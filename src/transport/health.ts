/**
 * 传输层健康检查：页面还活着吗？崩了怎么重挂？崩因写哪儿？
 *
 * 关键取舍：
 *  - **只判"页面可用"，不判业务**。这里不关心额度、模型、sentinel；
 *    那些失败有各自的语义，混进健康检查会让"重挂"变成粗暴的重试。
 *  - **崩溃绝不等于杀浏览器**。浏览器是用户自己开着的窗口，我们最多
 *    关掉自己的 WebSocket 再附着一次；实在不行才考虑拉起（且 detached）。
 *  - **每次异常都要留痕**。诊断条目写进 paths.diagnosticsDir()，出问题时
 *    用户能把文件直接发出来，不用复现。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { diagnosticsDir } from "../paths.ts";
import {
  DEFAULT_HOST,
  attachPage as defaultAttachPage,
  ensureBrowser as defaultEnsureBrowser,
  type BrowserOptions,
  type BrowserSession,
} from "./browser.ts";
import { Cdp, describeError, probeDevtools, sleep, type DevtoolsTarget } from "./cdp.ts";
import {
  CHATGPT_ORIGIN,
  probePage,
  readLoginState,
  waitForReady as defaultWaitForReady,
  type LoginState,
  type PageProbe,
} from "./page.ts";

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

export type DiagnosticKind = "health" | "crash" | "recover" | "attach" | "detach" | "probe";

export interface DiagnosticEntry {
  at: number;
  kind: DiagnosticKind;
  level: "info" | "warn" | "error";
  /** 一句话结论，直接给人看。 */
  message: string;
  /** 结构化细节；**不允许放 token / cookie / 邮箱明文**。 */
  detail: Record<string, unknown>;
}

export type DiagnosticsSink = (entry: DiagnosticEntry) => void;

/** 内存 sink，测试用（也方便上层接进自己的日志）。 */
export function createMemorySink(): { sink: DiagnosticsSink; entries: DiagnosticEntry[] } {
  const entries: DiagnosticEntry[] = [];
  return {
    entries,
    sink: (entry) => {
      entries.push(entry);
    },
  };
}

/** 当天诊断文件路径。按天切分，避免单文件无限增长。 */
export function diagnosticsFile(now: number = Date.now(), dir: string = diagnosticsDir()): string {
  const d = new Date(now);
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(dir, "transport-" + y + "-" + m + "-" + day + ".jsonl");
}

/**
 * 落盘 sink：一行一个 JSON。**永不抛异常** —— 诊断失败不能把主流程带崩。
 */
export function createFileSink(
  dir: string = diagnosticsDir(),
  now: () => number = () => Date.now(),
): DiagnosticsSink {
  return (entry) => {
    try {
      const file = diagnosticsFile(now(), dir);
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      /* 磁盘满 / 无权限都不该影响调用方 */
    }
  };
}

/** 多个 sink 合并；任一失败不影响其它。 */
export function composeSinks(...sinks: DiagnosticsSink[]): DiagnosticsSink {
  return (entry) => {
    for (const sink of sinks) {
      try {
        sink(entry);
      } catch {
        /* ignore */
      }
    }
  };
}

// ---------------------------------------------------------------------------
// 判定（纯函数，离线可测）
// ---------------------------------------------------------------------------

export type HealthStatus =
  | "healthy"
  | "logged-out"
  | "not-ready"
  | "navigated-away"
  | "unresponsive"
  | "crashed"
  | "detached"
  | "port-dead"
  | "error";

export interface LivenessInput {
  /** 有没有连着的 CDP。 */
  attached: boolean;
  cdpClosed: boolean;
  /** cdp.closedReason。 */
  closedReason: string;
  /** 存活探针是否超时。 */
  timedOut: boolean;
  /** 探针抛出的错误（非超时）。 */
  probeError: string | null;
  probe: PageProbe | null;
  login: LoginState | null;
  /** 调试端口 HTTP 端点是否可达。 */
  portAlive: boolean;
}

export interface HealthVerdict {
  status: HealthStatus;
  /** 给人看的崩因。 */
  reason: string;
  /** 重新附着/导航有没有可能修好它。 */
  recoverable: boolean;
  level: "info" | "warn" | "error";
}

