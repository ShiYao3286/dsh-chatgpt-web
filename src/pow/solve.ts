/**
 * ChatGPT 网页端 PoW 求解。
 *
 * 两种挑战，格式不同但共用同一套 SHA3-512 搜索：
 *   1. requirements token —— 前缀 'gAAAAAC'，difficulty 固定 '0fffff'，seed 是自己造的随机数
 *   2. chat proof token    —— 前缀 'gAAAAAB'，seed/difficulty 由 sentinel 下发
 *
 * 算法（据 g4f 的 openai/proofofwork.py 与实测验证）：
 *   config 是 18 元素的"浏览器指纹"数组。拼装时**故意把第 4、5 个元素挖空**，
 *   换成两个递增计数器 i 与 i>>1，再 base64(JSON 片段拼装) 后与 seed 连接做 SHA3-512，
 *   取前 diffLen 个 hex 字符与 difficulty 比较（字典序 <=）。
 *
 * 为什么这么奇怪：站点前端就是这么拼的。任何简化都会导致永远解不出来。
 */

import { sha3_512, utf8, toBase64, toHex, concat } from "./sha3.ts";

export interface PowChallenge {
  required: boolean;
  seed: string;
  difficulty: string;
}

export interface SolveResult {
  token: string;
  attempts: number;
  ms: number;
}

/** 组装 18 元素的浏览器指纹 config。数值尽量从真实环境取，取不到才用保守默认。 */
export function buildPowConfig(env: {
  userAgent: string;
  languages: readonly string[];
  hardwareConcurrency?: number;
  screenWidth?: number;
  dataBuild?: string;
  now?: number;
  uuid: string;
  perfNow: number;
}): unknown[] {
  const core = String(env.hardwareConcurrency ?? 8);
  const screen = String(env.screenWidth ?? 1920);
  return [
    core + screen,
    utcParseTime(env.now ?? Date.now()),
    null,
    Math.random(),
    env.userAgent,
    null,
    env.dataBuild ?? "",
    "en-US",
    env.languages.join(","),
    0,
    "webdriver",
    "location",
    "window",
    env.perfNow,
    env.uuid,
    "",
    8,
    Math.floor((env.now ?? Date.now()) / 1000),
  ];
}

/** 形如 "Tue Oct 27 2026 05:48:45 GMT+0200 (Central European Summer Time)" */
export function utcParseTime(ms: number): string {
  const d = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    days[d.getUTCDay()] +
    " " +
    months[d.getUTCMonth()] +
    " " +
    p(d.getUTCDate()) +
    " " +
    d.getUTCFullYear() +
    " " +
    p(d.getUTCHours()) +
    ":" +
    p(d.getUTCMinutes()) +
    ":" +
    p(d.getUTCSeconds()) +
    " GMT+0200 (Central European Summer Time)"
  );
}

function solve(seed: string, difficulty: string, config: unknown[], maxAttempts: number): SolveResult {
  const t0 = Date.now();
  const diffLen = difficulty.length;
  const target = Number.parseInt(difficulty, 16);
  const seedBytes = utf8(seed);

  // 把 config 切成三段，中间留出两个计数器的位置。
  const p1 = utf8(JSON.stringify(config.slice(0, 3)).slice(0, -1) + ",");
  const p2 = utf8("," + JSON.stringify(config.slice(4, 9)).slice(1, -1) + ",");
  const p3 = utf8("," + JSON.stringify(config.slice(10)).slice(1));

  for (let i = 0; i < maxAttempts; i++) {
    const d1 = utf8(String(i));
    const d2 = utf8(String(i >> 1));
    const body = concat(concat(concat(concat(p1, d1), p2), d2), p3);
    const base = toBase64(body);
    const digest = sha3_512(concat(seedBytes, utf8(base)));
    if (Number.parseInt(toHex(digest).slice(0, diffLen), 16) <= target) {
      return { token: base, attempts: i + 1, ms: Date.now() - t0 };
    }
  }
  throw new PowUnsolvedError(maxAttempts);
}

export class PowUnsolvedError extends Error {
  readonly attempts: number;
  constructor(attempts: number) {
    super(`PoW 求解失败：尝试 ${attempts} 次仍未命中`);
    this.name = "PowUnsolvedError";
    this.attempts = attempts;
  }
}

/** requirements token：前缀 gAAAAAC，难度固定 0fffff。 */
export function solveRequirementsToken(config: unknown[], maxAttempts = 500_000): SolveResult {
  const seed = String(Math.random());
  const r = solve(seed, "0fffff", config, maxAttempts);
  return { ...r, token: "gAAAAAC" + r.token };
}

/** chat proof token：前缀 gAAAAAB，seed/difficulty 由 sentinel 下发。 */
export function solveProofToken(challenge: PowChallenge, config: unknown[], maxAttempts = 500_000): SolveResult {
  const r = solve(challenge.seed, challenge.difficulty, config, maxAttempts);
  return { ...r, token: "gAAAAAB" + r.token };
}
