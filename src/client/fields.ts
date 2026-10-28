/**
 * 设置卡片的控制器：把 settings 命名空间桥接到 DSH 的分段表单模型。
 *
 * 只做一件事 —— 声明有哪些字段、默认值多少、怎么投影给 React 组件。
 * 真正的读写由 Host 侧的 configForms 负责，所以这里不碰磁盘。
 */

export interface FieldSpec {
  readonly key: string;
  readonly kind: "number" | "enum" | "text";
  /** enum 时的可选值。 */
  readonly options?: readonly string[];
}

/** 面板上暴露的字段，顺序即渲染顺序。 */
export const FIELDS: readonly FieldSpec[] = [
  { key: "transport", kind: "enum", options: ["node"] },
  { key: "webModel", kind: "text" },
  { key: "softTurns", kind: "number" },
  { key: "hardTurns", kind: "number" },
  { key: "minIntervalMs", kind: "number" },
  { key: "maxIntervalMs", kind: "number" },
  { key: "rateMaxInWindow", kind: "number" },
  { key: "catalogBudgetChars", kind: "number" },
  { key: "devtoolsPort", kind: "number" },
];

/** 面板默认值，与 Host 侧 DEFAULT_CONFIG 保持一致。 */
export const FIELD_DEFAULTS: Readonly<Record<string, unknown>> = {
  transport: "node",
  webModel: "auto",
  softTurns: 25,
  hardTurns: 40,
  minIntervalMs: 4000,
  maxIntervalMs: 9000,
  rateMaxInWindow: 12,
  catalogBudgetChars: 24000,
  devtoolsPort: 9222,
};

/** 把一组纯字段声明投影成表单组件需要的 props 形状（纯函数，可离线测试）。 */
export function fieldProps(field: FieldSpec, value: unknown, disabled: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: "plugin-config-chatgpt-web-" + field.key,
    disabled,
    value: value === undefined ? FIELD_DEFAULTS[field.key] : value,
    numeric: field.kind === "number",
  };
  if (field.kind === "enum") base.options = field.options ?? [];
  return base;
}

/** 表单是否应当可编辑：未加载或只读时为 false。 */
export function editable(writable: boolean, saving: boolean): boolean {
  return writable && !saving;
}
