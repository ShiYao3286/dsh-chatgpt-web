import { ok, eq, section } from "./harness.mjs";
import { DEFAULT_TRANSPORT, normalizeTransport, shouldFallback, TRANSPORT_HINT } from "../src/transport/select.ts";
import { browserHeaders, looksLikeCloudflare } from "../src/transport/node-http.ts";
import { normalizeAuth, authFingerprint } from "../src/auth.ts";

section("传输层：默认 Node，不需要浏览器");
eq(DEFAULT_TRANSPORT, "node", "默认 transport 是 node");
eq(normalizeTransport("node"), "node", "显式 node");
eq(normalizeTransport("chromium"), "chromium", "显式 chromium");
eq(normalizeTransport("bogus"), undefined, "非法值返回 undefined");
eq(normalizeTransport(null), undefined, "null 返回 undefined");
ok(TRANSPORT_HINT.node.includes("不需要浏览器"), "提示语说明 Node 不需要浏览器");

section("回落判定：只有 cloudflare 才回落");
eq(shouldFallback("cloudflare"), true, "cloudflare 回落");
eq(shouldFallback("auth"), false, "auth 不回落（换凭证才有用）");
eq(shouldFallback("rate-limit"), false, "限流不回落");
eq(shouldFallback("network"), false, "网络错误不回落");
eq(shouldFallback(null), false, "无失败不回落");

section("Cloudflare 判定");
eq(looksLikeCloudflare(403, "<html><head><title>Just a moment...</title></head><body>cloudflare</body></html>"), true, "403 + CF 挑战页");
eq(looksLikeCloudflare(503, "cloudflare"), true, "503 + cloudflare");
eq(looksLikeCloudflare(200, "<html>ok</html>"), false, "200 不算拦截");
eq(looksLikeCloudflare(403, '{"error":"forbidden"}'), false, "403 + JSON 不是 CF（是鉴权问题）");
eq(looksLikeCloudflare(401, "<html>"), false, "401 不是 CF");

section("浏览器头：贴近真实 Chrome");
{
  const h = browserHeaders({
    version: 1,
    accessToken: "T",
    cookieHeader: "a=1; b=2",
    dataBuild: "b1",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    languages: ["zh-CN", "en"],
    planType: "free",
    capturedAt: 0,
    lastOkAt: null,
  });
  eq(h["user-agent"].includes("Chrome/156"), true, "UA 保留");
  ok(h["sec-ch-ua"].includes('v="156"'), "sec-ch-ua 版本与 UA 一致");
  eq(h["sec-ch-ua-mobile"], "?0", "桌面端标记");
  eq(h["sec-ch-ua-platform"], '"Windows"', "平台标记");
  eq(h["sec-fetch-mode"], "cors", "fetch mode");
  eq(h.cookie, "a=1; b=2", "带上 cookie");
  ok(h["accept-language"].startsWith("zh-CN,en"), "语言头");
}

section("浏览器头：没有 cookie 时不写该头");
{
  const h = browserHeaders({ version: 1, accessToken: "T", cookieHeader: null, dataBuild: "", userAgent: "", languages: [], planType: null, capturedAt: 0, lastOkAt: null });
  eq(Object.hasOwn(h, "cookie"), false, "无 cookie 时不写");
  ok(h["user-agent"].includes("Chrome"), "空 UA 有默认值");
}

section("凭证归一化");
eq(normalizeAuth({ accessToken: "abc" }) !== null, true, "最小凭证可用");
eq(normalizeAuth({ accessToken: "" }), null, "空 token 拒绝");
eq(normalizeAuth({}), null, "缺 token 拒绝");
eq(normalizeAuth(null), null, "null 拒绝");
{
  const a = normalizeAuth({ accessToken: "abc", dataBuild: "b", languages: ["x"], capturedAt: 5 });
  eq(a.dataBuild, "b", "dataBuild 保留");
  eq(a.languages[0], "x", "languages 保留");
  eq(a.capturedAt, 5, "时间保留");
}

section("凭证指纹：不泄露完整 token");
{
  const a = normalizeAuth({ accessToken: "eyJhbGciOiJIUzI1NiJ9" + "x".repeat(200) });
  const fp = authFingerprint(a);
  eq(fp.includes("x".repeat(50)), false, "不含 token 长串");
  ok(fp.includes("len="), "带长度信息");
  ok(fp.length < 40, "指纹很短");
}