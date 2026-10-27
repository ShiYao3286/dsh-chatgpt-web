/**
 * 最小 CDP（Chrome DevTools Protocol）客户端。
 *
 * 设计约束：
 *  - 不引第三方依赖：Node 22+ 自带 WebSocket / fetch，够用。
 *  - 只做"通道"：连接、发命令、收事件、发发现（/json/list）与探活。
 *    Runtime.evaluate 只作为通用能力暴露，不认识页面里的任何业务字段。
 *  - 崩溃/断线要能被上层（health）观察到：pending 全部 reject，挂断事件单独通知。
 *
 * 事件模型：CDP 用 id 关联"命令-响应"，用 method 广播"事件"。两者混在同一条
 * WebSocket 上，所以这里一个 message 循环里分流。
 */

/** 调试端口 HTTP 端点：/json/version 与 /json/list。 */
export interface DevtoolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  webSocketUrl?: string;
}

export interface EvaluateOptions {
  /** 是否等待 Promise 结算（页面里跑 async 函数时必须为 true）。 */
  awaitPromise?: boolean;
  /** 按值返回（否则拿到的是 RemoteObject 引用，序列化不出来）。 */
  returnByValue?: boolean;
  /** 视为用户手势触发（某些接口会检查）。 */
  userGesture?: boolean;
  /** 页面内执行超时（毫秒）。长任务必须显式给，CDP 默认很短。 */
  timeoutMs?: number;
  /** 执行上下文 id；默认 main world。 */
  contextId?: number;
  /** 在哪个 frame 里执行（与 contextId 二选一）。 */
  uniqueContextId?: string;
}

export type CdpEvent = (params: Record<string, unknown>) => void;

/** CDP 命令被浏览器拒绝（协议层错误，不是页面内异常）。 */
export class CdpProtocolError extends Error {
  readonly code: number | null;
  readonly detail: string;
  readonly method: string;
  constructor(method: string, code: number | null, detail: string) {
    super("CDP 命令失败 [" + method + "] " + (detail.length > 0 ? detail : "code=" + String(code)));
    this.name = "CdpProtocolError";
    this.method = method;
    this.code = code;
    this.detail = detail;
  }
}

/** 页面内表达式抛异常（Runtime.evaluate 返回 exceptionDetails）。 */
export class PageExceptionError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super("页面内异常: " + detail);
    this.name = "PageExceptionError";
    this.detail = detail;
  }
}

export class CdpClosedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("CDP 连接已关闭: " + reason);
    this.name = "CdpClosedError";
    this.reason = reason;
  }
}

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 默认的 WebSocket 构造器；拿不到就说明运行时太老。 */
export function defaultWebSocket(url: string): WebSocket {
  const ctor = (globalThis as { WebSocket?: new (u: string) => WebSocket }).WebSocket;
  if (ctor === undefined) throw new Error("当前运行时没有 WebSocket（需要 Node 22+）");
  return new ctor(url);
}

export interface CdpOptions {
  /** 单条命令的默认超时（毫秒）；0 表示不限。 */
  defaultTimeoutMs?: number;
  /**
   * WebSocket 构造器。默认用全局 WebSocket；
   * 暴露出来是为了让离线测试能在不碰真实浏览器的前提下驱动完整协议流程。
   */
  createWebSocket?: (url: string) => WebSocket;
}

export class Cdp {
  private readonly ws: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, CdpEvent[]>();
  private readonly closeHandlers: Array<(reason: string) => void> = [];
  private readonly defaultTimeoutMs: number;
  private closed = false;
  private closeReason = "";

