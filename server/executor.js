/**
 * OKX 执行器（模拟盘 okx_demo / 实盘 okx_live）· USDT 永续多头 · 全仓
 * - okx_demo：OKX_DEMO_* Key + x-simulated-trading: 1
 * - okx_live：OKX_LIVE_* Key，不带模拟盘头（真实资金）
 *
 * 开仓流程：
 *   1) 缓存合约规格 /api/v5/public/instruments?instType=SWAP（ctVal/lotSz/minSz/tickSz）
 *   2) 读取账户配置 /api/v5/account/config（posMode：long_short_mode / net_mode）
 *   3) 点差检查（对应环境 ticker）+ 余额检查 /api/v5/account/balance
 *   4) 首次或杠杆变化时 /api/v5/account/set-leverage（cross）
 *   5) 张数 = floor(保证金×杠杆 / (ctVal×价格) / lotSz) × lotSz，低于 minSz 则跳过
 *   6) 市价买入 /api/v5/trade/order（tdMode=cross，唯一 clOrdId，按 instId 加锁）
 *   7) 查询订单 /api/v5/trade/order 获取 avgPx/accFillSz/fee
 *   8) 交易所端 OCO 止盈止损 /api/v5/trade/order-algo（ordType=oco，市价 -1）
 *      失败 → 立即市价平仓（fail-safe）
 */
import { OkxRestClient, OkxApiError } from './okxRest.js';
import { pickCloseRecord, closeKeyOf } from './closeMatch.js';

const INST_TTL_MS = 6 * 3600 * 1000;
/** 实盘杠杆硬上限（后端强制） */
export const LIVE_MAX_LEVERAGE = 20;
const BAL_TTL_MS = 5000;

/** 环境变量前缀：okx_live → OKX_LIVE_；其他 → OKX_DEMO_ */
function envPrefix(mode) {
  return mode === 'okx_live' ? 'OKX_LIVE_' : 'OKX_DEMO_';
}

/** 某执行模式的 Key 是否已配置（只判断是否非空，绝不返回/打印值） */
export function keysConfiguredFor(mode) {
  const pre = envPrefix(mode);
  return !!(
    String(process.env[`${pre}API_KEY`] || '').trim() &&
    String(process.env[`${pre}SECRET_KEY`] || '').trim() &&
    String(process.env[`${pre}PASSPHRASE`] || '').trim()
  );
}

export function demoKeysConfigured() {
  return keysConfiguredFor('okx_demo');
}

export function liveKeysConfigured() {
  return keysConfiguredFor('okx_live');
}

/** 小数位数（按步长字符串） */
export function decimalsOf(step) {
  const s = String(step);
  if (/e-/i.test(s)) {
    const [base, exp] = s.toLowerCase().split('e-');
    const baseDec = (base.split('.')[1] || '').length;
    return baseDec + Number(exp);
  }
  return (s.split('.')[1] || '').length;
}

/** 按步长向下取整，返回 { value, str } */
export function floorToStep(value, step) {
  const st = Number(step);
  if (!(st > 0) || !Number.isFinite(value)) return { value: 0, str: '0' };
  const dec = decimalsOf(step);
  const steps = Math.floor(value / st + 1e-9);
  const v = Number((steps * st).toFixed(dec));
  return { value: v, str: v.toFixed(dec) };
}

/** 按 tickSz 四舍五入价格 */
export function roundToTick(px, tickSz) {
  const st = Number(tickSz);
  if (!(st > 0) || !Number.isFinite(px)) return { value: px, str: String(px) };
  const dec = decimalsOf(tickSz);
  const v = Number((Math.round(px / st) * st).toFixed(dec));
  return { value: v, str: v.toFixed(dec) };
}

/**
 * 张数计算：contracts = floor((amount × leverage) / (ctVal × price) / lotSz) × lotSz
 */
export function calcContracts({ amount, leverage, price, ctVal, lotSz, minSz }) {
  const notionalTarget = Number(amount) * Number(leverage);
  const perContract = Number(ctVal) * Number(price);
  if (!(perContract > 0) || !(notionalTarget > 0)) {
    return { contracts: 0, contractsStr: '0', notional: 0, belowMin: true, raw: 0 };
  }
  const raw = notionalTarget / perContract;
  const { value, str } = floorToStep(raw, lotSz);
  return {
    contracts: value,
    contractsStr: str,
    notional: value * perContract,
    belowMin: !(value >= Number(minSz) - 1e-12) || value <= 0,
    raw,
  };
}

