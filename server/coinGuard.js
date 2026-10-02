/**
 * 同币冷却 / 止损过滤（本地模拟 · OKX 模拟盘 · OKX 实盘 通用，按执行模式分开计算）
 *
 * 规则：
 *  1) 普通止损：平仓后该币冷却 sl_cooldown_minutes 分钟（默认 60）
 *  2) 严重止损：实际平仓价格变动亏损（不含杠杆）≥ severe_sl_pct%（默认 3%）→ 冷却 severe_sl_cooldown_hours 小时（默认 24）
 *     强平一律按严重止损处理
 *  3) 滚动窗口止损次数：sl_filter_hours 小时内止损累计 ≥ max_consecutive_sl 次 → 暂停 sl_filter_hours 小时
 *     （止盈不再清零；窗口外的止损自然过期）
 *  多条规则同时命中时取结束时间最晚的一条；已有冷却不会被缩短。
 *  状态落盘到 JSON 文件（原子写），重启后恢复。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';

export const GUARD_DEFAULTS = Object.freeze({
  sl_cooldown_minutes: 60,
  severe_sl_pct: 3,
  severe_sl_cooldown_hours: 24,
  max_consecutive_sl: 2,
  sl_filter_hours: 24,
});

const KIND_TEXT = { normal: '普通止损', severe: '严重止损', streak: '连续止损', disaster: '灾难止损' };
export const DEFAULT_GUARD_STRATEGY = 'rsi_dip'; // 旧冷却条目（无 strategy_id）归入此策略；key = mode|strategy_id|instId
const MODE_TEXT = { sim: '本地模拟', okx_demo: 'OKX 模拟盘', okx_live: 'OKX 实盘' };
const LONG_MS = 365 * 24 * 3600 * 1000;

function num(v, def) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 冷却相关参数归一化（缺省用默认值；越界夹紧） */
export function clampGuardCfg(cfg = {}) {
  const d = GUARD_DEFAULTS;
  return {
    sl_cooldown_minutes: Math.max(0, Math.min(1440, num(cfg.sl_cooldown_minutes, d.sl_cooldown_minutes))),
    severe_sl_pct: Math.max(0.5, Math.min(50, num(cfg.severe_sl_pct, d.severe_sl_pct))),
    severe_sl_cooldown_hours: Math.max(0, Math.min(168, num(cfg.severe_sl_cooldown_hours, d.severe_sl_cooldown_hours))),
    max_consecutive_sl: Math.max(1, Math.min(20, Math.round(num(cfg.max_consecutive_sl, d.max_consecutive_sl)) || d.max_consecutive_sl)),
    sl_filter_hours: Math.max(0, Math.min(24 * 30, num(cfg.sl_filter_hours, d.sl_filter_hours))),
  };
}

export function kindText(kind) {
  return KIND_TEXT[kind] || '止损';
}

export function remainingText(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (ms >= LONG_MS / 2) return '长期（需手动解除）';
  return m >= 120 ? `剩余${m}分钟（约${(m / 60).toFixed(1)}小时）` : `剩余${m}分钟`;
}

export class CoinGuard {
  /**
   * @param {{ path?: string|null, log?: Function, now?: () => number }} opts
   */
  constructor({ path = null, log = () => {}, now = () => Date.now() } = {}) {
    this.path = path;
    this.log = log;
    this.now = now;
    /** key(mode|strategy_id|instId) -> { instId, exec_mode, slTimes:number[], cooldown:null|{until,kind,reason,at,lossPct} } */
    this.map = new Map();
  }

  static key(mode, instId, strategyId = DEFAULT_GUARD_STRATEGY) {
    return `${mode || 'sim'}|${strategyId || DEFAULT_GUARD_STRATEGY}|${instId}`;
  }

  _get(mode, instId, create = false, strategyId = DEFAULT_GUARD_STRATEGY) {
    const k = CoinGuard.key(mode, instId, strategyId);
    let g = this.map.get(k);
    if (!g && create) {
      g = { instId, exec_mode: mode || 'sim', strategy_id: strategyId || DEFAULT_GUARD_STRATEGY, slTimes: [], cooldown: null };
      this.map.set(k, g);
    }
    return g || null;
  }

