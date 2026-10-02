// 止损冷却分钟数（sl_cooldown_minutes）专项测试。运行：node --test server/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CoinGuard, clampGuardCfg, clampSlCooldownMinutes, GUARD_DEFAULTS, SL_COOLDOWN_MAX_MINUTES } from '../coinGuard.js';

const MIN = 60 * 1000;
const H = 60 * MIN;
const T0 = Date.parse('2026-10-02T10:00:00+08:00');
/** 关闭「窗口内多次止损」规则的干扰：阈值调到最大 */
const base = (over = {}) => ({ ...GUARD_DEFAULTS, max_consecutive_sl: 20, ...over });

function mk(dir) {
  const clock = { t: T0 };
  const logs = [];
  const g = new CoinGuard({ path: dir ? join(dir, 'cooldowns.json') : null, now: () => clock.t, log: (l, m) => logs.push([l, m]) });
  return { g, clock, logs };
}

test('配置钳制：默认 60、0 允许、上限 10080、非法值回退默认、取整', () => {
  assert.equal(SL_COOLDOWN_MAX_MINUTES, 10080);
  assert.equal(GUARD_DEFAULTS.sl_cooldown_minutes, 60);
  assert.equal(clampGuardCfg({}).sl_cooldown_minutes, 60);
  assert.equal(clampGuardCfg().sl_cooldown_minutes, 60);
  assert.equal(clampSlCooldownMinutes(0), 0);
  assert.equal(clampSlCooldownMinutes('0'), 0);
  assert.equal(clampSlCooldownMinutes(15), 15);
  assert.equal(clampSlCooldownMinutes('45'), 45);
  assert.equal(clampSlCooldownMinutes(10080), 10080);
  assert.equal(clampSlCooldownMinutes(10081), 10080);
  assert.equal(clampSlCooldownMinutes(99999999), 10080);
  assert.equal(clampSlCooldownMinutes(Infinity), 60); // 非有限数 → 默认
  for (const bad of ['abc', '', null, undefined, NaN, -5, '-1']) {
    assert.equal(clampSlCooldownMinutes(bad), 60, `非法值 ${String(bad)} 应回退默认 60`);
  }
  assert.equal(clampSlCooldownMinutes(30.6), 31);
  // 两档互相独立：改普通档不影响严重档
  const c = clampGuardCfg({ sl_cooldown_minutes: 5, severe_sl_cooldown_hours: 48 });
  assert.equal(c.sl_cooldown_minutes, 5);
  assert.equal(c.severe_sl_cooldown_hours, 48);
});

test('止损后进入冷却，时长等于配置的分钟数', () => {
  for (const minutes of [1, 15, 90, 1440, 10080]) {
    const { g, clock } = mk(null);
    const r = g.onStopLoss('sim', 'AAA-USDT', base({ sl_cooldown_minutes: minutes }), { lossPct: -1 });
    assert.ok(r, `${minutes} 分钟应进入冷却`);
    assert.equal(r.kind, 'normal');
    assert.equal(r.until - clock.t, minutes * MIN);
    const c = g.check('sim', 'AAA-USDT');
    assert.equal(c.until - clock.t, minutes * MIN);
    assert.equal(c.kind, 'normal');
    assert.match(r.reason, new RegExp(`冷却 ${minutes} 分钟`));
  }
});

test('超过上限的输入按 10080 分钟冷却；非法输入按默认 60 分钟冷却', () => {
  const a = mk(null);
  const r1 = a.g.onStopLoss('sim', 'AAA-USDT', base({ sl_cooldown_minutes: 500000 }), { lossPct: -1 });
  assert.equal(r1.until - a.clock.t, 10080 * MIN);
  const b = mk(null);
  const r2 = b.g.onStopLoss('sim', 'AAA-USDT', base({ sl_cooldown_minutes: 'abc' }), { lossPct: -1 });
  assert.equal(r2.until - b.clock.t, 60 * MIN);
});

test('配置为 0 分钟：止损后不冷却，可立刻再入场', () => {
  const { g, clock, logs } = mk(null);
  const r = g.onStopLoss('sim', 'AAA-USDT', base({ sl_cooldown_minutes: 0 }), { lossPct: -1 });
  assert.equal(r, null);
  assert.equal(g.check('sim', 'AAA-USDT'), null);
  assert.deepEqual(g.list(base({ sl_cooldown_minutes: 0 })), []);
  assert.ok(logs.some(([, m]) => m.includes('冷却已关闭')));
  clock.t += 1;
  assert.equal(g.check('sim', 'AAA-USDT'), null);
});

test('0 分钟只关闭普通档：严重止损仍按严重档冷却', () => {
  const { g, clock } = mk(null);
  const cfg = base({ sl_cooldown_minutes: 0 });
  const r = g.onStopLoss('sim', 'BBB-USDT', cfg, { lossPct: -4 });
  assert.equal(r.kind, 'severe');
  assert.equal(r.until - clock.t, 24 * H);
});

