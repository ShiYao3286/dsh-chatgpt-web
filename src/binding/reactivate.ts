/**
 * 重启后的"复用前校验"。
 *
 * 硬规则（用户明确要求）：**任何不匹配一律 rotate，不硬续**。
 * 续错的代价是整段上下文错位（模型会拿别人的历史当自己的），而轮换的代价
 * 只是一次检查点重建 —— 两者不对称，所以判据必须一边倒。
 *
 * 校验必须是**零成本**的：只比对本地状态里的标识（conversationId / parent / head hash /
 * 水位），不发任何网络请求。真正廉价的"会话是否还在"探测留给调用方在
 * acquire 之后一次性做，这里只负责给出"该不该探"和"探到什么算数"。
 */

import type { BindingState } from "./state.ts";

export type ProbeVerdict =
  /** 探针确认会话/父消息都在，可以复用。 */
  | "alive"
  /** 探针明确说会话没了（404 / not found / deleted）。 */
  | "gone"
  /** 会话在，但父消息不在（消息树被改写/裁剪）。 */
  | "parent-missing"
  /** 探针答不上来（超时/异常/未知）。 */
  | "unknown";

/** 一次经过探针的消息。null 表示"没探"。 */
export type ProbeResult = ProbeVerdict | null;

export interface ReactivateInput {
  /** 落盘读回来的绑定。 */
  binding: BindingState | null;
  /** 本次计算的固定头哈希。 */
  headHash: string;
  /** 水位数（来自当前配置）。 */
  softTurns: number;
  hardTurns: number;
  /** 允许复用的最长闲置时间（ms）。 */
  maxIdleMs: number;
  /** 上一次成功收尾的时刻（ms）；未知则 null。 */
  lastUsedAt: number | null;
  now: number;
  /** 探针结果（有的调用方在 acquire 后才有机会探）。 */
  probe?: ProbeResult;
}

export type ReactivateVerdict =
  | "reuse"
  | "no-binding"
  | "corrupt"
  | "head-changed"
  | "turns-exceeded"
  | "idle-expired"
  | "future-timestamp"
  | "probe-gone"
  | "probe-parent-missing"
  | "probe-unknown";

export interface ReactivateDecision {
  /** true = 可以接着用旧会话；false = 必须开新会话。 */
  reuse: boolean;
  /** 是否必须轮换。与 reuse 严格互补，方便调用方断言。 */
  rotate: boolean;
  reason: ReactivateVerdict;
  /** 人类可读的补充说明，进诊断日志用。 */
  detail: string;
  /** 是否需要先花一次（很廉价的）探针再决定。 */
  needsProbe: boolean;
  /** 是否可以用轮换代替"直接失败"（永远为 true，保留字段是为了语义显式）。 */
  recoverable: boolean;
}

/**
 * 判断重启后能不能复用旧绑定。
 *
 * 注意判断顺序：先"绑定根本没法用"，再"绑定明确死了"，最后"可能死了"。
 * 这样诊断信息最具体，也保证任何一条不满足都落到 rotate。
 */
export function evaluateReactivate(input: ReactivateInput): ReactivateDecision {
  const audit = auditBinding(input.binding);
  if (!audit.ok) {
    return rotate(audit.reason, audit.detail, false);
  }

  const binding = input.binding as BindingState;

  if (binding.headHash !== input.headHash) {
    return rotate("head-changed", "固定头变了（bootstrap/工具目录/协议版本）", false);
  }
  if (binding.turns >= input.hardTurns) {
    return rotate("turns-exceeded", "turns=" + binding.turns + " >= hardTurns=" + input.hardTurns, false);
  }
  if (binding.turns >= input.softTurns) {
    return rotate("turns-exceeded", "turns=" + binding.turns + " >= softTurns=" + input.softTurns, false);
  }

  if (input.lastUsedAt !== null) {
    const idle = input.now - input.lastUsedAt;
    if (idle < 0) {
      // 时钟回拨：闲置时长不可信，宁可轮换。
      return rotate("future-timestamp", "lastUsedAt 在未来（钟回拨），闲置时长不可信", false);
    }
    if (idle > input.maxIdleMs) {
      return rotate("idle-expired", "闲置 " + idle + "ms > " + input.maxIdleMs + "ms", false);
    }
  }

  const probe: ProbeResult = input.probe ?? null;
  if (probe === "gone") return rotate("probe-gone", "探针确认会话已不存在", false);
  if (probe === "parent-missing") {
    return rotate("probe-parent-missing", "会话在但 parent 消息不在", false);
  }
  if (probe === "alive") {
    return {
      reuse: true,
      rotate: false,
      reason: "reuse",
      detail: "探针确认会话与 parent 都在",
      needsProbe: false,
      recoverable: true,
    };
  }
  if (probe === "unknown") {
    // 探针答不上来 = 不可证明可复用 = 轮换。宁可多花一次重建，也不要续错。
    return rotate("probe-unknown", "探针无结论（超时/异常/未知响应）", false);
  }

  // 还没探：复用是**有条件**的，调用方必须先探。
  return {
    reuse: true,
    rotate: false,
    reason: "reuse",
    detail: "本地判据通过，需先做零成本探针再复用",
    needsProbe: true,
    recoverable: true,
  };
}

