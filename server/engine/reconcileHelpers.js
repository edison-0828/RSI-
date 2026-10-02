/**
 * 对账用的方向感知纯函数（净持仓 net_mode 下用 pos 的符号判断方向；双向 long_short_mode 用 posSide）。
 * 取代改造前散落各处的 `pos>0` / `posSide==='long'` 判断：空头（pos<0）不会再被误判为「仓位消失」。
 */

/** 交易所持仓行 → 方向；pos==0 返回 null */
export function exchangeRowDirection(row) {
  const p = Number(row?.pos);
  if (!Number.isFinite(p) || p === 0) return null;
  if (row.posSide === 'long') return 'long';
  if (row.posSide === 'short') return 'short';
  return p > 0 ? 'long' : 'short'; // net：按符号
}

/**
 * 在交易所持仓行中匹配期望方向的该币持仓
 * @param {object[]} rows 交易所持仓行（含 pos / posSide / avgPx / liqPx …）
 * @param {string} instId
 * @param {('long'|'short'|null)} dir 期望方向；null = 任意方向
 * @returns {{pos:number, signedPos:number, direction:('long'|'short'), avgPx:number, liqPx:(number|null), raw:object}|null} pos 为绝对张数
 */
export function matchExchangePos(rows, instId, dir = null) {
  for (const r of rows || []) {
    if (!r || r.instId !== instId) continue;
    const d = exchangeRowDirection(r);
    if (!d) continue;
    if (dir && d !== dir) continue;
    const signed = Number(r.pos);
    return { pos: Math.abs(signed), signedPos: signed, direction: d, avgPx: Number(r.avgPx), liqPx: r.liqPx ? Number(r.liqPx) : null, raw: r };
  }
  return null;
}

/**
 * 对账时判定某个程序持仓与交易所的关系
 *  - match：交易所有同方向持仓
 *  - direction_mismatch：交易所该币有持仓但方向与记录相反（严重异常：不得自动平仓/重挂保护/视为消失）
 *  - gone：交易所该币没有任何持仓（才可以走「仓位消失 → 查平仓记录入账」）
 * @returns {{state:'match'|'direction_mismatch'|'gone', xp:object|null, other:object|null}}
 */
export function classifyPosition(rows, pos) {
  const dir = pos?.direction === 'short' ? 'short' : 'long';
  const same = matchExchangePos(rows, pos.instId, dir);
  if (same) return { state: 'match', xp: same, other: null };
  const other = matchExchangePos(rows, pos.instId, null);
  if (other) return { state: 'direction_mismatch', xp: null, other };
  return { state: 'gone', xp: null, other: null };
}

export default { exchangeRowDirection, matchExchangePos, classifyPosition };
