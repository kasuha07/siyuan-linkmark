import { describe, expect, it, vi } from "vitest";
import {
  KernelCacheAuthority,
  ResolutionError,
  type CacheChangeEvent,
  type CacheEntry,
  type CacheStorage,
  type LinkScope,
} from "../src/cache-authority";
import { privateIconIdFromPath } from "../src/private-route";
import { INVALID_SHARE_DOMAIN } from "../src/parent-domain";
import { fetchOutcomeFor, outcomeForCacheRequest } from "../src/refresh-outcome";
import { ForwardProxyIconResolver, type ForwardProxy, type KernelResolverPolicy } from "../src/kernel-resolver";
import type { ResolutionTraceRecord, ResolutionTraceSink } from "../src/resolution-trace";

class MemoryStorage implements CacheStorage {
  readonly files = new Map<string, string>();
  failNextPut = false;

  async get(path: string) {
    return this.files.get(path);
  }

  async put(path: string, content: string) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated storage failure");
    }
    this.files.set(path, content);
  }

  async remove(path: string) {
    this.files.delete(path);
  }
}

class BlockingCacheIndexStorage extends MemoryStorage {
  private blockNextIndexWrite = false;
  private releaseIndexWrite?: () => void;
  private resolveIndexWriteStarted!: () => void;
  private readonly indexWriteStarted = new Promise<void>((resolve) => {
    this.resolveIndexWriteStarted = resolve;
  });

  blockNextCacheIndexWrite() {
    this.blockNextIndexWrite = true;
    return this.indexWriteStarted;
  }

  releaseCacheIndexWrite() {
    this.releaseIndexWrite?.();
  }

  override async put(path: string, content: string) {
    if (path === "favicon-cache-v2.json" && this.blockNextIndexWrite) {
      this.blockNextIndexWrite = false;
      this.resolveIndexWriteStarted();
      await new Promise<void>((resolve) => { this.releaseIndexWrite = resolve; });
    }
    await super.put(path, content);
  }
}

class CountingCacheIndexStorage extends MemoryStorage {
  cacheIndexWrites = 0;

  override async put(path: string, content: string) {
    if (path === "favicon-cache-v2.json") {
      this.cacheIndexWrites += 1;
    }
    await super.put(path, content);
  }
}

class FailingCacheIndexStorage extends CountingCacheIndexStorage {
  override async put(path: string, content: string) {
    if (path === "favicon-cache-v2.json") {
      this.cacheIndexWrites += 1;
      throw new Error("cache-index write failed");
    }
    this.files.set(path, content);
  }
}

class RecordingOrderStorage extends MemoryStorage {
  readonly operations: string[] = [];

  override async put(path: string, content: string) {
    this.operations.push(`write ${path}`);
    await super.put(path, content);
  }

  override async remove(path: string) {
    this.operations.push(`remove ${path}`);
    await super.remove(path);
  }
}

const scope = (key = "example.com"): LinkScope => ({
  key,
  domain: "example.com",
  targetUrl: "https://example.com/",
});

const entry = (overrides: Partial<CacheEntry> = {}): CacheEntry => ({
  url: "",
  fetchedAt: 1,
  source: "test resolver",
  domain: "example.com",
  ...overrides,
});

const resolverPolicy: KernelResolverPolicy = {
  provider: "https://example.com/favicon/{domain}", providerPreset: "auto", resolverMode: "direct",
  fallbackMode: "none", allowFullPageDiscovery: false, monogramColorMode: "domain",
  monogramPrimary: "#4F7CFF", monogramSecondary: "#745CFF", monogramText: "#FFFFFF",
  monogramShape: "rounded", monogramOverrides: {},
};