  _windowMs(cfg) {
    const h = cfg.sl_filter_hours > 0 ? cfg.sl_filter_hours : 24;
    return h * 3600 * 1000;
  }

  /** 清理过期冷却与窗口外止损；返回是否有变化 */
  prune(cfgRaw) {
    const cfg = clampGuardCfg(cfgRaw);
    const now = this.now();
    const cut = now - this._windowMs(cfg);
    let changed = false;
    for (const [k, g] of this.map.entries()) {
      if (g.cooldown && g.cooldown.until <= now) {
        g.cooldown = null;
        changed = true;
      }
      const before = g.slTimes.length;
      g.slTimes = g.slTimes.filter((t) => t > cut);
      if (g.slTimes.length !== before) changed = true;
      if (!g.cooldown && g.slTimes.length === 0) {
        this.map.delete(k);
        changed = true;
      }
    }
    return changed;
  }

  /** 窗口内止损次数 */
  slCount(mode, instId, cfgRaw, strategyId = DEFAULT_GUARD_STRATEGY) {
    const cfg = clampGuardCfg(cfgRaw);
    const g = this._get(mode, instId, false, strategyId);
    if (!g) return 0;
    const cut = this.now() - this._windowMs(cfg);
    return g.slTimes.filter((t) => t > cut).length;
  }

  /**
   * 止损/强平平仓后调用
   * @param {string} mode 执行模式
   * @param {string} instId
   * @param {object} cfgRaw 当前配置
   * @param {{ lossPct?: number, at?: number, liq?: boolean }} info lossPct=价格变动%（负数为亏损，不含杠杆）
   * @returns {{ kind:string, until:number, reason:string, count:number }|null}
   */
  onStopLoss(mode, instId, cfgRaw, { lossPct = null, at = null, liq = false, strategyId = DEFAULT_GUARD_STRATEGY } = {}) {
    const cfg = clampGuardCfg(cfgRaw);
    const now = this.now();
    let t = Number(at);
    if (!Number.isFinite(t) || t <= 0 || t > now) t = now;
    const g = this._get(mode, instId, true, strategyId);
    const cut = now - this._windowMs(cfg);
    g.slTimes = g.slTimes.filter((x) => x > cut);
    g.slTimes.push(t);
    g.slTimes.sort((a, b) => a - b);
    const count = g.slTimes.length;
    const drop = Number.isFinite(Number(lossPct)) ? -Number(lossPct) : null; // 亏损幅度（正数）
    const severe = liq || (drop != null && drop >= cfg.severe_sl_pct);
    const cands = [];
    if (severe) {
      if (cfg.severe_sl_cooldown_hours > 0) {
        cands.push({
          kind: 'severe',
          until: t + cfg.severe_sl_cooldown_hours * 3600 * 1000,
          reason: `${liq ? '强平' : `严重止损：亏损 ${drop.toFixed(2)}% ≥ ${cfg.severe_sl_pct}%`}，冷却 ${cfg.severe_sl_cooldown_hours} 小时`,
        });
      }
    } else if (cfg.sl_cooldown_minutes > 0) {
      cands.push({
        kind: 'normal',
        until: t + cfg.sl_cooldown_minutes * 60 * 1000,
        reason: `普通止损${drop != null ? `：亏损 ${drop.toFixed(2)}%` : ''}，冷却 ${cfg.sl_cooldown_minutes} 分钟`,
      });
    }
    if (count >= cfg.max_consecutive_sl) {
      const ms = cfg.sl_filter_hours > 0 ? cfg.sl_filter_hours * 3600 * 1000 : LONG_MS;
      cands.push({
        kind: 'streak',
        until: t + ms,
        reason: `${cfg.sl_filter_hours > 0 ? `${cfg.sl_filter_hours} 小时内` : ''}止损 ${count} 次（阈值 ${cfg.max_consecutive_sl}），暂停${cfg.sl_filter_hours > 0 ? ` ${cfg.sl_filter_hours} 小时` : '（长期，需手动解除）'}`,
      });
    }
    let best = null;
    for (const c of cands) if (!best || c.until > best.until) best = c;
    const cur = g.cooldown && g.cooldown.until > now ? g.cooldown : null;
    if (best && best.until > now && (!cur || best.until > cur.until)) {
      g.cooldown = { ...best, at: t, lossPct: Number.isFinite(Number(lossPct)) ? Number(lossPct) : null };
    }
    this.save();
    const active = g.cooldown && g.cooldown.until > now ? g.cooldown : null;
    const tag = `[冷却]${MODE_TEXT[mode] ? `[${MODE_TEXT[mode]}]` : ''}`;
    if (active) {
      this.log(
        active.kind === 'normal' ? 'info' : 'warn',
        `${tag} ${instId} ${active.reason}（窗口内止损 ${count}/${cfg.max_consecutive_sl}），${remainingText(active.until - now)}，至 ${new Date(active.until).toLocaleString('zh-CN', { hour12: false })}`
      );
    } else {
      this.log('info', `${tag} ${instId} 止损（窗口内 ${count}/${cfg.max_consecutive_sl}），冷却已关闭`);
    }
    return active ? { kind: active.kind, until: active.until, reason: active.reason, count } : null;
  }

