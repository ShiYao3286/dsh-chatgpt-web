# dsh-chatgpt-web

非官方 DSH provider，路由 `chatgpt-web`，模型目录 `chatgpt-free`。复用用户正常网页登录后手工捕获的认证，不是 OpenAI 官方 API。私有接口可能变化，存在服务条款、限流和账号风险，不保证可用性或底层模型身份。

## 实际接入

入口继承并注册真实 `@deepseek-ai/dsh-llm` 的 `LlmAdapter`。当前兼容范围精确限定为桌面 **0.2.1-rc.3**，Schemastery **3.18.5**；不再将旧 CLI 0.1.7-rc.2 的测试作为桌面兼容证据。已从实际安装的桌面 ASAR 离线提取目标模块，验证兼容检查无 exemption 通过、原生 Config、真实 Cordis 注册/注销、prepared-call、BlockAssembler 及桌面前端内嵌表单模型。**未重启应用，未验证 GUI、实际认证或真实网络可用性**。其他版本尚未验证，不使用宽泛 peer 范围承诺兼容。

- 模型目录、resolveModel、继承 prepareCall、标准 text/tool-call/finish chunks。
- provider 级单飞，不排队；按 Harness sessionId 隔离网页绑定。
- 使用完整新增消息（包括多个工具结果）；改写、压缩或固定头改变时重新建立网页会话。
- 网页绑定、检查点和调用台账在此 adapter 内仅保存在内存；重启后使用 Harness 提供的完整历史重建，不迁移或删除认证。
- 仅启用 Node 传输。不会自动开启浏览器、自动回落、求解 PoW、验证码或其他挑战。若站点要求 sentinel/挑战，调用会失败，需用户在正常浏览器人工恢复；恢复也不保证私有接口接受 Node 请求。
- `options.signal` 取消贯穿 HTTP 和流读取，总超时默认 180 秒。
- 会话标题本地生成；compaction 使用独立网页会话处理真实输入，不再用最后一条文本冒充完整摘要，因此可能消耗网页额度。

## 安装与构建

从 Actions 的 `dsh-chatgpt-web-0.1.1-installable` artifact 下载并解压，取得 `dsh-chatgpt-web-0.1.1.tgz` 与 `SHA256SUMS`。tarball 已含 server/client 编译资产，不需本机构建；在目标 desktop profile 中使用包管理器安装该本地 tarball，并将 `dsh-chatgpt-web` 加入 `dsh.profile.bundles`。不要只下载 GitHub 源码 zip。

开发和云端使用 `npm ci --ignore-scripts`、`npm run typecheck`、`npm run build`、`npm test`。仅依赖公开 npm peer；不内嵌宿主，不上传 ASAR、提取目录、凭证或本机路径。Actions 只编译、测试和上传安装包，绝不创建 tag/release。

包中的 `cordis.patch.yml` 是 bundle 装配入口。profile 需要同时有包依赖和 `dsh.profile.bundles` 中的 `dsh-chatgpt-web`；只有 link 依赖不代表启用。完成后由用户自行正常退出、重启桌面应用。

## 认证

保留既有 `~/.dsh/chatgpt-web/auth.json` 格式和位置（遵循现有路径环境配置）。运行时读取已有凭证，不自动改写；缺失、JWT exp 到期或服务器拒绝时返回明确认证错误。日志不输出 token 片段。

需要认证时，用户可显式执行 `node scripts/capture-auth.mjs`，在浏览器中正常手工登录。该脚本具有启动浏览器、读取和保存登录态的副作用，不属于离线测试。本次修复没有执行它，没有读取实际凭证，也没有真实请求网页接口。

## 设置

直接注册客户端 `settings.section`，不因缺少配置命名空间而隐藏页面；配置不可用时保留宿主表单的 unavailable/只读状态。使用真实 native volatile Config 与 `SettingsFormModel`，通过已有 settings gateway 保存到 profile patch，包含 revision 冲突检测。保存后同一 adapter 在下一次请求读取新配置；进行中的请求使用不可变快照，单飞闸门和限速历史不重建。

