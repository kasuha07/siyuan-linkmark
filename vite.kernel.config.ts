import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
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
});
