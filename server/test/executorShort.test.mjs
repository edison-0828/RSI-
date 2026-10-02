// executor 多空（mock，不联网）：做空下单 / 保护单 / 平仓 / 预检 / 做空断言
import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxExecutor } from '../executor.js';

function prepared(mode = 'okx_demo') {
  const logs = [];
  const ex = new OkxExecutor({ mode, log: (level, msg) => logs.push({ level, msg }) });
  ex.accountConfig = { posMode: 'net_mode', acctLv: '2' };
  ex.instruments.set('BTC-USDT-SWAP', { instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '1', minSz: '1', tickSz: '0.1', maxLever: 100, state: 'live' });
  ex.loadInstruments = async () => ex.instruments;
  ex.getDemoTicker = async () => ({ askPx: 100.2, bidPx: 100, last: 100.1 });
  ex.refreshBalance = async () => ({ usdtAvail: 1000 });
  ex.ensureLeverage = async () => {};
  ex.client.getPositions = async () => [];
  return { ex, logs };
}

const withEnv = async (env, fn) => {
  const old = { a: process.env.RSI_ALLOW_SHORT, b: process.env.RSI_ALLOW_SHORT_LIVE };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, key] of [['RSI_ALLOW_SHORT', 'a'], ['RSI_ALLOW_SHORT_LIVE', 'b']]) {
      if (old[key] === undefined) delete process.env[k];
      else process.env[k] = old[key];
    }
  }
};

test('开空：环境变量未放行 → 执行层断言直接抛错，且不碰任何网络方法（实盘 / 模拟盘都一样）', async () => {
  for (const mode of ['okx_demo', 'okx_live']) {
    const { ex } = prepared(mode);
    let touched = false;
    ex._placeOrderIdempotent = async () => { touched = true; return { ordId: 'x' }; };
    await withEnv({ RSI_ALLOW_SHORT: '0', RSI_ALLOW_SHORT_LIVE: '1' }, async () => {
      await assert.rejects(ex.openPosition({ instId: 'BTC-USDT-SWAP', direction: 'short', amount: 100, leverage: 1, maxSpreadPct: 0.5 }), /拒绝做空开仓/);
    });
    assert.equal(touched, false);
  }
  // 实盘：只开 RSI_ALLOW_SHORT 不开 RSI_ALLOW_SHORT_LIVE 也拒绝
  const { ex } = prepared('okx_live');
  await withEnv({ RSI_ALLOW_SHORT: '1', RSI_ALLOW_SHORT_LIVE: '0' }, async () => {
    await assert.rejects(ex.openPosition({ instId: 'BTC-USDT-SWAP', direction: 'short', amount: 100, leverage: 1, maxSpreadPct: 0.5 }), /RSI_ALLOW_SHORT_LIVE/);
  });
});

test('开空（模拟盘 mock）：side=sell、参考买一价算张数、pos 带 direction / strategy_id、灾难止损为 conditional+buy+reduceOnly', async () => {
  const { ex } = prepared('okx_demo');
  const orders = [];
  const algos = [];
  ex._placeOrderIdempotent = async (body) => { orders.push(body); return { ordId: 'o-open' }; };
  ex._waitFill = async () => ({ order: { state: 'filled', accFillSz: '10', avgPx: '100', fee: '-0.05', cTime: '1' }, final: true });
  ex.getExchangePosition = async () => ({ pos: 10, signedPos: -10, direction: 'short', avgPx: 100, liqPx: 190 });
  ex.client.placeAlgoOrder = async (body) => { algos.push(body); return [{ algoId: 'A1' }]; };
  const events = [];
  const r = await withEnv({ RSI_ALLOW_SHORT: '1' }, () =>
    ex.openPosition({ instId: 'BTC-USDT-SWAP', direction: 'short', amount: 100, leverage: 10, tpPct: null, slPct: 8, strategyId: 'supertrend', strategyVersion: 1, signalMeta: { flip_bar_ts: 7 }, maxSpreadPct: 0.5, onPending: (e) => events.push(e), recheck: () => ({ ok: true }) })
  );
  assert.equal(r.ok, true);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].side, 'sell');
  assert.equal(orders[0].ordType, 'market');
  assert.match(orders[0].clOrdId, /^stso/);
  assert.equal(orders[0].posSide, undefined, 'net 模式不传 posSide');
  // 参考价 = 买一 100：保证金 100 × 10x = 名义 1000 → 1000/(0.01×100)=1000 张？（按 calcContracts 规则，不低于最小量即可）
  assert.ok(Number(orders[0].sz) >= 1);
  const pos = r.pos;
  assert.equal(pos.direction, 'short');
  assert.equal(pos.strategy_id, 'supertrend');
  assert.equal(pos.strategy_version, 1);
  assert.deepEqual(pos.signal_meta, { flip_bar_ts: 7 });
  assert.equal(pos.liq_price, 190);
  assert.equal(pos.take_profit_price, null);
  assert.ok(Math.abs(pos.stop_loss_price - 108) < 1e-6, `空头灾难止损价应在入场价上方 8%：${pos.stop_loss_price}`);
  assert.equal(algos.length, 1);
  assert.equal(algos[0].ordType, 'conditional');
  assert.equal(algos[0].side, 'buy');
  assert.equal(algos[0].reduceOnly, true);
  assert.equal(Number(algos[0].slTriggerPx), 108);
  assert.equal(algos[0].tpTriggerPx, undefined);
  assert.equal(pos.algoId, 'A1');
  assert.equal(events[0].direction, 'short');
  assert.equal(events[0].strategy_id, 'supertrend');
});

