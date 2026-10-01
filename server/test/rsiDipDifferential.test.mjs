// 阶段 1：差分验证 —— 冻结的旧逻辑（fixtures/legacy）vs 新策略 rsiDip.evaluate（经与 index.js 共用的 ctxFromStore 适配）
// 运行：node --test server/test/
// 可选：设置 RSI_DIFF_CACHE_DIR=/path/to/live-analysis/cache 额外用真实 K 线缓存（*_15m.json）做差分（仅本地手动，默认不依赖）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CandleStore } from '../candleStore.js';
import { calcBollinger } from '../bbFilter.js';
import rsiDip from '../strategies/rsiDip.js';
import { evaluateSafely } from '../strategies/index.js';
import { ctxFromStore, rowFieldsFromDecision, recheckResultFromDecision } from '../engine/signalAdapter.js';
import { legacyEvaluateRow, legacyRecheck } from './fixtures/legacy/legacyEvaluateRow.js';

/** 可复现伪随机（mulberry32） */
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

/** 构造多种行情形态的收盘价序列 */
function makeSeries(kind, n, r) {
  const out = [];
  let px = 50 + r() * 100;
  for (let i = 0; i < n; i++) {
    let step;
    switch (kind) {
      case 'walk': step = (r() - 0.5) * 0.04; break;
      case 'crash': step = i > n - 12 ? -0.02 - r() * 0.02 : (r() - 0.5) * 0.01; break;
      case 'down': step = -0.002 - r() * 0.01; break; // 单边下跌 → RSI 可能为 0（无效）
      case 'up': step = 0.002 + r() * 0.01; break; // 单边上涨 → RSI 100
      case 'flat': step = 0; break; // 常数 → RSI 50
      case 'spiky': step = r() < 0.1 ? (r() - 0.6) * 0.15 : (r() - 0.5) * 0.005; break;
      default: step = 0;
    }
    px = Math.max(0.0001, px * (1 + step));
    out.push(px);
  }
  return out;
}

/** 用真实 CandleStore.bootstrap 构造快照；formingClose != null 时附带一根未收盘 K 线 */
function buildStore(instId, closes, formingClose, period) {
  const store = new CandleStore({ maxBars: 200, period });
  const t0 = 1_790_000_000_000;
  const rows = closes.map((c, i) => [t0 + i * 900_000, c, c, c, c, 1, 1, 1, '1']);
  if (formingClose != null) rows.push([t0 + closes.length * 900_000, formingClose, formingClose, formingClose, formingClose, 1, 1, 1, '0']);
  store.bootstrap(instId, rows.reverse()); // REST 返回：最新在前
  return store;
}

const BASE_CFG = { rsi_period: 6, rsi_buy_threshold: 20, confirm_on_close: false, bb_filter_enabled: false, bb_period: 20, bb_mult: 2, take_profit_pct: 8, stop_loss_pct: 6, bar: '15m' };

/** 新路径：与 index.js 一致（params = rsiDip.clamp(cfg)；ctxFromStore；evaluateSafely） */
function viaStrategy(store, instId, cfg, price, notOnDemo) {
  const params = rsiDip.clamp(cfg);
  const ctx = ctxFromStore(store, instId, params, { phase: 'scan', price, tradable: !notOnDemo });
  const d = evaluateSafely(rsiDip, ctx);
  return { d, row: { ...rowFieldsFromDecision(d), bbKind: d.blocked?.kind ?? null } };
}

function viaLegacy(store, instId, cfg, price, notOnDemo) {
  const snap = store.snapshot(instId);
  return legacyEvaluateRow({ snap, price, closes: store.closes(instId), notOnDemo }, cfg);
}

function* priceVariants(store, instId, cfg) {
  const snap = store.snapshot(instId);
  yield snap.price;
  yield null;
  const lower = calcBollinger(store.closes(instId), snap.price, cfg.bb_period, cfg.bb_mult)?.lower;
  if (lower != null) {
    // 刚好在下轨上 / 略高 / 略低（浮点边界）
    yield lower;
    yield lower * (1 + 1e-12);
    yield lower * (1 - 1e-12);
  }
  yield snap.price * 0.97;
  yield snap.price * 1.03;
}

