/**
 * 盈亏账本：记录平仓交易，汇总已实现 / 浮动盈亏
 * - 本地模拟（sim）与 OKX 模拟盘（okx_demo）：server/data/pnl-ledger.json（按 exec_mode 字段区分）
 * - OKX 实盘（okx_live）：单独存放 server/data/live/pnl-ledger.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { usedKeysFromTrades } from './closeMatch.js';
import { resolveDataDir } from './dataDir.js';
import { profitPct as calcProfitPct } from './engine/positionMath.js';
import { withStrategyDefaults, backupOnce } from './engine/normalize.js';

// 数据目录：RSI_DATA_DIR（新）优先，其次 RSI_BOTTOM_HUNTER_DATA_DIR（旧），否则 server/data
const DATA_DIR = resolveDataDir();
const LIVE_DIR = join(DATA_DIR, 'live');
const MAX_TRADES = 500;
const MAX_RISK_EVENTS = 10_000;
const RISK_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

/** @type {Record<'main'|'live', { path: string, trades: Array<object>, riskEvents: Array<object> }>} */
const LEDGERS = {
  main: { path: join(DATA_DIR, 'pnl-ledger.json'), trades: [], riskEvents: [] },
  live: { path: join(LIVE_DIR, 'pnl-ledger.json'), trades: [], riskEvents: [] },
};

export const EXEC_MODE_TEXT = { sim: '本地模拟', okx_demo: 'OKX 模拟盘', okx_live: 'OKX 实盘' };

function ledgerKey(execMode) {
  return execMode === 'okx_live' ? 'live' : 'main';
}

function ledgerFor(execMode) {
  return LEDGERS[ledgerKey(execMode)];
}

function loadOne(L) {
  try {
    if (!existsSync(L.path)) {
      L.trades = [];
      L.riskEvents = [];
      return;
    }
    const raw = JSON.parse(readFileSync(L.path, 'utf8'));
    // 旧账本升级：读时补 strategy_id=rsi_dip / direction=long（旧版只可能开多，side 已是 'long'）；首次写盘前备份 *.bak-pre-v2
    const rawTrades = Array.isArray(raw?.trades) ? raw.trades : [];
    L.needsBackup = rawTrades.some((t) => t && (t.strategy_id == null || t.direction == null));
    L.trades = rawTrades.map((t) => withStrategyDefaults(t));
    // 旧账本没有 riskEvents 时，用现存交易补建；之后清空展示历史不会再影响风控累计。
    L.riskEvents = Array.isArray(raw?.riskEvents)
      ? raw.riskEvents.map((e) => withStrategyDefaults(e))
      : L.trades.map((t) => ({
          strategy_id: t.strategy_id,
          direction: t.direction,
          id: t.id,
          exec_mode: t.exec_mode || 'sim',
          closed_at: t.closed_at,
          pnl_usdt: Number(t.pnl_usdt) || 0,
        }));
    pruneRiskEvents(L);
  } catch {
    L.trades = [];
    L.riskEvents = [];
  }
}

export function loadLedger() {
  loadOne(LEDGERS.main);
  loadOne(LEDGERS.live);
}

function saveOne(L) {
  try {
    if (L.needsBackup) {
      backupOnce(L.path); // 升级到 v2 前的一次性备份（不覆盖已有备份）
      L.needsBackup = false;
    }
    const dir = dirname(L.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${L.path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ updatedAt: new Date().toISOString(), trades: L.trades, riskEvents: L.riskEvents }, null, 2),
      'utf8'
    );
    renameSync(tmp, L.path);
  } catch {
    /* ignore disk errors */
  }
}

function pruneRiskEvents(L, now = Date.now()) {
  const cutoff = now - RISK_RETENTION_MS;
  L.riskEvents = (Array.isArray(L.riskEvents) ? L.riskEvents : [])
    .filter((e) => new Date(e?.closed_at || 0).getTime() >= cutoff)
    .slice(0, MAX_RISK_EVENTS);
}

/** 指定模式的交易（execMode 为空 = 全部账本） */
function tradesOf(execMode) {
  if (!execMode) return [...LEDGERS.main.trades, ...LEDGERS.live.trades].sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
  return ledgerFor(execMode).trades.filter((t) => (t.exec_mode || 'sim') === execMode);
}

function riskEventsOf(execMode) {
  if (!execMode) return [...LEDGERS.main.riskEvents, ...LEDGERS.live.riskEvents];
  return ledgerFor(execMode).riskEvents.filter((e) => (e.exec_mode || 'sim') === execMode);
}

