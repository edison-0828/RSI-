/**
 * 引擎 ↔ 策略 的适配（阶段 1）：把 CandleStore 快照构造成 EvalCtx，并把 Decision 映射回
 * 现网的信号行字段 / 下单前复核返回值。index.js 与差分测试共用同一份映射，保证测试覆盖的就是线上路径。
 */

const BAR_UNIT_MS = { m: 60_000, H: 3_600_000, D: 86_400_000, W: 604_800_000 };
/** '15m' → 900000；无法解析返回 0 */
export function barToMs(bar) {
  const m = /^(\d+)([mHDW])$/.exec(String(bar || ''));
  return m ? Number(m[1]) * BAR_UNIT_MS[m[2]] : 0;
}

/**
 * @param {{snap:object, forming:{ts:number,close:number}|null, price:number|null, closes:number[], bar?:string}} src
 * @param {object} params 策略已夹紧参数
 * @param {{phase:'scan'|'recheck', instId:string, tradable:boolean}} opt
 */
export function buildEvalCtx({ snap, forming, price, closes, bar }, params, { phase, instId, tradable }) {
  return {
    instId,
    phase,
    params,
    market: {
      price,
      bid: null,
      ask: null,
      closes,
      forming,
      bars: snap.bars,
      barMs: barToMs(bar),
      ind: { rsi: snap.rsi, rsiForming: snap.rsiForming },
    },
    flags: { tradable },
  };
}

/**
 * 由 CandleStore 构造 EvalCtx（index.js 的信号评估 / 下单前复核与差分测试共用，保证测试走的就是线上路径）
 * @param {object} store CandleStore
 * @param {string} instId
 * @param {object} params 策略已夹紧参数
 * @param {{phase:'scan'|'recheck', price:number|null, tradable:boolean}} opt price 为最终使用的价格
 * @returns {object|null} 无快照返回 null
 */
export function ctxFromStore(store, instId, params, { phase, price, tradable }) {
  const snap = store.snapshot(instId);
  if (!snap) return null;
  return buildEvalCtx(
    {
      snap,
      forming: store.get(instId)?.forming ?? null,
      price,
      // 仅布林带开启时才需要已收盘序列（关闭时 rsiDip 不读 closes，省掉每币每轮复制 200 个数）
      closes: params.bb_filter_enabled ? store.closes(instId) : [],
      bar: params.bar,
    },
    params,
    { phase, instId, tradable }
  );
}

/** Decision → 现网信号行里由策略决定的字段（signalText 为追加冷却文案之前的值） */
export function rowFieldsFromDecision(d) {
  return {
    rsi: d.metrics.rsi,
    rsiClosed: d.metrics.rsiClosed,
    signal: d.signal,
    signalText: d.text,
    bbLower: d.metrics.bbLower,
    bbBlocked: d.metrics.bbBlocked,
    bbReason: d.metrics.bbReason,
  };
}

/** Decision(phase='recheck') → 现网 recheckBuyCondition 在“有快照”之后的返回值 */
export function recheckResultFromDecision(d) {
  if (d.signal) return { ok: true, rsi: d.metrics.rsi, rsiClosed: d.metrics.rsiClosed };
  return { ok: false, rsi: d.metrics.rsi, rsiClosed: d.metrics.rsiClosed, reason: d.text };
}

export default { barToMs, buildEvalCtx, ctxFromStore, rowFieldsFromDecision, recheckResultFromDecision };
