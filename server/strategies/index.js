/**
 * 策略注册表：registerStrategy / getStrategy / listStrategies
 * 内置策略在模块加载时注册（阶段 1 只有 rsi_dip）。
 */
import { validateStrategy } from './contract.js';
import rsiDip from './rsiDip.js';

/** @type {Map<string, import('./contract.js').Strategy>} */
const registry = new Map();

/** 注册策略；id 重复或定义不合法会抛错 */
export function registerStrategy(strategy) {
  validateStrategy(strategy);
  if (registry.has(strategy.id)) throw new Error(`策略 id 重复：${strategy.id}`);
  registry.set(strategy.id, strategy);
  return strategy;
}

/** 取策略；未知 id 返回 undefined */
export function getStrategy(id) {
  return registry.get(id);
}

/** 已注册策略列表（注册顺序） */
export function listStrategies() {
  return [...registry.values()];
}

/**
 * 安全评估：策略抛异常时返回 null 并回调 onError，不向外抛（该策略该币本轮视为无信号）
 * @returns {import('./contract.js').Decision|null}
 */
export function evaluateSafely(strategy, ctx, onError) {
  try {
    return strategy.evaluate(ctx);
  } catch (e) {
    if (typeof onError === 'function') {
      try {
        onError(e, strategy, ctx);
      } catch {
        /* onError 自身出错也不外抛 */
      }
    }
    return null;
  }
}

registerStrategy(rsiDip);

export default { registerStrategy, getStrategy, listStrategies, evaluateSafely };
