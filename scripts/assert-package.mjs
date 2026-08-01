import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve("dist");
const requiredFiles = ["index.js", "kernel.js", "plugin.json"];

for (const file of requiredFiles) {
  await access(resolve(dist, file));
}

const plugin = JSON.parse(await readFile(resolve(dist, "plugin.json"), "utf8"));
const expectedFrontends = ["desktop", "mobile", "browser-desktop", "browser-mobile"];

if (!Array.isArray(plugin.kernels) || !plugin.kernels.includes("all")) {
  throw new Error("Marketplace payload must declare kernels: [all]");
}
if (JSON.stringify(plugin.frontends) !== JSON.stringify(expectedFrontends)) {
  throw new Error("Marketplace payload must declare every supported frontend");
}
