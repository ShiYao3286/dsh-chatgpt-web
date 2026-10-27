/**
 * 浏览器进程管理：附着（attach）或拉起（spawn）一个带调试端口的 Edge/Chrome。
 *
 * 两条必须守住的底线：
 *  1. **不接管生命周期**。spawn 一律 detached + unref + stdio:'ignore'，
 *     这样 DSH 退出时不会把浏览器带走（用户可能还开着窗口在用）。
 *  2. **能复用就复用**。调试端口已经活着就只附着，不再起第二个进程 ——
 *     同一个 user-data-dir 起第二个实例会被 Chrome 自己转交给第一个进程，
 *     表现为"端口起不来"，非常难排查。
 *
 * 这里只管进程与端口，不认识页面内容（那是 page.ts 的事）。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { profileDir as defaultProfileDir } from "../paths.ts";
import {
  Cdp,
  describeError,
  listTargets,
  pickPageTarget,
  probeDevtools,
  sleep,
  waitForDevtools,
  type DevtoolsTarget,
} from "./cdp.ts";

export const DEFAULT_PORT = 9222;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_START_URL = "https://chatgpt.com/";
export const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

/** 各平台的浏览器候选路径，按优先级排列。 */
export function browserCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

/** 找一个真实存在的浏览器可执行文件；显式配置优先。 */
export function findBrowserExecutable(
  explicit?: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const envOverride = process.env.DSH_CHATGPT_WEB_BROWSER;
  const candidates = [explicit, envOverride, ...browserCandidates(platform)];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate.length === 0) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

export interface BrowserOptions {
  /** 调试端口，默认 9222。 */
  port?: number;
  host?: string;
  /** user-data-dir；默认 src/paths.ts 的 profileDir()。 */
  profileDir?: string;
  /** 浏览器可执行文件；默认自动探测。 */
  executable?: string;
  /** 启动时打开的地址。 */
  startUrl?: string;
  /** --window-size 的值。 */
  windowSize?: string;
  /** 已经有一个调试端口活着时是否直接复用；恒为 true（保留字段便于显式表达意图）。 */
  reuse?: boolean;
  /** 端口没活时是否自己拉起；false = 只做附着，端口不在直接失败。 */
  spawnIfMissing?: boolean;
  /** 等端口就绪的总时长。 */
  attachTimeoutMs?: number;
  /** 追加给浏览器的参数。 */
  extraArgs?: string[];
}

export interface ResolvedBrowserOptions {
  port: number;
  host: string;
  profileDir: string;
  executable: string | null;
  startUrl: string;
  windowSize: string;
  spawnIfMissing: boolean;
  attachTimeoutMs: number;
  extraArgs: string[];
}

export function resolveBrowserOptions(options: BrowserOptions = {}): ResolvedBrowserOptions {
  return {
    port: options.port ?? DEFAULT_PORT,
    host: options.host ?? DEFAULT_HOST,
    profileDir: options.profileDir ?? defaultProfileDir(),
    executable: options.executable ?? null,
    startUrl: options.startUrl ?? DEFAULT_START_URL,
    windowSize: options.windowSize ?? "1280,900",
    spawnIfMissing: options.spawnIfMissing ?? true,
    attachTimeoutMs: options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
    extraArgs: options.extraArgs ?? [],
  };
}

/**
 * 浏览器启动参数。纯函数，离线可测。
 *
 * 注意 --disable-blink-features=AutomationControlled：不加这一条，
 * navigator.webdriver 会是 true，免费档的风控会直接降级体验。
 */
export function buildLaunchArgs(options: ResolvedBrowserOptions): string[] {
  return [
    "--remote-debugging-port=" + String(options.port),
    "--user-data-dir=" + options.profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--window-size=" + options.windowSize,
    "--disable-features=Translate",
    ...options.extraArgs,
    options.startUrl,
  ];
}

