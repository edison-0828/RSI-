// 运行：node --test server/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CoinGuard, clampGuardCfg, GUARD_DEFAULTS } from '../coinGuard.js';

const MIN = 60 * 1000;
const H = 60 * MIN;
const CFG = { ...GUARD_DEFAULTS }; // 60 分钟 / 3% / 24 小时 / 2 次 / 24 小时窗口

function mk(dir, t0 = Date.parse('2026-09-28T10:00:00+08:00')) {
  const clock = { t: t0 };
  const logs = [];
  const g = new CoinGuard({ path: dir ? join(dir, 'cooldowns.json') : null, now: () => clock.t, log: (l, m) => logs.push([l, m]) });
  return { g, clock, logs };
}

test('默认参数与夹紧', () => {
  assert.deepEqual(clampGuardCfg({}), { sl_cooldown_minutes: 60, severe_sl_pct: 3, severe_sl_cooldown_hours: 24, max_consecutive_sl: 2, sl_filter_hours: 24 });
  const c = clampGuardCfg({ sl_cooldown_minutes: 99999, severe_sl_pct: 0.1, severe_sl_cooldown_hours: -5, sl_filter_hours: 'abc' });
  assert.equal(c.sl_cooldown_minutes, 10080);
  assert.equal(c.severe_sl_pct, 0.5);
  assert.equal(c.severe_sl_cooldown_hours, 0);
  assert.equal(c.sl_filter_hours, 24);
});

test('普通止损：冷却 60 分钟，剩余时间递减，到期解除', () => {
  const { g, clock } = mk(null);
  const r = g.onStopLoss('okx_live', 'GPS-USDT-SWAP', CFG, { lossPct: -2.1 });
  assert.equal(r.kind, 'normal');
  let c = g.check('okx_live', 'GPS-USDT-SWAP');
  assert.equal(c.kind, 'normal');
  assert.equal(c.text, '冷却中：普通止损，剩余60分钟');
  clock.t += 15 * MIN + 10 * 1000;
  c = g.check('okx_live', 'GPS-USDT-SWAP');
  assert.equal(c.text, '冷却中：普通止损，剩余45分钟');
  // 其它模式 / 其它币不受影响
  assert.equal(g.check('sim', 'GPS-USDT-SWAP'), null);
  assert.equal(g.check('okx_live', 'BTC-USDT-SWAP'), null);
  clock.t += 45 * MIN;
  assert.equal(g.check('okx_live', 'GPS-USDT-SWAP'), null);
});

test('严重止损：亏损 ≥3%（不含杠杆）冷却 24 小时；强平也按严重', () => {
  const { g, clock } = mk(null);
  const r = g.onStopLoss('okx_demo', 'SENT-USDT-SWAP', CFG, { lossPct: -5.02 });
  assert.equal(r.kind, 'severe');
  assert.equal(r.until - clock.t, 24 * H);
  const c = g.check('okx_demo', 'SENT-USDT-SWAP');
  assert.match(c.text, /^冷却中：严重止损，剩余1440分钟/);
  // 恰好等于阈值也算严重
  const r2 = g.onStopLoss('okx_demo', 'A-USDT-SWAP', CFG, { lossPct: -3 });
  assert.equal(r2.kind, 'severe');
  const r3 = g.onStopLoss('okx_demo', 'B-USDT-SWAP', CFG, { lossPct: -0.5, liq: true });
  assert.equal(r3.kind, 'severe');
  // 自定义阈值 6% → 5% 亏损只算普通
  const r4 = g.onStopLoss('okx_demo', 'C-USDT-SWAP', { ...CFG, severe_sl_pct: 6, sl_cooldown_minutes: 30 }, { lossPct: -5 });
  assert.equal(r4.kind, 'normal');
  assert.equal(r4.until - clock.t, 30 * MIN);
});

test('冷却按平仓时间计算（对账晚发现的平仓）', () => {
  const { g, clock } = mk(null);
  g.onStopLoss('okx_live', 'X-USDT-SWAP', CFG, { lossPct: -2, at: clock.t - 20 * MIN });
  assert.equal(g.check('okx_live', 'X-USDT-SWAP').text, '冷却中：普通止损，剩余40分钟');
  // 平仓时间早于冷却时长 → 不再冷却（但计入窗口止损次数）
  const r = g.onStopLoss('okx_live', 'Y-USDT-SWAP', CFG, { lossPct: -2, at: clock.t - 2 * H });
  assert.equal(r, null);
  assert.equal(g.slCount('okx_live', 'Y-USDT-SWAP', CFG), 1);
});

test('窗口内止损 2 次 → 暂停 24 小时；中间止盈不清零', () => {
  const { g, clock } = mk(null);
  const inst = 'GPS-USDT-SWAP';
  g.onStopLoss('okx_live', inst, CFG, { lossPct: -2 });
  clock.t += 2 * H; // 普通冷却已过
  assert.equal(g.check('okx_live', inst), null);
  g.onTakeProfit('okx_live', inst); // 止盈
  assert.equal(g.slCount('okx_live', inst, CFG), 1, '止盈不应清零止损次数');
  clock.t += 3 * H;
  const r = g.onStopLoss('okx_live', inst, CFG, { lossPct: -1.9 });
  assert.equal(r.kind, 'streak');
  assert.equal(r.count, 2);
  assert.equal(r.until - clock.t, 24 * H);
  assert.match(g.check('okx_live', inst).text, /^冷却中：连续止损，剩余1440分钟/);
});