/** 判定顺序：先判"连接没了"，再判"端口没了"，最后才是页面状态。 */
export function classifyHealth(input: LivenessInput): HealthVerdict {
  if (input.cdpClosed) {
    const crashed = input.closedReason.includes("targetCrashed");
    return {
      status: "crashed",
      reason: crashed
        ? "页面渲染进程崩溃（Inspector.targetCrashed）"
        : "CDP 连接断开（" + (input.closedReason || "unknown") + "）",
      recoverable: true,
      level: "error",
    };
  }
  if (!input.portAlive) {
    return {
      status: "port-dead",
      reason: "调试端口不可达，浏览器可能已退出",
      recoverable: true,
      level: "error",
    };
  }
  if (!input.attached) {
    return { status: "detached", reason: "尚未附着到任何页面", recoverable: true, level: "warn" };
  }
  if (input.timedOut) {
    return {
      status: "unresponsive",
      reason: "页面在存活探针上超时（渲染进程卡死或标签被冻结）",
      recoverable: true,
      level: "error",
    };
  }
  if (input.probeError !== null) {
    return { status: "error", reason: "存活探针失败: " + input.probeError, recoverable: true, level: "error" };
  }
  const probe = input.probe;
  if (probe === null) {
    return { status: "error", reason: "拿不到页面信息", recoverable: true, level: "warn" };
  }
  if (!probe.isChatGPT) {
    return {
      status: "navigated-away",
      reason: "页面已离开 chatgpt.com（当前 " + (probe.href || "unknown") + "）",
      recoverable: true,
      level: "warn",
    };
  }
  if (probe.readyState !== "complete") {
    return {
      status: "not-ready",
      reason: "页面仍在加载（readyState=" + probe.readyState + "）",
      recoverable: true,
      level: "info",
    };
  }
  if (input.login !== null && !input.login.loggedIn) {
    return {
      status: "logged-out",
      reason: "页面存活但未登录（session=" + String(input.login.sessionStatus) + "）",
      // 登录是用户动作，重挂修不好 —— 但也不该让调用方一直等。
      recoverable: false,
      level: "warn",
    };
  }
  return { status: "healthy", reason: "页面存活且已登录", recoverable: false, level: "info" };
}

// ---------------------------------------------------------------------------
// 监控器
// ---------------------------------------------------------------------------

export interface HealthReport extends HealthVerdict {
  checkedAt: number;
  latencyMs: number;
  probe: PageProbe | null;
  login: LoginState | null;
  /** 这次检查有没有触发重挂。 */
  recovered: boolean;
  /** 重挂过程走过哪些台阶。 */
  recoverySteps: string[];
}

export interface HealthDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  probePort: (port: number, host: string) => Promise<boolean>;
  attachPage: (session: BrowserSession, wantHost: string) => Promise<{ cdp: Cdp; target: DevtoolsTarget } | null>;
  ensureBrowser: (options: BrowserOptions) => Promise<BrowserSession>;
  probePage: (cdp: Cdp) => Promise<PageProbe>;
  waitForReady: typeof defaultWaitForReady;
  readLogin: (cdp: Cdp) => Promise<LoginState>;
}

export const defaultHealthDeps: HealthDeps = {
  now: () => Date.now(),
  sleep,
  probePort: (port, host) => probeDevtools(port, host),
  attachPage: (session, wantHost) => defaultAttachPage(session, wantHost),
  ensureBrowser: (options) => defaultEnsureBrowser(options),
  probePage,
  waitForReady: defaultWaitForReady,
  readLogin: readLoginState,
};

export interface HealthOptions {
  session: BrowserSession;
  /** 想附着的域名。 */
  wantHost?: string;
  /** 已附着的连接（可选；不传则首次 check 时自动附着）。 */
  cdp?: Cdp | null;
  diagnostics?: DiagnosticsSink;
  deps?: Partial<HealthDeps>;
  /** 存活探针超时。 */
  livenessTimeoutMs?: number;
  /** check 是否顺带判登录态；默认 true。 */
  checkLogin?: boolean;
  /** 允许在端口死掉时拉起浏览器。 */
  allowSpawn?: boolean;
}

/** 存活探针：最便宜的表达式，只证明渲染进程还在响应。 */
export const LIVENESS_EXPRESSION =
  "(() => ({ ok: true, href: String(location.href), ready: String(document.readyState) }))()";

export class HealthMonitor {
  private session: BrowserSession;
  private cdp: Cdp | null;
  private readonly wantHost: string;
  private readonly diagnostics: DiagnosticsSink;
  private readonly deps: HealthDeps;
  private readonly livenessTimeoutMs: number;
  private readonly checkLogin: boolean;
  private readonly allowSpawn: boolean;

