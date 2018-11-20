/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringDictionary } from 'azure-arm-website/lib/models';
import * as path from 'path';
import * as vscode from 'vscode';
import { ISiteTreeRoot, validateAppSettingKey } from 'vscode-azureappservice';
import { AzureParentTreeItem, AzureTreeItem, createTreeItemsWithErrorHandling, GenericTreeItem, UserCancelledError } from 'vscode-azureextensionui';
import { AzureExtensionApiProvider } from 'vscode-azureextensionui/api';
import { ext } from '../extensionVariables';
import { DatabaseTreeItem } from '../vscode-cosmos.api';
import { ConnectionsTreeItem } from './ConnectionsTreeItem';
import { CosmosDBConnection } from './CosmosDBConnection';

export class CosmosDBTreeItem extends AzureParentTreeItem<ISiteTreeRoot> {
    public static contextValueInstalled: string = 'сosmosDBConnections';
    public static contextValueNotInstalled: string = 'сosmosDBNotInstalled';
    public readonly contextValue: string;
    public readonly label: string = 'Cosmos DB';
    public readonly parent: ConnectionsTreeItem;

    private readonly _endpointSuffix: string = '_ENDPOINT';
    private readonly _keySuffix: string = '_MASTER_KEY';
    private readonly _databaseSuffix: string = '_DATABASE_ID';

    private _cosmosDBApiProvider: AzureExtensionApiProvider | undefined;

    constructor(parent: ConnectionsTreeItem) {
        super(parent);

        const cosmosDB = vscode.extensions.getExtension('ms-azuretools.vscode-cosmosdb');
        if (cosmosDB) {
            this.contextValue = CosmosDBTreeItem.contextValueInstalled;
            this._cosmosDBApiProvider = <AzureExtensionApiProvider>cosmosDB.exports;
        } else {
            this.contextValue = CosmosDBTreeItem.contextValueNotInstalled;
        }
    }

