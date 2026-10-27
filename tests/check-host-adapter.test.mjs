import assert from 'node:assert/strict';
import { ChatGptWebAdapter, serializeMessage } from '../src/host-adapter.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
const auth = { version: 1, accessToken: 'offline-placeholder', cookieHeader: null, dataBuild: '', userAgent: '', languages: [], planType: null, capturedAt: 0, lastOkAt: null };
const config = { ...DEFAULT_CONFIG, minIntervalMs: 0, maxIntervalMs: 0 };
const options = { provider: 'chatgpt-web', model: 'chatgpt-free', sessionId: 'offline-session', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
function response(text) { return { status: 200, frames: [JSON.stringify({ v: { message: { id: 'a1', author: { role: 'assistant' }, content: { parts: [text] }, status: 'finished_successfully' } } }), JSON.stringify({ type: 'title_generation', conversation_id: 'offline-conversation' })], sawDone: true, failure: null, errorBody: null, totalMs: 1, ttfbMs: 1 }; }
async function collect(adapter, input = options) { return Array.fromAsync(adapter.stream(input)); }
let calls = [];
const adapter = new ChatGptWebAdapter(config, { loadAuth: async () => auth, runTurn: async input => { calls.push(input); return response('hello back'); } });
assert.equal((await adapter.listModels('chatgpt-web'))[0].provider, 'chatgpt-web');
let chunks = await collect(adapter);
assert.equal(chunks.at(-1).reason.kind, 'stop');
assert.equal(chunks.filter(c => c.type === 'finish').length, 1);
assert.equal(chunks.find(c => c.type === 'text-delta').text, 'hello back');
assert.ok(calls[0].headers && Object.keys(calls[0].headers).length > 0);
await collect(adapter, { ...options, messages: [...options.messages, { role: 'tool', toolCallId: 't1', content: [{ type: 'text', text: 'FIRST_RESULT' }] }, { role: 'tool', toolCallId: 't2', content: [{ type: 'text', text: 'SECOND_RESULT' }] }] });
assert.match(calls[1].prompt, /FIRST_RESULT/);
assert.match(calls[1].prompt, /SECOND_RESULT/);
const cancelled = new AbortController(); cancelled.abort();
chunks = await collect(adapter, { ...options, signal: cancelled.signal });
assert.equal(chunks.at(-1).reason.kind, 'aborted');
assert.equal(calls.length, 2);
const toolAdapter = new ChatGptWebAdapter(config, { loadAuth: async () => auth, runTurn: async () => response('<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>') });
chunks = await collect(toolAdapter, { ...options, tools: [{ name: 'read', description: '', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } }] });
assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
assert.equal(chunks.find(c => c.type === 'block-end').block.arguments, '{"path":"a"}');
const denied = new ChatGptWebAdapter(config, { loadAuth: async () => auth, runTurn: async () => response('<tool_call>{"name":"unknown","arguments":{}}</tool_call>') });
chunks = await collect(denied);
assert.equal(chunks.at(-1).reason.kind, 'error');
assert.equal(chunks.filter(c => c.type === 'tool-call-delta').length, 0);
let unblock;
const busy = new ChatGptWebAdapter(config, { loadAuth: async () => auth, runTurn: async () => { await new Promise(resolve => { unblock = resolve; }); return response('done'); } });
const first = collect(busy);
while (!unblock) await new Promise(resolve => setImmediate(resolve));
chunks = await collect(busy);
assert.equal(chunks.at(-1).reason.failure.code, 'BUSY');
unblock(); await first;
assert.match(serializeMessage({ role: 'tool', toolCallId: 't1', isError: true, content: [{ type: 'text', text: 'failed' }] }), /"isError":true/);
const frame = text => response(text).frames[0];
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('offline timeout')), 2000); })]); }
  finally { clearTimeout(timer); }
}
for (const mode of ['success', 'disconnect', 'abort', 'invalid']) {
  let input, release;
  const signal = new AbortController();
  const pending = new ChatGptWebAdapter(config, { loadAuth: async () => auth, runTurn: async value => {
    input = value;
    value.onFrame(frame('  Early'));
    return await new Promise(resolve => {
      release = resolve;
      value.signal.addEventListener('abort', () => resolve({ ...response('Early'), failure: 'network', sawDone: false }), { once: true });
    });
  } });
  const iterator = pending.stream({ ...options, signal: signal.signal });
  assert.equal((await bounded(iterator.next())).value.type, 'block-start');
  assert.equal((await bounded(iterator.next())).value.text, 'Early');
  assert.ok(release, 'transport still pending at first text');
  if (mode === 'abort') signal.abort();
  else if (mode === 'disconnect') release({ ...response('Early'), failure: 'network', sawDone: false });
  else if (mode === 'invalid') release(response('  Early<tool_call>{bad}</tool_call>'));
  else { input.onFrame(frame('  Early text')); release(response('  Early text')); }
  const rest = await bounded(Array.fromAsync(iterator));
  assert.equal(rest.filter(c => c.type === 'finish').length, 1);
  assert.equal(rest.at(-1).reason.kind, mode === 'success' ? 'stop' : mode === 'abort' ? 'aborted' : 'error');
  assert.equal('Early' + rest.filter(c => c.type === 'text-delta').map(c => c.text).join(''), mode === 'success' ? 'Early text' : 'Early');
  assert.equal(rest.filter(c => c.type === 'tool-call-delta').length, 0);
}
{
  let input, release;
  const pending = new ChatGptWebAdapter(config, { loadAuth: async () => auth, runTurn: async value => {
    input = value; value.onFrame(frame('Before <tool_'));
    return await new Promise(resolve => { release = resolve; });
  } });
  const iterator = pending.stream({ ...options, tools: [{ name: 'read', description: '', parameters: { type: 'object' } }] });
  await bounded(iterator.next());
  assert.equal((await bounded(iterator.next())).value.text, 'Before');
  input.onFrame(frame('Before <tool_call>{"name":"read","arguments":{}}</tool_'));
  input.onFrame(frame('Before <tool_call>{"name":"read","arguments":{}}</tool_call> After'));
  assert.equal((await bounded(iterator.next())).value.text, '  After');
  let completed = false;
  const next = iterator.next().then(value => { completed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'no tool before successful transport');
  release(response('Before <tool_call>{"name":"read","arguments":{}}</tool_call> After'));
  const rest = [(await bounded(next)).value, ...await Array.fromAsync(iterator)];
  assert.equal(rest.filter(c => c.type === 'tool-call-delta').length, 1);
  assert.equal(rest.at(-1).reason.kind, 'tool-calls');
}
{
  let cancelledTransport = false;
  const disposable = new ChatGptWebAdapter(config, { loadAuth: async () => auth, runTurn: async value => {
    value.onFrame(frame('visible'));
    return await new Promise(resolve => value.signal.addEventListener('abort', () => {
      cancelledTransport = true; resolve({ ...response('visible'), failure: 'network', sawDone: false });
    }, { once: true }));
  } });
  const iterator = disposable.stream(options);
  await bounded(iterator.next()); await bounded(iterator.next());
  await bounded(iterator.return());
  assert.equal(cancelledTransport, true, 'consumer return aborts live transport');
  const again = disposable.stream(options);
  assert.equal((await bounded(again.next())).value.type, 'block-start', 'single flight released');
  await bounded(again.return());
}
console.log('PASS host-adapter realtime early text, delayed tools, no replay, disconnect and abort');