  constructor(options: HealthOptions) {
    this.session = options.session;
    this.cdp = options.cdp ?? null;
    this.wantHost = options.wantHost ?? "chatgpt.com";
    this.diagnostics = options.diagnostics ?? createFileSink();
    this.deps = { ...defaultHealthDeps, ...(options.deps ?? {}) };
    this.livenessTimeoutMs = options.livenessTimeoutMs ?? 4000;
    this.checkLogin = options.checkLogin ?? true;
    this.allowSpawn = options.allowSpawn ?? true;
  }

  get connection(): Cdp | null {
    return this.cdp;
  }

  get currentSession(): BrowserSession {
    return this.session;
  }

  /** 主动挂上连接（上层拿到 attachPage 的结果后可直接塞进来）。 */
  attach(cdp: Cdp): void {
    this.cdp = cdp;
  }

  /** 只诊断，不修。 */
  async check(): Promise<HealthReport> {
    const started = this.deps.now();
    const cdp = this.cdp;

    let portAlive = true;
    let timedOut = false;
    let probeError: string | null = null;
    let probe: PageProbe | null = null;
    let login: LoginState | null = null;

    if (cdp === null) {
      portAlive = await this.deps.probePort(this.session.port, this.session.host);
    } else if (!cdp.isClosed) {
      const liveness = await this.liveness(cdp);
      if (liveness.kind === "timeout") timedOut = true;
      else if (liveness.kind === "error") probeError = liveness.message;
      if (probeError === null && !timedOut) {
        portAlive = await this.deps.probePort(this.session.port, this.session.host);
        if (portAlive) {
          try {
            probe = await this.deps.probePage(cdp);
          } catch (err) {
            probeError = describeError(err).slice(0, 300);
          }
          if (probe !== null && probe.isChatGPT && this.checkLogin) {
            try {
              login = await this.deps.readLogin(cdp);
            } catch {
              login = null;
            }
          }
        }
      }
    }

    const verdict = classifyHealth({
      attached: cdp !== null,
      cdpClosed: cdp !== null && cdp.isClosed,
      closedReason: cdp === null ? "" : cdp.closedReason,
      timedOut,
      probeError,
      probe,
      login,
      portAlive,
    });

    return {
      ...verdict,
      checkedAt: started,
      latencyMs: this.deps.now() - started,
      probe,
      login,
      recovered: false,
      recoverySteps: [],
    };
  }

  /**
   * 检查并在必要时重挂。
   * 重挂阶梯：重新附着 -> （端口死）重新拉起 -> 导航回 chatgpt.com。
   * 每一步都写诊断。
   */
  async ensureHealthy(): Promise<HealthReport> {
    const first = await this.check();
    if (first.status === "healthy" || first.status === "logged-out") {
      return first;
    }

    const steps: string[] = [];

    // 还在加载不是崩溃：等它加载完再判，别把好好的标签页关了重挂。
    if (first.status === "not-ready" && this.cdp !== null) {
      await this.deps.waitForReady(this.cdp, { timeoutMs: 20_000 });
      const ready = await this.check();
      const ok = ready.status === "healthy" || ready.status === "logged-out";
      return { ...ready, recovered: ok, recoverySteps: ["wait-ready"] };
    }

    this.record({
      kind: "crash",
      level: first.level === "info" ? "warn" : first.level,
      message: first.reason,
      detail: {
        status: first.status,
        closedReason: this.cdp === null ? null : this.cdp.closedReason,
        href: first.probe === null ? null : first.probe.href,
        latencyMs: first.latencyMs,
      },
    });

    // 台阶 1：丢掉旧连接，重新附着（页面可能还在，只是 socket 断了）
    this.dropConnection(steps);

    let session = this.session;
    let portAlive = await this.deps.probePort(session.port, session.host);

    // 台阶 2：端口没了，按需重新拉起（仍然是 detached，不接管生命周期）
    if (!portAlive && this.allowSpawn) {
      steps.push("spawn-browser");
      this.record({ kind: "recover", level: "warn", message: "调试端口不可达，重新拉起浏览器", detail: { port: session.port } });
      try {
        session = await this.deps.ensureBrowser({
          port: session.port,
          host: session.host,
          profileDir: session.profileDir,
        });
        this.session = session;
        portAlive = true;
      } catch (err) {
        steps.push("spawn-failed");
        this.record({
          kind: "recover",
          level: "error",
          message: "重新拉起浏览器失败: " + describeError(err),
          detail: { port: session.port },
        });
      }
    }

    if (portAlive) {
      // 台阶 3：附着
      const attached = await this.tryAttach(session, steps);
      if (attached !== null) {
        // 台阶 4：页面不在 chatgpt.com 就导航回去
        await this.tryNavigate(attached, steps);
      }
    }

    const second = await this.check();
    const recovered = second.status === "healthy" || second.status === "logged-out";
    const report: HealthReport = { ...second, recovered, recoverySteps: steps };

    this.record({
      kind: "health",
      level: recovered ? "info" : "error",
      message: (recovered ? "已恢复：" : "未能恢复：") + second.reason,
      detail: { status: second.status, recovered, steps, latencyMs: second.latencyMs },
    });

    return report;
  }

