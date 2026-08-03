import type { CacheMutationReceipt, CacheRequestResult } from "./cache-authority";
import {
  applyCacheChangeEvent,
  cacheBeforeChange,
  cachedIconForScope,
  type CacheEntry,
  type CacheSnapshot,
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

  failedAt(key: string): number | undefined {
    return this.failedDomains.get(key);
  }

  async load() {
    try {
      const [snapshot, policy] = await Promise.all([
        this.callKernel<CacheSnapshot>("cache.snapshot"),
        this.callKernel<Partial<Settings>>("cache.policy.get"),
      ]);
      this.adoptSnapshot(snapshot);
      this.applyPolicy(policy);
    } catch (error) {
      for (const key of Object.keys(this.cache)) delete this.cache[key];
      this.cacheEntryCount = 0;
      console.warn("[siyuan-linkmark] Kernel cache authority is unavailable", error);
    }
  }

  async refreshSnapshot() {
    try {
      this.adoptSnapshot(await this.callKernel<CacheSnapshot>("cache.snapshot"));
      this.notifyCount();
      return true;
    } catch (error) {
      console.warn("[siyuan-linkmark] Unable to refetch the cache snapshot", error);
      return false;
    }
  }

  async subscribe() {
    const bind = this.options.rpc?.bind;
    if (!bind) return;
    await bind("cache.changed", (params) => {
      const payload = eventPayload(params);
      const application = this.applyIncomingCacheChange(payload);
      if (application.status === "ignored") return;
      if (application.status === "refetch" || application.status === "epoch-changed") {
        void this.refreshSnapshot();
      }
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
        ? pending.promise.then(() => this.fetchAndCache(scope, targetUrl, preserveExisting, trigger))
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
    });
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

  async remove(key: string) {
    const receipt = await this.callKernel<CacheMutationReceipt>("cache.remove", key);
    await this.applyMutationReceipt(receipt, [key]);
    this.failedDomains.delete(key);
    this.manualRefreshKeys.delete(key);
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
   * Removes an entry that a scan decided is expired, guarding against
   * concurrent removal through the in-flight scope set. `onSettled` runs in
   * the same finally as the guard release so the caller can re-scan exactly
   * when the original plugin method did.
   */
  async expire(key: string, expected: CacheEntry, onSettled?: () => void) {
    if (this.options.settings.pauseAutomaticFetch) return;
    if (this.pendingDomains.has(key)) return;
    this.pendingDomains.add(key);
    try {
      if (this.cache[key] !== expected) return;
      const receipt = await this.callKernel<CacheMutationReceipt>("cache.remove", key);
      await this.applyMutationReceipt(receipt, [key]);
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
  ) {
    return this.callKernel<CacheMutationReceipt>("cache.pin", {
      key: scope.key,
      domain: scope.domain,
      targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
      routeKey: scope.routeKey,
      pathPrefix: scope.pathPrefix,
    }, entry, contentType, base64, selectedScopeKey);
  }

  async pinUrl(
    targetScope: LinkScope,
    targetUrl: string,
    value: string,
    includeSubdomains: boolean,
    selectedScopeKey: string,
  ) {
    return this.callKernel<CacheMutationReceipt>("cache.pin-url", {
      ...targetScope,
      targetUrl: this.sanitizeTargetUrl(targetUrl, targetScope.domain),
    }, value, includeSubdomains, selectedScopeKey);
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
    if (receipt.status === "committed") {
      const application = this.applyIncomingCacheChange(receipt.change);
      if (application.status === "refetch" || application.status === "epoch-changed") {
        await this.refreshSnapshot();
      }
      return;
    }
    if (receipt.epoch !== this.lastCacheEpoch || receipt.revision !== this.lastCacheRevision) {
      await this.refreshSnapshot();
      return;
    }
    this.removeLocalCacheKeys(unchangedRemoved);
  }

  /**
   * Adopts a kernel Cache snapshot as the local baseline: the cache contents
   * plus the revision and epoch captured at snapshot time. Revision and epoch
   * are adopted only when the snapshot carries them, so an event stream from
   * another epoch still triggers a rebaseline instead of being misapplied.
   */
  private adoptSnapshot(snapshot: CacheSnapshot | null | undefined) {
    for (const key of Object.keys(this.cache)) delete this.cache[key];
    if (snapshot && typeof snapshot.cache === "object") {
      for (const [key, entry] of Object.entries(snapshot.cache)) {
        this.cache[key] = { ...entry };
      }
    }
    this.cacheEntryCount = Object.keys(this.cache).length;
    if (typeof snapshot?.revision === "number") this.lastCacheRevision = snapshot.revision;
    if (typeof snapshot?.epoch === "string") this.lastCacheEpoch = snapshot.epoch;
  }

  private applyIncomingCacheChange(payload: unknown) {
    const application = applyCacheChangeEvent(this.cache, payload, this.lastCacheRevision, this.lastCacheEpoch);
    if (application.status !== "applied") return application;
    this.lastCacheRevision = application.revision;
    this.cacheEntryCount += application.entryCountDelta;
    for (const key of this.manualRefreshKeys.keys()) {
      if (this.cache[key]) this.manualRefreshKeys.delete(key);
    }
    this.options.callbacks.onCacheChanged(
      cacheBeforeChange(this.cache, application.previous),
      application.changedKeys,
    );
    this.notifyCount();
    return application;
  }

  private removeLocalCacheKeys(keys: string[]) {
    const previous: Record<string, CacheEntry | undefined> = {};
    const changed: string[] = [];
    for (const key of keys) {
      const entry = this.cache[key];
      if (!entry) continue;
      previous[key] = entry;
      delete this.cache[key];
      this.cacheEntryCount -= 1;
      changed.push(key);
    }
    if (changed.length > 0) {
      this.options.callbacks.onCacheChanged(cacheBeforeChange(this.cache, previous), changed);
      this.notifyCount();
    }
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
        if (!previous) this.cacheEntryCount += 1;
        this.notifyCount();
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
