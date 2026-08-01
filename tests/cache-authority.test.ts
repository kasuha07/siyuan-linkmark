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
    expect(privateIconIdFromPath("/plugin/private/auto-favicon/icon/example-1", "auto-favicon")).toBe("example-1");
    expect(privateIconIdFromPath("/icon/example-1", "auto-favicon")).toBeUndefined();
    expect(privateIconIdFromPath("/plugin/private/auto-favicon/icon/%2Fetc", "auto-favicon")).toBeUndefined();
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
    await expect(first).resolves.toMatchObject({ domain: "example.com", source: "test resolver" });
    await expect(second).resolves.toMatchObject({ domain: "example.com", source: "test resolver" });
    expect(calls).toBe(1);
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

  it("does not let a cache clear recreate an in-flight cache miss", async () => {
    const storage = new MemoryStorage();
    let resolveDownload: ((value: { bytes: ArrayBuffer; contentType: string; source: string }) => void) | undefined;
    const authority = new KernelCacheAuthority(storage, {
      resolve: async () => await new Promise((resolve) => { resolveDownload = resolve; }),
    }, () => 100);
    await authority.initialize();

    const pending = authority.getOrQueue(scope());
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
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);
    await authority.initialize();
    const first = await authority.putPinned(scope(), entry({ pinned: true }), "image/png", new Uint8Array([1]).buffer);
    storage.failNextPut = true;

    await expect(authority.putPinned(scope(), entry({ pinned: true }), "image/png", new Uint8Array([2]).buffer)).rejects.toThrow("simulated storage failure");

    expect(authority.snapshot()["example.com"]).toMatchObject({ iconId: first.iconId, pinned: true });
    await expect(authority.icon(first.iconId!)).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("imports legacy entries and keeps valid pinned icons", async () => {
    const storage = new MemoryStorage();
    storage.files.set("favicon-cache.json", JSON.stringify({
      "pinned.example.com": entry({ domain: "pinned.example.com", pinned: true, url: "/public/auto-favicon/pinned.png" }),
    }));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100);

    await authority.initialize();

    expect(authority.snapshot()).toEqual({
      "pinned.example.com": expect.objectContaining({ pinned: true, url: "/public/auto-favicon/pinned.png" }),
    });
  });

  it("keeps the authority available when a legacy payload cannot be read", async () => {
    const storage = new MemoryStorage();
    storage.files.set("favicon-cache.json", JSON.stringify({
      "legacy.example.com": entry({ domain: "legacy.example.com", url: "/public/auto-favicon/legacy.png" }),
    }));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100, {
      loadLegacyIcon: async () => { throw new Error("legacy file API unavailable"); },
    });

    await authority.initialize();

    expect(authority.snapshot()["legacy.example.com"]).toMatchObject({ url: "/public/auto-favicon/legacy.png" });
    expect(storage.files.get("favicon-cache-v2.json")).toContain("legacy.example.com");
  });

  it("moves readable legacy icon bytes behind the private icon route", async () => {
    const storage = new MemoryStorage();
    storage.files.set("favicon-cache.json", JSON.stringify({
      "pinned.example.com": entry({ domain: "pinned.example.com", pinned: true, url: "/public/auto-favicon/pinned.png" }),
    }));
    const authority = new KernelCacheAuthority(storage, { resolve: async () => null }, () => 100, {
      privateIconUrl: (iconId) => `/plugin/private/auto-favicon/icon/${iconId}`,
      loadLegacyIcon: async () => ({ bytes: new Uint8Array([9, 8, 7]).buffer, contentType: "image/png" }),
    });

    await authority.initialize();

    const migrated = authority.snapshot()["pinned.example.com"];
    expect(migrated).toMatchObject({ pinned: true, url: "/plugin/private/auto-favicon/icon/pinned.example.com", iconId: "pinned.example.com" });
    await expect(authority.icon("pinned.example.com")).resolves.toMatchObject({ contentType: "image/png" });
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
