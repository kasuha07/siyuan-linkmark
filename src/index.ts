import { confirm, Menu, Plugin, showMessage, type IProtyle } from "siyuan";
import "./style.css";
import { FrontendCacheClient } from "./frontend-cache-client";
import { CacheManagerDialog } from "./frontend-cache-manager";
import { planScanDecision, type CacheEntry } from "./frontend-cache-state";
import { IconPickerDialog } from "./frontend-icon-picker";
import { showRefreshResult } from "./frontend-labels";
import {
  LINK_CONTENT_OBSERVER_OPTIONS,
  LINK_IDENTITY_ATTRIBUTES,
  planMutationDiscovery,
  type MutationDiscoveryRecord,
} from "./frontend-mutation-discovery";
import { LinkContentObserverRegistry, protyleContentContainers } from "./frontend-observer-registry";
import {
  flushFrontendRenderWork,
  FrontendRenderWorkQueue,
  type FrontendRenderWorkExecutor,
} from "./frontend-render-work";
import {
  defaultSettings,
  mergeFrontendSettings,
  monogramSignature,
  type Settings,
} from "./frontend-settings";
import { SettingsPanel } from "./frontend-settings-panel";
import {
  createScopeQuery,
  planBindingSynchronization,
  presentIconBindingFor,
  reconcilePresentBindings,
  type PresentBindingContext,
} from "./icon-rule";
import { LINKMARK_BINDING_ATTRIBUTE, RuntimeIconBindingPublisher } from "./runtime-icon-bindings";
import { scopeForUrl, scopeFromCacheKey, type LinkScope } from "./url-scope";

const DISPLAY_SETTINGS_FILE = "display-settings-v2.json";
const RUNTIME_STYLE_ID = "siyuan-linkmark-runtime-style";
const FEEDBACK_URL = "https://github.com/kasuha07/siyuan-linkmark/issues";
const RULE_RENDER_BATCH_DELAY = 16;
const LINK_SELECTOR = [
  ".protyle-wysiwyg span[data-type~='a'][data-href]",
  ".protyle-wysiwyg span[data-type~='url'][data-href]",
  ".protyle-wysiwyg a[href]",
  ".b3-typography a[href]",
].join(",");
const DETACHED_LINK_SELECTOR = [
  "span[data-type~='a'][data-href]",
  "span[data-type~='url'][data-href]",
  "a[href]",
].join(",");
const EDITOR_SELECTOR = ".protyle-wysiwyg";
const EDITOR_BLOCK_SELECTOR = "[data-node-id]";
const STATIC_CONTAINER_SELECTOR = ".protyle-preview > .b3-typography";
const LOCAL_DISCOVERY_SELECTORS = {
  link: LINK_SELECTOR,
  detachedLink: DETACHED_LINK_SELECTOR,
  editor: EDITOR_SELECTOR,
  block: EDITOR_BLOCK_SELECTOR,
  staticContainer: STATIC_CONTAINER_SELECTOR,
};

export default class LinkmarkPlugin extends Plugin {
  private settings: Settings = { ...defaultSettings };
  private presentScopes = new Map<string, LinkScope>();
  private iconBindings = new Map<string, string>();
  private pendingMarkerBindings = new Map<HTMLElement, string | undefined>();
  private pendingFullMarkerReconcile = false;
  private readonly bindingPublisher = new RuntimeIconBindingPublisher(document, RUNTIME_STYLE_ID);
  private readonly contentObservers = new LinkContentObserverRegistry<Element, MutationObserver>(
    (container) => this.createContentObserver(container),
  );
  private scanTimer?: number;
  private renderWorkTimer?: number;
  private readonly renderWork = new FrontendRenderWorkQueue<Element>((outer, inner) => outer.contains(inner));
  private topBarElement?: HTMLElement;
  private client!: FrontendCacheClient;
  private settingsPanel?: SettingsPanel;
  private readonly protyleRegisterListener = (event: CustomEvent<{ protyle: IProtyle }>) => {
    this.registerProtyleContent(event.detail.protyle);
  };
  private readonly protyleDestroyListener = (event: CustomEvent<{ protyle: IProtyle }>) => {
    this.unregisterProtyleContent(event.detail.protyle);
    this.scheduleScan();
  };

