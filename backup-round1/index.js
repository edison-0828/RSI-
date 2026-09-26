/**
 * RSI抄底宝 — 全市场扫描后端
 * Universe（CLI filter/tickers）→ REST/CLI K 线 bootstrap → 本地 Wilder RSI
 * → OKX WebSocket 实时 K 线 + tickers 驱动更新（不再轮询 market indicator rsi）
 */
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { calcRsi } from './rsi.js';
import { CandleStore } from './candleStore.js';
import { recordClose, clearTrades, buildPnLDashboard, listTrades, todayRealized } from './pnl.js';
import { OkxWsManager, barToCandleChannel } from './okxWs.js';
import { loadEnvLocal } from './env.js';
import { OkxDemoExecutor, demoKeysConfigured, reasonText } from './executor.js';

// 启动时加载 server/.env.local（仅 OKX_DEMO_* 模拟盘凭证；绝不打印值）
const envLoad = loadEnvLocal();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const MAX_LOG = 300;
const OKX_REST = 'https://www.okx.com';
const CANDLE_BOOTSTRAP_LIMIT = 100;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/** @type {Array<{ts:string,level:string,msg:string}>} */
const eventLog = [];

const DATA_DIR = join(__dirname, 'data');
const STATE_PATH = join(DATA_DIR, 'positions.json');
const RECONCILE_MS = 20000;

function pushLog(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.length = MAX_LOG;
  return entry;
}

/** Resolve okx binary: prefer local `okx`, else npx (Windows-safe) */
function resolveOkxCmd() {
  const isWin = process.platform === 'win32';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'okx', 'bin', 'okx.exe'),
    join(home, '.okx', 'bin', 'okx.exe'),
    join(home, '.okx', 'bin', 'okx'),
    '/usr/local/bin/okx',
    '/usr/bin/okx',
    join(home, '.npm-global', 'bin', 'okx'),
    join(home, '.local', 'bin', 'okx'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return { cmd: p, argsPrefix: [], shell: false };
  }
  const nodeDir = dirname(process.execPath);
  const npxLocal = isWin ? join(nodeDir, 'npx.cmd') : join(nodeDir, 'npx');
  const npxCmd = existsSync(npxLocal) ? npxLocal : (isWin ? 'npx.cmd' : 'npx');
  return {
    cmd: npxCmd,
    argsPrefix: ['--yes', '@okx_ai/okx-trade-cli@latest'],
    shell: isWin,
  };
}

