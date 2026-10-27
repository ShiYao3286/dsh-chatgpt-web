/**
 * 滚动检查点：在软水位**之前**主动索要一份"状态交接"，让轮换能重建上下文。
 *
 * 为什么是"要"而不是"算"：我们拿不到 DSH 的内部状态，也不该把整段对话复制进新会话
 * （那等于把上下文成本翻倍）。让模型用固定字段讲清楚"现在到哪了"，是最小代价的交接。
 *
 * 安全边界：检查点只描述任务状态；解析时统一做一次密钥脱敏，落盘内容不含凭证。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { statePath } from "../paths.ts";

export const CHECKPOINT_VERSION = 1;

/** 交接块的边界标记。协议层（tools prompt）只需要知道这两个字符串。 */
export const HANDOFF_OPEN = "<state_handoff>";
export const HANDOFF_CLOSE = "</state_handoff>";

/** 交接块各字段的**固定顺序**。渲染与解析都按这个顺序。 */
export const FIELD_ORDER = [
  "goal",
  "confirmed",
  "changedFiles",
  "verified",
  "unverified",
  "openBranches",
  "nextStep",
  "doNotRepeat",
] as const;

export type CheckpointField = (typeof FIELD_ORDER)[number];

export const LIST_FIELDS: readonly CheckpointField[] = [
  "confirmed",
  "changedFiles",
  "verified",
  "unverified",
  "openBranches",
  "doNotRepeat",
];

export const FIELD_LABELS: Record<CheckpointField, string> = {
  goal: "GOAL",
  confirmed: "CONFIRMED",
  changedFiles: "CHANGED_FILES",
  verified: "VERIFIED",
  unverified: "UNVERIFIED",
  openBranches: "OPEN_BRANCHES",
  nextStep: "NEXT_STEP",
  doNotRepeat: "DO_NOT_REPEAT",
};

/** 一份状态交接。只装"任务状态"，不装对话原文，也不装凭证。 */
export interface Checkpoint {
  /** 一句话：这次到底要达成什么。 */
  goal: string;
  /** 已确认的事实。 */
  confirmed: string[];
  /** 已改动的文件（相对路径）。 */
  changedFiles: string[];
  /** 已验证：跑过什么、结果如何。 */
  verified: string[];
  /** 未验证：还缺哪一步。 */
  unverified: string[];
  /** 未解决的分支。 */
  openBranches: string[];
  /** 下一步。 */
  nextStep: string;
  /** 不要重做的事（踩过的坑）。 */
  doNotRepeat: string[];
}

export interface CheckpointEnvelope {
  version: number;
  savedAt: number;
  /** 保存时该 web 会话已吃进多少轮。 */
  turns: number;
  checkpoint: Checkpoint;
}

/* ------------------------------------------------------------------ */
/* 限额：交接块是要塞进新会话的种子，必须小。                          */
/* ------------------------------------------------------------------ */

export const MAX_ITEMS = 6;
export const MAX_ITEM_CHARS = 160;
export const MAX_SCALAR_CHARS = 240;
export const MAX_SEED_CHARS = 12_000;
export const DEFAULT_CHECKPOINT_MARGIN = 4;

/* ------------------------------------------------------------------ */
/* 触发时机：软水位之前，而不是软水位上                                 */
/* ------------------------------------------------------------------ */

export interface CheckpointPlanInput {
  /** 当前绑定已经吃进多少轮（无绑定时传 0）。 */
  turns: number;
  softTurns: number;
  /** 上一份检查点是第几轮拿到的；没有则为 null。 */
  lastCheckpointTurns: number | null;
  /** 距软水位提前多少轮开始要交接。 */
  margin?: number;
}

export type CheckpointPlanReason =
  | "no-turns"
  | "not-due"
  | "fresh"
  | "before-soft-watermark";

export interface CheckpointPlan {
  due: boolean;
  /** 开始索要检查点的轮数（严格小于 softTurns）。 */
  dueAt: number;
  /** 距软水位还剩几轮。 */
  remaining: number;
  reason: CheckpointPlanReason;
}

/**
 * 判断这一轮要不要顺手要一份交接。
 *
 * 关键点：dueAt 一定 < softTurns —— 软水位一到 decideFeed 就会轮换，
 * 那时再要检查点已经来不及（那一条请求会带着旧上下文一起被丢弃）。
 */
