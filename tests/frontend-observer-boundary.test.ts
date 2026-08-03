import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Link content observation boundary", () => {
  it("uses Protyle lifecycle events without document-wide edit observation", async () => {
    const source = await readFile(resolve(root, "src/index.ts"), "utf8");

    expect(source).toContain("loaded-protyle-static");
    expect(source).toContain("destroy-protyle");
    expect(source).toContain('STATIC_CONTAINER_SELECTOR = ".protyle-preview > .b3-typography"');
    expect(source).toContain("this.contentObservers.containers()");
    expect(source).toContain("if (!container.isConnected) return");
    expect(source).toContain("observer.observe(container, LINK_CONTENT_OBSERVER_OPTIONS)");
    expect(source).not.toContain("observer.observe(document.body");
    expect(source).not.toContain("document.querySelectorAll<HTMLElement>(createScopeQuery");
    expect(source).not.toContain("document.addEventListener(\"input\"");
    expect(source).not.toContain("characterData: true");
  });
});
