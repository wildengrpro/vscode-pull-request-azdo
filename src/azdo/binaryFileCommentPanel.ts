/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { constructDiffUris, openDiff } from '../common/fileUtils';
import Logger from '../common/logger';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { convertRawFileChangeToFileChangeNode } from './utils';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';
import { AzdoUserManager } from './userManager';

export class BinaryFileCommentPanel extends WebviewBase {
	public static ID: string = 'BinaryFileCommentPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: BinaryFileCommentPanel;

	protected static readonly _viewType: string = 'BinaryFileComments';
	protected readonly _panel: vscode.WebviewPanel;

	private _filePath: string;
	private _fileName: string;
	private _pullRequest: PullRequestModel;
	private _folderRepositoryManager: FolderRepositoryManager;
	private _userManager: AzdoUserManager;
	private _extensionPath: string;

	public static async createOrShow(
		extensionPath: string,
		folderRepositoryManager: FolderRepositoryManager,
		pr: PullRequestModel,
		filePath: string,
		fileName: string,
		userManager: AzdoUserManager,
	) {
		const fileName_display = path.basename(fileName);

		// If we already have a panel, close it so we can reopen fresh
		if (BinaryFileCommentPanel.currentPanel) {
			BinaryFileCommentPanel.currentPanel._panel.dispose();
			BinaryFileCommentPanel.currentPanel = undefined;
		}

		const title = `Comments: ${fileName_display}`;
		// Open the panel in the first column (same group as the diff editor)
		BinaryFileCommentPanel.currentPanel = new BinaryFileCommentPanel(
			extensionPath,
			vscode.ViewColumn.One,
			title,
			folderRepositoryManager,
			pr,
			filePath,
			fileName,
			userManager,
		);
		// Populate the panel with content for this file
		await BinaryFileCommentPanel.currentPanel.updateForFile(folderRepositoryManager, pr, filePath, fileName);
	}

