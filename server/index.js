/**
 * RSI抄底宝 — 全市场扫描后端
 * Universe（CLI filter/tickers）→ REST/CLI K 线 bootstrap → 本地 Wilder RSI
 * → OKX WebSocket 实时 K 线 + tickers 驱动更新（不再轮询 market indicator rsi）
 */
import express from 'express';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFile, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { calcRsi } from './rsi.js';
import { CandleStore } from './candleStore.js';
import { recordClose, clearTrades, buildPnLDashboard, todayRealized, usedCloseKeys, listTrades } from './pnl.js';
import { CoinGuard, clampGuardCfg, GUARD_DEFAULTS } from './coinGuard.js';
import { BB_DEFAULTS, clampBbCfg, applyBbFilter } from './bbFilter.js';
import { OkxWsManager, barToCandleChannel } from './okxWs.js';
import { loadEnvLocal } from './env.js';
import { OkxExecutor, demoKeysConfigured, liveKeysConfigured, keysConfiguredFor, reasonText, LIVE_MAX_LEVERAGE } from './executor.js';
import { createLocalAccess } from './localAuth.js';

// 启动时加载 server/.env.local（OKX_DEMO_* 模拟盘 / OKX_LIVE_* 实盘凭证；绝不打印值）
const envLoad = loadEnvLocal();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const MAX_LOG = 300; // 内存日志缓冲
const STATUS_LOG_LIMIT = 200; // /api/scan/status 返回最近条数
const OKX_REST = 'https://www.okx.com';
const CANDLE_BOOTSTRAP_LIMIT = 100;

const app = express();
const extraOrigins = String(process.env.LOCAL_UI_ORIGINS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const localAccess = createLocalAccess({ port: PORT, extraOrigins });
app.use(localAccess.originMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use(localAccess.mutationAuthMiddleware);

/** @type {Array<{ts:string,level:string,msg:string}>} */
const eventLog = [];

const DATA_DIR = join(__dirname, 'data');
const STATE_PATH = join(DATA_DIR, 'positions.json');
const LIVE_DIR = join(DATA_DIR, 'live');
const LIVE_STATE_PATH = join(LIVE_DIR, 'positions.json');
const EVENTS_LOG_PATH = join(DATA_DIR, 'events.log');
/** 同币冷却 / 止损过滤状态（重启后恢复） */
const COOLDOWN_PATH = join(DATA_DIR, 'cooldowns.json');
const EVENTS_LOG_MAX_BYTES = 20 * 1024 * 1024;
const PERSIST_LEVELS = new Set(['warn', 'error', 'buy', 'sell', 'tp', 'sl']);
const RECONCILE_MS = 20000;

let eventsLogWrites = 0;
/** 重要日志追加写入 server/data/events.log（按行 JSON，带时间），超过 20MB 轮转为 events.log.1 */
function persistEvent(entry) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    if (eventsLogWrites++ % 500 === 0 && existsSync(EVENTS_LOG_PATH) && statSync(EVENTS_LOG_PATH).size > EVENTS_LOG_MAX_BYTES) {
      renameSync(EVENTS_LOG_PATH, `${EVENTS_LOG_PATH}.1`);
    }
    const local = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false });
    appendFile(EVENTS_LOG_PATH, `${JSON.stringify({ ts: entry.ts, local, level: entry.level, msg: entry.msg })}\n`, 'utf8', () => {});
  } catch {
    /* 忽略磁盘错误 */
  }
}

function pushLog(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.length = MAX_LOG;
  if (PERSIST_LEVELS.has(level)) persistEvent(entry);
  return entry;
}

/** Windows cmd.exe 默认 GBK；按 UTF-8 读会变成 ◆ / �。优先 UTF-8，失败再按 gb18030。 */
function decodeChildOutput(buf) {
  if (!buf || !buf.length) return '';
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const utf8 = buffer.toString('utf8');
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return utf8;
  }
}

