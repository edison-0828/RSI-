/**
 * RSI 趋势回调多空自动交易系统 — 全市场扫描后端
 * Universe → REST K 线 bootstrap → 已收盘 K 线计算 EMA/RSI/量能/ATR
 * → OKX WebSocket 驱动 → 回调恢复入场、目标区或趋势反转退出，ATR 灾难止损兜底
 */
import express from 'express';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFile, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CandleStore } from './candleStore.js';
import { recordClose, clearTrades, buildPnLDashboard, todayRealized, usedCloseKeys, listTrades } from './pnl.js';
import { CoinGuard, GUARD_DEFAULTS } from './coinGuard.js';
import { OkxWsManager, barToCandleChannel } from './okxWs.js';
import { loadEnvLocal } from './env.js';
import { resolveDataDir, dataDirOverridden } from './dataDir.js';
import { getStrategy, evaluateSafely } from './strategies/index.js';
import { RSI_PULLBACK_DEFAULTS } from './strategies/rsiPullback.js';
import { ctxFromStore } from './engine/signalAdapter.js';
import {
  profitPct as posProfitPct,
  takeProfitPrice,
  stopLossPrice,
  inferCloseAction,
  stopHit,
  openSide,
  closeSide,
  dirText,
  simRoundTrip,
  estLiqPrice,
} from './engine/positionMath.js';
import { withStrategyDefaults, backupOnce, needsUpgrade, isManagedPosition, ACTIVE_STRATEGY_ID, SCHEMA_VERSION } from './engine/normalize.js';
import { planTarget } from './engine/flipPlanner.js';
import { shortBlockReason, shortEnvFlags, shortEnvBlockReason, assertShortAllowed } from './engine/shortGate.js';
import { classifyPosition, matchExchangePos, exchangeRowDirection } from './engine/reconcileHelpers.js';
import { OkxExecutor, demoKeysConfigured, liveKeysConfigured, keysConfiguredFor, reasonText, LIVE_MAX_LEVERAGE } from './executor.js';
import { createLocalAccess } from './localAuth.js';

// 启动时加载 server/.env.local（OKX_DEMO_* 模拟盘 / OKX_LIVE_* 实盘凭证；绝不打印值）
// RSI_NO_ENV_LOCAL=1 时不读取 .env.local（测试 / 回放 / 升级演练用）
const envLoad = loadEnvLocal();

// ---------- 运行开关（均为环境变量，默认全部关闭） ----------
/** RSI_NO_LISTEN=1：import 本模块时不监听端口、不启动对账定时器（仅用于测试 / 演练） */
const NO_LISTEN = process.env.RSI_NO_LISTEN === '1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const MAX_LOG = 300; // 内存日志缓冲
const STATUS_LOG_LIMIT = 200; // /api/scan/status 返回最近条数
const OKX_REST = 'https://www.okx.com';
/** 启动时每币拉取的 15m K 线根数（OKX /market/candles 单次最多 300） */
const CANDLE_BOOTSTRAP_LIMIT = 300;

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

// 数据目录：RSI_DATA_DIR（新）> RSI_BOTTOM_HUNTER_DATA_DIR（旧）> server/data（默认，行为不变）
const DATA_DIR = resolveDataDir();
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
  mode: 'swap',
  profile: 'demo',
  // RSI 趋势回调参数（允许做空默认关闭）
  ...RSI_PULLBACK_DEFAULTS,
  // 灾难止损触发 / 强平后，该币对本策略冷却（分钟）；信号平仓不冷却
  disaster_cooldown_minutes: 60,
  // 入场信号有效期（秒）：超时信号只允许平仓，不追单
  signal_max_age_sec: 300,
  // 本地模拟成交成本：单边 taker 手续费 % 与每笔市价成交滑点 %（沿用回测口径 0.05 / 0.031）
  sim_fee_pct: 0.05,
  sim_slippage_pct: 0.031,
  max_positions: 5,
  amount: 100,
  // 执行方式：sim=本地模拟（默认，永不下单）；okx_demo=OKX 模拟盘真实下单；okx_live=OKX 实盘（真实资金）。后两者仅永续
  exec_mode: 'sim',
  // 风控（服务端强制）
  daily_loss_limit_usdt: 50,
  max_orders_per_hour: 10,
  max_spread_pct: 0.3,
  // 永续专用（现货忽略，且现货不能做空）：全仓 + USDT 下单，杠杆可选
  leverage: 1,
  tdMode: 'cross',
  order_ccy: 'USDT',
  minVolUsd24h: 300_000,
  universeLimit: 120,
  scanConcurrency: 6,
  refreshSec: 60,
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
const SHORT_CONFIRM_TEXT = '确认做空';

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

/** 唯一启用的策略 */
const STRATEGY = getStrategy(ACTIVE_STRATEGY_ID);
function strategyParams(cfg) {
  return STRATEGY.clamp(cfg);
}

function clampConfig(body = {}) {
  const base = normExecMode(body?.exec_mode) === 'okx_live' ? { ...DEFAULT_SCAN, ...LIVE_DEFAULTS } : DEFAULT_SCAN;
  const cfg = { ...base, ...body };
  cfg.mode = cfg.mode === 'spot' ? 'spot' : 'swap';
  cfg.profile = cfg.profile === 'live' ? 'live' : 'demo';
  Object.assign(cfg, strategyParams(cfg));
  cfg.disaster_cooldown_minutes = Math.max(0, Math.min(1440, Number.isFinite(Number(cfg.disaster_cooldown_minutes)) ? Number(cfg.disaster_cooldown_minutes) : 60));
  cfg.signal_max_age_sec = Math.max(30, Math.min(3600, Number(cfg.signal_max_age_sec) || 300));
  cfg.sim_fee_pct = Math.max(0, Math.min(1, Number.isFinite(Number(cfg.sim_fee_pct)) ? Number(cfg.sim_fee_pct) : 0.05));
  cfg.sim_slippage_pct = Math.max(0, Math.min(2, Number.isFinite(Number(cfg.sim_slippage_pct)) ? Number(cfg.sim_slippage_pct) : 0.031));
  cfg.max_positions = Math.max(1, Math.min(20, Number(cfg.max_positions) || 5));
  cfg.amount = Math.max(1, Number(cfg.amount) || 100);
  cfg.leverage = Math.max(1, Math.min(20, Math.round(Number(cfg.leverage) || 1)));
  cfg.tdMode = 'cross'; // 全仓（固定）
  cfg.order_ccy = 'USDT'; // 下单单位 USDT（固定）
  delete cfg.posSide; // 方向由每个信号决定（持仓上记录 direction），不再有全局固定方向
  cfg.minVolUsd24h = Math.max(0, Number(cfg.minVolUsd24h) || 300_000);
  cfg.universeLimit = Math.max(1, Math.min(200, Number(cfg.universeLimit) || 120));
  cfg.scanConcurrency = Math.max(1, Math.min(12, Number(cfg.scanConcurrency) || 6));
  // 信号评估间隔：WS 推送行情后，前端/后端评估节奏（可短）
  cfg.refreshSec = Math.max(2, Number(cfg.refreshSec) || Number(cfg.poll_interval_sec) || 60);
  cfg.exec_mode = normExecMode(cfg.exec_mode);
  // profile 跟随执行方式：实盘=live，模拟盘=demo（本地模拟保留原值，永不下单）
  if (cfg.exec_mode === 'okx_live') cfg.profile = 'live';
  else if (cfg.exec_mode === 'okx_demo') cfg.profile = 'demo';
  if (cfg.exec_mode === 'okx_live') cfg.leverage = Math.min(cfg.leverage, LIVE_MAX_LEVERAGE);
  {
    const dl = Number(cfg.daily_loss_limit_usdt);
    cfg.daily_loss_limit_usdt = Number.isFinite(dl) && dl >= 0 ? Math.min(dl, 1e9) : 50;
    const mo = Number(cfg.max_orders_per_hour);
    cfg.max_orders_per_hour = Number.isFinite(mo) && mo >= 1 ? Math.min(Math.round(mo), 1000) : 10;
    const sp = Number(cfg.max_spread_pct);
    cfg.max_spread_pct = Number.isFinite(sp) && sp > 0 ? Math.min(sp, 20) : 0.3;
  }
  // 清掉已淘汰策略字段，避免旧前端配置残留在内存配置里
  for (const k of [
    'atr_multiplier', 'atr_method', 'disaster_stop_pct', 'flip_only', 'warmup_bars',
    'rsi_buy_threshold', 'confirm_on_close', 'bb_filter_enabled', 'bb_period', 'bb_mult',
    'take_profit_pct', 'stop_loss_pct', 'max_consecutive_sl', 'sl_filter_hours', 'sl_cooldown_minutes', 'severe_sl_pct', 'severe_sl_cooldown_hours',
  ]) delete cfg[k];
  cfg.watchlist = Array.isArray(cfg.watchlist)
    ? cfg.watchlist.map((x) => normalizeInstId(x, cfg.mode)).filter(Boolean)
    : (cfg.instId ? [normalizeInstId(cfg.instId, cfg.mode)] : []);
  return cfg;
}

