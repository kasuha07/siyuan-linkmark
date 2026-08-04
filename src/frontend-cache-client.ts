import type {
  BulkRefreshState,
  CacheEntryGuard,
  CacheLookupResult,
  CacheManagementPage,
  CacheManagementQuery,
  CacheMutationReceipt,
  CacheRequestResult,
  CacheStats,
  CacheCursor,
} from "./cache-authority";
import {
  cacheBeforeChange,
  cachedIconForScope,
  type CacheEntry,
} from "./frontend-cache-state";
import { errorText } from "./frontend-format";
import { CACHE_POLICY_FIELDS, pickCachePolicy, type Settings } from "./frontend-settings";
import { fetchOutcomeFor, type FetchOutcome } from "./refresh-outcome";
import { scopeFromCacheKey, type LinkScope } from "./url-scope";

export type FetchTrigger = "automatic" | "manual";

export type RefreshDomainsResult = {
  queued: number;
  failed: number;
  skipped: number;
  failures: string[];
};

export type FrontendCacheClientCallbacks = {
  onCacheChanged: (previous: Record<string, CacheEntry>, changedKeys: string[]) => void;
  onEntryCountChange: (count: number) => void;
  onManualRefreshFailed: (scope: LinkScope) => void;
};

export type KernelRpc = {
  call: Record<string, (...args: unknown[]) => Promise<unknown>>;
  bind: (name: string, handler: (params: unknown) => void) => void;
};

export type FrontendCacheClientOptions = {
  rpc?: KernelRpc;
  settings: Settings;
  callbacks: FrontendCacheClientCallbacks;
};

type PendingFetch = {
  promise: Promise<FetchOutcome>;
  trigger: FetchTrigger;
  automaticGeneration: number;
};

const MANUAL_FAILURE_WINDOW = 60 * 1000;

/**
 * The Frontend client's cache-facing subsystem. It owns the local cache
 * view, the Cache revision and epoch baseline, and all explicit or
 * scan-driven cache operations, and it is the only frontend caller of the
 * Cache authority's Kernel RPC surface. It never imports the plugin class:
 * rendering coordination and user feedback flow back through injected
 * callbacks.
 */
export class FrontendCacheClient {
  private readonly cache: Record<string, CacheEntry> = {};
  private readonly entryTokens = new Map<string, string>();
  private cacheEntryCount = 0;
  private readonly pendingDomains = new Set<string>();
  private readonly pendingFetches = new Map<string, PendingFetch>();
  private readonly failedDomains = new Map<string, number>();
  private readonly failureReasons = new Map<string, string>();
  private readonly manualRefreshKeys = new Map<string, number>();
  private automaticFetchGeneration = 0;
  private cacheGeneration = 0;
  private lastCacheRevision: number | undefined;
  private lastCacheEpoch: string | undefined;
  private readonly presentScopes = new Map<string, LinkScope>();
  private workingSetRefresh?: Promise<void>;
  private workingSetDirty = false;
  private readonly cursorListeners = new Set<(cursor: CacheCursor) => void>();
  private readonly bulkRefreshListeners = new Set<(state: BulkRefreshState) => void>();

  constructor(private readonly options: FrontendCacheClientOptions) {}

  entries() {
    return this.cache;
  }

  entryCount() {
    return this.cacheEntryCount;
  }

  entryFor(key: string): CacheEntry | undefined {
    return this.cache[key];
  }

  queryCache(query: CacheManagementQuery) {
    return this.callKernel<CacheManagementPage>("cache.query", query);
  }

  cacheStats() {
    return this.callKernel<CacheStats>("cache.stats");
  }

  async startBulkRefresh() {
    return this.callKernel<{ status: "started" | "already-running"; refresh: BulkRefreshState }>("cache.refresh-all");
  }

  cancelBulkRefresh() {
    return this.callKernel<BulkRefreshState | undefined>("cache.refresh-all.cancel");
  }

  onCursorChange(listener: (cursor: CacheCursor) => void) {
    this.cursorListeners.add(listener);
    return () => this.cursorListeners.delete(listener);
  }

