/**
 * 策略：RSI 抄底（含可选布林带下轨过滤、可选收盘确认）
 *
 * 严格对应改造前 server/index.js 的现网语句（逐行对应，行为一字不差）：
 * - isValidRsi / buySignalFromRsi  ← index.js L1319-1336（原样搬入，仅把 cfg 换成 params）
 * - 实时 RSI 取值                  ← evaluateSignals L1384-1385
 * - 布林带下轨过滤                 ← evaluateSignals L1395-1397，直接调用 bbFilter.js（本文件不改它）
 * - signal 合成与 5 种状态文案     ← evaluateSignals L1399-1413（文案逐字保留）
 * - 下单前复核失败文案             ← recheckBuyCondition L1347-1363
 *
 * 纯函数：不读时钟 / 随机数 / 网络 / 全局变量，不修改入参，不写日志。
 * 日志（如布林带挡单的节流日志）与冷却文案追加由引擎负责。
 */
import { applyBbFilter, clampBbCfg, BB_DEFAULTS } from '../bbFilter.js';
import { calcRsi, calcFormingRsi } from '../rsi.js';

/** 与 DEFAULT_SCAN / clampConfig 里的默认值一致 */
export const RSI_DIP_DEFAULTS = Object.freeze({
  bar: '15m',
  rsi_period: 6,
  rsi_buy_threshold: 20,
  take_profit_pct: 8,
  stop_loss_pct: 6,
  confirm_on_close: false,
  bb_filter_enabled: BB_DEFAULTS.bb_filter_enabled,
  bb_period: BB_DEFAULTS.bb_period,
  bb_mult: BB_DEFAULTS.bb_mult,
});

function isValidRsi(v) {
  return v != null && Number.isFinite(v) && v > 0;
}

/**
 * 买入判定：实时 RSI（含未收盘）必须 < 阈值；confirm_on_close 时已收盘 RSI 也须 < 阈值
 * @returns {{signal:boolean, waitingClose:boolean}}
 */
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

/** 参数夹紧：与 index.js clampConfig 对这些字段的处理逐项一致（幂等；旧配置缺字段 → 默认值） */
function clamp(raw = {}) {
  const r = raw || {};
  return {
    bar: r.bar || RSI_DIP_DEFAULTS.bar,
    rsi_period: Math.max(2, Number(r.rsi_period) || RSI_DIP_DEFAULTS.rsi_period),
    rsi_buy_threshold: Number(r.rsi_buy_threshold) || RSI_DIP_DEFAULTS.rsi_buy_threshold,
    take_profit_pct: Number(r.take_profit_pct) || RSI_DIP_DEFAULTS.take_profit_pct,
    stop_loss_pct: Number(r.stop_loss_pct) || RSI_DIP_DEFAULTS.stop_loss_pct,
    confirm_on_close: r.confirm_on_close === true || r.confirm_on_close === 'true' || r.confirm_on_close === 1,
    ...clampBbCfg(r), // bb_filter_enabled / bb_period / bb_mult
  };
}

/**
 * @param {import('./contract.js').EvalCtx} ctx
 * @returns {import('./contract.js').Decision}
 */
