/**
 * 一轮网页端对话的执行器：把 transport（页面）与 wire（协议）接起来。
 *
 * 职责边界：
 *   - 不做会话绑定决策（binding 层做），不做提示词渲染（protocol 层做）。
 *   - 只负责：取认证 -> 解 PoW -> 发请求 -> 读 SSE -> 交出结构化结果。
 *
 * 全部业务 fetch 都在**页面上下文**里执行 —— 只有这样才能带上正确 cookie 与浏览器指纹，
 * 否则 sentinel 会判成 chatgpt-noauth 访客态。
 */

import { evalInPage } from "../transport/page.ts";
import type { Cdp } from "../transport/cdp.ts";
import { classifyFrame, TurnAccumulator } from "./sse.ts";

export type TurnFailureKind =
  | "auth"
  | "rate-limit"
  | "message-limit"
  | "network"
  | "no-token"
  | "pow-failed"
  /** 服务端 200 + [DONE]，但正文是空的/纯空白 —— 重试可能有用，不是成功。 */
  | "empty-response"
  /** 流在没有 [DONE] 的情况下结束 —— 内容可能只到一半，绝不能当成功。 */
  | "truncated"
  | "unknown";

export interface RawTurnOutcome {
  status: number;
  frames: string[];
  sawDone: boolean;
  ttfbMs: number;
  totalMs: number;
  failure: TurnFailureKind | null;
  errorBody: string | null;
}

export interface TurnResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly text: string;
  readonly finishType: string | null;
  readonly sawDone: boolean;
  readonly ttfbMs: number;
  readonly totalMs: number;
  readonly failure: TurnFailureKind | null;
  readonly errorBody: string | null;
}

/** 把页面返回的原始帧交给累积器，得到结构化结果。 */
export function interpretFrames(raw: Partial<RawTurnOutcome>): TurnResponse {
  const acc = new TurnAccumulator();
  for (const frame of raw.frames ?? []) {
    acc.push(classifyFrame(frame));
  }
  const text = acc.textValue;
  const status = typeof raw.status === "number" ? raw.status : 0;
  const sawDone = raw.sawDone === true;
  let failure: TurnFailureKind | null = raw.failure ?? null;
  if (failure === null && acc.rateLimited) {
    failure = acc.finishType === "message_limit" ? "message-limit" : "rate-limit";
  }
  if (failure === null && status >= 400) {
    failure = status === 401 || status === 403 ? "auth" : "unknown";
  }
  // 空白正文不算有内容：网页端偶尔只回一个换行/空格，那不是回答。
  const hasVisibleText = text.trim().length > 0;
  // 失败必须**永远**带一个分类，否则调用方只能看到 ok=false 却无法路由。
  // 这两种情况都不是服务端明确报错，但也不是成功：空响应与断流。
  if (failure === null && !hasVisibleText) failure = "empty-response";
  if (failure === null && !sawDone) failure = "truncated";
  const ok = failure === null && status === 200 && sawDone && hasVisibleText;
  return {
    ok,
    status,
    conversationId: acc.conversationId,
    messageId: acc.messageId,
    text,
    finishType: acc.finishType,
    sawDone,
    ttfbMs: raw.ttfbMs ?? 0,
    totalMs: raw.totalMs ?? 0,
    failure,
    errorBody: raw.errorBody ?? null,
  };
}

/** 把内部失败分类映射成 DSH 的稳定失败码。 */
export function failureCodeOf(kind: TurnFailureKind | null): string | null {
  switch (kind) {
    case "auth":
    case "no-token":
      return "AUTH";
    case "rate-limit":
      return "RATE_LIMIT";
    case "message-limit":
      return "QUOTA";
    case "network":
      return "CONNECTION";
    case "pow-failed":
      return "PROVIDER_ERROR";
    case "empty-response":
      return "EMPTY_RESPONSE";
    case "truncated":
      return "TRUNCATED";
    case "unknown":
      return "PROVIDER_ERROR";
    default:
      return null;
  }
}

/** 读页面脚本源码（注入用）。构建时以字符串常量形式内联。 */
export const PAGE_TURN_SOURCE: string = String.raw`__PAGE_TURN_BODY__`;