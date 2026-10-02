// SuperTrend 指标：与 Python 回测逐点一致（含 SMA 分支）、与 Pine 逐句转写的独立参考一致、无前视、增量 == 整段
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { superTrend, createState, stepSuperTrend } from '../engine/superTrendCalc.js';
import { CandleStore } from '../candleStore.js';
import { closes as synthCloses, candle, T0, BAR } from './fixtures/stSeries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REF = JSON.parse(readFileSync(join(here, 'fixtures', 'supertrend', 'python_ref.json'), 'utf8'));

/**
 * 独立参考：把 Pine v4 源码逐句转写（与 engine/superTrendCalc.js 的“逐根增量”写法刻意不同：整段数组、按 Pine 的 [1] 取值）。
 *   atr = changeATR ? atr(Periods) : sma(tr, Periods)；src = hl2
 *   up := close[1] > up1 ? max(up, up1) : up；dn := close[1] < dn1 ? min(dn, dn1) : dn
 *   trend := nz(trend[1], trend)；trend := trend==-1 and close>dn1 ? 1 : trend==1 and close<up1 ? -1 : trend
 * 与引擎的唯一语义差：ATR 未就绪的预热段 trend=null（Pine 里恒为 1），翻转要求前后两根 trend 都有效。
 */
function pineReference(h, l, c, period, mult, changeATR) {
  const n = c.length;
  const tr = c.map((_, i) => (i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  const atr = new Array(n).fill(null);
  if (changeATR) {
    // ta.rma：首个值 = 前 period 根 tr 的简单平均，之后 (prev*(p-1)+x)/p
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (i < period - 1) acc += tr[i];
      else if (i === period - 1) { acc += tr[i]; atr[i] = acc / period; }
      else atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
  } else {
    for (let i = period - 1; i < n; i++) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += tr[j];
      atr[i] = s / period;
    }
  }
  const up = new Array(n).fill(null);
  const dn = new Array(n).fill(null);
  const trend = new Array(n).fill(null);
  let tPrev = 1;
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const src = (h[i] + l[i]) / 2;
    let u = src - mult * atr[i];
    let d = src + mult * atr[i];
    const u1 = i > 0 && up[i - 1] != null ? up[i - 1] : u;
    const d1 = i > 0 && dn[i - 1] != null ? dn[i - 1] : d;
    if (i > 0 && c[i - 1] > u1) u = Math.max(u, u1);
    if (i > 0 && c[i - 1] < d1) d = Math.min(d, d1);
    let t = tPrev;
    t = t === -1 && c[i] > d1 ? 1 : t === 1 && c[i] < u1 ? -1 : t;
    up[i] = u; dn[i] = d; trend[i] = t; tPrev = t;
  }
  const flips = [];
  for (let i = 1; i < n; i++) {
    if (trend[i] == null || trend[i - 1] == null) continue;
    if (trend[i] === 1 && trend[i - 1] === -1) flips.push([i, 1]);
    if (trend[i] === -1 && trend[i - 1] === 1) flips.push([i, -1]);
  }
  return { atr, up, dn, trend, flips };
}

