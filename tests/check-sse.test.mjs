import { ok, eq, deepEq, section } from "./harness.mjs";
import { classifyFrame, TurnAccumulator } from "../src/wire/sse.ts";

section("classifyFrame：编码协商");
eq(classifyFrame('"v1"').kind, "encoding", '"v1" 是编码协商');
eq(classifyFrame("v1").kind, "encoding", "裸 v1 也是");

section("classifyFrame：message 帧");
const msgFrame = classifyFrame(JSON.stringify({
  v: { message: { id: "m1", author: { role: "assistant" }, content: { content_type: "text", parts: ["PONG"] }, status: "in_progress" } },
}));
eq(msgFrame.kind, "message", "识别为 message");
eq(msgFrame.kind === "message" ? msgFrame.message.id : null, "m1", "取出 message id");

section("classifyFrame：patch 帧");
const patchFrame = classifyFrame(JSON.stringify({ o: "patch", v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }] }));
eq(patchFrame.kind, "patch", "o=patch 且 v 是数组");
eq(patchFrame.kind === "patch" ? patchFrame.ops.length : 0, 1, "取出一条 op");

section("classifyFrame：update 帧");
const upd = classifyFrame(JSON.stringify({ p: "/message/metadata/conversation_followup_suggestions_eligible", o: "replace", v: true }));
eq(upd.kind, "update", "单条 patch 识别为 update");
eq(upd.kind === "update" ? upd.path : "", "/message/metadata/conversation_followup_suggestions_eligible", "路径正确");

section("classifyFrame：event 帧");
const ev = classifyFrame(JSON.stringify({ type: "title_generation", title: "T", conversation_id: "c9" }));
eq(ev.kind, "event", "带 type 的是 event");
eq(ev.kind === "event" ? ev.type : "", "title_generation", "事件名");

section("classifyFrame：异常输入不崩");
eq(classifyFrame("").kind, "unknown", "空串");
eq(classifyFrame("not json").kind, "unknown", "非 JSON");
eq(classifyFrame("null").kind, "unknown", "null");
eq(classifyFrame("123").kind, "unknown", "数字");

section("TurnAccumulator：完整一轮（真实帧序列）");
{
  const acc = new TurnAccumulator();
  // system 消息（应忽略）
  acc.push(classifyFrame(JSON.stringify({ p: "", o: "add", v: { message: { id: "s1", author: { role: "system" }, content: { content_type: "text", parts: [""] } } } })));
  // user 回显（应忽略）
  acc.push(classifyFrame(JSON.stringify({ v: { message: { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] } } } })));
  // assistant 正文
  acc.push(classifyFrame(JSON.stringify({ v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["PONG"] }, status: "in_progress", metadata: {} } } })));
  eq(acc.textValue, "PONG", "取出正文");
  eq(acc.messageId, "a1", "记录 message id");
  // 终态 patch
  acc.push(classifyFrame(JSON.stringify({ o: "patch", v: [
    { p: "/message/status", o: "replace", v: "finished_successfully" },
    { p: "/message/end_turn", o: "replace", v: true },
    { p: "/message/metadata", o: "append", v: { finish_details: { type: "stop" }, is_complete: true } },
  ] })));
  eq(acc.statusValue, "finished_successfully", "终态 status");
  eq(acc.finishType, "stop", "finish_details.type");
  eq(acc.complete, true, "complete 为真");
  eq(acc.rateLimited, false, "未被限流");
}

section("TurnAccumulator：增量 patch 拼接");
{
  const acc = new TurnAccumulator();
  acc.push(classifyFrame(JSON.stringify({ v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] }, status: "in_progress" } } })));
  acc.push(classifyFrame(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "Hello" })));
  acc.push(classifyFrame(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: " world" })));
  eq(acc.textValue, "Hello world", "增量拼接");
  acc.push(classifyFrame(JSON.stringify({ p: "/message/content/parts/0", o: "replace", v: "Reset" })));
  eq(acc.textValue, "Reset", "replace 覆盖");
}

section("TurnAccumulator：限流识别");
{
  const acc = new TurnAccumulator();
  acc.push(classifyFrame(JSON.stringify({ v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] }, metadata: { finish_details: { type: "rate_limit" } } } } })));
  eq(acc.rateLimited, true, "识别 rate_limit");
}

section("TurnAccumulator：title_generation 带出 conversation_id");
{
  const acc = new TurnAccumulator();
  acc.push(classifyFrame(JSON.stringify({ type: "title_generation", title: "T", conversation_id: "c-42" })));
  eq(acc.conversationId, "c-42", "从事件里取 conversation_id");
}
