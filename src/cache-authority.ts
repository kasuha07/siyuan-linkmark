import { InvalidShareDomainError, isEligibleShareTarget, shareEligibilityOf } from "./parent-domain";
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
  | { status: "ready"; entry: CacheEntry }
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
export type CacheChangeEvent = {
  epoch: string;
  revision: number;
  upserts: Record<string, CacheEntry>;
  removed: string[];
};

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
  cachePolicy?: CachePolicy;
  resolverVersion?: number;
  privateIconUrl?: (iconId: string) => string;
  onCacheChanged?: (event: CacheChangeEvent) => Promise<void> | void;
  onResolutionFailure?: (scope: LinkScope, category: ResolutionFailureCategory) => Promise<void> | void;
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
  private initializing?: Promise<void>;
  private policy: CachePolicy;
  private iconSequence = 0;
  private cacheRevision = 0;
  private readonly cacheEpoch = newCacheEpoch();

  constructor(
    private readonly storage: CacheStorage,
    private readonly resolver: IconResolver,
    private readonly now: () => number = () => Date.now(),
    private readonly options: CacheAuthorityOptions = {},
  ) {
    this.policy = options.cachePolicy ?? { cacheDays: 30 };
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
      return existing ? { status: "ready", entry: copyEntry(existing) } : { status: "unavailable" };
    }
    if (existing && !force && this.isFresh(existing)) return { status: "ready", entry: copyEntry(existing) };
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

  async putPinned(scope: LinkScope, entry: CacheEntry, contentType: string, bytes: ArrayBuffer, replaceKey?: string) {
    if (entry.includeSubdomains && !isEligibleShareTarget(scope.domain)) {
      throw new InvalidShareDomainError();
    }
    await this.initialize();
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
      const nextCache = { ...this.cache, [scope.key]: nextEntry };
      if (replaceKey && replaceKey !== scope.key) delete nextCache[replaceKey];
      try {
        await this.persist(nextCache);
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
      const previousCache = this.cache;
      this.cache = nextCache;
      completeInvalidations();
      await this.notify(previousCache, nextCache);
      await this.removePayload(previous, iconId);
      await this.removePayload(replaced, iconId);
      return copyEntry(nextEntry);
    });
  }

  async remove(key: string) {
    await this.initialize();
    const generation = this.invalidate(key);
    return this.enqueueCacheMutation(async () => {
      const previous = this.cache[key];
      if (!previous) {
        this.completeInvalidation(key, generation);
        return;
      }
      const previousCache = this.cache;
      const nextCache = { ...this.cache };
      delete nextCache[key];
      try {
        await this.persist(nextCache);
      } catch (error) {
        this.completeInvalidation(key, generation);
        throw error;
      }
      this.cache = nextCache;
      this.completeInvalidation(key, generation);
      await this.notify(previousCache, nextCache);
      await this.removePayload(previous);
    });
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
      const previousCache = this.cache;
      const nextCache = Object.fromEntries(Object.entries(this.cache).filter(([, entry]) => entry.pinned));
      try {
        await this.persist(nextCache);
      } catch (error) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        throw error;
      }
      this.cache = nextCache;
      for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
      await this.notify(previousCache, nextCache);
      for (const [, entry] of removable) await this.removePayload(entry);
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
        return;
      }
      const previousCache = this.cache;
      const nextCache = Object.fromEntries(Object.entries(this.cache).filter(([, entry]) => entry.source !== "generated monogram"));
      try {
        await this.persist(nextCache);
      } catch (error) {
        for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
        throw error;
      }
      this.cache = nextCache;
      for (const [key, generation] of invalidations) this.completeInvalidation(key, generation);
      await this.notify(previousCache, nextCache);
      for (const [, entry] of generated) await this.removePayload(entry);
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
      void Promise.resolve().then(() => this.flushResolvedCommitBatch());
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
    const previousCache = this.cache;
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

    const nextCache = { ...this.cache };
    for (const pending of current) nextCache[pending.key] = pending.entry;
    try {
      await this.persist(nextCache);
    } catch (error) {
      await Promise.all(current.map(({ entry }) => this.storage.remove(this.iconPath(entry.iconId!))));
      throw error;
    }
    const committed = current.filter(({ key, generation }) => this.isCurrentGeneration(key, generation));
    if (committed.length !== current.length) {
      const finalCache = { ...this.cache };
      for (const pending of committed) finalCache[pending.key] = pending.entry;
      await this.persist(finalCache);
      for (const pending of current) {
        if (!committed.includes(pending)) {
          await this.storage.remove(this.iconPath(pending.entry.iconId!));
        }
      }
      this.cache = finalCache;
    } else {
      this.cache = nextCache;
    }

    if (committed.length > 0) {
      // A batch publishes one isolated event, so connected clients reconcile
      // once even when several scopes resolve together.
      await this.notify(previousCache, this.cache);
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
    const write = this.persistTail.catch(() => undefined).then(() => this.storage.put(CACHE_INDEX_FILE, snapshot));
    this.persistTail = write;
    return write;
  }

  private async notify(previous: Record<string, CacheEntry>, next: Record<string, CacheEntry>) {
    this.cacheRevision += 1;
    const upserts: Record<string, CacheEntry> = {};
    for (const [key, entry] of Object.entries(next)) {
      if (previous[key] !== entry) upserts[key] = copyEntry(entry);
    }
    const removed: string[] = [];
    for (const key of Object.keys(previous)) {
      if (!(key in next)) removed.push(key);
    }
    await this.options.onCacheChanged?.({ epoch: this.cacheEpoch, revision: this.cacheRevision, upserts, removed });
  }

  private async notifyResolutionFailure(scope: LinkScope, category: ResolutionFailureCategory) {
    await this.options.onResolutionFailure?.(scope, category);
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
    return `${encodeScopeKey(key)}-${this.now().toString(36)}-${this.iconSequence.toString(36)}`;
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
