import { describe, expect, it, vi } from "vitest";
import type { LinkScope } from "../src/cache-authority";
import { ForwardProxyIconResolver, type ForwardProxy, type KernelResolverPolicy } from "../src/kernel-resolver";
import { MAX_ICON_BYTES } from "../src/resolver-contract";
import { scopeForUrl } from "../src/url-scope";

const resolverPolicy: KernelResolverPolicy = {
  provider: "https://example.com/favicon/{domain}", providerPreset: "auto", resolverMode: "direct",
  fallbackMode: "none", allowFullPageDiscovery: false, monogramColorMode: "domain",
  monogramPrimary: "#4F7CFF", monogramSecondary: "#745CFF", monogramText: "#FFFFFF",
  monogramShape: "rounded", monogramOverrides: {},
};

const scope = (key = "example.com"): LinkScope => ({
  key,
  domain: "example.com",
  targetUrl: "https://example.com/",
});

const feishuScope = (overrides: Partial<LinkScope> = {}): LinkScope => ({
  key: "example.feishu.cn::docx",
  domain: "example.feishu.cn",
  targetUrl: "https://example.feishu.cn/docx/",
  routeKey: "docx",
  pathPrefix: "/docx",
  platformIconSvg: "<svg xmlns='http://www.w3.org/2000/svg'/>",
  platformIconSource: "platform type feishu:docx",
  ...overrides,
});

describe("ForwardProxyIconResolver platform icons", () => {
  it("resolves a Feishu route scope to its local platform SVG without any network retrieval", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    // The scope produced by the reviewed route mapping must carry a raw SVG.
    const discovered = scopeForUrl("https://example.feishu.cn/docx/abc");
    expect(discovered?.platformIconSvg?.startsWith("<svg")).toBe(true);
    expect(discovered?.platformIconUrl).toBeUndefined();
    const feishu: LinkScope = { ...discovered!, targetUrl: "https://example.feishu.cn/docx/abc" };

    await expect(resolver.resolve(feishu)).resolves.toMatchObject({
      contentType: "image/svg+xml",
      source: "platform type feishu:docx",
    });
    expect(forward).not.toHaveBeenCalled();
  });

  it("offers the local platform icon as the first candidate for Feishu routes", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    const candidates = await resolver.candidates(feishuScope());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      contentType: "image/svg+xml",
      source: "platform type feishu:docx",
    });
  });

  it("tries the hosted platform icon URL first for Tencent route scopes", async () => {
    const downloads: string[] = [];
    const forward = vi.fn<ForwardProxy>(async (url, encoding) => {
      downloads.push(url);
      if (encoding === "base64" && url.includes("tencent-docs")) {
        return { body: Buffer.from([1, 2, 3]).toString("base64"), contentType: "image/png", status: 200, url };
      }
      return null;
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    const discovered = scopeForUrl("https://docs.qq.com/doc/Abc123");
    expect(discovered?.platformIconUrl).toMatch(/^https:\/\//);
    const tencent: LinkScope = { ...discovered!, targetUrl: "https://docs.qq.com/doc/Abc123" };

    await expect(resolver.resolve(tencent)).resolves.toMatchObject({
      contentType: "image/png",
      source: "platform type tencent-docs:doc",
    });
    expect(downloads[0]).toBe(discovered?.platformIconUrl);
    expect(downloads).toHaveLength(1);
  });

  it("falls back to generic resolution when platformIconSvg is empty", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(feishuScope({ platformIconSvg: "" }))).rejects.toMatchObject({ category: "exhausted" });
    expect(forward).toHaveBeenCalledTimes(4);
  });

  it("treats an oversized local platform SVG as a failed candidate", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(feishuScope({ platformIconSvg: `<svg>${"x".repeat(MAX_ICON_BYTES)}</svg>` })))
      .rejects.toMatchObject({ category: "exhausted" });
  });

  it("rejects a local platform SVG that is not an SVG document", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(feishuScope({ platformIconSvg: "<script>alert(1)</script>" })))
      .rejects.toMatchObject({ category: "exhausted" });
  });

  it("rejects a non-HTTP(S) resolution target even with a local platform icon", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(feishuScope({ targetUrl: "data:image/png;base64,AA==" }))).resolves.toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it("keeps generic resolution unaffected when no platform icon fields are present", async () => {
    const forward = vi.fn<ForwardProxy>(async () => null);
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    await expect(resolver.resolve(scope())).rejects.toMatchObject({ category: "exhausted" });
    expect(forward).toHaveBeenCalledTimes(4);
  });

  it("skips HTML fallback payloads served at icon paths without throwing", async () => {
    // 静态站（如 S3/EdgeOne 托管）对不存在的 /favicon.ico 返回 200 + 首页
    // HTML；字节魔数检测必须跳过而非抛错，并继续后续候选。
    const html = "<!doctype html><html><body>fallback</body></html>";
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    const forward = vi.fn<ForwardProxy>(async (url) => {
      if (url.endsWith("/favicon.svg")) {
        return { body: Buffer.from(svg, "utf8").toString("base64"), contentType: "image/svg+xml", status: 200 };
      }
      return { body: Buffer.from(html, "utf8").toString("base64"), contentType: "text/html", status: 200 };
    });
    const resolver = new ForwardProxyIconResolver(forward, () => resolverPolicy);

    const candidates = await resolver.candidates(scope());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ contentType: "image/svg+xml", source: "root favicon.svg" });
  });
});
