import { ok, eq, section } from "./harness.mjs";
import { Gate, DEFAULT_GATE } from "../src/gate/gate.ts";

function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; },
  };
}

const cfg = {
  minIntervalMs: 5000,
  maxIntervalMs: 5000,
  longRunThreshold: 3,
  longRestMinMs: 1000,
  longRestMaxMs: 1000,
  rateWindowMs: 60_000,
  rateMaxInWindow: 10,
};

section("单飞：上一条没处理完不能发下一条");
{
  const c = clock();
  const g = new Gate(cfg, c.now);
  eq(g.acquire().ok, true, "首次获取成功");
  const second = g.acquire();
  eq(second.ok, false, "第二次被拒");
  eq(second.reason, "busy", "原因是 busy");
  g.release();
  c.advance(5000);
  eq(g.acquire().ok, true, "释放并等待后可再获取");
}

section("busy 时即使等很久也不复用（必须显式 release）");
{
  const c = clock();
  const g = new Gate(cfg, c.now);
  g.acquire();
  c.advance(10 * 60_000);
  eq(g.acquire().reason, "busy", "再久也还是 busy");
}

section("释放后单飞锁打开");
{
  const c = clock();
  const g = new Gate(cfg, c.now);
  g.acquire();
  g.releaseFailed();
  eq(g.snapshot().inFlight, false, "releaseFailed 也解锁");
}

section("间隔闸：从上次结束算起");
{
  const c = clock();
  const g = new Gate(cfg, c.now);
  eq(g.acquire().ok, true, "首次不受间隔限制");
  c.advance(1000);
  g.release();
  c.advance(1000);
  const d = g.acquire();
  eq(d.ok, false, "刚结束 1s，不够 5s");
  eq(d.reason, "interval", "原因是 interval");
  eq(d.waitMs, 4000, "还需等 4000ms");
  c.advance(4000);
  eq(g.acquire().ok, true, "等够后放行");
}

section("长休：连续 N 次后强制休息");
{
  const c = clock();
  const g = new Gate(cfg, c.now);
  for (let i = 0; i < 3; i++) {
    const d = g.acquire();
    if (!d.ok) { c.advance(d.waitMs); eq(g.acquire().ok, true, "等待后获取 " + i); }
    g.release();
    c.advance(5000);
  }
  const d = g.acquire();
  eq(d.ok, false, "连发 3 次后触发长休");
  eq(d.reason, "long-rest", "原因是 long-rest");
  eq(d.waitMs, 1000, "长休时长按区间");
  c.advance(1000);
  eq(g.acquire().ok, true, "长休结束后放行");
}

section("滚动窗口限速");
{
  const c = clock();
  const small = { ...cfg, rateMaxInWindow: 3, longRunThreshold: 999 };
  const g = new Gate(small, c.now);
  for (let i = 0; i < 3; i++) {
    eq(g.acquire().ok, true, "窗口内第 " + (i + 1) + " 次");
    g.release();
    c.advance(5000);
  }
  const d = g.acquire();
  eq(d.ok, false, "第 4 次被窗口限制");
  eq(d.reason, "rate-window", "原因是 rate-window");
  ok(d.waitMs > 0, "给出等待时长 " + d.waitMs);
  c.advance(d.waitMs);
  eq(g.acquire().ok, true, "滑出窗口后放行");
}

section("窗口按时间滑出");
{
  const c = clock();
  const small = { ...cfg, rateMaxInWindow: 2, longRunThreshold: 999, rateWindowMs: 10000 };
  const g = new Gate(small, c.now);
  g.acquire(); g.release();
  c.advance(5000);
  g.acquire(); g.release();
  eq(g.acquire().ok, false, "两条都在窗口内");
  c.advance(6000);
  eq(g.acquire().ok, true, "第一条滑出后可再发");
}

section("release 计数与快照");
{
  const c = clock();
  const g = new Gate(cfg, c.now);
  g.acquire(); g.release();
  eq(g.snapshot().consecutive, 1, "连续计数 1");
  eq(g.snapshot().recent.length, 1, "窗口内有 1 条");
  g.acquire(); g.releaseFailed();
  eq(g.snapshot().consecutive, 1, "失败不增加连续计数");
}

section("默认配置：严格串行");
ok(DEFAULT_GATE.minIntervalMs >= 4000, "默认间隔 >= 4s（比 DeepSeek 版更保守）");
ok(DEFAULT_GATE.rateMaxInWindow <= 12, "默认窗口上限 <= 12 次/30min");