  async onload() {
    this.addToolbar();
    const loadedDisplaySettings = await this.loadData(DISPLAY_SETTINGS_FILE);
    this.settings = mergeFrontendSettings(loadedDisplaySettings);
    this.client = new FrontendCacheClient({
      rpc: this.kernel?.rpc,
      settings: this.settings,
      callbacks: {
        onCacheChanged: (previous, changedKeys) => this.synchronizeCacheBindings(previous, changedKeys),
        onEntryCountChange: (count) => this.settingsPanel?.updateCacheCount(count),
        onManualRefreshFailed: (scope) => {
          showMessage(this.t("manualRefreshFailed").replace("{domain}", scope.domain));
        },
      },
    });
    await this.client.load();
    await this.client.subscribe();
    this.settingsPanel = new SettingsPanel({
      t: (key) => this.t(key),
      settings: this.settings,
      callbacks: {
        saveDisplay: () => this.saveDisplaySettings(),
        savePolicy: () => this.client.savePolicy(),
        onSaved: (context) => this.applySettingsSaved(context),
        refreshCurrent: () => {
          void this.refreshCurrentDocument();
        },
        refreshAll: () => this.confirmRefreshAll(),
        openCacheManager: () => this.openCacheManager(),
      },
    });
    this.settingsPanel.updateCacheCount(this.client.entryCount());
    this.setting = this.settingsPanel.setting;
    this.startObserver();
    // The initial scan runs immediately instead of on the scan debounce so
    // cached scopes render at the first frame; the trailing scheduled scan
    // is a safety net for content that changed during load.
    this.scanLinks();
    this.publishBindings();
    this.scheduleScan();
  }

  onunload() {
    this.removeProtyleEventListeners();
    this.contentObservers.destroy();
    if (this.scanTimer !== undefined) window.clearTimeout(this.scanTimer);
    if (this.renderWorkTimer !== undefined) window.clearTimeout(this.renderWorkTimer);
    this.topBarElement?.remove();
    this.bindingPublisher.destroy();
  }

  private t(key: string) {
    return String(this.i18n[key] ?? key);
  }

  private async saveDisplaySettings() {
    const { enabled, iconSize } = this.settings;
    await this.saveData(DISPLAY_SETTINGS_FILE, { enabled, iconSize });
  }

  private async applySettingsSaved(context: {
    wasEnabled: boolean;
    wasPaused: boolean | undefined;
    previousIconSize: number;
    previousCacheDays: number;
    previousMonogramSignature: string;
  }) {
    if (context.previousMonogramSignature !== monogramSignature(this.settings)) {
      await this.invalidateGeneratedMonograms();
    }
    if (!context.wasPaused && this.settings.pauseAutomaticFetch) this.client.bumpAutomaticGeneration();
    if (!this.settings.enabled) this.requestRuleRebuild();
    else if (!context.wasEnabled
      || context.wasPaused !== this.settings.pauseAutomaticFetch
      || context.previousCacheDays !== this.settings.cacheDays) this.scheduleScan();
    else if (context.previousIconSize !== this.settings.iconSize) this.requestRuleRebuild();
  }

  private async invalidateGeneratedMonograms() {
    await this.client.clearGenerated();
    this.scheduleScan();
  }

  private addToolbar() {
    const icon = `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="15" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="3.2"/>
      <path d="M19 18.5h11M19 25h8" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>
      <path d="m25 .5 2 4 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2 2-4Z" fill="currentColor"/>
    </svg>`;
    this.topBarElement = this.addTopBar({
      icon,
      title: this.t("toolbarTitle"),
      position: "right",
      callback: (event) => this.openToolbarMenu(event),
    });
  }

  private openToolbarMenu(event: MouseEvent) {
    const menu = new Menu("siyuan-linkmark-toolbar-menu");
    menu.addItem({
      type: "readonly",
      label: `${this.t("toolbarStatus")
        .replace("{count}", String(this.client.entryCount()))}${
        this.settings.pauseAutomaticFetch ? ` · ${this.t("automaticFetchPausedStatus")}` : ""
      }${
        this.settings.allowFullPageDiscovery ? ` · ${this.t("fullPageDiscoveryEnabledStatus")}` : ""
      }`,
    });
    menu.addItem({
      label: this.t("toolbarEnabled"),
      checked: this.settings.enabled,
      click: () => void this.setEnabled(!this.settings.enabled),
    });
    menu.addSeparator();
    menu.addItem({
      label: this.t("refreshCurrent"),
      click: () => void this.refreshCurrentDocument(),
    });
    menu.addItem({
      label: this.t("manageCache"),
      click: () => this.openCacheManager(),
    });
    menu.addItem({
      label: this.t("openSettings"),
      click: () => this.openSetting(),
    });
    menu.addItem({
      label: this.t("feedback"),
      click: () => {
        window.open(FEEDBACK_URL, "_blank", "noopener,noreferrer");
      },
    });
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    menu.open({
      x: rect?.right ?? event.clientX,
      y: rect?.bottom ?? event.clientY,
      isLeft: true,
    });
  }

