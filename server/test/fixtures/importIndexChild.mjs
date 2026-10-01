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

// 1) 端口：PORT 由父进程指定；若 import 时已监听，则这里 bind 会失败（EADDRINUSE）
const port = Number(process.env.PORT);
out.portFree = await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

// 2) 构造行情：一个“RSI 很低”的币，一个“未触发”的币
const bootstrap = (instId, closesOldToNew) => {
  const t0 = 1_790_000_000_000;
  const candles = closesOldToNew.map((c, i) => [t0 + i * 900_000, c, c, c, c, 1, 1, 1, '1']).reverse(); // 最新在前
  t.candleStore.bootstrap(instId, candles);
};
const falling = [];
let px = 100;
for (let i = 0; i < 60; i++) {
  px = px * (i % 7 === 6 ? 1.004 : 0.985);
  falling.push(px);
}
const flatUp = [];
for (let i = 0; i < 60; i++) flatUp.push(100 + i * 0.1);
t.candleStore.setPeriod(6);
bootstrap('AAA-USDT-SWAP', falling);
bootstrap('BBB-USDT-SWAP', flatUp);
t.setUniverseForTest([
  { instId: 'AAA-USDT-SWAP', volUsd24h: 1e6, price: falling[falling.length - 1] },
  { instId: 'BBB-USDT-SWAP', volUsd24h: 1e6, price: flatUp[flatUp.length - 1] },
]);
const cfg = t.startScanForTest({ exec_mode: 'sim', mode: 'swap', rsi_period: 6, rsi_buy_threshold: 20, max_positions: 3, amount: 10, leverage: 2 });
out.cfgRsiBuyThreshold = cfg.rsi_buy_threshold;

// 3) 评估一轮：AAA 应触发并在 sim 下开仓；BBB 不触发
t.evaluateSignals({ quiet: false });
const sigs = t.getSignalsForTest();
out.signals = sigs.map((r) => ({ instId: r.instId, signal: r.signal, signalText: r.signalText, rsi: r.rsi }));
out.positionsAfter = [...t.positions.values()].map((p) => ({ instId: p.instId, exec_mode: p.exec_mode, entry: p.entry_price, tp: p.take_profit_price, sl: p.stop_loss_price }));
out.recheck = t.recheckBuyCondition('AAA-USDT-SWAP', 'sim');
out.shadow = { ...t.shadowStats };
out.positionsFile = existsSync(join(t.DATA_DIR, 'positions.json')) ? JSON.parse(readFileSync(join(t.DATA_DIR, 'positions.json'), 'utf8')).positions.map((p) => p.instId) : null;

// 4) clampConfig 的策略相关字段 与 rsiDip.clamp 一致（旧 payload）
const { getStrategy } = await import('../../strategies/index.js');
const dip = getStrategy('rsi_dip');
const payloads = [
  {},
  { rsi_period: 14, rsi_buy_threshold: 25, confirm_on_close: true },
  { rsi_period: '9', rsi_buy_threshold: '0', take_profit_pct: 0, stop_loss_pct: 'x', bb_filter_enabled: true, bb_period: 500, bb_mult: -1 },
  { exec_mode: 'okx_live', bb_filter_enabled: 'true', bb_period: 1, bb_mult: 99, confirm_on_close: 'true', bar: '1H' },
  { rsi_period: 1, confirm_on_close: 1, bb_filter_enabled: 1, bb_period: 30.6, bb_mult: 2.25 },
];
out.clampMismatch = [];
for (const p of payloads) {
  const c = t.clampConfig(p);
  const d = dip.clamp(c);
  for (const k of Object.keys(d)) if (!Object.is(c[k], d[k])) out.clampMismatch.push({ payload: p, key: k, cfg: c[k], dip: d[k] });
}
console.log('@@JSON@@' + JSON.stringify(out));
