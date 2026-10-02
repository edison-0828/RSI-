/**
 * 目标仓位状态机（纯函数）：给定策略目标与当前占用情况，决定平仓 / 开仓 / 跳过。
 *
 * 规则（对应规格）：
 *  - 同币单仓（R1）：该币被非本策略持仓/待成交订单/外部持仓占用 → 跳过；
 *  - target=flat → 只平仓；target 与持仓相反时先平后开；
 *  - 反向开仓占用刚释放的槽位，不受「仓满」阻挡；开仓腿仍受做空和冷却约束；
 *  - 无仓位：做空被拦截 / 冷却中 / 仓满 → 跳过并给出原因，否则开仓；
 *  - 持仓方向 == target（重复信号）→ 无动作。
 */

/**
 * @param {{
 *   heldDir: ('long'|'short'|null),     本策略在该币的持仓方向
 *   occupied?: string|null,             该币被他人占用的原因（旧策略持仓 / pending / 外部持仓 / 平仓中），非空则不动
 *   target: 'long'|'short'|'flat',
 *   shortBlock?: string|null,           做空被拦截的原因（shortGate.shortBlockReason）
 *   cooldown?: string|null,             冷却原因文本（灾难止损后）
 *   full?: boolean,                     仓位已满（仅对「无仓位新入场」生效）
 * }} i
 * @returns {{ close:boolean, open:('long'|'short'|null), reverse:boolean, skip:(string|null) }}
 */
export function planTarget(i) {
  const { heldDir = null, occupied = null, target, shortBlock = null, cooldown = null, full = false } = i;
  if (!['long', 'short', 'flat'].includes(target)) return { close: false, open: null, reverse: false, skip: '无效的目标仓位' };
  if (occupied) return { close: false, open: null, reverse: false, skip: occupied };
  if (target === 'flat') {
    if (!heldDir) return { close: false, open: null, reverse: false, skip: '当前无本策略持仓' };
    return { close: true, open: null, reverse: false, skip: null };
  }
  if (heldDir && heldDir === target) return { close: false, open: null, reverse: false, skip: '已持有同方向仓位，无需操作' };
  if (heldDir) {
    // 反向目标：无条件平仓；开仓腿受做空开关与冷却约束，但不受仓满约束。
    if (target === 'short' && shortBlock) return { close: true, open: null, reverse: false, skip: `仅平仓不反手：${shortBlock}` };
    if (cooldown) return { close: true, open: null, reverse: false, skip: `仅平仓不反手：${cooldown}` };
    return { close: true, open: target, reverse: true, skip: null };
  }
  if (target === 'short' && shortBlock) return { close: false, open: null, reverse: false, skip: shortBlock };
  if (cooldown) return { close: false, open: null, reverse: false, skip: cooldown };
  if (full) return { close: false, open: null, reverse: false, skip: '持仓已满，跳过新入场' };
  return { close: false, open: target, reverse: false, skip: null };
}

/** 兼容旧测试/调用；新代码应使用 planTarget。 */
export function planFlip(i) {
  return planTarget({ ...i, target: i.flipDir });
}

export default { planTarget, planFlip };