  private constructor(ws: WebSocket, options: CdpOptions) {
    this.ws = ws;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev.data));
    ws.addEventListener("close", () => this.markClosed("socket closed"));
    ws.addEventListener("error", () => this.markClosed("socket error"));
  }

  /** 连接一个 webSocketDebuggerUrl。 */
  static connect(url: string, options: CdpOptions = {}): Promise<Cdp> {
    return new Promise<Cdp>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = (options.createWebSocket ?? defaultWebSocket)(url);
      } catch (err) {
        reject(new Error("CDP WebSocket 创建失败: " + describeError(err)));
        return;
      }
      const onOpenError = (): void => {
        cleanup();
        reject(new Error("CDP 连接失败: " + redactUrl(url)));
      };
      const cleanup = (): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onOpenError);
        ws.removeEventListener("close", onOpenError);
      };
      const onOpen = (): void => {
        cleanup();
        resolve(new Cdp(ws, options));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onOpenError);
      ws.addEventListener("close", onOpenError);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 关闭原因；未关闭时为空串。 */
  get closedReason(): string {
    return this.closeReason;
  }

  /** 发一条 CDP 命令。命令级错误 reject 为 CdpProtocolError。 */
  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new CdpClosedError(this.closeReason || "already closed"));
    }
    const id = ++this.seq;
    const effective = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer =
        effective > 0
          ? setTimeout(() => {
              if (!this.pending.has(id)) return;
              this.pending.delete(id);
              reject(new Error("CDP 命令超时 [" + method + "] " + effective + "ms"));
            }, effective)
          : null;
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.settle(id);
        reject(new Error("CDP 发送失败 [" + method + "]: " + describeError(err)));
      }
    });
  }

  /** 订阅 CDP 事件（如 Page.loadEventFired / Inspector.targetCrashed）。 */
  on(method: string, fn: CdpEvent): () => void {
    const list = this.handlers.get(method) ?? [];
    list.push(fn);
    this.handlers.set(method, list);
    return () => {
      const cur = this.handlers.get(method);
      if (!cur) return;
      const i = cur.indexOf(fn);
      if (i >= 0) cur.splice(i, 1);
    };
  }

  /** 订阅"连接断了/页面崩了"这一类终止事件。 */
  onClosed(fn: (reason: string) => void): () => void {
    if (this.closed) {
      fn(this.closeReason || "already closed");
      return () => {};
    }
    this.closeHandlers.push(fn);
    return () => {
      const i = this.closeHandlers.indexOf(fn);
      if (i >= 0) this.closeHandlers.splice(i, 1);
    };
  }

  /** 优雅关闭：先关 socket，再把所有挂起命令判失败。 */
  close(reason = "client closed"): void {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      /* 已经断了 */
    }
    this.markClosed(reason);
  }

  async enableRuntime(): Promise<void> {
    await this.send("Runtime.enable");
  }

  async enablePage(): Promise<void> {
    await this.send("Page.enable");
  }

  async enableNetwork(): Promise<void> {
    await this.send("Network.enable");
  }

  /**
   * 在页面上下文里求值。
   * 页面内抛异常时 reject 为 PageExceptionError（把页面里的错误原样带出来）。
   */
  async evaluate(expression: string, options: EvaluateOptions = {}): Promise<unknown> {
    const params: Record<string, unknown> = {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: options.userGesture ?? true,
    };
    if (options.timeoutMs !== undefined) params.timeout = options.timeoutMs;
    if (options.contextId !== undefined) params.contextId = options.contextId;
    if (options.uniqueContextId !== undefined) params.uniqueContextId = options.uniqueContextId;

    // 命令本身要比页面内执行稍宽一点，否则 CDP 先超时、错误信息就丢了。
    const cmdTimeout =
      options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs + 5000 : undefined;
    const result = await this.send("Runtime.evaluate", params, cmdTimeout);

    const exception = result.exceptionDetails as Record<string, unknown> | undefined;
    if (exception !== undefined && exception !== null) {
      throw new PageExceptionError(describeException(exception));
    }
    const remote = result.result as Record<string, unknown> | undefined;
    if (remote === undefined || remote === null) return undefined;
    if (remote.type === "undefined") return undefined;
    if ("value" in remote) return remote.value;
    // 结构化值（没有 returnByValue 时）或无法序列化的对象：给出可读降级。
    return remote.unserializableValue ?? remote.description ?? remote;
  }

  /** 页面导航并等 load 事件；load 等不到就按超时返回 false。 */
  async navigate(url: string, loadTimeoutMs = 30_000): Promise<boolean> {
    await this.enablePage();
    let loaded = false;
    const off = this.on("Page.loadEventFired", () => {
      loaded = true;
    });
    try {
      await this.send("Page.navigate", { url });
      const deadline = Date.now() + loadTimeoutMs;
      while (!loaded && Date.now() < deadline && !this.closed) {
        await sleep(100);
      }
      return loaded;
    } finally {
      off();
    }
  }

  async reload(loadTimeoutMs = 30_000): Promise<boolean> {
    await this.enablePage();
    let loaded = false;
    const off = this.on("Page.loadEventFired", () => {
      loaded = true;
    });
    try {
      await this.send("Page.reload", { ignoreCache: false });
      const deadline = Date.now() + loadTimeoutMs;
      while (!loaded && Date.now() < deadline && !this.closed) {
        await sleep(100);
      }
      return loaded;
    } finally {
      off();
    }
  }

  /** 当前主文档 URL（比 target 列表里的 url 更新，导航后会变）。 */
  async currentUrl(): Promise<string | null> {
    const r = await this.evaluate("location.href", { awaitPromise: false });
    return typeof r === "string" ? r : null;
  }

  /**
   * 把页面切到前台。
   *
   * 为什么必须做：Chrome 会节流**隐藏标签页**的网络请求（visibilityState === 'hidden'）。
   * 一旦窗口被最小化或被别的窗口完全遮住，页面里的 fetch 就可能长时间不 resolve ——
   * 表现是 CDP 命令超时，而错误信息里完全看不出原因。实测踩到过一次。
   */
  async bringToFront(): Promise<void> {
    await this.send("Page.bringToFront");
  }

  /** 页面当前是否被浏览器节流（隐藏/最小化）。 */
  async visibility(): Promise<{ hidden: boolean; state: string }> {
    const r = await this.evaluate(
      "({ hidden: document.hidden === true, state: String(document.visibilityState) })",
      { awaitPromise: false },
    );
    const o = (r ?? {}) as Record<string, unknown>;
    return { hidden: o.hidden === true, state: typeof o.state === "string" ? o.state : "unknown" };
  }

  /**
   * 让页面表现得像在前台。
   *
   * 背景：Chrome 会节流**隐藏标签页**。一旦窗口最小化或被完全遮挡，
   * 页面里的 fetch 会长时间不 resolve —— 表现为 CDP 命令超时，错误信息里
   * 完全看不出原因（实测踩过）。
   *
   * 只调 Pages.bringToFront 是**不够的**：窗口真被最小化时它唤不醒，
   * visibilityState 仍是 'hidden'，fetch 照样挂住。
   *
   * 可靠做法是在页面里覆写这两个只读属性，让页面自身按"可见"运行：
   * 这不是伪造请求头，也不会改变发出去的流量特征，只是解除浏览器对自己
   * 定时器/网络的节流。覆写后可稳定拿到 200。
   */
  async ensureVisible(): Promise<boolean> {
    try {
      const before = await this.visibility();
      if (!before.hidden) return true;
      try {
        await this.bringToFront();
        await sleep(120);
      } catch {
        // bringToFront 在真最小化时可能无效，继续走覆写路径。
      }
      const after = await this.visibility();
      if (!after.hidden) return true;
      const r = await this.evaluate(HIDDEN_OVERRIDE_EXPRESSION, { awaitPromise: false });
      return r === true;
    } catch {
      return false;
    }
  }

  /** 取 cookie（Network.getAllCookies，含 httpOnly）。 */
  async getAllCookies(): Promise<Array<Record<string, unknown>>> {
    await this.enableNetwork();
    const r = await this.send("Network.getAllCookies");
    const cookies = r.cookies;
    return Array.isArray(cookies) ? (cookies as Array<Record<string, unknown>>) : [];
  }

  private onMessage(raw: unknown): void {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
    else return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = msg.id;
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.settle(id);
      const error = msg.error as Record<string, unknown> | undefined;
      if (error !== undefined && error !== null) {
        const code = typeof error.code === "number" ? error.code : null;
        const detail = typeof error.message === "string" ? error.message : JSON.stringify(error);
        pending.reject(new CdpProtocolError(pending.method, code, detail));
        return;
      }
      const result = msg.result;
      pending.resolve(
        result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {},
      );
      return;
    }

    const method = msg.method;
    if (typeof method !== "string") return;
    if (method === "Inspector.targetCrashed") {
      this.markClosed("Inspector.targetCrashed");
      return;
    }
    const params =
      msg.params !== null && typeof msg.params === "object"
        ? (msg.params as Record<string, unknown>)
        : {};
    const list = this.handlers.get(method);
    if (list === undefined) return;
    for (const fn of [...list]) {
      try {
        fn(params);
      } catch {
        /* 单个监听器出错不能拖垮收包循环 */
      }
    }
  }

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (pending === undefined) continue;
      this.settle(id);
      pending.reject(new CdpClosedError(reason));
    }
    for (const fn of [...this.closeHandlers]) {
      try {
        fn(reason);
      } catch {
        /* 同上 */
      }
    }
    this.closeHandlers.length = 0;
  }

  private settle(id: number): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending.delete(id);
  }
}

