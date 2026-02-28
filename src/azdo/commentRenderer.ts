/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Comment, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { dateFromNow } from '../common/utils';

/**
 * Thread status enumeration matching Overview panel
 */
export const ThreadStatus = {
	'0': 'Unknown',
	'1': 'Active',
	'2': 'Fixed',
	'3': 'WontFix',
	'4': 'Closed',
	'6': 'Pending',
};

/**
 * Ordered list of thread statuses for dropdown display
 */
export const ThreadStatusOrder = ['1', '6', '2', '3', '4'];

/**
 * Utility to escape HTML special characters and prevent XSS attacks
 */
export function escapeHtml(text: string): string {
	const map: { [key: string]: string } = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#039;',
	};
	return text.replace(/[&<>"']/g, char => map[char]);
}

/**
 * Format absolute timestamp (for tooltip)
 * @param date The date to format
 * @returns A locale string representation of the date
 */
export function formatAbsoluteTimestamp(date: string | Date | undefined): string {
	if (!date) {
		return 'Unknown date';
	}
	try {
		const d = typeof date === 'string' ? new Date(date) : date;
		return d.toLocaleString();
	} catch (e) {
		return 'Unknown date';
	}
}

/**
 * Format relative timestamp (e.g., "2 hours ago")
 * Uses the same logic as the Overview panel
 * @param date The date to format
 * @returns A relative timestamp string
 */
export function formatRelativeTimestamp(date: string | Date | undefined): string {
	return dateFromNow(date);
}

/**
 * Get thread status text by ID
 * @param statusId The thread status ID
 * @returns The thread status text
 */
export function getThreadStatusText(statusId: number | string): string {
	return ThreadStatus[statusId.toString()] || 'Unknown';
}

/**
 * Render a single comment with author, timestamp, and content (rich HTML version)
 * @param comment The comment to render
 * @param index The index of the comment in the thread
 * @param threadId The thread ID
 * @param isFirstInThread Whether this is the first comment in the thread
 * @param threadStatus Optional thread status (only shown for first comment)
 * @returns HTML string representation of the comment
 */
export function renderCommentWithAvatar(
	comment: Comment,
	index: number,
	threadId: number,
	isFirstInThread: boolean = false,
	threadStatus?: number,
): string {
	const author = comment.author?.displayName || 'Unknown';
	const avatarUrl = comment.author?.['_links']?.['avatar']?.['href'];
	const profileUrl = comment.author?.profileUrl || '#';
	const content = escapeHtml(comment.content || '');
	const relativeTime = formatRelativeTimestamp(comment.publishedDate);
	const absoluteTime = formatAbsoluteTimestamp(comment.publishedDate);
	const commentId = threadId * 1000 + comment.id;

	let avatarHtml = '';
	if (avatarUrl) {
		avatarHtml = `<a class="avatar-link" href="${escapeHtml(profileUrl)}"><img class="avatar" src="${escapeHtml(avatarUrl)}" alt="" /></a>`;
	} else {
		avatarHtml = `<a class="avatar-link" href="${escapeHtml(profileUrl)}"><div class="avatar-icon">👤</div></a>`;
	}

	let statusDropdown = '';
	if (isFirstInThread && threadStatus !== undefined) {
		const options = ThreadStatusOrder.map(
			statusId => `<option value="${statusId}" ${statusId === threadStatus.toString() ? 'selected' : ''}>${ThreadStatus[statusId]}</option>`,
		).join('');
		statusDropdown = `
			<select class="thread-status-dropdown" data-thread-id="${threadId}" onchange="window.updateThreadStatus(${threadId}, this.value)">
				${options}
			</select>
		`;
	}

	return `
		<div class="comment-container review-comment" data-comment-id="${commentId}">
			<div class="review-comment-container">
				<div class="review-comment-header">
					<div class="comment-meta">
						${avatarHtml}
						<a class="author-link" href="${escapeHtml(profileUrl)}">${escapeHtml(author)}</a>
						<span class="spacer">•</span>
						<span class="timestamp" title="${absoluteTime}">${relativeTime}</span>
						${statusDropdown}
					</div>
					<div class="comment-actions">
						<button class="reply-btn" data-thread-id="${threadId}" data-comment-id="${commentId}" onclick="window.quoteReply(${threadId}, '${content.replace(/'/g, "\\'")}')">
							💬 Reply
						</button>
					</div>
				</div>
				<div class="comment-body markdown">${content}</div>
			</div>
		</div>
	`;
}

/**
 * Render a complete comment thread with all its comments (rich version)
 * @param thread The comment thread to render
 * @param threadStatus Optional thread status for the thread
 * @returns HTML string representation of the thread
 */
export function renderCommentThreadRich(thread: GitPullRequestCommentThread, threadStatus?: number): string {
	if (!thread.comments || thread.comments.length === 0) {
		return '';
	}

	const threadId = thread.id || 0;
	const comments = thread.comments.map((comment, index) =>
		renderCommentWithAvatar(comment, index, threadId, index === 0, threadStatus)
	);
	return `<div class="comment-thread" data-thread-id="${threadId}">${comments.join('')}</div>`;
}

/**
 * Render multiple comment threads (rich version)
 * @param threads Array of comment threads to render
 * @param threadStatuses Optional map of thread ID to status
 * @param reverseOrder If true, threads are rendered in reverse order (newest first)
 * @returns HTML string representation of all threads
 */
export function renderCommentThreadsRich(
	threads: GitPullRequestCommentThread[],
	threadStatuses?: { [threadId: number]: number },
	reverseOrder: boolean = false,
): string {
	const threadsToRender = reverseOrder ? [...threads].reverse() : threads;
	return threadsToRender
		.map(thread => {
			const status = threadStatuses ? threadStatuses[thread.id || 0] : undefined;
			return renderCommentThreadRich(thread, status);
		})
		.join('');
}

/**
 * Get the CSS styles for comment rendering
 * @returns CSS string for styling comments
 */
export function getCommentStyles(): string {
	return `
		.comment-panel {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 16px;
		}

		.panel-header {
			border-bottom: 1px solid var(--vscode-editorGroup-border);
			padding-bottom: 12px;
			margin-bottom: 16px;
		}

		.panel-header h2 {
			margin: 0 0 4px 0;
			font-size: 18px;
			font-weight: 600;
		}

		.panel-header p {
			margin: 0;
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
		}

		.comments-container {
			margin-bottom: 20px;
		}

		.empty-state {
			padding: 24px;
			text-align: center;
			color: var(--vscode-descriptionForeground);
			background-color: var(--vscode-editorGroup-emptyBackground);
			border-radius: 4px;
		}

		.comment-thread {
			margin-bottom: 16px;
			border-left: 2px solid var(--vscode-editorGroup-border);
			padding-left: 12px;
		}

		.comment {
			margin-bottom: 12px;
			padding: 8px;
			background-color: var(--vscode-editor-background);
			border-radius: 4px;
		}

		.comment-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 6px;
			font-size: 12px;
		}

		.comment-author {
			font-weight: 600;
			color: var(--vscode-foreground);
		}

		.comment-time {
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
		}

		.comment-body {
			font-size: 13px;
			line-height: 1.4;
			color: var(--vscode-foreground);
			word-wrap: break-word;
		}

		.comment-body.markdown {
			white-space: pre-wrap;
			tab-size: 2;
		}

		.reply {
			margin-top: 8px;
			padding-top: 8px;
			border-top: 1px dashed var(--vscode-editorGroup-border);
			font-style: italic;
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
		}

		.input-area {
			margin-top: 20px;
			padding-top: 16px;
			border-top: 1px solid var(--vscode-editorGroup-border);
		}

		.comment-input-wrapper {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		textarea {
			width: 100%;
			min-height: 80px;
			padding: 8px;
			background-color: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-editorGroup-border);
			border-radius: 4px;
			font-family: var(--vscode-font-family);
			font-size: 13px;
			resize: vertical;
		}

		textarea:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
			box-shadow: 0 0 0 1px var(--vscode-focusBorder);
		}

		.input-actions {
			display: flex;
			gap: 8px;
			justify-content: flex-end;
		}

		button {
			padding: 6px 12px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-size: 13px;
			font-weight: 500;
		}

		button#commentBtn {
			background-color: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}

		button#commentBtn:hover {
			background-color: var(--vscode-button-hoverBackground);
		}

		button.secondary {
			background-color: transparent;
			color: var(--vscode-foreground);
			border: 1px solid var(--vscode-editorGroup-border);
		}

		button.secondary:hover {
			background-color: var(--vscode-button-secondaryHoverBackground);
		}
	`;
}