只读 `chatGptWebStatus/status` 使用宿主 `TypertRemoteService`/`Remote` 与既有 gateway 访问控制，不新增 HTTP 文件接口、不接受路径参数。只返回 `missing`、`expired`、`unchecked`；后者表示未在线验证，不代表凭证可用。卡片不返回 token/cookie，也不执行在线认证。原 `~/.dsh/chatgpt-web/config.json` 不再作为此 adapter 的配置来源，文件不会被迁移或删除。

| 字段 | 默认值 | 说明 |
|---|---|---|
| transport | node | 原生设置只允许 node；旧 chromium 配置明确拒绝 |
| webModel | auto | 网页实际模型选择符，不保证其身份或账号权限 |
| softTurns / hardTurns | 25 / 40 | 保守轮换水位 |
| minIntervalMs / maxIntervalMs | 4000 / 9000 | 调用间隔闸门，不排队等待 |
| rateMaxInWindow | 12 | 滚动窗口请求上限 |
| catalogBudgetChars | 24000 | 工具目录预算 |

## 已知边界

- **实时正文，延迟工具**：SSE 帧经异步队列立即输出普通正文，不做事后全文重播或假打字。跨块工具协议/交接标记暂存且不显示，工具必须等整轮成功及最终验证后输出。取消、断线或协议失败保留已显示正文，但 finish 失败，不执行工具；已显示正文不代表远端最终成功。非单调的正文改写会失败而不是重复输出。正文边缘空白会裁剪，连续三个以上换行归一为两个。
- 要求 HTTP 成功、SSE DONE、assistant 成功终态，无业务错误；仅 DONE 不足以判成功。
- 工具调用是提示词协议，不是原生 function calling。调用必须闭合且为严格 JSON，工具名必须在当前声明中；基础参数结构检查不能替代宿主最终权限和完整 JSON Schema 校验。
- 不支持图像输入，无权威 token usage；目录采用保守 16384 上下文 / 2048 默认输出预算，不是网页模型能力承诺。
- 内部轮换种子有 12000 字符上限，adapter 会保守拒绝超长输入而不是静默截断；大工具目录可能提前触及此限制。
- 网页接口不提供可靠 temperature、maxTokens、stop 控制，不保证这些选项被远端执行；不要依赖它们作为安全限制。
- 历史 Chromium/page/PoW 模块作为未启用的旧实现保留，宿主 adapter 不走这些路径；不应将旧 smoke/probe 脚本作为安全离线测试。

## 本地测试

`npm test` 是云端离线回归，仅需公开 npm peer，不需要提取桌面资源。adapter 测试注入合成认证及内存传输，不访问凭证文件或网络。`npm run test:desktop` 是独立的真实桌面契约门禁，缺失目标宿主即失败，不 skip；`npm run test:all` 合并执行。真实宿主测试包含 Loader/root Include、SettingsForms、ConfigEditor 临时 profile 保存/revision 冲突/卸载、原生 volatile 更新保持 fiber/adapter、gateway source discovery 与非 owner 拒绝（只 prepare，不调用实际认证状态）。客户端回归执行真实构建 factory，从目标前端内嵌实现抽取 `SettingsFormModel`；表单快照单测不冒充真实 namespace，真实 namespace 由实际 Loader/Config schema 生成。

离线目标目录默认从本项目 `node_modules/@deepseek-ai/dsh-llm` 的真实路径推导，亦可通过 `DSH_OFFLINE_HOST_ROOT` 指定目标 `@deepseek-ai` 目录，但必须与运行时依赖一致。测试强制核对 dsh-llm、app-boot、settings、plugin-manager、web-frontend 均为 **0.2.1-rc.3**，Schemastery 为 **3.18.5**；误指向旧 CLI 会失败。本机开发 junction 已指向从桌面安装 ASAR 提取的完整运行时，发布 manifest 不包含机器绝对路径。提取的桌面包没有随附 `.d.ts`；`src/desktop-contract.d.ts` 是依据目标实现整理的最小消费面（不是官方 SDK 类型），通过真实模块契约回归补充检查，不把缺失声明降级为 `any`。它不替换运行时导入，也不宣称覆盖完整宿主类型。

`npm run build` 生成 `lib/index.js` 与 `lib/client.js`；构建目录被 Git 忽略，需要本地/打包时重新构建。离线检查不代替桌面正常重启后的 GUI/真实认证验证。

MIT
