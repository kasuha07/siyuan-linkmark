import { InvalidShareDomainError, isEligibleShareTarget, shareEligibilityOf } from "./parent-domain";
import { effectiveCacheMatch } from "./cache-match";
import { scopeFromCacheKey } from "./url-scope";
import type { CachePolicyFields } from "./resolver-contract";

export type CacheEntry = {
  url: string;
  fetchedAt: number;
  resolverVersion?: number;
  source?: string;
  targetUrl?: string;
  domain?: string;
  routeKey?: string;
  pathPrefix?: string;
  pinned?: boolean;
  includeSubdomains?: boolean;
  iconId?: string;
  contentType?: string;
};

export type LinkScope = {
  key: string;
  domain: string;
  targetUrl: string;
  routeKey?: string;
  pathPrefix?: string;
  platformIconUrl?: string;
  platformIconSvg?: string;
  platformIconSource?: string;
  discoverPage?: boolean;
};

export type CachePolicy = Pick<CachePolicyFields, "cacheDays" | "pauseAutomaticFetch">;

export type ResolvedIcon = {
  bytes: ArrayBuffer;
  contentType: string;
  source: string;
};

export type ResolutionTrigger = "automatic" | "manual";

export type ResolutionFailureCategory = "timeout" | "network" | "invalid" | "exhausted";

/**
 * A resolution task failed with a category that is safe to expose to a
 * Frontend client. It carries no remote response body, URL, or credential.
 */
export class ResolutionError extends Error {
  constructor(public readonly category: ResolutionFailureCategory) {
    super(`icon resolution failed: ${category}`);
    this.name = "ResolutionError";
  }
}

/**
 * The three-state result of a cache-miss request. `ready` carries a committed
 * Cache entry, `queued` acknowledges that a new or coalesced In-flight task
 * owns the Link scope, and `unavailable` means the Cache authority declined
 * to accept the work. A queued response is neither an icon result nor a
 * resolution failure.
 */
export type CacheRequestResult =
  | { status: "ready"; entry: CacheEntry; entryToken: string }
  | { status: "queued" }
  | { status: "unavailable" };