/** 当前时间（毫秒）。测试可通过 __test.setNow 注入，保证信号有效期 / 冷却 / 开仓时间可复现。 */
let nowFn = () => Date.now();
const nowMs = () => nowFn();

// ---------- Scan state ----------
/** @type {Map<string, object>} */
const positions = new Map();
/** 已开始但尚未完成本地入账的交易所开仓；key = `${exec_mode}:${instId}`。 */
const pendingOrders = new Map();
/** 同币冷却（普通止损 / 严重止损 / 窗口内多次止损），按执行模式分开，落盘 data/cooldowns.json */
const coinGuard = new CoinGuard({ path: COOLDOWN_PATH, log: (level, msg) => pushLog(level, msg), now: () => nowMs() });
/** @type {Array<object>} */
let lastSignals = [];
/** @type {Array<object>} */
let lastUniverse = [];
/** @type {null | object} */
let scanState = null;
let scanTimer = null;
let scanBusy = false;
let feedMode = 'websocket'; // 'websocket' | 'polling-legacy'

const candleStore = new CandleStore({ maxBars: 300 });
/** 已处理的策略信号：`模式|币` -> 信号 K 线开盘时间，重启后也不重复。 */
const handledSignals = new Map();
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
  const cut = nowMs() - 3600 * 1000;
  riskState.orderTimesByMode[m] = orderTimesOf(m).filter((t) => t > cut);
  return riskState.orderTimesByMode[m].length;
}

function recordOrderTime(mode) {
  orderTimesOf(mode).push(nowMs());
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
    const handled = Object.fromEntries(handledSignals);
    const hasShort = all.some((p) => p.direction === 'short') || pending.some((p) => p.direction === 'short');
    writeJsonAtomic(STATE_PATH, {
      schema_version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      positions: all.filter((p) => p.exec_mode !== 'okx_live'),
      killSwitch: riskState.killSwitch,
      orderTimesByMode: { sim: orderTimesOf('sim'), okx_demo: orderTimesOf('okx_demo') },
      pendingOrders: pending.filter((p) => p.exec_mode !== 'okx_live'),
      handledSignals: Object.fromEntries(Object.entries(handled).filter(([k]) => !k.startsWith('okx_live|'))),
      has_short: hasShort, // 回滚旧版本前必须确认没有空头持仓（旧版会把一切持仓当多头）
    });
    const live = all.filter((p) => p.exec_mode === 'okx_live');
    if (live.length || pending.some((p) => p.exec_mode === 'okx_live') || existsSync(LIVE_STATE_PATH) || orderTimesOf('okx_live').length) {
      writeJsonAtomic(LIVE_STATE_PATH, {
        schema_version: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        positions: live,
        orderTimes: orderTimesOf('okx_live'),
        pendingOrders: pending.filter((p) => p.exec_mode === 'okx_live'),
        handledSignals: Object.fromEntries(Object.entries(handled).filter(([k]) => k.startsWith('okx_live|'))),
        has_short: live.some((p) => p.direction === 'short'),
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

/** 已处理信号的键 */
function signalKey(mode, instId) {
  return `${normExecMode(mode)}|${instId}`;
}

/** 读文件并归一化：旧记录补 strategy_id=rsi_dip / direction=long；升级前保留一次备份。 */
function readStateFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const positionsRaw = Array.isArray(raw?.positions) ? raw.positions : [];
  const pendingRaw = Array.isArray(raw?.pendingOrders) ? raw.pendingOrders : [];
  const upgrade = raw?.schema_version !== SCHEMA_VERSION || positionsRaw.some(needsUpgrade) || pendingRaw.some(needsUpgrade);
  if (upgrade && backupOnce(path, '.bak-pre-v3')) {
    pushLog('info', `持仓文件已升级前备份：${path}.bak-pre-v3（旧持仓将保留为非当前策略持仓）`);
  }
  return {
    raw,
    positions: positionsRaw.filter((p) => p && p.instId).map((p) => withStrategyDefaults(p)),
    pending: pendingRaw.filter((p) => p && p.instId).map((p) => withStrategyDefaults(p)),
  };
}

function loadState() {
  try {
    let list = [];
    if (existsSync(STATE_PATH)) {
      const f = readStateFile(STATE_PATH);
      const raw = f.raw;
      list = f.positions.filter((p) => p.exec_mode !== 'okx_live');
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
      for (const p of f.pending) {
        if (isExchangeMode(p.exec_mode)) pendingOrders.set(pendingOrderKey(p.exec_mode, p.instId), p);
      }
      for (const [k, v] of Object.entries(raw?.handledSignals || raw?.handledFlips || {})) if (Number.isFinite(Number(v))) handledSignals.set(k, Number(v));
    }
    let liveList = [];
    if (existsSync(LIVE_STATE_PATH)) {
      const f = readStateFile(LIVE_STATE_PATH);
      liveList = f.positions;
      for (const p of liveList) p.exec_mode = 'okx_live';
      if (Array.isArray(f.raw?.orderTimes)) riskState.orderTimesByMode.okx_live = f.raw.orderTimes.filter((t) => Number.isFinite(t));
      for (const p of f.pending) pendingOrders.set(pendingOrderKey('okx_live', p.instId), { ...p, exec_mode: 'okx_live' });
      for (const [k, v] of Object.entries(f.raw?.handledSignals || f.raw?.handledFlips || {})) if (Number.isFinite(Number(v))) handledSignals.set(k, Number(v));
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
      const legacy = [...positions.values()].filter((p) => !isManagedPosition(p));
      if (legacy.length) {
        pushLog(
          'warn',
          `其中 ${legacy.length} 个是旧策略持仓（${legacy.map((p) => `${p.instId}/${dirText(p.direction)}/${p.strategy_id}`).join('、')}）：新版只对账、靠交易所保护单平仓，不执行当前策略信号，也不为其叠加仓位`
        );
      }
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
      try {
        const v = JSON.parse(readFileSync(COOLDOWN_PATH, 'utf8'))?.version;
        if (v !== 2 && backupOnce(COOLDOWN_PATH)) pushLog('info', `冷却文件已升级前备份：${COOLDOWN_PATH}.bak-pre-v2（旧条目归入 rsi_dip）`);
      } catch {
        /* 解析失败由 load 处理 */
      }
      const n = coinGuard.load(GUARD_DEFAULTS);
      if (n > 0) pushLog('info', `已恢复同币冷却 ${n} 个（重启不影响冷却计时）`);
    } else {
      const trades = [];
      for (const m of EXEC_MODES) trades.push(...listTrades(200, m));
      const n = coinGuard.seedFromTrades(trades, GUARD_DEFAULTS);
      pushLog('info', `首次启用同币冷却：已按账本近期止损补建 ${n} 个冷却`);
    }
    for (const it of coinGuard.list(GUARD_DEFAULTS)) {
      pushLog('info', `[冷却] ${execModeText(it.exec_mode)} ${it.instId}（${it.strategy_id}）${it.kindText}，${it.remainingText}`);
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

/** 做空能力（前端据此提示）：env=服务端环境变量是否放行；各模式是否实际可做空还需策略 allow_short */
function shortStatus() {
  const f = shortEnvFlags();
  return {
    env_allow_short: f.base,
    env_allow_short_live: f.live,
    block_reason: { sim: shortEnvBlockReason('sim'), okx_demo: shortEnvBlockReason('okx_demo'), okx_live: shortEnvBlockReason('okx_live') },
    confirmText: SHORT_CONFIRM_TEXT,
  };
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
    short: shortStatus(),
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

// ---------- 冷却 ----------

function listFilteredCoins(cfg) {
  return coinGuard.list(cfg || effectiveCfg());
}

/** 该币在指定执行模式 / 策略下的冷却状态：null 或 { kind, until, remainingMs, reason, text } */
function coinCooldown(instId, mode = effectiveCfg().exec_mode, strategyId = ACTIVE_STRATEGY_ID) {
  return coinGuard.check(normExecMode(mode), instId, strategyId);
}

/**
 * 平仓后冷却：
 *  - 当前 RSI 持仓：ATR 灾难止损 / 强平后冷却；策略信号、手动、急停平仓不冷却；
 *  - 旧 rsi_dip 持仓：沿用旧规则（onStopLoss，strategyId=rsi_dip），止盈不冷却。
 */
function applyCloseCooldown(pos, action, pct, at = null) {
  if (action !== 'sl' && action !== 'liq') return null;
  const cfg = effectiveCfg();
  const mode = normExecMode(pos.exec_mode);
  if (isManagedPosition(pos)) {
    return coinGuard.onDisasterStop(mode, pos.instId, {
      strategyId: pos.strategy_id,
      minutes: cfg.disaster_cooldown_minutes,
      at,
      lossPct: pct,
      liq: action === 'liq',
    });
  }
  return coinGuard.onStopLoss(mode, pos.instId, cfg, { lossPct: pct, at, liq: action === 'liq', strategyId: pos.strategy_id });
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

// ---------- 占用判定 / 策略信号处理 ----------

/** 该币的占用情况：kind='busy'（暂时忙：待确认订单 / 正在平仓，稍后重试）或 'occupied'（旧策略 / 外部 / 其他模式持仓，本策略不碰） */
function occupiedInfo(instId, execMode) {
  const held = positions.get(instId);
  if (held) {
    if ((held.exec_mode || 'sim') !== execMode) return { kind: 'occupied', reason: `已有${execModeText(held.exec_mode)}持仓，不叠加开仓` };
    if (!isManagedPosition(held)) {
      return { kind: 'occupied', reason: `该币已有旧策略持仓（${held.strategy_id} / ${dirText(held.direction)}头），当前 RSI 策略不接管、不叠加` };
    }
    if (held.status === 'closing') return { kind: 'busy', reason: '该币持仓正在平仓处理中' };
  }
  if (pendingOpens.has(instId) || pendingOrderFor(execMode, instId)) return { kind: 'busy', reason: '该币有待交易所确认的订单' };
  if (isExchangeMode(execMode) && (externalByMode[execMode] || []).some((p) => p.instId === instId)) {
    return { kind: 'occupied', reason: `${instId} 在${envTextOf(execMode)}已有外部持仓，不叠加开仓` };
  }
  return null;
}

function markHandled(execMode, instId, ts) {
  handledSignals.set(signalKey(execMode, instId), Number(ts));
  saveState();
}

function metaFromSignal(row, event, decision, cfg) {
  return {
    ...(decision.meta || {}),
    signal_bar_ts: event.ts,
    signal_close_at: event.closeAt,
    signal_close: event.close ?? null,
    signal_kind: event.kind || null,
    signal_price: row.price ?? null,
    trend: row.trend ?? null,
    rsi: row.rsi ?? null,
    ema: row.ema ?? null,
    atr: row.atr ?? null,
    volume_ratio: row.volumeRatio ?? null,
    params: { rsi_period: cfg.rsi_period, ema_period: cfg.ema_period, atr_period: cfg.atr_period, atr_stop_mult: cfg.atr_stop_mult, bar: cfg.bar },
  };
}

// ---------- 本地模拟成交（含滑点 / 手续费 / 做空 / 强平价估算） ----------

/** 市价成交价：买入向上滑、卖出向下滑 */
function simFillPrice(price, side, slippagePct) {
  const s = (Number(slippagePct) || 0) / 100;
  return side === 'buy' ? price * (1 + s) : price * (1 - s);
}

function openSimPosition({ instId, direction, price, cfg, meta = null, slPct = null }) {
  assertShortAllowed(direction, 'sim'); // 第 3 层做空断言
  const slip = cfg.sim_slippage_pct;
  const entry = simFillPrice(price, openSide(direction), slip);
  const leverage = cfg.mode === 'swap' ? cfg.leverage || 1 : 1;
  const amount = cfg.amount;
  const notional = amount * leverage;
  const safeSlPct = Number(slPct) > 0 ? Number(slPct) : null;
  const sl = safeSlPct ? stopLossPrice(entry, safeSlPct, direction) : null;
  const liq = cfg.mode === 'swap' && leverage > 1 ? estLiqPrice(entry, leverage, direction) : null;
  const feeOpen = (notional * cfg.sim_fee_pct) / 100;
  const pos = {
    instId,
    direction,
    strategy_id: ACTIVE_STRATEGY_ID,
    strategy_version: STRATEGY.version,
    signal_meta: meta,
    entry_price: entry,
    signal_price: price,
    amount,
    leverage,
    notional_usdt: notional,
    tdMode: cfg.mode === 'swap' ? 'cross' : null,
    posSide: cfg.mode === 'swap' ? 'net' : null,
    order_ccy: 'USDT',
    take_profit_price: null,
    stop_loss_price: sl,
    sl_pct: safeSlPct,
    tp_pct: null,
    liq_price: liq,
    sim_fee_pct: cfg.sim_fee_pct,
    sim_slippage_pct: slip,
    fee_open_usdt: feeOpen,
    at: new Date().toISOString(),
    opened_ts: nowMs(),
    simulated: true,
    exec_mode: 'sim',
    profile: cfg.profile,
    mode: cfg.mode,
    status: 'open',
  };
  positions.set(instId, pos);
  recordOrderTime('sim');
  pushLog(
    'buy',
    `[模拟${direction === 'long' ? '开多' : '开空'}] ${instId} @ ${entry}（信号价 ${price}，滑点 ${slip}%） | 保证金 ${amount} USDT × ${leverage}x | 名义 ${notional.toFixed(0)} USDT | 开仓手续费 ${feeOpen.toFixed(4)} | ATR 灾难止损 ${sl != null ? `${sl.toPrecision(7)}（${safeSlPct.toFixed(2)}%）` : '关闭'}${liq ? ` | 估算强平价 ${liq.toPrecision(7)}` : ''} | RSI 回调入场 | 本地模拟（未下真实订单）`
  );
  return pos;
}

/**
 * 本地模拟平仓。action: signal / sl / liq / tp(旧持仓) / manual / kill
 * 成交价 = 现价 ± 滑点（强平按强平价）；盈亏 = 方向收益 − 开平仓手续费，强平最多亏光保证金。
 */
function closeSimPosition(pos, price, action, cfg = effectiveCfg()) {
  const dir = pos.direction === 'short' ? 'short' : 'long';
  const slip = pos.sim_slippage_pct ?? cfg.sim_slippage_pct;
  const feePct = pos.sim_fee_pct ?? cfg.sim_fee_pct;
  const exit = action === 'liq' && Number(pos.liq_price) > 0 ? Number(pos.liq_price) : simFillPrice(price, closeSide(dir), slip);
  const notional = Number(pos.notional_usdt) || (Number(pos.amount) || 0) * Math.max(1, Number(pos.leverage) || 1);
  const rt = simRoundTrip({ notional, entry: pos.entry_price, exit, dir, feePct });
  let net = rt.net;
  if (action === 'liq') net = -(Number(pos.amount) || 0); // 强平：保守按亏光全部保证金记账
  const trade = recordClose(pos, exit, action, rt.pct, {
    pnl_usdt: net,
    fee_usdt: rt.fee,
    gross_pnl_usdt: rt.gross,
    fee_open_usdt: rt.feeOpen,
    sim: true,
    sim_slippage_pct: slip,
  });
  positions.delete(pos.instId);
  saveState();
  const text = action === 'signal' || action === 'flip' ? '策略信号平仓' : action === 'sl' ? '灾难止损' : action === 'liq' ? '强平' : action === 'tp' ? '止盈' : action === 'kill' ? '急停平仓' : '手动平仓';
  pushLog(
    action === 'tp' ? 'tp' : action === 'sl' || action === 'liq' ? 'sl' : 'sell',
    `[模拟${text}] ${pos.instId} ${dirText(dir)}头 入场 ${pos.entry_price} → 成交 ${exit} | ${rt.pct >= 0 ? '+' : ''}${rt.pct.toFixed(2)}% | 净盈亏 ${net.toFixed(4)} USDT（毛 ${rt.gross.toFixed(4)} − 手续费 ${rt.fee.toFixed(4)}）`
  );
  applyCloseCooldown(pos, action, rt.pct);
  return trade;
}

/** 模拟持仓的灾难止损 / 强平 / （旧持仓）止盈检查。返回触发的 action 或 null */
function checkSimExit(pos, price) {
  if (price == null || !Number.isFinite(price) || isExchangeMode(pos.exec_mode)) return null;
  const dir = pos.direction === 'short' ? 'short' : 'long';
  let action = null;
  if (Number(pos.liq_price) > 0 && stopHit(price, Number(pos.liq_price), dir)) action = 'liq';
  else if (Number(pos.stop_loss_price) > 0 && stopHit(price, Number(pos.stop_loss_price), dir)) action = 'sl';
  else if (Number(pos.take_profit_price) > 0 && (dir === 'long' ? price >= pos.take_profit_price : price <= pos.take_profit_price)) action = 'tp';
  if (!action) return null;
  closeSimPosition(pos, price, action);
  return action;
}

// ---------- OKX 模拟盘 / 实盘：开平仓（异步，不阻塞信号评估） ----------

/** 下单前复核：仍在扫描、未急停，并且同一根已收盘 K 线仍给出同方向入场。 */
function recheckSignalEntry(instId, execMode, direction, signalTs) {
  if (!scanState?.running) return { ok: false, reason: '扫描已停止' };
  if (riskState.killSwitch.on) return { ok: false, reason: '急停已开启' };
  const cfg = scanState.config;
  if (execMode && cfg.exec_mode !== execMode) return { ok: false, reason: '执行方式已变化' };
  if (execMode === 'okx_live' && !liveTradingActive()) return { ok: false, reason: '实盘未激活' };
  const snap = candleStore.snapshot(instId);
  if (!snap) return { ok: false, reason: '无行情快照' };
  const params = strategyParams(cfg);
  const ctx = ctxFromStore(candleStore, instId, params, { phase: 'recheck', price: snap.price, tradable: true, heldDirection: null });
  const decision = evaluateSafely(STRATEGY, ctx);
  if (!decision?.signal || decision.target !== direction || Number(decision.metrics?.signalTs) !== Number(signalTs)) {
    return { ok: false, reason: 'RSI 入场信号已变化' };
  }
  if (direction === 'short') {
    const b = shortBlockReason({ direction, execMode, tradeMode: cfg.mode, cfgAllowShort: cfg.allow_short });
    if (b) return { ok: false, reason: b };
  }
  return { ok: true };
}

/** OKX 模拟盘 / 实盘开仓一腿（调用方负责 pendingOpens 占位） */
async function startExchangeOpen({ instId, direction, event, meta, slPct }, cfg) {
  const execMode = cfg.exec_mode;
  const ex = execFor(execMode);
  const tag = ex.tag;
  try {
    const r = await ex.openPosition({
      instId,
      direction,
      amount: cfg.amount,
      leverage: cfg.leverage || 1,
      tpPct: null,
      slPct: Number(slPct) > 0 ? Number(slPct) : null,
      strategyId: ACTIVE_STRATEGY_ID,
      strategyVersion: STRATEGY.version,
      signalMeta: meta,
      maxSpreadPct: cfg.max_spread_pct,
      profile: cfg.profile,
      onSubmit: () => recordOrderTime(execMode),
      onPending: updatePendingOrder,
      recheck: () => recheckSignalEntry(instId, execMode, direction, event?.ts),
    });
    if (r.ok) {
      positions.set(instId, r.pos);
      // 先持久化已接管持仓，再清 pending；任一步崩溃都能在重启后继续恢复。
      if (saveState()) updatePendingOrder({ action: 'clear', exec_mode: execMode, instId });
      else throw new Error('成交后持仓落盘失败，pending 记录已保留等待对账');
      lastSkip.delete(instId);
      pushLog('info', `${tag} 新开成交入账（${dirText(direction)}头）| ${instId} | 持仓 ${modePositions(execMode).length}`);
      setTimeout(() => reconcileExchange(execMode).catch(() => {}), 3000);
    } else if (r.uncertain) {
      logThrottled(`pending:${execMode}:${instId}`, 'warn', `${tag} ${instId} 订单结果尚未明确，已保留 pending 记录并暂停该币重复下单：${r.reason}`, 60 * 1000);
    } else if (r.skipped) {
      if (r.skipKind === 'lock') return;
      pushLog('info', `${tag} 未开仓（${dirText(direction)}头）：${r.reason}`);
    } else {
      pushLog('warn', `${tag} 未开仓（${dirText(direction)}头）：${r.reason}`);
    }
  } catch (e) {
    if (pendingOrderFor(execMode, instId)) {
      pushLog('error', `${tag} ${instId} 开仓结果不明确：${e.message}；pending 记录已保留，等待自动对账，期间不会重复下单`);
    } else {
      pushLog('error', `${tag} ${instId} 开仓失败：${e.message}`);
    }
  }
}

/** 信号平仓落账：优先取交易所平仓记录，多次查不到则按成交均价估算。 */
async function settleSignalClose(held, close, execMode) {
  const ex = execFor(execMode);
  let res = null;
  for (let i = 0; i < 3 && !res; i++) {
    if (positions.get(held.instId) !== held) return; // 对账已先入账
    try {
      res = await ex.resolveClose(held, usedCloseKeys(execMode));
    } catch (e) {
      logThrottled(`resolve-${held.instId}`, 'warn', `${ex.tag} 查询 ${held.instId} 平仓记录失败：${e.message}`, 60000);
    }
    if (!res && i < 2) await sleep(2000);
  }
  if (positions.get(held.instId) !== held) return;
  if (res) finalizeExchangeClose(held, res);
  else finalizeExchangeClose(held, { closeAvgPx: close.closeAvgPx, action: 'signal', inferred: false }, { estimated: true });
}

async function executeExchangeSignal({ instId, execMode, cfg, event, plan, held, meta, slPct }) {
  const ex = execFor(execMode);
  pendingOpens.add(instId);
  try {
    if (plan.close && held) {
      held.close_reason = 'signal';
      let close;
      try {
        close = await ex.marketClose(held, 'signal');
      } catch (e) {
        held.close_reason = null;
        pushLog('error', `${ex.tag} ${instId} 信号平仓失败：${e.message}（持仓保持，保护单仍在）`);
        return;
      }
      if (!close.complete) {
        pushLog('warn', `${ex.tag} ${instId} 信号平仓尚未完成：对账会自动重试，等待下一根已收盘 K 线`);
        return;
      }
      if (held.algoId) await ex.cancelProtection(held);
      await settleSignalClose(held, close, execMode);
      saveState();
    }
    if (plan.open) await startExchangeOpen({ instId, direction: plan.open, event, meta, slPct }, cfg);
  } catch (e) {
    pushLog('error', `${ex.tag} ${instId} 策略订单流程异常：${e.message}`);
  } finally {
    pendingOpens.delete(instId);
  }
}

/**
 * 处理一次目标仓位信号。deferred=稍后重试；handled=已消费并持久化去重。
 */
function handleSignal(row, event, decision, cfg, execMode) {
  const instId = row.instId;
  const target = decision.target;
  const occ = occupiedInfo(instId, execMode);
  if (occ?.kind === 'busy') return { status: 'deferred', text: `待处理：${occ.reason}` };
  if (!isExchangeMode(execMode) && !(row.price > 0)) return { status: 'deferred', text: '待处理：暂无有效价格' };

  const held = positions.get(instId);
  const heldDir = held && isManagedPosition(held) && (held.exec_mode || 'sim') === execMode ? held.direction : null;
  const ageMs = nowMs() - event.closeAt;
  const stale = ageMs > cfg.signal_max_age_sec * 1000;
  const shortBlock = target === 'short' ? shortBlockReason({ direction: target, execMode, tradeMode: cfg.mode, cfgAllowShort: cfg.allow_short }) : null;
  const cd = coinCooldown(instId, execMode);
  const full = modePositions(execMode).length + pendingOpens.size >= cfg.max_positions;
  let plan = planTarget({ heldDir, occupied: occ?.reason || null, target, shortBlock, cooldown: cd?.text || null, full });
  let skip = plan.skip;
  if (stale && plan.open) {
    plan = { ...plan, open: null, reverse: false };
    skip = `信号已过期（${Math.round(ageMs / 1000)} 秒 > ${cfg.signal_max_age_sec} 秒），${plan.close ? '仅执行平仓' : '不追单'}`;
  }
  if (plan.open) {
    let block = null;
    const rb = riskBlockReason(cfg, instId);
    if (rb) {
      logThrottled(`risk:${rb.key}`, 'warn', `[风控] ${rb.msg}`, rb.ms);
      block = rb.msg;
    } else if (isExchangeMode(execMode) && cfg.mode !== 'swap') block = `${execModeText(execMode)}仅支持永续`;
    else if (execMode === 'okx_demo' && !demoHasInst(instId)) block = '模拟盘无此合约';
    else if (execMode === 'okx_live' && !liveTradingActive()) block = '实盘未激活（启动检查未通过或扫描未运行）';
    if (block) {
      plan = { ...plan, open: null, reverse: false };
      skip = plan.close ? `仅执行平仓：${block}` : block;
    }
  }

  markHandled(execMode, instId, event.ts);
  const head = `[RSI 信号] ${instId} ${decision.text}（K线收盘 ${new Date(event.closeAt).toLocaleString('zh-CN', { hour12: false })}）`;
  const plantext = plan.close || plan.open ? `${plan.close ? `平${dirText(heldDir)}` : ''}${plan.close && plan.open ? ' → ' : ''}${plan.open ? `开${dirText(plan.open)}` : ''}${plan.reverse ? '（反手）' : ''}` : '无操作';
  pushLog(plan.close || plan.open ? 'info' : 'warn', `${head} | 计划：${plantext}${skip ? ` | ${skip}` : ''}`);

  if (!plan.close && !plan.open) return { status: 'handled', closed: false, opened: false, skip, text: skip || '无操作' };

  const meta = metaFromSignal(row, event, decision, cfg);
  if (isExchangeMode(execMode)) {
    executeExchangeSignal({ instId, execMode, cfg, event, plan, held, meta, slPct: decision.slPct }).catch((e) => pushLog('error', `策略订单流程异常 ${instId}：${e.message}`));
    return { status: 'handled', closed: !!plan.close, opened: false, submitted: true, skip, text: '正在提交订单…' };
  }
  let closed = false;
  let opened = false;
  if (plan.close && held) {
    closeSimPosition(held, row.price, 'signal', cfg);
    closed = true;
  }
  if (plan.open) {
    try {
      openSimPosition({ instId, direction: plan.open, price: row.price, cfg, meta, slPct: decision.slPct });
      opened = true;
    } catch (e) {
      skip = `开仓被拒绝：${e.message}`;
      pushLog('warn', `[模拟] ${instId} ${skip}`);
    }
  }
  return { status: 'handled', closed, opened, skip, text: skip || '已执行' };
}

// ---------- 信号评估主循环 ----------

function evaluateSignals({ quiet = false } = {}) {
  if (!scanState?.running) return;
  const cfg = scanState.config;
  const execMode = normExecMode(cfg.exec_mode);
  const params = strategyParams(cfg);
  const now = new Date().toISOString();
  const volMap = new Map(lastUniverse.map((u) => [u.instId, u]));
  const ids = [...new Set([...lastUniverse.map((u) => u.instId), ...positions.keys()])];
  const rows = [];

  for (const instId of ids) {
    const snap = candleStore.snapshot(instId);
    if (!snap || snap.bars < 1) continue;
    const uni = volMap.get(instId);
    const cd = coinCooldown(instId, execMode);
    const notOnDemo = execMode === 'okx_demo' && cfg.mode === 'swap' && !demoHasInst(instId);
    const price = snap.price ?? uni?.price ?? null;
    const held = positions.get(instId);
    const managedHeld = held && isManagedPosition(held) && (held.exec_mode || 'sim') === execMode ? held : null;
    const ctx = ctxFromStore(candleStore, instId, params, { phase: 'scan', price, tradable: !notOnDemo, heldDirection: managedHeld?.direction || null });
    const decision = evaluateSafely(STRATEGY, ctx, (e) => logThrottled(`strategy-err:rsi:${instId}`, 'error', `RSI 策略评估异常（${instId}）：${e.message}`, 5 * 60 * 1000));
    const dec = decision || { direction: null, target: null, signal: false, text: '策略评估异常', metrics: {} };
    const m = dec.metrics || {};
    rows.push({
      instId,
      strategy_id: ACTIVE_STRATEGY_ID,
      volUsd24h: uni?.volUsd24h ?? 0,
      price,
      trend: m.trend ?? null,
      rsi: m.rsi ?? null,
      previousRsi: m.previousRsi ?? null,
      ema: m.ema ?? null,
      atr: m.atr ?? null,
      volumeRatio: m.volumeRatio ?? null,
      volumeOk: m.volumeOk ?? null,
      readyBars: m.readyBars ?? 0,
      requiredBars: m.requiredBars ?? 0,
      signalKind: m.signalKind ?? null,
      signalTs: m.signalTs ?? null,
      signalAt: m.signalCloseAt ? new Date(m.signalCloseAt).toISOString() : null,
      direction: dec.direction ?? null,
      target: dec.target ?? null,
      held: held && (held.exec_mode || 'sim') === execMode ? { direction: held.direction, strategy_id: held.strategy_id } : null,
      forming: !!snap.forming,
      stale: !!snap.stale,
      filtered: !!cd,
      cooldown: cd ? { kind: cd.kind, until: new Date(cd.until).toISOString(), text: cd.text, reason: cd.reason } : null,
      notOnDemo,
      signal: !!dec.signal,
      signalText: dec.text,
      skipped: false,
      skipReason: null,
      skipUntil: null,
      submitting: false,
      ok: true,
      error: null,
      at: snap.updatedAt || now,
      watchlist: !!uni?.watchlist,
      _dec: dec,
      _snap: snap,
    });
  }

  // 1) 持仓更新 + 本地模拟灾难止损 / 强平（先于策略信号处理）
  for (const pos of [...positions.values()]) {
    const px = candleStore.get(pos.instId)?.price ?? null;
    if (isExchangeMode(pos.exec_mode)) {
      if (px != null) pos.ws_price = px;
      continue;
    }
    if (px != null) {
      pos.last_price = px;
      pos.profit_pct = posProfitPct(pos.entry_price, px, pos.direction === 'short' ? 'short' : 'long');
      checkSimExit(pos, px);
    }
  }

  // 2) 策略目标仓位 → 平仓 / 开仓（按已收盘 K 线时间去重）
  let opened = 0;
  let closed = 0;
  let submitted = 0;
  let signalCount = 0;
  for (const r of rows) {
    const dec = r._dec;
    delete r._dec;
    delete r._snap;
    const signalTs = Number(dec.metrics?.signalTs);
    const closeAt = Number(dec.metrics?.signalCloseAt);
    if (dec.signal && dec.target && Number.isFinite(signalTs) && Number.isFinite(closeAt)) {
      const done = handledSignals.get(signalKey(execMode, r.instId));
      if (done != null && done >= signalTs) {
        r.signal = false;
        r.signalText = '当前 K 线的 RSI 信号已处理';
        continue;
      }
      signalCount++;
      const event = { ts: signalTs, closeAt, close: r.price, kind: dec.metrics?.signalKind || null };
      const res = handleSignal(r, event, dec, cfg, execMode);
      if (res.status === 'handled') {
        if (res.closed) closed++;
        if (res.opened) opened++;
        if (res.submitted) {
          submitted++;
          r.submitting = true;
        }
        if (res.skip) {
          r.skipped = true;
          r.skipReason = res.skip;
        }
        r.signalText = res.submitting ? '触发，正在提交订单…' : res.skip ? `触发：${res.skip}` : r.signalText;
        if (res.submitted) r.signalText = '触发，正在提交订单…';
      } else {
        r.skipped = true;
        r.skipReason = res.text;
        r.signalText = `触发：${res.text}`;
      }
    }
  }

  rows.sort((a, b) => {
    if (a.signal !== b.signal) return a.signal ? -1 : 1;
    if (!!a.held !== !!b.held) return a.held ? -1 : 1;
    const at = a.signalAt ? Date.parse(a.signalAt) : 0;
    const bt = b.signalAt ? Date.parse(b.signalAt) : 0;
    if (at !== bt) return bt - at;
    return (b.volUsd24h || 0) - (a.volUsd24h || 0);
  });
  lastSignals = rows;

  scanState.lastScanAt = now;
  scanState.error = null;

  const heldCount = modePositions(execMode).length;
  if (!quiet) {
    scanState.round = (scanState.round || 0) + 1;
    pushLog(
      'info',
      `信号评估 #${scanState.round}：有效 ${rows.length} | 待处理信号 ${signalCount} | 平仓 ${closed} | ${isExchangeMode(execMode) ? '提交订单' : '新开'} ${isExchangeMode(execMode) ? submitted : opened} | 持仓 ${positions.size} | WS ${wsPublicStatus().connected ? '已连接' : '重连中'}`
    );
  } else if (opened > 0 || closed > 0 || submitted > 0) {
    pushLog('info', `推送触发：平仓 ${closed} | 新开 ${opened} | 提交订单 ${submitted} | 持仓 ${heldCount}`);
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

function applyStrategyParams(cfg) {
  candleStore.setParams({ bar: cfg.bar });
}

async function bootstrapCandles(cfg, universe) {
  candleStore.clear();
  applyStrategyParams(cfg);
  const requiredBars = STRATEGY.needs(strategyParams(cfg)).closedBars;
  let ok = 0;
  let fail = 0;
  pushLog('info', `开始 Bootstrap K 线：${universe.length} 个币 × ${cfg.bar} limit=${CANDLE_BOOTSTRAP_LIMIT}（历史 K 线只用于预热）`);

  await mapPool(universe, cfg.scanConcurrency, async (u) => {
    const instId = u.instId;
    try {
      const candles = await fetchCandles(instId, cfg.bar, CANDLE_BOOTSTRAP_LIMIT);
      if (!candles.length) {
        fail++;
        pushLog('warn', `无 K 线 ${instId}`);
        return;
      }
      candleStore.bootstrap(instId, candles);
      if (u.price != null) candleStore.setPrice(instId, u.price);
      const snap = candleStore.snapshot(instId);
      if ((snap?.bars || 0) >= requiredBars) ok++;
      else {
        fail++;
        pushLog('warn', `K 线不足无法预热 RSI 策略 ${instId} bars=${snap?.bars ?? 0}/${requiredBars}`);
      }
    } catch (e) {
      fail++;
      pushLog('warn', `Bootstrap 失败 ${instId}: ${e.message}`);
    }
  });

  pushLog('info', `Bootstrap 完成：指标有效 ${ok} | 失败/预热不足 ${fail}`);
  return { ok, fail };
}

let refillBusy = false;
/** WS 漏 K 线 / 迟迟没有收盘推送的币：用 REST 补齐，随后重新评估最新已收盘 K 线。 */
async function refillStaleCandles() {
  if (refillBusy || !scanState?.running) return;
  refillBusy = true;
  try {
    const cfg = scanState.config;
    const now = nowMs();
    const need = [...candleStore.map.keys()].filter((id) => candleStore.needsRefill(id, now));
    if (!need.length) return;
    for (const id of need) candleStore.get(id).refillAt = now;
    let n = 0;
    await mapPool(need, cfg.scanConcurrency, async (instId) => {
      try {
        const candles = await fetchCandles(instId, cfg.bar, CANDLE_BOOTSTRAP_LIMIT);
        if (!candles.length) return;
        candleStore.bootstrap(instId, candles);
        n++;
      } catch (e) {
        logThrottled(`refill:${instId}`, 'warn', `K 线补齐失败 ${instId}：${e.message}`, 5 * 60 * 1000);
      }
    });
    if (n) {
      pushLog('info', `K 线补齐：${n}/${need.length} 个币已用 REST 重建指标状态`);
      scheduleEvaluate('refill');
    }
  } finally {
    refillBusy = false;
  }
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

// ---------- OKX 模拟盘对账（交易所为准） ----------

function finalizeExchangeClose(pos, res, { estimated = false } = {}) {
  if (positions.get(pos.instId) !== pos) return null; // 已被另一条路径入账，防止重复记账
  const ex = execFor(pos.exec_mode);
  const rtag = `[${ex.envText}对账]`;
  const dir = pos.direction === 'short' ? 'short' : 'long';
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
  const pct = entry > 0 ? posProfitPct(entry, exit, dir) : 0;
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
    `[${ex.envText}${reasonText(res.action)}] ${pos.instId} ${dirText(dir)}头 入场 ${entry} → 平仓均价 ${fmtNum(exit, 8).replace(/\.?0+$/, '')} | ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% | 已实现 ${trade.pnl_usdt.toFixed(4)} USDT${
      estimated ? '（估算：未查到平仓记录）' : `（含手续费 ${fmtNum(res.fee, 4)}${res.fundingFee ? ` · 资金费 ${fmtNum(res.fundingFee, 4)}` : ''}）`
    }${res.inferred ? ' · 类型按价格推断' : ''}`
  );
  applyCloseCooldown(pos, res.action, pct, res.uTime || null);
  return trade;
}

/** 无平仓记录时的平仓类型推断：有止盈比例的旧持仓按价格推断 tp/sl；灾难止损价被触及 → sl；否则 external */
function inferExchangeAction(pos, exit) {
  const dir = pos.direction === 'short' ? 'short' : 'long';
  if (pos.close_reason) return { action: pos.close_reason, inferred: false };
  if (Number(pos.tp_pct) > 0) return { action: inferCloseAction(pos.entry_price, exit, dir), inferred: true };
  if (Number(pos.stop_loss_price) > 0 && stopHit(exit, Number(pos.stop_loss_price), dir)) return { action: 'sl', inferred: true };
  return { action: 'external', inferred: true };
}

function buildRecoveredPosition(pending, exchangePos, order, ex) {
  const saved = pending.pos ? { ...pending.pos } : {};
  const inst = ex.getInst(pending.instId);
  const direction = (pending.direction || saved.direction) === 'short' ? 'short' : 'long';
  const contracts = Math.abs(Number(exchangePos?.pos) || Number(order?.accFillSz) || Number(saved.contracts) || 0);
  const entry = Number(exchangePos?.avgPx) || Number(order?.avgPx) || Number(saved.entry_price) || Number(pending.referencePrice) || 0;
  const leverage = Math.max(1, Number(pending.leverage) || Number(saved.leverage) || 1);
  const ctVal = Number(saved.ctVal) || Number(inst?.ctVal) || 0;
  const notional = contracts > 0 && ctVal > 0 && entry > 0 ? contracts * ctVal * entry : Number(saved.notional_usdt) || 0;
  const tpPct = Number(pending.tpPct ?? saved.tp_pct) > 0 ? Number(pending.tpPct ?? saved.tp_pct) : null;
  const slPct = Number(pending.slPct ?? saved.sl_pct) > 0 ? Number(pending.slPct ?? saved.sl_pct) : null;
  return {
    ...saved,
    instId: pending.instId,
    exec_mode: pending.exec_mode,
    direction,
    strategy_id: pending.strategy_id || saved.strategy_id || 'rsi_dip',
    strategy_version: pending.strategy_version ?? saved.strategy_version ?? null,
    signal_meta: pending.signal_meta ?? saved.signal_meta ?? null,
    simulated: false,
    external: false,
    entry_price: entry,
    amount: notional > 0 ? notional / leverage : Number(pending.amount) || Number(saved.amount) || 0,
    leverage,
    tdMode: 'cross',
    posSide: exchangePos?.raw?.posSide || saved.posSide || 'net',
    order_ccy: 'USDT',
    contracts,
    contractsStr: ex.fmtContracts(pending.instId, contracts),
    ctVal,
    ctValCcy: saved.ctValCcy || inst?.ctValCcy || null,
    notional_usdt: notional,
    ordId: pending.ordId || saved.ordId || order?.ordId || null,
    clOrdId: pending.clOrdId || saved.clOrdId || order?.clOrdId || null,
    tp_pct: tpPct,
    sl_pct: slPct,
    take_profit_price: saved.take_profit_price || (entry > 0 && tpPct ? takeProfitPrice(entry, tpPct, direction) : null),
    stop_loss_price: saved.stop_loss_price || (entry > 0 && slPct ? stopLossPrice(entry, slPct, direction) : null),
    liq_price: exchangePos?.liqPx ?? saved.liq_price ?? null,
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

    const xp = matchExchangePos(livePositions || [], pending.instId, pending.direction === 'short' ? 'short' : 'long');
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
      pushLog('warn', `${ex.tag} 已从 pending 恢复并接管 ${pending.instId}（${dirText(pos.direction)}头）：${pos.contractsStr} 张 @ ${pos.entry_price || '待对账'}`);
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
      const cls = classifyPosition(live, pos);
      if (cls.state === 'direction_mismatch') {
        // 严重异常：交易所该币持仓方向与记录相反。不自动平仓、不重挂保护、不当作仓位消失，只报警等人工处理
        logThrottled(
          `dir-mismatch-${mode}-${pos.instId}`,
          'error',
          `${rtag} ${pos.instId} 持仓方向与程序记录不一致：记录=${dirText(pos.direction)}头，交易所=${dirText(cls.other.direction)}头 ${cls.other.pos} 张。已停止自动处理该币，请立即人工核对！`,
          60 * 1000
        );
        continue;
      }
      const xp = cls.xp ? cls.xp.raw : null;
      const dir = pos.direction === 'short' ? 'short' : 'long';
      const age = Date.now() - Number(pos.opened_ts || 0);
      if (xp) {
        const last = Number(xp.last) || Number(xp.markPx) || null;
        const exPos = Math.abs(Number(xp.pos));
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
        pos.profit_pct = last && pos.entry_price ? posProfitPct(pos.entry_price, last, dir) : null;
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
          if (!closeComplete && !attached && pos.status === 'closing' && ex.needsProtection(pos)) {
            try {
              await ex.placeProtection(pos, pos.tp_pct, pos.sl_pct);
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
                await ex.placeProtection(pos, pos.tp_pct, pos.sl_pct);
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
          if (!attached && ex.needsProtection(pos) && (age > 15000 || pos.recovered_from_pending)) {
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
                await ex.placeProtection(pos, pos.tp_pct, pos.sl_pct);
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
          finalizeExchangeClose(pos, { closeAvgPx: exit, ...inferExchangeAction(pos, exit) }, { estimated: true });
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
        direction: exchangeRowDirection(p),
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
    // 实盘做空：策略开了 allow_short 且服务端环境变量放行时，另需单独确认文字
    if (cfg.allow_short && !shortEnvBlockReason('okx_live') && String(rawBody?.short_confirm_text ?? '') !== SHORT_CONFIRM_TEXT) {
      return { status: 400, error: `实盘开启做空必须额外输入「${SHORT_CONFIRM_TEXT}」（或关闭「允许做空」）` };
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
    service: 'rsi-pullback-trader',
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
    const shortNote = shortBlockReason({ direction: 'short', execMode: cfg.exec_mode, tradeMode: cfg.mode, cfgAllowShort: cfg.allow_short });
    pushLog(
      'info',
      `开始 RSI 趋势回调全市场扫描(WebSocket) mode=${cfg.mode} bar=${cfg.bar} RSI(${cfg.rsi_period}) + EMA(${cfg.ema_period}) | 入场 多:${cfg.long_setup_rsi}→${cfg.long_entry_rsi} 空:${cfg.short_setup_rsi}→${cfg.short_entry_rsi} | 量能 ${cfg.volume_filter_enabled ? `${cfg.volume_period}均量×${cfg.volume_multiplier}` : '关闭'} | ATR 止损 ${cfg.atr_stop_mult > 0 ? `${cfg.atr_stop_mult}倍` : '关闭'} | 做空：${shortNote ? `禁用（${shortNote}）` : '已开启'} | limit=${cfg.universeLimit} 评估间隔=${cfg.refreshSec}s${
        cfg.mode === 'swap' ? ` 杠杆=${cfg.leverage}x 全仓 USDT` : ''
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
      refillStaleCandles().catch((e) => pushLog('warn', `K 线补齐异常: ${e.message}`));
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
    short: shortStatus(),
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
    disaster_cooldown_minutes: cfg.disaster_cooldown_minutes,
    items: list,
  });
});

app.post('/api/filtered/clear', (req, res) => {
  const instId = req.body?.instId ? String(req.body.instId).toUpperCase() : null;
  const mode = req.body?.exec_mode ? normExecMode(req.body.exec_mode) : null;
  const strategyId = req.body?.strategy_id ? String(req.body.strategy_id) : null;
  const tail = `${mode ? `（${execModeText(mode)}）` : ''}${strategyId ? `（策略 ${strategyId}）` : ''}`;
  if (instId) {
    coinGuard.clear(instId, mode, strategyId);
    pushLog('info', `已手动解除冷却：${instId}${tail}`);
  } else {
    coinGuard.clear(null, mode, strategyId);
    pushLog('info', `已清空全部同币冷却${tail}`);
  }
  res.json({ ok: true, items: listFilteredCoins(scanState?.config || DEFAULT_SCAN) });
});

app.get('/api/positions', (_req, res) => {
  const cfg = scanState?.config || DEFAULT_SCAN;
  const list = [...positions.values()].map((p) => {
    const dir = p.direction === 'short' ? 'short' : 'long';
    const price = isExchangeMode(p.exec_mode) ? p.last_price ?? null : p.last_price ?? candleStore.get(p.instId)?.price ?? null;
    const profitPct = price != null ? posProfitPct(p.entry_price, price, dir) : p.profit_pct ?? null;
    return {
      ...p,
      direction: dir,
      managed: isManagedPosition(p),
      last_price: price,
      profit_pct: profitPct,
      take_profit_price: p.take_profit_price ?? null,
      stop_loss_price: p.stop_loss_price ?? null,
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
  let rows = lastSignals;
  if (onlySignal) rows = rows.filter((r) => r.signal);
  res.json({
    ok: true,
    count: rows.length,
    signals: rows.slice(0, limit),
    lastScanAt: scanState?.lastScanAt || null,
    feed: feedMode,
  });
});

app.get('/api/strategies', (_req, res) => {
  res.json({
    ok: true,
    active: ACTIVE_STRATEGY_ID,
    strategies: [
      {
        id: STRATEGY.id,
        name: STRATEGY.name,
        version: STRATEGY.version,
        directions: STRATEGY.directions,
        params: STRATEGY.params,
        presets: STRATEGY.presets,
        defaults: RSI_PULLBACK_DEFAULTS,
      },
    ],
    short: shortStatus(),
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
    const price = Number(candleStore.get(instId)?.price) || Number(pos.last_price) || Number(pos.entry_price);
    closeSimPosition(pos, price, 'manual', effectiveCfg());
  }
  saveState();
  res.json({ ok: true, positions: [...positions.values()] });
});

app.post('/api/signal', (_req, res) => {
  res.status(410).json({ ok: false, error: '旧版单币刷新接口已移除，请使用 /api/signals', moved_to: '/api/signals' });
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
  const direction = raw.direction === 'short' ? 'short' : 'long';

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
  try {
    price = (await fetchTickerHttp(instId))?.last ?? null;
  } catch (e) {
    return res.status(500).json({ error: `行情获取失败: ${e.message}` });
  }
  if (!(price > 0)) return res.status(502).json({ error: '行情无有效价格' });
  const block = shortBlockReason({ direction, execMode: cfg.exec_mode, tradeMode: cfg.mode, cfgAllowShort: cfg.allow_short });
  const entry = simFillPrice(price, openSide(direction), cfg.sim_slippage_pct);
  const preview = {
    instId,
    direction,
    mode: cfg.mode,
    exec_mode: cfg.exec_mode,
    amount: cfg.amount,
    leverage: cfg.leverage,
    entry_price: entry,
    take_profit_price: null,
    stop_loss_price: null,
    stop_loss_note: `实际入场时按 ATR(${cfg.atr_period}) × ${cfg.atr_stop_mult} 动态计算`,
    blocked: block,
    simulated: true,
    liveAutoTradeDisabled: true,
    command:
      cfg.mode === 'swap'
        ? `okx swap place --instId ${instId} --side ${openSide(direction)} --ordType market --tdMode cross --lever ${cfg.leverage || 1}（仅预览，不会执行）`
        : `okx spot place --instId ${instId} --side buy --ordType market（仅预览，不会执行）`,
  };
  pushLog('info', `[预览] ${preview.command}`);
  // 预览绝不开仓 / 下单（以前会在本地模拟下生成模拟持仓，现在只返回计算结果）
  res.json({ ok: true, executed: false, reason: '预览（未实际发送订单，也不会生成模拟持仓）', preview, liveAutoTradeDisabled: !liveTradingActive() });
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
        atr_stop_mult: cfg.atr_stop_mult,
        allow_short: cfg.allow_short,
        short_blocked: shortBlockReason({ direction: 'short', execMode: 'okx_live', tradeMode: cfg.mode, cfgAllowShort: cfg.allow_short }),
      },
      shortConfirmText: SHORT_CONFIRM_TEXT,
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
        closeSimPosition(pos, price, 'kill', effectiveCfg());
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
    pushLog('info', `开始 RSI 趋势回调扫描（兼容 monitor/start） mode=${cfg.mode} · WebSocket`);
    setImmediate(() => {
      runBootstrapAndStart().catch((e) => pushLog('error', `启动异常: ${e.message}`));
    });
    scanTimer = setInterval(() => {
      try {
        evaluateSignals({ quiet: false });
      } catch (e) {
        pushLog('error', `信号评估异常: ${e.message}`);
      }
      refillStaleCandles().catch((e) => pushLog('warn', `K 线补齐异常: ${e.message}`));
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

if (dataDirOverridden()) pushLog('info', `数据目录已通过环境变量重定向：${DATA_DIR}`);
if (process.env.RSI_NO_ENV_LOCAL === '1') pushLog('info', 'RSI_NO_ENV_LOCAL=1：未读取 server/.env.local');
loadState();
loadCoinGuard();

// 仅 RSI_NO_LISTEN=1 时导出测试钩子（默认 null，对现网无任何影响）：供冒烟 / 差分测试在不监听端口、
// 不连交易所的前提下驱动信号评估。钩子只读写本进程内存与（被重定向的）数据目录。
export const __test = NO_LISTEN
  ? {
      app,
      DATA_DIR,
      candleStore,
      eventLog,
      positions,
      pendingOrders,
      handledSignals,
      handledFlips: handledSignals,
      coinGuard,
      clampConfig,
      evaluateSignals,
      listTrades,
      saveState,
      startScanForTest(cfgRaw) {
        scanState = { running: true, config: clampConfig(cfgRaw), startedAt: new Date().toISOString(), lastScanAt: null, round: 0, error: null };
        applyStrategyParams(scanState.config);
        return scanState.config;
      },
      setUniverseForTest(list) {
        lastUniverse = list;
      },
      getSignalsForTest: () => lastSignals,
      setNow(fn) {
        nowFn = typeof fn === 'function' ? fn : () => Date.now();
      },
      closeSimPositionForTest: (pos, price, action) => closeSimPosition(pos, price, action),
    }
  : null;

// RSI_NO_LISTEN=1：只加载模块、不监听端口、不启动 20 秒对账定时器（测试 / 回放 / 升级演练）。默认不设置 = 行为不变。
// 注意：loadState()/loadCoinGuard() 仍会读取数据目录，所以演练时必须同时设置 RSI_DATA_DIR 指向临时目录。
if (NO_LISTEN) {
  pushLog('info', 'RSI_NO_LISTEN=1：未监听端口，未启动对账定时器（仅用于测试 / 演练）');
} else app.listen(PORT, '127.0.0.1', () => {
  pushLog('info', `RSI 趋势回调交易后端已启动 :${PORT} · 行情源 WebSocket`);
  const envNote = envLoad.loaded ? '（server/.env.local 中缺少必要项）' : '（未找到 server/.env.local）';
  pushLog('info', demoKeysConfigured() ? 'OKX 模拟盘 API Key：已配置（不显示内容）' : `OKX 模拟盘 API Key：未配置${envNote}`);
  pushLog(
    'info',
    liveKeysConfigured()
      ? 'OKX 实盘 API Key：已配置（不显示内容）· 仅在选择「OKX 实盘」、通过启动检查并输入「确认实盘」后才会下实盘单'
      : `OKX 实盘 API Key：未配置${envNote} · 实盘不可用`
  );
  console.log(`[rsi-pullback-trader] API http://127.0.0.1:${PORT}`);
  const runReconcileAll = () => {
    for (const m of EXCHANGE_MODES) reconcileExchange(m).catch(() => {});
  };
  runReconcileAll();
  setInterval(runReconcileAll, RECONCILE_MS);
});