function runGrid(seriesList, label) {
  let combos = 0;
  let signalsSeen = 0;
  let blockedSeen = { above: 0, insufficient: 0 };
  let waiting = 0;
  let invalid = 0;
  for (const { id, closes, formingClose } of seriesList) {
    for (const period of [6, 14]) {
      const store = buildStore(id, closes, formingClose, period);
      const snap = store.snapshot(id);
      const rsiShow = snap.forming && snap.rsiForming != null ? snap.rsiForming : snap.rsi;
      // 阈值：常规档 + 恰好等于当前 RSI（边界，不触发）+ 略高于当前 RSI（边界，触发）
      const thresholds = [15, 20, 25, 35];
      if (rsiShow != null && Number.isFinite(rsiShow)) thresholds.push(rsiShow, rsiShow + 1e-9, rsiShow - 1e-9);
      if (snap.rsi != null && Number.isFinite(snap.rsi)) thresholds.push(snap.rsi, snap.rsi + 1e-9);
      // 阈值必须 >0：线上 cfg 经 clampConfig 后 `Number(x) || 20` 已保证（0 不可达）
      for (const th of thresholds.filter((x) => x > 0)) {
        for (const confirm of [false, true]) {
          for (const bbOn of [false, true]) {
            const bbGrid = bbOn ? [[10, 1.5], [20, 2], [50, 2.5], [20, 1.5], [10, 2.5]] : [[20, 2]];
            for (const [bp, bm] of bbGrid) {
              const cfg = { ...BASE_CFG, rsi_period: period, rsi_buy_threshold: th, confirm_on_close: confirm, bb_filter_enabled: bbOn, bb_period: bp, bb_mult: bm };
              for (const price of priceVariants(store, id, cfg)) {
                for (const notOnDemo of [false, true]) {
                  const oldRow = viaLegacy(store, id, cfg, price, notOnDemo);
                  const { d, row } = viaStrategy(store, id, cfg, price, notOnDemo);
                  assert.deepStrictEqual(row, oldRow, `${label} ${id} period=${period} th=${th} confirm=${confirm} bb=${bbOn}(${bp},${bm}) price=${price} notOnDemo=${notOnDemo}`);
                  combos++;
                  if (oldRow.signal) signalsSeen++;
                  if (oldRow.bbKind) blockedSeen[oldRow.bbKind]++;
                  if (d.waitingClose) waiting++;
                  if (oldRow.signalText.startsWith('RSI 无效')) invalid++;
                }
              }
              // 下单前复核（phase=recheck，价格取快照价；现网 recheck 不含 notOnDemo）
              const params = rsiDip.clamp(cfg);
              const ctx = ctxFromStore(store, id, params, { phase: 'recheck', price: snap.price, tradable: true });
              const rc = recheckResultFromDecision(evaluateSafely(rsiDip, ctx));
              assert.deepStrictEqual(rc, legacyRecheck({ snap, closes: store.closes(id) }, cfg), `${label} 复核 ${id} th=${th} confirm=${confirm} bb=${bbOn}`);
              combos++;
            }
          }
        }
      }
    }
  }
  return { combos, signalsSeen, blockedSeen, waiting, invalid };
}

test('差分：合成行情 × 参数网格 × 价格边界 × 复核 —— 新策略与冻结旧逻辑逐字段严格相等', () => {
  const r = rng(20260929);
  const kinds = ['walk', 'crash', 'down', 'up', 'flat', 'spiky'];
  const list = [];
  let k = 0;
  for (const kind of kinds) {
    for (let rep = 0; rep < 5; rep++) {
      for (const n of [8, 25, 60, 150]) {
        const closes = makeSeries(kind, n, r);
        for (const withForming of [false, true]) {
          const last = closes[closes.length - 1];
          const formingClose = withForming ? last * (1 + (r() - 0.55) * 0.05) : null;
          list.push({ id: `S${k++}-${kind}-USDT-SWAP`, closes, formingClose });
        }
      }
    }
  }
  const res = runGrid(list, '合成');
  // 覆盖度断言：各分支都确实被走到，且组合数 ≥ 10 万
  assert.ok(res.combos >= 100_000, `组合数 ${res.combos} 应 ≥ 100000`);
  assert.ok(res.signalsSeen > 1000, `触发样本数 ${res.signalsSeen}`);
  assert.ok(res.blockedSeen.above > 100, `布林“未跌破下轨”样本 ${res.blockedSeen.above}`);
  assert.ok(res.blockedSeen.insufficient > 100, `布林“K线不足”样本 ${res.blockedSeen.insufficient}`);
  assert.ok(res.waiting > 100, `等待收盘确认样本 ${res.waiting}`);
  assert.ok(res.invalid > 100, `RSI 无效样本 ${res.invalid}`);
  console.log(`# 差分(合成)：${res.combos} 组合；触发 ${res.signalsSeen}；布林挡单 above=${res.blockedSeen.above} insufficient=${res.blockedSeen.insufficient}；等待收盘 ${res.waiting}；RSI无效 ${res.invalid}`);
});

