/**
 * 登录功能：纯逻辑部分的回归。
 *
 * 这些用例只碰**不导网络、不开浏览器**的纯函数：
 * 状态归一化、文案、cookie 过滤、端口归一化。
 * 真正的浏览器流程由 `check-login-session.mjs` 用注入桩件覆盖。
 */
import { ok, eq, deepEq, section } from "./harness.mjs";
import {
  normalizeStatusPayload,
  normalizeProgress,
  shouldPoll,
  describeWaited,
  describeCapturedAt,
  describeStoredAuth,
  LOGIN_ROUTE_PREFIX,
} from "../src/client/login-view.ts";
import {
  buildCookieHeader,
  normalizePort,
  phaseMessage,
  idleProgress,
  LOGIN_TIMEOUT_MS,
} from "../src/login.ts";

section("路由前缀与 Host 端一致");
eq(LOGIN_ROUTE_PREFIX, "/chatgpt-web/login", "客户端拼接用的前缀");

section("状态归一化：必须容忍宿主的 401/403 非 JSON 应答");
{
  const empty = normalizeStatusPayload(undefined);
  eq(empty.ok, false, "无应答 -> ok=false");
  eq(empty.stored.authStatus, "missing", "无应答 -> missing");
  eq(empty.progress.phase, "idle", "无应答 -> idle");

  const garbage = normalizeStatusPayload({ stored: { authStatus: "wat" }, progress: { phase: "nope" } });
  eq(garbage.stored.authStatus, "missing", "非法 authStatus 退回 missing");
  eq(garbage.progress.phase, "idle", "非法 phase 退回 idle");

  const good = normalizeStatusPayload({
    ok: true,
    stored: { authStatus: "expired", capturedAt: 1700000000000, planType: "plus", dataBuild: "abc", hasCookie: true, cookieCount: 3, tokenLength: 120 },
    progress: { phase: "waiting", message: "等登录", waitedMs: 5000, startedAt: 1, finishedAt: null },
  });
  eq(good.stored.authStatus, "expired", "合法状态保留");
  eq(good.stored.cookieCount, 3, "cookie 数保留");
  eq(good.progress.message, "等登录", "进度文案保留");
  eq(good.progress.phase, "waiting", "进度阶段保留");
}

section("进度归一化：非法数字不能变成 NaN");
{
  const p = normalizeProgress({ phase: "waiting", waitedMs: Number.NaN, startedAt: "x", finishedAt: Number.POSITIVE_INFINITY });
  eq(p.waitedMs, 0, "NaN -> 0");
  eq(p.startedAt, 0, "非数 -> 0");
  eq(p.finishedAt, null, "Infinity -> null");
}

section("shouldPoll：只有进行中的阶段才轮询");
{
  eq(shouldPoll({ phase: "launching" }), true, "launching 要轮询");
  eq(shouldPoll({ phase: "waiting" }), true, "waiting 要轮询");
  eq(shouldPoll({ phase: "capturing" }), true, "capturing 要轮询");
  eq(shouldPoll({ phase: "idle" }), false, "idle 不轮询");
  eq(shouldPoll({ phase: "done" }), false, "done 必须停（否则白烧 CPU）");
  eq(shouldPoll({ phase: "failed" }), false, "failed 必须停");
}

section("等待时长文案");
{
  eq(describeWaited(0), "0 秒", "零");
  eq(describeWaited(999), "0 秒", "不足一秒");
  eq(describeWaited(12_000), "12 秒", "纯秒");
  eq(describeWaited(65_000), "1 分 05 秒", "分秒补零");
}

section("时间戳文案");
{
  eq(describeCapturedAt(null), "未记录", "空值");
  eq(describeCapturedAt(0), "未记录", "零值");
  const text = describeCapturedAt(new Date(2026, 9, 28, 15, 4).getTime());
  eq(text, "2026-10-28 15:04", "格式化");
}

section("登录态文案：三种'没登录'必须能区分");
{
  const missing = describeStoredAuth({ authStatus: "missing", capturedAt: null, planType: null, dataBuild: null, hasCookie: false, cookieCount: 0, tokenLength: 0 });
  ok(missing.includes("未登录"), "missing 说未登录");

  const expired = describeStoredAuth({ authStatus: "expired", capturedAt: 1700000000000, planType: null, dataBuild: null, hasCookie: false, cookieCount: 0, tokenLength: 10 });
  ok(expired.includes("过期"), "expired 说过期");
  ok(expired.includes("重新拉取"), "expired 给出下一步");

  const unchecked = describeStoredAuth({ authStatus: "unchecked", capturedAt: 1700000000000, planType: "plus", dataBuild: "abc", hasCookie: true, cookieCount: 2, tokenLength: 120 });
  ok(unchecked.includes("未在线验证"), "unchecked 明确说明不保证可用");
  ok(unchecked.includes("token 120"), "带上 token 长度");
  ok(unchecked.includes("2 项 cookie"), "带上 cookie 数");
  ok(unchecked.includes("build abc"), "带上 dataBuild");
  // 反向验证：unchecked 绝不能被说成"已登录/可用"
  ok(!unchecked.includes("已登录"), "unchecked 不得声称已登录");
}

section("cookie 过滤：只留 chatgpt/openai 域");
{
  const header = buildCookieHeader([
    { name: "a", value: "1", domain: ".chatgpt.com" },
    { name: "b", value: "2", domain: "chat.openai.com" },
    { name: "c", value: "3", domain: ".example.com" },
    { name: "", value: "4", domain: ".chatgpt.com" },
    { name: "d", domain: ".chatgpt.com" },
  ]);
  eq(header, "a=1; b=2; d=", "只拼目标域，空名跳过");

  eq(buildCookieHeader([]), "", "空列表 -> 空串");
  // 反向验证：同域判断不能靠 includes("openai") 碰巧命中别的域
  eq(buildCookieHeader([{ name: "x", value: "1", domain: "notopenai.com.evil.test" }]), "", "伪装域被过滤");
}

section("端口归一化");
{
  eq(normalizePort(9222), 9222, "正常端口");
  eq(normalizePort(0), undefined, "0 视为未配置");
  eq(normalizePort(-1), undefined, "负数");
  eq(normalizePort(70000), undefined, "越界");
  eq(normalizePort(Number.NaN), undefined, "NaN");
  eq(normalizePort(undefined), undefined, "未传");
  eq(normalizePort(1234.7), 1235, "四舍五入");
}

section("等待阶段文案");
{
  eq(phaseMessage(null), "等待浏览器页面就绪…", "无状态");
  ok(phaseMessage({ sessionStatus: 401, hasAccessToken: false }).includes("登录"), "401 提示去登录");
  ok(phaseMessage({ sessionStatus: 403, hasAccessToken: false }).includes("登录"), "403 提示去登录");
  ok(phaseMessage({ sessionStatus: 200, hasAccessToken: true }).includes("准备抓取"), "已登录");
  ok(phaseMessage({ sessionStatus: 200, hasAccessToken: false }).includes("等待登录完成"), "还没登录");
}

section("初始进度 & 超时时长");
{
  const idle = idleProgress();
  eq(idle.phase, "idle", "初始 idle");
  eq(idle.waitedMs, 0, "初始 0");
  eq(idle.finishedAt, null, "初始未结束");
  ok(LOGIN_TIMEOUT_MS >= 60_000, "等待上限不能太短（用户要输密码）");
}
