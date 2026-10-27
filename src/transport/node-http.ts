/** Node HTTP transport. Never solves challenges or falls back to a browser. */
import { sha3_512, utf8, toBase64, toHex, concat } from "../pow/sha3.ts";
import type { StoredAuth } from "../auth.ts";

export type NodeFailure = "cloudflare" | "auth" | "rate-limit" | "network" | "unknown";
export interface NodeTurnResult {
  readonly transport: "node";
  readonly status: number;
  readonly frames: string[];
  readonly sawDone: boolean;
  readonly ttfbMs: number;
  readonly totalMs: number;
  readonly failure: NodeFailure | null;
  readonly errorBody: string | null;
}
const BASE = "https://chatgpt.com";
export function browserHeaders(auth: StoredAuth): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "text/event-stream", "content-type": "application/json",
    "accept-language": auth.languages.join(",") || "en-US",
    origin: BASE, referer: BASE + "/", "sec-fetch-mode": "cors",
    "user-agent": auth.userAgent || "DSH-ChatGPT-Web/0.1",
  };
  if (auth.userAgent) headers["user-agent"] = auth.userAgent;
  const major = auth.userAgent.match(/Chrome\/(\d+)/u)?.[1];
  if (major) {
    headers["sec-ch-ua"] = '"Chromium";v="' + major + '", "Google Chrome";v="' + major + '"';
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = '"Windows"';
  }
  if (auth.cookieHeader !== null) headers.cookie = auth.cookieHeader;
  return headers;
}
export function looksLikeCloudflare(status: number, body: string): boolean {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return /cloudflare|<html|cf-|just a moment|captcha|challenge/iu.test(body.slice(0, 2000));
}
export interface NodeTurnInput {
  readonly auth: StoredAuth;
  readonly prompt: string;
  readonly conversationId: string | null;
  readonly parentMessageId: string | null;
  readonly userMessageId: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
  readonly onFrame?: (frame: string) => void;
}

export async function nodeTurn(input: NodeTurnInput): Promise<NodeTurnResult> {
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("TIMEOUT")), input.timeoutMs ?? 180_000);
  const frames: string[] = [];
  let status = 0;
  let ttfbMs = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const result = (failure: NodeFailure | null, sawDone = false): NodeTurnResult => ({
    transport: "node", status, frames, sawDone, ttfbMs,
    totalMs: Date.now() - started, failure,
    errorBody: failure === "cloudflare" ? "CHALLENGE_REQUIRED: 请在正常浏览器中人工恢复认证；不会自动求解挑战。" : failure === null ? null : "请求失败（响应正文已隐藏）",
  });
  try {
    controller.signal.throwIfAborted();
    const headers = { ...input.headers, ...browserHeaders(input.auth), authorization: "Bearer " + input.auth.accessToken };
    // No requirements-token generation, proof solving, or challenge emulation.
    // If the service requires any of these, fail explicitly for manual recovery.
    const response = await fetch(BASE + "/backend-api/conversation", {
      method: "POST", headers, redirect: "error", signal: controller.signal,
      body: JSON.stringify({
        action: "next",
        messages: [{ id: input.userMessageId, author: { role: "user" }, content: { content_type: "text", parts: [input.prompt] } }],
        parent_message_id: input.parentMessageId ?? crypto.randomUUID(),
        ...(input.conversationId === null ? {} : { conversation_id: input.conversationId }),
        model: input.model, timezone_offset_min: new Date().getTimezoneOffset(),
        history_and_training_disabled: false, conversation_mode: { kind: "primary_assistant" },
        supported_encodings: ["v1"],
      }),
    });
    status = response.status;
    ttfbMs = Date.now() - started;
    if (!response.ok) {
      // Never retain or log upstream error bodies (they may echo request credentials).
      await response.body?.cancel();
      return result(status === 401 ? "auth" : status === 403 ? "cloudflare" : status === 429 ? "rate-limit" : "unknown");
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel();
      return result("cloudflare");
    }
    if (!response.body) return result("unknown");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let sawDone = false;
    const dispatch = () => {
      if (data.length === 0) return;
      const value = data.join("\n");
      data = [];
      if (value.trim() === "[DONE]") sawDone = true;
      else if (value.trim()) { frames.push(value); input.onFrame?.(value); }
    };
    const line = (value: string) => {
      if (value === "") dispatch();
      else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /u, ""));
    };
    for (;;) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      // Keep a trailing CR until the next chunk so split CRLF stays one delimiter.
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\n|\r(?!$)/u.exec(buffer)) !== null) {
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (chunk.done) {
        if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
        if (buffer) line(buffer);
        dispatch();
        break;
      }
      if (sawDone) break;
      if (buffer.length > 4_000_000 || frames.reduce((n, frame) => n + frame.length, 0) > 8_000_000) throw new Error("RESPONSE_LIMIT");
    }
    return result(null, sawDone);
  } catch {
    return result("network");
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
export { sha3_512, utf8, toBase64, toHex, concat };
