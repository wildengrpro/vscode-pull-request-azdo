/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SETTINGS_NAMESPACE } from '../../constants';
import { DirectoryTreeNode } from './directoryTreeNode';
import { GitFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class FilesCategoryNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Files';
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public contextValue: string = 'filescategory';
	private directories: TreeNode[] = [];
	private showOnlyFilesWithComments: boolean = false;

	constructor(public parent: TreeNodeParent, private _fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]) {
		super();
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

		// tree view
		const dirNode = new DirectoryTreeNode(this, '');
		this._fileChanges.forEach(f => dirNode.addFile(f));
		dirNode.finalize();
		if (dirNode.label === '') {
			// nothing on the root changed, pull children to parent
			this.directories = dirNode.children;
		} else {
			this.directories = [dirNode];
		}
	}

	getTreeItem(): vscode.TreeItem {
		// Get filtered count
		const filteredFiles = this.getFilteredFiles();
		const totalCount = this._fileChanges.length;
		const countText = this.showOnlyFilesWithComments
			? `${filteredFiles.length}/${totalCount} (with comments)`
			: `${totalCount}`;
		this.label = `Changes (${countText})`;
		const item: vscode.TreeItem = {
			label: this.label,
			collapsibleState: this.collapsibleState,
			contextValue: this.contextValue,
			tooltip: this.showOnlyFilesWithComments
				? `Showing ${filteredFiles.length} of ${totalCount} files with comments`
				: `All ${totalCount} files`,
		};
		return item;
	}

	private getFilteredFiles(): (GitFileChangeNode | RemoteFileChangeNode)[] {
		if (!this.showOnlyFilesWithComments) {
			return this._fileChanges;
		}
		// Only include files that have comments property and have at least one comment
		return this._fileChanges.filter(file => {
			// Check if file is a FileChangeNode (which has comments property)
			const fileChange = file as any;
			return fileChange.comments && Array.isArray(fileChange.comments) && fileChange.comments.length > 0;
		});
	}

	toggleCommentsFilter(): void {
		this.showOnlyFilesWithComments = !this.showOnlyFilesWithComments;
		this.refresh(this);
	}

	toggleFileListLayout(): void {
		const currentLayout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('fileListLayout');
		const newLayout = currentLayout === 'tree' ? 'flat' : 'tree';
		vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).update('fileListLayout', newLayout, vscode.ConfigurationTarget.Global);
		this.refresh(this);
	}

	async getChildren(): Promise<TreeNode[]> {
		let nodes: TreeNode[];
		const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('fileListLayout');

		// Apply comments filter if enabled
		const filesToShow = this.getFilteredFiles();

		if (layout === 'tree') {
			// Rebuild directory tree with filtered files
			const dirNode = new DirectoryTreeNode(this, '');
			filesToShow.forEach(f => dirNode.addFile(f));
			dirNode.finalize();
			nodes = dirNode.label === '' ? dirNode.children : [dirNode];
		} else {
			nodes = filesToShow;
		}
		return Promise.resolve(nodes);
	}
}