test('冷却期内同币被拦截并给出中文原因，其它币不受影响', () => {
  const { g, clock } = mk(null);
  g.onStopLoss('sim', 'AAA-USDT', base({ sl_cooldown_minutes: 30 }), { lossPct: -1 });
  const c = g.check('sim', 'AAA-USDT');
  assert.equal(c.text, '冷却中：普通止损，剩余30分钟');
  clock.t += 10 * MIN;
  assert.equal(g.check('sim', 'AAA-USDT').text, '冷却中：普通止损，剩余20分钟');
  assert.equal(g.check('sim', 'CCC-USDT'), null);
  assert.equal(g.check('okx_demo', 'AAA-USDT'), null); // 按执行模式分开
  const list = g.list(base());
  assert.equal(list.length, 1);
  assert.equal(list[0].instId, 'AAA-USDT');
  assert.equal(list[0].remainingMs, 20 * MIN);
  assert.equal(list[0].remainingText, '剩余20分钟');
});

test('冷却到期后可再入场，再次止损重新计时', () => {
  const { g, clock } = mk(null);
  const cfg = base({ sl_cooldown_minutes: 30 });
  g.onStopLoss('sim', 'AAA-USDT', cfg, { lossPct: -1 });
  clock.t += 30 * MIN - 1;
  assert.ok(g.check('sim', 'AAA-USDT'), '到期前 1 毫秒仍在冷却');
  clock.t += 1;
  assert.equal(g.check('sim', 'AAA-USDT'), null, '到期后可再入场');
  assert.deepEqual(g.list(cfg), []);
  const r = g.onStopLoss('sim', 'AAA-USDT', cfg, { lossPct: -1 });
  assert.equal(r.until - clock.t, 30 * MIN);
});

test('止盈不触发冷却，也不解除已有冷却', () => {
  const { g, clock } = mk(null);
  assert.equal(g.onTakeProfit('sim', 'AAA-USDT'), null);
  assert.equal(g.check('sim', 'AAA-USDT'), null); // 止盈本身不冷却
  g.onStopLoss('sim', 'BBB-USDT', base({ sl_cooldown_minutes: 30 }), { lossPct: -1 });
  clock.t += 5 * MIN;
  g.onTakeProfit('sim', 'BBB-USDT');
  assert.equal(g.check('sim', 'BBB-USDT').text, '冷却中：普通止损，剩余25分钟');
});

test('修改配置只影响之后的止损：已在冷却中的币到期时间不变', () => {
  const { g, clock } = mk(null);
  const first = g.onStopLoss('sim', 'AAA-USDT', base({ sl_cooldown_minutes: 60 }), { lossPct: -1 });
  const until0 = first.until;
  clock.t += 10 * MIN;
  // 改成更短的 5 分钟：再次止损不会缩短已有冷却
  const second = g.onStopLoss('sim', 'AAA-USDT', base({ sl_cooldown_minutes: 5 }), { lossPct: -1 });
  assert.equal(second.until, until0);
  assert.equal(g.check('sim', 'AAA-USDT').until, until0);
  // list / prune 用新配置也不改变到期时间
  assert.equal(g.list(base({ sl_cooldown_minutes: 1 }))[0].remainingMs, 50 * MIN);
  // 新止损的币使用新配置
  const other = g.onStopLoss('sim', 'DDD-USDT', base({ sl_cooldown_minutes: 5 }), { lossPct: -1 });
  assert.equal(other.until - clock.t, 5 * MIN);
});

test('持久化与重启恢复：冷却到期时间按配置分钟数落盘并继续计时', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-slcd-'));
  try {
    const a = mk(dir);
    a.g.onStopLoss('okx_demo', 'AAA-USDT', base({ sl_cooldown_minutes: 90 }), { lossPct: -1 });
    const saved = JSON.parse(readFileSync(join(dir, 'cooldowns.json'), 'utf8'));
    assert.equal(saved.items[0].cooldown.until, T0 + 90 * MIN);
    assert.equal(saved.items[0].cooldown.kind, 'normal');

    // 模拟重启：新实例从文件恢复
    const b = mk(dir);
    b.clock.t = T0 + 30 * MIN;
    assert.equal(b.g.load(base()), 1);
    assert.equal(b.g.check('okx_demo', 'AAA-USDT').text, '冷却中：普通止损，剩余60分钟');
    assert.equal(b.g.check('sim', 'AAA-USDT'), null);

    // 重启前后配置改成 0 / 5 分钟，也不改变已落盘冷却的到期时间
    assert.equal(b.g.list(base({ sl_cooldown_minutes: 0 }))[0].remainingMs, 60 * MIN);

    // 到期后再重启：已过期冷却被清理，可再入场
    const c = mk(dir);
    c.clock.t = T0 + 90 * MIN;
    assert.equal(c.g.load(base()), 0);
    assert.equal(c.g.check('okx_demo', 'AAA-USDT'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