export interface CacheStorage {
  get(path: string): Promise<string | undefined>;
  put(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface IconResolver {
  resolve(
    scope: LinkScope,
    trigger?: ResolutionTrigger,
  ): Promise<ResolvedIcon | null>;
}

/**
 * A revisioned incremental broadcast describing one committed Cache
 * persistence batch: the entries that were added or replaced and the Link
 * scope keys that left the cache. The revision is a strictly increasing
 * per-process counter, so a Frontend client can detect a missed batch; the
 * epoch identifies the kernel process that produced the batch, so a client
 * can detect that a restart reset the revision.
 */
export type CacheCursor = {
  epoch: string;
  revision: number;
};

export type CacheChangeEvent = CacheCursor;

export type CacheMutationReceipt =
  | ({ status: "committed" } & CacheCursor)
  | { status: "unchanged"; epoch: string; revision: number };

export type CacheLookupResult = CacheCursor & {
  matches: Record<string, { cacheKey: string; entry: CacheEntry; entryToken: string } | null>;
};

export type CacheManagementQuery = { query: string; offset: number; limit: number };

export type CacheManagementItem = { key: string; entry: CacheEntry; entryToken: string };

export type CacheManagementPage = CacheCursor & CacheManagementQuery & {
  items: CacheManagementItem[];
  total: number;
};

export type CacheEntryGuard = { epoch: string; entryToken: string };

export type BulkRefreshState = {
  id: string;
  state: "running" | "cancelling" | "cancelled" | "completed";
  total: number;
  scheduled: number;
  completed: number;
  failed: number;
  skipped: number;
};

export type CacheStats = CacheCursor & {
  entryCount: number;
  bulkRefresh?: BulkRefreshState;
};

export class CacheEntryChangedError extends Error {
  readonly code = "cache_entry_changed";

  constructor() {
    super("cache_entry_changed");
    this.name = "CacheEntryChangedError";
  }
}

/**
 * An isolated view of the authoritative Cache together with the revision
 * and epoch current at the moment the view was taken. A Frontend client
 * adopts these as its baseline so events at or below the snapshot revision
 * are known to be already contained.
 */
export type CacheSnapshot = {
  cache: Record<string, CacheEntry>;
  revision: number;
  epoch: string;
};

export type CacheAuthorityOptions = {
  cacheEpoch?: string;
  cachePolicy?: CachePolicy;
  resolverVersion?: number;
  privateIconUrl?: (iconId: string) => string;
  onCacheChanged?: (event: CacheChangeEvent) => Promise<void> | void;
  onCacheChangedError?: (error: unknown) => Promise<void> | void;
  onResolutionFailure?: (scope: LinkScope, category: ResolutionFailureCategory) => Promise<void> | void;
  onBulkRefreshChanged?: (state: BulkRefreshState) => Promise<void> | void;
};

const CACHE_INDEX_FILE = "favicon-cache-v2.json";
const ICON_DIRECTORY = "icons";
const MAX_RESOLUTION_CONCURRENCY = 4;

type InFlightTask = {
  generation: number;
  promise: Promise<void>;
};

type ResolvedCommit = {
  scope: LinkScope;
  resolved: ResolvedIcon;
  generation: number;
};

export class KernelCacheAuthority {
  private cache: Record<string, CacheEntry> = {};
  private readonly generations = new Map<string, number>();
  private readonly invalidationGenerations = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlightTask>();
  private activeResolutions = 0;
  private readonly resolutionQueue: Array<() => void> = [];
  private cacheMutationTail: Promise<void> = Promise.resolve();
  private persistTail: Promise<void> = Promise.resolve();
  private readonly resolvedCommitBatch: Array<{
    commit: ResolvedCommit;
    resolve: (entry: CacheEntry | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  private resolvedCommitBatchScheduled = false;
  private resolvedCommitBatchTimer?: ReturnType<typeof setTimeout>;
  private initializing?: Promise<void>;
  private policy: CachePolicy;
  private iconSequence = 0;
  private cacheRevision = 0;
  private readonly cacheEpoch: string;
  private sortedKeys?: { revision: number; keys: string[] };
  private bulkRefresh?: BulkRefreshState;
  private bulkRefreshSequence = 0;

  constructor(
    private readonly storage: CacheStorage,
    private readonly resolver: IconResolver,
    private readonly now: () => number = () => Date.now(),
    private readonly options: CacheAuthorityOptions = {},
  ) {
    this.policy = options.cachePolicy ?? { cacheDays: 30 };
    this.cacheEpoch = options.cacheEpoch ?? newCacheEpoch();
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const stored = await this.storage.get(CACHE_INDEX_FILE);
      if (!stored) return;
      const loaded = parseCache(stored);
      const removed: CacheEntry[] = [];
      const pruned = Object.fromEntries(
        Object.entries(loaded).filter(([key, entry]) => {
          if (isInvalidLegacyPin(key, entry)) {
            removed.push(entry);
            return false;
          }
          return true;
        }),
      );
      if (removed.length === 0) {
        this.cache = loaded;
        return;
      }
      // The pruned index must be durable before any payload leaves the
      // workspace; a failed index write fails initialization and preserves
      // every old record and payload.
      await this.persist(pruned);
      this.cache = pruned;
      for (const entry of removed) {
        if (entry.iconId) await this.storage.remove(this.iconPath(entry.iconId));
      }
    })();
    return this.initializing;
  }

  snapshot(): CacheSnapshot {
    return { cache: copyCache(this.cache), revision: this.cacheRevision, epoch: this.cacheEpoch };
  }

  async lookup(scopes: LinkScope[]): Promise<CacheLookupResult> {
    await this.initialize();
    const matches = Object.fromEntries(scopes.map((scope) => {
      const match = effectiveCacheMatch(this.cache, scope);
      return [scope.key, match ? {
        cacheKey: match.cacheKey,
        entry: copyEntry(match.entry),
        entryToken: entryToken(match.cacheKey, match.entry),
      } : null];
    }));
    return { matches, epoch: this.cacheEpoch, revision: this.cacheRevision };
  }

  async query(input: CacheManagementQuery): Promise<CacheManagementPage> {
    await this.initialize();
    const query = input.query.trim().toLowerCase();
    const offset = Math.max(0, Math.floor(input.offset));
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit)));
    const keys = this.sortedCacheKeys().filter((key) => {
      const entry = this.cache[key];
      return !query || key.toLowerCase().includes(query) || entry.domain?.toLowerCase().includes(query);
    });
    return {
      items: keys.slice(offset, offset + limit).map((key) => ({
        key,
        entry: copyEntry(this.cache[key]),
        entryToken: entryToken(key, this.cache[key]),
      })),
      total: keys.length,
      offset,
      limit,
      epoch: this.cacheEpoch,
      revision: this.cacheRevision,
      query,
    };
  }

  stats(): CacheStats {
    return {
      entryCount: Object.keys(this.cache).length,
      epoch: this.cacheEpoch,
      revision: this.cacheRevision,
      bulkRefresh: this.bulkRefresh ? copyBulkRefresh(this.bulkRefresh) : undefined,
    };
  }

  async startBulkRefresh() {
    await this.initialize();
    if (this.bulkRefresh?.state === "running" || this.bulkRefresh?.state === "cancelling") {
      return { status: "already-running" as const, refresh: copyBulkRefresh(this.bulkRefresh) };
    }
    const scopes = Object.entries(this.cache)
      .filter(([, entry]) => !entry.pinned)
      .map(([key, entry]) => scopeForEntry(key, entry));
    const refresh: BulkRefreshState = {
      id: `${this.cacheEpoch}-${(++this.bulkRefreshSequence).toString(36)}`,
      state: scopes.length === 0 ? "completed" : "running",
      total: scopes.length,
      scheduled: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };
    this.bulkRefresh = refresh;
    await this.notifyBulkRefresh(refresh);
    if (scopes.length > 0) void this.runBulkRefresh(refresh, scopes);
    return { status: "started" as const, refresh: copyBulkRefresh(refresh) };
  }

  cancelBulkRefresh() {
    if (this.bulkRefresh?.state === "running") {
      this.bulkRefresh.state = "cancelling";
      void this.notifyBulkRefresh(this.bulkRefresh);
    }
    return this.bulkRefresh ? copyBulkRefresh(this.bulkRefresh) : undefined;
  }

  setPolicy(policy: CachePolicy) {
    this.policy = { ...policy };
  }

  async getOrQueue(scope: LinkScope, force = false, automatic = false): Promise<CacheRequestResult> {
    await this.initialize();
    const existing = this.invalidationGenerations.has(scope.key) ? undefined : this.cache[scope.key];
    if (automatic && this.policy.pauseAutomaticFetch) {
      // A paused workspace policy cannot accept automatic work. Serve an
      // existing entry or decline explicitly so the Frontend client can
      // fail open without treating the pause as an icon failure.
      return existing ? { status: "ready", entry: copyEntry(existing), entryToken: entryToken(scope.key, existing) } : { status: "unavailable" };
    }
    if (existing && !force && this.isFresh(existing)) {
      return { status: "ready", entry: copyEntry(existing), entryToken: entryToken(scope.key, existing) };
    }
    const trigger: ResolutionTrigger = automatic ? "automatic" : "manual";
    const generation = this.generationFor(scope.key);
    const pending = this.inFlight.get(scope.key);
    if (pending?.generation === generation) return { status: "queued" };

    const resolve = async () => {
      const outcome = await this.enqueueResolution(async () => {
        if (!this.isCurrentGeneration(scope.key, generation)) return null;
        try {
          return await this.resolver.resolve(scope, trigger);
        } catch (error) {
          return new ResolutionError(this.resolutionCategoryOf(error));
        }
      });
      if (!this.isCurrentGeneration(scope.key, generation)) return;
      if (outcome instanceof ResolutionError) {
        await this.notifyResolutionFailure(scope, outcome.category);
      } else if (outcome) {
        await this.commitResolved(scope, outcome, generation);
      } else {
        await this.notifyResolutionFailure(scope, "exhausted");
      }
    };
    // An invalidated task cannot supply a replacement result. Keep the newer
    // task distinct, but wait for the obsolete one so a Link scope cannot use
    // two resolution slots at once while its old network request winds down.
    const task = pending ? pending.promise.catch(() => undefined).then(resolve) : resolve();
    this.inFlight.set(scope.key, { generation, promise: task });
    void task.finally(() => {
      if (this.inFlight.get(scope.key)?.promise === task) this.inFlight.delete(scope.key);
    }).catch(() => undefined);
    return { status: "queued" };
  }

  async putPinned(scope: LinkScope, entry: CacheEntry, contentType: string, bytes: ArrayBuffer, replaceKey?: string, guard?: CacheEntryGuard) {
    if (entry.includeSubdomains && !isEligibleShareTarget(scope.domain)) {
      throw new InvalidShareDomainError();
    }
    await this.initialize();
    this.assertEntryGuard(replaceKey ?? scope.key, guard);
    const generation = this.invalidate(scope.key);
    const replacedGeneration = replaceKey && replaceKey !== scope.key ? this.invalidate(replaceKey) : undefined;
    const completeInvalidations = () => {
      this.completeInvalidation(scope.key, generation);
      if (replaceKey && replacedGeneration !== undefined) this.completeInvalidation(replaceKey, replacedGeneration);
    };
    return this.enqueueCacheMutation(async () => {
      const iconId = this.nextIconId(scope.key);
      try {
        await this.storage.put(this.iconPath(iconId), bytesToBase64(bytes));
      } catch (error) {
        completeInvalidations();
        throw error;
      }
      if (!this.isCurrentPinnedOperation(scope.key, generation, replaceKey, replacedGeneration)) {
        completeInvalidations();
        await this.storage.remove(this.iconPath(iconId));
        throw new Error("Pinned icon operation was superseded by a newer cache change");
      }
      const previous = this.cache[scope.key];
      const replaced = replaceKey && replaceKey !== scope.key ? this.cache[replaceKey] : undefined;
      const nextEntry: CacheEntry = {
        ...entry,
        url: this.privateIconUrl(iconId), iconId, domain: scope.domain, routeKey: scope.routeKey,
        pathPrefix: scope.pathPrefix, targetUrl: scope.targetUrl, fetchedAt: this.now(), pinned: true,
        source: entry.source ?? "custom upload", resolverVersion: entry.resolverVersion, contentType,
      };
      const upserts = { [scope.key]: nextEntry };
      const removed = replaceKey && replaceKey !== scope.key ? [replaceKey] : [];
      try {
        await this.persistDelta(upserts, removed);
      } catch (error) {
        completeInvalidations();
        await this.storage.remove(this.iconPath(iconId));
        throw error;
      }
      if (!this.isCurrentPinnedOperation(scope.key, generation, replaceKey, replacedGeneration)) {
        await this.persist(this.cache);
        completeInvalidations();
        await this.storage.remove(this.iconPath(iconId));
        throw new Error("Pinned icon operation was superseded by a newer cache change");
      }
      this.applyDelta(upserts, removed);
      completeInvalidations();
      const receipt = await this.publishChange(upserts, removed);
      await this.removePayload(previous, iconId);
      await this.removePayload(replaced, iconId);
      return receipt;
    });
  }

  async remove(key: string, guard?: CacheEntryGuard) {
    await this.initialize();
    const generation = this.invalidate(key);
    return this.enqueueCacheMutation(async () => {
      // The guard is asserted inside the mutation queue so an expiry removal
      // cannot delete an entry that a concurrent pin replaced after the
      // caller's stale local view was taken.
      try {
        this.assertEntryGuard(key, guard);
      } catch (error) {
        this.completeInvalidation(key, generation);
        throw error;
      }
      const previous = this.cache[key];
      if (!previous) {
        this.completeInvalidation(key, generation);
        return this.unchangedReceipt();
      }
      try {
        await this.persistDelta({}, [key]);
      } catch (error) {
        this.completeInvalidation(key, generation);
        throw error;
      }
      this.applyDelta({}, [key]);
      this.completeInvalidation(key, generation);
      const receipt = await this.publishChange({}, [key]);
      await this.removePayload(previous);
      return receipt;
    });
  }

  async refreshEntry(key: string, guard: CacheEntryGuard) {
    await this.initialize();
    this.assertEntryGuard(key, guard);
    return this.getOrQueue(scopeForEntry(key, this.cache[key]), true, false);
  }

  async clear() {
    await this.initialize();
    const invalidations = new Map<string, number>();
    for (const key of this.inFlight.keys()) {
      if (!this.cache[key]?.pinned) invalidations.set(key, this.invalidate(key));
    }
    for (const [key, entry] of Object.entries(this.cache)) {
      if (!entry.pinned) invalidations.set(key, this.invalidate(key));
    }
    return this.enqueueCacheMutation(async () => {
      const removable = Object.entries(this.cache).filter(([, entry]) => !entry.pinned);
      const removed = removable.map(([key]) => key);
      if (removed.length === 0) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        return this.unchangedReceipt();
      }
      try {
        await this.persistDelta({}, removed);
      } catch (error) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        throw error;
      }
      this.applyDelta({}, removed);
      for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
      const receipt = await this.publishChange({}, removed);
      for (const [, entry] of removable) await this.removePayload(entry);
      return receipt;
    });
  }

  async clearGenerated() {
    await this.initialize();
    const invalidations = new Map(
      Object.entries(this.cache)
        .filter(([, entry]) => entry.source === "generated monogram")
        .map(([key]) => [key, this.invalidate(key)]),
    );
    return this.enqueueCacheMutation(async () => {
      const generated = Object.entries(this.cache).filter(([, entry]) => entry.source === "generated monogram");
      if (generated.length === 0) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        return this.unchangedReceipt();
      }
      const removed = generated.map(([key]) => key);
      try {
        await this.persistDelta({}, removed);
      } catch (error) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        throw error;
      }
      this.applyDelta({}, removed);
      for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
      const receipt = await this.publishChange({}, removed);
      for (const [, entry] of generated) await this.removePayload(entry);
      return receipt;
    });
  }

  async iconBytes(iconId: string) {
    const encoded = await this.storage.get(this.iconPath(iconId));
    return encoded ? base64ToArrayBuffer(encoded) : undefined;
  }

  async icon(iconId: string) {
    const entry = this.entryForIconId(iconId);
    if (!entry) return undefined;
    const bytes = await this.iconBytes(iconId);
    return bytes ? { bytes, contentType: entry.contentType ?? "application/octet-stream" } : undefined;
  }

  /**
   * Resolves an iconId to its Cache entry. New-format iconIds embed the
   * scope key losslessly, so the key is parsed back out and a known entry is
   * verified in O(1); a known key whose entry carries a different iconId is
   * a mismatch and never serves. iconIds that do not parse or decode to an
   * unknown key fall back to the former linear scan so legacy-format
   * entries keep serving.
   */
  private entryForIconId(iconId: string) {
    const key = scopeKeyFromIconId(iconId);
    if (key !== undefined && this.cache[key]) {
      const entry = this.cache[key];
      return entry.iconId === iconId ? entry : undefined;
    }
    return Object.values(this.cache).find((candidate) => candidate.iconId === iconId);
  }

  private async commitResolved(
    scope: LinkScope,
    resolved: ResolvedIcon,
    generation: number,
  ) {
    return new Promise<CacheEntry | null>((resolve, reject) => {
      this.resolvedCommitBatch.push({ commit: { scope, resolved, generation }, resolve, reject });
      if (this.resolvedCommitBatchScheduled) return;
      this.resolvedCommitBatchScheduled = true;
      this.resolvedCommitBatchTimer = setTimeout(() => {
        this.resolvedCommitBatchTimer = undefined;
        void this.flushResolvedCommitBatch();
      }, 32);
    });
  }

  private flushResolvedCommitBatch() {
    this.resolvedCommitBatchScheduled = false;
    const batch = this.resolvedCommitBatch.splice(0);
    void this.enqueueCacheMutation(() => this.persistResolvedCommitBatch(batch))
      .then((entries) => batch.forEach(({ resolve }, index) => resolve(entries[index])))
      .catch((error) => batch.forEach(({ reject }) => reject(error)));
  }

  private async persistResolvedCommitBatch(batch: Array<{ commit: ResolvedCommit }>) {
    const entries: Array<CacheEntry | null> = Array(batch.length).fill(null);
    const prepared: Array<{
      index: number;
      generation: number;
      key: string;
      previous: CacheEntry | undefined;
      entry: CacheEntry;
    }> = [];
    try {
      for (const [index, { commit }] of batch.entries()) {
        const { scope, resolved, generation } = commit;
        if (!this.isCurrentGeneration(scope.key, generation)) continue;
        const previous = this.cache[scope.key];
        if (previous?.pinned) {
          entries[index] = copyEntry(previous);
          continue;
        }
        const iconId = this.nextIconId(scope.key);
        await this.storage.put(this.iconPath(iconId), bytesToBase64(resolved.bytes));
        if (!this.isCurrentGeneration(scope.key, generation)) {
          await this.storage.remove(this.iconPath(iconId));
          continue;
        }
        prepared.push({
          index,
          generation,
          key: scope.key,
          previous,
          entry: {
            url: this.privateIconUrl(iconId), iconId, fetchedAt: this.now(), source: resolved.source,
            targetUrl: scope.targetUrl, domain: scope.domain, routeKey: scope.routeKey,
            pathPrefix: scope.pathPrefix, contentType: resolved.contentType, resolverVersion: this.options.resolverVersion,
          },
        });
      }
    } catch (error) {
      await Promise.all(prepared.map(({ entry }) => this.storage.remove(this.iconPath(entry.iconId!))));
      throw error;
    }

    const current = prepared.filter(({ key, generation }) => this.isCurrentGeneration(key, generation));
    for (const pending of prepared) {
      if (!current.includes(pending)) {
        await this.storage.remove(this.iconPath(pending.entry.iconId!));
      }
    }
    if (current.length === 0) return entries;

    const upserts = Object.fromEntries(current.map(({ key, entry }) => [key, entry]));
    try {
      await this.persistDelta(upserts, []);
    } catch (error) {
      await Promise.all(current.map(({ entry }) => this.storage.remove(this.iconPath(entry.iconId!))));
      throw error;
    }
    const committed = current.filter(({ key, generation }) => this.isCurrentGeneration(key, generation));
    if (committed.length !== current.length) {
      const finalUpserts = Object.fromEntries(committed.map(({ key, entry }) => [key, entry]));
      await this.persistDelta(finalUpserts, []);
      for (const pending of current) {
        if (!committed.includes(pending)) {
          await this.storage.remove(this.iconPath(pending.entry.iconId!));
        }
      }
    }

    if (committed.length > 0) {
      // A batch publishes one isolated event, so connected clients reconcile
      // once even when several scopes resolve together.
      this.applyDelta(Object.fromEntries(committed.map(({ key, entry }) => [key, entry])), []);
      await this.publishChange(Object.fromEntries(committed.map(({ key, entry }) => [key, entry])), []);
      for (const pending of committed) {
        entries[pending.index] = copyEntry(pending.entry);
        await this.removePayload(pending.previous, pending.entry.iconId);
      }
    }
    return entries;
  }

  private async removePayload(entry: CacheEntry | undefined, replacementIconId?: string) {
    if (!entry || entry.iconId === replacementIconId) return;
    if (entry.iconId) await this.storage.remove(this.iconPath(entry.iconId));
  }

  private enqueueResolution<T>(operation: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.activeResolutions += 1;
        void Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            this.activeResolutions -= 1;
            this.resolutionQueue.shift()?.();
          });
      };
      if (this.activeResolutions < MAX_RESOLUTION_CONCURRENCY) start();
      else this.resolutionQueue.push(start);
    });
  }

  private enqueueCacheMutation<T>(operation: () => Promise<T>) {
    const task = this.cacheMutationTail.then(operation);
    this.cacheMutationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private persist(cache = this.cache) {
    const snapshot = JSON.stringify(cache);
    return this.persistSerialized(snapshot);
  }

  private persistDelta(upserts: Record<string, CacheEntry>, removed: string[]) {
    const removedKeys = new Set(removed);
    const serialized: string[] = [];
    for (const [key, entry] of Object.entries(this.cache)) {
      if (removedKeys.has(key)) continue;
      const replacement = Object.prototype.hasOwnProperty.call(upserts, key) ? upserts[key] : entry;
      serialized.push(`${JSON.stringify(key)}:${JSON.stringify(replacement)}`);
    }
    for (const [key, entry] of Object.entries(upserts)) {
      if (!(key in this.cache)) serialized.push(`${JSON.stringify(key)}:${JSON.stringify(entry)}`);
    }
    return this.persistSerialized(`{${serialized.join(",")}}`);
  }

  private persistSerialized(snapshot: string) {
    const write = this.persistTail.catch(() => undefined).then(() => this.storage.put(CACHE_INDEX_FILE, snapshot));
    this.persistTail = write;
    return write;
  }

  private applyDelta(upserts: Record<string, CacheEntry>, removed: string[]) {
    for (const key of removed) delete this.cache[key];
    for (const [key, entry] of Object.entries(upserts)) {
      Object.defineProperty(this.cache, key, { value: entry, enumerable: true, configurable: true, writable: true });
    }
    this.sortedKeys = undefined;
  }

  private unchangedReceipt(): CacheMutationReceipt {
    return { status: "unchanged", epoch: this.cacheEpoch, revision: this.cacheRevision };
  }

  private async publishChange(upserts: Record<string, CacheEntry>, removed: string[]): Promise<CacheMutationReceipt> {
    void upserts;
    void removed;
    this.cacheRevision += 1;
    const change: CacheChangeEvent = { epoch: this.cacheEpoch, revision: this.cacheRevision };
    try {
      await this.options.onCacheChanged?.({ ...change });
    } catch (error) {
      try {
        await this.options.onCacheChangedError?.(error);
      } catch {
        // Notification diagnostics cannot change an already committed mutation.
      }
    }
    return { status: "committed", ...change };
  }

  private sortedCacheKeys() {
    if (this.sortedKeys?.revision === this.cacheRevision) return this.sortedKeys.keys;
    const keys = Object.keys(this.cache).sort((left, right) => (
      ordinalCompare(left.toLowerCase(), right.toLowerCase()) || ordinalCompare(left, right)
    ));
    this.sortedKeys = { revision: this.cacheRevision, keys };
    return keys;
  }

  private assertEntryGuard(key: string, guard: CacheEntryGuard | undefined) {
    if (!guard) return;
    const entry = this.cache[key];
    if (guard.epoch !== this.cacheEpoch || !entry || guard.entryToken !== entryToken(key, entry)) {
      throw new CacheEntryChangedError();
    }
  }

  private async notifyResolutionFailure(scope: LinkScope, category: ResolutionFailureCategory) {
    await this.options.onResolutionFailure?.(scope, category);
  }

  private async runBulkRefresh(refresh: BulkRefreshState, scopes: LinkScope[]) {
    let next = 0;
    const worker = async () => {
      while (refresh.state === "running") {
        const index = next;
        next += 1;
        if (index >= scopes.length) return;
        const scope = scopes[index];
        const before = this.cache[scope.key];
        refresh.scheduled += 1;
        const result = await this.getOrQueue(scope, true, false);
        if (result.status === "queued") await this.inFlight.get(scope.key)?.promise;
        const after = this.cache[scope.key];
        if (after?.pinned) refresh.skipped += 1;
        else if (after?.iconId && after.iconId !== before?.iconId) refresh.completed += 1;
        else refresh.failed += 1;
        await this.notifyBulkRefresh(refresh);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_RESOLUTION_CONCURRENCY, scopes.length) }, worker));
    refresh.state = refresh.state === "cancelling" ? "cancelled" : "completed";
    await this.notifyBulkRefresh(refresh);
  }

  private async notifyBulkRefresh(refresh: BulkRefreshState) {
    try {
      await this.options.onBulkRefreshChanged?.(copyBulkRefresh(refresh));
    } catch {
      // Progress notification failure cannot change the Workspace operation.
    }
  }

  private resolutionCategoryOf(error: unknown): ResolutionFailureCategory {
    return error instanceof ResolutionError ? error.category : "network";
  }

  private isFresh(entry: CacheEntry) {
    if (entry.pinned) return true;
    const maxAge = this.policy.cacheDays > 0 ? this.policy.cacheDays * 86400000 : Infinity;
    return this.now() - entry.fetchedAt <= maxAge;
  }

  private invalidate(key: string) {
    const generation = this.generationFor(key) + 1;
    this.generations.set(key, generation);
    this.invalidationGenerations.set(key, generation);
    return generation;
  }

  private completeInvalidation(key: string, generation: number) {
    if (this.invalidationGenerations.get(key) === generation) this.invalidationGenerations.delete(key);
  }

  private generationFor(key: string) {
    return this.generations.get(key) ?? 0;
  }

  private isCurrentGeneration(key: string, generation: number) {
    return generation === this.generationFor(key);
  }

  private isCurrentPinnedOperation(key: string, generation: number, replaceKey?: string, replacedGeneration?: number) {
    return this.isCurrentGeneration(key, generation)
      && (!replaceKey || replaceKey === key || replacedGeneration === undefined || this.isCurrentGeneration(replaceKey, replacedGeneration));
  }

  private nextIconId(key: string) {
    this.iconSequence += 1;
    const authorityId = Buffer.from(this.cacheEpoch, "utf8").toString("hex");
    return `${encodeScopeKey(key)}-${this.now().toString(36)}-${authorityId}${this.iconSequence.toString(36)}`;
  }

  private iconPath(iconId: string) {
    return `${ICON_DIRECTORY}/${iconId}.base64`;
  }

  private privateIconUrl(iconId: string) {
    return (this.options.privateIconUrl ?? ((id) => `/api/plugin/private/siyuan-linkmark/icon/${encodeURIComponent(id)}`))(iconId);
  }
}

