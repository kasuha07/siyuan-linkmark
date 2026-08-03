import { confirm, Dialog, showMessage } from "siyuan";
import type { FrontendCacheClient } from "./frontend-cache-client";
import { actionButton } from "./frontend-dom";
import { isCacheEntryFresh } from "./frontend-cache-state";
import { cacheSourceLabel, scopeTypeLabel, showRefreshResult, type Translator } from "./frontend-labels";
import type { Settings } from "./frontend-settings";
import { scopeFromCacheKey, type LinkScope } from "./url-scope";

export type CacheManagerDialogActions = {
  refreshCurrentDocument: () => Promise<void>;
  refreshAllCachedDomains: () => Promise<void>;
  restoreAutomaticIcon: (key: string) => Promise<void>;
  openIconPicker: (scope: LinkScope, targetUrl: string, afterChange: () => void) => void;
  scheduleScan: () => void;
  currentDocumentTargetUrl: (scopeKey: string) => string | undefined;
};

export type CacheManagerDialogOptions = {
  t: Translator;
  client: FrontendCacheClient;
  settings: Settings;
  actions: CacheManagerDialogActions;
};

export class CacheManagerDialog {
  private readonly t: Translator;
  private readonly client: FrontendCacheClient;
  private readonly settings: Settings;
  private readonly actions: CacheManagerDialogActions;

  constructor(options: CacheManagerDialogOptions) {
    this.t = options.t;
    this.client = options.client;
    this.settings = options.settings;
    this.actions = options.actions;
    this.open();
  }

  private open() {
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
      count.textContent = this.t("cacheCount").replace("{count}", String(this.client.entryCount()));
      const path = document.createElement("code");
      path.textContent = "plugin private icon storage";
      summary.append(count, path);

      const actions = document.createElement("div");
      actions.className = "fn__flex siyuan-linkmark-cache-actions";
      actions.append(
        actionButton(this.t("refreshCurrent"), "b3-button b3-button--outline", () => {
          void this.actions.refreshCurrentDocument().then(render);
        }),
        actionButton(this.t("refreshAll"), "b3-button b3-button--outline", () => {
          confirm(this.t("refreshAll"), this.t("refreshAllConfirm"), (confirmDialog) => {
            confirmDialog.destroy();
            void this.actions.refreshAllCachedDomains().then(render);
          });
        }),
        actionButton(this.t("clearCache"), "b3-button b3-button--remove", () => this.confirmClearAll(render)),
      );

      const search = document.createElement("input");
      search.className = "b3-text-field fn__block";
      search.placeholder = this.t("cacheSearch");
      const list = document.createElement("div");
      list.className = "siyuan-linkmark-cache-list";
      const renderList = () => {
        list.replaceChildren();
        const query = search.value.trim().toLowerCase();
        const entries = Object.entries(this.client.entries())
          .filter(([key, entry]) => !query || key.includes(query) || entry.domain?.includes(query))
          .sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) {
          const empty = document.createElement("div");
          empty.className = "b3-label__text siyuan-linkmark-cache-empty";
          empty.textContent = this.t(this.client.entryCount() === 0 ? "cacheEmpty" : "cacheNoMatches");
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
            ? this.t("cacheRouteName").replace("{type}", scopeTypeLabel(this.t, scope))
            : this.t("cacheDomainDefault");
          const meta = document.createElement("span");
          const source = cacheSourceLabel(this.t, entry.source);
          const status = entry.pinned
            ? this.t(entry.includeSubdomains ? "cachePinnedSubdomains" : "cachePinned")
            : isCacheEntryFresh(entry, this.settings.cacheDays) ? this.t("cacheFresh") : this.t("cacheExpired");
          meta.textContent = `${source} · ${new Date(entry.fetchedAt).toLocaleString()} · ${status}`;
          info.append(name, meta);
          const rowActions = document.createElement("div");
          rowActions.className = "fn__flex siyuan-linkmark-cache-row-actions";
          rowActions.append(actionButton(this.t("chooseIcon"), "b3-button b3-button--text", () => {
            const targetUrl = this.actions.currentDocumentTargetUrl(scope.key)
              ?? entry.targetUrl
              ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
            this.actions.openIconPicker(scope, targetUrl, render);
          }));
          if (entry.pinned) {
            rowActions.append(actionButton(this.t("restoreAutomatic"), "b3-button b3-button--text", () => {
              void this.actions.restoreAutomaticIcon(key).then(render);
            }));
          } else {
            rowActions.append(
              actionButton(this.t("refreshOne"), "b3-button b3-button--text", () => {
                const targetUrl = this.actions.currentDocumentTargetUrl(scope.key)
                  ?? entry.targetUrl
                  ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
                void this.client.refreshDomains(new Map([[scope.key, { scope, targetUrl }]])).then((result) => {
                  showRefreshResult(this.t, result);
                  render();
                });
              }),
              actionButton(this.t("deleteOne"), "b3-button b3-button--text", () => {
                void this.client.remove(key).then(() => {
                  this.actions.scheduleScan();
                  render();
                });
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

  private confirmClearAll(afterClear?: () => void) {
    confirm(this.t("clearCache"), this.t("clearCacheConfirm"), (dialog) => {
      dialog.destroy();
      void this.client.clearAll().then(() => {
        showMessage(this.t("cacheCleared"));
        this.actions.scheduleScan();
        afterClear?.();
      });
    });
  }
}
