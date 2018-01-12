/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import WebSiteManagementClient = require('azure-arm-website');
import * as path from 'path';
import { SiteWrapper } from 'vscode-azureappservice';
import { IAzureNode, IAzureParentTreeItem, IAzureTreeItem } from 'vscode-azureextensionui';
import KuduClient from 'vscode-azurekudu';
import { kuduFile } from '../KuduClient';
import { nodeUtils } from '../utils/nodeUtils';
import { FileTreeItem } from './FileTreeItem';

export class FolderTreeItem implements IAzureParentTreeItem {
    public static contextValue: string = 'folder';
    public readonly contextValue: string = FolderTreeItem.contextValue;
    public readonly childTypeLabel: string = 'files';

    constructor(readonly siteWrapper: SiteWrapper, readonly label: string, readonly folderPath: string, readonly useIcon: boolean = false) {
    }

    public get id(): string {
        return `${this.siteWrapper.id}/Folders`;
    }

    public get iconPath(): { light: string, dark: string } | undefined {
        return this.useIcon ? {
            light: path.join(__filename, '..', '..', '..', '..', 'resources', 'light', 'Folder.png'),
            dark: path.join(__filename, '..', '..', '..', '..', 'resources', 'dark', 'Folder.png')
        } : undefined;
    }

    public hasMoreChildren(): boolean {
        return false;
    }

    public async loadMoreChildren(node: IAzureNode<FolderTreeItem>): Promise<IAzureTreeItem[]> {
        const webAppClient: WebSiteManagementClient = nodeUtils.getWebSiteClient(node);
        const kuduClient: KuduClient = await this.siteWrapper.getKuduClient(webAppClient);

        const fileList = await kuduClient.vfs.getItem(this.folderPath);
        return fileList.map((file: kuduFile) => {
            return file.mime === 'inode/directory' ?
                // truncate the /home of the path
                new FolderTreeItem(this.siteWrapper, file.name, file.path.substring(file.path.indexOf('site'))) :
                new FileTreeItem(this.siteWrapper, file.name, file.path.substring(file.path.indexOf('site')));
        });
    }
}