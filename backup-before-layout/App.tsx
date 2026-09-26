import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Profile = 'demo' | 'live';
type Mode = 'spot' | 'swap';
type Bar = '1m' | '5m' | '15m' | '1H' | '4H' | '1Dutc';
type ExecMode = 'sim' | 'okx_demo' | 'okx_live';

interface FormState {
  amount: string;
  bar: Bar;
  rsi_period: string;
  rsi_buy_threshold: string;
  take_profit_pct: string;
  stop_loss_pct: string;
  max_positions: string;
  mode: Mode;
  profile: Profile;
  refreshSec: string;
  minVolUsd24h: string;
  universeLimit: string;
  scanConcurrency: string;
  max_consecutive_sl: string;
  sl_filter_hours: string;
  leverage: string;
  watchlist: string;
  exec_mode: ExecMode;
  confirm_on_close: boolean;
  daily_loss_limit_usdt: string;
  max_orders_per_hour: string;
  max_spread_pct: string;
}

interface SignalRow {
  instId: string;
  volUsd24h: number;
  price: number | null;
  rsi: number | null;
  rsiClosed?: number | null;
  signal: boolean;
  signalText?: string;
  ok?: boolean;
  error?: string | null;
  at?: string;
  watchlist?: boolean;
  forming?: boolean;
  filtered?: boolean;
  notOnDemo?: boolean;
  skipped?: boolean;
  skipReason?: string | null;
  skipUntil?: string | null;
  submitting?: boolean;
}

interface PositionRow {
  instId: string;
  entry_price: number;
  amount: number;
  last_price?: number | null;
  profit_pct?: number | null;
  take_profit_price?: number;
  stop_loss_price?: number;
  simulated?: boolean;
  status?: string;
  at?: string;
  rsi_at_entry?: number | null;
  leverage?: number;
  mode?: string;
  exec_mode?: ExecMode;
  contracts?: number;
  contractsStr?: string;
  exchange_contracts?: number;
  ctVal?: number;
  ctValCcy?: string;
  tp_sl_attached?: boolean;
  tp_sl_full?: boolean;
  algo_close_fraction?: boolean;
  algo_sz?: string | null;
  algoId?: string | null;
  upl?: number | null;
  close_reason?: string | null;
  notional_usdt?: number;
}

interface ExternalPosition {
  instId: string;
  posSide: string;
  pos: number;
  avgPx: number | null;
  lever: number | null;
  mgnMode?: string;
  upl: number | null;
  uplRatio: number | null;
  last: number | null;
}

interface AccountSummary {
  keysConfigured: boolean;
  posMode: string | null;
  posModeText?: string | null;
  acctLv?: string | null;
  acctLvText?: string | null;
  usdtEq: number | null;
  usdtAvail: number | null;
  totalEq?: number | null;
  updatedAt?: string | null;
  error?: string | null;
  perm?: string | null;
  ipBound?: boolean | null;
  exec_mode?: string;
  envText?: string;
}

interface LiveCheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface LiveCheckResult {
  ok: boolean;
  reasons: string[];
  checks: LiveCheckItem[];
  account?: AccountSummary;
  summary?: {
    amount: number;
    leverage: number;
    notional: number;
    max_positions: number;
    daily_loss_limit_usdt: number;
    max_orders_per_hour: number;
    take_profit_pct: number;
    stop_loss_pct: number;
  };
  maxLeverage?: number;
  confirmText?: string;
}

interface RiskState {
  exec_mode: ExecMode;
  today_realized_usdt: number;
  daily_loss_limit_usdt: number;
  daily_loss_hit: boolean;
  orders_last_hour: number;
  max_orders_per_hour: number;
  max_spread_pct: number;
  kill_switch: { on: boolean; at: string | null; reason: string | null };
  pending_opens?: string[];
}

interface ExecStatus {
  exec_mode: ExecMode;
  exec_mode_text?: string;
  keysConfigured: boolean;
  account: AccountSummary;
  posMode: string | null;
  risk: RiskState;
  reconcile?: { lastAt: string | null; error: string | null } | null;
  is_live?: boolean;
  demoKeysConfigured?: boolean;
  liveKeysConfigured?: boolean;
  liveTradingActive?: boolean;
  live?: {
    keysConfigured: boolean;
    account: AccountSummary;
    gate?: { ok: boolean; at: string | null; reasons: string[] };
    maxLeverage?: number;
  };
}

interface WsStatus {
  connected?: boolean;
  reconnecting?: boolean;
  candleSubs?: number;
  tickerSubs?: number;
  lastMsgAt?: string | null;
  connCount?: number;
  aliveCount?: number;
}

interface ScanStatus {
  running: boolean;
  scanning?: boolean;
  lastScanAt?: string | null;
  round?: number;
  universeSize?: number;
  signalCount?: number;
  positionCount?: number;
  filteredCount?: number;
  error?: string | null;
  note?: string | null;
  liveAutoTradeDisabled?: boolean;
  liveTradingActive?: boolean;
  config?: Record<string, unknown> | null;
  feed?: 'websocket' | 'polling-legacy' | string;
  ws?: WsStatus;
}

interface LogItem {
  ts: string;
  level: string;
  msg: string;
}

interface PnLTrade {
  id?: string;
  instId: string;
  action: string;
  entry_price: number;
  exit_price: number;
  amount: number;
  profit_pct: number;
  pnl_usdt: number;
  closed_at?: string;
  exec_mode?: ExecMode;
  pnl_exact?: boolean;
  fee_usdt?: number | null;
  leverage?: number;
}

interface PnLDashboard {
  exec_mode?: ExecMode | null;
  exec_mode_text?: string;
  is_live?: boolean;
  realized_usdt: number;
  unrealized_usdt: number;
  total_usdt: number;
  today_realized_usdt: number;
  closed_trades: number;
  open_positions: number;
  wins: number;
  losses: number;
  win_rate_pct: number | null;
  avg_win_usdt: number;
  avg_loss_usdt: number;
  recent?: PnLTrade[];
  updatedAt?: string;
}

const DEFAULTS: FormState = {
  amount: '100',
  bar: '15m',
  rsi_period: '6',
  rsi_buy_threshold: '20',
  take_profit_pct: '8',
  stop_loss_pct: '6',
  max_positions: '5',
  mode: 'spot',
  profile: 'demo',
  refreshSec: '60',
  minVolUsd24h: '300000',
  universeLimit: '120',
  scanConcurrency: '6',
  max_consecutive_sl: '2',
  sl_filter_hours: '24',
  leverage: '1',
  watchlist: '',
  exec_mode: 'sim',
  confirm_on_close: false,
  daily_loss_limit_usdt: '50',
  max_orders_per_hour: '10',
  max_spread_pct: '0.3',
};

/** 实盘保守默认值（切到实盘时，若该模式没有保存过配置则套用；止盈止损沿用当前设置） */
const LIVE_FORM_DEFAULTS: Partial<FormState> = {
  amount: '20',
  leverage: '5',
  max_positions: '3',
  daily_loss_limit_usdt: '30',
  max_orders_per_hour: '5',
};
/** 按执行方式分开保存的字段 */
const MODE_FIELDS: (keyof FormState)[] = ['amount', 'leverage', 'max_positions', 'daily_loss_limit_usdt', 'max_orders_per_hour'];
const MODE_CFG_KEY = (m: ExecMode) => `rsi-bottom-hunter:mode-cfg:${m}`;
const LIVE_CONFIRM_TEXT = '确认实盘';

