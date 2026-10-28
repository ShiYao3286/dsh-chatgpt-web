import { ok, eq, deepEq, section } from "./harness.mjs";
import { FIELDS, FIELD_DEFAULTS, fieldProps, editable } from "../src/client/fields.ts";
import { zh, en, NS, inject } from "../src/client/locales.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

section("字段声明");
eq(FIELDS.length, 9, "9 个字段（含登录用的调试端口）");
eq(FIELDS[0].key, "transport", "第一个是 transport");
eq(FIELDS[0].kind, "enum", "transport 是枚举");
deepEq(FIELDS[0].options, ["node"], "仅启用 node");
ok(FIELDS.slice(2).every((f) => f.kind === "number"), "其余都是数字");
eq(FIELDS[FIELDS.length - 1].key, "devtoolsPort", "最后一个是调试端口");

section("面板默认值与 Host 侧一致（防止两处漂移）");
{
  for (const k of Object.keys(FIELD_DEFAULTS)) {
    if (k === 'webModel') continue;
    ok(Object.hasOwn(DEFAULT_CONFIG, k), "Host 侧也有 " + k);
    eq(FIELD_DEFAULTS[k], DEFAULT_CONFIG[k], k + " 默认值一致");
  }
  eq(FIELD_DEFAULTS.webModel, 'auto', 'webModel default');
}

section("fieldProps");
{
  const p = fieldProps(FIELDS[0], "chromium", false);
  eq(p.id.includes("transport"), true, "id 含字段名");
  eq(p.value, "chromium", "值透传");
  eq(p.numeric, false, "枚举不是数字");
  deepEq(p.options, ["node"], "枚举带 options");
  eq(p.disabled, false, "可编辑");

  eq(fieldProps(FIELDS[1], undefined, false).value, 'auto', '网页模型默认值');
  const n = fieldProps(FIELDS[2], undefined, true);
  eq(n.value, 25, "未设值时用默认");
  eq(n.numeric, true, "数字字段");
  eq(n.disabled, true, "禁用透传");
  eq(Object.hasOwn(n, "options"), false, "数字字段无 options");
}

section("editable");
eq(editable(true, false), true, "可写且未保存中 -> 可编辑");
eq(editable(true, true), false, "保存中 -> 不可编辑");
eq(editable(false, false), false, "只读 -> 不可编辑");

section("locale 字典");
eq(NS, "settings.chatgptWeb", "命名空间");
ok(zh.title.length > 0, "中文有标题");
ok(en.title.length > 0, "英文有标题");
{
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  deepEq(enKeys, zhKeys, "中英文字典键完全一致（不会漏译）");
}
ok(zh.transportHint.includes("不需要浏览器"), "提示语说明 Node 不需要浏览器");

section("inject 声明");
{
  // `remote.chatGptWebStatus` 必须是**不**声明的那个：宿主 0.2.1-rc.3 只从编译期
  // `/remote` 贡献表挂载客户端 Remote 命名空间，第三方插件永远等不到自己的。
  // 曾经声明它就导致整个 Web boot 停在 "1 entry did not activate"。
  deepEq([...inject], ["slots", "locale", "configForms", "remote"], "原生设置服务 + remote 表");
  ok(!inject.some((k) => k.startsWith("remote.")), "不得把 remote.<namespace> 写进 inject");
}