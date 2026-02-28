/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { VersionControlChangeType } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { IFileChangeNode, IRawFileChange } from '../azdo/interface';
import { PullRequestModel } from '../azdo/pullRequestModel';
import { GitChangeType } from './file';
import Logger from './logger';
import { fromPRUri, toReviewUri } from './uri';

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

/**
 * Checks if a file is tracked by Git LFS based on git attributes
 * @param fileName The name of the file to check
 * @param folderManager The folder repository manager
 * @returns True if the file is tracked by LFS, false otherwise
 */
export async function isLFSTrackedFile(fileName: string, folderManager: FolderRepositoryManager): Promise<boolean> {
	try {
		const child = spawn('git', ['check-attr', 'filter', fileName], {
			cwd: folderManager.repository.rootUri.fsPath,
		});

		let output = '';

		if (!child.stdout || !child.stderr) {
			return false;
		}

		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
		});

		return new Promise((resolve) => {
			child.on('close', (code) => {
				if (code === 0 && output.includes('filter: lfs')) {
					Logger.appendLine(`FileUtils> Git LFS tracked file detected: ${fileName}`);
					resolve(true);
				} else {
					resolve(false);
				}
			});

			child.on('error', (error) => {
				Logger.appendLine(`FileUtils> Error checking git attributes: ${error}`);
				resolve(false);
			});
		});
	} catch (error) {
		Logger.appendLine(`FileUtils> Exception in isLFSTrackedFile: ${error}`);
		return false;
	}
}

/**
 * Gets file content from git, automatically smudging LFS pointers if detected
 * @param commit The commit SHA to get content from
 * @param filePath The file path in the repository
 * @param folderManager The folder repository manager
 * @returns The file content as a Buffer
 */
export async function getFileContentWithLFSSmudge(
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
			Logger.appendLine(`FileUtils> Detected LFS pointer, smudging: ${filePath}`);

			// Smudge the LFS pointer to get actual content
			const smudged = await smudgeLFSPointer(contentStr, folderManager.repository.rootUri.fsPath);
			return smudged;
		}

		return content;
	} catch (error) {
		Logger.appendLine(`FileUtils> Error getting file content: ${error}`);
		throw error;
	}
}

/**
 * Smudges an LFS pointer to get the actual file content
 * @param pointerContent The LFS pointer content
 * @param repoPath The repository root path
 * @returns The smudged file content as a Buffer
 */
export function smudgeLFSPointer(pointerContent: string, repoPath: string): Promise<Buffer> {
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
				Logger.appendLine(`FileUtils> Failed to spawn git lfs smudge: ${error}`);
				reject(error);
			});

			child.on('close', (code) => {
				if (code !== 0) {
					const errorMsg = Buffer.concat(errorChunks).toString('utf8');
					Logger.appendLine(`FileUtils> git lfs smudge exited with code ${code}: ${errorMsg}`);
					reject(new Error(`git lfs smudge failed: ${errorMsg}`));
				} else {
					const result = Buffer.concat(chunks);
					Logger.appendLine(`FileUtils> Successfully smudged LFS file, size: ${result.length} bytes`);
					resolve(result);
				}
			});

			child.stdin.write(pointerContent);
			child.stdin.end();
		} catch (error) {
			Logger.appendLine(`FileUtils> Exception in smudgeLFSPointer: ${error}`);
			reject(error);
		}
	});
}

export interface DiffUris {
	/** URI for the base (left) version of the file */
	baseUri: vscode.Uri;
	/** URI for the head (right) version of the file */
	headUri: vscode.Uri;
	/** Cleanup function to call after the diff is closed (for temp files) */
	cleanup?: () => void;
}

/**
 * Gets the proper URIs for opening a file diff, handling Git LFS files specially
 * For LFS files, creates temp files with actual content. For regular files, uses review:// URIs.
 *
 * @param fileChange The file change node
 * @param pr The pull request model
 * @param folderManager The folder repository manager
 * @returns Object with baseUri, headUri, and optional cleanup function, or undefined on error
 */
