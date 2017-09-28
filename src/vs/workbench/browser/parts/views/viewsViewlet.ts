/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import * as errors from 'vs/base/common/errors';
import * as DOM from 'vs/base/browser/dom';
import { $, Dimension, Builder } from 'vs/base/browser/builder';
import { Scope } from 'vs/workbench/common/memento';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { IAction, IActionRunner } from 'vs/base/common/actions';
import { IActionItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { ITree } from 'vs/base/parts/tree/browser/tree';
import { firstIndex } from 'vs/base/common/arrays';
import { DelayedDragHandler } from 'vs/base/browser/dnd';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { ViewsRegistry, ViewLocation, IViewDescriptor } from 'vs/workbench/browser/parts/views/viewsRegistry';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { PanelViewlet, ViewletPanel } from 'vs/workbench/browser/parts/views/panelViewlet';
import { IPanelOptions } from 'vs/base/browser/ui/splitview/panelview';

export interface IViewOptions extends IPanelOptions {
	id: string;
	name: string;
	actionRunner: IActionRunner;
}

export interface IViewConstructorSignature<T extends ViewsViewletPanel> {
	new(options: IViewOptions, ...services: { _serviceBrand: any; }[]): T;
}

export abstract class ViewsViewletPanel extends ViewletPanel {

	readonly id: string;
	readonly name: string;
	protected treeContainer: HTMLElement;

	// TODO@sandeep why is tree here? isn't this coming only from TreeView
	protected tree: ITree;
	protected isDisposed: boolean;
	private _isVisible: boolean;
	private dragHandler: DelayedDragHandler;

	constructor(
		options: IViewOptions,
		protected keybindingService: IKeybindingService,
		protected contextMenuService: IContextMenuService
	) {
		super(options.name, options, keybindingService, contextMenuService);

		this.id = options.id;
		this.name = options.name;
		this._expanded = options.expanded;
	}

	setExpanded(expanded: boolean): void {
		this.updateTreeVisibility(this.tree, expanded);
		super.setExpanded(expanded);
	}

	protected renderHeader(container: HTMLElement): void {
		super.renderHeader(container);

		// Expand on drag over
		this.dragHandler = new DelayedDragHandler(container, () => this.setExpanded(true));
	}

	protected renderViewTree(container: HTMLElement): HTMLElement {
		const treeContainer = document.createElement('div');
		container.appendChild(treeContainer);
		return treeContainer;
	}

	getViewer(): ITree {
		return this.tree;
	}

	isVisible(): boolean {
		return this._isVisible;
	}

	setVisible(visible: boolean): TPromise<void> {
		if (this._isVisible !== visible) {
			this._isVisible = visible;
			this.updateTreeVisibility(this.tree, visible && this.isExpanded());
		}

		return TPromise.as(null);
	}

	focus(): void {
		super.focus();
		this.focusTree();
	}

	protected reveal(element: any, relativeTop?: number): TPromise<void> {
		if (!this.tree) {
			return TPromise.as(null); // return early if viewlet has not yet been created
		}

		return this.tree.reveal(element, relativeTop);
	}

	layoutBody(size: number): void {
		if (this.tree) {
			this.treeContainer.style.height = size + 'px';
			this.tree.layout(size);
		}
	}

	getActions(): IAction[] {
		return [];
	}

	getSecondaryActions(): IAction[] {
		return [];
	}

	getActionItem(action: IAction): IActionItem {
		return null;
	}

	getActionsContext(): any {
		return undefined;
	}

	getOptimalWidth(): number {
		return 0;
	}

	create(): TPromise<void> {
		return TPromise.as(null);
	}

	shutdown(): void {
		// Subclass to implement
	}

	dispose(): void {
		this.isDisposed = true;
		this.treeContainer = null;

		if (this.tree) {
			this.tree.dispose();
		}

		if (this.dragHandler) {
			this.dragHandler.dispose();
		}

		super.dispose();
	}

	private updateTreeVisibility(tree: ITree, isVisible: boolean): void {
		if (!tree) {
			return;
		}

		if (isVisible) {
			$(tree.getHTMLElement()).show();
		} else {
			$(tree.getHTMLElement()).hide(); // make sure the tree goes out of the tabindex world by hiding it
		}

		if (isVisible) {
			tree.onVisible();
		} else {
			tree.onHidden();
		}
	}

	private focusTree(): void {
		if (!this.tree) {
			return; // return early if viewlet has not yet been created
		}

		// Make sure the current selected element is revealed
		const selection = this.tree.getSelection();
		if (selection.length > 0) {
			this.reveal(selection[0], 0.5).done(null, errors.onUnexpectedError);
		}

		// Pass Focus to Viewer
		this.tree.DOMFocus();
	}
}

export interface IViewletViewOptions extends IViewOptions {
	viewletSettings: object;
}

export interface IViewState {
	collapsed: boolean;
	size: number | undefined;
	isHidden: boolean;
	order: number;
}

export class ViewsViewlet extends PanelViewlet {

	private viewHeaderContextMenuListeners: IDisposable[] = [];
	private viewletSettings: object;
	private readonly viewsContextKeys: Set<string> = new Set<string>();

	private viewsViewletPanels: ViewsViewletPanel[] = [];

	protected viewsStates: Map<string, IViewState> = new Map<string, IViewState>();
	private areExtensionsReady: boolean = false;

	constructor(
		id: string,
		private location: ViewLocation,
		private showHeaderInTitleWhenSingleView: boolean,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService protected storageService: IStorageService,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IContextKeyService protected contextKeyService: IContextKeyService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@IExtensionService protected extensionService: IExtensionService
	) {
		super(id, { showHeaderInTitleWhenSingleView, dnd: true }, telemetryService, themeService);

		this.viewletSettings = this.getMemento(storageService, Scope.WORKSPACE);
	}

	async create(parent: Builder): TPromise<void> {
		super.create(parent);

		this._register(ViewsRegistry.onViewsRegistered(this.onViewsRegistered, this));
		this._register(ViewsRegistry.onViewsDeregistered(this.onViewsDeregistered, this));
		this._register(this.contextKeyService.onDidChangeContext(keys => this.onContextChanged(keys)));

		await this.extensionService.onReady();
		this.areExtensionsReady = true;
		await this.updateViews();
		// this.onViewsUpdated();

		await this.onViewsRegistered(ViewsRegistry.getViews(this.location));
		this.focus();
	}

	getContextMenuActions(): IAction[] {
		return this.getViewDescriptorsFromRegistry(true)
			.filter(viewDescriptor => viewDescriptor.canToggleVisibility && this.contextKeyService.contextMatchesRules(viewDescriptor.when))
			.map(viewDescriptor => (<IAction>{
				id: `${viewDescriptor.id}.toggleVisibility`,
				label: viewDescriptor.name,
				checked: this.isCurrentlyVisible(viewDescriptor),
				enabled: true,
				run: () => this.toggleViewVisibility(viewDescriptor.id)
			}));
	}

	setVisible(visible: boolean): TPromise<void> {
		return super.setVisible(visible)
			.then(() => TPromise.join(this.viewsViewletPanels.filter(view => view.isVisible() !== visible)
				.map((view) => view.setVisible(visible))))
			.then(() => void 0);
	}

	private didLayout = false;

	layout(dimension: Dimension): void {
		super.layout(dimension);

		if (!this.didLayout) {
			this.didLayout = true;

			for (const panel of this.viewsViewletPanels) {
				const viewState = this.viewsStates.get(panel.id);
				const size = viewState ? viewState.size : 200;
				this.resizePanel(panel, size);
			}
		}

		for (const view of this.viewsViewletPanels) {
			let viewState = this.updateViewStateSize(view);
			this.viewsStates.set(view.id, viewState);
		}
	}

	getOptimalWidth(): number {
		const additionalMargin = 16;
		const optimalWidth = Math.max(...this.viewsViewletPanels.map(view => view.getOptimalWidth() || 0));
		return optimalWidth + additionalMargin;
	}

	shutdown(): void {
		this.viewsViewletPanels.forEach((view) => view.shutdown());
		super.shutdown();
	}

	toggleViewVisibility(id: string, visible?: boolean): void {
		const view = this.getView(id);
		let viewState = this.viewsStates.get(id);

		if ((visible === true && view) || (visible === false && !view)) {
			return;
		}

		if (view) {
			viewState = viewState || this.createViewState(view);
			viewState.isHidden = true;
		} else {
			viewState = viewState || { collapsed: true, size: void 0, isHidden: false, order: void 0 };
			viewState.isHidden = false;
		}
		this.viewsStates.set(id, viewState);
		this.updateViews();
	}

	private onViewsRegistered(views: IViewDescriptor[]): TPromise<ViewsViewletPanel[]> {
		this.viewsContextKeys.clear();
		for (const viewDescriptor of this.getViewDescriptorsFromRegistry()) {
			if (viewDescriptor.when) {
				for (const key of viewDescriptor.when.keys()) {
					this.viewsContextKeys.add(key);
				}
			}
		}

		return this.updateViews();
	}

	private onViewsDeregistered(views: IViewDescriptor[]): TPromise<ViewsViewletPanel[]> {
		return this.updateViews(views);
	}

	private onContextChanged(keys: string[]): void {
		if (!keys) {
			return;
		}

		let hasToUpdate: boolean = false;
		for (const key of keys) {
			if (this.viewsContextKeys.has(key)) {
				hasToUpdate = true;
				break;
			}
		}

		if (hasToUpdate) {
			this.updateViews();
		}
	}

	protected updateViews(unregisteredViews: IViewDescriptor[] = []): TPromise<ViewsViewletPanel[]> {
		const registeredViews = this.getViewDescriptorsFromRegistry();
		const [visible, toAdd, toRemove] = registeredViews.reduce<[IViewDescriptor[], IViewDescriptor[], IViewDescriptor[]]>((result, viewDescriptor) => {
			const isCurrentlyVisible = this.isCurrentlyVisible(viewDescriptor);
			const canBeVisible = this.canBeVisible(viewDescriptor);

			if (canBeVisible) {
				result[0].push(viewDescriptor);
			}

			if (!isCurrentlyVisible && canBeVisible) {
				result[1].push(viewDescriptor);
			}

			if (isCurrentlyVisible && !canBeVisible) {
				result[2].push(viewDescriptor);
			}

			return result;

		}, [[], [], unregisteredViews]);

		const toCreate: ViewsViewletPanel[] = [];

		if (toAdd.length || toRemove.length) {
			const panels = [...this.viewsViewletPanels];

			for (const view of panels) {
				let viewState = this.viewsStates.get(view.id);
				if (!viewState || typeof viewState.size === 'undefined' || !view.isExpanded() !== viewState.collapsed) {
					viewState = this.updateViewStateSize(view);
					this.viewsStates.set(view.id, viewState);
				}
			}

			if (toRemove.length) {
				for (const viewDescriptor of toRemove) {
					let view = this.getView(viewDescriptor.id);
					const viewState = this.updateViewStateSize(view);
					this.viewsStates.set(view.id, viewState);
					this.removePanel(view);
					this.viewsViewletPanels.splice(this.viewsViewletPanels.indexOf(view), 1);
				}
			}

			for (const viewDescriptor of toAdd) {
				let viewState = this.viewsStates.get(viewDescriptor.id);
				let index = visible.indexOf(viewDescriptor);
				const view = this.createView(viewDescriptor,
					{
						id: viewDescriptor.id,
						name: viewDescriptor.name,
						actionRunner: this.getActionRunner(),
						expanded: !(viewState ? viewState.collapsed : void 0),
						viewletSettings: this.viewletSettings
					});
				toCreate.push(view);

				const size = viewState ? viewState.size : (viewDescriptor.size || 200);
				this.addPanel(view, size, index);
				this.viewsViewletPanels.splice(index, 0, view);
			}

			return TPromise.join(toCreate.map(view => view.create()))
				.then(() => this.onViewsUpdated())
				.then(() => toCreate);
		}

		return TPromise.as([]);
	}

	movePanel(from: ViewletPanel, to: ViewletPanel): void {
		const fromIndex = firstIndex(this.viewsViewletPanels, panel => panel === from);
		const toIndex = firstIndex(this.viewsViewletPanels, panel => panel === to);

		if (fromIndex < 0 || fromIndex >= this.viewsViewletPanels.length) {
			return;
		}

		if (toIndex < 0 || toIndex >= this.viewsViewletPanels.length) {
			return;
		}

		super.movePanel(from, to);

		const [panel] = this.viewsViewletPanels.splice(fromIndex, 1);
		this.viewsViewletPanels.splice(toIndex, 0, panel);

		for (let order = 0; order < this.viewsViewletPanels.length; order++) {
			this.viewsStates.get(this.viewsViewletPanels[order].id).order = order;
		}
	}

	protected getDefaultViewSize(): number | undefined {
		return undefined;
	}

	private isCurrentlyVisible(viewDescriptor: IViewDescriptor): boolean {
		return !!this.getView(viewDescriptor.id);
	}

	private canBeVisible(viewDescriptor: IViewDescriptor): boolean {
		const viewstate = this.viewsStates.get(viewDescriptor.id);
		if (viewstate && viewstate.isHidden) {
			return false;
		}
		return this.contextKeyService.contextMatchesRules(viewDescriptor.when);
	}

	private onViewsUpdated(): TPromise<void> {
		this.viewHeaderContextMenuListeners = dispose(this.viewHeaderContextMenuListeners);

		for (const viewDescriptor of this.getViewDescriptorsFromRegistry()) {
			const view = this.getView(viewDescriptor.id);

			if (view) {
				this.viewHeaderContextMenuListeners.push(DOM.addDisposableListener(view.draggableElement, DOM.EventType.CONTEXT_MENU, e => {
					e.stopPropagation();
					e.preventDefault();
					if (viewDescriptor.canToggleVisibility) {
						this.onContextMenu(new StandardMouseEvent(e), view);
					}
				}));
			}
		}

		return this.setVisible(this.isVisible());
	}

	private onContextMenu(event: StandardMouseEvent, view: ViewsViewletPanel): void {
		event.stopPropagation();
		event.preventDefault();

		let anchor: { x: number, y: number } = { x: event.posx, y: event.posy };
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => TPromise.as([<IAction>{
				id: `${view.id}.removeView`,
				label: nls.localize('hideView', "Hide from Side Bar"),
				enabled: true,
				run: () => this.toggleViewVisibility(view.id)
			}]),
		});
	}

	protected showHeaderInTitleArea(): boolean {
		if (!this.showHeaderInTitleWhenSingleView) {
			return false;
		}
		if (this.viewsViewletPanels.length > 1) {
			return false;
		}
		if (ViewLocation.getContributedViewLocation(this.location.id) && !this.areExtensionsReady) {
			// Checks in cache so that view do not jump. See #29609
			let visibleViewsCount = 0;
			const viewDecriptors = this.getViewDescriptorsFromRegistry();
			this.viewsStates.forEach((viewState, id) => {
				const viewDescriptor = viewDecriptors.filter(viewDescriptor => viewDescriptor.id === id)[0];
				const isHidden = viewState.isHidden || (viewDescriptor && !this.contextKeyService.contextMatchesRules(viewDescriptor.when));
				if (!isHidden) {
					visibleViewsCount++;
				}
			});
			return visibleViewsCount === 1;
		}
		return true;
	}

	protected getViewDescriptorsFromRegistry(defaultOrder: boolean = false): IViewDescriptor[] {
		return ViewsRegistry.getViews(this.location)
			.sort((a, b) => {
				const viewStateA = this.viewsStates.get(a.id);
				const viewStateB = this.viewsStates.get(b.id);
				const orderA = !defaultOrder && viewStateA ? viewStateA.order : a.order;
				const orderB = !defaultOrder && viewStateB ? viewStateB.order : b.order;

				if (orderB === void 0 || orderB === null) {
					return -1;
				}
				if (orderA === void 0 || orderA === null) {
					return 1;
				}

				return orderA - orderB;
			});
	}

	protected createView(viewDescriptor: IViewDescriptor, options: IViewletViewOptions): ViewsViewletPanel {
		return this.instantiationService.createInstance(viewDescriptor.ctor, options);
	}

	protected get views(): ViewsViewletPanel[] {
		return this.viewsViewletPanels;
	}

	protected getView(id: string): ViewsViewletPanel {
		return this.viewsViewletPanels.filter(view => view.id === id)[0];
	}

	private updateViewStateSize(view: ViewsViewletPanel): IViewState {
		const currentState = this.viewsStates.get(view.id);
		const newViewState = this.createViewState(view);
		return currentState ? { ...currentState, collapsed: newViewState.collapsed, size: newViewState.size } : newViewState;
	}

	protected createViewState(view: ViewsViewletPanel): IViewState {
		return {
			collapsed: !view.isExpanded(),
			size: this.getPanelSize(view),
			isHidden: false,
			order: this.viewsViewletPanels.indexOf(view)
		};
	}
}