/** spawn 选项。**detached 必须为 true**，否则 DSH 退出会带走浏览器。 */
export function detachedSpawnOptions(): { detached: true; stdio: "ignore"; windowsHide: boolean } {
  return { detached: true, stdio: "ignore", windowsHide: false };
}

export interface SpawnedChild {
  pid?: number;
  unref: () => void;
}

/** spawn 的可注入面：测试用假实现，生产用 node:child_process。 */
export interface BrowserDeps {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => SpawnedChild;
  probe: (port: number, host: string) => Promise<boolean>;
  waitForPort: (port: number, totalMs: number, host: string) => Promise<boolean>;
  targetList: (port: number, host: string) => Promise<DevtoolsTarget[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
  /** CDP 连接工厂；默认走真实 WebSocket，测试注入假实现。 */
  connect: (webSocketDebuggerUrl: string) => Promise<Cdp>;
}

export const defaultBrowserDeps: BrowserDeps = {
  spawn: (command, args, options) => nodeSpawn(command, args, options) as unknown as SpawnedChild,
  probe: (port, host) => probeDevtools(port, host),
  waitForPort: (port, totalMs, host) => waitForDevtools(port, totalMs, host),
  targetList: (port, host) => listTargets(port, host),
  sleep,
  now: () => Date.now(),
  exists: existsSync,
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  connect: (url) => Cdp.connect(url),
};

export type BrowserMode = "reused" | "spawned";

export interface BrowserSession {
  mode: BrowserMode;
  port: number;
  host: string;
  baseUrl: string;
  profileDir: string;
  executable: string | null;
  /** 只有自建进程才有 pid；复用时为 null。 */
  pid: number | null;
  startedAt: number;
  /** 复用时为 true。 */
  reused: boolean;
}

export class BrowserError extends Error {
  readonly stage: string;
  readonly hint: string;
  constructor(stage: string, message: string, hint = "") {
    super(message);
    this.name = "BrowserError";
    this.stage = stage;
    this.hint = hint;
  }
}

/**
 * 确保调试端口可用：能复用就复用，不能就拉起。
 * **不会在失败时杀掉任何进程**（可能不是我们起的）。
 */
export async function ensureBrowser(
  options: BrowserOptions = {},
  deps: BrowserDeps = defaultBrowserDeps,
): Promise<BrowserSession> {
  const opts = resolveBrowserOptions(options);
  const baseUrl = "http://" + opts.host + ":" + String(opts.port);

  if (await deps.probe(opts.port, opts.host)) {
    return {
      mode: "reused",
      port: opts.port,
      host: opts.host,
      baseUrl,
      profileDir: opts.profileDir,
      executable: null,
      pid: null,
      startedAt: deps.now(),
      reused: true,
    };
  }

  if (!opts.spawnIfMissing) {
    throw new BrowserError(
      "attach",
      "调试端口 " + String(opts.port) + " 不可用，且已禁止自行拉起浏览器",
      "先手动启动：<浏览器> --remote-debugging-port=" + String(opts.port) + " --user-data-dir=<profile>",
    );
  }

  const executable = opts.executable ?? findBrowserExecutable(undefined, process.platform, deps.exists);
  if (executable === null) {
    throw new BrowserError(
      "locate",
      "未找到可用的 Edge/Chrome 可执行文件",
      "设置 DSH_CHATGPT_WEB_BROWSER=<可执行文件路径>",
    );
  }

  deps.mkdir(opts.profileDir);

  // 同一个 profile 已经被别的实例占用时，新进程会把参数转交给老进程然后自己退出，
  // 端口永远不会开。这种情况直接给结论，比等 30 秒超时有用得多。
  if (isProfileLocked(opts.profileDir, deps.exists)) {
    throw new BrowserError(
      "spawn",
      "profile 已被另一个浏览器实例占用：" + opts.profileDir,
      "关闭那个浏览器窗口后重试，或改用 --user-data-dir 指向别的目录",
    );
  }

  const args = buildLaunchArgs(opts);
  let child: SpawnedChild;
  try {
    child = deps.spawn(executable, args, detachedSpawnOptions());
  } catch (err) {
    throw new BrowserError("spawn", "浏览器启动失败: " + describeError(err), executable);
  }
  // 关键：unref 之后 DSH 退出不会等待也不带走浏览器。
  try {
    child.unref();
  } catch {
    /* 某些桩实现没有 unref */
  }

  const ready = await deps.waitForPort(opts.port, opts.attachTimeoutMs, opts.host);
  if (!ready) {
    throw new BrowserError(
      "spawn",
      "浏览器已拉起但调试端口在 " + String(opts.attachTimeoutMs) + "ms 内未就绪",
      "检查是否有安全软件拦截，或先手动启动浏览器再重试",
    );
  }

  return {
    mode: "spawned",
    port: opts.port,
    host: opts.host,
    baseUrl,
    profileDir: opts.profileDir,
    executable,
    pid: child.pid ?? null,
    startedAt: deps.now(),
    reused: false,
  };
}

/**
 * 附着到一个 chatgpt 页面 target。
 * 没有合适的页面时返回 null（由 page.ts 决定是导航还是重开标签）。
 */
export async function attachPage(
  session: BrowserSession,
  wantHost = "chatgpt.com",
  deps: BrowserDeps = defaultBrowserDeps,
): Promise<{ cdp: Cdp; target: DevtoolsTarget } | null> {
  const targets = await deps.targetList(session.port, session.host);
  const target = pickPageTarget(targets, wantHost);
  if (target === null || target.webSocketDebuggerUrl.length === 0) return null;
  const cdp = await deps.connect(target.webSocketDebuggerUrl);
  return { cdp, target };
}

/** 只要连接（不改页面），给 health 层复用。 */
export async function connectTarget(target: DevtoolsTarget): Promise<Cdp> {
  return Cdp.connect(target.webSocketDebuggerUrl);
}

/**
 * profile 是否已被占用。
 * Windows 上 Chrome/Edge 用 lockfile；POSIX 上一般是 SingletonLock 符号链接。
 */
export function isProfileLocked(
  profileDir: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  for (const name of ["lockfile", "SingletonLock", "SingletonCookie"]) {
    if (exists(join(profileDir, name))) return true;
  }
  return false;
}

/**
 * 读 DevToolsActivePort（浏览器以 --remote-debugging-port=0 启动时写下的端口）。
 * 拿不到就返回 null。
 */
export function readDevToolsActivePort(
  profileDir: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  exists: (p: string) => boolean = existsSync,
): number | null {
  const file = join(profileDir, "DevToolsActivePort");
  if (!exists(file)) return null;
  try {
    const first = read(file).split(/\r?\n/, 1)[0]?.trim() ?? "";
    const port = Number.parseInt(first, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** 给日志/诊断用的一句话摘要（不含敏感路径之外的东西）。 */
export function describeSession(session: BrowserSession): string {
  const where = session.mode === "reused" ? "复用已有浏览器" : "新拉起浏览器";
  const pid = session.pid === null ? "" : " pid=" + String(session.pid);
  return where + " " + session.baseUrl + pid + " profile=" + session.profileDir;
}

/** 导出给上层做重试退避用。 */
export async function waitForPage(
  session: BrowserSession,
  wantHost: string,
  totalMs: number,
  deps: BrowserDeps = defaultBrowserDeps,
): Promise<DevtoolsTarget | null> {
  const deadline = deps.now() + totalMs;
  for (;;) {
    const targets = await deps.targetList(session.port, session.host);
    const page = pickPageTarget(targets, wantHost);
    if (page !== null && page.webSocketDebuggerUrl.length > 0) return page;
    if (deps.now() >= deadline) return null;
    await deps.sleep(300);
  }
}