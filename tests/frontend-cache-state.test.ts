import { describe, expect, it, vi } from "vitest";
import { shareDomainFor, shareEligibilityOf } from "../src/parent-domain";
import {
  cachedIconForScope,
  FAILURE_COOLDOWN,
  isCacheEntryFresh,
  planScanDecision,
  type CacheEntry,
} from "../src/frontend-cache-state";

vi.mock("../src/parent-domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/parent-domain")>();
  return { ...actual, shareEligibilityOf: vi.fn(actual.shareEligibilityOf) };
});

function entry(partial: Partial<CacheEntry> = {}): CacheEntry {
  return { url: "https://cdn.example.com/icon.png", fetchedAt: 1_000_000, ...partial };
}

const domainScope = { key: "example.com", domain: "example.com" };
const routeScope = { key: "docs.qq.com::doc", domain: "docs.qq.com", routeKey: "doc", pathPrefix: "/doc" };

describe("shareDomainFor", () => {
  it("keeps the domain itself when no parent exists", () => {
    expect(shareDomainFor("example.dev")).toBe("example.dev");
  });

  it("derives the single PSL eTLD+1", () => {
    expect(shareDomainFor("www.example.dev")).toBe("example.dev");
    expect(shareDomainFor("a.b.example.dev")).toBe("example.dev");
  });

  it("keeps tenant eTLD+1s under PSL Private suffixes", () => {
    expect(shareDomainFor("foo.github.io")).toBe("foo.github.io");
  });

  it("rejects addresses, special-use, and malformed labels", () => {
    expect(shareDomainFor("127.0.0.1")).toBeNull();
    expect(shareDomainFor("example.dev:8080")).toBeNull();
    expect(shareDomainFor("localhost")).toBeNull();
    expect(shareDomainFor("a..example.dev")).toBeNull();
    expect(shareDomainFor("foo.onion")).toBeNull();
    expect(shareDomainFor("x.home.arpa")).toBeNull();
    expect(shareDomainFor("example.com")).toBeNull();
  });
});

describe("cachedIconForScope", () => {
  it("derives shared-pin applicability from one eligibility result", () => {
    const eligibility = vi.mocked(shareEligibilityOf);
    eligibility.mockClear();
    const cache = { "example.dev": entry({ pinned: true, includeSubdomains: true }) };

    expect(cachedIconForScope(cache, {
      key: "a.example.dev",
      domain: "a.example.dev",
    })?.cacheKey).toBe("example.dev");
    expect(eligibility).toHaveBeenCalledOnce();
  });

  it("prefers the exact pinned entry over every other candidate", () => {
    const cache = {
      [domainScope.key]: entry({ pinned: true }),
      "www.example.com": entry({ pinned: true, includeSubdomains: true }),
      "shared.example.com": entry({ pinned: true, includeSubdomains: true }),
    };
    const match = cachedIconForScope(cache, domainScope);
    expect(match).toEqual({ cacheKey: domainScope.key, entry: cache[domainScope.key] });
  });

  it("lets a domain pinned entry serve route scopes", () => {
    const cache = { [routeScope.domain]: entry({ pinned: true }) };
    const match = cachedIconForScope(cache, routeScope);
    expect(match).toEqual({ cacheKey: routeScope.domain, entry: cache[routeScope.domain] });
  });

  it("applies a subdomain-shared pin within its eligible eTLD+1", () => {
    const cache = { "example.dev": entry({ pinned: true, includeSubdomains: true }) };
    const scope = { key: "a.b.example.dev", domain: "a.b.example.dev" };
    expect(cachedIconForScope(cache, scope)?.cacheKey).toBe("example.dev");
  });

  it("does not climb a parent chain to an intermediate shared pin", () => {
    const cache = { "b.example.dev": entry({ domain: "b.example.dev", pinned: true, includeSubdomains: true }) };
    const scope = { key: "a.b.example.dev", domain: "a.b.example.dev" };
    expect(cachedIconForScope(cache, scope)).toBeNull();
  });

  it("does not consult a shared pin across a PSL Private-suffix boundary", () => {
    const cache = { "foo.github.io": entry({ domain: "foo.github.io", pinned: true, includeSubdomains: true }) };
    expect(cachedIconForScope(cache, { key: "a.foo.github.io", domain: "a.foo.github.io" })).toBeNull();
  });

  it("serves an exact pinned entry for a private-suffix tenant scope", () => {
    const cache = { "foo.github.io": entry({ domain: "foo.github.io", pinned: true }) };
    expect(cachedIconForScope(cache, { key: "foo.github.io", domain: "foo.github.io" })?.cacheKey).toBe("foo.github.io");
  });

  it("does not re-enable a legacy shared pin at a public suffix", () => {
    const cache = { "github.io": entry({ domain: "github.io", pinned: true, includeSubdomains: true }) };
    expect(cachedIconForScope(cache, { key: "a.foo.github.io", domain: "a.foo.github.io" })).toBeNull();
  });

  it("does not apply a pin that does not share subdomains", () => {
    const cache = { "example.dev": entry({ pinned: true }) };
    expect(cachedIconForScope(cache, { key: "www.example.dev", domain: "www.example.dev" })).toBeNull();
  });

  it("does not apply a shared pin at a special-use name", () => {
    const cache = { "example.com": entry({ domain: "example.com", pinned: true, includeSubdomains: true }) };
    expect(cachedIconForScope(cache, { key: "www.example.com", domain: "www.example.com" })).toBeNull();
  });

  it("falls back to the exact or domain entry when nothing is pinned", () => {
    const exact = { [routeScope.key]: entry({ url: "route-icon.png" }) };
    expect(cachedIconForScope(exact, routeScope)?.cacheKey).toBe(routeScope.key);
    const domainOnly = { [routeScope.domain]: entry({ url: "domain-icon.png" }) };
    expect(cachedIconForScope(domainOnly, routeScope)?.cacheKey).toBe(routeScope.domain);
  });

  it("returns null when no entry applies", () => {
    expect(cachedIconForScope({}, routeScope)).toBeNull();
  });
});

