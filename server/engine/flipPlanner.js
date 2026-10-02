/**
 * SuperTrend 「始终持仓反手」状态机（纯函数）：给定一次翻转信号与当前占用情况，决定 平仓 / 开仓 / 跳过。
 *
 * 规则（对应规格）：
 *  - 同币单仓（R1）：该币被非本策略持仓/待成交订单/外部持仓占用 → 跳过；
 *  - 持仓方向 ≠ 翻转方向 → 平仓；若允许，立即反手（先平后开两笔，不是净持仓对冲）。
 *    反手占用刚释放的槽位，不受「仓满」阻挡；做空被拦截时只平仓不反手；
 *  - 无仓位：做空被拦截 / 冷却中 / 仓满 → 跳过并给出原因，否则开仓；
 *  - 持仓方向 == 翻转方向（重复信号）→ 无动作。
 */

/**
 * @param {{
 *   heldDir: ('long'|'short'|null),     本策略在该币的持仓方向
 *   occupied?: string|null,             该币被他人占用的原因（旧策略持仓 / pending / 外部持仓 / 平仓中），非空则不动
 *   flipDir: 'long'|'short',
 *   shortBlock?: string|null,           做空被拦截的原因（shortGate.shortBlockReason）
 *   cooldown?: string|null,             冷却原因文本（灾难止损后）
 *   full?: boolean,                     仓位已满（仅对「无仓位新入场」生效）
 * }} i
 * @returns {{ close:boolean, open:('long'|'short'|null), reverse:boolean, skip:(string|null) }}
 */
export function planFlip(i) {
  const { heldDir = null, occupied = null, flipDir, shortBlock = null, cooldown = null, full = false } = i;
  if (flipDir !== 'long' && flipDir !== 'short') return { close: false, open: null, reverse: false, skip: '无效的翻转方向' };
  if (occupied) return { close: false, open: null, reverse: false, skip: occupied };
  if (heldDir && heldDir === flipDir) return { close: false, open: null, reverse: false, skip: '已持有同方向仓位，无需操作' };
  if (heldDir) {
    // 反向翻转：无条件平仓（风控不得阻止平仓）；开仓腿受做空开关与冷却约束，但不受仓满约束
    if (flipDir === 'short' && shortBlock) return { close: true, open: null, reverse: false, skip: `仅平仓不反手：${shortBlock}` };
    if (cooldown) return { close: true, open: null, reverse: false, skip: `仅平仓不反手：${cooldown}` };
    return { close: true, open: flipDir, reverse: true, skip: null };
  }
  if (flipDir === 'short' && shortBlock) return { close: false, open: null, reverse: false, skip: shortBlock };
  if (cooldown) return { close: false, open: null, reverse: false, skip: cooldown };
  if (full) return { close: false, open: null, reverse: false, skip: '持仓已满，跳过新入场' };
  return { close: false, open: flipDir, reverse: false, skip: null };
}

export default { planFlip };
