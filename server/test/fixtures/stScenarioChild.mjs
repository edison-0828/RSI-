// 子进程夹具：sim 端到端场景（RSI_NO_LISTEN=1 + RSI_DATA_DIR 临时目录；不监听端口、不连交易所、不读 .env.local）。
// 输入：环境变量 ST_SCENARIO（JSON）：
//   { cfg, coins: { [instId]: number[]|'main' }, boot, feedTo, nowLag, actions:[{afterBar, inst, price}] }
// 逻辑：先 bootstrap 前 boot 根（历史翻转不算信号）→ 逐根 applyCandle（confirm=1）→ 每根后评估一次；输出事件、成交、持仓。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closes as mainCloses, candle, T0, BAR } from './stSeries.mjs';

const sc = JSON.parse(process.env.ST_SCENARIO || '{}');
const mod = await import('../../index.js');
const t = mod.__test;
const coins = sc.coins || { 'AAA-USDT-SWAP': 'main' };
const series = Object.fromEntries(Object.entries(coins).map(([k, v]) => [k, v === 'main' ? mainCloses() : v]));
const boot = sc.boot ?? 60;
const feedTo = sc.feedTo ?? 400;
const lag = (sc.nowLag ?? 5) * 1000;
const cfg = t.startScanForTest({ exec_mode: 'sim', mode: 'swap', max_positions: 5, amount: 100, leverage: 1, warmup_bars: 20, disaster_stop_pct: 0, sim_fee_pct: 0, sim_slippage_pct: 0, ...(sc.cfg || {}) });
t.setNow(() => T0 + boot * BAR + lag);
for (const [id, cl] of Object.entries(series)) {
  const rows = [];
  for (let i = 0; i < boot; i++) rows.push(candle(i, cl[i]));
  t.candleStore.bootstrap(id, rows.reverse(), Infinity);
}
t.setUniverseForTest(Object.entries(series).map(([id, cl]) => ({ instId: id, volUsd24h: 1e6, price: cl[boot - 1] })));
t.evaluateSignals({ quiet: true });
const timeline = [];
for (let i = boot; i < feedTo; i++) {
  const lagNow = sc.lagAfter && i >= sc.lagAfter.bar ? sc.lagAfter.lag * 1000 : lag;
  t.setNow(() => T0 + (i + 1) * BAR + lagNow);
  for (const [id, cl] of Object.entries(series)) if (i < cl.length) t.candleStore.applyCandle(id, candle(i, cl[i]));
  t.evaluateSignals({ quiet: true });
  for (const a of sc.actions || []) {
    if (a.afterBar === i) {
      t.candleStore.setPrice(a.inst, a.price);
      t.evaluateSignals({ quiet: true });
    }
  }
  const snap = [...t.positions.values()].map((p) => `${p.instId}:${p.direction}`).join(',');
  const last = timeline[timeline.length - 1];
  if (!last || last.pos !== snap) timeline.push({ bar: i, pos: snap });
}
const out = {
  cfg: { allow_short: cfg.allow_short, flip_only: cfg.flip_only },
  timeline,
  positions: [...t.positions.values()],
  trades: t.listTrades(100, 'sim').reverse(),
  signals: t.getSignalsForTest(),
  cooldowns: t.coinGuard.list(cfg),
  log: t.eventLog.map((e) => `${e.level}|${e.msg}`).reverse(),
  positionsFile: existsSync(join(t.DATA_DIR, 'positions.json')) ? JSON.parse(readFileSync(join(t.DATA_DIR, 'positions.json'), 'utf8')) : null,
};
console.log('@@JSON@@' + JSON.stringify(out));