function runOkx(args, { timeoutMs = 60000 } = {}) {
  const { cmd, argsPrefix, shell } = resolveOkxCmd();
  const fullArgs = [...argsPrefix, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, fullArgs, {
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: Boolean(shell),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`okx 命令超时 (${timeoutMs}ms): ${fullArgs.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errMsg = (stderr || stdout || `exit ${code}`).trim().slice(0, 800);
        reject(new Error(errMsg || `okx exited ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runOkxJson(args, opts) {
  const { stdout } = await runOkx([...args, '--json'], opts);
  const text = stdout.trim();
  const start = text.indexOf('[') >= 0 && (text.indexOf('{') < 0 || text.indexOf('[') < text.indexOf('{'))
    ? text.indexOf('[')
    : text.indexOf('{');
  if (start < 0) throw new Error(`无法解析 JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

function parseTicker(payload) {
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row) return null;
  return {
    last: Number(row.last),
    askPx: Number(row.askPx),
    bidPx: Number(row.bidPx),
    open24h: Number(row.open24h),
    high24h: Number(row.high24h),
    low24h: Number(row.low24h),
    vol24h: Number(row.vol24h),
    ts: row.ts,
    instId: row.instId,
  };
}

function normalizeInstId(instId, mode) {
  let id = String(instId || '').trim().toUpperCase();
  if (!id) return id;
  if (mode === 'swap' && !id.endsWith('-SWAP')) id = `${id}-SWAP`;
  if (mode === 'spot' && id.endsWith('-SWAP')) id = id.replace(/-SWAP$/, '');
  return id;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, retries = 2, delayMs = 400) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

/** Simple concurrency pool */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e.message || String(e) };
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => runner()));
  return results;
}

// ---------- Defaults ----------
const DEFAULT_SCAN = {
  mode: 'spot',
  profile: 'demo',
  bar: '15m',
  rsi_period: 6,
  rsi_buy_threshold: 20,
  take_profit_pct: 8,
  stop_loss_pct: 6,
  max_positions: 5,
  amount: 100,
  // 执行方式：sim=本地模拟（默认）；okx_demo=OKX 模拟盘真实下单（仅永续）
  exec_mode: 'sim',
  // 风控（服务端强制）
  daily_loss_limit_usdt: 50,
  max_orders_per_hour: 10,
  max_spread_pct: 0.3,
  // 永续专用（现货忽略）：固定多头 + 全仓 + USDT 下单，杠杆可选
  leverage: 1,
  tdMode: 'cross',
  posSide: 'long',
  order_ccy: 'USDT',
  minVolUsd24h: 300_000,
  universeLimit: 120,
  scanConcurrency: 6,
  refreshSec: 60,
  max_consecutive_sl: 2,
  sl_filter_hours: 24,
  watchlist: [],
};

function clampConfig(body = {}) {
  const cfg = { ...DEFAULT_SCAN, ...body };
  cfg.mode = cfg.mode === 'swap' ? 'swap' : 'spot';
  cfg.profile = cfg.profile === 'live' ? 'live' : 'demo';
  cfg.bar = cfg.bar || '15m';
  cfg.rsi_period = Math.max(2, Number(cfg.rsi_period) || 6);
  cfg.rsi_buy_threshold = Number(cfg.rsi_buy_threshold) || 20;
  cfg.take_profit_pct = Number(cfg.take_profit_pct) || 8;
  cfg.stop_loss_pct = Number(cfg.stop_loss_pct) || 6;
  cfg.max_positions = Math.max(1, Math.min(20, Number(cfg.max_positions) || 5));
  cfg.amount = Math.max(1, Number(cfg.amount) || 100);
  cfg.leverage = Math.max(1, Math.min(20, Math.round(Number(cfg.leverage) || 1)));
  cfg.tdMode = 'cross'; // 全仓（固定）
  cfg.posSide = 'long'; // 多头（固定）
  cfg.order_ccy = 'USDT'; // 下单单位 USDT（固定）
  cfg.minVolUsd24h = Math.max(0, Number(cfg.minVolUsd24h) || 300_000);
  cfg.universeLimit = Math.max(1, Math.min(200, Number(cfg.universeLimit) || 120));
  cfg.scanConcurrency = Math.max(1, Math.min(12, Number(cfg.scanConcurrency) || 6));
  // 信号评估间隔：WS 推送行情后，前端/后端评估节奏（可短）
  cfg.refreshSec = Math.max(2, Number(cfg.refreshSec) || Number(cfg.poll_interval_sec) || 60);
  cfg.max_consecutive_sl = Math.max(1, Math.min(20, Number(cfg.max_consecutive_sl) || 2));
  cfg.sl_filter_hours = Math.max(0, Math.min(24 * 30, Number(cfg.sl_filter_hours) ?? 24));
  cfg.exec_mode = cfg.exec_mode === 'okx_demo' ? 'okx_demo' : 'sim';
  {
    const dl = Number(cfg.daily_loss_limit_usdt);
    cfg.daily_loss_limit_usdt = Number.isFinite(dl) && dl >= 0 ? Math.min(dl, 1e9) : 50;
    const mo = Number(cfg.max_orders_per_hour);
    cfg.max_orders_per_hour = Number.isFinite(mo) && mo >= 1 ? Math.min(Math.round(mo), 1000) : 10;
    const sp = Number(cfg.max_spread_pct);
    cfg.max_spread_pct = Number.isFinite(sp) && sp > 0 ? Math.min(sp, 20) : 0.3;
  }
  cfg.watchlist = Array.isArray(cfg.watchlist)
    ? cfg.watchlist.map((x) => normalizeInstId(x, cfg.mode)).filter(Boolean)
    : (cfg.instId ? [normalizeInstId(cfg.instId, cfg.mode)] : []);
  return cfg;
}

// ---------- Scan state ----------
/** @type {Map<string, object>} */
const positions = new Map();
/** 连续止损计数与过滤：instId -> { streak, filteredUntil, reason, updatedAt } */
const slGuard = new Map();
/** @type {Array<object>} */
let lastSignals = [];
/** @type {Array<object>} */
let lastUniverse = [];
/** @type {null | object} */
let scanState = null;
let scanTimer = null;
let scanBusy = false;
let feedMode = 'websocket'; // 'websocket' | 'polling-legacy'

const candleStore = new CandleStore({ maxBars: 200, period: 14 });
const wsManager = new OkxWsManager({ log: pushLog, maxArgsPerConn: 50 });
let evalDebounceTimer = null;

// ---------- OKX 模拟盘执行 / 风控 / 持久化 ----------
const executor = new OkxDemoExecutor({ log: pushLog });
/** WS 盘口：instId -> { bidPx, askPx, ts } */
const tickerBook = new Map();
/** 正在开仓中的 instId（异步下单期间占位，防止重复开仓/超出持仓上限） */
const pendingOpens = new Set();
/** 交易所上非本程序开的仓位（仅展示，不管理） */
let externalPositions = [];
const riskState = {
  killSwitch: { on: false, at: null, reason: null },
  /** 开仓下单时间戳（毫秒），用于每小时下单上限 */
  orderTimes: [],
};
const reconcileState = { busy: false, lastAt: null, error: null, startupDone: false };
const throttleMap = new Map();

function logThrottled(key, level, msg, ms = 5 * 60 * 1000) {
  const last = throttleMap.get(key) || 0;
  if (Date.now() - last < ms) return;
  throttleMap.set(key, Date.now());
  pushLog(level, msg);
}

function effectiveCfg() {
  return scanState?.config || DEFAULT_SCAN;
}

function ordersLastHour() {
  const cut = Date.now() - 3600 * 1000;
  riskState.orderTimes = riskState.orderTimes.filter((t) => t > cut);
  return riskState.orderTimes.length;
}

function recordOrderTime() {
  riskState.orderTimes.push(Date.now());
  ordersLastHour();
  saveState();
}

function riskSnapshot(cfg = effectiveCfg()) {
  const execMode = cfg.exec_mode || 'sim';
  const today = todayRealized(execMode);
  const limit = Number(cfg.daily_loss_limit_usdt) || 0;
  return {
    exec_mode: execMode,
    today_realized_usdt: today,
    daily_loss_limit_usdt: limit,
    daily_loss_hit: limit > 0 && today <= -limit,
    orders_last_hour: ordersLastHour(),
    max_orders_per_hour: cfg.max_orders_per_hour,
    max_spread_pct: cfg.max_spread_pct,
    kill_switch: { ...riskState.killSwitch },
    pending_opens: [...pendingOpens],
  };
}

function saveState() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      positions: [...positions.values()],
      killSwitch: riskState.killSwitch,
      orderTimes: riskState.orderTimes,
    };
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, STATE_PATH);
  } catch (e) {
    logThrottled('save-state', 'warn', `持仓持久化失败：${e.message}`, 60000);
  }
}

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return;
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    const list = Array.isArray(raw?.positions) ? raw.positions : [];
    for (const p of list) {
      if (p && p.instId) positions.set(p.instId, p);
    }
    if (raw?.killSwitch && typeof raw.killSwitch === 'object') {
      riskState.killSwitch = { on: !!raw.killSwitch.on, at: raw.killSwitch.at || null, reason: raw.killSwitch.reason || null };
    }
    if (Array.isArray(raw?.orderTimes)) riskState.orderTimes = raw.orderTimes.filter((t) => Number.isFinite(t));
    const demo = list.filter((p) => p.exec_mode === 'okx_demo').length;
    if (list.length) {
      pushLog('info', `已从 server/data/positions.json 恢复持仓 ${list.length} 个（本地模拟 ${list.length - demo} · OKX 模拟盘 ${demo}）`);
    }
    if (riskState.killSwitch.on) pushLog('warn', '急停状态已恢复：当前禁止开新仓（可在界面「解除急停」）');
  } catch (e) {
    pushLog('warn', `读取持仓文件失败：${e.message}`);
  }
}

function demoPositions() {
  return [...positions.values()].filter((p) => p.exec_mode === 'okx_demo');
}

function execPublic(cfg = effectiveCfg()) {
  return {
    exec_mode: cfg.exec_mode || 'sim',
    exec_mode_text: cfg.exec_mode === 'okx_demo' ? 'OKX 模拟盘' : '本地模拟',
    keysConfigured: demoKeysConfigured(),
    account: executor.accountSummary(),
    posMode: executor.posMode,
    risk: riskSnapshot(cfg),
    reconcile: { lastAt: reconcileState.lastAt, error: reconcileState.error },
    liveAutoTradeDisabled: true,
  };
}

function wsPublicStatus() {
  const s = wsManager.status();
  return {
    connected: !!s.connected,
    reconnecting: !!s.reconnecting,
    candleSubs: s.candleSubs || 0,
    tickerSubs: s.tickerSubs || 0,
    lastMsgAt: s.lastMsgAt,
    connCount: s.connCount || 0,
    aliveCount: s.aliveCount || 0,
  };
}

function publicScan() {
  if (!scanState) {
    return {
      running: false,
      config: null,
      lastScanAt: null,
      round: 0,
      universeSize: 0,
      signalCount: 0,
      positionCount: 0,
      scanning: false,
      liveAutoTradeDisabled: true,
      note: null,
      feed: feedMode,
      ws: wsPublicStatus(),
      filteredCount: 0,
      exec_mode: 'sim',
      killSwitch: riskState.killSwitch.on,
    };
  }
  return {
    running: !!scanState.running,
    config: scanState.config,
    lastScanAt: scanState.lastScanAt,
    round: scanState.round || 0,
    universeSize: lastUniverse.length,
    signalCount: lastSignals.filter((s) => s.signal).length,
    positionCount: positions.size,
    filteredCount: listFilteredCoins(scanState.config).length,
    scanning: scanBusy,
    error: scanState.error || null,
    startedAt: scanState.startedAt,
    liveAutoTradeDisabled: true,
    feed: feedMode,
    ws: wsPublicStatus(),
    exec_mode: scanState.config?.exec_mode || 'sim',
    killSwitch: riskState.killSwitch.on,
    note: scanNote(scanState.config),
  };
}

function scanNote(cfg) {
  if (!cfg) return null;
  if (cfg.exec_mode === 'okx_demo') {
    return 'OKX 模拟盘真实下单（x-simulated-trading: 1）· 交易所端 OCO 止盈止损 · 行情源 WebSocket';
  }
  return cfg.profile === 'live'
    ? '实盘自动下单未启用（仅模拟/预览）· 行情源 WebSocket'
    : 'demo 本地模拟成交 · 行情源 WebSocket';
}

function parseFilterRows(payload) {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const rows = root?.rows || (Array.isArray(payload) ? payload : []);
  return Array.isArray(rows) ? rows : [];
}

function isUsdtSpot(instId) {
  return instId.endsWith('-USDT') && !instId.includes('-SWAP') && !instId.includes('-USDT-');
}

function isUsdtSwap(instId) {
  return instId.endsWith('-USDT-SWAP');
}

const STABLE_BASES = new Set([
  'USDT', 'USDC', 'USD', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'USDD', 'PYUSD', 'EURC',
  'BUSD', 'USDP', 'GUSD', 'FRAX', 'LUSD', 'SUSD', 'USD1', 'USDG', 'EUR', 'EUROC',
  'AGEUR', 'EURS', 'USDJ', 'USTC', 'USDY', 'RLUSD',
]);

function baseCcyFromInstId(instId) {
  return String(instId || '').toUpperCase().split('-')[0] || '';
}

function isStablecoinInst(instId) {
  return STABLE_BASES.has(baseCcyFromInstId(instId));
}

function rowsFromTickersPayload(payload) {
  if (Array.isArray(payload) && payload[0]?.data) return payload[0].data;
  if (Array.isArray(payload) && payload[0]?.instId) return payload;
  if (payload?.data) return payload.data;
  return [];
}

async function fetchUniverseFromTickers(cfg) {
  const instType = cfg.mode === 'swap' ? 'SWAP' : 'SPOT';
  const raw = await withRetry(
    () => runOkxJson(['market', 'tickers', instType], { timeoutMs: 90000 }),
    1
  );
  const rows = rowsFromTickersPayload(raw);
  const mapped = [];
  for (const r of rows) {
    const instId = String(r.instId || '').toUpperCase();
    if (!instId) continue;
    if (cfg.mode === 'swap') {
      if (!isUsdtSwap(instId)) continue;
    } else if (!isUsdtSpot(instId)) {
      continue;
    }
    if (isStablecoinInst(instId)) continue;
    const volUsd24h = Number(r.volCcy24h ?? r.volUsd24h ?? 0);
    if (!(volUsd24h >= cfg.minVolUsd24h)) continue;
    const last = Number(r.last);
    const open24h = Number(r.open24h);
    let chg24hPct = null;
    if (Number.isFinite(last) && Number.isFinite(open24h) && open24h > 0) {
      chg24hPct = ((last - open24h) / open24h) * 100;
    }
    mapped.push({
      instId,
      volUsd24h: Number.isFinite(volUsd24h) ? volUsd24h : 0,
      price: Number.isFinite(last) ? last : null,
      chg24hPct,
      instType: r.instType || instType,
      source: 'tickers',
    });
  }
  mapped.sort((a, b) => (b.volUsd24h || 0) - (a.volUsd24h || 0));
  return mapped.slice(0, cfg.universeLimit);
}

async function fetchUniverse(cfg) {
  const limit = cfg.universeLimit;
  const minVol = cfg.minVolUsd24h;
  const args =
    cfg.mode === 'swap'
      ? [
          'market', 'filter',
          '--instType', 'SWAP',
          '--settleCcy', 'USDT',
          '--quoteCcy', 'USDT',
          '--sortBy', 'volUsd24h',
          '--sortOrder', 'desc',
          '--limit', String(limit),
          '--minVolUsd24h', String(minVol),
        ]
      : [
          'market', 'filter',
          '--instType', 'SPOT',
          '--quoteCcy', 'USDT',
          '--sortBy', 'volUsd24h',
          '--sortOrder', 'desc',
          '--limit', String(limit),
          '--minVolUsd24h', String(minVol),
        ];

  let rows = [];
  try {
    const raw = await withRetry(() => runOkxJson(args, { timeoutMs: 90000 }), 1);
    rows = parseFilterRows(raw);
  } catch (e) {
    if (cfg.mode === 'swap') {
      try {
        const fallback = [
          'market', 'filter',
          '--instType', 'SWAP',
          '--quoteCcy', 'USDT',
          '--sortBy', 'volUsd24h',
          '--sortOrder', 'desc',
          '--limit', String(limit),
          '--minVolUsd24h', String(minVol),
        ];
        const raw = await withRetry(() => runOkxJson(fallback, { timeoutMs: 90000 }), 1);
        rows = parseFilterRows(raw);
      } catch {
        rows = [];
      }
    } else {
      rows = [];
    }
  }

  /** @type {Map<string, object>} */
  const map = new Map();
  for (const r of rows) {
    let instId = String(r.instId || '').toUpperCase();
    if (!instId) continue;
    if (cfg.mode === 'swap') {
      if (!isUsdtSwap(instId)) continue;
    } else if (!isUsdtSpot(instId)) {
      continue;
    }
    if (isStablecoinInst(instId)) continue;
    const volUsd24h = Number(r.volUsd24h ?? r.volCcy24h ?? r.sortVal ?? 0);
    const last = Number(r.last);
    map.set(instId, {
      instId,
      volUsd24h: Number.isFinite(volUsd24h) ? volUsd24h : 0,
      price: Number.isFinite(last) ? last : null,
      chg24hPct: r.chg24hPct != null ? Number(r.chg24hPct) : null,
      instType: r.instType || (cfg.mode === 'swap' ? 'SWAP' : 'SPOT'),
      source: 'filter',
    });
  }

  for (const id of [...map.keys()]) {
    if (isStablecoinInst(id)) map.delete(id);
  }

  if (map.size === 0 || map.size < limit) {
    pushLog(
      map.size === 0 ? 'warn' : 'info',
      map.size === 0
        ? 'market filter 无结果，改用 tickers 按成交量本地筛选（已排除稳定币）'
        : `filter 仅 ${map.size} 个，用 tickers 补足至 ${limit}（已排除稳定币）`
    );
    const fb = await fetchUniverseFromTickers(cfg);
    for (const item of fb) {
      if (isStablecoinInst(item.instId)) continue;
      if (!map.has(item.instId)) map.set(item.instId, item);
    }
  }

  for (const w of cfg.watchlist || []) {
    if (isStablecoinInst(w)) continue;
    if (!map.has(w)) {
      map.set(w, { instId: w, volUsd24h: 0, price: null, chg24hPct: null, watchlist: true });
    }
  }

  const list = [...map.values()]
    .sort((a, b) => (b.volUsd24h || 0) - (a.volUsd24h || 0))
    .slice(0, Math.max(limit, (cfg.watchlist || []).length));

  return list;
}

// ---------- Candles: HTTP first, CLI fallback ----------

async function fetchCandlesHttp(instId, bar, limit = CANDLE_BOOTSTRAP_LIMIT) {
  const url = `${OKX_REST}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (String(json.code) !== '0') throw new Error(json.msg || `OKX code ${json.code}`);
  return Array.isArray(json.data) ? json.data : [];
}

async function fetchCandlesCli(instId, bar, limit = CANDLE_BOOTSTRAP_LIMIT) {
  const raw = await runOkxJson(
    ['market', 'candles', instId, '--bar', bar, '--limit', String(limit)],
    { timeoutMs: 45000 }
  );
  // CLI 可能直接返回数组，或 { data: [...] }
  if (Array.isArray(raw) && Array.isArray(raw[0])) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw) && raw[0]?.data) return raw[0].data;
  if (Array.isArray(raw) && raw[0] && Array.isArray(raw[0])) return raw;
  // 单行可能是对象数组
  if (Array.isArray(raw) && typeof raw[0]?.[0] === 'string') return raw;
  throw new Error('CLI candles 无法解析');
}

async function fetchCandles(instId, bar, limit = CANDLE_BOOTSTRAP_LIMIT) {
  try {
    return await withRetry(() => fetchCandlesHttp(instId, bar, limit), 1, 300);
  } catch (e) {
    pushLog('warn', `HTTP K线失败 ${instId}: ${e.message}，改用 CLI`);
    return await withRetry(() => fetchCandlesCli(instId, bar, limit), 1, 400);
  }
}

async function fetchTickerHttp(instId) {
  const url = `${OKX_REST}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (String(json.code) !== '0') throw new Error(json.msg || `OKX code ${json.code}`);
  return parseTicker(json.data);
}

async function fetchInstMetricsLocal(instId, cfg) {
  const bar = cfg.bar || '1H';
  const period = Number(cfg.rsi_period) || 14;
  const need = Math.max(period + 2, 30);
  const candles = await fetchCandles(instId, bar, Math.max(need, 100));
  // 只用已收盘
  const closed = candles
    .filter((c) => String(c[8] ?? '1') === '1')
    .map((c) => Number(c[4]))
    .filter((n) => Number.isFinite(n))
    .reverse(); // 旧→新
  const rsi = calcRsi(closed, period);
  let price = closed.length ? closed[closed.length - 1] : null;
  let ticker = null;
  try {
    ticker = await fetchTickerHttp(instId);
    if (ticker?.last != null && Number.isFinite(ticker.last)) price = ticker.last;
  } catch {
    try {
      const tickerRaw = await runOkxJson(['market', 'ticker', instId], { timeoutMs: 30000 });
      ticker = parseTicker(tickerRaw);
      if (ticker?.last != null && Number.isFinite(ticker.last)) price = ticker.last;
    } catch {
      /* ignore */
    }
  }
  return { instId, rsi, price, ticker };
}


function listFilteredCoins(cfg) {
  const now = Date.now();
  const out = [];
  for (const [instId, g] of slGuard.entries()) {
    if (g.filteredUntil && g.filteredUntil > now) {
      out.push({
        instId,
        streak: g.streak || 0,
        filteredUntil: new Date(g.filteredUntil).toISOString(),
        remainingMs: g.filteredUntil - now,
        reason: g.reason || '连续止损',
        updatedAt: g.updatedAt || null,
      });
    } else if (g.filteredUntil && g.filteredUntil <= now) {
      // 冷却结束：清过滤，保留 streak=0
      slGuard.set(instId, { streak: 0, filteredUntil: 0, reason: null, updatedAt: new Date().toISOString() });
    }
  }
  out.sort((a, b) => a.instId.localeCompare(b.instId));
  return out;
}

function isCoinFiltered(instId) {
  const g = slGuard.get(instId);
  if (!g || !g.filteredUntil) return false;
  if (g.filteredUntil > Date.now()) return true;
  slGuard.set(instId, { streak: 0, filteredUntil: 0, reason: null, updatedAt: new Date().toISOString() });
  return false;
}

function onTakeProfit(instId) {
  const g = slGuard.get(instId) || { streak: 0, filteredUntil: 0 };
  slGuard.set(instId, {
    streak: 0,
    filteredUntil: g.filteredUntil && g.filteredUntil > Date.now() ? g.filteredUntil : 0,
    reason: null,
    updatedAt: new Date().toISOString(),
  });
}

function onStopLoss(instId, cfg) {
  const maxSl = Number(cfg.max_consecutive_sl) || 2;
  const hours = Number(cfg.sl_filter_hours);
  const prev = slGuard.get(instId) || { streak: 0, filteredUntil: 0 };
  const streak = (prev.streak || 0) + 1;
  let filteredUntil = prev.filteredUntil || 0;
  let reason = null;
  if (streak >= maxSl) {
    const ms = (Number.isFinite(hours) ? hours : 24) * 3600 * 1000;
    filteredUntil = ms <= 0 ? Date.now() + 365 * 24 * 3600 * 1000 : Date.now() + ms;
    reason = `连续止损 ${streak} 次（阈值 ${maxSl}）`;
    const untilTxt = ms <= 0 ? '长期（需手动解除）' : new Date(filteredUntil).toLocaleString('zh-CN', { hour12: false });
    pushLog('warn', `[过滤] ${instId} ${reason}，暂停开仓至 ${untilTxt}`);
  } else {
    pushLog('info', `${instId} 连续止损计数 ${streak}/${maxSl}`);
  }
  slGuard.set(instId, {
    streak,
    filteredUntil,
    reason,
    updatedAt: new Date().toISOString(),
  });
}

/** 服务端风控：返回拒绝原因（中文），null 表示放行 */
function riskBlockReason(cfg, instId) {
  if (riskState.killSwitch.on) return { key: 'kill', msg: '急停已开启，禁止开新仓' };
  const risk = riskSnapshot(cfg);
  if (risk.daily_loss_hit) {
    return {
      key: `daily-${new Date().toDateString()}`,
      msg: `今日已实现亏损 ${risk.today_realized_usdt.toFixed(2)} USDT 已达上限 ${risk.daily_loss_limit_usdt} USDT，今日停止开新仓`,
      ms: 24 * 3600 * 1000,
    };
  }
  if (risk.orders_last_hour >= cfg.max_orders_per_hour) {
    return { key: 'orders-hour', msg: `近 1 小时已下单 ${risk.orders_last_hour} 笔，达到上限 ${cfg.max_orders_per_hour}，暂停开新仓` };
  }
  if (cfg.exec_mode === 'okx_demo') {
    if (externalPositions.some((p) => p.instId === instId)) {
      return { key: `ext-${instId}`, msg: `${instId} 在模拟盘已有外部持仓，不叠加开仓` };
    }
  } else {
    // 本地模拟：用 WS 盘口做点差检查（模拟盘模式在执行器内用模拟盘盘口检查）
    const book = tickerBook.get(instId);
    if (book && book.askPx > 0 && book.bidPx > 0) {
      const mid = (book.askPx + book.bidPx) / 2;
      const spreadPct = ((book.askPx - book.bidPx) / mid) * 100;
      if (spreadPct > cfg.max_spread_pct) {
        return { key: `spread-${instId}`, msg: `${instId} 点差 ${spreadPct.toFixed(3)}% > 上限 ${cfg.max_spread_pct}%，跳过`, ms: 10 * 60 * 1000 };
      }
    }
  }
  return null;
}

function tryOpenPosition(signalRow, cfg) {
  const instId = signalRow.instId;
  if (positions.has(instId) || pendingOpens.has(instId)) return null;
  if (positions.size + pendingOpens.size >= cfg.max_positions) return null;
  if (isCoinFiltered(instId)) return null;
  if (signalRow.price == null || !Number.isFinite(signalRow.price)) return null;
  // 安全约束：live 环境永不真实下单
  if (cfg.profile === 'live' && cfg.exec_mode !== 'sim') return null;
  const block = riskBlockReason(cfg, instId);
  if (block) {
    logThrottled(`risk:${block.key}`, 'warn', `[风控] ${block.msg}`, block.ms);
    return null;
  }
  if (cfg.exec_mode === 'okx_demo') {
    if (cfg.mode !== 'swap') return null;
    startDemoOpen(signalRow, cfg);
    return { pending: true, instId };
  }
  return openSimPosition(signalRow, cfg);
}

/** OKX 模拟盘异步开仓（不阻塞信号评估） */
async function startDemoOpen(signalRow, cfg) {
  const instId = signalRow.instId;
  pendingOpens.add(instId);
  try {
    const r = await executor.openLong({
      instId,
      amount: cfg.amount,
      leverage: cfg.leverage || 1,
      tpPct: cfg.take_profit_pct,
      slPct: cfg.stop_loss_pct,
      rsi: signalRow.rsi,
      maxSpreadPct: cfg.max_spread_pct,
      profile: cfg.profile,
      onSubmit: () => recordOrderTime(),
    });
    if (r.ok) {
      positions.set(instId, r.pos);
      saveState();
      setTimeout(() => reconcileDemo().catch(() => {}), 3000);
    } else {
      logThrottled(`skip:${instId}:${r.reason}`, r.skipped ? 'info' : 'warn', `[模拟盘] 未开仓：${r.reason}`, 10 * 60 * 1000);
    }
  } catch (e) {
    pushLog('error', `[模拟盘] ${instId} 开仓失败：${e.message}`);
  } finally {
    pendingOpens.delete(instId);
  }
}

function openSimPosition(signalRow, cfg) {
  const instId = signalRow.instId;

  const entry = signalRow.price;
  const amount = cfg.amount;
  const leverage = cfg.mode === 'swap' ? cfg.leverage || 1 : 1;
  const tp = entry * (1 + cfg.take_profit_pct / 100);
  const sl = entry * (1 - cfg.stop_loss_pct / 100);
  const pos = {
    instId,
    entry_price: entry,
    amount,
    leverage,
    tdMode: cfg.mode === 'swap' ? 'cross' : null,
    posSide: cfg.mode === 'swap' ? 'long' : null,
    order_ccy: 'USDT',
    take_profit_price: tp,
    stop_loss_price: sl,
    rsi_at_entry: signalRow.rsi,
    at: new Date().toISOString(),
    simulated: true,
    exec_mode: 'sim',
    profile: cfg.profile,
    mode: cfg.mode,
    status: 'open',
  };
  positions.set(instId, pos);
  recordOrderTime();

  const liveNote = cfg.profile === 'live' ? ' | 实盘自动下单未启用' : '';
  const levNote =
    cfg.mode === 'swap'
      ? ` | 永续多头 全仓 ${leverage}x | 名义约 ${(amount * leverage).toFixed(0)} USDT`
      : '';
  pushLog(
    'buy',
    `[模拟买入] ${instId} @ ${entry} | 金额 ${amount} USDT${levNote} | RSI=${signalRow.rsi?.toFixed?.(2) ?? signalRow.rsi} | 止盈 ${tp.toFixed(6)} | 止损 ${sl.toFixed(6)}${liveNote}`
  );
  return pos;
}

function checkExit(pos, price, cfg) {
  if (price == null || !Number.isFinite(price)) return null;
  // OKX 模拟盘持仓由交易所端 OCO 止盈止损负责平仓，本地绝不自行平仓
  if (pos.exec_mode === 'okx_demo') return null;
  const profitPct = ((price - pos.entry_price) / pos.entry_price) * 100;
  if (profitPct >= cfg.take_profit_pct) {
    const trade = recordClose(pos, price, 'tp', profitPct);
    pushLog(
      'tp',
      `[模拟止盈] ${pos.instId} 入场 ${pos.entry_price} → 现价 ${price} | 盈利 ${profitPct.toFixed(2)}% | 约 ${trade.pnl_usdt.toFixed(2)} USDT`
    );
    positions.delete(pos.instId);
    saveState();
    onTakeProfit(pos.instId);
    return { action: 'tp', profitPct, pnl_usdt: trade.pnl_usdt };
  }
  if (profitPct <= -cfg.stop_loss_pct) {
    const trade = recordClose(pos, price, 'sl', profitPct);
    pushLog(
      'sl',
      `[模拟止损] ${pos.instId} 入场 ${pos.entry_price} → 现价 ${price} | 亏损 ${profitPct.toFixed(2)}% | 约 ${trade.pnl_usdt.toFixed(2)} USDT`
    );
    positions.delete(pos.instId);
    saveState();
    onStopLoss(pos.instId, cfg);
    return { action: 'sl', profitPct, pnl_usdt: trade.pnl_usdt };
  }
  return null;
}

/** 基于 candleStore 评估信号 / 止盈止损（不拉 CLI） */
function evaluateSignals({ quiet = false } = {}) {
  if (!scanState?.running) return;
  const cfg = scanState.config;
  const threshold = cfg.rsi_buy_threshold;
  const now = new Date().toISOString();
  const volMap = new Map(lastUniverse.map((u) => [u.instId, u]));
  const ids = [...new Set([...lastUniverse.map((u) => u.instId), ...positions.keys()])];
  const rows = [];

  for (const instId of ids) {
    const snap = candleStore.snapshot(instId);
    const uni = volMap.get(instId);
    if (!snap || snap.bars < (cfg.rsi_period || 14) + 1) {
      // 无足够 K 线：不算进 signals
      continue;
    }
    // 正式 RSI 用已收盘；展示可用 forming
    const rsiClosed = snap.rsi;
    const rsiShow = snap.forming && snap.rsiForming != null ? snap.rsiForming : rsiClosed;
    const rsiValid = rsiShow != null && Number.isFinite(rsiShow) && rsiShow > 0;
    // 买入信号以正式（已收盘）RSI 为准；若仅有 forming 且正式为空则用 forming
    const rsiForSignal = rsiClosed != null && rsiClosed > 0 ? rsiClosed : rsiShow;
    const filtered = isCoinFiltered(instId);
    const rawSignal =
      rsiForSignal != null &&
      Number.isFinite(rsiForSignal) &&
      rsiForSignal > 0 &&
      rsiForSignal < threshold;
    const signal = rawSignal && !filtered;
    const price = snap.price ?? uni?.price ?? null;
    rows.push({
      instId,
      volUsd24h: uni?.volUsd24h ?? 0,
      price,
      rsi: rsiShow,
      rsiClosed,
      forming: !!snap.forming,
      filtered,
      signal,
      signalText: filtered
        ? `连续止损已过滤（至 ${new Date(slGuard.get(instId).filteredUntil).toLocaleString('zh-CN', { hour12: false })}）`
        : !rsiValid
          ? 'RSI 无效（K 线不足或无数据）'
          : signal
            ? snap.forming
              ? 'RSI 进入超卖区（含未收盘），触发买入！'
              : 'RSI 进入超卖区，触发买入！'
            : '未触发',
      ok: true,
      error: null,
      at: snap.updatedAt || now,
      watchlist: !!uni?.watchlist,
    });
  }

  rows.sort((a, b) => {
    if (a.signal !== b.signal) return a.signal ? -1 : 1;
    const ar = a.rsi == null ? 999 : a.rsi;
    const br = b.rsi == null ? 999 : b.rsi;
    if (ar !== br) return ar - br;
    return (b.volUsd24h || 0) - (a.volUsd24h || 0);
  });

  lastSignals = rows.filter((r) => r.rsi != null && Number.isFinite(r.rsi) && r.rsi > 0);

  // 止盈止损（仅本地模拟持仓；OKX 模拟盘持仓价格/盈亏由对账从交易所更新）
  for (const pos of [...positions.values()]) {
    const snap = candleStore.get(pos.instId);
    const price = snap?.price ?? null;
    if (pos.exec_mode === 'okx_demo') {
      if (price != null) pos.ws_price = price;
      continue;
    }
    if (price != null) {
      pos.last_price = price;
      pos.profit_pct = ((price - pos.entry_price) / pos.entry_price) * 100;
      pos.take_profit_price = pos.entry_price * (1 + cfg.take_profit_pct / 100);
      pos.stop_loss_price = pos.entry_price * (1 - cfg.stop_loss_pct / 100);
      checkExit(pos, price, cfg);
    }
  }

  // 开仓
  const signalRows = rows.filter((r) => r.signal && r.ok);
  let opened = 0;
  for (const s of signalRows) {
    if (positions.size + pendingOpens.size >= cfg.max_positions) {
      if (opened === 0 && signalRows.length && !quiet) {
        pushLog('info', `持仓已满 (${positions.size}/${cfg.max_positions})，仅监控止盈止损，不再新开`);
      }
      break;
    }
    const p = tryOpenPosition(s, cfg);
    if (p) opened++;
  }

  scanState.lastScanAt = now;
  scanState.error = null;

  if (!quiet) {
    scanState.round = (scanState.round || 0) + 1;
    pushLog(
      'info',
      `信号评估 #${scanState.round}：有效 ${lastSignals.length} | 信号 ${signalRows.length} | ${cfg.exec_mode === 'okx_demo' ? '提交开仓' : '新开'} ${opened} | 持仓 ${positions.size} | WS ${wsPublicStatus().connected ? '已连接' : '重连中'}`
    );
  } else if (opened > 0) {
    pushLog('info', `推送触发新开 ${opened} | 持仓 ${positions.size}`);
  }
}