function loadModeCfg(m: ExecMode): Partial<FormState> | null {
  try {
    const raw = localStorage.getItem(MODE_CFG_KEY(m));
    return raw ? (JSON.parse(raw) as Partial<FormState>) : null;
  } catch {
    return null;
  }
}

function saveModeCfg(m: ExecMode, f: FormState) {
  try {
    const o: Partial<FormState> = {};
    for (const k of MODE_FIELDS) (o as Record<string, unknown>)[k] = f[k];
    localStorage.setItem(MODE_CFG_KEY(m), JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

const EXEC_TEXT: Record<string, string> = {
  sim: '本地模拟',
  okx_demo: 'OKX 模拟盘',
  okx_live: 'OKX 实盘',
};

function isExchangeMode(m?: string | null) {
  return m === 'okx_demo' || m === 'okx_live';
}

const ACTION_TEXT: Record<string, string> = {
  tp: '止盈',
  sl: '止损',
  kill: '急停平仓',
  failsafe: '保护平仓',
  manual: '手动',
  liq: '强平',
  external: '外部平仓',
};

function fmtPrice(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function fmtRsi(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || n <= 0) return '无效';
  return n.toFixed(2);
}

function fmtVol(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtUsdt(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}`;
}

function pnlClass(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || n === 0) return 'dim';
  return n > 0 ? 'text-green' : 'text-rose';
}

function localTs(iso: string) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data as T;
}

export default function App() {
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [filtered, setFiltered] = useState<
    { instId: string; streak: number; filteredUntil: string; reason?: string }[]
  >([]);
  const [pnl, setPnl] = useState<PnLDashboard | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [scan, setScan] = useState<ScanStatus>({ running: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configHint, setConfigHint] = useState('');
  const [modeHint, setModeHint] = useState<string | null>(null);
  const [exec, setExec] = useState<ExecStatus | null>(null);
  const [externalPositions, setExternalPositions] = useState<ExternalPosition[]>([]);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [liveModal, setLiveModal] = useState<{ open: boolean; loading: boolean; check: LiveCheckResult | null; text: string; error: string | null; starting: boolean }>({
    open: false,
    loading: false,
    check: null,
    text: '',
    error: null,
    starting: false,
  });
  const prevMode = useRef(form.mode);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  /** 切换执行方式：保存当前模式的资金/风控参数，载入目标模式已保存的参数；首次切实盘套用保守默认值 */
  const changeExecMode = (next: ExecMode) => {
    const f = form;
    if (f.exec_mode === next) return;
    saveModeCfg(f.exec_mode, f);
    const saved = loadModeCfg(next);
    const patch = saved || (next === 'okx_live' ? LIVE_FORM_DEFAULTS : {});
    setForm({ ...f, ...patch, exec_mode: next });
    if (next === 'okx_live') {
      setModeHint(
        saved
          ? '已切到「OKX 实盘」：已载入上次保存的实盘参数（止盈止损沿用当前设置）'
          : '已切到「OKX 实盘」：已套用实盘保守默认值（每笔保证金 20 USDT · 5x · 最大持仓 3 · 日亏上限 30 · 每小时 5 单），止盈止损沿用当前设置'
      );
    } else {
      setModeHint(`已切到「${EXEC_TEXT[next]}」${saved ? '，已载入该模式上次保存的参数' : ''}`);
    }
  };

  // 当前模式的资金/风控参数随改随存（按执行方式分开）
  useEffect(() => {
    saveModeCfg(form.exec_mode, form);
  }, [form]);

  const payload = useMemo(() => {
    const watchlist = form.watchlist
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      amount: Number(form.amount),
      bar: form.bar,
      rsi_period: Number(form.rsi_period),
      rsi_buy_threshold: Number(form.rsi_buy_threshold),
      take_profit_pct: Number(form.take_profit_pct),
      stop_loss_pct: Number(form.stop_loss_pct),
      max_positions: Number(form.max_positions),
      mode: form.mode,
      // profile 跟随执行方式（后端同样强制）：实盘=live，其余=demo
      profile: form.mode === 'swap' && form.exec_mode === 'okx_live' ? 'live' : 'demo',
      refreshSec: Number(form.refreshSec),
      minVolUsd24h: Number(form.minVolUsd24h),
      universeLimit: Number(form.universeLimit),
      scanConcurrency: Number(form.scanConcurrency),
      max_consecutive_sl: Number(form.max_consecutive_sl),
      sl_filter_hours: Number(form.sl_filter_hours),
      leverage: Number(form.leverage),
      exec_mode: (form.mode === 'swap' ? form.exec_mode : 'sim') as ExecMode,
      confirm_on_close: form.confirm_on_close,
      daily_loss_limit_usdt: Number(form.daily_loss_limit_usdt),
      max_orders_per_hour: Number(form.max_orders_per_hour),
      max_spread_pct: Number(form.max_spread_pct),
      tdMode: 'cross',
      posSide: 'long',
      order_ccy: 'USDT',
      watchlist,
    };
  }, [form]);

  // 盈亏看板/账户按「当前查看的执行方式」取数：扫描中用扫描的模式，否则用表单选择
  const viewModeRef = useRef<ExecMode>('sim');
  viewModeRef.current = (scan.running && (scan.config?.exec_mode as ExecMode)) || payload.exec_mode;

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api<{
        scan: ScanStatus;
        signals: SignalRow[];
        positions: PositionRow[];
        filtered?: { instId: string; streak: number; filteredUntil: string; reason?: string }[];
        pnl?: PnLDashboard;
        logs: LogItem[];
        feed?: string;
        ws?: WsStatus;
        exec?: ExecStatus;
        externalPositions?: ExternalPosition[];
      }>(`/api/scan/status?exec_mode=${encodeURIComponent(viewModeRef.current)}`);
      const scanData = data.scan || { running: false };
      if (!scanData.feed && data.feed) scanData.feed = data.feed;
      if (!scanData.ws && data.ws) scanData.ws = data.ws;
      setScan(scanData);
      setSignals(data.signals || []);
      setPositions(data.positions || []);
      setFiltered(data.filtered || []);
      setPnl(data.pnl || null);
      setExec(data.exec || null);
      setExternalPositions(data.externalPositions || []);
      if (data.exec?.account?.updatedAt) setAccount(data.exec.account);
      if (data.logs) setLogs(data.logs);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    api<{ tradingReady: boolean; hint: string; liveAutoTradeDisabled?: boolean }>(
      '/api/config-status'
    )
      .then((d) => {
        setConfigHint(
          d.hint ||
            (d.liveAutoTradeDisabled ? '实盘交易未激活（需选择「OKX 实盘」并通过启动检查）。' : '')
        );
      })
      .catch(() => setConfigHint('无法连接后端，请确认已启动 server（端口 8787）'));
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const t = setInterval(() => {
      refreshStatus();
    }, scan.running || scan.scanning ? 2500 : 8000);
    return () => clearInterval(t);
  }, [scan.running, scan.scanning, refreshStatus]);

  const testAccount = useCallback(async (mode: ExecMode = 'okx_demo') => {
    setAccountLoading(true);
    setAccountMsg(null);
    try {
      const d = await api<{ ok: boolean; keysConfigured: boolean; error?: string; account?: AccountSummary }>(
        `/api/account?mode=${mode === 'okx_live' ? 'okx_live' : 'okx_demo'}`
      );
      if (d.account) setAccount(d.account);
      setAccountMsg(d.ok ? `✅ ${mode === 'okx_live' ? '实盘' : '模拟盘'}连接正常` : `❌ ${d.error || '连接失败'}`);
    } catch (e) {
      setAccountMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAccountLoading(false);
    }
  }, []);

  useEffect(() => {
    setAccount(null);
    if (form.mode === 'swap' && isExchangeMode(form.exec_mode)) testAccount(form.exec_mode);
  }, [form.mode, form.exec_mode, testAccount]);

  useEffect(() => {
    if (form.mode === 'spot' && form.exec_mode !== 'sim') {
      changeExecMode('sim');
      setModeHint('现货暂不支持 OKX 模拟盘 / 实盘执行，已切回「本地模拟」');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.mode, form.exec_mode]);

  useEffect(() => {
    if (prevMode.current !== form.mode) {
      setModeHint(
        form.mode === 'swap'
          ? '已切换到永续：USDT-SWAP · 多头 · 全仓 · 下单 USDT · 请选择杠杆后重新开始扫描'
          : '已切换到现货：将重新构建 USDT 现货 universe'
      );
      prevMode.current = form.mode;
    }
  }, [form.mode]);

  /** 实盘：先做只读启动检查并弹出确认框，用户手动输入「确认实盘」后才真正开始 */
  const openLiveConfirm = async () => {
    setLiveModal({ open: true, loading: true, check: null, text: '', error: null, starting: false });
    try {
      const d = await api<LiveCheckResult>('/api/live/check', { method: 'POST', body: JSON.stringify(payload) });
      if (d.account) setAccount(d.account);
      setLiveModal((m) => ({ ...m, loading: false, check: d }));
    } catch (e) {
      setLiveModal((m) => ({ ...m, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const onConfirmLiveStart = async () => {
    if (liveModal.text.trim() !== LIVE_CONFIRM_TEXT) return;
    setLiveModal((m) => ({ ...m, starting: true, error: null }));
    try {
      const data = await api<{ note?: string; scan: ScanStatus }>('/api/scan/start', {
        method: 'POST',
        body: JSON.stringify({ ...payload, confirm_text: liveModal.text.trim() }),
      });
      if (data.note) setConfigHint(data.note);
      setScan(data.scan || { running: true });
      setLiveModal({ open: false, loading: false, check: null, text: '', error: null, starting: false });
      await refreshStatus();
    } catch (e) {
      setLiveModal((m) => ({ ...m, starting: false, error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const onStart = async () => {
    setError(null);
    setModeHint(null);
    try {
      if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
        throw new Error('请填写有效的买入金额 amount');
      }
      if (payload.universeLimit < 1 || payload.universeLimit > 200) {
        throw new Error('universeLimit 建议 10–200');
      }
      if (payload.exec_mode === 'okx_live') {
        if (payload.leverage > 20) throw new Error('实盘杠杆最高 20x');
        await openLiveConfirm();
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setLoading(true);
    try {
      const data = await api<{ note?: string; scan: ScanStatus }>('/api/scan/start', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (data.note) setConfigHint(data.note);
      setScan(data.scan || { running: true });
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const onStop = async () => {
    setError(null);
    try {
      await api('/api/scan/stop', { method: 'POST', body: '{}' });
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onPreviewUniverse = async () => {
    setError(null);
    setLoading(true);
    setModeHint(null);
    try {
      const data = await api<{ count: number; items: SignalRow[] }>('/api/universe', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setConfigHint(`Universe 预览：${data.count} 个币（mode=${payload.mode}${payload.exec_mode === 'okx_demo' ? '，仅模拟盘存在的合约' : ''}）`);
      // Show volume-only rows until full scan
      setSignals(
        (data.items || []).map((it) => ({
          instId: it.instId,
          volUsd24h: it.volUsd24h,
          price: it.price ?? null,
          rsi: null,
          signal: false,
          at: new Date().toISOString(),
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const onClearLogs = async () => {
    await api('/api/logs', { method: 'DELETE' });
    setLogs([]);
  };

  const onClearPositions = async () => {
    await api('/api/position/clear', { method: 'POST', body: '{}' });
    await refreshStatus();
  };

  const onKill = async (closeAll: boolean) => {
    const msg = closeAll
      ? '确认【急停并全部平仓】？\n将停止扫描、禁止开新仓，并按交易所持仓数量市价平掉本程序管理的全部 OKX 模拟盘 / 实盘持仓（撤销其止盈止损），本地模拟持仓按现价平仓。\n（交易所上非本程序开的外部仓位不会被平掉）'
      : '确认【急停】？\n将停止扫描并禁止开新仓；已有持仓保留（模拟盘/实盘持仓仍由交易所止盈止损保护）。';
    if (!confirm(msg)) return;
    setKillBusy(true);
    setError(null);
    try {
      const d = await api<{ results?: { instId: string; ok: boolean; error?: string }[] }>('/api/kill', {
        method: 'POST',
        body: JSON.stringify({ closeAll }),
      });
      const fails = (d.results || []).filter((r) => !r.ok);
      if (fails.length) setError(`部分平仓失败：${fails.map((f) => `${f.instId}(${f.error})`).join('；')}`);
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setKillBusy(false);
    }
  };

  const onKillReset = async () => {
    if (!confirm('确认解除急停？解除后可重新开始扫描。')) return;
    try {
      await api('/api/kill/reset', { method: 'POST', body: '{}' });
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = !!scan.running;
  const killOn = !!exec?.risk?.kill_switch?.on;
  const isDemoExec = form.mode === 'swap' && form.exec_mode === 'okx_demo';
  const isLiveExec = form.mode === 'swap' && form.exec_mode === 'okx_live';
  const liveRunning = running && scan.config?.exec_mode === 'okx_live';
  const showLiveBanner = isLiveExec || liveRunning;
  const execSel: ExecMode = form.mode === 'swap' ? form.exec_mode : 'sim';
  const keysOk =
    execSel === 'okx_live'
      ? exec?.liveKeysConfigured ?? account?.keysConfigured ?? false
      : execSel === 'okx_demo'
        ? exec?.demoKeysConfigured ?? exec?.keysConfigured ?? account?.keysConfigured ?? false
        : true;
  const acctFromExec = exec?.exec_mode === execSel ? exec?.account : null;
  const acct = (account && (!account.exec_mode || account.exec_mode === execSel) ? account : null) || acctFromExec || null;
  const liveAcct = execSel === 'okx_live' ? acct : exec?.live?.account || null;
  const risk = exec?.risk;
  const simPositionCount = positions.filter((p) => !isExchangeMode(p.exec_mode)).length;
  const viewModeText = EXEC_TEXT[pnl?.exec_mode || execSel] || '本地模拟';

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>
            <span className="accent">RSI抄底宝</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 500, fontSize: '1rem' }}>
              · 全市场扫描
            </span>
          </h1>
          <div className="subtitle">
            OKX WebSocket 行情 + 本地 Wilder RSI · 按 mode 筛 USDT → 推送驱动信号 · 本地模拟 / OKX 模拟盘 / OKX 实盘（需确认）
          </div>
        </div>
        <div className="badge-row">
          <span className={`badge ${showLiveBanner ? 'live' : 'demo'}`}>
            {showLiveBanner ? '⚡ 实盘 · 真实资金' : isDemoExec ? '🧪 模拟盘 DEMO' : '🧪 本地模拟'}
          </span>
          <span className="badge mode">{form.mode === 'swap' ? '永续 SWAP' : '现货 Spot'}</span>
          <span className={`badge ${isLiveExec ? 'live' : isDemoExec ? 'running' : 'mode'}`}>
            执行：{EXEC_TEXT[execSel]}
          </span>
          {killOn && <span className="badge live">⛔ 急停中</span>}
          {running && (
            <span className="badge running">
              ● 扫描中{scan.scanning ? '…' : ''} R{scan.round || 0}
            </span>
          )}
          <span className="badge mode">行情源：WebSocket</span>
          {running && (
            <span className={`badge ${scan.ws?.connected ? 'running' : 'live'}`}>
              WS：{scan.ws?.connected ? '已连接' : scan.ws?.reconnecting ? '重连中' : '未连接'}
            </span>
          )}
        </div>
      </header>

      {showLiveBanner && (
        <div className="live-banner">
          <div className="live-banner-title">⚠️ 实盘模式：真实资金</div>
          <div className="live-banner-body">
            {!(exec?.liveKeysConfigured ?? liveAcct?.keysConfigured) ? (
              <span>请在 server/.env.local 填入实盘 Key（OKX_LIVE_API_KEY / OKX_LIVE_SECRET_KEY / OKX_LIVE_PASSPHRASE），然后重启后端</span>
            ) : (
              <span>
                实盘 USDT 权益 <b className="mono">{liveAcct?.usdtEq == null ? '—' : liveAcct.usdtEq.toFixed(2)}</b> · 可用{' '}
                <b className="mono">{liveAcct?.usdtAvail == null ? '—' : liveAcct.usdtAvail.toFixed(2)}</b>
                {liveAcct?.error ? <span> · 账户读取失败：{liveAcct.error}</span> : null}
              </span>
            )}
            <span>
              {' '}
              · {liveRunning ? (scan.liveTradingActive ? '实盘自动下单：运行中' : '实盘自动下单：未激活') : '尚未启动（开始前需通过检查并输入「确认实盘」）'}
            </span>
          </div>
        </div>
      )}

      <div className="grid">
                <section className="card pnl-card">
          <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>
              <span className="dot" />
              盈亏看板
              <span className={`tag ${pnl?.exec_mode === 'okx_live' ? 'tag-live' : pnl?.exec_mode === 'okx_demo' ? 'tag-demo' : ''}`} style={{ marginLeft: 8 }}>
                {pnl?.exec_mode === 'okx_live' ? '实盘' : pnl?.exec_mode === 'okx_demo' ? '模拟盘' : '本地模拟'}
              </span>
            </h2>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                if (!confirm(`确认清空「${viewModeText}」的历史平仓盈亏记录？持仓不受影响，其他模式的记录保留。`)) return;
                try {
                  const data = await api<{ pnl: PnLDashboard }>('/api/pnl/clear', {
                    method: 'POST',
                    body: JSON.stringify({ exec_mode: pnl?.exec_mode || execSel }),
                  });
                  setPnl(data.pnl || null);
                  await refreshStatus();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              清空记录
            </button>
          </div>
          <div className="status-grid pnl-grid">
            <div className="metric">
              <div className="label">总盈亏 (USDT)</div>
              <div className={`value mono ${pnlClass(pnl?.total_usdt)}`}>{fmtUsdt(pnl?.total_usdt)}</div>
            </div>
            <div className="metric">
              <div className="label">已实现</div>
              <div className={`value mono ${pnlClass(pnl?.realized_usdt)}`}>{fmtUsdt(pnl?.realized_usdt)}</div>
            </div>
            <div className="metric">
              <div className="label">浮动盈亏</div>
              <div className={`value mono ${pnlClass(pnl?.unrealized_usdt)}`}>{fmtUsdt(pnl?.unrealized_usdt)}</div>
            </div>
            <div className="metric">
              <div className="label">今日已实现</div>
              <div className={`value mono ${pnlClass(pnl?.today_realized_usdt)}`}>
                {fmtUsdt(pnl?.today_realized_usdt)}
              </div>
            </div>
            <div className="metric">
              <div className="label">胜率</div>
              <div className="value mono dim">
                {pnl?.win_rate_pct == null ? '—' : `${pnl.win_rate_pct.toFixed(1)}%`}
                <span className="table-meta"> ({pnl?.wins ?? 0}胜/{pnl?.losses ?? 0}负)</span>
              </div>
            </div>
            <div className="metric">
              <div className="label">平仓笔数</div>
              <div className="value mono dim">{pnl?.closed_trades ?? 0}</div>
            </div>
            <div className="metric">
              <div className="label">平均盈利</div>
              <div className={`value mono ${pnlClass(pnl?.avg_win_usdt)}`}>{fmtUsdt(pnl?.avg_win_usdt)}</div>
            </div>
            <div className="metric">
              <div className="label">平均亏损</div>
              <div className={`value mono ${pnlClass(pnl?.avg_loss_usdt)}`}>{fmtUsdt(pnl?.avg_loss_usdt)}</div>
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <div className="table-meta" style={{ marginBottom: 8 }}>
              当前显示：{viewModeText}（本地模拟按估算：盈亏 ≈ 金额 × 杠杆 × 涨跌%；OKX 模拟盘 / 实盘为交易所真实已实现盈亏，含手续费/资金费）
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>交易对</th>
                  <th>来源</th>
                  <th>方向</th>
                  <th>入场</th>
                  <th>出场</th>
                  <th>金额</th>
                  <th>盈亏%</th>
                  <th>手续费</th>
                  <th>盈亏 USDT</th>
                </tr>
              </thead>
              <tbody>
                {!pnl?.recent?.length ? (
                  <tr>
                    <td colSpan={10} className="empty-cell">
                      暂无平仓记录 — 止盈/止损后会出现在这里
                    </td>
                  </tr>
                ) : (
                  pnl.recent.map((t) => (
                    <tr key={t.id || `${t.instId}-${t.closed_at}`}>
                      <td className="mono">{t.closed_at ? localTs(t.closed_at) : '—'}</td>
                      <td className="mono">{t.instId}</td>
                      <td>
                        <span className={`tag ${t.exec_mode === 'okx_live' ? 'tag-live' : ''}`}>{EXEC_TEXT[t.exec_mode || 'sim'] || '本地模拟'}</span>
                      </td>
                      <td>
                        <span className={`pill ${t.action === 'tp' ? 'on' : ''}`}>
                          {ACTION_TEXT[t.action] || t.action}
                        </span>
                      </td>
                      <td className="mono">${fmtPrice(t.entry_price)}</td>
                      <td className="mono">${fmtPrice(t.exit_price)}</td>
                      <td className="mono">{fmtPrice(t.amount)}</td>
                      <td className={`mono ${pnlClass(t.profit_pct)}`}>
                        {t.profit_pct == null
                          ? '—'
                          : `${t.profit_pct >= 0 ? '+' : ''}${t.profit_pct.toFixed(2)}%`}
                      </td>
                      <td className="mono dim">
                        {t.fee_usdt == null ? '—' : t.fee_usdt.toFixed(4)}
                      </td>
                      <td className={`mono ${pnlClass(t.pnl_usdt)}`}>
                        {fmtUsdt(t.pnl_usdt)}
                        {isExchangeMode(t.exec_mode) && !t.pnl_exact ? <span className="tag">估算</span> : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

<section className="card">
          <h2>
            <span className="dot" />
            扫描参数
          </h2>
          <div className="form-grid">
            <div className="field">
              <label>交易模式 mode</label>
              <select value={form.mode} onChange={(e) => setField('mode', e.target.value as Mode)}>
                <option value="spot">spot · USDT 现货</option>
                <option value="swap">swap · USDT 永续</option>
              </select>
            </div>
            {form.mode === 'swap' && (
              <>
                <div className="field">
                  <label>杠杆 leverage</label>
                  <select
                    value={form.leverage}
                    onChange={(e) => setField('leverage', e.target.value)}
                  >
                    {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={String(n)}>
                        {n}x
                      </option>
                    ))}
                  </select>
                  <div className="hint">1–20 倍；盈亏按 金额×杠杆×涨跌% 估算</div>
                </div>
                <div className="field">
                  <label>保证金模式</label>
                  <input value="全仓 cross" disabled readOnly />
                </div>
                <div className="field">
                  <label>仓位方向</label>
                  <input value="多头 long" disabled readOnly />
                </div>
                <div className="field">
                  <label>下单单位</label>
                  <input value="USDT" disabled readOnly />
                </div>
                <div className="field">
                  <label>执行方式</label>
                  <select
                    value={form.exec_mode}
                    disabled={running}
                    onChange={(e) => changeExecMode(e.target.value as ExecMode)}
                  >
                    <option value="sim">本地模拟（不调用下单接口）</option>
                    <option value="okx_demo">OKX 模拟盘（真实调用模拟盘 API）</option>
                    <option value="okx_live">OKX 实盘（真实资金）</option>
                  </select>
                  <div className="hint">
                    {form.exec_mode === 'okx_live'
                      ? '实盘：开始前会做账户检查，并要求手动输入「确认实盘」；杠杆最高 20x'
                      : running
                        ? '扫描中不能切换，请先停止扫描'
                        : '实盘需在 server/.env.local 配置 OKX_LIVE_* Key'}
                  </div>
                </div>
                {isExchangeMode(form.exec_mode) && (
                  <div className="field full">
                    <label>{form.exec_mode === 'okx_live' ? 'OKX 实盘账户（真实资金）' : 'OKX 模拟盘账户'}</label>
                    <div className={`demo-panel ${form.exec_mode === 'okx_live' ? 'live-panel' : ''}`}>
                      <div className="demo-row">
                        <span className="dim">API Key：</span>
                        {keysOk ? (
                          <span className="text-green">✅已配置</span>
                        ) : form.exec_mode === 'okx_live' ? (
                          <span className="text-rose">❌未配置：请在 server/.env.local 填入实盘 Key（OKX_LIVE_API_KEY / OKX_LIVE_SECRET_KEY / OKX_LIVE_PASSPHRASE）</span>
                        ) : (
                          <span className="text-rose">❌未配置，请在 server/.env.local 填写</span>
                        )}
                      </div>
                      {form.exec_mode === 'okx_live' && acct?.perm ? (
                        <div className="demo-row">
                          <span className="dim">Key 权限：</span>
                          <span className={acct.perm.includes('withdraw') ? 'text-rose' : ''}>
                            {acct.perm}
                            {acct.perm.includes('withdraw') ? '（开了提现权限，禁止启动！）' : ''}
                          </span>
                          {acct.ipBound === false ? <span className="text-rose"> · 未绑定 IP（建议绑定）</span> : null}
                        </div>
                      ) : null}
                      <div className="demo-row">
                        <span className="dim">USDT 权益 / 可用：</span>
                        <span className="mono">
                          {acct?.usdtEq == null ? '—' : acct.usdtEq.toFixed(2)} /{' '}
                          {acct?.usdtAvail == null ? '—' : acct.usdtAvail.toFixed(2)}
                        </span>
                      </div>
                      <div className="demo-row">
                        <span className="dim">持仓模式：</span>
                        <span>{acct?.posModeText || acct?.posMode || '—'}</span>
                        {acct?.acctLvText ? <span className="dim"> · 账户模式 {acct.acctLvText}</span> : null}
                      </div>
                      {acct?.updatedAt && (
                        <div className="demo-row dim">更新于 {localTs(acct.updatedAt)}</div>
                      )}
                      {accountMsg && <div className="demo-row">{accountMsg}</div>}
                      <div className="demo-row">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => testAccount(form.exec_mode)}
                          disabled={accountLoading}
                        >
                          {accountLoading ? <span className="spinner" /> : '⟳'} 测试连接 / 刷新余额
                        </button>
                      </div>
                      <div className="hint">
                        下单后立即在交易所挂 OCO 止盈止损（closeFraction=1 全仓，程序崩溃也受保护）；平仓以交易所为准，盈亏为真实已实现（含手续费）。
                        {form.exec_mode === 'okx_live' ? ' 实盘要求：Key 只开读取+交易（不开提现）、绑定 IP；账户模式为合约模式、持仓模式为买卖模式。' : ''}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="field">
              <label>K线周期 bar</label>
              <select value={form.bar} onChange={(e) => setField('bar', e.target.value as Bar)}>
                {(['1m', '5m', '15m', '1H', '4H', '1Dutc'] as Bar[]).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>RSI 周期</label>
              <input
                type="number"
                min="2"
                value={form.rsi_period}
                onChange={(e) => setField('rsi_period', e.target.value)}
              />
            </div>
            <div className="field">
              <label>买入阈值（RSI &lt;）</label>
              <input
                type="number"
                value={form.rsi_buy_threshold}
                onChange={(e) => setField('rsi_buy_threshold', e.target.value)}
              />
              <div className="hint">按实时 RSI（含未收盘 K 线）判定；建议 25–35</div>
            </div>
            <div className="field">
              <label>需收盘确认</label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.confirm_on_close}
                  onChange={(e) => setField('confirm_on_close', e.target.checked)}
                />
                <span>需收盘确认</span>
              </label>
              <div className="hint">勾选后还要求最近已收盘 K 线 RSI 也低于阈值（默认不勾选）</div>
            </div>
            <div className="field">
              <label>{form.mode === 'swap' ? '每笔保证金 USDT' : '每笔金额 USDT'}</label>
              <input
                type="number"
                min="1"
                value={form.amount}
                onChange={(e) => setField('amount', e.target.value)}
              />
              {form.mode === 'swap' && (
                <div className="hint">
                  名义仓位约 {(Number(form.amount) || 0) * (Number(form.leverage) || 1)} USDT
                </div>
              )}
            </div>
            <div className="field">
              <label>止盈 %</label>
              <input
                type="number"
                step="0.1"
                value={form.take_profit_pct}
                onChange={(e) => setField('take_profit_pct', e.target.value)}
              />
            </div>
            <div className="field">
              <label>止损 %</label>
              <input
                type="number"
                step="0.1"
                value={form.stop_loss_pct}
                onChange={(e) => setField('stop_loss_pct', e.target.value)}
              />
            </div>
            <div className="field">
              <label>最大持仓数</label>
              <input
                type="number"
                min="1"
                max="20"
                value={form.max_positions}
                onChange={(e) => setField('max_positions', e.target.value)}
              />
            </div>
            <div className="field">
              <label>连续止损次数后过滤</label>
              <input
                type="number"
                min="1"
                max="20"
                value={form.max_consecutive_sl}
                onChange={(e) => setField('max_consecutive_sl', e.target.value)}
              />
              <div className="hint">同一币连续止损达此次数后暂停开仓</div>
            </div>
            <div className="field">
              <label>过滤时长（小时）</label>
              <input
                type="number"
                min="0"
                max="720"
                value={form.sl_filter_hours}
                onChange={(e) => setField('sl_filter_hours', e.target.value)}
              />
              <div className="hint">默认 24；填 0 表示长期过滤（可手动解除）</div>
            </div>
            <div className="field">
              <label>风控：单日亏损上限 USDT</label>
              <input
                type="number"
                min="0"
                step="10"
                value={form.daily_loss_limit_usdt}
                onChange={(e) => setField('daily_loss_limit_usdt', e.target.value)}
              />
              <div className="hint">今日已实现亏损达到后当天停止开新仓；0 = 不限制</div>
            </div>
            <div className="field">
              <label>风控：每小时最多下单</label>
              <input
                type="number"
                min="1"
                max="1000"
                value={form.max_orders_per_hour}
                onChange={(e) => setField('max_orders_per_hour', e.target.value)}
              />
              <div className="hint">默认 10 笔（仅统计开仓单）</div>
            </div>
            <div className="field">
              <label>风控：最大点差 %</label>
              <input
                type="number"
                min="0.01"
                step="0.05"
                value={form.max_spread_pct}
                onChange={(e) => setField('max_spread_pct', e.target.value)}
              />
              <div className="hint">(卖一−买一)/中间价 超过则跳过，默认 0.3%</div>
            </div>
            <div className="field">
              <label>最小 24h 成交额 USDT</label>
              <input
                type="number"
                min="0"
                step="100000"
                value={form.minVolUsd24h}
                onChange={(e) => setField('minVolUsd24h', e.target.value)}
              />
              <div className="hint">默认 300,000；已自动排除 USDC/DAI 等稳定币</div>
            </div>
            <div className="field">
              <label>Universe 上限</label>
              <input
                type="number"
                min="10"
                max="200"
                value={form.universeLimit}
                onChange={(e) => setField('universeLimit', e.target.value)}
              />
              <div className="hint">默认 120，最大 200；越大 RSI 越慢</div>
            </div>
            <div className="field">
              <label>扫描并发</label>
              <input
                type="number"
                min="1"
                max="12"
                value={form.scanConcurrency}
                onChange={(e) => setField('scanConcurrency', e.target.value)}
              />
            </div>
            <div className="field">
              <label>信号评估间隔（秒）</label>
              <select
                value={form.refreshSec}
                onChange={(e) => setField('refreshSec', e.target.value)}
              >
                <option value="2">2 秒</option>
                <option value="5">5 秒</option>
                <option value="10">10 秒</option>
                <option value="30">30 秒</option>
                <option value="60">60 秒</option>
              </select>
              <div className="hint">行情已改为 WS 推送；此处仅控制信号评估节奏</div>
            </div>
            <div className="field full">
              <label>自选观察（可选，逗号分隔）</label>
              <input
                value={form.watchlist}
                onChange={(e) => setField('watchlist', e.target.value)}
                placeholder="例如 BTC-USDT, ETH-USDT"
              />
              <div className="hint">不强制；会并入扫描列表</div>
            </div>
          </div>

          {isLiveExec && (
            <div className="live-warn">
              ⚠️ 实盘警告：选择「OKX 实盘」后，信号触发会用<strong>真实资金</strong>在 OKX 下单（开始前需通过账户检查并输入「确认实盘」）。盈亏自负。
            </div>
          )}
          {isDemoExec && (
            <div className="config-hint">
              🧪 OKX 模拟盘执行：信号触发后会真实调用 OKX 模拟盘下单接口（x-simulated-trading: 1，不涉及真实资金）。
            </div>
          )}
          {killOn && (
            <div className="live-warn">
              ⛔ 急停已开启（{exec?.risk?.kill_switch?.reason || '急停'}
              {exec?.risk?.kill_switch?.at ? ` · ${localTs(exec.risk.kill_switch.at)}` : ''}）：禁止开新仓。
              <button type="button" className="btn btn-ghost" style={{ marginLeft: 8 }} onClick={onKillReset}>
                解除急停
              </button>
            </div>
          )}
          {modeHint && <div className="config-hint">🔄 {modeHint}</div>}
          {configHint && <div className="config-hint">💡 {configHint}</div>}

          <div className="actions">
            {!running ? (
              <button className={`btn ${isLiveExec ? 'btn-danger' : 'btn-amber'}`} onClick={onStart} disabled={loading || liveModal.loading}>
                {loading || liveModal.loading ? <span className="spinner" /> : '▶'} {isLiveExec ? '开始实盘扫描（真实资金）' : '开始全市场扫描'}
              </button>
            ) : (
              <button className="btn btn-danger" onClick={onStop}>
                ■ 停止扫描
              </button>
            )}
            <button className="btn btn-primary" onClick={onPreviewUniverse} disabled={loading}>
              {loading ? <span className="spinner" /> : '◎'} 预览 Universe
            </button>
            {simPositionCount > 0 && (
              <button className="btn btn-ghost" onClick={onClearPositions}>
                清除本地模拟持仓
              </button>
            )}
            <button className="btn btn-kill" onClick={() => onKill(false)} disabled={killBusy}>
              ⛔ 急停
            </button>
            <button className="btn btn-kill" onClick={() => onKill(true)} disabled={killBusy}>
              {killBusy ? <span className="spinner" /> : '⛔'} 急停并全部平仓
            </button>
          </div>
          {error && <div className="error-toast">{error}</div>}
        </section>

        <section className="card status-card">
          <h2>
            <span className="dot" />
            扫描状态
          </h2>
          <div className="status-grid">
            <div className="metric">
              <div className="label">状态</div>
              <div className={`value ${running ? 'teal' : 'dim'}`}>
                {running ? (scan.scanning ? 'Bootstrap/扫描中' : '运行中') : '空闲'}
              </div>
            </div>
            <div className="metric">
              <div className="label">轮次 / Universe</div>
              <div className="value dim">
                {scan.round ?? 0} / {scan.universeSize ?? '—'}
              </div>
            </div>
            <div className="metric">
              <div className="label">信号数</div>
              <div className={`value ${(scan.signalCount || 0) > 0 ? 'teal' : 'dim'}`}>
                {scan.signalCount ?? 0}
              </div>
            </div>
            <div className="metric">
              <div className="label">持仓 / 上限</div>
              <div className="value dim">
                {positions.length} / {form.max_positions}
              </div>
            </div>
            <div className="metric">
              <div className="label">止损过滤中</div>
              <div className={`value ${(scan.filteredCount || 0) > 0 ? 'amber' : 'dim'}`}>
                {scan.filteredCount ?? 0}
              </div>
            </div>
            <div className="metric">
              <div className="label">执行方式</div>
              <div className={`value ${exec?.exec_mode === 'okx_live' ? 'text-rose' : exec?.exec_mode === 'okx_demo' ? 'amber' : 'teal'}`}>
                {EXEC_TEXT[exec?.exec_mode || 'sim']}
                {running && scan.config?.exec_mode && scan.config.exec_mode !== exec?.exec_mode ? (
                  <span className="table-meta">（扫描中：{EXEC_TEXT[String(scan.config.exec_mode)]}）</span>
                ) : null}
              </div>
            </div>
            <div className="metric">
              <div className="label">今日已实现 / 亏损上限</div>
              <div className={`value mono ${risk?.daily_loss_hit ? 'amber' : pnlClass(risk?.today_realized_usdt)}`}>
                {fmtUsdt(risk?.today_realized_usdt)} / {risk?.daily_loss_limit_usdt ? `-${risk.daily_loss_limit_usdt}` : '不限'}
                {risk?.daily_loss_hit ? <span className="table-meta"> 已停开</span> : null}
              </div>
            </div>
            <div className="metric">
              <div className="label">近 1 小时下单</div>
              <div
                className={`value ${
                  risk && risk.orders_last_hour >= risk.max_orders_per_hour ? 'amber' : 'dim'
                }`}
              >
                {risk?.orders_last_hour ?? 0} / {risk?.max_orders_per_hour ?? form.max_orders_per_hour}
              </div>
            </div>
            <div className="metric">
              <div className="label">急停</div>
              <div className={`value ${killOn ? 'amber' : 'dim'}`}>{killOn ? '已开启' : '关闭'}</div>
            </div>
            <div className="metric">
              <div className="label">行情源</div>
              <div className="value teal">WebSocket</div>
            </div>
            <div className="metric">
              <div className="label">WS 状态</div>
              <div className={`value ${scan.ws?.connected ? 'teal' : running ? 'amber' : 'dim'}`}>
                {!running
                  ? '—'
                  : scan.ws?.connected
                    ? `已连接 (${scan.ws?.aliveCount ?? 0}/${scan.ws?.connCount ?? 0})`
                    : scan.ws?.reconnecting
                      ? '重连中'
                      : '未连接'}
              </div>
            </div>
          </div>
          <div className="signal-banner">
            {scan.note ||
              (running
                ? `WebSocket 推送中 · RSI < ${form.rsi_buy_threshold} · ${form.mode} · K线订阅 ${scan.ws?.candleSubs ?? 0}`
                : '选择 mode → 设置成交量/数量上限 → 点击「开始全市场扫描」（REST 预热 + WS 推送）')}
          </div>
          {scan.lastScanAt && (
            <div className="meta-line">上次扫描 {localTs(scan.lastScanAt)}</div>
          )}
          {exec?.reconcile?.error && (
            <div className="error-toast">{exec.exec_mode === 'okx_live' ? '实盘' : '模拟盘'}对账异常：{exec.reconcile.error}</div>
          )}
          {scan.error && <div className="error-toast">{scan.error}</div>}
        </section>
      </div>

      <section className="card table-card">
        <h2>
          <span className="dot" />
          扫描结果
          <span className="table-meta">{signals.length} 条 · 信号优先 / RSI 升序</span>
        </h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>交易对</th>
                <th>24h成交额</th>
                <th>价格</th>
                <th>RSI</th>
                <th>信号</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {signals.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    暂无数据 — 预览 Universe 或开始扫描
                  </td>
                </tr>
              ) : (
                signals.map((s) => (
                  <tr
                    key={s.instId}
                    className={s.filtered || s.notOnDemo ? 'row-filtered' : s.skipped ? 'row-skipped' : s.signal ? 'row-signal' : ''}
                  >
                    <td className="mono">
                      {s.instId}
                      {s.watchlist ? <span className="tag">自选</span> : null}
                    </td>
                    <td className="mono">{fmtVol(s.volUsd24h)}</td>
                    <td className="mono">${fmtPrice(s.price)}</td>
                    <td className={`mono ${s.signal ? 'text-teal' : ''}`}>
                      {fmtRsi(s.rsi)}
                      {s.forming ? <span className="tag">实时</span> : null}
                      {s.forming && s.rsiClosed != null && s.rsiClosed > 0 ? (
                        <span className="table-meta"> 收盘 {s.rsiClosed.toFixed(2)}</span>
                      ) : null}
                    </td>
                    <td title={s.signalText || ''}>
                      {s.notOnDemo ? (
                        <span className="pill">模拟盘无此合约</span>
                      ) : s.signal && s.skipped ? (
                        <>
                          <span className="pill warn">已跳过</span>
                          <div className="skip-reason">
                            {s.skipReason}
                            {s.skipUntil ? `（${new Date(s.skipUntil).toLocaleTimeString('zh-CN', { hour12: false })} 前不重试）` : ''}
                          </div>
                        </>
                      ) : s.signal && s.submitting ? (
                        <span className="pill warn">提交中</span>
                      ) : s.signal ? (
                        <span className="pill on">触发</span>
                      ) : (
                        <span className="pill">—</span>
                      )}
                    </td>
                    <td className="mono dim">{s.at ? localTs(s.at) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card table-card">
        <h2>
          <span className="dot" />
          持仓
          <span className="table-meta">
            {positions.length} / {form.max_positions}
            {exec?.risk?.pending_opens?.length ? ` · 下单中 ${exec.risk.pending_opens.join(', ')}` : ''}
          </span>
        </h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>交易对</th>
                <th>来源</th>
                <th>张数</th>
                <th>杠杆</th>
                <th>成交均价</th>
                <th>现价</th>
                <th>浮盈%</th>
                <th>浮盈 USDT</th>
                <th>止盈价</th>
                <th>止损价</th>
                <th>交易所止盈止损</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={12} className="empty-cell">
                    暂无持仓 — 信号触发且未满仓时将{isLiveExec ? '在 OKX 实盘下单（真实资金）' : isDemoExec ? '在 OKX 模拟盘下单' : '模拟买入'}
                  </td>
                </tr>
              ) : (
                positions.map((p) => {
                  const isDemo = isExchangeMode(p.exec_mode);
                  const tp =
                    p.take_profit_price ??
                    p.entry_price * (1 + Number(form.take_profit_pct) / 100);
                  const sl =
                    p.stop_loss_price ??
                    p.entry_price * (1 - Number(form.stop_loss_pct) / 100);
                  const pct = p.profit_pct;
                  const lev = p.leverage || 1;
                  const uplUsdt =
                    p.upl != null
                      ? p.upl
                      : pct != null
                        ? (p.amount * lev * pct) / 100
                        : null;
                  return (
                    <tr key={p.instId}>
                      <td className="mono">{p.instId}</td>
                      <td>
                        <span className={`tag ${p.exec_mode === 'okx_live' ? 'tag-live' : ''}`}>{EXEC_TEXT[p.exec_mode || 'sim'] || '本地模拟'}</span>
                      </td>
                      <td className="mono">
                        {isDemo ? p.contractsStr ?? p.contracts ?? '—' : '—'}
                        {isDemo && p.exchange_contracts != null && p.contracts != null && p.exchange_contracts !== p.contracts ? (
                          <span className="table-meta"> (所 {p.exchange_contracts})</span>
                        ) : null}
                      </td>
                      <td className="mono">{p.mode === 'swap' || lev > 1 ? `${lev}x` : '—'}</td>
                      <td className="mono">${fmtPrice(p.entry_price)}</td>
                      <td className="mono">${fmtPrice(p.last_price)}</td>
                      <td className={`mono ${pnlClass(pct)}`}>
                        {pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}
                      </td>
                      <td className={`mono ${pnlClass(uplUsdt)}`}>
                        {fmtUsdt(uplUsdt)}
                        {isDemo && p.upl == null ? <span className="tag">估</span> : null}
                      </td>
                      <td className="mono text-green">${fmtPrice(tp)}</td>
                      <td className="mono text-rose">${fmtPrice(sl)}</td>
                      <td>
                        {!isDemo ? (
                          <span className="pill">本地监控</span>
                        ) : p.tp_sl_attached && p.tp_sl_full !== false ? (
                          <span className="pill on">
                            ✅ 已挂 OCO{p.algo_close_fraction ? '（全仓）' : p.algo_sz ? `（${p.algo_sz} 张）` : ''}
                          </span>
                        ) : p.tp_sl_attached ? (
                          <span className="pill text-rose">⚠️ 仅覆盖部分{p.algo_sz ? ` ${p.algo_sz} 张` : ''}</span>
                        ) : (
                          <span className="pill text-rose">❌ 未挂</span>
                        )}
                      </td>
                      <td>
                        <span className={`pill ${p.status === 'open' ? 'on' : ''}`}>
                          {p.status === 'closing'
                            ? `平仓中${p.close_reason ? `（${ACTION_TEXT[p.close_reason] || p.close_reason}）` : ''}`
                            : p.status === 'open'
                              ? '持仓中'
                              : p.status || 'open'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {externalPositions.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <div className="table-meta" style={{ marginBottom: 8 }}>
              外部持仓（{viewModeText}上非本程序开的仓位，仅展示，不做管理/止盈止损/急停平仓）
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>交易对</th>
                  <th>来源</th>
                  <th>方向</th>
                  <th>张数</th>
                  <th>杠杆</th>
                  <th>均价</th>
                  <th>现价</th>
                  <th>未实现盈亏</th>
                </tr>
              </thead>
              <tbody>
                {externalPositions.map((x) => (
                  <tr key={`${x.instId}-${x.posSide}`} className="row-filtered">
                    <td className="mono">{x.instId}</td>
                    <td>
                      <span className="tag">外部持仓</span>
                    </td>
                    <td>{x.posSide === 'long' ? '多' : x.posSide === 'short' ? '空' : x.pos > 0 ? '多(净)' : '空(净)'}</td>
                    <td className="mono">{x.pos}</td>
                    <td className="mono">{x.lever ? `${x.lever}x` : '—'}</td>
                    <td className="mono">${fmtPrice(x.avgPx)}</td>
                    <td className="mono">${fmtPrice(x.last)}</td>
                    <td className={`mono ${pnlClass(x.upl)}`}>{fmtUsdt(x.upl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>连续止损过滤</h2>
          <span className="table-meta">{filtered.length} 个币暂停开仓</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>交易对</th>
                <th>连续止损</th>
                <th>过滤至</th>
                <th>原因</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    暂无。同一币连续止损达到阈值后会出现在这里。
                  </td>
                </tr>
              ) : (
                filtered.map((f) => (
                  <tr key={f.instId}>
                    <td className="mono">{f.instId}</td>
                    <td className="mono">{f.streak}</td>
                    <td className="mono">{localTs(f.filteredUntil)}</td>
                    <td>{f.reason || '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={async () => {
                          try {
                            await api('/api/filtered/clear', {
                              method: 'POST',
                              body: JSON.stringify({ instId: f.instId }),
                            });
                            await refreshStatus();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        解除
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card logs-card">
        <div className="log-toolbar">
          <h2 style={{ margin: 0 }}>
            <span className="dot" />
            日志 / 事件流
          </h2>
          <button className="btn btn-ghost" onClick={onClearLogs}>
            清空
          </button>
        </div>
        <div className="log-list">
          {logs.length === 0 ? (
            <div className="empty-log">暂无事件 — 开始扫描后将在此显示</div>
          ) : (
            logs.map((l, i) => (
              <div className="log-item" key={`${l.ts}-${i}`}>
                <span className="ts">{localTs(l.ts)}</span>
                <span className={`lvl ${l.level}`}>{l.level}</span>
                <span className="msg">{l.msg}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {liveModal.open && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal live-modal">
            <h2>⚠️ 确认启动 OKX 实盘（真实资金）</h2>
            {liveModal.loading ? (
              <div className="demo-row">
                <span className="spinner" /> 正在检查实盘账户（只读，不下单）…
              </div>
            ) : (
              <>
                {liveModal.check?.summary && (
                  <table className="data-table modal-table">
                    <tbody>
                      <tr>
                        <td>每笔保证金</td>
                        <td className="mono">{liveModal.check.summary.amount} USDT</td>
                      </tr>
                      <tr>
                        <td>杠杆</td>
                        <td className="mono">{liveModal.check.summary.leverage}x（上限 {liveModal.check.maxLeverage ?? 20}x）</td>
                      </tr>
                      <tr>
                        <td>每笔名义金额</td>
                        <td className="mono">约 {liveModal.check.summary.notional.toFixed(2)} USDT</td>
                      </tr>
                      <tr>
                        <td>最大持仓</td>
                        <td className="mono">{liveModal.check.summary.max_positions} 个</td>
                      </tr>
                      <tr>
                        <td>每日亏损上限</td>
                        <td className="mono">{liveModal.check.summary.daily_loss_limit_usdt ? `${liveModal.check.summary.daily_loss_limit_usdt} USDT` : '不限（不建议）'}</td>
                      </tr>
                      <tr>
                        <td>每小时最多下单</td>
                        <td className="mono">{liveModal.check.summary.max_orders_per_hour} 单</td>
                      </tr>
                      <tr>
                        <td>止盈 / 止损</td>
                        <td className="mono">
                          +{liveModal.check.summary.take_profit_pct}% / -{liveModal.check.summary.stop_loss_pct}%（交易所 OCO，全仓）
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {liveModal.check?.checks?.length ? (
                  <div className="check-list">
                    {liveModal.check.checks.map((c) => (
                      <div key={c.key} className={`check-item ${c.ok ? 'ok' : 'bad'}`}>
                        {c.ok ? '✅' : '❌'} {c.label}：<span className="dim">{c.detail}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {liveModal.check?.account && liveModal.check.account.usdtEq != null && (
                  <div className="demo-row">
                    实盘 USDT 权益 <b className="mono">{liveModal.check.account.usdtEq?.toFixed(2)}</b> · 可用{' '}
                    <b className="mono">{liveModal.check.account.usdtAvail?.toFixed(2) ?? '—'}</b>
                  </div>
                )}
                {liveModal.check && !liveModal.check.ok && (
                  <div className="error-toast">启动检查未通过，不能开始实盘：{liveModal.check.reasons.join('；')}</div>
                )}
                {liveModal.check?.ok && (
                  <div className="field">
                    <label>请手动输入「{LIVE_CONFIRM_TEXT}」以开始（真实资金，盈亏自负）</label>
                    <input
                      value={liveModal.text}
                      onChange={(e) => setLiveModal((m) => ({ ...m, text: e.target.value }))}
                      placeholder={LIVE_CONFIRM_TEXT}
                      autoFocus
                    />
                  </div>
                )}
              </>
            )}
            {liveModal.error && <div className="error-toast">{liveModal.error}</div>}
            <div className="actions">
              <button
                type="button"
                className="btn btn-danger"
                disabled={!liveModal.check?.ok || liveModal.text.trim() !== LIVE_CONFIRM_TEXT || liveModal.starting}
                onClick={onConfirmLiveStart}
              >
                {liveModal.starting ? <span className="spinner" /> : '▶'} 开始实盘
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={liveModal.starting}
                onClick={() => setLiveModal({ open: false, loading: false, check: null, text: '', error: null, starting: false })}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="footer">
        <strong>风险提示：</strong>
        默认本地模拟成交；「OKX 模拟盘」仅调用模拟盘接口（不涉及真实资金）；<strong>「OKX 实盘」使用真实资金</strong>
        ，需在 server/.env.local 配置实盘 Key、通过启动检查并手动输入「确认实盘」后才会下单。模拟盘成交价可能与 WebSocket 实盘行情略有差异。行情改为 OKX WebSocket 推送 + 本地 RSI；订阅过多会拆多连接并自动重连。RSI 抄底在单边下跌中可能连续止损。本工具仅供学习研究，不构成投资建议，盈亏自负。
      </footer>
    </div>
  );
}
