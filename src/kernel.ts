import type * as kernel from "siyuan/kernel";
import {
  KernelCacheAuthority,
  type CacheEntry,
  type CacheStorage,
  type LinkScope,
} from "./cache-authority";
import { ForwardProxyIconResolver } from "./kernel-resolver";
import { pinCustomUrl } from "./pin-url";
import { PRIVATE_ICON_CACHE_CONTROL, privateIconIdFromPath } from "./private-route";
import { DEFAULT_CACHE_POLICY, RESOLVER_VERSION, type CachePolicyFields } from "./resolver-contract";

const POLICY_FILE = "cache-policy-v2.json";

const defaultPolicy: CachePolicyFields = { ...DEFAULT_CACHE_POLICY };

class KernelStorage implements CacheStorage {
  async get(path: string) {
    try {
      return await siyuan.storage.get(path).then((data) => data.text());
    } catch {
      return undefined;
    }
  }

  async put(path: string, content: string) {
    await siyuan.storage.put(path, content);
  }

  async remove(path: string) {
    try {
      await siyuan.storage.remove(path);
    } catch {
      // Removing a missing payload is equivalent to successful cleanup.
    }
  }
}

class LinkmarkKernel {
  private policy: CachePolicyFields = { ...defaultPolicy };
  private authority?: KernelCacheAuthority;
  private resolver?: ForwardProxyIconResolver;

  constructor() {
    siyuan.plugin.lifecycle.onload = this.onload.bind(this);
    siyuan.plugin.lifecycle.onrunning = this.onrunning.bind(this);
    siyuan.plugin.lifecycle.onunload = this.onunload.bind(this);
    siyuan.server.private.http.handler = this.handlePrivateRequest.bind(this);
  }

