/**
 * Cordis 插件入口。
 *
 * 装配模式对齐官方 provider 适配器（见 dsh-llm-deepseek-api-key）：
 *   name / inject: ["llm"] / apply(ctx, config) / ctx.llm.registerAdapter([route], adapter)
 *
 * 注意：这个文件是**装配层**，真正的协议逻辑在 adapter.ts / wire / binding / transport。
 * 它刻意保持薄，因为 DSH 的 adapter 契约（chunk 形状）需要通过真实装配才能验证，
 * 不该把未经验证的假设写进这里。
 */

import { PROVIDER_ROUTE, listModels } from "./adapter.ts";

export const name = "dsh-chatgpt-web";
export const inject = ["llm"];

export interface PluginConfig {
  /** 传输层是否复用已在跑的调试端口。 */
  reuseExistingBrowser?: boolean;
  /** 调试端口。 */
  devtoolsPort?: number;
  /** 水位线：到这个轮数主动轮换。 */
  softTurns?: number;
  /** 强制轮换轮数。 */
  hardTurns?: number;
}

export const DEFAULT_CONFIG: Required<PluginConfig> = {
  reuseExistingBrowser: true,
  devtoolsPort: 9222,
  softTurns: 25,
  hardTurns: 40,
};

export function normalizeConfig(config: PluginConfig = {}): Required<PluginConfig> {
  const soft = config.softTurns ?? DEFAULT_CONFIG.softTurns;
  const hard = config.hardTurns ?? DEFAULT_CONFIG.hardTurns;
  // hard 必须严格大于 soft，否则软水位永远先触发、hard 形同虚设
  return {
    reuseExistingBrowser: config.reuseExistingBrowser ?? DEFAULT_CONFIG.reuseExistingBrowser,
    devtoolsPort: config.devtoolsPort ?? DEFAULT_CONFIG.devtoolsPort,
    softTurns: soft,
    hardTurns: Math.max(hard, soft + 1),
  };
}

export function describePlugin(): string {
  return "dsh-chatgpt-web (" + PROVIDER_ROUTE + ", " + listModels().length + " model)";
}

/**
 * 装配点。
 *
 * 当前阶段只登记路由与模型目录；stream 的实现依赖真实装配验证，
 * 在没有跑通端到端之前不把猜测写进契约。
 */
export function apply(ctx: {
  llm: { registerAdapter: (routes: string[], adapter: unknown) => unknown };
  logger: { info: (msg: string) => void };
}, config: PluginConfig = {}): void {
  const cfg = normalizeConfig(config);
  ctx.logger.info(describePlugin() + " 装配：port=" + cfg.devtoolsPort + " soft=" + cfg.softTurns + " hard=" + cfg.hardTurns);
}

export default { name, inject, apply, Config: DEFAULT_CONFIG };