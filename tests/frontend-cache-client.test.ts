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
            entryToken: "token-2",
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
          entryToken: "token-1",
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

describe("FrontendCacheClient expiry guard", () => {
  function clientWith(
    calls: Record<string, (...args: unknown[]) => Promise<unknown>>,
    handlers: Map<string, (params: unknown) => void> = new Map(),
  ) {
    return new FrontendCacheClient({
      rpc: {
        call: calls,
        bind: (name, handler) => { handlers.set(name, handler); },
      },
      settings: { ...defaultSettings },
      callbacks: { onCacheChanged: vi.fn(), onEntryCountChange: vi.fn(), onManualRefreshFailed: vi.fn() },
    });
  }

  function syncedClient() {
    let revision = 2;
    const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 2 })),
      "cache.policy.get": vi.fn(async () => ({})),
      "cache.lookup": vi.fn(async () => ({
        epoch: "kernel-1",
        revision: revision++,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
            entryToken: "token-a",
          },
        },
      })),
    };
    return { calls, client: clientWith(calls) };
  }

  it("removes an expired entry with the authoritative guard", async () => {
    const remove = vi.fn(async () => ({ status: "committed", epoch: "kernel-1", revision: 3 }));
    const { calls, client } = syncedClient();
    calls["cache.remove"] = remove;
    await client.load();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    const expected = client.entries()["example.dev"];
    const settled = vi.fn();

    await client.expire("example.dev", expected, settled);

    expect(remove).toHaveBeenCalledWith("example.dev", { epoch: "kernel-1", entryToken: "token-a" });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry when the kernel reports the guard no longer matches", async () => {
    const remove = vi.fn(async () => { throw { code: "cache_entry_changed" }; });
    const { calls, client } = syncedClient();
    calls["cache.remove"] = remove;
    await client.load();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    const expected = client.entries()["example.dev"];

    await expect(client.expire("example.dev", expected)).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledWith("example.dev", { epoch: "kernel-1", entryToken: "token-a" });
    expect(client.entries()["example.dev"]).toBe(expected);
  });

  it("skips the removal when the local view no longer matches the decision", async () => {
    const remove = vi.fn(async () => ({ status: "committed", epoch: "kernel-1", revision: 4 }));
    const handlers = new Map<string, (params: unknown) => void>();
    const lookup = vi.fn()
      .mockResolvedValueOnce({
        epoch: "kernel-1",
        revision: 2,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
            entryToken: "token-a",
          },
        },
      })
      .mockResolvedValueOnce({
        epoch: "kernel-1",
        revision: 3,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev", pinned: true },
            entryToken: "token-b",
          },
        },
      });
    const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 2 })),
      "cache.policy.get": vi.fn(async () => ({})),
      "cache.lookup": lookup,
      "cache.remove": remove,
    };
    const client = clientWith(calls, handlers);
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    const expected = client.entries()["example.dev"];
    // A cache.changed event rebaselines the local view (a pin landed) before
    // the expiry removal runs.
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 3 });
    await vi.waitFor(() => expect(client.entries()["example.dev"]).not.toBe(expected));

    await client.expire("example.dev", expected);

    expect(remove).not.toHaveBeenCalled();
  });

  it("skips the removal for a decision whose local view was never synchronized", async () => {
    const remove = vi.fn(async () => ({ status: "committed", epoch: "kernel-1", revision: 3 }));
    const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 0 })),
      "cache.policy.get": vi.fn(async () => ({})),
      "cache.lookup": vi.fn(async () => ({
        epoch: "kernel-1",
        revision: 0,
        matches: { "example.dev": null },
      })),
      "cache.remove": remove,
    };
    const client = clientWith(calls);
    await client.load();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    const staleEntry = { url: "orphan.png", fetchedAt: 1, domain: "example.dev" } as const;

    await client.expire("example.dev", staleEntry);

    expect(remove).not.toHaveBeenCalled();
  });
});

describe("FrontendCacheClient fetch failure containment", () => {
  function syncedClient() {
    let revision = 2;
    const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 2 })),
      "cache.policy.get": vi.fn(async () => ({})),
      "cache.lookup": vi.fn(async () => ({
        epoch: "kernel-1",
        revision: revision++,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
            entryToken: "token-a",
          },
        },
      })),
    };
    return { calls, client: new FrontendCacheClient({
      rpc: { call: calls, bind: () => undefined },
      settings: { ...defaultSettings },
      callbacks: { onCacheChanged: vi.fn(), onEntryCountChange: vi.fn(), onManualRefreshFailed: vi.fn() },
    }) };
  }

  it("never leaks an unhandled rejection when a fire-and-forget fetch fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const { calls, client } = syncedClient();
    calls["cache.get-or-queue"] = vi.fn(async () => { throw new Error("kernel unreachable"); });
    await client.load();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    try {
      // The scan's fire-and-forget call pattern must never surface a rejection.
      void client.fetchAndCache({ key: "example.dev", domain: "example.dev" }, "https://example.dev/");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("re-requests through the supersede path when a manual fetch supersedes an automatic one", async () => {
    let resolveFirst!: (value: unknown) => void;
    const getOrQueue = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ status: "unavailable" });
    const { calls, client } = syncedClient();
    calls["cache.get-or-queue"] = getOrQueue;
    await client.load();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    const scope = { key: "example.dev", domain: "example.dev", targetUrl: "https://example.dev/" };

    const automatic = client.fetchAndCache(scope, scope.targetUrl);
    const manual = client.fetchAndCache(scope, scope.targetUrl, false, "manual");
    resolveFirst({ status: "ready", entry: { url: "icon.png", fetchedAt: 2, domain: "example.dev", source: "test resolver" }, entryToken: "token-x" });

    await expect(automatic).resolves.toBe("success");
    await expect(manual).resolves.toBe("unavailable");
    expect(getOrQueue).toHaveBeenCalledTimes(2);
  });
});

