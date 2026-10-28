/**
 * 设置页登录面板的浏览器侧逻辑（纯函数 + 习题级副作用，可离线测试）。
 *
 * ## 为什么不走 `ctx.remote`
 *
 * 浏览器端的 Remote 命名空间只来自宿主编译期静态枚举的贡献表，第三方插件
 * 挂不上自己的命名空间。Host 的 `TypertRemoteService` 因此只能当「宿主内部服务」用，
 * 客户端读不到。这里的通道是 Host 注册的 HTTP 路由（见 `src/login-routes.ts`）。
 *
 * ## 这个模块管什么
 *
 * 只有三件事：拼 URL、发请求、把应答归一化成界面能直接渲染的形状。
 * 不碰 DOM、不碰定时器——定时轮询放在 card 组件里，便于卸载时清理。
 */

import type { LoginProgress } from "../login.ts";

/** 与 Host 端 `LOGIN_ROUTE_PREFIX` 必须一致。 */
export const LOGIN_ROUTE_PREFIX = "/chatgpt-web/login";

/** 持久化登录态的界面形状（Host 应答的子集）。 */
export interface StoredAuthView {
  authStatus: "missing" | "expired" | "unchecked";
  capturedAt: number | null;
  planType: string | null;
  dataBuild: string | null;
  hasCookie: boolean;
  cookieCount: number;
  tokenLength: number;
}

/** `/status` 的完整应答。 */
export interface LoginStatusPayload {
  ok: boolean;
  stored: StoredAuthView;
  progress: LoginProgress;
}

/** 一次 fetch 的最小面；测试里可替换。 */
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const emptyStored: StoredAuthView = {
  authStatus: "missing",
  capturedAt: null,
  planType: null,
  dataBuild: null,
  hasCookie: false,
  cookieCount: 0,
  tokenLength: 0,
};

/**
 * 把任意应答归一化成 `LoginStatusPayload`。
 *
 * 宿主的鉴权闸门对未认证请求直接回 401/403 且**没有 JSON**，
 * 所以这里必须能容忍非 JSON 与缺字段——否则设置页会白屏。
 */
export function normalizeStatusPayload(raw: unknown): LoginStatusPayload {
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const storedObj = obj.stored !== null && typeof obj.stored === "object" ? (obj.stored as Record<string, unknown>) : {};
  const status = storedObj.authStatus;
  const stored: StoredAuthView = {
    authStatus: status === "expired" || status === "unchecked" || status === "missing" ? status : "missing",
    capturedAt: numberOrNull(storedObj.capturedAt),
    planType: stringOrNull(storedObj.planType),
    dataBuild: stringOrNull(storedObj.dataBuild),
    hasCookie: storedObj.hasCookie === true,
    cookieCount: numberOr(storedObj.cookieCount, 0),
    tokenLength: numberOr(storedObj.tokenLength, 0),
  };
  return { ok: obj.ok === true, stored, progress: normalizeProgress(obj.progress) };
}

