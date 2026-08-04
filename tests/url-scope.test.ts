import { describe, expect, it } from "vitest";
import { safePageDiscoveryUrl, scopeForUrl, scopeFromCacheKey, scopeMatchTarget } from "../src/url-scope";

describe("scopeForUrl", () => {
  it("returns a plain domain scope for ordinary links", () => {
    expect(scopeForUrl("https://example.com/path?q=1")).toEqual({ key: "example.com", domain: "example.com" });
    expect(scopeForUrl("http://example.com/")).toEqual({ key: "example.com", domain: "example.com" });
  });

  it("lowercases the domain", () => {
    expect(scopeForUrl("https://EXAMPLE.com/x")).toEqual({ key: "example.com", domain: "example.com" });
  });

  it("rejects non-HTTP protocols and unparseable values", () => {
    expect(scopeForUrl("ftp://example.com")).toBeNull();
    expect(scopeForUrl("file:///tmp/icon.png")).toBeNull();
    expect(scopeForUrl("not a url")).toBeNull();
    expect(scopeForUrl("")).toBeNull();
  });

  it("maps Tencent Docs route segments", () => {
    const scope = scopeForUrl("https://docs.qq.com/doc/Abc123");
    expect(scope).toMatchObject({
      key: "docs.qq.com::doc",
      domain: "docs.qq.com",
      routeKey: "doc",
      pathPrefix: "/doc",
      platform: "tencent-docs",
    });
    expect(scope?.platformIconUrl).toMatch(/^https:\/\//);
    expect(scope?.platformIconSource).toBe("platform type tencent-docs:doc");
    for (const segment of ["sheet", "slide", "form", "mind", "desktop"]) {
      expect(scopeForUrl(`https://docs.qq.com/${segment}/x`)?.routeKey).toBe(segment);
    }
  });

  it("ignores unknown Tencent Docs segments and empty paths", () => {
    expect(scopeForUrl("https://docs.qq.com/other/x")).toEqual({ key: "docs.qq.com", domain: "docs.qq.com" });
    expect(scopeForUrl("https://docs.qq.com/")).toEqual({ key: "docs.qq.com", domain: "docs.qq.com" });
  });

  it("lowercases the route segment", () => {
    expect(scopeForUrl("https://docs.qq.com/DOC/1")).toMatchObject({ key: "docs.qq.com::doc", routeKey: "doc" });
  });

  it("maps Google Docs route segments", () => {
    const expected: Record<string, string> = {
      document: "document",
      spreadsheets: "spreadsheets",
      presentation: "presentation",
      forms: "forms",
      drawings: "drawings",
    };
    for (const [segment, routeKey] of Object.entries(expected)) {
      expect(scopeForUrl(`https://docs.google.com/${segment}/x`)).toMatchObject({
        key: `docs.google.com::${routeKey}`,
        routeKey,
        platform: "google-docs",
      });
    }
    expect(scopeForUrl("https://docs.google.com/document/x")?.platformIconUrl).toMatch(/^https:\/\//);
    expect(scopeForUrl("https://docs.google.com/other/x")).toEqual({ key: "docs.google.com", domain: "docs.google.com" });
  });

  it("maps Feishu and Lark route segments", () => {
    for (const segment of ["docx", "docs", "sheets", "base", "slides", "mindnotes", "wiki"]) {
      expect(scopeForUrl(`https://example.feishu.cn/${segment}/x`)).toMatchObject({
        key: `example.feishu.cn::${segment}`,
        routeKey: segment,
        platform: "feishu",
        platformIconSource: `platform type feishu:${segment}`,
      });
      expect(scopeForUrl(`https://example.feishu.cn/${segment}/x`)?.platformIconSvg).toMatch(/^<svg/);
      expect(scopeForUrl(`https://example.feishu.cn/${segment}/x`)?.platformIconUrl).toBeUndefined();
      expect(scopeForUrl(`https://example.larksuite.com/${segment}/x`)).toMatchObject({ routeKey: segment });
    }
    expect(scopeForUrl("https://example.feishu.cn/docx/x")?.platformIconSvg).toContain("<title>feishu document</title>");
    expect(scopeForUrl("https://feishu.cn/docx/x")).toMatchObject({ key: "feishu.cn::docx", routeKey: "docx" });
    expect(scopeForUrl("https://example.feishu.cn/unknown/x")).toEqual({
      key: "example.feishu.cn",
      domain: "example.feishu.cn",
    });
  });

  it("maps six-character nocode.host deployment segments", () => {
    expect(scopeForUrl("https://nocode.host/abc123/x")).toEqual({
      key: "nocode.host::site-abc123",
      domain: "nocode.host",
      routeKey: "site-abc123",
      pathPrefix: "/abc123",
      platform: "nocode-host",
      discoverPage: true,
    });
  });

  it("rejects nocode.host segments outside the six-character pattern", () => {
    expect(scopeForUrl("https://nocode.host/abc12/x")).toEqual({ key: "nocode.host", domain: "nocode.host" });
    expect(scopeForUrl("https://nocode.host/abcdefg/x")).toEqual({ key: "nocode.host", domain: "nocode.host" });
    expect(scopeForUrl("https://nocode.host/")).toEqual({ key: "nocode.host", domain: "nocode.host" });
  });

  it("lowercases nocode.host deployment segments before matching", () => {
    expect(scopeForUrl("https://nocode.host/ABC123/x")).toMatchObject({ routeKey: "site-abc123" });
  });
});

describe("scopeFromCacheKey", () => {
  it("restores a plain domain scope from a bare key", () => {
    expect(scopeFromCacheKey("example.com")).toEqual({ key: "example.com", domain: "example.com" });
  });

  it("reconstructs a known route scope from its key", () => {
    const scope = scopeFromCacheKey("docs.qq.com::doc");
    expect(scope).toMatchObject({
      key: "docs.qq.com::doc",
      domain: "docs.qq.com",
      routeKey: "doc",
      pathPrefix: "/doc",
      platform: "tencent-docs",
    });
  });

  it("reconstructs a Feishu route scope with its local platform SVG", () => {
    const scope = scopeFromCacheKey("example.feishu.cn::docx", "example.feishu.cn", "/docx");
    expect(scope).toMatchObject({
      key: "example.feishu.cn::docx",
      domain: "example.feishu.cn",
      routeKey: "docx",
      pathPrefix: "/docx",
      platform: "feishu",
      platformIconSource: "platform type feishu:docx",
    });
    expect(scope.platformIconSvg).toMatch(/^<svg/);
  });

  it("falls back to a synthetic route scope for unknown routes", () => {
    expect(scopeFromCacheKey("example.com::custom")).toEqual({
      key: "example.com::custom",
      domain: "example.com",
      routeKey: "custom",
      pathPrefix: "/custom",
    });
  });

  it("prefers the domain and path hints over the key", () => {
    expect(scopeFromCacheKey("example.com::x", "docs.qq.com", "/doc")).toEqual({
      key: "example.com::x",
      domain: "docs.qq.com",
      routeKey: "x",
      pathPrefix: "/doc",
    });
  });

  it("lowercases the domain hint", () => {
    expect(scopeFromCacheKey("Example.com::x", "EXAMPLE.com")).toMatchObject({ domain: "example.com" });
  });
});

describe("scopeMatchTarget", () => {
  it("matches a domain scope against the bare origin", () => {
    expect(scopeMatchTarget({ key: "example.com", domain: "example.com" }, "https")).toEqual({
      exact: "https://example.com",
      boundaries: ["/", "?", "#", ":"],
    });
    expect(scopeMatchTarget({ key: "example.com", domain: "example.com" }, "http")).toEqual({
      exact: "http://example.com",
      boundaries: ["/", "?", "#", ":"],
    });
  });

  it("matches a route scope against its path prefix", () => {
    expect(scopeMatchTarget({ key: "docs.qq.com::doc", domain: "docs.qq.com", pathPrefix: "/doc" }, "https")).toEqual({
      exact: "https://docs.qq.com/doc",
      boundaries: ["/", "?", "#"],
    });
  });
});

describe("safePageDiscoveryUrl", () => {
  it("drops the query and fragment while keeping the path", () => {
    expect(safePageDiscoveryUrl("https://example.com/path?q=1#frag")).toBe("https://example.com/path");
  });

  it("keeps an empty path as the origin root", () => {
    expect(safePageDiscoveryUrl("https://example.com/?a=b")).toBe("https://example.com/");
    expect(safePageDiscoveryUrl("https://example.com")).toBe("https://example.com/");
  });
});
