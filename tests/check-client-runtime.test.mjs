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
const { frontendSource, source } = await import('./desktop-host.mjs');
const host = frontendSource();
// Desktop embeds primitives in the Vite frontend, not a standalone package.
const exports = Object.fromEntries(['SettingsFormModel', 'settingsNumberField', 'settingsTextField'].map(key => {
  const match = host.match(new RegExp(key + ':([A-Za-z_$][\\w$]*)'));
  assert.ok(match, 'target primitive export ' + key);
  return [key, match[1]];
}));
const start = host.indexOf('function ' + exports.settingsNumberField + '(');
const end = host.indexOf('}};const ', host.indexOf('var ' + exports.SettingsFormModel + '=class', start)) + 2;
assert.ok(start > 0 && end > start, 'desktop bundled model region found');
const region = host.slice(start, end + 1);
const storeName = region.match(/bind\(\w+\)\{const \w+=(\w+)\(/)[1];
const primitives = vm.runInNewContext(region + '\n({' + Object.entries(exports).map(([key, value]) => key + ':' + value).join(',') + '})', {
  [storeName](value) { return { getSnapshot: () => value, set(next) { value = next; } }; }
});
assert.ok(host.includes('"@deepseek-ai/dsh-client-ui-primitives":'), 'actual frontend supplies factory dependency');
assert.match(source('dsh-client-ui-plugin-manager', 'lib/client.js'), /"plugins\.item"/);
const settingsSource = source('dsh-client-ui-settings', 'lib/client.js');
const gateStart = settingsSource.indexOf('whileServed(namespaces, register) {');
const gateEnd = settingsSource.indexOf('\n\t\t\t}', gateStart);
assert.ok(gateStart > 0 && gateEnd > gateStart);
const targetGate = vm.runInNewContext('({' + settingsSource.slice(gateStart, gateEnd) + '\n}})').whileServed;
let gateNamespaces = [], syncGate, liveCards = 0, gateSubscriptions = 0;
const gateOff = targetGate.call({ mirror: {
  getSnapshot: () => ({ view: { namespaces: gateNamespaces.map(ns => ({ ns })) } }),
  subscribe(fn) { syncGate = fn; gateSubscriptions++; return () => gateSubscriptions--; }, ensure() {}
} }, ['dsh-chatgpt-web'], () => { liveCards++; return () => liveCards--; });
assert.equal(liveCards, 0);
gateNamespaces = ['dsh-chatgpt-web']; syncGate(); syncGate();
assert.equal(liveCards, 1, 'actual target gate registers once');
gateNamespaces = []; syncGate();
assert.equal(liveCards, 0, 'actual target gate unregisters absent namespace');
gateNamespaces = ['dsh-chatgpt-web']; syncGate(); gateOff();
assert.equal(liveCards, 0);
assert.equal(gateSubscriptions, 0);
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
    inject(name, callback) { assert.equal(name, 'settings.section'); return callback(); },
    register(def, component) { definition = def; Component = component; }
  },
  effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); }
});
assert.ok(definition, 'section is visible even when the host namespace is unavailable');
assert.equal(definition.name, 'settings.section');
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
// 第一个子节点是登录面板（拉取浏览器登录态），表单字段跟在它后面。
const loginPanel = tree.children[0];
assert.ok(loginPanel && loginPanel.type, 'login panel element present');
// 该测试的 React 桩件没有 hooks，登录面板走静态回退：仍然要能渲染出结构。
const panelTree = loginPanel.type({ t: key => 'L:' + key });
assert.equal(panelTree.type, 'div');
assert.equal(panelTree.props.className, 'cgw-login');
assert.ok(panelTree.children.some(child => child?.props?.className === 'cgw-login-state'), 'shows the stored sign-in line');
assert.ok(panelTree.children.some(child => child?.props?.className === 'cgw-login-row'), 'shows the action row');
const fieldNodes = tree.children.filter(node => node?.props && node.props.id !== undefined);
assert.ok(fieldNodes.length >= 8, 'renders the config fields after the login panel');
assert.equal(fieldNodes.find(node => node.props.id.includes('webModel')).props.text, 'offline-model');
for (const dispose of disposers) dispose();
assert.equal(subscribed, 0);
console.log('PASS packaged client manifest/assets, factory lexical require, real installed SettingsFormModel, slot visibility, hook, edit/save failure/dispose');