export async function getDiffUris(
	fileChange: IFileChangeNode,
	pr: PullRequestModel,
	folderManager: FolderRepositoryManager,
): Promise<DiffUris | undefined> {
	try {
		const fileName = path.basename(fileChange.fileName);

		// Check if file is tracked by Git LFS
		const isLFS = await isLFSTrackedFile(fileName, folderManager);

		if (isLFS && fileChange.sha && fileChange.previousFileSha) {
			// LFS file with commit info: use temp files to display the actual smudged content
			Logger.appendLine(`FileUtils> File is Git LFS tracked, using temp files: ${fileName}`);

			try {
				// Get actual content from git, handling LFS smudging if needed
				const headContent = await getFileContentWithLFSSmudge(
					fileChange.sha,
					fileChange.fileName,
					folderManager,
				);

				// For base file, handle different statuses
				let parentContent: Buffer;
				if (fileChange.status === GitChangeType.ADD) {
					parentContent = Buffer.alloc(0); // Empty file for ADD
				} else if (fileChange.status === GitChangeType.DELETE) {
					parentContent = headContent; // Use same content for DELETE
				} else {
					parentContent = await getFileContentWithLFSSmudge(
						fileChange.previousFileSha,
						fileChange.previousFileName || fileChange.fileName,
						folderManager,
					);
				}

				// Create temp files for the actual content
				const tempDir = os.tmpdir();
				const fileExt = path.extname(fileName);
				const timestamp = Date.now();
				const randomSuffix = Math.random().toString(36).substring(7);

				const parentTempFile = path.join(tempDir, `parent_${timestamp}_${randomSuffix}${fileExt}`);
				const headTempFile = path.join(tempDir, `head_${timestamp}_${randomSuffix}${fileExt}`);

				// Write content to temp files
				fs.writeFileSync(parentTempFile, parentContent);
				fs.writeFileSync(headTempFile, headContent);

				// Convert to URIs
				const parentURI = vscode.Uri.file(parentTempFile);
				const headURI = vscode.Uri.file(headTempFile);

				// Return cleanup function to remove temp files
				const cleanup = () => {
					setTimeout(() => {
						try {
							if (fs.existsSync(parentTempFile)) fs.unlinkSync(parentTempFile);
							if (fs.existsSync(headTempFile)) fs.unlinkSync(headTempFile);
						} catch (e) {
							// Ignore cleanup errors
						}
					}, 30000); // 30 seconds
				};

				return { baseUri: parentURI, headUri: headURI, cleanup };
			} catch (lfsError) {
				// If LFS smudging fails, fall back to regular URIs
				Logger.appendLine(`FileUtils> LFS smudging failed, falling back to regular URIs: ${lfsError}`);
				const uris = await getBinaryFileUris(fileChange, pr, folderManager);
				return uris ? { baseUri: uris.baseUri, headUri: uris.headUri } : undefined;
			}
		} else {
			// Regular file: use review URIs
			Logger.appendLine(`FileUtils> Using review URIs for regular file: ${fileName}`);
			const uris = await getBinaryFileUris(fileChange, pr, folderManager);
			return uris ? { baseUri: uris.baseUri, headUri: uris.headUri } : undefined;
		}
	} catch (error) {
		Logger.appendLine(`FileUtils> Error getting diff URIs: ${error}`);
		return undefined;
	}
}

/**
 * Constructs diff URIs from a raw file change object
 * Converts the file change information into review:// URIs with proper commit parameters
 *
 * @param fileChange The raw file change information from the PR
 * @param folderManager The folder repository manager
 * @param pullRequest The pull request model
 * @returns Object with filePath and parentFilePath URIs, or undefined if construction fails
 */
export function constructDiffUris(
	fileChange: IRawFileChange,
	folderManager: FolderRepositoryManager,
	pullRequest: PullRequestModel,
): { filePath: vscode.Uri; parentFilePath: vscode.Uri } | undefined {
	try {
		const baseFileName = fileChange.previous_filename || fileChange.filename;
		const headFileName = fileChange.filename;

		// Get SHAs for the file versions
		const baseSha = fileChange.status === VersionControlChangeType.Add ? '' : (fileChange.previous_file_sha || '');
		const headSha = fileChange.status === VersionControlChangeType.Delete ? '' : (fileChange.file_sha || '');

		// Construct review URIs with commit info
		const filePath = toReviewUri(
			vscode.Uri.file(path.join(folderManager.repository.rootUri.fsPath, headFileName)),
			headFileName,
			undefined,
			headSha,
			false,
			{ base: false },
			folderManager.repository.rootUri,
		);

		const parentFilePath = toReviewUri(
			vscode.Uri.file(path.join(folderManager.repository.rootUri.fsPath, baseFileName)),
			baseFileName,
			undefined,
			baseSha,
			false,
			{ base: true },
			folderManager.repository.rootUri,
		);

		return { filePath, parentFilePath };
	} catch (error) {
		Logger.appendLine(`FileUtils> Error constructing diff URIs: ${error}`);
		return undefined;
	}
}

