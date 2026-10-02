/**
 * RSI 趋势回调：EMA 定方向，RSI 超调后重新穿越触发，成交量确认，ATR 灾难止损。
 * 信号只读取已收盘 K 线；策略返回目标仓位（long / short / flat），执行与风控由引擎负责。
 */
import { atrSeries, emaSeries, previousVolumeAverage, rsiSeries } from '../engine/rsiPullbackCalc.js';

export const RSI_PULLBACK_DEFAULTS = Object.freeze({
  bar: '15m',
  rsi_period: 14,
  ema_period: 200,
  long_setup_rsi: 35,
  long_entry_rsi: 40,
  short_setup_rsi: 65,
  short_entry_rsi: 60,
  setup_lookback: 12,
  exit_long_rsi: 65,
  exit_short_rsi: 35,
  volume_filter_enabled: true,
  volume_period: 20,
  volume_multiplier: 1,
  atr_period: 14,
  atr_stop_mult: 2.5,
  trend_exit_enabled: true,
  rsi_exit_enabled: true,
  allow_short: false,
});

const BARS = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H'];

function clamp(raw = {}) {
  const D = RSI_PULLBACK_DEFAULTS;
  const num = (value, fallback) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value));
  const bool = (value, fallback) => (value === undefined || value === null ? fallback : value === true || value === 'true' || value === 1 || value === '1');
  const longSetup = Math.max(5, Math.min(49, num(raw.long_setup_rsi, D.long_setup_rsi)));
  const longEntry = Math.max(longSetup + 1, Math.min(60, num(raw.long_entry_rsi, D.long_entry_rsi)));
  const shortSetup = Math.max(51, Math.min(95, num(raw.short_setup_rsi, D.short_setup_rsi)));
  const shortEntry = Math.max(40, Math.min(shortSetup - 1, num(raw.short_entry_rsi, D.short_entry_rsi)));
  return {
    bar: BARS.includes(raw.bar) ? raw.bar : D.bar,
    rsi_period: Math.max(2, Math.min(100, Math.round(num(raw.rsi_period, D.rsi_period)))),
    ema_period: Math.max(20, Math.min(500, Math.round(num(raw.ema_period, D.ema_period)))),
    long_setup_rsi: longSetup,
    long_entry_rsi: longEntry,
    short_setup_rsi: shortSetup,
    short_entry_rsi: shortEntry,
    setup_lookback: Math.max(2, Math.min(100, Math.round(num(raw.setup_lookback, D.setup_lookback)))),
    exit_long_rsi: Math.max(longEntry + 1, Math.min(95, num(raw.exit_long_rsi, D.exit_long_rsi))),
    exit_short_rsi: Math.max(5, Math.min(shortEntry - 1, num(raw.exit_short_rsi, D.exit_short_rsi))),
    volume_filter_enabled: bool(raw.volume_filter_enabled, D.volume_filter_enabled),
    volume_period: Math.max(2, Math.min(200, Math.round(num(raw.volume_period, D.volume_period)))),
    volume_multiplier: Math.max(0.1, Math.min(10, num(raw.volume_multiplier, D.volume_multiplier))),
    atr_period: Math.max(2, Math.min(100, Math.round(num(raw.atr_period, D.atr_period)))),
    atr_stop_mult: Math.max(0, Math.min(20, num(raw.atr_stop_mult, D.atr_stop_mult))),
    trend_exit_enabled: bool(raw.trend_exit_enabled, D.trend_exit_enabled),
    rsi_exit_enabled: bool(raw.rsi_exit_enabled, D.rsi_exit_enabled),
    allow_short: bool(raw.allow_short, D.allow_short),
  };
}

function hasFreshSetup(values, from, to, isSetup, isRecovered) {
  let setupIndex = -1;
  for (let i = Math.max(0, from); i <= to; i += 1) {
    if (values[i] != null && isSetup(values[i])) setupIndex = i;
  }
  if (setupIndex < 0) return false;
  // 一次超调只允许第一次恢复穿越触发；若已经恢复过，必须等新的超调。
  for (let i = setupIndex + 1; i <= to; i += 1) {
    if (values[i - 1] != null && values[i] != null && isRecovered(values[i - 1], values[i])) return false;
  }
  return true;
}

