import { Dialog, showMessage } from "siyuan";
import type { FrontendCacheClient } from "./frontend-cache-client";
import type { CacheEntry } from "./frontend-cache-state";
import { actionButton } from "./frontend-dom";
import { base64ToBlob, blobToBase64, formatFileSize, iconFormat } from "./frontend-format";
import { resolverSourceLabel, scopeTypeLabel, type Translator } from "./frontend-labels";
import { isDecodableImage } from "./image-decode";
import { pickerScopeChoices } from "./parent-domain";
import { RESOLVER_VERSION } from "./resolver-contract";
import type { Settings } from "./frontend-settings";
import type { LinkScope } from "./url-scope";

export type IconPickerDialogActions = {
  restoreAutomaticIcon: (key: string) => Promise<void>;
  scheduleScan: () => void;
};

export type IconPickerDialogOptions = {
  t: Translator;
  client: FrontendCacheClient;
  settings: Settings;
  selectedScope: LinkScope;
  targetUrl: string;
  afterChange: () => void;
  actions: IconPickerDialogActions;
};

export class IconPickerDialog {
  private readonly t: Translator;
  private readonly client: FrontendCacheClient;
  private readonly settings: Settings;
  private readonly selectedScope: LinkScope;
  private readonly targetUrl: string;
  private readonly afterChange: () => void;
  private readonly actions: IconPickerDialogActions;

  constructor(options: IconPickerDialogOptions) {
    this.t = options.t;
    this.client = options.client;
    this.settings = options.settings;
    this.selectedScope = options.selectedScope;
    this.targetUrl = options.targetUrl;
    this.afterChange = options.afterChange;
    this.actions = options.actions;
    this.open();
  }