export function planCheckpoint(input: CheckpointPlanInput): CheckpointPlan {
  const softTurns = Math.max(1, Math.floor(input.softTurns));
  const margin = clampInt(input.margin ?? DEFAULT_CHECKPOINT_MARGIN, 0, softTurns - 1);
  const dueAt = softTurns - margin;
  const remaining = Math.max(0, softTurns - input.turns);
  const base = { dueAt, remaining };

  if (input.turns <= 0) return { ...base, due: false, reason: "no-turns" };
  if (input.turns < dueAt) return { ...base, due: false, reason: "not-due" };

  // 已经有一份足够新的检查点：不重复打扰模型。refresh 间隔就用 margin。
  const refresh = Math.max(1, margin);
  if (input.lastCheckpointTurns !== null && input.turns - input.lastCheckpointTurns < refresh) {
    return { ...base, due: false, reason: "fresh" };
  }
  return { ...base, due: true, reason: "before-soft-watermark" };
}

/** 索要交接的协议指令。很短，只要求字段齐全，不要求文采。 */
export function buildCheckpointRequest(): string {
  const lines: string[] = [];
  lines.push("<state_handoff_request>");
  lines.push("在继续处理本条之前，先输出一份**最小状态交接**，字段名照抄，顺序不变，每项一行：");
  lines.push(HANDOFF_OPEN);
  lines.push(FIELD_LABELS.goal + ": " + PLACEHOLDER_GOAL);
  lines.push(FIELD_LABELS.confirmed + ": " + PLACEHOLDER_ITEM);
  lines.push(FIELD_LABELS.changedFiles + ": " + PLACEHOLDER_ITEM);
  lines.push(FIELD_LABELS.verified + ": " + PLACEHOLDER_ITEM);
  lines.push(FIELD_LABELS.unverified + ": " + PLACEHOLDER_ITEM);
  lines.push(FIELD_LABELS.openBranches + ": " + PLACEHOLDER_ITEM);
  lines.push(FIELD_LABELS.nextStep + ": " + PLACEHOLDER_GOAL);
  lines.push(FIELD_LABELS.doNotRepeat + ": " + PLACEHOLDER_ITEM);
  lines.push(HANDOFF_CLOSE);
  lines.push(
    "要求：只写任务状态，不要复述对话原文，不要出现任何令牌/Cookie/密钥；" +
      "交接块之后紧接着继续正常完成任务，不要额外解释。",
  );
  lines.push("</state_handoff_request>");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 渲染 / 解析                                                         */
/* ------------------------------------------------------------------ */

export function renderCheckpoint(cp: Checkpoint): string {
  const lines: string[] = [];
  for (const field of FIELD_ORDER) {
    const label = FIELD_LABELS[field];
    if (field === "goal" || field === "nextStep") {
      const value = field === "goal" ? cp.goal : cp.nextStep;
      lines.push(label + ": " + (value.trim() === "" ? PLACEHOLDER_EMPTY : value.trim()));
      continue;
    }
    const items = cp[field];
    if (items.length === 0) {
      lines.push(label + ": " + PLACEHOLDER_EMPTY);
      continue;
    }
    lines.push(label + ":");
    for (const item of items) lines.push("- " + item);
  }
  return lines.join("\n");
}

/**
 * 从模型回复里抠出交接块。容错优先：
 *   - 有 <state_handoff> 就用块内内容；没有就退化成"整段里找字段行"
 *   - 字段名大小写/空格/连字符不敏感，也认中文名
 *   - 列表项支持 "KEY: a; b"、"KEY:" + "- a" 两种写法
 */
export function parseCheckpoint(text: string): Checkpoint | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const block = extractHandoffBlock(text) ?? text;
  const buckets = emptyBuckets();
  let current: CheckpointField | null = null;
  let sawKey = 0;

  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.toLowerCase() === HANDOFF_OPEN || line.toLowerCase() === HANDOFF_CLOSE) continue;

    const keyed = /^[-*•·]?\s*([^:：]{1,24})\s*[:：]\s*(.*)$/.exec(line);
    if (keyed !== null) {
      const field = FIELD_ALIASES[normalizeKey(keyed[1])];
      if (field !== undefined) {
        current = field;
        sawKey += 1;
        const value = keyed[2].trim();
        if (value !== "") buckets[field].push(value);
        continue;
      }
      // 不是已知字段：当作普通文本丢弃，避免污染上一个字段
      current = null;
      continue;
    }

    if (current === null) continue;
    const bullet = /^[-*•·]\s*(.*)$/.exec(line);
    buckets[current].push(bullet === null ? line : bullet[1].trim());
  }

  if (sawKey === 0) return null;

  const cp: Checkpoint = {
    goal: cleanScalar(buckets.goal.join(" "), MAX_SCALAR_CHARS),
    confirmed: cleanList(buckets.confirmed, MAX_ITEMS, MAX_ITEM_CHARS),
    changedFiles: cleanList(buckets.changedFiles, MAX_ITEMS, MAX_ITEM_CHARS),
    verified: cleanList(buckets.verified, MAX_ITEMS, MAX_ITEM_CHARS),
    unverified: cleanList(buckets.unverified, MAX_ITEMS, MAX_ITEM_CHARS),
    openBranches: cleanList(buckets.openBranches, MAX_ITEMS, MAX_ITEM_CHARS),
    nextStep: cleanScalar(buckets.nextStep.join(" "), MAX_SCALAR_CHARS),
    doNotRepeat: cleanList(buckets.doNotRepeat, MAX_ITEMS, MAX_ITEM_CHARS),
  };
  return isBlank(cp) ? null : cp;
}

