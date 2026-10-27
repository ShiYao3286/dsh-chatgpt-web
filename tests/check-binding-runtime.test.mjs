import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok, eq, deepEq, section } from "./harness.mjs";
import { Gate } from "../src/gate/gate.ts";
import { headHashOf } from "../src/binding/state.ts";
import {
  MAX_ITEMS,
  checkpointPath,
  buildCheckpointRequest,
  buildRotateSeed,
  fileCheckpointStore,
  memoryCheckpointStore,
  parseCheckpoint,
  planCheckpoint,
  redactSecrets,
  renderCheckpoint,
  stripHandoffBlock,
  HANDOFF_OPEN,
  HANDOFF_CLOSE,
} from "../src/binding/checkpoint.ts";
import {
  auditBinding,
  classifyProbe,
  evaluateReactivate,
  extractMessageIds,
  probeRequest,
  shouldProbe,
} from "../src/binding/reactivate.ts";
import {
  BindingRuntime,
  RE_ANCHOR_TEXT,
  composeUserPayload,
  fileBindingStore,
  memoryBindingStore,
  shouldDropBinding,
} from "../src/binding/runtime.ts";
import {
  FAILURE_KINDS,
  createLedger,
  intervalStats,
  intervalsOf,
  kindFromGateReason,
  makeRecord,
  memoryLedger,
  percentile,
  pruneRecords,
  retentionCutoff,
  summarize,
} from "../src/gate/ledger.ts";

/* ------------------------------------------------------------------ */
/* 公用脚手架                                                          */
/* ------------------------------------------------------------------ */

const BOOT = "你是 DSH 的工具协议代理。";
const TOOLS = "dsh_tool: read / write / exec";
const PROTO = 1;
const HEAD = headHashOf(BOOT, TOOLS, PROTO);

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; },
  };
}

/** 闸门全开：只用来隔离绑定路由逻辑。 */
function permissiveGate(c) {
  return new Gate(
    {
      minIntervalMs: 0,
      maxIntervalMs: 0,
      longRunThreshold: 1_000_000,
      longRestMinMs: 0,
      longRestMaxMs: 0,
      rateWindowMs: 1000,
      rateMaxInWindow: 1_000_000,
    },
    c.now,
  );
}

function mkBinding(over = {}) {
  return {
    conversationId: "c1",
    parentMessageId: "m1",
    headHash: HEAD,
    lastEntries: ["u1", "a1"],
    turns: 2,
    createdAt: 0,
    ...over,
  };
}

function mkPersisted(binding, over = {}) {
  return {
    version: 1,
    savedAt: 0,
    binding,
    consecutiveFailures: 0,
    lastUsedAt: null,
    lastCheckpointTurns: null,
    ...over,
  };
}

function makeRuntime(over = {}) {
  const c = over.clock ?? clock();
  return new BindingRuntime({
    bootstrap: BOOT,
    toolCatalog: TOOLS,
    protocolVersion: PROTO,
    now: c.now,
    gate: permissiveGate(c),
    store: memoryBindingStore(null),
    checkpointStore: memoryCheckpointStore(null),
    ledger: memoryLedger(),
    newId: (() => { let n = 0; return () => "id-" + ++n; })(),
    // 默认探针：假装会话还在。重启路径的用例会显式覆盖它来验"不匹配就 rotate"。
    probe: () => "alive",
    ...over,
  });
}

/** 成功收尾一次请求。 */
async function completeTurn(rt, plan, over = {}) {
  return rt.finishTurn({
    ok: true,
    conversationId: plan.conversationId ?? "c-new",
    messageId: "m-new",
    status: 200,
    ttfbMs: 120,
    ...over,
  });
}

/* ------------------------------------------------------------------ */
section("checkpoint：在软水位之前触发");
/* ------------------------------------------------------------------ */

{
  const base = { softTurns: 10, margin: 3, lastCheckpointTurns: null };
  const p0 = planCheckpoint({ ...base, turns: 0 });
  eq(p0.due, false, "还没有轮次 -> 不要");
  eq(p0.reason, "no-turns", "原因 no-turns");
  eq(p0.dueAt, 7, "dueAt = softTurns - margin");
  ok(p0.dueAt < 10, "dueAt 严格小于软水位");

  const p6 = planCheckpoint({ ...base, turns: 6 });
  eq(p6.due, false, "第 6 轮（软水位前 4 轮）还不要");
  eq(p6.reason, "not-due", "原因 not-due");

  const p7 = planCheckpoint({ ...base, turns: 7 });
  eq(p7.due, true, "第 7 轮触发（软水位之前）");
  eq(p7.reason, "before-soft-watermark", "原因 before-soft-watermark");
  eq(p7.remaining, 3, "距软水位还剩 3 轮");
  ok(p7.remaining > 0, "触发时软水位还没到");

  const p9 = planCheckpoint({ ...base, turns: 9 });
  eq(p9.due, true, "第 9 轮仍可补要（还没轮换）");
  eq(p9.remaining, 1, "只剩 1 轮");

  const fresh = planCheckpoint({ ...base, turns: 8, lastCheckpointTurns: 7 });
  eq(fresh.due, false, "刚拿过检查点 -> 不重复打扰");
  eq(fresh.reason, "fresh", "原因 fresh");

  const stale = planCheckpoint({ ...base, turns: 9, lastCheckpointTurns: 7 });
  eq(stale.due, false, "间隔 2 < margin 3 -> 仍算新鲜");

  // margin 必须被夹到 < softTurns，否则 dueAt 会落在软水位之后（那就来不及了）
  const tiny = planCheckpoint({ turns: 5, softTurns: 5, lastCheckpointTurns: null, margin: 99 });
  ok(tiny.dueAt < 5, "margin 过大时被夹住，dueAt 仍 < softTurns");
}

/* ------------------------------------------------------------------ */
section("checkpoint：交接请求与字段");
/* ------------------------------------------------------------------ */

{
  const req = buildCheckpointRequest();
  ok(req.includes(HANDOFF_OPEN), "索要请求含开标记");
  ok(req.includes(HANDOFF_CLOSE), "索要请求含闭标记");
  ok(req.includes("GOAL:"), "要求 GOAL");
  ok(req.includes("CONFIRMED:"), "要求 CONFIRMED");
  ok(req.includes("CHANGED_FILES:"), "要求 CHANGED_FILES");
  ok(req.includes("VERIFIED:"), "要求 VERIFIED");
  ok(req.includes("UNVERIFIED:"), "要求 UNVERIFIED");
  ok(req.includes("OPEN_BRANCHES:"), "要求 OPEN_BRANCHES");
  ok(req.includes("NEXT_STEP:"), "要求 NEXT_STEP");
  ok(req.includes("DO_NOT_REPEAT:"), "要求 DO_NOT_REPEAT");
  ok(req.includes("不要出现任何令牌"), "明确禁止写凭证");
  ok(!req.includes("Bearer "), "请求本身不含凭证样例");
}

/* ------------------------------------------------------------------ */
section("checkpoint：渲染 / 解析往返");
/* ------------------------------------------------------------------ */

const SAMPLE = {
  goal: "把 chatgpt 网页端接成 DSH provider",
  confirmed: ["CDP 能拿到 auth/session", "PoW 可解"],
  changedFiles: ["src/binding/runtime.ts", "src/gate/ledger.ts"],
  verified: ["node scripts/test-offline.mjs 全绿"],
  unverified: ["真实浏览器端到端"],
  openBranches: ["re-anchor 的提醒文案"],
  nextStep: "写 provider 适配器",
  doNotRepeat: ["不要改 state.ts 的判据"],
};

