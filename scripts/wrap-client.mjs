#!/usr/bin/env node
// 构建后处理：把 client 产物包装成 DSH 要求的 __ModuleLoader__ 懒 CJS 形态。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FILE = join(ROOT, "lib", "client.js");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
// Keep legacy explicit Chromium resource lookup self-contained in published lib.
mkdirSync(join(ROOT, "lib", "wire"), { recursive: true });
for (const file of ["page-pow.js", "page-turn.js"]) {
  copyFileSync(join(ROOT, "src", "wire", file), join(ROOT, "lib", "wire", file));
}

const src = readFileSync(FILE, "utf8");
const imports = [];
const exported = [];

let body = src.replace(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)"\s*;\s*$/gmu, function (_m, spec, mod) {
  imports.push({ spec: spec.trim(), mod: mod });
  return "";
});

body = body.replace(/^export\s*\{([^}]+)\}\s*;\s*$/gmu, function (_m, names) {
  const list = names.split(",");
  for (let i = 0; i < list.length; i++) {
    const p = list[i].trim().split(/\s+as\s+/u);
    const local = p[0].trim();
    const exposed = (p[1] || p[0]).trim();
    if (local.length > 0) exported.push([local, exposed]);
  }
  return "";
});

body = body.replace(/^export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gmu, function (_m, name) {
  exported.push([name, name]);
  return "const " + name;
});

const reqLines = [];
for (let i = 0; i < imports.length; i++) {
  const it = imports[i];
  const v = "m_" + it.mod.replace(/[^A-Za-z0-9]/gu, "_");
  if (it.spec.charAt(0) === "{") {
    const inner = it.spec.slice(1, -1).replace(/\s+as\s+/gu, ": ");
    reqLines.push("\t\tconst " + v + " = require(" + JSON.stringify(it.mod) + ");");
    reqLines.push("\t\tconst { " + inner + " } = " + v + ";");
  } else {
    const alias = it.spec.indexOf("* as ") === 0 ? it.spec.slice(5).trim() : it.spec;
    reqLines.push("\t\tconst " + alias + " = require(" + JSON.stringify(it.mod) + ");");
  }
}

const expLines = [];
for (let i = 0; i < exported.length; i++) {
  expLines.push("\t\texports." + exported[i][1] + " = " + exported[i][0] + ";");
}

const pieces = ["window.__ModuleLoader__.load({"];
pieces.push("\tid: " + JSON.stringify(PKG.name) + ",");
pieces.push("\tfactory: (require) => {");
pieces.push("\t\tvar module = { exports: {} };");
pieces.push("\t\tvar exports = module.exports;");
if (reqLines.length > 0) pieces.push(reqLines.join("\n"));
pieces.push(body.trim());
if (expLines.length > 0) pieces.push(expLines.join("\n"));
pieces.push("\t\treturn module.exports;");
pieces.push("\t},");
pieces.push("});");
pieces.push("");

const out = pieces.join("\n");
writeFileSync(FILE, out, "utf8");
console.log("wrapped lib/client.js: " + out.length + " chars, " + imports.length + " imports, " + exported.length + " exports");