/** Resolve okx binary: prefer local `okx`, else npx via node（避开 Windows 路径空格） */
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
  const npxArgs = ['--yes', '@okx_ai/okx-trade-cli@latest'];
  // 走 node npx-cli.js，不要 spawn `C:\Program Files\nodejs\npx.cmd` + shell:true：
  // cmd.exe 会在空格处拆开，变成 `'C:\Program' 不是内部或外部命令`，再被 UTF-8 误读成乱码。
  const npxCliJs = join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (existsSync(npxCliJs)) {
    return { cmd: process.execPath, argsPrefix: [npxCliJs, ...npxArgs], shell: false };
  }
  const npxLocal = isWin ? join(nodeDir, 'npx.cmd') : join(nodeDir, 'npx');
  const npxCmd = existsSync(npxLocal) ? npxLocal : (isWin ? 'npx.cmd' : 'npx');
  if (isWin) {
    return {
      cmd: npxCmd.includes(' ') ? `"${npxCmd}"` : npxCmd,
      argsPrefix: npxArgs,
      shell: true,
    };
  }
  return { cmd: npxCmd, argsPrefix: npxArgs, shell: false };
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
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`okx 命令超时 (${timeoutMs}ms): ${fullArgs.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdoutChunks.push(d); });
    child.stderr.on('data', (d) => { stderrChunks.push(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = decodeChildOutput(Buffer.concat(stdoutChunks));
      const stderr = decodeChildOutput(Buffer.concat(stderrChunks));
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
  // 执行方式：sim=本地模拟（默认，永不下单）；okx_demo=OKX 模拟盘真实下单；okx_live=OKX 实盘（真实资金）。后两者仅永续
  exec_mode: 'sim',
  // 风控（服务端强制）
  daily_loss_limit_usdt: 50,
  max_orders_per_hour: 10,
  max_spread_pct: 0.3,
  // 需收盘确认：额外要求最近已收盘 K 线 RSI 也低于阈值（默认关闭）
  confirm_on_close: false,
  // 布林带下轨过滤（默认关闭）：打开后要求 RSI 已触发 且 实时价 < 下轨（扫描周期、bb_period 根、bb_mult 倍总体标准差）
  bb_filter_enabled: BB_DEFAULTS.bb_filter_enabled,
  bb_period: BB_DEFAULTS.bb_period,
  bb_mult: BB_DEFAULTS.bb_mult,
  // 永续专用（现货忽略）：固定多头 + 全仓 + USDT 下单，杠杆可选
  leverage: 1,
  tdMode: 'cross',
  posSide: 'long',
  order_ccy: 'USDT',
  minVolUsd24h: 300_000,
  universeLimit: 120,
  scanConcurrency: 6,
  refreshSec: 60,
  // 同币冷却：滚动窗口（sl_filter_hours 小时）内止损达 max_consecutive_sl 次 → 暂停 sl_filter_hours 小时（止盈不清零）
  max_consecutive_sl: GUARD_DEFAULTS.max_consecutive_sl,
  sl_filter_hours: GUARD_DEFAULTS.sl_filter_hours,
  // 普通止损后该币冷却（分钟）
  sl_cooldown_minutes: GUARD_DEFAULTS.sl_cooldown_minutes,
  // 严重止损阈值（价格变动 %，不含杠杆）与冷却（小时）
  severe_sl_pct: GUARD_DEFAULTS.severe_sl_pct,
  severe_sl_cooldown_hours: GUARD_DEFAULTS.severe_sl_cooldown_hours,
  watchlist: [],
};

/** 实盘保守默认值（请求里没带对应字段时套用） */
const LIVE_DEFAULTS = {
  amount: 20,
  leverage: 5,
  max_positions: 3,
  daily_loss_limit_usdt: 30,
  max_orders_per_hour: 5,
};

const EXEC_MODES = ['sim', 'okx_demo', 'okx_live'];
const EXCHANGE_MODES = ['okx_demo', 'okx_live'];
const LIVE_CONFIRM_TEXT = '确认实盘';

function isExchangeMode(m) {
  return m === 'okx_demo' || m === 'okx_live';
}

function normExecMode(m) {
  const v = String(m || '').toLowerCase();
  return EXEC_MODES.includes(v) ? v : 'sim';
}

function execModeText(m) {
  return m === 'okx_live' ? 'OKX 实盘（真实资金）' : m === 'okx_demo' ? 'OKX 模拟盘' : '本地模拟';
}

function envTextOf(m) {
  return m === 'okx_live' ? '实盘' : '模拟盘';
}

function clampConfig(body = {}) {
  const base = normExecMode(body?.exec_mode) === 'okx_live' ? { ...DEFAULT_SCAN, ...LIVE_DEFAULTS } : DEFAULT_SCAN;
  const cfg = { ...base, ...body };
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
  Object.assign(cfg, clampGuardCfg(cfg)); // max_consecutive_sl / sl_filter_hours / sl_cooldown_minutes / severe_sl_pct / severe_sl_cooldown_hours
  cfg.exec_mode = normExecMode(cfg.exec_mode);
  // profile 跟随执行方式：实盘=live，模拟盘=demo（本地模拟保留原值，永不下单）
  if (cfg.exec_mode === 'okx_live') cfg.profile = 'live';
  else if (cfg.exec_mode === 'okx_demo') cfg.profile = 'demo';
  if (cfg.exec_mode === 'okx_live') cfg.leverage = Math.min(cfg.leverage, LIVE_MAX_LEVERAGE);
  cfg.confirm_on_close = cfg.confirm_on_close === true || cfg.confirm_on_close === 'true' || cfg.confirm_on_close === 1;
  Object.assign(cfg, clampBbCfg(cfg)); // bb_filter_enabled / bb_period / bb_mult（旧配置缺字段 → 默认值）
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
/** 已开始但尚未完成本地入账的交易所开仓；key = `${exec_mode}:${instId}`。 */
const pendingOrders = new Map();
/** 同币冷却（普通止损 / 严重止损 / 窗口内多次止损），按执行模式分开，落盘 data/cooldowns.json */
const coinGuard = new CoinGuard({ path: COOLDOWN_PATH, log: (level, msg) => pushLog(level, msg) });
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

// ---------- OKX 执行（模拟盘 / 实盘）/ 风控 / 持久化 ----------
/** 每个交易所执行模式一个执行器：okx_demo（x-simulated-trading: 1）/ okx_live（真实资金） */
const executors = {
  okx_demo: new OkxExecutor({ log: pushLog, mode: 'okx_demo' }),
  okx_live: new OkxExecutor({ log: pushLog, mode: 'okx_live' }),
};
function execFor(mode) {
  return executors[mode === 'okx_live' ? 'okx_live' : 'okx_demo'];
}
/** WS 盘口：instId -> { bidPx, askPx, ts } */
const tickerBook = new Map();
/** 正在开仓中的 instId（异步下单期间占位，防止重复开仓/超出持仓上限） */
const pendingOpens = new Set();
/** 交易所上非本程序开的仓位（仅展示，不管理），按执行模式分开 */
const externalByMode = { okx_demo: [], okx_live: [] };
const riskState = {
  killSwitch: { on: false, at: null, reason: null },
  /** 开仓下单时间戳（毫秒），按执行模式分开，用于每小时下单上限 */
  orderTimesByMode: { sim: [], okx_demo: [], okx_live: [] },
};
const reconcileStates = {
  okx_demo: { busy: false, lastAt: null, error: null, startupDone: false },
  okx_live: { busy: false, lastAt: null, error: null, startupDone: false },
};
/**
 * 跳过冷却：startExchangeOpen 返回 skipped（或风控按币跳过）后，该币在冷却期内不再重试
 * instId -> { reason, at, until, exec_mode, kind }
 */
const lastSkip = new Map();
const SKIP_COOLDOWN_MS = { default: 10 * 60 * 1000, spread: 5 * 60 * 1000, no_quote: 5 * 60 * 1000, recheck: 60 * 1000, error: 5 * 60 * 1000 };
/** 实盘启动检查结果（仅本次扫描有效；未通过时绝不下实盘单） */
let liveGate = { ok: false, at: null, reasons: [], startedWith: null };
/** 模拟盘合约列表缓存（x-simulated-trading: 1 拉取 /api/v5/public/instruments?instType=SWAP） */
const demoInstCache = { set: null, at: 0, error: null };
const DEMO_INST_TTL_MS = 30 * 60 * 1000;
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

function orderTimesOf(mode) {
  const m = normExecMode(mode);
  if (!Array.isArray(riskState.orderTimesByMode[m])) riskState.orderTimesByMode[m] = [];
  return riskState.orderTimesByMode[m];
}

function ordersLastHour(mode) {
  const m = normExecMode(mode);
  const cut = Date.now() - 3600 * 1000;
  riskState.orderTimesByMode[m] = orderTimesOf(m).filter((t) => t > cut);
  return riskState.orderTimesByMode[m].length;
}

function recordOrderTime(mode) {
  orderTimesOf(mode).push(Date.now());
  ordersLastHour(mode);
  saveState();
}

function riskSnapshot(cfg = effectiveCfg(), modeOverride) {
  const execMode = normExecMode(modeOverride || cfg.exec_mode);
  const today = todayRealized(execMode);
  const limit = Number(cfg.daily_loss_limit_usdt) || 0;
  return {
    exec_mode: execMode,
    today_realized_usdt: today,
    daily_loss_limit_usdt: limit,
    daily_loss_hit: limit > 0 && today <= -limit,
    orders_last_hour: ordersLastHour(execMode),
    max_orders_per_hour: cfg.max_orders_per_hour,
    max_spread_pct: cfg.max_spread_pct,
    kill_switch: { ...riskState.killSwitch },
    pending_opens: [
      ...pendingOpens,
      ...[...pendingOrders.values()].filter((p) => p.exec_mode === execMode).map((p) => p.instId),
    ],
  };
}

function writeJsonAtomic(path, payload) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** 持久化：本地模拟/模拟盘 → data/positions.json；实盘 → data/live/positions.json */
function saveState() {
  try {
    const all = [...positions.values()];
    const pending = [...pendingOrders.values()];
    writeJsonAtomic(STATE_PATH, {
      updatedAt: new Date().toISOString(),
      positions: all.filter((p) => p.exec_mode !== 'okx_live'),
      killSwitch: riskState.killSwitch,
      orderTimesByMode: { sim: orderTimesOf('sim'), okx_demo: orderTimesOf('okx_demo') },
      pendingOrders: pending.filter((p) => p.exec_mode !== 'okx_live'),
    });
    const live = all.filter((p) => p.exec_mode === 'okx_live');
    if (live.length || pending.some((p) => p.exec_mode === 'okx_live') || existsSync(LIVE_STATE_PATH) || orderTimesOf('okx_live').length) {
      writeJsonAtomic(LIVE_STATE_PATH, {
        updatedAt: new Date().toISOString(),
        positions: live,
        orderTimes: orderTimesOf('okx_live'),
        pendingOrders: pending.filter((p) => p.exec_mode === 'okx_live'),
      });
    }
    return true;
  } catch (e) {
    logThrottled('save-state', 'warn', `持仓持久化失败：${e.message}`, 60000);
    return false;
  }
}

function pendingOrderKey(mode, instId) {
  return `${normExecMode(mode)}:${String(instId || '').toUpperCase()}`;
}

function pendingOrderFor(mode, instId) {
  return pendingOrders.get(pendingOrderKey(mode, instId)) || null;
}

function updatePendingOrder(event) {
  const mode = normExecMode(event?.exec_mode);
  const instId = String(event?.instId || '').toUpperCase();
  if (!isExchangeMode(mode) || !instId) return;
  const key = pendingOrderKey(mode, instId);
  if (event.action === 'clear') {
    const previous = pendingOrders.get(key);
    pendingOrders.delete(key);
    if (!saveState() && previous) pendingOrders.set(key, previous);
    return;
  }
  const previous = pendingOrders.get(key) || {};
  pendingOrders.set(key, {
    ...previous,
    ...event,
    action: undefined,
    exec_mode: mode,
    instId,
    updatedAt: new Date().toISOString(),
    createdAt: previous.createdAt || event.createdAt || new Date().toISOString(),
  });
  if (!saveState()) {
    if (Object.keys(previous).length) pendingOrders.set(key, previous);
    else pendingOrders.delete(key);
    throw new Error('无法持久化待确认订单，已禁止发送订单');
  }
}

function loadState() {
  try {
    let list = [];
    if (existsSync(STATE_PATH)) {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      list = (Array.isArray(raw?.positions) ? raw.positions : []).filter((p) => p && p.instId && p.exec_mode !== 'okx_live');
      if (raw?.killSwitch && typeof raw.killSwitch === 'object') {
        riskState.killSwitch = { on: !!raw.killSwitch.on, at: raw.killSwitch.at || null, reason: raw.killSwitch.reason || null };
      }
      const ot = raw?.orderTimesByMode;
      if (ot && typeof ot === 'object') {
        for (const m of ['sim', 'okx_demo']) {
          if (Array.isArray(ot[m])) riskState.orderTimesByMode[m] = ot[m].filter((t) => Number.isFinite(t));
        }
      } else if (Array.isArray(raw?.orderTimes)) {
        // 旧版本未区分模式：保守地同时计入本地模拟与模拟盘（1 小时后自然过期）
        const legacy = raw.orderTimes.filter((t) => Number.isFinite(t));
        riskState.orderTimesByMode.sim = [...legacy];
        riskState.orderTimesByMode.okx_demo = [...legacy];
      }
      for (const p of Array.isArray(raw?.pendingOrders) ? raw.pendingOrders : []) {
        if (p?.instId && isExchangeMode(p.exec_mode)) {
          pendingOrders.set(pendingOrderKey(p.exec_mode, p.instId), p);
        }
      }
    }
    let liveList = [];
    if (existsSync(LIVE_STATE_PATH)) {
      const rawLive = JSON.parse(readFileSync(LIVE_STATE_PATH, 'utf8'));
      liveList = (Array.isArray(rawLive?.positions) ? rawLive.positions : []).filter((p) => p && p.instId);
      for (const p of liveList) p.exec_mode = 'okx_live';
      if (Array.isArray(rawLive?.orderTimes)) riskState.orderTimesByMode.okx_live = rawLive.orderTimes.filter((t) => Number.isFinite(t));
      for (const p of Array.isArray(rawLive?.pendingOrders) ? rawLive.pendingOrders : []) {
        if (p?.instId) pendingOrders.set(pendingOrderKey('okx_live', p.instId), { ...p, exec_mode: 'okx_live' });
      }
    }
    for (const p of [...list, ...liveList]) {
      if (positions.has(p.instId)) {
        pushLog('warn', `持仓文件中 ${p.instId} 同时存在多个模式的记录，仅保留第一条（${execModeText(positions.get(p.instId).exec_mode)}）`);
        continue;
      }
      positions.set(p.instId, p);
    }
    const demo = list.filter((p) => p.exec_mode === 'okx_demo').length;
    if (list.length || liveList.length) {
      pushLog(
        'info',
        `已恢复持仓 ${list.length + liveList.length} 个（本地模拟 ${list.length - demo} · OKX 模拟盘 ${demo} · OKX 实盘 ${liveList.length}）`
      );
    }
    if (riskState.killSwitch.on) pushLog('warn', '急停状态已恢复：当前禁止开新仓（可在界面「解除急停」）');
    if (pendingOrders.size) pushLog('warn', `已恢复 ${pendingOrders.size} 个待确认订单，将在对账时自动核实并接管`);
  } catch (e) {
    pushLog('warn', `读取持仓文件失败：${e.message}`);
  }
}

/** 恢复同币冷却；首次启用（无 cooldowns.json）时按账本近期止损补建 */
function loadCoinGuard() {
  try {
    if (existsSync(COOLDOWN_PATH)) {
      const n = coinGuard.load(DEFAULT_SCAN);
      if (n > 0) pushLog('info', `已恢复同币冷却 ${n} 个（重启不影响冷却计时）`);
    } else {
      const trades = [];
      for (const m of EXEC_MODES) trades.push(...listTrades(200, m));
      const n = coinGuard.seedFromTrades(trades, DEFAULT_SCAN);
      pushLog('info', `首次启用同币冷却：已按账本近期止损补建 ${n} 个冷却`);
    }
    for (const it of coinGuard.list(DEFAULT_SCAN)) {
      pushLog('info', `[冷却] ${execModeText(it.exec_mode)} ${it.instId} ${it.kindText}，${it.remainingText}`);
    }
  } catch (e) {
    pushLog('warn', `恢复同币冷却失败：${e.message}`);
  }
}

function modePositions(mode) {
  return [...positions.values()].filter((p) => (p.exec_mode || 'sim') === mode);
}

function demoPositions() {
  return modePositions('okx_demo');
}

/** 界面查看的执行模式：显式传入优先，否则用当前扫描配置 */
function viewModeOf(req) {
  const q = req?.query?.exec_mode;
  return q ? normExecMode(q) : normExecMode(effectiveCfg().exec_mode);
}

function execPublic(cfg = effectiveCfg(), viewMode) {
  const mode = normExecMode(viewMode || cfg.exec_mode);
  const ex = isExchangeMode(mode) ? execFor(mode) : null;
  return {
    exec_mode: mode,
    exec_mode_text: execModeText(mode),
    is_live: mode === 'okx_live',
    keysConfigured: mode === 'sim' ? true : keysConfiguredFor(mode),
    demoKeysConfigured: demoKeysConfigured(),
    liveKeysConfigured: liveKeysConfigured(),
    account: ex ? ex.accountSummary() : null,
    posMode: ex ? ex.posMode : null,
    risk: riskSnapshot(cfg, mode),
    reconcile: ex ? { lastAt: reconcileStates[mode].lastAt, error: reconcileStates[mode].error } : null,
    live: {
      keysConfigured: liveKeysConfigured(),
      account: executors.okx_live.accountSummary(),
      gate: { ok: liveGate.ok, at: liveGate.at, reasons: liveGate.reasons },
      maxLeverage: LIVE_MAX_LEVERAGE,
      defaults: LIVE_DEFAULTS,
      confirmText: LIVE_CONFIRM_TEXT,
    },
    liveTradingActive: liveTradingActive(),
    liveAutoTradeDisabled: !liveTradingActive(),
  };
}

/** 实盘自动下单是否处于激活状态（扫描中 + okx_live + 启动检查通过） */
function liveTradingActive() {
  return !!(scanState?.running && scanState.config?.exec_mode === 'okx_live' && liveGate.ok);
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
      liveTradingActive: false,
      note: null,
      feed: feedMode,
      ws: wsPublicStatus(),
      filteredCount: listFilteredCoins(DEFAULT_SCAN).length,
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
    liveAutoTradeDisabled: !liveTradingActive(),
    liveTradingActive: liveTradingActive(),
    feed: feedMode,
    ws: wsPublicStatus(),
    exec_mode: scanState.config?.exec_mode || 'sim',
    killSwitch: riskState.killSwitch.on,
    note: scanNote(scanState.config),
  };
}

function scanNote(cfg) {
  if (!cfg) return null;
  if (cfg.exec_mode === 'okx_live') {
    return 'OKX 实盘真实下单（真实资金）· 交易所端 OCO 止盈止损 · 行情源 WebSocket';
  }
  if (cfg.exec_mode === 'okx_demo') {
    return 'OKX 模拟盘真实下单（x-simulated-trading: 1）· 交易所端 OCO 止盈止损 · 行情源 WebSocket';
  }
  return '本地模拟成交（不下任何真实订单）· 行情源 WebSocket';
}

// ---------- 模拟盘合约列表（universe 过滤用） ----------

/** 获取模拟盘存在的 USDT 永续合约集合（缓存 30 分钟；失败返回旧缓存或 null） */
async function getDemoSwapSet(force = false) {
  if (!force && demoInstCache.set && Date.now() - demoInstCache.at < DEMO_INST_TTL_MS) return demoInstCache.set;
  try {
    const ex = executors.okx_demo;
    const map = await ex.loadInstruments(true);
    const set = new Set([...map.values()].filter((i) => !i.state || i.state === 'live').map((i) => i.instId));
    if (set.size) {
      const prev = demoInstCache.set?.size || 0;
      demoInstCache.set = set;
      demoInstCache.at = Date.now();
      demoInstCache.error = null;
      if (prev !== set.size) {
        const usdt = [...set].filter((id) => id.endsWith('-USDT-SWAP')).length;
        pushLog('info', `[模拟盘] 合约列表已更新：SWAP 合约 ${set.size} 个（其中 USDT 永续 ${usdt} 个），全市场扫描只取模拟盘存在的合约`);
      }
    }
  } catch (e) {
    demoInstCache.error = e.message;
    logThrottled('demo-inst', 'warn', `[模拟盘] 获取模拟盘合约列表失败：${e.message}`, 5 * 60 * 1000);
  }
  return demoInstCache.set;
}

function demoUsdtSwapCount() {
  return demoInstCache.set ? [...demoInstCache.set].filter((id) => id.endsWith('-USDT-SWAP')).length : null;
}

function demoHasInst(instId) {
  return !demoInstCache.set || demoInstCache.set.has(instId);
}

// ---------- 跳过冷却 ----------

function activeSkip(instId) {
  const s = lastSkip.get(instId);
  if (!s) return null;
  if (s.until <= Date.now()) {
    lastSkip.delete(instId);
    return null;
  }
  return s;
}

function setSkip(instId, reason, kind = 'default', execMode = effectiveCfg().exec_mode, msOverride) {
  const ms = msOverride ?? SKIP_COOLDOWN_MS[kind] ?? SKIP_COOLDOWN_MS.default;
  const now = Date.now();
  lastSkip.set(instId, { reason, kind, at: now, until: now + ms, exec_mode: execMode });
  return ms;
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

async function fetchUniverseFromTickers(cfg, allow = null, excluded = null) {
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
    if (allow && !allow.has(instId)) {
      excluded?.add(instId); // 模拟盘不存在的合约
      continue;
    }
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

/**
 * 构建扫描 universe
 * - okx_demo：只保留模拟盘也存在的合约（模拟盘合约远少于实盘）；自选里模拟盘没有的仍保留，但行上不触发
 * - sim / okx_live：全市场
 * @returns {Promise<Array<object>>}（附加属性 demoFiltered：被排除的数量）
 */
async function fetchUniverse(cfg) {
  const limit = cfg.universeLimit;
  const minVol = cfg.minVolUsd24h;
  let allow = null;
  if (cfg.exec_mode === 'okx_demo' && cfg.mode === 'swap') {
    allow = await getDemoSwapSet();
    if (!allow) {
      pushLog('warn', '[模拟盘] 未能获取模拟盘合约列表，本次 universe 不做模拟盘过滤（模拟盘无此合约的币会在下单时跳过并冷却）');
    }
  }
  // 模拟盘过滤会去掉大量合约：先多取一些再过滤，保证最终接近 limit
  // okx CLI market filter 的 --limit 最大 100（超过返回 400），不足部分由 tickers 补足
  const fetchLimit = Math.min(100, allow ? Math.max(limit * 2, limit) : limit);
  const args =
    cfg.mode === 'swap'
      ? [
          'market', 'filter',
          '--instType', 'SWAP',
          '--settleCcy', 'USDT',
          '--quoteCcy', 'USDT',
          '--sortBy', 'volUsd24h',
          '--sortOrder', 'desc',
          '--limit', String(fetchLimit),
          '--minVolUsd24h', String(minVol),
        ]
      : [
          'market', 'filter',
          '--instType', 'SPOT',
          '--quoteCcy', 'USDT',
          '--sortBy', 'volUsd24h',
          '--sortOrder', 'desc',
          '--limit', String(fetchLimit),
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
          '--limit', String(fetchLimit),
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
  const demoExcluded = new Set();
  for (const r of rows) {
    let instId = String(r.instId || '').toUpperCase();
    if (!instId) continue;
    if (cfg.mode === 'swap') {
      if (!isUsdtSwap(instId)) continue;
    } else if (!isUsdtSpot(instId)) {
      continue;
    }
    if (isStablecoinInst(instId)) continue;
    if (allow && !allow.has(instId)) {
      demoExcluded.add(instId);
      continue;
    }
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
    const fb = await fetchUniverseFromTickers(cfg, allow, demoExcluded);
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

  // 自选优先保留（即使模拟盘没有，也保留以便显示「模拟盘无此合约」）
  const sorted = [...map.values()].sort((a, b) => (b.volUsd24h || 0) - (a.volUsd24h || 0));
  const watch = sorted.filter((u) => u.watchlist || (cfg.watchlist || []).includes(u.instId));
  const others = sorted.filter((u) => !watch.includes(u));
  const list = [...watch, ...others.slice(0, Math.max(0, limit - watch.length))];
  if (allow) {
    for (const u of list) u.onDemo = allow.has(u.instId);
    list.demoFiltered = demoExcluded.size;
    pushLog('info', `[模拟盘] universe 已按模拟盘合约过滤：保留 ${list.length} 个，排除模拟盘不存在的 ${demoExcluded.size} 个`);
  }
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
  return coinGuard.list(cfg || effectiveCfg());
}

/** 该币在指定执行模式下的冷却状态：null 或 { kind, until, remainingMs, reason, text } */
function coinCooldown(instId, mode = effectiveCfg().exec_mode) {
  return coinGuard.check(normExecMode(mode), instId);
}

function onTakeProfit(instId, mode) {
  // 止盈不再清零窗口内止损次数
  coinGuard.onTakeProfit(normExecMode(mode), instId);
}

/**
 * 止损 / 强平后进入冷却
 * @param {object} pos 平仓的持仓
 * @param {object} cfg
 * @param {{ pct?: number, at?: number, action?: string }} info pct=价格变动%（不含杠杆）
 */
function onStopLoss(pos, cfg, { pct = null, at = null, action = 'sl' } = {}) {
  return coinGuard.onStopLoss(normExecMode(pos.exec_mode), pos.instId, cfg, { lossPct: pct, at, liq: action === 'liq' });
}

/** 服务端风控：返回拒绝原因（中文），null 表示放行。perInst=true 表示只针对该币（进入跳过冷却） */
function riskBlockReason(cfg, instId) {
  if (riskState.killSwitch.on) return { key: 'kill', msg: '急停已开启，禁止开新仓' };
  const risk = riskSnapshot(cfg);
  if (risk.daily_loss_hit) {
    return {
      key: `daily-${cfg.exec_mode}-${new Date().toDateString()}`,
      msg: `${execModeText(cfg.exec_mode)} 今日已实现亏损 ${risk.today_realized_usdt.toFixed(2)} USDT 已达上限 ${risk.daily_loss_limit_usdt} USDT，今日停止开新仓`,
      ms: 24 * 3600 * 1000,
    };
  }
  if (risk.orders_last_hour >= cfg.max_orders_per_hour) {
    return { key: `orders-hour-${cfg.exec_mode}`, msg: `近 1 小时已下单 ${risk.orders_last_hour} 笔，达到上限 ${cfg.max_orders_per_hour}，暂停开新仓` };
  }
  if (isExchangeMode(cfg.exec_mode)) {
    if (cfg.exec_mode === 'okx_live' && !liveGate.ok) {
      return { key: 'live-gate', msg: '实盘启动检查未通过，禁止下实盘单' };
    }
    if ((externalByMode[cfg.exec_mode] || []).some((p) => p.instId === instId)) {
      return { key: `ext-${instId}`, msg: `${instId} 在${envTextOf(cfg.exec_mode)}已有外部持仓，不叠加开仓`, perInst: true, kind: 'default' };
    }
  } else {
    // 本地模拟：用 WS 盘口做点差检查（交易所模式在执行器内用对应环境盘口检查）
    const book = tickerBook.get(instId);
    if (book && book.askPx > 0 && book.bidPx > 0) {
      const mid = (book.askPx + book.bidPx) / 2;
      const spreadPct = ((book.askPx - book.bidPx) / mid) * 100;
      if (spreadPct > cfg.max_spread_pct) {
        return { key: `spread-${instId}`, msg: `${instId} 点差 ${spreadPct.toFixed(3)}% > 上限 ${cfg.max_spread_pct}%，跳过`, ms: 10 * 60 * 1000, perInst: true, kind: 'spread' };
      }
    }
  }
  return null;
}

/**
 * 尝试开仓
 * @returns {{status:'opened'|'submitted'|'submitting'|'held'|'skip', reason?:string, pos?:object}}
 */
function tryOpenPosition(signalRow, cfg) {
  const instId = signalRow.instId;
  const execMode = normExecMode(cfg.exec_mode);
  const held = positions.get(instId);
  if (held) {
    if ((held.exec_mode || 'sim') === execMode) return { status: 'held' };
    return { status: 'skip', reason: `已有${execModeText(held.exec_mode)}持仓，不叠加开仓` };
  }
  if (pendingOpens.has(instId)) return { status: 'submitting' };
  if (pendingOrderFor(execMode, instId)) {
    return { status: 'submitting', reason: '存在待交易所确认的订单，暂不重复下单' };
  }
  const cd = coinCooldown(instId, execMode);
  if (cd) return { status: 'skip', reason: cd.text, until: cd.until, cooldown: true, coinCooldown: cd.kind };
  const skip = activeSkip(instId);
  if (skip) return { status: 'skip', reason: skip.reason, cooldown: true };
  const count = modePositions(execMode).length;
  if (count + pendingOpens.size >= cfg.max_positions) {
    return { status: 'skip', reason: `持仓已满（${count}/${cfg.max_positions}）`, full: true };
  }
  if (signalRow.price == null || !Number.isFinite(signalRow.price)) return { status: 'skip', reason: '暂无有效价格' };
  if (execMode === 'okx_demo' && !demoHasInst(instId)) {
    return { status: 'skip', reason: '模拟盘无此合约' };
  }
  const block = riskBlockReason(cfg, instId);
  if (block) {
    logThrottled(`risk:${block.key}`, 'warn', `[风控] ${block.msg}`, block.ms);
    if (block.perInst) setSkip(instId, block.msg, block.kind || 'default', execMode);
    return { status: 'skip', reason: block.msg };
  }
  if (isExchangeMode(execMode)) {
    if (cfg.mode !== 'swap') return { status: 'skip', reason: `${execModeText(execMode)}仅支持永续` };
    // 安全：实盘只有在 okx_live 扫描运行中且启动检查通过时才会下单
    if (execMode === 'okx_live' && !liveTradingActive()) return { status: 'skip', reason: '实盘未激活（启动检查未通过或扫描未运行）' };
    startExchangeOpen(signalRow, cfg);
    return { status: 'submitted' };
  }
  // 本地模拟：永不下真实订单
  const pos = openSimPosition(signalRow, cfg);
  return pos ? { status: 'opened', pos } : { status: 'skip', reason: '本地模拟开仓失败' };
}

/** 跳过原因 → 冷却类别 */
function skipKindOf(r) {
  if (r?.skipKind === 'spread' || r?.skipKind === 'no_quote' || r?.skipKind === 'recheck') return r.skipKind;
  return 'default';
}

/** OKX 模拟盘 / 实盘异步开仓（不阻塞信号评估） */
async function startExchangeOpen(signalRow, cfg) {
  const instId = signalRow.instId;
  const execMode = cfg.exec_mode;
  const ex = execFor(execMode);
  const tag = ex.tag;
  pendingOpens.add(instId);
  try {
    const r = await ex.openLong({
      instId,
      amount: cfg.amount,
      leverage: cfg.leverage || 1,
      tpPct: cfg.take_profit_pct,
      slPct: cfg.stop_loss_pct,
      rsi: signalRow.rsi,
      rsiClosed: signalRow.rsiClosed ?? null,
      maxSpreadPct: cfg.max_spread_pct,
      profile: cfg.profile,
      onSubmit: () => recordOrderTime(execMode),
      onPending: updatePendingOrder,
      recheck: () => recheckBuyCondition(instId, execMode),
    });
    if (r.ok) {
      positions.set(instId, r.pos);
      // 先持久化已接管持仓，再清 pending；任一步崩溃都能在重启后继续恢复。
      if (saveState()) updatePendingOrder({ action: 'clear', exec_mode: execMode, instId });
      else throw new Error('成交后持仓落盘失败，pending 记录已保留等待对账');
      lastSkip.delete(instId);
      // 只有真正成交入账才计为「新开」
      pushLog('info', `${tag} 新开成交入账 1 | ${instId} | 持仓 ${modePositions(execMode).length}`);
      setTimeout(() => reconcileExchange(execMode).catch(() => {}), 3000);
    } else if (r.uncertain) {
      logThrottled(
        `pending:${execMode}:${instId}`,
        'warn',
        `${tag} ${instId} 订单结果尚未明确，已保留 pending 记录并暂停该币重复下单：${r.reason}`,
        60 * 1000
      );
    } else if (r.skipped) {
      if (r.skipKind === 'lock') return; // 并发保护，不冷却
      const kind = skipKindOf(r);
      const ms = setSkip(instId, r.reason, kind, execMode);
      logThrottled(`skip:${instId}:${r.reason}`, 'info', `${tag} 未开仓：${r.reason}（${Math.round(ms / 60000) || 1} 分钟内不再重试该币）`, ms);
    } else {
      const ms = setSkip(instId, r.reason, 'error', execMode);
      logThrottled(`skip:${instId}:${r.reason}`, 'warn', `${tag} 未开仓：${r.reason}（${Math.round(ms / 60000)} 分钟内不再重试该币）`, ms);
    }
  } catch (e) {
    if (pendingOrderFor(execMode, instId)) {
      pushLog('error', `${tag} ${instId} 开仓结果不明确：${e.message}；pending 记录已保留，等待自动对账，期间不会重复下单`);
    } else {
      const ms = setSkip(instId, `开仓失败：${e.message}`, 'error', execMode);
      pushLog('error', `${tag} ${instId} 开仓失败：${e.message}（${Math.round(ms / 60000)} 分钟内不再重试该币）`);
    }
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
    // 开仓时的止盈止损百分比快照：之后改设置不会追溯影响已有持仓
    take_profit_pct: cfg.take_profit_pct,
    stop_loss_pct: cfg.stop_loss_pct,
    rsi_at_entry: signalRow.rsi,
    rsi_closed_at_entry: signalRow.rsiClosed ?? null,
    at: new Date().toISOString(),
    simulated: true,
    exec_mode: 'sim',
    profile: cfg.profile,
    mode: cfg.mode,
    status: 'open',
  };
  positions.set(instId, pos);
  recordOrderTime('sim');

  const liveNote = ' | 本地模拟（未下真实订单）';
  const levNote =
    cfg.mode === 'swap'
      ? ` | 永续多头 全仓 ${leverage}x | 名义约 ${(amount * leverage).toFixed(0)} USDT`
      : '';
  pushLog(
    'buy',
    `[模拟买入] ${instId} @ ${entry} | 金额 ${amount} USDT${levNote} | 实时RSI=${signalRow.rsi?.toFixed?.(2) ?? signalRow.rsi ?? '—'} 收盘RSI=${signalRow.rsiClosed?.toFixed?.(2) ?? '—'} | 止盈 ${tp.toFixed(6)} | 止损 ${sl.toFixed(6)}${liveNote}`
  );
  return pos;
}

/** 持仓的止盈止损百分比：优先用开仓时的快照，老数据回落到当前配置 */
function exitPctOf(pos, cfg) {
  const tp = Number(pos.take_profit_pct);
  const sl = Number(pos.stop_loss_pct);
  return {
    tp: Number.isFinite(tp) && tp > 0 ? tp : Number(cfg.take_profit_pct),
    sl: Number.isFinite(sl) && sl > 0 ? sl : Number(cfg.stop_loss_pct),
  };
}

function checkExit(pos, price, cfg) {
  if (price == null || !Number.isFinite(price)) return null;
  // OKX 模拟盘/实盘持仓由交易所端 OCO 止盈止损负责平仓，本地绝不自行平仓
  if (isExchangeMode(pos.exec_mode)) return null;
  const { tp: tpPct, sl: slPct } = exitPctOf(pos, cfg);
  const profitPct = ((price - pos.entry_price) / pos.entry_price) * 100;
  if (profitPct >= tpPct) {
    const trade = recordClose(pos, price, 'tp', profitPct);
    pushLog(
      'tp',
      `[模拟止盈] ${pos.instId} 入场 ${pos.entry_price} → 现价 ${price} | 盈利 ${profitPct.toFixed(2)}% | 约 ${trade.pnl_usdt.toFixed(2)} USDT`
    );
    positions.delete(pos.instId);
    saveState();
    onTakeProfit(pos.instId, pos.exec_mode);
    return { action: 'tp', profitPct, pnl_usdt: trade.pnl_usdt };
  }
  if (profitPct <= -slPct) {
    const trade = recordClose(pos, price, 'sl', profitPct);
    pushLog(
      'sl',
      `[模拟止损] ${pos.instId} 入场 ${pos.entry_price} → 现价 ${price} | 亏损 ${profitPct.toFixed(2)}% | 约 ${trade.pnl_usdt.toFixed(2)} USDT`
    );
    positions.delete(pos.instId);
    saveState();
    onStopLoss(pos, cfg, { pct: profitPct, action: 'sl' });
    return { action: 'sl', profitPct, pnl_usdt: trade.pnl_usdt };
  }
  return null;
}

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

/** 下单前复核：读取最新 K 线快照重新计算（供交易所执行器在发单前调用） */
function recheckBuyCondition(instId, execMode) {
  if (!scanState?.running) return { ok: false, reason: '扫描已停止' };
  if (riskState.killSwitch.on) return { ok: false, reason: '急停已开启' };
  const cfg = scanState.config;
  if (execMode && cfg.exec_mode !== execMode) return { ok: false, reason: '执行方式已变化' };
  if (execMode === 'okx_live' && !liveTradingActive()) return { ok: false, reason: '实盘未激活' };
  const snap = candleStore.snapshot(instId);
  if (!snap) return { ok: false, reason: '无行情快照' };
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
    const bb = applyBbFilter(true, { closes: candleStore.closes(instId), price: snap.price }, cfg);
    if (!bb.signal) return { ok: false, rsi: rsiRt, rsiClosed, reason: bb.reason };
  }
  return { ok: true, rsi: rsiRt, rsiClosed };
}

/** 基于 candleStore 评估信号 / 止盈止损（不拉 CLI） */
function evaluateSignals({ quiet = false } = {}) {
  if (!scanState?.running) return;
  const cfg = scanState.config;
  const execMode = normExecMode(cfg.exec_mode);
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
    // 实时 RSI（含未收盘 K 线，即界面 RSI 列显示值）与已收盘 RSI
    const rsiClosed = snap.rsi;
    const rsiShow = snap.forming && snap.rsiForming != null ? snap.rsiForming : rsiClosed;
    const rsiValid = isValidRsi(rsiShow);
    const cd = coinCooldown(instId, execMode);
    const filtered = !!cd;
    // okx_demo：模拟盘不存在的合约（自选/持仓里的）永不触发
    const notOnDemo = execMode === 'okx_demo' && cfg.mode === 'swap' && !demoHasInst(instId);
    const sig = buySignalFromRsi(rsiShow, rsiClosed, cfg);
    const price = snap.price ?? uni?.price ?? null;
    // 布林带下轨过滤（开关关闭时 bb.signal === sig.signal，行为不变）：只在 RSI 已触发之后判断；
    // 被挡住时不进入开仓环节 → 不写跳过冷却、不影响同币冷却计数
    const bb = cfg.bb_filter_enabled
      ? applyBbFilter(sig.signal && !notOnDemo, { closes: candleStore.closes(instId), price }, cfg)
      : null;
    // 冷却中的币仍标记为触发，由开仓环节跳过并显示「冷却中：…，剩余xx分钟」
    const signal = sig.signal && !notOnDemo && (!bb || bb.signal);
    let signalText;
    if (notOnDemo) signalText = '模拟盘无此合约';
    else if (!rsiValid) signalText = 'RSI 无效（K 线不足或无数据）';
    else if (bb?.blocked) {
      signalText = `RSI 已触发，${bb.reason}`;
      if (!quiet) logThrottled(`bb:${instId}:${bb.kind}`, 'info', `${instId} RSI 已触发，${bb.reason}，不买入`, 30 * 60 * 1000);
    } else if (signal) {
      signalText = cfg.confirm_on_close
        ? '实时与收盘 RSI 均低于阈值（收盘确认），触发买入！'
        : snap.forming
          ? '实时 RSI 进入超卖区（含未收盘），触发买入！'
          : 'RSI 进入超卖区，触发买入！';
    } else if (sig.waitingClose) signalText = '实时 RSI 低于阈值，等待收盘确认';
    else signalText = '未触发';
    if (cd && !signal) signalText = `${signalText}（${cd.text}）`;
    rows.push({
      instId,
      volUsd24h: uni?.volUsd24h ?? 0,
      price,
      rsi: rsiShow,
      rsiClosed,
      forming: !!snap.forming,
      filtered,
      cooldown: cd ? { kind: cd.kind, until: new Date(cd.until).toISOString(), text: cd.text, reason: cd.reason } : null,
      notOnDemo,
      signal,
      signalText,
      bbLower: bb?.lower ?? null,
      bbBlocked: !!bb?.blocked,
      bbReason: bb?.blocked ? bb.reason : null,
      skipped: false,
      skipReason: null,
      skipUntil: null,
      submitting: false,
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

  // 止盈止损（仅本地模拟持仓；交易所持仓价格/盈亏由对账从交易所更新）
  for (const pos of [...positions.values()]) {
    const snap = candleStore.get(pos.instId);
    const price = snap?.price ?? null;
    if (isExchangeMode(pos.exec_mode)) {
      if (price != null) pos.ws_price = price;
      continue;
    }
    if (price != null) {
      pos.last_price = price;
      pos.profit_pct = ((price - pos.entry_price) / pos.entry_price) * 100;
      pos.take_profit_price = pos.entry_price * (1 + exitPctOf(pos, cfg).tp / 100);
      pos.stop_loss_price = pos.entry_price * (1 - exitPctOf(pos, cfg).sl / 100);
      checkExit(pos, price, cfg);
    }
  }

  // 开仓（逐个尝试，结果回写到信号行：跳过原因 / 提交中）
  const signalRows = rows.filter((r) => r.signal && r.ok);
  let opened = 0; // 真正成交入账（本地模拟立即入账）
  let submitted = 0; // 交易所模式：已提交、等待成交
  let fullLogged = false;
  for (const s of signalRows) {
    const res = tryOpenPosition(s, cfg);
    if (res.status === 'opened') opened++;
    else if (res.status === 'held') s.signalText = `${s.signalText}（已持仓）`;
    else if (res.status === 'submitted') {
      submitted++;
      s.submitting = true;
      s.signalText = '触发，正在提交订单…';
    } else if (res.status === 'submitting') {
      s.submitting = true;
      s.signalText = '触发，正在提交订单…';
    } else if (res.status === 'skip') {
      s.skipped = true;
      s.skipReason = res.reason || '未知原因';
      const sk = activeSkip(s.instId);
      s.skipUntil = res.until ? new Date(res.until).toISOString() : sk ? new Date(sk.until).toISOString() : null;
      s.signalText = `触发但未下单：${s.skipReason}`;
      if (res.full && !fullLogged && !quiet) {
        fullLogged = true;
        pushLog('info', `持仓已满 (${modePositions(execMode).length}/${cfg.max_positions})，仅监控止盈止损，不再新开`);
      }
    }
  }

  scanState.lastScanAt = now;
  scanState.error = null;

  const heldCount = modePositions(execMode).length;
  if (!quiet) {
    scanState.round = (scanState.round || 0) + 1;
    pushLog(
      'info',
      `信号评估 #${scanState.round}：有效 ${lastSignals.length} | 信号 ${signalRows.length} | ${isExchangeMode(execMode) ? '提交开仓' : '新开'} ${
        isExchangeMode(execMode) ? submitted : opened
      } | 持仓 ${positions.size} | WS ${wsPublicStatus().connected ? '已连接' : '重连中'}`
    );
  } else {
    if (opened > 0) pushLog('info', `推送触发新开 ${opened} | 持仓 ${heldCount}`);
    // 交易所模式：提交≠成交，成交入账后另有「新开成交入账」日志；提交日志节流
    if (submitted > 0) logThrottled('push-submit', 'info', `推送触发提交 ${submitted} 笔（等待成交后入账）| 持仓 ${heldCount}`, 30 * 1000);
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
    if (isExchangeMode(cfg.exec_mode)) {
      const ex = execFor(cfg.exec_mode);
      try {
        const acc = await ex.prepare();
        pushLog(
          'info',
          `${ex.tag} 连接成功 | 持仓模式 ${acc.posModeText || acc.posMode || '未知'} | 账户模式 ${acc.acctLvText || acc.acctLv || '未知'} | USDT 权益 ${fmtNum(acc.usdtEq)} | 可用 ${fmtNum(acc.usdtAvail)} | 合约规格 ${ex.instruments.size} 个`
        );
        if (cfg.exec_mode === 'okx_demo') await getDemoSwapSet(true);
        reconcileExchange(cfg.exec_mode).catch(() => {});
      } catch (e) {
        scanState.error = `OKX ${ex.envText}准备失败：${e.message}`;
        pushLog('error', `${ex.tag} 准备失败，已停止扫描：${e.message}`);
        stopScanInternal();
        return;
      }
    }
    pushLog(
      'info',
      `开始启动扫描 | mode=${cfg.mode} bar=${cfg.bar} channel=${barToCandleChannel(cfg.bar)} limit=${cfg.universeLimit}`
    );

    const universe = await fetchUniverse(cfg);
    if (!scanState?.running) return;
    lastUniverse = universe;
    pushLog('info', `Universe 构建完成：${universe.length} 个币（成交量过滤后${cfg.exec_mode === 'okx_demo' ? '，仅模拟盘存在的合约' : ''}）`);

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
  if (demoInstTimer) {
    clearInterval(demoInstTimer);
    demoInstTimer = null;
  }
  wsManager.stop();
  candleStore.clear();
  tickerBook.clear();
  if (scanState) scanState.running = false;
  liveGate = { ok: false, at: null, reasons: [], startedWith: null };
}

let demoInstTimer = null;

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

function finalizeExchangeClose(pos, res, { estimated = false } = {}) {
  const cfg = effectiveCfg();
  const ex = execFor(pos.exec_mode);
  const rtag = `[${ex.envText}对账]`;
  // 账本以交易所为准：整仓累计平仓张数 / 开仓均价 → 同步张数、名义与实际保证金
  if (!estimated && res.closeTotalPos > 0) {
    if (Math.abs(res.closeTotalPos - Number(pos.contracts)) > 1e-9) {
      pushLog('warn', `${rtag} ${pos.instId} 账本张数按交易所平仓记录修正：${pos.contracts} → ${res.closeTotalPos}`);
    }
    pos.contracts = res.closeTotalPos;
    if (res.openAvgPx > 0) pos.entry_price = res.openAvgPx;
    const ctVal = Number(pos.ctVal) || Number(ex.getInst(pos.instId)?.ctVal) || 0;
    if (ctVal > 0) {
      pos.notional_usdt = pos.contracts * ctVal * Number(pos.entry_price);
      pos.amount = pos.notional_usdt / Math.max(1, Number(pos.leverage) || 1);
    }
  }
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
    close_key: estimated ? null : res.close_key || null,
  });
  positions.delete(pos.instId);
  saveState();
  const level = res.action === 'tp' ? 'tp' : res.action === 'sl' || res.action === 'liq' ? 'sl' : 'sell';
  pushLog(
    level,
    `[${ex.envText}${reasonText(res.action)}] ${pos.instId} 入场 ${entry} → 平仓均价 ${fmtNum(exit, 8).replace(/\.?0+$/, '')} | ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% | 已实现 ${trade.pnl_usdt.toFixed(4)} USDT${
      estimated ? '（估算：未查到平仓记录）' : `（含手续费 ${fmtNum(res.fee, 4)}${res.fundingFee ? ` · 资金费 ${fmtNum(res.fundingFee, 4)}` : ''}）`
    }${res.inferred ? ' · 类型按价格推断' : ''}`
  );
  if (res.action === 'tp') onTakeProfit(pos.instId, pos.exec_mode);
  else if (res.action === 'sl' || res.action === 'liq') onStopLoss(pos, cfg, { pct, at: res.uTime || null, action: res.action });
  return trade;
}

function buildRecoveredPosition(pending, exchangePos, order, ex) {
  const saved = pending.pos ? { ...pending.pos } : {};
  const inst = ex.getInst(pending.instId);
  const contracts = Math.abs(Number(exchangePos?.pos) || Number(order?.accFillSz) || Number(saved.contracts) || 0);
  const entry = Number(exchangePos?.avgPx) || Number(order?.avgPx) || Number(saved.entry_price) || Number(pending.referencePrice) || 0;
  const leverage = Math.max(1, Number(pending.leverage) || Number(saved.leverage) || 1);
  const ctVal = Number(saved.ctVal) || Number(inst?.ctVal) || 0;
  const notional = contracts > 0 && ctVal > 0 && entry > 0 ? contracts * ctVal * entry : Number(saved.notional_usdt) || 0;
  return {
    ...saved,
    instId: pending.instId,
    exec_mode: pending.exec_mode,
    simulated: false,
    external: false,
    entry_price: entry,
    amount: notional > 0 ? notional / leverage : Number(pending.amount) || Number(saved.amount) || 0,
    leverage,
    tdMode: 'cross',
    posSide: exchangePos?.posSide || saved.posSide || 'net',
    order_ccy: 'USDT',
    contracts,
    contractsStr: ex.fmtContracts(pending.instId, contracts),
    ctVal,
    ctValCcy: saved.ctValCcy || inst?.ctValCcy || null,
    notional_usdt: notional,
    ordId: pending.ordId || saved.ordId || order?.ordId || null,
    clOrdId: pending.clOrdId || saved.clOrdId || order?.clOrdId || null,
    tp_pct: Number(pending.tpPct) || Number(saved.tp_pct) || effectiveCfg().take_profit_pct,
    sl_pct: Number(pending.slPct) || Number(saved.sl_pct) || effectiveCfg().stop_loss_pct,
    take_profit_price: saved.take_profit_price || (entry > 0 ? entry * (1 + Number(pending.tpPct || effectiveCfg().take_profit_pct) / 100) : null),
    stop_loss_price: saved.stop_loss_price || (entry > 0 ? entry * (1 - Number(pending.slPct || effectiveCfg().stop_loss_pct) / 100) : null),
    rsi_at_entry: pending.rsi ?? saved.rsi_at_entry ?? null,
    rsi_closed_at_entry: pending.rsiClosed ?? saved.rsi_closed_at_entry ?? null,
    at: saved.at || pending.createdAt || new Date().toISOString(),
    opened_ts: Number(saved.opened_ts) || new Date(pending.createdAt || Date.now()).getTime(),
    order_cts: Number(saved.order_cts) || Number(order?.cTime) || Number(order?.fillTime) || null,
    profile: pending.profile || saved.profile || (pending.exec_mode === 'okx_live' ? 'live' : 'demo'),
    mode: 'swap',
    status: saved.status || 'open',
    recovered_from_pending: true,
  };
}

/** 启动/网络异常后的 pending 订单恢复：交易所一旦有仓位或成交记录，就转为本程序管理的持仓。 */
async function recoverPendingOrders(mode, livePositions) {
  const ex = execFor(mode);
  const records = [...pendingOrders.values()].filter((p) => p.exec_mode === mode);
  for (const pending of records) {
    const existing = positions.get(pending.instId);
    if (existing) {
      if ((existing.exec_mode || 'sim') === mode) updatePendingOrder({ action: 'clear', exec_mode: mode, instId: pending.instId });
      else logThrottled(`pending-collision-${mode}-${pending.instId}`, 'error', `${ex.tag} ${pending.instId} pending 无法接管：同名合约已被 ${execModeText(existing.exec_mode)} 占用`, 60000);
      continue;
    }

    const xp = (livePositions || []).find(
      (p) => p.instId === pending.instId && Number(p.pos) !== 0 && (p.posSide === 'long' || (p.posSide === 'net' && Number(p.pos) > 0))
    );
    let order = null;
    if (!xp && (pending.ordId || pending.clOrdId)) {
      try {
        order = (await ex.client.getOrder(pending.instId, { ordId: pending.ordId, clOrdId: pending.clOrdId }))?.[0] || null;
      } catch (e) {
        logThrottled(`pending-query-${mode}-${pending.instId}`, 'warn', `${ex.tag} 核实 ${pending.instId} pending 订单失败：${e.message}`, 60000);
      }
    }

    const filled = Number(order?.accFillSz) > 0 && Number(order?.avgPx) > 0;
    if (pending.pos || xp || filled) {
      const pos = buildRecoveredPosition(pending, xp, order, ex);
      positions.set(pos.instId, pos);
      if (saveState()) updatePendingOrder({ action: 'clear', exec_mode: mode, instId: pending.instId });
      pushLog('warn', `${ex.tag} 已从 pending 恢复并接管 ${pending.instId}：${pos.contractsStr} 张 @ ${pos.entry_price || '待对账'}`);
      continue;
    }

    if (order && ['canceled', 'mmp_canceled'].includes(String(order.state || '')) && !(Number(order.accFillSz) > 0)) {
      updatePendingOrder({ action: 'clear', exec_mode: mode, instId: pending.instId });
      pushLog('info', `${ex.tag} ${pending.instId} pending 订单已确认取消且未成交，已清理`);
      continue;
    }

    logThrottled(
      `pending-wait-${mode}-${pending.instId}`,
      'warn',
      `${ex.tag} ${pending.instId} 订单结果仍未明确，继续保留 pending 并禁止重复下单（clOrdId=${pending.clOrdId || '—'}）`,
      5 * 60 * 1000
    );
  }
}

/** 对账（交易所为准）：mode = okx_demo / okx_live */
async function reconcileExchange(mode) {
  if (!isExchangeMode(mode)) return;
  const rs = reconcileStates[mode];
  const ex = execFor(mode);
  const rtag = `[${ex.envText}对账]`;
  if (rs.busy) return;
  const tracked0 = modePositions(mode);
  if (!keysConfiguredFor(mode)) {
    if (tracked0.length) {
      logThrottled(`recon-nokey-${mode}`, 'error', `${ex.tag} 有 ${tracked0.length} 个程序持仓，但未配置 ${ex.envText} API Key，无法对账/保护，请尽快检查！`, 10 * 60 * 1000);
    }
    return;
  }
  const cfg = effectiveCfg();
  if (cfg.exec_mode !== mode && tracked0.length === 0 && rs.startupDone) return;
  rs.busy = true;
  try {
    await ex.ensureTimeSync();
    if (!ex.accountConfig) await ex.refreshAccountConfig();
    try {
      await ex.loadInstruments(); // 合约规格（缓存 6 小时），用于张数/价格精度
    } catch (e) {
      logThrottled(`inst-load-${mode}`, 'warn', `${ex.tag} 读取合约规格失败：${e.message}`, 5 * 60 * 1000);
    }
    await ex.refreshBalance(true);
    const exPos = await ex.fetchPositions();
    const algos = await ex.fetchPendingAlgos();
    const live = (exPos || []).filter((p) => Number(p.pos) !== 0);
    const pendingAlgoIds = new Set((algos || []).map((a) => a.algoId));
    const pendingAlgoMap = new Map((algos || []).map((a) => [a.algoId, a]));

    await recoverPendingOrders(mode, live);

    for (const pos of modePositions(mode)) {
      const xp = live.find(
        (p) => p.instId === pos.instId && (pos.posSide === 'long' ? p.posSide === 'long' : p.posSide === 'net' && Number(p.pos) > 0)
      );
      const age = Date.now() - Number(pos.opened_ts || 0);
      if (xp) {
        const last = Number(xp.last) || Number(xp.markPx) || null;
        const exPos = Number(xp.pos);
        const exAvg = Number(xp.avgPx);
        // 交易所为准：张数 / 均价 / 名义 / 实际保证金
        if (exPos > 0 && (Math.abs(exPos - Number(pos.contracts)) > 1e-9 || (exAvg > 0 && Math.abs(exAvg - Number(pos.entry_price)) > 1e-12))) {
          const oldC = pos.contracts;
          const oldE = pos.entry_price;
          pos.contracts = exPos;
          pos.contractsStr = ex.fmtContracts(pos.instId, exPos);
          if (exAvg > 0) pos.entry_price = exAvg;
          const ctVal = Number(pos.ctVal) || Number(ex.getInst(pos.instId)?.ctVal) || 0;
          if (ctVal > 0) {
            pos.notional_usdt = exPos * ctVal * pos.entry_price;
            pos.amount = pos.notional_usdt / Math.max(1, Number(pos.leverage) || 1);
          }
          if (Math.abs(exPos - Number(oldC)) > 1e-9) {
            pushLog('warn', `${rtag} ${pos.instId} 张数 ${oldC} → ${exPos}（交易所为准），均价 ${oldE} → ${pos.entry_price}`);
          }
        }
        pos.last_price = last;
        pos.mark_price = Number(xp.markPx) || null;
        pos.upl = xp.upl !== '' && xp.upl != null ? Number(xp.upl) : null;
        pos.exchange_contracts = exPos;
        pos.liq_price = xp.liqPx ? Number(xp.liqPx) : null;
        pos.profit_pct = last && pos.entry_price ? ((last - pos.entry_price) / pos.entry_price) * 100 : null;
        pos.missingSince = null;
        // 已触发的保护单若 60 秒后仓位仍在（部分平仓等），恢复为 open 以重新挂保护
        if (pos.status === 'closing' && !pos.close_reason && pos.closing_since && Date.now() - pos.closing_since > 60000) {
          pos.status = 'open';
          pos.closing_since = null;
        }
        // 手动/急停/保护性平仓若只成交了一部分，保持保护单并按指数退避继续平剩余仓位。
        if (pos.status === 'closing' && pos.close_reason) {
          let attached = !!(pos.algoId && pendingAlgoMap.get(pos.algoId));
          let closeComplete = false;
          pos.tp_sl_attached = attached;
          const due = Date.now() >= Number(pos.close_next_retry_at || pos.close_last_submitted_at || 0);
          if (due) {
            try {
              const close = await ex.marketClose(pos, pos.close_reason);
              if (close.complete && pos.algoId) {
                await ex.cancelProtection(pos);
                attached = false;
              }
              closeComplete = close.complete;
              pushLog(
                close.complete ? 'sell' : 'warn',
                `${rtag} ${pos.instId} 自动重试平仓${close.complete ? '已完成，等待入账' : `后仍剩 ${close.remaining ?? '待确认'} 张`}`
              );
            } catch (e) {
              pos.close_last_error = e.message;
              pos.close_next_retry_at = Date.now() + Math.min(5 * 60 * 1000, 15000 * Math.pow(2, Math.min(Number(pos.close_attempts) || 0, 5)));
              pushLog('error', `${rtag} ${pos.instId} 自动重试平仓失败：${e.message}（保留/恢复保护单后继续重试）`);
            }
          }
          if (!closeComplete && !attached && pos.status === 'closing') {
            try {
              await ex.placeProtection(pos, pos.tp_pct ?? cfg.take_profit_pct, pos.sl_pct ?? cfg.stop_loss_pct);
              attached = true;
              pushLog('warn', `${rtag} ${pos.instId} 平仓尚未确认完成，已重新挂全仓止盈止损保护`);
            } catch (e) {
              pushLog('error', `${rtag} ${pos.instId} 剩余仓位保护单恢复失败：${e.message}（将继续自动平仓，请立即关注）`);
            }
          }
          continue;
        }
        if (pos.status === 'open') {
          const algo = pos.algoId ? pendingAlgoMap.get(pos.algoId) : null;
          const attached = !!algo;
          const full =
            attached &&
            (String(algo.closeFraction || '') === '1' || Math.abs(Number(algo.sz) - exPos) <= 1e-9);
          pos.tp_sl_attached = attached;
          pos.tp_sl_full = full;
          if (attached) {
            pos.algo_close_fraction = String(algo.closeFraction || '') === '1';
            pos.algo_sz = pos.algo_close_fraction ? null : algo.sz;
            pos.recovered_from_pending = false;
          }
          if (attached && !full && age > 5000) {
            // 止盈止损只覆盖部分仓位 → 撤销并按交易所均价重新挂全仓位 OCO；失败则保护性平仓
            pushLog('warn', `${rtag} ${pos.instId} 止盈止损仅覆盖 ${algo.sz} 张，交易所持仓 ${exPos} 张 → 撤销并重挂全仓位 OCO`);
            let cancelled = false;
            try {
              await ex.client.cancelAlgos([{ algoId: pos.algoId, instId: pos.instId }]);
              cancelled = true;
              pushLog('info', `${ex.tag} 已撤销 ${pos.instId} 部分仓位止盈止损 algoId=${pos.algoId}`);
            } catch (e) {
              pushLog('error', `${ex.tag} 撤销 ${pos.instId} 部分止盈止损失败：${e.message}（下轮对账重试）`);
            }
            if (cancelled) {
              pos.tp_sl_attached = false;
              pos.tp_sl_full = false;
              try {
                await ex.placeProtection(pos, pos.tp_pct ?? cfg.take_profit_pct, pos.sl_pct ?? cfg.stop_loss_pct);
              } catch (e) {
                pushLog('error', `${ex.tag} ${pos.instId} 重挂全仓位止盈止损失败：${e.message} → 保护性市价平仓`);
                pos.close_reason = 'failsafe';
                try {
                  await ex.marketClose(pos, 'failsafe');
                } catch (e2) {
                  pushLog('error', `${ex.tag} ${pos.instId} 保护性平仓失败：${e2.message}（请立即在 OKX ${ex.envText}手动处理！）`);
                }
              }
            }
          }
          if (!attached && (age > 15000 || pos.recovered_from_pending)) {
            // 保护单缺失：若已触发则等待交易所平仓；否则重新挂单，失败则保护性平仓
            let state = null;
            if (pos.algoId) {
              try {
                state = (await ex.client.getAlgoOrder({ algoId: pos.algoId }))?.[0]?.state || null;
              } catch {
                state = null;
              }
            }
            if (state === 'effective' || state === 'partially_effective') {
              pos.status = 'closing';
              pos.closing_since = Date.now();
            } else {
              pushLog('warn', `${ex.tag} ${pos.instId} 交易所止盈止损委托缺失（状态 ${state || '无'}），尝试重新挂单`);
              try {
                await ex.placeProtection(pos, pos.tp_pct ?? cfg.take_profit_pct, pos.sl_pct ?? cfg.stop_loss_pct);
                pos.recovered_from_pending = false;
              } catch (e) {
                pushLog('error', `${ex.tag} ${pos.instId} 重新挂止盈止损失败：${e.message} → 保护性市价平仓`);
                pos.close_reason = 'failsafe';
                try {
                  await ex.marketClose(pos, 'failsafe');
                } catch (e2) {
                  pushLog('error', `${ex.tag} ${pos.instId} 保护性平仓失败：${e2.message}（请立即在 OKX ${ex.envText}手动处理！）`);
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
          res = await ex.resolveClose(pos, usedCloseKeys(mode));
        } catch (e) {
          logThrottled(`resolve-${pos.instId}`, 'warn', `${ex.tag} 查询 ${pos.instId} 平仓记录失败：${e.message}`, 60000);
        }
        if (res) {
          finalizeExchangeClose(pos, res);
        } else if (Date.now() - pos.missingSince > 3 * 60 * 1000) {
          const exit = Number(pos.last_price) || Number(pos.entry_price);
          finalizeExchangeClose(
            pos,
            { closeAvgPx: exit, action: pos.close_reason || (exit >= pos.entry_price ? 'tp' : 'sl'), inferred: !pos.close_reason },
            { estimated: true }
          );
        } else {
          continue;
        }
        // 仓位已平但保护单仍挂着 → 撤销（避免孤儿委托）
        if (pos.algoId && pendingAlgoIds.has(pos.algoId)) await ex.cancelProtection(pos);
      }
    }

    const trackedKeys = new Set(modePositions(mode).map((p) => p.instId));
    externalByMode[mode] = live
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
    rs.error = null;
    ex.accountError = null;
  } catch (e) {
    rs.error = e.message;
    ex.accountError = e.message;
    logThrottled(`recon-err-${mode}`, 'warn', `${ex.tag} 对账失败：${e.message}`, 60000);
  } finally {
    rs.busy = false;
    rs.lastAt = new Date().toISOString();
    rs.startupDone = true;
  }
}

/** 启动扫描前的统一校验（同步部分）；返回 { status, error } 或 null */
function validateStart(rawBody, cfg, { route = 'scan' } = {}) {
  const rawExec = String(rawBody?.exec_mode ?? '').toLowerCase();
  if (rawExec && !EXEC_MODES.includes(rawExec)) {
    return { status: 400, error: `未知的执行方式「${rawExec}」，仅支持：本地模拟 / OKX 模拟盘 / OKX 实盘` };
  }
  if (isExchangeMode(cfg.exec_mode)) {
    const env = envTextOf(cfg.exec_mode);
    if (cfg.mode !== 'swap') {
      return { status: 400, error: `「OKX ${env}」执行目前仅支持 USDT 永续（swap）。现货请使用「本地模拟」。` };
    }
  }
  if (cfg.exec_mode === 'okx_live') {
    if (route !== 'scan') {
      return { status: 400, error: '实盘只能通过 /api/scan/start 启动（需要确认文字）' };
    }
    if (String(rawBody?.confirm_text ?? '') !== LIVE_CONFIRM_TEXT) {
      return { status: 400, error: `启动实盘必须在确认框中手动输入「${LIVE_CONFIRM_TEXT}」` };
    }
    const rawLev = Number(rawBody?.leverage);
    if (Number.isFinite(rawLev) && rawLev > LIVE_MAX_LEVERAGE) {
      return { status: 400, error: `实盘杠杆最高 ${LIVE_MAX_LEVERAGE}x，当前 ${rawLev}x，已拒绝启动` };
    }
    if (!liveKeysConfigured()) {
      return { status: 400, error: '未配置 OKX 实盘 API Key：请在 server/.env.local 填入 OKX_LIVE_API_KEY / OKX_LIVE_SECRET_KEY / OKX_LIVE_PASSPHRASE 后重启后端。' };
    }
  }
  if (cfg.exec_mode === 'okx_demo' && !demoKeysConfigured()) {
    return { status: 400, error: '未配置 OKX 模拟盘 API Key，请在 server/.env.local 填写 OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE 后重启后端。' };
  }
  if (riskState.killSwitch.on) {
    return { status: 409, error: '急停已开启，请先点击「解除急停」再开始扫描。' };
  }
  return null;
}

/**
 * 实盘启动检查（只读请求）：Key 已配置 / 无提现权限 / 账户模式 ≥ 合约模式 / 买卖模式(net_mode) / 可用 USDT ≥ 每笔保证金
 * @returns {Promise<{ok:boolean, reasons:string[], checks:Array<{key:string,label:string,ok:boolean,detail:string}>, account:object|null}>}
 */
async function liveStartChecks(cfg) {
  const ex = executors.okx_live;
  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok, detail });
  if (!liveKeysConfigured()) {
    add('keys', '实盘 API Key 已配置', false, '请在 server/.env.local 填入 OKX_LIVE_API_KEY / OKX_LIVE_SECRET_KEY / OKX_LIVE_PASSPHRASE 后重启后端');
    return { ok: false, reasons: checks.filter((c) => !c.ok).map((c) => c.detail), checks, account: ex.accountSummary() };
  }
  add('keys', '实盘 API Key 已配置', true, '已配置（不显示内容）');
  let acc = null;
  try {
    await ex.ensureTimeSync();
    await ex.refreshAccountConfig();
    await ex.refreshBalance(true);
    ex.accountError = null;
    acc = ex.accountSummary();
  } catch (e) {
    ex.accountError = e.message;
    add('account', '读取实盘账户', false, `读取实盘账户失败：${e.message}（请检查 Key 是否正确、是否绑定了本机 IP）`);
    return { ok: false, reasons: checks.filter((c) => !c.ok).map((c) => c.detail), checks, account: ex.accountSummary() };
  }
  const perms = String(ex.accountConfig?.perm || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (perms.includes('withdraw')) add('perm', 'Key 无提现权限', false, 'Key 开了提现权限，禁止启动（请在 OKX 重新创建只含「读取 + 交易」权限的 Key）');
  else add('perm', 'Key 无提现权限', true, `权限：${perms.join(' / ') || '未知'}`);
  if (!perms.includes('trade')) add('trade', 'Key 有交易权限', false, 'Key 没有交易权限，无法下单（创建 Key 时勾选「交易」）');
  else add('trade', 'Key 有交易权限', true, '有交易权限');
  const lv = Number(ex.accountConfig?.acctLv);
  if (!(lv >= 2)) {
    add('acctLv', '账户模式支持全仓永续', false, `当前账户模式为「${acc.acctLvText || ex.accountConfig?.acctLv || '未知'}」，无法做全仓永续：请在 OKX → 交易设置 → 账户模式 切换为「合约模式」（或跨币种/组合保证金）`);
  } else add('acctLv', '账户模式支持全仓永续', true, acc.acctLvText || String(lv));
  if (ex.accountConfig?.posMode !== 'net_mode') {
    add('posMode', '持仓模式为买卖模式（net_mode）', false, `当前持仓模式为「${acc.posModeText || ex.accountConfig?.posMode || '未知'}」：请在 OKX → 交易设置 → 持仓模式 改为「买卖模式（单向持仓）」（需先平掉所有永续仓位和挂单）`);
  } else add('posMode', '持仓模式为买卖模式（net_mode）', true, '买卖模式（单向持仓）');
  const avail = Number(acc.usdtAvail);
  if (!(Number.isFinite(avail) && avail >= Number(cfg.amount))) {
    add('balance', '可用 USDT 够一笔保证金', false, `实盘可用 USDT ${Number.isFinite(avail) ? avail.toFixed(2) : '未知'} < 每笔保证金 ${cfg.amount} USDT`);
  } else add('balance', '可用 USDT 够一笔保证金', true, `可用 ${avail.toFixed(2)} USDT ≥ ${cfg.amount} USDT`);
  if (ex.accountConfig && !ex.accountConfig.ipBound) {
    add('ip', '（建议）Key 已绑定 IP', true, '提示：该 Key 未绑定 IP，建议在 OKX 为 Key 绑定本机公网 IP');
  }
  const reasons = checks.filter((c) => !c.ok).map((c) => c.detail);
  return { ok: reasons.length === 0, reasons, checks, account: ex.accountSummary() };
}

// ---------- Routes ----------

/** 同源前端获取内存会话令牌；令牌每次后端重启都会变化，且不写入磁盘或日志。 */
app.get('/api/session', localAccess.sessionHandler);

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
      // 脱敏：隐藏任何疑似 Key/Secret 的长串，绝不把凭证返回给前端
      raw: text.replace(/[A-Za-z0-9+/=_-]{16,}/g, '***').slice(0, 1500),
      hint: /No profiles found/i.test(text)
        ? '未检测到 okx CLI profile（不影响扫描）。行情走 WebSocket/REST；OKX 模拟盘 / 实盘下单使用 server/.env.local 中的 Key。'
        : '已检测到 profile。行情源：WebSocket。真实下单只走 OKX 模拟盘 / OKX 实盘执行方式（Key 在 server/.env.local）。',
      liveAutoTradeDisabled: !liveTradingActive(),
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
    pushLog('info', `构建 Universe | mode=${cfg.mode} | exec=${cfg.exec_mode} | minVol=${cfg.minVolUsd24h} | limit=${cfg.universeLimit}`);
    const list = await fetchUniverse(cfg);
    // 扫描运行中不覆盖正在使用的 universe
    if (!scanState?.running) lastUniverse = list;
    res.json({
      ok: true,
      mode: cfg.mode,
      exec_mode: cfg.exec_mode,
      demoFiltered: list.demoFiltered ?? null,
      demoInstCount: cfg.exec_mode === 'okx_demo' ? demoInstCache.set?.size ?? null : null,
      demoUsdtSwapCount: cfg.exec_mode === 'okx_demo' ? demoUsdtSwapCount() : null,
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
    const bad = validateStart(req.body, cfg, { route: 'scan' });
    if (bad) {
      pushLog('warn', `拒绝开始扫描：${bad.error}`);
      return res.status(bad.status).json({ error: bad.error, liveAutoTradeDisabled: true });
    }
    let gate = null;
    if (cfg.exec_mode === 'okx_live') {
      gate = await liveStartChecks(cfg);
      if (!gate.ok) {
        pushLog('warn', `拒绝启动实盘：${gate.reasons.join('；')}`);
        return res.status(400).json({ error: `实盘启动检查未通过：${gate.reasons.join('；')}`, checks: gate.checks, liveAutoTradeDisabled: true });
      }
    }

    stopScanInternal();
    lastSkip.clear();
    if (gate) {
      liveGate = { ok: true, at: new Date().toISOString(), reasons: [], startedWith: { amount: cfg.amount, leverage: cfg.leverage } };
      pushLog(
        'warn',
        `[实盘] 启动检查通过，已确认「${LIVE_CONFIRM_TEXT}」：每笔保证金 ${cfg.amount} USDT × ${cfg.leverage}x（名义约 ${(cfg.amount * cfg.leverage).toFixed(0)} USDT）| 最大持仓 ${cfg.max_positions} | 日亏上限 ${cfg.daily_loss_limit_usdt} USDT | 每小时 ${cfg.max_orders_per_hour} 单`
      );
    }
    feedMode = 'websocket';
    scanState = {
      running: true,
      config: cfg,
      startedAt: new Date().toISOString(),
      lastScanAt: null,
      round: 0,
      error: null,
    };

    const liveNote = isExchangeMode(cfg.exec_mode)
      ? ` | 执行：${execModeText(cfg.exec_mode)}真实下单 | 风控：日亏上限 ${cfg.daily_loss_limit_usdt}U · 每小时 ${cfg.max_orders_per_hour} 单 · 点差 ≤${cfg.max_spread_pct}%`
      : ' | 本地模拟（不下真实订单）';
    pushLog(
      'info',
      `开始全市场扫描(WebSocket) mode=${cfg.mode} bar=${cfg.bar} 实时RSI<${cfg.rsi_buy_threshold}${cfg.confirm_on_close ? '（需收盘确认）' : ''}${
        cfg.bb_filter_enabled ? ` 且价<布林下轨(${cfg.bb_period},${cfg.bb_mult})` : ''
      } limit=${cfg.universeLimit} 评估间隔=${cfg.refreshSec}s${
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
    if (cfg.exec_mode === 'okx_demo') {
      // 定期刷新模拟盘合约列表（下架/新增）
      demoInstTimer = setInterval(() => {
        getDemoSwapSet(true).catch(() => {});
      }, DEMO_INST_TTL_MS);
    }

    res.json({
      ok: true,
      scan: publicScan(),
      liveAutoTradeDisabled: !liveTradingActive(),
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

app.get('/api/scan/status', (req, res) => {
  const posList = [...positions.values()];
  const cfg = effectiveCfg();
  const viewMode = viewModeOf(req);
  res.json({
    ok: true,
    scan: publicScan(),
    exec: execPublic(cfg, viewMode),
    exec_mode: cfg.exec_mode || 'sim',
    view_exec_mode: viewMode,
    externalPositions: isExchangeMode(viewMode) ? externalByMode[viewMode] : [],
    filtered: listFilteredCoins(scanState?.config || DEFAULT_SCAN),
    // 参数默认值（未启动扫描时 scan.config 为空，界面/校验可用这里的默认值）
    config_defaults: clampConfig({}),
    config_defaults_live: clampConfig({ exec_mode: 'okx_live' }),
    signals: lastSignals.slice(0, 100),
    positions: posList,
    pnl: buildPnLDashboard(posList, viewMode),
    universeSize: lastUniverse.length,
    universe: lastUniverse.map((u) => u.instId),
    demoInstCount: demoInstCache.set?.size ?? null,
    demoUsdtSwapCount: demoUsdtSwapCount(),
    logs: eventLog.slice(0, STATUS_LOG_LIMIT),
    liveAutoTradeDisabled: !liveTradingActive(),
    feed: feedMode,
    ws: wsPublicStatus(),
  });
});



app.get('/api/pnl', (req, res) => {
  res.json({ ok: true, ...buildPnLDashboard([...positions.values()], viewModeOf(req)) });
});

app.post('/api/pnl/clear', (req, res) => {
  const mode = normExecMode(req.body?.exec_mode || req.query?.exec_mode || effectiveCfg().exec_mode);
  clearTrades(mode);
  pushLog('info', `已清空盈亏账本（${execModeText(mode)}，仅历史平仓记录）`);
  res.json({ ok: true, pnl: buildPnLDashboard([...positions.values()], mode) });
});

app.get('/api/filtered', (_req, res) => {
  const cfg = scanState?.config || DEFAULT_SCAN;
  const list = listFilteredCoins(cfg);
  res.json({
    ok: true,
    count: list.length,
    max_consecutive_sl: cfg.max_consecutive_sl,
    sl_filter_hours: cfg.sl_filter_hours,
    sl_cooldown_minutes: cfg.sl_cooldown_minutes ?? GUARD_DEFAULTS.sl_cooldown_minutes,
    severe_sl_pct: cfg.severe_sl_pct ?? GUARD_DEFAULTS.severe_sl_pct,
    severe_sl_cooldown_hours: cfg.severe_sl_cooldown_hours ?? GUARD_DEFAULTS.severe_sl_cooldown_hours,
    items: list,
  });
});

app.post('/api/filtered/clear', (req, res) => {
  const instId = req.body?.instId ? String(req.body.instId).toUpperCase() : null;
  const mode = req.body?.exec_mode ? normExecMode(req.body.exec_mode) : null;
  if (instId) {
    coinGuard.clear(instId, mode);
    pushLog('info', `已手动解除冷却/过滤：${instId}${mode ? `（${execModeText(mode)}）` : ''}`);
  } else {
    coinGuard.clear(null, mode);
    pushLog('info', `已清空全部同币冷却/止损过滤${mode ? `（${execModeText(mode)}）` : ''}`);
  }
  res.json({ ok: true, items: listFilteredCoins(scanState?.config || DEFAULT_SCAN) });
});

app.get('/api/positions', (_req, res) => {
  const cfg = scanState?.config || DEFAULT_SCAN;
  const list = [...positions.values()].map((p) => {
    const price = isExchangeMode(p.exec_mode) ? p.last_price ?? null : p.last_price ?? candleStore.get(p.instId)?.price ?? null;
    const profitPct =
      price != null
        ? ((price - p.entry_price) / p.entry_price) * 100
        : p.profit_pct ?? null;
    return {
      ...p,
      last_price: price,
      profit_pct: profitPct,
      take_profit_price: p.take_profit_price ?? p.entry_price * (1 + exitPctOf(p, cfg).tp / 100),
      stop_loss_price: p.stop_loss_price ?? p.entry_price * (1 - exitPctOf(p, cfg).sl / 100),
    };
  });
  res.json({
    ok: true,
    positions: list,
    count: list.length,
    max_positions: cfg.max_positions,
    externalPositions: [...externalByMode.okx_demo, ...externalByMode.okx_live.map((p) => ({ ...p, exec_mode: 'okx_live' }))],
  });
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
  // 仅清除「本地模拟」持仓；OKX 模拟盘/实盘持仓以交易所为准，需用「急停并全部平仓」或在 OKX 平仓
  if (instId) {
    const id = normalizeInstId(instId, scanState?.config?.mode || 'spot');
    const p = positions.get(id);
    if (p && isExchangeMode(p.exec_mode)) {
      const env = envTextOf(p.exec_mode);
      return res.status(400).json({ error: `${id} 是 OKX ${env}持仓，不能本地清除；请使用「急停并全部平仓」或在 OKX ${env}平仓` });
    }
    positions.delete(id);
    pushLog('info', `已清除模拟持仓 ${instId}`);
  } else {
    let kept = 0;
    for (const [id, p] of [...positions.entries()]) {
      if (isExchangeMode(p.exec_mode)) kept++;
      else positions.delete(id);
    }
    if (monitor) {
      monitor.position = null;
      monitor.positionsCount = 0;
    }
    pushLog('info', `已清除全部本地模拟持仓${kept ? `（保留 OKX 模拟盘/实盘持仓 ${kept} 个，以交易所为准）` : ''}`);
  }
  saveState();
  res.json({ ok: true, positions: [...positions.values()] });
});

/** 手动平掉单个持仓：本地模拟按现价记账平仓；交易所持仓撤 OCO 后市价平仓并触发对账 */
app.post('/api/position/close', async (req, res) => {
  const raw = String(req.body?.instId || '').trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: 'instId 必填' });
  // 前端传的就是持仓里的 instId，先原样查；扫描停止时 scanState 为空，归一化会误删 -SWAP 后缀
  const instId = positions.has(raw)
    ? raw
    : normalizeInstId(raw, scanState?.config?.mode || (raw.endsWith('-SWAP') ? 'swap' : 'spot'));
  const pos = positions.get(instId);
  if (!pos) return res.status(404).json({ error: `${instId} 不在持仓中（可能已平仓）` });
  if (pos.status === 'closing') {
    return res.json({ ok: true, note: `${instId} 已在平仓中`, positions: [...positions.values()] });
  }

  if (isExchangeMode(pos.exec_mode)) {
    const ex = execFor(pos.exec_mode);
    try {
      pos.close_reason = 'manual';
      const close = await ex.marketClose(pos, 'manual'); // 内部按交易所持仓张数全平并确认剩余数量
      if (close.complete && pos.algoId) await ex.cancelProtection(pos);
      pushLog('sell', `[手动平仓] ${ex.envText} ${instId} 已提交市价平仓，${close.complete ? '等待对账入账' : '尚有剩余仓位，保护单已保留并将自动重试'}`);
      setTimeout(() => reconcileExchange(pos.exec_mode).catch(() => {}), 2500);
    } catch (e) {
      pos.close_reason = null;
      pushLog('error', `[手动平仓] ${ex.envText} ${instId} 平仓失败：${e.message}`);
      return res.status(502).json({ error: e.message });
    }
  } else {
    const price =
      Number(candleStore.get(instId)?.price) || Number(pos.last_price) || Number(pos.entry_price);
    const pct = ((price - pos.entry_price) / pos.entry_price) * 100;
    const trade = recordClose(pos, price, 'manual', pct);
    positions.delete(instId);
    pushLog(
      'sell',
      `[手动平仓·本地模拟] ${instId} @ ${price} | ${pct.toFixed(2)}% | 约 ${trade.pnl_usdt.toFixed(2)} USDT`
    );
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

  if (raw.execute) {
    return res.status(403).json({
      ok: false,
      error: '预览接口不会下单。真实下单只能通过「OKX 模拟盘 / OKX 实盘」执行方式开始扫描。',
      previewOnly: true,
      liveAutoTradeDisabled: !liveTradingActive(),
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
    reason: '预览（未实际发送订单）',
    preview,
    liveAutoTradeDisabled: !liveTradingActive(),
  });
});

// ---------- OKX 账户（模拟盘 / 实盘）/ 急停 ----------

/** 连通性测试（只读）：账户配置 + USDT 余额。?mode=okx_demo（默认）/ okx_live */
app.get('/api/account', async (req, res) => {
  const mode = String(req.query.mode || req.query.exec_mode || 'okx_demo') === 'okx_live' ? 'okx_live' : 'okx_demo';
  const ex = execFor(mode);
  const env = ex.envText;
  if (!keysConfiguredFor(mode)) {
    const vars = mode === 'okx_live' ? 'OKX_LIVE_API_KEY / OKX_LIVE_SECRET_KEY / OKX_LIVE_PASSPHRASE' : 'OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE';
    return res.json({
      ok: false,
      exec_mode: mode,
      keysConfigured: false,
      error: mode === 'okx_live' ? `请在 server/.env.local 填入实盘 Key（${vars}）后重启后端` : `未配置 OKX 模拟盘 API Key，请在 server/.env.local 填写 ${vars} 后重启后端`,
      account: ex.accountSummary(),
      liveAutoTradeDisabled: !liveTradingActive(),
    });
  }
  try {
    const account = await ex.refreshAccount();
    res.json({
      ok: true,
      exec_mode: mode,
      keysConfigured: true,
      simulated: mode !== 'okx_live',
      account,
      externalPositions: externalByMode[mode],
      trackedPositions: modePositions(mode).length,
      trackedDemoPositions: demoPositions().length,
      liveAutoTradeDisabled: !liveTradingActive(),
    });
  } catch (e) {
    pushLog('warn', `${ex.tag} 账户连通性测试失败：${e.message}`);
    res.json({ ok: false, exec_mode: mode, keysConfigured: true, error: e.message, account: ex.accountSummary(), liveAutoTradeDisabled: !liveTradingActive() });
  }
});

/** 实盘启动检查（只读，不下单）：供前端确认框展示 */
app.post('/api/live/check', async (req, res) => {
  try {
    const cfg = clampConfig({ ...(req.body || {}), exec_mode: 'okx_live' });
    const r = await liveStartChecks(cfg);
    res.json({
      ok: r.ok,
      reasons: r.reasons,
      checks: r.checks,
      account: r.account,
      summary: {
        amount: cfg.amount,
        leverage: cfg.leverage,
        notional: cfg.amount * cfg.leverage,
        max_positions: cfg.max_positions,
        daily_loss_limit_usdt: cfg.daily_loss_limit_usdt,
        max_orders_per_hour: cfg.max_orders_per_hour,
        take_profit_pct: cfg.take_profit_pct,
        stop_loss_pct: cfg.stop_loss_pct,
      },
      maxLeverage: LIVE_MAX_LEVERAGE,
      confirmText: LIVE_CONFIRM_TEXT,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 急停：停止开新仓 + 停止扫描；closeAll=true 时市价平掉本程序管理的模拟盘/实盘持仓（张数以交易所持仓为准）并撤销其止盈止损
 * 注：只处理本程序开的仓位；交易所上的外部仓位（手动开的）不会被平掉
 */
app.post('/api/kill', async (req, res) => {
  const closeAll = req.body?.closeAll === true;
  // 先记录本地模拟持仓最新价（停止扫描会清空行情缓存）
  for (const p of positions.values()) {
    if (!isExchangeMode(p.exec_mode)) {
      const px = candleStore.get(p.instId)?.price;
      if (px != null && Number.isFinite(px)) p.last_price = px;
    }
  }
  riskState.killSwitch = { on: true, at: new Date().toISOString(), reason: closeAll ? '急停并全部平仓' : '急停' };
  stopScanInternal();
  saveState();
  pushLog('error', `[急停] 已开启：禁止开新仓，已停止扫描${closeAll ? '，开始全部平仓（本地模拟 / 模拟盘 / 实盘）' : ''}`);

  const results = [];
  const touched = new Set();
  if (closeAll) {
    for (const pos of [...positions.values()]) {
      if (isExchangeMode(pos.exec_mode)) {
        const ex = execFor(pos.exec_mode);
        touched.add(pos.exec_mode);
        if (pos.status === 'closing' && pos.close_ordId) {
          results.push({ instId: pos.instId, ok: true, exec_mode: pos.exec_mode, note: '已在平仓中' });
          continue;
        }
        try {
          pos.close_reason = 'kill';
          const close = await ex.marketClose(pos, 'kill'); // 先平仓，确认完整后才撤保护，避免失败时裸仓
          if (close.complete && pos.algoId) await ex.cancelProtection(pos);
          results.push({ instId: pos.instId, ok: true, exec_mode: pos.exec_mode });
        } catch (e) {
          pushLog('error', `[急停] ${ex.envText} ${pos.instId} 平仓失败：${e.message}`);
          results.push({ instId: pos.instId, ok: false, error: e.message, exec_mode: pos.exec_mode });
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
    for (const m of touched) setTimeout(() => reconcileExchange(m).catch(() => {}), 2500);
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
    const bad = validateStart(req.body, cfg, { route: 'monitor' });
    if (bad) return res.status(bad.status).json({ error: bad.error, liveAutoTradeDisabled: true });
    stopScanInternal();
    lastSkip.clear();
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
    logs: eventLog.slice(0, STATUS_LOG_LIMIT),
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
loadCoinGuard();

app.listen(PORT, '127.0.0.1', () => {
  pushLog('info', `RSI抄底宝扫描后端已启动 :${PORT} · 行情源 WebSocket`);
  const envNote = envLoad.loaded ? '（server/.env.local 中缺少必要项）' : '（未找到 server/.env.local）';
  pushLog('info', demoKeysConfigured() ? 'OKX 模拟盘 API Key：已配置（不显示内容）' : `OKX 模拟盘 API Key：未配置${envNote}`);
  pushLog(
    'info',
    liveKeysConfigured()
      ? 'OKX 实盘 API Key：已配置（不显示内容）· 仅在选择「OKX 实盘」、通过启动检查并输入「确认实盘」后才会下实盘单'
      : `OKX 实盘 API Key：未配置${envNote} · 实盘不可用`
  );
  console.log(`[rsi-bottom-hunter] API http://127.0.0.1:${PORT}`);
  const runReconcileAll = () => {
    for (const m of EXCHANGE_MODES) reconcileExchange(m).catch(() => {});
  };
  runReconcileAll();
  setInterval(runReconcileAll, RECONCILE_MS);
});