{
  const rendered = renderCheckpoint(SAMPLE);
  ok(rendered.includes("GOAL: 把 chatgpt"), "渲染 GOAL");
  ok(rendered.includes("- src/binding/runtime.ts"), "渲染列表项");
  ok(!rendered.includes(HANDOFF_OPEN), "渲染正文不含标记（标记由调用方包）");

  const wrapped = HANDOFF_OPEN + "\n" + rendered + "\n" + HANDOFF_CLOSE;
  const parsed = parseCheckpoint(wrapped);
  deepEq(parsed, SAMPLE, "解析结果与原始一致（往返稳定）");
  eq(parseCheckpoint(renderCheckpoint(parsed)).goal, SAMPLE.goal, "二次往返稳定");
}

{
  // 容错：小写键名 / 全角冒号 / 分号分隔 / 中文字段名
  const loose = [
    "goal：重构绑定层",
    "confirmed: a; b",
    "changed_files: x.ts、y.ts",
    "VERIFIED: 跑过测试",
    "未验证: 真机",
    "open branches: 分支一",
    "NEXT_STEP: 收尾",
    "do-not-repeat: 别硬续",
  ].join("\n");
  const p = parseCheckpoint(loose);
  eq(p.goal, "重构绑定层", "全角冒号 + 小写键");
  deepEq(p.confirmed, ["a", "b"], "分号分隔拆成多项");
  deepEq(p.changedFiles, ["x.ts", "y.ts"], "顿号分隔拆成多项");
  deepEq(p.unverified, ["真机"], "中文字段名");
  deepEq(p.openBranches, ["分支一"], "空格式键名 + 中文");
  eq(p.nextStep, "收尾", "NEXT_STEP");
  deepEq(p.doNotRepeat, ["别硬续"], "do-not-repeat");
}

{
  const p = parseCheckpoint("GOAL: 只写了目标");
  eq(p.goal, "只写了目标", "至少一个字段即可解析");
  deepEq(p.confirmed, [], "缺省字段为空数组");
  eq(parseCheckpoint("完全无关的一段话"), null, "没有字段行 -> null");
  eq(parseCheckpoint(""), null, "空串 -> null");
  eq(parseCheckpoint(null), null, "非字符串 -> null");
  eq(parseCheckpoint("CONFIRMED: 无"), null, "全是占位符 -> null");
}

{
  const many = { ...SAMPLE, confirmed: Array.from({ length: 20 }, (_, i) => "fact-" + i) };
  const p = parseCheckpoint(renderCheckpoint(many));
  eq(p.confirmed.length, MAX_ITEMS, "列表被截到 MAX_ITEMS");
  const dup = parseCheckpoint("CONFIRMED: a; a; a");
  deepEq(dup.confirmed, ["a"], "去重");
}

/* ------------------------------------------------------------------ */
section("checkpoint：脱敏与正文剥离");
/* ------------------------------------------------------------------ */

{
  eq(redactSecrets("Authorization: Bearer abcdefghijklmnop"), "Authorization=[REDACTED]", "Bearer 被抹掉");
  ok(!redactSecrets("token sk-1234567890abcdef").includes("sk-1234"), "sk- 被抹掉");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl";
  ok(!redactSecrets("jwt " + jwt).includes(jwt), "JWT 被抹掉");
  eq(redactSecrets("普通文本保持不变"), "普通文本保持不变", "无关文本不动");

  const leaky = parseCheckpoint(
    "GOAL: 用 Bearer abcdefghijklmnop 调接口\nCONFIRMED: Cookie: session=deadbeefcafebabe",
  );
  ok(!JSON.stringify(leaky).includes("abcdefghijklmnop"), "解析时脱敏");
  ok(!JSON.stringify(leaky).includes("deadbeefcafebabe"), "解析时脱敏 cookie");
}

{
  const reply = "做法是这样的。\n\n" + HANDOFF_OPEN + "\nGOAL: x\n" + HANDOFF_CLOSE + "\n\n完。";
  const cleaned = stripHandoffBlock(reply);
  ok(!cleaned.includes(HANDOFF_OPEN), "剥离开标记");
  ok(!cleaned.includes("GOAL: x"), "剥离块内内容");
  ok(cleaned.includes("做法是这样的。"), "保留正文前段");
  ok(cleaned.includes("完。"), "保留正文后段");
  eq(stripHandoffBlock("没有交接块"), "没有交接块", "无块时原样返回");
  eq(stripHandoffBlock(""), "", "空串原样返回");
}

/* ------------------------------------------------------------------ */
section("checkpoint：落盘");
/* ------------------------------------------------------------------ */

{
  ok(checkpointPath().endsWith("checkpoint.json"), "检查点路径以 checkpoint.json 结尾");
  ok(checkpointPath() !== "", "检查点路径可用");
}

