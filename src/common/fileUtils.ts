/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';

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
