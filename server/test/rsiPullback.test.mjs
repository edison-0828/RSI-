import test from 'node:test';
import assert from 'node:assert/strict';
import rsiPullback from '../strategies/rsiPullback.js';
import { atrSeries, emaSeries, rsiSeries } from '../engine/rsiPullbackCalc.js';
import { planTarget } from '../engine/flipPlanner.js';
import { CandleStore } from '../candleStore.js';

const BAR = 900_000;
const T0 = 1_700_000_000_000;

function barsFrom(closes, lastVolume = 150) {
  return closes.map((close, index) => ({
    ts: T0 + index * BAR,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: index === closes.length - 1 ? lastVolume : 100,
  }));
}

function evaluate(closes, overrides = {}, flags = {}) {
  const params = rsiPullback.clamp({ ema_period: 20, volume_period: 20, ...overrides });
  const bars = barsFrom(closes, overrides.lastVolume ?? 150);
  return rsiPullback.evaluate({
    instId: 'AAA-USDT-SWAP',
    phase: 'scan',
    params,
    market: { price: closes.at(-1), bars: bars.length, barMs: BAR, lastBarTs: bars.at(-1)?.ts, closedBars: bars },
    flags: { tradable: true, heldDirection: null, ...flags },
  });
}

const longCloses = [...Array.from({ length: 30 }, (_, i) => 100 + i * 0.2), 100, 95, 90, 88, 90, 94, 104];

test('指标：EMA、Wilder RSI 与 ATR 只在预热完成后给值', () => {
  const closes = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(emaSeries(closes, 3).slice(0, 3), [null, null, 2]);
  assert.equal(rsiSeries(closes, 3)[3], 100);
  const atr = atrSeries(barsFrom(closes), 3);
  assert.equal(atr[0], null);
  assert.ok(atr[2] > 0);
});

test('多头入场：先进入超卖区，再上穿恢复阈值，同时位于 EMA 上方且量能确认', () => {
  const decision = evaluate(longCloses);
  assert.equal(decision.signal, true);
  assert.equal(decision.target, 'long');
  assert.equal(decision.direction, 'long');
  assert.equal(decision.metrics.signalKind, 'entry_long');
  assert.equal(decision.metrics.trend, 'bull');
  assert.ok(decision.metrics.previousRsi <= 40);
  assert.ok(decision.metrics.rsi > 40);
  assert.ok(decision.slPct > 0, 'ATR 应换算出动态止损百分比');
});

test('成交量过滤会阻止无量回升；关闭过滤后同一根 K 线可入场', () => {
  const blocked = evaluate(longCloses, { lastVolume: 50 });
  assert.equal(blocked.signal, false);
  assert.equal(blocked.metrics.volumeOk, false);
  const allowed = evaluate(longCloses, { lastVolume: 50, volume_filter_enabled: false });
  assert.equal(allowed.target, 'long');
});

test('多空逻辑对称：镜像价格序列产生做空信号', () => {
  const shortCloses = longCloses.map((value) => 200 - value);
  const decision = evaluate(shortCloses);
  assert.equal(decision.signal, true);
  assert.equal(decision.target, 'short');
  assert.equal(decision.metrics.signalKind, 'entry_short');
  assert.equal(decision.metrics.trend, 'bear');
});

test('已有多单到达 RSI 退出区时返回 flat，只平仓而不是强制反手', () => {
  const decision = evaluate([...longCloses, 112], {}, { heldDirection: 'long' });
  assert.equal(decision.signal, true);
  assert.equal(decision.target, 'flat');
  assert.equal(decision.direction, null);
  assert.equal(decision.metrics.signalKind, 'exit_long');
  assert.deepEqual(planTarget({ heldDir: 'long', target: 'flat' }), { close: true, open: null, reverse: false, skip: null });
});

test('CandleStore：形成中 K 线不进入策略数据；已收盘 K 线保留成交量', () => {
  const store = new CandleStore({ bar: '15m' });
  const row = (i, close, volume, confirm) => [String(T0 + i * BAR), String(close), String(close + 1), String(close - 1), String(close), '1', '1', String(volume), confirm];
  store.bootstrap('AAA', [row(0, 100, 10, '1')]);
  store.applyCandle('AAA', row(1, 101, 20, '0'));
  let snapshot = store.snapshot('AAA');
  assert.equal(snapshot.closedBars.length, 1);
  assert.equal(snapshot.forming, true);
  store.applyCandle('AAA', row(1, 101, 20, '1'));
  snapshot = store.snapshot('AAA');
  assert.equal(snapshot.closedBars.length, 2);
  assert.equal(snapshot.closedBars[1].v, 20);
});
