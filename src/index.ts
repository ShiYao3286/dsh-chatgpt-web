/** Native Cordis schema and the real Harness LlmAdapter registration. */
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_CONFIG as CONFIG_DEFAULTS, describeConfig, loadConfig, saveConfig, normalizeConfig, type PluginConfig } from './config.ts';
import { PROVIDER_ROUTE, listModels } from './adapter.ts';
import { ChatGptWebStatus } from './status.ts';
import { ChatGptWebAdapter } from './host-adapter.ts';
import { registerLoginRoutes, type LoginRouteContext } from './login-routes.ts';
export const name = 'dsh-chatgpt-web';
export const inject = ['llm'];
export const SETTINGS_NS = 'dsh-chatgpt-web';
export { CONFIG_DEFAULTS, describeConfig, loadConfig, saveConfig };
export type { PluginConfig };
export const Config = Schema.object({
  transport: Schema.const('node').default('node').description('仅支持 Node 传输；遇人工验证会失败，不启动浏览器或绕过挑战。'),
  webModel: Schema.string().default(CONFIG_DEFAULTS.webModel).description('网页模型标识（默认 auto，不保证具体底层模型）。'),
  softTurns: Schema.number().min(1).max(500).step(1).default(CONFIG_DEFAULTS.softTurns).description('主动轮换网页会话的轮数。'),
  hardTurns: Schema.number().min(2).max(1000).step(1).default(CONFIG_DEFAULTS.hardTurns).description('硬轮换上限（归一化后严格大于软上限）。'),
  minIntervalMs: Schema.number().min(0).max(600000).step(1).default(CONFIG_DEFAULTS.minIntervalMs).description('请求结束后最小间隔（毫秒）。'),
  maxIntervalMs: Schema.number().min(0).max(600000).step(1).default(CONFIG_DEFAULTS.maxIntervalMs).description('请求结束后最大间隔（毫秒）。'),
  rateMaxInWindow: Schema.number().min(1).max(500).step(1).default(CONFIG_DEFAULTS.rateMaxInWindow).description('30分钟窗口最多请求次数。'),
  catalogBudgetChars: Schema.number().min(2000).max(200000).step(1).default(CONFIG_DEFAULTS.catalogBudgetChars).description('提示词工具目录字符预算。'),
  devtoolsPort: Schema.number().min(1024).max(65535).step(1).default(CONFIG_DEFAULTS.devtoolsPort).description('设置页"拉取浏览器登录态"时浏览器调试端口；被占用会自动换端口。'),
}).volatile().description('ChatGPT 网页桥接（非官方）。可在设置页拉取本地浏览器登录态；不自动刷新、不解决验证码；请勿发送敏感资料。');
export function describePlugin(): string { return 'dsh-chatgpt-web (' + PROVIDER_ROUTE + ', ' + listModels().length + ' model)'; }
interface HostContext extends LoginRouteContext {
  plugin?: (plugin: typeof ChatGptWebStatus) => unknown;
  llm: { registerAdapter: (routes: string[], adapter: ChatGptWebAdapter) => (() => void) | unknown };
  logger: { info: (message: string) => void; warn?: (message: string) => void };
  effect?: (callback: () => unknown) => unknown;
  /** Cordis 的可选注入：宿主没提供该服务时，回调不跑，插件照常工作。 */
  inject?: (deps: string[], callback: (child: HostContext) => unknown) => unknown;
}
export function apply(ctx: HostContext, config: PluginConfig | { get(): PluginConfig } = CONFIG_DEFAULTS): void {
  ctx.plugin?.(ChatGptWebStatus);
  // Root-volatile native Config is a host-owned reference, not a plain record.
  const read = () => normalizeConfig('get' in config ? config.get() : config);
  const normalized = read();
  const register = () => ctx.llm.registerAdapter([PROVIDER_ROUTE], new ChatGptWebAdapter(read));
  if (ctx.effect) ctx.effect(register);
  else register();
  // Settings page login: browser launch, wait, capture, persist, logout.
  //
  // `webServer` is claimed through an **optional** injection: a composition without
  // an HTTP carrier (headless, ACP, the offline contract harness) must still load the
  // adapter and the status service. Declaring it in the static `inject` array would
  // instead leave this fiber pending forever in those compositions.
  const startRoutes = (host: LoginRouteContext) => {
    const routes = registerLoginRoutes(host, read);
    if (host.effect) host.effect(() => routes);
    else routes();
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (child) => startRoutes(child));
  } else {
    startRoutes(ctx);
  }
  ctx.logger.info(describePlugin() + ' · ' + describeConfig(normalized));
}
export default { name, inject, apply, Config };