const flipsOf = (r) => {
  const f = [];
  r.buy.forEach((b, i) => b && f.push([i, 1]));
  r.sell.forEach((b, i) => b && f.push([i, -1]));
  return f.sort((a, b) => a[0] - b[0]);
};
const close = (a, b) => (a == null || b == null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

test('与 Python 回测 fixture 逐点一致：7 币 × 5 组参数（含 SMA 分支），trend / up / dn 与翻转序列', () => {
  let variants = 0;
  let smaVariants = 0;
  let totalFlips = 0;
  for (const [inst, c] of Object.entries(REF.coins)) {
    assert.equal(c.ts.length, 700);
    for (const v of c.variants) {
      const r = superTrend(c.h, c.l, c.c, { period: v.period, mult: v.mult, method: v.method });
      assert.deepEqual(r.trend, v.trend, `${inst} ${v.period}/${v.mult}/${v.method} trend`);
      for (let i = 0; i < 700; i++) {
        assert.ok(close(r.up[i], v.up[i]), `${inst} up[${i}] ${r.up[i]} vs ${v.up[i]}`);
        assert.ok(close(r.dn[i], v.dn[i]), `${inst} dn[${i}]`);
      }
      assert.deepEqual(flipsOf(r), v.flips.map(([i, t]) => [i, t]), `${inst} ${v.method} 翻转序列`);
      variants++;
      totalFlips += v.flips.length;
      if (v.method === 'sma') smaVariants++;
    }
  }
  assert.equal(variants, 35);
  assert.ok(smaVariants >= 14, `SMA 分支应被覆盖：${smaVariants}`);
  assert.ok(totalFlips > 500, `翻转样本应足够多：${totalFlips}`);
});

test('ATR 的 SMA 分支：ATR = sma(tr, period)；与 RMA 分支确实不同；与 Pine 转写参考逐点一致', () => {
  const c = REF.coins['ETH-USDT-SWAP'];
  const rma = superTrend(c.h, c.l, c.c, { period: 10, mult: 3, method: 'rma' });
  const sma = superTrend(c.h, c.l, c.c, { period: 10, mult: 3, method: 'sma' });
  // 手算前几根 SMA ATR
  const tr = c.c.map((_, i) => (i === 0 ? c.h[i] - c.l[i] : Math.max(c.h[i] - c.l[i], Math.abs(c.h[i] - c.c[i - 1]), Math.abs(c.l[i] - c.c[i - 1]))));
  const mean = (a, b) => tr.slice(a, b + 1).reduce((x, y) => x + y, 0) / (b - a + 1);
  assert.equal(sma.atr[8], null);
  assert.ok(close(sma.atr[9], mean(0, 9)));
  assert.ok(close(sma.atr[10], mean(1, 10)));
  assert.ok(close(sma.atr[250], mean(241, 250)));
  assert.ok(close(rma.atr[9], mean(0, 9)), 'RMA 首值也是前 10 根的简单平均');
  assert.ok(!close(rma.atr[30], sma.atr[30]), 'RMA 与 SMA 从第 11 根起应不同');
  for (const [period, mult, method] of [[10, 3, 'sma'], [7, 2, 'sma'], [14, 1.5, 'sma'], [10, 3, 'rma'], [5, 2.5, 'sma'], [20, 4, 'rma']]) {
    const mine = superTrend(c.h, c.l, c.c, { period, mult, method });
    const ref = pineReference(c.h, c.l, c.c, period, mult, method === 'rma');
    assert.deepEqual(mine.trend, ref.trend, `${period}/${mult}/${method} trend`);
    assert.deepEqual(flipsOf(mine), ref.flips, `${period}/${mult}/${method} flips`);
    for (let i = 0; i < c.c.length; i++) {
      assert.ok(close(mine.atr[i], ref.atr[i]), `${method} atr[${i}]`);
      assert.ok(close(mine.up[i], ref.up[i]) && close(mine.dn[i], ref.dn[i]), `${method} up/dn[${i}]`);
    }
  }
  // 策略层参数 atr_method=sma 真的传到了 CandleStore 的指标
  const store = new CandleStore({ maxBars: 300, bar: '15m', period: 10, mult: 3, method: 'sma' });
  const rows = c.ts.map((ts, i) => [ts, c.c[i], c.h[i], c.l[i], c.c[i], 1, 1, 1, '1']).reverse();
  store.bootstrap('X', rows);
  const snapSma = store.snapshot('X').st;
  assert.ok(close(snapSma.atr, sma.atr[699]));
  store.setParams({ bar: '15m', period: 10, mult: 3, method: 'rma' });
  store.bootstrap('X', rows);
  assert.ok(close(store.snapshot('X').st.atr, rma.atr[699]));
});

test('判断用的是上一根已更新的 up1 / dn1，而不是本根更新后的 up / dn（Pine 语义）', () => {
  // 构造：本根 close 跌破“本根更新后的 up”但未跌破 up1 → 不应翻转；反之亦然。用参考实现与引擎对拍随机序列即可覆盖，
  // 这里再给一个手算用例。period=1, mult=1：atr=tr。
  const h = [10, 10.5, 10.4];
  const l = [9, 9.5, 8.9];
  const c = [9.5, 10, 9.0];
  const r = superTrend(h, l, c, { period: 1, mult: 1, method: 'sma' });
  // i=0：tr=1，src=9.5，up=8.5，dn=10.5，trend=1（初值）
  assert.equal(r.trend[0], 1);
  // i=1：tr=max(1,1,0)=1，src=10，up=9，dn=11；up1=8.5；close[0]=9.5>8.5 → up=max(9,8.5)=9；trend 仍为 1（close=10 > up1=8.5）
  assert.equal(r.up[1], 9);
  assert.equal(r.trend[1], 1);
  // i=2：tr=max(1.5,0.4,1.1)... h-l=1.5；src=9.65；up(raw)=8.15；up1=9（上一根更新后值）；close=9.0 < up1=9? 否（相等）→ 仍为 1
  assert.equal(r.trend[2], 1);
  const r2 = superTrend(h, l, [9.5, 10, 8.99], { period: 1, mult: 1, method: 'sma' });
  assert.equal(r2.trend[2], -1, 'close=8.99 < up1=9 → 翻为 -1（若误用本根 up=9.0 与 8.15 比较则不会翻转）');
  assert.equal(r2.sell[2], true);
});

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

test('随机序列：引擎 == Pine 转写参考（RMA / SMA，多组参数），且逐根增量 == 整段', () => {
  const r = rng(7);
  for (let k = 0; k < 40; k++) {
    const n = 150 + Math.floor(r() * 250);
    let p = 100;
    const c = [];
    const h = [];
    const l = [];
    for (let i = 0; i < n; i++) {
      p *= 1 + (r() - 0.5) * 0.04;
      const wick = p * r() * 0.01;
      c.push(p);
      h.push(p + wick);
      l.push(p - p * r() * 0.01);
    }
    const period = 2 + Math.floor(r() * 20);
    const mult = 0.5 + r() * 4;
    const method = k % 2 ? 'sma' : 'rma';
    const full = superTrend(h, l, c, { period, mult, method });
    const ref = pineReference(h, l, c, period, mult, method === 'rma');
    assert.deepEqual(full.trend, ref.trend);
    assert.deepEqual(flipsOf(full), ref.flips);
    // 增量
    let st = createState({ period, mult, method });
    const trend = [];
    for (let i = 0; i < n; i++) {
      const s = stepSuperTrend(st, { h: h[i], l: l[i], c: c[i] });
      st = s.state;
      trend.push(s.out.trend);
      assert.ok(close(s.out.up, full.up[i]) && close(s.out.dn, full.dn[i]));
    }
    assert.deepEqual(trend, full.trend);
  }
});

test('无前视：截断后重算，前缀的 trend / up / dn / 翻转与全量完全相同（未来数据不影响过去）', () => {
  const c = REF.coins['SOL-USDT-SWAP'];
  for (const method of ['rma', 'sma']) {
    const full = superTrend(c.h, c.l, c.c, { period: 10, mult: 3, method });
    for (const cut of [60, 123, 300, 555, 699]) {
      const part = superTrend(c.h.slice(0, cut), c.l.slice(0, cut), c.c.slice(0, cut), { period: 10, mult: 3, method });
      assert.deepEqual(part.trend, full.trend.slice(0, cut));
      assert.deepEqual(part.up, full.up.slice(0, cut));
      assert.deepEqual(part.dn, full.dn.slice(0, cut));
      assert.deepEqual(flipsOf(part), flipsOf(full).filter(([i]) => i < cut));
    }
  }
  // 引擎不修改入参
  const h2 = [...c.h];
  superTrend(h2, c.l, c.c, { period: 10, mult: 3 });
  assert.deepEqual(h2, c.h);
});

test('CandleStore：只用已收盘 K 线（confirm=0 不推进指标）；bootstrap 的历史翻转不算信号；新收盘的翻转才算', () => {
  const cl = synthCloses();
  const store = new CandleStore({ maxBars: 300, bar: '15m', period: 10, mult: 3, method: 'rma' });
  const id = 'T-USDT-SWAP';
  // bootstrap 前 200 根（含 103 的卖出翻转、164 的买入翻转）：都是历史，不算信号
  store.bootstrap(id, Array.from({ length: 200 }, (_, i) => candle(i, cl[i])).reverse());
  let s = store.snapshot(id);
  assert.equal(s.st.flip, null);
  assert.equal(s.st.trend, 1);
  assert.equal(s.lastTs, T0 + 199 * BAR);
  // confirm=0 的形成中 K 线：只更新价格，不改指标 / 不产生信号
  const before = JSON.stringify(s.st);
  store.applyCandle(id, candle(200, cl[200], '0'));
  s = store.snapshot(id);
  assert.equal(JSON.stringify(s.st), before);
  assert.equal(s.forming, true);
  // 逐根喂入已收盘 K 线：在 235 出现卖出翻转，flip.ts = 该 K 线开盘时间
  let sawSell = false;
  for (let i = 200; i < 240; i++) {
    store.applyCandle(id, candle(i, cl[i], '1'));
    const f = store.snapshot(id).st.flip;
    if (f) { sawSell = true; assert.equal(i, 235); assert.equal(f.dir, 'short'); assert.equal(f.ts, T0 + 235 * BAR); assert.equal(f.closeAt, T0 + 236 * BAR); break; }
  }
  assert.ok(sawSell);
  // 重复推送同一根已收盘 K 线不重复推进；漏一根 → stale，不盲目推进
  store.applyCandle(id, candle(235, cl[235], '1'));
  assert.equal(store.snapshot(id).lastTs, T0 + 235 * BAR);
  store.applyCandle(id, candle(238, cl[238], '1'));
  assert.equal(store.snapshot(id).stale, true);
  assert.equal(store.snapshot(id).lastTs, T0 + 235 * BAR);
  // REST 补齐：bootstrap(…, 旧 lastTs) → 缺失期间的翻转（若有）保留为信号；此处缺失期无翻转，stale 清除
  store.bootstrap(id, Array.from({ length: 240 }, (_, i) => candle(i, cl[i])).reverse(), T0 + 235 * BAR);
  assert.equal(store.snapshot(id).stale, false);
  assert.equal(store.snapshot(id).lastTs, T0 + 239 * BAR);
});

test('CandleStore：逐根收盘推进的指标 == 整段计算（SMA / RMA）', () => {
  const c = REF.coins['BTC-USDT-SWAP'];
  for (const method of ['rma', 'sma']) {
    const store = new CandleStore({ maxBars: 300, bar: '15m', period: 10, mult: 3, method });
    const id = 'B';
    for (let i = 0; i < 700; i++) store.applyCandle(id, [String(c.ts[i]), c.c[i], c.h[i], c.l[i], c.c[i], 1, 1, 1, '1']);
    const full = superTrend(c.h, c.l, c.c, { period: 10, mult: 3, method });
    const s = store.snapshot(id).st;
    assert.equal(s.trend, full.trend[699]);
    assert.ok(close(s.up, full.up[699]) && close(s.dn, full.dn[699]) && close(s.atr, full.atr[699]));
    assert.ok(store.snapshot(id).bars <= 300);
  }
});
