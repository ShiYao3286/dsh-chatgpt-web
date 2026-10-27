/**
 * 会话绑定层 —— 本项目与 dsh-deepseek-web-login 最大的结构差异。
 *
 * 核心约束（用户明确要求）：**上一条没处理完，不能发下一条**。
 * 所以这不是"可配置的节流参数"，而是设计前提：整个 provider 是单飞的（single-flight）。
 *
 * 另一个核心概念：网页端会话是 DSH 会话的**可撤销投影（cache）**，不是副本。
 * 任何"非严格追加"的变化都必须放弃当前 web 会话、用检查点重开 —— 因为网页端
 * 维护着自己的消息树，我们无法改写它已收到的东西。
 *
 * 状态机三动作：
 *   APPEND    只发增量，接着用当前 web 会话
 *   RE-ANCHOR 不换会话，补一条很短的协议提醒（成本 ~200 token，远低于轮换）
 *   ROTATE    开新 web 会话，seed = bootstrap + checkpoint + 最近 K 轮
 */

/** 一次绑定的持久状态。 */
export interface BindingState {
  conversationId: string;
  /** 当前链上最后一条 assistant 消息 id，作为下一次的 parent。 */
  parentMessageId: string | null;
  /** 固定头（bootstrap + 工具目录）的哈希；变了就必须轮换。 */
  headHash: string;
  /** 上一次成功发送后的对话条目快照，用于判断"是否严格追加"。 */
  lastEntries: string[];
  /** 这个 web 会话已经吃进多少轮。 */
  turns: number;
  /** web 会话的创建时刻（ms）。 */
  createdAt: number;
}

export type FeedAction = "append" | "re-anchor" | "rotate";

export interface FeedInput {
  /** 本次请求的完整对话条目（由 DSH 提供，deep-frozen）。 */
  entries: readonly string[];
  /** 本次固定头的哈希。 */
  headHash: string;
  /** 现有绑定；首次为 null。 */
  binding: BindingState | null;
  /** 最近的失败计数（连续工具协议解析失败等）。 */
  consecutiveFailures: number;
  /** 水位线。 */
  softTurns: number;
  hardTurns: number;
}

export type FeedReason =
  | "first-call"
  | "head-changed"
  | "not-strict-append"
  | "turns-exceeded"
  | "failures"
  | "no-binding"
  | "ok";

export interface FeedDecision {
  action: FeedAction;
  reason: FeedReason;
  /** append 时：需要发送的增量条目。 */
  delta: string[];
}

/**
 * 决定性判据。纯函数，无副作用 —— 这样测试可以直接钉住每一种情形。
 *
 * 顺序很重要：先判"必须轮换"的硬条件，再判"可以省一次轮换"的软条件。
 */
export function decideFeed(input: FeedInput): FeedDecision {
  const { entries, headHash, binding } = input;

  if (binding === null) {
    return { action: "rotate", reason: "first-call", delta: [...entries] };
  }
  if (binding.headHash !== headHash) {
    return { action: "rotate", reason: "head-changed", delta: [...entries] };
  }

  const prefix = isStrictAppend(binding.lastEntries, entries);
  if (!prefix.ok) {
    return { action: "rotate", reason: "not-strict-append", delta: [...entries] };
  }

  if (binding.turns >= input.hardTurns) {
    return { action: "rotate", reason: "turns-exceeded", delta: [...entries] };
  }
  if (input.consecutiveFailures >= 2) {
    return { action: "re-anchor", reason: "failures", delta: [...entries] };
  }
  if (binding.turns >= input.softTurns) {
    return { action: "rotate", reason: "turns-exceeded", delta: [...entries] };
  }
  if (prefix.at === entries.length) {
    // 没有任何新增：不需要发请求（调用方应短路）
    return { action: "append", reason: "ok", delta: [] };
  }
  return { action: "append", reason: "ok", delta: entries.slice(prefix.at) };
}

export interface AppendCheck {
  ok: boolean;
  /** 严格追加时，新条目的起始下标；不严格时为 -1。 */
  at: number;
}

/**
 * 判断 next 是否是在 prev 之后**严格追加**。
 *
 * 只做前缀比对会漏掉"压缩"这种形态：压缩后历史长度可能不变甚至变短，
 * 但中间内容变了。所以必须逐条比对全部 prev 项。
 */
export function isStrictAppend(prev: readonly string[], next: readonly string[]): AppendCheck {
  if (prev.length > next.length) return { ok: false, at: -1 };
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return { ok: false, at: -1 };
  }
  return { ok: true, at: prev.length };
}

/** 固定头哈希：bootstrap 文本 + 工具目录 + 协议版本。 */
export function headHashOf(bootstrap: string, toolCatalog: string, protocolVersion: number): string {
  const payload = protocolVersion + "\u0000" + bootstrap + "\u0000" + toolCatalog;
  return fnv1a64(payload);
}

/** 用 FNV-1a 64 位做内容指纹；不追求密码学强度，只要求稳定且分布均匀。 */
export function fnv1a64(str: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mod = 1n << 64n;
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) % mod;
  }
  return h.toString(16).padStart(16, "0");
}
