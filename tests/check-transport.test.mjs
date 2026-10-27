// 传输层离线测试。
//
// 铁律：**不启动任何浏览器**，也不碰真实 WebSocket / HTTP。
// Cdp 允许注入 WebSocket 构造器，browser 允许注入 spawn/probe，health 允许注入全套依赖，
// 所以整条链路的协议流程都能在进程内跑完。

import { ok, eq, deepEq, section } from "./harness.mjs";

import {
  Cdp,
  CdpClosedError,
  CdpProtocolError,
  PageExceptionError,
  defaultWebSocket,
  devtoolsBaseUrl,
  listTargets,
  pickPageTarget,
  probeDevtools,
  waitForDevtools,
} from "../src/transport/cdp.ts";

import {
  BrowserError,
  attachPage,
  browserCandidates,
  buildLaunchArgs,
  defaultBrowserDeps,
  describeSession,
  detachedSpawnOptions,
  ensureBrowser,
  findBrowserExecutable,
  isProfileLocked,
  readDevToolsActivePort,
  resolveBrowserOptions,
} from "../src/transport/browser.ts";

import {
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
} from "../src/transport/page.ts";

import {
  HealthMonitor,
  LIVENESS_EXPRESSION,
  classifyHealth,
  composeSinks,
  createFileSink,
  createMemorySink,
  diagnosticsFile,
  probeHealth,
} from "../src/transport/health.ts";

// ---------------------------------------------------------------------------
// 全程守门：默认 spawn / 默认 connect 一旦被走到就立刻炸。
// 这条断言比"某个用例没调 spawn"强得多 —— 它证明整份测试没有可能拉起浏览器。
// ---------------------------------------------------------------------------

let defaultSpawnCalls = 0;
let defaultConnectCalls = 0;
const realDefaultSpawn = defaultBrowserDeps.spawn;
const realDefaultConnect = defaultBrowserDeps.connect;

defaultBrowserDeps.spawn = () => {
  defaultSpawnCalls += 1;
  throw new Error("测试里绝不允许真的启动浏览器");
};
defaultBrowserDeps.connect = async () => {
  defaultConnectCalls += 1;
  throw new Error("测试里绝不允许真的连 CDP");
};

// ---------------------------------------------------------------------------
// 假 WebSocket：把页面侧的 CDP 行为演出来
// ---------------------------------------------------------------------------

