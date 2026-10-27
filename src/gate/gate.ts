/**
 * 闸门：单飞 + 间隔 + 轮次上限。
 *
 * 用户约束：**上一条没处理完，不能发下一条**。
 * 所以这里的核心是一个互斥队列，而不是"并发开关默认关"。
 *
 * 另外两道闸来自 dsh-deepseek-web-login 的真实事故（22:31→22:53 共 49 次请求、
 * 间隔 8~12 秒，账号被吊销）：只保证"两次不挨太近"不够，还要管"连着几十分钟不停发"。
 */

export interface GateConfig {
  /** 两次请求之间的最小间隔（毫秒），从**上次结束**算起。 */
  minIntervalMs: number;
  /** 上限；与下限不等时在这个区间内随机取值。 */
  maxIntervalMs: number;
  /** 连续 N 次后强制长休。 */
  longRunThreshold: number;
  /** 长休时长区间（毫秒）。 */
  longRestMinMs: number;
  longRestMaxMs: number;
  /** 滚动窗口：这么多毫秒内最多几次。 */
  rateWindowMs: number;
  rateMaxInWindow: number;
}

export const DEFAULT_GATE: GateConfig = {
  minIntervalMs: 4000,
  maxIntervalMs: 9000,
  longRunThreshold: 12,
  longRestMinMs: 60_000,
  longRestMaxMs: 180_000,
  rateWindowMs: 30 * 60_000,
  rateMaxInWindow: 12,
};

export interface GateSnapshot {
  inFlight: boolean;
  consecutive: number;
  recent: number[];
  lastFinishedAt: number | null;
}

export class Gate {
  private config: GateConfig;
  private inFlight = false;
  private consecutive = 0;
  private lastFinishedAt: number | null = null;
  private recent: number[] = [];
  private readonly now: () => number;

  constructor(config: GateConfig = DEFAULT_GATE, now: () => number = () => Date.now()) {
    this.config = { ...config };
    this.now = now;
  }

  configure(next: Partial<GateConfig>): void {
    this.config = { ...this.config, ...next };
  }

  snapshot(): GateSnapshot {
    return {
      inFlight: this.inFlight,
      consecutive: this.consecutive,
      recent: [...this.recent],
      lastFinishedAt: this.lastFinishedAt,
    };
  }

  /**
   * 申请发一次请求。若已有请求在飞，**立即拒绝**（而不是排队等待）——
   * 排队会让 DSH 的重试策略叠加上等待，变成"看起来卡住"。
   */
  acquire(): GateDecision {
    if (this.inFlight) {
      return { ok: false, reason: "busy", waitMs: 0 };
    }
    const now = this.now();
    this.prune(now);

    const rateLeft = this.config.rateMaxInWindow - this.recent.length;
    if (rateLeft <= 0) {
      const oldest = this.recent[0];
      // +1：恰好落在窗口边界时事件仍被计入，若给出 waitMs=0 调用方会忙等。
      const waitMs = Math.max(1, oldest + this.config.rateWindowMs - now + 1);
      return { ok: false, reason: "rate-window", waitMs };
    }

    if (this.consecutive >= this.config.longRunThreshold) {
      const rest = randomInt(this.config.longRestMinMs, this.config.longRestMaxMs);
      this.consecutive = 0;
      return { ok: false, reason: "long-rest", waitMs: rest };
    }

    // 首次调用（从未有过结束时刻）不受间隔限制。
    if (this.lastFinishedAt !== null) {
      const since = now - this.lastFinishedAt;
      const need = randomInt(this.config.minIntervalMs, this.config.maxIntervalMs);
      if (since < need) {
        return { ok: false, reason: "interval", waitMs: need - since };
      }
    }

    this.inFlight = true;
    return { ok: true, reason: "ok", waitMs: 0 };
  }

  /** 请求结束（成功或失败都要调，否则永远 busy）。 */
  release(): void {
    this.inFlight = false;
    this.consecutive += 1;
    this.lastFinishedAt = this.now();
    this.recent.push(this.lastFinishedAt);
    this.prune(this.lastFinishedAt);
  }

  /** 明确失败：不计入连续成功，但仍要释放单飞锁。 */
  releaseFailed(): void {
    this.inFlight = false;
    this.lastFinishedAt = this.now();
    this.prune(this.lastFinishedAt);
  }

  private prune(now: number): void {
    // 窗口是 [now - rateWindowMs, now]。恰好等于 windowMs 老的事件算窗口外
    // （用 <= 而不是 <），否则会一直卡在边界上。
    const cutoff = now - this.config.rateWindowMs;
    while (this.recent.length > 0 && this.recent[0] <= cutoff) this.recent.shift();
  }
}

export type GateRejectReason = "busy" | "rate-window" | "long-rest" | "interval";

export interface GateDecision {
  ok: boolean;
  reason: GateRejectReason | "ok";
  waitMs: number;
}

function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
