import { ok, eq, deepEq, section } from "./harness.mjs";
import {
  listModels,
  shouldUseWeb,
  localTitle,
  localCompactionSummary,
  MODELS,
  PROVIDER_ROUTE,
  CONTEXT_WINDOW,
  toResponse,
  failureCodeOf,
} from "../src/adapter.ts";
import { interpretFrames } from "../src/wire/turn.ts";

section("listModels：GUI 需要它才能选模型");
{
  const m = listModels();
  eq(m.length, MODELS.length, "返回全部模型");
  eq(m[0].id, "chatgpt-free", "模型 id");
  eq(m[0].contextWindow, CONTEXT_WINDOW, "声明 contextWindow");
  ok(m[0].maxTokens > 0, "声明 maxTokens");
  ok(typeof m[0].name === "string" && m[0].name.length > 0, "有显示名");
  // 必须返回副本，调用方改动不能污染全局
  m[0].name = "HACKED";
  eq(listModels()[0].name !== "HACKED", true, "返回的是副本");
}

section("purpose 分流：只有 chat 花额度");
eq(shouldUseWeb(undefined), true, "未指定 purpose 按 chat 处理");
eq(shouldUseWeb("chat"), true, "chat 走网页端");
eq(shouldUseWeb("session-title"), false, "session-title 不走网页端（零请求）");
eq(shouldUseWeb("compaction"), false, "compaction 不走网页端（不吃额度）");

section("localTitle：本地合成标题");
{
  eq(localTitle("帮我重构一下这个模块"), "帮我重构一下这个模块", "短文本原样");
  const long = "a".repeat(100);
  const t = localTitle(long, 24);
  eq(t.length, 25, "截断到 24 + 省略号");
  ok(t.endsWith("…"), "带省略号");
  eq(localTitle("   "), "新会话", "空白输入有兜底");
  eq(localTitle("多行\n文本\n标题"), "多行 文本 标题", "换行归一为空格");
}

section("localCompactionSummary：本地模板");
{
  const s = localCompactionSummary({ turns: 12, lastUserText: "把 tests 补上" });
  ok(s.includes("12"), "含轮数");
  ok(s.includes("把 tests 补上"), "含最后请求");
  ok(s.includes("[压缩摘要]"), "有明确标记");
  const empty = localCompactionSummary({ turns: 0, lastUserText: "  " });
  ok(empty.includes("(空)"), "空请求有兜底");
}

section("interpretFrames：完整一轮");
{
  const frames = [
    JSON.stringify({ v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["PONG"] }, status: "in_progress" } } }),
    JSON.stringify({ o: "patch", v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }, { p: "/message/metadata", o: "append", v: { finish_details: { type: "stop" } } }] }),
  ];
  const r = interpretFrames({ status: 200, frames, sawDone: true, ttfbMs: 100, totalMs: 900, failure: null, errorBody: null });
  eq(r.ok, true, "ok 为真");
  eq(r.text, "PONG", "正文");
  eq(r.messageId, "a1", "messageId");
  eq(r.finishType, "stop", "finishType");
  eq(r.failure, null, "无失败");
}

section("interpretFrames：空正文不算成功");
{
  const r = interpretFrames({ status: 200, frames: [], sawDone: true, ttfbMs: 10, totalMs: 20, failure: null, errorBody: null });
  eq(r.ok, false, "没有正文 -> 不 ok");
}

section("interpretFrames：没收到 [DONE] 不算成功");
{
  const frames = [JSON.stringify({ v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["半截"] } } } })];
  const r = interpretFrames({ status: 200, frames, sawDone: false, ttfbMs: 10, totalMs: 20, failure: null, errorBody: null });
  eq(r.ok, false, "流被截断 -> 不 ok（不假装成功）");
  eq(r.text, "半截", "但正文仍保留，不丢内容");
}

section("interpretFrames：限流识别");
{
  const frames = [JSON.stringify({ v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] }, metadata: { finish_details: { type: "rate_limit" } } } } })];
  const r = interpretFrames({ status: 200, frames, sawDone: true, ttfbMs: 10, totalMs: 20, failure: null, errorBody: null });
  eq(r.failure, "rate-limit", "识别 rate_limit");
  eq(r.ok, false, "限流不算成功");
}

