// 阶段 1：positionMath（仅做多）—— 与改造前 index.js / pnl.js / executor.js 中的旧表达式逐位（Object.is）比对
import test from 'node:test';
import assert from 'node:assert/strict';
import * as pm from '../engine/positionMath.js';
import { withStrategyDefaults, normalizePosition } from '../engine/normalize.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 旧表达式（逐字拷贝自 4b80682） ----
const oldProfit = (entry, price) => ((price - entry) / entry) * 100; // index.js L1293/L1461/L1722 等
const oldTp = (entry, tpPct) => entry * (1 + tpPct / 100); // index.js L1239/L1462
const oldSl = (entry, slPct) => entry * (1 - slPct / 100); // index.js L1240/L1463
const oldInfer = (entry, closePx) => (closePx >= entry ? 'tp' : 'sl'); // index.js L2031 / executor.js L796

test('positionMath：做多分支与旧表达式 Object.is 逐位一致（随机 + 边界，各 20 万）', () => {
  const r = rng(42);
  const entries = [1e-8, 0.00012345, 0.5, 1, 3.14159, 100, 12345.6789, 1e6];
  for (let i = 0; i < 200_000; i++) {
    const entry = i < 100 ? entries[i % entries.length] : Math.exp((r() - 0.5) * 30);
    const price = entry * (1 + (r() - 0.5) * 0.6);
    const tp = [0.1, 1, 3, 6, 8, 12.5, r() * 30][i % 7];
    const sl = [0.1, 1, 3, 6, 8, 12.5, r() * 30][(i + 3) % 7];
    assert.ok(Object.is(pm.profitPct(entry, price), oldProfit(entry, price)));
    assert.ok(Object.is(pm.takeProfitPrice(entry, tp), oldTp(entry, tp)));
    assert.ok(Object.is(pm.stopLossPrice(entry, sl), oldSl(entry, sl)));
    const both = pm.tpSlPrices(entry, tp, sl);
    assert.ok(Object.is(both.tp, oldTp(entry, tp)) && Object.is(both.sl, oldSl(entry, sl)));
    assert.equal(pm.inferCloseAction(entry, price), oldInfer(entry, price));
    assert.equal(pm.inferCloseAction(entry, entry), 'tp'); // 等于入场价 = 止盈（与旧 >= 一致）
    const pct = oldProfit(entry, price);
    const amount = [10, 20, 100, 33.3][i % 4];
    const lev = [1, 2, 5, 20][i % 4];
    assert.ok(Object.is(pm.unrealizedUsdt({ amount, leverage: lev, pct }), (amount * lev * pct) / 100)); // pnl.js L115-116/L237
  }
  // 特殊值：NaN / Infinity / 0 入场价的行为也保持一致
  for (const [e, p] of [[0, 1], [1, NaN], [NaN, 1], [1, Infinity], [0, 0]]) {
    assert.ok(Object.is(pm.profitPct(e, p), oldProfit(e, p)));
  }
});

test('positionMath：方向与买卖方向（阶段 1 仅做多；做空明确拒绝）', () => {
  assert.equal(pm.sign(), 1);
  assert.equal(pm.sign('long'), 1);
  assert.equal(pm.openSide('long'), 'buy');
  assert.equal(pm.closeSide('long'), 'sell');
  for (const fn of [pm.sign, pm.openSide, pm.closeSide, (d) => pm.profitPct(1, 2, d), (d) => pm.takeProfitPrice(1, 1, d), (d) => pm.stopLossPrice(1, 1, d), (d) => pm.inferCloseAction(1, 2, d)]) {
    assert.throws(() => fn('short'), /仅支持做多/);
  }
});

test('positionMath：手算样例', () => {
  assert.equal(pm.takeProfitPrice(100, 8), 108);
  assert.equal(pm.stopLossPrice(100, 6), 94);
  assert.equal(pm.profitPct(100, 110), 10);
  assert.equal(pm.profitPct(100, 90), -10);
});

test('normalize：旧记录补 strategy_id=rsi_dip / direction=long，保留未知字段，不改入参', () => {
  const old = { instId: 'BTC-USDT-SWAP', posSide: 'net', rsi_at_entry: 18.2, algoId: 'a1', custom: { x: 1 } };
  const frozen = JSON.stringify(old);
  const n = normalizePosition(old);
  assert.equal(JSON.stringify(old), frozen);
  assert.equal(n.strategy_id, 'rsi_dip');
  assert.equal(n.direction, 'long');
  assert.equal(n.posSide, 'net');
  assert.equal(n.algoId, 'a1');
  assert.deepEqual(n.custom, { x: 1 });
  assert.equal(withStrategyDefaults({ strategy_id: 'x', direction: 'short' }).direction, 'short', '已有值不被覆盖');
  assert.equal(withStrategyDefaults(null), null);
  assert.equal(withStrategyDefaults('s'), 's');
});
