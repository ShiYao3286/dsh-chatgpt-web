/**
 * 设置卡片组件（React）。
 *
 * 这里刻意写得很薄：所有可测的逻辑都在 fields.ts / locales.ts 里，
 * 这个文件只负责把字段铺成 DSH 的表单组件。
 *
 * 依赖 @deepseek-ai/dsh-client-ui-primitives —— 它由宿主提供，不在本包的 node_modules 里，
 * 所以用 require 取而不是 import（与官方 settings 插件一致）。
 */

import { FIELDS, fieldProps, editable } from "./fields.ts";

export interface CardProps {
  readonly t: (key: string) => string;
  /** 'summary' 时只渲染一句话（插件列表用）。 */
  readonly view?: "summary" | "form";
  readonly state: Record<string, unknown>;
  readonly save: () => void;
  readonly discard: () => void;
  readonly edit: (key: string, text: string) => void;
  readonly resetField: (key: string) => void;
}

/** 取值：优先表单快照，其次默认值。 */
function snapshotValue(state: Record<string, unknown>, key: string): unknown {
  const field = state[key];
  if (field !== null && typeof field === "object") {
    const box = field as Record<string, unknown>;
    if (typeof box.text === "string") return box.text;
    if (box.value !== undefined) return box.value;
  }
  return state[key];
}

export function buildFieldProps(props: CardProps) {
  const disabled = !editable(props.state.writable !== false, props.state.saving === true);
  return FIELDS.map((field) => {
    const p = fieldProps(field, snapshotValue(props.state, field.key), disabled);
    return {
      ...p,
      label: props.t(field.key),
      hint: props.t(field.key + "Hint"),
      overriddenLabel: props.t("overridden"),
      resetLabel: props.t("reset"),
      invalidLabel: props.t("invalidNumber"),
      onEdit: (text: string) => props.edit(field.key, text),
      onReset: () => props.resetField(field.key),
    };
  });
}

/** 摘要视图：插件列表里显示的一句话。 */
export function summaryOf(props: CardProps): string {
  return props.t("description");
}

/**
 * 真正的组件。用 require 拿宿主提供的 primitives，避免构建期解析不到。
 */
export function createCard(requirePrimitives: (name: string) => unknown) {
  const prim = requirePrimitives("@deepseek-ai/dsh-client-ui-primitives") as Record<string, unknown>;
  const React = requirePrimitives("react") as { createElement: (...a: unknown[]) => unknown };
  const SettingsForm = prim.SettingsForm as (...a: unknown[]) => unknown;
  const SettingsValueField = prim.SettingsValueField as (...a: unknown[]) => unknown;

  return function ChatGptWebCard(props: CardProps) {
    if (props.view === "summary") return summaryOf(props);
    const fields = buildFieldProps(props);
    return React.createElement(SettingsForm, {
      labels: {
        unavailable: props.t("unavailable"),
        readOnly: props.t("readOnly"),
        saveFailed: props.t("saveFailed"),
        save: props.t("save"),
        saving: props.t("saving"),
      },
      state: props.state,
      onSave: props.save,
      onDiscard: props.discard,
    }, ...fields.map((f) => React.createElement(SettingsValueField, f)));
  };
}