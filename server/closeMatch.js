/**
 * 交易所平仓记录匹配（/api/v5/account/positions-history）
 *
 * 旧逻辑只按「uTime ≥ 开仓时间-5 秒」取最新一条，若本仓位的平仓记录尚未出现在历史里，
 * 就会误用上一笔（同币、刚平掉）仓位的平仓记录（09-28 SENT 第二笔即此问题）。
 * 新逻辑：
 *  - 平仓记录的 cTime（仓位创建时间）必须在本仓位开仓（成交）时间附近，uTime（平仓时间）必须在开仓之后
 *  - 开仓均价与本仓位入场价偏差过大的记录排除
 *  - 方向必须一致（pos.direction；缺省 long）：先多后空（反手）时不会把上一笔多头的平仓记录误配给空头
 *  - 已被其它仓位（账本）使用过的记录（close_key）不再使用
 *  - 多条候选时取开仓之后最早的一条
 */

/** 平仓记录唯一键：instId|uTime(毫秒) —— 与账本 closed_at 可互相还原（兼容旧账本） */
export function closeKeyOf(instId, rec) {
  const u = Number(rec?.uTime);
  return instId && Number.isFinite(u) && u > 0 ? `${instId}|${u}` : null;
}

/** 账本记录 → 已用平仓键（新记录有 close_key；旧记录按 instId + closed_at 还原，仅交易所精确记录） */
export function tradeCloseKey(t) {
  if (!t) return null;
  if (t.close_key) return String(t.close_key);
  if ((t.exec_mode === 'okx_demo' || t.exec_mode === 'okx_live') && t.pnl_exact && t.closed_at) {
    const u = Date.parse(t.closed_at);
    return Number.isFinite(u) ? `${t.instId}|${u}` : null;
  }
  return null;
}

export function usedKeysFromTrades(trades = []) {
  const s = new Set();
  for (const t of trades) {
    const k = tradeCloseKey(t);
    if (k) s.add(k);
  }
  return s;
}

/**
 * 从 positions-history 中挑出属于该仓位的平仓记录
 * @param {object[]} rows positions-history 行
 * @param {object} pos 程序持仓（instId / opened_ts / order_cts / entry_price）
 * @param {Set<string>} usedKeys 已被其它仓位使用的平仓键
 * @param {{ openSkewMs?: number, closeSkewMs?: number, maxEntryDiffPct?: number }} opts
 * @returns {object|null}
 */
export function pickCloseRecord(rows, pos, usedKeys = new Set(), opts = {}) {
  const { openSkewMs = 20000, closeSkewMs = 1000, maxEntryDiffPct = 1 } = opts;
  // 方向：取持仓的 direction（缺省 long，兼容旧持仓）。OKX 净持仓下 positions-history 的 direction 为 long/short，posSide 为 net
  const dir = pos?.direction === 'short' ? 'short' : 'long';
  // 交易所开仓订单创建时间 order_cts（毫秒，交易所时钟）优先；旧持仓没有则用本地 opened_ts / at
  const fillTs = Number(pos?.order_cts) || 0;
  const localTs = Number(pos?.opened_ts) || (pos?.at ? Date.parse(pos.at) : 0) || 0;
  const openTs = fillTs || localTs;
  if (!openTs) return null;
  const entry = Number(pos?.entry_price);
  const cand = (rows || [])
    .filter((r) => r && (r.instId ? r.instId === pos.instId : true))
    .filter((r) => r.direction === dir || r.posSide === dir)
    .filter((r) => {
      const u = Number(r.uTime);
      const c = Number(r.cTime);
      if (!Number.isFinite(u) || u <= 0) return false;
      // 平仓时间必须在开仓之后（允许少量时钟误差）
      if (u < openTs - closeSkewMs) return false;
      // 仓位创建时间必须接近本仓位开仓时间（排除更早开仓、刚平掉的上一笔）
      if (Number.isFinite(c) && c > 0) {
        if (c < openTs - (fillTs ? 3000 : openSkewMs)) return false;
        if (c > openTs + openSkewMs) return false;
      }
      const oa = Number(r.openAvgPx);
      if (entry > 0 && oa > 0 && (Math.abs(oa - entry) / entry) * 100 > maxEntryDiffPct) return false;
      const k = closeKeyOf(pos.instId, r);
      if (!k || usedKeys.has(k)) return false;
      return true;
    })
    .sort((a, b) => Number(a.uTime) - Number(b.uTime));
  return cand[0] || null;
}
