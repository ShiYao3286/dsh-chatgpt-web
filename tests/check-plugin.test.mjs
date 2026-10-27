import { ok, eq, section } from "./harness.mjs";
import { name, inject, describePlugin, apply, SETTINGS_NS, CONFIG_DEFAULTS, describeConfig } from "../lib/index.js";

section("插件元数据");
eq(name, "dsh-chatgpt-web", "插件名");
ok(inject.includes("llm"), "inject 含 llm");
eq(SETTINGS_NS, "dsh-chatgpt-web", "原生插件设置 entry id");

section("describePlugin");
ok(describePlugin().includes("chatgpt-web"), "含路由名");

section("describeConfig 反映默认值");
{
  const s = describeConfig(CONFIG_DEFAULTS);
  ok(s.includes("Node"), "默认走 Node");
}

section("apply：没有 settings 服务也能装配");
{
  let logged = "";
  const ctx = { llm: { registerAdapter: () => ({}) }, logger: { info: (m) => { logged = m; } } };
  let threw = false;
  try { apply(ctx); } catch { threw = true; }
  eq(threw, false, "apply 正常返回");
  ok(logged.includes("dsh-chatgpt-web"), "写了日志");
}

section("apply：真实注册adapter并挂接生命周期");
{
  const regs = [];
  let disposed = false;
  const ctx = {
    llm: { registerAdapter: (routes, adapter) => { regs.push({ routes, adapter }); return () => { disposed = true; }; } },
    logger: { info: () => {} },
    effect: callback => { const dispose = callback(); dispose(); },
    settings: { register: () => { throw new Error('不得使用不存在的settings.register'); } },
  };
  apply(ctx);
  eq(regs.length, 1, "注册了一次");
  eq(regs[0].routes[0], "chatgpt-web", "路由正确");
  ok(typeof regs[0].adapter.stream === "function", "真实adapter具有stream");
  ok(disposed, "生命周期返回注销函数");
}