/** 把探针的原始响应归到四类里。只有明确"还在"才算 alive。 */
export function classifyProbe(query: ProbeQuery): ProbeVerdict {
  const status = query.status;
  const body = (query.body ?? "").toLowerCase();

  if (status === 404 || status === 410) return "gone";
  if (/not[ _-]?found|deleted|does not exist|no such conversation/.test(body)) return "gone";

  if (status !== null && status >= 500) return "unknown";
  if (status === 0 || status === null) return "unknown";
  if (status === 401 || status === 403) return "unknown";
  if (status < 200 || status >= 300) return "unknown";

  const parentId = query.parentMessageId;
  if (parentId !== null && query.messageIds !== null) {
    if (!query.messageIds.includes(parentId)) return "parent-missing";
  }
  return "alive";
}

export interface ProbeQuery {
  /** HTTP 状态码；网络失败用 0 或 null。 */
  status: number | null;
  /** 响应正文（可能是 JSON 字符串）。 */
  body: string | null;
  /** 绑定里的 parent 消息 id。 */
  parentMessageId: string | null;
  /** 响应里能看到的全部消息 id；拿不到则 null（不据此判死）。 */
  messageIds: readonly string[] | null;
}

/** 探针本身该不该发：只有"本地全部通过但还没验过会话存在"时才值得花一次。 */
export function shouldProbe(decision: ReactivateDecision): boolean {
  return decision.reuse && decision.needsProbe;
}

/**
 * 供调用方拼探针请求用。GET + 空 body，零 token 成本（不产生对话轮次）。
 * 用会话详情接口而不是重新发问，避免把 DSH 的重试卷进来。
 */
export function probeRequest(conversationId: string): { method: string; path: string } {
  return {
    method: "GET",
    path: "/backend-api/conversation/" + encodeURIComponent(conversationId),
  };
}

/** 从会话详情 JSON 里抽出消息 id 列表；抽不到返回 null（表示"不知道"，不是"没有"）。 */
export function extractMessageIds(raw: unknown): string[] | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const mapping = (raw as Record<string, unknown>).mapping;
  if (typeof mapping === "object" && mapping !== null) {
    const ids = Object.values(mapping as Record<string, unknown>)
      .map((node) => {
        if (typeof node !== "object" || node === null) return null;
        const id = (node as Record<string, unknown>).id;
        return typeof id === "string" ? id : null;
      })
      .filter((id): id is string => id !== null);
    return ids.length > 0 ? ids : null;
  }
  const items = (raw as Record<string, unknown>).items;
  if (Array.isArray(items)) {
    const ids = items
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const id = (item as Record<string, unknown>).id;
        return typeof id === "string" ? id : null;
      })
      .filter((id): id is string => id !== null);
    return ids.length > 0 ? ids : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 绑定体检：把"坏数据"挡在状态机之外                                  */
/* ------------------------------------------------------------------ */

export type BindingFault =
  | "no-binding"
  | "corrupt"
  | "bad-conversation-id"
  | "bad-head-hash"
  | "bad-turns"
  | "bad-created-at"
  | "bad-last-entries";

export type BindingAudit =
  | { ok: true }
  | { ok: false; reason: "no-binding"; detail: string }
  | { ok: false; reason: "corrupt"; detail: string };

/**
 * 结构体检。落盘文件可能被手改、被旧版本写过、被截断 —— 全都算"不可复用"。
 * 返回的 reason 必须是 ReactivateVerdict 的子集（no-binding / corrupt）。
 */
export function auditBinding(raw: unknown): BindingAudit {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "no-binding", detail: "没有落盘绑定" };
  }
  if (typeof raw !== "object") {
    return { ok: false, reason: "corrupt", detail: "绑定不是对象" };
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.conversationId !== "string" || b.conversationId.trim() === "") {
    return { ok: false, reason: "corrupt", detail: "conversationId 缺失或为空" };
  }
  if (b.parentMessageId !== null && typeof b.parentMessageId !== "string") {
    return { ok: false, reason: "corrupt", detail: "parentMessageId 类型错误" };
  }
  if (typeof b.headHash !== "string" || b.headHash.length === 0) {
    return { ok: false, reason: "corrupt", detail: "headHash 缺失" };
  }
  if (typeof b.turns !== "number" || !Number.isInteger(b.turns) || b.turns < 0) {
    return { ok: false, reason: "corrupt", detail: "turns 非非负整数" };
  }
  if (typeof b.createdAt !== "number" || !Number.isFinite(b.createdAt)) {
    return { ok: false, reason: "corrupt", detail: "createdAt 非法" };
  }
  if (!Array.isArray(b.lastEntries) || b.lastEntries.some((e) => typeof e !== "string")) {
    return { ok: false, reason: "corrupt", detail: "lastEntries 不是字符串数组" };
  }
  return { ok: true };
}

function rotate(reason: ReactivateVerdict, detail: string, needsProbe: boolean): ReactivateDecision {
  return { reuse: false, rotate: true, reason, detail, needsProbe, recoverable: true };
}
