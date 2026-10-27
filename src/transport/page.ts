/**
 * 页面层：把一个 CDP 连接变成一个"就绪的 chatgpt.com 页面"。
 *
 * 这层只做**读取与等待**，不构造业务请求（那是 wire 层）：
 *   - 等 ready        location 是 chatgpt.com 且 document.readyState 完成
 *   - 检测登录态      /api/auth/session + /backend-api/me（页面上下文里 fetch）
 *   - 拿 accessToken  /api/auth/session 的 accessToken
 *   - 拿 data-build   站点构建号，PoW 指纹里要用
 *
 * 为什么一定要在页面上下文里 fetch：cookie 是 httpOnly + 站点绑定的，
 * 而且请求要带上站点自己的 CSRF/指纹头。Node 侧直接 fetch 拿不到这些东西。
 */

import {
  Cdp,
  PageExceptionError,
  describeError,
  sleep,
  type EvaluateOptions,
} from "./cdp.ts";

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const CHATGPT_HOST = "chatgpt.com";

/** 页面里跑一段脚本，返回结构化结果；页面内异常原样抛出。 */
/**
 * 页面内求值的统一入口。
 *
 * 这里做了一次可见性守卫：后台标签页会被浏览器节流，页面里的 fetch 可能长时间
 * 不 resolve（表现为 CDP 超时且看不出原因）。守卫幂等，前台页面几乎零成本。
 *
 * 守卫是**能力检测**的：真实 Cdp 一定实现了 ensureVisible；测试替身可以只实现
 * evaluate，此时跳过守卫（否则每个假对象都要重写一遍）。
 */
export async function evalInPage<T>(
  cdp: Cdp,
  expression: string,
  options: EvaluateOptions = {},
): Promise<T> {
  if (typeof cdp.ensureVisible === "function") await cdp.ensureVisible();
  return (await cdp.evaluate(expression, options)) as T;
}

export interface PageProbe {
  href: string;
  readyState: string;
  /** 页面自报的构建号；拿不到为 null。 */
  dataBuild: string | null;
  userAgent: string;
  languages: string[];
  webdriver: boolean;
  isChatGPT: boolean;
}

/** 一次读齐页面的静态环境信息（不发起任何网络请求）。纯 DOM 读取。 */
export function pageProbeExpression(): string {
  return [
    "(() => {",
    "  const build = document.documentElement.getAttribute('data-build');",
    "  return {",
    "    href: String(location.href),",
    "    readyState: String(document.readyState),",
    "    dataBuild: build && build.length > 0 ? build : null,",
    "    userAgent: String(navigator.userAgent || ''),",
    "    languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 8) : [],",
    "    webdriver: navigator.webdriver === true,",
    "    isChatGPT: location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com'),",
    "  };",
    "})()",
  ].join("\n");
}

export async function probePage(cdp: Cdp): Promise<PageProbe> {
  const raw = await evalInPage<Partial<PageProbe>>(cdp, pageProbeExpression(), { awaitPromise: false });
  return {
    href: typeof raw.href === "string" ? raw.href : "",
    readyState: typeof raw.readyState === "string" ? raw.readyState : "",
    dataBuild: typeof raw.dataBuild === "string" && raw.dataBuild.length > 0 ? raw.dataBuild : null,
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : "",
    languages: Array.isArray(raw.languages) ? raw.languages.filter((x): x is string => typeof x === "string") : [],
    webdriver: raw.webdriver === true,
    isChatGPT: raw.isChatGPT === true,
  };
}