/**
 * Opens a diff view for a file, handling LFS files with temp files
 *
 * @param filePath The URI of the modified file version
 * @param parentFilePath The URI of the base file version
 * @param folderManager The folder repository manager
 * @param options Additional options for opening the diff
 * @returns A promise that resolves when the diff is opened
 */
export async function openDiff(
	filePath: vscode.Uri,
	parentFilePath: vscode.Uri,
	folderManager: FolderRepositoryManager,
	options?: {
		fileName?: string;
		title?: string;
		preserveFocus?: boolean;
	}
): Promise<void> {
	try {
		const fileName = options?.fileName || path.basename(filePath.fsPath);
		const title = options?.title || `${fileName} (Pull Request)`;
		const showOptions = {
			preserveFocus: options?.preserveFocus ?? true,
		};

		// Check if file is tracked by Git LFS
		const isLFS = await isLFSTrackedFile(fileName, folderManager);

		if (isLFS) {
			Logger.appendLine(`FileUtils> File is LFS tracked, creating temp files: ${fileName}`);

			// Extract commit params from the URIs
			const params = fromPRUri(filePath);
			const parentParams = fromPRUri(parentFilePath);

			if (!params || !parentParams) {
				Logger.appendLine('FileUtils> Could not parse PR URI parameters for LFS file');
				// Fall back to opening with regular URIs
				await vscode.commands.executeCommand('vscode.diff', parentFilePath, filePath, title, showOptions);
				return;
			}

			try {
				// Get actual content from git (handles LFS smudging)
				const headContent = await folderManager.repository.buffer(params.headCommit, filePath.fsPath);

				// For base file, handle different statuses
				let parentContent: Buffer;
				if (params.isBase) {
					parentContent = Buffer.alloc(0); // Empty file for ADD
				} else {
					parentContent = await folderManager.repository.buffer(parentParams.headCommit, parentFilePath.fsPath);
				}

				// Create temp files
				const tempDir = os.tmpdir();
				const fileExt = path.extname(fileName);
				const timestamp = Date.now();
				const randomSuffix = Math.random().toString(36).substring(7);

				const parentTempFile = path.join(tempDir, `parent_${timestamp}_${randomSuffix}${fileExt}`);
				const headTempFile = path.join(tempDir, `head_${timestamp}_${randomSuffix}${fileExt}`);

				fs.writeFileSync(parentTempFile, parentContent);
				fs.writeFileSync(headTempFile, headContent);

				const parentUri = vscode.Uri.file(parentTempFile);
				const headUri = vscode.Uri.file(headTempFile);

				// Open the diff
				await vscode.commands.executeCommand('vscode.diff', parentUri, headUri, title, showOptions);

				// Schedule cleanup
				setTimeout(() => {
					try {
						if (fs.existsSync(parentTempFile)) fs.unlinkSync(parentTempFile);
						if (fs.existsSync(headTempFile)) fs.unlinkSync(headTempFile);
					} catch (e) {
						// Ignore cleanup errors
					}
				}, 30000);
			} catch (lfsError) {
				Logger.appendLine(`FileUtils> LFS handling failed, falling back: ${lfsError}`);
				await vscode.commands.executeCommand('vscode.diff', parentFilePath, filePath, title, showOptions);
			}
		} else {
			// Regular file: use URIs as-is
			await vscode.commands.executeCommand('vscode.diff', parentFilePath, filePath, title, showOptions);
		}
	} catch (error) {
		Logger.appendLine(`FileUtils> Error opening diff: ${error}`);
		vscode.window.showErrorMessage(`Failed to open diff: ${error}`);
	}
}

