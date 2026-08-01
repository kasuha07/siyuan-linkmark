import type * as kernel from "siyuan/kernel";
import {
  KernelCacheAuthority,
  type CacheEntry,
  type CachePolicy,
  type CacheStorage,
  type LinkScope,
} from "./cache-authority";
import { ForwardProxyIconResolver, type KernelResolverPolicy } from "./kernel-resolver";
import { privateIconIdFromPath } from "./private-route";

const POLICY_FILE = "cache-policy-v2.json";
const LEGACY_SETTINGS_FILE = "settings.json";

type CachePolicyState = CachePolicy & KernelResolverPolicy;

const defaultPolicy: CachePolicyState = {
  cacheDays: 30,
  pauseAutomaticFetch: false,
  provider: "https://example.com/favicon/{domain}",
  providerPreset: "auto",
  resolverMode: "mainland",
  fallbackMode: "monogram",
  allowFullPageDiscovery: false,
  monogramColorMode: "domain",
  monogramPrimary: "#4F7CFF",
  monogramSecondary: "#745CFF",
  monogramText: "#FFFFFF",
  monogramShape: "rounded",
  monogramOverrides: {},
};

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

class AutoFaviconKernel {
  private policy: CachePolicyState = { ...defaultPolicy };
  private authority?: KernelCacheAuthority;
  private resolver?: ForwardProxyIconResolver;

  constructor() {
    siyuan.plugin.lifecycle.onload = this.onload.bind(this);
    siyuan.plugin.lifecycle.onunload = this.onunload.bind(this);
    siyuan.server.private.http.handler = this.handlePrivateRequest.bind(this);
  }