function parseCache(value: string | undefined): Record<string, CacheEntry> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => (
      entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as CacheEntry).url === "string"
    ))) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function copyCache(cache: Record<string, CacheEntry>): Record<string, CacheEntry> {
  return Object.fromEntries(Object.entries(cache).map(([key, entry]) => [key, copyEntry(entry)]));
}

function copyEntry(entry: CacheEntry): CacheEntry {
  return { ...entry };
}

function entryToken(key: string, entry: CacheEntry) {
  return Buffer.from(JSON.stringify([key, entry]), "utf8").toString("base64url");
}

function ordinalCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scopeForEntry(key: string, entry: CacheEntry): LinkScope {
  // Reconstruct the full synthetic scope (platform icon, page-discovery
  // flag) so refresh paths resolve routes exactly like first discovery.
  const reconstructed = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
  return {
    ...reconstructed,
    targetUrl: entry.targetUrl ?? `https://${reconstructed.domain}${reconstructed.pathPrefix ?? "/"}`,
  };
}

function copyBulkRefresh(state: BulkRefreshState): BulkRefreshState {
  return { ...state };
}

/**
 * Classifies a persisted Pinned icon under the shared Share eligibility
 * policy. The migration exception removes every pin whose target is a
 * public suffix and every shared pin that fails Share eligibility,
 * including PSL Private-suffix-family tenants and reviewed exclusions.
 * Exact pins at non-public-suffix hosts, including tenant eTLD+1s such as
 * `foo.github.io`, are retained.
 */
