import { describe, expect, it } from "vitest";
import { createIconRule, reconcilePresentRules, type PresentRuleContext } from "../src/icon-rule";
import { RESOLVER_VERSION } from "../src/resolver-contract";
import { perfCacheOverlay, perfScenarioScopes, PERF_CACHE_VIEW_ENTRIES, PERF_SCOPE_COUNT } from "../src/perf-scenario";
import { scopeForUrl } from "../src/url-scope";

describe("createIconRule", () => {
  const domainScope = { key: "example.com", domain: "example.com" };
  const routeScope = scopeForUrl("https://docs.qq.com/doc/abc");

  it("targets every link element for https and http with the exact origin", () => {
    const rule = createIconRule(domainScope, "https://cdn.example.com/icon.png", 1);
    for (const selector of [
      ".protyle-wysiwyg span[data-type~='a'][data-href=\"https://example.com\"]::before",
      ".protyle-wysiwyg span[data-type~='a'][data-href^=\"https://example.com/\"]::before",
      ".protyle-wysiwyg span[data-type~='url'][data-href=\"https://example.com\"]::before",
      ".protyle-wysiwyg a[href=\"https://example.com\"]::before",
      ".b3-typography a[href=\"https://example.com\"]::before",
      ".b3-typography a[href^=\"http://example.com/\"]::before",
    ]) {
      expect(rule).toContain(selector);
    }
  });

  it("includes path, query, fragment, and port boundary prefixes on domain scopes", () => {
    const rule = createIconRule(domainScope, "icon.png", 1);
    expect(rule).toContain("[data-href^=\"https://example.com/\"]");
    expect(rule).toContain("[data-href^=\"https://example.com?\"]");
    expect(rule).toContain("[data-href^=\"https://example.com#\"]");
    expect(rule).toContain("[data-href^=\"https://example.com:\"]");
  });

  it("uses the route prefix as the exact match and drops the port boundary", () => {
    expect(routeScope?.routeKey).toBe("doc");
    const rule = createIconRule(routeScope!, "icon.png", 1);
    expect(rule).toContain("[data-href=\"https://docs.qq.com/doc\"]");
    expect(rule).toContain("[data-href^=\"https://docs.qq.com/doc/\"]");
    expect(rule).not.toContain("[data-href^=\"https://docs.qq.com/doc:\"]");
  });

  it("escapes angle brackets in the icon URL", () => {
    const rule = createIconRule(domainScope, "https://cdn.example.com/a<icon>.png", 1);
    expect(rule).toContain("url(\"https://cdn.example.com/a\\3c icon>.png\")");
  });

  it("embeds the display preference icon size in em units", () => {
    const rule = createIconRule(domainScope, "icon.png", 1.4);
    expect(rule).toContain("width: 1.4em;");
    expect(rule).toContain("height: 1.4em;");
  });
});

