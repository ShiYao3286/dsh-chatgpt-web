/**
 * 会话请求构造 + 发送。
 *
 * 全部在页面上下文里执行（见 src/transport/page-bundle.ts）。这里只放纯函数，
 * 方便离线测试：给定输入必然得到同一份请求体。
 */

import type { SendContext } from "./types.ts";

export interface BuildRequestInput {
  prompt: string;
  /** 若为 null，则开新会话；否则续在已有会话上。 */
  conversationId: string | null;
  parentMessageId: string | null;
  userMessageId: string;
  model: string;
  timezoneOffsetMin: number;
  clientContext: Record<string, unknown>;
}

export interface ConversationRequest {
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

export function buildConversationRequest(ctx: SendContext, input: BuildRequestInput): ConversationRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: "Bearer " + ctx.auth.accessToken,
  };
  if (ctx.sentinel.token !== null) {
    headers["openai-sentinel-chat-requirements-token"] = ctx.sentinel.token;
  }
  if (ctx.proofToken !== null) {
    headers["openai-sentinel-proof-token"] = ctx.proofToken;
  }

  const payload: Record<string, unknown> = {
    action: "next",
    messages: [
      {
        id: input.userMessageId,
        author: { role: "user" },
        content: { content_type: "text", parts: [input.prompt] },
      },
    ],
    parent_message_id: input.parentMessageId ?? "client-created-root",
    model: input.model,
    timezone_offset_min: input.timezoneOffsetMin,
    history_and_training_disabled: false,
    conversation_mode: { kind: "primary_assistant" },
    force_paragen: false,
    force_rate_limit: false,
    suggestions: [],
    supported_encodings: ["v1"],
    system_hints: [],
    supports_buffering: true,
    client_contextual_info: input.clientContext,
  };
  if (input.conversationId !== null) {
    payload.conversation_id = input.conversationId;
  }

  return { headers, payload };
}

/** 站点要求的客户端上下文；数值取自真实页面，缺失时用保守默认。 */
export function clientContextualInfo(env: {
  innerHeight?: number;
  innerWidth?: number;
  devicePixelRatio?: number;
  screenWidth?: number;
  screenHeight?: number;
  timeSinceLoadedSec?: number;
}): Record<string, unknown> {
  return {
    is_dark_mode: false,
    time_since_loaded: env.timeSinceLoadedSec ?? 42,
    page_height: env.innerHeight ?? 900,
    page_width: env.innerWidth ?? 1280,
    pixel_ratio: env.devicePixelRatio ?? 1,
    screen_height: env.screenHeight ?? 1080,
    screen_width: env.screenWidth ?? 1920,
  };
}
