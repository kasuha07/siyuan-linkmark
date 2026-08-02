import { describe, expect, it } from "vitest";
import { createIconRule } from "../src/icon-rule";
import { scopeForUrl } from "../src/url-scope";

describe("createIconRule", () => {
  const domainScope = { key: "example.com", domain: "example.com" };
  const routeScope = scopeForUrl("https://docs.qq.com/doc/abc");

  it("targets every link element for https and http with the exact origin", () => {
    const rule = createIconRule(domainScope, "https://cdn.example.com/icon.png", 1);
    for (const selector of [
      ".protyle-wysiwyg span[data-type~='a'][data-href=\"https://example.com\"]::before",
      ".protyle-wysiwyg span[data-type~='a'][data-href^=\"https://example.com/\"]::before",
      ".protyle-wysiwyg span[data-type~='url'][data-href=\"https://example.com\"]::before",
      ".protyle-wysiwyg a[href=\"https://example.com\"]::before",
      ".b3-typography a[href=\"https://example.com\"]::before",
      ".b3-typography a[href^=\"http://example.com/\"]::before",
    ]) {
      expect(rule).toContain(selector);
    }
  });

  it("includes path, query, fragment, and port boundary prefixes on domain scopes", () => {
    const rule = createIconRule(domainScope, "icon.png", 1);
    expect(rule).toContain("[data-href^=\"https://example.com/\"]");
    expect(rule).toContain("[data-href^=\"https://example.com?\"]");
    expect(rule).toContain("[data-href^=\"https://example.com#\"]");
    expect(rule).toContain("[data-href^=\"https://example.com:\"]");
  });

  it("uses the route prefix as the exact match and drops the port boundary", () => {
    expect(routeScope?.routeKey).toBe("doc");
    const rule = createIconRule(routeScope!, "icon.png", 1);
    expect(rule).toContain("[data-href=\"https://docs.qq.com/doc\"]");
    expect(rule).toContain("[data-href^=\"https://docs.qq.com/doc/\"]");
    expect(rule).not.toContain("[data-href^=\"https://docs.qq.com/doc:\"]");
  });

  it("escapes angle brackets in the icon URL", () => {
    const rule = createIconRule(domainScope, "https://cdn.example.com/a<icon>.png", 1);
    expect(rule).toContain("url(\"https://cdn.example.com/a\\3c icon>.png\")");
  });

  it("embeds the display preference icon size in em units", () => {
    const rule = createIconRule(domainScope, "icon.png", 1.4);
    expect(rule).toContain("width: 1.4em;");
    expect(rule).toContain("height: 1.4em;");
  });
});
