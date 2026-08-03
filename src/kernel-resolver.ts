import { ResolutionError, type IconResolver, type LinkScope, type ResolvedIcon, type ResolutionTrigger } from "./cache-authority";
import { monogramSvg } from "./monogram";
import { parentDomainOf } from "./parent-domain";
import { MAX_ICON_BYTES, type CachePolicyFields } from "./resolver-contract";
import { isAuthenticationRedirect, isAuthenticationTarget, isSafePublicTarget } from "./url-safety";

export type KernelResolverPolicy = Pick<CachePolicyFields,
  | "provider"
  | "providerPreset"
  | "resolverMode"
  | "fallbackMode"
  | "allowFullPageDiscovery"
  | "monogramColorMode"
  | "monogramPrimary"
  | "monogramSecondary"
  | "monogramText"
  | "monogramShape"
  | "monogramOverrides">;

export type ForwardResponse = { body: string; contentType?: string; headers?: Record<string, string | string[]>; status: number; url?: string };
export type ForwardProxy = (url: string, responseEncoding: "text" | "base64", contentType: string, timeout?: number) => Promise<ForwardResponse | null>;

type Candidate = { url: string; source: string };
const MAX_RESOLUTION_CANDIDATE_ATTEMPTS = 4;
const MAX_RESOLUTION_BUDGET_MS = 10_000;
const MAX_REDIRECTS = 3;

type DownloadOutcome =
  | { kind: "resolved"; resolved: ResolvedIcon }
  | { kind: "failed" }
  | { kind: "invalid" }
  | { kind: "network" }
  | { kind: "timeout" };

export class ForwardProxyIconResolver implements IconResolver {
  constructor(private readonly forward: ForwardProxy, private readonly policy: () => KernelResolverPolicy) {}

  async resolve(
    scope: LinkScope,
    _trigger: ResolutionTrigger = "automatic",
  ): Promise<ResolvedIcon | null> {
    let target: URL;
    try {
      target = new URL(scope.targetUrl);
    } catch {
      return null;
    }
    if (!isSafePublicTarget(target)) return null;
    const deadline = Date.now() + MAX_RESOLUTION_BUDGET_MS;
    const candidates = await this.candidateUrls(target, scope, this.policy().allowFullPageDiscovery || Boolean(scope.discoverPage), deadline);
    const attempts = candidates.slice(0, MAX_RESOLUTION_CANDIDATE_ATTEMPTS);
    let networkFailure = false;
    let invalidData = false;
    for (const candidate of attempts) {
      const outcome = await this.tryDownload(candidate, deadline);
      if (outcome.kind === "resolved") return outcome.resolved;
      if (outcome.kind === "network") networkFailure = true;
      if (outcome.kind === "invalid") invalidData = true;
      if (outcome.kind === "timeout") throw new ResolutionError("timeout");
    }
    if (this.policy().fallbackMode === "monogram") return this.monogram(target.hostname);
    throw new ResolutionError(networkFailure ? "network" : invalidData ? "invalid" : "exhausted");
  }

  async candidates(scope: LinkScope, allowFullPageDiscovery = this.policy().allowFullPageDiscovery) {
    let target: URL;
    try {
      target = new URL(scope.targetUrl);
    } catch {
      return [];
    }
    if (!isSafePublicTarget(target)) return [];
    const results: ResolvedIcon[] = [];
    for (const candidate of await this.candidateUrls(target, scope, allowFullPageDiscovery, Infinity)) {
      const outcome = await this.tryDownload(candidate, Infinity);
      if (outcome.kind === "resolved") results.push(outcome.resolved);
      if (results.length >= 8) break;
    }
    return results;
  }

  async resolveUrl(url: string): Promise<ResolvedIcon | null> {
    try {
      const target = new URL(url);
      if (!isSafePublicTarget(target)) return null;
      const resolved = await this.download({ url: target.href, source: "custom URL" });
      return resolved ? { ...resolved, source: "custom URL" } : null;
    } catch {
      return null;
    }
  }

