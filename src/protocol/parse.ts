/**
 * 从模型的纯文本输出里解析出工具调用。
 *
 * 网页端没有 function-call 通道，模型只能把调用写在正文里。所以解析器必须同时容忍两族标记：
 *
 *   1. **JSON 族**：<tool_call>{"name":"read","arguments":{...}}</tool_call>，以及
 *      <toolcall> / <tool-call> / <tool\_call>（网页端 Markdown 会把下划线转义），
 *      外加贴在外面的 fenced 代码块。
 *   2. **XML / DSML 族**：<invoke name="read"><parameter name="file_path">a</parameter></invoke>、
 *      <function_call>、带命名空间的 <|DSML|invoke ...>，以及把参数摊成子标签的写法。
 *
 * 三条硬约束：
 *
 *   - **跨 SSE 分块不能泄漏**。标记可能被切成两半（"<tool_" + "call>"），未完成的尾巴必须
 *     hold-back，既不能当正文吐出去，也不能因为当前看不到结尾就判定「不是调用」。
 *   - **非法 JSON 要宽容修复**，但修不好不许猜。重点是 Windows 路径的单反斜杠：
 *     "C:\Users\me" 里 \U 是非法转义（好修），而 "\resources\foo" 里 \r 是**合法**转义 ——
 *     直接 JSON.parse 会把 \r 变成回车，于是 \resources 变成「回车 + esources」。
 *     所以必须先按字面量保护所有反斜杠，再交给 JSON 引擎。
 *   - **解析失败不静默丢内容**。任何没能变成 tool-call 的候选片段都原样回到正文，
 *     同时带上一条可读原因，让上层能把它反馈给模型。
 */

