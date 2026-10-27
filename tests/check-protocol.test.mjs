import { ok, eq, deepEq, section } from "./harness.mjs";
import {
  renderBootstrap,
  renderReanchor,
  PROTOCOL_VERSION,
  EXCLUDED_TOOL_NAMES,
  TOOL_CALL_PROTOCOL,
} from "../src/protocol/bootstrap.ts";
import { renderToolCatalog } from "../src/protocol/catalog.ts";
import { parseToolCalls, looksLikeToolCall, ToolCallStreamParser } from "../src/protocol/parse.ts";
import { detectUnexecuted, hasUnexecuted } from "../src/protocol/unexecuted.ts";

const env = {
  provider: "chatgpt-web",
  model: "chatgpt-web/chatgpt-free",
  cwd: "E:/ai处理文件",
  platform: "Windows",
  today: "2026-10-27",
  sessionId: "abc12345",
};

const tools = [
  { name: "read", description: "读取文件", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
  { name: "write", description: "写入文件", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
  { name: "pwsh", description: "执行 PowerShell", parameters: { type: "object", properties: { command: { type: "string" } } } },
];

const TC = "<tool_call>";
const TCC = "</tool_call>";
const call = (name, args) => TC + "\n" + JSON.stringify({ name, arguments: args }) + "\n" + TCC;

section("bootstrap：幂等（参与 headHash，必须逐字节稳定）");
{
  const input = { env, tools, catalogBudgetChars: 20000 };
  const a = renderBootstrap(input);
  const b = renderBootstrap(input);
  eq(a.text === b.text, true, "两次渲染逐字节相同");
  eq(a.protocolVersion, PROTOCOL_VERSION, "带出版本号");
  const crlf = renderBootstrap({ env: { ...env, cwd: "E:/ai\r\n处理" }, tools, catalogBudgetChars: 20000 });
  const lf = renderBootstrap({ env: { ...env, cwd: "E:/ai\n处理" }, tools, catalogBudgetChars: 20000 });
  eq(crlf.text === lf.text, true, "CRLF 与 LF 渲染一致");
}

section("bootstrap：内容要件");
{
  const r = renderBootstrap({ env, tools, catalogBudgetChars: 20000 });
  ok(r.text.includes("chatgpt-web"), "含 provider");
  ok(r.text.includes("2026-10-27"), "含日期");
  ok(r.text.includes("Windows"), "含平台");
  ok(r.text.includes("read"), "含工具名");
  ok(r.text.includes("<tool_call>"), "含调用标记说明");
  ok(/文件系统|不能直接|没有别的通道/u.test(r.text), "含能力边界声明");
}

section("协议文本：禁止伪造完成");
{
  ok(TOOL_CALL_PROTOCOL.includes("唯一"), "强调唯一行动手段");
  ok(/不要伪造工具结果/u.test(TOOL_CALL_PROTOCOL), "禁止伪造结果");
  ok(/反斜杠必须写成两个/u.test(TOOL_CALL_PROTOCOL), "明确 Windows 路径转义要求");
}

section("catalog：预算内全部带签名");
{
  const c = renderToolCatalog(tools, { budgetChars: 20000 });
  eq(c.total, 3, "总数 3");
  eq(c.overBudget, false, "未超预算");
  deepEq(c.detailed, ["read", "write", "pwsh"], "三个都带签名");
  eq(c.nameOnly.length, 0, "无降级");
}

section("catalog：超预算时列出省略项，绝不静默砍");
{
  const many = [];
  for (let i = 0; i < 60; i++) {
    many.push({ name: "tool_" + i, description: "第 " + i + " 个工具的说明写得很长很长以撑爆预算", parameters: { type: "object", properties: { a: { type: "string", description: "参数说明也写得很长很长" } } } });
  }
  const c = renderToolCatalog(many, { budgetChars: 1200 });
  eq(c.total, 60, "总数 60");
  ok(c.nameOnly.length > 0, "有工具降级为仅名字：" + c.nameOnly.length);
  eq(c.detailed.length + c.nameOnly.length, 60, "详细 + 仅名字 = 总数，没有丢失");
  ok(c.text.includes(c.nameOnly[0]), "被降级的工具名仍出现：" + c.nameOnly[0]);
}

section("catalog：excluded 工具不出现");
{
  const c = renderToolCatalog(tools, { budgetChars: 20000, exclude: ["pwsh"] });
  eq(c.total, 2, "排除后总数 2");
  deepEq(c.excluded, ["pwsh"], "记录被排除的");
  ok(!c.text.includes("pwsh"), "正文不含被封禁的工具");
}

section("parse：单块 <tool_call>");
{
  const out = parseToolCalls(call("read", { file_path: "a.txt" }));
  eq(out.toolCalls.length, 1, "解析出 1 个调用");
  eq(out.toolCalls[0].name, "read", "工具名");
  deepEq(out.toolCalls[0].arguments, { file_path: "a.txt" }, "参数");
  eq(out.balanced, true, "标记成对闭合");
  eq(out.text.trim(), "", "成功解析后正文清空");
}

section("parse：正文与调用共存");
{
  const out = parseToolCalls("我先看看文件。\n" + call("read", { file_path: "b.txt" }));
  eq(out.toolCalls.length, 1, "仍解析出调用");
  ok(out.text.includes("我先看看文件"), "正文保留");
}

section("parse：多调用");
{
  const out = parseToolCalls(call("read", {}) + "\n" + call("pwsh", { command: "ls" }));
  eq(out.toolCalls.length, 2, "解析出 2 个调用");
  eq(out.toolCalls[0].name, "read", "第一个");
  eq(out.toolCalls[1].name, "pwsh", "第二个");
}

section("parse：Windows 路径反斜杠");
{
  const raw = TC + "\n" + JSON.stringify({ name: "read", arguments: { file_path: "E:\\new\\test" } }) + "\n" + TCC;
  const out = parseToolCalls(raw);
  eq(out.toolCalls.length, 1, "解析成功");
  eq(out.toolCalls[0].arguments.file_path, "E:\\new\\test", "路径逐字还原");
}

section("parse：Windows 路径单反斜杠（\r 陷阱）");
{
  // 模型常写成 "E:\resources"，\r 是合法转义但会被静默变成回车
  const raw = TC + "\n" + '{"name":"read","arguments":{"file_path":"E:\\resources"}}' + "\n" + TCC;
  const out = parseToolCalls(raw);
  const got = out.toolCalls.length > 0 ? out.toolCalls[0].arguments.file_path : null;
  ok(got !== null, "非法转义下仍保住调用");
  if (got !== null) {
    ok(!String(got).includes("\r"), "没有把 \\resources 变成回车");
    eq(String(got), "E:\\resources", "还原为字面量 E:\\resources");
  }
}

section("parse：解析失败不静默丢内容");
{
  const out = parseToolCalls(TC + "\n" + '{"name":"read","arguments":{ BROKEN]' + "\n" + TCC);
  eq(out.toolCalls.length, 0, "没有解析出调用");
  ok(out.unparsed.length > 0 || out.text.trim().length > 0, "内容被保住（unparsed 或 text）");
}

section("parse：looksLikeToolCall");
eq(looksLikeToolCall(call("read", {})), true, "调用形态");
eq(looksLikeToolCall("普通的一段话"), false, "普通文本");

section("流式解析：跨分块标记不泄漏");
{
  const parser = new ToolCallStreamParser();
  const a = parser.feed("<tool_ca");
  ok(!a.text.includes("tool_ca"), "半截标记不泄漏到正文");
  const b = parser.feed('ll>{"name":"read","arguments":{}}</tool_call>');
  const f = parser.flush();
  const all = a.text + b.text + f.text;
  ok(!all.includes("<tool_ca"), "正文里没有半截标记");
  ok(b.toolCalls.length + f.toolCalls.length >= 1, "整块拼完后解析出调用");
}

section("unexecuted：零调用但正文有调用形态");
{
  const f = detectUnexecuted({ text: call("read", {}), toolCalls: [] });
  ok(f.length > 0, "检出 finding");
  ok(f.some((x) => x.kind === "tool-shape-no-call"), "kind = tool-shape-no-call");
  ok(f[0].correction.length > 0, "带纠正语");
}

section("unexecuted：声称已改文件但零调用");
{
  const f = detectUnexecuted({ text: "我已经修改了 config.ts，并保存好了。", toolCalls: [] });
  ok(f.some((x) => x.kind === "claimed-work-no-call"), "检出 claimed-work-no-call");
}

section("unexecuted：有真实调用时不误报");
{
  const f = detectUnexecuted({
    text: "我已经修改了 config.ts。",
    toolCalls: [{ id: "call_1", name: "write", arguments: {} }],
  });
  eq(f.some((x) => x.kind === "claimed-work-no-call"), false, "有真调用时不报");
}

section("unexecuted：将来时不误报");
{
  const f = detectUnexecuted({ text: "我接下来会修改 config.ts。", toolCalls: [] });
  eq(f.some((x) => x.kind === "claimed-work-no-call"), false, "将来时不算矛盾");
}

section("unexecuted：干净回答不误报");
{
  eq(hasUnexecuted({ text: "这个文件里有三个函数。", toolCalls: [] }), false, "普通回答无 finding");
}

section("renderReanchor：短小且重申工具");
{
  const c = renderToolCatalog(tools, { budgetChars: 20000 });
  const t = renderReanchor(c);
  ok(t.length > 0, "非空");
  ok(t.length < 1200, "够短（" + t.length + " 字符）");
  ok(t.includes("<tool_call>") || t.includes("read"), "重申了调用方式");
}

section("EXCLUDED_TOOL_NAMES：内置能力不重复建设");
{
  ok(EXCLUDED_TOOL_NAMES.length > 0, "非空");
  ok(EXCLUDED_TOOL_NAMES.includes("web_search"), "排除 web_search（交给内置联网）");
  ok(EXCLUDED_TOOL_NAMES.includes("python"), "排除 python（交给内置沙箱）");
}