{
  const dir = await mkdtemp(join(tmpdir(), "dsh-cp-"));
  try {
    const file = join(dir, "checkpoint.json");
    const store = fileCheckpointStore(file);
    eq(await store.load(), null, "文件不存在 -> null");

    const envelope = { version: 1, savedAt: 1234, turns: 9, checkpoint: SAMPLE };
    await store.save(envelope);
    const loaded = await store.load();
    deepEq(loaded, envelope, "落盘后能读回同一份");

    const raw = await readFile(file, "utf8");
    ok(raw.includes("把 chatgpt 网页端接成 DSH provider"), "文件里确实是检查点内容");
    ok(raw.includes('"version": 1'), "带版本号");

    await writeFile(file, "{ 不是 json", "utf8");
    eq(await store.load(), null, "坏 JSON -> null（不抛）");

    await writeFile(file, JSON.stringify({ version: 99, savedAt: 1, turns: 1, checkpoint: SAMPLE }), "utf8");
    eq(await store.load(), null, "版本不符 -> null");

    await writeFile(file, JSON.stringify({ version: 1, savedAt: 1, turns: 1, checkpoint: {} }), "utf8");
    eq(await store.load(), null, "空检查点 -> null");

    await store.save(envelope);
    await store.clear();
    eq(await store.load(), null, "clear 之后读不到");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
section("checkpoint：轮换种子");
/* ------------------------------------------------------------------ */

{
  const entries = ["u1", "a1", "u2", "a2", "u3", "a3"];
  const seed = buildRotateSeed({ bootstrap: BOOT, checkpoint: SAMPLE, entries, recentTurns: 2 });
  ok(seed.hasCheckpoint, "带上了检查点");
  ok(seed.text.includes("[固定头]"), "带固定头");
  ok(seed.text.includes(BOOT), "固定头内容是 bootstrap");
  ok(seed.text.includes("[状态交接]"), "带状态交接段");
  ok(seed.text.includes("NEXT_STEP:"), "交接里有下一步");
  ok(seed.text.includes("[最近 4 条]"), "最近 2 轮 = 4 条");
  eq(seed.recentCount, 4, "recentCount 正确");
  ok(seed.text.includes("u3") && seed.text.includes("a3"), "保留最新条目");
  ok(!seed.text.includes("u1"), "更早的条目被丢掉");
  eq(seed.truncated, false, "未超长不截断");

  const noCp = buildRotateSeed({ bootstrap: BOOT, checkpoint: null, entries, recentTurns: 2 });
  eq(noCp.hasCheckpoint, false, "没有检查点时不编造");
  ok(!noCp.text.includes("[状态交接]"), "没有交接段");

  const big = buildRotateSeed({
    bootstrap: BOOT,
    checkpoint: SAMPLE,
    entries: Array.from({ length: 40 }, (_, i) => "很长的条目 " + i + " " + "x".repeat(400)),
    recentTurns: 20,
  });
  eq(big.truncated, true, "超长被截断");
  ok(big.text.length <= 12_100, "截断后仍在限额内");
  ok(big.text.startsWith("…（较早内容已省略）"), "截断保留尾部（最新内容）");
}

/* ------------------------------------------------------------------ */
section("reactivate：结构性体检");
/* ------------------------------------------------------------------ */

{
  eq(auditBinding(null).ok, false, "null 不通过");
  eq(auditBinding(null).reason, "no-binding", "原因 no-binding");
  eq(auditBinding("字符串").reason, "corrupt", "非对象 corrupt");
  eq(auditBinding({}).reason, "corrupt", "空对象 corrupt");
  eq(auditBinding(mkBinding({ conversationId: "" })).reason, "corrupt", "空 conversationId corrupt");
  eq(auditBinding(mkBinding({ parentMessageId: 7 })).reason, "corrupt", "parent 类型错 corrupt");
  eq(auditBinding(mkBinding({ headHash: "" })).reason, "corrupt", "空 headHash corrupt");
  eq(auditBinding(mkBinding({ turns: -1 })).reason, "corrupt", "负 turns corrupt");
  eq(auditBinding(mkBinding({ turns: 1.5 })).reason, "corrupt", "非整 turns corrupt");
  eq(auditBinding(mkBinding({ createdAt: "x" })).reason, "corrupt", "createdAt 类型错 corrupt");
  eq(auditBinding(mkBinding({ lastEntries: "x" })).reason, "corrupt", "lastEntries 类型错 corrupt");
  eq(auditBinding(mkBinding()).ok, true, "合法绑定通过");
  eq(auditBinding(mkBinding({ parentMessageId: null })).ok, true, "parent 可为 null");
}

/* ------------------------------------------------------------------ */
section("reactivate：任何不匹配一律 rotate");
/* ------------------------------------------------------------------ */

function evalAt(over = {}) {
  return evaluateReactivate({
    binding: mkBinding(),
    headHash: HEAD,
    softTurns: 25,
    hardTurns: 40,
    maxIdleMs: 60_000,
    lastUsedAt: 1_000_000,
    now: 1_010_000,
    probe: null,
    ...over,
  });
}

{
  const good = evalAt();
  eq(good.reuse, true, "全部匹配 -> 可复用（但仍需探针）");
  eq(good.rotate, false, "不强制轮换");
  eq(good.needsProbe, true, "必须在复用前做零成本探针");
  eq(shouldProbe(good), true, "shouldProbe 为真");
}

{
  const cases = [
    ["", { probe: "gone" }, "probe-gone"],
    ["", { probe: "parent-missing" }, "probe-parent-missing"],
    ["", { probe: "unknown" }, "probe-unknown"],
    ["", { headHash: "deadbeefdeadbeef" }, "head-changed"],
    ["", { binding: mkBinding({ turns: 40 }) }, "turns-exceeded"],
    ["", { binding: mkBinding({ turns: 41 }) }, "turns-exceeded"],
    ["", { lastUsedAt: 0 }, "idle-expired"],
    ["", { lastUsedAt: 1_020_000 }, "future-timestamp"],
    ["", { binding: null }, "no-binding"],
    ["", { binding: { nope: true } }, "corrupt"],
  ];
  for (const [, over, expected] of cases) {
    const d = evalAt(over);
    eq(d.rotate, true, expected + " -> 必须 rotate");
    eq(d.reuse, false, expected + " -> 不复用");
    eq(d.reason, expected, expected + " -> 原因正确");
    eq(shouldProbe(d), false, expected + " -> 不再花探针");
  }
}

{
  // 软水位也拦：重启后轮次到软水位同样不能硬续
  const soft = evalAt({ binding: mkBinding({ turns: 25 }) });
  eq(soft.rotate, true, "到软水位 -> rotate");
  eq(soft.reason, "turns-exceeded", "原因 turns-exceeded");

  // 探针说还在，可以复用
  const alive = evalAt({ probe: "alive" });
  eq(alive.reuse, true, "探针 alive -> 复用");
  eq(alive.needsProbe, false, "探针已完成");
  eq(shouldProbe(alive), false, "不需要再探");

  // 闲置刚好等于上限：不算过期（边界用 > 而不是 >=）
  const edge = evalAt({ lastUsedAt: 1_000_000, now: 1_060_000 });
  eq(edge.reuse, true, "闲置恰好等于上限 -> 仍可复用");

  // lastUsedAt 未知时不做闲置判断
  const unknown = evalAt({ lastUsedAt: null });
  eq(unknown.reuse, true, "空闲时刻未知 -> 不据此轮换");
}

/* ------------------------------------------------------------------ */
section("reactivate：探针分类与请求形态");
/* ------------------------------------------------------------------ */

{
  eq(classifyProbe({ status: 200, body: "{}", parentMessageId: "m1", messageIds: ["m1"] }), "alive", "200 + parent 在 -> alive");
  eq(classifyProbe({ status: 200, body: "{}", parentMessageId: "m1", messageIds: null }), "alive", "拿不到消息列表时不判死");
  eq(classifyProbe({ status: 200, body: "{}", parentMessageId: "m1", messageIds: ["m2"] }), "parent-missing", "parent 不在 -> parent-missing");
  eq(classifyProbe({ status: 404, body: "", parentMessageId: "m1", messageIds: null }), "gone", "404 -> gone");
  eq(classifyProbe({ status: 410, body: "", parentMessageId: "m1", messageIds: null }), "gone", "410 -> gone");
  eq(classifyProbe({ status: 200, body: '{"detail":"not found"}', parentMessageId: "m1", messageIds: null }), "gone", "正文 not found -> gone");
  eq(classifyProbe({ status: 0, body: null, parentMessageId: "m1", messageIds: null }), "unknown", "网络失败 -> unknown");
  eq(classifyProbe({ status: 500, body: "", parentMessageId: "m1", messageIds: null }), "unknown", "5xx -> unknown");
  eq(classifyProbe({ status: 403, body: "", parentMessageId: "m1", messageIds: null }), "unknown", "403 -> unknown（不是死）");
  eq(classifyProbe({ status: 429, body: "", parentMessageId: "m1", messageIds: null }), "unknown", "429 -> unknown");

  const req = probeRequest("c 1");
  eq(req.method, "GET", "探针用 GET");
  ok(req.path.startsWith("/backend-api/conversation/"), "打会话详情接口");
  ok(req.path.includes("c%201"), "conversationId 被转义");

  eq(extractMessageIds({ mapping: { a: { id: "a" }, b: { id: "b" } } }).length, 2, "从 mapping 抽 id");
  eq(extractMessageIds({ items: [{ id: "x" }] })[0], "x", "从 items 抽 id");
  eq(extractMessageIds("{\"mapping\":{\"a\":{\"id\":\"a\"}}}")[0], "a", "字符串 JSON 也能抽");
  eq(extractMessageIds("坏 JSON"), null, "坏 JSON -> null");
  eq(extractMessageIds({}), null, "没有结构 -> null");
}

/* ------------------------------------------------------------------ */
section("runtime：三动作路由");
/* ------------------------------------------------------------------ */

{
  // append：严格追加，沿用当前会话
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const begin = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(begin.ok, true, "append：申请成功");
  eq(begin.plan.action, "append", "append：动作正确");
  eq(begin.plan.reason, "ok", "append：原因 ok");
  deepEq(begin.plan.delta, ["u2"], "append：只发增量");
  eq(begin.plan.conversationId, "c1", "append：沿用 conversationId");
  eq(begin.plan.parentMessageId, "m1", "append：沿用 parentMessageId");
  eq(begin.plan.seed, null, "append：不需要种子");
  eq(begin.plan.reAnchor, null, "append：不需要提醒");
  eq(begin.plan.payload, "u2", "append：载荷只有增量");
  await completeTurn(rt, begin.plan);
  eq(rt.bindingValue.turns, 3, "append：轮次 +1");
  eq(rt.bindingValue.conversationId, "c1", "append：会话不变");
  eq(rt.bindingValue.parentMessageId, "m-new", "append：parent 前移");
}

{
  // re-anchor：连续失败 2 次，不换会话，只补一句很短的话
  const c = clock();
  const rt = makeRuntime({
    clock: c,
    store: memoryBindingStore(mkPersisted(mkBinding(), { consecutiveFailures: 2 })),
  });
  const begin = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(begin.plan.action, "re-anchor", "re-anchor：动作正确");
  eq(begin.plan.reason, "failures", "re-anchor：原因 failures");
  eq(begin.plan.conversationId, "c1", "re-anchor：不换会话");
  eq(begin.plan.parentMessageId, "m1", "re-anchor：parent 不变");
  eq(begin.plan.reAnchor, RE_ANCHOR_TEXT, "re-anchor：带上协议提醒");
  eq(begin.plan.seed, null, "re-anchor：不重建种子");
  ok(begin.plan.payload.includes(RE_ANCHOR_TEXT), "re-anchor：载荷含提醒");
  ok(begin.plan.payload.endsWith("u2"), "re-anchor：用户文本仍在最后");
  ok(RE_ANCHOR_TEXT.length < 400, "提醒足够短（比轮换便宜一个数量级）");
  await completeTurn(rt, begin.plan);
  eq(rt.bindingValue.conversationId, "c1", "re-anchor：会话仍是 c1");
  eq(rt.snapshot().consecutiveFailures, 0, "re-anchor 成功后清零失败计数");
}

{
  // rotate：固定头变了
  const c = clock();
  const rt = makeRuntime({
    clock: c,
    store: memoryBindingStore(mkPersisted(mkBinding({ headHash: "0123456789abcdef" }))),
  });
  const act = await rt.activate();
  eq(act.rotate, true, "rotate：启动时就判定轮换");
  eq(act.reason, "head-changed", "rotate：原因 head-changed");
  eq(rt.bindingValue, null, "rotate：绑定被清掉");

  const begin = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(begin.plan.action, "rotate", "rotate：动作正确");
  eq(begin.plan.conversationId, null, "rotate：不带 conversationId");
  eq(begin.plan.parentMessageId, null, "rotate：不带 parentMessageId");
  ok(begin.plan.seed.includes("[固定头]"), "rotate：种子含固定头");
  ok(begin.plan.payload.includes(begin.plan.seed), "rotate：载荷以种子开头");
  ok(begin.plan.payload.endsWith("u2"), "rotate：当前用户文本作为新会话首条");
  const seedOccurrences = begin.plan.payload.split("u2").length - 1;
  eq(seedOccurrences, 1, "rotate：当前条目不重复出现在种子和历史里");
  await completeTurn(rt, begin.plan, { conversationId: "c-new", messageId: "m-root" });
  eq(rt.bindingValue.conversationId, "c-new", "rotate：新会话 id 生效");
  eq(rt.bindingValue.turns, 1, "rotate：轮次从 1 开始");
  eq(rt.bindingValue.lastEntries.join(","), "u1,a1,u2", "rotate：记下本次完整条目");
}

{
  // rotate：非严格追加（历史被压缩）
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const begin = await rt.beginTurn(["u1", "改写过的 a1", "u2"]);
  eq(begin.plan.action, "rotate", "非严格追加 -> rotate");
  eq(begin.plan.reason, "not-strict-append", "原因 not-strict-append");
}

{
  // rotate：到水位
  const c = clock();
  const rt = makeRuntime({
    clock: c,
    store: memoryBindingStore(mkPersisted(mkBinding({ turns: 25 }))),
  });
  const begin = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(begin.plan.action, "rotate", "到软水位 -> rotate");
  eq(begin.plan.reason, "turns-exceeded", "原因 turns-exceeded");
}

{
  // append 无增量：不发请求
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const begin = await rt.beginTurn(["u1", "a1"]);
  eq(begin.ok, true, "无增量：申请成功");
  eq(begin.plan.noop, true, "无增量：标记 noop");
  deepEq(begin.plan.delta, [], "无增量：delta 为空");
  eq(rt.snapshot().inFlight, false, "无增量：不占单飞锁");
  // 不占锁意味着下一条正常请求立刻可以走
  const next = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(next.ok, true, "无增量之后下一条立刻可发");
  eq(next.plan.action, "append", "下一条正常 append");
}

{
  // 三种动作在任何时候都只可能是这三个值
  const seen = new Set();
  for (const binding of [null, mkBinding(), mkBinding({ turns: 24 })]) {
    const rt = makeRuntime({
      clock: clock(),
      store: memoryBindingStore(binding === null ? null : mkPersisted(binding)),
    });
    for (const entries of [["u1"], ["u1", "a1"], ["u1", "a1", "u2"]]) {
      const b = await rt.beginTurn(entries);
      if (b.ok && !b.plan.noop) {
        seen.add(b.plan.action);
        rt.abortTurn();
      }
    }
  }
  ok([...seen].every((a) => a === "append" || a === "re-anchor" || a === "rotate"), "动作取值受限于三动作");
}

/* ------------------------------------------------------------------ */
section("runtime：单飞 —— busy 立即返回，不排队");
/* ------------------------------------------------------------------ */

{
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });

  const first = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(first.ok, true, "第一条拿到锁");

  const second = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(second.ok, false, "第二条被拒");
  eq(second.reason, "busy", "第二条立即返回 busy");
  eq(second.waitMs, 0, "busy 不给出等待时长（不排队）");

  // 即使时间过去很久也不复用
  c.advance(10 * 60_000);
  eq((await rt.beginTurn(["u1", "a1", "u2"])).reason, "busy", "过再久也还是 busy");
  eq(rt.snapshot().inFlight, true, "第一条仍在飞");

  await completeTurn(rt, first.plan);
  eq(rt.snapshot().inFlight, false, "收尾后放锁");
  eq((await rt.beginTurn(["u1", "a1", "u2", "a2"])).ok, true, "放锁后可再发");
}

