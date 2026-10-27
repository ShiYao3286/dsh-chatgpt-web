/**
 * 绑定编排：把纯判据（decideFeed）和闸门（Gate）接成可运行的运行时。
 *
 * 三条设计前提：
 *
 * 1. **单飞，绝不排队。** 上一条没处理完，beginTurn 必须**立即**返回 busy。
 *    这不是"默认并发 1、可以调大"的开关，而是不可协商的前提：排队会把 DSH 的
 *    重试策略叠上一层等待，表现成"看起来卡死"。所以占用标记在任何 await 之前
 *    同步置位，第二次调用根本进不到异步路径里。
 *
 * 2. **网页端会话是可撤销缓存，不是副本。** 只要不是严格追加（压缩、改写、固定头变化、
 *    到水位、疑似会话丢失），一律 rotate —— 我们无法改写网页端已收到的消息树。
 *
 * 3. **轮换要有种子。** 新会话不能从零开始，seed = 固定头 + 检查点 + 最近 K 轮。
 *    检查点由模型在软水位**之前**产出，落盘，轮换时直接取用。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { statePath } from "../paths.ts";
import { Gate, type GateRejectReason } from "../gate/gate.ts";
import { createLedger, kindFromGateReason, makeRecord, type FailureKind, type LedgerStore } from "../gate/ledger.ts";
import { decideFeed, headHashOf, type BindingState, type FeedAction, type FeedReason } from "./state.ts";
import {
  buildCheckpointRequest,
  buildRotateSeed,
  checkpointPath,
  fileCheckpointStore,
  parseCheckpoint,
  planCheckpoint,
  stripHandoffBlock,
  type Checkpoint,
  type CheckpointEnvelope,
  type CheckpointStore,
  type CheckpointPlan,
} from "./checkpoint.ts";
import {
  auditBinding,
  evaluateReactivate,
  type ProbeVerdict,
  type ReactivateVerdict,
} from "./reactivate.ts";

export const STATE_VERSION = 1;

/* ------------------------------------------------------------------ */
/* 配置                                                               */
/* ------------------------------------------------------------------ */

export interface BindingLimits {
  /** 到这个轮数就主动轮换。 */
  softTurns: number;
  /** 到这一轮数强制轮换（软水位没生效时的兜底）。 */
  hardTurns: number;
  /** 轮换种子带最近多少"轮"（1 轮 = 1 条 user + 1 条 assistant）。 */
  recentSeedTurns: number;
  /** 距软水位还有几轮时索要检查点。必须明显小于 softTurns。 */
  checkpointMargin: number;
  /** 闲置多久之后不再复用旧会话。 */
  maxIdleMs: number;
}

export const DEFAULT_LIMITS: BindingLimits = {
  softTurns: 25,
  hardTurns: 40,
  recentSeedTurns: 4,
  checkpointMargin: 4,
  // 网页端会话闲置太久，服务端状态未必还在；6 小时是保守值。
  maxIdleMs: 6 * 60 * 60 * 1000,
};

export interface BindingRuntimeConfig {
  /** 固定头文本（bootstrap）。 */
  bootstrap: string;
  /** 工具目录文本（也进固定头哈希）。 */
  toolCatalog: string;
  /** 协议版本，变了就轮换。 */
  protocolVersion: number;
  limits?: Partial<BindingLimits>;
  /** 时钟注入，便于测试。 */
  now?: () => number;
  /** 绑定落盘；默认 statePath()。 */
  store?: BindingStore;
  /** 检查点落盘；默认 checkpointPath()。 */
  checkpointStore?: CheckpointStore;
  /** 闸门；默认 DEFAULT_GATE 的新实例。 */
  gate?: Gate;
  /** 台账；默认 ledgerDir()/calls.ndjson。 */
  ledger?: LedgerStore;
  /** 用户消息 id 生成器；默认 randomUUID。 */
  newId?: () => string;
  /**
   * 默认的零成本探针。配了它，重启后复用前会自动验一次"会话是否还在"；
   * 不配则 beginTurn 返回 probe-required，由调用方自己探完再 applyProbe。
   */
  probe?: () => ProbeVerdict | Promise<ProbeVerdict>;
}

