/**
 * 传输层（transport）出口。
 *
 * 分四个模块，职责不重叠：
 *   cdp.ts     纯协议：WebSocket + 命令/事件 + 调试端口 HTTP 发现
 *   browser.ts 进程与会话：复用或拉起浏览器（detached + unref），附着页面
 *   page.ts    页面事实：ready / 登录态 / accessToken / data-build / 页面环境
 *   health.ts  健康与自愈：存活探测、重挂阶梯、诊断落盘
 *
 * 这一层**不做 PoW、不发业务请求**。页面上下文里的 fetch 由 wire 层负责，
 * 但它必须通过这里拿到的 Cdp 连接去执行。
 */

export {
  Cdp,
  CdpClosedError,
  CdpProtocolError,
  PageExceptionError,
  describeError,
  devtoolsBaseUrl,
  listTargets,
  pickPageTarget,
  probeDevtools,
  sleep,
  waitForDevtools,
  type CdpEvent,
  type CdpOptions,
  type DevtoolsTarget,
  type EvaluateOptions,
} from "./cdp.ts";

export {
  BrowserError,
  DEFAULT_ATTACH_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_START_URL,
  attachPage,
  browserCandidates,
  buildLaunchArgs,
  connectTarget,
  defaultBrowserDeps,
  describeSession,
  detachedSpawnOptions,
  ensureBrowser,
  findBrowserExecutable,
  isProfileLocked,
  readDevToolsActivePort,
  resolveBrowserOptions,
  waitForPage,
  type BrowserDeps,
  type BrowserMode,
  type BrowserOptions,
  type BrowserSession,
  type ResolvedBrowserOptions,
  type SpawnedChild,
} from "./browser.ts";

export {
  CHATGPT_HOST,
  CHATGPT_ORIGIN,
  ensureChatGPT,
  evalInPage,
  getAccessToken,
  getDataBuild,
  isOnChatGPT,
  judgeLogin,
  loginProbeExpression,
  pageEnvExpression,
  pageProbeExpression,
  probePage,
  readLoginState,
  readPageEnv,
  waitForLogin,
  waitForReady,
  type LoginState,
  type PageEnv,
  type PageProbe,
  type WaitReadyOptions,
} from "./page.ts";

export {
  HealthMonitor,
  LIVENESS_EXPRESSION,
  classifyHealth,
  composeSinks,
  createFileSink,
  createMemorySink,
  defaultHealthDeps,
  diagnosticsFile,
  openHealth,
  probeHealth,
  type DiagnosticEntry,
  type DiagnosticKind,
  type DiagnosticsSink,
  type HealthDeps,
  type HealthOptions,
  type HealthReport,
  type HealthStatus,
  type HealthVerdict,
  type LivenessInput,
} from "./health.ts";
