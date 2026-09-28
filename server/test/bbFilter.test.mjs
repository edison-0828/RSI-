// 运行：node --test server/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcBollinger, applyBbFilter, clampBbCfg, BB_DEFAULTS } from '../bbFilter.js';
import { CandleStore } from '../candleStore.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// 手算数据（period=20, mult=2）：前 19 根 = 9×98 + 9×102 + 1×100
const C19 = [...Array(9).fill(98), ...Array(9).fill(102), 100];
// 实时价 100：均值 2000/20=100；平方差和 18×4=72；总体方差 72/20=3.6；sd=√3.6=1.8973666；下轨=100−2×1.8973666=96.2052668
const LOWER_AT_100 = 100 - 2 * Math.sqrt(3.6);
// 实时价 90：均值 1990/20=99.5；平方差和 9×2.25+9×6.25+0.25+90.25=167；方差 8.35；sd=2.8896367；下轨=99.5−5.7792733=93.7207267
const LOWER_AT_90 = 99.5 - 2 * Math.sqrt(8.35);

const ON = { bb_filter_enabled: true, bb_period: 20, bb_mult: 2 };
const OFF = { bb_filter_enabled: false, bb_period: 20, bb_mult: 2 };

test('下轨计算：对照手算数据（总体标准差 ddof=0）', () => {
  const a = calcBollinger(C19, 100, 20, 2);
  near(a.mid, 100);
  near(a.sd, 1.8973665961);
  near(a.lower, 96.2052668078);
  near(a.lower, LOWER_AT_100);
  // 不是样本标准差（ddof=1 时 sd=√(72/19)=1.9466）
  assert.ok(Math.abs(a.sd - Math.sqrt(72 / 19)) > 0.01);

  const b = calcBollinger(C19, 90, 20, 2);
  near(b.mid, 99.5);
  near(b.lower, 93.7207267);
  near(b.lower, LOWER_AT_90);

  // 小样本：period=5, mult=1，[10,12,11,13] + 实时价 9 → 均值 11，方差 10/5=2，下轨 11−√2=9.5857864
  const c = calcBollinger([10, 12, 11, 13], 9, 5, 1);
  near(c.mid, 11);
  near(c.lower, 9.5857864376);
});

test('只取最后 period-1 根已收盘价，更早的 K 线不参与', () => {
  const a = calcBollinger([1, 5000, 3, ...C19], 100, 20, 2);
  near(a.lower, LOWER_AT_100);
});

test('默认值：旧配置缺字段 → 关闭 / 20 / 2.0；非法值回落默认', () => {
  assert.deepEqual(clampBbCfg({}), { bb_filter_enabled: false, bb_period: 20, bb_mult: 2 });
  assert.deepEqual(clampBbCfg({ rsi_buy_threshold: 20, amount: 100 }), { ...BB_DEFAULTS });
  assert.deepEqual(clampBbCfg({ bb_filter_enabled: 'true', bb_period: '30', bb_mult: '2.5' }), { bb_filter_enabled: true, bb_period: 30, bb_mult: 2.5 });
  assert.deepEqual(clampBbCfg({ bb_filter_enabled: 'yes', bb_period: 'abc', bb_mult: -1 }), { bb_filter_enabled: false, bb_period: 20, bb_mult: 2 });
  assert.equal(clampBbCfg({ bb_period: 1 }).bb_period, 2);
  assert.equal(clampBbCfg({ bb_period: 500 }).bb_period, 100);
});

test('开关关闭：不影响买入（价格高于下轨、K 线不足都照常按 RSI 放行）', () => {
  for (const cfg of [OFF, {}, { rsi_buy_threshold: 20 }]) {
    const r1 = applyBbFilter(true, { closes: C19, price: 100 }, cfg); // 价格高于下轨
    assert.equal(r1.signal, true);
    assert.equal(r1.blocked, false);
    assert.equal(r1.reason, null);
    const r2 = applyBbFilter(true, { closes: [1, 2], price: 3 }, cfg); // K 线不足
    assert.equal(r2.signal, true);
    assert.equal(r2.blocked, false);
    const r3 = applyBbFilter(false, { closes: C19, price: 90 }, cfg); // RSI 未触发仍不买
    assert.equal(r3.signal, false);
    assert.equal(r3.blocked, false);
  }
});

test('开关打开：RSI 触发但价格高于下轨 → 被挡，中文原因含价格与下轨', () => {
  const r = applyBbFilter(true, { closes: C19, price: 100 }, ON);
  assert.equal(r.signal, false);
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'above');
  near(r.lower, LOWER_AT_100);
  assert.equal(r.reason, '未跌破布林下轨（价 100.0000 / 下轨 96.2053）');
  // 恰好等于下轨也不放行（要求严格低于）
  const eq = applyBbFilter(true, { closes: [10, 10, 10, 10], price: 10 }, { ...ON, bb_period: 5 });
  assert.equal(eq.signal, false);
});

test('开关打开：RSI 触发且价格低于下轨 → 放行', () => {
  const r = applyBbFilter(true, { closes: C19, price: 90 }, ON);
  assert.equal(r.signal, true);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, null);
  near(r.lower, LOWER_AT_90);
});

test('开关打开：RSI 未触发 → 不买、也不产生跳过原因（只附带下轨数值）', () => {
  const r = applyBbFilter(false, { closes: C19, price: 90 }, ON);
  assert.equal(r.signal, false);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, null);
  near(r.lower, LOWER_AT_90);
});

test('开关打开：K 线不足 period 根 → 不买并给出原因', () => {
  const r = applyBbFilter(true, { closes: C19.slice(1), price: 50 }, ON); // 只有 18 根已收盘
  assert.equal(r.signal, false);
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'insufficient');
  assert.equal(r.lower, null);
  assert.equal(r.reason, '布林带K线不足（已收盘 18/19 根），暂不买入');
  const n = applyBbFilter(true, { closes: C19, price: null }, ON); // 无实时价
  assert.equal(n.signal, false);
  assert.equal(n.blocked, true);
  assert.equal(calcBollinger(C19.slice(1), 50, 20, 2), null);
  // 恰好 19 根已收盘 + 实时价 = 20 个样本即可计算
  assert.notEqual(calcBollinger(C19, 50, 20, 2), null);
});

test('CandleStore.closes 返回已收盘收盘价副本（不含未收盘 K 线）', () => {
  const cs = new CandleStore({ maxBars: 200, period: 6 });
  const rows = C19.map((c, i) => [String(1000 + i * 900000), '0', '0', '0', String(c), '0', '0', '0', '1']);
  rows.push([String(1000 + 19 * 900000), '0', '0', '0', '95', '0', '0', '0', '0']); // 未收盘
  cs.bootstrap('X-USDT-SWAP', rows);
  const got = cs.closes('X-USDT-SWAP');
  assert.deepEqual(got, C19);
  got.push(1);
  assert.equal(cs.closes('X-USDT-SWAP').length, 19);
  assert.deepEqual(cs.closes('NONE'), []);
  assert.equal(cs.snapshot('X-USDT-SWAP').price, 95);
});
