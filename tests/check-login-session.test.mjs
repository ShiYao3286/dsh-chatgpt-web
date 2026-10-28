/**
 * 登录会话状态机：用**注入桩件**跑完整流程，绝不真的开浏览器。
 *
 * 覆盖的关键判据（每条都配了反向验证的意图）：
 * 1. 成功路径：拉起 → 等登录 → 抓取 → done
 * 2. 超时：到点必须落 failed，且**不能**继续轮询
 * 3. 取消：在等的时候取消要立刻落 failed
 * 4. 重复 start：不能开出第二个会话
 * 5. 拿不到 token：不能假装成功
 * 6. 浏览器拉起失败：错误要可读，不能抛到调用方
 * 7. 页面丢失：连续探测失败要中止，而不是一直等
 */
import { ok, eq, section } from "./harness.mjs";
import { BrowserLoginSession, LOGIN_TIMEOUT_MS } from "../src/login.ts";

/** 造一个只走内存的依赖集合。 */
function fakeDeps(overrides = {}) {
  const calls = { ensureBrowser: 0, attachPage: 0, readLoginState: 0, saveAuth: 0, getAccessToken: 0 };
  const saved = [];
  let clock = 1000;
  let loginPollCount = 0;

  const deps = {
    ensureBrowser: async () => {
      calls.ensureBrowser += 1;
      return { mode: "spawned", port: 9222, host: "127.0.0.1", baseUrl: "http://127.0.0.1:9222", profileDir: "p", executable: "e", pid: 42, startedAt: 0, reused: false };
    },
    attachPage: async () => {
      calls.attachPage += 1;
      return {
        cdp: {
          getAllCookies: async () => [
            { name: "cf_clearance", value: "v", domain: ".chatgpt.com" },
            { name: "other", value: "x", domain: ".example.com" },
          ],
          close: () => undefined,
        },
        target: {},
      };
    },
    readLoginState: async () => {
      calls.readLoginState += 1;
      loginPollCount += 1;
      return { loggedIn: loginPollCount >= 2, sessionStatus: 200, meStatus: 200, hasAccessToken: loginPollCount >= 2, accessTokenLength: 120, planType: null, emailDomain: null, errors: [] };
    },
    getAccessToken: async () => {
      calls.getAccessToken += 1;
      return "tok-" + "x".repeat(20);
    },
    getDataBuild: async () => "build42",
    readPageEnv: async () => ({ userAgent: "UA", languages: ["zh-CN"], innerHeight: 900, innerWidth: 1280, devicePixelRatio: 1, screenWidth: 1920, screenHeight: 1080, timeSinceLoadedSec: 1, hardwareConcurrency: 8, dataBuild: "build42" }),
    ensureChatGPT: async () => ({ navigated: false, loaded: true }),
    saveAuth: async (auth) => {
      calls.saveAuth += 1;
      saved.push(auth);
    },
    now: () => {
      clock += 100;
      return clock;
    },
    sleep: async () => undefined,
    ...overrides,
  };
  return { deps, calls, saved, advance: (n) => (clock += n) };
}