  private async setEnabled(enabled: boolean) {
    this.settings.enabled = enabled;
    this.settingsPanel?.setEnabled(enabled);
    await this.saveDisplaySettings();
    if (enabled) this.scheduleScan();
    else this.requestRuleRebuild();
    showMessage(this.t(enabled ? "pluginEnabled" : "pluginDisabled"));
  }

  private confirmRefreshAll() {
    confirm(this.t("refreshAll"), this.t("refreshAllConfirm"), (dialog) => {
      dialog.destroy();
      void this.refreshAllCachedDomains();
    });
  }

  private currentDocumentRoot() {
    const active = document.querySelector<HTMLElement>(".layout__wnd--active .protyle-wysiwyg");
    if (active) return active;
    return [...document.querySelectorAll<HTMLElement>(".protyle-wysiwyg")]
      .find((element) => element.offsetParent !== null) ?? null;
  }

  private collectDocumentDomains(root?: Element | null) {
    const domains = new Map<string, { scope: LinkScope; targetUrl: string; elements: HTMLElement[] }>();
    const roots = root
      ? [root]
      : [...this.contentObservers.containers()].filter((container) => container.isConnected);
    const elements = roots.flatMap((container) => [
      ...(container.matches(LINK_SELECTOR) ? [container as HTMLElement] : []),
      ...container.querySelectorAll<HTMLElement>(LINK_SELECTOR),
    ]);
    for (const element of elements) {
      const href = element.dataset.href ?? element.getAttribute("href") ?? "";
      const scope = scopeForUrl(href);
      if (!scope) continue;
      const existing = domains.get(scope.key);
      if (existing) existing.elements.push(element);
      else domains.set(scope.key, { scope, targetUrl: href, elements: [element] });
    }
    return domains;
  }

  private currentDocumentTargetUrl(scopeKey: string) {
    return this.collectDocumentDomains(this.currentDocumentRoot()).get(scopeKey)?.targetUrl;
  }

  private async refreshCurrentDocument() {
    const domains = this.collectDocumentDomains(this.currentDocumentRoot());
    if (domains.size === 0) {
      showMessage(this.t("noCurrentDomains"));
      return;
    }
    const targets = new Map([...domains].map(([key, item]) => [key, { scope: item.scope, targetUrl: item.targetUrl }]));
    showMessage(this.t("refreshStarted").replace("{count}", String(targets.size)));
    showRefreshResult(this.t, await this.client.refreshDomains(targets));
  }

  private async refreshAllCachedDomains() {
    const targets = new Map(Object.entries(this.client.entries())
      .filter(([, entry]) => !entry.pinned)
      .map(([key, entry]) => {
        const scope = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
        const targetUrl = entry.targetUrl ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
        return [key, { scope, targetUrl }] as const;
      }));
    if (targets.size === 0) {
      showMessage(this.t(this.client.entryCount() === 0 ? "cacheEmpty" : "noRefreshableDomains"));
      return;
    }
    showMessage(this.t("refreshStarted").replace("{count}", String(targets.size)));
    showRefreshResult(this.t, await this.client.refreshDomains(targets));
  }

  private async restoreAutomaticIcon(key: string) {
    const entry = this.client.entryFor(key);
    if (!entry?.pinned) return;
    await this.client.remove(key);
    this.scheduleScan();
    showMessage(this.t("automaticRestored").replace("{domain}", entry.domain ?? key.split("::")[0]));
  }

  private openCacheManager() {
    new CacheManagerDialog({
      t: (key) => this.t(key),
      client: this.client,
      settings: this.settings,
      actions: {
        refreshCurrentDocument: () => this.refreshCurrentDocument(),
        refreshAllCachedDomains: () => this.refreshAllCachedDomains(),
        restoreAutomaticIcon: (key) => this.restoreAutomaticIcon(key),
        openIconPicker: (scope, targetUrl, afterChange) => this.openIconPicker(scope, targetUrl, afterChange),
        scheduleScan: () => this.scheduleScan(),
        currentDocumentTargetUrl: (key) => this.currentDocumentTargetUrl(key),
      },
    });
  }

  private openIconPicker(selectedScope: LinkScope, targetUrl: string, afterChange: () => void) {
    new IconPickerDialog({
      t: (key) => this.t(key),
      client: this.client,
      settings: this.settings,
      selectedScope,
      targetUrl,
      afterChange,
      actions: {
        restoreAutomaticIcon: (key) => this.restoreAutomaticIcon(key),
        scheduleScan: () => this.scheduleScan(),
      },
    });
  }

