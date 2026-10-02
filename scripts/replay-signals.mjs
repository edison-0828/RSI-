#!/usr/bin/env node
// SuperTrend 翻转回放：读 K 线文件 → 按币输出翻转序列（JSONL，一行一个翻转）。只读文件，不联网、不下单、不碰 server/data。
//
// 用法：
//   node scripts/replay-signals.mjs --file <K线文件> [--coin BTC-USDT-SWAP] [--period 10] [--mult 3] [--method rma|sma] [--limit 700]
// 支持的文件格式：
//   1) 缓存字典：{ "<ts>": [ts,o,h,l,c,vol,volCcy,confirm], ... }（单币；--coin 仅作标注）
//   2) 测试 fixture（server/test/fixtures/supertrend/python_ref.json）：{ coins: { inst: { ts,h,l,c } } }，可用 --coin 选币
//   3) OKX REST 返回数组：[[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm], ...]（最新在前）
// 输出每行：{"coin","i","ts","time","dir":"long|short","signal":"buy|sell","close","atr","up","dn"}；末尾一行汇总 { "summary": ... }（输出到 stderr）
import { readFileSync } from 'node:fs';
import { superTrend } from '../server/engine/superTrendCalc.js';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
if (args.includes('--help') || args.includes('-h') || !opt('file')) {
  console.error('用法：node scripts/replay-signals.mjs --file <K线文件> [--coin <instId>] [--period 10] [--mult 3] [--method rma|sma] [--limit N]');
  process.exit(opt('file') ? 0 : 2);
}
const period = Number(opt('period', 10));
const mult = Number(opt('mult', 3));
const method = String(opt('method', 'rma')).toLowerCase() === 'sma' ? 'sma' : 'rma';
const limit = Number(opt('limit', 0));
const coinArg = opt('coin', null);
const raw = JSON.parse(readFileSync(opt('file'), 'utf8'));

/** 统一成 { coin -> {ts,h,l,c} }（升序，仅已收盘） */
function load() {
  const out = {};
  const fromRows = (rows) => {
    const r = rows
      .filter((x) => String(x[x.length - 1] ?? '1') !== '0')
      .map((x) => ({ ts: Number(x[0]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]) }))
      .filter((b) => [b.ts, b.h, b.l, b.c].every(Number.isFinite))
      .sort((a, b) => a.ts - b.ts);
    return { ts: r.map((b) => b.ts), h: r.map((b) => b.h), l: r.map((b) => b.l), c: r.map((b) => b.c) };
  };
  if (raw && raw.coins) {
    for (const [k, v] of Object.entries(raw.coins)) out[k] = { ts: v.ts, h: v.h, l: v.l, c: v.c };
  } else if (Array.isArray(raw)) {
    out[coinArg || 'UNKNOWN'] = fromRows(raw);
  } else if (raw && typeof raw === 'object') {
    out[coinArg || 'UNKNOWN'] = fromRows(Object.values(raw));
  }
  return out;
}

const all = load();
const coins = coinArg && all[coinArg] ? [coinArg] : Object.keys(all);
if (!coins.length) {
  console.error('文件里没有可用的 K 线');
  process.exit(2);
}
const summary = {};
for (const coin of coins) {
  let { ts, h, l, c } = all[coin];
  if (limit > 0 && c.length > limit) {
    const s = c.length - limit;
    ts = ts.slice(s); h = h.slice(s); l = l.slice(s); c = c.slice(s);
  }
  const r = superTrend(h, l, c, { period, mult, method });
  let buys = 0;
  let sells = 0;
  for (let i = 0; i < c.length; i++) {
    if (!r.buy[i] && !r.sell[i]) continue;
    r.buy[i] ? buys++ : sells++;
    console.log(
      JSON.stringify({
        coin,
        i,
        ts: ts[i],
        time: new Date(ts[i]).toISOString(),
        dir: r.buy[i] ? 'long' : 'short',
        signal: r.buy[i] ? 'buy' : 'sell',
        close: c[i],
        atr: r.atr[i],
        up: r.up[i],
        dn: r.dn[i],
      })
    );
  }
  summary[coin] = { bars: c.length, buys, sells, params: { period, mult, method } };
}
console.error(JSON.stringify({ summary }));
