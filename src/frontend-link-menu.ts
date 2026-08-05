import { showMessage, type IMenuBaseDetail } from "siyuan";
import type { FrontendCacheClient } from "./frontend-cache-client";
import { cachedIconForScope } from "./frontend-cache-state";
import { linkHref } from "./frontend-link-discovery";
import type { Translator } from "./frontend-labels";
import { scopeForUrl, type LinkScope } from "./url-scope";

export type LinkContextMenuOptions = {
  t: Translator;
  client: FrontendCacheClient;
  openIconPicker: (scope: LinkScope, targetUrl: string) => void;
};

/**
 * The link context-menu entry point. It appends Linkmark's actions to
 * SiYuan's `open-menu-link` menu for external links only, independent of the
 * display-enabled setting: both actions are explicit manual operations. The
 * received `menu` is the official per-plugin submenu SiYuan nests under its
 * built-in "Plugins" context-menu group, so no separator is needed.
 */
export class LinkContextMenu {
  constructor(private readonly options: LinkContextMenuOptions) {}

  handleOpenMenu(event: CustomEvent<IMenuBaseDetail>) {
    const href = linkHref(event.detail.element);
    const scope = scopeForUrl(href);
    if (!scope) return;
    const { t } = this.options;
    event.detail.menu.addItem({
      label: t("menuRefreshIcon"),
      click: () => void this.refreshIcon(scope, href),
    });
    event.detail.menu.addItem({
      label: t("menuChooseIcon"),
      click: () => this.options.openIconPicker(scope, href),
    });
  }

  private async refreshIcon(scope: LinkScope, targetUrl: string) {
    const { t, client } = this.options;
    const match = cachedIconForScope(client.entries(), scope);
    if (match?.entry.pinned) {
      showMessage(t("iconRefreshPinned").replace("{domain}", scope.domain));
      return;
    }
    const outcome = await client.fetchAndCache(scope, targetUrl, true, "manual");
    if (outcome === "queued") {
      showMessage(t("iconRefreshQueued").replace("{domain}", scope.domain));
    } else if (outcome === "failure" || outcome === "unavailable") {
      // 失败与权威未就绪统一使用既有手动刷新失败文案；排队后解析失败的
      // 提示由 cache.resolution-failed 广播经 onManualRefreshFailed 给出。
      showMessage(t("manualRefreshFailed").replace("{domain}", scope.domain));
    }
  }
}
