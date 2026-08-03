import { Setting, showMessage } from "siyuan";
import { actionButton } from "./frontend-dom";
import { normalizeDomainInput } from "./frontend-format";
import { clamp, defaultSettings, monogramSignature, type Settings } from "./frontend-settings";
import type {
  FallbackMode,
  MonogramColorMode,
  MonogramOverride,
  MonogramShape,
  ProviderPreset,
  ResolverMode,
} from "./resolver-contract";

export type SettingsSavedContext = {
  wasEnabled: boolean;
  wasPaused: boolean | undefined;
  previousIconSize: number;
  previousCacheDays: number;
  previousMonogramSignature: string;
};

export type SettingsPanelCallbacks = {
  saveDisplay: () => Promise<void>;
  savePolicy: () => Promise<void>;
  onSaved: (context: SettingsSavedContext) => void | Promise<void>;
  refreshCurrent: () => void;
  refreshAll: () => void;
  openCacheManager: () => void;
};

export type SettingsPanelOptions = {
  t: (key: string) => string;
  settings: Settings;
  callbacks: SettingsPanelCallbacks;
};

export class SettingsPanel {
  readonly setting: Setting;
  private readonly t: (key: string) => string;
  private readonly settings: Settings;
  private readonly callbacks: SettingsPanelCallbacks;
  private enabledInput?: HTMLInputElement;
  private cacheCountElement?: HTMLElement;

  constructor(options: SettingsPanelOptions) {
    this.t = options.t;
    this.settings = options.settings;
    this.callbacks = options.callbacks;
    this.setting = this.buildSetting();
  }

  setEnabled(checked: boolean) {
    if (this.enabledInput) this.enabledInput.checked = checked;
  }

  updateCacheCount(count: number) {
    if (this.cacheCountElement) {
      this.cacheCountElement.textContent = this.t("cacheCount").replace("{count}", String(count));
    }
  }

  private buildSetting() {
    const t = this.t;
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
    const refreshCurrent = actionButton(t("refreshCurrent"), "b3-button b3-button--outline", () => {
      this.callbacks.refreshCurrent();
    });
    const refreshAll = actionButton(t("refreshAll"), "b3-button b3-button--outline", () => {
      this.callbacks.refreshAll();
    });
    const manage = actionButton(t("manageCache"), "b3-button b3-button--text", () => {
      this.callbacks.openCacheManager();
    });
    cacheActions.append(cacheCount, refreshCurrent, refreshAll, manage);

    const setting = new Setting({
      confirmCallback: async () => {
        const previousMonogramSignature = monogramSignature(this.settings);
        const wasEnabled = this.settings.enabled;
        const wasPaused = this.settings.pauseAutomaticFetch;
        const previousIconSize = this.settings.iconSize;
        const previousCacheDays = this.settings.cacheDays;
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
        await this.callbacks.saveDisplay();
        await this.callbacks.savePolicy();
        await this.callbacks.onSaved({
          wasEnabled,
          wasPaused,
          previousIconSize,
          previousCacheDays,
          previousMonogramSignature,
        });
      },
    });
    setting.addItem({
      title: t("enableTitle"),
      description: t("enableDescription"),
      createActionElement: () => enabled,
    });
    setting.addItem({
      title: t("pauseAutomaticFetchTitle"),
      description: t("pauseAutomaticFetchDescription"),
      createActionElement: () => pauseAutomaticFetch,
    });
    setting.addItem({
      title: t("allowFullPageDiscoveryTitle"),
      description: t("allowFullPageDiscoveryDescription"),
      createActionElement: () => allowFullPageDiscovery,
    });
    setting.addItem({
      title: t("strategyTitle"),
      description: t("strategyDescription"),
      createActionElement: () => resolverMode,
    });
    setting.addItem({
      title: t("providerTitle"),
      description: t("providerDescription"),
      createActionElement: () => providerPreset,
    });
    setting.addItem({
      title: t("customProviderTitle"),
      description: t("customProviderDescription"),
      createActionElement: () => provider,
    });
    setting.addItem({
      title: t("fallbackTitle"),
      description: t("fallbackDescription"),
      createActionElement: () => fallbackMode,
    });
    setting.addItem({
      title: t("monogramColorTitle"),
      description: t("monogramColorDescription"),
      createActionElement: () => monogramColorMode,
    });
    setting.addItem({
      title: t("monogramPrimaryTitle"),
      description: t("monogramPrimaryDescription"),
      createActionElement: () => monogramPrimary,
    });
    setting.addItem({
      title: t("monogramSecondaryTitle"),
      description: t("monogramSecondaryDescription"),
      createActionElement: () => monogramSecondary,
    });
    setting.addItem({
      title: t("monogramTextTitle"),
      description: t("monogramTextDescription"),
      createActionElement: () => monogramText,
    });
    setting.addItem({
      title: t("monogramShapeTitle"),
      description: t("monogramShapeDescription"),
      createActionElement: () => monogramShape,
    });
    setting.addItem({
      title: t("monogramOverridesTitle"),
      description: t("monogramOverridesDescription"),
      createActionElement: () => overrideEditor,
    });
    setting.addItem({
      title: t("sizeTitle"),
      description: t("sizeDescription"),
      createActionElement: () => iconSize,
    });
    setting.addItem({
      title: t("cacheDaysTitle"),
      description: t("cacheDaysDescription"),
      createActionElement: () => cacheDays,
    });
    setting.addItem({
      title: t("cacheTitle"),
      description: t("cacheDescription"),
      createActionElement: () => cacheActions,
    });
    return setting;
  }
}
