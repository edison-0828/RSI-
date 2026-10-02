// positionMath（多空）：多头分支与改造前 index.js / pnl.js / executor.js 中的旧表达式逐位（Object.is）比对
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

test('positionMath：方向与买卖方向（多空）', () => {
  assert.equal(pm.sign(), 1);
  assert.equal(pm.sign('long'), 1);
  assert.equal(pm.sign('short'), -1);
  assert.equal(pm.openSide('long'), 'buy');
  assert.equal(pm.closeSide('long'), 'sell');
  assert.equal(pm.openSide('short'), 'sell');
  assert.equal(pm.closeSide('short'), 'buy');
  assert.equal(pm.oppositeDir('long'), 'short');
  assert.equal(pm.oppositeDir('short'), 'long');
  assert.equal(pm.dirText('short'), '空');
  assert.equal(pm.dirText('long'), '多');
  // 非法方向仍然抛错（不允许悄悄当作多头）
  assert.throws(() => pm.sign('up'));
});

test('positionMath：多头手算样例', () => {
  assert.equal(pm.takeProfitPrice(100, 8), 108);
  assert.equal(pm.stopLossPrice(100, 6), 94);
  assert.equal(pm.profitPct(100, 110), 10);
  assert.equal(pm.profitPct(100, 90), -10);
});

test('positionMath：空头手算样例（价格下跌为正收益；止损价在上方；止损触发方向相反）', () => {
  assert.equal(pm.profitPct(100, 90, 'short'), 10);
  assert.equal(pm.profitPct(100, 110, 'short'), -10);
  assert.equal(pm.takeProfitPrice(100, 8, 'short'), 92);
  assert.equal(pm.stopLossPrice(100, 8, 'short'), 108);
  assert.deepEqual(pm.tpSlPrices(100, 8, 6, 'short'), { tp: 92, sl: 106 });
  assert.equal(pm.stopHit(108, 108, 'short'), true);
  assert.equal(pm.stopHit(107.9, 108, 'short'), false);
  assert.equal(pm.stopHit(92, 92, 'long'), true);
  assert.equal(pm.stopHit(92.1, 92, 'long'), false);
  assert.equal(pm.inferCloseAction(100, 90, 'short'), 'tp');
  assert.equal(pm.inferCloseAction(100, 110, 'short'), 'sl');
  // 强平价：多在下方、空在上方
  assert.ok(Math.abs(pm.estLiqPrice(100, 10, 'long') - 90.5) < 1e-9);
  assert.ok(Math.abs(pm.estLiqPrice(100, 10, 'short') - 109.5) < 1e-9);
  assert.equal(pm.liqBreached({ sl: 95, liqPx: 90.5, dir: 'long' }), false);
  assert.equal(pm.liqBreached({ sl: 90, liqPx: 90.5, dir: 'long' }), true);
  assert.equal(pm.liqBreached({ sl: 110, liqPx: 109.5, dir: 'short' }), true);
});

test('positionMath：simRoundTrip 含手续费的往返盈亏（手算）', () => {
  // 多：名义 1000，100 → 110，单边费率 0.05%：毛 100；开仓费 0.5；平仓名义 1100 → 费 0.55；净 98.95
  const L = pm.simRoundTrip({ notional: 1000, entry: 100, exit: 110, dir: 'long', feePct: 0.05 });
  assert.equal(L.pct, 10);
  assert.ok(Math.abs(L.gross - 100) < 1e-9 && Math.abs(L.feeOpen - 0.5) < 1e-9 && Math.abs(L.feeClose - 0.55) < 1e-9 && Math.abs(L.net - 98.95) < 1e-9);
  // 空：100 → 90：毛 +100；平仓名义 900 → 费 0.45；净 99.05
  const S = pm.simRoundTrip({ notional: 1000, entry: 100, exit: 90, dir: 'short', feePct: 0.05 });
  assert.equal(S.pct, 10);
  assert.ok(Math.abs(S.gross - 100) < 1e-9 && Math.abs(S.feeClose - 0.45) < 1e-9 && Math.abs(S.net - 99.05) < 1e-9);
  // 空头价格上涨 → 亏损
  const S2 = pm.simRoundTrip({ notional: 1000, entry: 100, exit: 105, dir: 'short', feePct: 0 });
  assert.ok(Math.abs(S2.net + 50) < 1e-9);
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