test('窗口外的止损自然过期，不计入次数', () => {
  const { g, clock } = mk(null);
  const inst = 'OLD-USDT-SWAP';
  g.onStopLoss('sim', inst, CFG, { lossPct: -2 });
  clock.t += 25 * H;
  const r = g.onStopLoss('sim', inst, CFG, { lossPct: -2 });
  assert.equal(r.kind, 'normal');
  assert.equal(r.count, 1);
});

test('冷却不会被更短的冷却缩短', () => {
  const { g, clock } = mk(null);
  g.onStopLoss('okx_live', 'Z-USDT-SWAP', { ...CFG, max_consecutive_sl: 5 }, { lossPct: -4 }); // 严重 24h
  clock.t += 1 * H;
  const r = g.onStopLoss('okx_live', 'Z-USDT-SWAP', { ...CFG, max_consecutive_sl: 5 }, { lossPct: -1 }); // 普通 60 分钟
  assert.equal(r.kind, 'severe');
  assert.equal(r.until - clock.t, 23 * H);
});

test('冷却状态落盘，重启后恢复并继续计时', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-'));
  try {
    const a = mk(dir);
    a.g.onStopLoss('okx_live', 'GPS-USDT-SWAP', CFG, { lossPct: -5 });
    a.g.onStopLoss('okx_live', 'SENT-USDT-SWAP', CFG, { lossPct: -1.2 });
    assert.ok(existsSync(join(dir, 'cooldowns.json')));
    const saved = JSON.parse(readFileSync(join(dir, 'cooldowns.json'), 'utf8'));
    assert.equal(saved.items.length, 2);
    // 「重启」：新实例，10 分钟后
    const b = mk(dir, a.clock.t + 10 * MIN);
    const n = b.g.load(CFG);
    assert.equal(n, 2);
    assert.match(b.g.check('okx_live', 'GPS-USDT-SWAP').text, /^冷却中：严重止损，剩余1430分钟/);
    assert.equal(b.g.check('okx_live', 'SENT-USDT-SWAP').text, '冷却中：普通止损，剩余50分钟');
    // 重启后窗口止损次数仍在：GPS 再止损一次 → 连续止损过滤
    b.clock.t += 24 * H + 5 * MIN; // 严重冷却结束，但窗口 24h：首次止损在 24h5m 前 → 已出窗口
    assert.equal(b.g.slCount('okx_live', 'GPS-USDT-SWAP', CFG), 0);
    // 已过期的冷却在重启加载时被清理
    const c = mk(dir, a.clock.t + 2 * H);
    c.g.load(CFG);
    assert.equal(c.g.check('okx_live', 'SENT-USDT-SWAP'), null);
    assert.equal(c.g.list(CFG).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重启后窗口内次数恢复：止损→重启→再止损触发过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-'));
  try {
    const a = mk(dir);
    a.g.onStopLoss('okx_live', 'K-USDT-SWAP', CFG, { lossPct: -1 });
    const b = mk(dir, a.clock.t + 3 * H);
    b.g.load(CFG);
    assert.equal(b.g.slCount('okx_live', 'K-USDT-SWAP', CFG), 1);
    const r = b.g.onStopLoss('okx_live', 'K-USDT-SWAP', CFG, { lossPct: -1 });
    assert.equal(r.kind, 'streak');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('首次启用按账本补建冷却；手动解除', () => {
  const { g, clock } = mk(null);
  const iso = (ms) => new Date(ms).toISOString();
  const trades = [
    { instId: 'GPS-USDT-SWAP', action: 'sl', profit_pct: -5.0, exec_mode: 'okx_live', closed_at: iso(clock.t - 30 * MIN) },
    { instId: 'SENT-USDT-SWAP', action: 'sl', profit_pct: -2.2, exec_mode: 'okx_live', closed_at: iso(clock.t - 20 * MIN) },
    { instId: 'SENT-USDT-SWAP', action: 'tp', profit_pct: 1, exec_mode: 'okx_live', closed_at: iso(clock.t - 10 * MIN) },
    { instId: 'OLD-USDT-SWAP', action: 'sl', profit_pct: -2, exec_mode: 'okx_live', closed_at: iso(clock.t - 5 * H) },
  ];
  const n = g.seedFromTrades(trades, CFG);
  assert.equal(n, 2);
  assert.match(g.check('okx_live', 'GPS-USDT-SWAP').text, /^冷却中：严重止损，剩余1410分钟/);
  assert.equal(g.check('okx_live', 'SENT-USDT-SWAP').text, '冷却中：普通止损，剩余40分钟');
  assert.equal(g.check('okx_live', 'OLD-USDT-SWAP'), null);
  assert.equal(g.slCount('okx_live', 'OLD-USDT-SWAP', CFG), 1);
  assert.equal(g.clear('GPS-USDT-SWAP'), 1);
  assert.equal(g.check('okx_live', 'GPS-USDT-SWAP'), null);
});
