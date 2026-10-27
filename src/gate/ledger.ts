/**
 * 调用台账：只记**元信息**，用来回答"我们现在发得多密、错在哪一类"。
 *
 * 三条硬约束：
 *   1. 不记对话内容 —— 只有时间戳、时长、结果码、计数。
 *   2. 不记凭证 —— 没有 token / cookie / header 字段，且写入前统一过一遍脱敏。
 *   3. 只留近 7 天 —— 更老的在 prune 时丢掉，文件不会无限长。
 *
 * 为什么要有它：dsh-deepseek-web-login 那次 22:31→22:53 共 49 次请求、间隔 8~12 秒，
 * 账号随即被吊销。事后只有"多久一次"这种统计能看出问题，事后翻请求体是没用的。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ledgerDir } from "../paths.ts";
import { redactSecrets } from "../binding/checkpoint.ts";

export const LEDGER_VERSION = 1;
export const DEFAULT_RETENTION_DAYS = 7;
export const LEDGER_FILE = "calls.ndjson";

/** 失败分类。只到"哪一类"，不记错误正文。 */
export type FailureKind =
  | "none"
  | "busy"
  | "throttle-interval"
  | "throttle-window"
  | "throttle-long-rest"
  | "auth"
  | "sentinel"
  | "pow"
  | "transport"
  | "http"
  | "empty-reply"
  | "tool-protocol"
  | "aborted"
  | "unknown";

export const FAILURE_KINDS: readonly FailureKind[] = [
  "none",
  "busy",
  "throttle-interval",
  "throttle-window",
  "throttle-long-rest",
  "auth",
  "sentinel",
  "pow",
  "transport",
  "http",
  "empty-reply",
  "tool-protocol",
  "aborted",
  "unknown",
];

/** 一条台账记录。字段只增不改，便于跨版本读旧文件。 */
export interface LedgerRecord {
  /** 开始时刻（ms）。 */
  t: number;
  /** 总耗时（ms）。 */
  durMs: number;
  /** HTTP 状态码；没有网络往返时为 null。 */
  status: number | null;
  /** 失败分类；成功为 "none"。 */
  kind: FailureKind;
  /** 本次是不是被闸门拒绝的（没有真正发出请求）。 */
  throttled: boolean;
  /** 重试序号（0 = 首次）。 */
  attempt: number;
  /** 本次动作：append / re-anchor / rotate，未知为 null。 */
  action: "append" | "re-anchor" | "rotate" | null;
  /** 首字节耗时（ms），未知为 null。 */
  ttfbMs: number | null;
}

