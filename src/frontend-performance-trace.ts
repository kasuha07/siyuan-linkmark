import type { CacheEntry } from "./frontend-cache-state";
import {
  flushFrontendRenderWork,
  type DiscoveryWork,
  type FrontendRenderWork,
  type FrontendRenderWorkExecutor,
  type FrontendRenderWorkQueue,
} from "./frontend-render-work";
import {
  PERF_CACHE_VIEW_ENTRIES,
  PERF_LINK_COUNT,
  PERF_SCOPE_COUNT,
  perfCacheOverlay,
} from "./perf-scenario";

/**
 * Development-build-only Frontend performance trace for the Interactive
 * render pipeline. It times discovery, rule reconciliation, and stylesheet
 * publication around the existing render-work flush seam, measures the
 * interval from stable editor input to rule publication, and supplies the
 * process-local 10,000-entry fixture cache overlay while a session is
 * active. Samples and aggregates are bounded, records contain only stage
 * names, durations, counts, and fixture metadata, and disabling the trace
 * clears every sample and the overlay.
 */
export const FRONTEND_TRACE_SCHEMA = 1;
export const INCREMENTAL_SAMPLE_CAP = 512;

export type FrontendTraceStageName = "discovery" | "reconcile" | "publication";

const STAGE_NAMES: readonly FrontendTraceStageName[] = ["discovery", "reconcile", "publication"];

export type FrontendTraceStageStats = {
  samples: number;
  totalMs: number;
  maxMs: number;
};

export type FrontendTraceSummary = {
  schema: 1;
  build: "development";
  batches: number;
  incrementalInteractions: number;
  incrementalP95Ms: number;
  fullDiscoveries: number;
  slowestFullDiscoveryMs: number;
  ruleFreshnessSamples: number;
  slowestRuleFreshnessMs: number;
  stages: Record<FrontendTraceStageName, FrontendTraceStageStats>;
  fixture: { links: number; scopes: number; cacheEntries: number };
};

export class FrontendPerformanceTrace {
  private enabled = false;
  private overlay: Record<string, CacheEntry> | null = null;
  private lastInputAt: number | undefined;
  private openBatch: {
    discovery: number;
    reconcile: number;
    rebuild: number;
    publication: number;
  } | null = null;
  private incrementalTotals: number[] = [];
  private batchCount = 0;
  private fullDiscoveryCount = 0;
  private slowestFullDiscoveryMs = 0;
  private ruleFreshnessSamples = 0;
  private slowestRuleFreshnessMs = 0;
  private readonly stages: Record<FrontendTraceStageName, FrontendTraceStageStats> = {
    discovery: { samples: 0, totalMs: 0, maxMs: 0 },
    reconcile: { samples: 0, totalMs: 0, maxMs: 0 },
    publication: { samples: 0, totalMs: 0, maxMs: 0 },
  };

  constructor(
    private readonly clock: () => number,
    private readonly wallClock: () => number = Date.now,
  ) {}

  get active() {
    return this.enabled;
  }

  /**
   * Starts a fresh tracing session and supplies the read-only fixture
   * overlay. All prior samples and aggregates are discarded. The overlay
   * entries carry wall-clock timestamps because the render pipeline compares
   * them with `Date.now()` when deciding entry freshness.
   */
  enable() {
    this.enabled = true;
    this.resetSession();
    this.overlay = perfCacheOverlay(this.wallClock());
  }

  /**
   * Ends the session, returning the single summary to print, and clears
   * every sample, aggregate, and the fixture overlay. Returns null when no
   * session is active.
   */
  disable(): FrontendTraceSummary | null {
    if (!this.enabled) return null;
    const summary = this.buildSummary();
    this.enabled = false;
    this.overlay = null;
    this.resetSession();
    return summary;
  }

  /**
   * Records the moment an editor input arrived; the interval from the last
   * such input to the next batch's publication becomes a Rule freshness
   * sample. A no-op while tracing is disabled.
   */
  input() {
    if (!this.enabled) return;
    this.lastInputAt = this.clock();
  }

  /**
   * Measures one render-pipeline stage with the monotonic clock and records
   * it into the open batch and the stage aggregates. When tracing is
   * disabled the function runs without measurement.
   */
  stage<R>(name: FrontendTraceStageName, fn: () => R): R {
    if (!this.enabled) return fn();
    const startedAt = this.clock();
    const result = fn();
    const durationMs = this.clock() - startedAt;
    const stats = this.stages[name];
    stats.samples += 1;
    stats.totalMs += durationMs;
    if (durationMs > stats.maxMs) stats.maxMs = durationMs;
    if (this.openBatch) this.openBatch[name] += durationMs;
    return result;
  }

