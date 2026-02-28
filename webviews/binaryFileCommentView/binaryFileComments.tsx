/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../common/cache';
import { AddComment } from '../components/comment';
import Timeline from '../components/timeline';

export const BinaryFileComments = (pr: PullRequest) => {
	const threads = pr.threads || [];

	return (
		<>
			<div id="main">
				<AddComment {...pr} />
				<Timeline threads={threads} currentUser={pr.currentUser} />
			</div>
		</>
	);
};


