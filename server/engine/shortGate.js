/**
 * 做空开关（三层拦截中的 1、2 层判定，纯函数；第 3 层是 executor.openPosition 与 openSimPosition 内的断言）
 *
 *  1) 服务端环境变量（后端硬开关，不依赖前端）：
 *       RSI_ALLOW_SHORT=1       才允许做空（sim / okx_demo）；默认 0 = 任何模式都不做空
 *       RSI_ALLOW_SHORT_LIVE=1  实盘（okx_live）另需此项（且需 RSI_ALLOW_SHORT=1）；默认 0
 *  2) 策略设置 allow_short（界面开关）；现货不支持做空
 *  3) 执行层断言：direction==='short' 且被 1 拦截时直接抛错
 * 做空被拦截时：已持多单遇卖出翻转仍会平多（只是不反手开空）。
 */

/** @returns {{base:boolean, live:boolean}} */
export function shortEnvFlags(env = process.env) {
  return { base: String(env.RSI_ALLOW_SHORT ?? '0') === '1', live: String(env.RSI_ALLOW_SHORT_LIVE ?? '0') === '1' };
}

/** 第 1 层：仅环境变量。返回拦截原因或 null */
export function shortEnvBlockReason(execMode, env = process.env) {
  const f = shortEnvFlags(env);
  if (!f.base) return '服务端未开启做空（环境变量 RSI_ALLOW_SHORT 默认 0）';
  if (execMode === 'okx_live' && !f.live) return '实盘做空被禁止（需额外设置环境变量 RSI_ALLOW_SHORT_LIVE=1）';
  return null;
}

/**
 * 第 1+2 层：任一层关闭则拒绝。direction!=='short' 恒放行。
 * @returns {string|null} 拦截原因（中文）
 */
export function shortBlockReason({ direction, execMode = 'sim', tradeMode = 'swap', cfgAllowShort = true, env = process.env }) {
  if (direction !== 'short') return null;
  if (tradeMode !== 'swap') return '现货不支持做空（需永续 swap）';
  if (!cfgAllowShort) return '策略设置未允许做空';
  return shortEnvBlockReason(execMode, env);
}

/** 第 3 层：断言，被拦截则抛错（executor / 本地模拟开仓入口调用，不看 cfg，只看环境变量） */
export function assertShortAllowed(direction, execMode, env = process.env) {
  if (direction !== 'short') return;
  const r = shortEnvBlockReason(execMode, env);
  if (r) throw new Error(`拒绝做空开仓：${r}`);
}

export default { shortEnvFlags, shortEnvBlockReason, shortBlockReason, assertShortAllowed };