describe("reconcilePresentRules", () => {
  const now = Date.now();
  const domainScope = { key: "example.com", domain: "example.com" };
  const routeScope = { key: "docs.qq.com::doc", domain: "docs.qq.com", routeKey: "doc", pathPrefix: "/doc" };
  const context = (overrides: Partial<PresentRuleContext> = {}): PresentRuleContext => ({
    cache: {},
    iconSize: 1,
    cacheDays: 30,
    pauseAutomaticFetch: false,
    ...overrides,
  });
  const entry = (overrides: Record<string, unknown> = {}) => ({
    url: "icon.png",
    fetchedAt: now - 1_000,
    resolverVersion: RESOLVER_VERSION,
    domain: "example.com",
    ...overrides,
  });

  it("produces rules for discovered Present scopes with fresh, current entries", () => {
    const result = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry() } }),
      previous: new Map(),
      full: true,
    });
    expect(result.changed).toBe(true);
    expect([...result.rules.keys()]).toEqual(["example.com"]);
    expect(result.rules.get("example.com")).toBe(createIconRule(domainScope, "icon.png", 1));
  });

  it("produces no rule for stale, legacy-version, and missing scopes", () => {
    const stale = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry({ fetchedAt: now - 40 * 86400000 }) } }),
      previous: new Map(),
      full: true,
    });
    expect(stale.rules.size).toBe(0);

    const legacy = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry({ resolverVersion: RESOLVER_VERSION - 1 }) } }),
      previous: new Map(),
      full: true,
    });
    expect(legacy.rules.size).toBe(0);

    const missing = reconcilePresentRules({
      discovery: [domainScope],
      context: context(),
      previous: new Map(),
      full: true,
    });
    expect(missing.rules.size).toBe(0);
  });

  it("keeps stale Pinned entries and paused legacy monograms", () => {
    const pinned = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry({ pinned: true, fetchedAt: 0 }) } }),
      previous: new Map(),
      full: true,
    });
    expect(pinned.rules.size).toBe(1);

    const pausedLegacy = reconcilePresentRules({
      discovery: [domainScope],
      context: context({
        pauseAutomaticFetch: true,
        cache: { [domainScope.key]: entry({ source: "generated monogram", resolverVersion: RESOLVER_VERSION - 1, fetchedAt: 0 }) },
      }),
      previous: new Map(),
      full: true,
    });
    expect(pausedLegacy.rules.size).toBe(1);
  });

  it("suppresses the route rule under a pinned domain and serves through the domain rule", () => {
    const pinnedUrl = "pinned-icon.png";
    const result = reconcilePresentRules({
      discovery: [routeScope],
      context: context({
        cache: {
          [routeScope.key]: entry({ domain: "docs.qq.com", routeKey: "doc", pathPrefix: "/doc", url: "route-icon.png" }),
          [routeScope.domain]: entry({ pinned: true, domain: "docs.qq.com", url: pinnedUrl }),
        },
      }),
      previous: new Map(),
      full: true,
    });
    expect(result.rules.has(routeScope.key)).toBe(false);
    expect(result.rules.get(routeScope.domain)).toBe(createIconRule(
      { key: "docs.qq.com", domain: "docs.qq.com" },
      pinnedUrl,
      1,
    ));
  });

  it("evicts rules for scopes absent from the new discovery on a full reconcile", () => {
    const previous = new Map([
      ["departed.example.com", "old-rule"],
      [domainScope.key, "old-rule"],
    ]);
    const result = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry() } }),
      previous,
      full: true,
    });
    expect(result.changed).toBe(true);
    expect([...result.rules.keys()]).toEqual(["example.com"]);
  });

  it("only adds or updates rules on a local reconcile", () => {
    const previous = new Map([["departed.example.com", "old-rule"]]);
    const result = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry() } }),
      previous,
      full: false,
    });
    expect(result.changed).toBe(true);
    expect(result.rules.get("departed.example.com")).toBe("old-rule");
    expect(result.rules.get("example.com")).toBe(createIconRule(domainScope, "icon.png", 1));
  });

  it("reuses the previous map when local discovery produces no usable rule", () => {
    const previous = new Map([["unrelated.example.com", "unrelated-rule"]]);
    const result = reconcilePresentRules({
      discovery: [],
      context: context(),
      previous,
      full: false,
    });
    expect(result.changed).toBe(false);
    expect(result.rules).toBe(previous);
  });

  it("reuses the previous map when every local rule is already current", () => {
    const rule = createIconRule(domainScope, "icon.png", 1);
    const previous = new Map([
      [domainScope.key, rule],
      ["unrelated.example.com", "unrelated-rule"],
    ]);
    const result = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry() } }),
      previous,
      full: false,
    });
    expect(result.changed).toBe(false);
    expect(result.rules).toBe(previous);
  });

  it("copies on the first effective local upsert and applies every later upsert", () => {
    const secondScope = { key: "second.example.com", domain: "second.example.com" };
    const previous = new Map([
      [domainScope.key, "old-rule"],
      ["unrelated.example.com", "unrelated-rule"],
    ]);
    const result = reconcilePresentRules({
      discovery: [domainScope, secondScope],
      context: context({
        cache: {
          [domainScope.key]: entry(),
          [secondScope.key]: entry({ domain: secondScope.domain, url: "second-icon.png" }),
        },
      }),
      previous,
      full: false,
    });
    expect(result.changed).toBe(true);
    expect(result.rules).not.toBe(previous);
    expect(previous).toEqual(new Map([
      [domainScope.key, "old-rule"],
      ["unrelated.example.com", "unrelated-rule"],
    ]));
    expect(result.rules.get("unrelated.example.com")).toBe("unrelated-rule");
    expect(result.rules.get(domainScope.key)).toBe(createIconRule(domainScope, "icon.png", 1));
    expect(result.rules.get(secondScope.key)).toBe(createIconRule(secondScope, "second-icon.png", 1));
  });

  it("reports no change when a full reconcile matches the previous map", () => {
    const rule = createIconRule(domainScope, "icon.png", 1);
    const previous = new Map([[domainScope.key, rule]]);
    const result = reconcilePresentRules({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry() } }),
      previous,
      full: true,
    });
    expect(result.changed).toBe(false);
    expect(result.rules).not.toBe(previous);
    expect(result.rules.get("example.com")).toBe(rule);
  });

  it("produces rules only for discovered Present scopes against a 10,000-entry cache", () => {
    const cache: Record<string, { url: string; fetchedAt: number; resolverVersion: number; domain: string }> = {};
    for (let index = 0; index < 10_000; index += 1) {
      const key = `domain-${index}.example.com`;
      cache[key] = { url: `icon-${index}.png`, fetchedAt: now - 1_000, resolverVersion: RESOLVER_VERSION, domain: key };
    }
    const discovery = [
      { key: "domain-0.example.com", domain: "domain-0.example.com" },
      { key: "domain-9999.example.com", domain: "domain-9999.example.com" },
    ];
    const result = reconcilePresentRules({
      discovery,
      context: context({ cache }),
      previous: new Map(),
      full: true,
    });
    expect([...result.rules.keys()]).toEqual([
      "domain-0.example.com",
      "domain-9999.example.com",
    ]);
    expect(result.rules.get("domain-0.example.com")).toBe(createIconRule(discovery[0], "icon-0.png", 1));
  });

  it("reconciles only the 500 scenario scopes against the 10,000-entry fixture cache", () => {
    const overlay = perfCacheOverlay(now);
    const scopes = perfScenarioScopes();
    const result = reconcilePresentRules({
      discovery: scopes,
      context: context({ cache: overlay }),
      previous: new Map(),
      full: true,
    });
    expect(Object.keys(overlay)).toHaveLength(PERF_CACHE_VIEW_ENTRIES);
    expect(result.rules.size).toBe(PERF_SCOPE_COUNT);
    const domainScope = scopes[0];
    expect(result.rules.get(domainScope.key)).toBe(createIconRule(
      domainScope,
      overlay[domainScope.key].url,
      1,
    ));
    const routeScope = scopeForUrl("https://nocode.host/p00019/ref-3")!;
    expect(result.rules.has(routeScope.key)).toBe(true);
    for (const key of result.rules.keys()) {
      expect(overlay[key]).toBeDefined();
    }
  });
});
