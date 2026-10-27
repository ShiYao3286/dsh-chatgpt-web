import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
assert.equal(pkg.dsh.client.platform, 'web');
assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
assert.equal(pkg.exports['./client'].default, './lib/client.js');
assert.ok(existsSync(new URL(pkg.exports['./client'].default, root)));
assert.ok(existsSync(new URL(pkg.main, root)));
// Execute the installed host's actual pure form model, without importing CSS/React or starting a host.
const hostRoot = process.env.DSH_OFFLINE_HOST_ROOT || 'C:/Users/32863/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const host = readFileSync(hostRoot + '/dsh-client-ui-primitives/lib/index.js', 'utf8');
const start = host.indexOf('function settingsNumberField(');
const end = host.indexOf('//#endregion', host.indexOf('var SettingsFormModel = class', start));
assert.ok(start > 0 && end > start, 'installed host model region found');
const primitives = vm.runInNewContext(host.slice(start, end) + '\n({SettingsFormModel,settingsNumberField,settingsTextField})', {
  createSnapshotStore(value) { return { getSnapshot: () => value, set(next) { value = next; } }; }
});
let registration;
vm.runInNewContext(readFileSync(new URL('lib/client.js', root), 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value; } } } });
assert.equal(registration.id, pkg.name);
const React = { createElement(type, props, ...children) { return { type, props, children }; } };
const client = registration.factory(name => {
  if (name === 'react') return React;
  assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives');
  return { ...primitives, SettingsForm: 'SettingsForm', SettingsValueField: 'SettingsValueField' };
});
let snapshot = { status: 'ready', writable: true, value: { transport: 'node', webModel: 'auto', softTurns: 25 }, base: {}, user: {}, revision: 1 };
let subscribed = 0, served, definition, Component, mutated;
const disposers = [];
const scope = {
  getSnapshot: () => snapshot,
  subscribe() { subscribed++; return () => subscribed--; },
  async mutate(ops) { mutated = ops; return false; }
};
client.apply({
  locale: { bind: () => key => key, register() {} },
  configForms: {
    get(ns) { assert.equal(ns, 'dsh-chatgpt-web'); return scope; },
    whileServed(names, callback) { assert.deepEqual(Array.from(names), ['dsh-chatgpt-web']); served = callback; }
  },
  slots: {
    inject(name, callback) { assert.equal(name, 'plugins.item'); return callback(); },
    register(def, component) { definition = def; Component = component; }
  },
  effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); }
});
assert.equal(definition, undefined, 'card hidden until namespace served');
served();
assert.equal(definition.name, 'plugins.item');
assert.equal(definition.id, 'chatgpt-web');
const injected = definition.inject();
const store = injected.hooks.chatGptWebCard;
assert.equal(store.getSnapshot().webModel.text, 'auto');
assert.equal(store.getSnapshot().authStatus, 'unchecked');
injected.edit('softTurns', 'not-a-number');
assert.equal(store.getSnapshot().invalid, true);
injected.discard();
injected.edit('webModel', 'offline-model');
injected.save();
await new Promise(resolve => setImmediate(resolve));
assert.equal(mutated[0].value, 'offline-model');
assert.equal(store.getSnapshot().failed, true, 'host rejected save shown');
const tree = Component({ t: key => key, ...injected, useChatGptWebCard: select => select(store.getSnapshot()) });
assert.equal(tree.type, 'SettingsForm');
assert.equal(tree.props.state.failed, true);
assert.equal(tree.children[0].props.role, 'status');
assert.equal(tree.children.find(node => node.props?.id?.includes('webModel')).props.text, 'offline-model');
for (const dispose of disposers) dispose();
assert.equal(subscribed, 0);
console.log('PASS packaged client manifest/assets, factory lexical require, real installed SettingsFormModel, slot visibility, hook, edit/save failure/dispose');