function scheduleEvaluate(reason = '') {
  if (!scanState?.running) return;
  if (evalDebounceTimer) return;
  evalDebounceTimer = setTimeout(() => {
    evalDebounceTimer = null;
    try {
      evaluateSignals({ quiet: true });
    } catch (e) {
      pushLog('warn', `推送评估失败(${reason}): ${e.message}`);
    }
  }, 800);
}

async function bootstrapCandles(cfg, universe) {
  candleStore.clear();
  candleStore.setPeriod(cfg.rsi_period);
  const need = Math.max(cfg.rsi_period + 2, CANDLE_BOOTSTRAP_LIMIT);
  let ok = 0;
  let fail = 0;
  pushLog('info', `开始 Bootstrap K 线：${universe.length} 个币 × ${cfg.bar} limit=${need}`);

  await mapPool(universe, cfg.scanConcurrency, async (u) => {
    const instId = u.instId;
    try {
      const candles = await fetchCandles(instId, cfg.bar, need);
      if (!candles.length) {
        fail++;
        pushLog('warn', `无 K 线 ${instId}`);
        return;
      }
      candleStore.bootstrap(instId, candles);
      if (u.price != null) candleStore.setPrice(instId, u.price);
      const snap = candleStore.snapshot(instId);
      if (snap && snap.rsi != null && snap.rsi > 0) ok++;
      else {
        fail++;
        pushLog('warn', `K 线不足无法算 RSI ${instId} bars=${snap?.bars ?? 0}`);
      }
    } catch (e) {
      fail++;
      pushLog('warn', `Bootstrap 失败 ${instId}: ${e.message}`);
    }
  });

  pushLog('info', `Bootstrap 完成：有效 RSI ${ok} | 失败/不足 ${fail}`);
  return { ok, fail };
}

