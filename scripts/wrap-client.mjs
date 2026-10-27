#!/usr/bin/env node
// Wrap compiler-produced CJS verbatim; never rewrite ESM with regex.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const input = new URL('lib/client.cjs', root);
const body = readFileSync(input, 'utf8');
writeFileSync(new URL('lib/client.js', root), `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nconst module = { exports: {} }; const exports = module.exports;\n${body}\nreturn module.exports;\n} });\n`);
unlinkSync(input);
mkdirSync(new URL('lib/wire/', root), { recursive: true });
for (const name of ['page-pow.js', 'page-turn.js']) copyFileSync(new URL('src/wire/' + name, root), new URL('lib/wire/' + name, root));