export interface LedgerIntervalStats {
  count: number;
  minMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

export interface LedgerKindBucket {
  kind: FailureKind;
  count: number;
  /** 占全部失败的比例（0..1）。 */
  share: number;
}

export interface LedgerSummary {
  /** 保留窗口内的记录数。 */
  total: number;
  /** 其中真正发出请求的条数。 */
  sent: number;
  /** 被闸门挡下的条数。 */
  throttled: number;
  failures: number;
  windowStart: number;
  windowEnd: number;
  retentionDays: number;
  /** 相邻**已发送**请求的间隔统计（只看真正占用了额度的那些）。 */
  intervals: LedgerIntervalStats;
  /** 失败分类排序（count 降序，同 count 按 kind 名升序保证稳定）。 */
  byKind: LedgerKindBucket[];
  /** 失败率（0..1）。 */
  failureRate: number;
}

/* ------------------------------------------------------------------ */
/* 记录构造                                                           */
/* ------------------------------------------------------------------ */

export interface CallRecordInput {
  startedAt: number;
  finishedAt: number;
  status?: number | null;
  kind?: FailureKind;
  throttled?: boolean;
  attempt?: number;
  action?: "append" | "re-anchor" | "rotate" | null;
  ttfbMs?: number | null;
}

export function makeRecord(input: CallRecordInput): LedgerRecord {
  const kind = input.kind ?? "none";
  if (!FAILURE_KINDS.includes(kind)) {
    throw new Error("unknown failure kind: " + String(kind));
  }
  const startedAt = Math.floor(input.startedAt);
  const finishedAt = Math.floor(input.finishedAt);
  const durMs = Math.max(0, finishedAt - startedAt);
  const status = input.status ?? null;
  return {
    t: startedAt,
    durMs,
    status: status === null ? null : Math.floor(status),
    kind,
    throttled: input.throttled === true || kind === "busy",
    attempt: Math.max(0, Math.floor(input.attempt ?? 0)),
    action: input.action ?? null,
    ttfbMs: input.ttfbMs === null || input.ttfbMs === undefined ? null : Math.max(0, Math.floor(input.ttfbMs)),
  };
}

/** 把闸门的拒绝理由映射成失败分类 —— 台账里必须能区分"限流"和"真错"。 */
export function kindFromGateReason(reason: string): FailureKind {
  if (reason === "busy") return "busy";
  if (reason === "interval") return "throttle-interval";
  if (reason === "rate-window") return "throttle-window";
  if (reason === "long-rest") return "throttle-long-rest";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* 失效与统计                                                          */
/* ------------------------------------------------------------------ */

export function retentionCutoff(now: number, days: number = DEFAULT_RETENTION_DAYS): number {
  return now - Math.max(0, days) * 24 * 60 * 60 * 1000;
}

/** 只保留近 N 天；时间戳非法的记录直接丢掉。保持原有顺序。 */
export function pruneRecords(
  records: readonly LedgerRecord[],
  now: number,
  days: number = DEFAULT_RETENTION_DAYS,
): LedgerRecord[] {
  const cutoff = retentionCutoff(now, days);
  return records.filter((r) => Number.isFinite(r.t) && r.t > cutoff && r.t <= now + 60_000);
}

export function intervalsOf(records: readonly LedgerRecord[]): number[] {
  const sent = records.filter((r) => !r.throttled && Number.isFinite(r.t)).map((r) => r.t);
  sent.sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < sent.length; i++) {
    const gap = sent[i] - sent[i - 1];
    if (gap >= 0) out.push(gap);
  }
  return out;
}

/**
 * 中位数用"两数均值"定义（偶数个取中间两个的平均），p90 用 nearest-rank。
 * 两者都写成显式定义，避免不同库给出不同答案。
 */
export function intervalStats(values: readonly number[]): LedgerIntervalStats {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).slice().sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, minMs: null, medianMs: null, p90Ms: null, maxMs: null, meanMs: null };
  }
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const meanMs = Math.round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { count: sorted.length, minMs, medianMs, p90Ms: percentile(sorted, 0.9), maxMs, meanMs };
}

/** nearest-rank：rank = ceil(p * n)，1-based。 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const rank = Math.max(1, Math.ceil(clamped * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function summarize(
  records: readonly LedgerRecord[],
  now: number,
  days: number = DEFAULT_RETENTION_DAYS,
): LedgerSummary {
  const kept = pruneRecords(records, now, days);
  const sent = kept.filter((r) => !r.throttled).length;
  const throttled = kept.length - sent;
  const failureCounts = new Map<FailureKind, number>();
  let failures = 0;
  for (const r of kept) {
    if (r.kind === "none") continue;
    failures += 1;
    failureCounts.set(r.kind, (failureCounts.get(r.kind) ?? 0) + 1);
  }
  const byKind: LedgerKindBucket[] = [...failureCounts.entries()]
    .map(([kind, count]) => ({ kind, count, share: failures === 0 ? 0 : count / failures }))
    .sort((a, b) => (b.count - a.count) || a.kind.localeCompare(b.kind));

  const times = kept.map((r) => r.t);
  return {
    total: kept.length,
    sent,
    throttled,
    failures,
    windowStart: times.length === 0 ? now : Math.min(...times),
    windowEnd: times.length === 0 ? now : Math.max(...times),
    retentionDays: days,
    intervals: intervalStats(intervalsOf(kept)),
    byKind,
    failureRate: kept.length === 0 ? 0 : failures / kept.length,
  };
}

/* ------------------------------------------------------------------ */
/* 落盘                                                               */
/* ------------------------------------------------------------------ */

export function ledgerPath(dir: string = ledgerDir()): string {
  return join(dir, LEDGER_FILE);
}

