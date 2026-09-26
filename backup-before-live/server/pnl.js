/**
 * 盈亏账本：记录平仓交易，汇总已实现 / 浮动盈亏
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const LEDGER_PATH = join(DATA_DIR, 'pnl-ledger.json');
const MAX_TRADES = 500;

/** @type {Array<object>} */
let trades = [];

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadLedger() {
  try {
    ensureDir();
    if (!existsSync(LEDGER_PATH)) {
      trades = [];
      return;
    }
    const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    trades = Array.isArray(raw?.trades) ? raw.trades : [];
  } catch {
    trades = [];
  }
}

function saveLedger() {
  try {
    ensureDir();
    writeFileSync(
      LEDGER_PATH,
      JSON.stringify({ updatedAt: new Date().toISOString(), trades }, null, 2),
      'utf8'
    );
  } catch {
    /* ignore disk errors */
  }
}

/**
 * @param {object} pos
 * @param {number} exitPrice
 * @param {'tp'|'sl'|'manual'|'kill'|'failsafe'|'liq'|'external'} action
 * @param {number} profitPct
 * @param {object} [extra] 真实成交数据（OKX 模拟盘）：
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
  trades.unshift(trade);
  if (trades.length > MAX_TRADES) trades.length = MAX_TRADES;
  saveLedger();
  return trade;
}

/** 今日（本地时区）已实现盈亏；execMode 为空则统计全部 */
export function todayRealized(execMode) {
  const day0 = startOfLocalDay();
  let sum = 0;
  for (const t of trades) {
    const closedAt = t.closed_at ? new Date(t.closed_at).getTime() : 0;
    if (closedAt < day0) continue;
    if (execMode && (t.exec_mode || 'sim') !== execMode) continue;
    sum += Number(t.pnl_usdt) || 0;
  }
  return sum;
}

export function clearTrades() {
  trades = [];
  saveLedger();
}

export function listTrades(limit = 50) {
  return trades.slice(0, Math.max(1, Math.min(200, limit)));
}

function startOfLocalDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/**
 * @param {Iterable<object>} openPositions
 */
export function buildPnLDashboard(openPositions = []) {
  const closed = trades;
  let realized = 0;
  let wins = 0;
  let losses = 0;
  let todayRealized = 0;
  const day0 = startOfLocalDay();

  for (const t of closed) {
    const pnl = Number(t.pnl_usdt) || 0;
    realized += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
    const closedAt = t.closed_at ? new Date(t.closed_at).getTime() : 0;
    if (closedAt >= day0) todayRealized += pnl;
  }

  let unrealized = 0;
  const openRows = [];
  for (const p of openPositions) {
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
    // OKX 模拟盘持仓优先使用交易所返回的未实现盈亏 upl
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
    realized_usdt: realized,
    unrealized_usdt: unrealized,
    total_usdt: realized + unrealized,
    today_realized_usdt: todayRealized,
    closed_trades: closedCount,
    open_positions: openRows.length,
    wins,
    losses,
    win_rate_pct: winRate,
    avg_win_usdt: avgWin,
    avg_loss_usdt: avgLoss,
    open: openRows,
    recent: listTrades(30),
    updatedAt: new Date().toISOString(),
  };
}

loadLedger();
