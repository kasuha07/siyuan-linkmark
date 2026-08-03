import { describe, expect, it } from "vitest";
import {
  FrontendPerformanceTrace,
  INCREMENTAL_SAMPLE_CAP,
  type FrontendTraceStageName,
  type FrontendTraceSummary,
} from "../src/frontend-performance-trace";
import {
  FrontendRenderWorkQueue,
  type FrontendRenderWorkExecutor,
} from "../src/frontend-render-work";
import { reconcilePresentBindings } from "../src/icon-rule";
import { PERF_CACHE_VIEW_ENTRIES, PERF_SCOPE_COUNT } from "../src/perf-scenario";
import { scopeForUrl } from "../src/url-scope";

function fakeClock() {
  let now = 0;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function batchExecutor(
  trace: FrontendPerformanceTrace,
  durations: Partial<Record<FrontendTraceStageName | "rebuild", number>>,
): FrontendRenderWorkExecutor<number> {
  return {
    rebuildRules: () => {
      if (durations.rebuild !== undefined) advanceWithin(durations.rebuild);
    },
    discover: (discovery) => {
      if (durations.discovery !== undefined) trace.stage("discovery", () => advanceWithin(durations.discovery!));
      if (durations.reconcile !== undefined) trace.stage("reconcile", () => advanceWithin(durations.reconcile!));
      return discovery !== null;
    },
    publishRules: () => {
      if (durations.publication !== undefined) trace.stage("publication", () => advanceWithin(durations.publication!));
    },
  };
}

let advanceWithin = (_ms: number) => {};

describe("FrontendPerformanceTrace", () => {
  it("reports nothing while inactive and requires enable to start a session", () => {
    const { clock } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    const queue = new FrontendRenderWorkQueue<number>();
    queue.requestRulePublication();

    trace.input();
    trace.flush(queue, batchExecutor(trace, {}));

    expect(trace.disable()).toBeNull();
    expect(trace.active).toBe(false);
  });

  it("computes the incremental interaction P95 from batch totals only", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    for (let batch = 1; batch <= 100; batch += 1) {
      queue.requestLocalDiscovery(batch);
      queue.flushDiscovery();
      trace.flush(queue, batchExecutor(trace, { discovery: batch, reconcile: 0, publication: 0 }));
    }
    queue.requestFullDiscovery();
      queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 50, reconcile: 50, publication: 50 }));

    const summary = trace.disable();
    expect(summary?.incrementalInteractions).toBe(100);
    expect(summary?.incrementalP95Ms).toBe(95);
    expect(summary?.fullDiscoveries).toBe(1);
    expect(summary?.slowestFullDiscoveryMs).toBe(100);
    expect(summary?.stages.publication.samples).toBe(101);
    expect(trace.active).toBe(false);
  });

  it("records the slowest full discovery excluding its publication stage", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    for (const [discovery, reconcile, publication] of [[40, 10, 80], [20, 5, 5], [45, 12, 1]]) {
      queue.requestFullDiscovery();
      queue.flushDiscovery();
      trace.flush(queue, batchExecutor(trace, { discovery, reconcile, publication }));
    }

    const summary = trace.disable();
    expect(summary?.fullDiscoveries).toBe(3);
    expect(summary?.slowestFullDiscoveryMs).toBe(57);
    expect(summary?.incrementalInteractions).toBe(0);
  });

  it("keeps a coincident rule rebuild out of the full-discovery total", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    queue.requestFullDiscovery();
    queue.requestRuleRebuild();
    queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 40, reconcile: 10, rebuild: 30, publication: 5 }));

    const summary = trace.disable();
    expect(summary?.fullDiscoveries).toBe(1);
    expect(summary?.slowestFullDiscoveryMs).toBe(50);
    expect(summary?.stages.reconcile.samples).toBe(2);
    expect(summary?.stages.reconcile.totalMs).toBe(40);
  });

  it("measures rule freshness from the last input to the batch publication end", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    advance(1_000);
    trace.input();
    advance(250);
    queue.requestLocalDiscovery(1);
      queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 1, reconcile: 1, publication: 2 }));

    advance(10);
    queue.requestLocalDiscovery(2);
      queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 1 }));

    const summary = trace.disable();
    expect(summary?.ruleFreshnessSamples).toBe(1);
    expect(summary?.slowestRuleFreshnessMs).toBe(250 + 1 + 1 + 2);
  });

  it("bounds the retained P95 window while the interaction count covers the session", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    for (let batch = 1; batch <= INCREMENTAL_SAMPLE_CAP + 100; batch += 1) {
      queue.requestLocalDiscovery(batch);
      queue.flushDiscovery();
      trace.flush(queue, batchExecutor(trace, { discovery: 1 }));
    }

    const summary = trace.disable();
    expect(summary?.batches).toBe(INCREMENTAL_SAMPLE_CAP + 100);
    expect(summary?.incrementalInteractions).toBe(INCREMENTAL_SAMPLE_CAP + 100);
    expect(summary?.stages.discovery.samples).toBe(INCREMENTAL_SAMPLE_CAP + 100);
    expect(summary?.incrementalP95Ms).toBe(1);
  });

  it("does not count a rebuild-only batch as an incremental interaction", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    queue.requestRuleRebuild();
    trace.flush(queue, batchExecutor(trace, { rebuild: 5, publication: 1 }));

    const summary = trace.disable();
    expect(summary?.batches).toBe(1);
    expect(summary?.incrementalInteractions).toBe(0);
    expect(summary?.stages.reconcile.samples).toBe(1);
    expect(summary?.stages.reconcile.totalMs).toBe(5);
  });

  it("does not count a publication-only batch as an incremental interaction", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    queue.requestRulePublication();
    trace.flush(queue, batchExecutor(trace, { publication: 2 }));

    const summary = trace.disable();
    expect(summary?.batches).toBe(1);
    expect(summary?.incrementalInteractions).toBe(0);
    expect(summary?.stages.publication.samples).toBe(1);
  });

  it("counts a local-discovery batch with a coincident rebuild once", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;

    queue.requestLocalDiscovery(1);
    queue.flushDiscovery();
    queue.requestRuleRebuild();
    trace.flush(queue, batchExecutor(trace, { discovery: 2, reconcile: 1, rebuild: 3, publication: 1 }));

    const summary = trace.disable();
    expect(summary?.batches).toBe(1);
    expect(summary?.incrementalInteractions).toBe(1);
    expect(summary?.incrementalP95Ms).toBe(7);
  });

  it("clears every sample and fixture before a later session", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;
    queue.requestLocalDiscovery(1);
      queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 9 }));

    const first = trace.disable();
    expect(first?.incrementalP95Ms).toBe(9);

    trace.enable();
    queue.requestLocalDiscovery(2);
      queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 3 }));
    const second = trace.disable();
    expect(second?.batches).toBe(1);
    expect(second?.incrementalInteractions).toBe(1);
    expect(second?.incrementalP95Ms).toBe(3);
    expect(second?.stages.discovery.totalMs).toBe(3);
    expect(trace.disable()).toBeNull();
    expect(trace.cacheView()).toBeNull();
  });

  it("keeps the summary free of document, URL, and cache content", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const queue = new FrontendRenderWorkQueue<number>();
    advanceWithin = advance;
    trace.input();
    advance(5);
    queue.requestLocalDiscovery(1);
      queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 2, reconcile: 1, publication: 1 }));
    queue.requestFullDiscovery();
      queue.flushDiscovery();
    trace.flush(queue, batchExecutor(trace, { discovery: 4, reconcile: 2, publication: 1 }));

    const summary = trace.disable();
    const text = JSON.stringify(summary);
    for (const forbidden of ["http", "perf-site", "nocode", "decoy", "::", "href", "ref-", "cdn", "example.dev", "url", "key"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("exposes a frozen 10,000-entry fixture overlay only while active", () => {
    const { clock, advance } = fakeClock();
    advance(5_000);
    const trace = new FrontendPerformanceTrace(clock, clock);
    expect(trace.cacheView()).toBeNull();

    trace.enable();
    const overlay = trace.cacheView();
    expect(overlay).not.toBeNull();
    expect(Object.keys(overlay!)).toHaveLength(PERF_CACHE_VIEW_ENTRIES);
    expect(Object.isFrozen(overlay)).toBe(true);
    expect(overlay!["perf-site-0.example.dev"]?.domain).toBe("perf-site-0.example.dev");

    advance(4_000);
    trace.disable();
    expect(trace.cacheView()).toBeNull();

    trace.enable();
    const second = trace.cacheView()!;
    expect(second["perf-site-0.example.dev"]?.fetchedAt).toBe(8_000);
    expect(Object.keys(second)).toHaveLength(PERF_CACHE_VIEW_ENTRIES);
  });

  it("keeps the fixture overlay isolated from any external cache object", () => {
    const { clock } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    const authority: Record<string, unknown> = {};
    trace.enable();
    const overlay = trace.cacheView()!;
    authority["perf-site-0.example.dev"] = { url: "real-icon.png" };

    expect(overlay["perf-site-0.example.dev"]).not.toBe(authority["perf-site-0.example.dev"]);
    expect(Object.keys(overlay)).toHaveLength(PERF_CACHE_VIEW_ENTRIES);
    expect(overlay["perf-site-0.example.dev"]?.url).toMatch(/^https:\/\/cdn\.perf\.example\.dev\//);
    expect(Object.isFrozen(overlay["perf-site-0.example.dev"])).toBe(true);
  });

  it("leaves the adopted cache authority untouched across enable, render reads, and disable", () => {
    const { clock } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    const authority = {
      cache: { "real.example.dev": { url: "real.png", fetchedAt: 1_000 } },
      revision: 42,
      epoch: "epoch-1",
    };
    const before = JSON.parse(JSON.stringify(authority));
    const renderView = () => trace.cacheView() ?? authority.cache;

    trace.enable();
    const fixture = renderView();
    expect(Object.keys(fixture!)).toHaveLength(PERF_CACHE_VIEW_ENTRIES);
    expect(fixture!["real.example.dev"]).toBeUndefined();
    expect(Object.isFrozen(fixture)).toBe(true);

    trace.disable();
    expect(renderView()).toBe(authority.cache);
    expect(authority).toEqual(before);
  });

  it("lays the real cache's pinned entries over the fixture overlay", () => {
    const { clock } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    const realCache = {
      "nocode.host": { url: "pinned-nocode.png", fetchedAt: 0, pinned: true },
      "unpinned.example.dev": { url: "unpinned.png", fetchedAt: 1_000 },
      "nocode.host::site-p00000": { url: "pinned-route.png", fetchedAt: 0, pinned: true },
    };
    trace.enable();
    const view = trace.cacheView(realCache)!;
    expect(Object.keys(view)).toHaveLength(PERF_CACHE_VIEW_ENTRIES + 1);
    expect(view["nocode.host"]).toEqual({ url: "pinned-nocode.png", fetchedAt: 0, pinned: true });
    expect(view["unpinned.example.dev"]).toBeUndefined();
    expect(view["nocode.host::site-p00000"]?.url).toBe("pinned-route.png");
    expect(view["perf-site-0.example.dev"]).toBeDefined();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view["nocode.host"])).toBe(true);
    expect(view["nocode.host"]).not.toBe(realCache["nocode.host"]);
  });

  it("rebuilds the composite view only when the real cache identity changes", () => {
    const { clock } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    const first = { "nocode.host": { url: "pin-a.png", fetchedAt: 0, pinned: true } };
    const second = { "nocode.host": { url: "pin-b.png", fetchedAt: 0, pinned: true } };
    trace.enable();
    const viewA = trace.cacheView(first)!;
    expect(trace.cacheView(first)).toBe(viewA);
    expect(viewA["nocode.host"]?.url).toBe("pin-a.png");
    const viewB = trace.cacheView(second)!;
    expect(viewB).not.toBe(viewA);
    expect(viewB["nocode.host"]?.url).toBe("pin-b.png");
    trace.disable();
    expect(trace.cacheView(first)).toBeNull();
  });

  it("preserves pinned-domain route suppression through the composite view", () => {
    const { clock } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const realCache = {
      "nocode.host": { url: "pinned-nocode.png", fetchedAt: 0, domain: "nocode.host", pinned: true },
    };
    const view = trace.cacheView(realCache)!;
    const routeScope = scopeForUrl("https://nocode.host/p00000/ref-1")!;
    const result = reconcilePresentBindings({
      discovery: [routeScope],
      context: { cache: view, cacheDays: 30, pauseAutomaticFetch: false },
      previous: new Map(),
    });
    expect(result.bindings.has(routeScope.key)).toBe(false);
    expect(result.bindings.get("nocode.host")).toBe("pinned-nocode.png");
  });

  it("supplies the five hundred scenario scopes through the overlay", () => {
    const { clock } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    const overlay = trace.cacheView()!;
    const scenarioKeys = [
      ...Array.from({ length: 480 }, (_, index) => `perf-site-${index}.example.dev`),
      ...Array.from({ length: 20 }, (_, index) => `nocode.host::site-p${String(index).padStart(5, "0")}`),
    ];
    for (const key of scenarioKeys) expect(overlay[key]).toBeDefined();
    expect(scenarioKeys.length).toBe(PERF_SCOPE_COUNT);
  });

  it("produces a stable one-summary shape on disable", () => {
    const { clock, advance } = fakeClock();
    const trace = new FrontendPerformanceTrace(clock, clock);
    trace.enable();
    advance(1);
    const summary = trace.disable() as FrontendTraceSummary;
    expect(summary.schema).toBe(1);
    expect(summary.build).toBe("development");
    expect(summary.fixture).toEqual({
      links: 2000,
      scopes: PERF_SCOPE_COUNT,
      cacheEntries: PERF_CACHE_VIEW_ENTRIES,
    });
    expect(summary).toMatchObject({
      batches: 0,
      incrementalInteractions: 0,
      incrementalP95Ms: 0,
      fullDiscoveries: 0,
      slowestFullDiscoveryMs: 0,
      ruleFreshnessSamples: 0,
      slowestRuleFreshnessMs: 0,
    });
  });
});
