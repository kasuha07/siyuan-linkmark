import { describe, expect, it } from "vitest";
import { shareDomainFor } from "../src/parent-domain";
import {
  applyCacheChangeEvent,
  cachedIconForScope,
  FAILURE_COOLDOWN,
  isCacheEntryFresh,
  planScanDecision,
  type CacheEntry,
} from "../src/frontend-cache-state";

function entry(partial: Partial<CacheEntry> = {}): CacheEntry {
  return { url: "https://cdn.example.com/icon.png", fetchedAt: 1_000_000, ...partial };
}

const domainScope = { key: "example.com", domain: "example.com" };
const routeScope = { key: "docs.qq.com::doc", domain: "docs.qq.com", routeKey: "doc", pathPrefix: "/doc" };

describe("shareDomainFor", () => {
  it("keeps the domain itself when no parent exists", () => {
    expect(shareDomainFor("example.com")).toBe("example.com");
  });

  it("walks up to the parent domain", () => {
    expect(shareDomainFor("www.example.com")).toBe("example.com");
    expect(shareDomainFor("a.b.example.com")).toBe("b.example.com");
  });

  it("rejects addresses and malformed labels", () => {
    expect(shareDomainFor("127.0.0.1")).toBeNull();
    expect(shareDomainFor("example.com:8080")).toBeNull();
    expect(shareDomainFor("localhost")).toBeNull();
    expect(shareDomainFor("a..example.com")).toBeNull();
  });
});

describe("cachedIconForScope", () => {
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

  it("applies a subdomain-shared pin along the whole parent chain", () => {
    const cache = { "example.com": entry({ pinned: true, includeSubdomains: true }) };
    const scope = { key: "a.b.example.com", domain: "a.b.example.com" };
    expect(cachedIconForScope(cache, scope)?.cacheKey).toBe("example.com");
  });

  it("does not apply a pin that does not share subdomains", () => {
    const cache = { "example.com": entry({ pinned: true }) };
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

describe("applyCacheChangeEvent", () => {
  const epoch = "test-epoch";
  const base = () => ({
    "example.com": entry(),
    "docs.qq.com::doc": entry({ url: "route-icon.png", domain: "docs.qq.com" }),
  });

  it("applies upserts and removed keys to an isolated copy", () => {
    const cache = base();
    const upserted = entry({ url: "new-icon.png" });
    const application = applyCacheChangeEvent(cache, {
      epoch,
      revision: 7,
      upserts: { "new.example.com": upserted },
      removed: ["docs.qq.com::doc"],
    }, 6);

    expect(application).toMatchObject({ status: "applied", revision: 7 });
    if (application.status === "applied") {
      expect(application.cache).toEqual({
        "example.com": cache["example.com"],
        "new.example.com": upserted,
      });
      expect(application.cache["new.example.com"]).not.toBe(upserted);
      expect(cache).toEqual(base());
    }
  });

  it("treats the first event as valid without a prior revision", () => {
    const application = applyCacheChangeEvent({}, {
      epoch,
      revision: 12,
      upserts: { "example.com": entry() },
      removed: [],
    }, undefined);
    expect(application).toMatchObject({ status: "applied", revision: 12 });
    if (application.status === "applied") {
      expect(application.cache["example.com"]).toMatchObject({ url: "https://cdn.example.com/icon.png" });
    }
  });

  it("detects a revision gap and requests a snapshot refetch", () => {
    const application = applyCacheChangeEvent(base(), {
      epoch,
      revision: 9,
      upserts: { "new.example.com": entry() },
      removed: ["example.com"],
    }, 4);
    expect(application).toEqual({ status: "refetch", revision: 9 });
  });

  it("ignores stale events at or below the last seen revision", () => {
    for (const revision of [5, 4]) {
      const application = applyCacheChangeEvent(base(), {
        epoch,
        revision,
        upserts: { "new.example.com": entry() },
        removed: ["example.com"],
      }, 5);
      expect(application).toEqual({ status: "ignored" });
    }
  });

  it("ignores malformed events", () => {
    for (const event of [
      null,
      "cache",
      7,
      [],
      { upserts: {}, removed: [] },
      { revision: 1, removed: [] },
      { revision: 1, upserts: {} },
      { revision: "1", upserts: {}, removed: [] },
      { revision: 1, upserts: [], removed: [] },
      { revision: 1, upserts: {}, removed: "x" },
      { revision: Number.NaN, upserts: {}, removed: [] },
      { revision: 1, upserts: {}, removed: [], epoch: 7 },
      { revision: 1, upserts: {}, removed: [], epoch: undefined },
    ]) {
      expect(applyCacheChangeEvent(base(), event, 0)).toEqual({ status: "ignored" });
    }
  });

  it("keeps existing entries when an upserted entry is malformed", () => {
    const cache = base();
    const application = applyCacheChangeEvent(cache, {
      epoch,
      revision: 8,
      upserts: { "example.com": { fetchedAt: 1 }, "new.example.com": entry({ url: "ok.png" }) },
      removed: [],
    }, 7);
    expect(application.status).toBe("applied");
    if (application.status === "applied") {
      expect(application.cache["example.com"]).toBe(cache["example.com"]);
      expect(application.cache["new.example.com"]).toMatchObject({ url: "ok.png" });
    }
  });

  it("advances the tracked revision even for an empty event", () => {
    const application = applyCacheChangeEvent(base(), { epoch, revision: 3, upserts: {}, removed: [] }, 2);
    expect(application).toMatchObject({ status: "applied", revision: 3 });
  });

  it("requests a refetch when an event arrives from a different epoch", () => {
    const application = applyCacheChangeEvent(base(), {
      epoch: "other-epoch",
      revision: 1,
      upserts: { "new.example.com": entry() },
      removed: ["example.com"],
    }, 42, epoch);
    expect(application).toEqual({ status: "epoch-changed", revision: 1 });
  });

  it("applies an event whose epoch matches the expected epoch", () => {
    const application = applyCacheChangeEvent(base(), {
      epoch,
      revision: 43,
      upserts: { "new.example.com": entry() },
      removed: [],
    }, 42, epoch);
    expect(application.status).toBe("applied");
  });

  it("does not compare epochs when no expected epoch has been adopted yet", () => {
    const application = applyCacheChangeEvent({}, {
      epoch,
      revision: 3,
      upserts: { "example.com": entry() },
      removed: [],
    }, undefined);
    expect(application.status).toBe("applied");
  });
});