function startWsFeed(cfg, instIds) {
  wsManager.start({
    instIds,
    bar: cfg.bar,
    onCandle: (instId, candle) => {
      candleStore.applyCandle(instId, candle);
      scheduleEvaluate('candle');
    },
    onTicker: (instId, ticker) => {
      const askPx = Number(ticker.askPx);
      const bidPx = Number(ticker.bidPx);
      if (Number.isFinite(askPx) && Number.isFinite(bidPx)) tickerBook.set(instId, { askPx, bidPx, ts: Date.now() });
      const last = Number(ticker.last);
      if (Number.isFinite(last)) {
        candleStore.setPrice(instId, last);
        // 持仓币优先评估止盈止损
        if (positions.has(instId)) scheduleEvaluate('ticker');
      }
    },
  });
}

async function runBootstrapAndStart() {
  if (!scanState?.running) return;
  if (scanBusy) {
    pushLog('warn', '启动流程仍在进行，跳过');
    return;
  }
  scanBusy = true;
  const cfg = scanState.config;
  feedMode = 'websocket';
  try {
    if (cfg.exec_mode === 'okx_demo') {
      try {
        const acc = await executor.prepare();
        pushLog(
          'info',
          `[模拟盘] 连接成功 | 持仓模式 ${acc.posModeText || acc.posMode || '未知'} | 账户模式 ${acc.acctLvText || acc.acctLv || '未知'} | USDT 权益 ${fmtNum(acc.usdtEq)} | 可用 ${fmtNum(acc.usdtAvail)} | 合约规格 ${executor.instruments.size} 个`
        );
        reconcileDemo().catch(() => {});
      } catch (e) {
        scanState.error = `OKX 模拟盘准备失败：${e.message}`;
        pushLog('error', `[模拟盘] 准备失败，已停止扫描：${e.message}`);
        stopScanInternal();
        return;
      }
    }
    pushLog(
      'info',
      `开始启动扫描 | mode=${cfg.mode} bar=${cfg.bar} channel=${barToCandleChannel(cfg.bar)} limit=${cfg.universeLimit}`
    );

    const universe = await fetchUniverse(cfg);
    lastUniverse = universe;
    pushLog('info', `Universe 构建完成：${universe.length} 个币（成交量过滤后）`);

    await bootstrapCandles(cfg, universe);

    const heldIds = [...positions.keys()];
    const scanIds = [...new Set([...universe.map((u) => u.instId), ...heldIds])];
    startWsFeed(cfg, scanIds);

    evaluateSignals({ quiet: false });
    scanState.error = null;
  } catch (e) {
    scanState.error = e.message;
    pushLog('error', `启动扫描失败: ${e.message}`);
  } finally {
    scanBusy = false;
  }
}

