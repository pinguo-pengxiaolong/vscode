/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IWorkspaceEditingService } from 'vs/workbench/services/workspace/common/workspaceEditing';
import URI from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IWindowsService, IWindowService, IEnterWorkspaceResult } from 'vs/platform/windows/common/windows';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IJSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditing';
import { IWorkspacesService, IStoredWorkspaceFolder, IWorkspaceIdentifier, isStoredWorkspaceFolder } from 'vs/platform/workspaces/common/workspaces';
import { dirname } from 'path';
import { IWorkspaceConfigurationService } from 'vs/workbench/services/configuration/common/configuration';
import { massageFolderPathForWorkspace } from 'vs/platform/workspaces/node/workspaces';
import { isLinux } from 'vs/base/common/platform';
import { WorkspaceService } from 'vs/workbench/services/configuration/node/configuration';
import { migrateStorageToMultiRootWorkspace } from 'vs/platform/storage/common/migration';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { StorageService } from 'vs/platform/storage/common/storageService';
import { ConfigurationScope, IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { Registry } from 'vs/platform/registry/common/platform';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { BackupFileService } from 'vs/workbench/services/backup/node/backupFileService';
import { Schemas } from 'vs/base/common/network';

export class WorkspaceEditingService implements IWorkspaceEditingService {

	public _serviceBrand: any;

	constructor(
		@IJSONEditingService private jsonEditingService: IJSONEditingService,
		@IWorkspaceContextService private contextService: WorkspaceService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IWindowsService private windowsService: IWindowsService,
		@IWindowService private windowService: IWindowService,
		@IWorkspacesService private workspacesService: IWorkspacesService,
		@IWorkspaceConfigurationService private workspaceConfigurationService: IWorkspaceConfigurationService,
		@IStorageService private storageService: IStorageService,
		@IExtensionService private extensionService: IExtensionService,
		@IBackupFileService private backupFileService: IBackupFileService
	) {
	}

	public addFolders(foldersToAdd: URI[]): TPromise<void> {
		if (!this.isSupported()) {
			return TPromise.as(void 0); // we need a workspace to begin with
		}

		const currentWorkspaceFolders = this.contextService.getWorkspace().folders;
		const currentWorkspaceFolderUris = currentWorkspaceFolders.map(folder => folder.uri);
		const currentStoredFolders = currentWorkspaceFolders.map(folder => folder.raw);

		const storedFoldersToAdd: IStoredWorkspaceFolder[] = [];

		const workspaceConfigFolder = dirname(this.contextService.getWorkspace().configuration.fsPath);

		foldersToAdd.forEach(folderToAdd => {
			if (this.contains(currentWorkspaceFolderUris, folderToAdd)) {
				return; // already existing
			}

			if (folderToAdd.scheme === Schemas.file) {
				storedFoldersToAdd.push({
					path: massageFolderPathForWorkspace(folderToAdd.fsPath, workspaceConfigFolder, currentStoredFolders)
				});
			} else {
				storedFoldersToAdd.push({
					uri: folderToAdd.toString(true)
				});
			}
		});

		if (storedFoldersToAdd.length > 0) {
			return this.doSetFolders([...currentStoredFolders, ...storedFoldersToAdd]);
		}

		return TPromise.as(void 0);
	}

	public removeFolders(foldersToRemove: URI[]): TPromise<void> {
		if (!this.isSupported()) {
			return TPromise.as(void 0); // we need a workspace to begin with
		}

		const currentWorkspaceFolders = this.contextService.getWorkspace().folders;
		const currentStoredFolders = currentWorkspaceFolders.map(folder => folder.raw);

		const newStoredFolders: IStoredWorkspaceFolder[] = currentStoredFolders.filter((folder, index) => {
			if (!isStoredWorkspaceFolder(folder)) {
				return true; // keep entries which are unrelated
			}

			return !this.contains(foldersToRemove, currentWorkspaceFolders[index].uri); // keep entries which are unrelated
		});

		if (newStoredFolders.length !== currentStoredFolders.length) {
			return this.doSetFolders(newStoredFolders);
		}

		return TPromise.as(void 0);
	}

	private doSetFolders(folders: IStoredWorkspaceFolder[]): TPromise<void> {
		const workspace = this.contextService.getWorkspace();

		return this.jsonEditingService.write(workspace.configuration, { key: 'folders', value: folders }, true);
	}

	private isSupported(): boolean {
		// TODO@Ben multi root
		return (
			this.environmentService.appQuality !== 'stable'  // not yet enabled in stable
			&& this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE // we need a multi folder workspace to begin with
		);
	}

	private contains(resources: URI[], toCheck: URI): boolean {
		return resources.some(resource => {
			if (isLinux) {
				return resource.toString() === toCheck.toString();
			}

			return resource.toString().toLowerCase() === toCheck.toString().toLowerCase();
		});
	}

	public createAndEnterWorkspace(folders?: string[], path?: string): TPromise<void> {
		return this.doEnterWorkspace(() => this.windowService.createAndEnterWorkspace(folders, path));
	}

	public saveAndEnterWorkspace(path: string): TPromise<void> {
		return this.doEnterWorkspace(() => this.windowService.saveAndEnterWorkspace(path));
	}

	private doEnterWorkspace(mainSidePromise: () => TPromise<IEnterWorkspaceResult>): TPromise<void> {

		// Stop the extension host first to give extensions most time to shutdown
		this.extensionService.stopExtensionHost();

		return mainSidePromise().then(result => {
			let enterWorkspacePromise: TPromise<void> = TPromise.as(void 0);
			if (result) {

				// Migrate storage and settings
				enterWorkspacePromise = this.migrate(result.workspace).then(() => {

					// Reinitialize backup service
					const backupFileService = this.backupFileService as BackupFileService; // TODO@Ben ugly cast
					backupFileService.initialize(result.backupPath);

					// Reinitialize configuration service
					const workspaceImpl = this.contextService as WorkspaceService; // TODO@Ben TODO@Sandeep ugly cast
					return workspaceImpl.initialize(result.workspace);
				});
			}

			// Finally bring the extension host back online
			return enterWorkspacePromise.then(() => this.extensionService.startExtensionHost());
		});
	}

	private migrate(toWorkspace: IWorkspaceIdentifier): TPromise<void> {
		this.migrateStorage(toWorkspace);

		return this.migrateConfiguration(toWorkspace);
	}

	private migrateStorage(toWorkspace: IWorkspaceIdentifier): void {

		// TODO@Ben revisit this when we move away from local storage to a file based approach
		const storageImpl = this.storageService as StorageService;
		const newWorkspaceId = migrateStorageToMultiRootWorkspace(storageImpl.workspaceId, toWorkspace, storageImpl.workspaceStorage);
		storageImpl.setWorkspaceId(newWorkspaceId);
	}

	private migrateConfiguration(toWorkspace: IWorkspaceIdentifier): TPromise<void> {
		if (this.contextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			return TPromise.as(void 0); // return early if not a folder workspace is opened
		}

		const configurationProperties = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
		const targetWorkspaceConfiguration = {};
		for (const key of this.workspaceConfigurationService.keys().workspace) {
			if (configurationProperties[key] && configurationProperties[key].scope === ConfigurationScope.WINDOW) {
				targetWorkspaceConfiguration[key] = this.workspaceConfigurationService.lookup(key).workspace;
			}
		}

		return this.jsonEditingService.write(URI.file(toWorkspace.configPath), { key: 'settings', value: targetWorkspaceConfiguration }, true);
	}
}
