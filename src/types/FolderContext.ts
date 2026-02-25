/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Represents the Azure DevOps context for a single workspace folder.
 * Contains the organization URL and project name extracted from git remote or settings.
 */
export interface FolderContext {
/** The workspace folder this context belongs to */
folder: vscode.WorkspaceFolder;
/** Azure DevOps organization URL (e.g., https://dev.azure.com/myorg) */
orgUrl: string | undefined;
/** Azure DevOps project name */
projectName: string | undefined;
/** Indicates if context extraction has completed (even if unsuccessful) */
isResolved: boolean;
/** Optional error message if context extraction failed */
error?: string;
}

/**
 * Aggregated context for all workspace folders.
 * Maps workspace folder URIs to their respective FolderContext.
 */
export interface WorkspaceContext {
/** Map of folder URI (as string) to FolderContext */
folders: Map<string, FolderContext>;
}

/**
 * Result of context extraction for a folder.
 */
export interface ContextExtractionResult {
orgUrl: string | undefined;
projectName: string | undefined;
error?: string;
}
