/**
 * SSE patch 流解析器。
 *
 * 实测得到的帧形态（2026-10-27，免费档）见 tests/fixtures/README.md：
 *   "v1"                                              编码协商
 *   {"v":{"message":{...}}}                            整条消息（add / 更新）
 *   {"o":"patch","v":[{"p":...,"o":...,"v":...}, ...]} 批量 patch
 *   {"p":"/message/...","o":"append","v":...}          单条 patch
 *   {"type":"...", ...}                                具名事件（含 title_generation 等）
 *   data: [DONE]                                      结束
 *
 * 关键点：正文在 {"v":{"message":...}} 里，终态在 {"o":"patch"} 里 —— 只看顶层
 * message 字段会漏掉全部正文（这是我第一版探针踩过的坑）。
 */

import type { SseFrame, PatchOp, ChatMessage } from "./types.ts";

export function classifyFrame(raw: string): SseFrame {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "unknown", raw };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 少数帧是裸字符串，比如编码协商的 "v1"（带引号）或 v1（不带）
    if (trimmed === "v1" || trimmed === '"v1"') return { kind: "encoding", value: "v1" };
    return { kind: "unknown", raw };
  }

  if (typeof parsed === "string") return { kind: "encoding", value: parsed };
  if (parsed === null || typeof parsed !== "object") return { kind: "unknown", raw };

  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.v) && typeof obj.o === "string" && obj.o === "patch") {
    return { kind: "patch", ops: obj.v as PatchOp[] };
  }
  if (typeof obj.p === "string" && typeof obj.o === "string") {
    return { kind: "update", path: obj.p, op: obj.o, value: obj.v };
  }
  if (obj.v !== null && typeof obj.v === "object" && !Array.isArray(obj.v)) {
    const inner = obj.v as Record<string, unknown>;
    if (inner.message !== null && typeof inner.message === "object") {
      return { kind: "message", message: inner.message as ChatMessage };
    }
  }
  if (typeof obj.type === "string") {
    return { kind: "event", type: obj.type, data: obj };
  }
  return { kind: "unknown", raw };
}

/** 把 SSE 字节流切成 data 帧。返回每帧的 data 内容（不含 "data:" 前缀）。 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload.length > 0) yield payload;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 累积器：把 message 帧与 patch 帧合成为最终文本与终态。
 *
 * 只保留 assistant 角色的消息；system 消息是站内隐藏上下文，user 消息是回显。
 */
export class TurnAccumulator {
  conversationId: string | null = null;
  messageId: string | null = null;
  finishType: string | null = null;
  sawDone = false;

  private text = "";
  private readonly fragments = new Map<string, string>();
  private status: string | null = null;

  push(frame: SseFrame): void {
    switch (frame.kind) {
      case "message":
        this.absorbMessage(frame.message);
        break;
      case "patch":
        for (const op of frame.ops) this.applyOp(op);
        break;
      case "update":
        this.applyOp({ p: frame.path, o: frame.op, v: frame.value });
        break;
      case "event":
        if (frame.type === "title_generation") {
          const cid = frame.data.conversation_id;
          if (typeof cid === "string") this.conversationId = cid;
        }
        break;
      default:
        break;
    }
  }

  private absorbMessage(msg: ChatMessage): void {
    const role = msg.author?.role;
    if (role !== "assistant") return;
    this.messageId = msg.id;
    if (typeof msg.status === "string") this.status = msg.status;
    const parts = msg.content?.parts;
    if (Array.isArray(parts) && parts.length > 0) {
      const joined = parts.filter((p): p is string => typeof p === "string").join("");
      this.fragments.set(msg.id, joined);
      this.text = joined;
    }
    this.readFinish(msg.metadata);
  }

  private applyOp(op: PatchOp): void {
    if (op.p === "/message/status" && typeof op.v === "string") {
      this.status = op.v;
      return;
    }
    if (op.p === "/message/metadata" && op.v !== null && typeof op.v === "object") {
      const v = op.v as Record<string, unknown>;
      const fd = v.finish_details;
      if (fd !== null && typeof fd === "object") {
        const type = (fd as Record<string, unknown>).type;
        if (typeof type === "string") this.finishType = type;
      }
      return;
    }
    if (op.p.startsWith("/message/content/parts/")) {
      const idx = Number.parseInt(op.p.slice("/message/content/parts/".length), 10);
      if (!Number.isInteger(idx) || idx < 0) return;
      if (op.o === "append" && typeof op.v === "string") {
        this.appendPart(idx, op.v);
      } else if (op.o === "replace" && typeof op.v === "string") {
        this.replacePart(idx, op.v);
      }
    }
  }

  private readonly parts = new Map<number, string>();

  private appendPart(idx: number, chunk: string): void {
    this.parts.set(idx, (this.parts.get(idx) ?? "") + chunk);
    this.text = this.renderParts();
  }

  private replacePart(idx: number, chunk: string): void {
    this.parts.set(idx, chunk);
    this.text = this.renderParts();
  }

  private renderParts(): string {
    const keys = [...this.parts.keys()].sort((a, b) => a - b);
    return keys.map((k) => this.parts.get(k) ?? "").join("");
  }

  private readFinish(metadata: Record<string, unknown> | undefined): void {
    if (metadata === undefined) return;
    const fd = metadata.finish_details;
    if (fd === null || typeof fd !== "object") return;
    const type = (fd as Record<string, unknown>).type;
    if (typeof type === "string") this.finishType = type;
  }

  get textValue(): string {
    return this.text;
  }

  get statusValue(): string | null {
    return this.status;
  }

  /** 账号级限流：服务端用 finish/details 或错误帧表达，这里只看已知形态。 */
  get rateLimited(): boolean {
    return this.finishType === "rate_limit" || this.finishType === "message_limit";
  }

  get complete(): boolean {
    return this.status === "finished_successfully";
  }
}
