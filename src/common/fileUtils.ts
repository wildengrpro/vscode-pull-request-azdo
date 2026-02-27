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
import { GitChangeType } from './file';
import Logger from './logger';
import { toReviewUri } from './uri';

/**
 * Set of binary file extensions that cannot be displayed as text
 */
const BINARY_EXTENSIONS = new Set([
	'.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
	'.zip', '.tar', '.gz', '.7z', '.rar', '.iso',
	'.exe', '.dll', '.so', '.dylib', '.bin',
	'.mp3', '.mp4', '.wav', '.avi', '.mov', '.wmv', '.flv',
	'.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	'.jar', '.class', '.pyc'
]);

/**
 * Determines if a file is a binary file based on its extension
 * @param filePath Path or name of the file to check
 * @returns True if the file is a binary file, false otherwise
 */
export function isBinaryFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

/**
 * Determines if content is an LFS (Large File Storage) pointer
 * @param content The content to check
 * @returns True if the content is an LFS pointer, false otherwise
 */
export function isLFSPointer(content: string): boolean {
	return content.startsWith('version https://git-lfs.github.com/spec/');
}

/**
 * Represents URIs for both base and head versions of a file
 */
export interface BinaryFileUris {
	/** URI for the base (left) version of the file */
	baseUri: vscode.Uri;
	/** URI for the head (right) version of the file */
	headUri: vscode.Uri;
	/** Whether the branch is checked out locally */
	isLocal: boolean;
}

/**
 * Gets the URIs for opening a binary file, handling both local and remote cases.
 * For unchecked-out branches, returns review:// URIs that work with the content provider.
 * For checked-out branches, returns local file URIs.
 *
 * @param fileChange The file change node to get URIs for
 * @param pr The pull request model
 * @param folderManager The folder repository manager for checking branch status
 * @returns Object containing baseUri and headUri for the file, or undefined if unable to create URIs
 */
export async function getBinaryFileUris(
	fileChange: IFileChangeNode,
	pr: PullRequestModel,
	folderManager: FolderRepositoryManager,
): Promise<BinaryFileUris | undefined> {
	try {
		const fileName = fileChange.fileName;
		const previousFileName = fileChange.previousFileName || fileName;

		// Check if the branch is checked out
		const isLocal = folderManager.isPullRequestCheckedOut(pr);

		if (isLocal) {
			// Branch is checked out - use local file URIs
			Logger.appendLine(`FileUtils> Branch is checked out, using local file URIs for ${fileName}`);

			const baseUri = vscode.Uri.file(path.join(folderManager.repository.rootUri.fsPath, previousFileName));
			const headUri = vscode.Uri.file(path.join(folderManager.repository.rootUri.fsPath, fileName));

			return { baseUri, headUri, isLocal: true };
		} else {
			// Branch is not checked out - use review:// URIs
			Logger.appendLine(`FileUtils> Branch not checked out, using review URIs for ${fileName}`);

			const filePath = path.join(folderManager.repository.rootUri.path, fileName).replace(/\\/g, '/');
			const baseFilePath = path.join(folderManager.repository.rootUri.path, previousFileName).replace(/\\/g, '/');

			const uri = folderManager.repository.rootUri.with({ path: filePath });
			const basePathUri = folderManager.repository.rootUri.with({ path: baseFilePath });

			// Get SHAs for the file versions
			const baseSha = fileChange.status === GitChangeType.ADD ? '' : (fileChange.previousFileSha || '');
			const headSha = fileChange.status === GitChangeType.DELETE ? '' : (fileChange.sha || '');

			const baseUri = toReviewUri(
				basePathUri,
				previousFileName,
				undefined,
				baseSha,
				false,
				{ base: true },
				folderManager.repository.rootUri,
			);

			const headUri = toReviewUri(
				uri,
				fileName,
				undefined,
				headSha,
				false,
				{ base: false },
				folderManager.repository.rootUri,
			);

			return { baseUri, headUri, isLocal: false };
		}
	} catch (error) {
		Logger.appendLine(`FileUtils> Error getting binary file URIs: ${error}`);
		return undefined;
	}
}

