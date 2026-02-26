/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import type { Repository } from '../api/api';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../azdo/pullRequestModel';
import { removeLeadingSlash } from '../azdo/utils';
import { DiffHunk, parseDiffAzdo, parsePatch } from '../common/diffHunk';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import Logger from '../common/logger';
import { toReviewUri } from '../common/uri';
import { groupBy } from '../common/utils';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

/**
 * Result of fetching PR data
 */
export interface PRData {
	comments: GitPullRequestCommentThread[];
	localFileChanges: GitFileChangeNode[];
	obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[];
}

/**
 * Manages PR data fetching and file change node creation.
 * Responsible for:
 * - Fetching file changes from the PR
 * - Parsing diffs
 * - Creating file change nodes for active and obsolete changes
 * - Organizing comments with their associated files
 */
export class PRDataManager implements vscode.Disposable {
	public static ID = 'PRData';
	private _disposables: vscode.Disposable[] = [];

	constructor(
		private _repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _dataProvider: PullRequestChangesTreeDataProvider,
	) {}

	/**
	 * Fetch and organize PR data including file changes and comments
	 */
	public async getPullRequestData(
		pr: PullRequestModel & IResolvedPullRequestModel,
		comments: GitPullRequestCommentThread[],
	): Promise<PRData> {
		try {
			Logger.appendLine('PRDataManager> fetching PR data');

			await pr.getPullRequestFileViewState();

			// Separate active and outdated comments
			const activeComments = comments;
			const outdatedComments: GitPullRequestCommentThread[] = [];
			// TODO What is outdated comments?
			// const activeComments = comments.filter(comment => !comment.pullRequestThreadContext);
			// const outdatedComments = comments.filter(comment => !!comment.pullRequestThreadContext);

			// Fetch file changes
			const data = await pr.getFileChangesInfo();
			const mergeBase = pr.getDiffTarget();
			const contentChanges = await parseDiffAzdo(data, this._repository, mergeBase!);

			// Create file change nodes for active changes
			const localFileChanges = await this.createLocalChangeNodes(pr, contentChanges, activeComments);

			// Create file change nodes for obsolete/outdated changes
			const obsoleteFileChanges = await this.createObsoleteChangeNodes(
				pr,
				outdatedComments,
			);

			Logger.appendLine(
				`PRDataManager> fetched ${localFileChanges.length} local changes and ${obsoleteFileChanges.length} obsolete changes`,
			);

			return {
				comments,
				localFileChanges,
				obsoleteFileChanges,
			};
		} catch (e) {
			Logger.appendLine(`PRDataManager> fetch PR data failed: ${e}`);
			throw e;
		}
	}

	/**
	 * Create file change nodes for the active PR changes
	 */
	private async createLocalChangeNodes(
		pr: PullRequestModel & IResolvedPullRequestModel,
		contentChanges: (InMemFileChange | SlimFileChange)[],
		activeComments: GitPullRequestCommentThread[],
	): Promise<GitFileChangeNode[]> {
		const nodes: GitFileChangeNode[] = [];
		const mergeBase = pr.getDiffTarget();
		const headSha = pr.head.sha;

		for (let i = 0; i < contentChanges.length; i++) {
			const change = contentChanges[i];
			let diffHunks: DiffHunk[] = [];

			if (change instanceof InMemFileChange) {
				diffHunks = change.diffHunks;
			} else if (change.status !== GitChangeType.RENAME) {
				try {
					const patch = await this._repository.diffBetween(pr.base.sha, pr.head.sha, change.fileName);
					diffHunks = parsePatch(patch);
				} catch (e) {
					Logger.appendLine(`PRDataManager> Failed to parse patch: ${e}`);
				}
			}

			Logger.appendLine(
				`PRDataManager> createLocalChangeNodes: ${change.fileName} status=${change.status} diffHunks=${diffHunks.length}`,
			);

			let fileName = change.fileName;
			if (change.status === GitChangeType.DELETE) {
				fileName = change.previousFileName!;
			}

			const filePath = nodePath.join(this._repository.rootUri.path, removeLeadingSlash(fileName)).replace(/\\/g, '/');
			const uri = this._repository.rootUri.with({ path: filePath });

			// Always use review URIs for both base and head files so provideCommentingRanges can match them
			const modifiedFileUri = toReviewUri(
				uri,
				change.fileName,
				undefined,
				change.status === GitChangeType.DELETE ? '' : headSha,
				false,
				{ base: false },
				this._repository.rootUri,
			);

			const originalFileUri = toReviewUri(
				uri,
				change.previousFileName || change.fileName,
				undefined,
				change.status === GitChangeType.ADD ? '' : mergeBase,
				false,
				{ base: true },
				this._repository.rootUri,
			);

			const changedItem = new GitFileChangeNode(
				this._dataProvider,
				pr,
				change.status,
				fileName,
				change.previousFileName,
				change.blobUrl,
				modifiedFileUri,
				originalFileUri,
				diffHunks,
				activeComments.filter(comment => comment.threadContext?.filePath === fileName),
				change.status === GitChangeType.DELETE ? change.previousFileSHA : change.fileSHA,
				headSha,
				change.previousFileSHA,
			);
			nodes.push(changedItem);
		}

		return nodes;
	}

	/**
	 * Create file change nodes for obsolete/outdated comments
	 */
	private async createObsoleteChangeNodes(
		pr: PullRequestModel & IResolvedPullRequestModel,
		outdatedComments: GitPullRequestCommentThread[],
	): Promise<(GitFileChangeNode | RemoteFileChangeNode)[]> {
		const obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];

		const commitsGroup = groupBy(outdatedComments, comment =>
			(comment.pullRequestThreadContext?.iterationContext?.secondComparingIteration ?? 0).toString(),
		);

		for (const commit in commitsGroup) {
			const commentsForCommit = commitsGroup[commit];
			const commentsForFile = groupBy(commentsForCommit, comment => comment.threadContext?.filePath);

			for (const fileName in commentsForFile) {
				let diffHunks: DiffHunk[] = [];
				try {
					const patch = await this._repository.diffBetween(pr.base.sha, commit, fileName);
					diffHunks = parsePatch(patch);
				} catch (e) {
					Logger.appendLine(`PRDataManager> Failed to parse patch for obsolete comments: ${e}`);
				}

				const oldComments = commentsForFile[fileName];
				const uri = vscode.Uri.file(nodePath.join(`commit~${commit.substr(0, 8)}`, fileName));
				const details = await this._repository.getObjectDetails(commit, fileName);

				const obsoleteFileChange = new GitFileChangeNode(
					this._dataProvider,
					pr,
					GitChangeType.MODIFY,
					fileName,
					undefined,
					undefined,
					toReviewUri(uri, fileName, undefined, '', true, { base: false }, this._repository.rootUri),
					toReviewUri(uri, fileName, undefined, '', true, { base: true }, this._repository.rootUri),
					diffHunks,
					oldComments,
					details.object,
					commit,
				);

				obsoleteFileChanges.push(obsoleteFileChange);
			}
		}

		return obsoleteFileChanges;
	}

	dispose(): void {
		Logger.appendLine('PRDataManager> disposing');
		this._disposables.forEach(d => d.dispose());
	}
}
