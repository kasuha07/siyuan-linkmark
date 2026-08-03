import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");

function buildBothArtifacts(mode: string, outDir: string) {
  execFileSync(process.execPath, [
    viteBin, "build", "--mode", mode, "--outDir", outDir, "--emptyOutDir", "false",
  ], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, [
    viteBin, "build", "--mode", mode, "--outDir", outDir, "--emptyOutDir", "false", "--config", "vite.kernel.config.ts",
  ], { cwd: root, stdio: "pipe" });
}

describe("development build boundary", () => {
  it("includes the trace switches and fixture surface in development artifacts and omits them from production artifacts", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "linkmark-boundary-"));
    try {
      const dev = join(tmp, "dev");
      const prod = join(tmp, "prod");
      buildBothArtifacts("development", dev);
      buildBothArtifacts("production", prod);

      const devFrontend = await readFile(join(dev, "index.js"), "utf8");
      const devKernel = await readFile(join(dev, "kernel.js"), "utf8");
      const prodFrontend = await readFile(join(prod, "index.js"), "utf8");
      const prodKernel = await readFile(join(prod, "kernel.js"), "utf8");

      expect(devFrontend).toContain("traceTitle");
      expect(devFrontend).toContain("frontendTraceTitle");
      expect(devFrontend).toContain("cache.trace.set");
      expect(devFrontend).toContain("perf-site-");
      expect(devFrontend).toContain("cdn.perf.example.dev");
      expect(devKernel).toContain("cache.trace.set");
      expect(devKernel).toContain("resolution-trace");

      expect(prodFrontend).not.toContain("traceTitle");
      expect(prodFrontend).not.toContain("traceDescription");
      expect(prodFrontend).not.toContain("frontendTraceTitle");
      expect(prodFrontend).not.toContain("frontendTraceDescription");
      expect(prodFrontend).not.toContain("cache.trace.set");
      expect(prodFrontend).not.toContain("perf-site-");
      expect(prodFrontend).not.toContain("cdn.perf.example.dev");
      expect(prodKernel).not.toContain("cache.trace.set");
      expect(prodKernel).not.toContain("resolution-trace");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