test('差分：K 线极少 / 无快照 / 价格为空 的数据不足分支', () => {
  const store = new CandleStore({ maxBars: 200, period: 6 });
  assert.equal(ctxFromStore(store, 'NONE-USDT-SWAP', rsiDip.clamp(BASE_CFG), { phase: 'scan', price: 1, tradable: true }), null, '无快照返回 null（index.js 对应 `!snap` 直接跳过）');
  for (const n of [1, 2, 5, 6, 7]) {
    const closes = makeSeries('walk', n, rng(n));
    const st = buildStore('F-USDT-SWAP', closes, null, 6);
    for (const bbOn of [false, true]) {
      for (const price of [null, closes[closes.length - 1]]) {
        const cfg = { ...BASE_CFG, bb_filter_enabled: bbOn, rsi_buy_threshold: 99 };
        assert.deepStrictEqual(viaStrategy(st, 'F-USDT-SWAP', cfg, price, false).row, viaLegacy(st, 'F-USDT-SWAP', cfg, price, false));
      }
    }
  }
});

test('差分：真实 K 线缓存（需设置 RSI_DIFF_CACHE_DIR，默认跳过）', { skip: !process.env.RSI_DIFF_CACHE_DIR }, () => {
  const dir = process.env.RSI_DIFF_CACHE_DIR;
  const files = readdirSync(dir).filter((f) => f.endsWith('_15m.json')).sort().slice(0, Number(process.env.RSI_DIFF_CACHE_FILES || 60));
  const list = [];
  const r = rng(7);
  for (const f of files) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const rows = Object.values(raw).sort((a, b) => a[0] - b[0]);
    if (rows.length < 40) continue;
    const closesAll = rows.map((x) => Number(x[4]));
    for (const cut of [0.3, 0.5, 0.7, 0.9, 1]) {
      const end = Math.max(30, Math.floor(closesAll.length * cut));
      const closes = closesAll.slice(Math.max(0, end - 150), end);
      list.push({ id: `${f}@${cut}`, closes, formingClose: r() < 0.5 ? null : closes[closes.length - 1] * (1 + (r() - 0.6) * 0.03) });
    }
  }
  const res = runGrid(list, '真实K线');
  console.log(`# 差分(真实K线缓存)：${files.length} 个文件 / ${list.length} 个片段 / ${res.combos} 组合；触发 ${res.signalsSeen}；布林挡单 ${JSON.stringify(res.blockedSeen)}`);
  assert.ok(res.combos > 0);
});

test('文案：现网 5 种 signalText + 模拟盘无此合约 + 无效 + 布林原因，逐字比对', () => {
  const mk = (closes, forming, cfgPatch, price, notOnDemo = false) => {
    const st = buildStore('T-USDT-SWAP', closes, forming, 6);
    const cfg = { ...BASE_CFG, ...cfgPatch };
    return viaStrategy(st, 'T-USDT-SWAP', cfg, price ?? st.snapshot('T-USDT-SWAP').price, notOnDemo).d;
  };
  const dn = makeSeries('crash', 60, rng(3));
  const flat = makeSeries('flat', 40, rng(4));
  const last = dn[dn.length - 1];
  assert.equal(mk(dn, null, { rsi_buy_threshold: 99 }).text, 'RSI 进入超卖区，触发买入！');
  assert.equal(mk(dn, last * 0.99, { rsi_buy_threshold: 99 }).text, '实时 RSI 进入超卖区（含未收盘），触发买入！');
  assert.equal(mk(dn, null, { rsi_buy_threshold: 99, confirm_on_close: true }).text, '实时与收盘 RSI 均低于阈值（收盘确认），触发买入！');
  assert.equal(mk(flat, null, { rsi_buy_threshold: 20 }).text, '未触发');
  assert.equal(mk(dn, null, { rsi_buy_threshold: 99 }, null, true).text, '模拟盘无此合约');
  assert.equal(mk(makeSeries('down', 40, rng(5)), null, { rsi_buy_threshold: 99 }).text, 'RSI 无效（K 线不足或无数据）');
  // 等待收盘确认：实时 RSI 低而已收盘 RSI 不低
  const up = makeSeries('up', 40, rng(6));
  const waiting = mk(up, up[up.length - 1] * 0.5, { rsi_buy_threshold: 40, confirm_on_close: true });
  assert.equal(waiting.text, '实时 RSI 低于阈值，等待收盘确认');
  assert.equal(waiting.waitingClose, true);
  assert.equal(waiting.signal, false);
  // 布林带原因
  const above = mk(dn, null, { rsi_buy_threshold: 99, bb_filter_enabled: true, bb_period: 20, bb_mult: 0.1 }, last * 3);
  assert.match(above.text, /^RSI 已触发，未跌破布林下轨（价 .+ \/ 下轨 .+）$/);
  assert.equal(above.blocked.kind, 'above');
  assert.equal(above.signal, false);
  const insuff = mk(dn.slice(0, 10), null, { rsi_buy_threshold: 99, bb_filter_enabled: true, bb_period: 20 });
  assert.match(insuff.text, /^RSI 已触发，布林带K线不足（已收盘 10\/19 根），暂不买入$/);
  assert.equal(insuff.blocked.kind, 'insufficient');
  const noPx = mk(dn, null, { rsi_buy_threshold: 99, bb_filter_enabled: true }, undefined);
  // 价格取快照价，不为空；单独验证“无实时价”分支
  const st = buildStore('T-USDT-SWAP', dn, null, 6);
  const d2 = evaluateSafely(rsiDip, ctxFromStore(st, 'T-USDT-SWAP', rsiDip.clamp({ ...BASE_CFG, rsi_buy_threshold: 99, bb_filter_enabled: true }), { phase: 'scan', price: null, tradable: true }));
  assert.equal(d2.text, 'RSI 已触发，布林带无实时价，暂不买入');
  assert.ok(noPx);
});

