import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const dist = resolve("dist");
const requiredFiles = [
  "index.js",
  "kernel.js",
  "plugin.json",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "THIRD_PARTY_NOTICES.md",
];
const expectedIdentity = {
  name: "siyuan-linkmark",
  author: "霞葉 (Kasuha)",
  url: "https://github.com/kasuha07/siyuan-linkmark",
};
const expectedDisplayName = {
  default: "Linkmark",
  en: "Linkmark",
  "zh-CN": "链接印记",
};
const expectedDescription = {
  default: "Automatically discovers, displays, and locally caches website icons for SiYuan links.",
  en: "Automatically discovers, displays, and locally caches website icons for SiYuan links.",
  "zh-CN": "自动为思源链接发现、显示并本地缓存网站图标。",
};

for (const file of requiredFiles) {
  await access(resolve(dist, file));
}

const sourcePackage = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const sourcePlugin = JSON.parse(await readFile(resolve("plugin.json"), "utf8"));
const plugin = JSON.parse(await readFile(resolve(dist, "plugin.json"), "utf8"));
const expectedFrontends = ["desktop", "mobile", "browser-desktop", "browser-mobile"];
const frontendBundle = await readFile(resolve(dist, "index.js"), "utf8");
const kernelBundle = await readFile(resolve(dist, "kernel.js"), "utf8");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not match the required Linkmark metadata`);
  }
}

for (const [field, value] of Object.entries(expectedIdentity)) {
  assertEqual(sourcePlugin[field], value, `plugin.json ${field}`);
}
assertDeepEqual(sourcePlugin.displayName, expectedDisplayName, "plugin.json displayName");
assertDeepEqual(sourcePlugin.description, expectedDescription, "plugin.json description");
assertEqual(sourcePackage.name, expectedIdentity.name, "package.json name");
assertEqual(sourcePackage.author, expectedIdentity.author, "package.json author");
assertEqual(sourcePackage.repository, expectedIdentity.url, "package.json repository");
assertEqual(sourcePackage.homepage, expectedIdentity.url, "package.json homepage");
assertEqual(sourcePackage.version, sourcePlugin.version, "package.json and plugin.json version");

for (const field of ["name", "author", "url", "version"]) {
  assertEqual(plugin[field], sourcePlugin[field], `dist/plugin.json ${field}`);
}
assertDeepEqual(plugin.displayName, sourcePlugin.displayName, "dist/plugin.json displayName");
assertDeepEqual(plugin.description, sourcePlugin.description, "dist/plugin.json description");
assertDeepEqual(plugin.readme, sourcePlugin.readme, "dist/plugin.json readme");

if (!Array.isArray(plugin.kernels) || !plugin.kernels.includes("all")) {
  throw new Error("Marketplace payload must declare kernels: [all]");
}
if (JSON.stringify(plugin.frontends) !== JSON.stringify(expectedFrontends)) {
  throw new Error("Marketplace payload must declare every supported frontend");
}
if (/link-icon|linkIconMode|preferDynamic/i.test(frontendBundle)) {
  throw new Error("Marketplace payload must not include retired Link Icon compatibility behavior");
}
if (/cache\.trace\.set|traceTitle/i.test(frontendBundle) || /cache\.trace\.set|resolution-trace/i.test(kernelBundle)) {
  throw new Error("Marketplace payload must not include the development-only resolution trace surface");
}
if (/frontendTraceTitle|frontendTraceDescription|perf-site-|cdn\.perf\.example\.dev/i.test(frontendBundle)) {
  throw new Error("Marketplace payload must not include the development-only frontend performance trace and fixture surface");
}
