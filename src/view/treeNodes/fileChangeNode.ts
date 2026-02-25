/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { IFileChangeNodeWithUri } from '../../azdo/interface';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { removeLeadingSlash } from '../../azdo/utils';
import { ViewedState } from '../../common/comment';
import { DiffHunk } from '../../common/diffHunk';
import { GitChangeType } from '../../common/file';
import { fromPRUri, toResourceUri } from '../../common/uri';
import { FileViewedDecorationProvider } from '../fileViewedDecorationProvider';
import { DecorationProvider } from '../treeDecorationProvider';
import { TreeNode, TreeNodeParent } from './treeNode';
import Logger from '../../common/logger';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';

/**
 * File change node whose content can not be resolved locally and we direct users to GitHub.
 */
export class RemoteFileChangeNode extends TreeNode implements vscode.TreeItem {
	public description: string;
	public iconPath?: string | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } | vscode.ThemeIcon;
	public command: vscode.Command;
	public resourceUri: vscode.Uri;
	public contextValue: string;
	public childrenDisposables: vscode.Disposable[] = [];
	private _viewed: ViewedState;

	constructor(
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly sha?: string,
		public readonly previousFileSha?: string | undefined,
	) {
		super();
		const viewed = this.pullRequest.fileChangeViewedState[sha] ?? ViewedState.UNVIEWED;
		this.contextValue = `filechange:${GitChangeType[status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		this.label = path.basename(fileName);
		this.description = path.relative('.', path.dirname(fileName));
		this.iconPath = vscode.ThemeIcon.File;
		this.resourceUri = toResourceUri(vscode.Uri.parse(this.blobUrl), pullRequest.getPullRequestId(), fileName, status);

		this.command = {
			title: 'show remote file',
			command: 'azdopr.openDiffView',
			arguments: [this],
		};

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeFileViewedState(e => {
				const matchingChange = e.changed.find(viewStateChange => viewStateChange.fileSHA === this.sha);
				if (matchingChange) {
					this.updateViewed(matchingChange.viewed);
					this.refresh(this);
				}
			}),
		);
	}

	updateViewed(viewed: ViewedState) {
		if (this._viewed === viewed) {
			return;
		}

		this._viewed = viewed;
		this.contextValue = `filechange:${GitChangeType[this.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		FileViewedDecorationProvider.updateFileViewedState(
			this.resourceUri,
			this.pullRequest.getPullRequestId(),
			this.fileName,
			viewed,
		);
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class FileChangeNode extends TreeNode implements vscode.TreeItem {
	public description: string;
	public iconPath?: string | { light: vscode.Uri; dark: vscode.Uri } | vscode.ThemeIcon;
	public resourceUri: vscode.Uri;
	public parentSha: string;
	public contextValue: string;
	public command: vscode.Command;
	public opts: vscode.TextDocumentShowOptions;

	public childrenDisposables: vscode.Disposable[] = [];
	private _viewed: ViewedState;

	constructor(
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly blobUrl: string | undefined,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly diffHunks: DiffHunk[],
		public comments: GitPullRequestCommentThread[],
		public readonly sha?: string,
		public readonly previousFileSha?: string | undefined,
	) {
		super();
		const viewed = this.pullRequest.fileChangeViewedState[sha] ?? ViewedState.UNVIEWED;
		this.contextValue = `filechange:${GitChangeType[status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		this.label = path.basename(fileName);
		this.description = path.relative('.', path.dirname(removeLeadingSlash(fileName)));
		this.iconPath = vscode.ThemeIcon.File;
		this.opts = {
			preserveFocus: true,
		};
		this.updateShowOptions();
		this.resourceUri = toResourceUri(
			vscode.Uri.file(this.fileName),
			this.pullRequest.getPullRequestId(),
			this.fileName,
			this.status,
		);
		this.updateViewed(viewed);

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeFileViewedState(e => {
				const matchingChange = e.changed.find(viewStateChange => viewStateChange.fileSHA === this.sha);
				if (matchingChange) {
					this.updateViewed(matchingChange.viewed);
					this.refresh(this);
				}
			}),
		);

		this.childrenDisposables.push(
			this.pullRequest.onDidChangeReviewThreads(e => {
				if ([...e.added, ...e.removed].some(thread => thread.path === this.fileName)) {
					this.updateShowOptions();
				}
			}),
		);
	}

	updateViewed(viewed: ViewedState) {
		if (this._viewed === viewed) {
			return;
		}

		this._viewed = viewed;
		this.contextValue = `filechange:${GitChangeType[this.status]}:${viewed === ViewedState.VIEWED ? 'viewed' : 'unviewed'}`;
		FileViewedDecorationProvider.updateFileViewedState(
			this.resourceUri,
			this.pullRequest.getPullRequestId(),
			this.fileName,
			viewed,
		);
	}

	updateShowOptions() {
		const reviewThreads = this.pullRequest.reviewThreadsCache;
		let reviewThreadsForNode = reviewThreads.filter(thread => !thread.isDeleted && thread.path === this.fileName);

		DecorationProvider.updateFileComments(
			this.resourceUri,
			this.pullRequest.getPullRequestId(),
			this.fileName,
			reviewThreadsForNode.length > 0,
		);
		/* Some comments are attached to the file and have not reference/selection in the content. Need to be removed here. */
		reviewThreadsForNode = reviewThreadsForNode.filter((thread) => thread.line !== undefined);

		if (reviewThreadsForNode.length) {
			reviewThreadsForNode.sort((a, b) => a.line - b.line);
			this.opts.selection = new vscode.Range(reviewThreadsForNode[0].line, 0, reviewThreadsForNode[0].line, 0);
		} else {
			delete this.opts.selection;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	private async getFileContentWithLFSSmudge(
		commit: string,
		filePath: string,
		folderManager: FolderRepositoryManager,
	): Promise<Buffer> {
		try {
			// Get raw content from git
			const content = await folderManager.repository.buffer(commit, filePath);

			// Check if it's an LFS pointer
			const contentStr = content.toString('utf8', 0, Math.min(200, content.length));
			if (contentStr.startsWith('version https://git-lfs.github.com/spec/')) {
				Logger.appendLine(`LFS> Detected LFS pointer, smudging: ${filePath}`);

				// Smudge the LFS pointer to get actual content
				const smudged = await this.smudgeLFSPointer(contentStr, folderManager.repository.rootUri.fsPath);
				return smudged;
			}

			return content;
		} catch (error) {
			Logger.appendLine(`Error getting file content: ${error}`);
			throw error;
		}
	}

	private smudgeLFSPointer(pointerContent: string, repoPath: string): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			try {
				const child = spawn('git', ['lfs', 'smudge'], {
					cwd: repoPath,
				});

				const chunks: Buffer[] = [];
				const errorChunks: Buffer[] = [];

				if (!child.stdout || !child.stderr || !child.stdin) {
					reject(new Error('Failed to create child process streams'));
					return;
				}

				child.stdout.on('data', (chunk: Buffer) => {
					chunks.push(chunk);
				});

				child.stderr.on('data', (chunk: Buffer) => {
					errorChunks.push(chunk);
				});

				child.on('error', (error) => {
					Logger.appendLine(`LFS> Failed to spawn git lfs smudge: ${error}`);
					reject(error);
				});

				child.on('close', (code) => {
					if (code !== 0) {
						const errorMsg = Buffer.concat(errorChunks).toString('utf8');
						Logger.appendLine(`LFS> git lfs smudge exited with code ${code}: ${errorMsg}`);
						reject(new Error(`git lfs smudge failed: ${errorMsg}`));
					} else {
						const result = Buffer.concat(chunks);
						Logger.appendLine(`LFS> Successfully smudged LFS file, size: ${result.length} bytes`);
						resolve(result);
					}
				});

				child.stdin.write(pointerContent);
				child.stdin.end();
			} catch (error) {
				Logger.appendLine(`LFS> Exception in smudgeLFSPointer: ${error}`);
				reject(error);
			}
		});
	}

	async openDiff(folderManager: FolderRepositoryManager): Promise<void> {
		const parentFilePath = this.parentFilePath;
		const filePath = this.filePath;
		const opts = this.opts;

		try {
			// For PR view (pr_azdo scheme), use temp files for binary handling
			// For Review mode (review scheme), use data URIs
			if (filePath.scheme === 'pr_azdo') {
				// PR view: use proper commit-based retrieval with temp files
				const params = fromPRUri(filePath);
				const parentParams = fromPRUri(parentFilePath);

				if (!params || !parentParams) {
					Logger.appendLine('Could not parse PR URI parameters');
					return;
				}

				const headContent = await this.getFileContentWithLFSSmudge(
					params.headCommit,
					filePath.fsPath,
					folderManager
				);

				// For base file, handle different statuses
				let parentContent: Buffer;
				if (this.status === GitChangeType.ADD) {
					parentContent = Buffer.alloc(0); // Empty file for ADD
				} else if (this.status === GitChangeType.DELETE) {
					parentContent = headContent; // Use same content for DELETE show
				} else {
					parentContent = await this.getFileContentWithLFSSmudge(
						parentParams.headCommit,
						parentFilePath.fsPath,
						folderManager
					);
				}

				// Create temp files for binary content
				const tempDir = os.tmpdir();
				const fileName = path.basename(filePath.fsPath);
				const fileExt = path.extname(fileName);

				const parentTempFile = path.join(tempDir, `parent_${Date.now()}${fileExt}`);
				const headTempFile = path.join(tempDir, `head_${Date.now()}${fileExt}`);

				// Write content to temp files
				if (parentContent.length > 0) {
					fs.writeFileSync(parentTempFile, parentContent);
				} else {
					fs.writeFileSync(parentTempFile, '');
				}
				fs.writeFileSync(headTempFile, headContent);

				// Convert to URIs
				const parentURI = vscode.Uri.file(parentTempFile);
				const headURI = vscode.Uri.file(headTempFile);

				// Open diff with the actual binary files
				vscode.commands.executeCommand(
					'vscode.diff',
					parentURI,
					headURI,
					`${fileName} (Pull Request)`,
					opts,
				);

				// Clean up temp files after a delay (user should have them open by then)
				setTimeout(() => {
					try {
						if (fs.existsSync(parentTempFile)) fs.unlinkSync(parentTempFile);
						if (fs.existsSync(headTempFile)) fs.unlinkSync(headTempFile);
					} catch (e) {
						// Ignore cleanup errors
					}
				}, 30000); // 30 seconds
			} else if (filePath.scheme === 'review') {
				// Review mode: use URIs directly (review scheme supports binary content)
				vscode.commands.executeCommand(
					'vscode.diff',
					parentFilePath,
					filePath,
					`${path.basename(filePath.fsPath)} (Review)`,
					opts,
				);
			} else if (filePath.scheme === 'file') {
				// Checkout/Review mode with local files: open diff with file URIs directly
				vscode.commands.executeCommand(
					'vscode.diff',
					parentFilePath,
					filePath,
					`${path.basename(filePath.fsPath)} (Checkout)`,
					opts,
				);
			} else {
				Logger.appendLine(`Unknown URI scheme: ${filePath.scheme}`);
			}
		} catch (error) {
			Logger.appendLine(`Error opening diff: ${error}`);
			vscode.window.showErrorMessage(`Failed to open file: ${error}`);
		}
	}
}

/**
 * File change node whose content is stored in memory and resolved when being revealed.
 */
export class InMemFileChangeNode extends FileChangeNode implements vscode.TreeItem, IFileChangeNodeWithUri {
	constructor(
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly blobUrl: string,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public isPartial: boolean,
		public readonly patch: string,
		public readonly diffHunks: DiffHunk[],
		public comments: GitPullRequestCommentThread[],
		public readonly sha?: string,
		public readonly previousFileSha?: string | undefined,
	) {
		super(parent, pullRequest, status, fileName, blobUrl, filePath, parentFilePath, diffHunks, comments, sha, previousFileSha);
		this.command = {
			title: 'show diff',
			command: 'azdopr.openDiffView',
			arguments: [this],
		};
	}
}

/**
 * File change node whose content can be resolved by git commit sha.
 */
export class GitFileChangeNode extends FileChangeNode implements vscode.TreeItem, IFileChangeNodeWithUri {
	constructor(
		public readonly parent: TreeNodeParent,
		public readonly pullRequest: PullRequestModel,
		public readonly status: GitChangeType,
		public readonly fileName: string,
		public readonly previousFileName: string | undefined,
		public readonly blobUrl: string | undefined,
		public readonly filePath: vscode.Uri,
		public readonly parentFilePath: vscode.Uri,
		public readonly diffHunks: DiffHunk[],
		public comments: GitPullRequestCommentThread[] = [],
		public readonly sha?: string, // For GitFileChangeNode this is commit id
		public readonly commitId?: string,
		public readonly previousFileSha?: string | undefined,
	) {
		super(parent, pullRequest, status, fileName, blobUrl, filePath, parentFilePath, diffHunks, comments, sha, previousFileSha);
		this.command = {
			title: 'open changed file',
			command: 'azdopr.openChangedFile',
			arguments: [this],
		};
	}
}

export function gitFileChangeNodeFilter(nodes: (GitFileChangeNode | RemoteFileChangeNode)[]): GitFileChangeNode[] {
	return nodes.filter(node => node instanceof GitFileChangeNode) as GitFileChangeNode[];
}
