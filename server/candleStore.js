/**
 * 每币 OHLCV 存储。只把已收盘 K 线交给策略；形成中的 K 线仅更新价格。
 * 断档时标记 stale，由引擎通过 REST 补齐，避免用不连续数据产生信号。
 */
import { barToMs } from './engine/bars.js';

const DEFAULT_MAX = 300;

export class CandleStore {
  constructor({ maxBars = DEFAULT_MAX, bar = '15m' } = {}) {
    this.maxBars = Math.max(50, maxBars);
    this.map = new Map();
    this.setParams({ bar });
  }

  setParams({ bar }) {
    this.bar = bar || this.bar || '15m';
    this.barMs = barToMs(this.bar) || 900_000;
  }

  clear() {
    this.map.clear();
  }

  ensure(instId) {
    if (!this.map.has(instId)) {
      this.map.set(instId, {
        bars: [],
        forming: null,
        price: null,
        lastTs: null,
        stale: false,
        refillAt: 0,
        updatedAt: null,
      });
    }
    return this.map.get(instId);
  }

  _ingest(entry, rows) {
    for (const bar of rows) {
      if (entry.lastTs != null) {
        if (bar.ts <= entry.lastTs) continue;
        if (bar.ts - entry.lastTs !== this.barMs) entry.bars = [];
      }
      entry.bars.push(bar);
      if (entry.bars.length > this.maxBars) entry.bars.shift();
      entry.lastTs = bar.ts;
    }
  }

  static _row(row) {
    const quoteVolume = Number(row[7]);
    const baseVolume = Number(row[5]);
    return {
      ts: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number.isFinite(quoteVolume) ? quoteVolume : (Number.isFinite(baseVolume) ? baseVolume : 0),
      confirm: String(row[8] ?? '1'),
    };
  }

  /** REST candles 为最新在前；这里重建升序、连续的已收盘序列。 */
  bootstrap(instId, candles) {
    const entry = this.ensure(instId);
    if (!Array.isArray(candles) || candles.length === 0) return entry;
    const sorted = candles
      .map(CandleStore._row)
      .filter((bar) => [bar.ts, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite))
      .sort((a, b) => a.ts - b.ts);
    const closed = [];
    let forming = null;
    for (const bar of sorted) {
      const clean = { ts: bar.ts, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
      if (bar.confirm === '0') forming = clean;
      else closed.push(clean);
    }
    entry.bars = [];
    entry.lastTs = null;
    this._ingest(entry, closed);
    entry.forming = forming;
    entry.stale = false;
    entry.price = forming?.c ?? closed.at(-1)?.c ?? entry.price;
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  applyCandle(instId, candle) {
    const entry = this.ensure(instId);
    if (!Array.isArray(candle) || candle.length < 5) return entry;
    const bar = CandleStore._row(candle);
    if (![bar.ts, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)) return entry;
    const clean = { ts: bar.ts, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
    if (bar.confirm === '1') {
      if (entry.lastTs != null && bar.ts <= entry.lastTs) return entry;
      if (entry.lastTs != null && bar.ts - entry.lastTs > this.barMs) {
        entry.stale = true;
        entry.price = bar.c;
        return entry;
      }
      this._ingest(entry, [clean]);
      if (entry.forming && entry.forming.ts <= bar.ts) entry.forming = null;
    } else {
      entry.forming = clean;
    }
    entry.price = bar.c;
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  setPrice(instId, price) {
    const entry = this.ensure(instId);
    if (price != null && Number.isFinite(price)) {
      entry.price = price;
      entry.updatedAt = new Date().toISOString();
    }
    return entry;
  }

  get(instId) {
    return this.map.get(instId) || null;
  }

  needsRefill(instId, now = Date.now()) {
    const entry = this.get(instId);
    if (!entry || entry.lastTs == null) return false;
    if (now - (entry.refillAt || 0) < this.barMs / 3) return false;
    if (entry.stale) return true;
    return now > entry.lastTs + 2 * this.barMs + 30_000;
  }

  snapshot(instId) {
    const entry = this.get(instId);
    if (!entry) return null;
    return {
      instId,
      price: entry.price,
      forming: !!entry.forming,
      bars: entry.bars.length,
      lastTs: entry.lastTs,
      stale: !!entry.stale,
      updatedAt: entry.updatedAt,
      closedBars: entry.bars.map((bar) => ({ ...bar })),
    };
  }

  size() {
    return this.map.size;
  }
}

export default CandleStore;
