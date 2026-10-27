import { ok, eq, deepEq, section } from "./harness.mjs";
import { decideFeed, isStrictAppend, headHashOf, fnv1a64 } from "../src/binding/state.ts";

const baseBinding = (over = {}) => ({
  conversationId: "c1",
  parentMessageId: "m1",
  headHash: "H",
  lastEntries: ["a", "b"],
  turns: 3,
  createdAt: 0,
  ...over,
});

const baseInput = (over = {}) => ({
  entries: ["a", "b"],
  headHash: "H",
  binding: baseBinding(),
  consecutiveFailures: 0,
  softTurns: 25,
  hardTurns: 40,
  ...over,
});

section("isStrictAppend");
deepEq(isStrictAppend([], []), { ok: true, at: 0 }, "都为空");
deepEq(isStrictAppend(["a"], ["a", "b"]), { ok: true, at: 1 }, "严格追加");
deepEq(isStrictAppend(["a", "b"], ["a", "b"]), { ok: true, at: 2 }, "完全相等");
deepEq(isStrictAppend(["a", "b"], ["a"]), { ok: false, at: -1 }, "变短 = 不严格");
deepEq(isStrictAppend(["a", "b"], ["a", "x"]), { ok: false, at: -1 }, "等长但中间变了 = 不严格");
deepEq(isStrictAppend(["a", "b"], ["x", "a", "b"]), { ok: false, at: -1 }, "前面插入 = 不严格");

section("decideFeed：必须轮换的硬条件");
eq(decideFeed(baseInput({ binding: null })).reason, "first-call", "首次调用");
eq(decideFeed(baseInput({ binding: null })).action, "rotate", "首次调用 -> rotate");
eq(decideFeed(baseInput({ headHash: "H2" })).reason, "head-changed", "固定头变了");
eq(decideFeed(baseInput({ headHash: "H2" })).action, "rotate", "固定头变了 -> rotate");
eq(decideFeed(baseInput({ entries: ["a"] })).reason, "not-strict-append", "历史变短（压缩）");
eq(decideFeed(baseInput({ entries: ["a"] })).action, "rotate", "压缩后 -> rotate");
eq(decideFeed(baseInput({ entries: ["a", "x"] })).reason, "not-strict-append", "等长改写（压缩）");
eq(decideFeed(baseInput({ binding: baseBinding({ turns: 40 }) })).reason, "turns-exceeded", "达到硬上限");
eq(decideFeed(baseInput({ binding: baseBinding({ turns: 41 }) })).reason, "turns-exceeded", "超过硬上限");

section("decideFeed：re-anchor");
const ra = decideFeed(baseInput({ consecutiveFailures: 2, entries: ["a", "b", "c"] }));
eq(ra.action, "re-anchor", "连续失败 2 次 -> re-anchor（不换会话）");
eq(ra.reason, "failures", "原因记为 failures");
const ra1 = decideFeed(baseInput({ consecutiveFailures: 1, entries: ["a", "b", "c"] }));
eq(ra1.action, "append", "只失败 1 次仍 append");

section("decideFeed：软水位");
const soft = decideFeed(baseInput({ binding: baseBinding({ turns: 25 }), entries: ["a", "b", "c"] }));
eq(soft.action, "rotate", "到软水位 -> 主动轮换");
eq(soft.reason, "turns-exceeded", "原因 turns-exceeded");

section("decideFeed：正常追加");
const ap = decideFeed(baseInput({ entries: ["a", "b", "c", "d"] }));
eq(ap.action, "append", "严格追加 -> append");
deepEq(ap.delta, ["c", "d"], "delta 只含新增");
const noNew = decideFeed(baseInput({ entries: ["a", "b"] }));
eq(noNew.action, "append", "无新增 -> append");
deepEq(noNew.delta, [], "无新增 -> 空 delta");

section("decideFeed：优先级");
// 硬上限优先于 re-anchor
const prio = decideFeed(baseInput({ binding: baseBinding({ turns: 40 }), consecutiveFailures: 5 }));
eq(prio.reason, "turns-exceeded", "硬上限优先于失败计数");
// head 变化优先于一切
const prio2 = decideFeed(baseInput({ headHash: "H9", binding: baseBinding({ turns: 40 }) }));
eq(prio2.reason, "head-changed", "head 变化最优先");

section("headHashOf");
eq(headHashOf("b", "t", 1), headHashOf("b", "t", 1), "同输入同哈希");
ok(headHashOf("b", "t", 1) !== headHashOf("b2", "t", 1), "bootstrap 变 -> 哈希变");
ok(headHashOf("b", "t", 1) !== headHashOf("b", "t2", 1), "工具目录变 -> 哈希变");
ok(headHashOf("b", "t", 1) !== headHashOf("b", "t", 2), "协议版本变 -> 哈希变");
eq(headHashOf("b", "t", 1).length, 16, "16 位 hex");

section("fnv1a64");
eq(fnv1a64(""), "cbf29ce484222325", "空串是 FNV offset basis");
ok(fnv1a64("a") !== fnv1a64("b"), "不同输入不同结果");
