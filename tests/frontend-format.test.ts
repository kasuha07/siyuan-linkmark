import { describe, expect, it } from "vitest";
import {
  base64ToBlob,
  blobToBase64,
  errorText,
  formatFileSize,
  iconFormat,
  normalizeDomainInput,
} from "../src/frontend-format";

describe("iconFormat", () => {
  it("maps known image types and falls back to the label", () => {
    expect(iconFormat(new Blob([], { type: "image/png" }), "unknown")).toBe("PNG");
    expect(iconFormat(new Blob([], { type: "image/svg+xml" }), "unknown")).toBe("SVG");
    expect(iconFormat(new Blob([], { type: "image/x-icon" }), "unknown")).toBe("ICO");
    expect(iconFormat(new Blob([], { type: "image/webp" }), "unknown")).toBe("WEBP");
    expect(iconFormat(new Blob([], { type: "image/vnd.microsoft.icon" }), "unknown")).toBe("ICO");
  });

  it("is case-insensitive and uses the caller-provided label for unknown types", () => {
    expect(iconFormat(new Blob([], { type: "IMAGE/PNG" }), "unknown")).toBe("PNG");
    expect(iconFormat(new Blob([], { type: "image/jpeg" }), "unknown")).toBe("JPEG");
    expect(iconFormat(new Blob([], { type: "" }), "未知格式")).toBe("未知格式");
    expect(iconFormat(new Blob([], { type: "application/pdf" }), "unknown")).toBe("APPLICATION/PDF");
  });
});

describe("formatFileSize", () => {
  it("formats byte counts below one KB and rounds above", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(10_240)).toBe("10 KB");
    expect(formatFileSize(2_000_000)).toBe("1953 KB");
  });
});

describe("base64 round trip", () => {
  it("converts a blob to base64 and back without losing bytes", async () => {
    const original = new Blob(["linkmark"], { type: "text/plain" });
    const encoded = await blobToBase64(original);
    expect(encoded).toBe("bGlua21hcms=");
    const restored = base64ToBlob(encoded, "text/plain");
    expect(restored.type).toBe("text/plain");
    expect(await restored.text()).toBe("linkmark");
  });
});

describe("errorText", () => {
  it("prefers the error message and falls back to serialized values", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ code: 7 })).toBe('{"code":7}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorText(circular)).toBe("[object Object]");
  });
});

describe("normalizeDomainInput", () => {
  it("normalizes hostnames with or without a scheme", () => {
    expect(normalizeDomainInput("Example.COM ")).toBe("example.com");
    expect(normalizeDomainInput("https://docs.qq.com/doc")).toBe("docs.qq.com");
    expect(normalizeDomainInput("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeDomainInput("localhost")).toBe("localhost");
  });

  it("rejects empty and unparseable input", () => {
    expect(normalizeDomainInput("   ")).toBeNull();
    expect(normalizeDomainInput("not a url")).toBeNull();
    expect(normalizeDomainInput("")).toBeNull();
  });
});