/**
 * @param {object} pos 持仓（direction: long|short；strategy_id）
 * @param {number} exitPrice
 * @param {'tp'|'sl'|'flip'|'manual'|'kill'|'failsafe'|'liq'|'external'} action  flip=SuperTrend 信号反手/平仓
 * @param {number} profitPct 方向调整后的价格收益率 %（空头价格下跌为正）
 * @param {object} [extra] 真实成交数据（OKX 模拟盘/实盘）：
 *   { pnl_usdt 已实现盈亏(含手续费/资金费), fee_usdt, funding_fee_usdt, gross_pnl_usdt, estimated, inferred, contracts }
 */
export function recordClose(pos, exitPrice, action, profitPct, extra = {}) {
  const amount = Number(pos.amount) || 0;
  const leverage = Math.max(1, Number(pos.leverage) || 1);
  const entry = Number(pos.entry_price);
  const exit = Number(exitPrice);
  const pct = Number(profitPct);
  // 估算：现货 金额×涨跌%；永续 保证金×杠杆×涨跌%（下单单位 USDT）
  const estPnl =
    Number.isFinite(pct) && Number.isFinite(amount) ? (amount * leverage * pct) / 100 : 0;
  const exact = extra && Number.isFinite(Number(extra.pnl_usdt)) && extra.pnl_usdt !== null && extra.pnl_usdt !== undefined;
  const pnlUsdt = exact ? Number(extra.pnl_usdt) : estPnl;
  const execMode = pos.exec_mode || 'sim';
  const direction = pos.direction === 'short' ? 'short' : 'long';
  const trade = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${pos.instId}-${action}`,
    instId: pos.instId,
    action,
    side: direction, // 兼容旧字段：等于 direction（旧账本恒为 long）
    direction,
    strategy_id: pos.strategy_id || 'rsi_dip',
    strategy_version: pos.strategy_version ?? null,
    signal_meta: pos.signal_meta ?? null,
    sim_slippage_pct: Number.isFinite(Number(extra?.sim_slippage_pct)) ? Number(extra.sim_slippage_pct) : null,
    fee_open_usdt: Number.isFinite(Number(extra?.fee_open_usdt)) ? Number(extra.fee_open_usdt) : null,
    entry_price: entry,
    exit_price: exit,
    amount,
    leverage,
    profit_pct: pct,
    pnl_usdt: pnlUsdt,
    pnl_exact: !!exact && !extra.estimated && !extra.sim,
    fee_usdt: Number.isFinite(Number(extra?.fee_usdt)) ? Number(extra.fee_usdt) : null,
    funding_fee_usdt: Number.isFinite(Number(extra?.funding_fee_usdt)) ? Number(extra.funding_fee_usdt) : null,
    gross_pnl_usdt: Number.isFinite(Number(extra?.gross_pnl_usdt)) ? Number(extra.gross_pnl_usdt) : null,
    contracts: pos.contracts ?? null,
    inferred: !!extra?.inferred,
    exec_mode: execMode,
    opened_at: pos.at || null,
    closed_at: extra?.closed_at || new Date().toISOString(),
    profile: pos.profile || 'demo',
    mode: pos.mode || 'spot',
    simulated: execMode === 'sim' ? pos.simulated !== false : false,
    // 交易所模式：开仓订单号与所用平仓记录键（防止同一平仓记录被多个仓位重复使用）
    ordId: pos.ordId || null,
    close_key: extra?.close_key || null,
  };
  const L = ledgerFor(execMode);
  L.trades.unshift(trade);
  if (L.trades.length > MAX_TRADES) L.trades.length = MAX_TRADES;
  L.riskEvents.unshift({
    id: trade.id,
    strategy_id: trade.strategy_id,
    direction,
    exec_mode: execMode,
    closed_at: trade.closed_at,
    pnl_usdt: pnlUsdt,
  });
  pruneRiskEvents(L);
  saveOne(L);
  return trade;
}

/** 该模式账本里已被使用的交易所平仓记录键 */
export function usedCloseKeys(execMode) {
  return usedKeysFromTrades(tradesOf(execMode));
}

/** 今日（本地时区）已实现盈亏；execMode 为空则统计全部 */
export function todayRealized(execMode) {
  const day0 = startOfLocalDay();
  let sum = 0;
  for (const t of riskEventsOf(execMode)) {
    const closedAt = t.closed_at ? new Date(t.closed_at).getTime() : 0;
    if (closedAt < day0) continue;
    sum += Number(t.pnl_usdt) || 0;
  }
  return sum;
}

/** 清空账本：传 execMode 只清该模式的记录；不传则清空全部 */
export function clearTrades(execMode) {
  if (!execMode) {
    LEDGERS.main.trades = [];
    LEDGERS.live.trades = [];
    saveOne(LEDGERS.main);
    saveOne(LEDGERS.live);
    return;
  }
  const L = ledgerFor(execMode);
  L.trades = L.trades.filter((t) => (t.exec_mode || 'sim') !== execMode);
  saveOne(L);
}

export function listTrades(limit = 50, execMode) {
  return tradesOf(execMode).slice(0, Math.max(1, Math.min(200, limit)));
}

function startOfLocalDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/**
 * @param {Iterable<object>} openPositions
 * @param {string} [execMode] 只统计该执行模式（sim / okx_demo / okx_live）；为空统计全部
 */
export function buildPnLDashboard(openPositions = [], execMode) {
  const closed = tradesOf(execMode);
  let realized = 0;
  let wins = 0;
  let losses = 0;
  const todayRealizedSum = todayRealized(execMode);

  for (const t of closed) {
    const pnl = Number(t.pnl_usdt) || 0;
    realized += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
  }

  let unrealized = 0;
  const openRows = [];
  for (const p of openPositions) {
    if (execMode && (p.exec_mode || 'sim') !== execMode) continue;
    const amount = Number(p.amount) || 0;
    const leverage = Math.max(1, Number(p.leverage) || 1);
    const entry = Number(p.entry_price);
    const price = p.last_price != null ? Number(p.last_price) : entry;
    let pct =
      p.profit_pct != null
        ? Number(p.profit_pct)
        : entry > 0 && Number.isFinite(price)
          ? calcProfitPct(entry, price, p.direction === 'short' ? 'short' : 'long')
          : 0;
    if (!Number.isFinite(pct)) pct = 0;
    // OKX 模拟盘/实盘持仓优先使用交易所返回的未实现盈亏 upl
    const exchangeUpl = p.upl != null && Number.isFinite(Number(p.upl)) ? Number(p.upl) : null;
    const pnl = exchangeUpl != null ? exchangeUpl : (amount * leverage * pct) / 100;
    unrealized += pnl;
    openRows.push({
      instId: p.instId,
      direction: p.direction === 'short' ? 'short' : 'long',
      strategy_id: p.strategy_id || 'rsi_dip',
      amount,
      leverage,
      entry_price: entry,
      last_price: price,
      profit_pct: pct,
      pnl_usdt: pnl,
      pnl_exact: exchangeUpl != null,
      exec_mode: p.exec_mode || 'sim',
    });
  }

  const closedCount = closed.length;
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : null;
  const avgWin =
    wins > 0
      ? closed.filter((t) => (t.pnl_usdt || 0) > 0).reduce((s, t) => s + t.pnl_usdt, 0) / wins
      : 0;
  const avgLoss =
    losses > 0
      ? closed.filter((t) => (t.pnl_usdt || 0) < 0).reduce((s, t) => s + t.pnl_usdt, 0) / losses
      : 0;

  const group = (keyFn) => {
    const g = {};
    for (const t of closed) {
      const k = keyFn(t);
      const x = (g[k] ||= { trades: 0, wins: 0, losses: 0, realized_usdt: 0 });
      const pnl = Number(t.pnl_usdt) || 0;
      x.trades++;
      x.realized_usdt += pnl;
      if (pnl > 0) x.wins++;
      else if (pnl < 0) x.losses++;
    }
    for (const x of Object.values(g)) x.win_rate_pct = x.wins + x.losses > 0 ? (x.wins / (x.wins + x.losses)) * 100 : null;
    return g;
  };

  return {
    by_strategy: group((t) => t.strategy_id || 'rsi_dip'),
    by_direction: group((t) => (t.direction === 'short' ? 'short' : 'long')),
    exec_mode: execMode || null,
    exec_mode_text: execMode ? EXEC_MODE_TEXT[execMode] || execMode : '全部',
    is_live: execMode === 'okx_live',
    realized_usdt: realized,
    unrealized_usdt: unrealized,
    total_usdt: realized + unrealized,
    today_realized_usdt: todayRealizedSum,
    closed_trades: closedCount,
    open_positions: openRows.length,
    wins,
    losses,
    win_rate_pct: winRate,
    avg_win_usdt: avgWin,
    avg_loss_usdt: avgLoss,
    open: openRows,
    recent: closed.slice(0, 30),
    updatedAt: new Date().toISOString(),
  };
}

loadLedger();