  private async onload() {
    try {
      this.policy = await this.loadPolicy();
      this.resolver = new ForwardProxyIconResolver(this.forward.bind(this), () => this.policy);
      this.authority = new KernelCacheAuthority(new KernelStorage(), this.resolver, () => Date.now(), {
        cachePolicy: this.policy,
        resolverVersion: RESOLVER_VERSION,
        privateIconUrl: (iconId) => `/plugin/private/${siyuan.plugin.name}/icon/${encodeURIComponent(iconId)}`,
        onCacheChanged: async (event) => siyuan.rpc.broadcast("cache.changed", event),
        onCacheChangedError: async (error) => {
          await siyuan.logger.error("Linkmark cache change broadcast failed", errorText(error)).catch(() => undefined);
        },
        onResolutionFailure: async (scope, category) => siyuan.rpc.broadcast("cache.resolution-failed", { key: scope.key, category }),
        onBulkRefreshChanged: async (state) => siyuan.rpc.broadcast("cache.refresh-all.changed", state),
      });
      await siyuan.rpc.bind("cache.lookup", async (scopes: LinkScope[]) => this.requireAuthority().lookup(scopes.map(normalizeLookupScope)), "Returns effective Cache matches for requested Present scopes.");
      await siyuan.rpc.bind("cache.query", async (query: { query: string; offset: number; limit: number }) => this.requireAuthority().query(query), "Returns a revision-tagged Cache-management page.");
      await siyuan.rpc.bind("cache.stats", async () => this.requireAuthority().stats(), "Returns Cache count, cursor, and Bulk refresh status.");
      await siyuan.rpc.bind("cache.get-or-queue", async (scope: LinkScope, force = false, automatic = false) => {
        // authority 未就绪（未初始化或初始化失败）时由 getOrQueue 以
        // unavailable 显式应答，不在此处拦截为 RPC 内部错误。
        return this.requireAuthority().getOrQueue(normalizeScope(scope), force, automatic);
      }, "Returns a cached icon, a queue acknowledgement, or an explicit unavailable result.");
      await siyuan.rpc.bind("cache.remove", async (key: string, guard?: { epoch: string; entryToken: string }) => this.requireAuthority().remove(key, guard), "Removes one cache entry workspace-wide and returns its mutation receipt.");
      await siyuan.rpc.bind("cache.refresh-one", async (key: string, guard: { epoch: string; entryToken: string }) => this.requireAuthority().refreshEntry(key, guard), "Refreshes one unchanged Cache-management entry.");
      await siyuan.rpc.bind("cache.refresh-all", async () => this.requireAuthority().startBulkRefresh(), "Starts or observes the Workspace Bulk cache refresh.");
      await siyuan.rpc.bind("cache.refresh-all.cancel", async () => this.requireAuthority().cancelBulkRefresh(), "Cancels future scheduling for the Workspace Bulk cache refresh.");
      await siyuan.rpc.bind("cache.clear", async () => this.requireAuthority().clear(), "Clears non-pinned cache entries workspace-wide and returns its mutation receipt.");
      await siyuan.rpc.bind("cache.clear-generated", async () => this.requireAuthority().clearGenerated(), "Clears generated monograms after policy changes and returns its mutation receipt.");
      await siyuan.rpc.bind("cache.policy.get", async () => this.policy, "Returns workspace cache policy.");
      await siyuan.rpc.bind("cache.policy.set", async (policy: Partial<CachePolicyFields>) => this.setPolicy(policy), "Updates workspace cache policy.");
      await siyuan.rpc.bind("cache.pin", async (scope: LinkScope, entry: CacheEntry, contentType: string, base64: string, replaceKey?: string, guard?: { epoch: string; entryToken: string }) => {
        const bytes = Buffer.from(base64, "base64");
        return this.requireAuthority().putPinned(normalizeScope(scope), entry, contentType, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), replaceKey, guard);
      }, "Pins a user-selected icon workspace-wide and returns its mutation receipt.");
      await siyuan.rpc.bind("cache.candidates", async (scope: LinkScope, discoverPage = false) => {
        const candidates = await this.requireResolver().candidates(normalizeScope(scope), discoverPage || this.policy.allowFullPageDiscovery);
        return candidates.map((candidate) => ({ ...candidate, base64: Buffer.from(candidate.bytes).toString("base64") }));
      }, "Returns server-downloaded icon candidates for a scope.");
      await siyuan.rpc.bind("cache.pin-url", async (scope: LinkScope, iconUrl: string, includeSubdomains = false, replaceKey?: string, guard?: { epoch: string; entryToken: string }) => {
        const resolver = this.requireResolver();
        const authority = this.requireAuthority();
        return pinCustomUrl({
          resolveUrl: (url) => resolver.resolveUrl(url),
          putPinned: (pinScope, entry, contentType, bytes, pinReplaceKey, pinGuard) => authority.putPinned(pinScope, entry, contentType, bytes, pinReplaceKey, pinGuard),
        }, normalizeScope(scope), iconUrl, includeSubdomains, replaceKey, guard);
      }, "Downloads and pins a custom icon URL workspace-wide and returns its mutation receipt.");
      // 先注册全部 Kernel RPC 再初始化：初始化失败时绑定仍然存在，
      // cache.get-or-queue 以 unavailable 显式应答，其余方法按既有 fail-open
      // 语义以 RPC 错误响应；恢复路径是重载 kernel 插件（新实例重新初始化）。
      await this.authority.initialize();
    } catch (error) {
      await siyuan.logger.error("Linkmark Kernel initialization failed", errorText(error)).catch(() => undefined);
    }
  }

  private onrunning() {
    // SiYuan v3.7.3 invokes every lifecycle hook, including this optional one.
  }

  private async onunload() {
    const methods = ["cache.lookup", "cache.query", "cache.stats", "cache.get-or-queue", "cache.remove", "cache.refresh-one", "cache.refresh-all", "cache.refresh-all.cancel", "cache.clear", "cache.clear-generated", "cache.policy.get", "cache.policy.set", "cache.pin", "cache.candidates", "cache.pin-url"];
    for (const method of methods) {
      await siyuan.rpc.unbind(method);
    }
  }

  private async setPolicy(policy: Partial<CachePolicyFields>) {
    this.policy = { ...this.policy, ...sanitizePolicy(policy) };
    this.requireAuthority().setPolicy(this.policy);
    await siyuan.storage.put(POLICY_FILE, JSON.stringify(this.policy));
    await siyuan.rpc.broadcast("cache.policy.changed", { policy: this.policy });
    return this.policy;
  }

  private async loadPolicy() {
    const storage = new KernelStorage();
    const stored = await storage.get(POLICY_FILE);
    if (!stored) return { ...defaultPolicy };
    try {
      return { ...defaultPolicy, ...sanitizePolicy(JSON.parse(stored) as Partial<CachePolicyFields>) };
    } catch {
      return { ...defaultPolicy };
    }
  }

  private async forward(url: string, responseEncoding: "text" | "base64", contentType: string, timeout = 8000) {
    const response = await siyuan.client.fetch("/api/network/forwardProxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        method: "GET",
        redirect: false,
        timeout,
        contentType,
        headers: [{ "User-Agent": "Mozilla/5.0 (compatible; SiYuan Linkmark/0.1.0)" }, { Accept: responseEncoding === "text" ? "text/html,application/xhtml+xml,application/json" : "image/avif,image/webp,image/*,*/*" }],
        payload: {},
        payloadEncoding: "text",
        responseEncoding,
      }),
    });
    if (!response.ok) return null;
    const envelope = await response.json() as { code?: number; data?: { body?: string; contentType?: string; headers?: Record<string, string | string[]>; status?: number; url?: string } };
    if (envelope.code !== 0 || typeof envelope.data?.body !== "string" || typeof envelope.data.status !== "number") return null;
    return {
      body: envelope.data.body,
      contentType: envelope.data.contentType,
      headers: envelope.data.headers,
      status: envelope.data.status,
      url: envelope.data.url,
    };
  }

  private async handlePrivateRequest(request: kernel.IServerRequest): Promise<kernel.IHttpResponse> {
    const iconId = privateIconIdFromPath(request.url.path, siyuan.plugin.name);
    if (!iconId) return notFound();
    const icon = await this.requireAuthority().icon(decodeURIComponent(iconId));
    if (!icon) return notFound();
    return {
      statusCode: 200,
      headers: { "Cache-Control": [PRIVATE_ICON_CACHE_CONTROL] },
      body: { raw: { contentType: icon.contentType, data: icon.bytes } },
    };
  }

  private requireAuthority() {
    if (!this.authority) throw new Error("Linkmark cache authority is not ready");
    return this.authority;
  }

  private requireResolver() {
    if (!this.resolver) throw new Error("Linkmark resolver is not ready");
    return this.resolver;
  }
}

