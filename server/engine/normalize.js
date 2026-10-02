/**
 * 旧数据归一化：缺少 strategy_id / direction 的旧记录一律视为 rsi_dip + long（旧版本只可能开多）。
 * 读时补默认（不丢字段、不改入参）；升级写盘前对原文件做一次性 `*.bak-pre-v2` 备份。
 */
import { copyFileSync, existsSync } from 'fs';

export const DEFAULT_STRATEGY_ID = 'rsi_dip';
export const DEFAULT_DIRECTION = 'long';
export const SCHEMA_VERSION = 2;
/** 当前唯一启用的策略 id；其余 strategy_id（含旧数据补的 rsi_dip）一律视为「旧策略持仓」，不由 SuperTrend 引擎管理 */
export const ACTIVE_STRATEGY_ID = 'supertrend';

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

/** 是否 SuperTrend 引擎管理的持仓（其余为旧策略持仓：只对账，不开新仓/不信号平仓/不反手） */
export function isManagedPosition(pos) {
  return !!pos && pos.strategy_id === ACTIVE_STRATEGY_ID;
}

/** 记录是否缺少 v2 字段（用于判断是否需要升级备份） */
export function needsUpgrade(rec) {
  return !!rec && typeof rec === 'object' && (rec.strategy_id == null || rec.strategy_id === '' || rec.direction == null || rec.direction === '');
}

/**
 * 一次性备份：path 存在且 path+suffix 不存在时复制。返回是否真的备份了。
 * 备份失败不抛（返回 false），由调用方记录日志。
 */
export function backupOnce(path, suffix = '.bak-pre-v2') {
  try {
    const bak = `${path}${suffix}`;
    if (!existsSync(path) || existsSync(bak)) return false;
    copyFileSync(path, bak);
    return true;
  } catch {
    return false;
  }
}

export default { withStrategyDefaults, normalizePosition, isManagedPosition, needsUpgrade, backupOnce, DEFAULT_STRATEGY_ID, DEFAULT_DIRECTION, ACTIVE_STRATEGY_ID, SCHEMA_VERSION };
