/**
 * RSI 回调策略使用的纯指标函数。
 * 所有序列都只使用已收盘 K 线；数组中尚未完成预热的位置为 null。
 */

export function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += Number(values[i]);
  let ema = seed / period;
  out[period - 1] = ema;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    ema = Number(values[i]) * alpha + ema * (1 - alpha);
    out[i] = ema;
  }
  return out;
}

function rsiValue(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder RSI，与 TradingView ta.rsi 的平滑方式一致。 */
export function rsiSeries(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = Number(values[i]) - Number(values[i - 1]);
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = rsiValue(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = Number(values[i]) - Number(values[i - 1]);
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

/** Wilder ATR。 */
export function atrSeries(bars, period = 14) {
  const out = Array(bars.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || bars.length < period) return out;
  const tr = bars.map((bar, i) => {
    if (i === 0) return Number(bar.h) - Number(bar.l);
    const prev = Number(bars[i - 1].c);
    return Math.max(Number(bar.h) - Number(bar.l), Math.abs(Number(bar.h) - prev), Math.abs(Number(bar.l) - prev));
  });
  let atr = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = atr;
  for (let i = period; i < bars.length; i += 1) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** 返回 index 之前（不含当前柱）的均量，防止当前放量把基准自身抬高。 */
export function previousVolumeAverage(bars, index, period) {
  if (!Number.isInteger(period) || period < 1 || index < period) return null;
  let sum = 0;
  for (let i = index - period; i < index; i += 1) sum += Number(bars[i].v) || 0;
  return sum / period;
}

export default { emaSeries, rsiSeries, atrSeries, previousVolumeAverage };