function genId(prefix) {
  // 仅字母数字，≤32 位
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}${ts}${rnd}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OkxExecutor {
  /** @param {{ log: (level:string, msg:string)=>void, mode?: 'okx_demo'|'okx_live' }} opts */
  constructor({ log, mode = 'okx_demo' }) {
    this.log = log || (() => {});
    this.mode = mode === 'okx_live' ? 'okx_live' : 'okx_demo';
    this.isLive = this.mode === 'okx_live';
    this.envText = this.isLive ? '实盘' : '模拟盘';
    this.tag = this.isLive ? '[实盘]' : '[模拟盘]';
    this.buyTag = this.isLive ? '[实盘买入]' : '[模拟盘买入]';
    this.client = null;
    this.instruments = new Map();
    this.instLoadedAt = 0;
    this.accountConfig = null; // { posMode, acctLv, at }
    this.balance = null; // { usdtEq, usdtAvail, totalEq, at }
    this.balanceAt = 0;
    this.accountError = null;
    this.leverageSet = new Map(); // instId -> lever
    this.locks = new Set();
    this.lastTimeSync = 0;
    this.rebuildClient();
  }

  rebuildClient() {
    const pre = envPrefix(this.mode);
    this.client = new OkxRestClient({
      apiKey: process.env[`${pre}API_KEY`],
      secretKey: process.env[`${pre}SECRET_KEY`],
      passphrase: process.env[`${pre}PASSPHRASE`],
      simulated: !this.isLive,
      allowLive: this.isLive,
      // 可选：OKX_DEMO_REST_BASE / OKX_LIVE_REST_BASE；默认 https://www.okx.com
      baseUrl: String(process.env[`${pre}REST_BASE`] || '').trim() || undefined,
      timeoutMs: 10000,
      minIntervalMs: 120,
    });
  }

  keysConfigured() {
    return keysConfiguredFor(this.mode);
  }

  get posMode() {
    return this.accountConfig?.posMode || null;
  }

  isLongShort() {
    return this.posMode === 'long_short_mode';
  }

  async ensureTimeSync() {
    if (Date.now() - this.lastTimeSync < 30 * 60 * 1000) return;
    await this.client.syncTime();
    this.lastTimeSync = Date.now();
  }

  async loadInstruments(force = false) {
    if (!force && this.instruments.size && Date.now() - this.instLoadedAt < INST_TTL_MS) return this.instruments;
    const rows = await this.client.getInstruments('SWAP');
    const map = new Map();
    for (const r of rows) {
      if (!r?.instId) continue;
      map.set(r.instId, {
        instId: r.instId,
        ctVal: r.ctVal,
        ctValCcy: r.ctValCcy,
        lotSz: r.lotSz,
        minSz: r.minSz,
        tickSz: r.tickSz,
        maxLever: Number(r.lever) || null,
        state: r.state,
        settleCcy: r.settleCcy,
        ctType: r.ctType,
      });
    }
    if (map.size) {
      this.instruments = map;
      this.instLoadedAt = Date.now();
    }
    return this.instruments;
  }

  getInst(instId) {
    return this.instruments.get(instId) || null;
  }

  async refreshAccountConfig() {
    const rows = await this.client.getAccountConfig();
    const c = rows?.[0] || {};
    this.accountConfig = {
      posMode: c.posMode || null,
      acctLv: c.acctLv || null,
      // Key 权限（read_only / trade / withdraw），用于实盘启动检查
      perm: String(c.perm || ''),
      ipBound: !!String(c.ip || '').trim(),
      at: new Date().toISOString(),
    };
    return this.accountConfig;
  }

  async refreshBalance(force = false) {
    if (!force && this.balance && Date.now() - this.balanceAt < BAL_TTL_MS) return this.balance;
    const rows = await this.client.getBalance('USDT');
    const acc = rows?.[0] || {};
    const usdt = (acc.details || []).find((d) => d.ccy === 'USDT') || {};
    const num = (v) => (v === '' || v == null ? null : Number(v));
    this.balance = {
      totalEq: num(acc.totalEq),
      usdtEq: num(usdt.eq),
      usdtAvail: num(usdt.availBal) ?? num(usdt.availEq),
      usdtCash: num(usdt.cashBal),
      upl: num(usdt.upl),
      at: new Date().toISOString(),
    };
    this.balanceAt = Date.now();
    return this.balance;
  }

  /** 连通性测试 + 账户摘要（只读） */
  async refreshAccount() {
    if (!this.keysConfigured()) {
      this.accountError = null;
      return this.accountSummary();
    }
    try {
      await this.ensureTimeSync();
      await this.refreshAccountConfig();
      await this.refreshBalance(true);
      this.accountError = null;
    } catch (e) {
      this.accountError = e.message;
      throw e;
    }
    return this.accountSummary();
  }

  accountSummary() {
    return {
      keysConfigured: this.keysConfigured(),
      posMode: this.posMode,
      posModeText:
        this.posMode === 'long_short_mode' ? '开平仓模式（双向持仓）' : this.posMode === 'net_mode' ? '买卖模式（单向持仓）' : null,
      acctLv: this.accountConfig?.acctLv || null,
      acctLvText: acctLvText(this.accountConfig?.acctLv),
      perm: this.accountConfig?.perm || null,
      ipBound: this.accountConfig ? !!this.accountConfig.ipBound : null,
      exec_mode: this.mode,
      envText: this.envText,
      usdtEq: this.balance?.usdtEq ?? null,
      usdtAvail: this.balance?.usdtAvail ?? null,
      totalEq: this.balance?.totalEq ?? null,
      updatedAt: this.balance?.at || this.accountConfig?.at || null,
      error: this.accountError,
    };
  }

  /** 开始扫描前准备：校时 + 合约规格 + 账户配置 */
  async prepare() {
    if (!this.keysConfigured()) throw new Error(`未配置 OKX ${this.envText} API Key，请在 server/.env.local 填写`);
    await this.ensureTimeSync();
    await this.loadInstruments(true);
    await this.refreshAccountConfig();
    await this.refreshBalance(true);
    this.accountError = null;
    if (this.accountConfig.acctLv === '1') {
      this.log('warn', `${this.tag} 账户模式为「现货模式」，无法交易永续；请在 OKX ${this.envText} → 设置 → 账户模式 切换为「合约模式」`);
    }
    return this.accountSummary();
  }

  async getDemoTicker(instId) {
    const rows = await this.client.getTicker(instId);
    const r = rows?.[0];
    if (!r) return null;
    return { last: Number(r.last), askPx: Number(r.askPx), bidPx: Number(r.bidPx) };
  }

  async ensureLeverage(instId, lever) {
    if (this.leverageSet.get(instId) === lever) return;
    // 全仓 cross 下 set-leverage 不需要 posSide（官方文档：仅「逐仓 + 开平仓模式」需要）
    await this.client.setLeverage({ instId, lever: String(lever), mgnMode: 'cross' });
    this.leverageSet.set(instId, lever);
    this.log('info', `${this.tag} ${instId} 已设置杠杆 ${lever}x（全仓）`);
  }

  async _placeOrderIdempotent(body) {
    try {
      const rows = await this.client.placeOrder(body);
      return rows?.[0] || {};
    } catch (e) {
      if (e instanceof OkxApiError && e.network && body.clOrdId) {
        // 网络超时：用 clOrdId 查询是否已下单成功（幂等，不重复下单）
        for (let i = 0; i < 3; i++) {
          await sleep(500 * (i + 1));
          try {
            const q = await this.client.getOrder(body.instId, { clOrdId: body.clOrdId });
            if (q?.[0]?.ordId) {
              this.log('warn', `${this.tag} 下单响应超时，但按 clOrdId 查到订单 ${q[0].ordId}，继续处理`);
              return { ordId: q[0].ordId, clOrdId: body.clOrdId };
            }
          } catch {
            /* 继续重试 */
          }
        }
      }
      throw e;
    }
  }

  /**
   * 轮询订单直到终态（filled / canceled / mmp_canceled），最长 timeoutMs（默认 15 秒）
   * @returns {Promise<{order:object|null, final:boolean}>}
   */
  async _waitFill(instId, ordId, timeoutMs = 15000) {
    let last = null;
    let lastErr = null;
    const deadline = Date.now() + timeoutMs;
    let i = 0;
    while (Date.now() < deadline) {
      await sleep(i === 0 ? 250 : 500);
      i++;
      try {
        const rows = await this.client.getOrder(instId, { ordId });
        last = rows?.[0] || last;
        lastErr = null;
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (!last) continue;
      if (last.state === 'filled' || last.state === 'canceled' || last.state === 'mmp_canceled') {
        return { order: last, final: true };
      }
    }
    if (!last && lastErr) throw lastErr;
    return { order: last, final: false };
  }

  /** 读取交易所该合约的多头持仓（net 模式 pos>0 / 双向模式 posSide=long） */
  async getExchangeLong(instId) {
    const rows = await this.client.getPositions('SWAP', instId);
    const longShort = this.isLongShort();
    const r = (rows || []).find(
      (p) => p.instId === instId && Number(p.pos) !== 0 && (longShort ? p.posSide === 'long' : p.posSide === 'net' && Number(p.pos) > 0)
    );
    if (!r) return null;
    return { pos: Number(r.pos), avgPx: Number(r.avgPx), raw: r };
  }

  /** 按合约 lotSz 格式化张数 */
  fmtContracts(instId, n) {
    const inst = this.getInst(instId);
    if (!inst) return String(Number(n));
    return Number(n).toFixed(decimalsOf(inst.lotSz));
  }

  /**
   * 市价开多（完整流程：规格 → 点差 → 余额 → 张数 → 杠杆 → 下单 → 查成交 → OCO）
   * @returns {Promise<{ok:true,pos:object}|{ok:false,skipped?:boolean,uncertain?:boolean,reason:string}>}
   */
  async openLong({ instId, amount, leverage, tpPct, slPct, rsi, rsiClosed, maxSpreadPct, profile = 'demo', onSubmit, onPending, recheck }) {
    if (this.locks.has(instId)) return { ok: false, skipped: true, skipKind: 'lock', reason: `${instId} 正在下单中，跳过重复开仓` };
    this.locks.add(instId);
    try {
      await this.loadInstruments();
      if (!this.accountConfig) await this.refreshAccountConfig();
      const inst = this.getInst(instId);
      if (!inst) return { ok: false, skipped: true, skipKind: 'no_inst', reason: `${instId} 在${this.envText}无此合约，跳过` };
      if (inst.state && inst.state !== 'live') return { ok: false, skipped: true, skipKind: 'inst_state', reason: `${instId} 合约状态 ${inst.state}，跳过` };

      let lever = Math.max(1, Math.round(Number(leverage) || 1));
      if (this.isLive && lever > LIVE_MAX_LEVERAGE) {
        // 实盘硬上限（后端强制）
        this.log('warn', `${this.tag} ${instId} 杠杆 ${lever}x 超过实盘上限 ${LIVE_MAX_LEVERAGE}x，已下调`);
        lever = LIVE_MAX_LEVERAGE;
      }
      if (inst.maxLever && lever > inst.maxLever) {
        this.log('warn', `${this.tag} ${instId} 最大杠杆 ${inst.maxLever}x，已由 ${lever}x 下调`);
        lever = inst.maxLever;
      }

      // 点差检查（对应环境盘口）
      const tk = await this.getDemoTicker(instId);
      if (!tk || !(tk.askPx > 0) || !(tk.bidPx > 0)) return { ok: false, skipped: true, skipKind: 'no_quote', reason: `${instId} ${this.envText}盘口无报价，跳过` };
      const mid = (tk.askPx + tk.bidPx) / 2;
      const spreadPct = ((tk.askPx - tk.bidPx) / mid) * 100;
      if (spreadPct > maxSpreadPct) {
        return { ok: false, skipped: true, skipKind: 'spread', reason: `${instId} ${this.envText}点差 ${spreadPct.toFixed(3)}% > 上限 ${maxSpreadPct}%，跳过` };
      }

      // 余额检查
      const bal = await this.refreshBalance(true);
      if (bal.usdtAvail == null || bal.usdtAvail < amount) {
        return {
          ok: false,
          skipped: true,
          skipKind: 'balance',
          reason: `${this.envText}可用 USDT ${bal.usdtAvail == null ? '未知' : bal.usdtAvail.toFixed(2)} < 每笔保证金 ${amount}，跳过 ${instId}`,
        };
      }

      // 张数
      const size = calcContracts({ amount, leverage: lever, price: tk.askPx, ctVal: inst.ctVal, lotSz: inst.lotSz, minSz: inst.minSz });
      if (size.belowMin) {
        return {
          ok: false,
          skipped: true,
          skipKind: 'min_size',
          reason: `${instId} 计算张数 ${size.contractsStr} 低于最小下单量 ${inst.minSz} 张（每张 ${inst.ctVal} ${inst.ctValCcy} ≈ ${(
            Number(inst.ctVal) * tk.askPx
          ).toFixed(2)} USDT），跳过`,
        };
      }

      await this.ensureLeverage(instId, lever);

      // 下单前最后一次复核（实时 RSI 仍低于阈值、未急停、扫描仍在运行）
      let rsiNow = rsi;
      let rsiClosedNow = rsiClosed;
      if (typeof recheck === 'function') {
        const rc = recheck();
        if (!rc?.ok) {
          return { ok: false, skipped: true, skipKind: 'recheck', reason: `${instId} 下单前复核未通过：${rc?.reason || '条件已变化'}，放弃下单` };
        }
        if (rc.rsi != null) rsiNow = rc.rsi;
        if (rc.rsiClosed !== undefined) rsiClosedNow = rc.rsiClosed;
      }

      const longShort = this.isLongShort();
      const clOrdId = genId('rsio');
      const body = { instId, tdMode: 'cross', side: 'buy', ordType: 'market', sz: size.contractsStr, clOrdId };
      if (longShort) body.posSide = 'long';
      // 必须先持久化意图再发单。若落盘失败，回调会抛错并阻止真实订单发送。
      onPending?.({
        action: 'upsert',
        exec_mode: this.mode,
        instId,
        phase: 'prepared',
        clOrdId,
        amount,
        leverage: lever,
        tpPct,
        slPct,
        rsi: rsiNow ?? null,
        rsiClosed: rsiClosedNow ?? null,
        profile,
        contractsStr: size.contractsStr,
        referencePrice: tk.askPx,
        createdAt: new Date().toISOString(),
      });
      this.log('info', `${this.tag} 提交市价买入 ${instId} ${size.contractsStr} 张 | ${lever}x 全仓 | 参考卖一 ${tk.askPx} | clOrdId=${clOrdId}`);
      try {
        onSubmit?.();
      } catch {
        /* ignore */
      }
      let placed;
      try {
        placed = await this._placeOrderIdempotent(body);
      } catch (e) {
        if (e instanceof OkxApiError && e.network) {
          try {
            onPending?.({ action: 'upsert', exec_mode: this.mode, instId, phase: 'uncertain', clOrdId, error: e.message });
          } catch {
            /* 首次 pending 已经落盘，保留它即可 */
          }
          e.orderUncertain = true;
        } else {
          onPending?.({ action: 'clear', exec_mode: this.mode, instId });
        }
        throw e;
      }
      const ordId = placed.ordId;
      if (!ordId) throw new Error(`${instId} 下单未返回 ordId`);
      try {
        onPending?.({ action: 'upsert', exec_mode: this.mode, instId, phase: 'submitted', clOrdId, ordId });
      } catch (e) {
        this.log('error', `${this.tag} ${instId} 已提交订单但更新 pending 失败：${e.message}（保留先前记录继续保护）`);
      }

      const { order: od, final } = await this._waitFill(instId, ordId, 15000);
      let filled = Number(od?.accFillSz || 0);
      let avgPx = Number(od?.avgPx || 0);
      const fee = Number(od?.fee || 0); // 负数 = 手续费支出
      const fillDec = decimalsOf(inst.lotSz);
      if (!final) {
        this.log('warn', `${this.tag} ${instId} 订单 15 秒内未到终态（state=${od?.state || '未知'}，已成交 ${filled}/${size.contractsStr} 张），改用交易所持仓数量`);
      } else if (filled > 0 && Math.abs(filled - size.contracts) > 1e-9) {
        this.log('warn', `${this.tag} ${instId} 部分成交：${filled}/${size.contractsStr} 张（state=${od?.state}）`);
      }
      // 以交易所持仓为准（张数 / 均价）
      try {
        const ex = await this.getExchangeLong(instId);
        if (ex && ex.pos > 0) {
          if (Math.abs(ex.pos - filled) > 1e-9) {
            this.log('warn', `${this.tag} ${instId} 订单成交 ${filled} 张，交易所持仓 ${ex.pos} 张 → 以交易所持仓为准`);
          }
          filled = ex.pos;
          if (ex.avgPx > 0) avgPx = ex.avgPx;
        }
      } catch (e) {
        this.log('warn', `${this.tag} ${instId} 读取交易所持仓失败（暂用订单成交数据）：${e.message}`);
      }
      if (!(filled > 0) || !(avgPx > 0)) {
        const terminalNoFill = final && ['canceled', 'mmp_canceled'].includes(String(od?.state || '')) && !(filled > 0);
        if (terminalNoFill) {
          onPending?.({ action: 'clear', exec_mode: this.mode, instId });
          return { ok: false, skipped: true, reason: `${instId} 市价单已取消且未成交（state=${od?.state}），ordId=${ordId}` };
        }
        try {
          onPending?.({
            action: 'upsert',
            exec_mode: this.mode,
            instId,
            phase: 'uncertain',
            clOrdId,
            ordId,
            orderState: od?.state || null,
          });
        } catch {
          /* 保留先前已落盘的 pending */
        }
        return { ok: false, uncertain: true, reason: `${instId} 市价单成交结果尚未明确（state=${od?.state || '未知'}），ordId=${ordId}` };
      }

      const pos = {
        instId,
        exec_mode: this.mode,
        simulated: false,
        external: false,
        entry_price: avgPx,
        amount: (filled * Number(inst.ctVal) * avgPx) / lever, // 实际保证金（按真实张数）
        leverage: lever,
        tdMode: 'cross',
        posSide: longShort ? 'long' : 'net',
        posMode: this.posMode,
        order_ccy: 'USDT',
        contracts: filled,
        contractsStr: filled.toFixed(fillDec),
        ctVal: Number(inst.ctVal),
        ctValCcy: inst.ctValCcy,
        notional_usdt: filled * Number(inst.ctVal) * avgPx,
        ordId,
        clOrdId,
        fee_open: fee,
        algoId: null,
        algoClOrdId: null,
        tp_sl_attached: false,
        take_profit_price: avgPx * (1 + tpPct / 100),
        stop_loss_price: avgPx * (1 - slPct / 100),
        tp_pct: tpPct,
        sl_pct: slPct,
        rsi_at_entry: rsiNow ?? null,
        rsi_closed_at_entry: rsiClosedNow ?? null,
        amount_config: amount,
        at: new Date().toISOString(),
        opened_ts: Date.now(),
        // 交易所时钟的开仓订单创建时间（用于匹配平仓记录，避免误用上一笔仓位的平仓记录）
        order_cts: Number(od?.cTime) || Number(od?.fillTime) || null,
        profile,
        mode: 'swap',
        status: 'open',
      };
      try {
        onPending?.({ action: 'upsert', exec_mode: this.mode, instId, phase: 'filled', clOrdId, ordId, pos });
      } catch (e) {
        this.log('error', `${this.tag} ${instId} 成交后更新 pending 失败：${e.message}（继续优先挂保护单）`);
      }
      this.log(
        'buy',
        `${this.buyTag} ${instId} 持仓 ${pos.contractsStr} 张 @ 均价 ${avgPx} | ${lever}x 全仓 | 名义约 ${pos.notional_usdt.toFixed(2)} USDT | 手续费 ${fee} | 实时RSI=${fmtRsi(
          rsiNow
        )} 收盘RSI=${fmtRsi(rsiClosedNow)}`
      );

      // 交易所端 OCO 止盈止损；失败则 fail-safe 立即平仓
      try {
        await this.placeProtection(pos, tpPct, slPct);
      } catch (e) {
        this.log('error', `${this.tag} ${instId} 止盈止损委托失败：${e.message} → 触发保护，立即市价平仓`);
        pos.close_reason = 'failsafe';
        try {
          await this.marketClose(pos, 'failsafe');
        } catch (e2) {
          this.log('error', `${this.tag} ${instId} 保护性平仓也失败：${e2.message}（请立即在 OKX ${this.envText}手动处理！）`);
        }
      }
      try {
        onPending?.({ action: 'upsert', exec_mode: this.mode, instId, phase: 'filled', clOrdId, ordId, pos });
      } catch {
        /* index 仍会持久化最终持仓；先前 pending 可供崩溃恢复 */
      }
      return { ok: true, pos };
    } finally {
      this.locks.delete(instId);
    }
  }

  /**
   * 为持仓挂交易所端 OCO（止盈+止损，触发后市价平多）
   * 优先 closeFraction='1'（官方文档：SWAP、oco/conditional、市价 -1 时可用，全仓位平仓，不传 sz；net 模式须 reduceOnly=true），
   * 若被拒则回退为 sz = 交易所持仓张数。
   */
  async placeProtection(pos, tpPct, slPct) {
    let inst = this.getInst(pos.instId);
    if (!inst) {
      await this.loadInstruments();
      inst = this.getInst(pos.instId);
    }
    if (!inst) throw new Error(`${pos.instId} 无合约规格，无法挂止盈止损`);
    const tp = roundToTick(pos.entry_price * (1 + tpPct / 100), inst.tickSz);
    const sl = roundToTick(pos.entry_price * (1 - slPct / 100), inst.tickSz);
    const base = {
      instId: pos.instId,
      tdMode: 'cross',
      side: 'sell',
      ordType: 'oco',
      tpTriggerPx: tp.str,
      tpOrdPx: '-1',
      tpTriggerPxType: 'last',
      slTriggerPx: sl.str,
      slOrdPx: '-1',
      slTriggerPxType: 'last',
    };
    if (pos.posSide === 'long') base.posSide = 'long'; // 开平仓模式：sell + long = 平多
    else base.reduceOnly = true; // 买卖模式：只减仓（closeFraction 要求）

    let r = null;
    let mode = 'closeFraction';
    let algoClOrdId = genId('rsit');
    let cfErr = null;
    try {
      const rows = await this.client.placeAlgoOrder({ ...base, closeFraction: '1', algoClOrdId });
      r = rows?.[0] || {};
      if (!r.algoId) throw new Error('未返回 algoId');
    } catch (e) {
      cfErr = e;
      r = null;
      if (e instanceof OkxApiError && e.network) {
        // 网络超时：先按 algoClOrdId 查询是否其实已挂上，避免重复挂单
        await sleep(800);
        try {
          const q = await this.client.getAlgoOrder({ algoClOrdId });
          if (q?.[0]?.algoId && !['canceled', 'order_failed'].includes(q[0].state)) r = { algoId: q[0].algoId };
        } catch {
          /* ignore */
        }
      }
    }
    if (!r?.algoId) {
      this.log('warn', `${this.tag} ${pos.instId} closeFraction=1 全仓止盈止损未成功（${cfErr?.message || '未返回 algoId'}）→ 改用 sz=${pos.contractsStr} 张`);
      mode = 'sz';
      algoClOrdId = genId('rsit');
      const rows = await this.client.placeAlgoOrder({ ...base, sz: pos.contractsStr, algoClOrdId });
      r = rows?.[0] || {};
      if (!r.algoId) throw new Error('未返回 algoId');
    }
    pos.algoId = r.algoId;
    pos.algoClOrdId = algoClOrdId;
    pos.algo_close_fraction = mode === 'closeFraction';
    pos.algo_sz = mode === 'sz' ? pos.contractsStr : null;
    pos.tp_sl_attached = true;
    pos.tp_sl_full = true;
    pos.take_profit_price = tp.value;
    pos.stop_loss_price = sl.value;
    pos.tp_pct = tpPct;
    pos.sl_pct = slPct;
    this.log(
      'info',
      `${this.tag} ${pos.instId} 已挂交易所 OCO（${mode === 'closeFraction' ? '全仓位 closeFraction=1' : `sz=${pos.contractsStr} 张`}）：止盈 ${tp.str} / 止损 ${sl.str}（触发后市价）algoId=${r.algoId}`
    );
    return pos;
  }

  async cancelProtection(pos) {
    if (!pos.algoId) return false;
    try {
      await this.client.cancelAlgos([{ algoId: pos.algoId, instId: pos.instId }]);
      this.log('info', `${this.tag} 已撤销 ${pos.instId} 止盈止损委托 algoId=${pos.algoId}`);
      pos.tp_sl_attached = false;
      return true;
    } catch (e) {
      this.log('warn', `${this.tag} 撤销 ${pos.instId} 止盈止损失败：${e.message}`);
      return false;
    }
  }

  /** 市价平掉该合约的全部多仓（张数以交易所持仓为准；只减仓，不会反向开空） */
  async marketClose(pos, reason = 'manual') {
    try {
      if (!this.accountConfig) await this.refreshAccountConfig();
      await this.loadInstruments();
      const ex = await this.getExchangeLong(pos.instId);
      if (ex && ex.pos > 0 && Math.abs(ex.pos - Number(pos.contracts)) > 1e-9) {
        this.log('warn', `${this.tag} ${pos.instId} 平仓张数按交易所持仓修正：${pos.contracts} → ${ex.pos}`);
        pos.contracts = ex.pos;
        pos.contractsStr = this.fmtContracts(pos.instId, ex.pos);
        if (ex.avgPx > 0) pos.entry_price = ex.avgPx;
      }
    } catch (e) {
      this.log('warn', `${this.tag} ${pos.instId} 平仓前查询交易所持仓失败：${e.message}（按程序记录张数平仓）`);
    }
    const body = {
      instId: pos.instId,
      tdMode: 'cross',
      side: 'sell',
      ordType: 'market',
      sz: pos.contractsStr,
      clOrdId: genId('rsic'),
    };
    if (pos.posSide === 'long') body.posSide = 'long';
    else body.reduceOnly = true;
    const requestedContracts = Number(pos.contracts) || 0;
    const r = await this._placeOrderIdempotent(body);
    if (!r.ordId) throw new Error(`${pos.instId} 平仓未返回 ordId`);
    pos.status = 'closing';
    pos.close_reason = pos.close_reason || reason;
    pos.close_ordId = r.ordId;
    pos.close_attempts = (Number(pos.close_attempts) || 0) + 1;
    pos.close_requested_at = pos.close_requested_at || Date.now();
    pos.close_last_submitted_at = Date.now();
    pos.close_next_retry_at = Date.now() + Math.min(5 * 60 * 1000, 15000 * Math.pow(2, Math.min(pos.close_attempts - 1, 5)));
    pos.close_last_error = null;
    this.log('sell', `${this.tag} 已提交市价平仓 ${pos.instId} ${pos.contractsStr} 张（原因：${reasonText(reason)}）ordId=${r.ordId}`);

    let waited = { order: null, final: false };
    try {
      waited = await this._waitFill(pos.instId, r.ordId, 15000);
    } catch (e) {
      this.log('warn', `${this.tag} ${pos.instId} 查询平仓成交结果失败：${e.message}（由对账继续确认）`);
    }
    const filled = Number(waited.order?.accFillSz || 0);
    let remaining = null;
    try {
      const after = await this.getExchangeLong(pos.instId);
      remaining = after?.pos > 0 ? Number(after.pos) : 0;
      if (remaining > 0) {
        pos.contracts = remaining;
        pos.contractsStr = this.fmtContracts(pos.instId, remaining);
        if (after.avgPx > 0) pos.entry_price = after.avgPx;
      }
    } catch (e) {
      this.log('warn', `${this.tag} ${pos.instId} 平仓后查询剩余仓位失败：${e.message}（保留保护单并由对账继续确认）`);
    }
    const complete = remaining === 0 || (remaining == null && waited.final && filled >= requestedContracts - 1e-9);
    if (!complete) {
      this.log(
        'warn',
        `${this.tag} ${pos.instId} 平仓尚未完成（已成交 ${filled}/${requestedContracts} 张，剩余 ${remaining == null ? '待确认' : remaining}），保留保护并自动重试`
      );
    }
    return { ...r, final: waited.final, filled, remaining, complete };
  }

  fetchPositions() {
    return this.client.getPositions('SWAP');
  }

  fetchPendingAlgos() {
    return this.client.getPendingAlgos({ ordType: 'oco,conditional', instType: 'SWAP' });
  }

  /**
   * 仓位消失后，查询平仓结果（/api/v5/account/positions-history：realizedPnl 已含手续费与资金费）
   * @returns {Promise<null|object>}
   */
  async resolveClose(pos, usedKeys = new Set()) {
    const rows = await this.client.getPositionsHistory({ instType: 'SWAP', instId: pos.instId, limit: '20' });
    // 只匹配本仓位开仓之后、且未被其它仓位使用过的平仓记录；找不到则返回 null（下轮重试）
    const h = pickCloseRecord(rows, pos, usedKeys);
    if (!h) return null;

    let action = null;
    let inferred = false;
    const type = String(h.type || '');
    if (pos.close_reason === 'kill') action = 'kill';
    else if (pos.close_reason === 'failsafe') action = 'failsafe';
    else if (type === '3' || type === '4') action = 'liq';
    else if (pos.algoId) {
      try {
        const a = await this.client.getAlgoOrder({ algoId: pos.algoId });
        const side = a?.[0]?.actualSide;
        if (side === 'tp' || side === 'sl') action = side;
      } catch {
        /* ignore */
      }
    }
    const closeAvgPx = Number(h.closeAvgPx);
    if (!action) {
      inferred = true;
      action = Number.isFinite(closeAvgPx) && closeAvgPx >= pos.entry_price ? 'tp' : 'sl';
    }
    return {
      closeAvgPx,
      realizedPnl: Number(h.realizedPnl),
      pnl: Number(h.pnl),
      fee: Number(h.fee),
      fundingFee: Number(h.fundingFee || 0),
      type,
      action,
      inferred,
      uTime: Number(h.uTime),
      close_key: closeKeyOf(pos.instId, h),
      // 整个仓位生命周期的累计平仓张数 / 开仓均价（用于账本记录真实仓位规模）
      closeTotalPos: Number(h.closeTotalPos) || null,
      openAvgPx: Number(h.openAvgPx) || null,
    };
  }
}

function fmtRsi(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—';
}

export function reasonText(r) {
  return (
    {
      tp: '止盈',
      sl: '止损',
      kill: '急停平仓',
      failsafe: '保护性平仓',
      manual: '手动',
      liq: '强平',
      external: '外部平仓',
    }[r] || r
  );
}

function acctLvText(v) {
  return { 1: '现货模式', 2: '合约模式', 3: '跨币种保证金', 4: '组合保证金' }[String(v)] || null;
}

/** 兼容旧名称 */
export const OkxDemoExecutor = OkxExecutor;
