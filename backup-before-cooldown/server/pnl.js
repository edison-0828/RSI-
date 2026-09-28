/**
 * 盈亏账本：记录平仓交易，汇总已实现 / 浮动盈亏
 * - 本地模拟（sim）与 OKX 模拟盘（okx_demo）：server/data/pnl-ledger.json（按 exec_mode 字段区分）
 * - OKX 实盘（okx_live）：单独存放 server/data/live/pnl-ledger.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const LIVE_DIR = join(DATA_DIR, 'live');
const MAX_TRADES = 500;

/** @type {Record<'main'|'live', { path: string, trades: Array<object> }>} */
const LEDGERS = {
  main: { path: join(DATA_DIR, 'pnl-ledger.json'), trades: [] },
  live: { path: join(LIVE_DIR, 'pnl-ledger.json'), trades: [] },
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
      return;
    }
    const raw = JSON.parse(readFileSync(L.path, 'utf8'));
    L.trades = Array.isArray(raw?.trades) ? raw.trades : [];
  } catch {
    L.trades = [];
  }
}

export function loadLedger() {
  loadOne(LEDGERS.main);
  loadOne(LEDGERS.live);
}

function saveOne(L) {
  try {
    const dir = dirname(L.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${L.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), trades: L.trades }, null, 2), 'utf8');
    renameSync(tmp, L.path);
  } catch {
    /* ignore disk errors */
  }
}

/** 指定模式的交易（execMode 为空 = 全部账本） */
function tradesOf(execMode) {
  if (!execMode) return [...LEDGERS.main.trades, ...LEDGERS.live.trades].sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
  return ledgerFor(execMode).trades.filter((t) => (t.exec_mode || 'sim') === execMode);
}

/**
 * @param {object} pos
 * @param {number} exitPrice
 * @param {'tp'|'sl'|'manual'|'kill'|'failsafe'|'liq'|'external'} action
 * @param {number} profitPct
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
  const trade = {
    id: `${Date.now()}-${pos.instId}-${action}`,
    instId: pos.instId,
    action,
    side: 'long',
    entry_price: entry,
    exit_price: exit,
    amount,
    leverage,
    profit_pct: pct,
    pnl_usdt: pnlUsdt,
    pnl_exact: !!exact && !extra.estimated,
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
  };
  const L = ledgerFor(execMode);
  L.trades.unshift(trade);
  if (L.trades.length > MAX_TRADES) L.trades.length = MAX_TRADES;
  saveOne(L);
  return trade;
}

/** 今日（本地时区）已实现盈亏；execMode 为空则统计全部 */
export function todayRealized(execMode) {
  const day0 = startOfLocalDay();
  let sum = 0;
  for (const t of tradesOf(execMode)) {
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
  let todayRealizedSum = 0;
  const day0 = startOfLocalDay();

  for (const t of closed) {
    const pnl = Number(t.pnl_usdt) || 0;
    realized += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
    const closedAt = t.closed_at ? new Date(t.closed_at).getTime() : 0;
    if (closedAt >= day0) todayRealizedSum += pnl;
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
          ? ((price - entry) / entry) * 100
          : 0;
    if (!Number.isFinite(pct)) pct = 0;
    // OKX 模拟盘/实盘持仓优先使用交易所返回的未实现盈亏 upl
    const exchangeUpl = p.upl != null && Number.isFinite(Number(p.upl)) ? Number(p.upl) : null;
    const pnl = exchangeUpl != null ? exchangeUpl : (amount * leverage * pct) / 100;
    unrealized += pnl;
    openRows.push({
      instId: p.instId,
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

  return {
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