test('开多（模拟盘 mock）：side=buy、参考卖一价；旧式止盈+止损为 OCO + sell + reduceOnly（旧 RSI 持仓的重挂路径）', async () => {
  const { ex } = prepared('okx_demo');
  const orders = [];
  const algos = [];
  ex._placeOrderIdempotent = async (body) => { orders.push(body); return { ordId: 'o1' }; };
  ex._waitFill = async () => ({ order: { state: 'filled', accFillSz: '5', avgPx: '100.2' }, final: true });
  ex.getExchangePosition = async () => ({ pos: 5, signedPos: 5, direction: 'long', avgPx: 100.2, liqPx: null });
  ex.client.placeAlgoOrder = async (b) => { algos.push(b); return [{ algoId: 'A2' }]; };
  const r = await ex.openPosition({ instId: 'BTC-USDT-SWAP', direction: 'long', amount: 100, leverage: 2, tpPct: 8, slPct: 6, maxSpreadPct: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(orders[0].side, 'buy');
  assert.match(orders[0].clOrdId, /^stlo/);
  assert.equal(algos[0].ordType, 'oco');
  assert.equal(algos[0].side, 'sell');
  assert.equal(algos[0].reduceOnly, true);
  assert.ok(algos[0].tpTriggerPx && algos[0].slTriggerPx);
  assert.ok(Number(algos[0].tpTriggerPx) > 100.2 && Number(algos[0].slTriggerPx) < 100.2);
});

test('灾难止损关闭（slPct=0 且 tpPct=0）→ 不挂任何保护单', async () => {
  const { ex } = prepared('okx_demo');
  let placed = 0;
  ex._placeOrderIdempotent = async () => ({ ordId: 'o1' });
  ex._waitFill = async () => ({ order: { state: 'filled', accFillSz: '5', avgPx: '100.2' }, final: true });
  ex.getExchangePosition = async () => ({ pos: 5, direction: 'long', avgPx: 100.2, liqPx: null });
  ex.client.placeAlgoOrder = async () => { placed++; return [{ algoId: 'X' }]; };
  const r = await ex.openPosition({ instId: 'BTC-USDT-SWAP', direction: 'long', amount: 100, leverage: 2, tpPct: null, slPct: 0, maxSpreadPct: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(placed, 0);
  assert.equal(ex.needsProtection(r.pos), false);
});

test('开仓前预检：交易所该币已有任意方向持仓 → occupied，不下单；预检失败 → precheck，不下单', async () => {
  for (const [rows, kind] of [[[{ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '-3', avgPx: '100' }], 'occupied'], [[{ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '4', avgPx: '100' }], 'occupied'], [null, 'precheck']]) {
    const { ex } = prepared('okx_demo');
    let ordered = false;
    ex._placeOrderIdempotent = async () => { ordered = true; return { ordId: 'x' }; };
    ex.client.getPositions = async () => { if (!rows) throw new Error('网络错误'); return rows; };
    const r = await ex.openPosition({ instId: 'BTC-USDT-SWAP', direction: 'long', amount: 100, leverage: 1, maxSpreadPct: 0.5 });
    assert.equal(r.skipped, true);
    assert.equal(r.skipKind, kind);
    assert.equal(ordered, false);
  }
});

test('空头 marketClose：side=buy + reduceOnly；按交易所空头张数修正；部分平仓保留剩余', async () => {
  const { ex } = prepared('okx_demo');
  const orders = [];
  let q = 0;
  ex.getExchangePosition = async (_i, dir) => { assert.equal(dir, 'short'); q++; return q === 1 ? { pos: 10, avgPx: 100 } : { pos: 4, avgPx: 100 }; };
  ex._placeOrderIdempotent = async (b) => { orders.push(b); return { ordId: 'c1' }; };
  ex._waitFill = async () => ({ order: { state: 'filled', accFillSz: '6', avgPx: '95' }, final: true });
  const pos = { instId: 'BTC-USDT-SWAP', direction: 'short', contracts: 8, contractsStr: '8', entry_price: 100, posSide: 'net', status: 'open' };
  const res = await ex.marketClose(pos, 'flip');
  assert.equal(orders[0].side, 'buy');
  assert.equal(orders[0].reduceOnly, true);
  assert.equal(orders[0].sz, '10', '张数按交易所持仓修正 8 → 10');
  assert.equal(res.complete, false);
  assert.equal(res.remaining, 4);
  assert.equal(res.closeAvgPx, 95);
  assert.equal(pos.close_reason, 'flip');
  assert.equal(pos.status, 'closing');
  // 完全平掉
  const { ex: ex2 } = prepared('okx_demo');
  let q2 = 0;
  ex2.getExchangePosition = async () => (++q2 === 1 ? { pos: 3, avgPx: 100 } : null);
  ex2._placeOrderIdempotent = async () => ({ ordId: 'c2' });
  ex2._waitFill = async () => ({ order: { state: 'filled', accFillSz: '3', avgPx: '101' }, final: true });
  const pos2 = { instId: 'BTC-USDT-SWAP', direction: 'long', contracts: 3, contractsStr: '3', entry_price: 100, posSide: 'net', status: 'open' };
  const r2 = await ex2.marketClose(pos2, 'flip');
  assert.equal(r2.complete, true);
  assert.equal(r2.closeAvgPx, 101);
});
