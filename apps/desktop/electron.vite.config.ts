import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

const alias = {
  "@shared": resolve(import.meta.dirname, "src/shared"),
  // The desktop bundles the core from source, so the packaged app needs no node_modules.
  "@specix/core/demo": resolve(import.meta.dirname, "../../packages/core/src/demo.ts"),
  "@specix/core": resolve(import.meta.dirname, "../../packages/core/src/index.ts"),
};

export default defineConfig({
  main: {
    resolve: { alias },
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        // The language host is a second entry: main forks it as a utilityProcess.
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          host: resolve(import.meta.dirname, "src/host/index.ts"),
        },
        external: ["electron", /^node:/],
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      // Sandboxed preloads must be a single CommonJS file with no node_modules imports.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
        external: ["electron"],
      },
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
  },
});
