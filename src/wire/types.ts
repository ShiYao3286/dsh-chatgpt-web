/**
 * 线缆层（wire）的共享类型。这里只描述 chatgpt.com 私有接口的形状，
 * 不含任何策略决策 —— 策略在 binding / gate 层。
 */

/** 一个内容块。当前只处理 text；图片/工具结果按 text 承载。 */
export interface ChatContentPart {
  content_type: string;
  parts: string[];
}

export interface ChatMessage {
  id: string;
  author: { role: string; name?: string | null; metadata?: Record<string, unknown> };
  create_time?: number | null;
  content: ChatContentPart;
  status?: string;
  end_turn?: boolean | null;
  recipient?: string;
  metadata?: Record<string, unknown>;
}

/** SSE 帧的三种形态，实测获得的完整分类。 */
export type SseFrame =
  | { kind: "encoding"; value: string }
  | { kind: "event"; type: string; data: Record<string, unknown> }
  | { kind: "message"; message: ChatMessage }
  | { kind: "patch"; ops: PatchOp[] }
  | { kind: "update"; path: string; op: string; value: unknown }
  | { kind: "unknown"; raw: string };

export interface PatchOp {
  p: string;
  o: string;
  v: unknown;
}

/** 从 /api/auth/session 取到的认证材料。 */
export interface SessionAuth {
  accessToken: string;
  planType: string | null;
  userEmailDomain: string | null;
}

/** sentinel 返回的挑战材料。 */
export interface SentinelResult {
  persona: string | null;
  token: string | null;
  proofofwork: { required: boolean; seed: string; difficulty: string } | null;
  turnstileRequired: boolean;
  forceLogin: boolean;
}

/** 一次发送所需的全部请求材料。 */
export interface SendContext {
  auth: SessionAuth;
  sentinel: SentinelResult;
  proofToken: string | null;
  dataBuild: string;
  userAgent: string;
  languages: string[];
}

/** 发送结果。 */
export interface SendOutcome {
  conversationId: string | null;
  messageId: string | null;
  text: string;
  finishType: string | null;
  sawDone: boolean;
  status: number;
  ttfbMs: number;
  totalMs: number;
  errorBody?: string;
}
