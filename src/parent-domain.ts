const COMMON_SECOND_LEVEL_DOMAINS = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

export function parentDomainOf(domain: string) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return undefined;
  const labels = normalized.split(".");
  if (labels.length < 3 || labels.some((label) => !label)) return undefined;
  const parent = labels.slice(1);
  if (parent.length === 2 && parent[1].length === 2 && COMMON_SECOND_LEVEL_DOMAINS.has(parent[0])) return undefined;
  return parent.join(".");
}

export function shareDomainFor(domain: string) {
  if (domain.includes(":") || /^\d+(?:\.\d+){3}$/.test(domain)) return null;
  const stripped = domain.replace(/^www\./i, "");
  const labels = stripped.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return null;
  const parent = parentDomainOf(stripped);
  if (parent) return parent;
  return stripped;
}

function normalizeDomain(domain: string) {
  const normalized = domain.toLowerCase().replace(/^\[|\]$/g, "").replace(/^www\./, "");
  if (normalized.includes(":") || /^\d+(?:\.\d+){3}$/.test(normalized)) return undefined;
  return normalized;
}
