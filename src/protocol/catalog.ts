/**
 * 工具目录渲染 —— 把 DSH 的工具声明压成网页端模型能读、并且**不会悄悄少掉东西**的一段文本。
 *
 * 背景：dsh-deepseek-web-login 在 61 个工具上按预算静默砍掉了 26 个，模型以为那些工具不存在，
 * 于是凭空编参数。本模块的判据是：
 *   1. 装得下 → 全部工具连参数签名一起列出来。
 *   2. 装不下 → 一部分工具保留完整签名，**剩下的每一个都至少保留名字**，并在正文里明确写
 *      「参数未加载、不要猜参数」。名字列表本身也参与预算；如果连名字都放不下，宁可超预算
 *      也要把名字写全，并把 overBudget 置为 true —— 超预算可以被看见，静默丢失不行。
 *
 * 字符预算按字符串的 UTF-16 码元计（即 `text.length`），与本仓库其它长度判据口径一致。
 * 渲染是纯函数：同一份输入必然逐字节得到同一份输出（它参与 headHash 计算）。
 */

/** DSH 工具声明的结构子集。多余字段一律忽略，渲染只依赖 name / description / parameters。 */
export interface CatalogTool {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema。用 unknown 接住，运行时再收窄 —— 免得和 DSH 的 schema 类型强耦合。 */
  readonly parameters?: unknown;
}

export interface RenderCatalogOptions {
  /** 字符预算（UTF-16 码元）。 */
  readonly budgetChars: number;
  /** 是否渲染参数签名。默认 true。 */
  readonly includeParameters?: boolean;
  /** 单个工具的签名最长多少字符，超出用 … 收尾。默认 120。 */
  readonly maxSignatureChars?: number;
  /** 单个工具的描述最长多少字符，超出用 … 收尾。默认 72。 */
  readonly maxDescriptionChars?: number;
  /**
   * 站内已经有等价能力、因而不进协议清单的工具名。
   * 这些名字**不写进正文**（写出来只会诱导模型对着它们发 <tool_call>），
   * 但会出现在返回值的 excluded 里，方便诊断。
   */
  readonly exclude?: readonly string[];
}

export interface CatalogRender {
  /** 渲染出来的正文，末尾带一个换行。 */
  readonly text: string;
  /** text 的 UTF-16 长度。 */
  readonly chars: number;
  readonly budgetChars: number;
  /** 连「全部只列名字」都放不下 —— 已经牺牲预算保住名字，必须让调用方看见。 */
  readonly overBudget: boolean;
  /** 真正的工具总数（不含 exclude）。 */
  readonly total: number;
  /** 附完整参数签名的工具名，按输入顺序。 */
  readonly detailed: readonly string[];
  /** 只保留名字（参数未加载）的工具名，按输入顺序。 */
  readonly nameOnly: readonly string[];
  /** 被 exclude 排除的工具名，按输入顺序。 */
  readonly excluded: readonly string[];
  /** 是否发生了裁剪（nameOnly 非空）。 */
  readonly trimmed: boolean;
}

const DEFAULT_MAX_SIGNATURE_CHARS = 120;
const DEFAULT_MAX_DESCRIPTION_CHARS = 72;
const MAX_ENUM_CHARS = 48;
const MAX_TYPE_DEPTH = 4;

interface SchemaLike {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  enum?: unknown;
  items?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
}

function asSchema(value: unknown): SchemaLike | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SchemaLike;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function typeLabel(schema: SchemaLike, depth: number): string | null {
  if (depth > MAX_TYPE_DEPTH) return null;
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    for (const member of union) {
      const inner = asSchema(member);
      if (inner === null) continue;
      const label = typeLabel(inner, depth + 1);
      if (label !== null) return label;
    }
  }
  const values = schema.enum;
  if (Array.isArray(values) && values.length > 0 && values.length <= 6) {
    const simple = values.every(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (simple) {
      const rendered = values.map((v) => JSON.stringify(v)).join("|");
      if (rendered.length <= MAX_ENUM_CHARS) return rendered;
    }
  }
  if (schema.type === "array") {
    const items = asSchema(schema.items);
    const inner = items === null ? null : typeLabel(items, depth + 1);
    return inner === null ? "array" : inner + "[]";
  }
  if (typeof schema.type === "string") return schema.type;
  return null;
}

/** `read(file_path: string, offset?: number)` 里的括号部分。没有 schema 时返回空串。 */
function signatureOf(tool: CatalogTool, includeParameters: boolean, maxChars: number): string {
  if (!includeParameters) return "";
  const schema = asSchema(tool.parameters);
  if (schema === null) return "";
  const properties = asRecord(schema.properties);
  if (properties === null) return "";
  const required = new Set<string>();
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string") required.add(key);
    }
  }
  const parts: string[] = [];
  let used = 0;
  for (const key of Object.keys(properties)) {
    const propSchema = asSchema(properties[key]);
    const label = propSchema === null ? null : typeLabel(propSchema, 0);
    const name = required.has(key) ? key : key + "?";
    const piece = label === null ? name : name + ": " + label;
    const separator = parts.length === 0 ? 0 : 2;
    if (used + separator + piece.length > Math.max(8, maxChars)) {
      parts.push("…");
      break;
    }
    parts.push(piece);
    used += separator + piece.length;
  }
  return parts.join(", ");
}

