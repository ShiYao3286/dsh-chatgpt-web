import { ok, eq, deepEq, section } from "./harness.mjs";
import { FIELDS, FIELD_DEFAULTS, fieldProps, editable } from "../src/client/fields.ts";
import { zh, en, NS, inject } from "../src/client/locales.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

section("字段声明");
eq(FIELDS.length, 8, "8 个字段");
eq(FIELDS[0].key, "transport", "第一个是 transport");
eq(FIELDS[0].kind, "enum", "transport 是枚举");
deepEq(FIELDS[0].options, ["node"], "仅启用 node");
ok(FIELDS.slice(2).every((f) => f.kind === "number"), "其余都是数字");

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
deepEq([...inject], ["slots", "locale", "configForms", "remote", "remote.chatGptWebStatus"], "原生设置和受控状态服务");