	// Move the panel to a group below the diff editor
	public static async movePanelBelow(): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
		} catch (e) {
			Logger.appendLine(`Failed to move panel below: ${e}`);
		}
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	public static closePanel(): void {
		if (this.currentPanel) {
			this.currentPanel._panel.dispose();
			this.currentPanel = undefined;
		}
	}

	public async refreshPanel(): Promise<void> {
		if (this._panel && this._panel.visible) {
			this.updateForFile(this._folderRepositoryManager, this._pullRequest, this._filePath, this._fileName);
		}
	}

	protected constructor(
		extensionPath: string,
		column: vscode.ViewColumn,
		title: string,
		folderRepositoryManager: FolderRepositoryManager,
		pr: PullRequestModel,
		filePath: string,
		fileName: string,
		userManager: AzdoUserManager,
	) {
		super();

		this._extensionPath = extensionPath;
		this._folderRepositoryManager = folderRepositoryManager;
		this._pullRequest = pr;
		this._filePath = filePath;
		this._fileName = fileName;
		this._userManager = userManager;

		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(BinaryFileCommentPanel._viewType, title, column, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(path.join(this._extensionPath, 'dist'))],
		});

		this._webview = this._panel.webview;
		super.initialize();

		// Listen for when the panel is disposed
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Listen for tab group changes to close panel if associated diff editor closes
		this.setupDiffEditorCloseListener();

		this.registerRenderListeners();
	}

	private setupDiffEditorCloseListener(): void {
		// Watch for tab changes and close the panel if the associated diff editor closes
		if (vscode.window.tabGroups) {
			const disposable = vscode.window.tabGroups.onDidChangeTabs(() => {
				if (!this.isDiffEditorForFileOpen()) {
					Logger.appendLine(`BinaryFileCommentPanel> Associated diff editor closed for ${this._fileName}, closing panel`);
					BinaryFileCommentPanel.closePanel();
				}
			});
			this._disposables.push(disposable);
		}
	}

	private isDiffEditorForFileOpen(): boolean {
		if (!vscode.window.tabGroups) {
			return false;
		}

		const fileName = this._fileName;
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input as any;
				// Check if this is a diff editor containing our file
				if (input && input.original && input.modified) {
					const modifiedPath = input.modified?.uri?.fsPath || '';
					const originalPath = input.original?.uri?.fsPath || '';
					if (modifiedPath.includes(fileName) || originalPath.includes(fileName)) {
						return true;
					}
				}
			}
		}
		return false;
	}

	private registerRenderListeners(): void {
		// Message handler is now implemented via _onDidReceiveMessage override
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<any> {
		if (message.command === 'pr.add-comment') {
			await this.addComment(message.args.text, message.args.isFileComment);
		} else if (message.command === 'pr.reply-comment') {
			await this.replyToComment(message.args.threadId, message.args.text);
		} else if (message.command === 'pr.change-thread-status') {
			await this.changeThreadStatus(message.args.threadId, message.args.status);
		} else if (message.command === 'openFile') {
			await this.openFileFromLink(message.args.filePath);
		} else {
			return super._onDidReceiveMessage(message);
		}
	}

	private async openFileFromLink(filePath: string): Promise<void> {
		try {
			const fileName = path.basename(filePath);

			// Get the PR's file changes to find the matching file
			const fileChangesInfo = await this._pullRequest.getFileChangesInfo();

			// Find the file change that matches (using filename property from IRawFileChange)
			const matchingFileChange = fileChangesInfo.find(change =>
				path.basename(change.filename) === fileName ||
				change.filename === filePath
			);

			if (!matchingFileChange) {
				Logger.appendLine(`File ${filePath} not found in PR changes, opening directly`);
				this.openFileDirectly(filePath);
				return;
			}

			// Construct diff URIs from the raw file change
			const uris = constructDiffUris(matchingFileChange, this._folderRepositoryManager, this._pullRequest);

			if (!uris) {
				Logger.appendLine(`Could not construct URIs for ${filePath}, opening directly`);
				this.openFileDirectly(filePath);
				return;
			}

			// Open the diff using the centralized function (handles LFS and temp files)
			await openDiff(uris.filePath, uris.parentFilePath, this._folderRepositoryManager, {
				fileName,
				title: `${fileName} (PR Diff)`,
				preserveFocus: true,
			});

			Logger.appendLine(`Opened diff for ${filePath} from comment link`);
		} catch (error) {
			Logger.appendLine(`Failed to open file from comment link ${filePath}: ${error}`);
			this.openFileDirectly(filePath);
		}
	}

	private async openFileDirectly(filePath: string): Promise<void> {
		try {
			const uri = vscode.Uri.file(filePath);
			const document = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(document, { preserveFocus: true });
			Logger.appendLine(`Opened file directly: ${filePath}`);
		} catch (error) {
			Logger.appendLine(`Failed to open file directly ${filePath}: ${error}`);
			vscode.window.showErrorMessage(`Could not open file: ${path.basename(filePath)}`);
		}
	}

	public async updateForFile(
		folderManager: FolderRepositoryManager,
		pr: PullRequestModel,
		filePath: string,
		fileName: string,
	): Promise<void> {
		this._folderRepositoryManager = folderManager;
		this._pullRequest = pr;
		this._filePath = filePath;
		this._fileName = fileName;

		try {
			// Extract the actual fileName from the URI query parameters
			let actualFileName = filePath;
			const queryIndex = filePath.indexOf('?');
			if (queryIndex > -1) {
				try {
					const queryString = filePath.substring(queryIndex + 1);
					const decodedQuery = decodeURIComponent(queryString);
					const params = JSON.parse(decodedQuery);
					actualFileName = params.fileName || actualFileName;
				} catch (e) {
					Logger.appendLine(`BinaryFileCommentPanel> Failed to parse URI params: ${e}`);
				}
			}

			// Get all threads and filter for this file
			const allThreads = await pr.getAllActiveThreadsBetweenAllIterations();
			Logger.appendLine(`BinaryFileCommentPanel> Total threads: ${allThreads?.length}`);
			Logger.appendLine(`BinaryFileCommentPanel> Looking for file: ${actualFileName}`);

			const fileThreads = (allThreads || []).filter(thread => {
				const threadPath = thread.threadContext?.filePath || (thread as any).path;
				return threadPath === actualFileName;
			});

			Logger.appendLine(`BinaryFileCommentPanel> Filtered threads: ${fileThreads.length}`);

			const currentUserName = await pr.azdoRepository.getAuthenticatedUserName();
			const currentUser = this._folderRepositoryManager.getCurrentUser();

			const html = await this.renderContent(fileThreads, currentUserName || 'Unknown');
			this._panel.webview.html = html;

			// Wait a tick for webview to be ready, then send PR data
			setTimeout(() => {
				Logger.appendLine(`BinaryFileCommentPanel> Sending pr.initialize with ${fileThreads.length} threads`);
				this._postMessage({
					command: 'pr.initialize',
					pullrequest: {
						number: pr.getPullRequestId(),
						title: pr.item.title,
						url: pr.url,
						createdAt: pr.item.createdBy?.displayName,
						body: pr.item.description,
						bodyHTML: pr.item.description,
						author: {
							login: pr.item.createdBy!.uniqueName!,
							name: pr.item.createdBy?.displayName,
							avatarUrl: pr.item.createdBy?.imageUrl,
							url: pr.item.createdBy?.url,
						},
						threads: fileThreads,
						state: pr.state,
						currentUser: {
							id: currentUser.id,
							name: currentUser.name,
							email: currentUser.email,
						}
					},
				});
			}, 100);

			// Update title
			const fileName_display = path.basename(fileName);
			this._panel.title = `Comments: ${fileName_display}`;
		} catch (error) {
			Logger.appendLine(`BinaryFileCommentPanel> Error updating for file: ${error}`);
			vscode.window.showErrorMessage(`Failed to load comments for ${fileName}`);
		}
	}

	private async renderContent(threads: GitPullRequestCommentThread[], currentUserName: string): Promise<string> {
		const nonce = getNonce();
		const fileName_display = path.basename(this._fileName);

		const uri = vscode.Uri.file(path.join(this._extensionPath, 'dist', 'webview-binary-file-comments.js'));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Comments: ${fileName_display}</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}

		body {
			font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif);
			font-size: 13px;
			line-height: 1.5;
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
		}

		#app {
			padding: 16px;
		}

		.binary-comment-view {
			display: flex;
			flex-direction: column;
			height: 100%;
		}

		.panel-header {
			padding: 12px 0;
			border-bottom: 1px solid var(--vscode-divider-background);
			margin-bottom: 16px;
			flex-shrink: 0;
		}

		.panel-header h2 {
			margin: 0;
			font-size: 14px;
			font-weight: 600;
		}

		.panel-header p {
			margin: 4px 0 0 0;
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
		}

		.comments-container {
			flex: 1;
			overflow-y: auto;
			margin-bottom: 20px;
		}

		.empty-state {
			text-align: center;
			padding: 40px 16px;
			color: var(--vscode-descriptionForeground);
		}

		.input-area {
			padding: 16px 0;
			border-top: 1px solid var(--vscode-divider-background);
			flex-shrink: 0;
		}

		.comment-input-wrapper {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		textarea {
			width: 100%;
			min-height: 80px;
			padding: 8px;
			border: 1px solid var(--vscode-input-border);
			border-radius: 3px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 13px;
			resize: vertical;
		}

		textarea::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}

		textarea:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}

		.input-actions {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
		}

		button {
			padding: 6px 16px;
			border: 1px solid var(--vscode-button-border);
			border-radius: 3px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			cursor: pointer;
			font-size: 12px;
			font-family: inherit;
		}

		button:hover {
			background: var(--vscode-button-hoverBackground);
		}

		button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}

		button.secondary:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
	</style>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}">
		window.appDataDebug = 'BinaryFileCommentPanel ready';
	</script>
	<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
