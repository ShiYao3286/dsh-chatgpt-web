import { ok, eq, section } from "./harness.mjs";
import { normalizeConfig, DEFAULT_CONFIG, describePlugin, name, inject, apply } from "../src/index.ts";

section("插件元数据");
eq(name, "dsh-chatgpt-web", "插件名");
ok(inject.includes("llm"), "inject 含 llm");

section("normalizeConfig：默认值");
{
  const c = normalizeConfig();
  eq(c.reuseExistingBrowser, DEFAULT_CONFIG.reuseExistingBrowser, "默认复用已有浏览器");
  eq(c.devtoolsPort, 9222, "默认端口 9222");
  eq(c.softTurns, 25, "默认软水位 25");
  eq(c.hardTurns, 40, "默认硬水位 40");
}

section("normalizeConfig：hard 必须严格大于 soft");
{
  const c = normalizeConfig({ softTurns: 30, hardTurns: 30 });
  ok(c.hardTurns > c.softTurns, "hard > soft (" + c.softTurns + " < " + c.hardTurns + ")");
  const d = normalizeConfig({ softTurns: 30, hardTurns: 10 });
  ok(d.hardTurns > d.softTurns, "hard 小于 soft 时被抬到 soft+1");
  eq(d.hardTurns, 31, "确认为 31");
}

section("normalizeConfig：用户值优先");
{
  const c = normalizeConfig({ devtoolsPort: 9333, reuseExistingBrowser: false });
  eq(c.devtoolsPort, 9333, "端口生效");
  eq(c.reuseExistingBrowser, false, "复用开关生效");
}

section("describePlugin");
ok(describePlugin().includes("chatgpt-web"), "含路由名");

section("apply 不抛异常");
{
  let logged = "";
  const ctx = {
    llm: { registerAdapter: () => ({}) },
    logger: { info: (m) => { logged = m; } },
  };
  let threw = false;
  try { apply(ctx); } catch (e) { threw = true; }
  eq(threw, false, "apply 正常返回");
  ok(logged.includes("dsh-chatgpt-web"), "写了日志");
}