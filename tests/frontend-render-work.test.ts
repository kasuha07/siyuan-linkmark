import { describe, expect, it } from "vitest";
import {
  addedLinkDiscoveryRegionFor,
  flushFrontendRenderWork,
  FrontendRenderWorkQueue,
  localDiscoveryRegionFor,
  type DiscoveryWork,
} from "../src/frontend-render-work";

type FakeElement = {
  isConnected: boolean;
  parentElement: FakeElement | null;
  roles: Set<string>;
  linkedDescendant: FakeElement | null;
  matches: (selector: string) => boolean;
  closest: (selector: string) => FakeElement | null;
  querySelector: (selector: string) => FakeElement | null;
};

function fakeElement(...roles: string[]): FakeElement {
  const element: FakeElement = {
    isConnected: true,
    parentElement: null,
    roles: new Set(roles),
    linkedDescendant: null,
    matches: (selector) => element.roles.has(selector),
    closest: (selector) => {
      let current: FakeElement | null = element;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    querySelector: (selector) => selector === "link" ? element.linkedDescendant : null,
  };
  return element;
}

const localSelectors = {
  link: "link",
  editor: "editor",
  block: "block",
  staticContainer: "static",
};

describe("FrontendRenderWorkQueue", () => {
  it("coalesces repeated mutations into one local discovery pass", () => {
    const work = new FrontendRenderWorkQueue<string>();

    work.requestLocalDiscovery("block-a");
    work.requestLocalDiscovery("block-a");
    work.requestLocalDiscovery("block-b");
    work.flushDiscovery();

    expect(work.take()).toEqual({
      discovery: { kind: "local", regions: ["block-a", "block-b"] },
      rebuildRules: false,
      publishRules: false,
    });
    expect(work.take()).toEqual({ discovery: null, rebuildRules: false, publishRules: false });
  });

  it("lets full cache reconciliation supersede pending local discovery", () => {
    const work = new FrontendRenderWorkQueue<string>();

    work.requestLocalDiscovery("block-a");
    work.requestFullDiscovery();
    work.requestRuleRebuild();
    work.flushDiscovery();

    expect(work.take()).toEqual({
      discovery: { kind: "full" },
      rebuildRules: true,
      publishRules: true,
    });
  });

  it("keeps an editor-host input local to its selected block or link", () => {
    const editor = fakeElement("editor");
    const block = fakeElement("block");
    const inline = fakeElement();
    const link = fakeElement("link");
    block.parentElement = editor;
    inline.parentElement = block;
    link.parentElement = block;

    expect(localDiscoveryRegionFor(link, localSelectors)).toBe(link);
    expect(localDiscoveryRegionFor(inline, localSelectors)).toBe(block);
    expect(localDiscoveryRegionFor(editor, localSelectors)).toBeNull();
    editor.linkedDescendant = link;
    expect(addedLinkDiscoveryRegionFor(editor, localSelectors)).toBe(editor);
  });

  it("coalesces the 1,000-link / 250-scope warm-cache fixture into one rule publication", () => {
    type Link = { id: number; scope: string };
    const links: Link[] = Array.from({ length: 1_000 }, (_, id) => ({ id, scope: `scope-${id % 250}` }));
    const cache = new Map(Array.from({ length: 250 }, (_, id) => [`scope-${id}`, `icon-${id}`]));
    const rules = new Map<string, string>();
    const publications: string[][] = [];
    const work = new FrontendRenderWorkQueue<Link>();

    for (const link of links) {
      work.requestLocalDiscovery(link);
    }
    work.flushDiscovery();

    const discover = (discovery: DiscoveryWork<Link>) => {
      const regions = discovery?.kind === "full" ? links : discovery?.regions ?? [];
      let changed = false;
      for (const link of regions) {
        const rule = cache.get(link.scope);
        if (rule && rules.get(link.scope) !== rule) {
          rules.set(link.scope, rule);
          changed = true;
        }
      }
      return changed;
    };
    const executor = {
      rebuildRules: () => rules.clear(),
      discover,
      publishRules: () => publications.push([...rules.values()]),
    };

    flushFrontendRenderWork(work, executor);
    expect(rules).toHaveLength(250);
    expect(publications).toEqual([Array.from({ length: 250 }, (_, id) => `icon-${id}`)]);

    cache.set("scope-0", "updated-icon");
    work.requestFullDiscovery();
    work.requestRuleRebuild();
    work.flushDiscovery();
    flushFrontendRenderWork(work, executor);

    expect(rules.get("scope-0")).toBe("updated-icon");
    expect(publications).toHaveLength(2);
  });
});
