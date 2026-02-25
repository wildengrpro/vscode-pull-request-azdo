/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as pathUtils from 'path';
import { EventEmitter, Uri, UriHandler } from 'vscode';
import { Repository } from '../api/api';
import { PullRequestModel as AzdoPullRequestModel } from '../azdo/pullRequestModel';
import { URI_SCHEME_PR, URI_SCHEME_RESOURCE, URI_SCHEME_REVIEW } from '../constants';
import { GitChangeType } from './file';
import { getGitChangeTypeFromVersionControlChangeType } from './diffHunk';
import { removeLeadingSlash } from '../azdo/utils';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { IRawFileChange } from '../azdo/interface';
import { spawn } from 'child_process';
import Logger from './logger';

export interface ReviewUriParams {
	path: string;
	ref?: string;
	commit?: string;
	base: boolean;
	isOutdated: boolean;
	rootPath: string;
}

export function fromReviewUri(uri: Uri): ReviewUriParams {
	return JSON.parse(uri.query);
}

export interface PRUriParams {
	baseCommit: string;
	headCommit: string;
	isBase: boolean;
	fileName: string;
	prNumber: number;
	status: GitChangeType;
	remoteName: string;
}

export function fromPRUri(uri: Uri): PRUriParams | undefined {
	try {
		return JSON.parse(uri.query) as PRUriParams;
	} catch (e) {}
}

export interface GitUriOptions {
	replaceFileExtension?: boolean;
	submoduleOf?: string;
	base: boolean;
}

const ImageMimetypes = ['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/tiff', 'image/bmp'];
const BinaryMimetypes = [
	'application/pdf',
	'application/zip',
	'application/x-zip-compressed',
	'application/octet-stream'
];

// a 1x1 pixel transparent gif, from http://png-pixel.com/
export const EMPTY_IMAGE_URI = Uri.parse(`data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==`);

/**
 * Check if content is a Git LFS pointer file
 */
function isLFSPointer(content: string | Buffer): boolean {
	const contentStr = Buffer.isBuffer(content) ? content.toString('utf8', 0, Math.min(200, content.length)) : content.substring(0, 200);
	return contentStr.startsWith('version https://git-lfs.github.com/spec/');
}

/**
 * Run content through git lfs smudge filter to get actual file
 */
async function smudgeLFSContent(pointerContent: string | Buffer, repoPath: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		try {
			const input = Buffer.isBuffer(pointerContent) ? pointerContent.toString('utf8') : pointerContent;
			Logger.appendLine(`LFS> Smudging LFS pointer file in ${repoPath}`);

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
					reject(new Error(`git lfs smudge exited with code ${code}: ${errorMsg}`));
				} else {
					const result = Buffer.concat(chunks);
					Logger.appendLine(`LFS> Successfully smudged LFS file, size: ${result.length} bytes`);
					resolve(result);
				}
			});

			// Write the pointer content to stdin
			child.stdin.write(input);
			child.stdin.end();
		} catch (error) {
			Logger.appendLine(`LFS> Exception in smudgeLFSContent: ${error}`);
			reject(error);
		}
	});
}

/**
 * Get binary file content as a data URI, handling Git LFS files
 */
export async function asBinaryDataURI(uri: Uri, repository: Repository): Promise<Uri | undefined> {
	try {
		const { commit, baseCommit, headCommit, isBase } = JSON.parse(uri.query);
		const ref = uri.scheme === URI_SCHEME_REVIEW ? commit : isBase ? baseCommit : headCommit;

		if (!ref) {
			return;
		}

		let contents = await repository.buffer(ref, uri.fsPath);

		// Check if this is a Git LFS pointer and smudge it
		if (isLFSPointer(contents)) {
			Logger.appendLine(`LFS> Detected LFS pointer for ${uri.fsPath}`);
			contents = await smudgeLFSContent(contents, repository.rootUri.fsPath);
		}

		const { size, object } = await repository.getObjectDetails(ref, uri.fsPath);
		const { mimetype } = await repository.detectObjectType(object);

		const fileName = pathUtils.basename(uri.fsPath);
		const base64Content = contents.toString('base64');

		return Uri.parse(
			`data:${mimetype};label:${fileName};description:${ref};size:${contents.length};base64,${base64Content}`,
		);
	} catch (err) {
		Logger.appendLine(`Error creating binary data URI: ${err}`);
		return;
	}
}

