/**
 * 布林带下轨过滤（与回测口径 live-analysis/bb-test/bb_engine.py 一致）
 *   样本 = 扫描周期前 period-1 根已收盘收盘价 + 当前实时价，共 period 个
 *   中轨 = 均值；标准差为总体标准差（ddof=0）；下轨 = 中轨 − mult × 标准差
 * 开关打开时：RSI 已触发 且 实时价 < 下轨 才放行；K 线不足时不放行。
 * 开关关闭时：不做任何改变（applyBbFilter 原样返回 RSI 判定）。
 */

export const BB_DEFAULTS = Object.freeze({ bb_filter_enabled: false, bb_period: 20, bb_mult: 2.0 });
export const BB_PERIOD_MIN = 2;
export const BB_PERIOD_MAX = 100; // Bootstrap 只拉 100 根 K 线

/** 夹紧/补默认值：旧配置里没有这些字段时按默认值处理 */
export function clampBbCfg(cfg = {}) {
  const en = cfg.bb_filter_enabled;
  const p = Math.round(Number(cfg.bb_period));
  const m = Number(cfg.bb_mult);
  return {
    bb_filter_enabled: en === true || en === 'true' || en === 1,
    bb_period: Number.isFinite(p) && p > 0 ? Math.max(BB_PERIOD_MIN, Math.min(BB_PERIOD_MAX, p)) : BB_DEFAULTS.bb_period,
    bb_mult: Number.isFinite(m) && m > 0 ? Math.min(m, 10) : BB_DEFAULTS.bb_mult,
  };
}

/**
 * 计算实时布林带
 * @param {number[]} closedCloses 已收盘收盘价（从旧到新，只取最后 period-1 根）
 * @param {number} price 当前实时价
 * @returns {{lower:number, mid:number, sd:number, upper:number} | null} 数据不足返回 null
 */
export function calcBollinger(closedCloses, price, period = BB_DEFAULTS.bb_period, mult = BB_DEFAULTS.bb_mult) {
  const n = Math.round(Number(period));
  if (!Number.isFinite(n) || n < 2) return null;
  if (price == null || !Number.isFinite(price)) return null;
  if (!Array.isArray(closedCloses) || closedCloses.length < n - 1) return null;
  const xs = [...closedCloses.slice(closedCloses.length - (n - 1)), price];
  if (xs.some((v) => !Number.isFinite(v))) return null;
  const mid = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, v) => a + (v - mid) ** 2, 0) / n);
  return { lower: mid - mult * sd, mid, sd, upper: mid + mult * sd };
}

function fmtPx(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  return Number(v.toPrecision(4)).toString();
}

/**
 * 在「RSI 已触发」之后叠加布林下轨条件
 * @param {boolean} rsiSignal RSI 判定结果（buySignalFromRsi().signal）
 * @param {{closes:number[], price:number|null}} data 已收盘收盘价 + 实时价
 * @param {object} cfg 扫描配置
 * @returns {{signal:boolean, blocked:boolean, reason:string|null, kind:null|'above'|'insufficient', lower:number|null, mid:number|null}}
 */
export function applyBbFilter(rsiSignal, data, cfg) {
  const out = { signal: !!rsiSignal, blocked: false, reason: null, kind: null, lower: null, mid: null };
  const bb = clampBbCfg(cfg || {});
  if (!bb.bb_filter_enabled) return out; // 关闭：与原逻辑完全一致
  const closes = data?.closes || [];
  const price = data?.price;
  const b = calcBollinger(closes, price, bb.bb_period, bb.bb_mult);
  if (b) {
    out.lower = b.lower;
    out.mid = b.mid;
  }
  if (!rsiSignal) return out; // RSI 未触发：只附带下轨数值，不产生跳过原因
  if (!b) {
    out.signal = false;
    out.blocked = true;
    out.kind = 'insufficient';
    const have = Array.isArray(closes) ? closes.length : 0;
    out.reason =
      price == null || !Number.isFinite(price)
        ? '布林带无实时价，暂不买入'
        : `布林带K线不足（已收盘 ${have}/${bb.bb_period - 1} 根），暂不买入`;
    return out;
  }
  if (!(price < b.lower)) {
    out.signal = false;
    out.blocked = true;
    out.kind = 'above';
    out.reason = `未跌破布林下轨（价 ${fmtPx(price)} / 下轨 ${fmtPx(b.lower)}）`;
  }
  return out;
}

export default { BB_DEFAULTS, clampBbCfg, calcBollinger, applyBbFilter };