  onBulkRefreshChange(listener: (state: BulkRefreshState) => void) {
    this.bulkRefreshListeners.add(listener);
    return () => this.bulkRefreshListeners.delete(listener);
  }

  failedAt(key: string): number | undefined {
    return this.failedDomains.get(key);
  }

  async load() {
    try {
      const [stats, policy] = await Promise.all([
        this.callKernel<{ entryCount: number; epoch: string; revision: number }>("cache.stats"),
        this.callKernel<Partial<Settings>>("cache.policy.get"),
      ]);
      this.cacheEntryCount = stats.entryCount;
      this.lastCacheRevision = stats.revision;
      this.lastCacheEpoch = stats.epoch;
      this.applyPolicy(policy);
      this.notifyCount();
    } catch (error) {
      for (const key of Object.keys(this.cache)) delete this.cache[key];
      this.cacheEntryCount = 0;
      console.warn("[siyuan-linkmark] Kernel cache authority is unavailable", error);
    }
  }

  setPresentScopes(scopes: Iterable<LinkScope>) {
    const next = new Map<string, LinkScope>();
    for (const scope of scopes) next.set(scope.key, { ...scope });
    if (next.size === this.presentScopes.size
      && [...next].every(([key, scope]) => JSON.stringify(scope) === JSON.stringify(this.presentScopes.get(key)))) {
      return Promise.resolve();
    }
    this.presentScopes.clear();
    for (const [key, scope] of next) this.presentScopes.set(key, scope);
    return this.requestWorkingSetRefresh();
  }

  async subscribe() {
    const bind = this.options.rpc?.bind;
    if (!bind) return;
    await bind("cache.changed", (params) => {
      const payload = eventPayload(params);
      if (!this.observeCursor(payload)) return;
      void this.requestWorkingSetRefresh();
    });
    await bind("cache.resolution-failed", (params) => {
      const payload = eventPayload(params);
      const key = payload.key;
      const category = payload.category;
      if (typeof key !== "string" || !key) return;
      // Automatic and manual failures keep the existing failure cooldown so
      // scans do not re-queue a scope that just exhausted its budget.
      this.failedDomains.set(key, Date.now());
      if (typeof category === "string") this.failureReasons.set(key, `kernel resolve · ${category}`);
      const queuedAt = this.manualRefreshKeys.get(key);
      this.manualRefreshKeys.delete(key);
      if (queuedAt !== undefined && Date.now() - queuedAt <= MANUAL_FAILURE_WINDOW) {
        this.options.callbacks.onManualRefreshFailed(scopeFromCacheKey(key));
      }
    });
    await bind("cache.policy.changed", (params) => {
      const payload = eventPayload(params);
      this.applyPolicy(payload.policy as Partial<Settings> | undefined);
    });
    await bind("cache.refresh-all.changed", (params) => {
      const payload = eventPayload(params) as Partial<BulkRefreshState>;
      if (typeof payload.id !== "string" || typeof payload.state !== "string") return;
      for (const listener of this.bulkRefreshListeners) listener(payload as BulkRefreshState);
    });
  }

  applyPolicy(policy: Partial<Settings> | undefined) {
    if (!policy || typeof policy !== "object") return;
    for (const key of CACHE_POLICY_FIELDS) {
      if (policy[key] !== undefined) this.options.settings[key] = policy[key] as never;
    }
  }

  async savePolicy() {
    const policy = await this.callKernel<Partial<Settings>>("cache.policy.set", pickCachePolicy(this.options.settings));
    this.applyPolicy(policy);
  }

