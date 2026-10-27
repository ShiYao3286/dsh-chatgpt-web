# dsh-chatgpt-web

非官方 DSH 插件：把 chatgpt.com **免费档**网页端做成 DSH 的 LLM provider（路由名 `chatgpt-web`）。

> ⚠️ 非官方项目，与 OpenAI 无关联。调用网页端私有接口可能违反服务条款，**存在账号被限流或封禁的风险**，使用风险自负。

## 它是什么

```
DSH agent loop → ctx.llm → [chatgpt-web 适配器] → chatgpt.com
                                  ├─ CDP 驱动真实页面发请求（指纹一致）
                                  ├─ PoW（SHA3-512，页面内求解）
                                  ├─ sentinel 挑战 + Bearer token
                                  └─ 提示词工具协议 ⇄ tool-call
```

它**不**调用 OpenAI API，而是复用你在浏览器里已有的登录态。请求由插件自己构造，
但**通过 CDP 在真实页面上下文里发出** —— 只有这样 cookie 与浏览器指纹才能带上，
否则服务端会把请求判成未登录访客（`persona: chatgpt-noauth`）。

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

## 登录一次

插件需要一个**已登录 chatgpt.com 的浏览器**。它默认复用 `127.0.0.1:9222` 上的调试端口；
没有就自己拉起一个（`detached + unref`，DSH 退出不会带走浏览器）。

```bash
# 手动起一个调试浏览器（一次就够，之后插件会复用）
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="%USERPROFILE%\.dsh\chatgpt-web\browser-profile" \
  https://chatgpt.com/
```

在弹出的窗口里正常登录即可。凭证与状态都在 `~/.dsh/chatgpt-web/`，不进仓库。

## 选模型

模型选择器 → provider `chatgpt-web` → `ChatGPT 网页 · 免费`。

免费档只有一条模型：思考与否是同一模型的开关，不是两个模型。

## 端到端冒烟

```bash
node scripts/smoke.mjs                      # 真实发一轮，会消耗 1 条免费额度
node scripts/smoke.mjs --prompt="你好"       # 自定义提示词
```

## 已知限制

- **免费额度**：具体条数随账号与时段变化，插件按保守水位轮换（默认 25 轮软水位 / 40 轮硬上限）。
- **单飞**：同一时刻只能有一轮在跑。这是设计前提，不是可调参数。
- **必须能启动 Edge / Chrome**：PoW 与 sentinel 都要在真实页面里完成。
- **后台标签页会被节流**：浏览器最小化时页面里的 fetch 会挂住。插件会覆写页面可见性解除节流，
  但仍建议不要关闭浏览器。
- **封号风险**：这是本方案的固有成本，代码里消不掉。不建议用新号，不建议多开。
- **工具协议是提示词模拟的**，网页端没有原生 function calling；模型偶发格式漂移由解析器兜底。

## 架构

| 层 | 位置 | 职责 |
|---|---|---|
| 传输 | `src/transport/` | CDP 客户端、浏览器进程、页面事实、健康自愈 |
| 线缆 | `src/wire/` | 请求构造、SSE patch 解析、页面侧运行时 |
| 协议 | `src/protocol/` | bootstrap 渲染、工具目录预算、工具调用解析、未执行检测 |
| 绑定 | `src/binding/` | 三动作决策（append / re-anchor / rotate）、检查点、重启校验 |
| 闸门 | `src/gate/` | 单飞、随机间隔、长休、滚动窗口、调用台账 |
| 适配器 | `src/adapter.ts` | 模型目录、purpose 分流、失败码映射 |

## 测试

```bash
npm test
```

全部离线：不启动浏览器、不发网络请求。有两条基线判据守着：

- `defaultSpawnCalls === 0 && defaultConnectCalls === 0` —— 测试物理上不可能拉起浏览器。
- 页面侧 PoW 与 `src/pow/*.ts` 是两份实现，由**差分测试**钉住逐字节一致。

## 许可证

MIT