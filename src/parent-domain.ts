import { parse } from "tldts-experimental";

/**
 * The stable error identity returned by the Cache authority for every pin
 * entry point that requests an invalid shared pin. The request fails
 * explicitly; it is never downgraded to an exact-domain pin.
 */
export const INVALID_SHARE_DOMAIN = "invalid-share-domain";

export class InvalidShareDomainError extends Error {
  constructor() {
    super(INVALID_SHARE_DOMAIN);
    this.name = "InvalidShareDomainError";
  }
}

export type ShareIneligibilityReason =
  | "ip-address"
  | "special-use"
  | "malformed"
  | "public-suffix"
  | "no-registrable-domain"
  | "private-suffix-family"
  | "reviewed-exclusion";

export type ShareEligibility =
  | { eligible: true; shareDomain: string }
  | { eligible: false; reason: ShareIneligibilityReason };

export type PickerScopeChoice =
  | { kind: "type" }
  | { kind: "domain" }
  | { kind: "subdomains"; shareDomain: string };

/**
 * tldts-experimental is the sole PSL parser: every calculation includes the
 * ICANN and Private sections plus special-use and IP detection, so eTLD+1
 * results are reproducible from the release-bundled list. No runtime
 * suffix-list request is ever made. It ships the tldts API over a compact
 * probabilistic rule set (see the package README), traded for a smaller
 * bundle; the domain semantics exercised here are identical to the full
 * tldts package. `detectSpecialUse` exposes the IANA Special-Use Domain
 * Names registry verdict (RFC 6761/6762/7686/8375/9476 and successors) as
 * `isSpecialUse`, covering each listed name and all of its sub-domains.
 */
const TLDTS_OPTIONS = {
  allowPrivateDomains: true,
  detectIp: true,
  detectSpecialUse: true,
  extractHostname: false,
  mixedInputs: false,
  validateHostname: true,
};

/**
 * The reviewed Shared-pin exclusion table. Each entry is an eTLD+1 boundary
 * containing a Linkmark-recognized multi-tenant platform host pattern; an
 * includeSubdomains pin is never offered or accepted inside these boundaries.
 * The table has no user override and is not a general website blacklist;
 * every future entry must document its source host range and carry
 * regression coverage.
 */
export const SHARED_PIN_EXCLUSIONS: ReadonlyArray<{
  boundary: string;
  platforms: readonly string[];
  provenance: string;
}> = [
  {
    boundary: "qq.com",
    platforms: ["tencent-docs"],
    provenance: "Covers the eTLD+1 boundary containing the Linkmark-recognized Tencent Docs host docs.qq.com.",
  },
  {
    boundary: "google.com",
    platforms: ["google-docs"],
    provenance: "Covers the eTLD+1 boundary containing the Linkmark-recognized Google Docs host docs.google.com.",
  },
  {
    boundary: "feishu.cn",
    platforms: ["feishu"],
    provenance: "Covers the eTLD+1 boundary containing the Linkmark-recognized Feishu hosts feishu.cn and *.feishu.cn.",
  },
  {
    boundary: "larksuite.com",
    platforms: ["lark"],
    provenance: "Covers the eTLD+1 boundary containing the Linkmark-recognized Lark hosts larksuite.com and *.larksuite.com.",
  },
  {
    boundary: "nocode.host",
    platforms: ["nocode-host"],
    provenance: "Covers the eTLD+1 boundary containing every Linkmark-recognized NoCode deployment route on nocode.host.",
  },
];

const EXCLUDED_BOUNDARIES = new Set(SHARED_PIN_EXCLUSIONS.map((entry) => entry.boundary));
const HOST_CLASSIFICATION_CACHE_LIMIT = 1_024;

/**
 * The shared domain-scope classification. It normalizes the hostname
 * (lowercase, punycode), rejects IP literals, special-use names, malformed
 * values, bare public suffixes, and values without a registrable domain, and
 * derives the eTLD+1 from the bundled PSL data. A hostname may have a
 * registrable eTLD+1 without being Share eligible (Private-suffix families
 * and reviewed exclusions restrict sharing, never probing).
 */
type HostClassification =
  | { kind: "eligible"; normalized: string; registrable: string }
  | { kind: "ineligible-share"; normalized: string; registrable: string; reason: "private-suffix-family" | "reviewed-exclusion" }
  | { kind: "invalid"; normalized: string; reason: "ip-address" | "special-use" | "malformed" | "public-suffix" | "no-registrable-domain" };

const hostClassifications = new Map<string, HostClassification>();

/**
 * The single PSL-derived eTLD+1 of a hostname, in normalized form, or null
 * when the hostname has no registrable domain (IP literal, special-use name,
 * malformed value, bare public suffix). This is the only host a shared pin
 * could target and the only parent a resolver may probe; Share eligibility
 * decides whether sharing is actually permitted.
 */
export function shareDomainFor(hostname: string): string | null {
  const classified = classifyHostname(hostname);
  return classified.kind === "invalid" ? null : classified.registrable;
}

/**
 * The sole Registrable parent: the eTLD+1 of the hostname only when it
 * differs from the hostname itself. Linkmark never walks an intermediate
 * parent chain and never returns a public suffix. Parent probing is bounded
 * by this one hostname even when sharing would be ineligible, so a tenant
 * beneath a PSL Private suffix is probed only at its own eTLD+1 and never at
 * the provider suffix.
 */
