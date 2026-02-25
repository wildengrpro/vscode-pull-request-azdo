/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';

/**
 * Manages workspace folders and emits events when folders are added or removed.
 * Provides API for querying current workspace folder state.
 */
export class WorkspaceFolderManager implements vscode.Disposable {
private static readonly ID = 'WorkspaceFolderManager';

private _disposables: vscode.Disposable[] = [];
private _onDidAddFolder = new vscode.EventEmitter<vscode.WorkspaceFolder>();
private _onDidRemoveFolder = new vscode.EventEmitter<vscode.WorkspaceFolder>();

public readonly onDidAddFolder: vscode.Event<vscode.WorkspaceFolder> = this._onDidAddFolder.event;
public readonly onDidRemoveFolder: vscode.Event<vscode.WorkspaceFolder> = this._onDidRemoveFolder.event;

constructor() {
// Listen for workspace folder changes
this._disposables.push(
vscode.workspace.onDidChangeWorkspaceFolders(e => {
Logger.appendLine(
`Workspace folders changed - added: ${e.added.length}, removed: ${e.removed.length}`,
WorkspaceFolderManager.ID
);

for (const folder of e.added) {
Logger.appendLine(`Folder added: ${folder.name} (${folder.uri.fsPath})`, WorkspaceFolderManager.ID);
this._onDidAddFolder.fire(folder);
}

for (const folder of e.removed) {
Logger.appendLine(`Folder removed: ${folder.name} (${folder.uri.fsPath})`, WorkspaceFolderManager.ID);
this._onDidRemoveFolder.fire(folder);
}
})
);
}

/**
 * Gets all current workspace folders.
 * 
 * @returns Array of workspace folders (empty if no workspace is open)
 */
getWorkspaceFolders(): vscode.WorkspaceFolder[] {
return vscode.workspace.workspaceFolders || [];
}

/**
 * Checks if the workspace has multiple folders (multi-root workspace).
 * 
 * @returns True if workspace has more than one folder
 */
isMultiRoot(): boolean {
const folders = this.getWorkspaceFolders();
return folders.length > 1;
}

/**
 * Finds a workspace folder by URI.
 * 
 * @param uri The URI to search for
 * @returns The workspace folder or undefined if not found
 */
findFolderByUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
return vscode.workspace.getWorkspaceFolder(uri);
}

dispose(): void {
this._disposables.forEach(d => d.dispose());
this._onDidAddFolder.dispose();
this._onDidRemoveFolder.dispose();
}
}