section("failureCodeOf：稳定失败码");
eq(failureCodeOf("auth"), "AUTH", "auth -> AUTH");
eq(failureCodeOf("no-token"), "AUTH", "no-token -> AUTH");
eq(failureCodeOf("rate-limit"), "RATE_LIMIT", "rate-limit -> RATE_LIMIT");
eq(failureCodeOf("message-limit"), "QUOTA", "message-limit -> QUOTA");
eq(failureCodeOf("network"), "CONNECTION", "network -> CONNECTION");
eq(failureCodeOf("pow-failed"), "PROVIDER_ERROR", "pow-failed -> PROVIDER_ERROR");
eq(failureCodeOf("unknown"), "PROVIDER_ERROR", "unknown -> PROVIDER_ERROR");
eq(failureCodeOf(null), null, "无失败返回 null");

section("POST 失败映射");
{
  const r401 = interpretFrames({ status: 401, frames: [], sawDone: false, ttfbMs: 1, totalMs: 2, failure: "auth", errorBody: "unauthorized" });
  eq(r401.ok, false, "401 不 ok");
  eq(r401.failure, "auth", "401 -> auth");
  const r429 = interpretFrames({ status: 429, frames: [], sawDone: false, ttfbMs: 1, totalMs: 2, failure: "rate-limit", errorBody: "too many" });
  eq(r429.failure, "rate-limit", "429 -> rate-limit");
}

section("toResponse 与 interpretFrames 等价");
{
  const raw = { status: 200, frames: [JSON.stringify({ v: { message: { id: "a", author: { role: "assistant" }, content: { content_type: "text", parts: ["X"] } } } })], sawDone: true, ttfbMs: 1, totalMs: 2, failure: null, errorBody: null };
  deepEq(toResponse(raw), interpretFrames(raw), "两条路径结果一致");
}

section("PROVIDER_ROUTE");
eq(PROVIDER_ROUTE, "chatgpt-web", "路由名固定");

section("审查修复：失败必须有分类，不能只给 ok=false");
{
  // 空响应：200 + DONE 但没有正文
  const r1 = interpretFrames({ status: 200, frames: [], sawDone: true, ttfbMs: 1, totalMs: 2, failure: null, errorBody: null });
  eq(r1.ok, false, "空响应不 ok");
  eq(r1.failure, "empty-response", "空响应归类 empty-response");
  eq(failureCodeOf(r1.failure), "EMPTY_RESPONSE", "映射为 EMPTY_RESPONSE");

  // 纯空白正文也不算成功
  const blank = JSON.stringify({ v: { message: { id: "a", author: { role: "assistant" }, content: { content_type: "text", parts: ["   \n  "] } } } });
  const r2 = interpretFrames({ status: 200, frames: [blank], sawDone: true, ttfbMs: 1, totalMs: 2, failure: null, errorBody: null });
  eq(r2.ok, false, "纯空白不 ok");
  eq(r2.failure, "empty-response", "纯空白归类 empty-response");

  // 断流：有正文但没 [DONE]
  const partial = JSON.stringify({ v: { message: { id: "a", author: { role: "assistant" }, content: { content_type: "text", parts: ["半截回答"] } } } });
  const r3 = interpretFrames({ status: 200, frames: [partial], sawDone: false, ttfbMs: 1, totalMs: 2, failure: null, errorBody: null });
  eq(r3.ok, false, "断流不 ok");
  eq(r3.failure, "truncated", "断流归类 truncated");
  eq(failureCodeOf(r3.failure), "TRUNCATED", "映射为 TRUNCATED");
  eq(r3.text, "半截回答", "但正文仍保留，不丢内容");

  // 任何 ok=false 都必须有 failure 分类 —— 这是调用方能路由的前提
  const allFalse = [r1, r2, r3, interpretFrames({ status: 500, frames: [], sawDone: false, ttfbMs: 1, totalMs: 2, failure: null, errorBody: "x" })];
  for (const r of allFalse) {
    ok(r.failure !== null, "ok=false 时 failure 非 null（status=" + r.status + "）");
  }
}
