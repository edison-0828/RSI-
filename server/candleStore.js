/**
 * 每币 K 线存储 + SuperTrend 增量状态（只在「已收盘」K 线上推进指标）
 *
 * - bootstrap：REST 返回的历史 K 线（最新在前，约 300 根）→ 升序逐根推进 SuperTrend；历史中的翻转不算信号。
 * - applyCandle：WS 推送。confirm='1'（已收盘）才推进指标；confirm='0'（正在形成）只更新价格，绝不参与信号。
 * - 断档（WS 漏了已收盘 K 线）：不盲目推进，标记 stale，由 index.js 用 REST 补齐（refill）。
 * - 翻转记录在 lastFlip（{ts,dir,closeAt,close}），由引擎按 ts 去重消费；ts = 该 K 线开盘时间，closeAt = ts + 周期。
 */
import { createState, stepSuperTrend, ST_DEFAULTS } from './engine/superTrendCalc.js';
import { barToMs } from './engine/bars.js';

const DEFAULT_MAX = 300;

export class CandleStore {
  /**
   * @param {{maxBars?:number, bar?:string, period?:number, mult?:number, method?:'rma'|'sma'}} opts
   */
  constructor({ maxBars = DEFAULT_MAX, bar = '15m', period = ST_DEFAULTS.period, mult = ST_DEFAULTS.mult, method = ST_DEFAULTS.method } = {}) {
    this.maxBars = Math.max(50, maxBars);
    this.map = new Map();
    this.setParams({ bar, period, mult, method });
  }

  /** 设置周期与 SuperTrend 参数（扫描启动时调用；调用方应随后 clear + 重新 bootstrap） */
  setParams({ bar, period, mult, method }) {
    this.bar = bar || this.bar || '15m';
    this.barMs = barToMs(this.bar) || 900_000;
    this.stOpts = { period: Number(period) || ST_DEFAULTS.period, mult: Number(mult) || ST_DEFAULTS.mult, method: method === 'sma' ? 'sma' : 'rma' };
  }

  clear() {
    this.map.clear();
  }

  ensure(instId) {
    if (!this.map.has(instId)) {
      this.map.set(instId, {
        bars: [], // 已收盘 {ts,o,h,l,c}，升序
        forming: null, // {ts,o,h,l,c}
        price: null,
        st: createState(this.stOpts),
        stOut: null, // 最近一根已收盘 K 线的指标输出
        lastFlip: null, // {ts, dir:'long'|'short', closeAt, close}：已记为「信号」的最近一次翻转
        trendSince: null, // 当前趋势开始的 K 线开盘时间（不论是否记为信号）
        trendVal: null,
        lastTs: null,
        stale: false,
        refillAt: 0,
        updatedAt: null,
      });
    }
    return this.map.get(instId);
  }

  /** 推进一批升序的已收盘 K 线；emitAfterTs：只有 ts 大于它的翻转才记为信号（历史翻转 = 不记） */
  _ingest(entry, rows, emitAfterTs) {
    for (const b of rows) {
      if (entry.lastTs != null) {
        if (b.ts <= entry.lastTs) continue; // 重复 / 乱序
        if (b.ts - entry.lastTs !== this.barMs) {
          // 内部断档：从这里重新预热（与 Python 回测一致：只取最后一段连续序列）
          entry.st = createState(this.stOpts);
          entry.stOut = null;
          entry.trendVal = null;
        }
      }
      const r = stepSuperTrend(entry.st, { h: b.h, l: b.l, c: b.c });
      entry.st = r.state;
      entry.stOut = r.out;
      entry.lastTs = b.ts;
      if (r.out.ready && r.out.trend !== entry.trendVal) {
        entry.trendVal = r.out.trend;
        entry.trendSince = b.ts;
      }
      entry.bars.push(b);
      if (entry.bars.length > this.maxBars) entry.bars.shift();
      if ((r.out.buy || r.out.sell) && b.ts > emitAfterTs) {
        entry.lastFlip = { ts: b.ts, dir: r.out.buy ? 'long' : 'short', closeAt: b.ts + this.barMs, close: b.c };
      }
    }
  }

