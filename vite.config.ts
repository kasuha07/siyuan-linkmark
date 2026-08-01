import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "plugin.json", dest: "." },
        { src: "README*.md", dest: "." },
        { src: "i18n", dest: "." },
        { src: "LICENSE", dest: "." },
        { src: "THIRD_PARTY_NOTICES.md", dest: "." },
        { src: "icon.png", dest: "." },
        { src: "preview.png", dest: "." },
        { src: "icon-picker.png", dest: "." },
      ],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["cjs"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["siyuan"],
      output: {
        inlineDynamicImports: true,
        entryFileNames: "index.js",
        assetFileNames: (asset) => asset.name === "style.css" ? "index.css" : "[name][extname]",
      },
    },
  },
});
