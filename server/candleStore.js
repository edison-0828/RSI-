/**
 * 每币 K 线 closes 环形缓冲 + 未收盘蜡烛
 */
import { calcRsi, calcFormingRsi } from './rsi.js';

const DEFAULT_MAX = 200;

export class CandleStore {
  constructor({ maxBars = DEFAULT_MAX, period = 14 } = {}) {
    this.maxBars = Math.max(50, maxBars);
    this.period = period;
    /** @type {Map<string, { closes: number[], tsList: number[], forming: { ts: number, close: number } | null, price: number|null, rsi: number|null, rsiForming: number|null, updatedAt: string|null }>} */
    this.map = new Map();
  }

  setPeriod(period) {
    this.period = Math.max(2, Number(period) || 14);
  }

  clear() {
    this.map.clear();
  }

  ensure(instId) {
    if (!this.map.has(instId)) {
      this.map.set(instId, {
        closes: [],
        tsList: [],
        forming: null,
        price: null,
        rsi: null,
        rsiForming: null,
        updatedAt: null,
      });
    }
    return this.map.get(instId);
  }

  /**
   * Bootstrap：REST 返回的 candles（最新在前）
   * @param {string} instId
   * @param {Array} candles [[ts,o,h,l,c,...,confirm], ...]
   */
  bootstrap(instId, candles) {
    const entry = this.ensure(instId);
    if (!Array.isArray(candles) || candles.length === 0) return entry;

    // 按时间升序
    const sorted = [...candles].sort((a, b) => Number(a[0]) - Number(b[0]));
    const closed = [];
    const tsList = [];
    let forming = null;

    for (const row of sorted) {
      const ts = Number(row[0]);
      const close = Number(row[4]);
      const confirm = String(row[8] ?? '1');
      if (!Number.isFinite(ts) || !Number.isFinite(close)) continue;
      if (confirm === '0') {
        forming = { ts, close };
      } else {
        closed.push(close);
        tsList.push(ts);
      }
    }

    // 截断
    while (closed.length > this.maxBars) {
      closed.shift();
      tsList.shift();
    }

    entry.closes = closed;
    entry.tsList = tsList;
    entry.forming = forming;
    if (forming) entry.price = forming.close;
    else if (closed.length) entry.price = closed[closed.length - 1];
    this.recompute(instId);
    return entry;
  }

  /**
   * WS K 线推送：candle = [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]
   */
  applyCandle(instId, candle) {
    const entry = this.ensure(instId);
    if (!Array.isArray(candle) || candle.length < 5) return entry;

    const ts = Number(candle[0]);
    const close = Number(candle[4]);
    const confirm = String(candle[8] ?? '0');
    if (!Number.isFinite(ts) || !Number.isFinite(close)) return entry;

    if (confirm === '1') {
      // 已收盘：写入 / 覆盖同 ts
      const lastTs = entry.tsList.length ? entry.tsList[entry.tsList.length - 1] : null;
      if (lastTs === ts) {
        entry.closes[entry.closes.length - 1] = close;
      } else if (lastTs == null || ts > lastTs) {
        entry.closes.push(close);
        entry.tsList.push(ts);
        while (entry.closes.length > this.maxBars) {
          entry.closes.shift();
          entry.tsList.shift();
        }
      }
      // 清掉同 ts 的 forming
      if (entry.forming && entry.forming.ts === ts) entry.forming = null;
      entry.price = close;
    } else {
      // 未收盘
      entry.forming = { ts, close };
      entry.price = close;
    }

    this.recompute(instId);
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

  recompute(instId) {
    const entry = this.ensure(instId);
    entry.rsi = calcRsi(entry.closes, this.period);
    entry.rsiForming = calcFormingRsi(
      entry.closes,
      entry.forming?.close ?? null,
      this.period
    );
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  get(instId) {
    return this.map.get(instId) || null;
  }

  snapshot(instId) {
    const e = this.get(instId);
    if (!e) return null;
    return {
      instId,
      price: e.price,
      rsi: e.rsi,
      rsiForming: e.rsiForming,
      forming: !!e.forming,
      bars: e.closes.length,
      updatedAt: e.updatedAt,
    };
  }

  size() {
    return this.map.size;
  }
}

export default CandleStore;
