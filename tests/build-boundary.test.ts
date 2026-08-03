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

describe("retired diagnostic build boundary", () => {
  it("omits trace controls, RPCs, logs, and runtime fixtures from every artifact", async () => {
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

      for (const frontend of [devFrontend, prodFrontend]) {
        expect(frontend).not.toContain("traceTitle");
        expect(frontend).not.toContain("frontendTraceTitle");
        expect(frontend).not.toContain("cache.trace.set");
        expect(frontend).not.toContain("perf-site-");
        expect(frontend).not.toContain("cdn.perf.example.dev");
      }
      for (const kernel of [devKernel, prodKernel]) {
        expect(kernel).not.toContain("cache.trace.set");
        expect(kernel).not.toContain("resolution-trace");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