function normalizeScope(scope: LinkScope): LinkScope {
  if (!scope || typeof scope !== "object" || typeof scope.key !== "string" || typeof scope.domain !== "string" || typeof scope.targetUrl !== "string") {
    throw new Error("Invalid Link scope");
  }
  const target = new URL(scope.targetUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Link scope must use HTTP(S)");
  if (target.hostname.toLowerCase() !== scope.domain.toLowerCase()) throw new Error("Link scope domain must match its target URL");
  const path = scope.pathPrefix ?? "/";
  return { ...scope, targetUrl: new URL(path, target.origin).href };
}

function normalizeLookupScope(scope: LinkScope): LinkScope {
  if (!scope || typeof scope !== "object" || typeof scope.key !== "string" || typeof scope.domain !== "string") {
    throw new Error("Invalid Link scope");
  }
  const domain = scope.domain.toLowerCase();
  return {
    key: scope.key,
    domain,
    targetUrl: `https://${domain}${scope.pathPrefix ?? "/"}`,
    routeKey: scope.routeKey,
    pathPrefix: scope.pathPrefix,
  };
}

function sanitizePolicy(policy: Partial<CachePolicyFields>) {
  const result: Partial<CachePolicyFields> = {};
  for (const key of Object.keys(defaultPolicy) as Array<keyof CachePolicyFields>) {
    if (policy[key] !== undefined) (result as Record<string, unknown>)[key] = policy[key];
  }
  return result;
}

function notFound(): kernel.IHttpResponse {
  return { statusCode: 404, body: { string: { format: "Not found" } } };
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

new LinkmarkKernel();
