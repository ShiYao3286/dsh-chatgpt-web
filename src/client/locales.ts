/**
 * ChatGPT 网页版的设置卡片（浏览器侧）。
 *
 * 注册进 DSH 设置面板的 plugins.item 插槽，形态对齐官方 settings 插件：
 *   inject: ["slots", "locale", "configForms"]
 *   ctx.slots.register({ name: "plugins.item", id, order, label, locale, inject }, Card)
 *
 * 只有 Host 侧注册了同名 settings 命名空间（configForms.whileServed）时才会出现，
 * 所以没装/没启用时不留下任何痕迹。
 */

/** 字典命名空间。 */
export const NS = "settings.chatgptWeb";

/** 需要注入的浏览器服务。 */
export const inject = ["slots", "locale", "configForms"];

/** 中文文案。 */
export const zh = {
  title: "ChatGPT 网页版",
  description: "用 chatgpt.com 免费额度驱动 DSH agent（提示词工具协议）。",
  transport: "传输方式",
  transportHint: "Node 直连不需要浏览器；被 Cloudflare 拦截时才切到浏览器代理。",
  transportNode: "Node 直连（推荐）",
  transportChromium: "浏览器代理",
  devtoolsPort: "调试端口",
  devtoolsPortHint: "仅浏览器代理使用。默认 9222。",
  softTurns: "软水位（轮）",
  softTurnsHint: "到这里主动轮换网页端会话。",
  hardTurns: "硬上限（轮）",
  hardTurnsHint: "强制轮换；必须大于软水位。",
  interval: "请求间隔（毫秒）",
  intervalHint: "从上次结束算起的随机区间；区间越固定越像脚本。",
  rateLimit: "窗口内最多请求数",
  rateLimitHint: "滚动窗口限速，防止连续轰炸。",
  catalogBudget: "工具目录预算（字符）",
  catalogBudgetHint: "超预算时会把长尾工具压成仅名字，并列出被省略的工具。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "保存失败，已保留你填的值。",
  readOnly: "本部署的设置为只读。",
  unavailable: "插件当前未加载，暂时无法配置。",
  invalidNumber: "请填数字；留空表示使用默认值。",
  overridden: "已覆盖",
  reset: "恢复默认",
};

/** 英文文案。 */
export const en = {
  title: "ChatGPT Web",
  description: "Drive DSH agents with the chatgpt.com free tier (prompting-based tool calls).",
  transport: "Transport",
  transportHint: "Node needs no browser; switch to the browser proxy only when Cloudflare blocks it.",
  transportNode: "Node direct (recommended)",
  transportChromium: "Browser proxy",
  devtoolsPort: "Debug port",
  devtoolsPortHint: "Used by the browser proxy only. Default 9222.",
  softTurns: "Soft limit (turns)",
  softTurnsHint: "Rotate the web conversation proactively at this point.",
  hardTurns: "Hard limit (turns)",
  hardTurnsHint: "Force a rotation; must exceed the soft limit.",
  interval: "Request interval (ms)",
  intervalHint: "Random range measured from the previous completion; fixed intervals look scripted.",
  rateLimit: "Max requests per window",
  rateLimitHint: "Rolling-window cap that prevents bursts.",
  catalogBudget: "Tool catalog budget (chars)",
  catalogBudgetHint: "Over budget, long-tail tools collapse to name-only and are listed as omitted.",
  save: "Save",
  saving: "Saving…",
  saveFailed: "Save failed; your values were kept.",
  readOnly: "This deployment stores settings read-only.",
  unavailable: "This plugin is not loaded, so it cannot be configured right now.",
  invalidNumber: "Enter a number, or leave blank to use the default.",
  overridden: "Overridden",
  reset: "Reset to default",
};
