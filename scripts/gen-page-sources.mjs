#!/usr/bin/env node
// 生成页面注入用的运行时源码（避免手写第二份 PoW 实现）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BT = String.fromCharCode(96); // 反引号

const tmp = mkdtempSync(join(tmpdir(), "dsh-cw-gen-"));
try {
  execFileSync(process.execPath, [
    join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    join(ROOT, "src", "pow", "sha3.ts"),
    join(ROOT, "src", "pow", "solve.ts"),
    "--outDir", tmp,
    "--target", "ES2022",
    "--module", "ES2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
    "--rootDir", join(ROOT, "src", "pow"),
  ], { cwd: ROOT, stdio: "pipe" });

  const strip = (src) => src
    .replace(/^\s*import[^;]+;\s*$/gmu, "")
    .replace(/^export\s+/gmu, "")
    .replace(/\/\/# sourceMappingURL=.*$/gmu, "");

  const sha = strip(readFileSync(join(tmp, "sha3.js"), "utf8"));
  const solve = strip(readFileSync(join(tmp, "solve.js"), "utf8"));
  const pageTurn = readFileSync(join(ROOT, "src", "wire", "page-turn.js"), "utf8").trim();

  const powRuntime = [
    "globalThis.__POW__ = (() => {",
    sha.trim(),
    solve.trim(),
    "  return { buildPowConfig, solveRequirementsToken, solveProofToken, newId: () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) };",
    "})();",
  ].join("\n");

  const out = [
    "/**",
    " * 由 scripts/gen-page-sources.mjs 自动生成，请勿手改。",
    " * 重新生成：node scripts/gen-page-sources.mjs",
    " */",
    "",
    "export const PAGE_POW_SOURCE: string = String.raw" + BT,
    powRuntime,
    BT + ";",
    "",
    "export const PAGE_TURN_SOURCE: string = String.raw" + BT,
    pageTurn,
    BT + ";",
    "",
  ].join("\n");

  writeFileSync(join(ROOT, "src", "wire", "page-sources.ts"), out, "utf8");
  console.log("generated src/wire/page-sources.ts (" + out.length + " chars)");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}