/** 解析出的一个工具调用。 */
export interface ParsedToolCall {
  /** 模型给了就用模型的；没给就是 call_N（稳定，不含随机数）。 */
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** 一段没能解析成调用的候选，原样保留。 */
export interface UnparsedToolCandidate {
  /** 原始片段（含标记本身）。 */
  readonly raw: string;
  /** 人话原因，可直接回给模型。 */
  readonly reason: string;
  /** 用的是哪一族标记。 */
  readonly family: "json" | "xml";
}

export interface ParsedOutput {
  /** 去掉成功解析的调用之后、应当流给用户的正文（含解析失败的原文）。 */
  readonly text: string;
  readonly toolCalls: readonly ParsedToolCall[];
  /** 解析失败但被保住的片段。非空时上层必须让模型看见。 */
  readonly unparsed: readonly UnparsedToolCandidate[];
  /** 流未结束时仍 hold 住的尾巴；flush 之后恒为空串。 */
  readonly pending: string;
  /** 所有标记是否都成对闭合。流被截断时为 false。 */
  readonly balanced: boolean;
}

export interface ParseOptions {
  /** 起始序号，用于给没有 id 的调用生成稳定的 call_N。默认 1。 */
  readonly startIndex?: number;
}

type Family = "json" | "xml";

interface OpenTag {
  readonly text: string;
  readonly family: Family;
}

interface CloseTag {
  readonly text: string;
  readonly open: string;
}

/** 开始标记。JSON 族要同时收下被 Markdown 转义的写法（下划线前多一个反斜杠）。 */
const OPEN_TAGS: readonly OpenTag[] = [
  { text: "<tool_call>", family: "json" },
  { text: "<tool\\_call>", family: "json" },
  { text: "<tool-call>", family: "json" },
  { text: "<toolcall>", family: "json" },
  { text: "<function_call>", family: "json" },
  { text: "<function-call>", family: "json" },
  { text: "<|DSML|invoke", family: "xml" },
  { text: "<|dsml|invoke", family: "xml" },
  { text: "<invoke", family: "xml" },
];

/** 结束标记。按开始标记反查，避免 <invoke> 误配 </tool_call>。 */
const CLOSE_TAGS: readonly CloseTag[] = [
  { text: "</tool_call>", open: "<tool_call>" },
  { text: "</tool\\_call>", open: "<tool\\_call>" },
  { text: "</tool-call>", open: "<tool-call>" },
  { text: "</toolcall>", open: "<toolcall>" },
  { text: "</function_call>", open: "<function_call>" },
  { text: "</function-call>", open: "<function-call>" },
  { text: "</|DSML|invoke>", open: "<|DSML|invoke" },
  { text: "</|dsml|invoke>", open: "<|dsml|invoke" },
  { text: "</invoke>", open: "<invoke" },
];

interface TagHit {
  readonly index: number;
  readonly tag: string;
  readonly family: Family;
}

function findOpenTag(buffer: string, from: number): TagHit | null {
  let best: TagHit | null = null;
  for (const tag of OPEN_TAGS) {
    const index = buffer.indexOf(tag.text, from);
    if (index < 0) continue;
    if (best === null || index < best.index || (index === best.index && tag.text.length > best.tag.length)) {
      best = { index, tag: tag.text, family: tag.family };
    }
  }
  return best;
}

/** buffer 结尾有多少字符是某个开始标记的前缀 —— 这些必须 hold，不能当正文吐出去。 */
function partialOpenSuffix(buffer: string): number {
  let longest = 0;
  for (const tag of OPEN_TAGS) {
    const limit = Math.min(tag.text.length - 1, buffer.length);
    for (let len = limit; len > longest; len--) {
      if (buffer.endsWith(tag.text.slice(0, len))) {
        longest = len;
        break;
      }
    }
  }
  return longest;
}

function closeTagsFor(open: string): readonly string[] {
  const out: string[] = [];
  for (const tag of CLOSE_TAGS) {
    if (tag.open === open) out.push(tag.text);
  }
  if (out.length === 0) out.push("</invoke>");
  return out;
}

function findCloseTag(buffer: string, from: number, open: string): TagHit | null {
  let best: TagHit | null = null;
  for (const text of closeTagsFor(open)) {
    const index = buffer.indexOf(text, from);
    if (index < 0) continue;
    if (best === null || index < best.index) best = { index, tag: text, family: "json" };
  }
  return best;
}

function partialCloseSuffix(buffer: string, open: string): number {
  let longest = 0;
  for (const text of closeTagsFor(open)) {
    const limit = Math.min(text.length - 1, buffer.length);
    for (let len = limit; len > longest; len--) {
      if (buffer.endsWith(text.slice(0, len))) {
        longest = len;
        break;
      }
    }
  }
  return longest;
}

/* ------------------------------------------------------------------ *
 * 宽容 JSON 修复
 * ------------------------------------------------------------------ */

export interface RepairResult {
  readonly value: unknown;
  readonly ok: boolean;
  readonly reason?: string;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;
const WHITESPACE = /\s/;

/* JSON 的普通转义（不含 \uXXXX，那个单独处理）。 */
const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/**
 * 稀有控制转义：\b \f \r。
 *
 * 判据来源：手写 Windows 路径的分段首字母大量落在这三个上（\resources、\build、\file、
 * \bin、\repo …），而"真正想表达退格/换页/回车"的场合极少。所以只要反斜杠后面跟着
 * 字母/数字/下划线，就按字面反斜杠处理；后面是引号、空格、标点、串尾时才当控制字符。
 */
const RARE_CONTROL_ESCAPES = new Set(["b", "f", "r"]);

/**
 * 常见控制转义：\n \t。
 *
 * 这两个在文件内容里是真正高频的（换行、缩进），误判的代价（把两字符 \n 写进文件）
 * 比不修更大。所以它们**始终按转义解释**，除非整段已经确认是路径（见 pathish）。
 */
const COMMON_CONTROL_ESCAPES = new Set(["n", "t"]);

/**
 * 这段字符串内容像不像 Windows 路径 / 反斜杠分隔的文件名。
 *
 * 只看非转义部分的原始字符。判据取"够用就好、宁可当路径"：
 *   - 出现盘符     C:\  D:\
 *   - 出现引号里的双反斜杠 \\server\share（UNC）
 *   - 出现 "." + 已知扩展名（.ts/.json/.mjs/.png ...）
 *   - 出现 \A \U \d \s 这类 JSON 根本不认的转义（只有手写路径才会产生）
 *   - 反斜杠后跟字母且后面还粘着字母（\resources）
 */
function looksLikeBackslashPath(inner: string): boolean {
  // 盘符：C:\  C:/  —— 最硬的证据
  if (/[A-Za-z]:[\\/]/u.test(inner)) return true;
  // 已经是合法的一对反斜杠（UNC 或模型自己写对了）
  if (/\\\\/u.test(inner)) return true;
  // 反斜杠夹在两个标识符之间：\foo\bar
  if (/\\[A-Za-z0-9_.\-]+\\[A-Za-z0-9_.\-]/u.test(inner)) return true;
  // 文件名：xxx.ts / xxx.json / xxx.mjs
  if (/\.[A-Za-z0-9]{1,8}(?=["\/\\]|$)/u.test(inner)) return true;
  // JSON 根本不认的转义：\A \U \d \s \w \p \x  —— 只有手写路径才会产生
  if (/\\(?![\\"/bfnrtu])/u.test(inner)) return true;
  // \resources 这类：\r 后面还粘着字母
  if (/\\[bfrt][A-Za-z0-9_\-]/u.test(inner)) return true;
  return false;
}

/**
 * 逐字符处理一个 JSON 字符串字面量（已经包含首尾引号），返回修好的字面量。
 *
 * 核心判据（Windows 单反斜杠）：
 *
 *   - \`"\resources\foo"\`：\r 在 JSON 里是**合法**转义，直接 JSON.parse 会得到
 *     「回车 + esources」，路径被悄悄改掉。但模型想写的显然是字面反斜杠。
 *   - \`"C:\Users\me"\`：\U 是**非法**转义，JSON.parse 直接抛错。
 *
 * 逐个反斜杠的处置：
 *   - 后面是 " \\ / uXXXX → 保留（都是合法转义，且不会误伤路径）。
 *   - 后面是 n / t → 默认按控制字符（文件内容里的换行、缩进是真的高频）；
 *     只有整条字符串已判定为路径时才改判成字面反斜杠。
 *   - 后面是 b / f / r → 默认按字面反斜杠。手写路径的分段首字母大量落在这三个上
 *     （\bin \build \file \resources \repo），而真要表达退格/换页/回车时，
 *     反斜杠后面几乎不会紧跟字母/数字。
 *   - 其它（\A \U \d \s …）→ JSON 不认，一律字面反斜杠。
 */
function repairStringLiteral(raw: string): string {
  const inner = raw.slice(1, raw.length - 1);
  const pathish = looksLikeBackslashPath(inner);
  let out = '"';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch === '"' ? '\\"' : ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      out += "\\\\";
      continue;
    }
    if (next === '"') {
      // 引号转义：内容里不会出现，保留
      out += '\\"';
      i += 1;
      continue;
    }
    if (next === "\\") {
      // 已经写成两个反斜杠：字面反斜杠，原样保留（这正是合法 JSON 写法）
      out += "\\\\";
      i += 1;
      continue;
    }
    if (next === "/") {
      out += "\\/";
      i += 1;
      continue;
    }
    if (next === "u") {
      const hex = inner.slice(i + 2, i + 6);
      if (HEX4.test(hex)) {
        out += "\\u" + hex;
        i += 5;
        continue;
      }
      out += "\\\\";
      continue;
    }
    if (COMMON_CONTROL_ESCAPES.has(next)) {
      // \n \t：高频真控制字符。只有整段已确认是路径时才改判成字面反斜杠。
      if (pathish) {
        out += "\\\\";
        continue;
      }
      out += "\\" + next;
      i += 1;
      continue;
    }
    if (RARE_CONTROL_ESCAPES.has(next)) {
      // \b \f \r：默认当字面反斜杠，除非后面紧跟着"不像路径"的字符。
      // 判据来源：\resources / \build / \file / \bin 全部会被这四类吃掉，
      // 而真要表达回车/退格时，反斜杠后面几乎不会紧跟字母。
      const after = inner[i + 2];
      const letterFollows = after !== undefined && /[A-Za-z0-9_\-]/u.test(after);
      if (pathish || letterFollows) {
        out += "\\\\";
        continue;
      }
      out += "\\" + next;
      i += 1;
      continue;
    }
    // \A、\U、\d、\. —— JSON 不认，一律当字面反斜杠
    out += "\\\\";
  }
  return out + '"';
}

/**
 * 把「模型手写的 JSON」里的反斜杠归一化成合法转义，同时**保住真实转义**。
 *
 * 必须在 JSON.parse **之前**做：否则 \`"\\resources\\foo"\` 里的 \r 会被 JSON 引擎按合法
 * 转义吃成回车，路径被悄悄改掉 —— 这正是 Windows 单反斜杠的经典踩坑点。
 */
export function repairJsonText(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== '"') {
      out += ch;
      i += 1;
      continue;
    }
    // 找到这个字符串字面量的结尾（跳过转义对）
    let end = i + 1;
    while (end < raw.length) {
      const c = raw[end];
      if (c === "\\") {
        end += 2;
        continue;
      }
      if (c === '"') break;
      end += 1;
    }
    const literal = raw.slice(i, Math.min(end + 1, raw.length));
    out += literal.length >= 2 && literal.endsWith('"')
      ? repairStringLiteral(literal)
      : repairStringLiteral(literal + '"').slice(0, -1);
    i = end + 1;
  }
  return out;
}

/** 去掉对象/数组结尾前的尾随逗号。字符串内部不动。 */
function dropTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && WHITESPACE.test(text[j] ?? "")) j += 1;
      const peek = text[j];
      if (peek === "}" || peek === "]") continue;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 给裸键名补引号：{name: "x"} → {"name": "x"}。字符串内部不动。 */
function quoteBareKeys(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === ",") {
      let j = i + 1;
      while (j < text.length && WHITESPACE.test(text[j] ?? "")) j += 1;
      const rest = text.slice(j);
      const keyMatch = /^[A-Za-z_$][A-Za-z0-9_$]*\s*:/.exec(rest);
      out += ch;
      if (keyMatch !== null) {
        const key = keyMatch[0].slice(0, keyMatch[0].lastIndexOf(":")).trim();
        out += text.slice(i + 1, j) + '"' + key + '":';
        i = j + key.length;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 最后手段：在真正解析不了的字符串里，把裸引号换成全角引号，让对象能被吃下来。
 * 判据是「后面跟着 , } ] 或结尾」才算字符串真结束，否则那个引号是内容的一部分。
 */
function salvageQuotes(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out += ch + next;
          i += 1;
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && WHITESPACE.test(text[j] ?? "")) j += 1;
        const peek = text[j];
        if (peek === undefined || peek === "," || peek === "}" || peek === "]") {
          inString = false;
          out += ch;
          continue;
        }
        out += "\u201d";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** 花括号配平：模型常在 fenced 块里漏一个 }。只在末尾补，不猜中间。 */
function balanceBraces(text: string): string {
  let depth = 0;
  let inString = false;
  let lastNonSpace = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    if (!WHITESPACE.test(ch)) lastNonSpace = ch;
  }
  let out = text;
  if (lastNonSpace === ",") out = out.replace(/,\s*$/, "");
  for (let i = 0; i < depth; i++) out += "}";
  return out;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 尽最大努力把一段文本读成 JSON 值。修不好就如实说修不好，绝不编造。 */
export function parseLooseObject(raw: string): RepairResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null, ok: false, reason: "片段为空" };

  const fence = "\u0060\u0060\u0060";
  let unfenced = trimmed;
  if (unfenced.startsWith(fence)) {
    unfenced = unfenced.slice(3).replace(/^(?:json|javascript|js|xml|python)\s*/i, "");
  }
  if (unfenced.endsWith(fence)) unfenced = unfenced.slice(0, -3);
  const body = unfenced.trim().length > 0 ? unfenced.trim() : trimmed;

  const repaired = repairJsonText(body);

  // 顺序很重要：**修复版优先于原始版**。
  //
  // 反例：模型写 "E:\resources"（单反斜杠）。这份原文是**合法 JSON**，
  // JSON.parse 会成功并给出 「E:<CR>esources」—— 路径被静默改掉，而且因为
  // "解析成功"你永远看不到任何错误。repairJsonText 已经把它修成
  // "E:\\resources"，所以必须先试修复版。
  //
  // 只有修复版解析失败、而原始版能解析时才回落到原始版（那种情况说明
  // 原文本来就是对的，repairJsonText 的启发式这次没命中）。
  const attempts: string[] = [
    repaired,
    body,
    dropTrailingCommas(repaired),
    quoteBareKeys(dropTrailingCommas(repaired)),
    balanceBraces(quoteBareKeys(dropTrailingCommas(repaired))),
    balanceBraces(salvageQuotes(quoteBareKeys(dropTrailingCommas(repaired)))),
  ];

  let lastError = "未知错误";
  for (const candidate of attempts) {
    const direct = tryParse(candidate);
    if (direct.ok) {
      if (direct.value !== null && typeof direct.value === "object") return { value: direct.value, ok: true };
      return { value: direct.value, ok: false, reason: "解析结果不是对象" };
    }
    lastError = direct.error;
  }

  // 模型常在对象外面写解释，截取第一个 { ... } 再试一次
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = body.slice(start, end + 1);
    for (const candidate of [sliced, balanceBraces(repairJsonText(sliced))]) {
      const direct = tryParse(candidate);
      if (direct.ok && direct.value !== null && typeof direct.value === "object") {
        return { value: direct.value, ok: true };
      }
    }
  }

  return { value: null, ok: false, reason: "JSON 解析失败：" + lastError };
}

/* ------------------------------------------------------------------ *
 * 候选 → ParsedToolCall
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function htmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 从 <invoke name="x" a="1"> 这种开标签里取属性。 */
function tagAttributes(openTagText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null = re.exec(openTagText);
  while (match !== null) {
    const key = match[1];
    if (key !== undefined) out[key] = htmlUnescape(match[2] ?? match[3] ?? "");
    match = re.exec(openTagText);
  }
  return out;
}

const SCALAR_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function coerceScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (text.length > 0 && SCALAR_NUMBER.test(text)) {
    const num = Number(text);
    if (Number.isFinite(num)) return num;
  }
  return raw;
}

/** <parameter name="file_path">C:\Users</parameter> 逐个取出。 */
function xmlParameters(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const open = /<(?:parameter|arg|argument)\s+([^>]*?)(\/?)>/gi;
  const closeRe = /<\/(?:parameter|arg|argument)>/gi;
  let match: RegExpExecArray | null = open.exec(body);
  while (match !== null) {
    const attrs = tagAttributes(match[1] ?? "");
    const name = attrs.name ?? attrs.key ?? attrs.id;
    const selfClosing = (match[2] ?? "") === "/";
    if (name !== undefined && name.length > 0) {
      if (selfClosing) {
        out[name] = coerceScalar(attrs.value ?? "");
        match = open.exec(body);
        continue;
      }
      const bodyStart = match.index + match[0].length;
      closeRe.lastIndex = bodyStart;
      const close = closeRe.exec(body);
      if (close !== null) {
        out[name] = coerceScalar(htmlUnescape(body.slice(bodyStart, close.index)));
        open.lastIndex = close.index + close[0].length;
        match = open.exec(body);
        continue;
      }
      out[name] = coerceScalar(htmlUnescape(body.slice(bodyStart)));
      break;
    }
    match = open.exec(body);
  }
  return out;
}

const STRUCTURAL_TAGS = new Set([
  "name",
  "tool",
  "tool_name",
  "function",
  "function_name",
  "id",
  "arguments",
  "parameters",
]);

/** 把参数摊成子标签的写法：<file_path>a</file_path>。跳过结构性标签。 */
function childTagParameters(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /<([A-Za-z_][A-Za-z0-9_-]*)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    const key = match[1];
    const value = match[2] ?? "";
    if (key !== undefined && !STRUCTURAL_TAGS.has(key.toLowerCase())) {
      if (!/<(?:parameter|arg|argument)\s/i.test(value)) {
        out[key] = coerceScalar(htmlUnescape(value));
      }
    }
    match = re.exec(body);
  }
  return out;
}

interface CandidateOutcome {
  readonly call?: ParsedToolCall;
  readonly reason?: string;
}

function candidateFromJson(body: string, fallbackId: string): CandidateOutcome {
  const parsed = parseLooseObject(body);
  if (!parsed.ok) return { reason: parsed.reason ?? "JSON 解析失败" };
  const obj = asRecord(parsed.value);
  if (obj === null) return { reason: "解析结果不是对象" };

  const nested = asRecord(obj.function);
  const name = pickString(obj, ["name", "tool", "tool_name", "toolName"])
    ?? (nested === null ? null : pickString(nested, ["name"]));
  if (name === null) return { reason: "缺少 name 字段" };

  let args: Record<string, unknown> = {};
  const direct = obj.arguments ?? obj.parameters ?? obj.input ?? obj.args
    ?? (nested === null ? undefined : nested.arguments ?? nested.parameters);
  const asObj = asRecord(direct);
  if (asObj !== null) {
    args = { ...asObj };
  } else if (typeof direct === "string" && direct.trim().length > 0) {
    const inner = parseLooseObject(direct);
    const innerObj = inner.ok ? asRecord(inner.value) : null;
    if (innerObj !== null) args = { ...innerObj };
  } else {
    const copy: Record<string, unknown> = { ...obj };
    delete copy.id;
    delete copy.name;
    delete copy.tool;
    delete copy.tool_name;
    delete copy.toolName;
    delete copy.function;
    delete copy.type;
    args = copy;
  }

  const id = obj.id ?? obj.call_id ?? obj.tool_call_id;
  return {
    call: {
      id: typeof id === "string" && id.trim().length > 0 ? id.trim() : fallbackId,
      name,
      arguments: args,
    },
  };
}

