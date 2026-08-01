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

export type CachePolicy = {
  cacheDays: number;
  pauseAutomaticFetch?: boolean;
};

export type ResolvedIcon = {
  bytes: ArrayBuffer;
  contentType: string;
  source: string;
};

export interface CacheStorage {
  get(path: string): Promise<string | undefined>;
  put(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface IconResolver {
  resolve(scope: LinkScope): Promise<ResolvedIcon | null>;
}

export type CacheAuthorityOptions = {
  cachePolicy?: CachePolicy;
  resolverVersion?: number;
  privateIconUrl?: (iconId: string) => string;
  onStateChange?: (cache: Record<string, CacheEntry>) => Promise<void> | void;
  loadLegacyIcon?: (url: string) => Promise<{ bytes: ArrayBuffer; contentType: string } | undefined>;
  removeLegacyIcon?: (url: string) => Promise<void>;
};

const CACHE_INDEX_FILE = "favicon-cache-v2.json";
const LEGACY_CACHE_FILE = "favicon-cache.json";
const ICON_DIRECTORY = "icons";

export class KernelCacheAuthority {
  private cache: Record<string, CacheEntry> = {};
  private readonly generations = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<CacheEntry | null>>();
  private resolutionTail: Promise<void> = Promise.resolve();
  private persistTail: Promise<void> = Promise.resolve();
  private initializing?: Promise<void>;
  private policy: CachePolicy;
  private iconSequence = 0;

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
      if (stored) {
        this.cache = parseCache(stored);
      } else {
        this.cache = parseCache(await this.storage.get(LEGACY_CACHE_FILE));
        for (const [key, entry] of Object.entries(this.cache)) {
          if (!entry.pinned && entry.source !== "generated monogram" && this.options.resolverVersion !== undefined) {
            entry.resolverVersion = this.options.resolverVersion;
          }
          let legacyIcon: Awaited<ReturnType<NonNullable<CacheAuthorityOptions["loadLegacyIcon"]>>>;
          try {
            legacyIcon = await this.options.loadLegacyIcon?.(entry.url);
          } catch {
            // Legacy payload migration is best effort. A stale or unsupported
            // public file must not prevent the cache authority from starting.
            legacyIcon = undefined;
          }
          if (legacyIcon) {
            const iconId = this.iconIdFor(key);
            await this.storage.put(this.iconPath(iconId), bytesToBase64(legacyIcon.bytes));
            entry.iconId = iconId;
            entry.contentType = legacyIcon.contentType;
            entry.url = this.privateIconUrl(iconId);
          }
        }
        if (Object.keys(this.cache).length > 0) await this.persist();
      }
    })();
    return this.initializing;
  }

  snapshot() {
    return copyCache(this.cache);
  }

  setPolicy(policy: CachePolicy) {
    this.policy = { ...policy };
  }

  async getOrQueue(scope: LinkScope, force = false, automatic = false): Promise<CacheEntry | null> {
    await this.initialize();
    const existing = this.cache[scope.key];
    if (automatic && this.policy.pauseAutomaticFetch) return existing ? copyEntry(existing) : null;
    if (existing && !force && this.isFresh(existing)) return copyEntry(existing);
    const pending = this.inFlight.get(scope.key);
    if (pending) return pending;

    const generation = this.generationFor(scope.key);
    const task = this.enqueueResolution(async () => {
      if (generation !== this.generationFor(scope.key)) return null;
      const resolved = await this.resolver.resolve(scope);
      if (!resolved || generation !== this.generationFor(scope.key)) return null;
      return this.commitResolved(scope, resolved, generation);
    });
    this.inFlight.set(scope.key, task);
    void task.finally(() => {
      if (this.inFlight.get(scope.key) === task) this.inFlight.delete(scope.key);
    }).catch(() => undefined);
    return task;
  }

  async putPinned(scope: LinkScope, entry: CacheEntry, contentType: string, bytes: ArrayBuffer, replaceKey?: string) {
    await this.initialize();
    this.invalidate(scope.key);
    if (replaceKey && replaceKey !== scope.key) this.invalidate(replaceKey);
    const iconId = this.nextIconId(scope.key);
    await this.storage.put(this.iconPath(iconId), bytesToBase64(bytes));
    const previous = this.cache[scope.key];
    const replaced = replaceKey && replaceKey !== scope.key ? this.cache[replaceKey] : undefined;
    const nextEntry: CacheEntry = {
      ...entry,
      url: this.privateIconUrl(iconId), iconId, domain: scope.domain, routeKey: scope.routeKey,
      pathPrefix: scope.pathPrefix, targetUrl: scope.targetUrl, fetchedAt: this.now(), pinned: true,
      source: entry.source ?? "custom upload", resolverVersion: entry.resolverVersion, contentType,
    };
    const previousCache = this.cache;
    this.cache = { ...this.cache, [scope.key]: nextEntry };
    if (replaceKey && replaceKey !== scope.key) delete this.cache[replaceKey];
    try {
      await this.persist();
    } catch (error) {
      this.cache = previousCache;
      await this.storage.remove(this.iconPath(iconId));
      throw error;
    }
    await this.removePayload(previous, iconId);
    await this.removePayload(replaced, iconId);
    await this.notify();
    return copyEntry(this.cache[scope.key]);
  }

  async remove(key: string) {
    await this.initialize();
    this.invalidate(key);
    const previous = this.cache[key];
    delete this.cache[key];
    if (previous?.iconId) await this.storage.remove(this.iconPath(previous.iconId));
    else if (previous) await this.options.removeLegacyIcon?.(previous.url);
    await this.persist();
    await this.notify();
  }

  async clear() {
    await this.initialize();
    for (const key of this.inFlight.keys()) {
      if (!this.cache[key]?.pinned) this.invalidate(key);
    }
    const removable = Object.entries(this.cache).filter(([, entry]) => !entry.pinned);
    for (const [key, entry] of removable) {
      this.invalidate(key);
      delete this.cache[key];
      if (entry.iconId) await this.storage.remove(this.iconPath(entry.iconId));
      else await this.options.removeLegacyIcon?.(entry.url);
    }
    await this.persist();
    await this.notify();
  }

  async clearGenerated() {
    await this.initialize();
    const generated = Object.entries(this.cache).filter(([, entry]) => entry.source === "generated monogram");
    for (const [key, entry] of generated) {
      this.invalidate(key);
      delete this.cache[key];
      if (entry.iconId) await this.storage.remove(this.iconPath(entry.iconId));
      else await this.options.removeLegacyIcon?.(entry.url);
    }
    if (generated.length > 0) {
      await this.persist();
      await this.notify();
    }
  }

  async iconBytes(iconId: string) {
    const encoded = await this.storage.get(this.iconPath(iconId));
    return encoded ? base64ToArrayBuffer(encoded) : undefined;
  }

  async icon(iconId: string) {
    const entry = Object.values(this.cache).find((candidate) => candidate.iconId === iconId);
    if (!entry) return undefined;
    const bytes = await this.iconBytes(iconId);
    return bytes ? { bytes, contentType: entry.contentType ?? "application/octet-stream" } : undefined;
  }

  private async commitResolved(
    scope: LinkScope,
    resolved: ResolvedIcon,
    generation: number,
  ) {
    if (generation !== this.generationFor(scope.key)) return null;
    const previous = this.cache[scope.key];
    if (previous?.pinned) return copyEntry(previous);
    const iconId = this.nextIconId(scope.key);
    await this.storage.put(this.iconPath(iconId), bytesToBase64(resolved.bytes));
    if (generation !== this.generationFor(scope.key)) {
      await this.storage.remove(this.iconPath(iconId));
      return null;
    }
    this.cache[scope.key] = {
      url: this.privateIconUrl(iconId),
      iconId,
      fetchedAt: this.now(),
      source: resolved.source,
      targetUrl: scope.targetUrl,
      domain: scope.domain,
      routeKey: scope.routeKey,
      pathPrefix: scope.pathPrefix,
      contentType: resolved.contentType,
      resolverVersion: this.options.resolverVersion,
    };
    await this.persist();
    if (previous?.iconId && previous.iconId !== iconId) await this.storage.remove(this.iconPath(previous.iconId));
    await this.notify();
    return copyEntry(this.cache[scope.key]);
  }

  private async removePayload(entry: CacheEntry | undefined, replacementIconId?: string) {
    if (!entry || entry.iconId === replacementIconId) return;
    if (entry.iconId) await this.storage.remove(this.iconPath(entry.iconId));
    else await this.options.removeLegacyIcon?.(entry.url);
  }

  private enqueueResolution<T>(operation: () => Promise<T>) {
    const task = this.resolutionTail.then(operation);
    this.resolutionTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private persist() {
    const snapshot = JSON.stringify(this.cache);
    const write = this.persistTail.catch(() => undefined).then(() => this.storage.put(CACHE_INDEX_FILE, snapshot));
    this.persistTail = write;
    return write;
  }

  private async notify() {
    await this.options.onStateChange?.(this.snapshot());
  }

  private isFresh(entry: CacheEntry) {
    if (entry.pinned) return true;
    const maxAge = this.policy.cacheDays > 0 ? this.policy.cacheDays * 86400000 : Infinity;
    return this.now() - entry.fetchedAt <= maxAge;
  }

  private invalidate(key: string) {
    this.generations.set(key, this.generationFor(key) + 1);
  }

  private generationFor(key: string) {
    return this.generations.get(key) ?? 0;
  }

  private iconIdFor(key: string) {
    return encodeURIComponent(key).replace(/%/g, "_");
  }

  private nextIconId(key: string) {
    this.iconSequence += 1;
    return `${this.iconIdFor(key)}-${this.now().toString(36)}-${this.iconSequence.toString(36)}`;
  }

  private iconPath(iconId: string) {
    return `${ICON_DIRECTORY}/${iconId}.base64`;
  }

  private privateIconUrl(iconId: string) {
    return (this.options.privateIconUrl ?? ((id) => `/api/plugin/private/auto-favicon/icon/${encodeURIComponent(id)}`))(iconId);
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


function bytesToBase64(bytes: ArrayBuffer) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToArrayBuffer(value: string) {
  const bytes = Buffer.from(value, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