function fmtNum(n, d = 2) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(d);
}

function stopScanInternal() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (evalDebounceTimer) {
    clearTimeout(evalDebounceTimer);
    evalDebounceTimer = null;
  }
  wsManager.stop();
  candleStore.clear();
  tickerBook.clear();
  if (scanState) scanState.running = false;
}

// ---------- Legacy single-coin helpers ----------
let monitor = null;

function getSignalState(cfg, rsi, price) {
  const threshold = Number(cfg.rsi_buy_threshold);
  const signal = rsi != null && Number.isFinite(rsi) && rsi > 0 && rsi < threshold;
  const entry = monitor?.position?.entry_price ?? null;
  const tpPct = Number(cfg.take_profit_pct);
  const slPct = Number(cfg.stop_loss_pct);
  let takeProfitPrice = null;
  let stopLossPrice = null;
  let profitPct = null;
  if (entry != null && Number.isFinite(entry)) {
    takeProfitPrice = entry * (1 + tpPct / 100);
    stopLossPrice = entry * (1 - slPct / 100);
    if (price != null) profitPct = ((price - entry) / entry) * 100;
  }
  return {
    rsi,
    price,
    rsi_buy_threshold: threshold,
    signal,
    signalText: signal ? 'RSI 进入超卖区，触发买入！' : '未触发买入信号',
    entry_price: entry,
    take_profit_price: takeProfitPrice,
    stop_loss_price: stopLossPrice,
    profit_pct: profitPct,
    positions: positions.size || (monitor?.position ? 1 : 0),
    max_positions: Number(cfg.max_positions) || 1,
  };
}

async function fetchMarket(cfg) {
  const instId = normalizeInstId(cfg.instId, cfg.mode);
  return fetchInstMetricsLocal(instId, cfg);
}

// ---------- OKX 模拟盘对账（交易所为准） ----------