/** 描述压成一行。空白折叠，超长截断并留 …。 */
function oneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function prepare(
  tools: readonly CatalogTool[],
  options: RenderCatalogOptions,
): { detailed: string[]; names: string[] } {
  const includeParameters = options.includeParameters !== false;
  const maxSignature = options.maxSignatureChars ?? DEFAULT_MAX_SIGNATURE_CHARS;
  const maxDescription = options.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
  const detailed: string[] = [];
  const names: string[] = [];
  for (const tool of tools) {
    const name = tool.name;
    names.push(name);
    const signature = signatureOf(tool, includeParameters, maxSignature);
    const head = signature.length === 0 ? "- `" + name + "`" : "- `" + name + "(" + signature + ")`";
    const description =
      typeof tool.description === "string" && tool.description.trim().length > 0
        ? oneLine(tool.description, maxDescription)
        : "";
    detailed.push(description.length === 0 ? head : head + " — " + description);
  }
  return { detailed, names };
}

export class CatalogBudgetError extends RangeError {
  constructor(budgetChars: number) {
    super("工具目录预算必须是非负有限数，收到 " + String(budgetChars));
    this.name = "CatalogBudgetError";
  }
}

/**
 * 渲染工具目录。
 *
 * @param tools 工具声明，保持调用方给的顺序 —— 裁剪时从尾部往前丢，所以调用方应按重要度排序。
 * @param options 预算与渲染选项。
 */
export function renderToolCatalog(
  tools: readonly CatalogTool[],
  options: RenderCatalogOptions,
): CatalogRender {
  const budget = options.budgetChars;
  if (!Number.isFinite(budget) || budget < 0) throw new CatalogBudgetError(budget);

  const exclude = new Set<string>();
  for (const name of options.exclude ?? []) exclude.add(name);

  const kept: CatalogTool[] = [];
  const excluded: string[] = [];
  for (const tool of tools) {
    if (exclude.has(tool.name)) {
      excluded.push(tool.name);
      continue;
    }
    kept.push(tool);
  }

  const prepared = prepare(kept, options);
  const count = kept.length;

  const assemble = (detailedCount: number): string => {
    const lines: string[] = [];
    if (count === 0) {
      lines.push("工具目录：本轮没有任何工具可用。需要动文件或执行命令时，先说明你需要什么，等用户开启。");
      return lines.join("\n") + "\n";
    }
    if (detailedCount === count) {
      lines.push("工具目录：共 " + count + " 个工具，全部附完整参数签名。");
    } else {
      lines.push(
        "工具目录：共 " +
          count +
          " 个工具。" +
          detailedCount +
          " 个附完整参数签名，" +
          (count - detailedCount) +
          " 个只保留名字。",
      );
    }
    if (detailedCount > 0) {
      lines.push("");
      lines.push("有完整参数签名的工具：");
      for (let i = 0; i < detailedCount; i++) {
        const line = prepared.detailed[i];
        if (line !== undefined) lines.push(line);
      }
    }
    if (detailedCount < count) {
      lines.push("");
      lines.push(
        "只保留名字的工具（本轮**没有加载它们的参数签名**，不要猜参数；要调用先说明用途并等确认）：",
      );
      const names: string[] = [];
      for (let i = detailedCount; i < count; i++) {
        const name = prepared.names[i];
        if (name !== undefined) names.push("`" + name + "`");
      }
      lines.push(names.join(", "));
      lines.push("");
      lines.push("只出现名字不代表可以照旧调用：没有签名就没有参数，猜出来的参数一律按错误处理。");
    }
    return lines.join("\n") + "\n";
  };

  let detailedCount = count;
  let text = assemble(detailedCount);
  if (text.length > budget) {
    let low = 0;
    let high = count - 1;
    let best = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = assemble(mid);
      if (candidate.length <= budget) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    detailedCount = best < 0 ? 0 : best;
    text = assemble(detailedCount);
  }

  const detailedNames: string[] = [];
  const nameOnly: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = kept[i]?.name;
    if (name === undefined) continue;
    if (i < detailedCount) detailedNames.push(name);
    else nameOnly.push(name);
  }

  return {
    text,
    chars: text.length,
    budgetChars: budget,
    overBudget: text.length > budget,
    total: count,
    detailed: detailedNames,
    nameOnly,
    excluded,
    trimmed: nameOnly.length > 0,
  };
}