describe("isCacheEntryFresh", () => {
  it("treats pinned entries as always fresh", () => {
    expect(isCacheEntryFresh(entry({ pinned: true, fetchedAt: 0 }), 1)).toBe(true);
  });

  it("treats cacheDays zero as never expiring", () => {
    expect(isCacheEntryFresh(entry({ fetchedAt: 0 }), 0)).toBe(true);
  });

  it("compares against the cache-days window", () => {
    const now = Date.now();
    expect(isCacheEntryFresh(entry({ fetchedAt: now }), 30)).toBe(true);
    expect(isCacheEntryFresh(entry({ fetchedAt: now - 31 * 86400000 }), 30)).toBe(false);
  });
});

describe("planScanDecision", () => {
  const now = 2_000_000;

  function decide(overrides: Partial<Parameters<typeof planScanDecision>[0]> = {}) {
    return planScanDecision({
      scopeKey: domainScope.key,
      scope: domainScope,
      cache: {},
      pauseAutomaticFetch: false,
      cacheDays: 30,
      failedAt: undefined,
      now,
      ...overrides,
    });
  }

  it("expires a stale cached entry when automatic fetch is active", () => {
    const cached = entry({ fetchedAt: now - 40 * 86400000 });
    const decision = decide({ cache: { [domainScope.key]: cached } });
    expect(decision).toEqual({ action: "expire", cacheKey: domainScope.key, entry: cached });
  });

  it("keeps a stale pinned entry without expiring it", () => {
    const cached = entry({ pinned: true, fetchedAt: 0 });
    expect(decide({ cache: { [domainScope.key]: cached } })).toEqual({
      action: "keep", entry: cached, fetch: false,
    });
  });

  it("keeps an exact match without fetching", () => {
    const cached = entry();
    expect(decide({ cache: { [domainScope.key]: cached } })).toEqual({
      action: "keep", entry: cached, fetch: false,
    });
  });

  it("keeps a domain fallback rule and refetches the route scope", () => {
    const cached = entry();
    const decision = decide({ scopeKey: routeScope.key, scope: routeScope, cache: { [routeScope.domain]: cached } });
    expect(decision).toEqual({ action: "keep", entry: cached, fetch: true });
  });

  it("skips fetching entirely while automatic fetch is paused", () => {
    const cached = entry({ pinned: false });
    expect(decide({ pauseAutomaticFetch: true, cache: { [domainScope.key]: cached } })).toEqual({
      action: "keep", entry: cached, fetch: false,
    });
    expect(decide({ pauseAutomaticFetch: true })).toEqual({ action: "skip" });
  });

  it("skips scopes inside the failure cooldown", () => {
    expect(decide({ failedAt: now - 5_000 })).toEqual({ action: "skip" });
    expect(decide({ failedAt: now - FAILURE_COOLDOWN })).toEqual({ action: "fetch" });
  });

  it("fetches missing scopes", () => {
    expect(decide()).toEqual({ action: "fetch" });
  });
});
