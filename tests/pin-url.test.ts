import { describe, expect, it, vi } from "vitest";
import type { CacheEntry, LinkScope, ResolvedIcon } from "../src/cache-authority";
import { INVALID_SHARE_DOMAIN } from "../src/parent-domain";
import { pinCustomUrl, type PinUrlDependencies } from "../src/pin-url";

function scope(domain: string): LinkScope {
  return { key: domain, domain, targetUrl: `https://${domain}/` };
}

function resolvedIcon(): ResolvedIcon {
  return { bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "image/png", source: "custom URL" };
}

function makeDeps(overrides: Partial<PinUrlDependencies> = {}) {
  const resolveUrl = vi.fn(async () => null);
  const putPinned = vi.fn<PinUrlDependencies["putPinned"]>(async (_scope: LinkScope, entry: CacheEntry) => entry);
  return {
    deps: { resolveUrl, putPinned, ...overrides } as PinUrlDependencies,
    resolveUrl,
    putPinned,
  };
}

describe("cache.pin-url error order", () => {
  it("rejects an invalid shared pin with the stable invalid-share-domain error before any URL download", async () => {
    for (const domain of ["github.io", "foo.github.io", "qq.com", "www.example.com", "a..example.com", "foo.onion", "x.home.arpa", "foo.alt"]) {
      const { deps: handlers, resolveUrl, putPinned } = makeDeps();
      await expect(
        pinCustomUrl(handlers, scope(domain), "https://cdn.example.dev/icon.png", true),
      ).rejects.toThrow(INVALID_SHARE_DOMAIN);
      expect(resolveUrl).not.toHaveBeenCalled();
      expect(putPinned).not.toHaveBeenCalled();
    }
  });

  it("keeps the invalid-share-domain error first even when the icon URL would resolve", async () => {
    const { deps: handlers, resolveUrl, putPinned } = makeDeps({ resolveUrl: vi.fn(async () => resolvedIcon()) });
    await expect(
      pinCustomUrl(handlers, scope("foo.github.io"), "https://cdn.example.dev/icon.png", true),
    ).rejects.toThrow(INVALID_SHARE_DOMAIN);
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(putPinned).not.toHaveBeenCalled();
  });

  it("reports the download failure for an exact pin at an ineligible eTLD+1", async () => {
    const { deps: handlers, resolveUrl, putPinned } = makeDeps();
    await expect(
      pinCustomUrl(handlers, scope("foo.github.io"), "https://broken.example.dev/icon.png", false),
    ).rejects.toThrow("Custom icon URL did not return a usable image");
    expect(resolveUrl).toHaveBeenCalledWith("https://broken.example.dev/icon.png");
    expect(putPinned).not.toHaveBeenCalled();
  });

  it("reports the download failure for a shared pin at an eligible eTLD+1", async () => {
    const { deps: handlers, putPinned } = makeDeps();
    await expect(
      pinCustomUrl(handlers, scope("example.dev"), "https://broken.example.dev/icon.png", true),
    ).rejects.toThrow("Custom icon URL did not return a usable image");
    expect(putPinned).not.toHaveBeenCalled();
  });

  it("pins a successfully downloaded custom URL with the shared-pin entry fields", async () => {
    const { deps: handlers, putPinned } = makeDeps({ resolveUrl: vi.fn(async () => resolvedIcon()) });
    const pinned = await pinCustomUrl(handlers, scope("example.dev"), "https://cdn.example.dev/icon.png", true, "replaced.example.dev");
    expect(putPinned).toHaveBeenCalledTimes(1);
    expect(putPinned.mock.calls[0][0]).toEqual(scope("example.dev"));
    expect(putPinned.mock.calls[0][1]).toMatchObject({
      url: "", source: "custom URL", targetUrl: "https://example.dev/",
      domain: "example.dev", pinned: true, includeSubdomains: true,
    });
    expect(putPinned.mock.calls[0][2]).toBe("image/png");
    expect(new Uint8Array(putPinned.mock.calls[0][3])).toEqual(new Uint8Array([1, 2, 3]));
    expect(putPinned.mock.calls[0][4]).toBe("replaced.example.dev");
    expect(pinned).toEqual(putPinned.mock.calls[0][1]);
  });
});
