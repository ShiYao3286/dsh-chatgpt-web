/**
 * 设置页里的「拉取本地浏览器登录态」。
 *
 * ## 为什么不复用 `scripts/capture-auth.mjs`
 *
 * 那个脚本要求用户**先自己开一个带 --remote-debugging-port=9222 的浏览器**，
 * 属于命令行步骤：设置页点不到，普通用户也不会做。这里把它做成**一键**：
 * 宿主侧拉起一个**可见的真实浏览器**（独立 profile 目录 + 调试端口），
 * 用 CDP 读登录态，然后落盘 —— 与 dsh-deepseek-web-login 的做法一致。
 *
 * ## 为什么用独立 profile 而不是用户正在用的浏览器
 *
 * 同一 user-data-dir 起第二个实例时，Chromium 会把参数转交给已有实例然后**自己退出**，
 * 调试端口永远不开。独立 profile 还有两个好处：登录态可复用（下次不用重登），
 * 且不碰用户日常浏览器的数据。
 *
 * ## 安全底线
 *
 * token / cookie **不写日志、不回传 HTTP**。状态接口只回 hasCookie / 长度 / 计划类型这类结论。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { authExpired, loadAuth, saveAuth, type StoredAuth } from "./auth.ts";
import { profileDir, webLoginRoot } from "./paths.ts";
import {
  DEFAULT_ATTACH_TIMEOUT_MS,
  DEFAULT_START_URL,
  attachPage,
  ensureBrowser,
  type BrowserSession,
} from "./transport/browser.ts";
import { describeError, sleep, type Cdp } from "./transport/cdp.ts";
import {
  ensureChatGPT,
  getAccessToken,
  getDataBuild,
  readLoginState,
  readPageEnv,
  type LoginState,
} from "./transport/page.ts";

/** 一次登录流程的阶段。设置页按这个值显示进度。 */
export type LoginPhase =
  | "idle"
  | "launching"
  | "waiting"
  | "capturing"
  | "done"
  | "failed";

/** 登录成功后抓到的结论（不含任何凭证明文）。 */
export interface LoginCapture {
  accessTokenLength: number;
  planType: string | null;
  dataBuild: string;
  hasCookie: boolean;
  cookieCount: number;
}

export interface LoginProgress {
  phase: LoginPhase;
  /** 给用户看的一句话。 */
  message: string;
  /** 已等待毫秒数（waiting 阶段）。 */
  waitedMs: number;
  startedAt: number;
  finishedAt: number | null;
  captured?: LoginCapture;
}

/** 未开始时的初始状态。 */
export function idleProgress(): LoginProgress {
  return { phase: "idle", message: "", waitedMs: 0, startedAt: 0, finishedAt: null };
}

/** 浏览器 cookie 元素的最小形状。 */
export interface RawCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
}

/** 活动登录会话的可注入面（测试用；生产全部用默认实现）。 */
export interface LoginDeps {
  ensureBrowser: typeof ensureBrowser;
  attachPage: typeof attachPage;
  readLoginState: typeof readLoginState;
  getAccessToken: typeof getAccessToken;
  getDataBuild: typeof getDataBuild;
  readPageEnv: typeof readPageEnv;
  ensureChatGPT: typeof ensureChatGPT;
  saveAuth: typeof saveAuth;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: LoginDeps = {
  ensureBrowser,
  attachPage,
  readLoginState,
  getAccessToken,
  getDataBuild,
  readPageEnv,
  ensureChatGPT,
  saveAuth,
  now: () => Date.now(),
  sleep,
};

/** 登录等待上限。用户要输账号密码（可能还有二次验证），两分钟太短。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** 轮询间隔：够快让进度更新，够慢不打扰页面。 */
const POLL_INTERVAL_MS = 1500;

/**
 * 一次「拉取浏览器登录态」的过程对象。
 *
 * 状态机单向：idle -> launching -> waiting -> capturing -> done/failed。
 * 中途失败或取消都落到 failed，靠 message 区分原因。
 */
export class BrowserLoginSession {
  private progress: LoginProgress = idleProgress();
  private cancelled = false;
  private readonly deps: LoginDeps;
  private cdp: Cdp | undefined;