/** 把交接块从正文里摘掉：协议细节不该出现在用户看到的回复里。 */
export function stripHandoffBlock(text: string): string {
  if (typeof text !== "string" || text === "") return text;
  const lower = text.toLowerCase();
  const open = lower.indexOf(HANDOFF_OPEN);
  if (open < 0) return text;
  const close = lower.indexOf(HANDOFF_CLOSE, open + HANDOFF_OPEN.length);
  const head = text.slice(0, open);
  const tail = close < 0 ? "" : text.slice(close + HANDOFF_CLOSE.length);
  return (head + tail).replace(/\n{3,}/g, "\n\n").trim();
}

export function checkpointToText(cp: Checkpoint): string {
  return renderCheckpoint(cp);
}

/* ------------------------------------------------------------------ */
/* 轮换种子：固定头 + 检查点 + 最近 K 轮                                */
/* ------------------------------------------------------------------ */

export interface RotateSeedInput {
  /** 固定头（bootstrap + 工具目录）。 */
  bootstrap: string;
  /** 最近一份检查点；没有则省略该段。 */
  checkpoint: Checkpoint | null;
  /** 本次请求的完整条目。 */
  entries: readonly string[];
  /** 最近几轮。一轮 = 一条 user + 一条 assistant，所以取 2*K 条。 */
  recentTurns: number;
}

export interface RotateSeed {
  text: string;
  hasCheckpoint: boolean;
  /** 实际带上的历史条数。 */
  recentCount: number;
  /** 是否因为超长被截断（截断时保留最新内容）。 */
  truncated: boolean;
}

export function buildRotateSeed(input: RotateSeedInput): RotateSeed {
  const sections: string[] = [];
  const bootstrap = input.bootstrap.trim();
  if (bootstrap !== "") {
    sections.push("[固定头]\n" + bootstrap);
  }

  const hasCheckpoint = input.checkpoint !== null;
  if (input.checkpoint !== null) {
    sections.push("[状态交接]\n" + renderCheckpoint(input.checkpoint));
  }

  const take = Math.max(0, Math.floor(input.recentTurns)) * 2;
  const recent = take === 0 ? [] : input.entries.slice(Math.max(0, input.entries.length - take));
  if (recent.length > 0) {
    const lines = recent.map((entry, i) => i + 1 + ". " + entry.trim());
    sections.push("[最近 " + recent.length + " 条]\n" + lines.join("\n"));
  }

  let text = sections.join("\n\n");
  let truncated = false;
  if (text.length > MAX_SEED_CHARS) {
    // 从前面砍：最新的内容才有价值。
    text = "…（较早内容已省略）\n\n" + text.slice(text.length - MAX_SEED_CHARS);
    truncated = true;
  }
  return { text, hasCheckpoint, recentCount: recent.length, truncated };
}

/* ------------------------------------------------------------------ */
/* 落盘                                                               */
/* ------------------------------------------------------------------ */

/** 检查点和 state.json 放同一个目录，便于一起备份/清理。 */
export function checkpointPath(): string {
  return join(dirname(statePath()), "checkpoint.json");
}

export interface CheckpointStore {
  load(): Promise<CheckpointEnvelope | null>;
  save(envelope: CheckpointEnvelope): Promise<void>;
  clear(): Promise<void>;
}

export function fileCheckpointStore(file: string = checkpointPath()): CheckpointStore {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        return null;
      }
      return normalizeEnvelope(safeJsonParse(raw));
    },
    async save(envelope) {
      await writeJsonAtomic(file, envelope);
    },
    async clear() {
      await writeJsonAtomic(file, null);
    },
  };
}