  /**
   * The read-only fixture cache view for the Interactive render pipeline, or
   * null outside an active session.
   */
  cacheView(): Record<string, CacheEntry> | null {
    return this.enabled ? this.overlay : null;
  }

  /**
   * Frames one render-work flush as a batch when a session is active, using
   * the same flush seam as production. Stage durations come from `stage`
   * calls inside the executor callbacks, except for the rule rebuild, which
   * this wrapper measures into its own batch slot so a coincident rebuild is
   * counted in the incremental total but kept out of the Full-discovery
   * total. The batch never retains DOM nodes, elements, URLs, or cache
   * payloads.
   */
  flush<Region>(queue: FrontendRenderWorkQueue<Region>, executor: FrontendRenderWorkExecutor<Region>): FrontendRenderWork<Region> {
    if (!this.enabled || this.openBatch) return flushFrontendRenderWork(queue, executor);
    this.openBatch = { discovery: 0, reconcile: 0, rebuild: 0, publication: 0 };
    let published = false;
    try {
      const work = flushFrontendRenderWork(queue, {
        rebuildRules: () => this.measureRebuild(() => executor.rebuildRules()),
        discover: executor.discover,
        publishRules: () => {
          published = true;
          executor.publishRules();
        },
      });
      this.endBatch(work, published);
      return work;
    } catch (error) {
      this.openBatch = null;
      throw error;
    }
  }

  private measureRebuild(fn: () => void) {
    const startedAt = this.clock();
    fn();
    const durationMs = this.clock() - startedAt;
    const stats = this.stages.reconcile;
    stats.samples += 1;
    stats.totalMs += durationMs;
    if (durationMs > stats.maxMs) stats.maxMs = durationMs;
    if (this.openBatch) this.openBatch.rebuild = durationMs;
  }

  private endBatch(
    work: { discovery: DiscoveryWork<unknown>; rebuildRules: boolean; publishRules: boolean },
    published: boolean,
  ) {
    const batch = this.openBatch;
    this.openBatch = null;
    if (!batch) return;
    this.batchCount += 1;
    const totalMs = batch.discovery + batch.reconcile + batch.rebuild + batch.publication;
    if (work.discovery?.kind === "full") {
      // The Full-discovery target covers the discovery and reconciliation
      // pass; publication and a coincident rebuild are excluded from it.
      this.fullDiscoveryCount += 1;
      const fullMs = batch.discovery + batch.reconcile;
      if (fullMs > this.slowestFullDiscoveryMs) this.slowestFullDiscoveryMs = fullMs;
    } else {
      this.incrementalTotals.push(totalMs);
      if (this.incrementalTotals.length > INCREMENTAL_SAMPLE_CAP) this.incrementalTotals.shift();
    }
    if (work.discovery) {
      if (published && this.lastInputAt !== undefined) {
        const freshnessMs = this.clock() - this.lastInputAt;
        this.ruleFreshnessSamples += 1;
        if (freshnessMs > this.slowestRuleFreshnessMs) this.slowestRuleFreshnessMs = freshnessMs;
      }
      this.lastInputAt = undefined;
    }
  }

  private resetSession() {
    this.lastInputAt = undefined;
    this.openBatch = null;
    this.incrementalTotals = [];
    this.batchCount = 0;
    this.fullDiscoveryCount = 0;
    this.slowestFullDiscoveryMs = 0;
    this.ruleFreshnessSamples = 0;
    this.slowestRuleFreshnessMs = 0;
    for (const name of STAGE_NAMES) {
      this.stages[name].samples = 0;
      this.stages[name].totalMs = 0;
      this.stages[name].maxMs = 0;
    }
  }

  private buildSummary(): FrontendTraceSummary {
    const sorted = [...this.incrementalTotals].sort((left, right) => left - right);
    const p95 = sorted.length > 0 ? sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] : 0;
    return {
      schema: FRONTEND_TRACE_SCHEMA,
      build: "development",
      batches: this.batchCount,
      incrementalInteractions: sorted.length,
      incrementalP95Ms: p95,
      fullDiscoveries: this.fullDiscoveryCount,
      slowestFullDiscoveryMs: this.slowestFullDiscoveryMs,
      ruleFreshnessSamples: this.ruleFreshnessSamples,
      slowestRuleFreshnessMs: this.slowestRuleFreshnessMs,
      stages: {
        discovery: { ...this.stages.discovery },
        reconcile: { ...this.stages.reconcile },
        publication: { ...this.stages.publication },
      },
      fixture: { links: PERF_LINK_COUNT, scopes: PERF_SCOPE_COUNT, cacheEntries: PERF_CACHE_VIEW_ENTRIES },
    };
  }
}
