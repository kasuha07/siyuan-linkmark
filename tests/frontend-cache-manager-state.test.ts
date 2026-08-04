import { describe, expect, it, vi } from "vitest";
import { CacheManagerPageController } from "../src/frontend-cache-manager-state";

describe("CacheManagerPageController", () => {
  it("debounces search and publishes only the newest revision-tagged page", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async ({ query }: { query: string; offset: number; limit: number }) => ({
        query, offset: 0, limit: 100, total: query === "new" ? 1 : 2,
        epoch: "kernel", revision: query === "new" ? 2 : 1,
        items: query === "new" ? [{ key: "new.dev", entry: { url: "new.png", fetchedAt: 1 }, entryToken: "new" }] : [],
      }));
      const states: unknown[] = [];
      const controller = new CacheManagerPageController({ load, onChange: (state) => states.push(state) });

      controller.setQuery("old");
      controller.setQuery("new");
      expect(load).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);

      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith({ query: "new", offset: 0, limit: 100 });
      expect(controller.state().page?.items.map((item) => item.key)).toEqual(["new.dev"]);
      expect(states.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads an invalidated page and clamps an empty trailing page", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ query: "", offset: 100, limit: 100, total: 101, epoch: "kernel", revision: 1, items: [{ key: "last.dev", entry: { url: "x", fetchedAt: 1 }, entryToken: "x" }] })
      .mockResolvedValueOnce({ query: "", offset: 100, limit: 100, total: 100, epoch: "kernel", revision: 2, items: [] })
      .mockResolvedValueOnce({ query: "", offset: 0, limit: 100, total: 100, epoch: "kernel", revision: 2, items: [{ key: "first.dev", entry: { url: "x", fetchedAt: 1 }, entryToken: "y" }] });
    const controller = new CacheManagerPageController({ load, onChange: () => undefined });

    await controller.goToOffset(100);
    await controller.invalidate({ epoch: "kernel", revision: 2 });

    expect(load).toHaveBeenLastCalledWith({ query: "", offset: 0, limit: 100 });
    expect(controller.state().page?.offset).toBe(0);
  });
});