{
  // 真正的"不排队"：第一条卡在读盘上时，第二条也必须立刻回 busy
  const c = clock();
  let releaseLoad;
  const stalled = new Promise((resolve) => { releaseLoad = resolve; });
  const slowStore = {
    async load() { await stalled; return null; },
    async save() {},
    async clear() {},
  };
  const rt = makeRuntime({ clock: c, store: slowStore, ledger: memoryLedger() });

  let firstSettled = false;
  const first = rt.beginTurn(["u1", "u2"]);
  first.then(() => { firstSettled = true; });
  await new Promise((r) => setTimeout(r, 0));
  eq(firstSettled, false, "第一条仍卡在启动读盘");

  const started = performance.now();
  const second = await rt.beginTurn(["u1", "u2"]);
  const elapsed = performance.now() - started;
  eq(second.ok, false, "第二条立刻被拒");
  eq(second.reason, "busy", "原因是 busy");
  ok(elapsed < 50, "没有等待第一条（耗时 " + elapsed.toFixed(1) + "ms）");
  eq(firstSettled, false, "第二条的申请没有促成第一条收尾");

  releaseLoad();
  const settled = await first;
  eq(settled.ok, true, "第一条最终拿到锁");
  eq(settled.plan.action, "rotate", "首次调用 -> rotate");
  await completeTurn(rt, settled.plan);
}

{
  // 同步占用：beginTurn 返回的瞬间就已在飞，不需要任何 await
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const p = rt.beginTurn(["u1", "a1", "u2"]);
  eq(rt.snapshot().inFlight, true, "调用返回瞬间即占用（同步置位）");
  const busy = await rt.beginTurn(["u1", "a1", "u2"]);
  eq(busy.reason, "busy", "同一 tick 内的第二次调用被拒");
  const plan = (await p).plan;
  await completeTurn(rt, plan);
}

