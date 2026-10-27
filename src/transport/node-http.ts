/**
 * Node 侧的 HTTP 直连传输 —— 不依赖浏览器。
 *
 * 这是与 CDP 路径**并行**的实现，不是降级方案：PoW、sentinel、SSE 全部能用纯 Node 完成，
 * 因为它们是普通 HTTP 请求。浏览器唯一难以复制的是 TLS 指纹，所以这里的策略是：
 *   1. 默认走 Node（快、不需要常驻浏览器）
 *   2. 请求头尽量贴近真实浏览器（UA、sec-ch-ua、accept-language 等）
 *   3. 一旦被 Cloudflare 拒（403 / HTML 挑战页），调用方自动回落到 CDP
 */

import { sha3_512, utf8, toBase64, toHex, concat } from "../pow/sha3.ts";
import { buildPowConfig, solveRequirementsToken, solveProofToken } from "../pow/solve.ts";
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

/** 浏览器会带的头。少一个都可能被判成脚本。 */
export function browserHeaders(auth: StoredAuth): Record<string, string> {
  const ua = auth.userAgent.length > 0
    ? auth.userAgent
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "accept-language": auth.languages.join(",") + (auth.languages.length > 0 ? ",en;q=0.9" : "en;q=0.9"),
    "content-type": "application/json",
    "user-agent": ua,
    origin: BASE,
    referer: BASE + "/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "accept-encoding": "gzip, deflate, br, zstd",
  };
  // sec-ch-ua 从 UA 的 Chrome 版本推导；对不上会被判"环境异常"。
  const m = ua.match(/Chrome\/(\d+)/u);
  const major = m === null ? "156" : m[1];
  headers["sec-ch-ua"] = '"Chromium";v="' + major + '", "Not.A/Brand";v="24", "Google Chrome";v="' + major + '"';
  headers["sec-ch-ua-mobile"] = "?0";
  headers["sec-ch-ua-platform"] = '"Windows"';
  if (auth.cookieHeader !== null) headers.cookie = auth.cookieHeader;
  return headers;
}

/** Cloudflare 的拦截页是 HTML，而正常响应是 JSON —— 用这个区分。 */
export function looksLikeCloudflare(status: number, body: string): boolean {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  const head = body.slice(0, 2000).toLowerCase();
  return head.includes("cloudflare") || head.includes("<html") || head.includes("cf-") || head.includes("just a moment");
}

export interface NodeTurnInput {
  readonly auth: StoredAuth;
  readonly prompt: string;
  readonly conversationId: string | null;
  readonly parentMessageId: string | null;
  readonly userMessageId: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export async function nodeTurn(input: NodeTurnInput): Promise<NodeTurnResult> {
  const t0 = Date.now();
  const auth = input.auth;
  const headers = browserHeaders(auth);
  headers.authorization = "Bearer " + auth.accessToken;

  const cfg = buildPowConfig({
    userAgent: headers["user-agent"],
    languages: auth.languages,
    hardwareConcurrency: 8,
    screenWidth: 1920,
    dataBuild: auth.dataBuild,
    uuid: crypto.randomUUID(),
    perfNow: 1,
  });

  let sentinelToken: string | null = null;
  let powRequired: { required: boolean; seed: string; difficulty: string } | null = null;
  try {
    const req = solveRequirementsToken(cfg);
    const senRes = await fetch(BASE + "/backend-api/sentinel/chat-requirements", {
      method: "POST",
      headers,
      body: JSON.stringify({ p: req.token }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!senRes.ok) {
      const body = await senRes.text().catch(() => "");
      return {
        transport: "node",
        status: senRes.status,
        frames: [],
        sawDone: false,
        ttfbMs: Date.now() - t0,
        totalMs: Date.now() - t0,
        failure: looksLikeCloudflare(senRes.status, body) ? "cloudflare" : "unknown",
        errorBody: body.slice(0, 600),
      };
    }
    const sen = (await senRes.json()) as Record<string, unknown>;
    if (typeof sen.token === "string") sentinelToken = sen.token;
    const pow = sen.proofofwork as Record<string, unknown> | undefined;
    if (pow !== undefined && pow.required === true) {
      powRequired = { required: true, seed: String(pow.seed), difficulty: String(pow.difficulty) };
    }
  } catch (e) {
    return {
      transport: "node",
      status: 0,
      frames: [],
      sawDone: false,
      ttfbMs: Date.now() - t0,
      totalMs: Date.now() - t0,
      failure: "network",
      errorBody: String(e instanceof Error ? e.message : e).slice(0, 300),
    };
  }

  if (sentinelToken !== null) headers["openai-sentinel-chat-requirements-token"] = sentinelToken;
  if (powRequired !== null) {
    try {
      headers["openai-sentinel-proof-token"] = solveProofToken(powRequired, cfg).token;
    } catch {
      return {
        transport: "node",
        status: 0,
        frames: [],
        sawDone: false,
        ttfbMs: Date.now() - t0,
        totalMs: Date.now() - t0,
        failure: "unknown",
        errorBody: "PoW 求解失败",
      };
    }
  }

  const payload: Record<string, unknown> = {
    action: "next",
    messages: [{ id: input.userMessageId, author: { role: "user" }, content: { content_type: "text", parts: [input.prompt] } }],
    parent_message_id: input.parentMessageId ?? "client-created-root",
    model: input.model,
    timezone_offset_min: new Date().getTimezoneOffset(),
    history_and_training_disabled: false,
    conversation_mode: { kind: "primary_assistant" },
    force_paragen: false,
    force_rate_limit: false,
    suggestions: [],
    supported_encodings: ["v1"],
    system_hints: [],
    supports_buffering: true,
    client_contextual_info: {
      is_dark_mode: false,
      time_since_loaded: 42,
      page_height: 900,
      page_width: 1280,
      pixel_ratio: 1,
      screen_height: 1080,
      screen_width: 1920,
    },
  };
  if (input.conversationId !== null) payload.conversation_id = input.conversationId;

  const tSend = Date.now();
  let res: Response;
  try {
    res = await fetch(BASE + "/backend-api/conversation", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      transport: "node",
      status: 0,
      frames: [],
      sawDone: false,
      ttfbMs: Date.now() - tSend,
      totalMs: Date.now() - t0,
      failure: "network",
      errorBody: String(e instanceof Error ? e.message : e).slice(0, 300),
    };
  }
  const ttfbMs = Date.now() - tSend;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const cf = looksLikeCloudflare(res.status, body);
    return {
      transport: "node",
      status: res.status,
      frames: [],
      sawDone: false,
      ttfbMs,
      totalMs: Date.now() - t0,
      failure: cf ? "cloudflare" : res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate-limit" : "unknown",
      errorBody: body.slice(0, 600),
    };
  }

  const body = res.body;
  if (body === null) {
    return {
      transport: "node",
      status: res.status,
      frames: [],
      sawDone: false,
      ttfbMs,
      totalMs: Date.now() - t0,
      failure: "unknown",
      errorBody: "响应体为空",
    };
  }

  const reader = body.getReader();
  const dec = new TextDecoder();
  const frames: string[] = [];
  let buf = "";
  let sawDone = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim();
          if (p === "[DONE]") { sawDone = true; continue; }
          if (p.length > 0) frames.push(p);
        }
      }
      if (sawDone) break;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    transport: "node",
    status: res.status,
    frames,
    sawDone,
    ttfbMs,
    totalMs: Date.now() - t0,
    failure: null,
    errorBody: null,
  };
}

export { sha3_512, utf8, toBase64, toHex, concat };