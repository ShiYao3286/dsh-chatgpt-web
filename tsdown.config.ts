import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    outDir: "lib",
    format: "esm",
    target: "node22",
    platform: "node",
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: [/^node:/, /^@deepseek-ai\//] },
  },
  {
    entry: { client: "src/client/index.ts" },
    outDir: "lib",
    format: "esm",
    target: "es2022",
    platform: "browser",
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: ["react", "react/jsx-runtime", /^@deepseek-ai\//] },
  },
]);
