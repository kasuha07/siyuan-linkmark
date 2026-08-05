import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showMessage, type IMenu, type IProtyle } from "siyuan";
import { LinkContextMenu } from "../src/frontend-link-menu";
import type { FrontendCacheClient } from "../src/frontend-cache-client";
import type { LinkScope } from "../src/url-scope";

vi.mock("siyuan", () => ({ showMessage: vi.fn() }));

type RecordedItem = { label?: string; click?: () => void | Promise<void> };

function makeMenu() {
  const record = { items: [] as RecordedItem[], separators: 0 };
  const menu = {
    menus: [] as IMenu[],
    addItem: (item: RecordedItem) => void record.items.push(item),
    addSeparator: () => void (record.separators += 1),
  };
  return { menu, record };
}

function linkElement(href: string) {
  return { dataset: { href }, getAttribute: () => null } as unknown as HTMLElement;
}

function openMenu(menu: LinkContextMenu, menuLike: { menus: IMenu[]; addItem: (item: RecordedItem) => void; addSeparator: () => void }, element: HTMLElement) {
  menu.handleOpenMenu(new CustomEvent("open-menu-link", {
    detail: { menu: menuLike, protyle: {} as IProtyle, element },
  }));
}

describe("LinkContextMenu", () => {
  const showMessageMock = vi.mocked(showMessage);

  beforeEach(() => {
    showMessageMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup(client: Partial<FrontendCacheClient>) {
    const picked: Array<{ scope: LinkScope; targetUrl: string }> = [];
    const context = new LinkContextMenu({
      t: (key) => key,
      client: client as FrontendCacheClient,
      openIconPicker: (scope, targetUrl) => void picked.push({ scope, targetUrl }),
    });
    return { context, picked };
  }

  it("adds nothing for a non-HTTP link", () => {
    const { menu, record } = makeMenu();
    const { context } = setup({});
    openMenu(context, menu, linkElement("siyuan://blocks/20210808180117-czj9bvb"));
    expect(record.items).toHaveLength(0);
    expect(record.separators).toBe(0);
  });

  it("appends both actions to the official plugin submenu without a separator", () => {
    const { menu, record } = makeMenu();
    const { context } = setup({});
    openMenu(context, menu, linkElement("https://example.dev/doc"));
    expect(record.separators).toBe(0);
    expect(record.items.map((item) => item.label)).toEqual(["menuRefreshIcon", "menuChooseIcon"]);
  });

  it("skips a pinned match with a hint instead of fetching", async () => {
    const { menu, record } = makeMenu();
    const fetchAndCache = vi.fn();
    const { context } = setup({
      entries: () => ({
        "example.dev": { url: "icon.png", fetchedAt: 1, domain: "example.dev", pinned: true },
      }),
      fetchAndCache,
    });
    openMenu(context, menu, linkElement("https://example.dev/doc"));
    await record.items[0].click?.();
    expect(fetchAndCache).not.toHaveBeenCalled();
    expect(showMessageMock).toHaveBeenCalledWith("iconRefreshPinned");
  });

  it("re-queues a manual refresh for an unpinned link and confirms the queue", async () => {
    const { menu, record } = makeMenu();
    const fetchAndCache = vi.fn().mockResolvedValue("queued");
    const { context } = setup({ entries: () => ({}), fetchAndCache });
    openMenu(context, menu, linkElement("https://example.dev/doc"));
    await record.items[0].click?.();
    expect(fetchAndCache).toHaveBeenCalledWith(
      { key: "example.dev", domain: "example.dev" },
      "https://example.dev/doc",
      true,
      "manual",
    );
    expect(showMessageMock).toHaveBeenCalledWith("iconRefreshQueued");
  });

  it("reports a failed refresh with the existing manual-failure message", async () => {
    const { menu, record } = makeMenu();
    const fetchAndCache = vi.fn().mockResolvedValue("failure");
    const { context } = setup({ entries: () => ({}), fetchAndCache });
    openMenu(context, menu, linkElement("https://example.dev/doc"));
    await record.items[0].click?.();
    expect(showMessageMock).toHaveBeenCalledWith("manualRefreshFailed");
  });

  it("opens the icon picker for the link's scope", async () => {
    const { menu, record } = makeMenu();
    const { context, picked } = setup({});
    openMenu(context, menu, linkElement("https://example.dev/doc"));
    await record.items[1].click?.();
    expect(picked).toEqual([{ scope: { key: "example.dev", domain: "example.dev" }, targetUrl: "https://example.dev/doc" }]);
  });
});
