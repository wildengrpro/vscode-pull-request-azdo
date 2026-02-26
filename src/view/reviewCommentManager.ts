/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import type { Repository } from '../api/api';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { PullRequestModel } from '../azdo/pullRequestModel';
import { isUserThread } from '../azdo/utils';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { ReviewCommentController } from './reviewCommentController';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

/**
 * Manages comment controller lifecycle and comment thread loading for Review mode.
 * Responsible for:
 * - Creating and initializing ReviewCommentController
 * - Fetching and managing comment threads
 * - Tracking comment changes
 * - Syncing comments with file changes
 */
export class ReviewCommentManager implements vscode.Disposable {
	public static ID = 'ReviewComments';
	private _disposables: vscode.Disposable[] = [];
	private _comments: GitPullRequestCommentThread[] = [];
	private _reviewCommentController: ReviewCommentController | undefined;
	private _updateCommentsInProgress: boolean = false;

	constructor(
		private _repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
	) {}

	/**
	 * Initialize the comment controller
	 */
	public async initialize(pr: PullRequestModel, localFileChanges: GitFileChangeNode[]): Promise<void> {
		Logger.appendLine('ReviewCommentManager> initializing');

		// Create and initialize the ReviewCommentController
		this._reviewCommentController = new ReviewCommentController(
			this._folderRepoManager,
			this._repository,
			localFileChanges,
			pr.getCommentPermission.bind(pr),
		);

		await this._reviewCommentController.initialize();

		this._disposables.push(this._reviewCommentController);

		// Listen to comment changes from the controller
		this._disposables.push(
			this._reviewCommentController.onDidChangeComments(comments => {
				this._comments = comments;
				Logger.appendLine(`ReviewCommentManager> comments updated, count: ${comments.length}`);
			}),
		);

		Logger.appendLine('ReviewCommentManager> initialized successfully');
	}

	/**
	 * Fetch and update comment threads
	 */
	public async fetchComments(pr: PullRequestModel): Promise<void> {
		try {
			Logger.appendLine('ReviewCommentManager> fetching comments');
			this._comments = ((await pr.getAllActiveThreadsBetweenAllIterations()) ?? []).filter(isUserThread);
			Logger.appendLine(`ReviewCommentManager> fetched ${this._comments.length} comment(s)`);
		} catch (e) {
			Logger.appendLine(`ReviewCommentManager> fetch comments failed: ${e}`);
			throw e;
		}
	}

	/**
	 * Update the comment controller with current file changes
	 */
	public async update(
		localFileChanges: GitFileChangeNode[],
		obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
	): Promise<void> {
		if (!this._reviewCommentController) {
			Logger.appendLine('ReviewCommentManager> comment controller not initialized');
			return;
		}

		try {
			Logger.appendLine('ReviewCommentManager> updating comment controller');
			await this._reviewCommentController.update(localFileChanges, obsoleteFileChanges);
		} catch (e) {
			Logger.appendLine(`ReviewCommentManager> update failed: ${e}`);
			throw e;
		}
	}

	/**
	 * Update comments with polling (called periodically)
	 */
	public async updateComments(pr: PullRequestModel): Promise<void> {
		if (this._updateCommentsInProgress) {
			Logger.appendLine('ReviewCommentManager> update already in progress, skipping');
			return;
		}

		this._updateCommentsInProgress = true;
		try {
			Logger.appendLine('ReviewCommentManager> polling for comment updates');
			await this.fetchComments(pr);
		} catch (e) {
			Logger.appendLine(`ReviewCommentManager> polling update failed: ${e}`);
		} finally {
			this._updateCommentsInProgress = false;
		}
	}

	/**
	 * Get current comments
	 */
	public get comments(): GitPullRequestCommentThread[] {
		return this._comments;
	}

	/**
	 * Get the underlying comment controller
	 */
	public get commentController(): ReviewCommentController | undefined {
		return this._reviewCommentController;
	}

	dispose(): void {
		Logger.appendLine('ReviewCommentManager> disposing');
		this._disposables.forEach(d => d.dispose());
	}
}
