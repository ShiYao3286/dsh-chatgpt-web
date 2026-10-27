#!/usr/bin/env node
// P0-c: 一次性完成 启动浏览器 -> 等登录 -> 环境与 sentinel 诊断。
// 浏览器以 detached 方式拉起，脚本退出后仍存活，方便后续复用。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, 'profile');
const PORT = 9222;
const ARGV = process.argv.slice(2);
const WAIT = Number((ARGV.find((a) => a.startsWith('--wait=')) || '--wait=25').slice(7));

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) { return (await fetch(url)).json(); }
async function portAlive() {
  try { await getJson('http://127.0.0.1:' + PORT + '/json/version'); return true; } catch { return false; }
}
async function waitForPort(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await portAlive()) return true; await sleep(300); }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
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
      ws.addEventListener('open', () => res(new Cdp(ws)));
      ws.addEventListener('error', () => rej(new Error('CDP connect failed')));
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面内异常: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

const DIAG = [
  '(async () => {',
  '  const out = {};',
  '  out.ua = navigator.userAgent;',
  '  out.webdriver = navigator.webdriver;',
  '  out.languages = navigator.languages;',
  '  out.platform = navigator.platform;',
  '  out.cookieNames = (document.cookie || "").split(";").map(function (s) { return s.trim().split("=")[0]; }).filter(Boolean);',
  '  out.lsNames = Object.keys(localStorage).slice(0, 30);',
  '  const r1 = await fetch("/backend-api/me", { credentials: "include" });',
  '  out.meStatus = r1.status;',
  '  let me = null; try { me = await r1.json(); } catch (e) {}',
  '  out.meEmailDomain = me && me.email ? String(me.email).split("@").pop() : null;',
  '  out.mePlan = me && me.plan_type ? me.plan_type : null;',
  '  const r2 = await fetch("/backend-api/sentinel/chat-requirements", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ p: null }) });',
  '  let sen = null; try { sen = await r2.json(); } catch (e) {}',
  '  out.sentinelStatus = r2.status;',
  '  out.persona = sen && sen.persona;',
  '  out.turnstile = sen && sen.turnstile;',
  '  out.forceLogin = sen && sen.force_login;',
  '  out.expireAfter = sen && sen.expire_after;',
  '  out.pow = sen && sen.proofofwork ? { required: sen.proofofwork.required, difficulty: sen.proofofwork.difficulty, seedLen: (sen.proofofwork.seed || "").length } : null;',
  '  out.sentinelKeys = sen ? Object.keys(sen) : null;',
  '  const r3 = await fetch("/backend-api/conversations?offset=0&limit=3", { credentials: "include" });',
  '  out.convStatus = r3.status;',
  '  let conv = null; try { conv = await r3.json(); } catch (e) {}',
  '  out.convCount = conv && Array.isArray(conv.items) ? conv.items.length : null;',
  '  return out;',
  '})()',
].join('\n');

function pad(k, v) { console.log('  ' + String(k).padEnd(16) + ' ' + v); }

async function main() {
  if (!(await portAlive())) {
    const exe = BROWSERS.find((c) => existsSync(c));
    if (!exe) throw new Error('未找到 Edge/Chrome');
    mkdirSync(PROFILE, { recursive: true });
    console.log('启动浏览器: ' + exe);
    const child = spawn(exe, [
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
      'https://chatgpt.com/',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    if (!(await waitForPort(30000))) throw new Error('调试端口未就绪');
  } else {
    console.log('复用已开的调试浏览器');
  }

  const targets = await getJson('http://127.0.0.1:' + PORT + '/json/list');
  let page = targets.find((t) => t.type === 'page' && (t.url || '').includes('chatgpt.com'));
  if (!page) page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  if (!(page.url || '').includes('chatgpt.com')) {
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: 'https://chatgpt.com/' });
    await sleep(4000);
  }

  // 等登录：轮询 /backend-api/me 直到 200 或超时
  const deadline = Date.now() + WAIT * 1000;
  let st = 0;
  let first = true;
  for (;;) {
    try { st = await evaluate(cdp, "fetch('/backend-api/me',{credentials:'include'}).then(r=>r.status)"); } catch { st = -1; }
    if (st === 200) break;
    if (Date.now() > deadline) break;
    if (first) { console.log('等待登录（当前 status=' + st + '，最多 ' + WAIT + ' 秒）…'); first = false; }
    await sleep(1000);
  }
  console.log('');
  console.log('=== 环境 ===');
  const info = await evaluate(cdp, DIAG);
  pad('meStatus', info.meStatus);
  pad('邮箱域名', String(info.meEmailDomain));
  pad('套餐', String(info.mePlan));
  pad('UA', String(info.ua));
  pad('webdriver', String(info.webdriver));
  pad('platform', String(info.platform));
  pad('languages', JSON.stringify(info.languages));
  pad('cookie 名字', JSON.stringify(info.cookieNames));
  pad('localStorage', JSON.stringify(info.lsNames));
  console.log('');
  console.log('=== sentinel ===');
  pad('status', String(info.sentinelStatus));
  pad('persona', String(info.persona));
  pad('force_login', String(info.forceLogin));
  pad('expire_after', String(info.expireAfter));
  const ts = info.turnstile || {};
  pad('turnstile.required', String(ts.required));
  pad('turnstile.dx 长度', ts.dx ? String(ts.dx).length : 'null');
  pad('proofofwork', JSON.stringify(info.pow));
  pad('字段', JSON.stringify(info.sentinelKeys));
  pad('会话列表 status', String(info.convStatus));
  pad('会话条数', String(info.convCount));
  console.log('');
  console.log('=== 判定 ===');
  const authed = info.persona && info.persona !== 'chatgpt-noauth';
  console.log((authed ? '  [PASS] ' : '  [FAIL] ') + 'persona = ' + info.persona);
  const needPow = !!(info.pow && info.pow.required);
  console.log((needPow ? '  [INFO] ' : '  [INFO] ') + 'PoW ' + (needPow ? '必需（difficulty=' + info.pow.difficulty + '）' : '不需要'));
  cdp.close();
  console.log('');
  console.log('浏览器保持运行（端口 ' + PORT + '），后续脚本可复用。');
}

main().catch((e) => { console.error('失败: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });