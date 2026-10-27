/**
 * 「说要做、实际没做」的检测。
 *
 * 网页端模型有一个反复出现的失败形态：正文里写「我来改一下 src/a.ts」「已修改完成」
 * 「现在执行测试」，实际上一个 <tool_call> 都没发。用户看到的是"做了"，磁盘上什么都没发生。
 *
 * 本模块只做**判定**，不做补救：返回一个可读的问题描述，让上层把它作为一次协议纠正
 * 回给模型（或直接告诉用户这轮没有执行）。判据全部是纯函数，正反例都有测试钉住。
 *
 * 两类信号：
 *   1. **零调用但正文像在调用** —— 出现了 <tool_call> / <invoke 之类的调用形态，
 *      却一个都没解析出来（被解析器放进 unparsed），或者正文写着"我来调用…"却没有调用。
 *   2. **声称改了文件** —— 正文断言已完成写入/修改/删除/执行，但本轮零工具调用。
 *      只要本轮真的发生过调用，就一律不判 —— 宁可漏报，不可误报。
 */

import { looksLikeToolCall } from "./parse.ts";
import type { ParsedToolCall, UnparsedToolCandidate } from "./parse.ts";

export type UnexecutedKind =
  /** 正文里有调用形态，但本轮零调用。 */
  | "tool-shape-no-call"
  /** 正文声称已完成写文件/执行，但本轮零调用。 */
  | "claimed-work-no-call";

export interface UnexecutedFinding {
  readonly kind: UnexecutedKind;
  /** 触发判定的原句（正则会连同前后文一起截出来）。 */
  readonly evidence: string;
  /** 可直接回给模型的中文纠正语。 */
  readonly correction: string;
}

export interface UnexecutedInput {
  /** 已剔除了成功 tool-call 的正文。 */
  readonly text: string;
  /** 本轮真正执行（或被接受）的工具调用。空数组 = 零调用。 */
  readonly toolCalls: readonly ParsedToolCall[];
  /** 解析器报了但没能变成调用的候选。 */
  readonly unparsed?: readonly UnparsedToolCandidate[];
}

/**
 * 声称已经完成写入/修改/删除/执行的断言。
 *
 * 刻意收窄：只认「动词 + 完成体」和明确的完成语，不认「我会去改」「打算改」这种将来时 ——
 * 将来时本来就还没做，不是矛盾。
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:已|已经)(?:成功)?(?:修改|更改|改好|改完|写入|写好|创建|新建|删除|移除|保存|更新|修复|重命名|移动|覆盖|替换|生成)(?:了)?/gu,
  /(?:我|已经)?(?:已)?(?:完成|做完)了?(?:修改|更改|写入|编辑|创建|删除|更新|修复|重构)/gu,
  /(?:修改|写入|创建|删除|更新|修复|重构)(?:已经|已)?完成/gu,
  /(?:文件|代码|脚本|配置|目录)(?:已经|已)(?:改好|写好|建好|更新|保存|就位)/gu,
  /\b(?:I(?:'ve| have)? (?:successfully )?(?:created|updated|modified|written|edited|deleted|removed|renamed|saved|patched|fixed)|(?:created|updated|modified|written|edited|deleted|removed|renamed|saved|patched|fixed) the file)\b/giu,
  /\b(?:changes|edits|updates) (?:have been|were) (?:made|applied|saved)\b/giu,
  /\b(?:done|applied|saved)\.?\s*(?:the )?(?:file|change|edit|patch) (?:is|has been) updated\b/giu,
];

/** 声称要执行命令/跑测试的断言（同样是完成体）。 */
const COMMAND_CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:已|已经)(?:成功)?(?:执行|运行|跑)(?:了)?(?:命令|脚本|测试)?/gu,
  /(?:测试|命令|脚本)(?:已经|已)?(?:跑|运行|执行)(?:完|通过)/gu,
  /(?:全部|都)(?:通过|绿了)/gu,
  /\b(?:I (?:ran|executed)|ran the (?:command|tests?|script)|tests? (?:pass|passed|are green))\b/giu,
];

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

function firstMatch(text: string, patterns: readonly RegExp[]): { evidence: string } | null {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match !== null) {
      return { evidence: snippet(text, match.index, match[0].length) };
    }
  }
  return null;
}

/** 代码块里的内容不算「声称」—— 那是引用的代码，不是完成报告。 */
function stripFencedCode(text: string): string {
  const fence = "\u0060\u0060\u0060";
  let out = "";
  let index = 0;
  for (;;) {
    const start = text.indexOf(fence, index);
    if (start < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, start);
    const end = text.indexOf(fence, start + 3);
    if (end < 0) break;
    index = end + 3;
  }
  return out;
}

/**
 * 主判据。返回 null 表示这一轮没有「说要做实际没做」的问题。
 *
 * 顺序：先看「零调用 + 有调用形态」（最硬的证据），再看「零调用 + 声称完成」。
 * 只要本轮有调用，一律放行 —— 断言是否属实不归本模块管。
 */
export function detectUnexecuted(input: UnexecutedInput): UnexecutedFinding[] {
  if (input.toolCalls.length > 0) return [];

  const findings: UnexecutedFinding[] = [];
  const prose = stripFencedCode(input.text);

  const unparsed = input.unparsed ?? [];
  if (unparsed.length > 0) {
    findings.push({
      kind: "tool-shape-no-call",
      evidence: snippet(unparsed[0]?.raw ?? "", 0, (unparsed[0]?.raw ?? "").length),
      correction:
        "你写了工具调用的标记，但这一轮没有任何调用被执行：" +
        (unparsed[0]?.reason ?? "解析失败") +
        "。请重新用 <tool_call>{\"name\":...,\"arguments\":{...}}</tool_call> 的完整形式发一次，" +
        "参数必须是合法 JSON；如果这个工具不该用，就直接说明原因。",
    });
    return findings;
  }

  if (looksLikeToolCall(prose)) {
    const index = prose.search(/<tool_call>|<toolcall>|<invoke|<function_call>|"tool_calls"\s*:/u);
    findings.push({
      kind: "tool-shape-no-call",
      evidence: snippet(prose, Math.max(0, index), 32),
      correction:
        "正文里出现了工具调用的形态，但本轮一个调用都没有执行。工具调用必须写成完整的 " +
        "<tool_call>{\"name\":\"工具名\",\"arguments\":{...}}</tool_call>，并且真的发出来；" +
        "只在正文里描述调用不算执行。",
    });
    return findings;
  }

  const fileClaim = firstMatch(prose, CLAIM_PATTERNS);
  if (fileClaim !== null) {
    findings.push({
      kind: "claimed-work-no-call",
      evidence: fileClaim.evidence,
      correction:
        "你声称已经完成修改/写入，但本轮零工具调用 —— 你说的改动没有发生。" +
        "请真的发出对应的工具调用；如果只是建议，请改成「建议改成……」。",
    });
    return findings;
  }

  const commandClaim = firstMatch(prose, COMMAND_CLAIM_PATTERNS);
  if (commandClaim !== null) {
    findings.push({
      kind: "claimed-work-no-call",
      evidence: commandClaim.evidence,
      correction:
        "你声称已经执行/跑过测试，但本轮零工具调用 —— 没有任何命令真的跑过。" +
        "请真的发出工具调用，或者明确说「还没验证」。",
    });
  }

  return findings;
}

/** 有没有问题，给调用方省一次数组判空。 */
export function hasUnexecuted(input: UnexecutedInput): boolean {
  return detectUnexecuted(input).length > 0;
}
