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
 * persistence batch: the Cache keys that were added or replaced and the Cache
 * keys that left the cache. The revision is a strictly increasing per-process
 * counter, so a Frontend client can detect a missed batch; the epoch
 * identifies the kernel process that produced the batch, so a client can
 * detect that a restart reset the revision. `changedKeys` enumerates exactly
 * those keys, or is null when the batch is too broad to enumerate (for
 * example a bulk clear), in which case every Frontend client must refresh its
 * working set without skipping.
 */
export type CacheCursor = {
  epoch: string;
  revision: number;
};

export type CacheChangeEvent = CacheCursor & {
  changedKeys: string[] | null;
};

export type CacheMutationReceipt =
  | ({ status: "committed" } & CacheCursor)
  | { status: "unchanged"; epoch: string; revision: number };

/**
 * One appended Cache journal record: the Cache revision allocated at append
 * time, the upserted Cache entries, and the removed Cache keys of one
 * Cache persistence batch. Records are appended in Cache revision order and
 * replayed in that order over the Index checkpoint at initialization.
 */
type JournalRecord = {
  revision: number;
  upserts: Record<string, CacheEntry>;
  removed: string[];
};

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
  journalCompactBytes?: number;
  privateIconUrl?: (iconId: string) => string;
  onCacheChanged?: (event: CacheChangeEvent) => Promise<void> | void;
  onCacheChangedError?: (error: unknown) => Promise<void> | void;
  onResolutionFailure?: (scope: LinkScope, category: ResolutionFailureCategory) => Promise<void> | void;
  onBulkRefreshChanged?: (state: BulkRefreshState) => Promise<void> | void;
};

