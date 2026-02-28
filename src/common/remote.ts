/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Repository } from '../api/api';
import { Protocol } from './protocol';

export class Remote {
	public get host(): string {
		return this.gitProtocol.host;
	}
	public get owner(): string {
		return this.gitProtocol.owner;
	}
	public get repositoryName(): string {
		return this.gitProtocol.repositoryName;
	}

	public get normalizedHost(): string {
		const normalizedUri = this.gitProtocol.normalizeUri();
		return `${normalizedUri!.scheme}://${normalizedUri!.authority}`;
	}

	/**
	 * Extracts the Azure DevOps project name from the remote URL.
	 * Handles multiple URL formats:
	 * - https://<org>@dev.azure.com/<org>/<project>/_git/<repo>
	 * - https://dev.azure.com/<org>/<project>/_git/<repo>
	 * - git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
	 *
	 * @returns The project name or undefined if it cannot be extracted
	 */
	public get azureProjectName(): string | undefined {
		// Try _git pattern first (HTTPS URLs)
		let projectNameMatch = this.url.match(/\/([^\/]+)\/_git\//);
		if (projectNameMatch && projectNameMatch.length > 1) {
			return projectNameMatch[1];
		}

		// Try SSH pattern: git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
		projectNameMatch = this.url.match(/v3\/[^\/]+\/([^\/]+)\//);
		if (projectNameMatch && projectNameMatch.length > 1) {
			return projectNameMatch[1];
		}

		return undefined;
	}

	constructor(public readonly remoteName: string, public readonly url: string, public readonly gitProtocol: Protocol) {}

	equals(remote: Remote): boolean {
		if (this.remoteName !== remote.remoteName) {
			return false;
		}
		if (this.host !== remote.host) {
			return false;
		}
		if (this.owner !== remote.owner) {
			return false;
		}
		if (this.repositoryName !== remote.repositoryName) {
			return false;
		}

		return true;
	}
}

export function parseRemote(remoteName: string, url: string | undefined, originalProtocol?: Protocol): Remote | null {
	if (!url) {
		return null;
	}
	const gitProtocol = new Protocol(url);
	if (originalProtocol) {
		gitProtocol.update({
			type: originalProtocol.type,
		});
	}

	if (gitProtocol.host) {
		return new Remote(remoteName, url, gitProtocol);
	}

	return null;
}

export function parseRepositoryRemotes(repository: Repository): Remote[] {
	return repository.state.remotes.map(r => parseRemote(r.name, r.fetchUrl || r.pushUrl)).filter(r => !!r) as Remote[];
}
