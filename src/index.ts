import { confirm, Dialog, Menu, Plugin, Setting, showMessage } from "siyuan";
import "./style.css";
import type { CacheRequestResult } from "./cache-authority";
import { isDecodableImage } from "./image-decode";
import {
  RESOLVER_VERSION,
  type FallbackMode,
  type MonogramColorMode,
  type MonogramOverride,
  type MonogramShape,
  type ProviderPreset,
  type ResolverMode,
} from "./resolver-contract";
import { createIconRule } from "./icon-rule";
import {
  CACHE_POLICY_FIELDS,
  clamp,
  defaultSettings,
  mergeFrontendSettings,
  monogramSignature,
  pickCachePolicy,
  type Settings,
} from "./frontend-settings";
import {
  addedLinkDiscoveryRegionFor,
  flushFrontendRenderWork,
  FrontendRenderWorkQueue,
  localDiscoveryRegionFor,
} from "./frontend-render-work";
import {
  cachedIconForScope,
  isCacheEntryFresh,
  planScanDecision,
  type CacheEntry,
} from "./frontend-cache-state";
import { shareDomainFor } from "./parent-domain";
import {
  base64ToBlob,
  blobToBase64,
  errorText,
  formatFileSize,
  iconFormat,
  normalizeDomainInput,
} from "./frontend-format";
import { fetchOutcomeFor, type FetchOutcome } from "./refresh-outcome";
import { scopeForUrl, scopeFromCacheKey, type LinkScope } from "./url-scope";

type FetchTrigger = "automatic" | "manual";

const DISPLAY_SETTINGS_FILE = "display-settings-v2.json";
const RUNTIME_STYLE_ID = "siyuan-linkmark-runtime-style";
const FEEDBACK_URL = "https://github.com/kasuha07/siyuan-linkmark/issues";
const MANUAL_FAILURE_WINDOW = 60 * 1000;
const RULE_RENDER_BATCH_DELAY = 16;
const LINK_SELECTOR = [
  ".protyle-wysiwyg span[data-type~='a'][data-href]",
  ".protyle-wysiwyg span[data-type~='url'][data-href]",
  ".protyle-wysiwyg a[href]",
  ".b3-typography a[href]",
].join(",");
const EDITOR_SELECTOR = ".protyle-wysiwyg";
const EDITOR_BLOCK_SELECTOR = "[data-node-id]";
const STATIC_CONTAINER_SELECTOR = ".b3-typography";
const LOCAL_DISCOVERY_SELECTORS = {
  link: LINK_SELECTOR,
  editor: EDITOR_SELECTOR,
  block: EDITOR_BLOCK_SELECTOR,
  staticContainer: STATIC_CONTAINER_SELECTOR,
};

export default class LinkmarkPlugin extends Plugin {
  private settings: Settings = { ...defaultSettings };
  private cache: Record<string, CacheEntry> = {};
  private pendingDomains = new Set<string>();
  private pendingFetches = new Map<string, {
    promise: Promise<FetchOutcome>;
    trigger: FetchTrigger;
    automaticGeneration: number;
  }>();
  private failedDomains = new Map<string, number>();
  private iconRules = new Map<string, string>();
  private observer?: MutationObserver;
  private scanTimer?: number;
  private renderWorkTimer?: number;
  private readonly renderWork = new FrontendRenderWorkQueue<Element>((outer, inner) => outer.contains(inner));
  private topBarElement?: HTMLElement;
  private enabledInput?: HTMLInputElement;
  private cacheCountElement?: HTMLElement;
  private failureReasons = new Map<string, string>();
  private manualRefreshKeys = new Map<string, number>();
  private automaticFetchGeneration = 0;
  private cacheGeneration = 0;
  private traceEnabled = false;
  private readonly inputListener = (event: Event) => this.scheduleInputScan(event.target);

  async onload() {
    this.addToolbar();
    const loadedDisplaySettings = await this.loadData(DISPLAY_SETTINGS_FILE);
    this.settings = mergeFrontendSettings(loadedDisplaySettings);
    await this.loadKernelState();
    await this.subscribeToKernelChanges();
    this.addSetting();
    this.rebuildRules();
    this.renderRules();
    this.startObserver();
    this.scheduleScan();
  }

  onunload() {
    this.observer?.disconnect();
    document.removeEventListener("input", this.inputListener, true);
    if (this.scanTimer !== undefined) window.clearTimeout(this.scanTimer);
    if (this.renderWorkTimer !== undefined) window.clearTimeout(this.renderWorkTimer);
    this.topBarElement?.remove();
    document.getElementById(RUNTIME_STYLE_ID)?.remove();
  }

  private t(key: string) {
    return String(this.i18n[key] ?? key);
  }

  private async callKernel<T>(method: string, ...args: unknown[]): Promise<T> {
    const call = this.kernel?.rpc.call?.[method];
    if (!call) throw new Error("Linkmark kernel cache authority is unavailable");
    return call(...args) as Promise<T>;
  }

  private async loadKernelState() {
    try {
      const [cache, policy] = await Promise.all([
        this.callKernel<Record<string, CacheEntry>>("cache.snapshot"),
        this.callKernel<Partial<Settings>>("cache.policy.get"),
      ]);
      this.cache = cache && typeof cache === "object" ? cache : {};
      this.applyCachePolicy(policy);
    } catch (error) {
      this.cache = {};
      console.warn("[siyuan-linkmark] Kernel cache authority is unavailable", error);
    }
  }

  private async subscribeToKernelChanges() {
    const bind = this.kernel?.rpc.bind;
    if (!bind) return;
    await bind("cache.changed", (params) => {
      const cache = params?.cache ?? params?.params?.cache;
      if (!cache || typeof cache !== "object") return;
      this.cache = cache as Record<string, CacheEntry>;
      for (const key of this.manualRefreshKeys.keys()) {
        if (this.cache[key]) this.manualRefreshKeys.delete(key);
      }
      this.requestRuleRebuild();
      this.scheduleScan();
    });
    await bind("cache.resolution-failed", (params) => {
      const key = params?.key ?? params?.params?.key;
      const category = params?.category ?? params?.params?.category;
      if (typeof key !== "string" || !key) return;
      // Automatic and manual failures keep the existing failure cooldown so
      // scans do not re-queue a scope that just exhausted its budget.
      this.failedDomains.set(key, Date.now());
      if (typeof category === "string") this.failureReasons.set(key, `kernel resolve · ${category}`);
      const queuedAt = this.manualRefreshKeys.get(key);
      this.manualRefreshKeys.delete(key);
      if (queuedAt !== undefined && Date.now() - queuedAt <= MANUAL_FAILURE_WINDOW) {
        const failedScope = scopeFromCacheKey(key);
        showMessage(this.t("manualRefreshFailed").replace("{domain}", failedScope.domain));
      }
    });
    await bind("cache.policy.changed", async (params) => {
      this.applyCachePolicy(params?.policy ?? params?.params?.policy);
    });
  }