function isInvalidLegacyPin(key: string, entry: CacheEntry) {
  if (!entry.pinned) return false;
  const target = entry.domain ?? key.split("::", 1)[0];
  if (!entry.includeSubdomains) {
    const policy = shareEligibilityOf(target);
    return policy.eligible ? false : policy.reason === "public-suffix" || policy.reason === "special-use";
  }
  return !isEligibleShareTarget(target);
}

/**
 * Generates the per-process Cache epoch identifying this kernel authority
 * instance. A timestamp plus a random suffix makes two consecutive authority
 * constructions distinguishable while remaining cheap and local.
 */
function newCacheEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Losslessly encodes a Link scope key for embedding in an iconId. The
 * base64url alphabet already matches the Private icon route's allowed
 * characters, so the encoded key round-trips through the URL untouched.
 */
function encodeScopeKey(key: string) {
  return Buffer.from(key, "utf8").toString("base64url");
}

/**
 * Parses a new-format iconId back to its Link scope key. The base36
 * suffixes contain no `-`, so the two rightmost `-` delimiters split them
 * off unambiguously even when the base64url key part contains `-`. Returns
 * undefined when the iconId cannot be a new-format id, so the caller can
 * fall back to the legacy linear scan.
 */
function scopeKeyFromIconId(iconId: string): string | undefined {
  const suffixDash = iconId.lastIndexOf("-");
  if (suffixDash <= 0) return undefined;
  const keyDash = iconId.lastIndexOf("-", suffixDash - 1);
  if (keyDash <= 0) return undefined;
  return Buffer.from(iconId.slice(0, keyDash), "base64url").toString("utf8");
}

function bytesToBase64(bytes: ArrayBuffer) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToArrayBuffer(value: string) {
  const bytes = Buffer.from(value, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
