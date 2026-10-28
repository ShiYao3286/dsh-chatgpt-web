/**
 * 设置页的「登录态」面板。
 *
 * 这一段是本次功能的主体：**一键拉起本地浏览器 → 等用户在窗口里登录 → 抓取登录态落盘**。
 *
 * ## 分层
 *
 * - 逻辑与文案在 `login-view.ts`（纯函数，离线可测）
 * - 这里只管 DOM 与定时器：轮询、按钮状态、卸载清理
 *
 * ## 为什么轮询而不是长连接
 *
 * 登录要等用户手动操作，可能几十秒也可能几分钟。SSE 长连接在
 * 这个场景下没有收益（进度本来就只有几个阶段），而轮询在页面切走、
 * 休眠恢复时的行为更可预测。`shouldPoll` 决定何时停。
 *
 * ## 主题
 *
 * 所有颜色走宿主 `--dsw-alias-*` 令牌（经下面的别名），**不写死颜色**——
 * 写死会在浅色主题下变成黑底黑字。
 */

import {
  cancelBrowserLogin,
  describeCapturedAt,
  describeStoredAuth,
  describeWaited,
  fetchLoginStatus,
  logoutStoredAuth,
  shouldPoll,
  startBrowserLogin,
  type FetchLike,
  type LoginStatusPayload,
  type StoredAuthView,
} from "./login-view.ts";

/** 轮询间隔。登录是人工动作，1.5 秒足够。 */
const POLL_MS = 1500;

/** 面板样式。只用宿主主题令牌。 */
const STYLE_ID = "dsh-chatgpt-web-login-style";
const CSS = `
.cgw-login { display:flex; flex-direction:column; gap:10px; padding:12px 14px; margin:0 0 14px;
  border:1px solid var(--dsw-alias-border-default, rgba(128,128,128,.28)); border-radius:10px;
  background:var(--dsw-alias-surface-subtle, rgba(128,128,128,.06)); }
.cgw-login-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.cgw-login-title { font-size:13px; font-weight:600; color:var(--dsw-alias-text-primary, currentColor); }
.cgw-login-state { font-size:12px; line-height:1.55; color:var(--dsw-alias-text-secondary, currentColor);
  word-break:break-word; }
.cgw-login-state[data-tone="ok"] { color:var(--dsw-alias-text-success, currentColor); }
.cgw-login-state[data-tone="warn"] { color:var(--dsw-alias-text-warning, currentColor); }
.cgw-login-state[data-tone="bad"] { color:var(--dsw-alias-text-danger, currentColor); }
.cgw-login-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.cgw-btn { appearance:none; cursor:pointer; font:inherit; font-size:12px; padding:6px 12px;
  border-radius:8px; border:1px solid var(--dsw-alias-border-default, rgba(128,128,128,.4));
  background:var(--dsw-alias-surface-default, transparent);
  color:var(--dsw-alias-text-primary, currentColor); }
.cgw-btn:hover:not(:disabled) { background:var(--dsw-alias-surface-hover, rgba(128,128,128,.12)); }
.cgw-btn:disabled { opacity:.55; cursor:default; }
.cgw-btn[data-variant="primary"] { border-color:var(--dsw-alias-border-accent, transparent);
  background:var(--dsw-alias-surface-accent, rgba(64,128,255,.16)); }
.cgw-login-progress { font-size:12px; color:var(--dsw-alias-text-secondary, currentColor); }
.cgw-login-hint { font-size:11.5px; line-height:1.5; color:var(--dsw-alias-text-tertiary, currentColor); }
`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** 面板运行所需的最小 React 面。 */
interface ReactLike {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T;
}

export interface LoginPanelProps {
  readonly t: (key: string) => string;
}

/** 当前状态 → 文案与色调。 */
export function describeProgress(progress: LoginStatusPayload["progress"], t: (k: string) => string): { text: string; tone: string } {
  const phase = progress.phase;
  if (phase === "idle") return { text: "", tone: "" };
  if (phase === "launching") return { text: t("loginWaiting"), tone: "" };
  if (phase === "waiting") return { text: progress.message.length > 0 ? progress.message + "（" + describeWaited(progress.waitedMs) + "）" : t("loginWaiting"), tone: "" };
  if (phase === "capturing") return { text: t("loginWaiting"), tone: "" };
  if (phase === "done") {
    const c = progress.captured;
    const detail = c === undefined ? "" : " · token " + String(c.accessTokenLength) + " 字符" + (c.hasCookie ? " · " + String(c.cookieCount) + " 项 cookie" : "") + (c.dataBuild.length > 0 ? " · build " + c.dataBuild : "");
    return { text: t("loginDone") + detail, tone: "ok" };
  }
  return { text: t("loginFailed") + (progress.message.length > 0 ? "：" + progress.message : ""), tone: "bad" };
}

/** 已保存登录态 → 文案与色调。 */
export function describeStored(view: StoredAuthView, hint: string): { text: string; tone: string } {
  const tone = view.authStatus === "missing" ? "warn" : view.authStatus === "expired" ? "bad" : "";
  return { text: hint.length > 0 ? hint : describeStoredAuth(view), tone };
}

/**
 * 建面板组件。`fetchImpl` 可注入（测试用），默认 `globalThis.fetch` ——
 * **每次调用现取**，不在模块加载时固化（否则测试的 fetch 桩件会静默失效）。
 */
export function createLoginPanel(requirePrimitives: (name: string) => unknown, fetchImpl?: FetchLike) {
  const prim = requirePrimitives("@deepseek-ai/dsh-client-ui-primitives") as Record<string, unknown>;
  const React = requirePrimitives("react") as ReactLike;
  void prim;

  const activeFetch: FetchLike = (input, init) => {
    if (fetchImpl !== undefined) return fetchImpl(input, init);
    const impl = (globalThis as { fetch?: FetchLike }).fetch;
    if (impl === undefined) return Promise.reject(new Error("fetch unavailable"));
    return impl(input, init);
  };

  return function LoginPanel(props: LoginPanelProps): unknown {
    const { t } = props;
    // 没有 hooks 的环境（宿主外的静态渲染 / 部分测试桩件）直接出一个静态快照，
    // 而不是抛 "useState is not a function"。这保证组件在任何 React 面上都能渲染。
    if (typeof React.useState !== "function") return renderStatic(t);
    const [payload, setPayload] = React.useState<LoginStatusPayload | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState("");
    const alive = React.useRef(true);
    const polling = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    // 卸载时停轮询并标记失效，避免 setState 落到已卸载的组件上。
    React.useEffect(() => () => {
      alive.current = false;
      if (polling.current !== undefined) clearTimeout(polling.current);
    }, []);

    const apply = React.useCallback((next: LoginStatusPayload) => {
      if (!alive.current) return;
      setPayload(next);
      if (polling.current !== undefined) clearTimeout(polling.current);
      if (shouldPoll(next.progress)) {
        polling.current = setTimeout(() => {
          void fetchLoginStatus(activeFetch).then(apply);
        }, POLL_MS);
      }
    }, []);
    React.useEffect(() => {
      void fetchLoginStatus(activeFetch).then(apply);
    }, [apply]);

    const progress = payload?.progress ?? null;
    const stored = payload?.stored ?? null;
    const running = progress !== null && shouldPoll(progress);

    const onStart = React.useCallback(() => {
      setBusy(true);
      setNotice("");
      void startBrowserLogin(activeFetch)
        .then((next) => {
          if (!alive.current) return;
          apply({ ok: true, stored: payload?.stored ?? defaultStored(), progress: next });
        })
        .finally(() => {
          if (alive.current) setBusy(false);
        });
    }, [apply, payload]);

    const onCancel = React.useCallback(() => {
      setBusy(true);
      void cancelBrowserLogin(activeFetch)
        .then((next) => {
          if (!alive.current) return;
          apply({ ok: true, stored: payload?.stored ?? defaultStored(), progress: next });
        })
        .finally(() => {
          if (alive.current) setBusy(false);
        });
    }, [apply, payload]);

    const onLogout = React.useCallback(() => {
      setBusy(true);
      void logoutStoredAuth(activeFetch)
        .then((next) => {
          if (!alive.current) return;
          apply(next);
          setNotice(t("loginLogoutConfirm"));
        })
        .finally(() => {
          if (alive.current) setBusy(false);
        });
    }, [apply, t]);

    // ---------------------------------------------------------------------
    // 渲染
    // ---------------------------------------------------------------------
    ensureStyleSafe();

    return renderPanel(React, t, {
      stored,
      progress,
      busy,
      notice,
      onStart,
      onCancel,
      onLogout,
    });
  };

  /**
   * 无 hooks 环境下的静态渲染：按钮不带 onClick（点了也没状态机可驱动），
   * 但结构、文案、样式都在，便于宿主外的静态快照与测试断言。
   */
  function renderStatic(t: (key: string) => string): unknown {
    ensureStyleSafe();
    return renderPanel(React, t, {
      stored: null,
      progress: null,
      busy: false,
      notice: "",
      onStart: undefined,
      onCancel: undefined,
      onLogout: undefined,
    });
  }

  /** 样式挂到当前文档；没有 document（测试环境）就跳过。 */
  function ensureStyleSafe(): void {
    try {
      const doc = (globalThis as { document?: Document }).document;
      if (doc !== undefined) ensureStyle(doc);
    } catch {
      /* 非浏览器环境 */
    }
  }

  /** 共用的渲染体，hooks 路径与静态回退都走它，保证两者不会漂移。 */
  function renderPanel(
    ReactImpl: ReactLike,
    t: (key: string) => string,
    view: {
      stored: StoredAuthView | null;
      progress: LoginStatusPayload["progress"] | null;
      busy: boolean;
      notice: string;
      onStart: (() => void) | undefined;
      onCancel: (() => void) | undefined;
      onLogout: (() => void) | undefined;
    },
  ): unknown {
    const { stored, progress, busy, notice } = view;
    const progressView = progress === null ? { text: "", tone: "" } : describeProgress(progress, t);
    const storedView = stored === null ? { text: t("loginWaiting"), tone: "" } : describeStored(stored, notice);
    const hasAuth = stored !== null && stored.authStatus !== "missing";
    const running = progress !== null && shouldPoll(progress);
    const canStart = !busy && !running && view.onStart !== undefined;

    const children: unknown[] = [
      ReactImpl.createElement(
        "div",
        { className: "cgw-login-head", key: "head" },
        ReactImpl.createElement("span", { className: "cgw-login-title", key: "t" }, t("login")),
      ),
      ReactImpl.createElement(
        "div",
        { className: "cgw-login-state", "data-tone": storedView.tone, role: "status", key: "stored" },
        ReactImpl.createElement("strong", null, t("loginStored") + "："),
        stored === null
          ? t("loginWaiting")
          : stored.authStatus === "missing"
            ? describeStoredAuth(stored)
            : (stored.capturedAt !== null ? describeCapturedAt(stored.capturedAt) : "未记录") +
              " · token " + String(stored.tokenLength) + " 字符" +
              (stored.hasCookie ? " · " + String(stored.cookieCount) + " 项 cookie" : "") +
              (stored.dataBuild !== null ? " · build " + stored.dataBuild : ""),
      ),
      progressView.text.length > 0
        ? ReactImpl.createElement("div", { className: "cgw-login-progress", "data-tone": progressView.tone, role: "status", key: "prog" }, progressView.text)
        : null,
      ReactImpl.createElement(
        "div",
        { className: "cgw-login-row", key: "row" },
        ReactImpl.createElement(
          "button",
          {
            type: "button",
            className: "cgw-btn",
            "data-variant": "primary",
            disabled: !canStart,
            ...(view.onStart ? { onClick: view.onStart } : {}),
            key: "start",
          },
          hasAuth ? t("loginRestart") : t("loginStart"),
        ),
        running && view.onCancel !== undefined
          ? ReactImpl.createElement("button", { type: "button", className: "cgw-btn", disabled: busy, onClick: view.onCancel, key: "cancel" }, t("loginCancel"))
          : null,
        hasAuth && view.onLogout !== undefined
          ? ReactImpl.createElement("button", { type: "button", className: "cgw-btn", disabled: busy || running, onClick: view.onLogout, key: "logout" }, t("loginLogout"))
          : null,
      ),
      ReactImpl.createElement(
        "div",
        { className: "cgw-login-hint", key: "hint" },
        ReactImpl.createElement("div", null, t("loginHint")),
        ReactImpl.createElement("div", null, t("loginBrowserHint")),
      ),
    ];

    return ReactImpl.createElement("div", { className: "cgw-login" }, ...children.filter((c) => c !== null));
  }
}

/** 状态未知时的占位，避免把 undefined 传进类型。 */
function defaultStored(): StoredAuthView {
  return { authStatus: "missing", capturedAt: null, planType: null, dataBuild: null, hasCookie: false, cookieCount: 0, tokenLength: 0 };
}