export function parentDomainOf(hostname: string): string | undefined {
  const classified = classifyHostname(hostname);
  if (classified.kind === "invalid" || classified.registrable === classified.normalized) return undefined;
  return classified.registrable;
}

/**
 * Whether a scope is Share eligible and, when it is, the exact eTLD+1 target
 * an includeSubdomains pin would apply to. Eligibility depends only on the
 * eTLD+1 boundary: the target must not be a public suffix, must not belong to
 * a PSL Private-suffix family, and must not match a reviewed exclusion.
 */
export function shareEligibilityOf(hostname: string): ShareEligibility {
  const classified = classifyHostname(hostname);
  if (classified.kind === "eligible") return { eligible: true, shareDomain: classified.registrable };
  return { eligible: false, reason: classified.reason };
}

/**
 * Whether the hostname itself is a valid includeSubdomains pin target: it is
 * exactly a non-public-suffix eTLD+1, outside every PSL Private-suffix
 * family, and outside every reviewed Shared-pin exclusion. The Cache
 * authority enforces this for every pin entry point.
 */
export function isEligibleShareTarget(hostname: string): boolean {
  const classified = classifyHostname(hostname);
  return classified.kind === "eligible" && classified.registrable === classified.normalized;
}

/**
 * The scope choices the icon picker may offer for a selected Link scope.
 * Current Type is offered for route scopes, Current Domain always, and the
 * broader Parent Domain / Subdomains choice only when an eligible Registrable
 * parent exists. Ineligible Private-suffix tenants such as `foo.github.io`
 * keep the exact choices and never expose the shared choice.
 */
export function pickerScopeChoices(scope: { domain: string; routeKey?: string }): PickerScopeChoice[] {
  const choices: PickerScopeChoice[] = [];
  if (scope.routeKey) choices.push({ kind: "type" });
  choices.push({ kind: "domain" });
  const parent = parentDomainOf(scope.domain);
  if (parent && isEligibleShareTarget(parent)) choices.push({ kind: "subdomains", shareDomain: parent });
  return choices;
}

function classifyHostname(hostname: string): HostClassification {
  const cached = hostClassifications.get(hostname);
  if (cached) {
    hostClassifications.delete(hostname);
    hostClassifications.set(hostname, cached);
    return cached;
  }
  const classified = classifyHostnameUncached(hostname);
  hostClassifications.set(hostname, classified);
  if (hostClassifications.size > HOST_CLASSIFICATION_CACHE_LIMIT) {
    const leastRecent = hostClassifications.keys().next().value;
    if (leastRecent !== undefined) hostClassifications.delete(leastRecent);
  }
  return classified;
}

function classifyHostnameUncached(hostname: string): HostClassification {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return { kind: "invalid", normalized: hostname.trim().toLowerCase(), reason: "malformed" };
  const parsed = parse(normalized, TLDTS_OPTIONS);
  if (parsed.isIp) return { kind: "invalid", normalized, reason: "ip-address" };
  // The tldts special-use signal is the IANA registry verdict: `foo.onion`,
  // `x.home.arpa`, `foo.alt`, `example.com`, and every other listed name or
  // sub-domain has no internet registrable domain, so it never acquires a
  // parent or shared-pin scope.
  if (parsed.isSpecialUse) return { kind: "invalid", normalized, reason: "special-use" };
  const suffix = parsed.publicSuffix ?? "";
  const registrable = parsed.domain;
  if (!registrable) {
    return suffix === normalized
      ? { kind: "invalid", normalized, reason: "public-suffix" }
      : { kind: "invalid", normalized, reason: "no-registrable-domain" };
  }
  if (parsed.isPrivate) return { kind: "ineligible-share", normalized, registrable, reason: "private-suffix-family" };
  if (EXCLUDED_BOUNDARIES.has(registrable)) return { kind: "ineligible-share", normalized, registrable, reason: "reviewed-exclusion" };
  return { kind: "eligible", normalized, registrable };
}

/**
 * Normalizes a hostname to lowercase ASCII (punycode) form and rejects
 * values that can never name a registrable domain: ports, userinfo, path or
 * query syntax, empty labels, underscore or percent labels, and label forms
 * that URL parsing cannot represent. tldts is intentionally lenient, so the
 * label validation here is the malformed-input authority.
 */
function normalizeHostname(hostname: string): string | null {
  const value = hostname.trim().toLowerCase();
  if (!value || value.length > 253) return null;
  if (value.includes("@") || value.includes("/") || value.includes("?") || value.includes("#")
    || value.includes("%") || /\s/.test(value)) return null;
  if (value.includes(":")) {
    // Only IPv6 literals may carry colons; any other colon-bearing value is
    // a port or otherwise malformed for domain-scope purposes.
    if (!/^\[?[0-9a-f:.]+\]?$/.test(value)) return null;
  }
  let url: URL;
  try {
    url = new URL(`https://${value}/`);
  } catch {
    return null;
  }
  const ascii = url.hostname;
  if (!ascii || ascii.length > 253) return null;
  // Bracketed IPv6 literals are label-hostile but valid; tldts classifies
  // them as IP literals.
  if (ascii.startsWith("[")) return ascii;
  if (!validLabels(ascii)) return null;
  return ascii;
}

function validLabels(hostname: string) {
  const labels = hostname.split(".");
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/.test(label)
    && !label.startsWith("-")
    && !label.endsWith("-")
  ));
}
