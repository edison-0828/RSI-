/**
 * 持仓数学（方向感知，纯函数）。direction: 'long' | 'short'
 *
 * - profit_pct 语义：方向调整后的价格收益率 %（不含杠杆）。多头 = 价格涨幅；空头 = 价格跌幅（价格上涨为负）。
 * - 多头分支的浮点表达式与改造前逐位一致（回归保护）。
 * - 买卖方向：多头 开仓 buy / 平仓 sell；空头 开仓 sell / 平仓 buy。
 */

/** @typedef {'long'|'short'} Direction */

function chk(dir) {
  if (dir !== 'long' && dir !== 'short') throw new Error(`direction 必须是 long 或 short，收到：${String(dir)}`);
  return dir;
}

/** 方向符号：long=+1，short=-1 */
export function sign(dir = 'long') {
  return chk(dir) === 'long' ? 1 : -1;
}

/** 开仓买卖方向 */
export function openSide(dir = 'long') {
  return chk(dir) === 'long' ? 'buy' : 'sell';
}

/** 平仓买卖方向 */
export function closeSide(dir = 'long') {
  return chk(dir) === 'long' ? 'sell' : 'buy';
}

/** 反向 */
export function oppositeDir(dir) {
  return chk(dir) === 'long' ? 'short' : 'long';
}

/** 方向中文 */
export function dirText(dir) {
  return dir === 'short' ? '空' : dir === 'long' ? '多' : '—';
}

/** 方向调整后的收益率 %：多 ((price-entry)/entry)*100；空 ((entry-price)/entry)*100 */
export function profitPct(entry, price, dir = 'long') {
  return chk(dir) === 'long' ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
}

/** 止盈价：多 entry*(1+tp/100)；空 entry*(1-tp/100) */
export function takeProfitPrice(entry, tpPct, dir = 'long') {
  return chk(dir) === 'long' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
}

/** 止损价（含灾难止损）：多 entry*(1-sl/100)；空 entry*(1+sl/100) */
export function stopLossPrice(entry, slPct, dir = 'long') {
  return chk(dir) === 'long' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
}

/** 止盈止损价 */
export function tpSlPrices(entry, tpPct, slPct, dir = 'long') {
  return { tp: takeProfitPrice(entry, tpPct, dir), sl: stopLossPrice(entry, slPct, dir) };
}

/** 价格是否已触及止损价：多 price<=sl；空 price>=sl */
export function stopHit(price, slPrice, dir = 'long') {
  return chk(dir) === 'long' ? price <= slPrice : price >= slPrice;
}

/**
 * 由平仓均价推断平仓类型（仅用于带止盈止损的旧持仓）：
 * 多 closePx>=entry 为止盈；空 closePx<=entry 为止盈；其余止损
 */
export function inferCloseAction(entry, closePx, dir = 'long') {
  return chk(dir) === 'long' ? (closePx >= entry ? 'tp' : 'sl') : closePx <= entry ? 'tp' : 'sl';
}

/** 估算盈亏 USDT：保证金 × 杠杆 × 方向调整收益% / 100 */
export function unrealizedUsdt({ amount, leverage, pct }) {
  return (amount * leverage * pct) / 100;
}

/**
 * 本地模拟的完整往返盈亏（含手续费）。
 * notional = 开仓名义（保证金×杠杆）；entry/exit 为含滑点的实际成交价；feePct 为单边 taker 费率 %（按各自成交名义计）
 * @returns {{pct:number, gross:number, feeOpen:number, feeClose:number, fee:number, net:number}}
 */
export function simRoundTrip({ notional, entry, exit, dir, feePct = 0 }) {
  const pct = profitPct(entry, exit, dir);
  const gross = (notional * pct) / 100;
  const feeOpen = (notional * feePct) / 100;
  const feeClose = (notional * (exit / entry) * feePct) / 100;
  const fee = feeOpen + feeClose;
  return { pct, gross, feeOpen, feeClose, fee, net: gross - fee };
}

/** 逐仓/全仓粗略强平价估算（本地模拟用；维持保证金率 mmr 默认 0.5%）：多 entry*(1-1/lev+mmr)；空 entry*(1+1/lev-mmr) */
export function estLiqPrice(entry, leverage, dir = 'long', mmr = 0.005) {
  const lev = Math.max(1, Number(leverage) || 1);
  return chk(dir) === 'long' ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
}

/** 止损价是否越过强平价（会先被强平）：多 sl<=liq；空 sl>=liq */
export function liqBreached({ sl, liqPx, dir = 'long' }) {
  if (!(Number(sl) > 0) || !(Number(liqPx) > 0)) return false;
  return chk(dir) === 'long' ? sl <= liqPx : sl >= liqPx;
}

export default {
  sign, openSide, closeSide, oppositeDir, dirText, profitPct, takeProfitPrice, stopLossPrice, tpSlPrices,
  stopHit, inferCloseAction, unrealizedUsdt, simRoundTrip, estLiqPrice, liqBreached,
};
