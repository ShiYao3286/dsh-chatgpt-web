#!/usr/bin/env node
// t6 端到端冒烟：用正式代码路径真实跑一轮。不连发。
import { ensureBrowser, attachPage } from "../src/transport/browser.ts";
import { getAccessToken, getDataBuild, readLoginState } from "../src/transport/page.ts";
import { runTurn, toResponse } from "../src/adapter.ts";
import { randomUUID } from "node:crypto";

const PROMPT = process.argv.find((a) => a.startsWith("--prompt="))?.slice(9) ?? "Reply with exactly one word: PONG";

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + " 超时 " + ms + "ms")), ms)),
  ]);
}

async function main() {
  console.log("=== 1. 浏览器 ===");
  const session = await withTimeout(ensureBrowser({ port: 9222 }), 20000, "ensureBrowser");
  console.log("  mode:", session.mode);

  const attached = await withTimeout(attachPage(session, "chatgpt.com"), 15000, "attachPage");
  if (attached === null) throw new Error("attachPage 返回 null（找不到 chatgpt.com 页面）");
  const cdp = attached.cdp;
  console.log("  已附着页面:", attached.target.url.slice(0, 60));

  console.log("");
  console.log("=== 2. 页面事实 ===");
  const login = await withTimeout(readLoginState(cdp), 15000, "readLoginState");
  console.log("  loggedIn:", login.loggedIn);
  console.log("  accessTokenLength:", login.accessTokenLength);
  const token = await withTimeout(getAccessToken(cdp), 15000, "getAccessToken");
  console.log("  token 可取:", token !== null);
  const build = await withTimeout(getDataBuild(cdp), 10000, "getDataBuild");
  console.log("  data-build:", build ?? "(空)");
  if (!login.loggedIn || token === null) throw new Error("未登录，无法冒烟");

  console.log("");
  console.log("=== 3. 真实发送一轮（会消耗 1 条免费额度）===");
  const t0 = Date.now();
  const raw = await withTimeout(
    runTurn({ cdp, prompt: PROMPT, conversationId: null, parentMessageId: null, userMessageId: randomUUID(), model: "auto" }),
    150000, "runTurn",
  );
  const resp = toResponse(raw);
  console.log("  status:", resp.status);
  console.log("  ok:", resp.ok);
  console.log("  failure:", resp.failure);
  console.log("  首字节:", resp.ttfbMs, "ms");
  console.log("  总耗时:", resp.totalMs, "ms（墙钟", Date.now() - t0, "ms）");
  console.log("  conversation_id:", resp.conversationId ? "已拿到" : "未拿到");
  console.log("  message_id:", resp.messageId ?? "(空)");
  console.log("  finishType:", resp.finishType);
  console.log("  正文长度:", resp.text.length);
  console.log("  正文:", JSON.stringify(resp.text.slice(0, 200)));

  const pass = resp.ok && resp.text.trim().length > 0;
  console.log("");
  console.log(pass ? "  [PASS] 端到端跑通" : "  [FAIL] 端到端失败");
  process.exitCode = pass ? 0 : 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error("失败:", e?.message ?? e); process.exit(1); });