import { ok, eq, deepEq, section } from "./harness.mjs";
import { DEFAULT_CONFIG, normalizeConfig, describeConfig } from "../src/config.ts";

section("默认值");
{
  const c = normalizeConfig(undefined);
  deepEq(c, DEFAULT_CONFIG, "空输入得到默认配置");
  eq(c.transport, "node", "默认 Node 直连");
}

section("归一化：非法值退回默认");
{
  const c = normalizeConfig({ transport: "bogus", devtoolsPort: "abc", softTurns: null });
  eq(c.transport, "node", "非法 transport 退回 node");
  eq(c.devtoolsPort, DEFAULT_CONFIG.devtoolsPort, "非法端口退回默认");
  eq(c.softTurns, DEFAULT_CONFIG.softTurns, "非法 softTurns 退回默认");
}

section("归一化：范围钳制");
{
  eq(normalizeConfig({ devtoolsPort: 80 }).devtoolsPort, 1024, "端口下限 1024");
  eq(normalizeConfig({ devtoolsPort: 99999 }).devtoolsPort, 65535, "端口上限 65535");
  eq(normalizeConfig({ softTurns: 0 }).softTurns, 1, "softTurns 下限 1");
  eq(normalizeConfig({ rateMaxInWindow: 0 }).rateMaxInWindow, 1, "窗口次数下限 1");
  eq(normalizeConfig({ minIntervalMs: -5 }).minIntervalMs, 0, "间隔下限 0");
}

section("hardTurns 必须严格大于 softTurns");
{
  const c = normalizeConfig({ softTurns: 30, hardTurns: 30 });
  ok(c.hardTurns > c.softTurns, "相等时抬高到 soft+1（" + c.softTurns + " -> " + c.hardTurns + "）");
  const d = normalizeConfig({ softTurns: 40, hardTurns: 10 });
  ok(d.hardTurns > d.softTurns, "小于时抬高");
}

section("间隔区间：max 不得小于 min");
{
  const c = normalizeConfig({ minIntervalMs: 8000, maxIntervalMs: 3000 });
  ok(c.maxIntervalMs >= c.minIntervalMs, "max 被抬到 min（" + c.minIntervalMs + " -> " + c.maxIntervalMs + "）");
}

section("字符串数字可接受");
{
  const c = normalizeConfig({ softTurns: "12", rateMaxInWindow: "7" });
  eq(c.softTurns, 12, "字符串转数字");
  eq(c.rateMaxInWindow, 7, "字符串转数字 2");
}

section("describeConfig 可读");
{
  const s = describeConfig(DEFAULT_CONFIG);
  ok(s.includes("Node"), "含传输方式");
  ok(s.includes("25"), "含软水位");
}