</body>
</html>`;
	}

	private async addComment(text: string, isFileComment: boolean): Promise<void> {
		try {
			await this._pullRequest.createThread(text, {
				filePath: this._fileName,
				line: 1,
				startOffset: 1,
				endOffset: 1,
				isLeft: false,
			});

			vscode.window.showInformationMessage('Comment added successfully!');
			// Await the refresh to ensure the new comment is displayed
			await this.refreshPanel();
		} catch (error) {
			Logger.appendLine(`BinaryFileCommentPanel> Error adding comment: ${error}`);
			vscode.window.showErrorMessage(`Failed to add comment: ${error}`);
		}
	}

	private async replyToComment(threadId: number, text: string): Promise<void> {
		try {
			await this._pullRequest.createCommentOnThread(threadId, text);
			vscode.window.showInformationMessage('Reply added successfully!');
			// Await the refresh to ensure the reply is displayed
			await this.refreshPanel();
		} catch (error) {
			Logger.appendLine(`BinaryFileCommentPanel> Error replying to comment: ${error}`);
			vscode.window.showErrorMessage(`Failed to reply to comment: ${error}`);
		}
	}

	private async changeThreadStatus(threadId: number, statusStr: string): Promise<void> {
		try {
			// Convert string status to CommentThreadStatus enum
			const statusMap: { [key: string]: number } = {
				'1': 1, // Active
				'2': 2, // Fixed
				'3': 3, // WontFix
				'4': 4, // Closed
				'6': 6, // Pending
			};
			const status = statusMap[statusStr.toString()];
			if (status === undefined) {
				vscode.window.showErrorMessage('Invalid thread status');
				return;
			}

			await this._pullRequest.updateThreadStatus(threadId, status);
			vscode.window.showInformationMessage('Thread status updated successfully!');
			// Await the refresh to ensure the status change is displayed
			await this.refreshPanel();
		} catch (error) {
			Logger.appendLine(`BinaryFileCommentPanel> Error updating thread status: ${error}`);
			vscode.window.showErrorMessage(`Failed to update thread status: ${error}`);
		}
	}

	public dispose(): void {
		BinaryFileCommentPanel.currentPanel = undefined;
		// Dispose all disposables
		this._disposables.forEach(disposable => disposable.dispose());
		// Dispose the webview panel
		if (this._panel) {
			this._panel.dispose();
		}
	}
}