/* ------------------------------------------------------------------ */
/* 落盘形态                                                            */
/* ------------------------------------------------------------------ */

export interface PersistedState {
  version: number;
  savedAt: number;
  binding: BindingState | null;
  consecutiveFailures: number;
  lastUsedAt: number | null;
  lastCheckpointTurns: number | null;
}

export interface BindingStore {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
  clear(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 单次调用的计划                                                      */
/* ------------------------------------------------------------------ */

export interface TurnPlan {
  action: FeedAction;
  reason: FeedReason | ReactivateVerdict;
  /** append / re-anchor 复用当前会话；rotate 恒为 null。 */
  conversationId: string | null;
  parentMessageId: string | null;
  /** append 需要的增量条目。 */
  delta: string[];
  /** rotate 专用的种子；其它动作为 null。 */
  seed: string | null;
  /** re-anchor 用的短协议提醒；其它动作为 null。 */
  reAnchor: string | null;
  /** 本轮的交接请求（触发检查点时才有）。 */
  checkpointRequest: string | null;
  /** 本轮要发出去的用户文本（entries 的最后一条）。 */
  userText: string;
  /** 组装好的最终提示词。 */
  payload: string;
  /** 用户消息 id（每条都要新的，服务端按 id 去重）。 */
  userMessageId: string;
  /** 没有任何新增：不该发请求，调用方应短路。 */
  noop: boolean;
  checkpointDue: boolean;
  turnsBefore: number;
  /** 本次调用看到的完整条目，成功后写回 lastEntries。 */
  entries: string[];
}

export type BeginRejectReason = GateRejectReason | "probe-required";

export type BeginOutcome =
  | { ok: true; plan: TurnPlan }
  | { ok: false; reason: BeginRejectReason; waitMs: 0 };

export interface TurnResult {
  ok: boolean;
  /** 服务端返回的会话 id（rotate 时才有意义）。 */
  conversationId?: string | null;
  /** 助手消息 id，作为下一次的 parent。 */
  messageId?: string | null;
  kind?: FailureKind;
  status?: number | null;
  ttfbMs?: number | null;
  finishedAt?: number;
}

export interface FinishOutcome {
  accepted: boolean;
  reason: string;
  turns: number;
  action: FeedAction | null;
}

export interface ActivationResult {
  reuse: boolean;
  rotate: boolean;
  reason: ReactivateVerdict;
  detail: string;
  needsProbe: boolean;
}

export interface RuntimeSnapshot {
  activated: boolean;
  inFlight: boolean;
  action: FeedAction | null;
  turns: number;
  consecutiveFailures: number;
  conversationId: string | null;
  lastUsedAt: number | null;
  lastCheckpointTurns: number | null;
  headHash: string;
  lastVerdict: ReactivateVerdict | null;
  lastRotateReason: string | null;
}

export interface BeginOptions {
  /**
   * 零成本探针：只有在"本地判据全过、但还没验过会话是否还在"时才会被调用。
   * 不传则返回 probe-required，由调用方决定先探后重试。
   */
  probe?: () => ProbeVerdict | Promise<ProbeVerdict>;
}

/* ------------------------------------------------------------------ */
/* re-anchor 的协议提醒                                                */
/* ------------------------------------------------------------------ */

/**
 * 很短的协议提醒。要点只有三个：格式没变、工具调用照旧、别复述。
 * 长度控制在 ~50 token —— 它的全部意义就是比轮换便宜一个数量级。
 */
export const RE_ANCHOR_TEXT = [
  "<protocol_reminder>",
  "提醒：上下文没有变化，继续按最初的协议工作 —— 工具调用仍写在 dsh_tool 代码块里，",
  "一次一条；不要重复已给出的内容，也不要复述本提醒。",
  "</protocol_reminder>",
].join("\n");

/* ------------------------------------------------------------------ */
/* 运行时                                                             */
/* ------------------------------------------------------------------ */

export class BindingRuntime {
  private readonly config: BindingRuntimeConfig;
  private readonly limits: BindingLimits;
  private readonly now: () => number;
  private readonly gate: Gate;
  private readonly store: BindingStore;
  private readonly checkpointStore: CheckpointStore;
  private readonly ledger: LedgerStore;
  private readonly newId: () => string;
  private readonly headHash: string;

  /** 同步占用标记：单飞的真正实现点。 */
  private occupied = false;
  private currentPlan: TurnPlan | null = null;
  private currentStartedAt = 0;

  private binding: BindingState | null = null;
  private consecutiveFailures = 0;
  private lastUsedAt: number | null = null;
  private lastCheckpointTurns: number | null = null;
  private checkpoint: CheckpointEnvelope | null = null;

  private activation: ActivationResult | null = null;
  private activating: Promise<ActivationResult> | null = null;
  private lastRotateReason: string | null = null;
  private pendingWrites: Promise<void>[] = [];

  constructor(config: BindingRuntimeConfig) {
    this.config = config;
    this.limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}) };
    this.now = config.now ?? (() => Date.now());
    this.gate = config.gate ?? new Gate(undefined, this.now);
    this.store = config.store ?? fileBindingStore(statePath());
    this.checkpointStore = config.checkpointStore ?? fileCheckpointStore(checkpointPath());
    this.ledger = config.ledger ?? createLedger();
    this.newId = config.newId ?? (() => randomUUID());
    this.headHash = headHashOf(config.bootstrap, config.toolCatalog, config.protocolVersion);
  }

  get limitsSnapshot(): BindingLimits {
    return { ...this.limits };
  }

  get headHashValue(): string {
    return this.headHash;
  }

  get bindingValue(): BindingState | null {
    return this.binding;
  }

  get checkpointValue(): CheckpointEnvelope | null {
    return this.checkpoint;
  }

  snapshot(): RuntimeSnapshot {
    return {
      activated: this.activation !== null,
      inFlight: this.occupied,
      action: this.currentPlan === null ? null : this.currentPlan.action,
      turns: this.turnCount(),
      consecutiveFailures: this.consecutiveFailures,
      conversationId: this.binding === null ? null : this.binding.conversationId,
      lastUsedAt: this.lastUsedAt,
      lastCheckpointTurns: this.lastCheckpointTurns,
      headHash: this.headHash,
      lastVerdict: this.activation === null ? null : this.activation.reason,
      lastRotateReason: this.lastRotateReason,
    };
  }

  /** 等所有异步落盘完成。测试与退出前调用。 */
  async flush(): Promise<void> {
    const pending = this.pendingWrites;
    this.pendingWrites = [];
    await Promise.all(pending.map((p) => p.catch(() => undefined)));
  }

  /* ---------------------------------------------------------------- */
  /* 启动：复用前先校验                                                */
  /* ---------------------------------------------------------------- */

  /** 幂等。并发调用共享同一个 Promise，不会重复读盘。 */
  activate(): Promise<ActivationResult> {
    if (this.activation !== null) return Promise.resolve(this.activation);
    if (this.activating !== null) return this.activating;
    const p = this.doActivate();
    this.activating = p;
    return p;
  }

  private async doActivate(): Promise<ActivationResult> {
    // 读盘失败（权限、坏盘、并发写坏）绝不能把运行时焊死：按"没有绑定"处理，
    // 也就是 rotate。宁可重建一次会话，也不要每次启动都抛同一个 rejected promise。
    let persisted: PersistedState | null = null;
    try {
      persisted = await this.store.load();
    } catch {
      persisted = null;
    }
    let checkpoint: CheckpointEnvelope | null = null;
    try {
      checkpoint = await this.checkpointStore.load();
    } catch {
      checkpoint = null;
    }
    this.checkpoint = checkpoint;
    this.lastCheckpointTurns = persisted === null ? null : persisted.lastCheckpointTurns;
    this.consecutiveFailures = persisted === null ? 0 : Math.max(0, persisted.consecutiveFailures);
    this.lastUsedAt = persisted === null ? null : persisted.lastUsedAt;

    const decision = evaluateReactivate({
      binding: persisted === null ? null : persisted.binding,
      headHash: this.headHash,
      softTurns: this.limits.softTurns,
      hardTurns: this.limits.hardTurns,
      maxIdleMs: this.limits.maxIdleMs,
      lastUsedAt: persisted === null ? null : persisted.lastUsedAt,
      now: this.now(),
      probe: null,
    });

    if (decision.rotate) {
      // 任何不匹配一律 rotate —— 不硬续。
      this.binding = null;
      this.lastRotateReason = decision.reason;
      this.activation = {
        reuse: false,
        rotate: true,
        reason: decision.reason,
        detail: decision.detail,
        needsProbe: false,
      };
      await this.persist();
      return this.activation;
    }

    this.binding = persisted === null ? null : persisted.binding;
    this.activation = {
      reuse: true,
      rotate: false,
      reason: "reuse",
      detail: decision.detail,
      needsProbe: decision.needsProbe,
    };
    return this.activation;
  }

  /**
   * 探针结果回填。只有 alive 才能保住复用；其它一律轮换。
   * 在 acquire 之后、真正发请求之前调用（beginTurn 的 probe 选项会替你做）。
   */
  async applyProbe(verdict: ProbeVerdict): Promise<ActivationResult> {
    const current = this.activation ?? (await this.activate());
    if (verdict === "alive") {
      this.activation = { ...current, reuse: true, rotate: false, reason: "reuse", needsProbe: false };
      return this.activation;
    }
    const reason: ReactivateVerdict =
      verdict === "gone"
        ? "probe-gone"
        : verdict === "parent-missing"
          ? "probe-parent-missing"
          : "probe-unknown";
    this.binding = null;
    this.lastRotateReason = reason;
    this.activation = {
      reuse: false,
      rotate: true,
      reason,
      detail: "探针判定不可复用：" + verdict,
      needsProbe: false,
    };
    await this.persist();
    return this.activation;
  }

  /* ---------------------------------------------------------------- */
  /* 一轮的开始                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 申请开始一轮。
   *
   * 关键：占用标记在**任何 await 之前**同步置位。上一条还在飞时，这里不会排队，
   * 也不会等 —— 直接返回 busy。
   */
  beginTurn(entries: readonly string[], options: BeginOptions = {}): Promise<BeginOutcome> {
    if (this.occupied) {
      // 同步分支：连一次 await 都不经过，保证"立即"。
      this.noteRejection("busy", 0);
      return Promise.resolve({ ok: false, reason: "busy", waitMs: 0 });
    }
    this.occupied = true;
    const startedAt = this.now();
    this.currentStartedAt = startedAt;
    return this.doBegin(entries, startedAt, options);
  }

  private async doBegin(
    entries: readonly string[],
    startedAt: number,
    options: BeginOptions,
  ): Promise<BeginOutcome> {
    try {
      await this.activate();

      if (this.activation !== null && this.activation.needsProbe) {
        const probe = options.probe ?? this.config.probe;
        if (probe === undefined) {
          // 还没验过会话是否还在：不许硬续，让调用方先探。
          this.releaseOccupancy();
          return { ok: false, reason: "probe-required", waitMs: 0 };
        }
        let verdict: ProbeVerdict;
        try {
          verdict = await probe();
        } catch {
          verdict = "unknown";
        }
        await this.applyProbe(verdict);
      }

      const decision = decideFeed({
        entries,
        headHash: this.headHash,
        binding: this.binding,
        consecutiveFailures: this.consecutiveFailures,
        softTurns: this.limits.softTurns,
        hardTurns: this.limits.hardTurns,
      });

      // 没有任何新增：不该花一次请求，也不该占用闸门额度。
      if (decision.action === "append" && decision.delta.length === 0) {
        this.releaseOccupancy();
        return {
          ok: true,
          plan: this.buildPlan(entries, "append", decision.reason, [], true),
        };
      }

      const acquired = this.gate.acquire();
      if (!acquired.ok) {
        // GateDecision 的 reason 是 "ok" | 拒绝理由 的联合，这里按 ok=false 收窄。
        const reason: GateRejectReason = acquired.reason === "ok" ? "busy" : acquired.reason;
        this.releaseOccupancy();
        this.noteRejection(reason, acquired.waitMs, startedAt);
        return { ok: false, reason, waitMs: 0 };
      }

      // 启动阶段就因为"陈旧绑定"轮换过的话，decideFeed 只会看到 binding===null 并报
      // first-call。这里把真实原因接回去，诊断日志才不会骗人。
      const priorRotateReason = this.lastRotateReason;
      const reason =
        decision.action === "rotate" &&
        decision.reason === "first-call" &&
        priorRotateReason !== null
          ? (priorRotateReason as FeedReason | ReactivateVerdict)
          : decision.reason;
      if (decision.action === "rotate") {
        this.lastRotateReason = decision.reason;
      }
      const plan = this.buildPlan(entries, decision.action, reason, decision.delta, false);
      this.currentPlan = plan;
      return { ok: true, plan };
    } catch (err) {
      this.currentPlan = null;
      this.releaseOccupancy();
      throw err;
    }
  }

  private buildPlan(
    entries: readonly string[],
    action: FeedAction,
    reason: FeedReason | ReactivateVerdict,
    delta: string[],
    noop: boolean,
  ): TurnPlan {
    const turnsBefore = this.turnCount();
    const cpPlan = planCheckpoint({
      turns: turnsBefore,
      softTurns: this.limits.softTurns,
      lastCheckpointTurns: this.lastCheckpointTurns,
      margin: this.limits.checkpointMargin,
    });
    const checkpointDue = !noop && cpPlan.due;
    const checkpointRequest = checkpointDue ? buildCheckpointRequest() : null;
    const reAnchor = action === "re-anchor" ? RE_ANCHOR_TEXT : null;
    const userText = entries.length === 0 ? "" : entries[entries.length - 1];
    const reuse = action !== "rotate" && this.binding !== null;

    // 轮换种子只带"已经发生过的历史"，当前这条用户文本作为新会话的第一条消息。
    // 否则同一条请求会先在种子里出现一次、再作为新消息发一次。
    const history = entries.length === 0 ? [] : entries.slice(0, entries.length - 1);
    const seed =
      action === "rotate"
        ? buildRotateSeed({
            bootstrap: this.config.bootstrap,
            checkpoint: this.checkpoint === null ? null : this.checkpoint.checkpoint,
            entries: history,
            recentTurns: this.limits.recentSeedTurns,
          })
        : null;

    return {
      action,
      reason,
      conversationId: reuse ? (this.binding as BindingState).conversationId : null,
      parentMessageId: reuse ? (this.binding as BindingState).parentMessageId : null,
      delta: [...delta],
      seed: seed === null ? null : seed.text,
      reAnchor,
      checkpointRequest,
      userText,
      payload:
        seed === null
          ? composeUserPayload(reAnchor, checkpointRequest, userText)
          : composeUserPayload(seed.text, checkpointRequest, userText),
      userMessageId: this.newId(),
      noop,
      checkpointDue,
      turnsBefore,
      entries: [...entries],
    };
  }

  /* ---------------------------------------------------------------- */
  /* 一轮的结束                                                        */
  /* ---------------------------------------------------------------- */

  async finishTurn(result: TurnResult): Promise<FinishOutcome> {
    const plan = this.currentPlan;
    if (plan === null || !this.occupied) {
      return { accepted: false, reason: "no-in-flight", turns: this.turnCount(), action: null };
    }
    if (plan.noop) {
      this.currentPlan = null;
      this.releaseOccupancy();
      return { accepted: false, reason: "noop", turns: this.turnCount(), action: plan.action };
    }

    const finishedAt = result.finishedAt ?? this.now();
    const kind: FailureKind = result.ok ? "none" : (result.kind ?? "unknown");
    const now = this.now();

    if (result.ok) {
      const conversationId =
        result.conversationId ?? (plan.conversationId === null ? null : plan.conversationId);
      if (
        conversationId === null ||
        conversationId === undefined ||
        result.messageId === null ||
        result.messageId === undefined
      ) {
        // 服务端没给出可续锚点：这条链没法再续，直接作废。
        this.dropBinding("missing-anchor");
        this.recordCall(plan, "unknown", result, finishedAt, true);
        this.currentPlan = null;
        this.releaseOccupancy();
        this.gate.releaseFailed();
        await this.persist();
        return { accepted: false, reason: "missing-anchor", turns: this.turnCount(), action: plan.action };
      }

      const rotated = plan.action === "rotate" || this.binding === null;
      this.binding = {
        conversationId,
        parentMessageId: result.messageId,
        headHash: this.headHash,
        lastEntries: [...plan.entries],
        turns: (rotated ? 0 : (this.binding as BindingState).turns) + 1,
        createdAt: rotated ? now : (this.binding as BindingState).createdAt,
      };
      this.consecutiveFailures = 0;
      this.lastUsedAt = now;
    } else {
      this.consecutiveFailures += 1;
      if (shouldDropBinding(kind, result.status ?? null)) {
        this.dropBinding("failure-" + kind);
      }
    }

    this.recordCall(plan, kind, result, finishedAt, false);
    this.currentPlan = null;
    this.releaseOccupancy();
    if (result.ok) this.gate.release();
    else this.gate.releaseFailed();
    await this.persist();
    await this.flush();

    return {
      accepted: result.ok,
      reason: result.ok ? "ok" : kind,
      turns: this.turnCount(),
      action: plan.action,
    };
  }

  /** 调用方主动放弃（进程退出等）。不计数，只放锁。 */
  abortTurn(): void {
    if (!this.occupied) return;
    this.currentPlan = null;
    this.releaseOccupancy();
    this.gate.releaseFailed();
  }

  /* ---------------------------------------------------------------- */
  /* 检查点                                                            */
  /* ---------------------------------------------------------------- */

  /** 这一轮要不要顺带索要交接。 */
  checkpointPlan(): CheckpointPlan {
    return planCheckpoint({
      turns: this.turnCount(),
      softTurns: this.limits.softTurns,
      lastCheckpointTurns: this.lastCheckpointTurns,
      margin: this.limits.checkpointMargin,
    });
  }

  /**
   * 从回复里取检查点：解析 → 落盘 → 返回**剥掉交接块的正文**。
   * 交接块是协议细节，不该出现在用户看到的回复里。
   */
  async recordReply(text: string): Promise<{ checkpoint: Checkpoint | null; text: string }> {
    const cleaned = stripHandoffBlock(text);
    const parsed = parseCheckpoint(text);
    if (parsed === null) return { checkpoint: null, text: cleaned };

    this.checkpoint = {
      version: 1,
      savedAt: this.now(),
      turns: this.turnCount(),
      checkpoint: parsed,
    };
    this.lastCheckpointTurns = this.turnCount();
    await this.checkpointStore.save(this.checkpoint);
    await this.persist();
    return { checkpoint: parsed, text: cleaned };
  }

  /* ---------------------------------------------------------------- */
  /* 手工轮换                                                          */
  /* ---------------------------------------------------------------- */

  /** 外部触发轮换（例如用户改了设置）。下一个 beginTurn 会走 rotate。 */
  async rotate(reason: string = "manual"): Promise<void> {
    this.dropBinding(reason);
    await this.persist();
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                              */
  /* ---------------------------------------------------------------- */

  private turnCount(): number {
    return this.binding === null ? 0 : this.binding.turns;
  }

  private releaseOccupancy(): void {
    this.occupied = false;
  }

  private dropBinding(reason: string): void {
    this.binding = null;
    this.lastRotateReason = reason;
  }

  private recordCall(
    plan: TurnPlan,
    kind: FailureKind,
    result: TurnResult,
    finishedAt: number,
    throttled: boolean,
  ): void {
    this.emit(
      makeRecord({
        startedAt: this.currentStartedAt,
        finishedAt,
        status: result.status ?? null,
        kind,
        throttled,
        attempt: 0,
        action: plan.action,
        ttfbMs: result.ttfbMs ?? null,
      }),
    );
  }

  private noteRejection(reason: BeginRejectReason, waitMs: number, startedAt?: number): void {
    if (reason === "probe-required") return;
    const at = startedAt ?? this.now();
    this.emit(
      makeRecord({
        startedAt: at,
        finishedAt: at + Math.max(0, waitMs),
        status: null,
        kind: kindFromGateReason(reason),
        throttled: true,
        attempt: 0,
        action: null,
        ttfbMs: null,
      }),
    );
  }

  private emit(record: ReturnType<typeof makeRecord>): void {
    this.pendingWrites.push(this.ledger.append(record).catch(() => undefined));
  }

  /**
   * 落盘失败只影响"下次启动能不能复用"，不影响这一轮的结果。
   * 把异常吞掉并降级为 rotate，比让一次成功的请求因为磁盘问题失败要好。
   */
  private async persist(): Promise<void> {
    try {
      await this.store.save({
        version: STATE_VERSION,
        savedAt: this.now(),
        binding: this.binding,
        consecutiveFailures: this.consecutiveFailures,
        lastUsedAt: this.lastUsedAt,
        lastCheckpointTurns: this.lastCheckpointTurns,
      });
    } catch {
      // 状态没落住：下次启动会因为 lastUsedAt/绑定缺失而 rotate，安全侧。
      this.lastRotateReason = "persist-failed";
    }
  }
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                           */
/* ------------------------------------------------------------------ */

/** 组装非轮换请求的正文：提醒 / 交接请求在前，真正的用户文本垫底。 */
export function composeUserPayload(
  reAnchor: string | null,
  checkpointRequest: string | null,
  userText: string,
): string {
  const blocks: string[] = [];
  if (reAnchor !== null && reAnchor.trim() !== "") blocks.push(reAnchor);
  if (checkpointRequest !== null && checkpointRequest.trim() !== "") blocks.push(checkpointRequest);
  if (userText.trim() !== "") blocks.push(userText);
  return blocks.join("\n\n");
}

/**
 * 哪些失败意味着"这条会话的锚点已经不可信"。
 *
 * 只认三种：中途被中断、传输层断了（服务端可能已经收下那条消息）、
 * 以及明确的 404/410。其它失败（限流、工具协议、空回复）保留会话，
 * 由 decideFeed 的连续失败计数决定要不要 re-anchor。
 */
export function shouldDropBinding(kind: FailureKind, status: number | null): boolean {
  if (kind === "aborted" || kind === "transport") return true;
  if (kind === "http" && (status === 404 || status === 410)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 绑定落盘                                                           */
/* ------------------------------------------------------------------ */

export function fileBindingStore(file: string): BindingStore {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
      return normalizePersisted(parsed);
    },
    async save(state) {
      await writeJsonAtomic(file, state);
    },
    async clear() {
      await writeJsonAtomic(file, null);
    },
  };
}

export function memoryBindingStore(initial: PersistedState | null = null): BindingStore {
  let value: PersistedState | null = initial;
  return {
    async load() {
      return value;
    },
    async save(state) {
      value = state;
    },
    async clear() {
      value = null;
    },
  };
}

function normalizePersisted(raw: unknown): PersistedState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== STATE_VERSION) return null;
  const binding = obj.binding ?? null;
  if (binding !== null && typeof binding !== "object") return null;
  // 结构体检交给 evaluateReactivate；这里只保证信封本身可用。
  const audit = binding === null ? { ok: true } : auditBinding(binding);
  return {
    version: STATE_VERSION,
    savedAt: typeof obj.savedAt === "number" ? obj.savedAt : 0,
    binding: audit.ok ? (binding as BindingState | null) : null,
    consecutiveFailures:
      typeof obj.consecutiveFailures === "number" && Number.isFinite(obj.consecutiveFailures)
        ? Math.max(0, Math.floor(obj.consecutiveFailures))
        : 0,
    lastUsedAt:
      typeof obj.lastUsedAt === "number" && Number.isFinite(obj.lastUsedAt) ? obj.lastUsedAt : null,
    lastCheckpointTurns:
      typeof obj.lastCheckpointTurns === "number" && Number.isFinite(obj.lastCheckpointTurns)
        ? obj.lastCheckpointTurns
        : null,
  };
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
