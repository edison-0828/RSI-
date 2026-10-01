/**
 * 旧数据归一化（纯函数）：缺少 strategy_id / direction 的旧记录一律视为 rsi_dip + long
 * （旧版本只可能开多）。
 *
 * 阶段 1 说明：数据文件格式本阶段不变，本函数暂未接入 loadState / 账本 / 冷却加载流程，
 * 只提供并测试“读时补默认、不丢字段、不改入参”的语义；接入在阶段 2。
 */

export const DEFAULT_STRATEGY_ID = 'rsi_dip';
export const DEFAULT_DIRECTION = 'long';

/**
 * 补默认的浅拷贝：保留所有未知字段，不修改入参；非对象原样返回
 * @template T
 * @param {T} rec 持仓 / pending / 账本交易 / 冷却条目
 * @returns {T}
 */
export function withStrategyDefaults(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const out = { ...rec };
  if (out.strategy_id == null || out.strategy_id === '') out.strategy_id = DEFAULT_STRATEGY_ID;
  if (out.direction == null || out.direction === '') out.direction = DEFAULT_DIRECTION;
  return out;
}

export const normalizePosition = withStrategyDefaults;

export default { withStrategyDefaults, normalizePosition, DEFAULT_STRATEGY_ID, DEFAULT_DIRECTION };
