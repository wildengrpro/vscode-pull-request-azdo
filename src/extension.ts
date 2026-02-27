/* eslint-disable @typescript-eslint/no-var-requires */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import { LiveShare } from 'vsls/vscode.js';
import { Repository } from './api/api';
import { GitApiImpl } from './api/api1';
import { CredentialStore } from './azdo/credentials';
import { FileReviewedStatusService } from './azdo/fileReviewedStatusService';
import { FolderRepositoryManager } from './azdo/folderRepositoryManager';
import { RepositoriesManager } from './azdo/repositoriesManager';
import { AzdoUserManager } from './azdo/userManager';
import { AzdoWorkItem } from './azdo/workItem';
import { registerCommands } from './commands';
import { LocalStorageService } from './common/localStorageService';
import Logger from './common/logger';
import * as PersistentState from './common/persistentState';
import { Resource } from './common/resources';
import { handler as uriHandler } from './common/uri';
import { onceEvent } from './common/utils';
import { EXTENSION_ID, SETTINGS_NAMESPACE, URI_SCHEME_PR } from './constants';
import { ContextManager } from './ContextManager';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { MockGitProvider } from './gitProviders/mockGitProvider';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { getInMemPRContentProvider } from './view/inMemPRContentProvider';
import { PullRequestChangesTreeDataProvider } from './view/prChangesTreeDataProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { CheckoutManager } from './view/checkoutManager';
import { ReviewCommentManager } from './view/reviewCommentManager';
import { PRDataManager } from './view/prDataManager';
import { ReviewsManager } from './view/reviewsManager';

const aiKey: string = '6d22c8ed-52c8-4779-a6f8-09c748e18e95';

// fetch.promise polyfill
const PolyfillPromise = require('es6-promise').Promise;
const fetch = require('node-fetch');

fetch.Promise = PolyfillPromise;

let telemetry: TelemetryReporter;