export class PersistentViewsViewlet extends ViewsViewlet {

	constructor(
		id: string,
		location: ViewLocation,
		private viewletStateStorageId: string,
		showHeaderInTitleWhenSingleView: boolean,
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService
	) {
		super(id, location, showHeaderInTitleWhenSingleView, telemetryService, storageService, instantiationService, themeService, contextKeyService, contextMenuService, extensionService);
		this.loadViewsStates();
	}

	shutdown(): void {
		this.saveViewsStates();
		super.shutdown();
	}

	private saveViewsStates(): void {
		const viewsStates = {};
		const registeredViewDescriptors = this.getViewDescriptorsFromRegistry();
		this.viewsStates.forEach((viewState, id) => {
			const view = this.getView(id);

			if (view) {
				viewsStates[id] = this.createViewState(view);
			} else {
				const viewDescriptor = registeredViewDescriptors.filter(v => v.id === id)[0];
				if (viewDescriptor) {
					viewsStates[id] = viewState;
				}
			}
		});

		this.storageService.store(this.viewletStateStorageId, JSON.stringify(viewsStates), this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? StorageScope.WORKSPACE : StorageScope.GLOBAL);
	}

	private loadViewsStates(): void {
		const viewsStates = JSON.parse(this.storageService.get(this.viewletStateStorageId, this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? StorageScope.WORKSPACE : StorageScope.GLOBAL, '{}'));
		Object.keys(viewsStates).forEach(id => this.viewsStates.set(id, <IViewState>viewsStates[id]));
	}
}