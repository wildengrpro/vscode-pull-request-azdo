/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as pathLib from 'path';
import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { Repository } from './api/api';
import { GitErrorCodes } from './api/api1';
import { CredentialStore } from './azdo/credentials';
import { FolderRepositoryManager } from './azdo/folderRepositoryManager';
import { IFileChangeNodeWithUri, IRawFileChange, PullRequest } from './azdo/interface';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from './azdo/prComment';
import { PullRequestModel } from './azdo/pullRequestModel';
import { PullRequestOverviewPanel } from './azdo/pullRequestOverview';
import { RepositoriesManager } from './azdo/repositoriesManager';
import { AzdoUserManager } from './azdo/userManager';
import { convertRawFileChangeToFileChangeNode, getPositionFromThread, removeLeadingSlash } from './azdo/utils';
import { AzdoWorkItem } from './azdo/workItem';
import { CommentReply, resolveCommentHandler } from './commentHandlerResolver';
import { DiffChangeType } from './common/diffHunk';
import { getZeroBased } from './common/diffPositionMapping';
import { GitChangeType, InMemFileChange } from './common/file';
import Logger from './common/logger';
import { ITelemetry } from './common/telemetry';
import { asImageDataURI, fromPRUri, fromReviewUri, ReviewUriParams, toPRUriAzdo } from './common/uri';
import { formatError } from './common/utils';
import { SETTINGS_NAMESPACE, URI_SCHEME_PR, URI_SCHEME_REVIEW } from './constants';
import { getInMemPRContentProvider, provideDocumentContentForChangeModel } from './view/inMemPRContentProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { PullRequestCommentingRangeProvider } from './view/pullRequestCommentingRangeProvider';
import { CheckoutManager } from './view/checkoutManager';
import { ReviewCommentManager } from './view/reviewCommentManager';
import { PRDataManager } from './view/prDataManager';
import { CommitNode } from './view/treeNodes/commitNode';
import { DescriptionNode } from './view/treeNodes/descriptionNode';
import { GitFileChangeNode, InMemFileChangeNode } from './view/treeNodes/fileChangeNode';
import { PRNode } from './view/treeNodes/pullRequestNode';

const _onDidUpdatePR = new vscode.EventEmitter<PullRequest | void>();
export const onDidUpdatePR: vscode.Event<PullRequest | void> = _onDidUpdatePR.event;

function ensurePR(folderRepoManager: FolderRepositoryManager, pr?: PRNode | PullRequestModel): PullRequestModel {
	// If the command is called from the command palette, no arguments are passed.
	if (!pr) {
		if (!folderRepoManager.activePullRequest) {
			vscode.window.showErrorMessage('Unable to find current pull request.');
			throw new Error('Unable to find current pull request.');
		}

		return folderRepoManager.activePullRequest;
	} else {
		return pr instanceof PRNode ? pr.pullRequestModel : pr;
	}
}

async function chooseItem<T>(
	activePullRequests: T[],
	propertyGetter: (itemValue: T) => string,
	placeHolder?: string,
): Promise<T | undefined> {
	if (activePullRequests.length === 1) {
		return activePullRequests[0];
	}
	interface Item extends vscode.QuickPickItem {
		itemValue: T;
	}
	const items: Item[] = activePullRequests.map(currentItem => {
		return {
			label: propertyGetter(currentItem),
			itemValue: currentItem,
		};
	});
	return (await vscode.window.showQuickPick(items, { placeHolder }))?.itemValue;
}

/**
 * Get comment text from user via input box or editor based on configuration
 * @param prompt Prompt for input
 * @param defaultValue Default value if using editor
 * @returns Comment text or undefined if cancelled
 */
async function getCommentText(prompt: string, defaultValue: string = ''): Promise<string | undefined> {
	const config = vscode.workspace.getConfiguration('azdoPullRequests');
	const inputStyle = config.get<'inputBox' | 'editor'>('commentInputStyle', 'inputBox');

	if (inputStyle === 'editor') {
		// Use full editor for comment input
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:comment.md'));
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.Beside,
			preview: true,
		});

		if (defaultValue) {
			await editor.edit(editBuilder => {
				editBuilder.insert(new vscode.Position(0, 0), defaultValue);
			});
		}

		// Wait for user to finish editing (they must close/change tabs to submit)
		// Store the text before closing
		let commentText = editor.document.getText();
		if (!commentText || !commentText.trim()) {
			return undefined;
		}

		// Auto-close the untitled document after a brief delay to let user see the result
		await new Promise(resolve => setTimeout(resolve, 100));
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

		return commentText;
	} else {
		// Use input box (existing behavior)
		return await vscode.window.showInputBox({
			prompt,
			placeHolder: 'Type your comment here...',
			ignoreFocusOut: true,
		});
	}
}