export function memoryCheckpointStore(initial: CheckpointEnvelope | null = null): CheckpointStore {
  let value: CheckpointEnvelope | null = initial;
  return {
    async load() {
      return value;
    },
    async save(envelope) {
      value = envelope;
    },
    async clear() {
      value = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 内部                                                               */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_GOAL = "一句话说明目标";
const PLACEHOLDER_ITEM = "一项一条（没有就写 无）";
const PLACEHOLDER_EMPTY = "（未提供）";

const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "",
  "无",
  "沒有",
  "没有",
  "暂无",
  "none",
  "n/a",
  "na",
  "null",
  "-",
  "—",
  "–",
  "…",
  "...",
  "（无）",
  "(无)",
  "（未提供）",
  "(未提供)",
  PLACEHOLDER_GOAL,
  PLACEHOLDER_ITEM,
]);

const FIELD_ALIASES: Record<string, CheckpointField> = {
  goal: "goal",
  objective: "goal",
  "目标": "goal",
  confirmed: "confirmed",
  confirmed_facts: "confirmed",
  confirmed_fact: "confirmed",
  facts: "confirmed",
  "已确认": "confirmed",
  "已确认事实": "confirmed",
  changed_files: "changedFiles",
  changed_file: "changedFiles",
  files: "changedFiles",
  touched_files: "changedFiles",
  "已改文件": "changedFiles",
  "改动文件": "changedFiles",
  verified: "verified",
  "已验证": "verified",
  "已通过": "verified",
  unverified: "unverified",
  not_verified: "unverified",
  pending: "unverified",
  "未验证": "unverified",
  "待验证": "unverified",
  open_branches: "openBranches",
  open_branch: "openBranches",
  open: "openBranches",
  branches: "openBranches",
  "未解决": "openBranches",
  "未解决分支": "openBranches",
  next_step: "nextStep",
  next: "nextStep",
  todo: "nextStep",
  "下一步": "nextStep",
  do_not_repeat: "doNotRepeat",
  dont_repeat: "doNotRepeat",
  avoid: "doNotRepeat",
  "不要重做": "doNotRepeat",
  "勿重做": "doNotRepeat",
};

function emptyBuckets(): Record<CheckpointField, string[]> {
  return {
    goal: [],
    confirmed: [],
    changedFiles: [],
    verified: [],
    unverified: [],
    openBranches: [],
    nextStep: [],
    doNotRepeat: [],
  };
}

function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractHandoffBlock(text: string): string | null {
  const lower = text.toLowerCase();
  const open = lower.indexOf(HANDOFF_OPEN);
  if (open < 0) return null;
  const start = open + HANDOFF_OPEN.length;
  const close = lower.indexOf(HANDOFF_CLOSE, start);
  return close < 0 ? text.slice(start) : text.slice(start, close);
}

function splitItems(value: string): string[] {
  return value
    .split(/[;；、]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function cleanScalar(value: string, maxChars: number): string {
  const redacted = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (PLACEHOLDERS.has(redacted.toLowerCase())) return "";
  return truncate(redacted, maxChars);
}

function cleanList(values: readonly string[], maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const piece of splitItems(value)) {
      const cleaned = cleanScalar(piece, maxChars);
      if (cleaned === "") continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
      if (out.length >= maxItems) return out;
    }
  }
  return out;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function isBlank(cp: Checkpoint): boolean {
  if (cp.goal !== "" || cp.nextStep !== "") return false;
  return LIST_FIELDS.every((field) => cp[field].length === 0);
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_\-]{8,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{4,}/g, "[REDACTED-JWT]"],
  // 值里可能含空格（例如先被上面那条换成了 "Bearer [REDACTED]"），所以整行吞掉。
  // 宁可过度脱敏，也不能漏。
  [
    /\b(authorization|access_token|refresh_token|cookie|password|secret|api[_-]?key)\b\s*[:=]\s*[^\r\n]+/gi,
    "$1=[REDACTED]",
  ],
  [/\b[0-9a-f]{40,}\b/gi, "[REDACTED]"],
];

/** 脱敏：检查点会落盘，任何看起来像凭证的片段一律替换掉。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number.isFinite(value) ? value : min);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function normalizeEnvelope(raw: unknown): CheckpointEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== CHECKPOINT_VERSION) return null;
  if (typeof obj.savedAt !== "number" || !Number.isFinite(obj.savedAt)) return null;
  if (typeof obj.turns !== "number" || !Number.isFinite(obj.turns)) return null;
  const cp = normalizeCheckpoint(obj.checkpoint);
  if (cp === null) return null;
  return { version: CHECKPOINT_VERSION, savedAt: obj.savedAt, turns: obj.turns, checkpoint: cp };
}

function normalizeCheckpoint(raw: unknown): Checkpoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const cp: Checkpoint = {
    goal: typeof obj.goal === "string" ? obj.goal : "",
    confirmed: stringList(obj.confirmed),
    changedFiles: stringList(obj.changedFiles),
    verified: stringList(obj.verified),
    unverified: stringList(obj.unverified),
    openBranches: stringList(obj.openBranches),
    nextStep: typeof obj.nextStep === "string" ? obj.nextStep : "",
    doNotRepeat: stringList(obj.doNotRepeat),
  };
  return isBlank(cp) ? null : cp;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
