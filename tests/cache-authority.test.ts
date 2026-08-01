import { describe, expect, it, vi } from "vitest";
import {
  KernelCacheAuthority,
  ResolutionError,
  type CacheEntry,
  type CacheStorage,
  type LinkScope,
} from "../src/cache-authority";
import { privateIconIdFromPath } from "../src/private-route";
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

type Subscriber<T> = {
  events: T[];
  waitFor(predicate: (events: T[]) => boolean, description: string): Promise<void>;
};

function subscribers() {
  const cacheEvents: Array<Record<string, CacheEntry>> = [];
  const waitFor = async (predicate: (events: Array<Record<string, CacheEntry>>) => boolean, description: string) => {
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
      onStateChange: (cache) => { watched.cacheEvents.push(cache); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await watched.waitForCache((events) => events.length === 1, "the first commit broadcast");
    expect(resolve).toHaveBeenCalledTimes(1);

    const result = await authority.getOrQueue(scope());
    expect(result).toEqual({ status: "ready", entry: expect.objectContaining({ source: "test resolver" }) });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a cache miss as queued before resolution or persistence completes", async () => {
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => 100);
    await authority.initialize();

    const result = await authority.getOrQueue(scope());

    expect(result).toEqual({ status: "queued" });
    expect(authority.snapshot()).toEqual({});
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    expect(authority.snapshot()).toEqual({});
  });

  it("returns queued while the cache-index persistence of an earlier task is still in flight", async () => {
    const storage = new BlockingCacheIndexStorage();
    const watched = subscribers();
    const authority = new KernelCacheAuthority(storage, { resolve: async () => resolved() }, () => 100, {
      onStateChange: (cache) => { watched.cacheEvents.push(cache); },
    });
    await authority.initialize();
    const indexWriteStarted = storage.blockNextCacheIndexWrite();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await indexWriteStarted;
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    storage.releaseCacheIndexWrite();

    await watched.waitForCache((events) => Boolean(events[0]?.["example.com"]), "the committed entry broadcast");
    expect(authority.snapshot()["example.com"]).toMatchObject({ source: "test resolver" });
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
      onStateChange: (cache) => { watched.cacheEvents.push(cache); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(calls).toBe(1));

    resolveDownload?.(resolved());
    await watched.waitForCache((events) => Boolean(events[0]?.["example.com"]), "the committed entry broadcast");
    expect(calls).toBe(1);
    expect(watched.cacheEvents[0]["example.com"]).toMatchObject({
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

  it("broadcasts isolated cache snapshots without structuredClone in the kernel runtime", async () => {
    const received: Record<string, CacheEntry>[] = [];
    vi.stubGlobal("structuredClone", undefined);
    try {
      const authority = new KernelCacheAuthority(new MemoryStorage(), {
        resolve: async () => resolved(),
      }, () => 100, {
        onStateChange: (cache) => { received.push(cache); },
      });
      await authority.initialize();

      await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      received[0]["example.com"].source = "subscriber mutation";
      const snapshot = authority.snapshot();
      snapshot["example.com"].source = "caller mutation";

      expect(authority.snapshot()["example.com"]).toMatchObject({ source: "test resolver" });
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
    expect(authority.snapshot()).toEqual({});
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
    expect(authority.snapshot()).toEqual({});
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
      onStateChange: (cache) => { watched.cacheEvents.push(cache); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(calls).toBe(1));
    await authority.remove(scope().key);
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });

    releases[0]?.();
    await vi.waitFor(() => expect(calls).toBe(2));
    releases[1]?.();

    await watched.waitForCache((events) => Boolean(events[0]?.["example.com"]), "the replacement commit broadcast");
    expect(authority.snapshot()).toEqual({
      "example.com": expect.objectContaining({ source: "resolver 2" }),
    });
  });

  it("persists concurrent resolved scopes in one cache-index batch and broadcasts once", async () => {
    const storage = new CountingCacheIndexStorage();
    const received: Record<string, CacheEntry>[] = [];
    const releaseDownloads: Array<() => void> = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async (requested) => {
        await new Promise<void>((resolve) => { releaseDownloads.push(resolve); });
        return resolved(requested.key);
      },
    }, () => 100, {
      onStateChange: (cache) => { received.push(cache); },
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
        "first.example.com": expect.objectContaining({ source: "first.example.com" }),
        "second.example.com": expect.objectContaining({ source: "second.example.com" }),
      },
    ]);
    expect(authority.snapshot()).toEqual({
      "first.example.com": expect.objectContaining({ source: "first.example.com" }),
      "second.example.com": expect.objectContaining({ source: "second.example.com" }),
    });
  });

  it("does not publish any resolved scope when its cache-index batch fails", async () => {
    const storage = new FailingCacheIndexStorage();
    const received: Record<string, CacheEntry>[] = [];
    const failures: Array<{ key: string; category: string }> = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async (requested) => resolved(requested.key),
    }, () => 100, {
      onStateChange: (cache) => { received.push(cache); },
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
    expect(authority.snapshot()).toEqual({});
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
    expect(authority.snapshot()).toEqual({});
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
    expect(authority.snapshot()).toEqual({});
  });

  it("retains pinned entries when clearing the workspace cache", async () => {
    const storage = new MemoryStorage();
    const received: Record<string, CacheEntry>[] = [];
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => resolved(),
    }, () => 100, {
      onStateChange: (cache) => { received.push(cache); },
    });
    await authority.initialize();
    await authority.putPinned(scope("pinned.example.com"), entry({ domain: "pinned.example.com", pinned: true }), "image/png", new Uint8Array([9]).buffer);
    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await authority.clear();

    expect(authority.snapshot()).toEqual({
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

    expect(authority.snapshot()["example.com"]).toMatchObject({ iconId: first.iconId, pinned: true });
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

    expect(authority.snapshot()).toEqual({});
    expect(storage.files.has("favicon-cache-v2.json")).toBe(false);
    expect(storage.files.get("favicon-cache.json")).toContain("pinned.example.com");
  });

  it("loads pinned icons already stored in the Linkmark cache", async () => {
    const storage = new MemoryStorage();
    storage.files.set("favicon-cache-v2.json", JSON.stringify({
      "pinned.example.com": entry({
        domain: "pinned.example.com",
        pinned: true,
        url: "/plugin/private/siyuan-linkmark/icon/pinned-1",
        iconId: "pinned-1",
        contentType: "image/png",
      }),
    }));
    storage.files.set("icons/pinned-1.base64", Buffer.from([9, 8, 7]).toString("base64"));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);

    await authority.initialize();

    expect(authority.snapshot()["pinned.example.com"]).toMatchObject({
      pinned: true,
      url: "/plugin/private/siyuan-linkmark/icon/pinned-1",
      iconId: "pinned-1",
    });
    await expect(authority.icon("pinned-1")).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("keeps distinct route Link scopes independent", async () => {
    const received: Record<string, CacheEntry>[] = [];
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => resolved(requested.key),
    }, () => 100, {
      onStateChange: (cache) => { received.push(cache); },
    });
    await authority.initialize();

    await Promise.all([
      authority.getOrQueue({ ...scope("docs.example.com::doc"), domain: "docs.example.com" }),
      authority.getOrQueue({ ...scope("docs.example.com::sheet"), domain: "docs.example.com" }),
    ]);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(authority.snapshot()).toEqual({
      "docs.example.com::doc": expect.objectContaining({ source: "docs.example.com::doc" }),
      "docs.example.com::sheet": expect.objectContaining({ source: "docs.example.com::sheet" }),
    });
  });

  it("publishes a refreshed icon under a new private payload before cleaning the old payload", async () => {
    const storage = new MemoryStorage();
    const received: Record<string, CacheEntry>[] = [];
    let byte = 1;
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => resolved(`test resolver ${byte++}`),
    }, () => 100, {
      onStateChange: (cache) => { received.push(cache); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const first = received[0]["example.com"];

    await expect(authority.getOrQueue(scope(), true)).resolves.toEqual({ status: "queued" });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const second = received[1]["example.com"];

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
    expect(authority.snapshot()).toEqual({});
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
    expect(authority.snapshot()).toEqual({});
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
      onStateChange: (cache) => { watched.cacheEvents.push(cache); },
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
    await watched.waitForCache((events) => Boolean(events[0]?.["example.com"]), "the committed entry broadcast");

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
      onStateChange: (cache) => { watched.cacheEvents.push(cache); },
    });
    await authority.initialize();
    const indexWriteStarted = storage.blockNextCacheIndexWrite();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await indexWriteStarted;
    await settle();
    expect(trace.events()).toEqual(["accepted", "started", "resolved"]);

    storage.releaseCacheIndexWrite();
    await watched.waitForCache((events) => Boolean(events[0]?.["example.com"]), "the committed entry broadcast");
    await settle();
    expect(trace.events()).toEqual(["accepted", "started", "resolved", "persisted", "committed"]);
    expectSanitizedRecords(trace.records);
  });

  it("emits no trace records and no behavior change when tracing is disabled", async () => {
    const watched = subscribers();
    const failures: Array<{ key: string; category: string }> = [];
    const resolve = vi.fn(async () => resolved());
    const authority = new KernelCacheAuthority(new MemoryStorage(), { resolve }, () => 100, {
      onStateChange: (cache) => { watched.cacheEvents.push(cache); },
      onResolutionFailure: (failedScope, category) => { failures.push({ key: failedScope.key, category }); },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope())).resolves.toEqual({ status: "queued" });
    await watched.waitForCache((events) => Boolean(events[0]?.["example.com"]), "the committed entry broadcast");

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(authority.snapshot()).toEqual({ "example.com": expect.objectContaining({ source: "test resolver" }) });
    expect(failures).toEqual([]);
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
    const policy = { ...resolverPolicy, providerPreset: "custom", resolverMode: "mainland" as const };
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
