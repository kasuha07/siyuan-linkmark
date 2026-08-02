export type PlatformFamily = "tencent-docs" | "feishu" | "google-docs" | "nocode-host";

export type LinkScope = {
  key: string;
  domain: string;
  routeKey?: string;
  pathPrefix?: string;
  platform?: PlatformFamily;
  platformIconUrl?: string;
  platformIconSource?: string;
  discoverPage?: boolean;
};

type RouteDefinition = {
  routeKey: string;
  pathPrefix: string;
  iconUrl: string;
};

const TENCENT_ICON_ROOT =
  "https://docs.gtimg.com/docs-design-resources/document-management/tencent-docs/favicon";

const TENCENT_ROUTES: Record<string, RouteDefinition> = {
  doc: route("doc", "doc", `${TENCENT_ICON_ROOT}/application-vnd.tdocs-apps.doc.png`),
  sheet: route("sheet", "sheet", `${TENCENT_ICON_ROOT}/application-vnd.tdocs-apps.sheet.png`),
  slide: route("slide", "slide", `${TENCENT_ICON_ROOT}/application-vnd.tdocs-apps.slide.png`),
  form: route("form", "form", `${TENCENT_ICON_ROOT}/application-vnd.tdocs-apps.form.png`),
  mind: route("mind", "mind", `${TENCENT_ICON_ROOT}/application-vnd.tdocs-apps.mind.png`),
  desktop: route("desktop", "desktop", "https://docs.gtimg.com/desktop/favicon2.ico"),
};

const GOOGLE_ROUTES: Record<string, RouteDefinition> = {
  document: route("document", "document", "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico"),
  spreadsheets: route("spreadsheets", "spreadsheets", "https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico"),
  presentation: route("presentation", "presentation", "https://ssl.gstatic.com/docs/presentations/images/favicon5.ico"),
  forms: route("forms", "forms", "https://ssl.gstatic.com/docs/spreadsheets/forms/favicon_qp2.png"),
  drawings: route("drawings", "drawings", "https://ssl.gstatic.com/docs/drawings/images/favicon5.ico"),
};

const FEISHU_ROUTE_TYPES: Record<string, string> = {
  docx: "document",
  docs: "document",
  sheets: "spreadsheets",
  base: "base",
  slides: "presentation",
  mindnotes: "mind",
  wiki: "wiki",
};

const TYPE_COLORS: Record<string, [string, string]> = {
  document: ["#3370FF", "#245BDB"],
  spreadsheets: ["#00B578", "#009A68"],
  base: ["#7B67EE", "#5F48D8"],
  presentation: ["#FF8B3D", "#E66B20"],
  mind: ["#00A6A6", "#087F8C"],
  wiki: ["#4E83FD", "#6750D8"],
};

const TYPE_GLYPHS: Record<string, string> = {
  document: "D",
  spreadsheets: "S",
  base: "B",
  presentation: "P",
  mind: "M",
  wiki: "W",
};

export function scopeForUrl(value: string): LinkScope | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const domain = url.hostname.toLowerCase();
  const segment = firstPathSegment(url.pathname);

  if (domain === "docs.qq.com" && segment && TENCENT_ROUTES[segment]) {
    return routeScope(domain, "tencent-docs", TENCENT_ROUTES[segment]);
  }
  if (domain === "docs.google.com" && segment && GOOGLE_ROUTES[segment]) {
    return routeScope(domain, "google-docs", GOOGLE_ROUTES[segment]);
  }
  if (isFeishuDomain(domain) && segment && FEISHU_ROUTE_TYPES[segment]) {
    const type = FEISHU_ROUTE_TYPES[segment];
    const definition = route(segment, segment, platformTypeSvg("feishu", type));
    return routeScope(domain, "feishu", definition);
  }
  if (domain === "nocode.host" && isNoCodeDeploymentSegment(segment)) {
    return {
      key: `${domain}::site-${segment}`,
      domain,
      routeKey: `site-${segment}`,
      pathPrefix: `/${segment}`,
      platform: "nocode-host",
      discoverPage: true,
    };
  }
  return { key: domain, domain };
}

export function scopeFromCacheKey(key: string, domainHint?: string, pathPrefix?: string): LinkScope {
  const separator = key.indexOf("::");
  const domain = (domainHint ?? (separator >= 0 ? key.slice(0, separator) : key)).toLowerCase();
  if (separator < 0) return { key: domain, domain };
  const routeKey = key.slice(separator + 2);
  const synthetic = scopeForUrl(`https://${domain}${pathPrefix ?? `/${routeKey}/`}`);
  if (synthetic?.routeKey === routeKey) return synthetic;
  return { key, domain, routeKey, pathPrefix: pathPrefix ?? `/${routeKey}` };
}

export function safePageDiscoveryUrl(value: string) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
}

export function scopeMatchTarget(scope: LinkScope, protocol: "http" | "https") {
  const origin = `${protocol}://${scope.domain}`;
  if (scope.pathPrefix) {
    return { exact: origin + scope.pathPrefix, boundaries: ["/", "?", "#"] };
  }
  return { exact: origin, boundaries: ["/", "?", "#", ":"] };
}

function route(routeKey: string, pathPrefix: string, iconUrl: string): RouteDefinition {
  return { routeKey, pathPrefix: `/${pathPrefix}`, iconUrl };
}

function routeScope(domain: string, platform: PlatformFamily, definition: RouteDefinition): LinkScope {
  return {
    key: `${domain}::${definition.routeKey}`,
    domain,
    routeKey: definition.routeKey,
    pathPrefix: definition.pathPrefix,
    platform,
    platformIconUrl: definition.iconUrl,
    platformIconSource: `platform type ${platform}:${definition.routeKey}`,
  };
}

function firstPathSegment(pathname: string) {
  return pathname.split("/").find(Boolean)?.toLowerCase() ?? "";
}

function isFeishuDomain(domain: string) {
  return domain === "feishu.cn"
    || domain.endsWith(".feishu.cn")
    || domain === "larksuite.com"
    || domain.endsWith(".larksuite.com");
}

function isNoCodeDeploymentSegment(segment: string) {
  return /^[a-z0-9]{6}$/.test(segment);
}

function platformTypeSvg(platform: PlatformFamily, type: string) {
  const [primary, secondary] = TYPE_COLORS[type] ?? ["#3370FF", "#6750D8"];
  const glyph = TYPE_GLYPHS[type] ?? "F";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse"><stop stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient></defs>
  <rect x="6" y="4" width="52" height="56" rx="13" fill="url(#g)"/>
  <path d="M39 4v13a5 5 0 0 0 5 5h14" fill="#fff" fill-opacity=".26"/>
  <text x="32" y="44" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#fff">${glyph}</text>
  <title>${platform} ${type}</title>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