  private startObserver() {
    this.addProtyleEventListeners();
    for (const container of document.querySelectorAll<HTMLElement>(`${EDITOR_SELECTOR}, ${STATIC_CONTAINER_SELECTOR}`)) {
      this.registerContentContainer(container);
    }
  }

  private createContentObserver(container: Element) {
    const observer = new MutationObserver((records) => {
      const normalized: MutationDiscoveryRecord<Element>[] = [];
      for (const record of records) {
        if (record.type === "childList") {
          normalized.push({
            type: "childList",
            addedElements: [...record.addedNodes].filter((node): node is Element => node instanceof Element),
            removedElements: [...record.removedNodes].filter((node): node is Element => node instanceof Element),
          });
          continue;
        }
        const target = record.target instanceof Element ? record.target : null;
        const attributeName = LINK_IDENTITY_ATTRIBUTES.find((name) => name === record.attributeName);
        if (target && attributeName) {
          normalized.push({ type: "attributes", target, attributeName, oldValue: record.oldValue });
        }
      }
      const discovery = planMutationDiscovery(normalized, LOCAL_DISCOVERY_SELECTORS);
      if (!discovery) return;
      if (discovery.kind === "full") this.renderWork.requestFullDiscovery();
      else for (const region of discovery.regions) this.renderWork.requestLocalDiscovery(region);
      this.scheduleDiscoveryTimer();
    });
    observer.observe(container, LINK_CONTENT_OBSERVER_OPTIONS);
    return observer;
  }

  private registerContentContainer(container: Element) {
    if (!container.isConnected) return;
    if (this.contentObservers.register(container)) this.scheduleScan(container);
  }

  private registerProtyleContent(protyle: IProtyle) {
    for (const container of protyleContentContainers(protyle)) this.registerContentContainer(container);
  }

  private unregisterProtyleContent(protyle: IProtyle) {
    for (const container of protyleContentContainers(protyle)) this.contentObservers.unregister(container);
  }

  private addProtyleEventListeners() {
    this.eventBus.on("loaded-protyle-static", this.protyleRegisterListener);
    this.eventBus.on("loaded-protyle-dynamic", this.protyleRegisterListener);
    this.eventBus.on("switch-protyle", this.protyleRegisterListener);
    this.eventBus.on("switch-protyle-mode", this.protyleRegisterListener);
    this.eventBus.on("destroy-protyle", this.protyleDestroyListener);
  }

  private removeProtyleEventListeners() {
    this.eventBus.off("loaded-protyle-static", this.protyleRegisterListener);
    this.eventBus.off("loaded-protyle-dynamic", this.protyleRegisterListener);
    this.eventBus.off("switch-protyle", this.protyleRegisterListener);
    this.eventBus.off("switch-protyle-mode", this.protyleRegisterListener);
    this.eventBus.off("destroy-protyle", this.protyleDestroyListener);
  }

