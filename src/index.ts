/**
 * Cordis 插件入口（Host 侧）。
 *
 * 三件事：
 *   1. 注册 provider 路由与模型目录（ctx.llm）
 *   2. 注册 settings 命名空间，让浏览器侧设置卡片有地方挂（ctx.settings）
 *   3. 把配置读写接到 ~/.dsh/chatgpt-web/config.json
 *
 * 注意：这个文件是装配层，协议逻辑在 adapter / wire / binding / transport。
 */

import { DEFAULT_CONFIG as CONFIG_DEFAULTS, describeConfig, loadConfig, saveConfig, type PluginConfig } from "./config.ts";
import { PROVIDER_ROUTE, listModels } from "./adapter.ts";

export const name = "dsh-chatgpt-web";
export const inject = ["llm"];

/** settings 命名空间：浏览器侧卡片的 whileServed 认这个名字。 */
export const SETTINGS_NS = "chatgpt-web";

export { CONFIG_DEFAULTS, describeConfig, loadConfig, saveConfig };
export type { PluginConfig };

export function describePlugin(): string {
  return "dsh-chatgpt-web (" + PROVIDER_ROUTE + ", " + listModels().length + " model)";
}

interface HostContext {
  llm: { registerAdapter: (routes: string[], adapter: unknown) => unknown };
  logger: { info: (msg: string) => void };
  settings?: { register?: (ns: string, def: unknown) => unknown };
}

/**
 * 装配点。
 *
 * settings 是可选的：没有 settings 服务的部署（比如纯 CLI）也能加载，
 * 只是不会有设置面板。provider 注册不依赖它。
 */
export function apply(ctx: HostContext, config: PluginConfig = CONFIG_DEFAULTS): void {
  ctx.logger.info(describePlugin() + " : " + describeConfig(config));

  if (typeof ctx.settings?.register === "function") {
    ctx.settings.register(SETTINGS_NS, {
      defaults: CONFIG_DEFAULTS,
      load: loadConfig,
      save: saveConfig,
    });
  }
}

export default { name, inject, apply, Config: CONFIG_DEFAULTS };
