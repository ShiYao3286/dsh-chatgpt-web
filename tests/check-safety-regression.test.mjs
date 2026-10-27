import assert from 'node:assert/strict';
import { nodeTurn } from '../src/transport/node-http.ts';
import { LiveText } from '../src/wire/live-text.ts';
import { authExpired, authFingerprint } from '../src/auth.ts';
import { classifyFrame, TurnAccumulator, readSseData } from '../src/wire/sse.ts';
import { interpretFrames } from '../src/wire/turn.ts';
import { parseToolCalls, ToolCallStreamParser } from '../src/protocol/parse.ts';
const auth = { version: 1, accessToken: 'synthetic-token', cookieHeader: null, dataBuild: '', userAgent: '', languages: [], planType: null, capturedAt: 0, lastOkAt: null };
const snapshot = { p: '', o: 'add', v: { message: { id: 'a', author: { role: 'assistant' }, content: { parts: ['hello'] }, status: 'finished_successfully' } } };
const acc = new TurnAccumulator();
acc.push(classifyFrame(JSON.stringify(snapshot)));
acc.push(classifyFrame(JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: ' world' })));
assert.equal(acc.textValue, 'hello world');
assert.equal(interpretFrames({ status: 200, sawDone: true, frames: [JSON.stringify(snapshot)] }).ok, true);
const unfinished = structuredClone(snapshot); unfinished.v.message.status = 'in_progress';
assert.equal(interpretFrames({ status: 200, sawDone: true, frames: [JSON.stringify(unfinished)] }).failure, 'truncated');
assert.equal(interpretFrames({ status: 200, sawDone: true, frames: [JSON.stringify(snapshot), '{"error":{"message":"hidden"}}'] }).ok, false);
const enc = new TextEncoder();
const stream = new ReadableStream({ start(c) { for (const s of ['data: a\r', '\ndata: b\r\n\r', '\ndata: last']) c.enqueue(enc.encode(s)); c.close(); } });
assert.deepEqual(await Array.fromAsync(readSseData(stream)), ['a\nb', 'last']);
const parser = new ToolCallStreamParser();
assert.equal(parser.feed('<tool_call>{"name":"read","arguments":{}}</tool_').text, '');
assert.equal(parser.feed('call>').toolCalls.length, 1);
assert.equal(parseToolCalls('<tool_call>{"name":"read","arguments":{}}').toolCalls.length, 0);
assert.equal(parseToolCalls('<tool_call>{"name":"read","arguments":"bad"}</tool_call>').toolCalls.length, 0);
assert.equal(parseToolCalls('<tool_call>{name:"read",arguments:{}}</tool_call>').toolCalls.length, 0);
assert.equal(authFingerprint(auth).includes('synthetic'), false);
assert.equal(authExpired({ ...auth, accessToken: 'x.' + Buffer.from('{"exp":1}').toString('base64url') + '.x' }), true);
assert.equal(authExpired(auth), false);
// Every possible opening/closing boundary, including XML and DSML, stays private.
for (const hidden of ['<tool_call>{"name":"read","arguments":{}}</tool_call>', '<invoke name="read"><parameter name="path">a</parameter></invoke>', '<|DSML|invoke name="read"><parameter name="path">a</parameter></|DSML|invoke>', '<｜DSML｜invoke name="read"><parameter name="path">a</parameter></｜DSML｜invoke>', '<state_handoff>private</state_handoff>']) {
  for (let cut = 1; cut < hidden.length; cut++) {
    const live = new LiveText();
    const packet = text => JSON.stringify({ v: { message: { author: { role: 'assistant' }, content: { parts: [text] } } } });
    const one = live.push(packet('Visible ' + hidden.slice(0, cut)));
    const two = live.push(packet('Visible ' + hidden + ' End'));
    assert.equal(one + two, 'Visible  End');
  }
}
const changing = new LiveText();
changing.push(JSON.stringify(snapshot));
assert.throws(() => changing.push(JSON.stringify({ ...snapshot, v: { message: { ...snapshot.v.message, content: { parts: ['rewritten'] } } } })), /NON_MONOTONIC/);
const original = globalThis.fetch;
let count = 0;
try {
  globalThis.fetch = async (_url, init) => {
    count++;
    assert.equal(init.headers['x-offline-attribution'], 'yes');
    assert.equal(Object.keys(init.headers).some(k => k.includes('proof')), false);
    return new Response('data: one\r\ndata: two\r\n\r\ndata: [DONE]', { headers: { 'content-type': 'text/event-stream' } });
  };
  const input = { auth, prompt: 'offline', conversationId: null, parentMessageId: null, userMessageId: 'u', model: 'auto', headers: { 'x-offline-attribution': 'yes' } };
  let result = await nodeTurn(input);
  assert.deepEqual(result.frames, ['one\ntwo']); assert.equal(result.sawDone, true); assert.equal(count, 1);
  let releaseStream;
  const observed = [];
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(enc.encode('data: live\n\n'));
    releaseStream = () => { controller.enqueue(enc.encode('data: [DONE]\n\n')); controller.close(); };
  } }), { headers: { 'content-type': 'text/event-stream' } });
  let settled = false;
  const streaming = nodeTurn({ ...input, onFrame: value => observed.push(value) }).finally(() => { settled = true; });
  for (let i = 0; i < 20 && !observed.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, ['live']);
  assert.equal(settled, false, 'node HTTP callback precedes completion');
  releaseStream(); await streaming;
  const pre = new AbortController(); pre.abort();
  result = await nodeTurn({ ...input, signal: pre.signal });
  assert.equal(count, 1); assert.equal(result.failure, 'network');
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  const cancel = new AbortController(); const pending = nodeTurn({ ...input, signal: cancel.signal }); cancel.abort();
  assert.equal((await pending).failure, 'network');
  result = await nodeTurn({ ...input, timeoutMs: 5 }); assert.equal(result.failure, 'network');
  globalThis.fetch = async () => new Response('secret reflected token', { status: 403 });
  result = await nodeTurn(input); assert.equal(result.failure, 'cloudflare'); assert.equal(result.errorBody.includes('secret'), false);
} finally { globalThis.fetch = original; }
console.log('PASS safety regressions: SSE snapshot/append/EOF, terminal/error, strict tools, auth redaction/expiry, cancellation/deadline, no challenge solving');
