import { describe, expect, it } from "vitest";
import {
  createScopeQuery,
  planBindingSynchronization,
  presentIconBindingFor,
  reconcilePresentBindings,
  type PresentBindingContext,
} from "../src/icon-rule";
import { RESOLVER_VERSION } from "../src/resolver-contract";
import { perfScenarioScopes, PERF_SCOPE_COUNT } from "../src/perf-scenario";
import { PERF_CACHE_VIEW_ENTRIES } from "../src/perf-scenario-definition.js";
import { scopeForUrl } from "../src/url-scope";
import { largeCacheFixture } from "./perf-cache-fixture";

describe("createScopeQuery", () => {
  const domainScope = { key: "example.com", domain: "example.com" };

  it("builds transient exact and boundary queries for supported link elements", () => {
    const query = createScopeQuery(domainScope);
    expect(query).toContain(".protyle-wysiwyg span[data-type~='a'][data-href=\"https://example.com\"]");
    expect(query).toContain(".protyle-wysiwyg span[data-type~='url'][data-href^=\"https://example.com/\"]");
    expect(query).toContain(".protyle-wysiwyg a[href^=\"https://example.com?\"]");
    expect(query).toContain(".b3-typography a[href^=\"http://example.com:\"]");
    expect(query).not.toContain("::before");
  });

  it("uses route boundaries without treating a port as part of the route", () => {
    const routeScope = scopeForUrl("https://docs.qq.com/doc/abc")!;
    const query = createScopeQuery(routeScope);
    expect(query).toContain("[data-href=\"https://docs.qq.com/doc\"]");
    expect(query).toContain("[data-href^=\"https://docs.qq.com/doc/\"]");
    expect(query).not.toContain("[data-href^=\"https://docs.qq.com/doc:\"]");
  });
});

