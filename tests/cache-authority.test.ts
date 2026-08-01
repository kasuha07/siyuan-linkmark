import { describe, expect, it, vi } from "vitest";
import {
  KernelCacheAuthority,
  type CacheEntry,
  type CacheStorage,
  type IconResolver,
  type LinkScope,
} from "../src/cache-authority";
import { privateIconIdFromPath } from "../src/private-route";
import { fetchOutcomeFor } from "../src/refresh-outcome";
import { ForwardProxyIconResolver, type ForwardProxy, type KernelResolverPolicy } from "../src/kernel-resolver";

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

describe("KernelCacheAuthority", () => {
  it("does not report a generated monogram as a remote refresh success", () => {
    expect(fetchOutcomeFor(entry({ source: "FaviconKit" }))).toBe("success");
    expect(fetchOutcomeFor(entry({ source: "generated monogram" }))).toBe("fallback");
    expect(fetchOutcomeFor(null)).toBe("failure");
  });

  it("matches only its complete private icon route", () => {
    expect(privateIconIdFromPath("/plugin/private/siyuan-linkmark/icon/example-1", "siyuan-linkmark")).toBe("example-1");
    expect(privateIconIdFromPath("/icon/example-1", "siyuan-linkmark")).toBeUndefined();
    expect(privateIconIdFromPath("/plugin/private/siyuan-linkmark/icon/%2Fetc", "siyuan-linkmark")).toBeUndefined();
  });

  it("keeps manifest discovery in the kernel resolver", async () => {
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (url === "https://example.com/") return {
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

    await expect(resolver.resolve(scope())).resolves.toMatchObject({ source: "root rel=icon · web app manifest", contentType: "image/png" });
    expect(forward).toHaveBeenCalledWith("https://example.com/site.webmanifest", "text", "application/manifest+json");
  });

  it("limits automatic resolution to sixteen icon downloads", async () => {
    const downloads: string[] = [];
    const links = Array.from({ length: 17 }, (_, index) => `<link rel="icon" href="/icon-${index}.png">`).join("");
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      if (encoding === "text") return { body: links, contentType: "text/html", status: 200, url };
      downloads.push(url);
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope(), "automatic")).resolves.toBeNull();
    expect(downloads).toHaveLength(16);
  });

  it("keeps manual candidate discovery beyond the automatic download limit", async () => {
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

    await expect(resolver.candidates(scope(), false)).resolves.toEqual([
      expect.objectContaining({ source: "root rel=icon" }),
    ]);
    expect(downloads).toContain("https://example.com/icon-16.png");
  });

  it("coalesces concurrent requests for the same Link scope", async () => {
    const storage = new MemoryStorage();
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    let calls = 0;
    const resolver: IconResolver = {
      resolve: async () => {
        calls += 1;
        return await new Promise((resolve) => { resolveDownload = resolve; });
      },
    };
    const authority = new KernelCacheAuthority(storage, resolver, () => 100);
    await authority.initialize();

    const first = authority.getOrQueue(scope());
    const second = authority.getOrQueue(scope());
    await vi.waitFor(() => expect(calls).toBe(1));

    resolveDownload?.({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentType: "image/png",
      source: "test resolver",
    });
    await expect(first).resolves.toMatchObject({
      domain: "example.com",
      source: "test resolver",
      url: expect.stringContaining("/api/plugin/private/siyuan-linkmark/icon/"),
    });
    await expect(second).resolves.toMatchObject({
      domain: "example.com",
      source: "test resolver",
      url: expect.stringContaining("/api/plugin/private/siyuan-linkmark/icon/"),
    });
    expect(calls).toBe(1);
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
        return {
          bytes: new Uint8Array([requested.key.length]).buffer,
          contentType: "image/png",
          source: requested.key,
        };
      },
    }, () => 100);
    await authority.initialize();

    const requests = ["one.example.com", "two.example.com", "three.example.com", "four.example.com", "five.example.com"]
      .map((key) => authority.getOrQueue(scope(key)));
    const matchingRequest = authority.getOrQueue(scope("one.example.com"));

    await vi.waitFor(() => expect(active).toBe(4), { timeout: 100 });
    expect(calls).toBe(4);

    releases.get("one.example.com")?.();
    await vi.waitFor(() => expect(releases.has("five.example.com")).toBe(true));
    expect(active).toBe(4);
    for (const key of ["two.example.com", "three.example.com", "four.example.com", "five.example.com"]) {
      releases.get(key)?.();
    }

    await expect(Promise.all([...requests, matchingRequest])).resolves.toHaveLength(6);
    expect(calls).toBe(5);
    expect(peakActive).toBe(4);
  });

  it("does not start an invalidated Link scope that is waiting for a resolution slot", async () => {
    const releases = new Map<string, () => void>();
    const calls: string[] = [];
    let active = 0;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async (requested) => {
        calls.push(requested.key);
        active += 1;
        await new Promise<void>((resolve) => releases.set(requested.key, resolve));
        active -= 1;
        return {
          bytes: new Uint8Array([requested.key.length]).buffer,
          contentType: "image/png",
          source: requested.key,
        };
      },
    }, () => 100);
    await authority.initialize();

    const running = ["one.example.com", "two.example.com", "three.example.com", "four.example.com"]
      .map((key) => authority.getOrQueue(scope(key)));
    await vi.waitFor(() => expect(active).toBe(4));
    const queued = authority.getOrQueue(scope("queued.example.com"));
    await authority.remove("queued.example.com");

    releases.get("one.example.com")?.();
    await expect(queued).resolves.toBeNull();
    expect(calls).not.toContain("queued.example.com");

    for (const key of ["two.example.com", "three.example.com", "four.example.com"]) releases.get(key)?.();
    await expect(Promise.all(running)).resolves.toHaveLength(4);
  });

  it("does not start a new automatic download while the workspace policy is paused", async () => {
    const storage = new MemoryStorage();
    const resolve = vi.fn(async () => ({
      bytes: new Uint8Array([1]).buffer,
      contentType: "image/png",
      source: "test resolver",
    }));
    const authority = new KernelCacheAuthority(storage, { resolve }, () => 100, {
      cachePolicy: { cacheDays: 30, pauseAutomaticFetch: true },
    });
    await authority.initialize();

    await expect(authority.getOrQueue(scope(), false, true)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("broadcasts isolated cache snapshots without structuredClone in the kernel runtime", async () => {
    const received: Record<string, CacheEntry>[] = [];
    vi.stubGlobal("structuredClone", undefined);
    try {
      const authority = new KernelCacheAuthority(new MemoryStorage(), {
        resolve: async () => ({ bytes: new Uint8Array([1]).buffer, contentType: "image/png", source: "test resolver" }),
      }, () => 100, {
        onStateChange: (cache) => { received.push(cache); },
      });

      await expect(authority.getOrQueue(scope())).resolves.toMatchObject({ source: "test resolver" });
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

    const pending = authority.getOrQueue(scope());
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    await authority.remove(scope().key);
    resolveDownload?.({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentType: "image/png",
      source: "test resolver",
    });

    await expect(pending).resolves.toBeNull();
    expect(authority.snapshot()).toEqual({});
    expect(storage.files.has("icons/example.com.base64")).toBe(false);
  });

  it("starts a replacement task after an invalidated scope finishes", async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const authority = new KernelCacheAuthority(new MemoryStorage(), {
      resolve: async () => {
        const call = ++calls;
        await new Promise<void>((resolve) => releases.push(resolve));
        return {
          bytes: new Uint8Array([call]).buffer,
          contentType: "image/png",
          source: `resolver ${call}`,
        };
      },
    }, () => 100);
    await authority.initialize();

    const invalidated = authority.getOrQueue(scope());
    await vi.waitFor(() => expect(calls).toBe(1));
    await authority.remove(scope().key);
    const replacement = authority.getOrQueue(scope());

    releases[0]?.();
    await vi.waitFor(() => expect(calls).toBe(2));
    releases[1]?.();

    await expect(invalidated).resolves.toBeNull();
    await expect(replacement).resolves.toMatchObject({ source: "resolver 2" });
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
        return {
          bytes: new Uint8Array([requested.key.length]).buffer,
          contentType: "image/png",
          source: requested.key,
        };
      },
    }, () => 100, {
      onStateChange: (cache) => { received.push(cache); },
    });
    await authority.initialize();

    const first = authority.getOrQueue(scope("first.example.com"));
    const second = authority.getOrQueue(scope("second.example.com"));
    await vi.waitFor(() => expect(releaseDownloads).toHaveLength(2));
    releaseDownloads.forEach((release) => release());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

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
    const authority = new KernelCacheAuthority(storage, {
      resolve: async (requested) => ({
        bytes: new Uint8Array([requested.key.length]).buffer,
        contentType: "image/png",
        source: requested.key,
      }),
    }, () => 100, {
      onStateChange: (cache) => { received.push(cache); },
    });
    await authority.initialize();

    const first = authority.getOrQueue(scope("first.example.com"));
    const second = authority.getOrQueue(scope("second.example.com"));
    const results = await Promise.allSettled([first, second]);

    expect(results).toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "rejected", reason: expect.any(Error) },
    ]);
    expect(storage.cacheIndexWrites).toBe(1);
    expect(received).toEqual([]);
    expect(authority.snapshot()).toEqual({});
    expect([...storage.files.keys()].filter((path) => path.startsWith("icons/"))).toEqual([]);
  });

  it("does not return an entry removed while its cache-index write is in flight", async () => {
    const storage = new BlockingCacheIndexStorage();
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "image/png", source: "test resolver" }),
    }, () => 100);
    await authority.initialize();
    const indexWriteStarted = storage.blockNextCacheIndexWrite();

    const pending = authority.getOrQueue(scope());
    await indexWriteStarted;
    const removal = authority.remove(scope().key);
    storage.releaseCacheIndexWrite();

    await expect(pending).resolves.toBeNull();
    await removal;
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

    const pending = authority.getOrQueue(scope());
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf("function"));
    await authority.clear();
    resolveDownload?.({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentType: "image/png",
      source: "test resolver",
    });

    await expect(pending).resolves.toBeNull();
    expect(authority.snapshot()).toEqual({});
  });

  it("retains pinned entries when clearing the workspace cache", async () => {
    const storage = new MemoryStorage();
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => ({
        bytes: new Uint8Array([1]).buffer,
        contentType: "image/png",
        source: "test resolver",
      }),
    }, () => 100);
    await authority.initialize();
    await authority.putPinned(scope("pinned.example.com"), entry({ domain: "pinned.example.com", pinned: true }), "image/png", new Uint8Array([9]).buffer);
    await authority.getOrQueue(scope());

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
    await expect(authority.getOrQueue(scope())).resolves.toMatchObject({ iconId: first.iconId, pinned: true });
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
    await expect(authority.getOrQueue(scope("first.example.com"))).resolves.toMatchObject({ iconId: original.iconId, pinned: true });
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
    const storage = new MemoryStorage();
    const resolver: IconResolver = {
      resolve: async (requested) => ({
        bytes: new Uint8Array([requested.key.length]).buffer,
        contentType: "image/png",
        source: requested.key,
      }),
    };
    const authority = new KernelCacheAuthority(storage, resolver, () => 100);
    await authority.initialize();

    await Promise.all([
      authority.getOrQueue({ ...scope("docs.example.com::doc"), domain: "docs.example.com" }),
      authority.getOrQueue({ ...scope("docs.example.com::sheet"), domain: "docs.example.com" }),
    ]);

    expect(authority.snapshot()).toEqual({
      "docs.example.com::doc": expect.objectContaining({ source: "docs.example.com::doc" }),
      "docs.example.com::sheet": expect.objectContaining({ source: "docs.example.com::sheet" }),
    });
  });

  it("publishes a refreshed icon under a new private payload before cleaning the old payload", async () => {
    const storage = new MemoryStorage();
    let byte = 1;
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => ({ bytes: new Uint8Array([byte++]).buffer, contentType: "image/png", source: "test resolver" }),
    }, () => 100);
    await authority.initialize();

    const first = await authority.getOrQueue(scope());
    const second = await authority.getOrQueue(scope(), true);

    expect(first?.iconId).not.toBe(second?.iconId);
    await expect(authority.icon(first!.iconId!)).resolves.toBeUndefined();
    await expect(authority.icon(second!.iconId!)).resolves.toMatchObject({ contentType: "image/png" });
  });
});
