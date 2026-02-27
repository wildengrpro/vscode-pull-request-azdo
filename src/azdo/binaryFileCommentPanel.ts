/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';
import { AzdoUserManager } from './userManager';

function escapeHtml(text: string): string {
	const html: { [key: string]: string } = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#039;',
	};
	return text.replace(/[&<>"']/g, c => html[c]);
}

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

		// If we already have a panel, show it and update it for the new file
		if (BinaryFileCommentPanel.currentPanel) {
			BinaryFileCommentPanel.currentPanel._panel.reveal(vscode.ViewColumn.Active, true);
			await BinaryFileCommentPanel.currentPanel.updateForFile(folderRepositoryManager, pr, filePath, fileName);
		} else {
			const title = `Comments: ${fileName_display}`;
			BinaryFileCommentPanel.currentPanel = new BinaryFileCommentPanel(
				extensionPath,
				vscode.ViewColumn.Beside,
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

		// Move the panel below the active editor
		try {
			await vscode.commands.executeCommand('workbench.action.moveEditorToBelow');
		} catch (e) {
			// Ignore errors if move command fails
		}
	}

	protected set _currentPanel(panel: BinaryFileCommentPanel | undefined) {
		BinaryFileCommentPanel.currentPanel = panel;
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
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

		this.registerRenderListeners();
	}

	private registerRenderListeners(): void {
		// Message handler is now implemented via _onDidReceiveMessage override
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<any> {
		if (message.command === 'pr.add-comment') {
			await this.addComment(message.args.text, message.args.isFileComment);
		} else if (message.command === 'pr.reply-comment') {
			await this.replyToComment(message.args.threadId, message.args.text);
		} else {
			return super._onDidReceiveMessage(message);
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
			// Get all threads and filter for this file
			const allThreads = await pr.getAllActiveThreadsBetweenAllIterations();
			const fileThreads = (allThreads || []).filter(thread => thread.threadContext?.filePath === fileName);

			const currentUserName = await pr.azdoRepository.getAuthenticatedUserName();

			const html = await this.renderContent(fileThreads, currentUserName || 'Unknown');
			this._panel.webview.html = html;

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

		// Use inline styles to avoid resource loading issues
		const styles = `
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

				.comment-panel {
					display: flex;
					flex-direction: column;
					height: 100vh;
					background: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
				}

				.panel-header {
					padding: 12px 16px;
					border-bottom: 1px solid var(--vscode-divider-background);
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
					padding: 16px;
				}

				.comment-thread {
					margin-bottom: 24px;
					border: 1px solid var(--vscode-widget-border);
					border-radius: 4px;
					padding: 12px;
				}

				.comment {
					margin-bottom: 12px;
				}

				.comment-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 8px;
					font-size: 12px;
				}

				.comment-author {
					font-weight: 600;
					color: var(--vscode-foreground);
				}

				.comment-time {
					color: var(--vscode-descriptionForeground);
				}

				.comment-body {
					font-size: 13px;
					margin-bottom: 8px;
					white-space: pre-wrap;
					word-break: break-word;
				}

				.reply {
					margin-left: 20px;
					padding-top: 8px;
					border-top: 1px solid var(--vscode-widget-border);
				}

				.input-area {
					padding: 16px;
					border-top: 1px solid var(--vscode-divider-background);
					background: var(--vscode-editorWidget-background);
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

				button.secondary {
					background: var(--vscode-button-secondaryBackground);
					color: var(--vscode-button-secondaryForeground);
				}

				button.secondary:hover {
					background: var(--vscode-button-secondaryHoverBackground);
				}

				.empty-state {
					text-align: center;
					padding: 40px 16px;
					color: var(--vscode-descriptionForeground);
				}
			</style>
		`;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Comments: ${fileName_display}</title>
	${styles}
</head>
<body>
	<div class="comment-panel">
		<div class="panel-header">
			<h2>Comments: ${fileName_display}</h2>
			<p>Comments related to this document</p>
		</div>

		<div class="comments-container" id="commentsContainer">
			${threads.length === 0 ? '<div class="empty-state">No comments yet. Be the first to add one!</div>' : ''}
			${threads.map(thread => this.renderThread(thread)).join('')}
		</div>

		<div class="input-area">
			<div class="comment-input-wrapper">
				<textarea id="commentInput" placeholder="Leave a comment..." data-nonce="${nonce}"></textarea>
				<div class="input-actions">
					<button class="secondary" id="cancelBtn">Cancel</button>
					<button id="commentBtn">Comment</button>
				</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const commentInput = document.getElementById('commentInput');
		const commentBtn = document.getElementById('commentBtn');
		const cancelBtn = document.getElementById('cancelBtn');

		if (commentBtn) {
			commentBtn.addEventListener('click', () => {
				const text = commentInput.value.trim();
				if (text) {
					vscode.postMessage({
						command: 'pr.add-comment',
						args: { text: text, isFileComment: true }
					});
					commentInput.value = '';
				}
			});
		}

		if (cancelBtn) {
			cancelBtn.addEventListener('click', () => {
				commentInput.value = '';
			});
		}

		if (commentInput) {
			commentInput.addEventListener('keydown', (e) => {
				if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
					if (commentBtn) commentBtn.click();
				}
			});
		}

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.command === 'refresh') {
				// Will reload the entire panel
			}
		});
	</script>
</body>
</html>`;
	}

	private renderThread(thread: GitPullRequestCommentThread): string {
		if (!thread.comments || thread.comments.length === 0) {
			return '';
		}

		const comments = thread.comments.map((comment, index) => {
			const time = new Date(comment.publishedDate || new Date()).toLocaleString();
			return `
				<div class="comment">
					<div class="comment-header">
						<span class="comment-author">${escapeHtml(comment.author?.displayName || 'Unknown')}</span>
						<span class="comment-time">${time}</span>
					</div>
					<div class="comment-body markdown">${escapeHtml(comment.content || '')}</div>
					${index > 0 ? '<div class="reply"></div>' : ''}
				</div>
			`;
		});

		return `<div class="comment-thread">${comments.join('')}</div>`;
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
			this.refreshPanel();
		} catch (error) {
			Logger.appendLine(`BinaryFileCommentPanel> Error adding comment: ${error}`);
			vscode.window.showErrorMessage(`Failed to add comment: ${error}`);
		}
	}

	private async replyToComment(threadId: number, text: string): Promise<void> {
		try {
			await this._pullRequest.createCommentOnThread(threadId, text);
			vscode.window.showInformationMessage('Reply added successfully!');
			this.refreshPanel();
		} catch (error) {
			Logger.appendLine(`BinaryFileCommentPanel> Error replying to comment: ${error}`);
			vscode.window.showErrorMessage(`Failed to reply to comment: ${error}`);
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