test('复核文案：已不满足阈值 / 需收盘确认 / 无效 / 布林原因，与旧 recheckBuyCondition 一致', () => {
  const dn = makeSeries('walk', 60, rng(11)); // 中性行情：RSI 约 30~70
  const st = buildStore('R-USDT-SWAP', dn, null, 6);
  const snap = st.snapshot('R-USDT-SWAP');
  const run = (patch) => {
    const cfg = { ...BASE_CFG, ...patch };
    const params = rsiDip.clamp(cfg);
    const got = recheckResultFromDecision(evaluateSafely(rsiDip, ctxFromStore(st, 'R-USDT-SWAP', params, { phase: 'recheck', price: snap.price, tradable: true })));
    assert.deepStrictEqual(got, legacyRecheck({ snap, closes: st.closes('R-USDT-SWAP') }, cfg));
    return got;
  };
  assert.equal(run({ rsi_buy_threshold: 99 }).ok, true);
  assert.match(run({ rsi_buy_threshold: 1 }).reason, /^实时RSI=\d+\.\d\d 收盘RSI=\d+\.\d\d，已不满足 RSI<1$/);
  assert.match(run({ rsi_buy_threshold: 1, confirm_on_close: true }).reason, /（需收盘确认）$/);
  assert.match(run({ rsi_buy_threshold: 99, bb_filter_enabled: true, bb_period: 100 }).reason, /^布林带K线不足（已收盘 60\/99 根），暂不买入$/);
});

test('策略异常被隔离：evaluate 抛错 → evaluateSafely 返回 null 并回调，不外抛', () => {
  const bomb = { id: 'bomb', evaluate() { throw new Error('炸了'); } };
  const errs = [];
  assert.equal(evaluateSafely(bomb, {}, (e) => errs.push(e.message)), null);
  assert.deepEqual(errs, ['炸了']);
  assert.equal(evaluateSafely(bomb, {}, () => { throw new Error('回调也炸'); }), null);
  assert.equal(evaluateSafely(bomb, {}), null);
});

test('evaluate 纯函数：不修改入参、同输入同输出', () => {
  const st = buildStore('P-USDT-SWAP', makeSeries('crash', 60, rng(1)), 50, 6);
  const params = rsiDip.clamp({ ...BASE_CFG, rsi_buy_threshold: 99, bb_filter_enabled: true });
  const ctx = ctxFromStore(st, 'P-USDT-SWAP', params, { phase: 'scan', price: 1, tradable: true });
  const frozen = JSON.stringify(ctx);
  Object.freeze(ctx.market.closes);
  const a = rsiDip.evaluate(ctx);
  const b = rsiDip.evaluate(ctx);
  assert.deepStrictEqual(a, b);
  assert.equal(JSON.stringify(ctx), frozen);
});
