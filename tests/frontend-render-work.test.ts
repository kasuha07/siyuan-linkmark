import { describe, expect, it } from "vitest";
import {
  addedLinkDiscoveryRegionFor,
  flushFrontendRenderWork,
  FrontendRenderWorkQueue,
  localDiscoveryRegionFor,
  type DiscoveryWork,
} from "../src/frontend-render-work";
import { reconcilePresentRules, createIconRule, type PresentRuleContext } from "../src/icon-rule";
import { perfCacheOverlay, perfScenarioLinkUrls } from "../src/perf-scenario";
import { RESOLVER_VERSION } from "../src/resolver-contract";
import { scopeForUrl } from "../src/url-scope";

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

  it("reduces nested and repeated local regions to the narrowest useful set", () => {
    const work = new FrontendRenderWorkQueue<string>((outer, inner) => inner.includes(outer));

    work.requestLocalDiscovery("block-a");
    work.requestLocalDiscovery("block-a/child");
    work.requestLocalDiscovery("block-a/text-node");
    work.requestLocalDiscovery("block-b");
    work.flushDiscovery();
    expect(work.take().discovery).toEqual({ kind: "local", regions: ["block-a", "block-b"] });

    work.requestLocalDiscovery("block-c/child");
    work.requestLocalDiscovery("block-c");
    work.flushDiscovery();
    expect(work.take().discovery).toEqual({ kind: "local", regions: ["block-c"] });
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

  it("coalesces the 2,000-link / 500-scope scenario into one 500-rule publication", () => {
    const links = perfScenarioLinkUrls().map((url, id) => ({ id, url }));
    const overlay = perfCacheOverlay(Date.now());
    const rules = new Map<string, string>();
    const publications: string[][] = [];
    const work = new FrontendRenderWorkQueue<{ id: number; url: string }>();

    for (const link of links) {
      work.requestLocalDiscovery(link);
    }
    work.flushDiscovery();

    const discover = (discovery: DiscoveryWork<{ id: number; url: string }>) => {
      const regions = discovery?.kind === "full" ? links : discovery?.regions ?? [];
      let changed = false;
      for (const link of regions) {
        const scope = scopeForUrl(link.url);
        const entry = scope ? overlay[scope.key] : undefined;
        if (scope && entry && rules.get(scope.key) !== entry.url) {
          rules.set(scope.key, entry.url);
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
    expect(rules).toHaveLength(500);
    expect(publications).toEqual([Array.from(rules.values())]);
    expect([...rules.keys()]).toEqual(expect.arrayContaining([
      "perf-site-0.example.dev",
      "perf-site-479.example.dev",
      "nocode.host::site-p00000",
      "nocode.host::site-p00019",
    ]));
  });

  it("evicts departed scopes on a full discovery without local scans touching other regions", () => {
    const context: PresentRuleContext = {
      cache: {
        "a.example.dev": { url: "icon-a.png", fetchedAt: Date.now() - 1_000, resolverVersion: RESOLVER_VERSION },
        "b.example.dev": { url: "icon-b.png", fetchedAt: Date.now() - 1_000, resolverVersion: RESOLVER_VERSION },
      },
      iconSize: 1,
      cacheDays: 30,
      pauseAutomaticFetch: false,
    };
    const aScope = { key: "a.example.dev", domain: "a.example.dev" };
    const bScope = { key: "b.example.dev", domain: "b.example.dev" };
    const work = new FrontendRenderWorkQueue<{ key: string; domain: string }>();
    let rules = new Map<string, string>();
    let publications = 0;
    const discover = (discovery: DiscoveryWork<{ key: string; domain: string }>) => {
      const discovered = discovery?.kind === "full"
        ? [aScope] // b.example.dev left the document
        : discovery?.regions ?? [];
      const reconciled = reconcilePresentRules({
        discovery: discovered,
        context,
        previous: rules,
        full: discovery?.kind === "full",
      });
      rules = reconciled.rules;
      return reconciled.changed;
    };
    const executor = {
      rebuildRules: () => {
        rules = new Map();
      },
      discover,
      publishRules: () => {
        publications += 1;
      },
    };

    work.requestLocalDiscovery(bScope);
    work.flushDiscovery();
    flushFrontendRenderWork(work, executor);
    expect([...rules.keys()]).toEqual(["b.example.dev"]);
    expect(publications).toBe(1);

    work.requestLocalDiscovery(aScope);
    work.requestFullDiscovery();
    work.flushDiscovery();
    flushFrontendRenderWork(work, executor);
    expect([...rules.keys()]).toEqual(["a.example.dev"]);
    expect(rules.get("a.example.dev")).toBe(createIconRule(aScope, "icon-a.png", 1));
    expect(publications).toBe(2);

    work.requestLocalDiscovery(bScope);
    work.flushDiscovery();
    flushFrontendRenderWork(work, executor);
    expect([...rules.keys()].sort()).toEqual(["a.example.dev", "b.example.dev"]);
    expect(publications).toBe(3);
  });
});