function finalizeDemoClose(pos, res, { estimated = false } = {}) {
  const cfg = effectiveCfg();
  const entry = Number(pos.entry_price);
  const exit = Number.isFinite(res.closeAvgPx) && res.closeAvgPx > 0 ? res.closeAvgPx : Number(pos.last_price) || entry;
  const pct = entry > 0 ? ((exit - entry) / entry) * 100 : 0;
  const trade = recordClose(pos, exit, res.action, pct, {
    pnl_usdt: estimated ? null : res.realizedPnl,
    fee_usdt: estimated ? null : res.fee,
    funding_fee_usdt: estimated ? null : res.fundingFee,
    gross_pnl_usdt: estimated ? null : res.pnl,
    inferred: !!res.inferred,
    estimated,
    closed_at: res.uTime ? new Date(res.uTime).toISOString() : undefined,
  });
  positions.delete(pos.instId);
  saveState();
  const level = res.action === 'tp' ? 'tp' : res.action === 'sl' || res.action === 'liq' ? 'sl' : 'sell';
  pushLog(
    level,
    `[模拟盘${reasonText(res.action)}] ${pos.instId} 入场 ${entry} → 平仓均价 ${fmtNum(exit, 8).replace(/\.?0+$/, '')} | ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% | 已实现 ${trade.pnl_usdt.toFixed(4)} USDT${
      estimated ? '（估算：未查到平仓记录）' : `（含手续费 ${fmtNum(res.fee, 4)}${res.fundingFee ? ` · 资金费 ${fmtNum(res.fundingFee, 4)}` : ''}）`
    }${res.inferred ? ' · 类型按价格推断' : ''}`
  );
  if (res.action === 'tp') onTakeProfit(pos.instId);
  else if (res.action === 'sl' || res.action === 'liq') onStopLoss(pos.instId, cfg);
  return trade;
}

async function reconcileDemo() {
  if (reconcileState.busy) return;
  if (!demoKeysConfigured()) return;
  const tracked0 = demoPositions();
  const cfg = effectiveCfg();
  if (cfg.exec_mode !== 'okx_demo' && tracked0.length === 0 && reconcileState.startupDone) return;
  reconcileState.busy = true;
  try {
    await executor.ensureTimeSync();
    if (!executor.accountConfig) await executor.refreshAccountConfig();
    await executor.refreshBalance(true);
    const exPos = await executor.fetchPositions();
    const algos = await executor.fetchPendingAlgos();
    const live = (exPos || []).filter((p) => Number(p.pos) !== 0);
    const pendingAlgoIds = new Set((algos || []).map((a) => a.algoId));

    for (const pos of demoPositions()) {
      const ex = live.find(
        (p) => p.instId === pos.instId && (pos.posSide === 'long' ? p.posSide === 'long' : p.posSide === 'net' && Number(p.pos) > 0)
      );
      const age = Date.now() - Number(pos.opened_ts || 0);
      if (ex) {
        const last = Number(ex.last) || Number(ex.markPx) || null;
        pos.last_price = last;
        pos.mark_price = Number(ex.markPx) || null;
        pos.upl = ex.upl !== '' && ex.upl != null ? Number(ex.upl) : null;
        pos.exchange_contracts = Number(ex.pos);
        pos.liq_price = ex.liqPx ? Number(ex.liqPx) : null;
        pos.profit_pct = last && pos.entry_price ? ((last - pos.entry_price) / pos.entry_price) * 100 : null;
        pos.missingSince = null;
        if (pos.status === 'open') {
          const attached = !!(pos.algoId && pendingAlgoIds.has(pos.algoId));
          pos.tp_sl_attached = attached;
          if (!attached && age > 15000) {
            // 保护单缺失：若已触发则等待交易所平仓；否则重新挂单，失败则保护性平仓
            let state = null;
            if (pos.algoId) {
              try {
                state = (await executor.client.getAlgoOrder({ algoId: pos.algoId }))?.[0]?.state || null;
              } catch {
                state = null;
              }
            }
            if (state === 'effective' || state === 'partially_effective') {
              pos.status = 'closing';
            } else {
              pushLog('warn', `[模拟盘] ${pos.instId} 交易所止盈止损委托缺失（状态 ${state || '无'}），尝试重新挂单`);
              try {
                await executor.placeProtection(pos, pos.tp_pct ?? cfg.take_profit_pct, pos.sl_pct ?? cfg.stop_loss_pct);
              } catch (e) {
                pushLog('error', `[模拟盘] ${pos.instId} 重新挂止盈止损失败：${e.message} → 保护性市价平仓`);
                pos.close_reason = 'failsafe';
                try {
                  await executor.marketClose(pos, 'failsafe');
                } catch (e2) {
                  pushLog('error', `[模拟盘] ${pos.instId} 保护性平仓失败：${e2.message}（请立即在 OKX 模拟盘手动处理！）`);
                }
              }
            }
          }
        }
      } else {
        if (age < 10000) continue; // 刚开仓，等待交易所数据
        if (!pos.missingSince) pos.missingSince = Date.now();
        pos.status = 'closing';
        let res = null;
        try {
          res = await executor.resolveClose(pos);
        } catch (e) {
          logThrottled(`resolve-${pos.instId}`, 'warn', `[模拟盘] 查询 ${pos.instId} 平仓记录失败：${e.message}`, 60000);
        }
        if (res) {
          finalizeDemoClose(pos, res);
        } else if (Date.now() - pos.missingSince > 3 * 60 * 1000) {
          const exit = Number(pos.last_price) || Number(pos.entry_price);
          finalizeDemoClose(
            pos,
            { closeAvgPx: exit, action: pos.close_reason || (exit >= pos.entry_price ? 'tp' : 'sl'), inferred: !pos.close_reason },
            { estimated: true }
          );
        } else {
          continue;
        }
        // 仓位已平但保护单仍挂着 → 撤销（避免孤儿委托）
        if (pos.algoId && pendingAlgoIds.has(pos.algoId)) await executor.cancelProtection(pos);
      }
    }

    const trackedKeys = new Set(demoPositions().map((p) => p.instId));
    externalPositions = live
      .filter((p) => !trackedKeys.has(p.instId))
      .map((p) => ({
        instId: p.instId,
        posSide: p.posSide,
        pos: Number(p.pos),
        avgPx: Number(p.avgPx) || null,
        lever: Number(p.lever) || null,
        mgnMode: p.mgnMode,
        upl: p.upl !== '' ? Number(p.upl) : null,
        uplRatio: p.uplRatio !== '' ? Number(p.uplRatio) : null,
        last: Number(p.last) || Number(p.markPx) || null,
        external: true,
      }));
    saveState();
    reconcileState.error = null;
    executor.accountError = null;
  } catch (e) {
    reconcileState.error = e.message;
    executor.accountError = e.message;
    logThrottled('recon-err', 'warn', `[模拟盘] 对账失败：${e.message}`, 60000);
  } finally {
    reconcileState.busy = false;
    reconcileState.lastAt = new Date().toISOString();
    reconcileState.startupDone = true;
  }
}

/** 启动扫描前的统一校验；返回 { status, error } 或 null */
function validateStart(rawBody, cfg) {
  const rawExec = String(rawBody?.exec_mode ?? '').toLowerCase();
  if (rawExec && rawExec !== 'sim' && rawExec !== 'okx_demo') {
    return { status: 403, error: '实盘真实下单已被禁用（安全约束）。执行方式仅支持「本地模拟」或「OKX 模拟盘」。' };
  }
  if (cfg.exec_mode === 'okx_demo') {
    if (cfg.profile === 'live') {
      return { status: 403, error: '实盘（live）真实下单已被禁用（安全约束）。OKX 模拟盘执行请选择 demo 环境。' };
    }
    if (cfg.mode !== 'swap') {
      return { status: 400, error: '「OKX 模拟盘」执行目前仅支持 USDT 永续（swap）。现货请使用「本地模拟」。' };
    }
    if (!demoKeysConfigured()) {
      return { status: 400, error: '未配置 OKX 模拟盘 API Key，请在 server/.env.local 填写 OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE 后重启后端。' };
    }
  }
  if (riskState.killSwitch.on) {
    return { status: 409, error: '急停已开启，请先点击「解除急停」再开始扫描。' };
  }
  return null;
}

// ---------- Routes ----------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'rsi-bottom-hunter',
    mode: 'market-scan',
    feed: feedMode,
    time: new Date().toISOString(),
  });
});

app.get('/api/config-status', async (_req, res) => {
  try {
    const { stdout } = await runOkx(['config', 'show'], { timeoutMs: 20000 });
    const text = stdout.trim();
    res.json({
      tradingReady: !/No profiles found/i.test(text),
      raw: text.slice(0, 1500),
      hint: /No profiles found/i.test(text)
        ? '当前未配置 OKX API profile。行情走 WebSocket/REST；下单需先运行: okx config add-profile AK=... SK=... PP=...'
        : '已检测到 profile。自动扫描仅模拟成交；live 实盘自动下单未启用。行情源：WebSocket。',
      liveAutoTradeDisabled: true,
      feed: feedMode,
    });
  } catch (e) {
    res.json({
      tradingReady: false,
      raw: '',
      hint: `无法读取 okx config: ${e.message}（行情仍可用 WebSocket/REST）`,
      error: e.message,
      liveAutoTradeDisabled: true,
      feed: feedMode,
    });
  }
});

