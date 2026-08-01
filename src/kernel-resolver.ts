import type { IconResolver, LinkScope, ResolvedIcon, ResolutionTrigger } from "./cache-authority";

export type KernelResolverPolicy = {
  provider: string;
  providerPreset: "auto" | "faviconkit" | "faviconim" | "iconhorse" | "custom";
  resolverMode: "mainland" | "global" | "direct";
  fallbackMode: "monogram" | "none";
  allowFullPageDiscovery: boolean;
  monogramColorMode: "domain" | "custom";
  monogramPrimary: string;
  monogramSecondary: string;
  monogramText: string;
  monogramShape: "rounded" | "circle" | "square";
  monogramOverrides: Record<string, { letter: string; primary: string; secondary: string; text: string; shape: "rounded" | "circle" | "square" }>;
};

export type ForwardResponse = { body: string; contentType?: string; status: number; url?: string };
export type ForwardProxy = (url: string, responseEncoding: "text" | "base64", contentType: string, timeout?: number) => Promise<ForwardResponse | null>;

type Candidate = { url: string; source: string };
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_AUTOMATIC_CANDIDATE_ATTEMPTS = 16;

export class ForwardProxyIconResolver implements IconResolver {
  constructor(private readonly forward: ForwardProxy, private readonly policy: () => KernelResolverPolicy) {}

  async resolve(scope: LinkScope, trigger: ResolutionTrigger = "automatic"): Promise<ResolvedIcon | null> {
    let target: URL;
    try {
      target = new URL(scope.targetUrl);
    } catch {
      return null;
    }
    if (!isSafePublicTarget(target)) return null;
    const candidates = await this.candidateUrls(target, scope, this.policy().allowFullPageDiscovery || Boolean(scope.discoverPage));
    const attempts = trigger === "automatic" ? candidates.slice(0, MAX_AUTOMATIC_CANDIDATE_ATTEMPTS) : candidates;
    for (const candidate of attempts) {
      const resolved = await this.download(candidate);
      if (resolved) return resolved;
    }
    return this.policy().fallbackMode === "monogram" ? this.monogram(target.hostname) : null;
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
    for (const candidate of await this.candidateUrls(target, scope, allowFullPageDiscovery)) {
      const resolved = await this.download(candidate);
      if (resolved) results.push(resolved);
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

  private async candidateUrls(target: URL, scope: LinkScope, allowFullPageDiscovery: boolean) {
    const policy = this.policy();
    const candidates: Candidate[] = [];
    if (allowFullPageDiscovery) candidates.push(...await this.discoverPageIcons(target, target, "page rel=icon"));
    if (scope.platformIconUrl) {
      try {
        const platformUrl = new URL(scope.platformIconUrl);
        if (isSafePublicTarget(platformUrl)) candidates.push({ url: platformUrl.href, source: scope.platformIconSource ?? "platform type icon" });
      } catch {
        // Ignore malformed reviewed route mappings.
      }
    }
    const root = new URL("/", target.origin);
    candidates.push(...await this.discoverPageIcons(root, target, "root rel=icon"));
    candidates.push(
      { url: new URL("/favicon.svg", target.origin).href, source: "root favicon.svg" },
      { url: new URL("/favicon.png", target.origin).href, source: "root favicon.png" },
      { url: new URL("/apple-touch-icon.png", target.origin).href, source: "root apple-touch-icon.png" },
      { url: new URL("/favicon.ico", target.origin).href, source: "root favicon.ico" },
    );
    const parentDomain = parentDomainOf(target.hostname);
    if (parentDomain) {
      const parent = new URL(`${target.protocol}//${parentDomain}/`);
      candidates.push(...await this.discoverPageIcons(parent, parent, `parent domain ${parentDomain} · rel=icon`));
      candidates.push(
        { url: new URL("/favicon.svg", parent).href, source: `parent domain ${parentDomain} · root favicon.svg` },
        { url: new URL("/favicon.png", parent).href, source: `parent domain ${parentDomain} · root favicon.png` },
        { url: new URL("/apple-touch-icon.png", parent).href, source: `parent domain ${parentDomain} · root apple-touch-icon.png` },
        { url: new URL("/favicon.ico", parent).href, source: `parent domain ${parentDomain} · root favicon.ico` },
      );
    }
    candidates.push(...providerCandidates(target.hostname.toLowerCase(), policy));
    if (parentDomain) candidates.push(...providerCandidates(parentDomain, policy, `parent domain ${parentDomain} · `));
    return [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
  }

  private async discoverPageIcons(target: URL, requestedTarget: URL, source: string): Promise<Candidate[]> {
    const page = await this.forward(target.href, "text", "text/html");
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
      return [...candidates, ...await this.discoverManifestIcons(manifestUrl, requestedTarget, source)];
    } catch {
      return candidates;
    }
  }

  private async discoverManifestIcons(manifestUrl: URL, requestedTarget: URL, source: string): Promise<Candidate[]> {
    if (!isSafePublicTarget(manifestUrl)) return [];
    const response = await this.forward(manifestUrl.href, "text", "application/manifest+json");
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

  private async download(candidate: Candidate): Promise<ResolvedIcon | null> {
    const response = await this.forward(candidate.url, "base64", "application/octet-stream", 5000);
    if (!response || response.status < 200 || response.status >= 300 || !response.body || isAuthenticationRedirect(new URL(candidate.url), response.url)) return null;
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
    const style = policy.monogramOverrides[domain] ?? {
      letter: domain.replace(/^www\./, "").match(/[a-z0-9]/i)?.[0] ?? "?",
      primary: policy.monogramPrimary,
      secondary: policy.monogramSecondary,
      text: policy.monogramText,
      shape: policy.monogramShape,
    };
    const letter = escapeXml(Array.from(style.letter.trim() || "?")[0].toUpperCase());
    let hash = 0;
    for (const character of domain) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    const primary = policy.monogramColorMode === "domain" && !policy.monogramOverrides[domain]
      ? `hsl(${hue} 72% 58%)`
      : safeColor(style.primary, "#4F7CFF");
    const secondary = policy.monogramColorMode === "domain" && !policy.monogramOverrides[domain]
      ? `hsl(${(hue + 28) % 360} 68% 42%)`
      : safeColor(style.secondary, "#745CFF");
    const text = safeColor(style.text, "#FFFFFF");
    const body = style.shape === "circle"
      ? '<circle cx="32" cy="32" r="32" fill="url(#g)"/>'
      : `<rect width="64" height="64" rx="${style.shape === "square" ? 4 : 14}" fill="url(#g)"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient></defs>${body}<text x="32" y="43" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="${text}">${letter}</text></svg>`;
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

function parentDomainOf(domain: string) {
  const labels = domain.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length < 3 || labels.some((label) => !label) || domain.includes(":")) return undefined;
  const parent = labels.slice(1);
  if (parent.length === 2 && parent[1].length === 2 && new Set(["ac", "co", "com", "edu", "gov", "net", "org"]).has(parent[0])) return undefined;
  return parent.join(".");
}

function attributesFor(tag: string) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? ""]));
}

