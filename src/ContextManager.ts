/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGit } from './api/api';
import Logger from './common/logger';
import { ApiClientFactory } from './services/ApiClientFactory';
import { GitContextExtractor } from './services/GitContextExtractor';
import { WorkspaceFolderManager } from './services/WorkspaceFolderManager';
import { FolderContext, WorkspaceContext } from './types/FolderContext';

/**
 * Orchestrates multi-root workspace support by coordinating:
 * - WorkspaceFolderManager: tracks folder add/remove
 * - GitContextExtractor: extracts org/project from git remotes
 * - ApiClientFactory: caches org-level Azure DevOps API clients
 * 
 * Implements hybrid activation pattern:
 * - Synchronous: detects workspace folders immediately
 * - Asynchronous: extracts context in background
 */
export class ContextManager implements vscode.Disposable {
private static readonly ID = 'ContextManager';

private _disposables: vscode.Disposable[] = [];
private _folderManager: WorkspaceFolderManager;
private _contextExtractor: GitContextExtractor;
private _apiClientFactory: ApiClientFactory;

// Current workspace context
private _workspaceContext: WorkspaceContext = {
folders: new Map<string, FolderContext>(),
};

// Event emitters
private _onDidChangeContext = new vscode.EventEmitter<WorkspaceContext>();
public readonly onDidChangeContext: vscode.Event<WorkspaceContext> = this._onDidChangeContext.event;

constructor(gitApi: IGit) {
this._folderManager = new WorkspaceFolderManager();
this._contextExtractor = new GitContextExtractor(gitApi);
this._apiClientFactory = new ApiClientFactory();

this._disposables.push(this._folderManager);
this._disposables.push(this._onDidChangeContext);

// Listen for folder changes
this._disposables.push(
this._folderManager.onDidAddFolder(folder => {
Logger.appendLine(`ContextManager: folder added ${folder.name}`, ContextManager.ID);
this._onFolderAdded(folder);
})
);

this._disposables.push(
this._folderManager.onDidRemoveFolder(folder => {
Logger.appendLine(`ContextManager: folder removed ${folder.name}`, ContextManager.ID);
this._onFolderRemoved(folder);
})
);
}

/**
 * Initializes the ContextManager with hybrid pattern:
 * 1. Synchronously detects all workspace folders
 * 2. Asynchronously extracts context for each folder
 * 
 * Returns immediately with folder detection complete.
 * Context extraction happens in background.
 */
async initialize(): Promise<void> {
Logger.appendLine('Initializing ContextManager...', ContextManager.ID);

// Synchronous: get all current workspace folders
const folders = this._folderManager.getWorkspaceFolders();
Logger.appendLine(`Found ${folders.length} workspace folder(s)`, ContextManager.ID);

// Create initial (unresolved) context entries for all folders
for (const folder of folders) {
const folderKey = folder.uri.toString();
this._workspaceContext.folders.set(folderKey, {
folder,
orgUrl: undefined,
projectName: undefined,
isResolved: false,
});
}

// Asynchronous: extract context for each folder in background
// Don't await - let this happen asynchronously
this._extractContextForAllFolders(folders).catch(error => {
Logger.appendLine(`Error during context extraction: ${error}`, ContextManager.ID);
});

Logger.appendLine('ContextManager initialized (context extraction in progress)', ContextManager.ID);
}

/**
 * Extracts context for all folders asynchronously.
 * Updates workspace context as each folder's context is resolved.
 * 
 * @param folders Array of workspace folders to process
 */
private async _extractContextForAllFolders(folders: vscode.WorkspaceFolder[]): Promise<void> {
Logger.appendLine(`Starting context extraction for ${folders.length} folder(s)...`, ContextManager.ID);

// Extract context for all folders in parallel
const extractionPromises = folders.map(folder => this._extractContextForFolder(folder));

await Promise.all(extractionPromises);

Logger.appendLine('Context extraction completed for all folders', ContextManager.ID);

// Notify listeners that context has changed
this._onDidChangeContext.fire(this._workspaceContext);
}

/**
 * Extracts context for a single folder and updates workspace context.
 * 
 * @param folder The workspace folder to extract context for
 */
private async _extractContextForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
const folderKey = folder.uri.toString();

try {
Logger.appendLine(`Extracting context for folder: ${folder.name}`, ContextManager.ID);

const result = await this._contextExtractor.extractContextForFolder(folder);

// Update workspace context
this._workspaceContext.folders.set(folderKey, {
folder,
orgUrl: result.orgUrl,
projectName: result.projectName,
isResolved: true,
error: result.error,
});

if (result.error) {
Logger.appendLine(
`Context extraction for ${folder.name} completed with error: ${result.error}`,
ContextManager.ID
);
} else {
Logger.appendLine(
`Context extracted for ${folder.name} - org: ${result.orgUrl}, project: ${result.projectName}`,
ContextManager.ID
);
}
} catch (error) {
Logger.appendLine(
`Failed to extract context for folder ${folder.name}: ${error}`,
ContextManager.ID
);

// Mark as resolved with error
this._workspaceContext.folders.set(folderKey, {
folder,
orgUrl: undefined,
projectName: undefined,
isResolved: true,
error: error instanceof Error ? error.message : String(error),
});
}
}

/**
 * Handles folder addition.
 * Creates initial context entry and starts async extraction.
 * 
 * @param folder The added workspace folder
 */
private _onFolderAdded(folder: vscode.WorkspaceFolder): void {
const folderKey = folder.uri.toString();

// Add unresolved context entry
this._workspaceContext.folders.set(folderKey, {
folder,
orgUrl: undefined,
projectName: undefined,
isResolved: false,
});

// Extract context asynchronously
this._extractContextForFolder(folder)
.then(() => {
// Notify listeners
this._onDidChangeContext.fire(this._workspaceContext);
})
.catch(error => {
Logger.appendLine(`Error extracting context for added folder: ${error}`, ContextManager.ID);
});
}

/**
 * Handles folder removal.
 * Removes context entry from workspace context.
 * 
 * @param folder The removed workspace folder
 */
private _onFolderRemoved(folder: vscode.WorkspaceFolder): void {
const folderKey = folder.uri.toString();
this._workspaceContext.folders.delete(folderKey);

// Notify listeners
this._onDidChangeContext.fire(this._workspaceContext);
}

/**
 * Gets the current workspace context.
 * Contains all folders and their resolved/unresolved contexts.
 * 
 * @returns Current workspace context
 */
getWorkspaceContext(): WorkspaceContext {
return this._workspaceContext;
}

/**
 * Gets context for a specific folder by URI.
 * 
 * @param folderUri The folder URI to look up
 * @returns FolderContext or undefined if not found
 */
getContextForFolder(folderUri: vscode.Uri): FolderContext | undefined {
return this._workspaceContext.folders.get(folderUri.toString());
}

/**
 * Gets the API client factory for creating org-level Azure DevOps clients.
 * 
 * @returns The ApiClientFactory instance
 */
getApiClientFactory(): ApiClientFactory {
return this._apiClientFactory;
}

/**
 * Checks if the workspace has multiple folders.
 * 
 * @returns True if workspace has multiple folders
 */
isMultiRoot(): boolean {
return this._folderManager.isMultiRoot();
}

dispose(): void {
this._disposables.forEach(d => d.dispose());
this._apiClientFactory.clearAllClients();
}
}