  /** 断开我们的 CDP 连接（**不会**关浏览器）。 */
  close(): void {
    this.dropConnection([]);
  }

  private dropConnection(steps: string[]): void {
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp !== null && !cdp.isClosed) {
      steps.push("detach");
      try {
        cdp.close("health reattach");
      } catch {
        /* ignore */
      }
      this.record({ kind: "detach", level: "info", message: "已断开旧 CDP 连接", detail: {} });
    }
  }

  private async tryAttach(session: BrowserSession, steps: string[]): Promise<Cdp | null> {
    try {
      const attached = await this.deps.attachPage(session, this.wantHost);
      if (attached === null) {
        steps.push("attach:no-page");
        this.record({
          kind: "attach",
          level: "warn",
          message: "没有可附着的页面 target",
          detail: { port: session.port, wantHost: this.wantHost },
        });
        return null;
      }
      this.cdp = attached.cdp;
      steps.push("attach");
      this.record({
        kind: "attach",
        level: "info",
        message: "已重新附着页面",
        detail: { targetId: attached.target.id, url: attached.target.url.slice(0, 200) },
      });
      return attached.cdp;
    } catch (err) {
      steps.push("attach:failed");
      this.record({
        kind: "attach",
        level: "error",
        message: "附着失败: " + describeError(err),
        detail: { port: session.port },
      });
      return null;
    }
  }

  private async tryNavigate(cdp: Cdp, steps: string[]): Promise<void> {
    try {
      const probe = await this.deps.probePage(cdp);
      if (probe.isChatGPT) return;
      steps.push("navigate");
      this.record({
        kind: "recover",
        level: "warn",
        message: "页面不在 chatgpt.com，导航回站点",
        detail: { from: probe.href.slice(0, 200) },
      });
      await cdp.navigate(CHATGPT_ORIGIN, 45_000);
      await this.deps.waitForReady(cdp, { timeoutMs: 20_000 });
    } catch (err) {
      steps.push("navigate:failed");
      this.record({
        kind: "recover",
        level: "error",
        message: "导航回站点失败: " + describeError(err),
        detail: {},
      });
    }
  }

  private async liveness(cdp: Cdp): Promise<{ kind: "ok" } | { kind: "timeout" } | { kind: "error"; message: string }> {
    const probe = cdp
      .evaluate(LIVENESS_EXPRESSION, { awaitPromise: false })
      .then((): { kind: "ok" } => ({ kind: "ok" }))
      .catch((err: unknown): { kind: "timeout" } | { kind: "error"; message: string } => {
        const message = describeError(err);
        if (message.includes("超时") || message.includes("timeout")) return { kind: "timeout" };
        return { kind: "error", message };
      });
    const timer = this.deps.sleep(this.livenessTimeoutMs).then((): { kind: "timeout" } => ({ kind: "timeout" }));
    return await Promise.race([probe, timer]);
  }

  private record(entry: Omit<DiagnosticEntry, "at">): void {
    const full: DiagnosticEntry = { at: this.deps.now(), ...entry };
    try {
      this.diagnostics(full);
    } catch {
      /* 诊断失败不能影响主流程 */
    }
  }
}

/** 便捷入口：给定浏览器会话，返回一个已附着（尽力）的监控器。 */
export async function openHealth(
  options: HealthOptions,
): Promise<{ monitor: HealthMonitor; report: HealthReport }> {
  const monitor = new HealthMonitor(options);
  const report = await monitor.ensureHealthy();
  return { monitor, report };
}

/** 默认健康检查（不重挂）用的简化入口，给上层做"探一下"用。 */
export async function probeHealth(port: number = 9222, host: string = DEFAULT_HOST): Promise<boolean> {
  return probeDevtools(port, host);
}