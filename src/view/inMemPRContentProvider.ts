/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { IFileChangeNode } from '../azdo/interface';
import { PullRequestModel } from '../azdo/pullRequestModel';
import { GitChangeType } from '../common/file';
import Logger from '../common/logger';
import { fromPRUri, PRUriParams } from '../common/uri';
import { spawn } from 'child_process';

// Binary file extensions that cannot be displayed as text
const BINARY_EXTENSIONS = new Set([
	'.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
	'.zip', '.tar', '.gz', '.7z', '.rar', '.iso',
	'.exe', '.dll', '.so', '.dylib', '.bin',
	'.mp3', '.mp4', '.wav', '.avi', '.mov', '.wmv', '.flv',
	'.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	'.jar', '.class', '.pyc'
]);

export function isBinaryFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

export function isLFSPointer(content: string): boolean {
	return content.startsWith('version https://git-lfs.github.com/spec/');
}

/**
 * Smudge LFS pointer content to get the actual binary file
 */
async function smudgeLFSPointer(pointerContent: string, repoPath: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		try {
			Logger.appendLine(`LFS> Smudging LFS pointer in content provider`);

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
					Logger.appendLine(`LFS> Successfully smudged LFS pointer, size: ${result.length} bytes`);
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

export class InMemPRContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> {
		return this._onDidChange.event;
	}

	fireDidChange(uri: vscode.Uri) {
		this._onDidChange.fire(uri);
	}

	private _prFileChangeContentProviders: { [key: number]: (uri: vscode.Uri) => Promise<string> } = {};

	constructor() {}

	async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken): Promise<string> {
		const prUriParams = fromPRUri(uri);
		if (prUriParams && prUriParams.prNumber) {
			const provider = this._prFileChangeContentProviders[prUriParams.prNumber];

			if (provider) {
				return await provider(uri);
			}
		}

		return '';
	}

	registerTextDocumentContentProvider(prNumber: number, provider: (uri: vscode.Uri) => Promise<string>): vscode.Disposable {
		this._prFileChangeContentProviders[prNumber] = provider;

		return {
			dispose: () => {
				delete this._prFileChangeContentProviders[prNumber];
			},
		};
	}
}

const inMemPRContentProvider = new InMemPRContentProvider();

export function getInMemPRContentProvider(): InMemPRContentProvider {
	return inMemPRContentProvider;
}

export async function provideDocumentContentForChangeModel(params: PRUriParams, pullRequestModel: PullRequestModel, folderReposManager: FolderRepositoryManager, fileChange: IFileChangeNode, isFileRemote: boolean): Promise<string> {
	if (
		(params.isBase && fileChange.status === GitChangeType.ADD) ||
		(!params.isBase && fileChange.status === GitChangeType.DELETE)
	) {
		return '';
	}

	// Check if this is a binary file that cannot be displayed as text
	if (isBinaryFile(fileChange.fileName)) {
		Logger.appendLine(`PR> Binary file detected: ${fileChange.fileName}, cannot display as text`);
		// Return empty content - user should use diff view or open locally
		return '';
	}

	if (isFileRemote) {
		try {
			const sha = params.isBase ? fileChange.previousFileSha : fileChange.sha ?? fileChange.sha;
			Logger.appendLine(`PR> Fetching file content from AzDO: ${sha}`);
			const content = await pullRequestModel.getFile(sha);
			Logger.debug(`PR> Fetched file content from AzDO: ${sha}, content: ${content}`, 'InMemPRContentProvider');

			// Check if the content is a Git LFS pointer
			if (isLFSPointer(content)) {
				Logger.appendLine(`PR> Git LFS pointer detected for remote file: ${fileChange.fileName}`);
				return '';
			}

			return content;
		} catch (e) {
			Logger.appendLine(`PR> Fetching file content failed: ${e}`);
			vscode.window
				.showWarningMessage(
					'Opening this file locally failed. Would you like to view it on AzDO?',
					'Open in AzDO',
				)
				.then(result => {
					if (result === 'Open in AzDO') {
						vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(fileChange.blobUrl));
					}
				});
			return '';
		}
	} else {
		if (fileChange.status === GitChangeType.ADD) {
			const originalFileName = fileChange.fileName;
			const originalFilePath = vscode.Uri.joinPath(folderReposManager.repository.rootUri, originalFileName!);
			const commit = params.headCommit;
			const originalContent = await folderReposManager.repository.show(commit, originalFilePath.fsPath);

			// Check for LFS pointer
			if (isLFSPointer(originalContent)) {
				Logger.appendLine(`PR> Git LFS pointer detected for ADD file: ${fileChange.fileName}`);
				return '';
			}

			return originalContent;
		} else if (fileChange.status === GitChangeType.RENAME) {
			let commit = params.baseCommit;
			let originalFileName = fileChange.previousFileName;
			if (!params.isBase) {
				commit = params.headCommit;
				originalFileName = fileChange.fileName;
			}

			const originalFilePath = vscode.Uri.joinPath(folderReposManager.repository.rootUri, originalFileName!);
			const originalContent = await folderReposManager.repository.show(commit, originalFilePath.fsPath);

			// Check for LFS pointer
			if (isLFSPointer(originalContent)) {
				Logger.appendLine(`PR> Git LFS pointer detected for RENAME file: ${fileChange.fileName}`);
				return '';
			}

			return originalContent;
		} else {
			const originalFileName =
				fileChange.status === GitChangeType.DELETE ? fileChange.previousFileName : fileChange.fileName;
			const originalFilePath = vscode.Uri.joinPath(folderReposManager.repository.rootUri, originalFileName!);
			let commit = params.baseCommit;
			if (!params.isBase) {
				commit = params.headCommit;
			}
			const originalContent = await folderReposManager.repository.show(commit, originalFilePath.fsPath);

			// Check for LFS pointer
			if (isLFSPointer(originalContent)) {
				Logger.appendLine(`PR> Git LFS pointer detected for file: ${fileChange.fileName}`);
				return '';
			}

			return originalContent;
		}
	}

	return '';
}