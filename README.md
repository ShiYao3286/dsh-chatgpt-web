# dsh-chatgpt-web

非官方 DSH 插件：把 chatgpt.com **免费档**网页端做成 DSH 的 LLM provider（路由名 `chatgpt-web`）。

> ⚠️ 非官方项目，与 OpenAI 无关联。调用网页端私有接口可能违反服务条款，**存在账号被限流或封禁的风险**，使用风险自负。

## 它是什么

```
DSH agent loop → ctx.llm → [chatgpt-web 适配器] → chatgpt.com
                                  ├─ 默认：Node 直连（不需要浏览器）
                                  ├─ PoW（SHA3-512）
                                  ├─ sentinel 挑战 + Bearer token
                                  └─ 提示词工具协议 ⇄ tool-call
```

它**不**调用 OpenAI API，而是复用你在浏览器里登录过一次之后捕获的登录态。

### 为什么默认不需要浏览器

最初的实现必须常驻一个可调试的 Edge/Chrome（担心 Cloudflare 识别 TLS 指纹）。
**这个前提是被实测推翻的**：把全部调试浏览器关掉、调试端口停掉之后，纯 Node 直连仍然
`status 200`、拿到完整 SSE、模型真实回复 `PONG`。

所以现在的形态是：**登录一次 → 捕获凭证落盘 → 之后纯 Node 跑，不挂浏览器**。
只有被 Cloudflare 拦（返回 HTML 挑战页）才回落到浏览器代理。

顺带一个证据：sentinel 里 `turnstile.required: true`，但我们**不带 turnstile token 也能通过** ——
真正的门槛只有 PoW 与 Bearer。

## 三条不可协商的设计前提

1. **单飞，绝不排队。** 上一条没处理完时，下一次调用**立即**返回 `busy`，不排队、不等待。
   排队会把 DSH 的重试策略叠上一层等待，表现成"看起来卡死"。
2. **网页端会话是可撤销缓存，不是副本。** 只要不是严格追加（压缩、改写、固定头变化、
   到水位、疑似会话丢失），一律开新会话 —— 我们无法改写网页端已经收到的消息树。
3. **网页端额度是稀缺资源。** `session-title` 与 `compaction` 一律本地合成，**零网络请求**；
   只有真正的对话才花额度。

## 安装

```bash
cd E:\ai处理文件\dsh-chatgpt-web
npm install
npm test          # 离线套件，不碰网络
```

装配到 DSH（包内 `cordis.patch.yml` 会自注册，**不要**再手动 insert）：

```bash
dsh plugin --profile desktop add ./dsh-chatgpt-web
```

## 登录一次（只做一次）

凭证捕获之后会落盘到 `~/.dsh/chatgpt-web/auth.json`，**之后不再需要浏览器**。

```bash
node scripts/capture-auth.mjs
```

它会拉起一个浏览器窗口（独立 profile，不碰你日常 Edge 的 cookie 和历史），
你在里面正常登录 chatgpt.com，脚本轮询到登录成功后自动捕获：
accessToken、cookie、data-build、UA、语言、套餐类型。

> **凭证与浏览器 profile 是解耦的。** 删掉浏览器 profile 也不用重新登录 —— 凭证在 auth.json 里。
> 反过来，auth.json 丢了就得重登一次。

## 端到端冒烟

```bash
node scripts/smoke.mjs                       # 默认走 Node，不需要浏览器
node scripts/smoke.mjs --chromium            # 强制走浏览器代理
node scripts/smoke.mjs --prompt="你好"        # 自定义提示词
```

会真实消耗 1 条免费额度。

## 配置

有两种改法，效果相同：

1. **设置面板**：DSH 设置 → 插件 → **ChatGPT 网页版**（`client/index.ts` 注册进 `plugins.item` 插槽）
2. **直接改文件**：`~/.dsh/chatgpt-web/config.json`

| 字段 | 默认 | 说明 |
|---|---|---|
| `transport` | `node` | `node` 不需要浏览器；被 Cloudflare 拦截时改 `chromium` |
| `devtoolsPort` | `9222` | 仅浏览器代理使用 |
| `softTurns` | `25` | 到这里主动轮换网页端会话 |
| `hardTurns` | `40` | 强制轮换；必须大于软水位（会被自动抬高） |
| `minIntervalMs` / `maxIntervalMs` | `4000` / `9000` | 随机间隔；固定值更像脚本 |
| `rateMaxInWindow` | `12` | 滚动窗口内的请求上限 |
| `catalogBudgetChars` | `24000` | 工具目录预算，超了把长尾工具压成仅名字 |

> 所有字段都做了范围钳制与非法值回退，手改坏了也不会让插件起不来。

## 选模型

模型选择器 → provider `chatgpt-web` → `ChatGPT 网页 · 免费`。

免费档只有一条模型：思考与否是同一模型的开关，不是两个模型。

## 已知限制

- **免费额度**：具体条数随账号与时段变化，插件按保守水位轮换（默认 25 轮软水位 / 40 轮硬上限）。
- **单飞**：同一时刻只能有一轮在跑。这是设计前提，不是可调参数。
- **accessToken 会过期**：过期后请求返回 `AUTH`，需要重跑一次 `capture-auth.mjs`。
- **Cloudflare 可能收紧**：届时 Node 直连会被返回 HTML 挑战页，插件会报 `cloudflare` 失败，
  此时改用 `--chromium` 或设置 `transport: chromium` 走浏览器代理。
- **封号风险**：这是本方案的固有成本，代码里消不掉。不建议用新号，不建议多开。
- **工具协议是提示词模拟的**，网页端没有原生 function calling；模型偶发格式漂移由解析器兜底。

## 架构

| 层 | 位置 | 职责 |
|---|---|---|
| 凭证 | `src/auth.ts` | accessToken / cookie / data-build 落盘与归一化 |
| 传输 | `src/transport/` | `node-http.ts` 直连（主路径）、`cdp.ts`/`browser.ts` 浏览器代理（回落） |
| 线缆 | `src/wire/` | 请求构造、SSE patch 解析、页面侧运行时 |
| 协议 | `src/protocol/` | bootstrap 渲染、工具目录预算、工具调用解析、未执行检测 |
| 绑定 | `src/binding/` | 三动作决策（append / re-anchor / rotate）、检查点、重启校验 |
| 闸门 | `src/gate/` | 单飞、随机间隔、长休、滚动窗口、调用台账 |
| 适配器 | `src/adapter.ts` | 模型目录、purpose 分流、失败码映射、传输选择 |

## 测试

```bash
npm test
```

全部离线：不启动浏览器、不发网络请求。有两条基线判据守着：

- `defaultSpawnCalls === 0 && defaultConnectCalls === 0` —— 测试物理上不可能拉起浏览器。
- 页面侧 PoW 与 `src/pow/*.ts` 是两份实现，由**差分测试**钉住逐字节一致。

## 许可证

MIT