  sanitizeTargetUrl(targetUrl: string, domain: string) {
    try {
      const url = new URL(targetUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}/`;
    } catch {
      // Fall through to a safe domain-only URL.
    }
    return `https://${domain}/`;
  }

  async fetchAndCache(
    scope: LinkScope,
    targetUrl: string,
    preserveExisting = false,
    trigger: FetchTrigger = "automatic",
  ): Promise<FetchOutcome> {
    if (trigger === "automatic" && this.options.settings.pauseAutomaticFetch) return Promise.resolve("failure");
    const pending = this.pendingFetches.get(scope.key);
    if (pending) {
      const supersedesInvalidatedAutomatic = pending.trigger === "automatic"
        && pending.automaticGeneration !== this.automaticFetchGeneration;
      return (trigger === "manual" && pending.trigger === "automatic") || supersedesInvalidatedAutomatic
        ? pending.promise.catch(() => undefined).then(() => this.fetchAndCache(scope, targetUrl, preserveExisting, trigger))
        : pending.promise;
    }
    const request = this.runFetchAndCache(
      scope,
      targetUrl,
      preserveExisting,
      trigger,
      this.automaticFetchGeneration,
      this.cacheGeneration,
    );
    this.pendingFetches.set(scope.key, {
      promise: request,
      trigger,
      automaticGeneration: this.automaticFetchGeneration,
    });
    void request.finally(() => {
      if (this.pendingFetches.get(scope.key)?.promise === request) this.pendingFetches.delete(scope.key);
    }).catch(() => undefined);
    return request;
  }

  async refreshDomains(
    targets: Map<string, { scope: LinkScope; targetUrl: string }>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<RefreshDomainsResult> {
    const items = [...targets];
    let completed = 0;
    let queued = 0;
    let skipped = 0;
    let failed = 0;
    const failures: string[] = [];
    await Promise.all(items.map(async ([key, { scope, targetUrl }]) => {
      if (cachedIconForScope(this.cache, scope)?.entry.pinned) skipped += 1;
      else {
        const outcome = await this.fetchAndCache(scope, targetUrl, true, "manual");
        if (outcome === "queued" || outcome === "success" || outcome === "fallback") queued += 1;
        else {
          failed += 1;
          const reason = this.failureReasons.get(key);
          if (reason && failures.length < 3) failures.push(reason);
        }
      }
      completed += 1;
      onProgress?.(completed, items.length);
    }));
    return { queued, failed, skipped, failures };
  }

  async remove(key: string, guard?: CacheEntryGuard) {
    const receipt = await this.callKernel<CacheMutationReceipt>("cache.remove", key, guard);
    await this.applyMutationReceipt(receipt, [key]);
    this.failedDomains.delete(key);
    this.manualRefreshKeys.delete(key);
  }

  refreshManagedEntry(key: string, guard: CacheEntryGuard) {
    return this.callKernel<CacheRequestResult>("cache.refresh-one", key, guard);
  }

  async clearGenerated() {
    const receipt = await this.callKernel<CacheMutationReceipt>("cache.clear-generated");
    await this.applyMutationReceipt(receipt);
    this.failedDomains.clear();
    this.manualRefreshKeys.clear();
  }

  async clearAll() {
    this.cacheGeneration += 1;
    const receipt = await this.callKernel<CacheMutationReceipt>("cache.clear");
    await this.applyMutationReceipt(receipt);
    this.failedDomains.clear();
    this.manualRefreshKeys.clear();
  }

  /**
   * Removes an entry that a scan decided is expired, guarded by the
   * authoritative epoch and entry token captured with the local view. The
   * kernel re-asserts the guard inside its mutation queue, so a pin committed
   * after this decision but before the removal executes keeps the entry
   * instead of being deleted. `onSettled` runs in the same finally as the
   * guard release so the caller can re-scan exactly when the original plugin
   * method did.
   */
  async expire(key: string, expected: CacheEntry, onSettled?: () => void) {
    if (this.options.settings.pauseAutomaticFetch) return;
    if (this.pendingDomains.has(key)) return;
    this.pendingDomains.add(key);
    try {
      if (this.cache[key] !== expected) return;
      const epoch = this.lastCacheEpoch;
      const entryToken = this.entryTokens.get(key);
      if (!epoch || !entryToken) return;
      try {
        const receipt = await this.callKernel<CacheMutationReceipt>("cache.remove", key, { epoch, entryToken });
        await this.applyMutationReceipt(receipt, [key]);
      } catch (error) {
        // The authoritative entry no longer matches the stale local view (for
        // example a pin landed in the race window). Keep the new entry and
        // let the next working-set refresh reconcile the local view.
        if (isCacheEntryChangedError(error)) return;
        throw error;
      }
    } finally {
      this.pendingDomains.delete(key);
      onSettled?.();
    }
  }

  async pin(
    scope: LinkScope,
    targetUrl: string,
    entry: CacheEntry,
    contentType: string,
    base64: string,
    selectedScopeKey: string,
    guard?: CacheEntryGuard,
  ) {
    return this.callKernel<CacheMutationReceipt>("cache.pin", {
      key: scope.key,
      domain: scope.domain,
      targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
      routeKey: scope.routeKey,
      pathPrefix: scope.pathPrefix,
    }, entry, contentType, base64, selectedScopeKey, guard);
  }

  async pinUrl(
    targetScope: LinkScope,
    targetUrl: string,
    value: string,
    includeSubdomains: boolean,
    selectedScopeKey: string,
    guard?: CacheEntryGuard,
  ) {
    return this.callKernel<CacheMutationReceipt>("cache.pin-url", {
      ...targetScope,
      targetUrl: this.sanitizeTargetUrl(targetUrl, targetScope.domain),
    }, value, includeSubdomains, selectedScopeKey, guard);
  }

  async candidates(scope: LinkScope, targetUrl: string, discoverPage: boolean) {
    return this.callKernel<Array<{ base64: string; contentType: string; source: string }>>("cache.candidates", {
      ...scope,
      targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
    }, discoverPage);
  }

  async whenPendingSettled(key: string) {
    const pending = this.pendingFetches.get(key);
    if (pending) await pending.promise;
  }

  clearFailure(key: string) {
    this.failedDomains.delete(key);
  }

  cancelManualRefresh(key: string) {
    this.manualRefreshKeys.delete(key);
  }

  bumpAutomaticGeneration() {
    this.automaticFetchGeneration += 1;
  }

  async applyMutationReceipt(receipt: CacheMutationReceipt, unchangedRemoved: string[] = []) {
    void unchangedRemoved;
    this.observeCursor(receipt);
    await Promise.all([this.requestWorkingSetRefresh(), this.refreshStats()]);
  }

  /**
   * Adopts a kernel Cache snapshot as the local baseline: the cache contents
   * plus the revision and epoch captured at snapshot time. Revision and epoch
   * are adopted only when the snapshot carries them, so an event stream from
   * another epoch still triggers a rebaseline instead of being misapplied.
   */
  private requestWorkingSetRefresh() {
    this.workingSetDirty = true;
    if (this.workingSetRefresh) return this.workingSetRefresh;
    this.workingSetRefresh = this.runWorkingSetRefresh().finally(() => {
      this.workingSetRefresh = undefined;
    });
    return this.workingSetRefresh;
  }

  private async runWorkingSetRefresh() {
    while (this.workingSetDirty) {
      this.workingSetDirty = false;
      const result = await this.callKernel<CacheLookupResult>("cache.lookup", [...this.presentScopes.values()]);
      if (this.lastCacheEpoch !== undefined && result.epoch !== this.lastCacheEpoch) {
        this.workingSetDirty = true;
        continue;
      }
      if (this.lastCacheRevision !== undefined && result.revision < this.lastCacheRevision) {
        this.workingSetDirty = true;
        continue;
      }
      this.lastCacheEpoch = result.epoch;
      this.lastCacheRevision = result.revision;
      this.adoptWorkingSet(result);
    }
  }

  private adoptWorkingSet(result: CacheLookupResult) {
    const previous = Object.fromEntries(Object.entries(this.cache).map(([key, entry]) => [key, { ...entry }]));
    const next: Record<string, CacheEntry> = {};
    for (const match of Object.values(result.matches)) {
      if (match) next[match.cacheKey] = { ...match.entry };
    }
    const changedKeys = [...new Set([...Object.keys(previous), ...Object.keys(next)])];
    for (const key of Object.keys(this.cache)) delete this.cache[key];
    for (const [key, entry] of Object.entries(next)) this.cache[key] = entry;
    this.entryTokens.clear();
    for (const match of Object.values(result.matches)) {
      if (match) this.entryTokens.set(match.cacheKey, match.entryToken);
    }
    for (const key of this.manualRefreshKeys.keys()) {
      if (this.cache[key]) this.manualRefreshKeys.delete(key);
    }
    if (changedKeys.length > 0) this.options.callbacks.onCacheChanged(previous, changedKeys);
  }

  private observeCursor(value: unknown): value is CacheCursor {
    if (!value || typeof value !== "object") return false;
    const cursor = value as Partial<CacheCursor>;
    if (typeof cursor.epoch !== "string" || typeof cursor.revision !== "number" || !Number.isFinite(cursor.revision)) return false;
    if (this.lastCacheEpoch === cursor.epoch && this.lastCacheRevision !== undefined && cursor.revision <= this.lastCacheRevision) return false;
    this.lastCacheEpoch = cursor.epoch;
    this.lastCacheRevision = cursor.revision;
    for (const listener of this.cursorListeners) listener({ epoch: cursor.epoch, revision: cursor.revision });
    return true;
  }

  async refreshStats() {
    const stats = await this.cacheStats();
    this.cacheEntryCount = stats.entryCount;
    this.observeCursor(stats);
    this.notifyCount();
    return stats;
  }

  private async runFetchAndCache(
    scope: LinkScope,
    targetUrl: string,
    preserveExisting: boolean,
    trigger: FetchTrigger,
    automaticGeneration: number,
    cacheGeneration: number,
  ) {
    const invalidated = () => cacheGeneration !== this.cacheGeneration
      || (trigger === "automatic" && (
        automaticGeneration !== this.automaticFetchGeneration
        || this.options.settings.pauseAutomaticFetch
      ));
    this.pendingDomains.add(scope.key);
    try {
      const result = await this.callKernel<CacheRequestResult>("cache.get-or-queue", {
        ...scope,
        targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
      }, preserveExisting, trigger === "automatic");
      if (invalidated()) return "failure";
      if (result.status === "ready") {
        const entry = result.entry;
        const previous = this.cache[scope.key];
        this.cache[scope.key] = { ...entry };
        this.entryTokens.set(scope.key, result.entryToken);
        this.failedDomains.delete(scope.key);
        this.failureReasons.delete(scope.key);
        this.manualRefreshKeys.delete(scope.key);
        this.options.callbacks.onCacheChanged(
          cacheBeforeChange(this.cache, { [scope.key]: previous }),
          [scope.key],
        );
        return fetchOutcomeFor(entry);
      }
      if (result.status === "queued") {
        // Resolution continues in the kernel; a committed entry arrives
        // through the cache.changed broadcast and a failure through the
        // cache.resolution-failed broadcast. Keep the scope out of the
        // failed-domain cooldown and do not create a placeholder icon.
        if (trigger === "manual") this.manualRefreshKeys.set(scope.key, Date.now());
        return "queued";
      }
      // The Cache authority declined the request, for example while the
      // kernel plugin is still loading. Fail open without treating the
      // outcome as an icon failure.
      this.manualRefreshKeys.delete(scope.key);
      return "unavailable";
    } catch (error) {
      this.notifyCount();
      this.manualRefreshKeys.delete(scope.key);
      if (invalidated()) return "failure";
      console.warn(`[siyuan-linkmark] Unable to cache ${scope.key}`, error);
      this.failureReasons.set(scope.key, `${scope.key} · kernel resolve · ${errorText(error)}`);
      this.failedDomains.set(scope.key, Date.now());
      // Do not create a pseudo-element when no verified image exists, which
      // prevents an empty gap beside the link.
      return "failure";
    } finally {
      this.pendingDomains.delete(scope.key);
    }
  }

  private callKernel<T>(method: string, ...args: unknown[]): Promise<T> {
    const call = this.options.rpc?.call?.[method];
    if (!call) throw new Error("Linkmark kernel cache authority is unavailable");
    return call(...args) as Promise<T>;
  }

  private notifyCount() {
    this.options.callbacks.onEntryCountChange(this.cacheEntryCount);
  }
}

function eventPayload(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const record = params as Record<string, unknown>;
  if (record.params && typeof record.params === "object" && !Array.isArray(record.params)) {
    return record.params as Record<string, unknown>;
  }
  return record;
}

function isCacheEntryChangedError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "cache_entry_changed");
}
