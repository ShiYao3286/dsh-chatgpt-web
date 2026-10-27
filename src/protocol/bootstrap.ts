/**
 * 初始化提示词的渲染。
 *
 * 这是每开一个新网页会话（或轮换后）时，随第一问一起发过去的那段固定文本。
 *
 * 两条硬约束：
 *
 *   1. **幂等**：同样的输入必须逐字节得到同样的输出。它会参与 binding 层的 headHash 计算
 *      （见 src/binding/state.ts 的 headHashOf），一旦两次渲染出现差异，每一轮都会被判成
 *      head-changed 而触发无限轮换。所以这里不出现时间戳、随机数、Map 迭代顺序、平台换行符。
 *   2. **说清楚「工具调用是你唯一的行动手段」**：网页端模型没有函数调用通道，如果它以为
 *      自己能直接改文件，就会只在正文里写「我来改」，磁盘上什么都没发生。
 *
 * 站内已有的能力（联网搜索、画图、代码解释器）**不进**这段文本 —— 那些交给网页端自己，
 * 写进来只会诱导模型对着不存在的工具发 tool_call。工具清单的裁剪与「被省略的工具名」
 * 由 catalog.ts 负责，这里只负责把渲染结果嵌进固定结构里。
 */

import { renderToolCatalog } from "./catalog.ts";
import type { CatalogTool, CatalogRender } from "./catalog.ts";

/** 协议版本。任何会改变 headHash 的措辞调整都要递增。 */
export const PROTOCOL_VERSION = 1;

const BT = "\u0060";

/** 正文里禁止出现的工具名：站内已经有等价能力。 */
export const EXCLUDED_TOOL_NAMES: readonly string[] = [
  "web_search",
  "web_fetch",
  "image_generation",
  "image_generate",
  "python",
  "python_exec",
  "code_interpreter",
  "computer",
  "browser",
];

const CALL_EXAMPLE = [
  BT + BT + BT + "text",
  "<tool_call>",
  "{\"name\": \"工具名\", \"arguments\": {\"参数名\": 值}}",
  "</tool_call>",
  BT + BT + BT,
].join("\n");

/** 调用协议的措辞。单独导出，方便 re-anchor 时复用同一份说法。 */
export const TOOL_CALL_PROTOCOL: string = [
  "## 工具调用协议",
  "",
  "工具调用是你**唯一的行动手段**。你没有别的通道能改变外部世界：正文里的描述、承诺、",
  "代码片段都不会被执行，只有下面这种标记会被真正执行。",
  "",
  "一次调用写成一个块，可以有多个：",
  "",
  CALL_EXAMPLE,
  "",
  "规则：",
  "",
  "1. 标记必须写成 " + BT + "<tool_call>" + BT + " … " + BT + "</tool_call>" + BT +
    "，中间是**一个** JSON 对象，字段是 name 与 arguments。",
  "2. arguments 必须是合法 JSON 对象：字符串用双引号，字符串里的反斜杠必须写成两个" +
    "（Windows 路径要写成 C:" + "\\\\Users\\\\me 这种转义形式）。",
  "3. 参数值里**不要写注释、不要写省略号、不要用单引号**。不确定参数就少传，不要猜。",
  "4. 需要多个动作就发多个 " + BT + "<tool_call>" + BT + "，不要把它们塞进一个数组里。",
  "5. 调用之后**停下来等结果**。结果会以工具结果的形式回到你面前，再决定下一步。",
  "6. 不要伪造工具结果，也不要在标记外面再包一层解释性的包装。",
  "",
  "调用失败或参数不合法时，你会收到一条明确的错误。那时候请修正参数重发，不要假装已经成功。",
].join("\n");

export interface BootstrapEnv {
  /** 插件/路由标识，例如 chatgpt-web。 */
  readonly provider: string;
  /** 模型标识，例如 chatgpt-web/chatgpt-free。 */
  readonly model: string;
  /** 会话工作目录（绝对路径）。没有就传空串。 */
  readonly cwd: string;
  /** 平台描述，例如 Windows / macOS / Linux。 */
  readonly platform: string;
  /** 当前日期，ISO 日期（YYYY-MM-DD）。由调用方传入，渲染本身不读时钟。 */
  readonly today: string;
  /** 会话 id 的短前缀，用于让模型区分会话。可为空串。 */
  readonly sessionId?: string;
  /** 额外环境条目，按给定顺序渲染。 */
  readonly extra?: readonly { readonly key: string; readonly value: string }[];
}

export interface RenderBootstrapInput {
  readonly env: BootstrapEnv;
  /** 本轮可用的工具声明。 */
  readonly tools: readonly CatalogTool[];
  /** 工具目录的字符预算。 */
  readonly catalogBudgetChars: number;
  /** 是否渲染参数签名。默认 true。 */
  readonly includeParameters?: boolean;
  /** 额外排除的工具名（会与 EXCLUDED_TOOL_NAMES 合并）。 */
  readonly excludeTools?: readonly string[];
  /** Host-declared tools remain authoritative, including browser/search names. */
  readonly includeHostTools?: boolean;
}

export interface BootstrapRender {
  /** 完整正文。同一份输入必然逐字节相同。 */
  readonly text: string;
  /** 工具目录的渲染结果，供上层诊断「哪些工具被裁剪了」。 */
  readonly catalog: CatalogRender;
  readonly protocolVersion: number;
}

function clean(value: string): string {
  // 只归一换行与首尾空白，保证正文不会因为调用方传了 CRLF 而出现平台差异
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
}

/**
 * 渲染初始化提示词。
 *
 * 输出只依赖入参：不读时钟、不读环境变量、不用随机数 —— 这是它能参与 headHash 的前提。
 */
export function renderBootstrap(input: RenderBootstrapInput): BootstrapRender {
  const exclude = [...(input.includeHostTools ? [] : EXCLUDED_TOOL_NAMES), ...(input.excludeTools ?? [])];
  const catalog = renderToolCatalog(input.tools, {
    budgetChars: input.catalogBudgetChars,
    includeParameters: input.includeParameters !== false,
    exclude,
  });

  const env = input.env;
  const envLines: string[] = [
    "- 路由：" + clean(env.provider) + " / " + clean(env.model),
    "- 平台：" + clean(env.platform),
  ];
  if (clean(env.cwd).length > 0) envLines.push("- 工作目录：" + clean(env.cwd));
  if (clean(env.today).length > 0) envLines.push("- 今天：" + clean(env.today));
  if (env.sessionId !== undefined && clean(env.sessionId).length > 0) {
    envLines.push("- 会话：" + clean(env.sessionId));
  }
  for (const item of env.extra ?? []) {
    envLines.push("- " + clean(item.key) + "：" + clean(item.value));
  }

  const sections: string[] = [
    [
      "你是 DeepSeek Harness（DSH）里的一名执行型助手，这个会话通过 chatgpt.com 网页端接入。",
      "你面对的是一个真实工作区和一个会真正执行动作的工具系统：你发出的工具调用会被执行，",
      "执行结果会回到你面前。请把它当成一次真实的工程任务，而不是一次闲聊。",
    ].join("\n"),

    ["## 当前环境", "", ...envLines].join("\n"),

    [
      "## 能力边界（很重要）",
      "",
      "- **你没有文件系统访问权，除非通过下列工具。** 你不能直接读、写、改、删任何文件。",
      "- **你不能直接执行代码或命令，除非通过下列工具。** 你脑子里过一遍不算跑过。",
      "- 你不能直接修改任何文件：没有工具调用就没有改动。",
      "- 你没有跨会话的持久记忆，除非工具把内容读出来给你。",
      "- **工具调用是你唯一的行动手段。** 正文里写「我已经改好了」「我来运行一下」，",
      "  如果没有对应的工具调用，那就是什么都没发生 —— 系统会据此判定本轮未执行。",
      "- 网页端自带的联网搜索、画图等能力不属于本协议，不要为它们发工具调用。",
      "",
      "反过来：需要读文件、改文件、跑命令时，**不要只描述，直接发工具调用**。",
    ].join("\n"),

    ["## 工具", "", catalog.text.trimEnd()].join("\n"),

    TOOL_CALL_PROTOCOL,

    [
      "## 结束一轮的约定",
      "",
      "- 任务做完：直接用正文给出结果。说清楚**你实际做了什么**（哪些调用成功了），",
      "  以及**哪些没做、没验证**。不要把没做的事写成做完了。",
      "- 需要用户拿主意：停下来提问，把选项和各自代价写清楚，不要自己替用户选。",
      "- 被工具报错挡住：如实说明错误原文与你的判断，不要伪造成功。",
      "- 一轮里可以连续多次调用工具；每次拿到结果后再决定下一步。",
      "- 不要在正文里输出 JSON 形式的「计划」来代替调用 —— 计划不会被执行。",
    ].join("\n"),
  ];

  return {
    text: sections.join("\n\n") + "\n",
    catalog,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * 会话续接时的短提醒（re-anchor 动作使用，成本远低于整轮轮换）。
 *
 * 同样必须幂等。
 */
export function renderReanchor(catalog: CatalogRender): string {
  const lines: string[] = [
    "<protocol_reminder>",
    "提醒（不是新任务）：工具调用仍然是你唯一的行动手段。",
    "格式：" + BT + "<tool_call>{\"name\": \"工具名\", \"arguments\": {...}}</tool_call>" + BT,
    "没有发出调用就声称「已修改」「已执行」，会被判定为本轮未执行。",
  ];
  if (catalog.trimmed) {
    const names = catalog.nameOnly.map((name) => BT + name + BT).join(", ");
    lines.push("本轮有 " + catalog.nameOnly.length + " 个工具只保留了名字、没加载参数签名：" + names + "。不要猜它们的参数。");
  }
  lines.push("</protocol_reminder>");
  return lines.join("\n") + "\n";
}