const resolved = (source = "test resolver"): { bytes: ArrayBuffer; contentType: string; source: string } => ({
  bytes: new Uint8Array([1, 2, 3]).buffer,
  contentType: "image/png",
  source,
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function snapshotCache(authority: KernelCacheAuthority): Record<string, CacheEntry> {
  return authority.snapshot().cache;
}

class RecordingTrace {
  readonly records: ResolutionTraceRecord[] = [];
  readonly sink: ResolutionTraceSink = (record) => { this.records.push(record); };
  events() {
    return this.records.map((record) => record.event);
  }
}

const ALLOWED_RECORD_KEYS = new Set([
  "schema", "event", "task", "scope", "trigger", "elapsedMs",
  "ordinal", "source", "outcome", "status", "contentType", "bytes", "remainingBudgetMs", "category",
]);

function expectSanitizedRecords(records: ResolutionTraceRecord[]) {
  for (const record of records) {
    for (const key of Object.keys(record)) {
      expect(ALLOWED_RECORD_KEYS.has(key)).toBe(true);
    }
    expect(record.scope).toMatchObject({ key: expect.any(String), domain: expect.any(String) });
    expect(record.schema).toBe(1);
  }
}

function subscribers() {
  const cacheEvents: CacheChangeEvent[] = [];
  const waitFor = async (predicate: (events: CacheChangeEvent[]) => boolean, description: string) => {
    await vi.waitFor(() => {
      if (!predicate(cacheEvents)) throw new Error(`timed out waiting for ${description}`);
    }, { timeout: 2000 });
  };
  return {
    cacheEvents,
    waitForCache: waitFor,
  };
}

describe("KernelCacheAuthority", () => {
  it("does not report a generated monogram as a remote refresh success", () => {
    expect(fetchOutcomeFor(entry({ source: "FaviconKit" }))).toBe("success");
    expect(fetchOutcomeFor(entry({ source: "generated monogram" }))).toBe("fallback");
    expect(fetchOutcomeFor(null)).toBe("failure");
    expect(outcomeForCacheRequest({ status: "ready", entry: entry({ source: "FaviconKit" }) })).toBe("success");
    expect(outcomeForCacheRequest({ status: "ready", entry: entry({ source: "generated monogram" }) })).toBe("fallback");
    expect(outcomeForCacheRequest({ status: "queued" })).toBe("queued");
    expect(outcomeForCacheRequest({ status: "unavailable" })).toBe("unavailable");
  });

  it("matches only its complete private icon route", () => {
    expect(privateIconIdFromPath("/plugin/private/siyuan-linkmark/icon/example-1", "siyuan-linkmark")).toBe("example-1");
    expect(privateIconIdFromPath("/icon/example-1", "siyuan-linkmark")).toBeUndefined();
    expect(privateIconIdFromPath("/plugin/private/siyuan-linkmark/icon/%2Fetc", "siyuan-linkmark")).toBeUndefined();
  });

  it("returns a fresh cache hit as ready without resolver work", async () => {
    const resolve = vi.fn(async () => null);
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => 100, {
      cachePolicy: { cacheDays: 30 },
    });
    await authority.initialize();
    const pinned = await authority.putPinned(scope(), entry({ pinned: true }), "image/png", new Uint8Array([9]).buffer);

    const result = await authority.getOrQueue(scope());

    expect(result).toEqual({ status: "ready", entry: expect.objectContaining({ iconId: pinned.iconId, pinned: true }) });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns a committed cache hit as ready without resolver work", async () => {
    const watched = subscribers();
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => 100, {
      onCacheChanged: (event) => { watched.cacheEvents.push(event); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await watched.waitForCache((events) => events.length === 1, "the first commit broadcast");
    expect(resolve).toHaveBeenCalledTimes(1);

    const result = await authority.getOrQueue(scope());
    expect(result).toEqual({ status: "ready", entry: expect.objectContaining({ source: "test resolver" }) });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("refetches a stale cache entry", async () => {
    let now = 1_000;
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => now, {
      cachePolicy: { cacheDays: 30 },
    });
    await authority.initialize();

    await authority.getOrQueue(scope());
    await vi.waitFor(() => expect(snapshotCache(authority)["example.com"]).toBeDefined());
    now += 31 * 86400000;

    const result = await authority.getOrQueue(scope());
    await vi.waitFor(() => expect(snapshotCache(authority)["example.com"]?.fetchedAt).toBe(now));

    expect(result).toEqual({ status: "queued" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("never expires entries while cacheDays is zero", async () => {
    let now = 1_000;
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => now, {
      cachePolicy: { cacheDays: 0 },
    });
    await authority.initialize();

    await authority.getOrQueue(scope());
    await vi.waitFor(() => expect(snapshotCache(authority)["example.com"]).toBeDefined());
    now += 3650 * 86400000;

    await expect(authority.getOrQueue(scope())).resolves.toEqual({
      status: "ready",
      entry: expect.objectContaining({ fetchedAt: 1_000 }),
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("generates unique private icon names under a frozen clock", async () => {
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => 1_000);
    await authority.initialize();

    await authority.getOrQueue(scope("example.com"));
    await authority.getOrQueue({ key: "example.com::doc", domain: "example.com", targetUrl: "https://example.com/doc" });
    await vi.waitFor(() => expect(Object.keys(snapshotCache(authority))).toHaveLength(2));

    const [first, second] = Object.values(snapshotCache(authority)).map((entry) => entry.iconId!);
    expect(first).not.toBe(second);
    for (const iconId of [first, second]) {
      expect(iconId).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(privateIconIdFromPath(`/plugin/private/siyuan-linkmark/icon/${iconId}`, "siyuan-linkmark")).toBe(iconId);
    }
  });

  it("commits a resolved icon when queueMicrotask is unavailable", async () => {
    const watched = subscribers();
    vi.stubGlobal("queueMicrotask", undefined);
    try {
      const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve: async () => resolved() }, () => 100, {
        onCacheChanged: (event) => { watched.cacheEvents.push(event); },
      });
      await authority.initialize();

      await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
      await watched.waitForCache((events) => Boolean(events[0]?.upserts["example.com"]), "the committed entry broadcast");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("acknowledges a cache miss as queued before resolution or persistence completes", async () => {
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => 100);
    await authority.initialize();

    const result = await authority.getOrQueue(scope());

    expect(result).toEqual({ status: "queued" });
    expect(snapshotCache(authority)).toEqual({});
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    expect(snapshotCache(authority)).toEqual({});
  });

  it("returns queued while the cache-index persistence of an earlier task is still in flight", async () => {
    const storage = new BlockingCacheIndexStorage();
    const watched = subscribers();
    const authority = new KernelCacheAuthority(storage, { resolve: async () => resolved() }, () => 100, {
      onCacheChanged: (event) => { watched.cacheEvents.push(event); },
    });
    await authority.initialize();
    const indexWriteStarted = storage.blockNextCacheIndexWrite();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await indexWriteStarted;
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    storage.releaseCacheIndexWrite();

    await watched.waitForCache((events) => Boolean(events[0]?.upserts["example.com"]), "the committed entry broadcast");
    expect(snapshotCache(authority)["example.com"]).toMatchObject({ source: "test resolver" });
  });

  it("coalesces concurrent requests for the same Link scope", async () => {
    const watched = subscribers();
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    let calls = 0;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => {
        calls += 1;
        return await new Promise((resolve) => { resolveDownload = resolve; });
      },
    }, () => 100, {
      onCacheChanged: (event) => { watched.cacheEvents.push(event); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(calls).toBe(1));

    resolveDownload?.(resolved());
    await watched.waitForCache((events) => Boolean(events[0]?.upserts["example.com"]), "the committed entry broadcast");
    expect(calls).toBe(1);
    expect(watched.cacheEvents[0].upserts["example.com"]).toMatchObject({
      domain: "example.com",
      source: "test resolver",
      url: expect.stringContaining("/api/plugin/private/siyuan-linkmark/icon/"),
    });
  });

  it("resolves at most four distinct Link scopes concurrently while coalescing matching requests", async () => {
    const releases = new Map<string, () => void>();
    let active = 0;
    let peakActive = 0;
    let calls = 0;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => {
        calls += 1;
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise<void>((resolve) => releases.set(requested.key, resolve));
        active -= 1;
        return resolved(requested.key);
      },
    }, () => 100);
    await authority.initialize();

    const results = await Promise.all([
      authority.getOrQueue(scope("one.example.com")),
      authority.getOrQueue(scope("two.example.com")),
      authority.getOrQueue(scope("three.example.com")),
      authority.getOrQueue(scope("four.example.com")),
      authority.getOrQueue(scope("five.example.com")),
      authority.getOrQueue(scope("one.example.com")),
    ]);
    expect(results).toEqual([
      { status: "queued" }, { status: "queued" }, { status: "queued" },
      { status: "queued" }, { status: "queued" }, { status: "queued" },
    ]);

    await vi.waitFor(() => expect(active).toBe(4));
    expect(calls).toBe(4);

    releases.get("one.example.com")?.();
    await vi.waitFor(() => expect(releases.has("five.example.com")).toBe(true));
    expect(active).toBe(4);
    for (const key of ["two.example.com", "three.example.com", "four.example.com", "five.example.com"]) {
      releases.get(key)?.();
    }

    await settle();
    expect(calls).toBe(5);
    expect(peakActive).toBe(4);
  });

  it("does not start an invalidated Link scope that is waiting for a resolution slot", async () => {
    const releases = new Map<string, () => void>();
    const calls: string[] = [];
    const failures: Array<{ key: string; category: string }> = [];
    let active = 0;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => {
        calls.push(requested.key);
        active += 1;
        await new Promise<void>((resolve) => releases.set(requested.key, resolve));
        active -= 1;
        return resolved(requested.key);
      },
    }, () => 100, {
      onResolutionFailure: (failedScope, category) => { failures.push({ key: failedScope.key, category }); },
    });
    await authority.initialize();

    const running = ["one.example.com", "two.example.com", "three.example.com", "four.example.com"]
      .map((key) => authority.getOrQueue(scope(key)));
    await Promise.all(running);
    await vi.waitFor(() => expect(active).toBe(4));
    await expect(authority.getOrQueue(scope("queued.example.com"))).resolves.toEqual({ status: "queued" });
    await authority.remove("queued.example.com");

    releases.get("one.example.com")?.();
    await settle();
    expect(calls).not.toContain("queued.example.com");
    expect(failures).toEqual([]);

    for (const key of ["two.example.com", "three.example.com", "four.example.com"]) releases.get(key)?.();
    await settle();
  });

  it("declines automatic work while the workspace policy is paused", async () => {
    const storage = new MemoryStorage();
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(storage, { resolve }, () => 100, {
      cachePolicy: { cacheDays: 30, pauseAutomaticFetch: true },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope(), false, true)).resolves.toEqual({ status: "unavailable" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("still serves an existing entry when automatic work is paused", async () => {
    const storage = new MemoryStorage();
    const resolve = vi.fn(async () => null);
    const authority = new KernelCacheAuthority(storage, { resolve }, () => 100, {
      cachePolicy: { cacheDays: 30, pauseAutomaticFetch: true },
    });
    await authority.initialize();
    await authority.putPinned(scope(), entry({ pinned: true }), "image/png", new Uint8Array([1]).buffer);

    const result = await authority.getOrQueue(scope(), false, true);

    expect(result).toEqual({ status: "ready", entry: expect.objectContaining({ pinned: true }) });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps manual refresh work available while the policy is paused", async () => {
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => 100, {
      cachePolicy: { cacheDays: 30, pauseAutomaticFetch: true },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope(), false, false)).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
  });

  it("broadcasts isolated upsert entry copies without structuredClone in the kernel runtime", async () => {
    const received: CacheChangeEvent[] = [];
    vi.stubGlobal("structuredClone", undefined);
    try {
      const authority = new KernelCacheAuthority(new MemoryStorage(), {
        resolve: async () => resolved(),
      }, () => 100, {
        onCacheChanged: (event) => { received.push(event); },
      });
      await authority.initialize();

      await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      received[0].upserts["example.com"].source = "subscriber mutation";
      const snapshot = snapshotCache(authority);
      snapshot["example.com"].source = "caller mutation";

      expect(snapshotCache(authority)["example.com"]).toMatchObject({ source: "test resolver" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not let an invalidated download recreate a deleted cache entry", async () => {
    const storage = new MemoryStorage();
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => 100);
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    await authority.remove(scope().key);
    resolveDownload?.(resolved());

    await settle();
    expect(snapshotCache(authority)).toEqual({});
    expect(storage.files.has("icons/example.com.base64")).toBe(false);
  });

  it("does not broadcast a failure for an invalidated task", async () => {
    const storage = new MemoryStorage();
    let resolveDownload: ((value: null) => void) | undefined;
    const failures: Array<{ key: string; category: string }> = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => 100, {
      onResolutionFailure: (failedScope, category) => { failures.push({ key: failedScope.key, category }); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    await authority.remove(scope().key);
    resolveDownload?.(null);

    await settle();
    expect(failures).toEqual([]);
    expect(snapshotCache(authority)).toEqual({});
  });

  it("starts a replacement task after an invalidated scope finishes", async () => {
    const watched = subscribers();
    const releases: Array<() => void> = [];
    let calls = 0;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => {
        const call = ++calls;
        await new Promise<void>((resolve) => releases.push(resolve));
        return resolved(`resolver ${call}`);
      },
    }, () => 100, {
      onCacheChanged: (event) => { watched.cacheEvents.push(event); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(calls).toBe(1));
    await authority.remove(scope().key);
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });

    releases[0]?.();
    await vi.waitFor(() => expect(calls).toBe(2));
    releases[1]?.();

    await watched.waitForCache((events) => Boolean(events[0]?.upserts["example.com"]), "the replacement commit broadcast");
    expect(snapshotCache(authority)).toEqual({
      "example.com": expect.objectContaining({ source: "resolver 2" }),
    });
  });

  it("persists concurrent resolved scopes in one cache-index batch and broadcasts one change event", async () => {
    const storage = new CountingCacheIndexStorage();
    const received: CacheChangeEvent[] = [];
    const releaseDownloads: Array<() => void> = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async (requested) => {
        await new Promise<void>((resolve) => { releaseDownloads.push(resolve); });
        return resolved(requested.key);
      },
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();

    const first = authority.getOrQueue(scope("first.example.com"));
    const second = authority.getOrQueue(scope("second.example.com"));
    await expect(first).resolves.toEqual({ status: "queued" });
    await expect(second).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(releaseDownloads).toHaveLength(2));
    releaseDownloads.forEach((release) => release());

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(storage.cacheIndexWrites).toBe(1);
    expect(received).toEqual([
      {
        epoch: expect.any(String),
        revision: 1,
        upserts: {
          "first.example.com": expect.objectContaining({ source: "first.example.com" }),
          "second.example.com": expect.objectContaining({ source: "second.example.com" }),
        },
        removed: [],
      },
    ]);
    expect(snapshotCache(authority)).toEqual({
      "first.example.com": expect.objectContaining({ source: "first.example.com" }),
      "second.example.com": expect.objectContaining({ source: "second.example.com" }),
    });
  });

  it("returns the cache with its revision and epoch from the snapshot", async () => {
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => resolved(),
    }, () => 100);
    await authority.initialize();

    expect(authority.snapshot()).toEqual({
      cache: {},
      revision: 0,
      epoch: expect.any(String),
    });
  });

  it("tags every change event with the epoch and advances the snapshot revision", async () => {
    const received: CacheChangeEvent[] = [];
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => resolved(),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope("first.example.com"))).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await authority.remove("first.example.com");
    await vi.waitFor(() => expect(received).toHaveLength(2));

    expect(received[0].epoch).toBe(received[1].epoch);
    expect(received.map((event) => event.revision)).toEqual([1, 2]);
    expect(authority.snapshot()).toEqual({
      cache: {},
      revision: 2,
      epoch: received[0].epoch,
    });
  });

  it("uses a fresh epoch for a new authority instance", async () => {
    const first = new KernelCacheAuthority(new MemoryStorage(), { resolve: async () => resolved() }, () => 100);
    const second = new KernelCacheAuthority(new MemoryStorage(), { resolve: async () => resolved() }, () => 100);
    await first.initialize();
    await second.initialize();

    expect(first.snapshot().epoch).not.toBe(second.snapshot().epoch);
  });

  it("does not publish any resolved scope when its cache-index batch fails", async () => {
    const storage = new FailingCacheIndexStorage();
    const received: CacheChangeEvent[] = [];
    const failures: Array<{ key: string; category: string }> = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async (requested) => resolved(requested.key),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
      onResolutionFailure: (failedScope, category) => { failures.push({ key: failedScope.key, category }); },
    });
    await authority.initialize();

    const first = authority.getOrQueue(scope("first.example.com"));
    const second = authority.getOrQueue(scope("second.example.com"));
    await expect(first).resolves.toEqual({ status: "queued" });
    await expect(second).resolves.toEqual({ status: "queued" });

    await settle();
    expect(storage.cacheIndexWrites).toBe(1);
    expect(received).toEqual([]);
    expect(failures).toEqual([]);
    expect(snapshotCache(authority)).toEqual({});
    expect([...storage.files.keys()].filter((path) => path.startsWith("icons/"))).toEqual([]);
  });

  it("does not return an entry removed while its cache-index write is in flight", async () => {
    const storage = new BlockingCacheIndexStorage();
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => resolved(),
    }, () => 100);
    await authority.initialize();
    const indexWriteStarted = storage.blockNextCacheIndexWrite();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await indexWriteStarted;
    const removal = authority.remove(scope().key);
    storage.releaseCacheIndexWrite();

    await removal;
    await settle();
    expect(snapshotCache(authority)).toEqual({});
    expect(storage.files.has("icons/example.com.base64")).toBe(false);
  });

  it("does not let a cache clear recreate an in-flight cache miss", async () => {
    const storage = new MemoryStorage();
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => 100);
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    await authority.clear();
    resolveDownload?.(resolved());

    await settle();
    expect(snapshotCache(authority)).toEqual({});
  });

  it("retains pinned entries when clearing the workspace cache", async () => {
    const storage = new MemoryStorage();
    const received: CacheChangeEvent[] = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => resolved(),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();
    await authority.putPinned(scope("pinned.example.com"), entry({ domain: "pinned.example.com", pinned: true }), "image/png", new Uint8Array([9]).buffer);
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await authority.clear();

    expect(snapshotCache(authority)).toEqual({
      "pinned.example.com": expect.objectContaining({ pinned: true }),
    });
  });

  it("keeps the prior pinned icon when staging a replacement fails", async () => {
    const storage = new MemoryStorage();
    const resolve = vi.fn(async () => null);
    const authority = new KernelCacheAuthority(storage, { resolve }, () => 100);
    await authority.initialize();
    const first = await authority.putPinned(scope(), entry({ pinned: true }), "image/png", new Uint8Array([1]).buffer);
    storage.failNextPut = true;

    await expect(authority.putPinned(scope(), entry({ pinned: true }), "image/png", new Uint8Array([2]).buffer)).rejects.toThrow("simulated storage failure");

    expect(snapshotCache(authority)["example.com"]).toMatchObject({ iconId: first.iconId, pinned: true });
    await expect(authority.icon(first.iconId!)).resolves.toMatchObject({ contentType: "image/png" });
    const result = await authority.getOrQueue(scope());
    expect(result).toEqual({ status: "ready", entry: expect.objectContaining({ iconId: first.iconId, pinned: true }) });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps the unaffected pinned scope available when a two-key pin is superseded", async () => {
    const storage = new BlockingCacheIndexStorage();
    const resolve = vi.fn(async () => null);
    const authority = new KernelCacheAuthority(storage, { resolve }, () => 100);
    await authority.initialize();
    const original = await authority.putPinned(
      scope("first.example.com"),
      entry({ domain: "first.example.com", pinned: true }),
      "image/png",
      new Uint8Array([1]).buffer,
    );
    await authority.putPinned(
      scope("second.example.com"),
      entry({ domain: "second.example.com", pinned: true }),
      "image/png",
      new Uint8Array([2]).buffer,
    );
    const indexWriteStarted = storage.blockNextCacheIndexWrite();

    const replacement = authority.putPinned(
      scope("first.example.com"),
      entry({ domain: "first.example.com", pinned: true }),
      "image/png",
      new Uint8Array([3]).buffer,
      "second.example.com",
    );
    await indexWriteStarted;
    const removal = authority.remove("second.example.com");
    storage.releaseCacheIndexWrite();

    await expect(replacement).rejects.toThrow("superseded");
    await removal;
    const result = await authority.getOrQueue(scope("first.example.com"));
    expect(result).toEqual({ status: "ready", entry: expect.objectContaining({ iconId: original.iconId, pinned: true }) });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not import or delete the old plugin cache", async () => {
    const storage = new MemoryStorage();
    storage.files.set("favicon-cache.json", JSON.stringify({
      "pinned.example.com": entry({ domain: "pinned.example.com", pinned: true, url: "/public/auto-favicon/pinned.png" }),
    }));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);

    await authority.initialize();

    expect(snapshotCache(authority)).toEqual({});
    expect(storage.files.has("favicon-cache-v2.json")).toBe(false);
    expect(storage.files.get("favicon-cache.json")).toContain("pinned.example.com");
  });

  it("loads pinned icons already stored in the Linkmark cache", async () => {
    const storage = new MemoryStorage();
    storage.files.set("favicon-cache-v2.json", JSON.stringify({
      "pinned.example.dev": entry({
        domain: "pinned.example.dev",
        pinned: true,
        url: "/plugin/private/siyuan-linkmark/icon/pinned-1",
        iconId: "pinned-1",
        contentType: "image/png",
      }),
    }));
    storage.files.set("icons/pinned-1.base64", Buffer.from([9, 8, 7]).toString("base64"));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);

    await authority.initialize();

    expect(snapshotCache(authority)["pinned.example.dev"]).toMatchObject({
      pinned: true,
      url: "/plugin/private/siyuan-linkmark/icon/pinned-1",
      iconId: "pinned-1",
    });
    await expect(authority.icon("pinned-1")).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("keeps distinct route Link scopes independent", async () => {
    const received: CacheChangeEvent[] = [];
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => resolved(requested.key),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();

    await Promise.all([
      authority.getOrQueue({ ...scope("docs.example.com::doc"), domain: "docs.example.com" }),
      authority.getOrQueue({ ...scope("docs.example.com::sheet"), domain: "docs.example.com" }),
    ]);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(snapshotCache(authority)).toEqual({
      "docs.example.com::doc": expect.objectContaining({ source: "docs.example.com::doc" }),
      "docs.example.com::sheet": expect.objectContaining({ source: "docs.example.com::sheet" }),
    });
  });

  it("publishes a refreshed icon under a new private payload before cleaning the old payload", async () => {
    const storage = new MemoryStorage();
    const received: CacheChangeEvent[] = [];
    let byte = 1;
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => resolved(`test resolver ${byte++}`),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const first = received[0].upserts["example.com"];

    await expect(authority.getOrQueue(scope(), true)).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const second = received[1].upserts["example.com"];

    expect(first.iconId).not.toBe(second.iconId);
    await expect(authority.icon(first.iconId!)).resolves.toBeUndefined();
    await expect(authority.icon(second.iconId!)).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("broadcasts a sanitized resolution failure without an entry or payload leak", async () => {
    const storage = new MemoryStorage();
    const failures: Array<{ key: string; category: string }> = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => { throw new ResolutionError("network"); },
    }, () => 100, {
      onResolutionFailure: (failedScope, category) => { failures.push({ key: failedScope.key, category }); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toEqual({ key: "example.com", category: "network" });
    expect(snapshotCache(authority)).toEqual({});
    expect([...storage.files.keys()].filter((path) => path.startsWith("icons/"))).toEqual([]);
  });

  it("reports resolver exhaustion as a sanitized failure", async () => {
    const failures: Array<{ key: string; category: string }> = [];
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => null,
    }, () => 100, {
      onResolutionFailure: (failedScope, category) => { failures.push({ key: failedScope.key, category }); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toEqual({ key: "example.com", category: "exhausted" });
    expect(snapshotCache(authority)).toEqual({});
  });

  it("traces a cache miss from acceptance through resolve, persist, and commit", async () => {
    let now = 100;
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    const trace = new RecordingTrace();
    const watched = subscribers();
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => now, {
      traceSink: trace.sink,
      onCacheChanged: (event) => { watched.cacheEvents.push(event); },
    });
    await authority.initialize();

    const result = await authority.getOrQueue(scope());

    expect(result).toEqual({ status: "queued" });
    expect(trace.events()).toEqual(["accepted", "started"]);
    expect(trace.records[0]).toMatchObject({
      schema: 1, event: "accepted", trigger: "manual",
      scope: { key: "example.com", domain: "example.com" }, elapsedMs: 0,
    });
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));

    now = 160;
    resolveDownload?.(resolved());
    await watched.waitForCache((events) => Boolean(events[0]?.upserts["example.com"]), "the committed entry broadcast");

    expect(trace.events()).toEqual(["accepted", "started", "resolved", "persisted", "committed"]);
    expect(new Set(trace.records.map((record) => record.task)).size).toBe(1);
    expect(trace.records[2]).toMatchObject({
      event: "resolved", elapsedMs: 60, source: "test resolver", contentType: "image/png", bytes: 3,
    });
    expect(trace.records[3]).toMatchObject({ event: "persisted", elapsedMs: 60 });
    expect(trace.records[4]).toMatchObject({ event: "committed", elapsedMs: 60 });
    expectSanitizedRecords(trace.records);
  });

  it("traces a coalesced request against the owning task", async () => {
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    let calls = 0;
    const trace = new RecordingTrace();
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => {
        calls += 1;
        return await new Promise((resolve) => { resolveDownload = resolve; });
      },
    }, () => 100, { traceSink: trace.sink });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(calls).toBe(1));

    const coalesced = trace.records.find((record) => record.event === "coalesced")!;
    expect(coalesced).toMatchObject({ task: trace.records[0].task, trigger: "manual" });
    expectSanitizedRecords(trace.records);

    resolveDownload?.(resolved());
    await settle();
    expect(calls).toBe(1);
    expect(trace.events()).toEqual(["accepted", "started", "coalesced", "resolved", "persisted", "committed"]);
  });

  it("traces a fifth distinct scope waiting for a Resolution concurrency slot", async () => {
    const releases = new Map<string, () => void>();
    const trace = new RecordingTrace();
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => {
        await new Promise<void>((resolve) => releases.set(requested.key, resolve));
        return resolved(requested.key);
      },
    }, () => 100, { traceSink: trace.sink });
    await authority.initialize();

    await Promise.all([
      authority.getOrQueue(scope("one.example.com")),
      authority.getOrQueue(scope("two.example.com")),
      authority.getOrQueue(scope("three.example.com")),
      authority.getOrQueue(scope("four.example.com")),
    ]);
    await vi.waitFor(() => expect(releases.size).toBe(4));
    await expect(authority.getOrQueue(scope("five.example.com"))).resolves.toEqual({ status: "queued" });

    const fifth = trace.records.filter((record) => record.scope.key === "five.example.com");
    expect(fifth.map((record) => record.event)).toEqual(["accepted", "waiting-slot"]);
    expect(trace.records.filter((record) => record.event === "started")).toHaveLength(4);

    releases.get("one.example.com")?.();
    await vi.waitFor(() => expect(trace.records.some((record) => (
      record.event === "started" && record.scope.key === "five.example.com"
    ))).toBe(true));
    for (const release of releases.values()) release();
    await settle();

    expect(trace.records.filter((record) => record.event === "accepted")).toHaveLength(5);
    expect(trace.records.filter((record) => record.event === "started")).toHaveLength(5);
    expect(trace.records.filter((record) => record.event === "waiting-slot")).toHaveLength(1);
    expect(trace.records.filter((record) => record.event === "committed")).toHaveLength(5);
    const validSequences = [
      ["accepted", "started", "resolved", "persisted", "committed"],
      ["accepted", "waiting-slot", "started", "resolved", "persisted", "committed"],
    ];
    const byTask = new Map<string, string[]>();
    for (const record of trace.records) {
      byTask.set(record.task, [...(byTask.get(record.task) ?? []), record.event]);
    }
    for (const sequence of byTask.values()) {
      expect(validSequences).toContainEqual(sequence);
    }
    expectSanitizedRecords(trace.records);
  });

  it("traces sanitized candidate outcomes for usable and rejected responses", async () => {
    const trace = new RecordingTrace();
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding !== "base64") return null;
      if (url.endsWith("/favicon.ico")) {
        return { body: "not-an-icon", contentType: "text/html", status: 404, url };
      }
      return { body: Buffer.from([1, 2, 3, 4]).toString("base64"), contentType: "image/png", status: 200, url };
    });
    const authority = new KernelCacheAuthority(new MemoryStorage(), new ForwardProxyIconResolver(forward, () => resolverPolicy), () => 100, {
      traceSink: trace.sink,
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(trace.records.some((record) => record.event === "committed")).toBe(true));

    const candidates = trace.records.filter((record) => record.event === "candidate-finished");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      ordinal: 1, source: "root favicon.ico", outcome: "failed", status: 404, contentType: "text/html",
    });
    expect(candidates[1]).toMatchObject({
      ordinal: 2, source: "root favicon.png", outcome: "resolved", status: 200, contentType: "image/png", bytes: 4,
    });
    expectSanitizedRecords(trace.records);
    expect(JSON.stringify(trace.records)).not.toMatch(/https?:\/\//);
  });

  it("traces malformed candidate data as invalid without leaking response details", async () => {
    const trace = new RecordingTrace();
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding !== "base64") return null;
      return { body: "!!not-base64!!", contentType: "image/png", status: 200, url };
    });
    const authority = new KernelCacheAuthority(new MemoryStorage(), new ForwardProxyIconResolver(forward, () => resolverPolicy), () => 100, {
      traceSink: trace.sink,
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(trace.records.some((record) => record.event === "failed")).toBe(true));

    const candidates = trace.records.filter((record) => record.event === "candidate-finished");
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) expect(candidate.outcome).toBe("invalid");
    expect(trace.records.find((record) => record.event === "failed")).toMatchObject({ category: "invalid" });
    expectSanitizedRecords(trace.records);
    expect(JSON.stringify(trace.records)).not.toContain("not-base64");
  });

  it("traces resolver transport rejection as network without leaking error text", async () => {
    const trace = new RecordingTrace();
    const forward = vi.fn<ForwardProxy>(async () => { throw new Error("proxy refused"); });
    const authority = new KernelCacheAuthority(new MemoryStorage(), new ForwardProxyIconResolver(forward, () => resolverPolicy), () => 100, {
      traceSink: trace.sink,
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(trace.records.some((record) => record.event === "failed")).toBe(true));

    const candidates = trace.records.filter((record) => record.event === "candidate-finished");
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) expect(candidate.outcome).toBe("network");
    expect(trace.records.find((record) => record.event === "failed")).toMatchObject({ category: "network" });
    expectSanitizedRecords(trace.records);
    expect(JSON.stringify(trace.records)).not.toContain("proxy refused");
  });

  it("traces deadline expiry as a timeout candidate and terminal failure", async () => {
    vi.useFakeTimers();
    try {
      const trace = new RecordingTrace();
      const forward = vi.fn<ForwardProxy>(async () => await new Promise(() => {}));
      const authority = new KernelCacheAuthority(new MemoryStorage(), new ForwardProxyIconResolver(forward, () => resolverPolicy), () => Date.now(), {
        traceSink: trace.sink,
      });
      await authority.initialize();

      const pending = authority.getOrQueue(scope());
      await expect(pending).resolves.toEqual({ status: "queued" });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(trace.records.some((record) => record.event === "failed")).toBe(true));

      expect(trace.records.filter((record) => record.event === "candidate-finished")).toHaveLength(1);
      expect(trace.records.find((record) => record.event === "candidate-finished")).toMatchObject({
        ordinal: 1, outcome: "timeout", remainingBudgetMs: 0,
      });
      expect(trace.records.find((record) => record.event === "failed")).toMatchObject({ category: "timeout" });
      expectSanitizedRecords(trace.records);
    } finally {
      vi.useRealTimers();
    }
  });

  it("traces exactly one terminal failed record with the sanitized category", async () => {
    const trace = new RecordingTrace();
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => { throw new ResolutionError("network"); },
    }, () => 100, { traceSink: trace.sink });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await settle();

    const failed = trace.records.filter((record) => record.event === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ category: "network", task: trace.records[0].task });
    expect(trace.events()).toEqual(["accepted", "started", "failed"]);
    expectSanitizedRecords(trace.records);
  });

  it("traces an invalidated task without a later commit or failure record", async () => {
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    const trace = new RecordingTrace();
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => 100, { traceSink: trace.sink });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    await authority.remove(scope().key);
    resolveDownload?.(resolved());
    await settle();

    const invalidated = trace.records.filter((record) => record.event === "invalidated");
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]).toMatchObject({ task: trace.records[0].task });
    expect(trace.events()).toEqual(["accepted", "started", "invalidated"]);
    expect(trace.events()).not.toContain("failed");
    expect(trace.events()).not.toContain("persisted");
    expect(trace.events()).not.toContain("committed");
    expectSanitizedRecords(trace.records);
  });

  it("traces persistence only after storage succeeds and commit only with the state publication", async () => {
    const storage = new BlockingCacheIndexStorage();
    const trace = new RecordingTrace();
    const watched = subscribers();
    const authority = new KernelCacheAuthority(storage, { resolve: async () => resolved() }, () => 100, {
      traceSink: trace.sink,
      onCacheChanged: (event) => { watched.cacheEvents.push(event); },
    });
    await authority.initialize();
    const indexWriteStarted = storage.blockNextCacheIndexWrite();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await indexWriteStarted;
    await settle();
    expect(trace.events()).toEqual(["accepted", "started", "resolved"]);

    storage.releaseCacheIndexWrite();
    await watched.waitForCache((events) => Boolean(events[0]?.upserts["example.com"]), "the committed entry broadcast");
    await settle();
    expect(trace.events()).toEqual(["accepted", "started", "resolved", "persisted", "committed"]);
    expectSanitizedRecords(trace.records);
  });

  it("emits no trace records and no behavior change when tracing is disabled", async () => {
    const watched = subscribers();
    const failures: Array<{ key: string; category: string }> = [];
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => 100, {
      onCacheChanged: (event) => { watched.cacheEvents.push(event); },
      onResolutionFailure: (failedScope, category) => { failures.push({ key: failedScope.key, category }); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await watched.waitForCache((events) => Boolean(events[0]?.upserts["example.com"]), "the committed entry broadcast");

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(snapshotCache(authority)).toEqual({ "example.com": expect.objectContaining({ source: "test resolver" }) });
    expect(failures).toEqual([]);
  });

  it("increments the cache revision exactly once per committed event", async () => {
    const received: CacheChangeEvent[] = [];
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => resolved(requested.key),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();

    await authority.putPinned(scope("first.example.com"), entry({ domain: "first.example.com", pinned: true }), "image/png", new Uint8Array([1]).buffer);
    await authority.putPinned(scope("second.example.com"), entry({ domain: "second.example.com", pinned: true }), "image/png", new Uint8Array([2]).buffer);
    await expect(authority.getOrQueue(scope("third.example.com"))).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(snapshotCache(authority)["third.example.com"]).toBeDefined());
    await authority.remove("third.example.com");

    expect(received.map((event) => event.revision)).toEqual([1, 2, 3, 4]);
  });

  it("reports removed keys for remove, clear, clear-generated, and pin-replace operations", async () => {
    const received: CacheChangeEvent[] = [];
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => resolved(requested.key),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();
    let nextEvent = 0;

    await authority.putPinned(scope("generated.example.com"), entry({ domain: "generated.example.com", pinned: true, source: "generated monogram" }), "image/svg+xml", new Uint8Array([1]).buffer);
    await authority.putPinned(scope("pinned.example.com"), entry({ domain: "pinned.example.com", pinned: true }), "image/png", new Uint8Array([2]).buffer);
    await expect(authority.getOrQueue(scope("plain.example.com"))).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(snapshotCache(authority)["plain.example.com"]).toBeDefined());
    nextEvent = received.length;

    await authority.remove("plain.example.com");
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(nextEvent));
    expect(received[nextEvent]).toEqual({ epoch: expect.any(String), revision: expect.any(Number), upserts: {}, removed: ["plain.example.com"] });
    nextEvent = received.length;

    await authority.clearGenerated();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(nextEvent));
    expect(received[nextEvent]).toEqual({ epoch: expect.any(String), revision: expect.any(Number), upserts: {}, removed: ["generated.example.com"] });
    nextEvent = received.length;

    await expect(authority.getOrQueue(scope("plain-2.example.com"))).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(snapshotCache(authority)["plain-2.example.com"]).toBeDefined());
    nextEvent = received.length;

    await authority.clear();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(nextEvent));
    expect(received[nextEvent]).toEqual({ epoch: expect.any(String), revision: expect.any(Number), upserts: {}, removed: ["plain-2.example.com"] });
    nextEvent = received.length;

    await authority.putPinned(scope("second.example.com"), entry({ domain: "second.example.com", pinned: true }), "image/png", new Uint8Array([3]).buffer);
    await authority.putPinned(scope("first.example.com"), entry({ domain: "first.example.com", pinned: true }), "image/png", new Uint8Array([4]).buffer, "second.example.com");
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(nextEvent));
    expect(received[received.length - 1]).toEqual({
      epoch: expect.any(String),
      revision: expect.any(Number),
      upserts: { "first.example.com": expect.objectContaining({ pinned: true }) },
      removed: ["second.example.com"],
    });
  });

  it("resolves new-format iconIds in constant time and rejects mismatches", async () => {
    const storage = new MemoryStorage();
    const authority = new KernelCacheAuthority(storage, { resolve: async () => resolved() }, () => 100);
    await authority.initialize();
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(snapshotCache(authority)["example.com"]).toBeDefined());
    const iconId = snapshotCache(authority)["example.com"].iconId!;

    await expect(authority.icon(iconId)).resolves.toMatchObject({ contentType: "image/png" });
    const mismatch = `${iconId.slice(0, iconId.lastIndexOf("-"))}-9`;
    await expect(authority.icon(mismatch)).resolves.toBeUndefined();
    await expect(authority.icon("unknown-key")).resolves.toBeUndefined();
    await expect(authority.icon("unknown.example.com-2pc-1")).resolves.toBeUndefined();
  });

  it("still serves legacy-format iconIds through the linear scan", async () => {
    const storage = new MemoryStorage();
    storage.files.set("favicon-cache-v2.json", JSON.stringify({
      "example.com": entry({
        domain: "example.com", iconId: "example.com-2pc-1",
        url: "/plugin/private/siyuan-linkmark/icon/example.com-2pc-1", contentType: "image/png",
      }),
      "a-b.example.com": entry({
        domain: "a-b.example.com", iconId: "a-b.example.com-2pc-1",
        url: "/plugin/private/siyuan-linkmark/icon/a-b.example.com-2pc-1", contentType: "image/png",
      }),
    }));
    storage.files.set("icons/example.com-2pc-1.base64", Buffer.from([1, 2, 3]).toString("base64"));
    storage.files.set("icons/a-b.example.com-2pc-1.base64", Buffer.from([4, 5]).toString("base64"));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);
    await authority.initialize();

    await expect(authority.icon("example.com-2pc-1")).resolves.toMatchObject({ contentType: "image/png" });
    await expect(authority.icon("a-b.example.com-2pc-1")).resolves.toMatchObject({ contentType: "image/png" });
    await expect(authority.icon("example.com-2pc-2")).resolves.toBeUndefined();
  });

  it("does not serve a stale iconId for an entry that was refreshed or removed", async () => {
    const storage = new MemoryStorage();
    const received: CacheChangeEvent[] = [];
    let byte = 1;
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => resolved(`test resolver ${byte++}`),
    }, () => 100, {
      onCacheChanged: (event) => { received.push(event); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const stale = received[0].upserts["example.com"].iconId!;

    await expect(authority.getOrQueue(scope(), true)).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const current = received[1].upserts["example.com"].iconId!;
    expect(current).not.toBe(stale);
    await expect(authority.icon(stale)).resolves.toBeUndefined();

    await authority.remove(scope().key);
    await vi.waitFor(() => expect(snapshotCache(authority)).toEqual({}));
    await expect(authority.icon(current)).resolves.toBeUndefined();
  });

  it("resolves new-format and legacy iconIds against a 10,000-entry cache fixture", async () => {
    const storage = new MemoryStorage();
    const entries: Record<string, CacheEntry> = {};
    let encodedIconId = "";
    const legacyIconId = "legacy.example.com-2pc-1";
    const now = 100;
    for (let index = 0; index < 10_000; index += 1) {
      const key = `domain-${index}.example.com`;
      const id = `${Buffer.from(key).toString("base64url")}-${now.toString(36)}-${index.toString(36)}`;
      if (index === 5_000) encodedIconId = id;
      entries[key] = entry({
        domain: key, iconId: id, url: `/plugin/private/siyuan-linkmark/icon/${id}`, contentType: "image/png",
      });
    }
    entries["legacy.example.com"] = entry({
      domain: "legacy.example.com", iconId: legacyIconId,
      url: `/plugin/private/siyuan-linkmark/icon/${legacyIconId}`, contentType: "image/png",
    });
    storage.files.set("favicon-cache-v2.json", JSON.stringify(entries));
    storage.files.set(`icons/${encodedIconId}.base64`, Buffer.from([1, 2, 3]).toString("base64"));
    storage.files.set(`icons/${legacyIconId}.base64`, Buffer.from([4]).toString("base64"));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => now);
    await authority.initialize();

    await expect(authority.icon(encodedIconId)).resolves.toMatchObject({ contentType: "image/png" });
    await expect(authority.icon(legacyIconId)).resolves.toMatchObject({ contentType: "image/png" });
    await expect(authority.icon(`${encodedIconId.slice(0, encodedIconId.lastIndexOf("-"))}-zzz`)).resolves.toBeUndefined();
  });
});