function evaluate(ctx) {
  const p = ctx.params;
  const bars = Array.isArray(ctx.market?.closedBars) ? ctx.market.closedBars : [];
  const held = ctx.flags?.heldDirection || null;
  const required = Math.max(p.ema_period, p.rsi_period + p.setup_lookback + 2, p.volume_period + 1, p.atr_period);
  const baseMetrics = { readyBars: bars.length, requiredBars: required, signalTs: null, signalCloseAt: null, signalKind: null };
  const base = { direction: null, target: null, signal: false, text: '', blocked: null, metrics: baseMetrics };
  if (ctx.flags?.tradable === false) return { ...base, text: '模拟盘无此合约' };
  if (bars.length < required) return { ...base, text: `RSI 策略预热中（${bars.length}/${required} 根）` };

  const closes = bars.map((bar) => Number(bar.c));
  const rsi = rsiSeries(closes, p.rsi_period);
  const ema = emaSeries(closes, p.ema_period);
  const atr = atrSeries(bars, p.atr_period);
  const i = bars.length - 1;
  const last = bars[i];
  const currentRsi = rsi[i];
  const previousRsi = rsi[i - 1];
  const currentEma = ema[i];
  const currentAtr = atr[i];
  const volumeAverage = previousVolumeAverage(bars, i, p.volume_period);
  const volume = Number(last.v) || 0;
  const volumeRatio = volumeAverage > 0 ? volume / volumeAverage : null;
  const volumeOk = !p.volume_filter_enabled || (volumeAverage > 0 && volume >= volumeAverage * p.volume_multiplier);
  const longSetup = hasFreshSetup(
    rsi,
    i - p.setup_lookback,
    i - 1,
    (value) => value <= p.long_setup_rsi,
    (previous, current) => previous <= p.long_entry_rsi && current > p.long_entry_rsi,
  );
  const shortSetup = hasFreshSetup(
    rsi,
    i - p.setup_lookback,
    i - 1,
    (value) => value >= p.short_setup_rsi,
    (previous, current) => previous >= p.short_entry_rsi && current < p.short_entry_rsi,
  );
  const longCross = previousRsi != null && currentRsi != null && previousRsi <= p.long_entry_rsi && currentRsi > p.long_entry_rsi;
  const shortCross = previousRsi != null && currentRsi != null && previousRsi >= p.short_entry_rsi && currentRsi < p.short_entry_rsi;
  const aboveEma = currentEma != null && Number(last.c) > currentEma;
  const belowEma = currentEma != null && Number(last.c) < currentEma;
  const metrics = {
    ...baseMetrics,
    rsi: currentRsi,
    previousRsi,
    ema: currentEma,
    atr: currentAtr,
    volume,
    volumeAverage,
    volumeRatio,
    volumeOk,
    trend: aboveEma ? 'bull' : belowEma ? 'bear' : 'neutral',
    longSetup,
    shortSetup,
    signalTs: last.ts,
    signalCloseAt: Number(last.ts) + Number(ctx.market.barMs || 0),
  };
  const meta = {
    signal_bar_ts: last.ts,
    rsi: currentRsi,
    ema: currentEma,
    atr: currentAtr,
    volume_ratio: volumeRatio,
  };
  const slPct = p.atr_stop_mult > 0 && currentAtr > 0 && last.c > 0 ? Math.min(50, (currentAtr * p.atr_stop_mult * 100) / Number(last.c)) : undefined;

  if (held === 'long') {
    const rsiExit = p.rsi_exit_enabled && currentRsi >= p.exit_long_rsi;
    const trendExit = p.trend_exit_enabled && belowEma;
    if (rsiExit || trendExit) {
      const reason = rsiExit ? `RSI ${currentRsi.toFixed(1)} 到达多单止盈区` : '收盘价跌破 EMA 趋势线';
      return { ...base, target: 'flat', signal: true, text: `平多：${reason}`, metrics: { ...metrics, signalKind: 'exit_long' }, meta };
    }
    return { ...base, direction: 'long', text: `持有多单，RSI ${currentRsi.toFixed(1)}，价格${aboveEma ? '高于' : '低于'} EMA`, metrics, meta };
  }
  if (held === 'short') {
    const rsiExit = p.rsi_exit_enabled && currentRsi <= p.exit_short_rsi;
    const trendExit = p.trend_exit_enabled && aboveEma;
    if (rsiExit || trendExit) {
      const reason = rsiExit ? `RSI ${currentRsi.toFixed(1)} 到达空单止盈区` : '收盘价升破 EMA 趋势线';
      return { ...base, target: 'flat', signal: true, text: `平空：${reason}`, metrics: { ...metrics, signalKind: 'exit_short' }, meta };
    }
    return { ...base, direction: 'short', text: `持有空单，RSI ${currentRsi.toFixed(1)}，价格${belowEma ? '低于' : '高于'} EMA`, metrics, meta };
  }

  if (longSetup && longCross && currentRsi < p.exit_long_rsi && aboveEma && volumeOk) {
    return { ...base, direction: 'long', target: 'long', signal: true, text: `做多：RSI 从超卖回升至 ${currentRsi.toFixed(1)}，趋势与量能确认`, slPct, metrics: { ...metrics, signalKind: 'entry_long' }, meta };
  }
  if (shortSetup && shortCross && currentRsi > p.exit_short_rsi && belowEma && volumeOk) {
    return { ...base, direction: 'short', target: 'short', signal: true, text: `做空：RSI 从超买回落至 ${currentRsi.toFixed(1)}，趋势与量能确认`, slPct, metrics: { ...metrics, signalKind: 'entry_short' }, meta };
  }

  const volumeText = p.volume_filter_enabled && !volumeOk ? '，等待成交量确认' : '';
  return { ...base, text: `RSI ${currentRsi.toFixed(1)}，${aboveEma ? '多头趋势' : belowEma ? '空头趋势' : '趋势中性'}，等待回调恢复信号${volumeText}`, slPct, metrics, meta };
}

