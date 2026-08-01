import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  define: {
    __AUTO_FAVICON_DEBUG__: JSON.stringify(mode === "debug"),
  },
  build: {
    outDir: mode === "debug" ? "dist-debug" : "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/kernel.ts"),
      formats: ["es"],
      fileName: "kernel",
    },
    rollupOptions: {
      output: {
        entryFileNames: "kernel.js",
      },
    },
  },
}));