{
  // 失败也要放锁，否则永远 busy
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const b = await rt.beginTurn(["u1", "a1", "u2"]);
  await rt.finishTurn({ ok: false, kind: "tool-protocol", status: 200 });
  eq(rt.snapshot().inFlight, false, "失败后放锁");
  eq((await rt.beginTurn(["u1", "a1", "u2"])).ok, true, "失败后可再发");
}

{
  // abort 也要放锁
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  await rt.beginTurn(["u1", "a1", "u2"]);
  rt.abortTurn();
  eq(rt.snapshot().inFlight, false, "abortTurn 放锁");
}

{
  // 闸门自己也会拒：间隔不够时立刻返回 interval，而不是等
  const c = clock();
  const rt = makeRuntime({
    clock: c,
    store: memoryBindingStore(mkPersisted(mkBinding())),
    gate: new Gate(
      { minIntervalMs: 5000, maxIntervalMs: 5000, longRunThreshold: 999, longRestMinMs: 0, longRestMaxMs: 0, rateWindowMs: 60_000, rateMaxInWindow: 999 },
      c.now,
    ),
  });
  const a = await rt.beginTurn(["u1", "a1", "u2"]);
  await completeTurn(rt, a.plan);
  c.advance(1000);
  const blocked = await rt.beginTurn(["u1", "a1", "u2", "a2"]);
  eq(blocked.ok, false, "间隔不够被拒");
  eq(blocked.reason, "interval", "原因是 interval");
  eq(rt.snapshot().inFlight, false, "被拒后不残留占用");
  c.advance(4000);
  eq((await rt.beginTurn(["u1", "a1", "u2", "a2"])).ok, true, "等够后放行");
}

/* ------------------------------------------------------------------ */
section("runtime：检查点 → 落盘 → 轮换种子");
/* ------------------------------------------------------------------ */

{
  const c = clock();
  const dir = await mkdtemp(join(tmpdir(), "dsh-rt-"));
  try {
    const cpFile = join(dir, "checkpoint.json");
    const cpStore = fileCheckpointStore(cpFile);
    const stateFile = join(dir, "state.json");
    const rt = makeRuntime({
      clock: c,
      limits: { softTurns: 10, hardTurns: 15, checkpointMargin: 3 },
      store: fileBindingStore(stateFile),
      checkpointStore: cpStore,
    });
    await rt.activate();

    // 先建立绑定
    const first = await rt.beginTurn(["u1"]);
    await completeTurn(rt, first.plan, { conversationId: "c1", messageId: "m1" });
    eq(rt.bindingValue.turns, 1, "第 1 轮");
    eq(rt.checkpointPlan().due, false, "第 1 轮不要检查点");

    // 推进到第 7 轮 = 软水位 10 前 3 轮
    const entries = ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4", "u5", "a5", "u6", "a6", "u7"];
    for (let i = 2; i <= 7; i++) {
      const b = await rt.beginTurn(entries.slice(0, i * 2 - 1));
      eq(b.plan.action, "append", "第 " + i + " 轮仍是 append");
      await completeTurn(rt, b.plan);
    }
    eq(rt.bindingValue.turns, 7, "现在第 7 轮");

    const due = await rt.beginTurn([...entries, "u8"]);
    eq(due.plan.checkpointDue, true, "第 8 轮触发检查点（软水位之前）");
    ok(due.plan.checkpointRequest.includes(HANDOFF_OPEN), "载荷里带了交接请求");
    ok(due.plan.payload.includes("GOAL:"), "交接请求要求 GOAL");
    ok(due.plan.payload.endsWith("u8"), "用户文本仍在最后");

    // 模型按请求交回一份检查点
    const reply = "好的，先交接。\n\n" + HANDOFF_OPEN + "\n" + renderCheckpoint(SAMPLE) + "\n" + HANDOFF_CLOSE + "\n\n继续处理 u8。";
    const stored = await rt.recordReply(reply);
    ok(stored.checkpoint !== null, "回复里的交接被解析");
    eq(stored.checkpoint.nextStep, SAMPLE.nextStep, "解析出下一步");
    ok(!stored.text.includes(HANDOFF_OPEN), "对用户隐藏交接块");
    ok(stored.text.includes("继续处理 u8。"), "保留真实正文");

    const onDisk = await cpStore.load();
    ok(onDisk !== null, "检查点已落盘");
    eq(onDisk.checkpoint.goal, SAMPLE.goal, "落盘内容正确");
    eq(onDisk.turns, 7, "落盘记录了当时的轮次");
    const raw = await readFile(cpFile, "utf8");
    ok(raw.includes("src/binding/runtime.ts"), "已改文件也落盘了");

    // 手工轮换：种子必须用上刚才那份检查点
    await completeTurn(rt, due.plan);
    await rt.rotate("test");
    eq(rt.bindingValue, null, "轮换后没有绑定");
    const rotated = await rt.beginTurn([...entries, "u8", "a8", "u9"]);
    eq(rotated.plan.action, "rotate", "轮换动作");
    ok(rotated.plan.seed.includes("[状态交接]"), "新会话种子带上检查点");
    ok(rotated.plan.seed.includes("不要改 state.ts 的判据"), "种子带上了 DO_NOT_REPEAT");
    ok(rotated.plan.seed.includes("[最近 8 条]"), "种子带最近 K 轮");
    await completeTurn(rt, rotated.plan, { conversationId: "c2", messageId: "m2" });

    // 轮换后检查点计时重置
    eq(rt.checkpointPlan().due, false, "轮换后立刻不再要检查点");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // 检查点也跨进程存活（重启后仍可作种子）
  const c = clock();
  const cpStore = memoryCheckpointStore(null);
  const first = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())), checkpointStore: cpStore });
  await first.activate();
  await first.recordReply(HANDOFF_OPEN + "\n" + renderCheckpoint(SAMPLE) + "\n" + HANDOFF_CLOSE);
  eq(first.checkpointValue.checkpoint.goal, SAMPLE.goal, "第一进程拿到检查点");

  const second = makeRuntime({ clock: c, store: memoryBindingStore(null), checkpointStore: cpStore });
  await second.activate();
  eq(second.checkpointValue.checkpoint.goal, SAMPLE.goal, "第二进程读到同一份检查点");
  const b = await second.beginTurn(["u1", "a1", "u2"]);
  ok(b.plan.seed.includes("[状态交接]"), "重启后首次轮换就用上检查点");
}

/* ------------------------------------------------------------------ */
section("runtime：重启后陈旧绑定一律 rotate");
/* ------------------------------------------------------------------ */

