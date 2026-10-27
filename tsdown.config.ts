import { defineConfig } from "tsdown";
import ts from 'typescript';

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    plugins: [{
      name: 'standard-remote-decorators',
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('/src/status.ts')) return;
        return { code: ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, map: null };
      },
    }],
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
    format: "cjs",
    target: "es2022",
    platform: "browser",
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: ["react", "react/jsx-runtime", /^@deepseek-ai\//] },
  },
]);