function createFakeSocket() {
  const listeners = new Map();
  const socket = {
    sent: [],
    closed: false,
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    send(text) {
      if (socket.closed) throw new Error("socket 已关闭");
      const msg = JSON.parse(text);
      socket.sent.push(msg);
      queueMicrotask(() => socket.receive(msg));
    },
    close() {
      if (socket.closed) return;
      socket.closed = true;
      socket.emit("close", {});
    },
    emit(type, event) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
    receive(msg) {
      socket.emit("message", { data: JSON.stringify(msg) });
    },
    respond(msg, result) {
      socket.receive({ id: msg.id, result });
    },
    fail(msg, code, message) {
      socket.receive({ id: msg.id, error: { code, message } });
    },
    push(method, params) {
      socket.emit("message", { data: JSON.stringify({ method, params }) });
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
  return socket;
}

/** 造一个已经握手成功的 Cdp（注入上面那块假 socket）。 */
function connectFake(handler, options = {}) {
  let socket = null;
  const factory = (url) => {
    socket = createFakeSocket();
    socket.url = url;
    socket.send = (text) => {
      const msg = JSON.parse(text);
      socket.sent.push(msg);
      queueMicrotask(() => handler(socket, msg));
    };
    queueMicrotask(() => socket.emit("open", {}));
    return socket;
  };
  return Cdp.connect("ws://fake/devtools/page/1", { createWebSocket: factory, ...options }).then(
    (cdp) => ({ cdp, get socket() { return socket; } }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 常见桩：所有命令都返回空结果，evaluate 返回给定值。 */
function simpleHandler(values = {}) {
  return (socket, msg) => {
    if (msg.method === "Runtime.evaluate") {
      const hit = values[msg.params.expression];
      if (hit === undefined) return socket.respond(msg, { result: { type: "undefined" } });
      if (hit instanceof Error) {
        return socket.respond(msg, {
          result: { type: "object" },
          exceptionDetails: { text: hit.message, exception: { description: hit.message } },
        });
      }
      return socket.respond(msg, { result: { type: "string", value: hit } });
    }
    socket.respond(msg, {});
  };
}

// ---------------------------------------------------------------------------

section("默认 WebSocket 构造器");
ok(typeof defaultWebSocket === "function", "defaultWebSocket 已导出");
ok(typeof globalThis.WebSocket === "function", "Node 22+ 运行时自带 WebSocket");

/** 什么都不回：需要测试自己控制响应时机时用。 */
const silent = () => {};

section("Cdp：命令-响应配对");
{
  const { cdp, socket } = await connectFake(silent);
  eq(socket.url, "ws://fake/devtools/page/1", "连的是给的那条 URL");
  const p = cdp.send("Runtime.enable");
  await tick();
  eq(socket.sent.length, 1, "命令已发出");
  eq(socket.sent[0].method, "Runtime.enable", "方法名正确");
  eq(socket.sent[0].id, 1, "id 从 1 开始");
  socket.respond(socket.sent[0], { ok: 1 });
  deepEq(await p, { ok: 1 }, "结果原样返回");

  const p2 = cdp.send("Page.enable");
  await tick();
  eq(socket.sent[1].id, 2, "id 递增");
  socket.respond(socket.sent[1], {});
  await p2;
  cdp.close();
  ok(cdp.isClosed, "close 后 isClosed 为真");
}

section("Cdp：协议错误 -> CdpProtocolError");
{
  const { cdp, socket } = await connectFake(silent);
  const p = cdp.send("Page.navigate", { url: "x" });
  await tick();
  socket.fail(socket.sent[0], -32000, "Cannot navigate");
  let caught = null;
  try { await p; } catch (e) { caught = e; }
  ok(caught instanceof CdpProtocolError, "抛 CdpProtocolError");
  eq(caught.code, -32000, "带上错误码");
  ok(caught.message.includes("Cannot navigate"), "带上原错误文案");
  eq(caught.method, "Page.navigate", "带上方法名");
  cdp.close();
}

section("Cdp：页面内异常 -> PageExceptionError");
{
  const { cdp } = await connectFake(
    simpleHandler({ boom: new Error("ReferenceError: nope") }),
  );
  let caught = null;
  try { await cdp.evaluate("boom"); } catch (e) { caught = e; }
  ok(caught instanceof PageExceptionError, "抛 PageExceptionError");
  ok(caught.message.includes("ReferenceError"), "带出页面内错误文案");
  cdp.close();
}

section("Cdp：evaluate 的默认参数与返回值");
{
  const { cdp, socket } = await connectFake(
    (sock, msg) => {
      sock.respond(msg, { result: { type: "number", value: 42 } });
    },
  );
  const v = await cdp.evaluate("1+1");
  eq(v, 42, "按值返回");
  const params = socket.sent[0].params;
  eq(params.awaitPromise, true, "默认等 Promise");
  eq(params.returnByValue, true, "默认按值返回");
  eq(params.userGesture, true, "默认视为用户手势");
  ok(!("timeout" in params), "未指定时不写 timeout");

  await cdp.evaluate("x", { awaitPromise: false, userGesture: false, timeoutMs: 1234 });
  eq(socket.sent[1].params.awaitPromise, false, "可覆盖 awaitPromise");
  eq(socket.sent[1].params.userGesture, false, "可覆盖 userGesture");
  eq(socket.sent[1].params.timeout, 1234, "timeout 透传");
  cdp.close();
}

section("Cdp：undefined / unserializable 降级");
{
  const { cdp } = await connectFake((sock, msg) => {
    if (msg.params.expression === "u") return sock.respond(msg, { result: { type: "undefined" } });
    if (msg.params.expression === "n") {
      return sock.respond(msg, { result: { type: "number", unserializableValue: "NaN" } });
    }
    return sock.respond(msg, { result: { type: "object", objectId: "obj-1", description: "Object" } });
  });
  eq(await cdp.evaluate("u"), undefined, "undefined 类型 -> undefined");
  eq(await cdp.evaluate("n"), "NaN", "unserializableValue 兜底");
  eq(await cdp.evaluate("o"), "Object", "无法取值时退回 description");
  cdp.close();
}

section("Cdp：事件订阅");
{
  const { cdp, socket } = await connectFake(simpleHandler());
  const seen = [];
  const off = cdp.on("Page.loadEventFired", (p) => seen.push(p));
  socket.push("Page.loadEventFired", { timestamp: 1 });
  eq(seen.length, 1, "收到事件");
  eq(seen[0].timestamp, 1, "载荷原样");
  socket.push("Page.unrelated", {});
  eq(seen.length, 1, "无关事件不触发");
  off();
  socket.push("Page.loadEventFired", { timestamp: 2 });
  eq(seen.length, 1, "取消订阅后不再触发");
  cdp.close();
}

section("Cdp：坏消息不炸收包循环");
{
  const { cdp, socket } = await connectFake(simpleHandler());
  const seen = [];
  cdp.on("X", () => seen.push("x"));
  socket.emit("message", { data: "not json" });
  socket.emit("message", { data: JSON.stringify({ id: 999, result: {} }) });
  socket.emit("message", { data: JSON.stringify({ method: "X", params: null }) });
  eq(seen.length, 1, "非法 JSON / 未知 id 被忽略，正常事件仍到达");
  cdp.close();
}

section("Cdp：崩溃事件 -> 挂起命令全部失败");
{
  const { cdp, socket } = await connectFake(silent);
  const pending = cdp.send("Runtime.evaluate", { expression: "1" });
  await tick();
  socket.push("Inspector.targetCrashed", {});
  let caught = null;
  try { await pending; } catch (e) { caught = e; }
  ok(caught instanceof CdpClosedError, "挂起命令被判 CdpClosedError");
  ok(cdp.isClosed, "连接进入 closed");
  eq(cdp.closedReason, "Inspector.targetCrashed", "崩因保留");
}

section("Cdp：关闭后的调用立即失败");
{
  const { cdp } = await connectFake(simpleHandler());
  cdp.close("test");
  let caught = null;
  try { await cdp.send("Page.enable"); } catch (e) { caught = e; }
  ok(caught instanceof CdpClosedError, "send 抛 CdpClosedError");
  const reasons = [];
  cdp.onClosed((r) => reasons.push(r));
  eq(reasons.length, 1, "已关闭时 onClosed 立即回调");
}

section("Cdp：命令超时");
{
  const { cdp } = await connectFake(() => { /* 永不响应 */ });
  let caught = null;
  try { await cdp.send("Page.enable", {}, 40); } catch (e) { caught = e; }
  ok(caught !== null && caught.message.includes("超时"), "超时被拒");
  cdp.close();
}

section("Cdp：navigate / reload 等 load 事件");
{
  const { cdp, socket } = await connectFake(simpleHandler());
  const p = cdp.navigate("https://chatgpt.com/", 1000);
  await tick();
  eq(socket.sent[0].method, "Page.enable", "navigate 前自动开 Page");
  eq(socket.sent[1].method, "Page.navigate", "发出 Page.navigate");
  eq(socket.sent[1].params.url, "https://chatgpt.com/", "URL 正确");
  socket.push("Page.loadEventFired", {});
  eq(await p, true, "收到 load 事件 -> true");

  const p2 = cdp.reload(60);
  await tick();
  eq(socket.sent[2].method, "Page.enable", "reload 前也会确保 Page 域开着");
  eq(socket.sent[3].method, "Page.reload", "发出 Page.reload");
  eq(await p2, false, "等不到 load 时返回 false");
  cdp.close();
}

section("Cdp：getAllCookies");
{
  const { cdp, socket } = await connectFake((sock, msg) => {
    if (msg.method === "Network.getAllCookies") {
      return sock.respond(msg, { cookies: [{ name: "a" }, { name: "b" }] });
    }
    sock.respond(msg, {});
  });
  const cookies = await cdp.getAllCookies();
  eq(cookies.length, 2, "拿到两条 cookie");
  eq(cookies[0].name, "a", "原样返回");
  eq(socket.sent[0].method, "Network.enable", "先开 Network 域");
  cdp.close();
}

section("调试端口工具");
eq(devtoolsBaseUrl(9222), "http://127.0.0.1:9222", "base url");
eq(devtoolsBaseUrl(9333, "localhost"), "http://localhost:9333", "自定义 host");
eq(pickPageTarget([], "chatgpt.com"), null, "空列表 -> null");
{
  const targets = [
    { id: "1", type: "service_worker", url: "https://chatgpt.com/sw.js", webSocketDebuggerUrl: "ws://a" },
    { id: "2", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://b" },
    { id: "3", type: "page", url: "https://chatgpt.com/c/1", webSocketDebuggerUrl: "ws://c" },
  ];
  eq(pickPageTarget(targets, "chatgpt.com").id, "3", "优先命中域名");
  eq(pickPageTarget(targets).id, "2", "没有域名要求时取第一个 page");
  eq(pickPageTarget(targets, "nope.com").id, "2", "域名不命中时退回第一个 page");
  eq(pickPageTarget(targets.filter((t) => t.type !== "page")), null, "只剩 worker 时 -> null");
}
{
  // 探活：端口关着必须快速失败，不能挂住
  const t0 = Date.now();
  const alive = await probeDevtools(9, "127.0.0.1", 300);
  ok(alive === false, "端口没开 -> false");
  ok(Date.now() - t0 < 3000, "失败要快（" + (Date.now() - t0) + "ms）");
  eq(await waitForDevtools(9, 0, "127.0.0.1", 10), false, "超时为 0 时最多试一次");
  const listed = await listTargets(9, "127.0.0.1", 300);
  deepEq(listed, [], "拿不到 target 列表 -> 空数组而不是抛异常");
}

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------

section("browser：可执行文件探测");
{
  const exists = (p) => p === "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  eq(
    findBrowserExecutable(undefined, "win32", exists),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "命中已知的 Edge 路径",
  );
  eq(findBrowserExecutable("/custom/chrome", "win32", (p) => p === "/custom/chrome"), "/custom/chrome", "显式路径优先");
  eq(findBrowserExecutable(undefined, "win32", () => false), null, "一个都找不到 -> null");
  ok(browserCandidates("win32").some((p) => p.endsWith("msedge.exe")), "win32 候选含 Edge");
  ok(browserCandidates("darwin").every((p) => p.startsWith("/Applications/")), "darwin 候选都在 /Applications");
  ok(browserCandidates("linux").length > 0, "linux 有候选");
}

section("browser：启动参数");
{
  const opts = resolveBrowserOptions({ port: 9333, profileDir: "P:/prof", startUrl: "https://chatgpt.com/" });
  eq(opts.port, 9333, "端口可覆盖");
  eq(opts.host, "127.0.0.1", "默认 host");
  eq(opts.attachTimeoutMs, 30000, "默认超时");
  eq(opts.spawnIfMissing, true, "默认可自行拉起");
  const args = buildLaunchArgs(opts);
  ok(args.includes("--remote-debugging-port=9333"), "带调试端口");
  ok(args.includes("--user-data-dir=P:/prof"), "带 user-data-dir");
  ok(args.includes("--disable-blink-features=AutomationControlled"), "关掉 AutomationControlled 特征");
  ok(args.includes("--no-first-run"), "no-first-run");
  ok(args.includes("--no-default-browser-check"), "no-default-browser-check");
  ok(args[args.length - 1] === "https://chatgpt.com/", "启动页放最后");
  const withExtra = buildLaunchArgs({ ...opts, extraArgs: ["--lang=en-US"] });
  ok(withExtra.includes("--lang=en-US"), "extraArgs 生效");
  ok(withExtra[withExtra.length - 1] === "https://chatgpt.com/", "extraArgs 不挤掉启动页");
}

section("browser：spawn 必须是 detached + unref");
{
  const spawnOpts = detachedSpawnOptions();
  eq(spawnOpts.detached, true, "detached 为 true");
  eq(spawnOpts.stdio, "ignore", "stdio 忽略，不跟着进程走");

  // 端到端：用假 spawn 走一遍 ensureBrowser，确认 spawn 选项与 unref 调用
  const calls = { spawn: [], unref: 0 };
  const deps = makeDeps({ calls });
  const session = await ensureBrowser({ port: 9222, profileDir: "P:/prof" }, deps);
  eq(calls.spawn.length, 1, "起了一个进程");
  eq(calls.spawn[0].options.detached, true, "真实调用里 detached 为 true");
  eq(calls.spawn[0].options.stdio, "ignore", "真实调用里 stdio=ignore");
  eq(calls.unref, 1, "调用了 unref（DSH 退出不会带走浏览器）");
  eq(session.mode, "spawned", "模式是 spawned");
  eq(session.reused, false, "不是复用");
  eq(session.pid, 4321, "pid 带出来");
}

/** 造一套浏览器依赖桩；默认行为=端口一开始不通、spawn 后通。 */
function makeDeps(extra = {}) {
  const calls = extra.calls ?? { spawn: [], unref: 0 };
  let portOpen = extra.portOpen ?? false;
  const spawned = extra.spawned ?? true;
  return {
    spawn: (command, args, options) => {
      calls.spawn.push({ command, args, options });
      if (spawned) portOpen = true;
      return {
        pid: 4321,
        unref: () => {
          calls.unref += 1;
        },
      };
    },
    probe: async () => portOpen,
    waitForPort: async () => {
      if (spawned) portOpen = true;
      return portOpen;
    },
    targetList: async () => extra.targets ?? [],
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    now: () => 1000,
    exists: (p) => (extra.existing ?? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]).includes(p),
    mkdir: () => {},
    connect: async () => {
      throw new Error("测试里不该真的连 CDP");
    },
  };
}

section("browser：端口已活时复用，不起新进程");
{
  const calls = { spawn: [], unref: 0 };
  const deps = makeDeps({ calls, portOpen: true });
  const session = await ensureBrowser({ port: 9222 }, deps);
  eq(session.mode, "reused", "复用模式");
  eq(session.reused, true, "标记为复用");
  eq(calls.spawn.length, 0, "没有起新进程");
  eq(calls.unref, 0, "没有 unref 可调");
  ok(describeSession(session).includes("复用"), "摘要里写明复用");
}

section("browser：禁止自行拉起时给出明确错误");
{
  const deps = makeDeps();
  let caught = null;
  try { await ensureBrowser({ spawnIfMissing: false }, deps); } catch (e) { caught = e; }
  ok(caught instanceof BrowserError, "抛 BrowserError");
  eq(caught.stage, "attach", "阶段是 attach");
  ok(caught.hint.includes("--remote-debugging-port"), "给出可操作提示");
}

section("browser：找不到浏览器时给结论而不是瞎起");
{
  const deps = { ...makeDeps(), exists: () => false };
  let caught = null;
  try { await ensureBrowser({}, deps); } catch (e) { caught = e; }
  ok(caught instanceof BrowserError, "抛 BrowserError");
  eq(caught.stage, "locate", "阶段是 locate");
  ok(caught.hint.includes("DSH_CHATGPT_WEB_BROWSER"), "提示环境变量");
}

section("browser：profile 被占用时立刻报错（不等 30 秒）");
{
  const calls = { spawn: [], unref: 0 };
  const deps = makeDeps({ calls });
  deps.exists = (p) => p.endsWith("lockfile") || p.includes("msedge.exe");
  let caught = null;
  try { await ensureBrowser({ profileDir: "P:/prof" }, deps); } catch (e) { caught = e; }
  ok(caught instanceof BrowserError, "抛 BrowserError");
  eq(caught.stage, "spawn", "阶段是 spawn");
  ok(caught.message.includes("占用"), "说明是 profile 占用");
  eq(calls.spawn.length, 0, "没有白起进程");
}

section("browser：spawn 后端口起不来要报错");
{
  const deps = makeDeps({ spawned: false });
  deps.waitForPort = async () => false;
  let caught = null;
  try { await ensureBrowser({ attachTimeoutMs: 5 }, deps); } catch (e) { caught = e; }
  ok(caught instanceof BrowserError, "抛 BrowserError");
  ok(caught.message.includes("未就绪"), "说明端口没就绪");
}

section("browser：profile 锁检测");
{
  ok(isProfileLocked("P", (p) => p === "P\\lockfile" || p === "P/lockfile"), "Windows lockfile 算占用");
  ok(isProfileLocked("P", (p) => p.endsWith("SingletonLock")), "POSIX SingletonLock 算占用");
  ok(!isProfileLocked("P", () => false), "没有锁文件 = 空闲");
}

section("browser：读 DevToolsActivePort");
{
  const read = () => "51234\n/devtools/browser/abc\n";
  eq(readDevToolsActivePort("P", read, () => true), 51234, "解析首行端口");
  eq(readDevToolsActivePort("P", read, () => false), null, "文件不存在 -> null");
  eq(readDevToolsActivePort("P", () => "garbage", () => true), null, "解析不出来 -> null");
}

section("browser：attachPage 通过注入的 connect 建立连接");
{
  const targets = [
    { id: "t1", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://fake/1" },
  ];
  let askedUrl = null;
  const deps = {
    ...makeDeps({ targets }),
    connect: async (url) => {
      askedUrl = url;
      return { fake: true };
    },
  };
  const session = { mode: "reused", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: null, pid: null, startedAt: 0, reused: true };
  const attached = await attachPage(session, "chatgpt.com", deps);
  eq(askedUrl, "ws://fake/1", "连的是页面 target 的 ws 地址");
  eq(attached.target.id, "t1", "带回 target");
  const empty = await attachPage(session, "chatgpt.com", { ...deps, targetList: async () => [] });
  eq(empty, null, "没有页面时返回 null");
}

section("browser：defaultBrowserDeps 形状正确（未被实际调用）");
ok(typeof defaultBrowserDeps.spawn === "function", "spawn 是函数");
ok(typeof defaultBrowserDeps.connect === "function", "connect 是函数");
ok(typeof defaultBrowserDeps.mkdir === "function", "mkdir 是函数");
eq(defaultBrowserDeps.now() > 0, true, "now 返回时间戳");

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

section("page：探针表达式形状");
ok(pageProbeExpression().includes("data-build"), "读 data-build");
ok(pageProbeExpression().includes("readyState"), "读 readyState");
ok(loginProbeExpression().includes("/api/auth/session"), "走 auth/session");
ok(loginProbeExpression().includes("/backend-api/me"), "走 backend-api/me");
ok(!loginProbeExpression().includes("return sj.accessToken"), "不把 token 明文回传");
ok(pageEnvExpression().includes("devicePixelRatio"), "读像素比");

section("page：probePage 归一化");
{
  const { cdp } = await connectFake((sock, msg) => {
    sock.respond(msg, {
      result: {
        type: "object",
        value: {
          href: "https://chatgpt.com/c/1",
          readyState: "complete",
          dataBuild: "prod-abc",
          userAgent: "UA",
          languages: ["zh-CN", 42],
          webdriver: false,
          isChatGPT: true,
        },
      },
    });
  });
  const probe = await probePage(cdp);
  eq(probe.href, "https://chatgpt.com/c/1", "href");
  eq(probe.readyState, "complete", "readyState");
  eq(probe.dataBuild, "prod-abc", "dataBuild");
  deepEq(probe.languages, ["zh-CN"], "非字符串语言项被丢弃");
  eq(probe.webdriver, false, "webdriver");
  eq(probe.isChatGPT, true, "isChatGPT");
  cdp.close();
}

section("page：probePage 对缺字段的容错");
{
  const { cdp } = await connectFake((sock, msg) => {
    sock.respond(msg, { result: { type: "object", value: {} } });
  });
  const probe = await probePage(cdp);
  eq(probe.href, "", "缺字段给空串");
  eq(probe.dataBuild, null, "dataBuild 缺失为 null");
  eq(probe.webdriver, false, "webdriver 缺省 false");
  eq(probe.isChatGPT, false, "isChatGPT 缺省 false");
  cdp.close();
}

section("page：judgeLogin");
{
  const okState = judgeLogin({
    sessionStatus: 200,
    meStatus: 200,
    hasAccessToken: true,
    accessTokenLength: 900,
    planType: "free",
    emailDomain: "example.com",
    errors: [],
  });
  eq(okState.loggedIn, true, "有 token 且 session 200 = 已登录");
  eq(okState.planType, "free", "套餐");
  eq(okState.emailDomain, "example.com", "邮箱域名");
  eq(okState.accessTokenLength, 900, "token 长度");

  eq(judgeLogin({ sessionStatus: 200, hasAccessToken: false }).loggedIn, false, "没 token = 未登录");
  eq(judgeLogin({ sessionStatus: 401, hasAccessToken: true }).loggedIn, false, "session 非 200 = 未登录");
  eq(judgeLogin({}).loggedIn, false, "全空 = 未登录");
  eq(judgeLogin({}).sessionStatus, -1, "缺省 sessionStatus 为 -1");
  deepEq(judgeLogin({ errors: ["a", 7, "b"] }).errors, ["a", "b"], "非字符串 error 被丢弃");
  eq(judgeLogin({ planType: "" }).planType, null, "空套餐名归一成 null");
}

section("page：readLoginState 走页面内 fetch");
{
  const { cdp, socket } = await connectFake((sock, msg) => {
    sock.respond(msg, {
      result: {
        type: "object",
        value: { sessionStatus: 200, meStatus: 200, hasAccessToken: true, accessTokenLength: 700, planType: "free", errors: [] },
      },
    });
  });
  const state = await readLoginState(cdp);
  eq(state.loggedIn, true, "判定已登录");
  // evalInPage 会先做一次可见性守卫（后台标签页被节流时 fetch 会挂住），
  // 所以真正的登录探针不是第一条命令 —— 这里断言"某个命令里跑了探针"。
  const probeCall = socket.sent.find((m) => String(m.params?.expression ?? "").includes("/api/auth/session"));
  ok(probeCall !== undefined, "确实在页面里跑探针");
  eq(probeCall?.params?.awaitPromise, true, "等 Promise");
  // 守卫本身必须真的发生过（否则隐藏标签页下会静默超时）
  const guardCall = socket.sent.find((m) => {
    const e = String(m.params?.expression ?? "");
    return e.includes("visibilityState") || e.includes("document.hidden");
  });
  ok(guardCall !== undefined, "发请求前做过可见性守卫");
  cdp.close();
}

section("page：waitForLogin 轮询到登录为止");
{
  let round = 0;
  const fakeCdp = { evaluate: async () => (++round >= 3 ? { sessionStatus: 200, hasAccessToken: true, errors: [] } : { sessionStatus: 401, hasAccessToken: false, errors: [] }) };
  const r = await waitForLogin(fakeCdp, { timeoutMs: 10_000, intervalMs: 1, now: () => 0, sleep: async () => {} });
  eq(r.timedOut, false, "拿到登录后立刻返回");
  eq(r.state.loggedIn, true, "状态为已登录");
  eq(round, 3, "第 3 次探到时停下");

  let n = 0;
  const never = { evaluate: async () => { n += 1; return { sessionStatus: 401, hasAccessToken: false, errors: [] }; } };
  let clock = 0;
  const r2 = await waitForLogin(never, { timeoutMs: 5, intervalMs: 1, now: () => (clock += 3), sleep: async () => {} });
  eq(r2.timedOut, true, "等不到就标记超时");
  eq(r2.state.loggedIn, false, "最后一次状态是未登录");
  ok(n >= 2, "轮询了多次（" + n + "）");
}

section("page：getAccessToken / getDataBuild");
{
  const { cdp } = await connectFake((sock, msg) => {
    const expr = msg.params.expression;
    if (expr.includes("/api/auth/session")) return sock.respond(msg, { result: { type: "string", value: "tok-abc" } });
    if (expr.includes("data-build")) return sock.respond(msg, { result: { type: "string", value: "prod-xyz" } });
    return sock.respond(msg, { result: { type: "undefined" } });
  });
  eq(await getAccessToken(cdp), "tok-abc", "拿到 accessToken");
  eq(await getDataBuild(cdp), "prod-xyz", "拿到 data-build");
  cdp.close();
}
{
  const { cdp } = await connectFake((sock, msg) => sock.respond(msg, { result: { type: "undefined" } }));
  eq(await getAccessToken(cdp), null, "没有 token -> null");
  eq(await getDataBuild(cdp), null, "没有 build -> null");
  cdp.close();
}

section("page：waitForReady");
{
  let probes = 0;
  const probeFn = async () => {
    probes += 1;
    return probes >= 2
      ? { href: "https://chatgpt.com/", readyState: "complete", dataBuild: null, userAgent: "", languages: [], webdriver: false, isChatGPT: true }
      : { href: "about:blank", readyState: "loading", dataBuild: null, userAgent: "", languages: [], webdriver: false, isChatGPT: false };
  };
  let clock = 0;
  const r = await waitForReady({}, { timeoutMs: 100, intervalMs: 1, now: () => (clock += 1), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), probe: probeFn });
  eq(r.ok, true, "等到了就绪");
  eq(probes, 2, "第 2 次探针命中");

  const alwaysLoading = async () => ({
    href: "about:blank", readyState: "loading", dataBuild: null, userAgent: "", languages: [], webdriver: false, isChatGPT: false,
  });
  const never = await waitForReady({}, { timeoutMs: 3, intervalMs: 1, now: () => (clock += 3), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), probe: alwaysLoading });
  eq(never.ok, false, "等不到返回 ok=false 而不是抛异常");
  ok(never.probe !== null, "带回最后一次探测结果，便于写诊断");
}
{
  // 页面还在加载时 RuntimeException 不该炸掉轮询
  let calls = 0;
  const throwingProbe = async () => {
    calls += 1;
    if (calls === 1) throw new PageExceptionError("Execution context was destroyed");
    return { href: "https://chatgpt.com/", readyState: "complete", dataBuild: null, userAgent: "", languages: [], webdriver: false, isChatGPT: true };
  };
  let clock = 0;
  const r = await waitForReady({}, { timeoutMs: 100, intervalMs: 1, now: () => (clock += 1), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), probe: throwingProbe });
  eq(r.ok, true, "导航中丢上下文后仍能恢复");
  eq(r.errors.length, 1, "错误被记录下来");
  ok(r.errors[0].includes("Execution context"), "记录的是页面内异常");
}

section("page：ensureChatGPT 只在需要时导航");
{
  const navigated = [];
  const onSite = {
    evaluate: async () => ({ href: "https://chatgpt.com/", readyState: "complete", dataBuild: null, userAgent: "", languages: [], webdriver: false, isChatGPT: true }),
    navigate: async (url) => { navigated.push(url); return true; },
  };
  const a = await ensureChatGPT(onSite);
  eq(a.navigated, false, "已在站点上不导航");
  eq(navigated.length, 0, "没有多余导航");

  const offSite = {
    evaluate: async () => ({ href: "chrome://newtab", readyState: "complete", dataBuild: null, userAgent: "", languages: [], webdriver: false, isChatGPT: false }),
    navigate: async (url) => { navigated.push(url); return true; },
  };
  const b = await ensureChatGPT(offSite);
  eq(b.navigated, true, "不在站点上就导航");
  eq(navigated[0], CHATGPT_ORIGIN, "导航到站点根");
}

section("page：isOnChatGPT");
{
  eq(await isOnChatGPT({ evaluate: async () => "chatgpt.com" }), true, "主域");
  eq(await isOnChatGPT({ evaluate: async () => "chat.openai.com" }), false, "别的域");
  eq(await isOnChatGPT({ evaluate: async () => { throw new Error("x"); } }), false, "探针炸了当作不在");
}

section("page：readPageEnv 默认值");
{
  const { cdp } = await connectFake((sock, msg) => sock.respond(msg, { result: { type: "object", value: { innerWidth: 1000, languages: ["en"] } } }));
  const env = await readPageEnv(cdp);
  eq(env.innerWidth, 1000, "给了的字段照用");
  eq(env.innerHeight, 900, "缺的字段给默认");
  eq(env.screenWidth, 1920, "屏幕宽默认");
  deepEq(env.languages, ["en"], "语言列表");
  cdp.close();
}

section("page：evalInPage 透传");
{
  const { cdp } = await connectFake(simpleHandler({ "1+1": "2" }));
  eq(await evalInPage(cdp, "1+1"), "2", "透传求值结果");
  cdp.close();
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

const healthyProbe = {
  href: "https://chatgpt.com/",
  readyState: "complete",
  dataBuild: "prod-1",
  userAgent: "UA",
  languages: ["zh-CN"],
  webdriver: false,
  isChatGPT: true,
};
const loggedIn = { loggedIn: true, sessionStatus: 200, meStatus: 200, hasAccessToken: true, accessTokenLength: 10, planType: "free", emailDomain: "x.com", errors: [] };

function healthInput(over = {}) {
  return {
    attached: true,
    cdpClosed: false,
    closedReason: "",
    timedOut: false,
    probeError: null,
    probe: healthyProbe,
    login: loggedIn,
    portAlive: true,
    ...over,
  };
}

section("classifyHealth：健康");
{
  const v = classifyHealth(healthInput());
  eq(v.status, "healthy", "全绿 -> healthy");
  eq(v.level, "info", "级别 info");
  eq(v.recoverable, false, "健康时不需要重挂");
}

section("classifyHealth：各类崩因");
{
  const crashed = classifyHealth(healthInput({ cdpClosed: true, closedReason: "Inspector.targetCrashed" }));
  eq(crashed.status, "crashed", "targetCrashed -> crashed");
  ok(crashed.reason.includes("崩溃"), "崩因写明是渲染进程崩溃");
  eq(crashed.level, "error", "级别 error");
  eq(crashed.recoverable, true, "可恢复");

  const dropped = classifyHealth(healthInput({ cdpClosed: true, closedReason: "socket closed" }));
  eq(dropped.status, "crashed", "连接断开也算崩");
  ok(dropped.reason.includes("socket closed"), "带上原始原因");

  const portDead = classifyHealth(healthInput({ portAlive: false }));
  eq(portDead.status, "port-dead", "端口没了");
  ok(portDead.reason.includes("调试端口"), "说明端口不可达");

  const unresponsive = classifyHealth(healthInput({ timedOut: true }));
  eq(unresponsive.status, "unresponsive", "探针超时");
  ok(unresponsive.reason.includes("超时"), "说明是超时");

  const errored = classifyHealth(healthInput({ probeError: "boom" }));
  eq(errored.status, "error", "探针异常");
  ok(errored.reason.includes("boom"), "带上错误详情");

  const navigated = classifyHealth(healthInput({ probe: { ...healthyProbe, isChatGPT: false, href: "https://example.com/" } }));
  eq(navigated.status, "navigated-away", "离开站点");
  ok(navigated.reason.includes("example.com"), "带上当前地址");

  const notReady = classifyHealth(healthInput({ probe: { ...healthyProbe, readyState: "loading" } }));
  eq(notReady.status, "not-ready", "还在加载");
  eq(notReady.level, "info", "加载中不算错误");

  const loggedOut = classifyHealth(healthInput({ login: { ...loggedIn, loggedIn: false, sessionStatus: 401 } }));
  eq(loggedOut.status, "logged-out", "未登录");
  eq(loggedOut.recoverable, false, "登录得用户自己做，重挂修不好");

  const detached = classifyHealth(healthInput({ attached: false }));
  eq(detached.status, "detached", "没附着");
  eq(detached.recoverable, true, "可以重新附着");

  const noProbe = classifyHealth(healthInput({ probe: null }));
  eq(noProbe.status, "error", "拿不到页面信息");
}

section("classifyHealth：判定优先级");
eq(classifyHealth(healthInput({ cdpClosed: true, portAlive: false })).status, "crashed", "连接崩了优先于端口");
eq(classifyHealth(healthInput({ attached: false, portAlive: false })).status, "port-dead", "端口死了比没附着更具体");
eq(classifyHealth(healthInput({ timedOut: true, probeError: "x" })).status, "unresponsive", "超时优先于一般错误");
eq(classifyHealth(healthInput({ timedOut: true, probe: { ...healthyProbe, isChatGPT: false } })).status, "unresponsive", "超时优先于页面状态");

section("health：诊断 sink");
{
  const mem = createMemorySink();
  mem.sink({ at: 1, kind: "health", level: "info", message: "hi", detail: {} });
  eq(mem.entries.length, 1, "内存 sink 收到条目");
  eq(mem.entries[0].message, "hi", "内容原样");

  const seen = [];
  const composed = composeSinks(
    () => { throw new Error("坏 sink"); },
    (e) => seen.push(e.message),
  );
  composed({ at: 1, kind: "recover", level: "warn", message: "still here", detail: {} });
  deepEq(seen, ["still here"], "坏 sink 不影响好 sink");

  ok(diagnosticsFile(Date.UTC(2026, 0, 2)).includes("transport-2026-01-02"), "按天切分文件");
  ok(diagnosticsFile(0, "D:/diag").endsWith(".jsonl"), "是 jsonl");
  ok(createFileSink("D:/definitely/not/writable/\u0000bad")({ at: 0, kind: "health", level: "info", message: "x", detail: {} }) === undefined, "落盘失败不抛异常");
}

section("health：monitor.check 不抛、能定性");
{
  const mem = createMemorySink();
  const deps = {
    now: () => 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    probePort: async () => true,
    attachPage: async () => null,
    ensureBrowser: async () => { throw new Error("不该拉起"); },
    probePage: async () => healthyProbe,
    waitForReady: async () => ({ ok: true, probe: healthyProbe, waitedMs: 0, errors: [] }),
    readLogin: async () => loggedIn,
    connect: async () => { throw new Error("x"); },
    targetList: async () => [],
    exists: () => false,
    mkdir: () => {},
    spawn: () => { throw new Error("不该 spawn"); },
    probe: async () => true,
    waitForPort: async () => true,
  };
  const session = { mode: "reused", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: null, pid: null, startedAt: 0, reused: true };
  const monitor = new HealthMonitor({ session, cdp: null, diagnostics: mem.sink, deps });
  const report = await monitor.check();
  eq(report.status, "detached", "没连接时报告 detached");
  eq(report.checkedAt, 1000, "带上检查时刻");
  eq(report.recovered, false, "check 不修");

  const ensure = await monitor.ensureHealthy();
  ok(ensure.recoverySteps.includes("attach:no-page"), "重挂时记录了没页面的台阶");
  ok(!ensure.recoverySteps.includes("attach"), "没页面时不会假装附着成功");
  eq(monitor.currentSession.mode, "reused", "会话没被动过");
}

section("health：页面健康时 ensureHealthy 不折腾");
{
  const mem = createMemorySink();
  const fakeCdp = { isClosed: false, closedReason: "", evaluate: async () => ({}) };
  const deps = {
    now: () => 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    probePort: async () => true,
    attachPage: async () => { throw new Error("健康时不该重挂"); },
    ensureBrowser: async () => { throw new Error("健康时不该拉起"); },
    probePage: async () => healthyProbe,
    waitForReady: async () => ({ ok: true, probe: healthyProbe, waitedMs: 0, errors: [] }),
    readLogin: async () => loggedIn,
  };
  const session = { mode: "reused", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: null, pid: null, startedAt: 0, reused: true };
  const monitor = new HealthMonitor({ session, cdp: fakeCdp, diagnostics: mem.sink, deps });
  const report = await monitor.ensureHealthy();
  eq(report.status, "healthy", "健康");
  deepEq(report.recoverySteps, [], "没有多余动作");
  eq(mem.entries.length, 0, "健康时不写诊断噪音");
}

section("health：崩溃后按阶梯重挂");
{
  const mem = createMemorySink();
  let attachCalls = 0;
  let closed = 0;
  const deadCdp = {
    isClosed: false,
    closedReason: "",
    evaluate: async () => { throw new CdpClosedError("Inspector.targetCrashed"); },
    close: () => { closed += 1; },
  };
  let probeCount = 0;
  const deps = {
    now: () => 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    probePort: async () => true,
    attachPage: async () => {
      attachCalls += 1;
      return { cdp: { isClosed: false, closedReason: "", evaluate: async () => ({}) }, target: { id: "t1", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://x" } };
    },
    ensureBrowser: async () => { throw new Error("端口活着不该拉起"); },
    probePage: async () => (++probeCount === 1 ? { ...healthyProbe, href: "https://example.com/", isChatGPT: false } : healthyProbe),
    waitForReady: async () => ({ ok: true, probe: healthyProbe, waitedMs: 0, errors: [] }),
    readLogin: async () => loggedIn,
  };
  const session = { mode: "reused", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: null, pid: null, startedAt: 0, reused: true };
  const monitor = new HealthMonitor({ session, cdp: deadCdp, diagnostics: mem.sink, deps });
  const report = await monitor.ensureHealthy();
  eq(closed, 1, "先断开旧连接");
  eq(attachCalls, 1, "重新附着一次");
  eq(report.recovered, true, "最终恢复");
  ok(report.recoverySteps.includes("detach"), "记录了 detach");
  ok(report.recoverySteps.includes("attach"), "记录了 attach");
  ok(mem.entries.some((e) => e.kind === "crash"), "崩溃写进诊断");
  ok(mem.entries.some((e) => e.kind === "attach"), "重挂写进诊断");
  const crash = mem.entries.find((e) => e.kind === "crash");
  ok(typeof crash.detail.status === "string", "诊断条目带结构化细节");
}

section("health：端口死了会在允许时重新拉起");
{
  const mem = createMemorySink();
  let spawns = 0;
  const deps = {
    now: () => 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    probePort: async () => false,
    attachPage: async () => ({ cdp: { isClosed: false, closedReason: "", evaluate: async () => ({}) }, target: { id: "t", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://x" } }),
    ensureBrowser: async (opts) => {
      spawns += 1;
      return { mode: "spawned", port: opts.port, host: opts.host, baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: "edge", pid: 99, startedAt: 0, reused: false };
    },
    probePage: async () => healthyProbe,
    waitForReady: async () => ({ ok: true, probe: healthyProbe, waitedMs: 0, errors: [] }),
    readLogin: async () => loggedIn,
  };
  const session = { mode: "reused", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: null, pid: null, startedAt: 0, reused: true };
  const monitor = new HealthMonitor({ session, cdp: null, diagnostics: mem.sink, deps });
  const report = await monitor.ensureHealthy();
  eq(spawns, 1, "拉起了一次");
  ok(report.recoverySteps.includes("spawn-browser"), "记录了拉起台阶");
  eq(monitor.currentSession.mode, "spawned", "会话被替换成新会话");
  ok(mem.entries.some((e) => e.kind === "recover"), "拉起写进诊断");
}

section("health：不允许拉起时只报告不动作");
{
  const mem = createMemorySink();
  let spawns = 0;
  const deps = {
    now: () => 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    probePort: async () => false,
    attachPage: async () => null,
    ensureBrowser: async () => { spawns += 1; throw new Error("不该调用"); },
    probePage: async () => healthyProbe,
    waitForReady: async () => ({ ok: true, probe: healthyProbe, waitedMs: 0, errors: [] }),
    readLogin: async () => loggedIn,
  };
  const session = { mode: "reused", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: null, pid: null, startedAt: 0, reused: true };
  const monitor = new HealthMonitor({ session, cdp: null, diagnostics: mem.sink, deps, allowSpawn: false });
  const report = await monitor.ensureHealthy();
  eq(spawns, 0, "没有拉起");
  eq(report.status, "port-dead", "如实报告端口死了");
  eq(report.recovered, false, "没有恢复");
}

section("health：加载中只等不重挂");
{
  const mem = createMemorySink();
  let attaches = 0;
  let waits = 0;
  const loadingProbe = { ...healthyProbe, readyState: "loading" };
  let phase = 0;
  const deps = {
    now: () => 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    probePort: async () => true,
    attachPage: async () => { attaches += 1; return null; },
    ensureBrowser: async () => { throw new Error("不该拉起"); },
    probePage: async () => (phase === 0 ? loadingProbe : healthyProbe),
    waitForReady: async () => { waits += 1; phase = 1; return { ok: true, probe: healthyProbe, waitedMs: 0, errors: [] }; },
    readLogin: async () => loggedIn,
  };
  const session = { mode: "reused", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "P", executable: null, pid: null, startedAt: 0, reused: true };
  const monitor = new HealthMonitor({ session, cdp: { isClosed: false, closedReason: "", evaluate: async () => ({}) }, diagnostics: mem.sink, deps });
  const report = await monitor.ensureHealthy();
  eq(waits, 1, "等了一次 ready");
  eq(attaches, 0, "没有重新附着");
  eq(report.status, "healthy", "加载完就健康");
  deepEq(report.recoverySteps, ["wait-ready"], "只记录了等待");
}

section("health：LIVENESS_EXPRESSION 是最便宜的探针");
ok(LIVENESS_EXPRESSION.includes("readyState"), "读 readyState");
ok(!LIVENESS_EXPRESSION.includes("fetch"), "不发网络请求");
ok(LIVENESS_EXPRESSION.length < 200, "表达式足够短");

section("health：probeHealth 不连浏览器也能安全调用");
eq(await probeHealth(9, "127.0.0.1"), false, "端口没开 -> false（不会挂住）");

section("铁律：整份测试没有真的启动浏览器");
eq(defaultSpawnCalls, 0, "默认 spawn 分支一次都没走到（不可能拉起浏览器）");
eq(defaultConnectCalls, 0, "默认 connect 分支一次都没走到（不可能连上真页面）");
ok(typeof realDefaultSpawn === "function", "真实 spawn 实现仍在");
ok(typeof realDefaultConnect === "function", "真实 connect 实现仍在");
defaultBrowserDeps.spawn = realDefaultSpawn;
defaultBrowserDeps.connect = realDefaultConnect;