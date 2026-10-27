/**
 * 凭证捕获与持久化。
 *
 * 为什么要这一层：浏览器不是必须的。accessToken、cookie、data-build 都只是**字符串**，
 * 捕获一次落盘就能反复用，不需要一直挂着一个调试浏览器。
 *
 * 落盘位置在 ~/.dsh/chatgpt-web/auth.json（不进仓库、不经网络）。
 * 唯一要定期做的事是**刷新 accessToken** —— 它有过期时间。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { authPath } from "./paths.ts";

export interface StoredAuth {
  version: 1;
  /** 必需：Bearer token，所有 /backend-api/* 都要它。 */
  accessToken: string;
  /** 或有的会话 cookie 串（cf_clearance 等由浏览器补，这里只存我们能拿到的）。 */
  cookieHeader: string | null;
  /** 站点构建号，PoW 指纹要用。 */
  dataBuild: string;
  userAgent: string;
  languages: string[];
  planType: string | null;
  /** 捕获时刻与最后成功使用时刻（毫秒）。 */
  capturedAt: number;
  lastOkAt: number | null;
}

export function normalizeAuth(raw: unknown): StoredAuth | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.accessToken !== "string" || o.accessToken.length === 0) return null;
  return {
    version: 1,
    accessToken: o.accessToken,
    cookieHeader: typeof o.cookieHeader === "string" && o.cookieHeader.length > 0 ? o.cookieHeader : null,
    dataBuild: typeof o.dataBuild === "string" ? o.dataBuild : "",
    userAgent: typeof o.userAgent === "string" ? o.userAgent : "",
    languages: Array.isArray(o.languages) ? o.languages.filter((x): x is string => typeof x === "string") : ["en-US"],
    planType: typeof o.planType === "string" ? o.planType : null,
    capturedAt: typeof o.capturedAt === "number" ? o.capturedAt : 0,
    lastOkAt: typeof o.lastOkAt === "number" ? o.lastOkAt : null,
  };
}

export async function loadAuth(path: string = authPath()): Promise<StoredAuth | null> {
  try {
    const text = await readFile(path, "utf8");
    return normalizeAuth(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function saveAuth(auth: StoredAuth, path: string = authPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  // 先写临时文件再 rename：写一半崩掉不会留下坏凭证。
  await writeFile(tmp, JSON.stringify(auth, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** 认不出 token 是否过期（它是 JWT 但服务端不按 exp 拒），只能靠使用失败来判定。 */
export function authFingerprint(auth: StoredAuth): string {
  // 只暴露前 8 位用于日志辨识，绝不打印完整 token。
  const head = auth.accessToken.slice(0, 8);
  return head + "…(len=" + auth.accessToken.length + ")";
}

/** 组装 cookie 头：存的东西在前，调用方可再追加。 */
export function cookieHeaderOf(auth: StoredAuth): string | null {
  return auth.cookieHeader;
}