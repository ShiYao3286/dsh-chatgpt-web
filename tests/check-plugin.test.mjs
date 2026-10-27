import { ok, eq, section } from "./harness.mjs";
import { name, inject, describePlugin, apply, SETTINGS_NS, CONFIG_DEFAULTS, describeConfig } from "../src/index.ts";

section("插件元数据");
eq(name, "dsh-chatgpt-web", "插件名");
ok(inject.includes("llm"), "inject 含 llm");
eq(SETTINGS_NS, "chatgpt-web", "settings 命名空间");

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

section("apply：有 settings 服务时注册命名空间");
{
  const regs = [];
  const ctx = {
    llm: { registerAdapter: () => ({}) },
    logger: { info: () => {} },
    settings: { register: (ns, def) => { regs.push({ ns, def }); } },
  };
  apply(ctx);
  eq(regs.length, 1, "注册了一次");
  eq(regs[0].ns, "chatgpt-web", "命名空间正确");
  ok(typeof regs[0].def.load === "function", "带 load");
  ok(typeof regs[0].def.save === "function", "带 save");
  ok(regs[0].def.defaults.transport === "node", "默认 transport 是 node");
}