export function registerCommands(
	context: vscode.ExtensionContext,
	reposManager: RepositoriesManager,
	checkoutManagers: CheckoutManager[],
	commentManagers: ReviewCommentManager[],
	dataManagers: PRDataManager[],
	workItem: AzdoWorkItem,
	azdoUserManager: AzdoUserManager,
	telemetry: ITelemetry,
	credentialStore: CredentialStore,
	tree: PullRequestsTreeDataProvider,
) {
	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.signout', async () => {
			credentialStore.logout();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'azdopr.openPullRequestInAzdo',
			async (e: PRNode | DescriptionNode | PullRequestModel) => {
				if (!e) {
					const activePullRequests: PullRequestModel[] = reposManager.folderManagers
						.map(folderManager => folderManager.activePullRequest!)
						.filter(activePR => !!activePR);

					if (activePullRequests.length >= 1) {
						const result = await chooseItem<PullRequestModel>(activePullRequests, itemValue => itemValue.url);
						if (result) {
							vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(result.url));
						}
					}
				} else if (e instanceof PRNode || e instanceof DescriptionNode) {
					vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.pullRequestModel.url));
				} else {
					vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.url));
				}

				/* __GDPR__
			"pr.openInAzdo" : {}
		*/
				telemetry.sendTelemetryEvent('azdopr.openInAzdo');
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdoreview.suggestDiff', async e => {
			try {
				const folderManager = await chooseItem<FolderRepositoryManager>(reposManager.folderManagers, itemValue =>
					pathLib.basename(itemValue.repository.rootUri.fsPath),
				);
				if (!folderManager || !folderManager.activePullRequest) {
					return;
				}

				const { indexChanges, workingTreeChanges } = folderManager.repository.state;

				if (!indexChanges.length) {
					if (workingTreeChanges.length) {
						const stageAll = await vscode.window.showWarningMessage(
							'There are no staged changes to suggest.\n\nWould you like to automatically stage all your of changes and suggest them?',
							{ modal: true },
							'Yes',
						);
						if (stageAll === 'Yes') {
							await vscode.commands.executeCommand('git.stageAll');
						} else {
							return;
						}
					} else {
						vscode.window.showInformationMessage('There are no changes to suggest.');
						return;
					}
				}

				const diff = await folderManager.repository.diff(true);

				let suggestEditMessage = '';
				if (e && e.inputBox && e.inputBox.value) {
					suggestEditMessage = `${e.inputBox.value}\n`;
					e.inputBox.value = '';
				}

				const suggestEditText = `${suggestEditMessage}\`\`\`diff\n${diff}\n\`\`\``;
				await folderManager.activePullRequest.createThread(suggestEditText);

				// Reset HEAD and then apply reverse diff
				await vscode.commands.executeCommand('git.unstageAll');

				const tempFilePath = pathLib.join(
					folderManager.repository.rootUri.path,
					'.git',
					`${folderManager.activePullRequest.getPullRequestId()}.diff`,
				);
				const encoder = new TextEncoder();
				const tempUri = vscode.Uri.file(tempFilePath);

				await vscode.workspace.fs.writeFile(tempUri, encoder.encode(diff));
				await folderManager.repository.apply(tempUri.fsPath, true);
				await vscode.workspace.fs.delete(tempUri);
			} catch (err) {
				Logger.appendLine(`Applying patch failed: ${err}`);
				vscode.window.showErrorMessage(`Applying patch failed: ${formatError(err)}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.openFileInAzdo', (e: GitFileChangeNode) => {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(e.blobUrl!));
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.copyCommitHash', (e: CommitNode) => {
			vscode.env.clipboard.writeText(e.sha);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.openOriginalFile', async (e: GitFileChangeNode) => {
			// if this is an image, encode it as a base64 data URI
			const folderManager = reposManager.getManagerForPullRequestModel(e.pullRequest);
			if (folderManager) {
				const imageDataURI = await asImageDataURI(e.parentFilePath, folderManager.repository);
				vscode.commands.executeCommand('vscode.open', imageDataURI || e.parentFilePath);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.openModifiedFile', (e: GitFileChangeNode) => {
			vscode.commands.executeCommand('vscode.open', e.filePath);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'azdopr.openDiffView',
			async (fileChangeNode: GitFileChangeNode | InMemFileChangeNode) => {
				const folderManager = reposManager.getManagerForPullRequestModel(fileChangeNode.pullRequest);
				if (!folderManager) {
					return;
				}

				// Set the active pull request to trigger comment initialization
				if (folderManager.activePullRequest !== fileChangeNode.pullRequest) {
					Logger.appendLine(`Commands> openDiffView: Setting active PR #${fileChangeNode.pullRequest.getPullRequestId()}`);
					folderManager.activePullRequest = fileChangeNode.pullRequest;
				}

				await fileChangeNode.openDiff(folderManager);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.deleteLocalBranch', async (e: PRNode) => {
			const folderManager = reposManager.getManagerForPullRequestModel(e.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pullRequestModel = ensurePR(folderManager, e);
			const DELETE_BRANCH_FORCE = 'delete branch (even if not merged)';
			let error = null;

			try {
				await folderManager.deleteLocalPullRequest(pullRequestModel);
			} catch (e) {
				if (e.gitErrorCode === GitErrorCodes.BranchNotFullyMerged) {
					const action = await vscode.window.showErrorMessage(
						`The branch '${pullRequestModel.localBranchName}' is not fully merged, are you sure you want to delete it? `,
						DELETE_BRANCH_FORCE,
					);

					if (action !== DELETE_BRANCH_FORCE) {
						return;
					}

					try {
						await folderManager.deleteLocalPullRequest(pullRequestModel, true);
					} catch (e) {
						error = e;
					}
				} else {
					error = e;
				}
			}

			if (error) {
				/* __GDPR__
				"pr.deleteLocalPullRequest.failure" : {
					"message" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
				}
			*/
				telemetry.sendTelemetryErrorEvent('azdopr.deleteLocalPullRequest.failure', {
					message: error,
				});
				await vscode.window.showErrorMessage(`Deleting local pull request branch failed: ${error}`);
			} else {
				/* __GDPR__
				"pr.deleteLocalPullRequest.success" : {}
			*/
				telemetry.sendTelemetryEvent('azdopr.deleteLocalPullRequest.success');
				// fire and forget
				vscode.commands.executeCommand('azdopr.refreshList');
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.pick', async (pr: PRNode | DescriptionNode | PullRequestModel) => {
			let pullRequestModel: PullRequestModel;

			if (pr instanceof PRNode || pr instanceof DescriptionNode) {
				pullRequestModel = pr.pullRequestModel;
			} else {
				pullRequestModel = pr;
			}

			const fromDescriptionPage = pr instanceof PullRequestModel;
			/* __GDPR__
			"pr.checkout" : {
				"fromDescriptionPage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
			telemetry.sendTelemetryEvent('azdopr.checkout', { fromDescription: fromDescriptionPage.toString() });

			return vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.SourceControl,
					title: `Switching to Pull Request #${pullRequestModel.getPullRequestId()}`,
				},
				async (_progress, _token) => {
					const folderManager = reposManager.getManagerForPullRequestModel(pullRequestModel);
					if (folderManager) {
						const checkoutManager = checkoutManagers.find(
							manager => manager.repository.rootUri.toString() === folderManager.repository.rootUri.toString(),
						);
						if (checkoutManager) {
							await checkoutManager.switch(pullRequestModel);
						}
					}
				},
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.exit', async (pr: PRNode | DescriptionNode | PullRequestModel) => {
			let pullRequestModel: PullRequestModel;

			if (pr instanceof PRNode || pr instanceof DescriptionNode) {
				pullRequestModel = pr.pullRequestModel;
			} else {
				pullRequestModel = pr;
			}

			const fromDescriptionPage = pr instanceof PullRequestModel;
			/* __GDPR__
			"azdopr.exit" : {
				"fromDescriptionPage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
			telemetry.sendTelemetryEvent('azdopr.exit', { fromDescription: fromDescriptionPage.toString() });

			return vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.SourceControl,
					title: `Exiting Pull Request`,
				},
				async (_progress, _token) => {
					const branch = await pullRequestModel.azdoRepository.getDefaultBranch();
					const manager = reposManager.getManagerForPullRequestModel(pullRequestModel);
					if (manager) {
						manager.checkoutDefaultBranch(branch);
					}
				},
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.merge', async (pr?: PRNode) => {
			const folderManager = reposManager.getManagerForPullRequestModel(pr?.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pullRequest = ensurePR(folderManager, pr);
			return vscode.window
				.showWarningMessage(`Are you sure you want to merge this pull request on Azure Devops?`, { modal: true }, 'Yes')
				.then(async value => {
					let newPR;
					if (value === 'Yes') {
						try {
							newPR = await folderManager.mergePullRequest(pullRequest);
							return newPR;
						} catch (e) {
							vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
							return newPR;
						}
					}
				});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.close', async (pr?: PRNode | PullRequestModel, message?: string) => {
			let pullRequestModel: PullRequestModel | undefined;
			if (pr) {
				pullRequestModel = pr instanceof PullRequestModel ? pr : pr.pullRequestModel;
			} else {
				const activePullRequests: PullRequestModel[] = reposManager.folderManagers
					.map(folderManager => folderManager.activePullRequest!)
					.filter(activePR => !!activePR);
				pullRequestModel = await chooseItem<PullRequestModel>(
					activePullRequests,
					itemValue => `${itemValue.getPullRequestId()}: ${itemValue.item.title}`,
					'Pull request to close',
				);
			}
			if (!pullRequestModel) {
				return;
			}
			const pullRequest: PullRequestModel = pullRequestModel;
			return vscode.window
				.showWarningMessage(
					`Are you sure you want to abondon this pull request? This will close the pull request without merging.`,
					{ modal: true },
					'Yes',
					'No',
				)
				.then(async value => {
					if (value === 'Yes') {
						try {
							let newComment: GitPullRequestCommentThread | undefined = undefined;
							if (message) {
								newComment = await pullRequest.createThread(message);
							}

							const newPR = await pullRequest.abandon();
							vscode.commands.executeCommand('azdopr.refreshList');
							_onDidUpdatePR.fire(newPR);
							return newComment;
						} catch (e) {
							vscode.window.showErrorMessage(`Unable to close pull request. ${formatError(e)}`);
							_onDidUpdatePR.fire();
						}
					}

					_onDidUpdatePR.fire();
				});
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.openDescription', async (argument: DescriptionNode | PullRequestModel) => {
			const pullRequestModel = argument instanceof DescriptionNode ? argument.pullRequestModel : argument;
			const folderManager = reposManager.getManagerForPullRequestModel(pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pullRequest = ensurePR(folderManager, pullRequestModel);
			// Create and show the webview (description node reveal is not available with new architecture)
			PullRequestOverviewPanel.createOrShow(context.extensionPath, folderManager, pullRequest, workItem, azdoUserManager);

			/* __GDPR__
			"azdopr.openDescription" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.openDescription');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.refreshDescription', async () => {
			if (PullRequestOverviewPanel.currentPanel) {
				PullRequestOverviewPanel.refresh();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.openDescriptionToTheSide', async (descriptionNode: DescriptionNode) => {
			const folderManager = reposManager.getManagerForPullRequestModel(descriptionNode.pullRequestModel);
			if (!folderManager) {
				return;
			}
			const pr = descriptionNode.pullRequestModel;
			const pullRequest = ensurePR(folderManager, pr);
			descriptionNode.reveal(descriptionNode, { select: true, focus: true });
			// Create and show a new webview
			PullRequestOverviewPanel.createOrShow(
				context.extensionPath,
				folderManager,
				pullRequest,
				workItem,
				azdoUserManager,
				true,
			);

			/* __GDPR__
			"azdopr.openDescriptionToTheSide" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.openDescriptionToTheSide');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.viewChanges', async (fileChange: GitFileChangeNode) => {
			// Set the active pull request so comment managers initialize
			const folderManager = reposManager.getManagerForPullRequestModel(fileChange.pullRequest);
			if (folderManager && folderManager.activePullRequest !== fileChange.pullRequest) {
				Logger.appendLine(`Commands> azdopr.viewChanges: Setting active PR #${fileChange.pullRequest.getPullRequestId()}`);
				folderManager.activePullRequest = fileChange.pullRequest;
			}

			if (fileChange.status === GitChangeType.DELETE || fileChange.status === GitChangeType.ADD) {
				// create an empty `review` uri without any path/commit info.
				const emptyFileUri = fileChange.parentFilePath.with({
					query: JSON.stringify({
						path: null,
						commit: null,
					}),
				});

				return fileChange.status === GitChangeType.DELETE
					? vscode.commands.executeCommand(
							'vscode.diff',
							fileChange.parentFilePath,
							emptyFileUri,
							`${fileChange.fileName}`,
							{ preserveFocus: true },
					  )
					: vscode.commands.executeCommand(
							'vscode.diff',
							emptyFileUri,
							fileChange.parentFilePath,
							`${fileChange.fileName}`,
							{ preserveFocus: true },
					  );
			}

			// Show the file change in a diff view.
			const { path, ref, commit, rootPath } = fromReviewUri(fileChange.parentFilePath);
			const previousCommit = `${commit}^`;
			const query: ReviewUriParams = {
				path: path,
				ref: ref,
				commit: previousCommit,
				base: true,
				isOutdated: true,
				rootPath,
			};
			const previousFileUri = fileChange.filePath.with({ query: JSON.stringify(query) });

			const options: vscode.TextDocumentShowOptions = {
				preserveFocus: true,
			};

			if (fileChange.comments && fileChange.comments.length) {
				const sortedOutdatedComments = fileChange.comments
					.filter(comment => getPositionFromThread(comment) === undefined)
					.sort((a, b) => {
						return getPositionFromThread(a)! - getPositionFromThread(b)!;
					});

				if (sortedOutdatedComments.length) {
					const lastHunk = fileChange.diffHunks[fileChange.diffHunks.length - 1];
					// const diffLine =  getDiffLineByPosition(fileChange.diffHunks, sortedOutdatedComments[0].originalPosition!);
					const diffLine = lastHunk.diffLines[lastHunk.diffLines.length - 1];

					if (diffLine) {
						const lineNumber = Math.max(
							getZeroBased(
								diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber,
							),
							0,
						);
						options.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
					}
				}
			}

			return vscode.commands.executeCommand(
				'vscode.diff',
				previousFileUri,
				fileChange.filePath,
				`${fileChange.fileName} from ${(commit || '').substr(0, 8)}`,
				options,
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.signin', async () => {
			await reposManager.authenticate();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.deleteLocalBranchesNRemotes', async () => {
			for (const folderManager of reposManager.folderManagers) {
				await folderManager.deleteLocalBranchesNRemotes();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.signinAndRefreshList', async () => {
			await vscode.commands.executeCommand('azdopr.signin');
			vscode.commands.executeCommand('azdopr.refreshList');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.configureRemotes', async () => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { name, publisher } = require('../package.json') as { name: string; publisher: string };
			const extensionId = `${publisher}.${name}`;

			return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} remotes`);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.createComment', async (reply: CommentReply) => {
			/* __GDPR__
			"azdopr.createComment" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.createComment');
			const handler = resolveCommentHandler(reply.thread);

			if (handler) {
				handler.createOrReplyComment(reply.thread, reply.text);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.changeThreadStatus', async (thread: GHPRCommentThread) => {
			/* __GDPR__
			"azdopr.createComment" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.changeThreadStatus');
			const handler = resolveCommentHandler(thread);

			if (handler) {
				await handler.changeThreadStatus(thread);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.editComment', async (comment: GHPRComment | TemporaryComment) => {
			/* __GDPR__
			"azdopr.editComment" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.editComment');
			comment.startEdit();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.cancelEditComment', async (comment: GHPRComment | TemporaryComment) => {
			/* __GDPR__
			"azdopr.cancelEditComment" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.cancelEditComment');
			comment.cancelEdit();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.saveComment', async (comment: GHPRComment | TemporaryComment) => {
			/* __GDPR__
			"azdopr.saveComment" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.saveComment');
			const handler = resolveCommentHandler(comment.parent);

			if (handler) {
				await handler.editComment(comment.parent, comment);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.addCommentOnPRFile', async (fileNode: GitFileChangeNode | InMemFileChangeNode) => {
			/* __GDPR__
			"azdopr.addCommentOnPRFile" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.addCommentOnPRFile');

			try {
				const folderManager = reposManager.getManagerForPullRequestModel(fileNode.pullRequest);
				if (!folderManager) {
					vscode.window.showErrorMessage('Unable to find repository manager');
					return;
				}

				// Get active editor - handle both pr_azdo:// and file:// URIs
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					vscode.window.showErrorMessage('Please open the file in the editor first');
					return;
				}

				// Get selection or cursor position
				const selection = editor.selection;
				let line = selection.active.line + 1; // 1-indexed for API

				// Get comment text using configured input style
				const commentText = await getCommentText(`Add comment on line ${line}`);

				if (!commentText) {
					return;
				}

				// Determine if this is the base (left) or head (right) file
				const params = fromPRUri(fileNode.filePath);
				const isBase = params?.isBase ?? false;

				// Create the thread via PR API
				await fileNode.pullRequest.createThread(commentText, {
					filePath: fileNode.fileName,
					line: line,
					startOffset: 1,
					endOffset: 1,
					isLeft: isBase,
				});

				// Refresh PR description if it's open
				if (PullRequestOverviewPanel.currentPanel) {
					PullRequestOverviewPanel.refresh();
				}

				vscode.window.showInformationMessage('Comment added successfully!');
			} catch (error) {
				Logger.appendLine(`Error adding comment: ${error}`);
				vscode.window.showErrorMessage(`Failed to add comment: ${error}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.addFileComment', async (fileNode: GitFileChangeNode | InMemFileChangeNode) => {
			/* __GDPR__
			"azdopr.addFileComment" : {}
		*/
			telemetry.sendTelemetryEvent('azdopr.addFileComment');

			try {
				const folderManager = reposManager.getManagerForPullRequestModel(fileNode.pullRequest);
				if (!folderManager) {
					vscode.window.showErrorMessage('Unable to find repository manager');
					return;
				}

				// Get comment text using configured input style
				const commentText = await getCommentText(`Add comment for ${pathLib.basename(fileNode.fileName)}`);

				if (!commentText) {
					return;
				}

				// Determine if this is the base (left) or head (right) file
				const params = fromPRUri(fileNode.filePath);
				const isBase = params?.isBase ?? false;

				// Create file-level thread with file path context (line: 1 for file-level)
				await fileNode.pullRequest.createThread(commentText, {
					filePath: fileNode.fileName,
					line: 1,
					startOffset: 1,
					endOffset: 1,
					isLeft: isBase,
				});

				// Refresh PR description if it's open
				if (PullRequestOverviewPanel.currentPanel) {
					PullRequestOverviewPanel.refresh();
				}

				vscode.window.showInformationMessage(`File comment added to ${fileNode.fileName}`);
			} catch (error) {
				Logger.appendLine(`Error adding file comment: ${error}`);
				vscode.window.showErrorMessage(`Failed to add file comment: ${error}`);
			}
		}),
	);

	// context.subscriptions.push(vscode.commands.registerCommand('azdopr.deleteComment', async (comment: GHPRComment | TemporaryComment) => {
	// 	/* __GDPR__
	// 		"azdopr.deleteComment" : {}
	// 	*/
	// 	telemetry.sendTelemetryEvent('azdopr.deleteComment');

	// 	const shouldDelete = await vscode.window.showWarningMessage('Delete comment?', { modal: true }, 'Delete');

	// 	if (shouldDelete === 'Delete') {
	// 		const handler = resolveCommentHandler(comment.parent);

	// 		if (handler) {
	// 			await handler.deleteComment(comment.parent, comment);
	// 		}
	// 	}
	// }));

	context.subscriptions.push(
		vscode.commands.registerCommand('azdoreview.openFile', (value: GitFileChangeNode | vscode.Uri) => {
			// If it's a GitFileChangeNode, set the active PR to trigger comment initialization
			if (value instanceof GitFileChangeNode) {
				const folderManager = reposManager.getManagerForPullRequestModel(value.pullRequest);
				if (folderManager && folderManager.activePullRequest !== value.pullRequest) {
					Logger.appendLine(`Commands> azdoreview.openFile: Setting active PR #${value.pullRequest.getPullRequestId()}`);
					folderManager.activePullRequest = value.pullRequest;
				}
			}

			const uri = value instanceof GitFileChangeNode ? value.filePath : value;

			const activeTextEditor = vscode.window.activeTextEditor;
			const opts: vscode.TextDocumentShowOptions = {
				preserveFocus: true,
				viewColumn: vscode.ViewColumn.Active,
			};

			// Check if active text editor has same path as other editor. we cannot compare via
			// URI.toString() here because the schemas can be different. Instead we just go by path.
			if (activeTextEditor && activeTextEditor.document.uri.path === uri.path) {
				opts.selection = activeTextEditor.selection;
			}

			vscode.commands.executeCommand('vscode.open', uri, opts);
		}),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.openChangedFile', (value: GitFileChangeNode) => {
			const openDiff = vscode.workspace.getConfiguration().get('git.openDiffOnClick');
			if (openDiff) {
				return vscode.commands.executeCommand('azdopr.openDiffView', value);
			} else {
				return vscode.commands.executeCommand('azdoreview.openFile', value);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.refreshChanges', _ => {
			// Find active PRs in folder managers and update their comment managers
			for (let i = 0; i < reposManager.folderManagers.length; i++) {
				const folderManager = reposManager.folderManagers[i];
				if (folderManager.activePullRequest && commentManagers[i]) {
					commentManagers[i].updateComments(folderManager.activePullRequest);
				}
			}
			PullRequestOverviewPanel.refresh();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.setFileListLayoutAsTree', _ => {
			vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).update('fileListLayout', 'tree', true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.setFileListLayoutAsFlat', _ => {
			vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).update('fileListLayout', 'flat', true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.toggleFileListLayout', _ => {
			const config = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
			const currentLayout = config.get<string>('fileListLayout');
			const newLayout = currentLayout === 'tree' ? 'flat' : 'tree';
			config.update('fileListLayout', newLayout, true);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.refreshPullRequest', (prNode: PRNode) => {
			const folderManager = reposManager.getManagerForPullRequestModel(prNode.pullRequestModel);
			if (folderManager && prNode.pullRequestModel.equals(folderManager?.activePullRequest)) {
				// Find the comment manager for this folder and update comments
				const folderIndex = reposManager.folderManagers.indexOf(folderManager);
				if (folderIndex >= 0 && commentManagers[folderIndex]) {
					commentManagers[folderIndex].updateComments(prNode.pullRequestModel);
				}
			}

			PullRequestOverviewPanel.refresh();
			tree.refresh(prNode);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.markFileAsViewed', async (treeNode: GitFileChangeNode) => {
			try {
				await treeNode.pullRequest.markFileAsViewed(treeNode.sha);
			} catch (e) {
				vscode.window.showErrorMessage(`Marked file as viewed failed: ${e}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.unmarkFileAsViewed', async (treeNode: GitFileChangeNode) => {
			try {
				await treeNode.pullRequest.unmarkFileAsViewed(treeNode.sha);
			} catch (e) {
				vscode.window.showErrorMessage(`Marked file as not viewed failed: ${e}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.applySuggestionWithCopilot', async (commentThread: GHPRCommentThread) => {
			/* __GDPR__
				"pr.applySuggestionWithCopilot" : {}
			*/
			telemetry.sendTelemetryEvent('azdopr.applySuggestionWithCopilot');

			commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			const messages = commentThread.comments.map(comment => {
				const body = comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body;
				return `- ${comment.author.name}: ${body}`;
			}).join('\n');

			await vscode.commands.executeCommand('vscode.editorChat.start', {
				initialRange: commentThread.range,
				message: messages,
				autoSend: true,
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('azdopr.toggleFilesWithCommentsFilter', (node: any) => {
			// The command receives the FilesCategoryNode that was clicked
			if (node && typeof node.toggleCommentsFilter === 'function') {
				node.toggleCommentsFilter();
			}
		})
	);
}