  private scheduleDiscoveryTimer() {
    if (this.scanTimer !== undefined) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = undefined;
      this.renderWork.flushDiscovery();
      this.scheduleRenderWork();
    }, 250);
  }

  private scheduleScan(root?: Element | null) {
    if (root) this.renderWork.requestLocalDiscovery(root);
    else this.renderWork.requestFullDiscovery();
    this.scheduleDiscoveryTimer();
  }

  private requestRuleRebuild() {
    this.renderWork.requestRuleRebuild();
    this.scheduleRenderWork();
  }

  private scheduleRenderWork() {
    if (this.renderWorkTimer !== undefined) return;
    // Let concurrent cache and discovery changes settle into one atomic publication.
    this.renderWorkTimer = window.setTimeout(() => this.flushRenderWork(), RULE_RENDER_BATCH_DELAY);
  }

  private flushRenderWork() {
    this.renderWorkTimer = undefined;
    const executor: FrontendRenderWorkExecutor<Element> = {
      rebuildRules: () => this.rebuildBindings(),
      discover: (discovery) => {
        if (discovery.kind === "full") return this.scanLinks();
        let rulesChanged = false;
        for (const root of discovery.regions) rulesChanged = this.scanLinks(root) || rulesChanged;
        return rulesChanged;
      },
      publishRules: () => this.publishBindings(),
    };
    flushFrontendRenderWork(this.renderWork, executor);
  }

  private scanLinks(root?: Element | null) {
    if (!this.settings.enabled) return false;
    const full = !root;
    const domains = this.collectDocumentDomains(root);
    if (full) {
      this.presentScopes = new Map([...domains].map(([key, { scope }]) => [key, scope]));
      this.pendingMarkerBindings.clear();
      this.pendingFullMarkerReconcile = true;
    } else {
      for (const [key, { scope }] of domains) this.presentScopes.set(key, scope);
    }
    const context = this.presentBindingContext();
    const reconciled = reconcilePresentBindings({
      discovery: this.presentScopes.values(),
      context,
      previous: this.iconBindings,
    });
    this.iconBindings = reconciled.bindings;
    const publisherChanged = this.bindingPublisher.replaceBindings(this.iconBindings, this.settings.iconSize);
    let markerChanged = false;
    for (const { scope, elements } of domains.values()) {
      const bindingKey = presentIconBindingFor(scope, context)?.key;
      const token = this.bindingPublisher.tokenFor(bindingKey);
      for (const element of elements) {
        this.pendingMarkerBindings.set(element, bindingKey);
        if (element.getAttribute(LINKMARK_BINDING_ATTRIBUTE) !== token) markerChanged = true;
      }
    }

    domains.forEach(({ scope, targetUrl }, key) => {
      const decision = planScanDecision({
        scopeKey: key,
        scope,
        cache: this.client.entries(),
        pauseAutomaticFetch: Boolean(this.settings.pauseAutomaticFetch),
        cacheDays: this.settings.cacheDays,
        failedAt: this.client.failedAt(key),
      });
      if (decision.action === "expire") {
        void this.client.expire(decision.cacheKey, decision.entry, () => this.scheduleScan());
        return;
      }
      if (decision.action === "keep" && decision.fetch) void this.client.fetchAndCache(scope, targetUrl);
      if (decision.action === "fetch") void this.client.fetchAndCache(scope, targetUrl);
    });
    return full || reconciled.changed || publisherChanged || markerChanged;
  }

  private rebuildBindings() {
    if (!this.settings.enabled) {
      this.presentScopes.clear();
      this.iconBindings.clear();
      this.pendingMarkerBindings.clear();
      this.pendingFullMarkerReconcile = true;
      this.bindingPublisher.replaceBindings(this.iconBindings, this.settings.iconSize);
      return;
    }
    const reconciled = reconcilePresentBindings({
      discovery: this.presentScopes.values(),
      context: this.presentBindingContext(),
      previous: this.iconBindings,
    });
    if (!sameMapKeys(this.iconBindings, reconciled.bindings)) {
      this.scheduleScan();
      return;
    }
    this.iconBindings = reconciled.bindings;
    this.bindingPublisher.replaceBindings(this.iconBindings, this.settings.iconSize);
  }

  private presentBindingContext(cache = this.client.entries()): PresentBindingContext {
    return {
      cache,
      cacheDays: this.settings.cacheDays,
      pauseAutomaticFetch: Boolean(this.settings.pauseAutomaticFetch),
    };
  }

  private synchronizeCacheBindings(previousCache: Record<string, CacheEntry>, changedKeys: Iterable<string>) {
    if (!this.settings.enabled) return;
    const plan = planBindingSynchronization({
      scopes: this.presentScopes.values(),
      before: this.presentBindingContext(previousCache),
      after: this.presentBindingContext(),
      changedKeys,
    });
    if (plan.kind === "rules") {
      this.requestRuleRebuild();
      return;
    }
    if (plan.kind === "full" || !this.scheduleTargetedDiscovery(plan.scopes)) this.scheduleScan();
  }

  private scheduleTargetedDiscovery(scopes: Iterable<LinkScope>) {
    let matched = false;
    for (const scope of scopes) {
      const query = createScopeQuery(scope);
      for (const container of this.contentObservers.containers()) {
        if (!container.isConnected) continue;
        for (const element of container.querySelectorAll<HTMLElement>(query)) {
          matched = true;
          this.scheduleScan(element);
        }
      }
    }
    return matched;
  }

  private publishBindings() {
    const markers = this.pendingMarkerBindings;
    const full = this.pendingFullMarkerReconcile;
    this.pendingMarkerBindings = new Map();
    this.pendingFullMarkerReconcile = false;
    this.bindingPublisher.publish(markers, full);
  }
}

function sameMapKeys(left: ReadonlyMap<string, unknown>, right: ReadonlyMap<string, unknown>) {
  if (left.size !== right.size) return false;
  for (const key of left.keys()) {
    if (!right.has(key)) return false;
  }
  return true;
}