export interface LedgerStore {
  append(record: LedgerRecord): Promise<void>;
  /** 读全部记录（已按保留期裁剪，但仍会写回时顺带压缩）。 */
  load(now: number, days?: number): Promise<LedgerRecord[]>;
  /** 重写文件，丢掉过期记录。 */
  compact(now: number, days?: number): Promise<number>;
  summary(now: number, days?: number): Promise<LedgerSummary>;
}

export function createLedger(file: string = ledgerPath()): LedgerFileLedger {
  return new LedgerFileLedger(file);
}

export class LedgerFileLedger implements LedgerStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  append(record: LedgerRecord): Promise<void> {
    // 串行化写入，避免并发 append 交错出半行 JSON。
    this.queue = this.queue.then(async () => {
      this.queue = this.queue;
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(scrub(record)) + "\n", "utf8");
    }).catch(() => undefined);
    return this.queue.then(() => undefined);
  }

  async load(now: number, days: number = DEFAULT_RETENTION_DAYS): Promise<LedgerRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out: LedgerRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (text === "") continue;
      const parsed = parseRecord(text);
      if (parsed !== null) out.push(parsed);
    }
    return pruneRecords(out, now, days);
  }

  async compact(now: number, days: number = DEFAULT_RETENTION_DAYS): Promise<number> {
    const kept = await this.load(now, days);
    await mkdir(dirname(this.file), { recursive: true });
    const body = kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length === 0 ? "" : "\n");
    const tmp = this.file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.file);
    return kept.length;
  }

  async summary(now: number, days: number = DEFAULT_RETENTION_DAYS): Promise<LedgerSummary> {
    return summarize(await this.load(now, days), now, days);
  }
}

export function memoryLedger(initial: readonly LedgerRecord[] = []): MemoryLedger {
  return new MemoryLedger(initial);
}

export class MemoryLedger implements LedgerStore {
  private records: LedgerRecord[];

  constructor(initial: readonly LedgerRecord[] = []) {
    this.records = initial.map((r) => ({ ...r }));
  }

  async append(record: LedgerRecord): Promise<void> {
    this.records.push({ ...record });
  }

  appendSync(record: LedgerRecord): void {
    this.records.push({ ...record });
  }

  async load(now: number, days: number = DEFAULT_RETENTION_DAYS): Promise<LedgerRecord[]> {
    this.records = pruneRecords(this.records, now, days);
    return this.records.map((r) => ({ ...r }));
  }

  async compact(now: number, days: number = DEFAULT_RETENTION_DAYS): Promise<number> {
    this.records = pruneRecords(this.records, now, days);
    return this.records.length;
  }

  async summary(now: number, days: number = DEFAULT_RETENTION_DAYS): Promise<LedgerSummary> {
    return summarize(this.records, now, days);
  }
}

/* ------------------------------------------------------------------ */
/* 内部                                                               */
/* ------------------------------------------------------------------ */

/**
 * 就算调用方手滑塞了多余字段，落盘前也要剥掉。
 * 这是"不含对话内容与凭证"这条约束的最后一道闸。
 */
function scrub(record: LedgerRecord): LedgerRecord {
  return {
    t: record.t,
    durMs: record.durMs,
    status: record.status,
    kind: record.kind,
    throttled: record.throttled,
    attempt: record.attempt,
    action: record.action,
    ttfbMs: record.ttfbMs,
  };
}

function parseRecord(line: string): LedgerRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(redactSecrets(line)) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const t = obj.t;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const kind = FAILURE_KINDS.includes(obj.kind as FailureKind) ? (obj.kind as FailureKind) : "unknown";
  return {
    t,
    durMs: numberOr(obj.durMs, 0),
    status: obj.status === null || obj.status === undefined ? null : numberOr(obj.status, 0),
    kind,
    throttled: obj.throttled === true,
    attempt: numberOr(obj.attempt, 0),
    action:
      obj.action === "append" || obj.action === "re-anchor" || obj.action === "rotate"
        ? obj.action
        : null,
    ttfbMs: obj.ttfbMs === null || obj.ttfbMs === undefined ? null : numberOr(obj.ttfbMs, 0),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