  static _row(row) {
    return { ts: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), confirm: String(row[8] ?? '1') };
  }

  /**
   * Bootstrap / 补齐：REST 返回的 candles（最新在前）。重建该币的指标状态。
   * @param {number} [emitAfterTs] 默认 Infinity = 历史翻转都不算信号；启动时传「刚收盘」阈值，补齐时传旧 lastTs（缺失期间发生的翻转作为信号保留）
   */
  bootstrap(instId, candles, emitAfterTs = Infinity) {
    const entry = this.ensure(instId);
    if (!Array.isArray(candles) || candles.length === 0) return entry;
    const sorted = candles
      .map(CandleStore._row)
      .filter((b) => [b.ts, b.o, b.h, b.l, b.c].every(Number.isFinite))
      .sort((a, b) => a.ts - b.ts);
    const closed = [];
    let forming = null;
    for (const b of sorted) {
      if (b.confirm === '0') forming = { ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c };
      else closed.push({ ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c });
    }
    const prevFlip = entry.lastFlip;
    entry.bars = [];
    entry.st = createState(this.stOpts);
    entry.stOut = null;
    entry.lastTs = null;
    entry.lastFlip = null;
    entry.trendVal = null;
    entry.trendSince = null;
    this._ingest(entry, closed, emitAfterTs);
    if (!entry.lastFlip && prevFlip) entry.lastFlip = prevFlip; // 重建不丢已记录（可能尚未处理）的信号
    entry.forming = forming;
    entry.stale = false;
    if (forming) entry.price = forming.c;
    else if (closed.length) entry.price = closed[closed.length - 1].c;
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  /**
   * WS K 线推送：candle = [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]
   * @returns {entry}
   */
  applyCandle(instId, candle) {
    const entry = this.ensure(instId);
    if (!Array.isArray(candle) || candle.length < 5) return entry;
    const b = CandleStore._row(candle);
    if (![b.ts, b.o, b.h, b.l, b.c].every(Number.isFinite)) return entry;
    if (b.confirm === '1') {
      if (entry.lastTs != null && b.ts <= entry.lastTs) return entry; // 重复推送
      if (entry.lastTs != null && b.ts - entry.lastTs > this.barMs) {
        entry.stale = true; // 漏了已收盘 K 线：等 REST 补齐，不盲目推进
        entry.price = b.c;
        return entry;
      }
      this._ingest(entry, [{ ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c }], -Infinity);
      if (entry.forming && entry.forming.ts <= b.ts) entry.forming = null;
      entry.price = b.c;
    } else {
      entry.forming = { ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c };
      entry.price = b.c;
    }
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

  /** 需要 REST 补齐的币：stale，或应已收盘的 K 线迟迟没到（每币每根 K 线最多补一次） */
  needsRefill(instId, now = Date.now()) {
    const e = this.get(instId);
    if (!e || e.lastTs == null) return false;
    if (now - (e.refillAt || 0) < this.barMs / 3) return false;
    if (e.stale) return true;
    return now > e.lastTs + 2 * this.barMs + 30_000;
  }

  snapshot(instId) {
    const e = this.get(instId);
    if (!e) return null;
    const o = e.stOut;
    return {
      instId,
      price: e.price,
      forming: !!e.forming,
      bars: e.bars.length,
      lastTs: e.lastTs,
      stale: !!e.stale,
      updatedAt: e.updatedAt,
      st: {
        ready: !!(o && o.ready),
        readyBars: e.st.readyBars,
        trend: o && o.ready ? o.trend : null, // 1 / -1
        up: o?.up ?? null,
        dn: o?.dn ?? null,
        atr: o?.atr ?? null,
        flip: e.lastFlip ? { ...e.lastFlip } : null,
        trendSince: e.trendSince,
      },
    };
  }

  size() {
    return this.map.size;
  }
}

export default CandleStore;