/** 进度归一化：未知阶段一律 idle，避免界面卡在假状态里。 */
export function normalizeProgress(raw: unknown): LoginProgress {
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const phase = obj.phase;
  const known = ["idle", "launching", "waiting", "capturing", "done", "failed"];
  const capturedObj = obj.captured !== null && typeof obj.captured === "object" ? (obj.captured as Record<string, unknown>) : null;
  return {
    phase: typeof phase === "string" && known.includes(phase) ? (phase as LoginProgress["phase"]) : "idle",
    message: typeof obj.message === "string" ? obj.message : "",
    waitedMs: numberOr(obj.waitedMs, 0),
    startedAt: numberOr(obj.startedAt, 0),
    finishedAt: numberOrNull(obj.finishedAt),
    ...(capturedObj === null
      ? {}
      : {
          captured: {
            accessTokenLength: numberOr(capturedObj.accessTokenLength, 0),
            planType: stringOrNull(capturedObj.planType),
            dataBuild: typeof capturedObj.dataBuild === "string" ? capturedObj.dataBuild : "",
            hasCookie: capturedObj.hasCookie === true,
            cookieCount: numberOr(capturedObj.cookieCount, 0),
          },
        }),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 读当前状态。任意失败都退回"全 missing"，绝不抛。 */
export async function fetchLoginStatus(fetcher: FetchLike): Promise<LoginStatusPayload> {
  try {
    const res = await fetcher(LOGIN_ROUTE_PREFIX + "/status", { method: "GET" });
    if (!res.ok) return normalizeStatusPayload({ ok: false, stored: emptyStored, progress: { phase: "idle" } });
    return normalizeStatusPayload(await res.json());
  } catch {
    return normalizeStatusPayload({ ok: false, stored: emptyStored, progress: { phase: "idle" } });
  }
}

/** 启动登录（拉起浏览器）。失败时返回失败进度而不是抛。 */
export async function startBrowserLogin(fetcher: FetchLike, port?: number): Promise<LoginProgress> {
  try {
    const body = port === undefined ? "{}" : JSON.stringify({ port });
    const res = await fetcher(LOGIN_ROUTE_PREFIX + "/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const raw: unknown = await res.json().catch(() => ({}));
    const payload = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (res.ok) return normalizeProgress(payload.progress);
    return normalizeProgress({ phase: "failed", message: typeof payload.error === "string" ? payload.error : "启动登录失败" });
  } catch (error) {
    return normalizeProgress({ phase: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}

/** 取消等待。 */
export async function cancelBrowserLogin(fetcher: FetchLike): Promise<LoginProgress> {
  try {
    const res = await fetcher(LOGIN_ROUTE_PREFIX + "/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const raw: unknown = await res.json().catch(() => ({}));
    const payload = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return normalizeProgress(payload.progress);
  } catch {
    return normalizeProgress({ phase: "failed", message: "取消失败" });
  }
}

/** 删除本地凭证。 */
export async function logoutStoredAuth(fetcher: FetchLike): Promise<LoginStatusPayload> {
  try {
    const res = await fetcher(LOGIN_ROUTE_PREFIX + "/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) return normalizeStatusPayload({ ok: false, stored: { ...emptyStored }, progress: { phase: "idle" } });
    return normalizeStatusPayload(await res.json());
  } catch {
    return normalizeStatusPayload({ ok: false, stored: { ...emptyStored }, progress: { phase: "idle" } });
  }
}

/** 是否该继续轮询：进行中的阶段才轮询，终态停。 */
export function shouldPoll(progress: LoginProgress): boolean {
  return progress.phase === "launching" || progress.phase === "waiting" || progress.phase === "capturing";
}

/** 把已等待毫秒数写成"1 分 05 秒"。 */
export function describeWaited(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "0 秒";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? String(minutes) + " 分 " + String(seconds).padStart(2, "0") + " 秒" : String(seconds) + " 秒";
}

/** 时间戳 → "2026-10-28 15:04"。 */
export function describeCapturedAt(ms: number | null): string {
  if (ms === null || ms <= 0) return "未记录";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/**
 * 登录态这一行的完整文案。
 *
 * 刻意区分三种"没登录"：文件不存在 / 本地已过期 / 未在线验证——
 * 第三种最容易被误读成"能用"，所以要明确写出"不代表凭证可用"。
 */
export function describeStoredAuth(view: StoredAuthView): string {
  if (view.authStatus === "missing") return "未登录：本地没有凭证，点下面按钮拉取浏览器登录态";
  if (view.authStatus === "expired") return "本地凭证已过期（" + describeCapturedAt(view.capturedAt) + " 捕获），请重新拉取";
  const parts = ["已保存凭证：" + describeCapturedAt(view.capturedAt) + " 捕获"];
  if (view.tokenLength > 0) parts.push("token " + String(view.tokenLength) + " 字符");
  if (view.hasCookie) parts.push(String(view.cookieCount) + " 项 cookie");
  if (view.dataBuild !== null) parts.push("build " + view.dataBuild);
  parts.push("未在线验证，不保证远端仍接受");
  return parts.join(" · ");
}
