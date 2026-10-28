/** Register the settings section unconditionally; missing host config remains visible. */

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
export function createController(scope: unknown, primitives: Record<string, unknown>, status?: () => Promise<{ authStatus: string }>) {
  let authStatus = 'unchecked';
  let alive = true;
  const Model = primitives.SettingsFormModel as new (scope: unknown, fields: unknown[]) => FormModel;
  const number = primitives.settingsNumberField as (key: string) => unknown;
  const text = primitives.settingsTextField as (key: string) => unknown;
  const form = new Model(scope, FIELDS.map(field => (field.kind === 'number' ? number : text)(field.key)));
  const project = () => ({ ...form.shell(), ...Object.fromEntries(FIELDS.map(field => [field.key, form.field(field.key)])), authStatus });
  const store = form.bind(project) as { set(value: unknown): void };
  status?.().then(value => {
    if (alive && ['missing', 'expired', 'unchecked'].includes(value.authStatus)) { authStatus = value.authStatus; store.set(project()); }
  }).catch(() => undefined);
  return { inject: () => ({ hooks: { chatGptWebCard: store }, ...form.actions() }), dispose: () => { alive = false; form.dispose(); } };
}

export { NS, zh, en };
/**
 * Required services only.
 *
 * `remote` itself must be declared: Cordis reads `ctx.remote` through an
 * inject-gated accessor and throws "cannot get property \"remote\" without
 * inject" when the fiber did not declare it.
 *
 * `remote.chatGptWebStatus` must NOT appear here. The Client Remote namespaces
 * are mounted from compile-time `/remote` contributions that
 * `@deepseek-ai/dsh-api-remotes` enumerates statically, so a Host-side
 * `TypertRemoteService` alone never creates `ctx.remote.<name>` in the browser.
 * Declaring that namespace as an inject made this entry pending forever and the
 * whole Web boot aborted with "1 entry did not activate" — the entire UI stayed
 * on the failure screen. The card now reads the auth status opportunistically
 * and degrades to `unchecked`.
 */
export const inject = ["slots", "locale", "configForms", "remote"];

/** Host 侧 settings 命名空间（与 src/index.ts 注册的一致）。 */
export const HOST_SETTINGS_NS = "dsh-chatgpt-web";

export const SLOT_ID = "chatgpt-web";
export const SLOT_ORDER = 40;

export interface ClientContext {
  /**
   * The Client Remote table. `remote` itself always exists, but a
   * `remote.<namespace>` service is mounted only from a compile-time
   * contribution, so every namespace read below is optional.
   */
  remote?: Record<string, { status?: () => Promise<{ authStatus: string }> } | undefined>;
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

/** Read the Host auth status when (and only when) the namespace is mounted. */
function optionalStatus(ctx: ClientContext): (() => Promise<{ authStatus: string }>) | undefined {
  let endpoint: { status?: () => Promise<{ authStatus: string }> } | undefined;
  try {
    // The Client Remote table may be a service proxy that rejects reads of a
    // namespace no contribution mounted, so this probe must never throw.
    endpoint = (ctx.remote as Record<string, { status?: () => Promise<{ authStatus: string }> } | undefined> | undefined)
      ?.chatGptWebStatus;
  } catch {
    return undefined;
  }
  if (typeof endpoint?.status !== 'function') return undefined;
  return () => endpoint!.status!();
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-chatgpt-web: dictionaries");

  const card = createController(
    ctx.configForms.get(HOST_SETTINGS_NS),
    require('@deepseek-ai/dsh-client-ui-primitives') as Record<string, unknown>,
    optionalStatus(ctx),
  );
  const Card = createCard(require);
  ctx.effect(() => () => card.dispose(), 'ui-settings-chatgpt-web: form subscription');

  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: SLOT_ID, order: SLOT_ORDER, label: () => t('title'), locale: NS, inject: () => card.inject() },
      Card,
    )),
    'ui-settings-chatgpt-web: page',
  );
}