app.post('/api/universe', async (req, res) => {
  try {
    const cfg = clampConfig(req.body || {});
    pushLog('info', `构建 Universe | mode=${cfg.mode} | minVol=${cfg.minVolUsd24h} | limit=${cfg.universeLimit}`);
    const list = await fetchUniverse(cfg);
    lastUniverse = list;
    res.json({
      ok: true,
      mode: cfg.mode,
      minVolUsd24h: cfg.minVolUsd24h,
      universeLimit: cfg.universeLimit,
      count: list.length,
      items: list,
      at: new Date().toISOString(),
    });
  } catch (e) {
    pushLog('error', `Universe 失败: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scan/start', async (req, res) => {
  try {
    const cfg = clampConfig(req.body || {});
    if (!Number.isFinite(cfg.amount) || cfg.amount <= 0) {
      return res.status(400).json({ error: 'amount 必填且须 > 0' });
    }
    const bad = validateStart(req.body, cfg);
    if (bad) {
      pushLog('warn', `拒绝开始扫描：${bad.error}`);
      return res.status(bad.status).json({ error: bad.error, liveAutoTradeDisabled: true });
    }

    stopScanInternal();
    feedMode = 'websocket';
    scanState = {
      running: true,
      config: cfg,
      startedAt: new Date().toISOString(),
      lastScanAt: null,
      round: 0,
      error: null,
    };

    const liveNote =
      cfg.exec_mode === 'okx_demo'
        ? ` | 执行：OKX 模拟盘真实下单 | 风控：日亏上限 ${cfg.daily_loss_limit_usdt}U · 每小时 ${cfg.max_orders_per_hour} 单 · 点差 ≤${cfg.max_spread_pct}%`
        : cfg.profile === 'live'
          ? ' | 实盘自动下单未启用，仅模拟'
          : ' | demo 本地模拟';
    pushLog(
      'info',
      `开始全市场扫描(WebSocket) mode=${cfg.mode} bar=${cfg.bar} RSI<${cfg.rsi_buy_threshold} limit=${cfg.universeLimit} 评估间隔=${cfg.refreshSec}s${
        cfg.mode === 'swap' ? ` 杠杆=${cfg.leverage}x 全仓多头 USDT` : ''
      }${liveNote}`
    );

    setImmediate(() => {
      runBootstrapAndStart().catch((e) => pushLog('error', `启动异常: ${e.message}`));
    });
    scanTimer = setInterval(() => {
      try {
        evaluateSignals({ quiet: false });
      } catch (e) {
        pushLog('error', `信号评估异常: ${e.message}`);
      }
    }, cfg.refreshSec * 1000);

    res.json({
      ok: true,
      scan: publicScan(),
      liveAutoTradeDisabled: true,
      feed: 'websocket',
      note: scanNote(cfg),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scan/stop', (_req, res) => {
  stopScanInternal();
  pushLog('info', '已停止全市场扫描（已关闭 WebSocket）');
  res.json({ ok: true, scan: publicScan() });
});

app.get('/api/scan/status', (_req, res) => {
  const posList = [...positions.values()];
  const cfg = effectiveCfg();
  res.json({
    ok: true,
    scan: publicScan(),
    exec: execPublic(cfg),
    exec_mode: cfg.exec_mode || 'sim',
    externalPositions,
    filtered: listFilteredCoins(scanState?.config || DEFAULT_SCAN),
    signals: lastSignals.slice(0, 100),
    positions: posList,
    pnl: buildPnLDashboard(posList),
    universeSize: lastUniverse.length,
    logs: eventLog.slice(0, 50),
    liveAutoTradeDisabled: true,
    feed: feedMode,
    ws: wsPublicStatus(),
  });
});



app.get('/api/pnl', (_req, res) => {
  res.json({ ok: true, ...buildPnLDashboard([...positions.values()]) });
});

app.post('/api/pnl/clear', (_req, res) => {
  clearTrades();
  pushLog('info', '已清空盈亏账本（仅历史平仓记录）');
  res.json({ ok: true, pnl: buildPnLDashboard([...positions.values()]) });
});

app.get('/api/filtered', (_req, res) => {
  const cfg = scanState?.config || DEFAULT_SCAN;
  const list = listFilteredCoins(cfg);
  res.json({
    ok: true,
    count: list.length,
    max_consecutive_sl: cfg.max_consecutive_sl,
    sl_filter_hours: cfg.sl_filter_hours,
    items: list,
  });
});

app.post('/api/filtered/clear', (req, res) => {
  const instId = req.body?.instId ? String(req.body.instId).toUpperCase() : null;
  if (instId) {
    slGuard.delete(instId);
    pushLog('info', `已手动解除过滤：${instId}`);
  } else {
    slGuard.clear();
    pushLog('info', '已清空全部连续止损过滤');
  }
  res.json({ ok: true, items: listFilteredCoins(scanState?.config || DEFAULT_SCAN) });
});

app.get('/api/positions', (_req, res) => {
  const cfg = scanState?.config || DEFAULT_SCAN;
  const list = [...positions.values()].map((p) => {
    const price = p.exec_mode === 'okx_demo' ? p.last_price ?? null : p.last_price ?? candleStore.get(p.instId)?.price ?? null;
    const profitPct =
      price != null
        ? ((price - p.entry_price) / p.entry_price) * 100
        : p.profit_pct ?? null;
    return {
      ...p,
      last_price: price,
      profit_pct: profitPct,
      take_profit_price:
        p.exec_mode === 'okx_demo' ? p.take_profit_price : p.entry_price * (1 + Number(cfg.take_profit_pct) / 100),
      stop_loss_price:
        p.exec_mode === 'okx_demo' ? p.stop_loss_price : p.entry_price * (1 - Number(cfg.stop_loss_pct) / 100),
    };
  });
  res.json({ ok: true, positions: list, count: list.length, max_positions: cfg.max_positions, externalPositions });
});

app.get('/api/signals', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  const onlySignal = String(req.query.signal || '') === '1';
  let rows = lastSignals.filter((r) => r.rsi != null && Number.isFinite(r.rsi) && r.rsi > 0);
  if (onlySignal) rows = rows.filter((r) => r.signal);
  res.json({
    ok: true,
    count: rows.length,
    signals: rows.slice(0, limit),
    lastScanAt: scanState?.lastScanAt || null,
    feed: feedMode,
  });
});

app.post('/api/position/clear', (req, res) => {
  const instId = req.body?.instId;
  // 仅清除「本地模拟」持仓；OKX 模拟盘持仓以交易所为准，需用「急停并全部平仓」或在 OKX 平仓
  if (instId) {
    const id = normalizeInstId(instId, scanState?.config?.mode || 'spot');
    const p = positions.get(id);
    if (p?.exec_mode === 'okx_demo') {
      return res.status(400).json({ error: `${id} 是 OKX 模拟盘持仓，不能本地清除；请使用「急停并全部平仓」或在 OKX 模拟盘平仓` });
    }
    positions.delete(id);
    pushLog('info', `已清除模拟持仓 ${instId}`);
  } else {
    let kept = 0;
    for (const [id, p] of [...positions.entries()]) {
      if (p.exec_mode === 'okx_demo') kept++;
      else positions.delete(id);
    }
    if (monitor) {
      monitor.position = null;
      monitor.positionsCount = 0;
    }
    pushLog('info', `已清除全部本地模拟持仓${kept ? `（保留 OKX 模拟盘持仓 ${kept} 个，以交易所为准）` : ''}`);
  }
  saveState();
  res.json({ ok: true, positions: [...positions.values()] });
});

app.post('/api/signal', async (req, res) => {
  try {
    const cfg = clampConfig(req.body || {});
    if (!req.body?.instId) return res.status(400).json({ error: 'instId 必填（单币接口）' });
    const { instId, rsi, price, ticker } = await fetchMarket({ ...cfg, instId: req.body.instId });
    const state = getSignalState({ ...cfg, instId }, rsi, price);
    pushLog('info', `手动刷新 ${instId} RSI=${rsi ?? 'N/A'} 价格=${price ?? 'N/A'} | ${state.signalText}`);
    res.json({
      ok: true,
      profile: cfg.profile,
      mode: cfg.mode,
      instId,
      bar: cfg.bar,
      rsi_period: cfg.rsi_period,
      feed: 'rest-local-rsi',
      ...state,
      ticker,
      at: new Date().toISOString(),
    });
  } catch (e) {
    pushLog('error', `刷新信号失败: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/balance', async (req, res) => {
  const profile = String(req.query.profile || 'demo');
  try {
    const data = await runOkxJson(['account', 'balance', 'USDT', '--profile', profile]);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message,
      hint: '查询余额需要已配置的 API profile。',
    });
  }
});

