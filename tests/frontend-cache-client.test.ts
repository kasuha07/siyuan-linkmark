import { describe, expect, it, vi } from "vitest";
import { FrontendCacheClient } from "../src/frontend-cache-client";
import { defaultSettings } from "../src/frontend-settings";

describe("FrontendCacheClient working set", () => {
  it("loads stats without a snapshot and coalesces invalidated Present-scope lookups", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    let resolveFirst!: (value: unknown) => void;
    const lookup = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        epoch: "kernel-1",
        revision: 2,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "icon-2.png", fetchedAt: 2, domain: "example.dev" },
          },
        },
      });
    const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      "cache.stats": vi.fn(async () => ({ entryCount: 10_000, epoch: "kernel-1", revision: 0 })),
      "cache.policy.get": vi.fn(async () => ({})),
      "cache.lookup": lookup,
    };
    const changed = vi.fn();
    const client = new FrontendCacheClient({
      rpc: {
        call: calls,
        bind: (name, handler) => { handlers.set(name, handler); },
      },
      settings: { ...defaultSettings },
      callbacks: { onCacheChanged: changed, onEntryCountChange: vi.fn(), onManualRefreshFailed: vi.fn() },
    });

    await client.load();
    await client.subscribe();
    expect(calls["cache.snapshot"]).toBeUndefined();
    expect(client.entryCount()).toBe(10_000);

    const synchronization = client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2 });
    resolveFirst({
      epoch: "kernel-1",
      revision: 1,
      matches: {
        "example.dev": {
          cacheKey: "example.dev",
          entry: { url: "stale.png", fetchedAt: 1, domain: "example.dev" },
        },
      },
    });
    await synchronization;

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(client.entries()).toEqual({
      "example.dev": { url: "icon-2.png", fetchedAt: 2, domain: "example.dev" },
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
