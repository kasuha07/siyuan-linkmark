import { describe, expect, it } from "vitest";
import { monogramSvg, type MonogramSource } from "../src/monogram";

const defaultSource: MonogramSource = {
  domain: "example.com",
  colorMode: "domain",
  primary: "#4F7CFF",
  secondary: "#745CFF",
  text: "#FFFFFF",
  shape: "rounded",
  overrides: {},
};

describe("monogramSvg", () => {
  it("derives the letter from the first alphanumeric of the domain", () => {
    expect(monogramSvg({ ...defaultSource, domain: "docs.example.com" })).toContain('fill="#FFFFFF">D</text>');
    expect(monogramSvg({ ...defaultSource, domain: "www.example.org" })).toContain('fill="#FFFFFF">E</text>');
    expect(monogramSvg({ ...defaultSource, domain: "42.example.com" })).toContain('fill="#FFFFFF">4</text>');
  });

  it("falls back to a question mark when the domain has no alphanumeric", () => {
    expect(monogramSvg({ ...defaultSource, domain: "---" })).toContain('fill="#FFFFFF">?</text>');
  });

  it("produces byte-identical SVG for the default domain style", () => {
    expect(monogramSvg(defaultSource)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
      + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(99 72% 58%)"/><stop offset="1" stop-color="hsl(127 68% 42%)"/></linearGradient></defs>'
      + '<rect width="64" height="64" rx="14" fill="url(#g)"/>'
      + '<text x="32" y="43" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#FFFFFF">E</text></svg>',
    );
  });

  it("is deterministic for a given domain", () => {
    expect(monogramSvg(defaultSource)).toBe(monogramSvg(defaultSource));
  });

  it("derives a different hue for a different domain", () => {
    const first = monogramSvg({ ...defaultSource, domain: "example.com" });
    const second = monogramSvg({ ...defaultSource, domain: "otherdomain.org" });
    expect(first).not.toBe(second);
  });

  it("uses custom colors verbatim (uppercased) and ignores the domain hue", () => {
    const svg = monogramSvg({
      ...defaultSource,
      colorMode: "custom",
      primary: "#111111",
      secondary: "#222222",
      text: "#333333",
      shape: "square",
    });
    expect(svg).toContain('<stop stop-color="#111111"/>');
    expect(svg).toContain('<stop offset="1" stop-color="#222222"/>');
    expect(svg).toContain('fill="#333333"');
    expect(svg).toContain('rx="4"');
    expect(svg).not.toContain("hsl(");
  });

  it("falls back to default colors for malformed custom colors", () => {
    const svg = monogramSvg({
      ...defaultSource,
      colorMode: "custom",
      primary: "not-a-color",
      secondary: "#222222",
      text: "#333333",
    });
    expect(svg).toContain('<stop stop-color="#4F7CFF"/>');
    expect(svg).toContain('<stop offset="1" stop-color="#222222"/>');
  });

  it("applies a per-domain override letter, colors, and shape", () => {
    const svg = monogramSvg({
      ...defaultSource,
      overrides: {
        "example.com": { letter: "X&Y", primary: "#a1b2c3", secondary: "#d4e5f6", text: "#010203", shape: "circle" },
      },
    });
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
      + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#A1B2C3"/><stop offset="1" stop-color="#D4E5F6"/></linearGradient></defs>'
      + '<circle cx="32" cy="32" r="32" fill="url(#g)"/>'
      + '<text x="32" y="43" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#010203">X</text></svg>',
    );
  });

  it("keeps the domain hue only for non-overridden domains", () => {
    const overridden = monogramSvg({
      ...defaultSource,
      overrides: { "example.com": { letter: "E", primary: "#123456", secondary: "#654321", text: "#FFFFFF", shape: "rounded" } },
    });
    expect(overridden).toContain('stop-color="#123456"');
    expect(overridden).not.toContain("hsl(");
  });

  it.each([
    ["rounded", 'rx="14"'],
    ["square", 'rx="4"'],
    ["circle", '<circle cx="32" cy="32" r="32" fill="url(#g)"/>'],
  ] as const)("renders the %s shape", (shape, expected) => {
    const svg = monogramSvg({ ...defaultSource, shape });
    expect(svg).toContain(expected);
  });

  it("escapes XML-significant characters in the letter", () => {
    const svg = monogramSvg({
      ...defaultSource,
      overrides: { "example.com": { letter: "<&", primary: "#000000", secondary: "#000000", text: "#000000", shape: "rounded" } },
    });
    expect(svg).toContain('fill="#000000">&lt;</text>');
  });

  it("ignores an override for a different domain", () => {
    const svg = monogramSvg({
      ...defaultSource,
      overrides: { "other.com": { letter: "Z", primary: "#000000", secondary: "#000000", text: "#000000", shape: "circle" } },
    });
    expect(svg).toContain('fill="#FFFFFF">E</text>');
    expect(svg).toContain("hsl(");
  });
});