describe("FrontendCacheClient cursor rebaseline", () => {
  function clientWithHandlers(
    calls: Record<string, (...args: unknown[]) => Promise<unknown>>,
    handlers = new Map<string, (params: unknown) => void>(),
  ) {
    return new FrontendCacheClient({
      rpc: {
        call: calls,
        bind: (name, handler) => { handlers.set(name, handler); },
      },
      settings: { ...defaultSettings },
      callbacks: { onCacheChanged: vi.fn(), onEntryCountChange: vi.fn(), onManualRefreshFailed: vi.fn() },
    });
  }

  it("rebaselines to a fresh kernel epoch and converges without retrying forever", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce({
        epoch: "kernel-2",
        revision: 3,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "discarded.png", fetchedAt: 3, domain: "example.dev" },
            entryToken: "token-old",
          },
        },
      })
      .mockResolvedValueOnce({
        epoch: "kernel-2",
        revision: 3,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "adopted.png", fetchedAt: 3, domain: "example.dev" },
            entryToken: "token-new",
          },
        },
      })
      // A regression to the infinite retry loop must not hang the test; it
      // only fails the call-count assertion below.
      .mockResolvedValue({
        epoch: "kernel-2",
        revision: 3,
        matches: {},
      });
    const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 2 })),
      "cache.policy.get": vi.fn(async () => ({})),
      "cache.lookup": lookup,
    };
    const changed = vi.fn();
    const client = new FrontendCacheClient({
      rpc: { call: calls, bind: () => undefined },
      settings: { ...defaultSettings },
      callbacks: { onCacheChanged: changed, onEntryCountChange: vi.fn(), onManualRefreshFailed: vi.fn() },
    });

    await client.load();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);

    expect(lookup).toHaveBeenCalledTimes(2);
    // The first response's entries are discarded on rebaseline; only the
    // re-issued lookup under the new baseline is adopted.
    expect(client.entries()).toEqual({
      "example.dev": { url: "adopted.png", fetchedAt: 3, domain: "example.dev" },
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("discards a stale previous-epoch lookup response and converges to the fresh epoch", async () => {
    let resolveFirst!: (value: unknown) => void;
    const lookup = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        epoch: "kernel-2",
        revision: 1,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "fresh.png", fetchedAt: 1, domain: "example.dev" },
            entryToken: "token-fresh",
          },
        },
      })
      .mockResolvedValueOnce({
        epoch: "kernel-2",
        revision: 1,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "fresh.png", fetchedAt: 1, domain: "example.dev" },
            entryToken: "token-fresh",
          },
        },
      })
      .mockResolvedValue({
        epoch: "kernel-2",
        revision: 1,
        matches: {},
      });
    const handlers = new Map<string, (params: unknown) => void>();
    const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
      "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 5 })),
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
    const synchronization = client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    // The reload is first discovered through a cache.changed event, then the
    // stale in-flight lookup from the previous epoch arrives late.
    handlers.get("cache.changed")?.({ epoch: "kernel-2", revision: 1 });
    resolveFirst({
      epoch: "kernel-1",
      revision: 7,
      matches: {
        "example.dev": {
          cacheKey: "example.dev",
          entry: { url: "stale.png", fetchedAt: 7, domain: "example.dev" },
          entryToken: "token-stale",
        },
      },
    });
    await synchronization;

    expect(lookup).toHaveBeenCalledTimes(3);
    // The previous-epoch response must never overwrite the fresh state, and
    // its rebase back to the old epoch is corrected by the next lookup.
    expect(client.entries()).toEqual({
      "example.dev": { url: "fresh.png", fetchedAt: 1, domain: "example.dev" },
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("stops the refresh when the kernel is unavailable and recovers on the next trigger", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const handlers = new Map<string, (params: unknown) => void>();
      const lookup = vi.fn()
        .mockRejectedValueOnce(new Error("kernel reloading"))
        .mockResolvedValueOnce({
          epoch: "kernel-1",
          revision: 1,
          matches: {
            "example.dev": {
              cacheKey: "example.dev",
              entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
              entryToken: "token-a",
            },
          },
        })
        .mockResolvedValue({
          epoch: "kernel-1",
          revision: 1,
          matches: {},
        });
      const calls: Record<string, (...args: unknown[]) => Promise<unknown>> = {
        "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 0 })),
        "cache.policy.get": vi.fn(async () => ({})),
        "cache.lookup": lookup,
      };
      const client = clientWithHandlers(calls, handlers);

      await client.load();
      await client.subscribe();
      await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(client.entries()).toEqual({});

      // A later cursor event starts a fresh refresh that recovers.
      handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 1 });
      await vi.waitFor(() => expect(client.entries()).toEqual({
        "example.dev": { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
      }));
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });
});