function isAuthenticationRedirect(requested: URL, received?: string) {
  if (!received) return false;
  try {
    const finalUrl = new URL(received);
    if (finalUrl.href === requested.href) return false;
    const host = finalUrl.hostname.toLowerCase();
    const path = finalUrl.pathname.toLowerCase();
    return finalUrl.origin !== requested.origin
      || host.startsWith("accounts.")
      || host.startsWith("passport.")
      || host.startsWith("login.")
      || /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/.test(path);
  } catch {
    return true;
  }
}

function isSafePublicTarget(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::" || host === "::1" || /^(?:fc|fd|fe[89ab])(?:[0-9a-f])?:/i.test(host)) return false;
  const mappedIpv4 = mappedIpv4Address(host);
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);
  if (host.includes(":")) return true;
  return isPublicIpv4(host);
}

function mappedIpv4Address(host: string) {
  const value = host.match(/^::ffff:(.+)$/i)?.[1];
  if (!value) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value;
  const hexadecimal = value.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexadecimal) return undefined;
  const number = (parseInt(hexadecimal[1], 16) << 16) + parseInt(hexadecimal[2], 16);
  return [(number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join(".");
}

function isPublicIpv4(host: string) {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;
  const [a, b, c] = ipv4.slice(1).map(Number);
  if ([a, b, c].some((part) => part > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || b === 2)) || (a === 198 && (b === 18 || b === 19))
    || a >= 224);
}

function isImagePayload(bytes: Buffer, contentType?: string) {
  const normalized = contentType?.split(";", 1)[0].toLowerCase();
  if (normalized?.startsWith("image/")) return true;
  return bytes.subarray(0, 4).toString("hex") === "89504e47" || bytes.subarray(0, 3).toString("hex") === "ffd8ff" || bytes.subarray(0, 4).toString("ascii") === "GIF8" || bytes.subarray(0, 4).toString("ascii") === "<svg";
}

function imageContentType(bytes: Buffer, contentType?: string) {
  const normalized = contentType?.split(";", 1)[0].toLowerCase();
  if (normalized?.startsWith("image/")) return normalized;
  if (bytes.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return "image/svg+xml";
}

function safeColor(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
