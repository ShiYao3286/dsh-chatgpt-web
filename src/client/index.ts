/**
 * 浏览器侧入口：把 ChatGPT Web 的设置卡片注册进 DSH 设置面板。
 *
 * 注册形态与官方 settings 插件一致：
 *   ctx.effect(() => ctx.locale.register(NS, { zh, en }), ...)
 *   ctx.effect(() => ctx.configForms.whileServed([NS_HOST], () =>
 *     ctx.slots.inject("plugins.item", () => ctx.slots.register({...}, Card))))
 *
 * whileServed 是关键：Host 侧没有提供这个命名空间时，这里什么都不挂。
 */

import { NS, zh, en } from "./locales.ts";
import { createCard } from "./card.tsx";
import { FIELDS } from './fields.ts';
// Resolved lexically by the host ModuleLoader factory, not a nonexistent global require.
declare const require: (name: string) => unknown;

export interface FormModel {
  bind: (project: () => Record<string, unknown>) => unknown;
  shell: () => Record<string, unknown>;
  field: (key: string) => unknown;
  actions: () => Record<string, unknown>;
  dispose: () => void;
}
export function createController(scope: unknown, primitives: Record<string, unknown>) {
  const Model = primitives.SettingsFormModel as new (scope: unknown, fields: unknown[]) => FormModel;
  const number = primitives.settingsNumberField as (key: string) => unknown;
  const text = primitives.settingsTextField as (key: string) => unknown;
  const form = new Model(scope, FIELDS.map(field => (field.kind === 'number' ? number : text)(field.key)));
  const store = form.bind(() => ({ ...form.shell(), ...Object.fromEntries(FIELDS.map(field => [field.key, form.field(field.key)])), authStatus: 'unchecked' }));
  return { inject: () => ({ hooks: { chatGptWebCard: store }, ...form.actions() }), dispose: () => form.dispose() };
}

export { NS, zh, en };
export const inject = ["slots", "locale", "configForms"];

/** Host 侧 settings 命名空间（与 src/index.ts 注册的一致）。 */
export const HOST_SETTINGS_NS = "dsh-chatgpt-web";

export const SLOT_ID = "chatgpt-web";
export const SLOT_ORDER = 40;

export interface ClientContext {
  locale: {
    bind: (ns: string) => (key: string) => string;
    register: (ns: string, dict: Record<string, unknown>) => void;
  };
  configForms: {
    get: (ns: string) => { subscribe: (listener: () => void) => () => void; getSnapshot: () => { value: Record<string, unknown> } };
    whileServed: (ns: readonly string[], fn: () => void) => (() => void) | void;
  };
  slots: {
    inject: (name: string, fn: () => unknown) => unknown;
    register: (def: Record<string, unknown>, component: unknown) => unknown;
  };
  effect: (fn: () => unknown, label?: string) => void;
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-chatgpt-web: dictionaries");

  const card = createController(ctx.configForms.get(HOST_SETTINGS_NS), require('@deepseek-ai/dsh-client-ui-primitives') as Record<string, unknown>);
  const Card = createCard(require);
  ctx.effect(() => () => card.dispose(), 'ui-settings-chatgpt-web: form subscription');

  ctx.effect(
    () =>
      ctx.configForms.whileServed([HOST_SETTINGS_NS], () =>
        ctx.slots.inject("plugins.item", () =>
          ctx.slots.register(
            {
              name: "plugins.item",
              id: SLOT_ID,
              order: SLOT_ORDER,
              label: () => t("title"),
              locale: NS,
              inject: () => card.inject(),
            },
            Card,
          ),
        ),
      ),
    "ui-settings-chatgpt-web: page",
  );
}