export async function asImageDataURI(uri: Uri, repository: Repository): Promise<Uri | undefined> {
	try {
		const { commit, baseCommit, headCommit, isBase } = JSON.parse(uri.query);
		const ref = uri.scheme === URI_SCHEME_REVIEW ? commit : isBase ? baseCommit : headCommit;
		const { size, object } = await repository.getObjectDetails(ref, uri.fsPath);
		const { mimetype } = await repository.detectObjectType(object);

		if (mimetype === 'text/plain') {
			return;
		}

		// Handle images and other binary files (like PDFs)
		if (ImageMimetypes.indexOf(mimetype) > -1 || BinaryMimetypes.indexOf(mimetype) > -1) {
			return asBinaryDataURI(uri, repository);
		}
	} catch (err) {
		return;
	}
}

export function toReviewUri(
	uri: Uri,
	filePath: string | undefined,
	ref: string | undefined,
	commit: string,
	isOutdated: boolean,
	options: GitUriOptions,
	rootUri: Uri,
): Uri {
	const params: ReviewUriParams = {
		path: filePath ? filePath : uri.path,
		ref,
		commit: commit,
		base: options.base,
		isOutdated,
		rootPath: rootUri.path,
	};

	let path = uri.path;

	if (options.replaceFileExtension) {
		path = `${path}.git`;
	}

	return uri.with({
		scheme: URI_SCHEME_REVIEW,
		path,
		query: JSON.stringify(params),
	});
}

export interface FileChangeNodeUriParams {
	prNumber: number;
	fileName: string;
	status?: GitChangeType;
}

export function toResourceUri(uri: Uri, prNumber: number, fileName: string, status: GitChangeType) {
	const params = {
		prNumber: prNumber,
		fileName: fileName,
		status: status,
	};

	return uri.with({
		scheme: URI_SCHEME_RESOURCE,
		query: JSON.stringify(params),
	});
}

export function fromFileChangeNodeUri(uri: Uri): FileChangeNodeUriParams | undefined {
	try {
		return JSON.parse(uri.query) as FileChangeNodeUriParams;
	} catch (e) {}
}

export function toPRUriAzdo(
	uri: Uri,
	pullRequestModel: AzdoPullRequestModel,
	baseCommit: string,
	headCommit: string,
	fileName: string,
	base: boolean,
	status: GitChangeType,
): Uri {
	const params: PRUriParams = {
		baseCommit: baseCommit,
		headCommit: headCommit,
		isBase: base,
		fileName: fileName,
		prNumber: pullRequestModel.getPullRequestId(),
		status: status,
		remoteName: pullRequestModel.azdoRepository.remote.remoteName,
	};

	const path = uri.path;

	return uri.with({
		scheme: URI_SCHEME_PR,
		path,
		query: JSON.stringify(params),
	});
}

class UriEventHandler extends EventEmitter<Uri> implements UriHandler {
	public handleUri(uri: Uri) {
		this.fire(uri);
	}
}

export const handler = new UriEventHandler();

export function createPRUris(pr: AzdoPullRequestModel, folderManager: FolderRepositoryManager, fileChange: IRawFileChange) {
	let headUri: Uri, baseUri: Uri;
	const headCommit = pr.head!.sha;
	const fileName = fileChange.status === VersionControlChangeType.Delete ? fileChange.previous_filename! : fileChange.filename;
	const parentFileName = fileChange.previous_filename ?? '';
	headUri = toPRUriAzdo(
		Uri.file(pathUtils.resolve(folderManager.repository.rootUri.fsPath, removeLeadingSlash(fileName))),
		pr,
		pr.base.sha,
		headCommit,
		fileName,
		false,
		getGitChangeTypeFromVersionControlChangeType(fileChange.status)
	);
	baseUri = toPRUriAzdo(
		Uri.file(pathUtils.resolve(folderManager.repository.rootUri.fsPath, removeLeadingSlash(parentFileName))),
		pr,
		pr.base.sha,
		headCommit,
		parentFileName,
		true,
		getGitChangeTypeFromVersionControlChangeType(fileChange.status)
	);

	return { headUri, baseUri };
}