  private applyCachePolicy(policy: Partial<Settings> | undefined) {
    if (!policy || typeof policy !== "object") return;
    for (const key of CACHE_POLICY_FIELDS) {
      if (policy[key] !== undefined) this.settings[key] = policy[key] as never;
    }
  }

  private async saveDisplaySettings() {
    const { enabled, iconSize } = this.settings;
    await this.saveData(DISPLAY_SETTINGS_FILE, { enabled, iconSize });
  }

  private async saveCachePolicy() {
    const policy = await this.callKernel<Partial<Settings>>("cache.policy.set", pickCachePolicy(this.settings));
    this.applyCachePolicy(policy);
  }

  private sanitizeTargetUrl(targetUrl: string, domain: string) {
    try {
      const url = new URL(targetUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}/`;
    } catch {
      // Fall through to a safe domain-only URL.
    }
    return `https://${domain}/`;
  }

  private addSetting() {
    const t = (key: string) => String(this.i18n[key] ?? key);
    const addOptions = (select: HTMLSelectElement, options: Array<[string, string]>) => {
      for (const [value, label] of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      }
    };
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "b3-switch fn__flex-center";
    enabled.checked = this.settings.enabled;
    this.enabledInput = enabled;

    const pauseAutomaticFetch = document.createElement("input");
    pauseAutomaticFetch.type = "checkbox";
    pauseAutomaticFetch.className = "b3-switch fn__flex-center";
    pauseAutomaticFetch.checked = Boolean(this.settings.pauseAutomaticFetch);

    const allowFullPageDiscovery = document.createElement("input");
    allowFullPageDiscovery.type = "checkbox";
    allowFullPageDiscovery.className = "b3-switch fn__flex-center";
    allowFullPageDiscovery.checked = this.settings.allowFullPageDiscovery;

    const provider = document.createElement("input");
    provider.className = "b3-text-field fn__block";
    provider.value = this.settings.provider;
    provider.placeholder = "https://example.com/favicon/{domain}";

    const providerPreset = document.createElement("select");
    providerPreset.className = "b3-select fn__size200";
    addOptions(providerPreset, [
      ["auto", t("providerAuto")],
      ["faviconkit", t("providerFaviconKit")],
      ["faviconim", t("providerFaviconIm")],
      ["iconhorse", t("providerIconHorse")],
      ["custom", t("providerCustom")],
    ]);
    providerPreset.value = this.settings.providerPreset;
    const updateProviderAvailability = () => {
      provider.disabled = providerPreset.value !== "custom";
    };
    providerPreset.addEventListener("change", updateProviderAvailability);
    updateProviderAvailability();

    const resolverMode = document.createElement("select");
    resolverMode.className = "b3-select fn__size200";
    addOptions(resolverMode, [
      ["mainland", t("strategyStandard")],
      ["global", t("strategyProxy")],
      ["direct", t("strategyDirect")],
    ]);
    resolverMode.value = this.settings.resolverMode;

    const fallbackMode = document.createElement("select");
    fallbackMode.className = "b3-select fn__size200";
    addOptions(fallbackMode, [
      ["monogram", t("fallbackMonogram")],
      ["none", t("fallbackNone")],
    ]);
    fallbackMode.value = this.settings.fallbackMode;

    const monogramColorMode = document.createElement("select");
    monogramColorMode.className = "b3-select fn__size200";
    addOptions(monogramColorMode, [
      ["domain", t("monogramColorDomain")],
      ["custom", t("monogramColorCustom")],
    ]);
    monogramColorMode.value = this.settings.monogramColorMode;

    const monogramShape = document.createElement("select");
    monogramShape.className = "b3-select fn__size200";
    addOptions(monogramShape, [
      ["rounded", t("monogramShapeRounded")],
      ["circle", t("monogramShapeCircle")],
      ["square", t("monogramShapeSquare")],
    ]);
    monogramShape.value = this.settings.monogramShape;

    const colorInput = (value: string, title?: string) => {
      const input = document.createElement("input");
      input.type = "color";
      input.className = "b3-text-field";
      input.style.width = "64px";
      input.style.height = "32px";
      input.value = value;
      if (title) input.title = title;
      return input;
    };
    const monogramPrimary = colorInput(this.settings.monogramPrimary);
    const monogramSecondary = colorInput(this.settings.monogramSecondary);
    const monogramText = colorInput(this.settings.monogramText);

    const draftOverrides: Record<string, MonogramOverride> = JSON.parse(JSON.stringify(this.settings.monogramOverrides));
    const overrideEditor = document.createElement("div");
    overrideEditor.style.display = "grid";
    overrideEditor.style.gap = "8px";
    overrideEditor.style.width = "min(520px, 70vw)";
    const overrideFields = document.createElement("div");
    overrideFields.className = "fn__flex";
    overrideFields.style.gap = "6px";
    overrideFields.style.flexWrap = "wrap";
    const overrideDomain = document.createElement("input");
    overrideDomain.className = "b3-text-field";
    overrideDomain.style.width = "150px";
    overrideDomain.placeholder = t("monogramDomainPlaceholder");
    overrideDomain.title = t("monogramDomainPlaceholder");
    const overrideLetter = document.createElement("input");
    overrideLetter.className = "b3-text-field";
    overrideLetter.style.width = "48px";
    overrideLetter.maxLength = 2;
    overrideLetter.placeholder = t("monogramLetterPlaceholder");
    overrideLetter.title = t("monogramLetterPlaceholder");
    const overridePrimary = colorInput(this.settings.monogramPrimary, t("monogramPrimaryTitle"));
    const overrideSecondary = colorInput(this.settings.monogramSecondary, t("monogramSecondaryTitle"));
    const overrideText = colorInput(this.settings.monogramText, t("monogramTextTitle"));
    const overrideShape = document.createElement("select");
    overrideShape.className = "b3-select";
    overrideShape.title = t("monogramShapeTitle");
    addOptions(overrideShape, [
      ["rounded", t("monogramShapeRounded")],
      ["circle", t("monogramShapeCircle")],
      ["square", t("monogramShapeSquare")],
    ]);
    const saveOverride = document.createElement("button");
    saveOverride.type = "button";
    saveOverride.className = "b3-button b3-button--outline";
    saveOverride.textContent = t("monogramOverrideSave");
    const overrideList = document.createElement("div");
    overrideList.style.display = "grid";
    overrideList.style.gap = "4px";
    const renderOverrideList = () => {
      overrideList.replaceChildren();
      for (const [domain, item] of Object.entries(draftOverrides).sort(([a], [b]) => a.localeCompare(b))) {
        const row = document.createElement("div");
        row.className = "fn__flex";
        row.style.alignItems = "center";
        row.style.gap = "6px";
        const label = document.createElement("span");
        label.className = "fn__flex-1";
        label.textContent = `${domain} · ${item.letter || domain[0]?.toUpperCase() || "?"}`;
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "b3-button b3-button--text";
        edit.textContent = t("monogramOverrideEdit");
        edit.addEventListener("click", () => {
          overrideDomain.value = domain;
          overrideLetter.value = item.letter;
          overridePrimary.value = item.primary;
          overrideSecondary.value = item.secondary;
          overrideText.value = item.text;
          overrideShape.value = item.shape;
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "b3-button b3-button--text";
        remove.textContent = t("monogramOverrideRemove");
        remove.addEventListener("click", () => {
          delete draftOverrides[domain];
          renderOverrideList();
        });
        row.append(label, edit, remove);
        overrideList.append(row);
      }
    };
    saveOverride.addEventListener("click", () => {
      const domain = normalizeDomainInput(overrideDomain.value);
      if (!domain) {
        showMessage(t("monogramDomainInvalid"));
        return;
      }
      draftOverrides[domain] = {
        letter: Array.from(overrideLetter.value.trim())[0] ?? "",
        primary: overridePrimary.value,
        secondary: overrideSecondary.value,
        text: overrideText.value,
        shape: overrideShape.value as MonogramShape,
      };
      overrideDomain.value = "";
      overrideLetter.value = "";
      renderOverrideList();
    });
    overrideFields.append(
      overrideDomain,
      overrideLetter,
      overridePrimary,
      overrideSecondary,
      overrideText,
      overrideShape,
      saveOverride,
    );
    overrideEditor.append(overrideFields, overrideList);
    renderOverrideList();

    const iconSize = document.createElement("input");
    iconSize.type = "number";
    iconSize.min = "0.7";
    iconSize.max = "1.8";
    iconSize.step = "0.1";
    iconSize.className = "b3-text-field fn__size100";
    iconSize.value = String(this.settings.iconSize);

    const cacheDays = document.createElement("input");
    cacheDays.type = "number";
    cacheDays.min = "0";
    cacheDays.max = "365";
    cacheDays.step = "1";
    cacheDays.className = "b3-text-field fn__size100";
    cacheDays.value = String(this.settings.cacheDays);

    const cacheActions = document.createElement("div");
    cacheActions.className = "fn__flex siyuan-linkmark-cache-actions";
    const cacheCount = document.createElement("span");
    cacheCount.className = "b3-label__text";
    this.cacheCountElement = cacheCount;
    this.updateCacheCount();
    const refreshCurrent = this.actionButton(t("refreshCurrent"), "b3-button b3-button--outline", () => {
      void this.refreshCurrentDocument();
    });
    const refreshAll = this.actionButton(t("refreshAll"), "b3-button b3-button--outline", () => {
      this.confirmRefreshAll();
    });
    const manage = this.actionButton(t("manageCache"), "b3-button b3-button--text", () => {
      this.openCacheManager();
    });
    cacheActions.append(cacheCount, refreshCurrent, refreshAll, manage);

    this.setting = new Setting({
      confirmCallback: async () => {
        const previousMonogramSignature = monogramSignature(this.settings);
        const wasPaused = this.settings.pauseAutomaticFetch;
        this.settings.enabled = enabled.checked;
        this.settings.pauseAutomaticFetch = pauseAutomaticFetch.checked;
        this.settings.allowFullPageDiscovery = allowFullPageDiscovery.checked;
        this.settings.provider = provider.value.trim() || defaultSettings.provider;
        this.settings.providerPreset = providerPreset.value as ProviderPreset;
        this.settings.resolverMode = resolverMode.value as ResolverMode;
        this.settings.fallbackMode = fallbackMode.value as FallbackMode;
        this.settings.monogramColorMode = monogramColorMode.value as MonogramColorMode;
        this.settings.monogramPrimary = monogramPrimary.value;
        this.settings.monogramSecondary = monogramSecondary.value;
        this.settings.monogramText = monogramText.value;
        this.settings.monogramShape = monogramShape.value as MonogramShape;
        this.settings.monogramOverrides = { ...draftOverrides };
        this.settings.iconSize = clamp(Number(iconSize.value), 0.7, 1.8, 1);
        this.settings.cacheDays = clamp(Number(cacheDays.value), 0, 365, 30);
        await this.saveDisplaySettings();
        await this.saveCachePolicy();
        if (previousMonogramSignature !== monogramSignature(this.settings)) {
          await this.invalidateGeneratedMonograms();
        }
        if (!wasPaused && this.settings.pauseAutomaticFetch) this.automaticFetchGeneration += 1;
        this.requestRuleRebuild();
        if (this.settings.enabled && !this.settings.pauseAutomaticFetch) this.scheduleScan();
      },
    });
    this.setting.addItem({
      title: t("enableTitle"),
      description: t("enableDescription"),
      createActionElement: () => enabled,
    });
    this.setting.addItem({
      title: t("pauseAutomaticFetchTitle"),
      description: t("pauseAutomaticFetchDescription"),
      createActionElement: () => pauseAutomaticFetch,
    });
    this.setting.addItem({
      title: t("allowFullPageDiscoveryTitle"),
      description: t("allowFullPageDiscoveryDescription"),
      createActionElement: () => allowFullPageDiscovery,
    });
    this.setting.addItem({
      title: t("strategyTitle"),
      description: t("strategyDescription"),
      createActionElement: () => resolverMode,
    });
    this.setting.addItem({
      title: t("providerTitle"),
      description: t("providerDescription"),
      createActionElement: () => providerPreset,
    });
    this.setting.addItem({
      title: t("customProviderTitle"),
      description: t("customProviderDescription"),
      createActionElement: () => provider,
    });
    this.setting.addItem({
      title: t("fallbackTitle"),
      description: t("fallbackDescription"),
      createActionElement: () => fallbackMode,
    });
    this.setting.addItem({
      title: t("monogramColorTitle"),
      description: t("monogramColorDescription"),
      createActionElement: () => monogramColorMode,
    });
    this.setting.addItem({
      title: t("monogramPrimaryTitle"),
      description: t("monogramPrimaryDescription"),
      createActionElement: () => monogramPrimary,
    });
    this.setting.addItem({
      title: t("monogramSecondaryTitle"),
      description: t("monogramSecondaryDescription"),
      createActionElement: () => monogramSecondary,
    });
    this.setting.addItem({
      title: t("monogramTextTitle"),
      description: t("monogramTextDescription"),
      createActionElement: () => monogramText,
    });
    this.setting.addItem({
      title: t("monogramShapeTitle"),
      description: t("monogramShapeDescription"),
      createActionElement: () => monogramShape,
    });
    this.setting.addItem({
      title: t("monogramOverridesTitle"),
      description: t("monogramOverridesDescription"),
      createActionElement: () => overrideEditor,
    });
    this.setting.addItem({
      title: t("sizeTitle"),
      description: t("sizeDescription"),
      createActionElement: () => iconSize,
    });
    this.setting.addItem({
      title: t("cacheDaysTitle"),
      description: t("cacheDaysDescription"),
      createActionElement: () => cacheDays,
    });
    this.setting.addItem({
      title: t("cacheTitle"),
      description: t("cacheDescription"),
      createActionElement: () => cacheActions,
    });
    if (import.meta.env.MODE === "development") {
      // The development-only Resolution trace switch applies immediately and
      // never participates in the settings confirmation flow. It is process
      // local, off by default, and reset whenever the kernel reloads.
      const resolutionTrace = document.createElement("input");
      resolutionTrace.type = "checkbox";
      resolutionTrace.className = "b3-switch fn__flex-center";
      resolutionTrace.checked = this.traceEnabled;
      resolutionTrace.addEventListener("change", () => {
        this.traceEnabled = resolutionTrace.checked;
        void this.callKernel<{ enabled: boolean }>("cache.trace.set", this.traceEnabled).then((state) => {
          this.traceEnabled = state?.enabled ?? false;
          resolutionTrace.checked = this.traceEnabled;
        }).catch(() => {
          this.traceEnabled = false;
          resolutionTrace.checked = false;
        });
      });
      this.setting.addItem({
        title: t("traceTitle"),
        description: t("traceDescription"),
        createActionElement: () => resolutionTrace,
      });
    }
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
        .replace("{count}", String(Object.keys(this.cache).length))}${
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

  private actionButton(label: string, className: string, callback: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }

  private updateCacheCount() {
    if (this.cacheCountElement) {
      this.cacheCountElement.textContent = this.t("cacheCount").replace("{count}", String(Object.keys(this.cache).length));
    }
  }

  private async setEnabled(enabled: boolean) {
    this.settings.enabled = enabled;
    if (this.enabledInput) this.enabledInput.checked = enabled;
    await this.saveDisplaySettings();
    this.requestRuleRebuild();
    if (enabled && !this.settings.pauseAutomaticFetch) this.scheduleScan();
    showMessage(this.t(enabled ? "pluginEnabled" : "pluginDisabled"));
  }

  private confirmRefreshAll() {
    confirm(this.t("refreshAll"), this.t("refreshAllConfirm"), (dialog) => {
      dialog.destroy();
      void this.refreshAllCachedDomains();
    });
  }

  private confirmClearAll(afterClear?: () => void) {
    confirm(this.t("clearCache"), this.t("clearCacheConfirm"), (dialog) => {
      dialog.destroy();
      void this.clearCache().then(() => {
        showMessage(this.t("cacheCleared"));
        afterClear?.();
      });
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
    const elements = [
      ...(root?.matches(LINK_SELECTOR) ? [root as HTMLElement] : []),
      ...(root ?? document).querySelectorAll<HTMLElement>(LINK_SELECTOR),
    ];
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

  private scheduleScanForNode(target: EventTarget | null) {
    const root = this.localScanRootFor(target);
    if (root) this.scheduleScan(root);
  }

  private scheduleAddedNodeScan(node: Node) {
    const root = addedLinkDiscoveryRegionFor(this.elementForNode(node), LOCAL_DISCOVERY_SELECTORS);
    if (root) this.scheduleScan(root);
  }

  private scheduleInputScan(target: EventTarget | null) {
    const targetElement = this.elementForNode(target);
    const selectedElement = this.elementForNode(document.getSelection()?.anchorNode ?? null);
    const source = selectedElement && targetElement?.contains(selectedElement) ? selectedElement : targetElement;
    const root = this.localScanRootFor(source);
    if (root) this.scheduleScan(root);
  }

  private localScanRootFor(node: EventTarget | null) {
    return localDiscoveryRegionFor(this.elementForNode(node), LOCAL_DISCOVERY_SELECTORS);
  }

  private elementForNode(node: EventTarget | null) {
    if (node instanceof Element) return node;
    return node instanceof Node ? node.parentElement : null;
  }

  private async refreshCurrentDocument() {
    const domains = this.collectDocumentDomains(this.currentDocumentRoot());
    if (domains.size === 0) {
      showMessage(this.t("noCurrentDomains"));
      return;
    }
    const targets = new Map([...domains].map(([key, item]) => [key, { scope: item.scope, targetUrl: item.targetUrl }]));
    showMessage(this.t("refreshStarted").replace("{count}", String(targets.size)));
    this.showRefreshResult(await this.refreshDomains(targets));
  }

  private async refreshAllCachedDomains() {
    const targets = new Map(Object.entries(this.cache)
      .filter(([, entry]) => !entry.pinned)
      .map(([key, entry]) => {
        const scope = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
        const targetUrl = entry.targetUrl ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
        return [key, { scope, targetUrl }] as const;
      }));
    if (targets.size === 0) {
      showMessage(this.t(Object.keys(this.cache).length === 0 ? "cacheEmpty" : "noRefreshableDomains"));
      return;
    }
    showMessage(this.t("refreshStarted").replace("{count}", String(targets.size)));
    this.showRefreshResult(await this.refreshDomains(targets));
  }

  private async refreshDomains(
    targets: Map<string, { scope: LinkScope; targetUrl: string }>,
    onProgress?: (completed: number, total: number) => void,
  ) {
    const items = [...targets];
    let completed = 0;
    let queued = 0;
    let skipped = 0;
    let failed = 0;
    const failures: string[] = [];
    await Promise.all(items.map(async ([key, { scope, targetUrl }]) => {
      if (cachedIconForScope(this.cache, scope)?.entry.pinned) skipped += 1;
      else {
        const outcome = await this.fetchAndCache(scope, targetUrl, true, "manual");
        if (outcome === "queued" || outcome === "success" || outcome === "fallback") queued += 1;
        else {
          failed += 1;
          const reason = this.failureReasons.get(key);
          if (reason && failures.length < 3) failures.push(reason);
        }
      }
      completed += 1;
      onProgress?.(completed, items.length);
    }));
    return { queued, failed, skipped, failures };
  }

  private showRefreshResult(result: { queued: number; failed: number; skipped: number; failures?: string[] }) {
    const summary = this.t("refreshFinished")
      .replace("{queued}", String(result.queued))
      .replace("{failed}", String(result.failed))
      .replace("{skipped}", String(result.skipped));
    const details = result.failures?.length ? `\n${result.failures.join("\n")}` : "";
    showMessage(`${summary}${details}`);
  }

  private async removeCachedDomain(key: string) {
    await this.callKernel("cache.remove", key);
    this.cache = await this.callKernel<Record<string, CacheEntry>>("cache.snapshot");
    this.failedDomains.delete(key);
    this.manualRefreshKeys.delete(key);
    this.requestRuleRebuild();
    this.updateCacheCount();
    if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
  }

  private openCacheManager() {
    const dialog = new Dialog({
      title: this.t("manageCache"),
      content: '<div class="siyuan-linkmark-cache-manager"></div>',
      width: "min(760px, 92vw)",
      height: "min(640px, 82vh)",
    });
    const root = dialog.element.querySelector<HTMLElement>(".siyuan-linkmark-cache-manager");
    if (!root) return;

    const render = () => {
      root.replaceChildren();
      const summary = document.createElement("div");
      summary.className = "siyuan-linkmark-cache-summary";
      const count = document.createElement("strong");
      count.textContent = this.t("cacheCount").replace("{count}", String(Object.keys(this.cache).length));
      const path = document.createElement("code");
      path.textContent = "plugin private icon storage";
      summary.append(count, path);

      const actions = document.createElement("div");
      actions.className = "fn__flex siyuan-linkmark-cache-actions";
      actions.append(
        this.actionButton(this.t("refreshCurrent"), "b3-button b3-button--outline", () => {
          void this.refreshCurrentDocument().then(render);
        }),
        this.actionButton(this.t("refreshAll"), "b3-button b3-button--outline", () => {
          confirm(this.t("refreshAll"), this.t("refreshAllConfirm"), (confirmDialog) => {
            confirmDialog.destroy();
            void this.refreshAllCachedDomains().then(render);
          });
        }),
        this.actionButton(this.t("clearCache"), "b3-button b3-button--remove", () => this.confirmClearAll(render)),
      );

      const search = document.createElement("input");
      search.className = "b3-text-field fn__block";
      search.placeholder = this.t("cacheSearch");
      const list = document.createElement("div");
      list.className = "siyuan-linkmark-cache-list";
      const renderList = () => {
        list.replaceChildren();
        const query = search.value.trim().toLowerCase();
        const entries = Object.entries(this.cache)
          .filter(([key, entry]) => !query || key.includes(query) || entry.domain?.includes(query))
          .sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) {
          const empty = document.createElement("div");
          empty.className = "b3-label__text siyuan-linkmark-cache-empty";
          empty.textContent = this.t(Object.keys(this.cache).length === 0 ? "cacheEmpty" : "cacheNoMatches");
          list.append(empty);
          return;
        }
        let previousDomain = "";
        for (const [key, entry] of entries) {
          const scope = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
          if (scope.domain !== previousDomain) {
            const heading = document.createElement("strong");
            heading.className = "siyuan-linkmark-cache-domain-heading";
            heading.textContent = scope.domain;
            list.append(heading);
            previousDomain = scope.domain;
          }
          const row = document.createElement("div");
          row.className = "siyuan-linkmark-cache-row";
          const info = document.createElement("div");
          info.className = "siyuan-linkmark-cache-info";
          const name = document.createElement("strong");
          name.textContent = scope.routeKey
            ? this.t("cacheRouteName").replace("{type}", this.scopeTypeLabel(scope))
            : this.t("cacheDomainDefault");
          const meta = document.createElement("span");
          const source = this.cacheSourceLabel(entry.source);
          const status = entry.pinned
            ? this.t(entry.includeSubdomains ? "cachePinnedSubdomains" : "cachePinned")
            : isCacheEntryFresh(entry, this.settings.cacheDays) ? this.t("cacheFresh") : this.t("cacheExpired");
          meta.textContent = `${source} · ${new Date(entry.fetchedAt).toLocaleString()} · ${status}`;
          info.append(name, meta);
          const rowActions = document.createElement("div");
          rowActions.className = "fn__flex siyuan-linkmark-cache-row-actions";
          rowActions.append(this.actionButton(this.t("chooseIcon"), "b3-button b3-button--text", () => {
            const current = this.collectDocumentDomains(this.currentDocumentRoot()).get(scope.key);
            this.openIconPicker(scope, current?.targetUrl ?? entry.targetUrl ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`, render);
          }));
          if (entry.pinned) {
            rowActions.append(this.actionButton(this.t("restoreAutomatic"), "b3-button b3-button--text", () => {
              void this.restoreAutomaticIcon(key).then(render);
            }));
          } else {
            rowActions.append(
              this.actionButton(this.t("refreshOne"), "b3-button b3-button--text", () => {
              const current = this.collectDocumentDomains(this.currentDocumentRoot()).get(scope.key);
              const targetUrl = current?.targetUrl ?? entry.targetUrl ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
              void this.refreshDomains(new Map([[scope.key, { scope, targetUrl }]])).then((result) => {
                this.showRefreshResult(result);
                render();
              });
              }),
              this.actionButton(this.t("deleteOne"), "b3-button b3-button--text", () => {
                void this.removeCachedDomain(key).then(render);
              }),
            );
          }
          row.append(info, rowActions);
          list.append(row);
        }
      };
      search.addEventListener("input", renderList);
      renderList();
      root.append(summary, actions, search, list);
    };
    render();
  }

  private cacheSourceLabel(source?: string) {
    if (!source) return this.t("cacheUnknownSource");
    if (source === "generated monogram") return this.t("cacheGenerated");
    if (source === "custom upload") return this.t("customUploadSource");
    if (source === "custom URL") return this.t("customUrlSource");
    if (source.startsWith("selected candidate:")) {
      return `${this.t("selectedCandidateSource")} · ${this.resolverSourceLabel(source.slice("selected candidate:".length))}`;
    }
    return this.resolverSourceLabel(source);
  }

  private resolverSourceLabel(source: string) {
    const parent = source.match(/^parent domain ([^·]+) · (.+)$/);
    if (parent) return `${this.t("parentDomainSource").replace("{domain}", parent[1].trim())} · ${parent[2]}`;
    const platform = source.match(/^platform type ([^:]+):(.+)$/);
    if (platform) return this.t("platformTypeSource").replace("{type}", this.scopeTypeLabel({ routeKey: platform[2] }));
    return source;
  }

  private scopeTypeLabel(scope: Pick<LinkScope, "routeKey">) {
    const key = `scopeType_${scope.routeKey ?? "domain"}`;
    const translated = this.t(key);
    return translated === key ? (scope.routeKey ?? this.t("cacheDomainDefault")) : translated;
  }

  private async pinScopedIcon(
    scope: LinkScope,
    selectedScope: LinkScope,
    targetUrl: string,
    blob: Blob,
    source: string,
    includeSubdomains = false,
  ) {
    if (!await isDecodableImage(blob)) {
      showMessage(this.t("customIconInvalid"));
      return false;
    }
    const pending = this.pendingFetches.get(selectedScope.key);
    if (pending) await pending.promise;
    try {
      const selected = await this.callKernel<CacheEntry>("cache.pin", {
        key: scope.key,
        domain: scope.domain,
        targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
        routeKey: scope.routeKey,
        pathPrefix: scope.pathPrefix,
      }, {
        url: "",
        fetchedAt: Date.now(),
        resolverVersion: RESOLVER_VERSION,
        source,
        targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
        domain: scope.domain,
        routeKey: scope.routeKey,
        pathPrefix: scope.pathPrefix,
        pinned: true,
        includeSubdomains,
      }, blob.type || "image/png", await blobToBase64(blob), selectedScope.key);
      this.cache[scope.key] = selected;
      if (selectedScope.key !== scope.key) delete this.cache[selectedScope.key];
      this.failedDomains.delete(scope.key);
      this.failedDomains.delete(selectedScope.key);
      this.manualRefreshKeys.delete(scope.key);
      this.manualRefreshKeys.delete(selectedScope.key);
      this.requestRuleRebuild();
      if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
      this.updateCacheCount();
      showMessage(this.t("customIconSaved").replace("{domain}", scope.domain));
      return true;
    } catch (error) {
      console.warn(`[siyuan-linkmark] Unable to save custom icon for ${scope.key}`, error);
      showMessage(this.t("customIconSaveFailed"));
      return false;
    }
  }

  private async restoreAutomaticIcon(key: string) {
    const entry = this.cache[key];
    if (!entry?.pinned) return;
    await this.callKernel("cache.remove", key);
    this.cache = await this.callKernel<Record<string, CacheEntry>>("cache.snapshot");
    this.failedDomains.delete(key);
    this.manualRefreshKeys.delete(key);
    this.requestRuleRebuild();
    this.updateCacheCount();
    if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
    showMessage(this.t("automaticRestored").replace("{domain}", entry.domain ?? key.split("::")[0]));
  }

  private openIconPicker(selectedScope: LinkScope, targetUrl: string, afterChange: () => void) {
    const domain = selectedScope.domain;
    const objectUrls: string[] = [];
    const dialog = new Dialog({
      title: this.t("chooseIconFor").replace("{domain}", domain),
      content: '<div class="siyuan-linkmark-picker"></div>',
      width: "min(720px, 92vw)",
      height: "min(620px, 82vh)",
      destroyCallback: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)),
    });
    const root = dialog.element.querySelector<HTMLElement>(".siyuan-linkmark-picker");
    if (!root) return;

    const sharedDomain = shareDomainFor(domain);

    const controls = document.createElement("div");
    controls.className = "siyuan-linkmark-picker-controls";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico";
    fileInput.className = "b3-text-field";
    fileInput.title = this.t("uploadCustomIcon");
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "b3-text-field fn__flex-1";
    urlInput.placeholder = this.t("customIconUrlPlaceholder");
    const urlButton = this.actionButton(this.t("useCustomUrl"), "b3-button b3-button--outline", () => {
      void useUrl();
    });
    controls.append(fileInput, urlInput, urlButton);
    if (this.cache[selectedScope.key]?.pinned) {
      controls.append(this.actionButton(this.t("restoreAutomatic"), "b3-button b3-button--text", () => {
        void this.restoreAutomaticIcon(selectedScope.key).then(() => {
          dialog.destroy();
          afterChange();
        });
      }));
    }

    const scopeSelect = document.createElement("select");
    scopeSelect.className = "b3-select";
    if (selectedScope.routeKey) {
      scopeSelect.add(new Option(this.t("pinCurrentType").replace("{type}", this.scopeTypeLabel(selectedScope)), "type"));
    }
    scopeSelect.add(new Option(this.t("pinCurrentDomain").replace("{domain}", domain), "domain"));
    if (sharedDomain && sharedDomain !== domain) {
      scopeSelect.add(new Option(this.t("applyToSubdomains").replace("{domain}", sharedDomain), "subdomains"));
    }
    const shareRow = document.createElement("label");
    shareRow.className = "siyuan-linkmark-picker-scope";
    const shareText = document.createElement("span");
    shareText.textContent = this.t("pinScopeTitle");
    shareRow.append(shareText, scopeSelect);

    const status = document.createElement("div");
    status.className = "b3-label__text siyuan-linkmark-picker-status";
    status.textContent = this.t("loadingCandidates");
    const hint = document.createElement("div");
    hint.className = "b3-label__text siyuan-linkmark-picker-hint";
    hint.textContent = this.t("candidateHint");
    const grid = document.createElement("div");
    grid.className = "siyuan-linkmark-candidate-grid";
    const loadPageCandidates = this.actionButton(
      this.t("loadPageCandidates"),
      "b3-button b3-button--outline",
      () => void loadCandidates(true),
    );
    root.append(controls);
    root.append(shareRow);
    if (!this.settings.allowFullPageDiscovery && !selectedScope.discoverPage) root.append(loadPageCandidates);
    root.append(hint, status, grid);

    let saving = false;
    const targetScopeForSelection = () => {
      const selection = scopeSelect.value;
      return selection === "type"
        ? selectedScope
        : selection === "subdomains" && sharedDomain
          ? { key: sharedDomain, domain: sharedDomain }
          : { key: domain, domain };
    };
    const saveAndClose = async (blob: Blob, source: string) => {
      if (saving) return;
      saving = true;
      const targetScope = targetScopeForSelection();
      const includeSubdomains = scopeSelect.value === "subdomains";
      if (!await this.pinScopedIcon(targetScope, selectedScope, targetUrl, blob, source, includeSubdomains)) {
        saving = false;
        return;
      }
      dialog.destroy();
      afterChange();
    };

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void saveAndClose(file, "custom upload");
    });

    const useUrl = async () => {
      const value = urlInput.value.trim();
      if (!value) return;
      urlButton.setAttribute("disabled", "true");
      status.textContent = this.t("loadingCustomUrl");
      try {
        const targetScope = targetScopeForSelection();
        const selected = await this.callKernel<CacheEntry>("cache.pin-url", {
          ...targetScope,
          targetUrl: this.sanitizeTargetUrl(targetUrl, targetScope.domain),
        }, value, scopeSelect.value === "subdomains", selectedScope.key);
        if (!root.isConnected) return;
        this.cache[targetScope.key] = selected;
        if (targetScope.key !== selectedScope.key) delete this.cache[selectedScope.key];
        this.requestRuleRebuild();
        dialog.destroy();
        afterChange();
      } catch {
        status.textContent = this.t("customIconInvalid");
      } finally {
        urlButton.removeAttribute("disabled");
      }
    };

    const loadCandidates = async (allowFullPageDiscovery: boolean) => {
      loadPageCandidates.setAttribute("disabled", "true");
      status.textContent = this.t("loadingCandidates");
      grid.replaceChildren();
      try {
        const discoverPage = allowFullPageDiscovery || Boolean(selectedScope.discoverPage);
        const candidates = await this.callKernel<Array<{ base64: string; contentType: string; source: string }>>("cache.candidates", {
          ...selectedScope,
          targetUrl: this.sanitizeTargetUrl(targetUrl, selectedScope.domain),
        }, discoverPage);
        if (!root.isConnected) return;
        if (!urlButton.hasAttribute("disabled")) {
          status.textContent = candidates.length === 0 ? this.t("noCandidates") : this.t("candidateCount").replace("{count}", String(candidates.length));
        }
        for (const candidate of candidates) {
          const blob = base64ToBlob(candidate.base64, candidate.contentType);
          const card = document.createElement("button");
          card.type = "button";
          card.className = "siyuan-linkmark-candidate-card";
          const preview = document.createElement("img");
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.push(objectUrl);
          preview.src = objectUrl;
          preview.alt = candidate.source;
          const label = document.createElement("span");
          label.className = "siyuan-linkmark-candidate-source";
          label.textContent = this.resolverSourceLabel(candidate.source);
          const details = document.createElement("small");
          details.className = "siyuan-linkmark-candidate-details";
          const format = iconFormat(blob, this.t("unknownIconFormat"));
          const size = formatFileSize(blob.size);
          details.textContent = format === "SVG"
            ? `${format} · ${this.t("vectorIcon")} · ${size}`
            : `${format} · ${size}`;
          preview.addEventListener("load", () => {
            if (format !== "SVG" && preview.naturalWidth > 0 && preview.naturalHeight > 0) {
              details.textContent = `${preview.naturalWidth}×${preview.naturalHeight} · ${format} · ${size}`;
            }
          }, { once: true });
          card.append(preview, label, details);
          card.addEventListener("click", () => {
            void saveAndClose(blob, `selected candidate:${candidate.source}`);
          });
          grid.append(card);
        }
      } catch (error) {
        console.warn(`[siyuan-linkmark] Unable to discover candidates for ${selectedScope.key}`, error);
        if (root.isConnected && !urlButton.hasAttribute("disabled")) status.textContent = this.t("candidateLoadFailed");
      } finally {
        loadPageCandidates.removeAttribute("disabled");
      }
    };
    void loadCandidates(this.settings.allowFullPageDiscovery || Boolean(selectedScope.discoverPage));
  }

  private async invalidateGeneratedMonograms() {
    await this.callKernel("cache.clear-generated");
    this.cache = await this.callKernel<Record<string, CacheEntry>>("cache.snapshot");
    this.failedDomains.clear();
    this.manualRefreshKeys.clear();
    this.requestRuleRebuild();
    this.updateCacheCount();
  }

  private async clearCache() {
    this.cacheGeneration += 1;
    await this.callKernel("cache.clear");
    this.cache = await this.callKernel<Record<string, CacheEntry>>("cache.snapshot");
    this.failedDomains.clear();
    this.manualRefreshKeys.clear();
    this.requestRuleRebuild();
    if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
  }

  private startObserver() {
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        this.scheduleScanForNode(record.target);
        if (record.type === "childList") {
          for (const node of record.addedNodes) this.scheduleAddedNodeScan(node);
        }
      }
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-href", "href", "data-type"],
    });
    document.addEventListener("input", this.inputListener, true);
  }

  private scheduleScan(root?: Element | null) {
    if (root) this.renderWork.requestLocalDiscovery(root);
    else this.renderWork.requestFullDiscovery();
    if (this.scanTimer !== undefined) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = undefined;
      this.renderWork.flushDiscovery();
      this.scheduleRenderWork();
    }, 250);
  }

  private requestRuleRebuild() {
    this.renderWork.requestRuleRebuild();
    this.scheduleRenderWork();
  }

  private requestRulePublication() {
    this.renderWork.requestRulePublication();
    this.scheduleRenderWork();
  }

  private scheduleRenderWork() {
    if (this.renderWorkTimer !== undefined) return;
    // Let concurrent cache updates settle before replacing the complete stylesheet.
    this.renderWorkTimer = window.setTimeout(() => this.flushRenderWork(), RULE_RENDER_BATCH_DELAY);
  }

  private flushRenderWork() {
    this.renderWorkTimer = undefined;
    flushFrontendRenderWork(this.renderWork, {
      rebuildRules: () => this.rebuildRules(),
      discover: (discovery) => {
        if (discovery.kind === "full") return this.scanLinks();
        let rulesChanged = false;
        for (const root of discovery.regions) rulesChanged = this.scanLinks(root) || rulesChanged;
        return rulesChanged;
      },
      publishRules: () => this.renderRules(),
    });
  }

  private scanLinks(root?: Element | null) {
    if (!this.settings.enabled) return false;
    const domains = this.collectDocumentDomains(root);

    let rulesChanged = false;
    domains.forEach(({ scope, targetUrl }, key) => {
      const decision = planScanDecision({
        scopeKey: key,
        scope,
        cache: this.cache,
        pauseAutomaticFetch: Boolean(this.settings.pauseAutomaticFetch),
        cacheDays: this.settings.cacheDays,
        failedAt: this.failedDomains.get(key),
      });
      if (decision.action === "expire") {
        void this.expireCachedDomain(decision.cacheKey, decision.entry);
        return;
      }
      if (decision.action === "keep") {
        const rule = createIconRule(scope, decision.entry.url, this.settings.iconSize);
        if (this.iconRules.get(key) !== rule) {
          this.iconRules.set(key, rule);
          rulesChanged = true;
        }
        if (decision.fetch) void this.fetchAndCache(scope, targetUrl);
        return;
      }
      if (decision.action === "fetch") void this.fetchAndCache(scope, targetUrl);
    });
    return rulesChanged;
  }

  private fetchAndCache(
    scope: LinkScope,
    targetUrl: string,
    preserveExisting = false,
    trigger: FetchTrigger = "automatic",
  ): Promise<FetchOutcome> {
    if (trigger === "automatic" && this.settings.pauseAutomaticFetch) return Promise.resolve("failure");
    const pending = this.pendingFetches.get(scope.key);
    if (pending) {
      const supersedesInvalidatedAutomatic = pending.trigger === "automatic"
        && pending.automaticGeneration !== this.automaticFetchGeneration;
      return (trigger === "manual" && pending.trigger === "automatic") || supersedesInvalidatedAutomatic
        ? pending.promise.then(() => this.fetchAndCache(scope, targetUrl, preserveExisting, trigger))
        : pending.promise;
    }
    const request = this.runFetchAndCache(
      scope,
      targetUrl,
      preserveExisting,
      trigger,
      this.automaticFetchGeneration,
      this.cacheGeneration,
    );
    this.pendingFetches.set(scope.key, {
      promise: request,
      trigger,
      automaticGeneration: this.automaticFetchGeneration,
    });
    void request.finally(() => {
      if (this.pendingFetches.get(scope.key)?.promise === request) this.pendingFetches.delete(scope.key);
    });
    return request;
  }

  private async runFetchAndCache(
    scope: LinkScope,
    targetUrl: string,
    preserveExisting: boolean,
    trigger: FetchTrigger,
    automaticGeneration: number,
    cacheGeneration: number,
  ) {
    const invalidated = () => cacheGeneration !== this.cacheGeneration
      || (trigger === "automatic" && (
        automaticGeneration !== this.automaticFetchGeneration
        || this.settings.pauseAutomaticFetch
      ));
    this.pendingDomains.add(scope.key);
    try {
      const result = await this.callKernel<CacheRequestResult>("cache.get-or-queue", {
        ...scope,
        targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
      }, preserveExisting, trigger === "automatic");
      if (invalidated()) return "failure";
      if (result.status === "ready") {
        const entry = result.entry;
        this.cache[scope.key] = entry;
        this.updateCacheCount();
        this.failedDomains.delete(scope.key);
        this.failureReasons.delete(scope.key);
        this.manualRefreshKeys.delete(scope.key);
        if (this.setRule(scope, entry.url)) this.requestRulePublication();
        return fetchOutcomeFor(entry);
      }
      if (result.status === "queued") {
        // Resolution continues in the kernel; a committed entry arrives
        // through the cache.changed broadcast and a failure through the
        // cache.resolution-failed broadcast. Keep the scope out of the
        // failed-domain cooldown and do not create a placeholder icon.
        if (trigger === "manual") this.manualRefreshKeys.set(scope.key, Date.now());
        return "queued";
      }
      // The Cache authority declined the request, for example while the
      // kernel plugin is still loading. Fail open without treating the
      // outcome as an icon failure.
      this.manualRefreshKeys.delete(scope.key);
      return "unavailable";
    } catch (error) {
      this.updateCacheCount();
      this.manualRefreshKeys.delete(scope.key);
      if (invalidated()) return "failure";
      console.warn(`[siyuan-linkmark] Unable to cache ${scope.key}`, error);
      this.failureReasons.set(scope.key, `${scope.key} · kernel resolve · ${errorText(error)}`);
      this.failedDomains.set(scope.key, Date.now());
      // Do not create a pseudo-element when no verified image exists, which
      // prevents an empty gap beside the link.
      return "failure";
    } finally {
      this.pendingDomains.delete(scope.key);
    }
  }

  private async expireCachedDomain(key: string, expected: CacheEntry) {
    if (this.settings.pauseAutomaticFetch) return;
    if (this.pendingDomains.has(key)) return;
    this.pendingDomains.add(key);
    try {
      if (this.cache[key] !== expected) return;
      await this.callKernel("cache.remove", key);
      this.cache = await this.callKernel<Record<string, CacheEntry>>("cache.snapshot");
      this.requestRuleRebuild();
      this.updateCacheCount();
    } finally {
      this.pendingDomains.delete(key);
      if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
    }
  }

  private rebuildRules() {
    this.iconRules.clear();
    if (this.settings.enabled) {
      const entries = Object.entries(this.cache).sort(([a], [b]) => Number(a.includes("::")) - Number(b.includes("::")));
      for (const [key, entry] of entries) {
        if (entry.routeKey && this.cache[entry.domain ?? key.split("::")[0]]?.pinned) {
          continue;
        }
        const pausedLegacyMonogram = this.settings.pauseAutomaticFetch
          && entry.source === "generated monogram"
          && entry.resolverVersion !== RESOLVER_VERSION;
        const current = entry.pinned || entry.resolverVersion === RESOLVER_VERSION || pausedLegacyMonogram;
        const fresh = this.settings.pauseAutomaticFetch || isCacheEntryFresh(entry, this.settings.cacheDays);
        if (current && fresh) {
          const scope = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
          this.iconRules.set(key, createIconRule(scope, entry.url, this.settings.iconSize));
        }
      }
    }
    this.updateCacheCount();
  }

  private setRule(scope: LinkScope, url: string) {
    if (!this.settings.enabled) return false;
    const rule = createIconRule(scope, url, this.settings.iconSize);
    if (this.iconRules.get(scope.key) === rule) return false;
    this.iconRules.set(scope.key, rule);
    return true;
  }

  private renderRules() {
    let style = document.getElementById(RUNTIME_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = RUNTIME_STYLE_ID;
      document.head.appendChild(style);
    }
    // Domain selectors intentionally come first. Route selectors are more
    // specific semantically but use the same CSS specificity, so they must be
    // rendered later to let /doc/ and /sheet/ coexist predictably.
    style.textContent = [...this.iconRules.entries()]
      .sort(([left], [right]) => Number(left.includes("::")) - Number(right.includes("::")))
      .map(([, rule]) => rule)
      .join("\n");
  }

}
