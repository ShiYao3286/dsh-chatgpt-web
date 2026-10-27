import { ok, eq, deepEq, section } from "./harness.mjs";
import { buildConversationRequest, clientContextualInfo } from "../src/wire/conversation.ts";

const ctx = {
  auth: { accessToken: "TOK", planType: "free", userEmailDomain: null },
  sentinel: { persona: "chatgpt-freeaccount", token: "SENT", proofofwork: null, turnstileRequired: true, forceLogin: false },
  proofToken: "PROOF",
  dataBuild: "build123",
  userAgent: "UA",
  languages: ["zh-CN"],
};

const input = {
  prompt: "hello",
  conversationId: null,
  parentMessageId: null,
  userMessageId: "u-1",
  model: "auto",
  timezoneOffsetMin: -480,
  clientContext: clientContextualInfo({}),
};

section("请求头");
{
  const r = buildConversationRequest(ctx, input);
  eq(r.headers["authorization"], "Bearer TOK", "带 Bearer");
  eq(r.headers["openai-sentinel-chat-requirements-token"], "SENT", "带 sentinel token");
  eq(r.headers["openai-sentinel-proof-token"], "PROOF", "带 proof token");
  eq(r.headers["accept"], "text/event-stream", "SSE accept");
  eq(r.headers["content-type"], "application/json", "JSON content-type");
}

section("缺失 token 时不写空头");
{
  const r = buildConversationRequest(
    { ...ctx, sentinel: { ...ctx.sentinel, token: null }, proofToken: null },
    input,
  );
  eq(Object.hasOwn(r.headers, "openai-sentinel-chat-requirements-token"), false, "无 sentinel 时不写头");
  eq(Object.hasOwn(r.headers, "openai-sentinel-proof-token"), false, "无 proof 时不写头");
}

section("请求体：新会话");
{
  const r = buildConversationRequest(ctx, input);
  eq(r.payload.action, "next", "action=next");
  eq(r.payload.parent_message_id, "client-created-root", "新会话 parent 是 client-created-root");
  eq(Object.hasOwn(r.payload, "conversation_id"), false, "新会话不带 conversation_id");
  eq(r.payload.model, "auto", "model");
  deepEq(r.payload.supported_encodings, ["v1"], "编码协商");
  eq(r.payload.history_and_training_disabled, false, "不关历史");
  deepEq(r.payload.system_hints, [], "不强制内置工具");
}

section("请求体：续会话");
{
  const r = buildConversationRequest(ctx, { ...input, conversationId: "c-1", parentMessageId: "m-9" });
  eq(r.payload.conversation_id, "c-1", "带 conversation_id");
  eq(r.payload.parent_message_id, "m-9", "parent 指向上一轮 assistant");
}

section("messages 结构");
{
  const r = buildConversationRequest(ctx, input);
  const msgs = r.payload.messages;
  eq(msgs.length, 1, "只发一条 user");
  eq(msgs[0].id, "u-1", "带 id");
  eq(msgs[0].author.role, "user", "role=user");
  eq(msgs[0].content.content_type, "text", "content_type=text");
  deepEq(msgs[0].content.parts, ["hello"], "parts");
}

section("clientContextualInfo");
{
  const c = clientContextualInfo({ innerHeight: 800, innerWidth: 1200, devicePixelRatio: 2, screenWidth: 2560, screenHeight: 1440 });
  eq(c.page_height, 800, "page_height");
  eq(c.page_width, 1200, "page_width");
  eq(c.pixel_ratio, 2, "pixel_ratio");
  eq(c.screen_width, 2560, "screen_width");
  eq(c.screen_height, 1440, "screen_height");
  eq(c.is_dark_mode, false, "is_dark_mode");
}

section("幂等性：同输入同输出");
{
  const a = buildConversationRequest(ctx, input);
  const b = buildConversationRequest(ctx, input);
  deepEq(a, b, "两次构造完全一致");
}
