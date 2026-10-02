// 子进程夹具：在 RSI_NO_LISTEN=1 + 隔离数据目录下 import server/index.js 并做一次 sim 冒烟。
// 由 phase0Isolation.test.mjs 以子进程方式运行（index.js import 即有副作用，必须隔离在独立进程里）。
// 全程不监听端口、不连交易所、只用本地模拟（sim）。结果以单行 JSON 输出到 stdout。
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const out = {};
const mod = await import('../../index.js');
const t = mod.__test;
out.hasHook = !!t;
out.dataDir = t.DATA_DIR;
out.positionsAtLoad = [...t.positions.keys()];
out.legacyAtLoad = [...t.positions.values()].map((p) => ({ instId: p.instId, strategy_id: p.strategy_id, direction: p.direction }));

// 1) 端口：PORT 由父进程指定；若 import 时已监听，则这里 bind 会失败（EADDRINUSE）
const port = Number(process.env.PORT);
out.portFree = await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

// 2) 构造行情：AAA = 合成走势（bar 103 卖出翻转、bar 164 买入翻转）；BBB = 单边缓涨（无翻转）
import { closes as synth, candle, T0, BAR } from './stSeries.mjs';
const closesA = synth();
const closesB = closesA.map((_, i) => 100 + i * 0.1);
const boot = 150; // bootstrap 前 150 根：历史中的 bar 103 卖出翻转不算信号
t.setNow(() => T0 + boot * BAR + 5_000);
const cfg = t.startScanForTest({ exec_mode: 'sim', mode: 'swap', max_positions: 3, amount: 10, leverage: 2, warmup_bars: 20, disaster_stop_pct: 8, sim_fee_pct: 0, sim_slippage_pct: 0 });
out.cfg = { atr_period: cfg.atr_period, atr_multiplier: cfg.atr_multiplier, atr_method: cfg.atr_method, allow_short: cfg.allow_short, flip_only: cfg.flip_only };
const load = (id, cl) => t.candleStore.bootstrap(id, Array.from({ length: boot }, (_, i) => candle(i, cl[i])).reverse());
load('AAA-USDT-SWAP', closesA);
load('BBB-USDT-SWAP', closesB);
t.setUniverseForTest([
  { instId: 'AAA-USDT-SWAP', volUsd24h: 1e6, price: closesA[boot - 1] },
  { instId: 'BBB-USDT-SWAP', volUsd24h: 1e6, price: closesB[boot - 1] },
]);
t.evaluateSignals({ quiet: false });
out.afterBootstrap = { positions: [...t.positions.keys()], signals: t.getSignalsForTest().filter((s) => s.signal).map((s) => s.instId) };
for (let i = boot; i < 170; i++) {
  t.setNow(() => T0 + (i + 1) * BAR + 5_000);
  t.candleStore.applyCandle('AAA-USDT-SWAP', candle(i, closesA[i]));
  t.candleStore.applyCandle('BBB-USDT-SWAP', candle(i, closesB[i]));
  t.evaluateSignals({ quiet: true });
}
const sigs = t.getSignalsForTest();
out.signals = sigs.map((r) => ({ instId: r.instId, signal: r.signal, trend: r.trend, flipDir: r.flipDir, held: r.held, signalText: r.signalText }));
out.positionsAfter = [...t.positions.values()].map((p) => ({ instId: p.instId, exec_mode: p.exec_mode, direction: p.direction, strategy_id: p.strategy_id, sl: p.stop_loss_price, tp: p.take_profit_price, entry: p.entry_price }));
out.positionsFile = existsSync(join(t.DATA_DIR, 'positions.json')) ? JSON.parse(readFileSync(join(t.DATA_DIR, 'positions.json'), 'utf8')) : null;
// clampConfig 的策略字段与策略 clamp 一致
const { getStrategy } = await import('../../strategies/index.js');
const st = getStrategy('supertrend');
out.clampMismatch = [];
for (const p of [{}, { atr_period: 7, atr_multiplier: 2, atr_method: 'sma' }, { atr_period: '0', atr_multiplier: 'x', disaster_stop_pct: 999, allow_short: 'true', flip_only: false }, { exec_mode: 'okx_live', bar: '1H' }]) {
  const c = t.clampConfig(p);
  const d = st.clamp(c);
  for (const k of Object.keys(d)) if (!Object.is(c[k], d[k])) out.clampMismatch.push({ payload: p, key: k, cfg: c[k], st: d[k] });
}
console.log('@@JSON@@' + JSON.stringify(out));
