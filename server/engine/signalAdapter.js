/**
 * 引擎 ↔ 策略 的适配：把 CandleStore 快照构造成 EvalCtx（index.js 与测试共用，保证测试走的就是线上路径）
 */
import { barToMs } from './bars.js';

export { barToMs };

/**
 * @param {object} store CandleStore
 * @param {string} instId
 * @param {object} params 策略已夹紧参数
 * @param {{phase:'scan'|'recheck', price:number|null, tradable:boolean, heldDirection?:'long'|'short'|null}} opt price 为最终使用的价格
 * @returns {object|null} 无快照返回 null
 */
export function ctxFromStore(store, instId, params, { phase, price, tradable, heldDirection = null }) {
  const snap = store.snapshot(instId);
  if (!snap) return null;
  return {
    instId,
    phase,
    params,
    market: {
      price,
      bid: null,
      ask: null,
      bars: snap.bars,
      barMs: store.barMs,
      lastBarTs: snap.lastTs,
      closedBars: snap.closedBars,
    },
    flags: { tradable, heldDirection },
  };
}

export default { ctxFromStore, barToMs };