describe("Present icon bindings", () => {
  const now = Date.now();
  const domainScope = { key: "example.com", domain: "example.com" };
  const routeScope = { key: "docs.qq.com::doc", domain: "docs.qq.com", routeKey: "doc", pathPrefix: "/doc" };
  const context = (overrides: Partial<PresentBindingContext> = {}): PresentBindingContext => ({
    cache: {},
    cacheDays: 30,
    pauseAutomaticFetch: false,
    now,
    ...overrides,
  });
  const entry = (overrides: Record<string, unknown> = {}) => ({
    url: "icon.png",
    fetchedAt: now - 1_000,
    resolverVersion: RESOLVER_VERSION,
    domain: "example.com",
    ...overrides,
  });

  it("resolves fresh current entries to compact key/url bindings", () => {
    const result = reconcilePresentBindings({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry() } }),
      previous: new Map(),
    });
    expect(result.changed).toBe(true);
    expect(result.bindings).toEqual(new Map([[domainScope.key, "icon.png"]]));
  });

  it("rejects stale, legacy-version, and missing entries", () => {
    for (const cache of [
      { [domainScope.key]: entry({ fetchedAt: now - 40 * 86400000 }) },
      { [domainScope.key]: entry({ resolverVersion: RESOLVER_VERSION - 1 }) },
      {},
    ]) {
      expect(presentIconBindingFor(domainScope, context({ cache }))).toBeUndefined();
    }
  });

  it("uses one supplied evaluation time for every freshness decision", () => {
    const first = { key: "first.example.dev", domain: "first.example.dev" };
    const second = { key: "second.example.dev", domain: "second.example.dev" };
    const evaluationTime = 10_000;
    const result = reconcilePresentBindings({
      discovery: [first, second],
      context: context({
        now: evaluationTime,
        cacheDays: 1,
        cache: {
          [first.key]: entry({ domain: first.domain, fetchedAt: evaluationTime - 1, url: "first.png" }),
          [second.key]: entry({ domain: second.domain, fetchedAt: evaluationTime - 1, url: "second.png" }),
        },
      }),
      previous: new Map(),
    });

    expect(result.bindings).toEqual(new Map([
      [first.key, "first.png"],
      [second.key, "second.png"],
    ]));
  });

  it("keeps stale Pinned entries and paused legacy monograms", () => {
    expect(presentIconBindingFor(domainScope, context({
      cache: { [domainScope.key]: entry({ pinned: true, fetchedAt: 0 }) },
    }))).toEqual({ key: domainScope.key, iconUrl: "icon.png" });
    expect(presentIconBindingFor(domainScope, context({
      pauseAutomaticFetch: true,
      cache: {
        [domainScope.key]: entry({
          source: "generated monogram",
          resolverVersion: RESOLVER_VERSION - 1,
          fetchedAt: 0,
        }),
      },
    }))).toEqual({ key: domainScope.key, iconUrl: "icon.png" });
  });

  it("binds a route to the Pinned domain that governs its final icon", () => {
    const binding = presentIconBindingFor(routeScope, context({
      cache: {
        [routeScope.key]: entry({ domain: routeScope.domain, url: "route-icon.png" }),
        [routeScope.domain]: entry({ pinned: true, domain: routeScope.domain, url: "pinned-icon.png" }),
      },
    }));
    expect(binding).toEqual({ key: routeScope.domain, iconUrl: "pinned-icon.png" });
  });

  it("plans direct CSSOM updates when final binding keys stay unchanged", () => {
    const before = context({ cache: { [domainScope.key]: entry({ url: "old.png" }) } });
    const after = context({ cache: { [domainScope.key]: entry({ url: "new.png" }) } });
    expect(planBindingSynchronization({
      scopes: [domainScope],
      before,
      after,
      changedKeys: [domainScope.key],
    })).toEqual({ kind: "rules" });
  });

  it("plans targeted discovery for an ordinary exact binding change", () => {
    const before = context({
      cache: { [routeScope.domain]: entry({ domain: routeScope.domain, url: "domain.png" }) },
    });
    const after = context({
      cache: {
        ...before.cache,
        [routeScope.key]: entry({ domain: routeScope.domain, url: "route.png" }),
      },
    });
    expect(planBindingSynchronization({
      scopes: [routeScope],
      before,
      after,
      changedKeys: [routeScope.key],
    })).toEqual({ kind: "targeted", scopes: [routeScope] });
  });

  it("uses one evaluation time for a before-and-after freshness comparison", () => {
    const evaluationTime = 86_400_001;
    const before = context({
      now: evaluationTime,
      cacheDays: 1,
      cache: { [domainScope.key]: entry({ fetchedAt: 0 }) },
    });
    const after = context({
      now: evaluationTime,
      cacheDays: 1,
      cache: { [domainScope.key]: entry({ fetchedAt: 1 }) },
    });

    expect(planBindingSynchronization({
      scopes: [domainScope],
      before,
      after,
      changedKeys: [domainScope.key],
    })).toEqual({ kind: "targeted", scopes: [domainScope] });
  });

  it("plans Full discovery for Pinned precedence and broad changes", () => {
    const before = context({ cache: { [domainScope.key]: entry() } });
    const pinned = context({ cache: { [domainScope.key]: entry({ pinned: true }) } });
    expect(planBindingSynchronization({
      scopes: [domainScope],
      before,
      after: pinned,
      changedKeys: [domainScope.key],
    })).toEqual({ kind: "full" });

    const scopes = Array.from({ length: 9 }, (_, index) => ({
      key: `scope-${index}.example.com`,
      domain: `scope-${index}.example.com`,
    }));
    const after = context({ cache: Object.fromEntries(scopes.map((scope) => [scope.key, entry({ domain: scope.domain })])) });
    expect(planBindingSynchronization({
      scopes,
      before: context(),
      after,
      changedKeys: scopes.map((scope) => scope.key),
    })).toEqual({ kind: "full" });
  });

  it("reports changes only when the compact binding map changes", () => {
    const previous = new Map([[domainScope.key, "icon.png"]]);
    const unchanged = reconcilePresentBindings({
      discovery: [domainScope],
      context: context({ cache: { [domainScope.key]: entry() } }),
      previous,
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.bindings).not.toBe(previous);

    const departed = reconcilePresentBindings({
      discovery: [],
      context: context(),
      previous,
    });
    expect(departed.changed).toBe(true);
    expect(departed.bindings.size).toBe(0);
  });

  it("reads only discovered scopes from a 10,000-entry cache", () => {
    const cache: PresentBindingContext["cache"] = {};
    for (let index = 0; index < 10_000; index += 1) {
      const key = `domain-${index}.example.com`;
      cache[key] = entry({ domain: key, url: `icon-${index}.png` });
    }
    const discovery = [
      { key: "domain-0.example.com", domain: "domain-0.example.com" },
      { key: "domain-9999.example.com", domain: "domain-9999.example.com" },
    ];
    const result = reconcilePresentBindings({
      discovery,
      context: context({ cache }),
      previous: new Map(),
    });
    expect(result.bindings).toEqual(new Map([
      ["domain-0.example.com", "icon-0.png"],
      ["domain-9999.example.com", "icon-9999.png"],
    ]));
  });

  it("produces exactly 500 bindings for the standard scenario", () => {
    const cache = largeCacheFixture(now);
    const result = reconcilePresentBindings({
      discovery: perfScenarioScopes(),
      context: context({ cache }),
      previous: new Map(),
    });
    expect(Object.keys(cache)).toHaveLength(PERF_CACHE_VIEW_ENTRIES);
    expect(result.bindings.size).toBe(PERF_SCOPE_COUNT);
  });
});
