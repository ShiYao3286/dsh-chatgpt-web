/** Desktop Harness 0.2.1-rc.3 adapter. No browser launch, credential writes or challenge solving. */
import { randomUUID } from 'node:crypto';
import { LlmAdapter, attributionHeaders } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm/types';
import { loadAuth, authExpired } from './auth.ts';
import { BindingRuntime, memoryBindingStore } from './binding/runtime.ts';
import { memoryCheckpointStore, MAX_SEED_CHARS } from './binding/checkpoint.ts';
import { memoryLedger } from './gate/ledger.ts';
import { Gate, DEFAULT_GATE } from './gate/gate.ts';
import { renderBootstrap } from './protocol/bootstrap.ts';
import { parseToolCalls } from './protocol/parse.ts';
import { LiveText } from './wire/live-text.ts';
import { PROVIDER_ROUTE, CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, runTurn, toResponse, failureCodeOf, localTitle } from './adapter.ts';
import type { PluginConfig } from './config.ts';

export function serializeMessage(message: Pick<RequestMessage, 'role' | 'content'> & { toolCallId?: string; isError?: boolean }): string {
  const blocks = message.content.map(block => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text;
    if (block.type === 'tool-call') return '<tool_call>' + JSON.stringify({ id: block.id, name: block.name, arguments: JSON.parse(block.arguments) }) + '</tool_call>';
    // Never silently discard images or unknown model-facing blocks.
    if (block.type === 'image') throw new Error('UNSUPPORTED_IMAGE');
    return JSON.stringify(block);
  }).join('\n');
  return JSON.stringify({ role: message.role, ...('toolCallId' in message ? { toolCallId: message.toolCallId, isError: message.isError === true } : {}), content: blocks });
}

/** Fail closed for common JSON Schema constraints before publishing executable calls. */
export function validArguments(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) return false;
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (Array.isArray(schema.required) && schema.required.some(k => typeof k !== 'string' || !(k in obj))) return false;
    for (const [key, item] of Object.entries(obj)) {
      if (!properties[key]) { if (schema.additionalProperties === false) return false; }
      else if (!validArguments(item, properties[key])) return false;
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return false;
    if (schema.items && typeof schema.items === 'object' && !value.every(v => validArguments(v, schema.items as Record<string, unknown>))) return false;
  } else if (type === 'integer') { if (!Number.isInteger(value)) return false; }
  else if (typeof type === 'string' && type !== 'null' && typeof value !== type) return false;
  else if (type === 'null' && value !== null) return false;
  return true;
}

