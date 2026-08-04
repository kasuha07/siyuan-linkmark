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

describe("FrontendCacheClient change filtering", () => {
  function clientWithLookup(
    lookup: ReturnType<typeof vi.fn>,
    changed: ReturnType<typeof vi.fn>,
  ) {
    const handlers = new Map<string, (params: unknown) => void>();
    const client = new FrontendCacheClient({
      rpc: {
        call: {
          "cache.stats": vi.fn(async () => ({ entryCount: 1, epoch: "kernel-1", revision: 0 })),
          "cache.policy.get": vi.fn(async () => ({})),
          "cache.lookup": lookup,
        },
        bind: (name, handler) => { handlers.set(name, handler); },
      },
      settings: { ...defaultSettings },
      callbacks: { onCacheChanged: changed, onEntryCountChange: vi.fn(), onManualRefreshFailed: vi.fn() },
    });
    return { handlers, client };
  }

  function scopeLookup(entries: Record<string, { cacheKey: string; entry: Record<string, unknown>; entryToken: string }>) {
    let revision = 0;
    return vi.fn(async (scopes: Array<{ key: string }>) => ({
      epoch: "kernel-1",
      revision: ++revision,
      matches: Object.fromEntries(scopes.map((scope) => [scope.key, entries[scope.key] ?? null])),
    }));
  }

  it("keeps matches untouched and skips synchronization when a touched revision changes nothing", async () => {
    const changed = vi.fn();
    const lookup = scopeLookup({
      "example.dev": {
        cacheKey: "example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
        entryToken: "token-a",
      },
    });
    const { handlers, client } = clientWithLookup(lookup, changed);
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    const entry = client.entries()["example.dev"];

    // The key touches the Present scope, so the lookup still runs, but the
    // equal entry token proves no match changed and nothing is reported.
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2, changedKeys: ["example.dev"] });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(client.entries()["example.dev"]).toBe(entry);
  });

  it("reports only the departed keys when scopes leave the working set", async () => {
    const changed = vi.fn();
    const entries = {
      "example.dev": {
        cacheKey: "example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
        entryToken: "token-a",
      },
      "other.dev": {
        cacheKey: "other.dev",
        entry: { url: "other.png", fetchedAt: 1, domain: "other.dev" },
        entryToken: "token-b",
      },
    };
    const lookup = vi.fn(async (scopes: Array<{ key: string }>) => ({
      epoch: "kernel-1",
      revision: 1,
      matches: Object.fromEntries(scopes.map((scope) => [scope.key, entries[scope.key as keyof typeof entries] ?? null])),
    }));
    const { client } = clientWithLookup(lookup, changed);
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([
      { key: "example.dev", domain: "example.dev" },
      { key: "other.dev", domain: "other.dev" },
    ]);
    expect(Object.keys(client.entries())).toEqual(["example.dev", "other.dev"]);

    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    await vi.waitFor(() => expect(client.entries()["other.dev"]).toBeUndefined());
    // The shrink is reported as the departed key alone: an unchanged match
    // keeps its entry, while a key that left the working set always differs
    // from its missing new token and must not be silently dropped.
    expect(changed).toHaveBeenCalledTimes(2);
    const [previous, changedKeys] = changed.mock.calls[1] as [Record<string, unknown>, string[]];
    expect(changedKeys).toEqual(["other.dev"]);
    expect(previous["other.dev"]).toEqual({ url: "other.png", fetchedAt: 1, domain: "other.dev" });
    expect(client.entries()["example.dev"]).toEqual({ url: "icon.png", fetchedAt: 1, domain: "example.dev" });
  });

  it("reports only genuinely changed keys with a sparse before view", async () => {
    const changed = vi.fn();
    const lookup = vi.fn()
      .mockResolvedValueOnce({
        epoch: "kernel-1",
        revision: 1,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
            entryToken: "token-a",
          },
          "other.dev": {
            cacheKey: "other.dev",
            entry: { url: "other.png", fetchedAt: 1, domain: "other.dev" },
            entryToken: "token-b",
          },
        },
      })
      .mockResolvedValueOnce({
        epoch: "kernel-1",
        revision: 2,
        matches: {
          "example.dev": {
            cacheKey: "example.dev",
            entry: { url: "new.png", fetchedAt: 2, domain: "example.dev" },
            entryToken: "token-a2",
          },
          "other.dev": {
            cacheKey: "other.dev",
            entry: { url: "other.png", fetchedAt: 1, domain: "other.dev" },
            entryToken: "token-b",
          },
        },
      });
    const { handlers, client } = clientWithLookup(lookup, changed);
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([
      { key: "example.dev", domain: "example.dev" },
      { key: "other.dev", domain: "other.dev" },
    ]);

    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2, changedKeys: ["example.dev"] });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    const [previous, changedKeys] = changed.mock.calls[1] as [Record<string, unknown>, string[]];
    expect(changedKeys).toEqual(["example.dev"]);
    expect(Object.hasOwn(previous, "example.dev")).toBe(true);
    expect(previous["example.dev"]).toEqual({ url: "icon.png", fetchedAt: 1, domain: "example.dev" });
    expect(Object.hasOwn(previous, "other.dev")).toBe(false);
    expect(client.entries()["example.dev"]).toEqual({ url: "new.png", fetchedAt: 2, domain: "example.dev" });
  });

  it("skips the working-set lookup when changed keys cannot affect any Present scope", async () => {
    const changed = vi.fn();
    const lookup = scopeLookup({
      "example.dev": {
        cacheKey: "example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
        entryToken: "token-a",
      },
    });
    const { handlers, client } = clientWithLookup(lookup, changed);
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);

    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2, changedKeys: ["unrelated.test"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("looks up when changed keys touch a route scope's own, domain, or share-domain slot", async () => {
    const lookup = scopeLookup({
      "sub.example.dev::docs": {
        cacheKey: "sub.example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "sub.example.dev" },
        entryToken: "token-a",
      },
    });
    const { handlers, client } = clientWithLookup(lookup, vi.fn());
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{
      key: "sub.example.dev::docs",
      domain: "sub.example.dev",
      routeKey: "docs",
      pathPrefix: "/docs",
    }]);

    // Unrelated: neither the route key, its domain slot, nor its share slot.
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2, changedKeys: ["example.com"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookup).toHaveBeenCalledTimes(1);
    // The route scope's own key.
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 3, changedKeys: ["sub.example.dev::docs"] });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    // The route scope's domain slot.
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 4, changedKeys: ["sub.example.dev"] });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(3));
    // The route scope's eligible share slot.
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 5, changedKeys: ["example.dev"] });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(4));
  });

  it("looks up when changedKeys is missing or a null sentinel", async () => {
    const lookup = scopeLookup({
      "example.dev": {
        cacheKey: "example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
        entryToken: "token-a",
      },
    });
    const { handlers, client } = clientWithLookup(lookup, vi.fn());
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);

    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2 });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 3, changedKeys: null });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(3));
  });

  it("looks up when the event comes from another epoch even with no intersecting keys", async () => {
    const lookup = scopeLookup({
      "example.dev": {
        cacheKey: "example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
        entryToken: "token-a",
      },
    });
    const { handlers, client } = clientWithLookup(lookup, vi.fn());
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);

    handlers.get("cache.changed")?.({ epoch: "kernel-2", revision: 1, changedKeys: ["unrelated.test"] });
    await vi.waitFor(() => expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("never looks up for invalidation events without Present scopes", async () => {
    const lookup = scopeLookup({
      "example.dev": {
        cacheKey: "example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
        entryToken: "token-a",
      },
    });
    const { handlers, client } = clientWithLookup(lookup, vi.fn());
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    await client.setPresentScopes([]);
    const callsBefore = lookup.mock.calls.length;

    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2, changedKeys: ["example.dev"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookup.mock.calls.length).toBe(callsBefore);
  });

  it("notifies cursor listeners even when the lookup is skipped", async () => {
    const lookup = scopeLookup({
      "example.dev": {
        cacheKey: "example.dev",
        entry: { url: "icon.png", fetchedAt: 1, domain: "example.dev" },
        entryToken: "token-a",
      },
    });
    const { handlers, client } = clientWithLookup(lookup, vi.fn());
    await client.load();
    await client.subscribe();
    await client.setPresentScopes([{ key: "example.dev", domain: "example.dev" }]);
    const cursor = vi.fn();
    client.onCursorChange(cursor);

    handlers.get("cache.changed")?.({ epoch: "kernel-1", revision: 2, changedKeys: ["unrelated.test"] });
    expect(cursor).toHaveBeenCalledWith({ epoch: "kernel-1", revision: 2 });
    expect(lookup).toHaveBeenCalledTimes(1);
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

  it("counts an unavailable get-or-queue as skipped in a manual domain refresh", async () => {
    const { calls, client } = syncedClient();
    calls["cache.get-or-queue"] = vi.fn(async () => ({ status: "unavailable" }));
    await client.load();
    const result = await client.refreshDomains(new Map([
      ["example.dev", {
        scope: { key: "example.dev", domain: "example.dev", targetUrl: "https://example.dev/" },
        targetUrl: "https://example.dev/",
      }],
    ]));
    expect(result).toEqual({ queued: 0, failed: 0, skipped: 1, failures: [] });
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