  /**
   * 信号出场策略专用：灾难止损 / 强平后，该币对该策略冷却 minutes 分钟（正常策略平仓不冷却）。
   * 已有更长的冷却不会被缩短。minutes<=0 表示不冷却。
   * @returns {{kind:string, until:number, reason:string}|null}
   */
  onDisasterStop(mode, instId, { strategyId, minutes = 60, at = null, lossPct = null, liq = false } = {}) {
    const mins = Number(minutes);
    if (!(mins > 0)) return null;
    const now = this.now();
    let t = Number(at);
    if (!Number.isFinite(t) || t <= 0 || t > now) t = now;
    const g = this._get(mode, instId, true, strategyId);
    const until = t + mins * 60 * 1000;
    const reason = `${liq ? '强平' : '灾难止损触发'}${Number.isFinite(Number(lossPct)) ? `（价格 ${Number(lossPct).toFixed(2)}%）` : ''}，冷却 ${mins} 分钟`;
    const cur = g.cooldown && g.cooldown.until > now ? g.cooldown : null;
    if (until > now && (!cur || until > cur.until)) g.cooldown = { kind: 'disaster', until, reason, at: t, lossPct: Number.isFinite(Number(lossPct)) ? Number(lossPct) : null };
    this.save();
    const tag = `[冷却]${MODE_TEXT[mode] ? `[${MODE_TEXT[mode]}]` : ''}`;
    this.log('warn', `${tag} ${instId} ${reason}，至 ${new Date(g.cooldown?.until || until).toLocaleString('zh-CN', { hour12: false })}`);
    return g.cooldown ? { kind: g.cooldown.kind, until: g.cooldown.until, reason: g.cooldown.reason } : null;
  }

  /**
   * 首次启用（无状态文件）时，按账本里近期的止损/强平记录补建冷却，避免升级重启后立刻重复开刚止损的币
   * @param {object[]} trades 账本记录（任意顺序）
   * @returns {number} 补建后生效中的冷却数量
   */
  seedFromTrades(trades, cfgRaw) {
    const cfg = clampGuardCfg(cfgRaw);
    const now = this.now();
    const lookback = Math.max(this._windowMs(cfg), cfg.severe_sl_cooldown_hours * 3600 * 1000, cfg.sl_cooldown_minutes * 60 * 1000);
    const list = (trades || [])
      .filter((t) => t && t.instId && (t.action === 'sl' || t.action === 'liq') && t.closed_at)
      .map((t) => ({ t, at: Date.parse(t.closed_at) }))
      .filter((x) => Number.isFinite(x.at) && x.at > now - lookback && x.at <= now)
      .sort((a, b) => a.at - b.at);
    const log = this.log;
    this.log = () => {};
    try {
      for (const { t, at } of list) {
        this.onStopLoss(t.exec_mode || 'sim', t.instId, cfg, { lossPct: Number(t.profit_pct), at, liq: t.action === 'liq', strategyId: t.strategy_id || DEFAULT_GUARD_STRATEGY });
      }
    } finally {
      this.log = log;
    }
    this.save();
    return [...this.map.values()].filter((g) => g.cooldown && g.cooldown.until > now).length;
  }

  /** 止盈：不清零窗口内止损次数，也不解除冷却（仅作记录） */
  onTakeProfit(_mode, _instId) {
    return null;
  }

