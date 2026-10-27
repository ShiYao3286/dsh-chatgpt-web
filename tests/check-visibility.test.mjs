import { ok, eq, section } from "./harness.mjs";
import { HIDDEN_OVERRIDE_EXPRESSION } from "../src/transport/cdp.ts";

section("后台标签页节流：覆写表达式");
ok(HIDDEN_OVERRIDE_EXPRESSION.length > 0, "表达式非空");
ok(HIDDEN_OVERRIDE_EXPRESSION.includes("visibilityState"), "覆写 visibilityState");
ok(HIDDEN_OVERRIDE_EXPRESSION.includes("hidden"), "覆写 hidden");
ok(HIDDEN_OVERRIDE_EXPRESSION.includes("visibilitychange"), "派发 visibilitychange 事件");
ok(HIDDEN_OVERRIDE_EXPRESSION.includes("configurable"), "属性可重新定义（幂等前提）");

section("表达式是自执行且不依赖外部变量");
ok(HIDDEN_OVERRIDE_EXPRESSION.trim().startsWith("(() =>"), "自执行箭头函数");
ok(!/\bimport\b/.test(HIDDEN_OVERRIDE_EXPRESSION), "无 import");
ok(!/\brequire\b/.test(HIDDEN_OVERRIDE_EXPRESSION), "无 require");

section("可在纯 JS 环境里安全求值（模拟页面）");
{
  const fakeDoc = {
    _state: "hidden",
    get visibilityState() { return this._state; },
    get hidden() { return this._state !== "visible"; },
    dispatchEvent() { return true; },
  };
  const evalExpr = new Function("document", "Event", "return " + HIDDEN_OVERRIDE_EXPRESSION);
  const r = evalExpr(fakeDoc, function Event() {});
  eq(r, true, "返回 true 表示已是可见");
  eq(fakeDoc.visibilityState, "visible", "visibilityState 被覆写为 visible");
  eq(fakeDoc.hidden, false, "hidden 被覆写为 false");

  // 幂等：再跑一次不报错
  const r2 = evalExpr(fakeDoc, function Event() {});
  eq(r2, true, "重复执行无害");
}

section("已在可见状态时短路");
{
  const fakeDoc = {
    get visibilityState() { return "visible"; },
    get hidden() { return false; },
    dispatchEvent() { throw new Error("不该派发事件"); },
  };
  const evalExpr = new Function("document", "Event", "return " + HIDDEN_OVERRIDE_EXPRESSION);
  eq(evalExpr(fakeDoc, function Event() {}), true, "可见时不派发事件、直接返回 true");
}