function evaluate(ctx) {
  const p = ctx.params;
  const m = ctx.market || {};
  const closes = m.closes || [];
  const forming = m.forming || null;
  const notOnDemo = ctx.flags?.tradable === false; // 环境属性（现网 notOnDemo）：该币在当前环境不可交易

  // 实时 RSI（含未收盘 K 线）与已收盘 RSI：优先用引擎预计算（CandleStore），缺失时现算（数值一致）
  const ind = m.ind || null;
  const rsiClosed = ind && 'rsi' in ind ? ind.rsi : calcRsi(closes, p.rsi_period);
  const rsiFormingVal = ind && 'rsiForming' in ind ? ind.rsiForming : calcFormingRsi(closes, forming?.close ?? null, p.rsi_period);
  const rsiShow = forming && rsiFormingVal != null ? rsiFormingVal : rsiClosed;
  const rsiValid = isValidRsi(rsiShow);

  const sig = buySignalFromRsi(rsiShow, rsiClosed, p);
  const price = m.price ?? null;
  // 布林带下轨过滤（开关关闭时 bb === null，行为不变）：只在 RSI 已触发之后判断
  const bb = p.bb_filter_enabled ? applyBbFilter(sig.signal && !notOnDemo, { closes, price }, p) : null;
  const signal = sig.signal && !notOnDemo && (!bb || bb.signal);

  let text;
  if (ctx.phase === 'recheck' && !signal) {
    // 下单前复核失败：文案沿用现网 recheckBuyCondition
    const f = (v) => (isValidRsi(v) ? v.toFixed(2) : '无效');
    if (!sig.signal) {
      text = `实时RSI=${f(rsiShow)} 收盘RSI=${f(rsiClosed)}，已不满足 RSI<${p.rsi_buy_threshold}${p.confirm_on_close ? '（需收盘确认）' : ''}`;
    } else if (bb?.blocked) {
      text = bb.reason;
    } else {
      text = '模拟盘无此合约'; // 仅 tradable=false 时可达（现网复核恒为 tradable=true，走不到这里）
    }
  } else if (notOnDemo) text = '模拟盘无此合约';
  else if (!rsiValid) text = 'RSI 无效（K 线不足或无数据）';
  else if (bb?.blocked) text = `RSI 已触发，${bb.reason}`;
  else if (signal) {
    text = p.confirm_on_close
      ? '实时与收盘 RSI 均低于阈值（收盘确认），触发买入！'
      : forming
        ? '实时 RSI 进入超卖区（含未收盘），触发买入！'
        : 'RSI 进入超卖区，触发买入！';
  } else if (sig.waitingClose) text = '实时 RSI 低于阈值，等待收盘确认';
  else text = '未触发';

  return {
    direction: signal ? 'long' : null,
    signal,
    text,
    blocked: bb?.blocked ? { kind: bb.kind, reason: bb.reason } : null,
    tpPct: p.take_profit_pct,
    slPct: p.stop_loss_pct,
    metrics: {
      rsi: rsiShow,
      rsiClosed,
      forming: !!forming,
      bbLower: bb?.lower ?? null,
      bbBlocked: !!bb?.blocked,
      bbReason: bb?.blocked ? bb.reason : null,
    },
    meta: { rsi_at_entry: rsiShow, rsi_closed_at_entry: rsiClosed ?? null },
    waitingClose: sig.waitingClose,
  };
}

/** @type {import('./contract.js').Strategy} */
const rsiDip = {
  id: 'rsi_dip',
  name: 'RSI 抄底',
  version: 1,
  directions: ['long'],
  params: [
    { key: 'rsi_period', label: 'RSI 周期', type: 'number', default: RSI_DIP_DEFAULTS.rsi_period, min: 2 },
    { key: 'rsi_buy_threshold', label: '买入阈值', type: 'number', default: RSI_DIP_DEFAULTS.rsi_buy_threshold },
    { key: 'confirm_on_close', label: '需收盘确认', type: 'boolean', default: RSI_DIP_DEFAULTS.confirm_on_close },
    { key: 'bb_filter_enabled', label: '布林带下轨过滤', type: 'boolean', default: RSI_DIP_DEFAULTS.bb_filter_enabled },
    { key: 'bb_period', label: '布林周期', type: 'number', default: RSI_DIP_DEFAULTS.bb_period, advanced: true },
    { key: 'bb_mult', label: '布林倍数', type: 'number', default: RSI_DIP_DEFAULTS.bb_mult, advanced: true },
    { key: 'take_profit_pct', label: '止盈 %', type: 'number', default: RSI_DIP_DEFAULTS.take_profit_pct },
    { key: 'stop_loss_pct', label: '止损 %', type: 'number', default: RSI_DIP_DEFAULTS.stop_loss_pct },
    { key: 'bar', label: 'K 线周期', type: 'string', default: RSI_DIP_DEFAULTS.bar },
  ],
  presets: [],
  clamp,
  needs: (p) => ({ bar: p.bar, closedBars: Math.max(p.rsi_period + 1, p.bb_filter_enabled ? p.bb_period - 1 : 0) }),
  evaluate,
};

export { isValidRsi, buySignalFromRsi };
export default rsiDip;