export class ChatGptWebAdapter extends LlmAdapter {
  private active = false;
  private readonly gate: Gate;
  private readonly sessions = new Map<string, { head: string; runtime: BindingRuntime }>();
  private readonly readConfig: () => PluginConfig;
  private readonly dependencies: { loadAuth: typeof loadAuth; runTurn: typeof runTurn };
  constructor(config: PluginConfig | (() => PluginConfig), dependencies: { loadAuth: typeof loadAuth; runTurn: typeof runTurn } = { loadAuth, runTurn }) {
    super();
    this.readConfig = typeof config === 'function' ? config : () => config;
    this.dependencies = dependencies;
    this.gate = new Gate(DEFAULT_GATE);
  }
  override providerInfo(provider: string) { return { id: provider, name: 'ChatGPT 网页（非官方）' }; }
  override async listModels(provider: string) { return [{ provider, id: 'chatgpt-free', name: 'ChatGPT 网页（自动模型）', inputModalities: ['text' as const] }]; }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return { provider, id: model, name: 'ChatGPT 网页（自动模型）', inputModalities: ['text' as const], context: { contextWindow: CONTEXT_WINDOW }, defaultMaxTokens: DEFAULT_MAX_TOKENS };
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.active) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'BUSY', message: '网页 provider 正在处理上一条请求；不排队。' } } }; return; }
    this.active = true;
    // Capture once before the first await; live saves never mutate an in-flight turn.
    const config = { ...this.readConfig() };
    this.gate.configure({ minIntervalMs: config.minIntervalMs, maxIntervalMs: config.maxIntervalMs, rateMaxInWindow: config.rateMaxInWindow });
    let runtime: BindingRuntime | undefined;
    let finished = false;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let transportTask: Promise<unknown> | undefined;
    let shown = '';
    let textOpen = false;
    try {
      options.signal?.throwIfAborted();
      if (options.provider !== PROVIDER_ROUTE || options.model !== 'chatgpt-free') throw new Error('UNSUPPORTED_MODEL');
      const entries = options.messages.map(serializeMessage);
      if (options.purpose === 'session-title') {
        const text = localTitle(options.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join(' '));
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      if (config.transport !== 'node') throw new Error('MANUAL_BROWSER_REQUIRED');
      const auth = await this.dependencies.loadAuth();
      if (!auth || authExpired(auth)) throw new Error('AUTH');
      options.signal?.throwIfAborted();
      const tools: ToolSchema[] = options.tools ?? [];
      const bootstrap = renderBootstrap({ env: { provider: options.provider, model: options.model, cwd: process.cwd(), platform: process.platform, today: new Date().toISOString().slice(0, 10) }, tools, includeHostTools: true, catalogBudgetChars: config.catalogBudgetChars });
      const head = bootstrap.text + '\n' + (options.system ?? '');
      const signature = JSON.stringify([head, config.softTurns, config.hardTurns]);
      // Refuse instead of letting the legacy seed builder trim instructions/history.
      if (head.length + entries.join('\n').length + entries.length * 12 + 256 > MAX_SEED_CHARS) throw new Error('CONTEXT_LIMIT');
      const key = options.purpose === 'compaction' ? randomUUID() : options.sessionId ?? randomUUID();
      let session = this.sessions.get(key);
      if (!session || session.head !== signature) {
        runtime = new BindingRuntime({ bootstrap: head, toolCatalog: bootstrap.catalog.text, protocolVersion: bootstrap.protocolVersion, limits: { softTurns: config.softTurns, hardTurns: config.hardTurns, recentSeedTurns: 100000 }, gate: this.gate, store: memoryBindingStore(), checkpointStore: memoryCheckpointStore(), ledger: memoryLedger() });
        session = { head: signature, runtime };
        // Bound memory. Evicted sessions restart safely from the caller's full history.
        if (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value!);
        if (options.sessionId && !options.purpose) this.sessions.set(key, session);
      }
      runtime = session.runtime;
      const begin = await runtime.beginTurn(entries);
      if (!begin.ok) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: begin.reason === 'busy' ? 'BUSY' : 'RATE_LIMIT', message: '网页调用闸门拒绝：' + begin.reason, ...(begin.waitMs ? { providerRetryAfterMs: begin.waitMs } : {}) } } }; return;
      }
      if (begin.plan.seed?.startsWith('…（较早内容已省略）')) throw new Error('CONTEXT_LIMIT');
      if (begin.plan.noop) { yield { type: 'finish', reason: { kind: 'stop' } }; return; }
      options.signal?.throwIfAborted();
      const live = new LiveText();
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let settled = false;
      let transportError: unknown;
      let raw: Awaited<ReturnType<typeof runTurn>> | undefined;
      const notify = () => { wake?.(); wake = undefined; };
      transportTask = this.dependencies.runTurn({ auth, prompt: begin.plan.payload, conversationId: begin.plan.conversationId, parentMessageId: begin.plan.parentMessageId, userMessageId: begin.plan.userMessageId, model: config.webModel, signal: controller.signal, headers: attributionHeaders(), onFrame: frame => {
        controller.signal.throwIfAborted();
        const delta = live.push(frame);
        if (delta) { queue.push(delta); notify(); }
      } }).then(value => { raw = value; }, error => { transportError = error; }).finally(() => { settled = true; notify(); });
      while (!settled || queue.length) {
        if (!queue.length) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
        const delta = queue.shift()!;
        if (!textOpen) { textOpen = true; yield { type: 'block-start', index: 0, blockType: 'text' }; }
        shown += delta;
        yield { type: 'text-delta', index: 0, text: delta };
      }
      if (transportError) throw transportError;
      options.signal?.throwIfAborted();
      if (!raw) throw new Error('PROVIDER_ERROR');
      const response = toResponse(raw);
      if (!response.ok) {
        if (textOpen) { yield { type: 'block-end', index: 0, block: { type: 'text', text: shown } }; textOpen = false; }
        await runtime.finishTurn({ ok: false, kind: response.failure === 'auth' ? 'auth' : 'transport', status: response.status }); finished = true;
        yield { type: 'finish', reason: { kind: 'error', failure: { code: failureCodeOf(response.failure) ?? 'PROVIDER_ERROR', message: response.failure === 'auth' ? '网页登录凭证无效或过期，请手工重新登录并捕获凭证。' : response.failure === 'cloudflare' || response.failure === 'pow-failed' ? '网页要求人工验证；请在网页登录处理后重试，不自动绕过挑战。' : '网页响应失败：' + response.failure, status: response.status } } }; return;
      }
      live.assertComplete();
      const cleaned = await runtime.recordReply(response.text);
      const result = parseToolCalls(cleaned.text);
      const parsed = { ...result, text: result.text.replace(/\n{3,}/g, '\n\n').trim() };
      if (!parsed.text.startsWith(shown)) throw new Error('NON_MONOTONIC_STREAM');
      if (!parsed.balanced || parsed.unparsed.length || parsed.pending) throw new Error('TOOL_PROTOCOL');
      for (const call of parsed.toolCalls) {
        const tool = tools.find(t => t.name === call.name);
        if (!tool || !validArguments(call.arguments, tool.parameters)) throw new Error('TOOL_PROTOCOL');
      }
      const emittedCalls = parsed.toolCalls.map(call => ({ ...call, id: randomUUID() as import('@deepseek-ai/dsh-llm/brand').ToolCallId }));
      const assistantEntry = serializeMessage({ role: 'assistant', content: [
        ...(parsed.text ? [{ type: 'text' as const, text: parsed.text }] : []),
        ...emittedCalls.map(call => ({ type: 'tool-call' as const, id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })),
      ] });
      options.signal?.throwIfAborted();
      await runtime.finishTurn({ ok: true, conversationId: response.conversationId, messageId: response.messageId, status: response.status, ttfbMs: response.ttfbMs, assistantEntry }); finished = true;
      options.signal?.throwIfAborted();
      let index = 0;
      if (parsed.text) {
        if (!textOpen) { textOpen = true; yield { type: 'block-start', index, blockType: 'text' }; }
        const tail = parsed.text.slice(shown.length);
        if (tail) yield { type: 'text-delta', index, text: tail };
        shown = parsed.text;
        yield { type: 'block-end', index, block: { type: 'text', text: parsed.text } }; textOpen = false; index++;
      }
      for (const call of emittedCalls) {
        options.signal?.throwIfAborted();
        const id = call.id;
        const argumentsText = JSON.stringify(call.arguments);
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: argumentsText };
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: argumentsText } }; index++;
      }
      options.signal?.throwIfAborted();
      yield { type: 'finish', reason: { kind: parsed.toolCalls.length ? 'tool-calls' : 'stop' } };
    } catch (error) {
      controller.abort(error);
      if (transportTask) await transportTask.catch(() => undefined);
      if (textOpen) { yield { type: 'block-end', index: 0, block: { type: 'text', text: shown } }; textOpen = false; }
      if (runtime && !finished) { await runtime.finishTurn({ ok: false, kind: options.signal?.aborted ? 'aborted' : 'tool-protocol' }).catch(() => runtime?.abortTurn()); finished = true; }
      const known = error instanceof Error ? error.message : '';
      const code = ['AUTH', 'CONTEXT_LIMIT', 'TOOL_PROTOCOL', 'UNSUPPORTED_IMAGE', 'UNSUPPORTED_MODEL', 'MANUAL_BROWSER_REQUIRED'].includes(known) ? known : 'PROVIDER_ERROR';
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { code: options.signal?.aborted ? 'ABORTED' : code, message: code === 'AUTH' ? '缺少有效网页登录凭证，请手工登录并捕获；不会自动修改凭证。' : '网页 provider 调用未完成（' + code + '）。' } } };
    } finally {
      controller.abort();
      options.signal?.removeEventListener('abort', abort);
      if (transportTask) await transportTask.catch(() => undefined);
      if (runtime && !finished) runtime.abortTurn();
      this.active = false;
    }
  }
}