function candidateFromXml(openTagText: string, body: string, fallbackId: string): CandidateOutcome {
  const attrs = tagAttributes(openTagText);
  let name = attrs.name ?? attrs.tool ?? attrs.function ?? null;

  const nameTag = /<name>([\s\S]*?)<\/name>/i.exec(body)
    ?? /<tool_name>([\s\S]*?)<\/tool_name>/i.exec(body)
    ?? /<function_name>([\s\S]*?)<\/function_name>/i.exec(body);
  if ((name === null || name.length === 0) && nameTag !== null) {
    name = htmlUnescape(nameTag[1] ?? "").trim();
  }
  if (name === null || name.length === 0) return { reason: "缺少 name 属性" };

  let args: Record<string, unknown> = {};
  const paramBlock = /<parameters>([\s\S]*?)<\/parameters>/i.exec(body);
  if (paramBlock !== null) {
    const inner = parseLooseObject(paramBlock[1] ?? "");
    const innerObj = inner.ok ? asRecord(inner.value) : null;
    if (innerObj !== null) args = { ...innerObj };
  }
  if (Object.keys(args).length === 0) args = xmlParameters(body);
  if (Object.keys(args).length === 0) args = childTagParameters(body);
  if (Object.keys(args).length === 0) {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "name" || key === "tool" || key === "function" || key === "id") continue;
      copy[key] = value;
    }
    args = copy;
  }

  const id = attrs.id;
  return {
    call: {
      id: id !== undefined && id.trim().length > 0 ? id.trim() : fallbackId,
      name,
      arguments: args,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 流式解析器
 * ------------------------------------------------------------------ */

interface ConsumeOutcome {
  readonly call?: ParsedToolCall;
  readonly reason?: string;
}

/**
 * 增量解析器。每收到一段 delta 调一次 feed，流结束调一次 flush。
 *
 * 内部只保留「可能是标记开头」的那一小段尾巴，其余正文立刻返回 —— hold-back 不会拖慢首字。
 */
export class ToolCallStreamParser {
  private buffer = "";
  private index: number;
  private truncated = false;

  constructor(options: ParseOptions = {}) {
    this.index = options.startIndex ?? 1;
  }

  feed(delta: string): ParsedOutput {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): ParsedOutput {
    return this.drain(true);
  }

  private nextId(): string {
    const id = "call_" + this.index;
    this.index += 1;
    return id;
  }

  private drain(final: boolean): ParsedOutput {
    let text = "";
    const toolCalls: ParsedToolCall[] = [];
    const unparsed: UnparsedToolCandidate[] = [];

    const record = (raw: string, family: Family, outcome: ConsumeOutcome, unterminated: boolean): void => {
      if (outcome.call !== undefined) {
        toolCalls.push(outcome.call);
        return;
      }
      // 解析失败：原文回到正文，绝不静默丢弃
      text += raw;
      unparsed.push({
        raw,
        family,
        reason:
          (unterminated ? "标记没有闭合，而且" : "") +
          (outcome.reason ?? "无法解析") +
          "。这段内容已原样保留在正文里。",
      });
    };

    for (;;) {
      const open = findOpenTag(this.buffer, 0);
      if (open === null) {
        if (final) {
          text += this.buffer;
          this.buffer = "";
          break;
        }
        const hold = partialOpenSuffix(this.buffer);
        if (hold > 0) {
          text += this.buffer.slice(0, this.buffer.length - hold);
          this.buffer = this.buffer.slice(this.buffer.length - hold);
        } else {
          text += this.buffer;
          this.buffer = "";
        }
        break;
      }

      text += this.buffer.slice(0, open.index);
      this.buffer = this.buffer.slice(open.index);

      const markerEnd = this.buffer.indexOf(">");
      if (markerEnd < 0) {
        if (!final) {
          // 开标签自己还没收完 —— 整段 hold
          break;
        }
        this.truncated = true;
        const raw = this.buffer;
        this.buffer = "";
        record(raw, open.family, { reason: "开标签不完整" }, true);
        break;
      }

      const selfClosing = open.family === "xml" && this.buffer[markerEnd - 1] === "/";
      if (selfClosing) {
        const raw = this.buffer.slice(0, markerEnd + 1);
        this.buffer = this.buffer.slice(markerEnd + 1);
        record(raw, open.family, candidateFromXml(raw, "", this.nextId()), false);
        continue;
      }

      const bodyStart = markerEnd + 1;
      const close = findCloseTag(this.buffer, bodyStart, open.tag);
      if (close === null) {
        if (!final) {
          const hold = partialCloseSuffix(this.buffer, open.tag);
          if (hold > 0) {
            text += this.buffer.slice(0, this.buffer.length - hold);
            this.buffer = this.buffer.slice(this.buffer.length - hold);
          }
          break;
        }
        this.truncated = true;
        const raw = this.buffer;
        this.buffer = "";
        const openTagText = raw.slice(0, bodyStart);
        const body = raw.slice(bodyStart);
        const outcome = open.family === "xml"
          ? candidateFromXml(openTagText, body, this.nextId())
          : candidateFromJson(body, this.nextId());
        record(raw, open.family, outcome, true);
        break;
      }

      const raw = this.buffer.slice(0, close.index + close.tag.length);
      this.buffer = this.buffer.slice(close.index + close.tag.length);
      const openTagText = raw.slice(0, bodyStart);
      const body = raw.slice(bodyStart, close.index);
      const outcome = open.family === "xml"
        ? candidateFromXml(openTagText, body, this.nextId())
        : candidateFromJson(body, this.nextId());
      record(raw, open.family, outcome, false);
    }

    return {
      text,
      toolCalls,
      unparsed,
      pending: final ? "" : this.buffer,
      balanced: final ? !this.truncated && this.buffer.length === 0 : true,
    };
  }
}

/** 一次性便捷入口：整段正文进来，结果出去。 */
export function parseToolCalls(text: string, options: ParseOptions = {}): ParsedOutput {
  const parser = new ToolCallStreamParser(options);
  const first = parser.feed(text);
  const second = parser.flush();
  return {
    text: first.text + second.text,
    toolCalls: [...first.toolCalls, ...second.toolCalls],
    unparsed: [...first.unparsed, ...second.unparsed],
    pending: "",
    balanced: first.balanced && second.balanced,
  };
}

/** 只判断「这段文本里有没有像工具调用的东西」，给未执行检测用。 */
export function looksLikeToolCall(text: string): boolean {
  if (findOpenTag(text, 0) !== null) return true;
  return /"tool_calls"\s*:|"tool_call"\s*:/u.test(text);
}