/** @type {import('./contract.js').Strategy} */
const rsiPullback = {
  id: 'rsi_pullback',
  name: 'RSI 趋势回调',
  version: 1,
  directions: ['long', 'short'],
  params: [
    { key: 'bar', label: 'K 线周期', type: 'string', default: RSI_PULLBACK_DEFAULTS.bar },
    { key: 'rsi_period', label: 'RSI 周期', type: 'number', default: RSI_PULLBACK_DEFAULTS.rsi_period, min: 2, max: 100 },
    { key: 'ema_period', label: 'EMA 趋势周期', type: 'number', default: RSI_PULLBACK_DEFAULTS.ema_period, min: 20, max: 500 },
    { key: 'long_setup_rsi', label: '多头超卖阈值', type: 'number', default: RSI_PULLBACK_DEFAULTS.long_setup_rsi },
    { key: 'long_entry_rsi', label: '多头恢复阈值', type: 'number', default: RSI_PULLBACK_DEFAULTS.long_entry_rsi },
    { key: 'short_setup_rsi', label: '空头超买阈值', type: 'number', default: RSI_PULLBACK_DEFAULTS.short_setup_rsi },
    { key: 'short_entry_rsi', label: '空头恢复阈值', type: 'number', default: RSI_PULLBACK_DEFAULTS.short_entry_rsi },
    { key: 'setup_lookback', label: '超调回看根数', type: 'number', default: RSI_PULLBACK_DEFAULTS.setup_lookback },
    { key: 'volume_filter_enabled', label: '成交量确认', type: 'boolean', default: RSI_PULLBACK_DEFAULTS.volume_filter_enabled },
    { key: 'volume_period', label: '均量周期', type: 'number', default: RSI_PULLBACK_DEFAULTS.volume_period },
    { key: 'volume_multiplier', label: '成交量倍数', type: 'number', default: RSI_PULLBACK_DEFAULTS.volume_multiplier },
    { key: 'atr_period', label: 'ATR 周期', type: 'number', default: RSI_PULLBACK_DEFAULTS.atr_period },
    { key: 'atr_stop_mult', label: 'ATR 灾难止损倍数', type: 'number', default: RSI_PULLBACK_DEFAULTS.atr_stop_mult },
    { key: 'exit_long_rsi', label: '多单 RSI 退出', type: 'number', default: RSI_PULLBACK_DEFAULTS.exit_long_rsi },
    { key: 'exit_short_rsi', label: '空单 RSI 退出', type: 'number', default: RSI_PULLBACK_DEFAULTS.exit_short_rsi },
    { key: 'trend_exit_enabled', label: 'EMA 反转退出', type: 'boolean', default: RSI_PULLBACK_DEFAULTS.trend_exit_enabled },
    { key: 'rsi_exit_enabled', label: 'RSI 目标退出', type: 'boolean', default: RSI_PULLBACK_DEFAULTS.rsi_exit_enabled },
    { key: 'allow_short', label: '允许做空', type: 'boolean', default: RSI_PULLBACK_DEFAULTS.allow_short },
  ],
  presets: [
    { id: 'balanced', name: '均衡', params: {} },
    { id: 'conservative', name: '保守', params: { long_setup_rsi: 30, long_entry_rsi: 38, short_setup_rsi: 70, short_entry_rsi: 62, volume_multiplier: 1.2, atr_stop_mult: 2 } },
  ],
  clamp,
  needs: (p) => ({ bar: p.bar, closedBars: Math.max(p.ema_period, p.rsi_period + p.setup_lookback + 2, p.volume_period + 1, p.atr_period) }),
  evaluate,
};

export default rsiPullback;
