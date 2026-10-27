#!/usr/bin/env node
// Phase 1b: 抓取原始 SSE data 帧，用于确定 patch 流格式。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9222;
const ARGV = process.argv.slice(2);
const PROMPT = (ARGV.find((a) => a.startsWith("--prompt=")) || "--prompt=Reply with exactly: PONG").slice(9);
async function getJson(u) { return (await fetch(u)).json(); }

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); return;
      }
      if (m.method) for (const fn of (this.handlers.get(m.method) || [])) fn(m.params);
    });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new Cdp(ws)));
      ws.addEventListener("error", () => rej(new Error("CDP connect failed")));
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evaluate(cdp, expression, timeoutMs) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: timeoutMs || 180000 });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error("页面内异常: " + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

async function main() {
  const list = await getJson("http://127.0.0.1:" + PORT + "/json/list");
  const page = list.find((t) => t.type === "page" && (t.url || "").includes("chatgpt.com"));
  if (!page) throw new Error("没有 chatgpt.com 页面");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  const sha = readFileSync(join(HERE, "..", "src", "wire", "page-pow.js"), "utf8");
  const logic = readFileSync(join(HERE, "..", "src", "wire", "page-turn.js"), "utf8");

  const prelude = [
    "(function(){",
    sha,
    "globalThis.__SHA3__ = sha3_512;",
    "globalThis.__BYTES__ = bytesOf;",
    "globalThis.__B64__ = b64;",
    "globalThis.__HEX__ = hex;",
    "})();",
    "globalThis.__P2_PROMPT = " + JSON.stringify(PROMPT) + ";",
  ].join("\n");

  await evaluate(cdp, prelude, 30000);
  console.log("SHA3 已注入");
  console.log("");
  console.log("=== 发送中 ===");
  const r = await evaluate(cdp, logic, 180000);

  console.log("status=" + r.status + "  events=" + r.dataEvents + "  done=" + r.sawDone + "  ms=" + r.totalMs);
  if (r.error) console.log("error=" + r.error);
  if (r.errorBody) console.log("body=" + r.errorBody);
  console.log("");
  console.log("=== 原始 data 帧（前 " + (r.raw || []).length + " 条）===");
  for (let i = 0; i < (r.raw || []).length; i++) {
    console.log("--- [" + i + "] ---");
    console.log(r.raw[i]);
  }
  cdp.close();
}

main().catch((e) => { console.error("失败: " + (e && e.message ? e.message : e)); process.exitCode = 1; });