/** 等后台流程跑完（状态机是 fire-and-forget，靠这个让测试确定化）。 */
async function settle(session, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (session.active && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return session.snapshot();
}

section("成功路径：拉起 -> 等登录 -> 抓取 -> done");
{
  const { deps, calls, saved } = fakeDeps();
  const session = new BrowserLoginSession(deps);
  session.start();
  const final = await settle(session);
  eq(final.phase, "done", "最终 done");
  ok(final.captured !== undefined, "带捕获结论");
  eq(final.captured.hasCookie, true, "抓到了 cookie");
  eq(final.captured.cookieCount, 1, "只算 chatgpt 域");
  eq(final.captured.dataBuild, "build42", "带上 build");
  eq(calls.saveAuth, 1, "凭证落盘一次");
  eq(saved.length, 1, "保存的凭证");
  ok(saved[0].accessToken.length > 0, "写了 token");
  ok(saved[0].cookieHeader.includes("cf_clearance"), "cookie 头含目标 cookie");
  ok(!saved[0].cookieHeader.includes("other"), "不写非目标域 cookie");
}

section("重复 start 不会开第二个会话");
{
  const { deps, calls } = fakeDeps();
  const session = new BrowserLoginSession(deps);
  session.start();
  session.start();
  session.start();
  await settle(session);
  eq(calls.ensureBrowser, 1, "只拉起一次");
}

section("超时：到点落 failed 并停止");
{
  const { deps } = fakeDeps({
    readLoginState: async () => ({ loggedIn: false, sessionStatus: 401, meStatus: -1, hasAccessToken: false, accessTokenLength: 0, planType: null, emailDomain: null, errors: [] }),
  });
  const session = new BrowserLoginSession(deps);
  session.start({ timeoutMs: 1 });
  const final = await settle(session);
  eq(final.phase, "failed", "超时失败");
  ok(final.message.includes("超时"), "明确说超时");
}

section("取消：等待中取消立刻落 failed");
{
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { deps } = fakeDeps({
    readLoginState: async () => {
      await gate;
      return { loggedIn: false, sessionStatus: 401, meStatus: -1, hasAccessToken: false, accessTokenLength: 0, planType: null, emailDomain: null, errors: [] };
    },
  });
  const session = new BrowserLoginSession(deps);
  session.start();
  await new Promise((r) => setTimeout(r, 20));
  const after = session.cancel("用户点了取消");
  eq(after.phase, "failed", "取消即失败");
  ok(after.message.includes("取消"), "原因可读");
  release();
  await settle(session);
}

section("拿不到 token 不能假装成功");
{
  const { deps, calls } = fakeDeps({ getAccessToken: async () => null });
  const session = new BrowserLoginSession(deps);
  session.start();
  const final = await settle(session);
  eq(final.phase, "failed", "无 token -> 失败");
  ok(final.message.includes("accessToken"), "说清原因");
  eq(calls.saveAuth, 0, "不得写凭证");
}

section("浏览器拉起失败：错误可读，不抛到调用方");
{
  const { deps } = fakeDeps({ ensureBrowser: async () => { throw new Error("未找到可用的 Edge/Chrome 可执行文件"); } });
  const session = new BrowserLoginSession(deps);
  session.start();
  const final = await settle(session);
  eq(final.phase, "failed", "拉起失败 -> failed");
  ok(final.message.includes("Edge/Chrome"), "保留原始原因");
}

section("页面打不开：明确失败而不是永远等");
{
  const { deps } = fakeDeps({ attachPage: async () => null });
  const session = new BrowserLoginSession(deps);
  session.start();
  const final = await settle(session);
  eq(final.phase, "failed", "附着不上 -> failed");
  ok(final.message.includes("chatgpt.com"), "提示要手动打开页面");
}

section("页面丢失：连续探测失败即中止");
{
  let polls = 0;
  const { deps } = fakeDeps({
    readLoginState: async () => {
      polls += 1;
      throw new Error("Target closed");
    },
  });
  const session = new BrowserLoginSession(deps);
  session.start();
  const final = await settle(session);
  eq(final.phase, "failed", "页面丢了 -> failed");
  ok(final.message.includes("窗口"), "提示检查窗口");
  ok(polls >= 5, "连续失败才判定（不是一次就放弃）");
}

section("默认产物的安全性：状态快照里没有凭证明文");
{
  const { deps } = fakeDeps();
  const session = new BrowserLoginSession(deps);
  session.start();
  const final = await settle(session);
  const text = JSON.stringify(final);
  ok(!text.includes("tok-"), "快照不含 token 明文");
  ok(!text.includes("cf_clearance"), "快照不含 cookie 明文");
}

section("等待上限");
{
  ok(LOGIN_TIMEOUT_MS >= 5 * 60_000, "至少 5 分钟（要留时间输入密码 + 二次验证）");
}
