/**
 * 持仓数学（方向中性接口的“阶段 1 版本”：只实现做多语义）
 *
 * 约束（见 DESIGN.md 4.1）：
 * - 多头分支的浮点表达式与改造前 index.js / pnl.js 中的写法逐位一致（运算顺序相同），
 *   测试里用 Object.is 严格比较，不是近似比较。
 * - 阶段 1 不涉及做空：传入 'short' 会直接抛错，避免在做空代码尚未就位时被误用。
 *   做空镜像在阶段 2 才加入。
 * - profit_pct 语义：价格涨跌幅 %（不含杠杆）。
 */

/** @typedef {'long'|'short'} Direction */

function assertLong(dir) {
  if (dir !== undefined && dir !== 'long') {
    throw new Error(`positionMath 阶段 1 仅支持做多（direction='long'），收到：${String(dir)}`);
  }
}

/** 方向符号：long=+1 */
export function sign(dir = 'long') {
  assertLong(dir);
  return 1;
}

/** 开仓方向 */
export function openSide(dir = 'long') {
  assertLong(dir);
  return 'buy';
}

/** 平仓方向 */
export function closeSide(dir = 'long') {
  assertLong(dir);
  return 'sell';
}

/** 价格涨跌幅 %：((price - entry) / entry) * 100（与改造前表达式逐位相同） */
export function profitPct(entry, price, dir = 'long') {
  assertLong(dir);
  return ((price - entry) / entry) * 100;
}

/** 止盈价：entry * (1 + tpPct / 100) */
export function takeProfitPrice(entry, tpPct, dir = 'long') {
  assertLong(dir);
  return entry * (1 + tpPct / 100);
}

/** 止损价：entry * (1 - slPct / 100) */
export function stopLossPrice(entry, slPct, dir = 'long') {
  assertLong(dir);
  return entry * (1 - slPct / 100);
}

/** 止盈止损价 */
export function tpSlPrices(entry, tpPct, slPct, dir = 'long') {
  return { tp: takeProfitPrice(entry, tpPct, dir), sl: stopLossPrice(entry, slPct, dir) };
}

/** 由平仓均价推断平仓类型：不低于入场价为止盈，否则止损（做多） */
export function inferCloseAction(entry, closePx, dir = 'long') {
  assertLong(dir);
  return closePx >= entry ? 'tp' : 'sl';
}

/** 估算盈亏 USDT：金额(保证金) × 杠杆 × 涨跌% / 100（与 pnl.js 一致） */
export function unrealizedUsdt({ amount, leverage, pct }) {
  return (amount * leverage * pct) / 100;
}

export default { sign, openSide, closeSide, profitPct, takeProfitPrice, stopLossPrice, tpSlPrices, inferCloseAction, unrealizedUsdt };
