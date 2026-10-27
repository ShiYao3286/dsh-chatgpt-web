import assert from 'node:assert/strict';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const llmDir = dirname(realpathSync(fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-llm/package.json', import.meta.url))));
export const hostRoot = process.env.DSH_OFFLINE_HOST_ROOT || dirname(llmDir);
export function manifest(name) { return JSON.parse(readFileSync(join(hostRoot, name, 'package.json'), 'utf8')); }
export function source(name, file = 'lib/index.js') { return readFileSync(join(hostRoot, name, file), 'utf8'); }
export function hostImport(name) { return import(pathToFileURL(join(hostRoot, name, 'lib/index.js')).href); }
for (const name of ['dsh-llm', 'dsh-app-boot', 'dsh-client-ui-settings', 'dsh-client-ui-plugin-manager', 'dsh-web-frontend']) {
  assert.equal(manifest(name).version, '0.2.1-rc.3', `${name}: target desktop required, old CLI is not evidence`);
}
assert.equal(manifest('schemastery').version, '3.18.5');
assert.equal(realpathSync(join(hostRoot, 'dsh-llm')), realpathSync(llmDir), 'tests and runtime dependency must use same target');
export function frontendSource() {
  const dir = join(hostRoot, 'dsh-web-frontend/dist/assets');
  for (const file of readdirSync(dir).filter(file => /^index-.*\.js$/.test(file))) {
    const text = readFileSync(join(dir, file), 'utf8');
    if (text.includes('SettingsFormModel:')) return text;
  }
  throw new Error('target frontend primitive asset not found');
}