  /** 查询冷却：null 表示可开仓 */
  check(mode, instId, strategyId = DEFAULT_GUARD_STRATEGY) {
    const g = this._get(mode, instId, false, strategyId);
    if (!g || !g.cooldown) return null;
    const now = this.now();
    if (g.cooldown.until <= now) {
      g.cooldown = null;
      this.save();
      return null;
    }
    const remainingMs = g.cooldown.until - now;
    return {
      kind: g.cooldown.kind,
      until: g.cooldown.until,
      remainingMs,
      reason: g.cooldown.reason,
      text: `冷却中：${kindText(g.cooldown.kind)}，${remainingText(remainingMs)}`,
    };
  }

  /** 当前所有生效中的冷却（界面「暂停开仓」列表） */
  list(cfgRaw) {
    const now = this.now();
    if (this.prune(cfgRaw)) this.save();
    const out = [];
    for (const g of this.map.values()) {
      if (!g.cooldown || g.cooldown.until <= now) continue;
      out.push({
        instId: g.instId,
        exec_mode: g.exec_mode,
        strategy_id: g.strategy_id || DEFAULT_GUARD_STRATEGY,
        kind: g.cooldown.kind,
        kindText: kindText(g.cooldown.kind),
        streak: this.slCount(g.exec_mode, g.instId, cfgRaw, g.strategy_id),
        filteredUntil: new Date(g.cooldown.until).toISOString(),
        remainingMs: g.cooldown.until - now,
        remainingText: remainingText(g.cooldown.until - now),
        reason: g.cooldown.reason,
        lossPct: g.cooldown.lossPct ?? null,
        updatedAt: g.cooldown.at ? new Date(g.cooldown.at).toISOString() : null,
      });
    }
    out.sort((a, b) => a.instId.localeCompare(b.instId) || a.exec_mode.localeCompare(b.exec_mode));
    return out;
  }

  /** 手动解除：instId 为空则全部；mode / strategyId 为空则所有模式 / 所有策略。同时清空该币窗口内止损次数 */
  clear(instId = null, mode = null, strategyId = null) {
    let n = 0;
    for (const [k, g] of [...this.map.entries()]) {
      if (instId && g.instId !== instId) continue;
      if (mode && g.exec_mode !== mode) continue;
      if (strategyId && (g.strategy_id || DEFAULT_GUARD_STRATEGY) !== strategyId) continue;
      this.map.delete(k);
      n++;
    }
    this.save();
    return n;
  }

  toJSON() {
    return {
      updatedAt: new Date(this.now()).toISOString(),
      version: 2,
      items: [...this.map.values()].map((g) => ({ instId: g.instId, exec_mode: g.exec_mode, strategy_id: g.strategy_id || DEFAULT_GUARD_STRATEGY, slTimes: g.slTimes, cooldown: g.cooldown })),
    };
  }

  save() {
    if (!this.path) return;
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf8');
      renameSync(tmp, this.path);
    } catch (e) {
      this.log('warn', `冷却状态保存失败：${e.message}`);
    }
  }

  /** 从文件恢复；返回恢复的生效冷却数量 */
  load(cfgRaw) {
    this.map.clear();
    if (!this.path || !existsSync(this.path)) return 0;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const it of Array.isArray(raw?.items) ? raw.items : []) {
        if (!it || !it.instId) continue;
        const mode = it.exec_mode || 'sim';
        const sid = it.strategy_id || DEFAULT_GUARD_STRATEGY; // 旧条目缺 strategy_id → rsi_dip
        const cd = it.cooldown && Number.isFinite(Number(it.cooldown.until)) ? { ...it.cooldown, until: Number(it.cooldown.until) } : null;
        this.map.set(CoinGuard.key(mode, it.instId, sid), {
          instId: it.instId,
          exec_mode: mode,
          strategy_id: sid,
          slTimes: (Array.isArray(it.slTimes) ? it.slTimes : []).map(Number).filter((t) => Number.isFinite(t) && t > 0),
          cooldown: cd,
        });
      }
      this.prune(cfgRaw);
      const now = this.now();
      return [...this.map.values()].filter((g) => g.cooldown && g.cooldown.until > now).length;
    } catch (e) {
      this.log('warn', `读取冷却状态失败：${e.message}`);
      return 0;
    }
  }
}
