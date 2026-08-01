import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vite = resolve(root, "node_modules/vite/bin/vite.js");
const commands = [
  ["frontend", ["build", "--watch", "--mode", "development"]],
  ["kernel", ["build", "--watch", "--mode", "development", "--config", "vite.kernel.config.ts"]],
];

const children = commands.map(([name, args]) => {
  const child = spawn(process.execPath, [vite, ...args], { cwd: root, stdio: "inherit" });
  child.on("error", (error) => console.error(`[dev:${name}] failed to start`, error));
  return child;
});

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
};

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));

for (const [index, child] of children.entries()) {
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[dev:${commands[index][0]}] stopped (${signal ?? `exit ${code}`})`);
    stop("SIGTERM");
    process.exitCode = code && code !== 0 ? code : 1;
  });
}
