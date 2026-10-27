/**
 * 插件配置：落盘 + 归一化。
 *
 * 这里只放**用户会改的东西**，且都带保守默认值。
 * 落盘在 ~/.dsh/chatgpt-web/config.json，与凭证分开（凭证在 auth.json）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { webLoginRoot } from "./paths.ts";
import { DEFAULT_TRANSPORT, normalizeTransport, type TransportKind } from "./transport/select.ts";

export function configPath(): string {
  return join(webLoginRoot(), "config.json");
}

export interface PluginConfig {
  /** 传输层：node（默认，不需要浏览器）或 chromium（Cloudflare 拦截时用）。 */
  transport: TransportKind;
  /** 调试端口（仅 chromium 用）。 */
  devtoolsPort: number;
  /** 到这里主动轮换网页会话。 */
  softTurns: number;
  /** 强制轮换轮数。 */
  hardTurns: number;
  /** 两次请求最小间隔（毫秒）。 */
  minIntervalMs: number;
  /** 间隔上限；与下限不等时随机取值。 */
  maxIntervalMs: number;
  /** 滚动窗口内最多几次请求。 */
  rateMaxInWindow: number;
  /** 工具目录字符预算。 */
  catalogBudgetChars: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
  transport: DEFAULT_TRANSPORT,
  devtoolsPort: 9222,
  softTurns: 25,
  hardTurns: 40,
  minIntervalMs: 4000,
  maxIntervalMs: 9000,
  rateMaxInWindow: 12,
  catalogBudgetChars: 24000,
};

function int(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 归一化：任何非法值都退回默认，且保证 hardTurns 严格大于 softTurns。 */
export function normalizeConfig(raw: unknown): PluginConfig {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const softTurns = int(o.softTurns, DEFAULT_CONFIG.softTurns, 1, 500);
  const hardTurns = Math.max(int(o.hardTurns, DEFAULT_CONFIG.hardTurns, 2, 1000), softTurns + 1);
  const minIntervalMs = int(o.minIntervalMs, DEFAULT_CONFIG.minIntervalMs, 0, 600_000);
  const maxIntervalMs = Math.max(int(o.maxIntervalMs, DEFAULT_CONFIG.maxIntervalMs, 0, 600_000), minIntervalMs);
  return {
    transport: normalizeTransport(o.transport) ?? DEFAULT_CONFIG.transport,
    devtoolsPort: int(o.devtoolsPort, DEFAULT_CONFIG.devtoolsPort, 1024, 65535),
    softTurns,
    hardTurns,
    minIntervalMs,
    maxIntervalMs,
    rateMaxInWindow: int(o.rateMaxInWindow, DEFAULT_CONFIG.rateMaxInWindow, 1, 500),
    catalogBudgetChars: int(o.catalogBudgetChars, DEFAULT_CONFIG.catalogBudgetChars, 2000, 200_000),
  };
}

export async function loadConfig(path: string = configPath()): Promise<PluginConfig> {
  try {
    const text = await readFile(path, "utf8");
    return normalizeConfig(JSON.parse(text));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: PluginConfig, path: string = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(normalizeConfig(config), null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** 给设置页的人类可读摘要。 */
export function describeConfig(c: PluginConfig): string {
  return [
    "传输：" + (c.transport === "node" ? "Node 直连" : "浏览器代理"),
    "轮换：" + c.softTurns + " / " + c.hardTurns + " 轮",
    "间隔：" + c.minIntervalMs + "~" + c.maxIntervalMs + " ms",
    "窗口：" + c.rateMaxInWindow + " 次",
    "工具预算：" + c.catalogBudgetChars + " 字符",
  ].join(" · ");
}