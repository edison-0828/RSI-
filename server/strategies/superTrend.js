/**
 * 策略：SuperTrend 翻转反手（KivancOzbilgic 标准版，始终持仓）
 *
 * 纯函数：只读 ctx.market.st（由 CandleStore 在「已收盘」K 线上增量计算），不读时钟/随机数/网络，不改入参，不写日志。
 * - 翻转 buy（trend -1 → 1）→ direction='long'；翻转 sell（1 → -1）→ direction='short'。
 * - 是否「新」翻转（去重 / 过期）、持仓状态机、做空开关、仓位上限都由引擎负责。
 * - 无翻转时：flip_only=false 且当前趋势已确立 → 给出 direction=趋势方向、signal=false、metrics.enterByTrend=true，
 *   由引擎在「无仓位」时按当前趋势入场（默认关闭：只在翻转时入场）。
 */

export const SUPERTREND_DEFAULTS = Object.freeze({
  bar: '15m',
  atr_period: 10,
  atr_multiplier: 3,
  atr_method: 'rma',
  disaster_stop_pct: 8,
  allow_short: false,
  flip_only: true,
  warmup_bars: 150,
});

const BARS = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H'];

function clamp(raw = {}) {
  const r = raw || {};
  const num = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'true' || v === 1 || v === '1');
  const D = SUPERTREND_DEFAULTS;
  return {
    bar: BARS.includes(r.bar) ? r.bar : D.bar,
    atr_period: Math.max(1, Math.min(100, Math.round(num(r.atr_period, D.atr_period)) || D.atr_period)),
    atr_multiplier: Math.max(0.1, Math.min(20, num(r.atr_multiplier, D.atr_multiplier)) || D.atr_multiplier),
    atr_method: String(r.atr_method).toLowerCase() === 'sma' ? 'sma' : 'rma',
    disaster_stop_pct: Math.max(0, Math.min(50, num(r.disaster_stop_pct, D.disaster_stop_pct))), // 0 = 关闭
    allow_short: bool(r.allow_short, D.allow_short),
    flip_only: bool(r.flip_only, D.flip_only),
    warmup_bars: Math.max(20, Math.min(280, Math.round(num(r.warmup_bars, D.warmup_bars)))),
  };
}

/**
 * @param {object} ctx { instId, phase, params, market:{price, bars, barMs, st:{ready, readyBars, trend, flip, up, dn, atr}}, flags:{tradable} }
 */
function evaluate(ctx) {
  const p = ctx.params;
  const m = ctx.market || {};
  const st = m.st || {};
  const notTradable = ctx.flags?.tradable === false;
  const flip = st.flip || null;
  const warm = st.ready && Number(st.readyBars) >= p.warmup_bars;
  const metrics = {
    trend: st.ready ? st.trend : null,
    up: st.up ?? null,
    dn: st.dn ?? null,
    atr: st.atr ?? null,
    flipDir: flip?.dir ?? null,
    flipTs: flip?.ts ?? null,
    flipCloseAt: flip?.closeAt ?? null,
    readyBars: st.readyBars ?? 0,
    enterByTrend: false,
  };
  const meta = { flip_bar_ts: flip?.ts ?? null, trend: metrics.trend, atr: metrics.atr, st_up: metrics.up, st_dn: metrics.dn };
  const base = { tpPct: undefined, slPct: p.disaster_stop_pct > 0 ? p.disaster_stop_pct : undefined, metrics, meta, blocked: null };
  const trendText = st.trend === 1 ? '上升趋势' : st.trend === -1 ? '下降趋势' : '趋势未知';

  if (notTradable) return { ...base, direction: null, signal: false, text: '模拟盘无此合约' };
  if (!warm) return { ...base, direction: null, signal: false, text: `SuperTrend 预热中（${st.readyBars ?? 0}/${p.warmup_bars} 根）` };
  if (flip && flip.ts === m.lastBarTs) {
    const word = flip.dir === 'long' ? '买入翻转（转上升）' : '卖出翻转（转下降）';
    return { ...base, direction: flip.dir, signal: true, text: `最新收盘K线出现${word}` };
  }
  if (flip && flip.ts !== m.lastBarTs) {
    // 翻转发生在更早的 K 线（引擎若尚未消费，会按 flip.ts 去重 / 判过期；这里仍标记 signal，由引擎裁决）
    const word = flip.dir === 'long' ? '买入翻转' : '卖出翻转';
    return { ...base, direction: flip.dir, signal: true, text: `${word}（K线 ${flip.ts}）待处理` };
  }
  if (!p.flip_only && st.trend != null) {
    const dir = st.trend === 1 ? 'long' : 'short';
    return { ...base, direction: dir, signal: false, text: `${trendText}（启动入场模式：无仓位时按趋势入场）`, metrics: { ...metrics, enterByTrend: true } };
  }
  return { ...base, direction: null, signal: false, text: `${trendText}，等待翻转` };
}

/** @type {import('./contract.js').Strategy} */
const superTrend = {
  id: 'supertrend',
  name: 'SuperTrend 翻转反手',
  version: 1,
  directions: ['long', 'short'],
  params: [
    { key: 'atr_period', label: 'ATR 周期', type: 'number', default: SUPERTREND_DEFAULTS.atr_period, min: 1, max: 100 },
    { key: 'atr_multiplier', label: 'ATR 倍数', type: 'number', default: SUPERTREND_DEFAULTS.atr_multiplier, min: 0.1, max: 20 },
    { key: 'atr_method', label: 'ATR 方法', type: 'string', default: SUPERTREND_DEFAULTS.atr_method, hint: 'rma（默认，Pine atr()）或 sma' },
    { key: 'bar', label: 'K 线周期', type: 'string', default: SUPERTREND_DEFAULTS.bar },
    { key: 'disaster_stop_pct', label: '灾难止损 %', type: 'number', default: SUPERTREND_DEFAULTS.disaster_stop_pct, min: 0, max: 50, hint: '入场价反向 N%，0=关闭' },
    { key: 'allow_short', label: '允许做空', type: 'boolean', default: SUPERTREND_DEFAULTS.allow_short },
    { key: 'flip_only', label: '仅翻转入场', type: 'boolean', default: SUPERTREND_DEFAULTS.flip_only },
    { key: 'warmup_bars', label: '预热根数', type: 'number', default: SUPERTREND_DEFAULTS.warmup_bars, min: 20, max: 280, advanced: true },
  ],
  presets: [],
  clamp,
  needs: (p) => ({ bar: p.bar, closedBars: p.warmup_bars + p.atr_period }),
  evaluate,
};

export default superTrend;
