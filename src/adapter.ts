/**
 * DSH provider 适配器：路由名 chatgpt-web。
 *
 * 契约要点（来自 @deepseek-ai/dsh-llm）：
 *   - `listModels()` 供 GUI 选择模型；
 *   - `stream(options)` 产出 chunk，且**必须恰好以一条 terminal finish 结束**；
 *   - 失败走稳定 code（AUTH / RATE_LIMIT / QUOTA / PROVIDER_ERROR），不要靠 message 文本判断。
 *
 * purpose 分流（关键设计）：
 *   - `session-title` -> 本地合成，**零网络请求**。网页端自己也会生成标题，白花额度。
 *   - `compaction`  -> 本地模板摘要，**绝不吃网页端额度**。压缩本身就是为了省额度。
 *   - `chat`        -> 正常走网页端。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Cdp } from "./transport/cdp.ts";
import { failureCodeOf, interpretFrames, type RawTurnOutcome } from "./wire/turn.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 页面脚本：与 page-pow.js / page-turn.js 是同一份源码，运行时读入。 */
export function loadPageSources(): { pow: string; turn: string } {
  const pow = readFileSync(join(HERE, "wire", "page-pow.js"), "utf8");
  const turn = readFileSync(join(HERE, "wire", "page-turn.js"), "utf8");
  return { pow, turn };
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export const CONTEXT_WINDOW = 1_048_576;
export const DEFAULT_MAX_TOKENS = 32_768;

/** 只暴露一条模型：免费档只有「快速模式」，思考是同一模型的开关。 */
export const MODELS: readonly ModelInfo[] = [
  { id: "chatgpt-free", name: "ChatGPT 网页 · 免费", contextWindow: CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
];

export const PROVIDER_ROUTE = "chatgpt-web";

export function listModels(): ModelInfo[] {
  return MODELS.map((m) => ({ ...m }));
}

/* ------------------------------------------------------------------ */
/* purpose 分流                                                        */
/* ------------------------------------------------------------------ */

export type Purpose = "chat" | "session-title" | "compaction" | string;

/** 只有 chat 才允许真的花一次网页端额度。 */
export function shouldUseWeb(purpose: Purpose | undefined): boolean {
  return purpose === undefined || purpose === "chat";
}

/** 会话标题：取首条用户文本前 N 字，本地合成，一个请求都不发。 */
export function localTitle(prompt: string, maxChars = 24): string {
  const flat = prompt.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return "新会话";
  const head = flat.length > maxChars ? flat.slice(0, maxChars) + "…" : flat;
  return head;
}

/** 压缩摘要：本地模板，不吃额度。 */
export function localCompactionSummary(input: { turns: number; lastUserText: string }): string {
  const tail = input.lastUserText.replace(/\s+/gu, " ").trim().slice(0, 400);
  return [
    "[压缩摘要] 本会话已进行 " + input.turns + " 轮。",
    "最后一次用户请求：" + (tail.length > 0 ? tail : "(空)"),
    "更早的细节已从上下文中移除；如需回看请向用户确认。",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 一轮执行                                                            */
/* ------------------------------------------------------------------ */

export interface RunTurnInput {
  readonly cdp: Cdp;
  readonly prompt: string;
  readonly conversationId: string | null;
  readonly parentMessageId: string | null;
  readonly userMessageId: string;
  readonly model: string;
}

export async function runTurn(input: RunTurnInput): Promise<RawTurnOutcome> {
  const { pow, turn } = loadPageSources();
  const request = {
    prompt: input.prompt,
    conversationId: input.conversationId,
    parentMessageId: input.parentMessageId,
    userMessageId: input.userMessageId,
    model: input.model,
  };
  const expression = [
    pow,
    "globalThis.__TURN_REQ__ = " + JSON.stringify(request) + ";",
    turn,
  ].join("\n");
  const raw = (await input.cdp.evaluate(expression, {
    awaitPromise: true,
    returnByValue: true,
    timeoutMs: 180_000,
  })) as RawTurnOutcome;
  return raw;
}

/** 把一轮原始结果转成适配器可用的响应。 */
export function toResponse(raw: RawTurnOutcome) {
  return interpretFrames(raw);
}

export { failureCodeOf };