{
  const dir = await mkdtemp(join(tmpdir(), "dsh-restart-"));
  try {
    const stateFile = join(dir, "state.json");
    const cpFile = join(dir, "checkpoint.json");
    const c1 = clock();

    const rt1 = makeRuntime({
      clock: c1,
      store: fileBindingStore(stateFile),
      checkpointStore: fileCheckpointStore(cpFile),
    });
    await rt1.activate();
    const b1 = await rt1.beginTurn(["u1"]);
    await completeTurn(rt1, b1.plan, { conversationId: "c1", messageId: "m1" });
    eq(rt1.bindingValue.conversationId, "c1", "第一进程建立绑定");

    // 进程重启
    const c2 = clock(c1.now() + 1000);
    const sameHead = makeRuntime({
      clock: c2,
      store: fileBindingStore(stateFile),
      checkpointStore: fileCheckpointStore(cpFile),
    });
    const act = await sameHead.activate();
    eq(act.reuse, true, "本地判据全过 -> 允许复用（但要先探）");
    eq(act.needsProbe, true, "复用前必须探针");

    // 每个子场景都从"同一份重启前状态"开始，避免前一个场景的落盘污染后一个。
    const pristine = await readFile(stateFile, "utf8");
    const restart = async (patch = {}) => {
      await writeFile(stateFile, pristine, "utf8");
      return makeRuntime({
        clock: c2,
        store: fileBindingStore(stateFile),
        checkpointStore: fileCheckpointStore(cpFile),
        ...patch,
      });
    };

    // 没配默认探针：不许硬续，也不能残留占用
    const bare = await restart({ probe: undefined });
    const noProbeBare = await bare.beginTurn(["u1", "a1", "u2"]);
    eq(noProbeBare.ok, false, "不给探针就不许硬续");
    eq(noProbeBare.reason, "probe-required", "原因是 probe-required");
    eq(bare.snapshot().inFlight, false, "被拒后不残留占用");
    eq(bare.bindingValue.conversationId, "c1", "拒绝时不动旧绑定");

    // 配了默认探针：自动探完继续
    const autoProbe = await restart();
    const auto = await autoProbe.beginTurn(["u1", "a1", "u2"]);
    eq(auto.ok, true, "配了默认探针则自动探");
    eq(auto.plan.action, "append", "默认探针 alive -> append");

    // 探针说没了 -> rotate
    const gone = await restart();
    const goneRotate = await gone.beginTurn(["u1", "a1", "u2"], { probe: () => "gone" });
    eq(goneRotate.ok, true, "探针说没了 -> 继续走轮换");
    eq(goneRotate.plan.action, "rotate", "陈旧绑定 -> rotate");
    eq(goneRotate.plan.conversationId, null, "不硬续旧会话");
    eq(gone.bindingValue, null, "旧绑定已作废");

    // 父消息不在 -> rotate
    const pMissing = await restart();
    const pRotate = await pMissing.beginTurn(["u1", "a1", "u2"], { probe: () => "parent-missing" });
    eq(pRotate.plan.action, "rotate", "parent 不在 -> rotate");

    // 探针无结论 -> rotate
    const unknownRt = await restart();
    const u = await unknownRt.beginTurn(["u1", "a1", "u2"], { probe: () => "unknown" });
    eq(u.plan.action, "rotate", "探针无结论 -> rotate（宁可重建）");

    // 探针说还在 -> 正常 append
    const alive = await restart();
    const a = await alive.beginTurn(["u1", "a1", "u2"], { probe: () => "alive" });
    eq(a.plan.action, "append", "探针 alive -> 正常 append");
    eq(a.plan.conversationId, "c1", "沿用旧会话");

    // 固定头变了 -> 启动即轮换，连探针都不该发
    const c3 = clock(c1.now() + 1000);
    const changedHead = new BindingRuntime({
      bootstrap: BOOT + "（工具目录更新）",
      toolCatalog: TOOLS,
      protocolVersion: PROTO,
      now: c3.now,
      gate: permissiveGate(c3),
      store: fileBindingStore(stateFile),
      checkpointStore: fileCheckpointStore(cpFile),
      ledger: memoryLedger(),
    });
    const act2 = await changedHead.activate();
    eq(act2.rotate, true, "固定头变了 -> 启动即 rotate");
    eq(act2.reason, "head-changed", "原因 head-changed");
    eq(act2.needsProbe, false, "不需要再探（已经决定轮换）");
    eq(changedHead.bindingValue, null, "绑定已作废");
    const rb = await changedHead.beginTurn(["u1", "a1", "u2"]);
    eq(rb.plan.action, "rotate", "下一次请求就是 rotate");

    // 闲置太久 -> 启动即轮换
    await writeFile(stateFile, pristine, "utf8");
    const c4 = clock(c1.now() + 48 * 60 * 60 * 1000);
    const idle = makeRuntime({
      clock: c4,
      store: fileBindingStore(stateFile),
      checkpointStore: fileCheckpointStore(cpFile),
    });
    const act3 = await idle.activate();
    eq(act3.reason, "idle-expired", "闲置超时 -> rotate");
    eq(act3.needsProbe, false, "已判死就不再花探针");

    // 状态文件坏掉 -> 不硬续
    await writeFile(stateFile, "{ 这不是 json", "utf8");
    const broken = makeRuntime({
      clock: c2,
      store: fileBindingStore(stateFile),
      checkpointStore: fileCheckpointStore(cpFile),
    });
    eq((await broken.activate()).rotate, true, "坏状态文件 -> rotate");
    eq(broken.bindingValue, null, "坏状态不产生绑定");

    // 状态文件被截断（只剩 version）
    await writeFile(stateFile, JSON.stringify({ version: 1 }), "utf8");
    const truncated = makeRuntime({
      clock: c2,
      store: fileBindingStore(stateFile),
      checkpointStore: fileCheckpointStore(cpFile),
    });
    eq((await truncated.activate()).rotate, true, "截断的状态 -> rotate");

    // 版本不符
    await writeFile(stateFile, JSON.stringify({ version: 99, binding: mkBinding() }), "utf8");
    const wrongVersion = makeRuntime({
      clock: c2,
      store: fileBindingStore(stateFile),
      checkpointStore: fileCheckpointStore(cpFile),
    });
    eq((await wrongVersion.activate()).rotate, true, "版本不符 -> rotate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // 轮次超过水位：重启后不能硬续
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding({ turns: 26 }))) });
  const act = await rt.activate();
  eq(act.rotate, true, "turns 超软水位 -> rotate");
  eq(act.reason, "turns-exceeded", "原因 turns-exceeded");
}

{
  // 探针缺失/异常一律按 unknown 处理 -> rotate
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const b = await rt.beginTurn(["u1", "a1", "u2"], { probe: () => { throw new Error("探针炸了"); } });
  eq(b.plan.action, "rotate", "探针抛异常 -> rotate");
}

/* ------------------------------------------------------------------ */
section("runtime：失败处理与绑定作废");
/* ------------------------------------------------------------------ */

{
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  await rt.beginTurn(["u1", "a1", "u2"]);
  const fin = await rt.finishTurn({ ok: false, kind: "tool-protocol", status: 200 });
  eq(fin.accepted, false, "失败不被接受");
  eq(rt.snapshot().consecutiveFailures, 1, "失败计数 1");
  eq(rt.bindingValue.conversationId, "c1", "协议失败不换会话语义");
}

{
  eq(shouldDropBinding("transport", null), true, "传输失败 -> 作废绑定");
  eq(shouldDropBinding("aborted", 200), true, "中断 -> 作废绑定");
  eq(shouldDropBinding("http", 404), true, "404 -> 作废绑定");
  eq(shouldDropBinding("http", 410), true, "410 -> 作废绑定");
  eq(shouldDropBinding("http", 500), false, "500 保留绑定");
  eq(shouldDropBinding("empty-reply", 200), false, "空回复保留绑定");
  eq(shouldDropBinding("tool-protocol", 200), false, "协议失败保留绑定");
  eq(shouldDropBinding("none", 200), false, "成功不涉及");
}

{
  // 成功但服务端没给锚点：不能留一条续不上的绑定
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  await rt.beginTurn(["u1", "a1", "u2"]);
  const fin = await rt.finishTurn({ ok: true, conversationId: "c1", messageId: null, status: 200 });
  eq(fin.accepted, false, "没有 messageId -> 不接受");
  eq(fin.reason, "missing-anchor", "原因 missing-anchor");
  eq(rt.bindingValue, null, "绑定作废");
}

{
  // 没有在飞时 finishTurn 不应误伤
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const fin = await rt.finishTurn({ ok: true, conversationId: "x", messageId: "y" });
  eq(fin.accepted, false, "无在飞 -> 不接受");
  eq(fin.reason, "no-in-flight", "原因 no-in-flight");
}

/* ------------------------------------------------------------------ */
section("runtime：载荷组装");
/* ------------------------------------------------------------------ */