async function init(
	context: vscode.ExtensionContext,
	git: GitApiImpl,
	credentialStore: CredentialStore,
	repositories: Repository[],
	tree: PullRequestsTreeDataProvider,
	liveshareApiPromise: Promise<LiveShare | undefined>,
): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	// vscode.authentication.onDidChangeSessions(async e => {
	// 	if (e.provider.id === 'github') {
	// 		await reposManager.clearCredentialCache();
	// 		if (reviewManagers) {
	// 			reviewManagers.forEach(reviewManager => reviewManager.updateState());
	// 		}
	// 	}
	// });

	const localStorageService = new LocalStorageService(context.workspaceState);
	const fileReviewedStatusService = new FileReviewedStatusService(localStorageService);

	vscode.authentication.onDidChangeSessions(async (e) => {
		if (e.provider.id === 'microsoft') {
			await reposManager.clearCredentialCache();
			if (checkoutManagers) {
				checkoutManagers.forEach(manager => manager.updateState());
			}
		}
	});

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());
	// Sort the repositories to match folders in a multiroot workspace (if possible).
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		repositories = repositories.sort((a, b) => {
			let indexA = workspaceFolders.length;
			let indexB = workspaceFolders.length;
			for (let i = 0; i < workspaceFolders.length; i++) {
				if (workspaceFolders[i].uri.toString() === a.rootUri.toString()) {
					indexA = i;
				} else if (workspaceFolders[i].uri.toString() === b.rootUri.toString()) {
					indexB = i;
				}
				if (indexA !== workspaceFolders.length && indexB !== workspaceFolders.length) {
					break;
				}
			}
			return indexA - indexB;
		});
	}

	const workItem = new AzdoWorkItem(credentialStore, telemetry);
	await workItem.ensure();
	context.subscriptions.push(workItem);

	const userManager = new AzdoUserManager(credentialStore, telemetry);
	await userManager.ensure();
	context.subscriptions.push(userManager);
	const folderManagers = repositories.map(
		repository => new FolderRepositoryManager(repository, telemetry, git, credentialStore, fileReviewedStatusService),
	);
	context.subscriptions.push(...folderManagers);
	const reposManager = new RepositoriesManager(folderManagers, credentialStore, telemetry);
	context.subscriptions.push(reposManager);

	liveshareApiPromise.then(api => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			// TODO used by VLSS.
			// api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(reposManager));
		}
	});
	const changesTree = new PullRequestChangesTreeDataProvider(context);
	context.subscriptions.push(changesTree);

	// Initialize three independent manager arrays
	const checkoutManagers: CheckoutManager[] = [];
	const commentManagers: ReviewCommentManager[] = [];
	const dataManagers: PRDataManager[] = [];

	for (const folderManager of folderManagers) {
		const checkoutManager = new CheckoutManager(context, folderManager.repository, folderManager, telemetry);
		const commentManager = new ReviewCommentManager(folderManager.repository, folderManager, telemetry);
		const dataManager = new PRDataManager(folderManager.repository, folderManager, changesTree);

		checkoutManagers.push(checkoutManager);
		commentManagers.push(commentManager);
		dataManagers.push(dataManager);

		context.subscriptions.push(checkoutManager, commentManager, dataManager);

			// Subscribe to PR activation to initialize comment and data managers
		context.subscriptions.push(
			folderManager.onDidChangeActivePullRequest(async () => {
				const pr = folderManager.activePullRequest;
				if (pr) {
					try {
						// First fetch comments from the PR
						Logger.appendLine(`Extension> Fetching comments for PR #${pr.getPullRequestId()}`);
						await commentManager.fetchComments(pr);
						const comments = commentManager.comments;

						// Get PR data (file changes) with the fetched comments
						const prData = await dataManager.getPullRequestData(pr, comments);
						const { localFileChanges, obsoleteFileChanges } = prData;

						// Initialize comment manager with the PR and file changes
						Logger.appendLine(`Extension> Initializing comment controller for PR #${pr.getPullRequestId()} with ${localFileChanges.length} files`);
						await commentManager.initialize(pr, localFileChanges);

						// Update comment manager with file changes
						await commentManager.update(localFileChanges, obsoleteFileChanges);

						Logger.appendLine(`Extension> Initialized comment and data managers for PR #${pr.getPullRequestId()}`);
					// Auto-open the Description webpanel when PR is activated
					Logger.appendLine(`Extension> Auto-opening Description webpanel for PR #${pr.getPullRequestId()}`);
					await vscode.commands.executeCommand('azdopr.openDescription', pr);					} catch (e) {
						Logger.appendLine(`Extension> Failed to initialize managers for PR: ${e}`);
					}
				} else {
					// PR deactivated
					Logger.appendLine('Extension> PR deactivated');
				}
			}),
		);
	}

	const reviewsManager = new ReviewsManager(context, reposManager, checkoutManagers, tree, changesTree, telemetry, git);
	context.subscriptions.push(reviewsManager);
	tree.initialize(reposManager);
	registerCommands(context, reposManager, checkoutManagers, commentManagers, dataManagers, workItem, userManager, telemetry, credentialStore, tree);
	const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('fileListLayout');
	await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat');

	// Debounce git state changes to avoid excessive validation calls
	let gitStateTimeout: NodeJS.Timeout | undefined;
	git.onDidChangeState(() => {
		if (gitStateTimeout) {
			clearTimeout(gitStateTimeout);
		}
		gitStateTimeout = setTimeout(() => {
			Logger.appendLine('Extension> Git state changed, validating checkout state...');
			checkoutManagers.forEach(manager => manager.updateState(true));
		}, 1000);
	});
	context.subscriptions.push({ dispose: () => { if (gitStateTimeout) clearTimeout(gitStateTimeout); } });

	git.onDidOpenRepository(repo => {
		const disposable = repo.state.onDidChange(() => {
			const newFolderManager = new FolderRepositoryManager(
				repo,
				telemetry,
				git,
				credentialStore,
				fileReviewedStatusService,
			);
			reposManager.insertFolderManager(newFolderManager);

			// Create the three independent managers for the new repository
			const newCheckoutManager = new CheckoutManager(context, newFolderManager.repository, newFolderManager, telemetry);
			const newCommentManager = new ReviewCommentManager(newFolderManager.repository, newFolderManager, telemetry);
			const newDataManager = new PRDataManager(newFolderManager.repository, newFolderManager, changesTree);

			checkoutManagers.push(newCheckoutManager);
			commentManagers.push(newCommentManager);
			dataManagers.push(newDataManager);

			context.subscriptions.push(newCheckoutManager, newCommentManager, newDataManager);

			// Subscribe to PR activation for the new repository
			context.subscriptions.push(
				newFolderManager.onDidChangeActivePullRequest(async () => {
					const pr = newFolderManager.activePullRequest;
					if (pr) {
						try {
							// First fetch comments from the PR
							Logger.appendLine(`Extension> Fetching comments for PR #${pr.getPullRequestId()} in new repo`);
							await newCommentManager.fetchComments(pr);
							const comments = newCommentManager.comments;

							// Get PR data (file changes) with the fetched comments
							const prData = await newDataManager.getPullRequestData(pr, comments);
							const { localFileChanges, obsoleteFileChanges } = prData;

							// Initialize comment manager with the PR and file changes
							Logger.appendLine(`Extension> Initializing comment controller for PR #${pr.getPullRequestId()} with ${localFileChanges.length} files`);
							await newCommentManager.initialize(pr, localFileChanges);

							// Update comment manager with file changes
							await newCommentManager.update(localFileChanges, obsoleteFileChanges);

							Logger.appendLine(`Extension> Initialized comment and data managers for PR #${pr.getPullRequestId()}`);
						} catch (e) {
							Logger.appendLine(`Extension> Failed to initialize managers for PR: ${e}`);
						}
					} else {
						// PR deactivated
						Logger.appendLine('Extension> PR deactivated');
					}
				}),
			);
			tree.refresh();
			disposable.dispose();
		});
	});

	git.onDidCloseRepository(repo => {
		reposManager.removeRepo(repo);

		const checkoutIndex = checkoutManagers.findIndex(
			manager => manager.repository.rootUri.toString() === repo.rootUri.toString(),
		);
		if (checkoutIndex >= 0) {
			const checkoutManager = checkoutManagers[checkoutIndex];
			const commentManager = commentManagers[checkoutIndex];
			const dataManager = dataManagers[checkoutIndex];

			Logger.appendLine(`Extension> Closing repository ${repo.rootUri.fsPath}`);
			checkoutManagers.splice(checkoutIndex, 1);
			commentManagers.splice(checkoutIndex, 1);
			dataManagers.splice(checkoutIndex, 1);

			checkoutManager.dispose();
			commentManager.dispose();
			dataManager.dispose();
		}

		tree.refresh();
	});

	await vscode.commands.executeCommand('setContext', 'azdo:initialized', true);
	// TODO Investigate what is intialized in issues
	// const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewManagers, context, telemetry);
	// context.subscriptions.push(issuesFeatures);
	// await issuesFeatures.initialize();

	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	// initialize resources
	Resource.initialize(context);
	const apiImpl = new GitApiImpl();

	const version = context.extension.packageJSON.version;
	telemetry = new TelemetryReporter(EXTENSION_ID, version, aiKey);
	context.subscriptions.push(telemetry);

	PersistentState.init(context);

	// const session = await registerGithubExtension();

	const builtInGitProvider = await registerBuiltinGitProvider(apiImpl);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
	} else {
		const mockGitProvider = new MockGitProvider();
		context.subscriptions.push(apiImpl.registerGitProvider(mockGitProvider));
	}

	const credentialStore = new CredentialStore(telemetry, context.secrets, apiImpl);
	context.subscriptions.push(credentialStore);
	await credentialStore.initialize();

	const liveshareGitProvider = registerLiveShareGitProvider(apiImpl);
	context.subscriptions.push(liveshareGitProvider);
	const liveshareApiPromise = liveshareGitProvider.initialize();

	context.subscriptions.push(apiImpl);

	Logger.appendLine('Looking for git repository');

	// Initialize ContextManager for multi-root workspace support
	// Hybrid pattern: sync folder detection, async context extraction
	Logger.appendLine('Initializing ContextManager for multi-root support...');
	const contextManager = new ContextManager(apiImpl);
	context.subscriptions.push(contextManager);

	// Initialize returns immediately after folder detection
	// Context extraction happens in background
	await contextManager.initialize();

	// Log workspace context info
	const workspaceContext = contextManager.getWorkspaceContext();
	Logger.appendLine(
		`Workspace has ${workspaceContext.folders.size} folder(s). Multi-root: ${contextManager.isMultiRoot()}`
	);

	const prTree = new PullRequestsTreeDataProvider(telemetry);
	context.subscriptions.push(prTree);

	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(URI_SCHEME_PR, getInMemPRContentProvider()));

	if (apiImpl.repositories.length > 0) {
		await init(context, apiImpl, credentialStore, apiImpl.repositories, prTree, liveshareApiPromise);
	} else {
		onceEvent(apiImpl.onDidOpenRepository)(r => init(context, apiImpl, credentialStore, [r], prTree, liveshareApiPromise));
	}

	return apiImpl;
}

const SCOPES = ['vso.identity', 'vso.code'];
async function registerGithubExtension() {
	const session = await vscode.authentication.getSession('azdo', SCOPES, { createIfNone: false });
	return session;
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}
