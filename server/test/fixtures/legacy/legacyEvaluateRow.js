/**
 * 冻结的“旧逻辑”对照夹具（只读，不要再修改）
 * 来源：分支基线 4b80682 的 server/index.js 中 buySignalFromRsi / recheckBuyCondition /
 * evaluateSignals（单币判定部分）的逐字拷贝，仅把依赖的 cfg / 快照改成显式参数。
 * 差分测试用它与新的 strategies/rsiDip.js 比对，证明 RSI 抄底行为不变。
 */
import { applyBbFilter } from '../../../bbFilter.js';

function isValidRsi(v) {
  return v != null && Number.isFinite(v) && v > 0;
}

function buySignalFromRsi(rsiRealtime, rsiClosed, cfg) {
  const threshold = Number(cfg.rsi_buy_threshold);
  const rtOk = isValidRsi(rsiRealtime) && rsiRealtime < threshold;
  if (!rtOk) return { signal: false, waitingClose: false };
  if (cfg.confirm_on_close) {
    const closedOk = isValidRsi(rsiClosed) && rsiClosed < threshold;
    return { signal: closedOk, waitingClose: !closedOk };
  }
  return { signal: true, waitingClose: false };
}

/**
 * 旧 evaluateSignals 单币判定（不含冷却文案追加、不含日志）
 * @param {{snap:object, price:number|null, closes:number[], notOnDemo:boolean}} input price 为已合并 uni.price 的最终价
 */
export function legacyEvaluateRow({ snap, price, closes, notOnDemo }, cfg) {
  const rsiClosed = snap.rsi;
  const rsiShow = snap.forming && snap.rsiForming != null ? snap.rsiForming : rsiClosed;
  const rsiValid = isValidRsi(rsiShow);
  const sig = buySignalFromRsi(rsiShow, rsiClosed, cfg);
  const bb = cfg.bb_filter_enabled ? applyBbFilter(sig.signal && !notOnDemo, { closes, price }, cfg) : null;
  const signal = sig.signal && !notOnDemo && (!bb || bb.signal);
  let signalText;
  if (notOnDemo) signalText = '模拟盘无此合约';
  else if (!rsiValid) signalText = 'RSI 无效（K 线不足或无数据）';
  else if (bb?.blocked) {
    signalText = `RSI 已触发，${bb.reason}`;
  } else if (signal) {
    signalText = cfg.confirm_on_close
      ? '实时与收盘 RSI 均低于阈值（收盘确认），触发买入！'
      : snap.forming
        ? '实时 RSI 进入超卖区（含未收盘），触发买入！'
        : 'RSI 进入超卖区，触发买入！';
  } else if (sig.waitingClose) signalText = '实时 RSI 低于阈值，等待收盘确认';
  else signalText = '未触发';
  return {
    rsi: rsiShow,
    rsiClosed,
    signal,
    signalText,
    bbLower: bb?.lower ?? null,
    bbBlocked: !!bb?.blocked,
    bbReason: bb?.blocked ? bb.reason : null,
    bbKind: bb?.blocked ? bb.kind : null,
  };
}

/** 旧 recheckBuyCondition 在“已有快照”之后的部分 */
export function legacyRecheck({ snap, closes }, cfg) {
  const rsiClosed = snap.rsi;
  const rsiRt = snap.forming && snap.rsiForming != null ? snap.rsiForming : rsiClosed;
  const sig = buySignalFromRsi(rsiRt, rsiClosed, cfg);
  const f = (v) => (isValidRsi(v) ? v.toFixed(2) : '无效');
  if (!sig.signal) {
    return {
      ok: false,
      rsi: rsiRt,
      rsiClosed,
      reason: `实时RSI=${f(rsiRt)} 收盘RSI=${f(rsiClosed)}，已不满足 RSI<${cfg.rsi_buy_threshold}${cfg.confirm_on_close ? '（需收盘确认）' : ''}`,
    };
  }
  if (cfg.bb_filter_enabled) {
    const bb = applyBbFilter(true, { closes, price: snap.price }, cfg);
    if (!bb.signal) return { ok: false, rsi: rsiRt, rsiClosed, reason: bb.reason };
  }
  return { ok: true, rsi: rsiRt, rsiClosed };
}

export default { legacyEvaluateRow, legacyRecheck };
