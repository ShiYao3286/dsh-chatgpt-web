import { ok, eq, section } from "./harness.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha3_512, utf8, toBase64, toHex } from "../src/pow/sha3.ts";
import { buildPowConfig, solveProofToken, solveRequirementsToken } from "../src/pow/solve.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "wire", "page-pow.js");

// 在 Node 里加载页面侧运行时：它只依赖 BigInt / TextEncoder / btoa。
globalThis.window = globalThis.window ?? {};
globalThis.btoa = globalThis.btoa ?? ((s) => Buffer.from(s, "binary").toString("base64"));
const code = readFileSync(SRC, "utf8");
new Function(code)();
const POW = globalThis.__POW__;

section("页面运行时存在");
ok(POW !== undefined, "globalThis.__POW__ 已挂载");
for (const k of ["sha3_512", "utf8", "toBase64", "toHex", "utcParseTime", "buildPowConfig", "solveRequirementsToken", "solveProofToken"]) {
  eq(typeof POW?.[k], "function", "导出 " + k);
}

section("差分：SHA3-512 与 TS 实现逐字节一致");
{
  const cases = ["", "abc", "a".repeat(72), "a".repeat(73), "The quick brown fox jumps over the lazy dog", "中文路径 E:\\x"];
  for (const s of cases) {
    const a = toHex(sha3_512(utf8(s)));
    const b = POW.toHex(POW.sha3_512(POW.utf8(s)));
    eq(b, a, "SHA3(" + JSON.stringify(s.slice(0, 24)) + ") 一致");
  }
  // NIST 向量
  eq(POW.toHex(POW.sha3_512(POW.utf8("abc"))),
     "b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0",
     "页面实现命中 NIST 向量");
}

section("差分：utcParseTime 与 TS 一致");
{
  const t = Date.UTC(2026, 9, 27, 5, 48, 45);
  const tsImpl = buildPowConfig({ userAgent: "UA", languages: ["en"], now: t, uuid: "u", perfNow: 1 })[1];
  const jsImpl = POW.buildPowConfig({ userAgent: "UA", languages: ["en"], now: t, uuid: "u", perfNow: 1 })[1];
  eq(jsImpl, tsImpl, "同一时刻的时间串一致");
  ok(String(tsImpl).includes("GMT+0200"), "带时区后缀");
}

section("差分：config 形状一致（除随机项）");
{
  const env = { userAgent: "UA", languages: ["zh-CN", "en"], hardwareConcurrency: 12, screenWidth: 2560, dataBuild: "b1", now: 1000, uuid: "u-1", perfNow: 42 };
  const a = buildPowConfig(env);
  const b = POW.buildPowConfig(env);
  eq(a.length, b.length, "长度相同（18）");
  eq(b[0], a[0], "core+screen 一致");
  eq(b[1], a[1], "时间串一致");
  eq(b[4], a[4], "UA 一致");
  eq(b[6], a[6], "dataBuild 一致");
  eq(b[7], a[7], "语言首项一致");
  eq(b[8], a[8], "语言列表一致");
  eq(b[10], a[10], "navigator key 一致");
  eq(b[12], a[12], "window key 一致");
  eq(b[13], a[13], "perfNow 一致");
  eq(b[14], a[14], "uuid 一致");
  eq(b[17], a[17], "时间戳一致");
}

section("差分：求解结果可被同一 SHA3 验证");
{
  // 固定 seed，两套实现都必须解出且结果能自洽（hash 前缀 <= difficulty）
  const seed = "0.123456789";
  const difficulty = "0fffff";
  const cfg = POW.buildPowConfig({ userAgent: "UA", languages: ["en"], now: 1000, uuid: "u", perfNow: 1 });
  const solved = POW.solveProofToken({ required: true, seed, difficulty }, cfg, 200000);
  eq(typeof solved.token, "string", "解出 token");
  ok(solved.token.startsWith("gAAAAAB"), "前缀正确");
  ok(solved.attempts > 0, "记录尝试次数：" + solved.attempts);
  // 用 TS 侧的 SHA3 独立校验：把 token 的 body 重新拼 seed 做哈希
  const body = solved.token.slice("gAAAAAB".length);
  const digest = toHex(sha3_512(new Uint8Array([...utf8(seed), ...utf8(body)])));
  ok(parseInt(digest.slice(0, difficulty.length), 16) <= parseInt(difficulty, 16), "哈希前缀满足难度（TS 侧独立验证）");
}

section("差分：requirements token 前缀");
{
  const cfg = POW.buildPowConfig({ userAgent: "UA", languages: ["en"], now: 1000, uuid: "u", perfNow: 1 });
  const r = POW.solveRequirementsToken(cfg, 200000);
  ok(r.token.startsWith("gAAAAAC"), "前缀 gAAAAAC");
}
