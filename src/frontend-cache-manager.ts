import { confirm, Dialog, showMessage } from "siyuan";
import type { BulkRefreshState, CacheManagementItem } from "./cache-authority";
import type { FrontendCacheClient } from "./frontend-cache-client";
import { CacheManagerPageController, type CacheManagerPageState } from "./frontend-cache-manager-state";
import { actionButton } from "./frontend-dom";
import { isCacheEntryFresh } from "./frontend-cache-state";
import { cacheSourceLabel, scopeTypeLabel, showRefreshResult, type Translator } from "./frontend-labels";
import type { Settings } from "./frontend-settings";
import { scopeFromCacheKey, type LinkScope } from "./url-scope";

export type CacheManagerDialogActions = {
  refreshCurrentDocument: () => Promise<void>;
  openIconPicker: (scope: LinkScope, targetUrl: string, afterChange: () => void, guard: { epoch: string; entryToken: string }) => void;
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
    let dispose = () => undefined;
    const dialog = new Dialog({
      title: this.t("manageCache"),
      content: '<div class="siyuan-linkmark-cache-manager"></div>',
      width: "min(760px, 92vw)",
      height: "min(640px, 82vh)",
      destroyCallback: () => dispose(),
    });
    const root = dialog.element.querySelector<HTMLElement>(".siyuan-linkmark-cache-manager");
    if (!root) return;

    const summary = document.createElement("div");
    summary.className = "siyuan-linkmark-cache-summary";
    const count = document.createElement("strong");
    const path = document.createElement("code");
    path.textContent = "plugin private icon storage";
    summary.append(count, path);

    const actions = document.createElement("div");
    actions.className = "fn__flex siyuan-linkmark-cache-actions";
    const bulkStatus = document.createElement("div");
    bulkStatus.className = "b3-label__text siyuan-linkmark-cache-bulk-status";
    const search = document.createElement("input");
    search.className = "b3-text-field fn__block";
    search.placeholder = this.t("cacheSearch");
    const list = document.createElement("div");
    list.className = "siyuan-linkmark-cache-list";
    const pager = document.createElement("div");
    pager.className = "fn__flex siyuan-linkmark-cache-pager";

    let bulkRefresh: BulkRefreshState | undefined;
    const controller = new CacheManagerPageController({
      load: (query) => this.client.queryCache(query),
      onChange: (state) => this.renderPage(state, list, pager, controller),
    });
    const renderCount = (value: number) => {
      count.textContent = this.t("cacheCount").replace("{count}", String(value));
    };
    const renderBulk = (state?: BulkRefreshState) => {
      bulkRefresh = state;
      bulkStatus.replaceChildren();
      if (!state) return;
      bulkStatus.append(document.createTextNode(this.bulkStatusText(state)));
      if (state.state === "running" || state.state === "cancelling") {
        const cancel = actionButton(this.t("cancelRefreshAll"), "b3-button b3-button--text", () => {
          void this.client.cancelBulkRefresh();
        });
        cancel.disabled = state.state === "cancelling";
        bulkStatus.append(cancel);
      }
    };

    actions.append(
      actionButton(this.t("refreshCurrent"), "b3-button b3-button--outline", () => {
        void this.actions.refreshCurrentDocument().then(() => controller.reload());
      }),
      actionButton(this.t("refreshAll"), "b3-button b3-button--outline", () => {
        confirm(this.t("refreshAll"), this.t("refreshAllConfirm"), (confirmDialog) => {
          confirmDialog.destroy();
          void this.client.startBulkRefresh().then(({ refresh }) => renderBulk(refresh));
        });
      }),
      actionButton(this.t("clearCache"), "b3-button b3-button--remove", () => this.confirmClearAll(controller)),
    );
    search.addEventListener("input", () => controller.setQuery(search.value));
    root.append(summary, actions, bulkStatus, search, list, pager);

    const unsubscribeCursor = this.client.onCursorChange((cursor) => {
      void controller.invalidate(cursor);
      void this.client.refreshStats().then((stats) => renderCount(stats.entryCount));
    });
    const unsubscribeBulk = this.client.onBulkRefreshChange((state) => renderBulk(state));
    dispose = () => {
      controller.dispose();
      unsubscribeCursor();
      unsubscribeBulk();
    };
    void this.client.refreshStats().then((stats) => {
      renderCount(stats.entryCount);
      renderBulk(stats.bulkRefresh ?? bulkRefresh);
    });
    void controller.reload();
  }

  private renderPage(
    state: CacheManagerPageState,
    list: HTMLElement,
    pager: HTMLElement,
    controller: CacheManagerPageController,
  ) {
    list.replaceChildren();
    pager.replaceChildren();
    const page = state.page;
    if (state.loading && !page) {
      list.append(this.empty(this.t("cacheLoading")));
      return;
    }
    if (!page || page.items.length === 0) {
      list.append(this.empty(this.t(this.client.entryCount() === 0 ? "cacheEmpty" : "cacheNoMatches")));
    } else {
      let previousDomain = "";
      for (const item of page.items) {
        const scope = scopeFromCacheKey(item.key, item.entry.domain, item.entry.pathPrefix);
        if (scope.domain !== previousDomain) {
          const heading = document.createElement("strong");
          heading.className = "siyuan-linkmark-cache-domain-heading";
          heading.textContent = scope.domain;
          list.append(heading);
          previousDomain = scope.domain;
        }
        list.append(this.renderRow(item, page.epoch, scope, controller));
      }
    }
    if (!page) return;
    const previous = actionButton(this.t("previousPage"), "b3-button b3-button--outline", () => {
      void controller.goToOffset(Math.max(0, page.offset - page.limit));
    });
    previous.disabled = page.offset === 0;
    const next = actionButton(this.t("nextPage"), "b3-button b3-button--outline", () => {
      void controller.goToOffset(page.offset + page.limit);
    });
    next.disabled = page.offset + page.items.length >= page.total;
    const position = document.createElement("span");
    position.textContent = this.t("cachePageSummary")
      .replace("{start}", String(page.total === 0 ? 0 : page.offset + 1))
      .replace("{end}", String(page.offset + page.items.length))
      .replace("{total}", String(page.total));
    pager.append(previous, position, next);
  }

  private renderRow(item: CacheManagementItem, epoch: string, scope: LinkScope, controller: CacheManagerPageController) {
    const row = document.createElement("div");
    row.className = "siyuan-linkmark-cache-row";
    const info = document.createElement("div");
    info.className = "siyuan-linkmark-cache-info";
    const name = document.createElement("strong");
    name.textContent = scope.routeKey
      ? this.t("cacheRouteName").replace("{type}", scopeTypeLabel(this.t, scope))
      : this.t("cacheDomainDefault");
    const meta = document.createElement("span");
    const source = cacheSourceLabel(this.t, item.entry.source);
    const status = item.entry.pinned
      ? this.t(item.entry.includeSubdomains ? "cachePinnedSubdomains" : "cachePinned")
      : isCacheEntryFresh(item.entry, this.settings.cacheDays) ? this.t("cacheFresh") : this.t("cacheExpired");
    meta.textContent = `${source} · ${new Date(item.entry.fetchedAt).toLocaleString()} · ${status}`;
    info.append(name, meta);
    const guard = { epoch, entryToken: item.entryToken };
    const rowActions = document.createElement("div");
    rowActions.className = "fn__flex siyuan-linkmark-cache-row-actions";
    rowActions.append(actionButton(this.t("chooseIcon"), "b3-button b3-button--text", () => {
      const targetUrl = this.actions.currentDocumentTargetUrl(scope.key)
        ?? item.entry.targetUrl
        ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
      this.actions.openIconPicker(scope, targetUrl, () => { void controller.reload(); }, guard);
    }));
    if (item.entry.pinned) {
      rowActions.append(actionButton(this.t("restoreAutomatic"), "b3-button b3-button--text", () => {
        void this.runManagedAction(() => this.client.remove(item.key, guard), controller, true);
      }));
    } else {
      rowActions.append(
        actionButton(this.t("refreshOne"), "b3-button b3-button--text", () => {
          void this.runManagedAction(async () => {
            const result = await this.client.refreshManagedEntry(item.key, guard);
            showRefreshResult(this.t, {
              queued: result.status === "queued" ? 1 : 0,
              failed: result.status === "unavailable" ? 1 : 0,
              skipped: result.status === "ready" ? 1 : 0,
            });
          }, controller);
        }),
        actionButton(this.t("deleteOne"), "b3-button b3-button--text", () => {
          void this.runManagedAction(() => this.client.remove(item.key, guard), controller, true);
        }),
      );
    }
    row.append(info, rowActions);
    return row;
  }

  private async runManagedAction(operation: () => Promise<unknown>, controller: CacheManagerPageController, scan = false) {
    try {
      await operation();
      if (scan) this.actions.scheduleScan();
      await controller.reload();
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: string }).code === "cache_entry_changed") {
        showMessage(this.t("cacheEntryChanged"));
        await controller.reload();
        return;
      }
      console.warn("[siyuan-linkmark] Cache manager action failed", error);
      showMessage(this.t("cacheActionFailed"));
    }
  }

  private confirmClearAll(controller: CacheManagerPageController) {
    confirm(this.t("clearCache"), this.t("clearCacheConfirm"), (dialog) => {
      dialog.destroy();
      void this.client.clearAll().then(() => {
        showMessage(this.t("cacheCleared"));
        this.actions.scheduleScan();
        void controller.reload();
      });
    });
  }

  private empty(text: string) {
    const empty = document.createElement("div");
    empty.className = "b3-label__text siyuan-linkmark-cache-empty";
    empty.textContent = text;
    return empty;
  }

  private bulkStatusText(state: BulkRefreshState) {
    return this.t(`bulkRefresh_${state.state}`)
      .replace("{completed}", String(state.completed + state.failed + state.skipped))
      .replace("{total}", String(state.total));
  }
}
