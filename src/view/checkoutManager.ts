/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Branch, Repository } from '../api/api';
import { GitErrorCodes } from '../api/api1';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { PullRequestGitHelper } from '../azdo/pullRequestGitHelper';
import { PullRequestModel } from '../azdo/pullRequestModel';
import { PullRequestOverviewPanel } from '../azdo/pullRequestOverview';
import Logger from '../common/logger';
import { parseRepositoryRemotes, Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { formatError } from '../common/utils';

/**
 * Manages checkout process and git branch state monitoring.
 * Responsible for:
 * - Monitoring current branch HEAD
 * - Handling PR checkout
 * - Tracking branch/commit state
 * - Status bar display for checkout state
 */
export class CheckoutManager implements vscode.Disposable {
	public static ID = 'Checkout';
	private _disposables: vscode.Disposable[] = [];

	private _statusBarItem: vscode.StatusBarItem;
	private _prNumber?: number;
	private _lastCommitSha?: string;
	private _updateMessageShown: boolean = false;
	private _validateStatusInProgress?: Promise<void>;
	private _queuedValidation: boolean = false;
	private _switchingToReviewMode: boolean;
	private _isFirstLoad = true;

	private _previousRepositoryState: {
		HEAD: Branch | undefined;
		remotes: Remote[];
	};

	public get switchingToReviewMode(): boolean {
		return this._switchingToReviewMode;
	}

	public set switchingToReviewMode(newState: boolean) {
		this._switchingToReviewMode = newState;
		if (!newState) {
			this.updateState();
		}
	}

	public get statusBarItem(): vscode.StatusBarItem {
		return this._statusBarItem;
	}

	public get prNumber(): number | undefined {
		return this._prNumber;
	}

	public get repository(): Repository {
		return this._repository;
	}

	constructor(
		private _context: vscode.ExtensionContext,
		private _repository: Repository,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
	) {
		this._switchingToReviewMode = false;
		this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this._statusBarItem.name = 'Azure DevOps PR Checkout Status';

		this._previousRepositoryState = {
			HEAD: _repository.state.HEAD,
			remotes: parseRepositoryRemotes(this._repository),
		};

		this.registerListeners();
		this.updateState();
	}

	private registerListeners(): void {
		this._disposables.push(
			this._repository.state.onDidChange(async () => {
				const newRemotes = parseRepositoryRemotes(this._repository);

				// Check if remotes changed by comparing lengths and URLs
				const remotesChanged =
					newRemotes.length !== this._previousRepositoryState.remotes.length ||
					!newRemotes.every((remote, i) => remote.url === this._previousRepositoryState.remotes[i]?.url);

				if (remotesChanged) {
					Logger.appendLine(`Checkout> Repository remotes changed`);
					this._previousRepositoryState.remotes = newRemotes;
				}

				const newHead = this._repository.state.HEAD;
				if (this._previousRepositoryState.HEAD?.name !== newHead?.name) {
					Logger.appendLine(`Checkout> HEAD changed from ${this._previousRepositoryState.HEAD?.name} to ${newHead?.name}`);
					this._previousRepositoryState.HEAD = newHead;
					await this.updateState(!!this._previousRepositoryState.HEAD);
				}
			}),
		);
	}

	public async updateState(silent: boolean = false) {
		if (this.switchingToReviewMode) {
			return;
		}
		if (!this._validateStatusInProgress) {
			Logger.appendLine('Checkout> Starting validation');
			this._validateStatusInProgress = this.validateState(silent);
			this._queuedValidation = false;
			this._validateStatusInProgress.finally(() => {
				if (this._queuedValidation) {
					// A validation was requested while we were busy, do one more
					this._queuedValidation = false;
					this._validateStatusInProgress = this.validateState(true).finally(() => {
						this._validateStatusInProgress = undefined;
					});
				} else {
					this._validateStatusInProgress = undefined;
				}
			});
			return this._validateStatusInProgress;
		} else {
			if (!this._queuedValidation) {
				Logger.appendLine('Checkout> Queuing one additional validation');
				this._queuedValidation = true;
			}
			return this._validateStatusInProgress;
		}
	}

	private async validateState(silent: boolean) {
		try {
			Logger.appendLine('Checkout> Validating state...');
			await this._folderRepoManager.updateRepositories(silent);

			if (!this._repository.state.HEAD) {
				this.clear(true);
				return;
			}

			const branch = this._repository.state.HEAD;
			let matchingPullRequestMetadata = await this._folderRepoManager.getMatchingPullRequestMetadataForBranch();

			if (!matchingPullRequestMetadata) {
				Logger.appendLine(`Checkout> no matching pull request metadata found for current branch ${branch.name}`);
				const metadataFromGithub = await this._folderRepoManager.getMatchingPullRequestMetadataFromGitHub();
				if (metadataFromGithub) {
					PullRequestGitHelper.associateBranchWithPullRequest(this._repository, metadataFromGithub.model, branch.name!);
					matchingPullRequestMetadata = metadataFromGithub;
				}
			}

			if (!matchingPullRequestMetadata) {
				Logger.appendLine(`Checkout> no matching pull request metadata found on GitHub for current branch ${branch.name}`);
				this.clear(true);
				return;
			}

			const hasPushedChanges = branch.commit !== this._lastCommitSha && branch.ahead === 0 && branch.behind === 0;
			if (this._prNumber === matchingPullRequestMetadata.prNumber && !hasPushedChanges) {
				vscode.commands.executeCommand('azdopr.refreshList');
				return;
			}

			const remote = branch.upstream ? branch.upstream.remote : null;
			if (!remote) {
				Logger.appendLine(`Checkout> current branch ${this._repository.state.HEAD.name} hasn't setup remote yet`);
				this.clear(true);
				return;
			}

			Logger.appendLine(
				`Checkout> current branch ${this._repository.state.HEAD.name} is associated with pull request #${matchingPullRequestMetadata.prNumber}`,
			);
			this._prNumber = matchingPullRequestMetadata.prNumber;
			this._lastCommitSha = undefined;

			const pr = await this._folderRepoManager.resolvePullRequest(
				matchingPullRequestMetadata.owner,
				matchingPullRequestMetadata.repositoryName,
				matchingPullRequestMetadata.prNumber,
			);

			this.statusBarItem.text = `$(git-branch) Pull Request #${this._prNumber}`;
			this.statusBarItem.command = {
				command: 'azdopr.openDescription',
				title: 'View Pull Request Description',
				arguments: [pr],
			};
			Logger.appendLine(`Checkout> display pull request status bar indicator`);
			this.statusBarItem.show();
			vscode.commands.executeCommand('azdopr.refreshList');
		} catch (e) {
			Logger.appendLine(`Checkout> validation error: ${e}`);
		}
	}

	public async switch(pr: PullRequestModel): Promise<void> {
		Logger.appendLine(`Checkout> switch to Pull Request #${pr.getPullRequestId()} - start`);
		this.statusBarItem.text = '$(sync~spin) Checking out branch...';
		this.statusBarItem.command = undefined;
		this.statusBarItem.show();
		this.switchingToReviewMode = true;

		try {
			// Delegate actual checkout to FolderRepositoryManager which handles git operations
			const didLocalCheckout = await this._folderRepoManager.checkoutExistingPullRequestBranch(pr);

			if (!didLocalCheckout) {
				await this._folderRepoManager.fetchAndCheckout(pr);
			}

			Logger.appendLine(`Checkout> switch to Pull Request #${pr.getPullRequestId()} - done`);
			this._telemetry.sendTelemetryEvent('pr.checkout');
			// Auto-refresh the webpanel to update the UI with the new checkout state
			if (PullRequestOverviewPanel.currentPanel) {
				PullRequestOverviewPanel.refresh();
			}
		} catch (e) {
			Logger.appendLine(`Checkout> checkout failed #${JSON.stringify(e)}`);
			this.switchingToReviewMode = false;

			if (e instanceof Error && 'gitErrorCode' in e) {
				const gitError = e as { gitErrorCode: string };
				if (
					gitError.gitErrorCode === GitErrorCodes.LocalChangesOverwritten ||
					gitError.gitErrorCode === GitErrorCodes.DirtyWorkTree
				) {
					vscode.window.showErrorMessage(
						'Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches',
					);
					return;
				}
			}

			vscode.window.showErrorMessage(formatError(e));
			return;
		} finally {
			this.switchingToReviewMode = false;
		}
	}

	public clear(includeLocalBranch: boolean): void {
		Logger.appendLine('Checkout> clear');
		this._prNumber = undefined;
		this._lastCommitSha = undefined;
		this._updateMessageShown = false;
		this.statusBarItem.hide();
		vscode.commands.executeCommand('azdopr.refreshList');
		// Auto-refresh the webpanel when exiting checkout
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.refresh();
		}

		if (includeLocalBranch) {
			this.switchingToReviewMode = false;
		}
	}

	dispose(): void {
		this._disposables.forEach(d => d.dispose());
		this._statusBarItem.dispose();
	}
}