  private async onload() {
    this.policy = await this.loadPolicy();
    this.resolver = new ForwardProxyIconResolver(this.forward.bind(this), () => this.policy);
    this.authority = new KernelCacheAuthority(new KernelStorage(), this.resolver, () => Date.now(), {
      cachePolicy: this.policy,
      resolverVersion: 6,
      privateIconUrl: (iconId) => `/plugin/private/${siyuan.plugin.name}/icon/${encodeURIComponent(iconId)}`,
      onStateChange: async (cache) => siyuan.rpc.broadcast("cache.changed", { cache }),
      loadLegacyIcon: this.loadLegacyIcon.bind(this),
      removeLegacyIcon: this.removeLegacyIcon.bind(this),
    });
    await this.authority.initialize();
    await siyuan.rpc.bind("cache.snapshot", async () => this.requireAuthority().snapshot(), "Returns the authoritative favicon cache.");
    await siyuan.rpc.bind("cache.get-or-queue", async (scope: LinkScope, force = false, automatic = false) => this.requireAuthority().getOrQueue(normalizeScope(scope), force, automatic), "Returns a cached icon or queues server-side resolution.");
    await siyuan.rpc.bind("cache.remove", async (key: string) => this.requireAuthority().remove(key), "Removes one cache entry workspace-wide.");
    await siyuan.rpc.bind("cache.clear", async () => this.requireAuthority().clear(), "Clears non-pinned cache entries workspace-wide.");
    await siyuan.rpc.bind("cache.clear-generated", async () => this.requireAuthority().clearGenerated(), "Clears generated monograms after policy changes.");
    await siyuan.rpc.bind("cache.policy.get", async () => this.policy, "Returns workspace cache policy.");
    await siyuan.rpc.bind("cache.policy.set", async (policy: Partial<CachePolicyState>) => this.setPolicy(policy), "Updates workspace cache policy.");
    await siyuan.rpc.bind("cache.pin", async (scope: LinkScope, entry: CacheEntry, contentType: string, base64: string, replaceKey?: string) => {
      const bytes = Buffer.from(base64, "base64");
      return this.requireAuthority().putPinned(normalizeScope(scope), entry, contentType, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), replaceKey);
    }, "Pins a user-selected icon workspace-wide.");
    await siyuan.rpc.bind("cache.candidates", async (scope: LinkScope, discoverPage = false) => {
      const candidates = await this.requireResolver().candidates(normalizeScope(scope), discoverPage || this.policy.allowFullPageDiscovery);
      return candidates.map((candidate) => ({ ...candidate, base64: Buffer.from(candidate.bytes).toString("base64") }));
    }, "Returns server-downloaded icon candidates for a scope.");
    await siyuan.rpc.bind("cache.pin-url", async (scope: LinkScope, iconUrl: string, includeSubdomains = false, replaceKey?: string) => {
      const normalized = normalizeScope(scope);
      const resolved = await this.requireResolver().resolveUrl(iconUrl);
      if (!resolved) throw new Error("Custom icon URL did not return a usable image");
      return this.requireAuthority().putPinned(normalized, {
        url: "",
        fetchedAt: Date.now(),
        source: "custom URL",
        targetUrl: normalized.targetUrl,
        domain: normalized.domain,
        routeKey: normalized.routeKey,
        pathPrefix: normalized.pathPrefix,
        pinned: true,
        includeSubdomains,
      }, resolved.contentType, resolved.bytes, replaceKey);
    }, "Downloads and pins a custom icon URL workspace-wide.");
  }

  private async onunload() {
    for (const method of ["cache.snapshot", "cache.get-or-queue", "cache.remove", "cache.clear", "cache.clear-generated", "cache.policy.get", "cache.policy.set", "cache.pin", "cache.candidates", "cache.pin-url"]) {
      await siyuan.rpc.unbind(method);
    }
  }

  private async setPolicy(policy: Partial<CachePolicyState>) {
    this.policy = { ...this.policy, ...sanitizePolicy(policy) };
    this.requireAuthority().setPolicy(this.policy);
    await siyuan.storage.put(POLICY_FILE, JSON.stringify(this.policy));
    await siyuan.rpc.broadcast("cache.policy.changed", { policy: this.policy });
    return this.policy;
  }

  private async loadPolicy() {
    const storage = new KernelStorage();
    const stored = await storage.get(POLICY_FILE) ?? await storage.get(LEGACY_SETTINGS_FILE);
    if (!stored) return { ...defaultPolicy };
    try {
      return { ...defaultPolicy, ...sanitizePolicy(JSON.parse(stored) as Partial<CachePolicyState>) };
    } catch {
      return { ...defaultPolicy };
    }
  }

  private async forward(url: string, responseEncoding: "text" | "base64", contentType: string, timeout = 8000) {
    const response = await siyuan.client.fetch("/api/network/forwardProxy", {
      method: "POST",
      body: JSON.stringify({
        url,
        method: "GET",
        timeout,
        contentType,
        headers: [{ "User-Agent": "Mozilla/5.0 (compatible; SiYuan Auto Favicon/0.6)" }, { Accept: responseEncoding === "text" ? "text/html,application/xhtml+xml,application/json" : "image/avif,image/webp,image/*,*/*" }],
        payload: {},
        payloadEncoding: "text",
        responseEncoding,
      }),
    });
    if (!response.ok) return null;
    const envelope = await response.json() as { code?: number; data?: { body?: string; contentType?: string; status?: number; url?: string } };
    if (envelope.code !== 0 || !envelope.data?.body || typeof envelope.data.status !== "number") return null;
    return { body: envelope.data.body, contentType: envelope.data.contentType, status: envelope.data.status, url: envelope.data.url };
  }

  private async loadLegacyIcon(url: string) {
    if (!url.startsWith("/public/auto-favicon/")) return undefined;
    const response = await siyuan.client.fetch("/api/file/getFile", {
      method: "POST",
      body: JSON.stringify({ path: `/data${url}` }),
    });
    if (!response.ok) return undefined;
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) return undefined;
    return { bytes, contentType: response.headers["Content-Type"]?.split(";", 1)[0] ?? "application/octet-stream" };
  }

  private async removeLegacyIcon(url: string) {
    if (!url.startsWith("/public/auto-favicon/")) return;
    await siyuan.client.fetch("/api/file/removeFile", {
      method: "POST",
      body: JSON.stringify({ path: `/data${url}` }),
    });
  }

  private async handlePrivateRequest(request: kernel.IServerRequest): Promise<kernel.IHttpResponse> {
    const iconId = privateIconIdFromPath(request.url.path, siyuan.plugin.name);
    if (!iconId) return notFound();
    const icon = await this.requireAuthority().icon(decodeURIComponent(iconId));
    if (!icon) return notFound();
    return {
      statusCode: 200,
      headers: { "Cache-Control": ["private, max-age=86400"] },
      body: { raw: { contentType: icon.contentType, data: icon.bytes } },
    };
  }

  private requireAuthority() {
    if (!this.authority) throw new Error("Auto Favicon cache authority is not ready");
    return this.authority;
  }

  private requireResolver() {
    if (!this.resolver) throw new Error("Auto Favicon resolver is not ready");
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

function sanitizePolicy(policy: Partial<CachePolicyState>) {
  const result: Partial<CachePolicyState> = {};
  for (const key of Object.keys(defaultPolicy) as Array<keyof CachePolicyState>) {
    if (policy[key] !== undefined) (result as Record<string, unknown>)[key] = policy[key];
  }
  return result;
}

function notFound(): kernel.IHttpResponse {
  return { statusCode: 404, body: { string: { format: "Not found" } } };
}

new AutoFaviconKernel();