app.post('/api/trade/preview', async (req, res) => {
  const raw = req.body || {};
  const cfg = clampConfig(raw);
  const profile = cfg.profile;
  const action = raw.action || 'buy';

  if (profile === 'live' && raw.execute) {
    return res.status(403).json({
      ok: false,
      error: '实盘自动下单未启用（安全约束）。请使用 demo 模拟，或仅预览。',
      previewOnly: true,
      liveAutoTradeDisabled: true,
    });
  }

  if (!raw.instId) return res.status(400).json({ error: 'instId 必填' });
  const instId = normalizeInstId(raw.instId, cfg.mode);
  let price = null;
  let rsi = null;
  try {
    const m = await fetchMarket({ ...cfg, instId });
    price = m.price;
    rsi = m.rsi;
  } catch (e) {
    return res.status(500).json({ error: `行情获取失败: ${e.message}` });
  }

  const entry = price;
  const tp = entry * (1 + cfg.take_profit_pct / 100);
  const sl = entry * (1 - cfg.stop_loss_pct / 100);
  const preview = {
    action,
    instId,
    mode: cfg.mode,
    profile,
    amount: cfg.amount,
    rsi,
    entry_price: entry,
    take_profit_price: tp,
    stop_loss_price: sl,
    simulated: true,
    liveAutoTradeDisabled: true,
    command:
      cfg.mode === 'swap'
        ? `okx swap place --instId ${instId} --side buy --ordType market --sz ${cfg.amount} --tdMode cross --posSide long --lever ${cfg.leverage || 1} --tgtCcy quote_ccy --profile ${profile}`
        : `okx spot place --instId ${instId} --side buy --ordType market --sz ${cfg.amount} --tgtCcy quote_ccy --profile ${profile}`,
  };

  pushLog('info', `[预览] ${preview.command}`);
  // 预览只在「本地模拟」下生成模拟持仓，绝不触发真实下单
  if (action === 'buy' && entry != null && cfg.exec_mode === 'sim') {
    tryOpenPosition({ instId, price: entry, rsi, signal: true }, cfg);
  }
  res.json({
    ok: true,
    executed: false,
    reason:
      profile === 'live'
        ? '实盘自动下单未启用，已生成模拟预览'
        : '预览/模拟模式（未实际发送订单）',
    preview,
    liveAutoTradeDisabled: true,
  });
});

// ---------- OKX 模拟盘账户 / 急停 ----------

/** 连通性测试（只读）：账户配置 + USDT 余额 */
app.get('/api/account', async (_req, res) => {
  if (!demoKeysConfigured()) {
    return res.json({
      ok: false,
      keysConfigured: false,
      error: '未配置 OKX 模拟盘 API Key，请在 server/.env.local 填写 OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE 后重启后端',
      account: executor.accountSummary(),
      liveAutoTradeDisabled: true,
    });
  }
  try {
    const account = await executor.refreshAccount();
    res.json({
      ok: true,
      keysConfigured: true,
      simulated: true,
      account,
      externalPositions,
      trackedDemoPositions: demoPositions().length,
      liveAutoTradeDisabled: true,
    });
  } catch (e) {
    pushLog('warn', `[模拟盘] 账户连通性测试失败：${e.message}`);
    res.json({ ok: false, keysConfigured: true, error: e.message, account: executor.accountSummary(), liveAutoTradeDisabled: true });
  }
});

/** 急停：停止开新仓 + 停止扫描；closeAll=true 时市价平掉本程序管理的模拟盘持仓并撤销其止盈止损 */
app.post('/api/kill', async (req, res) => {
  const closeAll = req.body?.closeAll === true;
  // 先记录本地模拟持仓最新价（停止扫描会清空行情缓存）
  for (const p of positions.values()) {
    if (p.exec_mode !== 'okx_demo') {
      const px = candleStore.get(p.instId)?.price;
      if (px != null && Number.isFinite(px)) p.last_price = px;
    }
  }
  riskState.killSwitch = { on: true, at: new Date().toISOString(), reason: closeAll ? '急停并全部平仓' : '急停' };
  stopScanInternal();
  saveState();
  pushLog('error', `[急停] 已开启：禁止开新仓，已停止扫描${closeAll ? '，开始全部平仓' : ''}`);

  const results = [];
  if (closeAll) {
    for (const pos of [...positions.values()]) {
      if (pos.exec_mode === 'okx_demo') {
        if (pos.status === 'closing') {
          results.push({ instId: pos.instId, ok: true, exec_mode: 'okx_demo', note: '已在平仓中' });
          continue;
        }
        try {
          pos.close_reason = 'kill';
          if (pos.algoId) await executor.cancelProtection(pos);
          await executor.marketClose(pos, 'kill');
          results.push({ instId: pos.instId, ok: true, exec_mode: 'okx_demo' });
        } catch (e) {
          pushLog('error', `[急停] ${pos.instId} 平仓失败：${e.message}`);
          results.push({ instId: pos.instId, ok: false, error: e.message, exec_mode: 'okx_demo' });
        }
      } else {
        const price = Number(pos.last_price) || Number(pos.entry_price);
        const pct = ((price - pos.entry_price) / pos.entry_price) * 100;
        const trade = recordClose(pos, price, 'kill', pct);
        positions.delete(pos.instId);
        pushLog('sell', `[急停平仓·本地模拟] ${pos.instId} @ ${price} | ${pct.toFixed(2)}% | 约 ${trade.pnl_usdt.toFixed(2)} USDT`);
        results.push({ instId: pos.instId, ok: true, exec_mode: 'sim' });
      }
    }
    saveState();
    setTimeout(() => reconcileDemo().catch(() => {}), 2500);
  }
  res.json({ ok: true, killSwitch: riskState.killSwitch, closeAll, results, scan: publicScan() });
});

app.post('/api/kill/reset', (_req, res) => {
  riskState.killSwitch = { on: false, at: null, reason: null };
  saveState();
  pushLog('info', '[急停] 已解除，可重新开始扫描');
  res.json({ ok: true, killSwitch: riskState.killSwitch });
});

app.get('/api/logs', (_req, res) => {
  res.json({ logs: eventLog });
});

app.delete('/api/logs', (_req, res) => {
  eventLog.length = 0;
  res.json({ ok: true });
});

app.post('/api/monitor/start', async (req, res) => {
  try {
    const cfg = clampConfig(req.body || {});
    if (!Number.isFinite(cfg.amount) || cfg.amount <= 0) {
      return res.status(400).json({ error: 'amount 必填且须 > 0' });
    }
    const bad = validateStart(req.body, cfg);
    if (bad) return res.status(bad.status).json({ error: bad.error, liveAutoTradeDisabled: true });
    stopScanInternal();
    feedMode = 'websocket';
    scanState = {
      running: true,
      config: cfg,
      startedAt: new Date().toISOString(),
      lastScanAt: null,
      round: 0,
      error: null,
    };
    pushLog('info', `开始扫描（兼容 monitor/start） mode=${cfg.mode} · WebSocket`);
    setImmediate(() => {
      runBootstrapAndStart().catch((e) => pushLog('error', `启动异常: ${e.message}`));
    });
    scanTimer = setInterval(() => {
      try {
        evaluateSignals({ quiet: false });
      } catch (e) {
        pushLog('error', `信号评估异常: ${e.message}`);
      }
    }, cfg.refreshSec * 1000);
    res.json({ ok: true, scan: publicScan(), monitor: { running: true }, feed: 'websocket' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/monitor/stop', (_req, res) => {
  stopScanInternal();
  pushLog('info', '已停止扫描（兼容 monitor/stop）');
  res.json({ ok: true, scan: publicScan(), monitor: { running: false } });
});
app.get('/api/monitor/status', (_req, res) => {
  res.json({
    ok: true,
    scan: publicScan(),
    monitor: {
      running: !!scanState?.running,
      last: lastSignals[0] || null,
      position: [...positions.values()][0] || null,
    },
    logs: eventLog.slice(0, 50),
    feed: feedMode,
    ws: wsPublicStatus(),
  });
});

const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(dist, 'index.html'));
  });
}

process.on('unhandledRejection', (e) => {
  pushLog('error', `未处理的异步错误：${e?.message || e}`);
});

loadState();

app.listen(PORT, '127.0.0.1', () => {
  pushLog('info', `RSI抄底宝扫描后端已启动 :${PORT} · 行情源 WebSocket`);
  pushLog(
    'info',
    demoKeysConfigured()
      ? 'OKX 模拟盘 API Key：已配置（来自 server/.env.local / 环境变量）· 实盘真实下单已禁用'
      : `OKX 模拟盘 API Key：未配置${envLoad.loaded ? '（server/.env.local 中缺少必要项）' : '（未找到 server/.env.local）'} · 仅可本地模拟`
  );
  console.log(`[rsi-bottom-hunter] API http://127.0.0.1:${PORT}`);
  if (demoKeysConfigured()) {
    reconcileDemo().catch(() => {});
  }
  setInterval(() => {
    reconcileDemo().catch(() => {});
  }, RECONCILE_MS);
});
