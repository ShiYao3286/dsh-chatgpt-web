#!/usr/bin/env node
// 等你登录，然后立刻捕获凭证落盘。
import { ensureBrowser, attachPage } from "../src/transport/browser.ts";
import { getAccessToken, getDataBuild, readLoginState, readPageEnv, evalInPage } from "../src/transport/page.ts";
import { saveAuth, loadAuth, authFingerprint } from "../src/auth.ts";

async function main() {
  const session = await ensureBrowser({ port: 9222 });
  const attached = await attachPage(session, "chatgpt.com");
  if (attached === null) throw new Error("找不到 chatgpt.com 页面");
  const cdp = attached.cdp;
  await cdp.bringToFront().catch(() => {});

  console.log("等待登录中（最多 10 分钟）…");
  const deadline = Date.now() + 600_000;
  let ok = false;
  while (Date.now() < deadline) {
    const login = await readLoginState(cdp);
    if (login.loggedIn) { ok = true; break; }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("");
  if (!ok) throw new Error("等待登录超时");
  console.log("已登录，开始捕获…");

  const token = await getAccessToken(cdp);
  if (token === null) throw new Error("拿不到 accessToken");
  const dataBuild = await getDataBuild(cdp);
  const env = await readPageEnv(cdp);

  const cookies = await cdp.getAllCookies();
  const relevant = cookies.filter((c) => {
    const d = String(c.domain ?? "");
    return d.includes("chatgpt.com") || d.includes("openai.com");
  });
  const cookieHeader = relevant
    .filter((c) => typeof c.name === "string" && typeof c.value === "string")
    .map((c) => String(c.name) + "=" + String(c.value))
    .join("; ");

  const plan = await evalInPage(cdp, "(async()=>{const r=await fetch('/api/auth/session',{credentials:'include'});const j=await r.json();return j&&j.account?j.account.planType:null})()");

  await saveAuth({
    version: 1,
    accessToken: token,
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
    dataBuild: dataBuild ?? "",
    userAgent: env.userAgent,
    languages: env.languages.length > 0 ? [...env.languages] : ["en-US"],
    planType: typeof plan === "string" ? plan : null,
    capturedAt: Date.now(),
    lastOkAt: null,
  });

  const saved = await loadAuth();
  console.log("已落盘:", authFingerprint(saved));
  console.log("cookie 项数:", relevant.length);
  console.log("dataBuild:", dataBuild ?? "(空)");
  console.log("planType:", plan ?? "(未知)");
}

main().catch((e) => { console.error("失败:", e?.message ?? e); process.exit(1); });