  constructor(deps: Partial<LoginDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** 当前进度快照（对外只读副本）。 */
  snapshot(): LoginProgress {
    return { ...this.progress, ...(this.progress.captured ? { captured: { ...this.progress.captured } } : {}) };
  }

  /** 是否正在占用一个浏览器窗口。 */
  get active(): boolean {
    return this.progress.phase === "launching" || this.progress.phase === "waiting" || this.progress.phase === "capturing";
  }

  /**
   * 启动一次登录。**重复调用返回当前状态**而不是重开——
   * 设置页轮询期间用户连点两次不该开出两个浏览器窗口。
   */
  start(options: { port?: number; timeoutMs?: number; startUrl?: string } = {}): LoginProgress {
    if (this.active) return this.snapshot();
    this.cancelled = false;
    const now = this.deps.now();
    this.progress = {
      phase: "launching",
      message: "正在启动浏览器…",
      waitedMs: 0,
      startedAt: now,
      finishedAt: null,
    };
    // 后台跑完整流程；start 立刻返回，设置页靠轮询看进度。
    void this.run(options);
    return this.snapshot();
  }

  /**
   * 取消进行中的登录。**不杀浏览器**：它可能是用户正在手动登录的窗口，
   * 也可能是他日常用的窗口。这里只停止等待。
   */
  cancel(reason = "已取消登录"): LoginProgress {
    this.cancelled = true;
    if (this.active) {
      this.progress = { ...this.progress, phase: "failed", message: reason, finishedAt: this.deps.now() };
    }
    return this.snapshot();
  }

  private async run(options: { port?: number; timeoutMs?: number; startUrl?: string }): Promise<void> {
    const finish = (phase: LoginPhase, message: string, captured?: LoginCapture): void => {
      const now = this.deps.now();
      this.progress = {
        ...this.progress,
        phase,
        message,
        waitedMs: now - this.progress.startedAt,
        finishedAt: now,
        ...(captured ? { captured } : {}),
      };
    };

    try {
      const port = normalizePort(options.port);
      const session = await this.deps.ensureBrowser({
        ...(port !== undefined ? { port } : {}),
        profileDir: profileDir(),
        startUrl: options.startUrl ?? DEFAULT_START_URL,
        spawnIfMissing: true,
        attachTimeoutMs: DEFAULT_ATTACH_TIMEOUT_MS,
      });
      if (this.cancelled) return finish("failed", "已取消登录");

      this.progress = {
        ...this.progress,
        phase: "waiting",
        message: "浏览器已打开，请在窗口里完成 ChatGPT 登录（已登录可跳过）",
      };

      const cdp = await this.attach(session);
      if (cdp === null) return finish("failed", "浏览器已启动但打不开 chatgpt.com 页面；请手动在窗口里打开后重试");
      this.cdp = cdp;
      await this.deps.ensureChatGPT(cdp).catch(() => undefined);

      const failure = await this.waitingLoop(options.timeoutMs ?? LOGIN_TIMEOUT_MS);
      if (this.cancelled) return finish("failed", "已取消登录");
      if (failure !== null) return finish("failed", failure);

      this.progress = { ...this.progress, phase: "capturing", message: "已检测到登录，正在抓取凭证…" };
      const saved = await this.capture(cdp);
      if (saved === null) {
        return finish("failed", "已登录但抓不到 accessToken；请确认窗口里打开的是 chatgpt.com");
      }
      finish("done", "登录态已保存，可以关闭浏览器窗口了", saved);
    } catch (error) {
      finish("failed", describeError(error));
    } finally {
      try {
        this.cdp?.close();
      } catch {
        /* 已关闭 */
      }
      this.cdp = undefined;
    }
  }

  /** 附着到 chatgpt.com 页面；刚启动时 target 列表可能还空，多试几轮。 */
  private async attach(session: BrowserSession): Promise<Cdp | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (this.cancelled) return null;
      const attached = await this.deps.attachPage(session, "chatgpt.com").catch(() => null);
      if (attached !== null) return attached.cdp;
      await this.deps.sleep(1500);
    }
    return null;
  }

  /**
   * 等登录。返回 null 表示已登录；返回字符串表示失败原因。
   * 每轮刷新 waitedMs，让设置页的进度有东西可显示。
   */
  private async waitingLoop(timeoutMs: number): Promise<string | null> {
    const deadline = this.progress.startedAt + timeoutMs;
    let probeFailures = 0;
    while (this.deps.now() < deadline) {
      if (this.cancelled) return null;
      if (this.cdp === undefined) return "浏览器页面已关闭，登录流程中止";
      let state: LoginState | null = null;
      try {
        state = await this.deps.readLoginState(this.cdp);
        probeFailures = 0;
      } catch {
        // 页面可能在导航中；连续多次失败才判定页面真的丢了。
        probeFailures += 1;
        if (probeFailures >= 5) return "无法读取浏览器页面状态，请确认窗口还开着";
      }
      if (state !== null && state.loggedIn) return null;
      this.progress = {
        ...this.progress,
        waitedMs: this.deps.now() - this.progress.startedAt,
        message: phaseMessage(state),
      };
      await this.deps.sleep(POLL_INTERVAL_MS);
    }
    return "等待登录超时（" + String(Math.round(timeoutMs / 60_000)) + " 分钟），可以重新点击登录";
  }

  /** 读 token / cookie / 页面环境并落盘。返回 null 表示拿不到 token。 */
  private async capture(cdp: Cdp): Promise<LoginCapture | null> {
    const token = await this.deps.getAccessToken(cdp);
    if (token === null || token.length === 0) return null;
    const [dataBuild, env, cookies] = await Promise.all([
      this.deps.getDataBuild(cdp).catch(() => null),
      this.deps.readPageEnv(cdp).catch(() => null),
      cdp.getAllCookies().catch((): RawCookie[] => []),
    ]);
    const cookieHeader = buildCookieHeader(cookies);
    const auth: StoredAuth = {
      version: 1,
      accessToken: token,
      cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
      dataBuild: dataBuild ?? "",
      userAgent: env?.userAgent ?? "",
      languages: env?.languages !== undefined && env.languages.length > 0 ? [...env.languages] : ["en-US"],
      planType: null,
      capturedAt: this.deps.now(),
      lastOkAt: null,
    };
    await this.deps.saveAuth(auth);
    return {
      accessTokenLength: token.length,
      planType: null,
      dataBuild: auth.dataBuild,
      hasCookie: auth.cookieHeader !== null,
      cookieCount: auth.cookieHeader === null ? 0 : auth.cookieHeader.split("; ").length,
    };
  }
}

/** 端口归一化：非法值/0/越界一律当作未配置，交给浏览器默认端口。 */
export function normalizePort(raw: number | undefined): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const port = Math.round(raw);
  if (port <= 0 || port > 65_535) return undefined;
  return port;
}

/** 目标域判定：只认 chatgpt.com / openai.com（含子域）。 */
export function isTargetDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./u, "");
  return (
    normalized === "chatgpt.com" ||
    normalized.endsWith(".chatgpt.com") ||
    normalized === "openai.com" ||
    normalized.endsWith(".openai.com")
  );
}

/** 只保留 chatgpt/openai 域的 cookie；其它域不进请求头。 */
export function buildCookieHeader(cookies: readonly RawCookie[]): string {
  const pairs: string[] = [];
  for (const cookie of cookies) {
    const name = typeof cookie.name === "string" ? cookie.name : "";
    if (name.length === 0) continue;
    const value = typeof cookie.value === "string" ? cookie.value : "";
    const domain = String(cookie.domain ?? "");
    if (!isTargetDomain(domain)) continue;
    pairs.push(name + "=" + value);
  }
  return pairs.join("; ");
}

/** waiting 阶段的提示语，按探测结果给不同引导。 */
export function phaseMessage(state: LoginState | null): string {
  if (state === null) return "等待浏览器页面就绪…";
  if (state.sessionStatus === 401 || state.sessionStatus === 403) return "请在弹出的浏览器窗口里登录 ChatGPT";
  if (state.hasAccessToken && state.sessionStatus === 200) return "登录已就绪，准备抓取…";
  if (state.hasAccessToken) return "已拿到 token，正在确认会话…";
  return "检测到窗口已打开，等待登录完成…";
}

/** 只读地报告当前持久化登录态。设置页打开时先问这个。 */
export interface StoredAuthStatus {
  authStatus: "missing" | "expired" | "unchecked";
  capturedAt: number | null;
  planType: string | null;
  dataBuild: string | null;
  hasCookie: boolean;
  cookieCount: number;
  tokenLength: number;
}

export async function readStoredAuthStatus(): Promise<StoredAuthStatus> {
  const auth = await loadAuth().catch(() => null);
  if (auth === null) {
    return { authStatus: "missing", capturedAt: null, planType: null, dataBuild: null, hasCookie: false, cookieCount: 0, tokenLength: 0 };
  }
  return {
    authStatus: authExpired(auth) ? "expired" : "unchecked",
    capturedAt: auth.capturedAt > 0 ? auth.capturedAt : null,
    planType: auth.planType,
    dataBuild: auth.dataBuild.length > 0 ? auth.dataBuild : null,
    hasCookie: auth.cookieHeader !== null,
    cookieCount: auth.cookieHeader === null ? 0 : auth.cookieHeader.split("; ").length,
    tokenLength: auth.accessToken.length,
  };
}

/** 清除本地凭证文件（登出）。**删文件**而不是改名归档：登出的语义就是它不该留在磁盘上。 */
export async function clearStoredAuth(): Promise<boolean> {
  const { rm } = await import("node:fs/promises");
  try {
    await rm(join(webLoginRoot(), "auth.json"), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** <profile>/DevToolsActivePort 是否存在：浏览器窗口还活着。 */
export function devtoolsPortAvailable(dir: string = profileDir(), exists: (p: string) => boolean = existsSync): boolean {
  return exists(join(dir, "DevToolsActivePort"));
}

/** 读 <profile>/DevToolsActivePort 第一行拿真实端口（浏览器用端口 0 启动时用）。 */
export function readRandomDevtoolsPort(dir: string = profileDir()): number | undefined {
  try {
    const text = readFileSync(join(dir, "DevToolsActivePort"), "utf8");
    const first = text.split(/\r?\n/u)[0];
    const port = Number(first);
    return Number.isFinite(port) && port > 0 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}
