/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Azdo } from '../azdo/credentials';
import Logger from '../common/logger';

// TODO: Add unit tests for client caching logic
// TODO: Add tests for token expiration handling
// TODO: Add tests for cache invalidation scenarios

/**
 * Factory for creating and caching org-level Azure DevOps API client instances.
 * Each unique organization gets its own cached Azdo instance.
 * Does NOT include projectName - callers should provide that as needed.
 */
export class ApiClientFactory {
private static readonly ID = 'ApiClientFactory';

// Cache of Azdo instances by organization URL
private _clientCache: Map<string, Azdo> = new Map();

/**
 * Gets or creates an Azdo API client for the specified organization.
 * The client is cached and reused for subsequent requests to the same org.
 * 
 * @param orgUrl The Azure DevOps organization URL (e.g., https://dev.azure.com/myorg)
 * @param token The authentication token (PAT or Bearer token)
 * @param isPatTokenAuth Whether the token is a PAT (true) or Bearer token (false)
 * @returns Azdo API client instance for the organization
 */
getOrCreateClient(orgUrl: string, token: string, isPatTokenAuth: boolean): Azdo {
// Check cache first
const cached = this._clientCache.get(orgUrl);
if (cached && !cached.isTokenExpired()) {
Logger.debug(`Returning cached API client for org: ${orgUrl}`, ApiClientFactory.ID);
return cached;
}

Logger.appendLine(`Creating new API client for org: ${orgUrl}`, ApiClientFactory.ID);

// Create new org-level client (no projectName)
const client = new Azdo(orgUrl, token, isPatTokenAuth);

// Cache it
this._clientCache.set(orgUrl, client);

return client;
}

/**
 * Clears the cached client for a specific organization.
 * Useful when credentials change or become invalid.
 * 
 * @param orgUrl The organization URL to clear from cache
 */
clearClient(orgUrl: string): void {
Logger.appendLine(`Clearing cached API client for org: ${orgUrl}`, ApiClientFactory.ID);
this._clientCache.delete(orgUrl);
}

/**
 * Clears all cached API clients.
 * Should be called when user logs out or credentials are reset.
 */
clearAllClients(): void {
Logger.appendLine('Clearing all cached API clients', ApiClientFactory.ID);
this._clientCache.clear();
}

/**
 * Gets the number of cached API clients.
 * Useful for diagnostics and testing.
 * 
 * @returns Number of cached clients
 */
getCachedClientCount(): number {
return this._clientCache.size;
}
}