  private open() {
    const { t, selectedScope, targetUrl } = this;
    const domain = selectedScope.domain;
    const objectUrls: string[] = [];
    const dialog = new Dialog({
      title: t("chooseIconFor").replace("{domain}", domain),
      content: '<div class="siyuan-linkmark-picker"></div>',
      width: "min(720px, 92vw)",
      height: "min(620px, 82vh)",
      destroyCallback: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)),
    });
    const root = dialog.element.querySelector<HTMLElement>(".siyuan-linkmark-picker");
    if (!root) return;

    const scopeChoices = pickerScopeChoices(selectedScope);
    const subdomainsChoice = scopeChoices.find((choice) => choice.kind === "subdomains");

    const controls = document.createElement("div");
    controls.className = "siyuan-linkmark-picker-controls";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico";
    fileInput.className = "b3-text-field";
    fileInput.title = t("uploadCustomIcon");
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "b3-text-field fn__flex-1";
    urlInput.placeholder = t("customIconUrlPlaceholder");
    const urlButton = actionButton(t("useCustomUrl"), "b3-button b3-button--outline", () => {
      void useUrl();
    });
    controls.append(fileInput, urlInput, urlButton);
    if (this.client.entryFor(selectedScope.key)?.pinned) {
      controls.append(actionButton(t("restoreAutomatic"), "b3-button b3-button--text", () => {
        void this.actions.restoreAutomaticIcon(selectedScope.key).then(() => {
          dialog.destroy();
          this.afterChange();
        });
      }));
    }

    const scopeSelect = document.createElement("select");
    scopeSelect.className = "b3-select";
    for (const choice of scopeChoices) {
      if (choice.kind === "type") {
        scopeSelect.add(new Option(t("pinCurrentType").replace("{type}", scopeTypeLabel(t, selectedScope)), "type"));
      } else if (choice.kind === "domain") {
        scopeSelect.add(new Option(t("pinCurrentDomain").replace("{domain}", domain), "domain"));
      } else {
        scopeSelect.add(new Option(t("applyToSubdomains").replace("{domain}", choice.shareDomain), "subdomains"));
      }
    }
    const shareRow = document.createElement("label");
    shareRow.className = "siyuan-linkmark-picker-scope";
    const shareText = document.createElement("span");
    shareText.textContent = t("pinScopeTitle");
    shareRow.append(shareText, scopeSelect);

    const status = document.createElement("div");
    status.className = "b3-label__text siyuan-linkmark-picker-status";
    status.textContent = t("loadingCandidates");
    const hint = document.createElement("div");
    hint.className = "b3-label__text siyuan-linkmark-picker-hint";
    hint.textContent = t("candidateHint");
    const grid = document.createElement("div");
    grid.className = "siyuan-linkmark-candidate-grid";
    const loadPageCandidates = actionButton(
      t("loadPageCandidates"),
      "b3-button b3-button--outline",
      () => void loadCandidates(true),
    );
    root.append(controls);
    root.append(shareRow);
    if (!this.settings.allowFullPageDiscovery && !selectedScope.discoverPage) root.append(loadPageCandidates);
    root.append(hint, status, grid);

    let saving = false;
    const targetScopeForSelection = (): LinkScope => {
      const selection = scopeSelect.value;
      if (selection === "type") return selectedScope;
      if (selection === "subdomains" && subdomainsChoice) {
        return { key: subdomainsChoice.shareDomain, domain: subdomainsChoice.shareDomain };
      }
      return { key: domain, domain };
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
      this.afterChange();
    };

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void saveAndClose(file, "custom upload");
    });

    const useUrl = async () => {
      const value = urlInput.value.trim();
      if (!value) return;
      urlButton.setAttribute("disabled", "true");
      status.textContent = t("loadingCustomUrl");
      try {
        const targetScope = targetScopeForSelection();
        const receipt = await this.client.pinUrl(
          targetScope,
          targetUrl,
          value,
          scopeSelect.value === "subdomains",
          selectedScope.key,
        );
        if (!root.isConnected) return;
        await this.client.applyMutationReceipt(receipt);
        this.actions.scheduleScan();
        dialog.destroy();
        this.afterChange();
      } catch {
        status.textContent = t("customIconInvalid");
      } finally {
        urlButton.removeAttribute("disabled");
      }
    };

    const loadCandidates = async (allowFullPageDiscovery: boolean) => {
      loadPageCandidates.setAttribute("disabled", "true");
      status.textContent = t("loadingCandidates");
      grid.replaceChildren();
      try {
        const discoverPage = allowFullPageDiscovery || Boolean(selectedScope.discoverPage);
        const candidates = await this.client.candidates(selectedScope, targetUrl, discoverPage);
        if (!root.isConnected) return;
        if (!urlButton.hasAttribute("disabled")) {
          status.textContent = candidates.length === 0 ? t("noCandidates") : t("candidateCount").replace("{count}", String(candidates.length));
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
          label.textContent = resolverSourceLabel(t, candidate.source);
          const details = document.createElement("small");
          details.className = "siyuan-linkmark-candidate-details";
          const format = iconFormat(blob, t("unknownIconFormat"));
          const size = formatFileSize(blob.size);
          details.textContent = format === "SVG"
            ? `${format} · ${t("vectorIcon")} · ${size}`
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
        if (root.isConnected && !urlButton.hasAttribute("disabled")) status.textContent = t("candidateLoadFailed");
      } finally {
        loadPageCandidates.removeAttribute("disabled");
      }
    };
    void loadCandidates(this.settings.allowFullPageDiscovery || Boolean(selectedScope.discoverPage));
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
    await this.client.whenPendingSettled(selectedScope.key);
    try {
      const entry: CacheEntry = {
        url: "",
        fetchedAt: Date.now(),
        resolverVersion: RESOLVER_VERSION,
        source,
        targetUrl: this.client.sanitizeTargetUrl(targetUrl, scope.domain),
        domain: scope.domain,
        routeKey: scope.routeKey,
        pathPrefix: scope.pathPrefix,
        pinned: true,
        includeSubdomains,
      };
      const receipt = await this.client.pin(
        scope,
        targetUrl,
        entry,
        blob.type || "image/png",
        await blobToBase64(blob),
        selectedScope.key,
      );
      await this.client.applyMutationReceipt(receipt);
      this.client.clearFailure(scope.key);
      this.client.clearFailure(selectedScope.key);
      this.client.cancelManualRefresh(scope.key);
      this.client.cancelManualRefresh(selectedScope.key);
      this.actions.scheduleScan();
      showMessage(this.t("customIconSaved").replace("{domain}", scope.domain));
      return true;
    } catch (error) {
      console.warn(`[siyuan-linkmark] Unable to save custom icon for ${scope.key}`, error);
      showMessage(this.t("customIconSaveFailed"));
      return false;
    }
  }
}
