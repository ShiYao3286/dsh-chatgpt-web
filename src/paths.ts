/**
 * 本机落盘位置。凭证与状态一律放在 DSH home 下，不进仓库。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function dshHome(): string {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.length > 0) return env;
  return join(homedir(), ".dsh");
}

export function webLoginRoot(): string {
  return join(dshHome(), "chatgpt-web");
}

export function profileDir(): string {
  return join(webLoginRoot(), "browser-profile");
}

export function statePath(): string {
  return join(webLoginRoot(), "state.json");
}

export function gatePath(): string {
  return join(webLoginRoot(), "gate.json");
}

export function ledgerDir(): string {
  return join(webLoginRoot(), "ledger");
}

export function diagnosticsDir(): string {
  return join(webLoginRoot(), "diagnostics");
}
