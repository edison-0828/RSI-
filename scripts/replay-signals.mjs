#!/usr/bin/env node
// RSI 趋势回调信号回放。只读本地 K 线文件，不联网、不下单、不触碰 server/data。
import { readFileSync } from 'node:fs';
import rsiPullback from '../server/strategies/rsiPullback.js';

const args = process.argv.slice(2);
const opt = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
if (args.includes('--help') || args.includes('-h') || !opt('file')) {
  console.error('用法：node scripts/replay-signals.mjs --file <K线文件> [--coin BTC-USDT-SWAP] [--bar 15m] [--rsi 14] [--ema 200] [--volume-mult 1] [--limit 700]');
  process.exit(opt('file') ? 0 : 2);
}

const coin = opt('coin', 'UNKNOWN');
const bar = opt('bar', '15m');
const barMs = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1H': 3_600_000, '2H': 7_200_000, '4H': 14_400_000 }[bar] || 900_000;
const params = rsiPullback.clamp({
  bar,
  rsi_period: Number(opt('rsi', 14)),
  ema_period: Number(opt('ema', 200)),
  volume_multiplier: Number(opt('volume-mult', 1)),
  allow_short: true,
});
const limit = Number(opt('limit', 0));
const raw = JSON.parse(readFileSync(opt('file'), 'utf8'));

function toBar(row) {
  const quoteVolume = Number(row[7]);
  const baseVolume = Number(row[5]);
  return {
    ts: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]),
    v: Number.isFinite(quoteVolume) ? quoteVolume : (Number.isFinite(baseVolume) ? baseVolume : 0),
  };
}

let rows = Array.isArray(raw) ? raw : Object.values(raw || {});
let bars = rows
  .filter((row) => Array.isArray(row) && String(row[8] ?? '1') !== '0')
  .map(toBar)
  .filter((item) => [item.ts, item.o, item.h, item.l, item.c].every(Number.isFinite))
  .sort((a, b) => a.ts - b.ts);
if (limit > 0 && bars.length > limit) bars = bars.slice(-limit);
if (!bars.length) {
  console.error('文件里没有可用的已收盘 K 线');
  process.exit(2);
}

const required = rsiPullback.needs(params).closedBars;
let longs = 0;
let shorts = 0;
for (let i = required - 1; i < bars.length; i += 1) {
  const closedBars = bars.slice(0, i + 1);
  const last = closedBars.at(-1);
  const decision = rsiPullback.evaluate({
    instId: coin,
    phase: 'scan',
    params,
    market: { price: last.c, bars: closedBars.length, barMs, lastBarTs: last.ts, closedBars },
    flags: { tradable: true, heldDirection: null },
  });
  if (!decision.signal || !['long', 'short'].includes(decision.target)) continue;
  if (decision.target === 'long') longs += 1;
  else shorts += 1;
  console.log(JSON.stringify({
    coin, i, ts: last.ts, time: new Date(last.ts).toISOString(), direction: decision.target,
    close: last.c, rsi: decision.metrics.rsi, ema: decision.metrics.ema, atr: decision.metrics.atr,
    volumeRatio: decision.metrics.volumeRatio, slPct: decision.slPct, text: decision.text,
  }));
}
console.error(JSON.stringify({ summary: { coin, bars: bars.length, longs, shorts, params } }));