describe("shared-pin eligibility and legacy migration", () => {
  const hostScope = (domain: string): LinkScope => ({ key: domain, domain, targetUrl: `https://${domain}/` });
  const hostEntry = (domain: string, overrides: Partial<CacheEntry> = {}): CacheEntry => ({
    url: "", fetchedAt: 1, source: "legacy pin", domain, pinned: true,
    ...overrides,
  });

  function preload(storage: MemoryStorage, pins: Array<[string, CacheEntry]>) {
    const entries = Object.fromEntries(pins);
    storage.files.set("favicon-cache-v2.json", JSON.stringify(entries));
    for (const [, cacheEntry] of pins) {
      if (cacheEntry.iconId) {
        storage.files.set(`icons/${cacheEntry.iconId}.base64`, Buffer.from([9]).toString("base64"));
      }
    }
  }

  it("rejects invalid shared pin requests with the stable invalid-share-domain error", async () => {
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve: async () => null }, () => 100);
    await authority.initialize();

    for (const domain of ["github.io", "foo.github.io", "qq.com", "www.example.com", "a..example.com", "example.com", "foo.onion", "x.home.arpa", "foo.alt"]) {
      await expect(
        authority.putPinned(hostScope(domain), hostEntry(domain, { includeSubdomains: true }), "image/png", new Uint8Array([1]).buffer),
      ).rejects.toThrow(INVALID_SHARE_DOMAIN);
    }
    expect(snapshotCache(authority)).toEqual({});
  });

  it("accepts a valid shared pin at an eligible eTLD+1 and keeps it available", async () => {
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve: async () => null }, () => 100);
    await authority.initialize();

    const pinned = await authority.putPinned(
      hostScope("example.dev"),
      hostEntry("example.dev", { includeSubdomains: true }),
      "image/png",
      new Uint8Array([1]).buffer,
    );
    expect(pinned).toMatchObject({ domain: "example.dev", pinned: true, includeSubdomains: true });

    const result = await authority.getOrQueue(hostScope("example.dev"));
    expect(result).toEqual({ status: "ready", entry: expect.objectContaining({ iconId: pinned.iconId, includeSubdomains: true }) });
    expect(Object.keys(snapshotCache(authority))).toEqual(["example.dev"]);
  });

  it("still accepts exact pins at tenant eTLD+1s and inside reviewed exclusions", async () => {
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve: async () => null }, () => 100);
    await authority.initialize();

    await expect(authority.putPinned(hostScope("foo.github.io"), hostEntry("foo.github.io"), "image/png", new Uint8Array([1]).buffer))
      .resolves.toMatchObject({ domain: "foo.github.io", pinned: true });
    await expect(authority.putPinned(hostScope("docs.qq.com"), hostEntry("docs.qq.com"), "image/png", new Uint8Array([2]).buffer))
      .resolves.toMatchObject({ domain: "docs.qq.com", pinned: true });
  });

  it("retains valid shared pins and exact tenant pins during initialization", async () => {
    const storage = new MemoryStorage();
    preload(storage, [
      ["example.dev", hostEntry("example.dev", { iconId: "legacy-1", includeSubdomains: true })],
      ["foo.github.io", hostEntry("foo.github.io", { iconId: "legacy-2" })],
      ["docs.qq.com", hostEntry("docs.qq.com", { iconId: "legacy-3" })],
    ]);
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);
    await authority.initialize();

    expect(Object.keys(snapshotCache(authority))).toEqual(["example.dev", "foo.github.io", "docs.qq.com"]);
    for (const iconId of ["legacy-1", "legacy-2", "legacy-3"]) {
      expect(storage.files.has(`icons/${iconId}.base64`)).toBe(true);
    }
  });

  it("removes legacy public-suffix, Private-suffix, and reviewed-exclusion shared pins with their payloads", async () => {
    const storage = new MemoryStorage();
    preload(storage, [
      ["example.dev", hostEntry("example.dev", { iconId: "keep-1", includeSubdomains: true })],
      ["github.io", hostEntry("github.io", { iconId: "drop-1", includeSubdomains: true })],
      ["foo.github.io", hostEntry("foo.github.io", { iconId: "drop-2", includeSubdomains: true })],
      ["sub.foo.github.io", hostEntry("sub.foo.github.io", { iconId: "drop-3", includeSubdomains: true })],
      ["b.example.dev", hostEntry("b.example.dev", { iconId: "drop-4", includeSubdomains: true })],
      ["qq.com", hostEntry("qq.com", { iconId: "drop-5", includeSubdomains: true })],
      ["x.feishu.cn", hostEntry("x.feishu.cn", { iconId: "drop-6", includeSubdomains: true })],
      ["example.com", hostEntry("example.com", { iconId: "drop-7", includeSubdomains: true })],
      ["foo.onion", hostEntry("foo.onion", { iconId: "drop-8", includeSubdomains: true })],
    ]);
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);
    await authority.initialize();

    expect(Object.keys(snapshotCache(authority))).toEqual(["example.dev"]);
    expect(storage.files.has("icons/keep-1.base64")).toBe(true);
    for (const iconId of ["drop-1", "drop-2", "drop-3", "drop-4", "drop-5", "drop-6", "drop-7", "drop-8"]) {
      expect(storage.files.has(`icons/${iconId}.base64`)).toBe(false);
    }
    expect(JSON.parse(storage.files.get("favicon-cache-v2.json")!)).toEqual({
      "example.dev": snapshotCache(authority)["example.dev"],
    });
  });

  it("removes every pin whose target is a public suffix or special-use name, shared or exact", async () => {
    const storage = new MemoryStorage();
    preload(storage, [
      ["example.dev", hostEntry("example.dev", { iconId: "keep-1" })],
      ["github.io", hostEntry("github.io", { iconId: "drop-1" })],
      ["localhost", hostEntry("localhost", { iconId: "drop-2" })],
      ["example.com", hostEntry("example.com", { iconId: "drop-3" })],
      ["foo.onion", hostEntry("foo.onion", { iconId: "drop-4" })],
    ]);
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);
    await authority.initialize();

    expect(Object.keys(snapshotCache(authority))).toEqual(["example.dev"]);
    expect(storage.files.has("icons/drop-1.base64")).toBe(false);
    expect(storage.files.has("icons/drop-2.base64")).toBe(false);
    expect(storage.files.has("icons/drop-3.base64")).toBe(false);
    expect(storage.files.has("icons/drop-4.base64")).toBe(false);
  });

  it("keeps exact pins at non-registrable hosts such as IP literals", async () => {
    const storage = new MemoryStorage();
    preload(storage, [
      ["127.0.0.1", hostEntry("127.0.0.1", { iconId: "keep-1" })],
    ]);
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);
    await authority.initialize();

    expect(Object.keys(snapshotCache(authority))).toEqual(["127.0.0.1"]);
    expect(storage.files.has("icons/keep-1.base64")).toBe(true);
  });

  it("writes the pruned index before deleting any payload", async () => {
    const storage = new RecordingOrderStorage();
    preload(storage, [
      ["example.dev", hostEntry("example.dev", { iconId: "keep-1", includeSubdomains: true })],
      ["github.io", hostEntry("github.io", { iconId: "drop-1", includeSubdomains: true })],
    ]);
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);
    await authority.initialize();

    expect(storage.operations).toEqual([
      "write favicon-cache-v2.json",
      "remove icons/drop-1.base64",
    ]);
    expect(storage.files.has("icons/keep-1.base64")).toBe(true);
  });

  it("fails initialization without removing records or payloads when the index write fails", async () => {
    const storage = new FailingCacheIndexStorage();
    preload(storage, [
      ["example.dev", hostEntry("example.dev", { iconId: "keep-1", includeSubdomains: true })],
      ["github.io", hostEntry("github.io", { iconId: "drop-1", includeSubdomains: true })],
    ]);
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);

    await expect(authority.initialize()).rejects.toThrow("cache-index write failed");
    expect(storage.cacheIndexWrites).toBe(1);
    const persisted = JSON.parse(storage.files.get("favicon-cache-v2.json")!) as Record<string, CacheEntry>;
    expect(Object.keys(persisted)).toEqual(["example.dev", "github.io"]);
    expect(storage.files.has("icons/keep-1.base64")).toBe(true);
    expect(storage.files.has("icons/drop-1.base64")).toBe(true);
  });
});

