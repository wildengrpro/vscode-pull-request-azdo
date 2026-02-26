/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Repository } from '../api/api';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { PullRequestModel } from '../azdo/pullRequestModel';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { CheckoutManager } from './checkoutManager';
import { ReviewCommentManager } from './reviewCommentManager';
import { PRDataManager } from './prDataManager';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

/**
 * Container that manages three independent managers:
 * - CheckoutManager: Git checkout state and branch monitoring
 * - ReviewCommentManager: Comment controller and thread management
 * - PRDataManager: PR data fetching and file change node creation
 *
 * This allows ReviewCommentManager to be initialized early (before checkout)
 * while keeping other concerns separated.
 */
export class ReviewContainer implements vscode.Disposable {
	public static ID = 'ReviewContainer';
	private _disposables: vscode.Disposable[] = [];

	public readonly checkoutManager: CheckoutManager;
	public readonly commentManager: ReviewCommentManager;
	public readonly dataManager: PRDataManager;

	// For backward compatibility with existing code that expects ReviewManager-like interface
	public readonly repository: Repository;

	constructor(
		private _context: vscode.ExtensionContext,
		repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		private _changesTreeDataProvider: PullRequestChangesTreeDataProvider,
	) {
		this.repository = repository;

		// Initialize the three independent managers
		this.checkoutManager = new CheckoutManager(
			_context,
			repository,
			_folderRepoManager,
			_telemetry,
		);

		this.commentManager = new ReviewCommentManager(
			repository,
			_folderRepoManager,
			_telemetry,
		);

		this.dataManager = new PRDataManager(
			repository,
			_folderRepoManager,
			_changesTreeDataProvider,
		);

		this._disposables.push(
			this.checkoutManager,
			this.commentManager,
			this.dataManager,
		);

		Logger.appendLine('ReviewContainer> initialized');
	}

	/**
	 * Switch to a PR (checkout branch and initialize comment controller)
	 */
	public async switch(pr: PullRequestModel): Promise<void> {
		Logger.appendLine(`ReviewContainer> switch to PR #${pr.getPullRequestId()}`);

		try {
			// Initialize comment manager with this PR if not already done
			if (!this.commentManager.commentController) {
				Logger.appendLine('ReviewContainer> initializing comment manager for PR');
				await this.commentManager.initialize(pr, []);
			}

			// Perform checkout via CheckoutManager
			await this.checkoutManager.switch(pr);

			// Fetch PR data
			if (!pr.isResolved()) {
				Logger.appendLine('ReviewContainer> PR not resolved, cannot fetch data');
				return;
			}

			const comments = await this.fetchComments(pr);
			const prData = await this.dataManager.getPullRequestData(pr, comments);

			// Update comment controller with file changes
			await this.commentManager.update(prData.localFileChanges, prData.obsoleteFileChanges);

			Logger.appendLine(`ReviewContainer> switch to PR #${pr.getPullRequestId()} - complete`);
		} catch (e) {
			Logger.appendLine(`ReviewContainer> switch failed: ${e}`);
			throw e;
		}
	}

	/**
	 * Fetch comments for a PR (for comment manager to use)
	 */
	private async fetchComments(pr: PullRequestModel): Promise<any[]> {
		if (!pr.isResolved()) {
			return [];
		}
		await this.commentManager.fetchComments(pr);
		return this.commentManager.comments;
	}

	/**
	 * Update comments (polling)
	 */
	public async updateComments(): Promise<void> {
		if (!this._folderRepoManager.activePullRequest || !this._folderRepoManager.activePullRequest.isResolved()) {
			return;
		}

		await this.commentManager.updateComments(this._folderRepoManager.activePullRequest);
	}

	/**
	 * Update state (for branch monitoring)
	 */
	public async updateState(silent?: boolean): Promise<void> {
		await this.checkoutManager.updateState(silent);
	}

	/**
	 * Get the underlying comment controller for external use
	 */
	public get reviewCommentController() {
		return this.commentManager.commentController;
	}

	/**
	 * Static helper: Find container for a given repository
	 */
	public static getContainerForRepository(
		containers: ReviewContainer[],
		azdoRepository: any,
	): ReviewContainer | undefined {
		return containers.find(
			container => container.repository.rootUri.toString() === azdoRepository.rootUri.toString(),
		);
	}

	/**
	 * Static helper: Find container for a given folder manager
	 */
	public static getContainerForFolderManager(
		containers: ReviewContainer[],
		folderManager: FolderRepositoryManager,
	): ReviewContainer | undefined {
		return containers.find(
			container => container.repository.rootUri.toString() === folderManager.repository.rootUri.toString(),
		);
	}

	dispose(): void {
		Logger.appendLine('ReviewContainer> disposing');
		this._disposables.forEach(d => d.dispose());
	}
}
