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
import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

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

	private isBinaryFile(fileName: string): boolean {
		const binaryExtensions = [
			'.pdf', '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
			'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.ico',
			'.zip', '.tar', '.gz', '.7z', '.rar',
			'.exe', '.dll', '.so', '.o',
			'.bin', '.dat', '.iso',
		];
		const ext = path.extname(fileName).toLowerCase();
		return binaryExtensions.includes(ext);
	}

	private isLFSPointer(content: Buffer): boolean {
		const contentStr = content.toString('utf8', 0, Math.min(200, content.length));
		return contentStr.startsWith('version https://git-lfs.github.com/spec/');
	}

	private async isLFSTrackedFile(fileName: string, folderManager: FolderRepositoryManager): Promise<boolean> {
		try {
			// Use git check-attr to determine if file is tracked by LFS
			const child = spawn('git', ['check-attr', 'filter', fileName], {
				cwd: folderManager.repository.rootUri.fsPath,
			});

			let output = '';
			let errorOutput = '';

			if (!child.stdout || !child.stderr) {
				return false;
			}

			child.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString('utf8');
			});

			child.stderr.on('data', (chunk: Buffer) => {
				errorOutput += chunk.toString('utf8');
			});

			return new Promise((resolve) => {
				child.on('close', (code) => {
					if (code === 0 && output.includes('filter: lfs')) {
						Logger.appendLine(`FileChangeNode> Git LFS tracked file detected: ${fileName}`);
						resolve(true);
					} else {
						resolve(false);
					}
				});

				child.on('error', (error) => {
					Logger.appendLine(`FileChangeNode> Error checking git attributes: ${error}`);
					resolve(false);
				});
			});
		} catch (error) {
			Logger.appendLine(`FileChangeNode> Exception in isLFSTrackedFile: ${error}`);
			return false;
		}
	}

	async openDiff(folderManager: FolderRepositoryManager): Promise<void> {
		const fileName = path.basename(this.filePath.fsPath);
		const opts = this.opts;

		try {
			// Check if file is tracked by Git LFS using git attributes
			const isLFS = await this.isLFSTrackedFile(fileName, folderManager);

			if (isLFS) {
				// LFS file: use temp files to display the actual smudged content
				Logger.appendLine(`FileChangeNode> File is Git LFS tracked, using temp files: ${fileName}`);

				const params = fromPRUri(this.filePath);
				const parentParams = fromPRUri(this.parentFilePath);

				if (!params || !parentParams) {
					Logger.appendLine('Could not parse PR URI parameters');
					return;
				}

				// Get actual content from git (already smudged by git automatically)
				const headContent = await folderManager.repository.buffer(
					params.headCommit,
					this.filePath.fsPath,
				);

				// For base file, handle different statuses
				let parentContent: Buffer;
				if (this.status === GitChangeType.ADD) {
					parentContent = Buffer.alloc(0); // Empty file for ADD
				} else if (this.status === GitChangeType.DELETE) {
					parentContent = headContent; // Use same content for DELETE show
				} else {
					parentContent = await folderManager.repository.buffer(
						parentParams.headCommit,
						this.parentFilePath.fsPath,
					);
				}

				// Create temp files for the actual content
				const tempDir = os.tmpdir();
				const fileExt = path.extname(fileName);

				const parentTempFile = path.join(tempDir, `parent_${Date.now()}${fileExt}`);
				const headTempFile = path.join(tempDir, `head_${Date.now()}${fileExt}`);

				// Write content to temp files
				fs.writeFileSync(parentTempFile, parentContent);
				fs.writeFileSync(headTempFile, headContent);

				// Convert to URIs
				const parentURI = vscode.Uri.file(parentTempFile);
				const headURI = vscode.Uri.file(headTempFile);

				// Open diff with the actual files
				vscode.commands.executeCommand(
					'vscode.diff',
					parentURI,
					headURI,
					`${fileName} (Pull Request)`,
					opts,
				);

				// Clean up temp files after a delay
				setTimeout(() => {
					try {
						if (fs.existsSync(parentTempFile)) fs.unlinkSync(parentTempFile);
						if (fs.existsSync(headTempFile)) fs.unlinkSync(headTempFile);
					} catch (e) {
						// Ignore cleanup errors
					}
				}, 30000); // 30 seconds
			} else {
				// Regular file (not LFS): use review URIs to enable commenting support
				Logger.appendLine(`FileChangeNode> Opening regular file with review URIs: ${fileName}`);
				vscode.commands.executeCommand(
					'vscode.diff',
					this.parentFilePath,
					this.filePath,
					`${fileName} (Pull Request)`,
					opts,
				);
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