describe("ForwardProxyIconResolver", () => {
  it("skips HTML and manifest retrieval on the default fast path", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).rejects.toMatchObject({ category: "exhausted" });
    expect(forward).toHaveBeenCalledTimes(4);
    for (const call of forward.mock.calls) expect(call[1]).toBe("base64");
  });

  it("does not probe parent-domain or provider candidates on the default fast path", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const policy = { ...resolverPolicy, providerPreset: "custom" as const, resolverMode: "mainland" as const };
    const resolver = new ForwardProxyIconResolver(forward, () => policy);
    const multiLabelScope: LinkScope = {
      key: "docs.example.co.uk",
      domain: "docs.example.co.uk",
      targetUrl: "https://docs.example.co.uk/",
    };

    await expect(resolver.resolve(multiLabelScope)).rejects.toMatchObject({ category: "exhausted" });
    const requested = forward.mock.calls.map(([url]) => url);
    expect(requested).toEqual([
      "https://docs.example.co.uk/favicon.ico",
      "https://docs.example.co.uk/favicon.png",
      "https://example.com/favicon/docs.example.co.uk",
      "https://docs.example.co.uk/favicon.svg",
    ]);
  });

  it("limits resolution to four candidate downloads even under Specific-page discovery", async () => {
    const downloads: string[] = [];
    const links = Array.from({ length: 17 }, (_, index) => `<link rel="icon" href="/icon-${index}.png">`).join("");
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "text") return { body: links, contentType: "text/html", status: 200, url };
      downloads.push(url);
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve({ ...scope(), discoverPage: true }, "automatic")).rejects.toMatchObject({ category: "exhausted" });
    expect(downloads).toHaveLength(4);
  });

  it("downloads candidates in priority order and stops at the first success", async () => {
    const downloads: string[] = [];
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      downloads.push(url);
      if (url === "https://example.com/favicon.png" && encoding === "base64") {
        return { body: Buffer.from([1, 2, 3]).toString("base64"), contentType: "image/png", status: 200, url };
      }
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).resolves.toMatchObject({ source: "root favicon.png", contentType: "image/png" });
    expect(downloads).toEqual([
      "https://example.com/favicon.ico",
      "https://example.com/favicon.png",
    ]);
  });

  it("follows three public redirects, including a cross-origin CDN hop", async () => {
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding !== "base64") return null;
      if (url === "https://example.com/favicon.ico") return {
        body: "", status: 301, headers: { location: ["/redirect-1"] }, url,
      };
      if (url === "https://example.com/redirect-1") return {
        body: "", status: 303, headers: { location: ["/redirect-2"] }, url,
      };
      if (url === "https://example.com/redirect-2") return {
        body: "", status: 308, headers: { location: ["https://cdn.example.net/icon"] }, url,
      };
      if (url === "https://cdn.example.net/icon") return {
        body: Buffer.from([1, 2, 3]).toString("base64"), contentType: "image/png", status: 200, url,
      };
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).resolves.toMatchObject({ source: "root favicon.ico", contentType: "image/png" });
    expect(forward.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/favicon.ico",
      "https://example.com/redirect-1",
      "https://example.com/redirect-2",
      "https://cdn.example.net/icon",
    ]);
  });

  it.each([302, 307])("follows %i redirects", async (status) => {
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding !== "base64") return null;
      if (url === "https://example.com/favicon.ico") return {
        body: "", status, headers: { Location: ["/favicon.png"] }, url,
      };
      if (url === "https://example.com/favicon.png") return {
        body: Buffer.from([1, 2, 3]).toString("base64"), contentType: "image/png", status: 200, url,
      };
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).resolves.toMatchObject({ source: "root favicon.ico", contentType: "image/png" });
  });

  it("rejects authentication, unsafe, malformed, and over-limit redirect targets", async () => {
    const cases = [
      "/login",
      "http://127.0.0.1/icon.png",
      "http://[",
      undefined,
    ];
    for (const location of cases) {
      const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
        if (encoding !== "base64") return null;
        if (url === "https://example.com/favicon.ico") return {
          body: "", status: 302, ...(location === undefined ? {} : { headers: { Location: [location] } }), url,
        };
        return null;
      });
      const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

      await expect(resolver.resolve(scope())).rejects.toMatchObject({ category: "exhausted" });
      expect(forward).toHaveBeenCalledTimes(4);
    }

    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding !== "base64") return null;
      if (url === "https://example.com/favicon.ico" || /^https:\/\/cdn\.example\.net\/step-[1-3]$/.test(url)) {
        const step = url === "https://example.com/favicon.ico" ? 1 : Number(url.at(-1)) + 1;
        return { body: "", status: 302, headers: { Location: [`https://cdn.example.net/step-${step}`] }, url };
      }
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).rejects.toMatchObject({ category: "exhausted" });
    expect(forward.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/favicon.ico",
      "https://cdn.example.net/step-1",
      "https://cdn.example.net/step-2",
      "https://cdn.example.net/step-3",
      "https://example.com/favicon.png",
      "https://example.com/favicon.svg",
      "https://example.com/apple-touch-icon.png",
    ]);
  });

  it("orders exact-domain candidates before parent-domain candidates", async () => {
    const downloads: string[] = [];
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "base64") downloads.push(url);
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);
    const subScope: LinkScope = { key: "docs.example.dev", domain: "docs.example.dev", targetUrl: "https://docs.example.dev/" };

    await expect(resolver.candidates({ ...subScope, discoverPage: true }, true)).resolves.toEqual([]);
    expect(downloads).toEqual([
      "https://docs.example.dev/favicon.ico",
      "https://docs.example.dev/favicon.png",
      "https://docs.example.dev/favicon.svg",
      "https://docs.example.dev/apple-touch-icon.png",
      "https://example.dev/favicon.ico",
      "https://example.dev/favicon.png",
      "https://example.dev/favicon.svg",
      "https://example.dev/apple-touch-icon.png",
    ]);
  });

  it("probes only the one registrable parent after exact-host candidates", async () => {
    const downloads: string[] = [];
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "base64") downloads.push(url);
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);
    const deepScope: LinkScope = { key: "a.b.example.dev", domain: "a.b.example.dev", targetUrl: "https://a.b.example.dev/" };

    await expect(resolver.candidates(deepScope, true)).resolves.toEqual([]);
    expect(downloads).toEqual([
      "https://a.b.example.dev/favicon.ico",
      "https://a.b.example.dev/favicon.png",
      "https://a.b.example.dev/favicon.svg",
      "https://a.b.example.dev/apple-touch-icon.png",
      "https://example.dev/favicon.ico",
      "https://example.dev/favicon.png",
      "https://example.dev/favicon.svg",
      "https://example.dev/apple-touch-icon.png",
    ]);
  });

  it("probes the country-code registrable parent instead of an intermediate label", async () => {
    const downloads: string[] = [];
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "base64") downloads.push(url);
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);
    const coUkScope: LinkScope = { key: "docs.example.co.uk", domain: "docs.example.co.uk", targetUrl: "https://docs.example.co.uk/" };

    await expect(resolver.candidates(coUkScope, true)).resolves.toEqual([]);
    expect(downloads).toEqual([
      "https://docs.example.co.uk/favicon.ico",
      "https://docs.example.co.uk/favicon.png",
      "https://docs.example.co.uk/favicon.svg",
      "https://docs.example.co.uk/apple-touch-icon.png",
      "https://example.co.uk/favicon.ico",
      "https://example.co.uk/favicon.png",
      "https://example.co.uk/favicon.svg",
      "https://example.co.uk/apple-touch-icon.png",
    ]);
  });

  it("never generates a public-suffix or provider-suffix candidate for hosted tenants", async () => {
    const downloads: string[] = [];
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "base64") downloads.push(url);
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);
    const tenant: LinkScope = { key: "foo.github.io", domain: "foo.github.io", targetUrl: "https://foo.github.io/" };

    await expect(resolver.candidates(tenant, true)).resolves.toEqual([]);
    expect(downloads).toEqual([
      "https://foo.github.io/favicon.ico",
      "https://foo.github.io/favicon.png",
      "https://foo.github.io/favicon.svg",
      "https://foo.github.io/apple-touch-icon.png",
    ]);

    downloads.length = 0;
    const deepTenant: LinkScope = { key: "a.foo.github.io", domain: "a.foo.github.io", targetUrl: "https://a.foo.github.io/" };
    await expect(resolver.candidates(deepTenant, true)).resolves.toEqual([]);
    expect(downloads).toEqual([
      "https://a.foo.github.io/favicon.ico",
      "https://a.foo.github.io/favicon.png",
      "https://a.foo.github.io/favicon.svg",
      "https://a.foo.github.io/apple-touch-icon.png",
      "https://foo.github.io/favicon.ico",
      "https://foo.github.io/favicon.png",
      "https://foo.github.io/favicon.svg",
      "https://foo.github.io/apple-touch-icon.png",
    ]);
    expect(downloads).not.toContain("https://github.io/favicon.ico");
  });

  it("stops resolution when the ten-second budget expires", async () => {
    vi.useFakeTimers();
    try {
      const forward = vi.fn<ForwardProxy>(async () => await new Promise(() => {}));
      const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

      const pending = resolver.resolve(scope());
      const timeout = expect(pending).rejects.toMatchObject({ category: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);

      await timeout;
      expect(forward).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a rejected Forward-proxy transport into a network failure", async () => {
    const forward = vi.fn<ForwardProxy>(async () => { throw new Error("proxy refused"); });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).rejects.toMatchObject({ category: "network" });
  });

  it("turns malformed proxy data into an invalid failure", async () => {
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "base64") return { body: "!!not-base64!!", contentType: "image/png", status: 200, url };
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).rejects.toMatchObject({ category: "invalid" });
  });

  it("discovers page and manifest icons only under Specific-page discovery", async () => {
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (url === "https://example.com/" && encoding === "text") return {
        body: '<link rel="manifest" href="/site.webmanifest">', contentType: "text/html", status: 200, url,
      };
      if (url === "https://example.com/site.webmanifest") return {
        body: JSON.stringify({ icons: [{ src: "/icon.png" }] }), contentType: "application/manifest+json", status: 200, url,
      };
      if (url === "https://example.com/icon.png" && encoding === "base64") return {
        body: Buffer.from([1, 2, 3]).toString("base64"), contentType: "image/png", status: 200, url,
      };
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).rejects.toMatchObject({ category: "exhausted" });
    expect(forward).not.toHaveBeenCalledWith("https://example.com/", "text", "text/html", 5000);

    await expect(resolver.resolve({ ...scope(), discoverPage: true })).resolves.toMatchObject({
      source: "root rel=icon · web app manifest",
      contentType: "image/png",
    });
    expect(forward).toHaveBeenCalledWith("https://example.com/site.webmanifest", "text", "application/manifest+json", 5000);
  });

  it("keeps manual candidate discovery for the icon picker", async () => {
    const downloads: string[] = [];
    const links = Array.from({ length: 17 }, (_, index) => `<link rel="icon" href="/icon-${index}.png">`).join("");
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "text") return { body: links, contentType: "text/html", status: 200, url };
      downloads.push(url);
      if (url.endsWith("/icon-16.png")) {
        return {
          body: Buffer.from([1, 2, 3]).toString("base64"),
          contentType: "image/png",
          status: 200,
          url,
        };
      }
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.candidates(scope(), true)).resolves.toEqual([
      expect.objectContaining({ source: "root rel=icon" }),
    ]);
    expect(downloads).toContain("https://example.com/icon-16.png");
  });

  it("generates a monogram fallback after fast-path exhaustion", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const policy = { ...resolverPolicy, fallbackMode: "monogram" as const };
    const resolver = new ForwardProxyIconResolver(forward, () => policy);

    await expect(resolver.resolve(scope())).resolves.toMatchObject({ source: "generated monogram", contentType: "image/svg+xml" });
  });
});