// ---------------------------------------------------------------------------
// 发现 / 探活：调试端口的 HTTP 侧
// ---------------------------------------------------------------------------

export function devtoolsBaseUrl(port: number, host = "127.0.0.1"): string {
  return "http://" + host + ":" + String(port);
}

/** GET /json/version：成功即端口活着。 */
export async function probeDevtools(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(devtoolsBaseUrl(port, host) + "/json/version", { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 等调试端口就绪。 */
export async function waitForDevtools(
  port: number,
  totalMs: number,
  host = "127.0.0.1",
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  for (;;) {
    if (await probeDevtools(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** GET /json/list：所有可见 target（page / iframe / worker / service_worker）。 */
export async function listTargets(port: number, host = "127.0.0.1", timeoutMs = 3000): Promise<DevtoolsTarget[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(devtoolsBaseUrl(port, host) + "/json/list", { signal: ctrl.signal });
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return [];
    return raw.filter(isTarget).map(normalizeTarget);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 从 target 列表里挑页面：优先域名命中，其次第一个普通页面。 */
export function pickPageTarget(targets: readonly DevtoolsTarget[], wantHost?: string): DevtoolsTarget | null {
  const pages = targets.filter((t) => t.type === "page");
  if (wantHost !== undefined && wantHost.length > 0) {
    const hit = pages.find((t) => t.url.includes(wantHost));
    if (hit !== undefined) return hit;
  }
  return pages[0] ?? null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 页面里解除后台节流的表达式：把 visibilityState/hidden 覆写成"可见"。
 * 覆写是幂等的，重复执行无害。
 */
export const HIDDEN_OVERRIDE_EXPRESSION = [
  "(() => {",
  "  try {",
  "    if (document.visibilityState === 'visible') return true;",
  "    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });",
  "    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });",
  "    document.dispatchEvent(new Event('visibilitychange'));",
  "    return document.visibilityState === 'visible';",
  "  } catch (e) { return false; }",
  "})()",
].join("\n");

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 错误对象转一句可读文本（不吞 stack，但要短）。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function describeException(details: Record<string, unknown>): string {
  const exception = details.exception as Record<string, unknown> | undefined;
  if (exception !== undefined && exception !== null) {
    const desc = exception.description;
    if (typeof desc === "string" && desc.length > 0) return desc;
  }
  const text = details.text;
  if (typeof text === "string" && text.length > 0) return text;
  return JSON.stringify(details).slice(0, 500);
}

/** WebSocket URL 里带 token，出错误信息前先抹掉。 */
function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|key|secret)=)[^&]*/gi, "$1***");
}

function isTarget(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.type === "string" && typeof rec.id === "string";
}

function normalizeTarget(raw: unknown): DevtoolsTarget {
  const rec = raw as Record<string, unknown>;
  return {
    id: String(rec.id),
    type: String(rec.type),
    title: typeof rec.title === "string" ? rec.title : "",
    url: typeof rec.url === "string" ? rec.url : "",
    webSocketDebuggerUrl:
      typeof rec.webSocketDebuggerUrl === "string" ? rec.webSocketDebuggerUrl : "",
    webSocketUrl: typeof rec.webSocketUrl === "string" ? rec.webSocketUrl : undefined,
  };
}