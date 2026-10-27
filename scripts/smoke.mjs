#!/usr/bin/env node
// 端到端冒烟：默认走 Node（不需要浏览器）。
import { loadAuth } from "../src/auth.ts";
import { runTurn, toResponse } from "../src/adapter.ts";
import { randomUUID } from "node:crypto";

const PROMPT = (process.argv.find((a) => a.startsWith("--prompt=")) ?? "--prompt=Reply with exactly one word: PONG").slice(9);
const TRANSPORT = process.argv.includes("--chromium") ? "chromium" : "node";

async function main() {
  const auth = await loadAuth();
  if (auth === null) {
    console.log("没有凭证。先跑一次：node scripts/capture-auth.mjs");
    process.exit(2);
  }
  console.log("transport:", TRANSPORT);
  console.log("凭证:", auth.accessToken.slice(0, 8) + "… len=" + auth.accessToken.length);
  console.log("");

  let cdp;
  if (TRANSPORT === "chromium") {
    const { ensureBrowser, attachPage } = await import("../src/transport/browser.ts");
    const session = await ensureBrowser({ port: 9222 });
    const attached = await attachPage(session, "chatgpt.com");
    if (!attached) throw new Error("找不到页面");
    cdp = attached.cdp;
  }

  const t0 = Date.now();
  const raw = await runTurn({ auth, prompt: PROMPT, conversationId: null, parentMessageId: null, userMessageId: randomUUID(), model: "auto", transport: TRANSPORT, cdp });
  const resp = toResponse(raw);
  console.log("status:", resp.status);
  console.log("ok:", resp.ok);
  console.log("failure:", resp.failure);
  console.log("首字节:", resp.ttfbMs, "ms");
  console.log("总耗时:", resp.totalMs, "ms（墙钟", Date.now() - t0, "ms）");
  console.log("conversation_id:", resp.conversationId ? "已拿到" : "未拿到");
  console.log("finishType:", resp.finishType);
  console.log("正文:", JSON.stringify(resp.text.slice(0, 200)));
  console.log("");
  const pass = resp.ok && resp.text.trim().length > 0;
  console.log(pass ? "  [PASS] 端到端跑通" : "  [FAIL] 端到端失败");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("失败:", e?.message ?? e); process.exit(1); });