{
  eq(composeUserPayload(null, null, "u"), "u", "只有用户文本");
  eq(composeUserPayload("R", null, "u"), "R\n\nu", "提醒在前");
  eq(composeUserPayload(null, "C", "u"), "C\n\nu", "交接请求在前");
  eq(composeUserPayload("R", "C", "u"), "R\n\nC\n\nu", "顺序：提醒 → 交接 → 用户");
  eq(composeUserPayload(null, null, ""), "", "全空 -> 空");
}

{
  // 每条请求都要新的 userMessageId（服务端按 id 去重）
  const c = clock();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())) });
  const a = await rt.beginTurn(["u1", "a1", "u2"]);
  const idA = a.plan.userMessageId;
  await completeTurn(rt, a.plan);
  const b = await rt.beginTurn(["u1", "a1", "u2", "a2", "u3"]);
  ok(idA !== b.plan.userMessageId, "两条请求的 userMessageId 不同");
}

/* ------------------------------------------------------------------ */
section("runtime：坏盘不把运行时焊死");
/* ------------------------------------------------------------------ */

{
  // 读盘抛异常：按"没有绑定"处理（= rotate），不能把 activate 永久焊成 rejected
  let loads = 0;
  const flakyStore = {
    async load() { loads += 1; throw new Error("EACCES"); },
    async save() {},
    async clear() {},
  };
  const c = clock();
  const rt = makeRuntime({ clock: c, store: flakyStore });
  const act = await rt.activate();
  eq(act.rotate, true, "读盘失败 -> rotate（不抛）");
  eq(rt.bindingValue, null, "读盘失败不产生绑定");
  const again = await rt.activate();
  eq(again.rotate, true, "重复 activate 仍返回同一结论");
  eq(loads, 1, "activate 幂等，只读一次盘");

  const begin = await rt.beginTurn(["u1"]);
  eq(begin.ok, true, "坏盘之后仍能正常开新会话");
  eq(begin.plan.action, "rotate", "坏盘 -> rotate");
}

{
  // 写盘抛异常：一轮成功的结果不能因此变成失败
  const c = clock();
  const rt = makeRuntime({
    clock: c,
    store: {
      async load() { return null; },
      async save() { throw new Error("ENOSPC"); },
      async clear() {},
    },
  });
  const b = await rt.beginTurn(["u1"]);
  const fin = await rt.finishTurn({ ok: true, conversationId: "c1", messageId: "m1", status: 200 });
  eq(fin.accepted, true, "写盘失败不影响这一轮成功");
  eq(rt.bindingValue.conversationId, "c1", "内存里的绑定仍是对的");
  eq(rt.snapshot().lastRotateReason, "persist-failed", "记下落盘失败（下次启动会 rotate）");
}

/* ------------------------------------------------------------------ */
section("ledger：统计（中位 / p90 / 最短）");
/* ------------------------------------------------------------------ */

{
  eq(percentile([], 0.9), null, "空集 p90 为 null");
  eq(percentile([5], 0.9), 5, "单项 p90");
  eq(percentile([1, 2, 3, 4], 0.9), 4, "nearest-rank p90");
  eq(percentile([1, 2, 3, 4, 5], 0.5), 3, "nearest-rank p50");
  eq(percentile([1, 2, 3, 4, 5], 1), 5, "p100 = 最大");
  eq(percentile([1, 2, 3, 4, 5], 0), 1, "p0 = 最小");

  const empty = intervalStats([]);
  eq(empty.count, 0, "空集 count 0");
  eq(empty.medianMs, null, "空集中位为 null");
  eq(empty.minMs, null, "空集最短为 null");

  const stats = intervalStats([20_000, 5_000, 10_000, 15_000]);
  eq(stats.count, 4, "样本数");
  eq(stats.minMs, 5_000, "最短");
  eq(stats.maxMs, 20_000, "最长");
  eq(stats.medianMs, 12_500, "偶数个取中间两个的平均");
  eq(stats.p90Ms, 20_000, "p90");
  eq(stats.meanMs, 12_500, "均值");
}

{
  const base = 1_000_000_000;
  const now = base;
  const records = [
    makeRecord({ startedAt: base - 100_000, finishedAt: base - 99_000, status: 200 }),
    makeRecord({ startedAt: base - 90_000, finishedAt: base - 89_000, status: 200 }),
    makeRecord({ startedAt: base - 70_000, finishedAt: base - 69_500, status: 200 }),
    makeRecord({ startedAt: base - 55_000, finishedAt: base - 54_000, status: 200 }),
    makeRecord({ startedAt: base - 50_000, finishedAt: base - 49_000, status: 200 }),
  ];
  const gaps = intervalsOf(records);
  deepEq(gaps, [10_000, 20_000, 15_000, 5_000], "间隔按时间顺序计算");
  const s = summarize(records, now);
  eq(s.total, 5, "全部计入");
  eq(s.sent, 5, "全部为已发送");
  eq(s.throttled, 0, "没有被拒的");
  eq(s.intervals.minMs, 5_000, "最短间隔");
  eq(s.intervals.medianMs, 12_500, "中位间隔");
  eq(s.intervals.p90Ms, 20_000, "p90 间隔");
  eq(s.failures, 0, "没有失败");
  eq(s.failureRate, 0, "失败率 0");
}

{
  // 被闸门挡下的不算"相邻请求间隔"
  const base = 2_000_000_000;
  const records = [
    makeRecord({ startedAt: base - 60_000, finishedAt: base - 59_000, status: 200 }),
    makeRecord({ startedAt: base - 55_000, finishedAt: base - 55_000, kind: "busy", status: null }),
    makeRecord({ startedAt: base - 30_000, finishedAt: base - 29_000, status: 200 }),
  ];
  const s = summarize(records, base);
  eq(s.throttled, 1, "被拒的计为 throttled");
  eq(s.sent, 2, "只有 2 条真正发出");
  deepEq(intervalsOf(records), [30_000], "busy 不参与间隔计算");
  eq(s.intervals.minMs, 30_000, "最短间隔只看已发送");
}

/* ------------------------------------------------------------------ */
section("ledger：失败分类");
/* ------------------------------------------------------------------ */

{
  eq(kindFromGateReason("busy"), "busy", "busy");
  eq(kindFromGateReason("interval"), "throttle-interval", "interval");
  eq(kindFromGateReason("rate-window"), "throttle-window", "rate-window");
  eq(kindFromGateReason("long-rest"), "throttle-long-rest", "long-rest");
  eq(kindFromGateReason("谁知道"), "unknown", "未知理由 -> unknown");

  ok(FAILURE_KINDS.includes("auth"), "有 auth 分类");
  ok(FAILURE_KINDS.includes("sentinel"), "有 sentinel 分类");
  ok(FAILURE_KINDS.includes("pow"), "有 pow 分类");
  ok(FAILURE_KINDS.includes("tool-protocol"), "有 tool-protocol 分类");
  ok(FAILURE_KINDS.includes("transport"), "有 transport 分类");
  eq(new Set(FAILURE_KINDS).size, FAILURE_KINDS.length, "分类无重复");
}

