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

export { NS, zh, en };
export const inject = ["slots", "locale", "configForms"];

/** Host 侧 settings 命名空间（与 src/index.ts 注册的一致）。 */
export const HOST_SETTINGS_NS = "chatgpt-web";

export const SLOT_ID = "chatgpt-web";
export const SLOT_ORDER = 40;

interface ClientContext {
  locale: {
    bind: (ns: string) => (key: string) => string;
    register: (ns: string, dict: Record<string, unknown>) => void;
  };
  configForms: {
    get: (ns: string) => unknown;
    whileServed: (ns: readonly string[], fn: () => void) => void;
  };
  slots: {
    inject: (name: string, fn: () => void) => void;
    register: (def: Record<string, unknown>, component: unknown) => void;
  };
  effect: (fn: () => unknown, label?: string) => void;
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-chatgpt-web: dictionaries");

  // require 由模块加载器注入；primitives 与 react 都由宿主提供。
  const requireFn = (globalThis as { __ModuleLoader__?: { require?: (n: string) => unknown } }).__ModuleLoader__?.require;
  const Card = createCard((name: string) => {
    if (typeof requireFn === "function") return requireFn(name);
    throw new Error("缺少模块加载器，无法解析 " + name);
  });

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
              inject: () => ({ hooks: {} }),
            },
            Card,
          ),
        ),
      ),
    "ui-settings-chatgpt-web: page",
  );
}