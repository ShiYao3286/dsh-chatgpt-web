/**
 * 登录相关的 Host 路由（`/chatgpt-web/login/*`）。
 *
 * ## 为什么是 HTTP 路由而不是 Remote 方法
 *
 * 客户端半侧无法调用 Host 的 `TypertRemoteService`：浏览器端的 Remote 命名空间
 * 只来自 `@deepseek-ai/dsh-api-remotes` 编译期静态枚举的那批贡献，第三方插件
 * 挂不上自己的命名空间（这条在 0.1.1 的 inject 事故里已经吃过一次亏）。
 * `webServer.register` 是插件唯一可靠的 Host→Browser 通道。
 *
 * ## 鉴权
 *
 * 每个路由都先过 `ctx.connection.requestRejection(req)`——与宿主自带路由同一个闸门，
 * 未认证的请求在这里就被拒，业务代码拿不到任何东西。
 *
 * ## 不泄漏凭证
 *
 * 应答里**没有 token、没有 cookie 明文**。只有长度、域数、时间戳这类结论。
 */

import { normalizeConfig, type PluginConfig } from "./config.ts";
import {
  BrowserLoginSession,
  LOGIN_TIMEOUT_MS,
  clearStoredAuth,
  readStoredAuthStatus,
  type LoginProgress,
} from "./login.ts";
import { describeError } from "./transport/cdp.ts";

/** 路由前缀。客户端用同一份常量拼 URL。 */
export const LOGIN_ROUTE_PREFIX = "/chatgpt-web/login";

/** Host 侧需要的 Cordis 面。 */
export interface LoginRouteContext {
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  webServer?: {
    register(route: { kind: "exact"; path: string; handler: (req: unknown, res: unknown) => void }): () => void;
  };
  connection?: { requestRejection?(req: unknown): number | boolean | undefined | null };
  get?(name: string): unknown;
  effect?(fn: () => unknown): unknown;
}

/** 最小化的 Node 请求/应答形状，避免 import 宿主私有类型。 */
interface BareRequest {
  method?: string;
  url?: string;
}
interface BareResponse {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** 读请求体（有上限，防滥用）。 */
async function readJsonBody(req: unknown, limitBytes = 16 * 1024): Promise<Record<string, unknown>> {
  const stream = req as AsyncIterable<Uint8Array> & { on?: unknown };
  if (typeof stream[Symbol.asyncIterator] !== "function") return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limitBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sendJson(res: BareResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  try {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
  } catch {
    /* 头部已发出 */
  }
  res.end(text);
}

/**
 * 注册全部登录路由，返回 disposer。
 *
 * 路由：
 * - `GET  /chatgpt-web/login/status`  当前持久化登录态 + 进行中进度
 * - `POST /chatgpt-web/login/start`   拉起浏览器开始登录
 * - `POST /chatgpt-web/login/cancel`  取消等待（不杀浏览器）
 * - `POST /chatgpt-web/login/logout`  删除本地凭证
 */
export function registerLoginRoutes(
  ctx: LoginRouteContext,
  readConfig: () => PluginConfig,
): () => void {
  // 只用**注入上来的**服务属性，绝不调用 ctx.get(...)：
  // ctx.get 会向 Cordis 发起服务解析，缺失时让整个插件 fiber 卡在 pending；
  // 而直接读 ctx.webServer 在未 inject 时又会抛
  // "cannot get property webServer without inject"，所以必须 try/catch。
  // 两者都失败时安静跳过，不影响适配器与状态服务。
  let webServer: LoginRouteContext["webServer"];
  try {
    webServer = ctx.webServer;
  } catch {
    webServer = undefined;
  }
  if (webServer === undefined || typeof webServer.register !== "function") {
    ctx.logger?.warn?.("[dsh-chatgpt-web] webServer unavailable; login routes skipped");
    return () => undefined;
  }

  const session = new BrowserLoginSession();
  const disposers: Array<() => void> = [];

  const rejected = (req: unknown, res: BareResponse): boolean => {
    try {
      let connection: LoginRouteContext["connection"];
      try {
        connection = ctx.connection;
      } catch {
        connection = undefined;
      }
      if (connection === undefined || typeof connection.requestRejection !== "function") return false;
      const code = connection.requestRejection(req);
      if (code === undefined || code === null || code === false) return false;
      res.statusCode = typeof code === "number" ? code : 403;
      res.end();
      return true;
    } catch {
      return false;
    }
  };

  const route = (path: string, handler: (req: BareRequest, res: BareResponse) => Promise<void> | void): void => {
    const dispose = webServer.register({
      kind: "exact",
      path,
      handler: (rawReq, rawRes) => {
        const req = rawReq as BareRequest;
        const res = rawRes as BareResponse;
        if (rejected(req, res)) return;
        Promise.resolve(handler(req, res)).catch((error: unknown) => {
          try {
            sendJson(res, 500, { ok: false, error: describeError(error) });
          } catch {
            /* 连接已断 */
          }
        });
      },
    });
    disposers.push(dispose);
  };

  /** 组装对外状态：持久化结论 + 进行中进度。 */
  const statusPayload = async (): Promise<Record<string, unknown>> => {
    const stored = await readStoredAuthStatus();
    return { ok: true, stored, progress: session.snapshot() };
  };

  route(LOGIN_ROUTE_PREFIX + "/status", async (_req, res) => {
    sendJson(res, 200, await statusPayload());
  });

  route(LOGIN_ROUTE_PREFIX + "/start", async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "POST only" });
      return;
    }
    const body = await readJsonBody(req, 4096);
    const config = normalizeConfig(readConfig());
    // 端口取自插件配置（设置页可改）；越界/非法由 login.ts 归一化。
    const requestedPort = typeof body.port === "number" ? body.port : config.devtoolsPort;
    const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? Math.min(body.timeoutMs, LOGIN_TIMEOUT_MS) : LOGIN_TIMEOUT_MS;
    const progress: LoginProgress = session.start({ port: requestedPort, timeoutMs });
    ctx.logger?.info?.("[dsh-chatgpt-web] browser login started (port=" + String(requestedPort) + ")");
    sendJson(res, 200, { ok: true, progress });
  });

  route(LOGIN_ROUTE_PREFIX + "/cancel", async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "POST only" });
      return;
    }
    sendJson(res, 200, { ok: true, progress: session.cancel() });
  });

  route(LOGIN_ROUTE_PREFIX + "/logout", async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "POST only" });
      return;
    }
    const cleared = await clearStoredAuth();
    ctx.logger?.info?.("[dsh-chatgpt-web] local credential file removed: " + String(cleared));
    sendJson(res, 200, { ok: true, cleared, ...(await statusPayload()) });
  });

  return () => {
    session.cancel("插件已卸载");
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* 已注销 */
      }
    }
  };
}