{
  const base = 3_000_000_000;
  const mk = (offset, kind, extra = {}) =>
    makeRecord({ startedAt: base - offset, finishedAt: base - offset + 1000, status: 200, kind, ...extra });
  const records = [
    mk(50_000, "none"),
    mk(45_000, "auth"),
    mk(40_000, "auth"),
    mk(35_000, "auth"),
    mk(30_000, "tool-protocol"),
    mk(25_000, "tool-protocol"),
    mk(20_000, "pow"),
    mk(15_000, "busy"),
  ];
  const s = summarize(records, base);
  eq(s.total, 8, "总数");
  eq(s.failures, 7, "失败数");
  eq(s.byKind.length, 4, "四类失败");
  eq(s.byKind[0].kind, "auth", "最多的排在前面");
  eq(s.byKind[0].count, 3, "auth 有 3 次");
  eq(s.byKind[1].kind, "tool-protocol", "第二名");
  eq(s.byKind[1].count, 2, "tool-protocol 有 2 次");
  const shares = s.byKind.reduce((sum, b) => sum + b.share, 0);
  ok(Math.abs(shares - 1) < 1e-9, "占比之和为 1");
  ok(Math.abs(s.failureRate - 7 / 8) < 1e-9, "失败率 7/8");
  eq(s.byKind.some((b) => b.kind === "none"), false, "成功不计入分类");

  // 同 count 时按名字排序，保证稳定
  const tie = summarize([mk(10_000, "pow"), mk(5_000, "auth")], base);
  eq(tie.byKind[0].kind, "auth", "同 count 按名字升序");
}

{
  eq(makeRecord({ startedAt: 0, finishedAt: 0, kind: "busy" }).throttled, true, "busy 自动记为 throttled");
  eq(makeRecord({ startedAt: 0, finishedAt: 100 }).throttled, false, "成功不是 throttled");
  const r = makeRecord({ startedAt: 100, finishedAt: 50 });
  eq(r.durMs, 0, "耗时不出现负数");
  let threw = false;
  try { makeRecord({ startedAt: 0, finishedAt: 0, kind: "不存在的分类" }); } catch { threw = true; }
  eq(threw, true, "未知分类直接报错（防止静默错分类）");
}

/* ------------------------------------------------------------------ */
section("ledger：只留近 7 天 / 只记元信息");
/* ------------------------------------------------------------------ */

{
  const day = 24 * 60 * 60 * 1000;
  const now = 10 * day;
  eq(retentionCutoff(now), now - 7 * day, "默认保留 7 天");
  const records = [
    makeRecord({ startedAt: now - 8 * day, finishedAt: now - 8 * day + 100 }),
    makeRecord({ startedAt: now - 6 * day, finishedAt: now - 6 * day + 100 }),
    makeRecord({ startedAt: now - 1 * day, finishedAt: now - 1 * day + 100 }),
  ];
  const kept = pruneRecords(records, now);
  eq(kept.length, 2, "8 天前的被丢掉");
  eq(kept[0].t, now - 6 * day, "保留 6 天前的");
  eq(pruneRecords(records, now, 30).length, 3, "放宽到 30 天则全留");
  eq(pruneRecords([], now).length, 0, "空集安全");
}

{
  // 台账字段是白名单：多塞的字段一律被剥掉
  const dir = await mkdtemp(join(tmpdir(), "dsh-ledger-"));
  try {
    const file = join(dir, "calls.ndjson");
    const ledger = createLedger(file);
    eq((await ledger.load(Date.now())).length, 0, "首次读取为空");

    // 时间戳必须贴近真实 now，否则会被 7 天保留期当成过期记录删掉。
    const now = Date.now();
    const rec = makeRecord({ startedAt: now - 2000, finishedAt: now - 1500, status: 200, action: "append", ttfbMs: 90 });
    deepEq(
      Object.keys(rec).sort(),
      ["action", "attempt", "durMs", "kind", "status", "t", "throttled", "ttfbMs"],
      "记录只有元信息字段",
    );

    const leaky = { ...rec, prompt: "用户的私密对话内容 SECRET", cookie: "session=abc", headers: { authorization: "Bearer x" } };
    await ledger.append(leaky);
    const raw = await readFile(file, "utf8");
    ok(!raw.includes("SECRET"), "对话内容没有落盘");
    ok(!raw.includes("session=abc"), "凭证没有落盘");
    ok(!raw.includes("Bearer"), "authorization 没有落盘");
    ok(raw.includes('"kind":"none"'), "元信息正常落盘");

    await ledger.append(makeRecord({ startedAt: now - 1000, finishedAt: now - 500, status: 200 }));
    const loaded = await ledger.load(now);
    eq(loaded.length, 2, "两条都能读回");
    eq(loaded[0].action, "append", "字段完整");

    const s = await ledger.summary(now);
    eq(s.total, 2, "summary 基于文件内容");
    eq(s.sent, 2, "两条都是已发送");
    eq(s.failures, 0, "没有失败");
    eq(s.intervals.count, 1, "两条记录一段间隔");
    eq(s.intervals.minMs, 1000, "间隔 1000ms");

    // 压缩掉过期记录
    const old = now - 10 * 24 * 60 * 60 * 1000;
    await ledger.append(makeRecord({ startedAt: old, finishedAt: old + 10 }));
    eq((await ledger.load(now)).length, 2, "过期记录读时就被过滤");
    eq(await ledger.compact(now), 2, "compact 返回保留条数");
    const after = await readFile(file, "utf8");
    ok(!after.includes(String(old)), "过期记录已从文件里删掉");
    ok(after.includes(String(now - 2000)), "未过期的仍在文件里");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  // 内存台账：并发 append 不丢
  const ledger = memoryLedger();
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      ledger.append(makeRecord({ startedAt: 1000 + i * 1000, finishedAt: 1500 + i * 1000, status: 200 })),
    ),
  );
  const s = await ledger.summary(100_000);
  eq(s.total, 25, "并发写入全部保留");
  eq(s.intervals.count, 24, "24 段间隔");
  eq(s.intervals.minMs, 1000, "间隔 1000ms");
}

/* ------------------------------------------------------------------ */
section("runtime + ledger：拒绝也记账且分类正确");
/* ------------------------------------------------------------------ */

{
  const c = clock();
  const ledger = memoryLedger();
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())), ledger });

  const first = await rt.beginTurn(["u1", "a1", "u2"]);
  await completeTurn(rt, first.plan);
  // 第二条：闸门全开，会成功
  const second = await rt.beginTurn(["u1", "a1", "u2", "a2", "u3"]);
  const third = await rt.beginTurn(["u1", "a1", "u2", "a2", "u3"]); // 在飞 -> busy
  eq(third.reason, "busy", "在飞时 busy");
  await completeTurn(rt, second.plan);
  await rt.flush();

  const s = await ledger.summary(c.now());
  eq(s.sent, 2, "两次真正发出");
  eq(s.throttled, 1, "一次被拒");
  eq(s.byKind.length, 1, "只有一类");
  eq(s.byKind[0].kind, "busy", "失败分类是 busy");
  eq(s.intervals.count, 1, "两段请求只有一段间隔");
  eq(s.intervals.minMs, 0, "同一时刻发出的间隔为 0");

  const loaded = await ledger.load(c.now());
  eq(loaded.filter((r) => r.action === "append").length, 2, "记录了动作");
  ok(loaded.every((r) => typeof r.t === "number"), "每条都有时间戳");
}

{
  // 闸门拒绝也进台账，且分类到 throttle-*
  const c = clock();
  const ledger = memoryLedger();
  const gate = new Gate(
    { minIntervalMs: 5000, maxIntervalMs: 5000, longRunThreshold: 999, longRestMinMs: 0, longRestMaxMs: 0, rateWindowMs: 60_000, rateMaxInWindow: 999 },
    c.now,
  );
  const rt = makeRuntime({ clock: c, store: memoryBindingStore(mkPersisted(mkBinding())), ledger, gate });
  const a = await rt.beginTurn(["u1", "a1", "u2"]);
  await completeTurn(rt, a.plan);
  c.advance(1000);
  const blocked = await rt.beginTurn(["u1", "a1", "u2", "a2", "u3"]);
  eq(blocked.reason, "interval", "间隔不够");
  await rt.flush();
  const s = await ledger.summary(c.now());
  eq(s.byKind[0].kind, "throttle-interval", "被限流单独归类");
  eq(s.throttled, 1, "计为 throttled");
  eq(s.sent, 1, "只有一次真正发出");
}
