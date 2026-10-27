# 探针脚本

这两个文件是开发期用来**摸清 chatgpt.com 私有接口**的诊断脚本，保留下来是因为它们比任何文档都更直接地说明协议长什么样。

## `probe-diagnose.mjs`

一次性完成：拉起浏览器 → 等登录 → 读页面环境 → 打 sentinel → 打印 persona / turnstile / PoW 参数。

它当年用来回答一个关键问题：为什么 `/backend-api/me` 返回 200 却不是登录态。答案是 `/backend-api/*`
同时校验 cookie **和** `Authorization: Bearer <accessToken>`，而 accessToken 只能从 `/api/auth/session` 取。
不带头时服务端把请求判成 `persona: chatgpt-noauth` 访客。

```bash
node docs/probe-diagnose.mjs --wait=30
```

## `probe-raw-sse.mjs`

真的发一条消息，并把 SSE 的 `data:` 帧**原样打印**。当年就是靠它发现正文不在顶层 `message` 字段里，
而在 `{"v":{"message":{...}}}` 里、终态在 `{"o":"patch", ...}` 里 —— 这个发现直接决定了 `src/wire/sse.ts` 的解析器结构。

```bash
node docs/probe-raw-sse.mjs --prompt="Reply with exactly one word: PONG"
```

## 注意

- 两者都需要一个**已登录的调试浏览器**（`--remote-debugging-port=9222`）。
- 它们会真实消耗免费额度（`probe-diagnose` 的只读部分除外）。
- 它们依赖开发期 `probe/lib/` 里的页面脚本，**这些没有一起保留** —— 现在的等价实现就是 `src/wire/page-pow.js`
  与 `src/wire/page-turn.js`。要跑通请把 import 指向 `src/wire/`。
- **不要**把这里当成生产入口；生产路径是 `src/adapter.ts` + `scripts/smoke.mjs`。
