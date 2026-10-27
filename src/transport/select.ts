/**
 * 传输层选择：默认 Node，浏览器只在必要时才用。
 *
 * 这个默认值是**实测推翻假设**后改的：原设计认为"必须常驻可调试浏览器"，
 * 理由是 ChatGPT 有 Cloudflare + sentinel，担心 TLS 指纹被识别。
 * 但实测（2026-10-27，免费档）：把调试浏览器全部关掉、端口停掉之后，
 * 纯 Node 直连仍然 status 200、拿到完整 SSE、模型真实回复 PONG。
 *
 * 所以 Node 是主路径，CDP 是保险：
 *   - 快，且不需要用户常驻一个浏览器窗口
 *   - 缺点：一旦 Cloudflare 收紧（返回挑战页），需要回落到 CDP
 */

export type TransportKind = "node" | "chromium";

export const DEFAULT_TRANSPORT: TransportKind = "node";

export const TRANSPORT_HINT: Record<TransportKind, string> = {
  node: "Node 直连（推荐，不需要浏览器）",
  chromium: "浏览器代理（Cloudflare 拦截时使用）",
};

export function normalizeTransport(raw: unknown): TransportKind | undefined {
  return raw === "node" || raw === "chromium" ? raw : undefined;
}

/** 什么情况下应该回落到浏览器。 */
export function shouldFallback(failure: string | null): boolean {
  return failure === "cloudflare";
}

/** 传输层能力的可见描述，给设置页用。 */
export interface TransportStatus {
  readonly kind: TransportKind;
  /** Node 是否已有可用凭证。 */
  readonly hasCredential: boolean;
  /** 调试浏览器是否在跑。 */
  readonly browserAlive: boolean;
}
