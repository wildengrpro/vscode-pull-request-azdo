/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGit, Repository } from '../api/api';
import Logger from '../common/logger';
import { parseRepositoryRemotes } from '../common/remote';
import { SETTINGS_NAMESPACE } from '../constants';
import { ContextExtractionResult } from '../types/FolderContext';

// TODO: Add unit tests for URL parsing logic with various remote formats
// TODO: Add tests for fallback chain (git remote -> settings)
// TODO: Add test cases for edge cases (no remotes, invalid URLs, etc.)

/**
 * Extracts Azure DevOps organization and project context from git remotes and settings.
 * Implements a fallback chain: GitApiImpl -> VS Code git extension API -> shell command.
 */
export class GitContextExtractor {
private static readonly ID = 'GitContextExtractor';

constructor(private readonly gitApi: IGit) {}

/**
 * Extracts context (org/project) for a specific workspace folder.
 * Uses a fallback chain: git remote parsing, then resource-scoped settings.
 * 
 * @param folder The workspace folder to extract context for
 * @returns Promise with extraction result containing orgUrl, projectName, and optional error
 */
async extractContextForFolder(folder: vscode.WorkspaceFolder): Promise<ContextExtractionResult> {
Logger.appendLine(`Extracting context for folder: ${folder.uri.fsPath}`, GitContextExtractor.ID);

// First, try to get from resource-scoped settings
const settingsResult = this.getContextFromSettings(folder);
if (settingsResult.orgUrl && settingsResult.projectName) {
Logger.appendLine(`Context found in settings for ${folder.name}`, GitContextExtractor.ID);
return settingsResult;
}

// Try to find a git repository for this folder
const repository = this.findRepositoryForFolder(folder);
if (!repository) {
Logger.appendLine(`No git repository found for folder ${folder.name}`, GitContextExtractor.ID);
return {
orgUrl: settingsResult.orgUrl,
projectName: settingsResult.projectName,
error: 'No git repository found for this folder',
};
}

// Extract context from git remote
const remoteResult = this.extractContextFromRemote(repository);

// Merge results: prefer git remote, fallback to settings
return {
orgUrl: remoteResult.orgUrl || settingsResult.orgUrl,
projectName: remoteResult.projectName || settingsResult.projectName,
error: remoteResult.error,
};
}

/**
 * Finds the git repository that corresponds to a workspace folder.
 * 
 * @param folder The workspace folder to find repository for
 * @returns The Repository or undefined if not found
 */
private findRepositoryForFolder(folder: vscode.WorkspaceFolder): Repository | undefined {
const folderPath = folder.uri.fsPath;
return this.gitApi.repositories.find(repo => {
const repoPath = repo.rootUri.fsPath;
return folderPath === repoPath || folderPath.startsWith(repoPath + '/');
});
}

/**
 * Extracts context from git remote URL.
 * Expected URL format: https://<org>@dev.azure.com/<org>/<project>/_git/<repo>
 * 
 * @param repository The git repository
 * @returns Extraction result with orgUrl and projectName
 */
private extractContextFromRemote(repository: Repository): ContextExtractionResult {
const remotes = parseRepositoryRemotes(repository);

if (remotes.length === 0) {
Logger.appendLine(`No remotes found in repository ${repository.rootUri.fsPath}`, GitContextExtractor.ID);
return {
orgUrl: undefined,
projectName: undefined,
error: 'No remotes configured in git repository',
};
}

// Use the first remote (typically 'origin')
const remote = remotes[0];
const url = remote.url;

Logger.appendLine(`Parsing remote URL: ${url}`, GitContextExtractor.ID);

// Parse Azure DevOps URL
// Format: https://<org>@dev.azure.com/<org>/<project>/_git/<repo>
const orgUrlMatch = url.match(/https:\/\/(.+?)@dev\.azure\.com\/(.+?)\//);
const orgUrl = orgUrlMatch && orgUrlMatch.length > 2 ? `https://dev.azure.com/${orgUrlMatch[2]}` : undefined;

const projectNameMatch = url.match(/\/([^\/]+)\/_git\//);
const projectName = projectNameMatch && projectNameMatch.length > 1 ? projectNameMatch[1] : undefined;

Logger.appendLine(`Extracted - orgUrl: ${orgUrl}, projectName: ${projectName}`, GitContextExtractor.ID);

if (!orgUrl || !projectName) {
return {
orgUrl,
projectName,
error: 'Could not parse Azure DevOps organization and project from remote URL',
};
}

return { orgUrl, projectName };
}

/**
 * Gets context from VS Code workspace settings (resource-scoped).
 * 
 * @param folder The workspace folder to get settings for
 * @returns Extraction result with settings values
 */
private getContextFromSettings(folder: vscode.WorkspaceFolder): ContextExtractionResult {
const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE, folder.uri);
const orgUrl = config.get<string>('orgUrl');
const projectName = config.get<string>('projectName');

Logger.appendLine(
`Settings for ${folder.name} - orgUrl: ${orgUrl}, projectName: ${projectName}`,
GitContextExtractor.ID
);

return { orgUrl, projectName };
}
}