    public get iconPath(): string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } {
        return {
            light: path.join(__filename, '..', '..', '..', '..', 'resources', 'light', 'CosmosDBAccount.svg'),
            dark: path.join(__filename, '..', '..', '..', '..', 'resources', 'dark', 'CosmosDBAccount.svg')
        };
    }

    public async loadMoreChildrenImpl(_clearCache: boolean): Promise<AzureTreeItem<ISiteTreeRoot>[]> {
        if (!this._cosmosDBApiProvider) {
            return [new GenericTreeItem(this, {
                commandId: 'appService.InstallCosmosDBExtension',
                contextValue: 'InstallCosmosDBExtension',
                label: 'Install Cosmos DB Extension...'
            })];
        }

        if (ext.cosmosAPI === undefined) {
            ext.cosmosAPI = this._cosmosDBApiProvider.getApi('^1.0.0');
        }

        // tslint:disable-next-line:strict-boolean-expressions
        const appSettings = (await this.root.client.listApplicationSettings()).properties || {};
        const connections: IDetectedConnection[] = this.detectMongoConnections(appSettings).concat(this.detectDocDBConnections(appSettings));
        const treeItems = <CosmosDBConnection[]>await createTreeItemsWithErrorHandling(
            this,
            connections,
            'invalidCosmosDBConnection',
            async (c: IDetectedConnection) => {
                const databaseTreeItem = await ext.cosmosAPI.findTreeItem({
                    connectionString: c.connectionString
                });
                return databaseTreeItem ? new CosmosDBConnection(this, databaseTreeItem, c.keys) : undefined;
            },
            (c: IDetectedConnection) => c.keys[0] // just use first key for label if connection is invalid
        );

        if (treeItems.length > 0) {
            return treeItems;
        } else {
            return [new GenericTreeItem(this, {
                commandId: 'appService.AddCosmosDBConnection',
                contextValue: 'AddCosmosDBConnection',
                label: 'Add Cosmos DB Connection...'
            })];
        }
    }

    public async createChildImpl(showCreatingTreeItem: (label: string) => void): Promise<AzureTreeItem<ISiteTreeRoot>> {
        const databaseToAdd = await ext.cosmosAPI.pickTreeItem({
            resourceType: 'Database'
        });
        if (!databaseToAdd) {
            throw new UserCancelledError();
        }
        const appSettingsDict = await this.root.client.listApplicationSettings();
        // tslint:disable-next-line:strict-boolean-expressions
        appSettingsDict.properties = appSettingsDict.properties || {};

        const newAppSettings: Map<string, string> = databaseToAdd.docDBData ?
            await this.promptForDocDBAppSettings(appSettingsDict, databaseToAdd) :
            await this.promptForMongoAppSettings(appSettingsDict, databaseToAdd);

        for (const [k, v] of newAppSettings) {
            appSettingsDict.properties[k] = v;
        }

        await this.root.client.updateApplicationSettings(appSettingsDict);
        await this.parent.parent.appSettingsNode.refresh();

        const createdDatabase = new CosmosDBConnection(this, databaseToAdd, Array.from(newAppSettings.keys()));
        showCreatingTreeItem(createdDatabase.label);

        const ok: vscode.MessageItem = { title: 'OK' };
        const revealDatabase: vscode.MessageItem = { title: 'Reveal Database' };
        const message: string = `Database "${createdDatabase.label}" connected to web app "${this.root.client.fullName}". Created the following application settings: "${Array.from(newAppSettings.keys()).join(', ')}".`;
        // Don't wait
        vscode.window.showInformationMessage(message, ok, revealDatabase).then(async (result: vscode.MessageItem | undefined) => {
            if (result === revealDatabase) {
                await createdDatabase.cosmosExtensionItem.reveal();
            }
        });

        return createdDatabase;
    }

    public hasMoreChildrenImpl(): boolean {
        return false;
    }

    private detectMongoConnections(appSettings: { [propertyName: string]: string }): IDetectedConnection[] {
        const result: IDetectedConnection[] = [];
        for (const key of Object.keys(appSettings)) {
            const value = appSettings[key];
            if (/^mongodb[^:]*:\/\//i.test(value)) {
                result.push({
                    keys: [key],
                    connectionString: appSettings[key]
                });
            }
        }
        return result;
    }

    private detectDocDBConnections(appSettings: { [propertyName: string]: string }): IDetectedConnection[] {
        const connectionStringEndpointPrefix = 'AccountEndpoint=';
        const connectionStringKeyPrefix = 'AccountKey=';

        const result: IDetectedConnection[] = [];
        const regexp = new RegExp(`(.+)${this._endpointSuffix}`, 'i');
        for (const key of Object.keys(appSettings)) {
            // First, check for connection string split up into multiple app settings (endpoint, key, and optional database id)
            const match = key && key.match(regexp);
            if (match) {
                const prefix = match[1];
                const endpointKey = prefix + this._endpointSuffix;
                const keyKey = prefix + this._keySuffix;
                const documentEndpoint: string | undefined = appSettings[endpointKey];
                const masterKey: string | undefined = appSettings[keyKey];

                if (documentEndpoint && masterKey) {
                    const keys: string[] = [endpointKey, keyKey];
                    let connectionString = `${connectionStringEndpointPrefix}${documentEndpoint};${connectionStringKeyPrefix}${masterKey};`;

                    const databaseKey = prefix + this._databaseSuffix;
                    if (Object.keys(appSettings).find((k) => k === databaseKey)) {
                        keys.push(databaseKey);
                        connectionString += `Database=${appSettings[databaseKey]}`;
                    }

                    result.push({ keys, connectionString });
                }
            } else {
                // Second, check for connection string as one app setting
                const regExp1 = new RegExp(connectionStringEndpointPrefix, 'i');
                const regExp2 = new RegExp(connectionStringKeyPrefix, 'i');

                const value: string = appSettings[key];
                if (regExp1.test(value) && regExp2.test(value)) {
                    result.push({ keys: [key], connectionString: value });
                }
            }
        }

        return result;
    }

    private async promptForMongoAppSettings(appSettingsDict: StringDictionary, database: DatabaseTreeItem): Promise<Map<string, string>> {
        const prompt: string = 'Enter new connection setting key';
        const defaultKey: string = 'MONGO_URL';

        const appSettingKey: string = await ext.ui.showInputBox({
            prompt,
            validateInput: (v?: string): string | undefined => validateAppSettingKey(appSettingsDict, v),
            value: defaultKey
        });

        return new Map([[appSettingKey, database.connectionString]]);
    }

    private async promptForDocDBAppSettings(appSettingsDict: StringDictionary, database: DatabaseTreeItem): Promise<Map<string, string>> {
        const prompt: string = 'Enter new connection setting prefix';
        const defaultPrefix: string = 'AZURE_COSMOS';

        const appSettingPrefix: string = await ext.ui.showInputBox({
            prompt,
            validateInput: (v?: string): string | undefined => {
                // tslint:disable-next-line:strict-boolean-expressions
                v = v || '';
                return validateAppSettingKey(appSettingsDict, v + this._endpointSuffix) || validateAppSettingKey(appSettingsDict, v + this._keySuffix) || validateAppSettingKey(appSettingsDict, v + this._databaseSuffix);
            },
            value: defaultPrefix
        });

        return new Map([
            // tslint:disable-next-line:no-non-null-assertion
            [appSettingPrefix + this._endpointSuffix, database.docDBData!.documentEndpoint],
            // tslint:disable-next-line:no-non-null-assertion
            [appSettingPrefix + this._keySuffix, database.docDBData!.masterKey],
            [appSettingPrefix + this._databaseSuffix, database.databaseName]
        ]);
    }
}

interface IDetectedConnection {
    keys: string[];
    connectionString: string;
}
