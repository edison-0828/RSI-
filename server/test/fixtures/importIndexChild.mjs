// 隔离子进程：import 后端并用本地 OHLCV 驱动一次 RSI 回调入场。
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

const port = Number(process.env.PORT);
out.portFree = await new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

const BAR = 900_000;
const T0 = 1_700_000_000_000;
const candle = (i, close, volume = 100, confirm = '1') => [String(T0 + i * BAR), String(close), String(close + 1), String(close - 1), String(close), String(volume), String(volume), String(volume), confirm];
const closes = [...Array.from({ length: 30 }, (_, i) => 100 + i * 0.2), 100, 95, 90, 88, 90, 94, 104];
const boot = closes.length - 1;
const cfg = t.startScanForTest({
  exec_mode: 'sim', mode: 'swap', max_positions: 3, amount: 10, leverage: 2,
  ema_period: 20, rsi_period: 14, volume_filter_enabled: true, volume_period: 20,
  volume_multiplier: 1, atr_period: 14, atr_stop_mult: 2.5,
  sim_fee_pct: 0, sim_slippage_pct: 0,
});
out.cfg = { rsi_period: cfg.rsi_period, ema_period: cfg.ema_period, atr_period: cfg.atr_period, atr_stop_mult: cfg.atr_stop_mult, allow_short: cfg.allow_short };
t.candleStore.bootstrap('AAA-USDT-SWAP', Array.from({ length: boot }, (_, i) => candle(i, closes[i])).reverse());
t.setUniverseForTest([{ instId: 'AAA-USDT-SWAP', volUsd24h: 1e6, price: closes[boot - 1] }]);
t.setNow(() => T0 + boot * BAR + 5_000);
t.evaluateSignals({ quiet: false });
out.afterBootstrap = { positions: [...t.positions.keys()], signals: t.getSignalsForTest().filter((s) => s.signal).map((s) => s.instId) };

t.candleStore.applyCandle('AAA-USDT-SWAP', candle(boot, closes[boot], 150));
t.setNow(() => T0 + (boot + 1) * BAR + 5_000);
t.evaluateSignals({ quiet: true });
out.signals = t.getSignalsForTest().map((row) => ({ instId: row.instId, signal: row.signal, trend: row.trend, rsi: row.rsi, target: row.target, held: row.held, signalText: row.signalText }));
out.positionsAfter = [...t.positions.values()].map((p) => ({ instId: p.instId, exec_mode: p.exec_mode, direction: p.direction, strategy_id: p.strategy_id, sl: p.stop_loss_price, slPct: p.sl_pct, tp: p.take_profit_price, entry: p.entry_price }));
out.positionsFile = existsSync(join(t.DATA_DIR, 'positions.json')) ? JSON.parse(readFileSync(join(t.DATA_DIR, 'positions.json'), 'utf8')) : null;

const { getStrategy } = await import('../../strategies/index.js');
const strategy = getStrategy('rsi_pullback');
out.clampMismatch = [];
for (const payload of [{}, { rsi_period: 7, ema_period: 50, volume_multiplier: 1.2 }, { atr_stop_mult: 999, allow_short: 'true' }, { exec_mode: 'okx_live', bar: '1H' }]) {
  const actual = t.clampConfig(payload);
  const expected = strategy.clamp(actual);
  for (const key of Object.keys(expected)) if (!Object.is(actual[key], expected[key])) out.clampMismatch.push({ payload, key, actual: actual[key], expected: expected[key] });
}

console.log('@@JSON@@' + JSON.stringify(out));