const CACHE_INDEX_FILE = "favicon-cache-v2.json";
const CACHE_JOURNAL_FILE = "favicon-cache.journal.ndjson";
const JOURNAL_COMPACT_BYTES = 1024 * 1024;
const RESOLVED_BATCH_WINDOW_MS = 32;
const BULK_REFRESH_BATCH_WINDOW_MS = 250;
const ICON_DIRECTORY = "icons";
const MAX_RESOLUTION_CONCURRENCY = 4;
// Batches larger than this send a null `changedKeys` sentinel instead of the
// key list: any Frontend document with real links almost certainly intersects
// a broad change, so the list would only waste event payload bytes.
const MAX_EVENT_CHANGED_KEYS = 128;

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
  private readonly journalCompactBytes: number;
  private journalText = "";
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
    this.journalCompactBytes = options.journalCompactBytes ?? JOURNAL_COMPACT_BYTES;
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const [stored, journal] = await Promise.all([
        this.storage.get(CACHE_INDEX_FILE),
        this.storage.get(CACHE_JOURNAL_FILE),
      ]);
      const loaded = parseCache(stored);
      const { records, validText } = parseJournal(journal);
      this.journalText = validText;
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
      this.cache = pruned;
      // 按 revision 顺序在 checkpoint 之上重放 journal；已被折叠进更新的
      // checkpoint 的记录重放是幂等的。
      for (const record of records) {
        this.applyDelta(record.upserts, record.removed);
        this.cacheRevision = record.revision;
      }
      if (removed.length === 0) return;
      // The pruned index must be durable before any payload leaves the
      // workspace; a failed index write fails initialization and preserves
      // every old record and payload.
      await this.persist(this.cache);
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
    // Baseline generations captured with the scope set: a scope mutated after
    // the run starts is excluded from this run even when its refresh task has
    // not begun, so deletion or replacement before task creation cannot be
    // undone by the run.
    const baselines = new Map(scopes.map((scope) => [scope.key, this.generationFor(scope.key)]));
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
    if (scopes.length > 0) void this.runBulkRefresh(refresh, scopes, baselines);
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

  async getOrQueue(scope: LinkScope, force = false, automatic = false, expectedGeneration?: number): Promise<CacheRequestResult> {
    try {
      await this.initialize();
    } catch {
      // 初始化失败（如 legacy-pin 迁移的索引写入失败）后，本 authority 在
      // kernel 插件重载前无法接受 cache-miss 工作。按三态契约显式应答
      // unavailable，而不是把失败泄漏为 RPC 内部错误。
      return { status: "unavailable" };
    }
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
    if (expectedGeneration !== undefined && generation !== expectedGeneration) {
      // A workspace mutation (deletion, Pinning, replacement, clear) changed
      // the scope since the caller captured its baseline generation. The
      // caller's work is obsolete: decline without starting a fresh task so
      // the mutation is not undone by a later refresh result.
      return { status: "unavailable" };
    }
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
      let revision: number;
      try {
        revision = await this.persistDelta(upserts, removed);
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
      const receipt = await this.publishChange(upserts, removed, revision);
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
      let revision: number;
      try {
        revision = await this.persistDelta({}, [key]);
      } catch (error) {
        this.completeInvalidation(key, generation);
        throw error;
      }
      this.applyDelta({}, [key]);
      this.completeInvalidation(key, generation);
      const receipt = await this.publishChange({}, [key], revision);
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
      let revision: number;
      try {
        revision = await this.persistDelta({}, removed);
      } catch (error) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        throw error;
      }
      this.applyDelta({}, removed);
      for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
      const receipt = await this.publishChange({}, removed, revision);
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
    // 与 clear() 一致：失效所有可能产出 generated 条目的 in-flight 任务。
    // 无法预知任务结果，因此真实 favicon 下载也会一并失效（代价最多
    // MAX_RESOLUTION_CONCURRENCY 个重新下载），保证旧配置的 monogram 绝不
    // 在 clear-generated 之后 commit。
    for (const key of this.inFlight.keys()) {
      if (!this.cache[key]?.pinned) invalidations.set(key, this.invalidate(key));
    }
    return this.enqueueCacheMutation(async () => {
      const generated = Object.entries(this.cache).filter(([, entry]) => entry.source === "generated monogram");
      if (generated.length === 0) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        return this.unchangedReceipt();
      }
      const removed = generated.map(([key]) => key);
      let revision: number;
      try {
        revision = await this.persistDelta({}, removed);
      } catch (error) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        throw error;
      }
      this.applyDelta({}, removed);
      for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
      const receipt = await this.publishChange({}, removed, revision);
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

  /**
   * 解析完成到提交之间的 batch 窗口：交互路径 32ms，Bulk cache refresh
   * 运行期间 250ms，以摊薄每次追加的固定写入开销。计时器不被后续到达
   * 的解析重置（ADR 0008）。
   */
  private resolvedBatchWindowMs() {
    return this.bulkRefresh?.state === "running" ? BULK_REFRESH_BATCH_WINDOW_MS : RESOLVED_BATCH_WINDOW_MS;
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
      }, this.resolvedBatchWindowMs());
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
      reusedIcon: boolean;
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
        // 图标字节与现有 payload 相同时复用其 iconId：不写新 payload，
        // Immutable private icon URL 保持（同 URL 永远同字节），省去刷新
        // 未变化图标时的 payload 写入与删除。复用条目的 payload 归属于
        // previous，因此它被 superseded 时绝不删除该 payload。
        let iconId: string | undefined;
        let url: string | undefined;
        if (previous?.iconId) {
          const stored = await this.storage.get(this.iconPath(previous.iconId));
          if (!this.isCurrentGeneration(scope.key, generation)) continue;
          if (stored !== undefined && stored === bytesToBase64(resolved.bytes)) {
            iconId = previous.iconId;
            url = previous.url;
          }
        }
        if (iconId === undefined) {
          iconId = this.nextIconId(scope.key);
          await this.storage.put(this.iconPath(iconId), bytesToBase64(resolved.bytes));
          if (!this.isCurrentGeneration(scope.key, generation)) {
            await this.storage.remove(this.iconPath(iconId));
            continue;
          }
          url = this.privateIconUrl(iconId);
        }
        prepared.push({
          index,
          generation,
          key: scope.key,
          previous,
          reusedIcon: iconId === previous?.iconId,
          entry: {
            url: url!, iconId, fetchedAt: this.now(), source: resolved.source,
            targetUrl: scope.targetUrl, domain: scope.domain, routeKey: scope.routeKey,
            pathPrefix: scope.pathPrefix, contentType: resolved.contentType, resolverVersion: this.options.resolverVersion,
          },
        });
      }
    } catch (error) {
      await Promise.all(prepared.filter((pending) => !pending.reusedIcon).map(({ entry }) => this.storage.remove(this.iconPath(entry.iconId!))));
      throw error;
    }

    const current = prepared.filter(({ key, generation }) => this.isCurrentGeneration(key, generation));
    for (const pending of prepared) {
      if (!current.includes(pending) && !pending.reusedIcon) {
        await this.storage.remove(this.iconPath(pending.entry.iconId!));
      }
    }
    if (current.length === 0) return entries;

    const upserts = Object.fromEntries(current.map(({ key, entry }) => [key, entry]));
    let revision: number;
    try {
      revision = await this.persistDelta(upserts, []);
    } catch (error) {
      await Promise.all(current.filter((pending) => !pending.reusedIcon).map(({ entry }) => this.storage.remove(this.iconPath(entry.iconId!))));
      throw error;
    }
    // 追加之后才被 superseded 的条目仍保留在已追加的记录里：触发
    // invalidate 的后续 mutation（删除、替换）会各自追加修正记录，
    // 重放顺序保证最终一致，无需撤回记录。
    const committed = current.filter(({ key, generation }) => this.isCurrentGeneration(key, generation));
    for (const pending of current) {
      if (!committed.includes(pending) && !pending.reusedIcon) {
        await this.storage.remove(this.iconPath(pending.entry.iconId!));
      }
    }

    if (committed.length > 0) {
      // A batch publishes one isolated event, so connected clients reconcile
      // once even when several scopes resolve together.
      this.applyDelta(Object.fromEntries(committed.map(({ key, entry }) => [key, entry])), []);
      await this.publishChange(Object.fromEntries(committed.map(({ key, entry }) => [key, entry])), [], revision);
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

  /**
   * 把内存 Cache 整体固化为新的 Index checkpoint，并清空已折叠进该
   * checkpoint 的 Cache journal。仅 Index compaction、legacy-pin 迁移和
   * superseded Pinned 兜底路径使用；普通变更走 persistDelta 追加。
   */
  private persist(cache = this.cache) {
    const write = this.persistTail.catch(() => undefined).then(async () => {
      await this.storage.put(CACHE_INDEX_FILE, JSON.stringify(cache));
      if (this.journalText.length > 0) {
        this.journalText = "";
        try {
          await this.storage.remove(CACHE_JOURNAL_FILE);
        } catch {
          // 残留 journal 与 checkpoint 内容重叠，重放幂等；由下一次整体覆盖消除。
        }
      }
    });
    this.persistTail = write;
    return write;
  }

  private persistDelta(upserts: Record<string, CacheEntry>, removed: string[]) {
    // 追加前分配 Cache revision：磁盘记录与广播事件一一对应；追加失败
    // 留下的空洞按既有 gap 语义由客户端全量重查。
    const revision = ++this.cacheRevision;
    const record: JournalRecord = { revision, upserts, removed };
    return this.appendJournal(`${JSON.stringify(record)}`).then(() => revision);
  }

  private appendJournal(recordText: string) {
    const write = this.persistTail.catch(() => undefined).then(async () => {
      const next = this.journalText ? `${this.journalText}\n${recordText}` : recordText;
      await this.storage.put(CACHE_JOURNAL_FILE, next);
      this.journalText = next;
      if (next.length >= this.journalCompactBytes) {
        // 压缩失败不使已成功的追加失败；journal 仍超阈值时下一次追加重试。
        void this.compactJournal(false).catch(() => undefined);
      }
    });
    this.persistTail = write;
    return write;
  }

  private compactJournal(force: boolean) {
    const write = this.persistTail.catch(() => undefined).then(async () => {
      if (this.journalText.length === 0) return;
      if (!force && this.journalText.length < this.journalCompactBytes) return;
      await this.doCompact();
    });
    this.persistTail = write;
    return write;
  }

  private async doCompact() {
    await this.storage.put(CACHE_INDEX_FILE, JSON.stringify(this.cache));
    this.journalText = "";
    try {
      await this.storage.remove(CACHE_JOURNAL_FILE);
    } catch {
      // 残留 journal 与 checkpoint 内容重叠，重放幂等；由下一次覆盖消除。
    }
  }

  /**
   * Kernel 插件卸载前调用：flush 未到期的 resolved batch，等待全部
   * mutation 与磁盘写排空，然后压缩 journal 使 checkpoint 保持最新。
   */
  async shutdown() {
    if (this.resolvedCommitBatch.length > 0) this.flushResolvedCommitBatch();
    await this.cacheMutationTail;
    await this.persistTail;
    await this.compactJournal(true);
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

  private async publishChange(upserts: Record<string, CacheEntry>, removed: string[], revision: number): Promise<CacheMutationReceipt> {
    // 不在此递增：revision 由 persistDelta 在 journal 追加前分配并传入。
    // Enumerate the batch keys so unrelated Frontend clients can skip their
    // working-set lookup; a bulk operation too broad to enumerate sends the
    // null sentinel so every client refreshes unconditionally.
    const changedKeys = [...new Set([...Object.keys(upserts), ...removed])];
    const change: CacheChangeEvent = {
      epoch: this.cacheEpoch,
      revision,
      changedKeys: changedKeys.length > MAX_EVENT_CHANGED_KEYS ? null : changedKeys,
    };
    try {
      await this.options.onCacheChanged?.({ ...change });
    } catch (error) {
      try {
        await this.options.onCacheChangedError?.(error);
      } catch {
        // Notification diagnostics cannot change an already committed mutation.
      }
    }
    // The receipt intentionally carries only the cursor, never the batch keys.
    return { status: "committed", epoch: change.epoch, revision: change.revision };
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

  private async runBulkRefresh(refresh: BulkRefreshState, scopes: LinkScope[], baselines: Map<string, number>) {
    let next = 0;
    const worker = async () => {
      while (refresh.state === "running") {
        const index = next;
        next += 1;
        if (index >= scopes.length) return;
        const scope = scopes[index];
        refresh.scheduled += 1;
        try {
          const result = await this.getOrQueue(scope, true, false, baselines.get(scope.key));
          if (result.status === "unavailable") {
            // 条目自刷新启动后被删除、钉住或替换（基线失效）：本次刷新不再
            // 适用，跳过而不发起新任务，不计为失败。
            refresh.skipped += 1;
          } else {
            if (result.status === "queued") await this.inFlight.get(scope.key)?.promise;
            const after = this.cache[scope.key];
            if (!after || after.pinned) {
              // 刷新期间条目被并发删除或钉住：其结果已无关紧要，不计为失败。
              refresh.skipped += 1;
            } else {
              // 条目仍在：刷新完成。图标未变化（解析未提交新图标）也不算失败，
              // 原图标继续生效，解析问题由失败通知路径单独上报。
              refresh.completed += 1;
            }
          }
        } catch {
          // 单个 scope 的失败（例如失败通知回调拒绝）不得中断整个批量刷新；
          // 计入 failed。
          refresh.failed += 1;
        }
        await this.notifyBulkRefresh(refresh);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_RESOLUTION_CONCURRENCY, scopes.length) }, worker));
    refresh.state = refresh.state === "cancelling" ? "cancelled" : "completed";
    await this.notifyBulkRefresh(refresh);
    // 刷新结束：flush 未到期的 resolved batch，排空写链，压缩 journal 使
    // 下一次启动无需重放本次刷新的全部记录。压缩失败不影响刷新结果。
    try {
      if (this.resolvedCommitBatch.length > 0) this.flushResolvedCommitBatch();
      await this.cacheMutationTail;
      await this.compactJournal(true);
    } catch {
      // 批量刷新结果已提交；仅压缩未完成，后续追加或卸载时重试。
    }
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

/**
 * 解析 Cache journal：按行顺序校验，第一条无法解析或形状非法的记录
 * 起截断尾部（该记录及其后全部丢弃）。validText 是有效记录的重组文本，
 * 作为后续追加的内存镜像基线。
 */
function parseJournal(value: string | undefined): { records: JournalRecord[]; validText: string } {
  if (!value) return { records: [], validText: "" };
  const records: JournalRecord[] = [];
  let validText = "";
  for (const line of value.split("\n")) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      break;
    }
    if (!isJournalRecord(record)) break;
    records.push(record);
    validText = validText ? `${validText}\n${line}` : line;
  }
  return { records, validText };
}

function isJournalRecord(value: unknown): value is JournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<JournalRecord>;
  return typeof record.revision === "number"
    && !!record.upserts && typeof record.upserts === "object" && !Array.isArray(record.upserts)
    && Array.isArray(record.removed);
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
