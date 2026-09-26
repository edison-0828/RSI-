/**
 * Wilder RSI（标准实现）
 * @param {number[]} closes 收盘价序列，时间从旧到新
 * @param {number} period 默认 14
 * @returns {number|null} 最新 RSI；数据不足返回 null
 */
export function calcRsi(closes, period = 14) {
  const p = Math.max(2, Number(period) || 14);
  if (!Array.isArray(closes) || closes.length < p + 1) return null;

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // 首个平均：前 period 根涨跌的简单平均
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < p; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= p;
  avgLoss /= p;

  // Wilder 平滑
  for (let i = p; i < gains.length; i++) {
    avgGain = (avgGain * (p - 1) + gains[i]) / p;
    avgLoss = (avgLoss * (p - 1) + losses[i]) / p;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  if (!Number.isFinite(rsi)) return null;
  return rsi;
}

/**
 * 用已收盘 closes + 当前未收盘 close 算「forming」RSI（不写回正式序列）
 */
export function calcFormingRsi(closedCloses, formingClose, period = 14) {
  if (formingClose == null || !Number.isFinite(formingClose)) {
    return calcRsi(closedCloses, period);
  }
  return calcRsi([...closedCloses, formingClose], period);
}

export default { calcRsi, calcFormingRsi };