export interface WaitReadyOptions {
  /** 总超时。 */
  timeoutMs?: number;
  /** 轮询间隔。 */
  intervalMs?: number;
  /** 只是 readyState 完成还不够，登录后才出现的标记可以在这里等。 */
  extraExpression?: string;
  /** 可注入的时钟/休眠，方便离线测试。 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: (cdp: Cdp) => Promise<PageProbe>;
}

/**
 * 等页面就绪：域名对 + readyState 完成 + （可选）额外表达式为真。
 * 超时返回最后一次探测结果并标记 ok=false，不抛异常 —— 调用方要能把它写进诊断。
 */
export async function waitForReady(
  cdp: Cdp,
  options: WaitReadyOptions = {},
): Promise<{ ok: boolean; probe: PageProbe | null; waitedMs: number; errors: string[] }> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? (() => Date.now());
  const pause = options.sleep ?? sleep;
  const probeFn = options.probe ?? probePage;

  const started = now();
  const errors: string[] = [];
  let last: PageProbe | null = null;

  for (;;) {
    try {
      last = await probeFn(cdp);
      if (last.isChatGPT && last.readyState === "complete") {
        if (options.extraExpression === undefined) {
          return { ok: true, probe: last, waitedMs: now() - started, errors };
        }
        const extra = await evalInPage<unknown>(cdp, options.extraExpression, { awaitPromise: false });
        if (extra === true) return { ok: true, probe: last, waitedMs: now() - started, errors };
      }
    } catch (err) {
      if (err instanceof PageExceptionError) {
        // 导航途中执行上下文会被销毁，属于正常现象，记一笔继续等。
        errors.push(err.detail.slice(0, 200));
      } else {
        errors.push(describeError(err));
      }
    }
    if (now() - started >= timeoutMs) {
      return { ok: false, probe: last, waitedMs: now() - started, errors };
    }
    await pause(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// 登录态
// ---------------------------------------------------------------------------

export interface LoginState {
  /** 是否已登录。 */
  loggedIn: boolean;
  /** /api/auth/session 的 HTTP 状态码；-1 表示页面内请求本身失败。 */
  sessionStatus: number;
  meStatus: number;
  /** 是否拿到 accessToken。**不导出 token 内容**。 */
  hasAccessToken: boolean;
  accessTokenLength: number;
  planType: string | null;
  /** 只保留邮箱域名，用来判断账号类型（不泄漏完整邮箱）。 */
  emailDomain: string | null;
  errors: string[];
}

/**
 * 登录态探测表达式。一次跑完两个端点，减少跨进程往返。
 * 注意：只回传长度/域名这类结论，不回传 token 本身。
 */
export function loginProbeExpression(): string {
  return [
    "(async () => {",
    "  const out = { sessionStatus: -1, meStatus: -1, hasAccessToken: false,",
    "    accessTokenLength: 0, planType: null, emailDomain: null, errors: [] };",
    "  try {",
    "    const s = await fetch('/api/auth/session', { credentials: 'include' });",
    "    out.sessionStatus = s.status;",
    "    let sj = null;",
    "    try { sj = await s.json(); } catch (e) { out.errors.push('session 非 JSON'); }",
    "    if (sj && typeof sj.accessToken === 'string') {",
    "      out.hasAccessToken = sj.accessToken.length > 0;",
    "      out.accessTokenLength = sj.accessToken.length;",
    "    }",
    "    if (sj && sj.account && typeof sj.account.planType === 'string') out.planType = sj.account.planType;",
    "    if (sj && sj.user && typeof sj.user.email === 'string') {",
    "      const at = sj.user.email.lastIndexOf('@');",
    "      out.emailDomain = at >= 0 ? sj.user.email.slice(at + 1) : null;",
    "    }",
    "  } catch (e) { out.errors.push('session: ' + (e && e.message ? e.message : String(e))); }",
    "  try {",
    "    const m = await fetch('/backend-api/me', { credentials: 'include' });",
    "    out.meStatus = m.status;",
    "    let mj = null;",
    "    try { mj = await m.json(); } catch (e) {}",
    "    if (mj && typeof mj.plan_type === 'string') out.planType = out.planType || mj.plan_type;",
    "    if (mj && out.emailDomain === null && typeof mj.email === 'string') {",
    "      const at = mj.email.lastIndexOf('@');",
    "      out.emailDomain = at >= 0 ? mj.email.slice(at + 1) : null;",
    "    }",
    "  } catch (e) { out.errors.push('me: ' + (e && e.message ? e.message : String(e))); }",
    "  return out;",
    "})()",
  ].join("\n");
}

/** 判定登录态：session 里有 accessToken 才算登录（/me 会随 cookie 抖动，只作补充）。 */
export function judgeLogin(raw: Partial<LoginState>): LoginState {
  const errors = Array.isArray(raw.errors) ? raw.errors.filter((e): e is string => typeof e === "string") : [];
  const hasAccessToken = raw.hasAccessToken === true;
  const sessionOk = typeof raw.sessionStatus === "number" && raw.sessionStatus === 200;
  return {
    loggedIn: hasAccessToken && sessionOk,
    sessionStatus: typeof raw.sessionStatus === "number" ? raw.sessionStatus : -1,
    meStatus: typeof raw.meStatus === "number" ? raw.meStatus : -1,
    hasAccessToken,
    accessTokenLength: typeof raw.accessTokenLength === "number" ? raw.accessTokenLength : 0,
    planType: typeof raw.planType === "string" && raw.planType.length > 0 ? raw.planType : null,
    emailDomain: typeof raw.emailDomain === "string" && raw.emailDomain.length > 0 ? raw.emailDomain : null,
    errors,
  };
}

export async function readLoginState(cdp: Cdp): Promise<LoginState> {
  const raw = await evalInPage<Partial<LoginState>>(cdp, loginProbeExpression(), {
    awaitPromise: true,
    timeoutMs: 30_000,
  });
  return judgeLogin(raw ?? {});
}

/** 轮询到登录为止。返回最后一次探测结果（超时也不抛）。 */
export async function waitForLogin(
  cdp: Cdp,
  options: { timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ state: LoginState | null; waitedMs: number; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 1500;
  const now = options.now ?? (() => Date.now());
  const pause = options.sleep ?? sleep;
  const started = now();
  let last: LoginState | null = null;
  for (;;) {
    try {
      last = await readLoginState(cdp);
      if (last.loggedIn) return { state: last, waitedMs: now() - started, timedOut: false };
    } catch {
      /* 页面可能在导航，继续轮询 */
    }
    if (now() - started >= timeoutMs) {
      return { state: last, waitedMs: now() - started, timedOut: last === null || !last.loggedIn };
    }
    await pause(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// accessToken / data-build
// ---------------------------------------------------------------------------

/**
 * 取 accessToken。返回 null 表示当前没有（未登录）。
 * 这是本模块里唯一会拿到敏感明文的地方 —— 只交给 wire 层用，别写日志。
 */
export async function getAccessToken(cdp: Cdp): Promise<string | null> {
  const token = await evalInPage<unknown>(
    cdp,
    "(async () => { const r = await fetch('/api/auth/session', { credentials: 'include' });" +
      " let j = null; try { j = await r.json(); } catch (e) {}" +
      " return j && typeof j.accessToken === 'string' && j.accessToken.length > 0 ? j.accessToken : null; })()",
    { awaitPromise: true, timeoutMs: 20_000 },
  );
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * 取站点构建号 data-build。
 *
 * 页面稳定后直接读根元素属性；页面还没挂上时退回 __NEXT_DATA__ / 脚本里的字面量。
 * 都找不到返回 null —— PoW 指纹里它是可空字段，不该让整个流程失败。
 */
export async function getDataBuild(cdp: Cdp): Promise<string | null> {
  const build = await evalInPage<unknown>(
    cdp,
    "(() => {" +
      " const v = document.documentElement.getAttribute('data-build');" +
      " if (v && v.length > 0) return v;" +
      " try {" +
      "   const nd = document.getElementById('__NEXT_DATA__');" +
      "   if (nd && nd.textContent) {" +
      "     const j = JSON.parse(nd.textContent);" +
      "     const b = j && j.buildId ? String(j.buildId) : null;" +
      "     if (b && b.length > 0) return b;" +
      "   }" +
      " } catch (e) {}" +
      " const html = document.documentElement.outerHTML || '';" +
      " const m = html.match(/data-build=\"([^\"]+)\"/);" +
      " return m ? m[1] : null;" +
      "})()",
    { awaitPromise: false },
  );
  return typeof build === "string" && build.length > 0 ? build : null;
}

/** 页面尺寸/环境，wire 层构造 client_contextual_info 时用。 */
export interface PageEnv {
  innerHeight: number;
  innerWidth: number;
  devicePixelRatio: number;
  screenWidth: number;
  screenHeight: number;
  timeSinceLoadedSec: number;
  hardwareConcurrency: number;
  userAgent: string;
  languages: string[];
  dataBuild: string | null;
}

export function pageEnvExpression(): string {
  return [
    "(() => {",
    "  const nav = navigator;",
    "  const t = performance && performance.timeOrigin ? (Date.now() - performance.timeOrigin) / 1000 : 0;",
    "  return {",
    "    innerHeight: window.innerHeight || 0,",
    "    innerWidth: window.innerWidth || 0,",
    "    devicePixelRatio: window.devicePixelRatio || 1,",
    "    screenWidth: (screen && screen.width) || 0,",
    "    screenHeight: (screen && screen.height) || 0,",
    "    timeSinceLoadedSec: Math.max(0, Math.round(t)),",
    "    hardwareConcurrency: nav.hardwareConcurrency || 8,",
    "    userAgent: String(nav.userAgent || ''),",
    "    languages: Array.isArray(nav.languages) ? nav.languages.slice(0, 8) : [],",
    "    dataBuild: document.documentElement.getAttribute('data-build') || null,",
    "  };",
    "})()",
  ].join("\n");
}

export async function readPageEnv(cdp: Cdp): Promise<PageEnv> {
  const raw = await evalInPage<Partial<PageEnv>>(cdp, pageEnvExpression(), { awaitPromise: false });
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    innerHeight: num(raw.innerHeight, 900),
    innerWidth: num(raw.innerWidth, 1280),
    devicePixelRatio: num(raw.devicePixelRatio, 1),
    screenWidth: num(raw.screenWidth, 1920),
    screenHeight: num(raw.screenHeight, 1080),
    timeSinceLoadedSec: num(raw.timeSinceLoadedSec, 42),
    hardwareConcurrency: num(raw.hardwareConcurrency, 8),
    userAgent: typeof raw.userAgent === "string" ? raw.userAgent : "",
    languages: Array.isArray(raw.languages) ? raw.languages.filter((x): x is string => typeof x === "string") : [],
    dataBuild: typeof raw.dataBuild === "string" && raw.dataBuild.length > 0 ? raw.dataBuild : null,
  };
}

/** 当前页面是否还是 chatgpt.com（没被导航走 / 没被关掉）。 */
export async function isOnChatGPT(cdp: Cdp): Promise<boolean> {
  try {
    const href = await evalInPage<unknown>(cdp, "location.hostname", { awaitPromise: false });
    return typeof href === "string" && (href === CHATGPT_HOST || href.endsWith("." + CHATGPT_HOST));
  } catch {
    return false;
  }
}

/** 确保页面在 chatgpt.com 上；不在就导航过去。返回是否发生了导航。 */
export async function ensureChatGPT(cdp: Cdp, loadTimeoutMs = 45_000): Promise<{ navigated: boolean; loaded: boolean }> {
  const probe = await probePage(cdp).catch(() => null);
  if (probe !== null && probe.isChatGPT) return { navigated: false, loaded: true };
  const loaded = await cdp.navigate(CHATGPT_ORIGIN, loadTimeoutMs);
  return { navigated: true, loaded };
}