  private async candidateUrls(target: URL, scope: LinkScope, allowFullPageDiscovery: boolean, deadline: number) {
    const policy = this.policy();
    const candidates: Candidate[] = [];
    const root = new URL("/", target.origin);
    if (allowFullPageDiscovery) {
      candidates.push(...await this.discoverPageIcons(target, target, "page rel=icon", deadline));
      candidates.push(...await this.discoverPageIcons(root, target, "root rel=icon", deadline));
    }
    if (scope.platformIconUrl) {
      try {
        const platformUrl = new URL(scope.platformIconUrl);
        if (isSafePublicTarget(platformUrl)) candidates.push({ url: platformUrl.href, source: scope.platformIconSource ?? "platform type icon" });
      } catch {
        // Ignore malformed reviewed route mappings.
      }
    }
    // Default resolution is the fast path: standard root icon paths and
    // configured providers, without HTML or manifest retrieval.
    candidates.push(
      { url: new URL("/favicon.ico", target.origin).href, source: "root favicon.ico" },
      { url: new URL("/favicon.png", target.origin).href, source: "root favicon.png" },
      ...providerCandidates(target.hostname.toLowerCase(), policy),
      { url: new URL("/favicon.svg", target.origin).href, source: "root favicon.svg" },
      { url: new URL("/apple-touch-icon.png", target.origin).href, source: "root apple-touch-icon.png" },
    );
    if (allowFullPageDiscovery) {
      const parentDomain = parentDomainOf(target.hostname);
      if (parentDomain) {
        const parent = new URL(`${target.protocol}//${parentDomain}/`);
        candidates.push(...await this.discoverPageIcons(parent, parent, `parent domain ${parentDomain} · rel=icon`, deadline));
        candidates.push(
          { url: new URL("/favicon.ico", parent).href, source: `parent domain ${parentDomain} · root favicon.ico` },
          { url: new URL("/favicon.png", parent).href, source: `parent domain ${parentDomain} · root favicon.png` },
          { url: new URL("/favicon.svg", parent).href, source: `parent domain ${parentDomain} · root favicon.svg` },
          { url: new URL("/apple-touch-icon.png", parent).href, source: `parent domain ${parentDomain} · root apple-touch-icon.png` },
        );
      }
    }
    return [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
  }

  private async discoverPageIcons(target: URL, requestedTarget: URL, source: string, deadline: number): Promise<Candidate[]> {
    const page = await this.forwardFollowingRedirects(target.href, "text", "text/html", deadline);
    if (!page || page.status < 200 || page.status >= 300 || !page.body || isAuthenticationRedirect(requestedTarget, page.url)) return [];
    const base = page.url ?? target.href;
    const candidates = [...page.body.matchAll(/<link\b[^>]*>/gi)].flatMap((match) => {
      const attributes = attributesFor(match[0]);
      const rel = attributes.rel?.toLowerCase() ?? "";
      if (!attributes.href || (!rel.split(/\s+/).includes("icon") && !rel.includes("apple-touch-icon") && !rel.includes("mask-icon"))) return [];
      try {
        const url = new URL(attributes.href, base);
        return isSafePublicTarget(url) ? [{ url: url.href, source }] : [];
      } catch {
        return [];
      }
    });
    const manifest = [...page.body.matchAll(/<link\b[^>]*>/gi)].find((match) => {
      const attributes = attributesFor(match[0]);
      return attributes.rel?.toLowerCase().split(/\s+/).includes("manifest") && Boolean(attributes.href);
    });
    if (!manifest) return candidates;
    try {
      const manifestUrl = new URL(attributesFor(manifest[0]).href!, base);
      return [...candidates, ...await this.discoverManifestIcons(manifestUrl, requestedTarget, source, deadline)];
    } catch {
      return candidates;
    }
  }

  private async discoverManifestIcons(manifestUrl: URL, requestedTarget: URL, source: string, deadline: number): Promise<Candidate[]> {
    if (!isSafePublicTarget(manifestUrl)) return [];
    const response = await this.forwardFollowingRedirects(manifestUrl.href, "text", "application/manifest+json", deadline);
    if (!response || response.status < 200 || response.status >= 300 || !response.body || isAuthenticationRedirect(requestedTarget, response.url)) return [];
    try {
      const manifest = JSON.parse(response.body) as { icons?: Array<{ src?: string; purpose?: string }> };
      const base = response.url ?? manifestUrl.href;
      return (manifest.icons ?? []).flatMap((icon) => {
        if (!icon.src || icon.purpose?.includes("monochrome")) return [];
        try {
          const url = new URL(icon.src, base);
          return isSafePublicTarget(url) ? [{ url: url.href, source: `${source} · web app manifest` }] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private async tryDownload(
    candidate: Candidate,
    deadline: number,
  ): Promise<DownloadOutcome> {
    let response: ForwardResponse | null;
    try {
      response = await this.forwardFollowingRedirects(candidate.url, "base64", "application/octet-stream", deadline);
    } catch (error) {
      const outcome: DownloadOutcome =
        error instanceof ResolutionError && error.category === "timeout"
          ? { kind: "timeout" }
          : { kind: "network" };
      return outcome;
    }
    let outcome: DownloadOutcome;
    if (!response || response.status < 200 || response.status >= 300 || !response.body || isAuthenticationRedirect(new URL(candidate.url), response.url)) {
      outcome = { kind: "failed" };
    } else if (!isWellFormedBase64(response.body)) {
      outcome = { kind: "invalid" };
    } else {
      const decoded = Buffer.from(response.body, "base64");
      if (!decoded.length || decoded.length > MAX_ICON_BYTES || !isImagePayload(decoded, response.contentType)) {
        outcome = { kind: "failed" };
      } else {
        outcome = {
          kind: "resolved",
          resolved: {
            bytes: decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength),
            contentType: imageContentType(decoded, response.contentType),
            source: candidate.source,
          },
        };
      }
    }
    return outcome;
  }

  /**
   * Runs one Forward-proxy request without exceeding the resolution deadline.
   * The proxy's own timeout still bounds the request, but a strict race keeps
   * the total per-task budget predictable when the proxy stalls.
   */
  private forwardBounded(url: string, responseEncoding: "text" | "base64", contentType: string, deadline: number) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new ResolutionError("timeout"));
    const call = this.forward(url, responseEncoding, contentType, Math.min(5000, remaining));
    if (!Number.isFinite(deadline)) return call;
    return new Promise<ForwardResponse | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ResolutionError("timeout")), remaining);
      timer.unref?.();
      Promise.resolve(call).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async forwardFollowingRedirects(url: string, responseEncoding: "text" | "base64", contentType: string, deadline: number) {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return null;
    }
    if (!isSafePublicTarget(current)) return null;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await this.forwardBounded(current.href, responseEncoding, contentType, deadline);
      if (!response) return null;
      if (!isRedirect(response.status)) return { ...response, url: current.href };
      if (redirects === MAX_REDIRECTS) return null;

      const location = responseHeader(response.headers, "location");
      if (!location) return null;
      try {
        const next = new URL(location, current);
        if (!isSafePublicTarget(next) || isAuthenticationTarget(next)) return null;
        current = next;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async download(candidate: Candidate): Promise<ResolvedIcon | null> {
    const response = await this.forwardFollowingRedirects(candidate.url, "base64", "application/octet-stream", Date.now() + 5000);
    if (!response || response.status < 200 || response.status >= 300 || !response.body || isAuthenticationRedirect(new URL(candidate.url), response.url)) return null;
    if (!isWellFormedBase64(response.body)) return null;
    const bytes = Buffer.from(response.body, "base64");
    if (!bytes.length || bytes.length > MAX_ICON_BYTES || !isImagePayload(bytes, response.contentType)) return null;
    return {
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      contentType: imageContentType(bytes, response.contentType),
      source: candidate.source,
    };
  }

  private monogram(domain: string): ResolvedIcon {
    const policy = this.policy();
    const svg = monogramSvg({
      domain,
      colorMode: policy.monogramColorMode,
      primary: policy.monogramPrimary,
      secondary: policy.monogramSecondary,
      text: policy.monogramText,
      shape: policy.monogramShape,
      overrides: policy.monogramOverrides,
    });
    const bytes = Buffer.from(svg, "utf8");
    return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), contentType: "image/svg+xml", source: "generated monogram" };
  }
}

function providerCandidates(domain: string, policy: KernelResolverPolicy, sourcePrefix = ""): Candidate[] {
  if (policy.resolverMode === "direct") return [];
  const encoded = encodeURIComponent(domain);
  const provider = (preset: Exclude<KernelResolverPolicy["providerPreset"], "auto">) => {
    if (preset === "faviconkit") return `https://ico.faviconkit.net/favicon/${encoded}?sz=64`;
    if (preset === "faviconim") return `https://favicon.im/${encoded}?larger=true&throw-error-on-404=true`;
    if (preset === "iconhorse") return `https://icon.horse/icon/${encoded}`;
    const template = policy.provider.trim();
    return template.includes("{domain}") ? template.replaceAll("{domain}", encoded) : `${template.replace(/\/$/, "")}/${encoded}`;
  };
  const result: Candidate[] = policy.providerPreset === "auto"
    ? [{ url: provider("faviconkit"), source: `${sourcePrefix}FaviconKit` }, { url: provider("faviconim"), source: `${sourcePrefix}favicon.im` }]
    : [{ url: provider(policy.providerPreset), source: `${sourcePrefix}${policy.providerPreset === "custom" ? "custom favicon service" : policy.providerPreset}` }];
  if (policy.resolverMode === "global") result.push(
    { url: `https://www.google.com/s2/favicons?domain=${encoded}&sz=64`, source: `${sourcePrefix}Google domain favicon` },
    { url: `https://icons.duckduckgo.com/ip3/${encoded}.ico`, source: `${sourcePrefix}DuckDuckGo favicon` },
  );
  return result;
}

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function responseHeader(headers: ForwardResponse["headers"], name: string) {
  if (!headers) return undefined;
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function attributesFor(tag: string) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? ""]));
}

function isImagePayload(bytes: Buffer, contentType?: string) {
  const normalized = contentType?.split(";", 1)[0].toLowerCase();
  if (normalized?.startsWith("image/")) return true;
  return bytes.subarray(0, 4).toString("hex") === "89504e47" || bytes.subarray(0, 3).toString("hex") === "ffd8ff" || bytes.subarray(0, 4).toString("ascii") === "GIF8" || bytes.subarray(0, 4).toString("ascii") === "<svg";
}

function isWellFormedBase64(value: string) {
  const withoutPadding = value.replace(/=+$/, "");
  if (value.length - withoutPadding.length > 2 || withoutPadding.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/]+$/.test(withoutPadding);
}

function imageContentType(bytes: Buffer, contentType?: string) {
  const normalized = contentType?.split(";", 1)[0].toLowerCase();
  if (normalized?.startsWith("image/")) return normalized;
  if (bytes.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return "image/svg+xml";
}
