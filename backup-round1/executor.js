/**
 * OKX 模拟盘（Demo Trading）执行器 · USDT 永续多头 · 全仓
 *
 * 开仓流程：
 *   1) 缓存合约规格 /api/v5/public/instruments?instType=SWAP（ctVal/lotSz/minSz/tickSz）
 *   2) 读取账户配置 /api/v5/account/config（posMode：long_short_mode / net_mode）
 *   3) 点差检查（模拟盘 ticker）+ 余额检查 /api/v5/account/balance
 *   4) 首次或杠杆变化时 /api/v5/account/set-leverage（cross）
 *   5) 张数 = floor(保证金×杠杆 / (ctVal×价格) / lotSz) × lotSz，低于 minSz 则跳过
 *   6) 市价买入 /api/v5/trade/order（tdMode=cross，唯一 clOrdId，按 instId 加锁）
 *   7) 查询订单 /api/v5/trade/order 获取 avgPx/accFillSz/fee
 *   8) 交易所端 OCO 止盈止损 /api/v5/trade/order-algo（ordType=oco，市价 -1）
 *      失败 → 立即市价平仓（fail-safe）
 */
import { OkxRestClient, OkxApiError } from './okxRest.js';

const INST_TTL_MS = 6 * 3600 * 1000;
const BAL_TTL_MS = 5000;

export function demoKeysConfigured() {
  return !!(
    String(process.env.OKX_DEMO_API_KEY || '').trim() &&
    String(process.env.OKX_DEMO_SECRET_KEY || '').trim() &&
    String(process.env.OKX_DEMO_PASSPHRASE || '').trim()
  );
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

export class OkxDemoExecutor {
  /** @param {{ log: (level:string, msg:string)=>void }} opts */
  constructor({ log }) {
    this.log = log || (() => {});
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
    this.client = new OkxRestClient({
      apiKey: process.env.OKX_DEMO_API_KEY,
      secretKey: process.env.OKX_DEMO_SECRET_KEY,
      passphrase: process.env.OKX_DEMO_PASSPHRASE,
      simulated: true,
      // 可选：OKX_DEMO_REST_BASE（如官方文档列出的模拟盘域名 https://openapi.okx.com）；默认 https://www.okx.com
      baseUrl: String(process.env.OKX_DEMO_REST_BASE || '').trim() || undefined,
      timeoutMs: 10000,
      minIntervalMs: 120,
    });
  }

  keysConfigured() {
    return demoKeysConfigured();
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
      usdtEq: this.balance?.usdtEq ?? null,
      usdtAvail: this.balance?.usdtAvail ?? null,
      totalEq: this.balance?.totalEq ?? null,
      updatedAt: this.balance?.at || this.accountConfig?.at || null,
      error: this.accountError,
    };
  }

  /** 开始扫描前准备：校时 + 合约规格 + 账户配置 */
  async prepare() {
    if (!this.keysConfigured()) throw new Error('未配置 OKX 模拟盘 API Key，请在 server/.env.local 填写');
    await this.ensureTimeSync();
    await this.loadInstruments(true);
    await this.refreshAccountConfig();
    await this.refreshBalance(true);
    this.accountError = null;
    if (this.accountConfig.acctLv === '1') {
      this.log('warn', '[模拟盘] 账户模式为「现货模式」，无法交易永续；请在 OKX 模拟盘 → 设置 → 账户模式 切换为「合约模式」');
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
    this.log('info', `[模拟盘] ${instId} 已设置杠杆 ${lever}x（全仓）`);
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
              this.log('warn', `[模拟盘] 下单响应超时，但按 clOrdId 查到订单 ${q[0].ordId}，继续处理`);
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

  async _waitFill(instId, ordId) {
    let last = null;
    for (let i = 0; i < 10; i++) {
      await sleep(i === 0 ? 200 : 350);
      try {
        const rows = await this.client.getOrder(instId, { ordId });
        last = rows?.[0] || last;
      } catch (e) {
        if (i === 9 && !last) throw e;
        continue;
      }
      if (!last) continue;
      if (last.state === 'filled' || last.state === 'canceled' || last.state === 'mmp_canceled') break;
    }
    return last;
  }

  /**
   * 市价开多（完整流程：规格 → 点差 → 余额 → 张数 → 杠杆 → 下单 → 查成交 → OCO）
   * @returns {Promise<{ok:true,pos:object}|{ok:false,skipped?:boolean,reason:string}>}
   */
  async openLong({ instId, amount, leverage, tpPct, slPct, rsi, maxSpreadPct, profile = 'demo', onSubmit }) {
    if (this.locks.has(instId)) return { ok: false, skipped: true, reason: `${instId} 正在下单中，跳过重复开仓` };
    this.locks.add(instId);
    try {
      await this.loadInstruments();
      if (!this.accountConfig) await this.refreshAccountConfig();
      const inst = this.getInst(instId);
      if (!inst) return { ok: false, skipped: true, reason: `${instId} 在模拟盘无此合约，跳过` };
      if (inst.state && inst.state !== 'live') return { ok: false, skipped: true, reason: `${instId} 合约状态 ${inst.state}，跳过` };

      let lever = leverage;
      if (inst.maxLever && lever > inst.maxLever) {
        this.log('warn', `[模拟盘] ${instId} 最大杠杆 ${inst.maxLever}x，已由 ${lever}x 下调`);
        lever = inst.maxLever;
      }

      // 点差检查（模拟盘盘口）
      const tk = await this.getDemoTicker(instId);
      if (!tk || !(tk.askPx > 0) || !(tk.bidPx > 0)) return { ok: false, skipped: true, reason: `${instId} 模拟盘盘口无报价，跳过` };
      const mid = (tk.askPx + tk.bidPx) / 2;
      const spreadPct = ((tk.askPx - tk.bidPx) / mid) * 100;
      if (spreadPct > maxSpreadPct) {
        return { ok: false, skipped: true, reason: `${instId} 模拟盘点差 ${spreadPct.toFixed(3)}% > 上限 ${maxSpreadPct}%，跳过` };
      }

      // 余额检查
      const bal = await this.refreshBalance(true);
      if (bal.usdtAvail == null || bal.usdtAvail < amount) {
        return {
          ok: false,
          skipped: true,
          reason: `模拟盘可用 USDT ${bal.usdtAvail == null ? '未知' : bal.usdtAvail.toFixed(2)} < 每笔保证金 ${amount}，跳过 ${instId}`,
        };
      }

      // 张数
      const size = calcContracts({ amount, leverage: lever, price: tk.askPx, ctVal: inst.ctVal, lotSz: inst.lotSz, minSz: inst.minSz });
      if (size.belowMin) {
        return {
          ok: false,
          skipped: true,
          reason: `${instId} 计算张数 ${size.contractsStr} 低于最小下单量 ${inst.minSz} 张（每张 ${inst.ctVal} ${inst.ctValCcy} ≈ ${(
            Number(inst.ctVal) * tk.askPx
          ).toFixed(2)} USDT），跳过`,
        };
      }

      await this.ensureLeverage(instId, lever);

      const longShort = this.isLongShort();
      const clOrdId = genId('rsio');
      const body = { instId, tdMode: 'cross', side: 'buy', ordType: 'market', sz: size.contractsStr, clOrdId };
      if (longShort) body.posSide = 'long';
      this.log('info', `[模拟盘] 提交市价买入 ${instId} ${size.contractsStr} 张 | ${lever}x 全仓 | 参考卖一 ${tk.askPx} | clOrdId=${clOrdId}`);
      try {
        onSubmit?.();
      } catch {
        /* ignore */
      }
      const placed = await this._placeOrderIdempotent(body);
      const ordId = placed.ordId;
      if (!ordId) throw new Error(`${instId} 下单未返回 ordId`);

      const od = await this._waitFill(instId, ordId);
      const filled = Number(od?.accFillSz || 0);
      const avgPx = Number(od?.avgPx || 0);
      if (!(filled > 0) || !(avgPx > 0)) {
        return { ok: false, reason: `${instId} 市价单未成交（state=${od?.state || '未知'}），ordId=${ordId}` };
      }
      const fee = Number(od?.fee || 0); // 负数 = 手续费支出
      const fillDec = decimalsOf(inst.lotSz);

      const pos = {
        instId,
        exec_mode: 'okx_demo',
        simulated: false,
        external: false,
        entry_price: avgPx,
        amount,
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
        rsi_at_entry: rsi ?? null,
        at: new Date().toISOString(),
        opened_ts: Date.now(),
        profile,
        mode: 'swap',
        status: 'open',
      };
      this.log(
        'buy',
        `[模拟盘买入] ${instId} 成交 ${pos.contractsStr} 张 @ 均价 ${avgPx} | ${lever}x 全仓 | 名义约 ${pos.notional_usdt.toFixed(2)} USDT | 手续费 ${fee} | RSI=${
          rsi?.toFixed?.(2) ?? rsi ?? '—'
        }`
      );

      // 交易所端 OCO 止盈止损；失败则 fail-safe 立即平仓
      try {
        await this.placeProtection(pos, tpPct, slPct);
      } catch (e) {
        this.log('error', `[模拟盘] ${instId} 止盈止损委托失败：${e.message} → 触发保护，立即市价平仓`);
        pos.close_reason = 'failsafe';
        try {
          await this.marketClose(pos, 'failsafe');
        } catch (e2) {
          this.log('error', `[模拟盘] ${instId} 保护性平仓也失败：${e2.message}（请立即在 OKX 模拟盘手动处理！）`);
        }
      }
      return { ok: true, pos };
    } finally {
      this.locks.delete(instId);
    }
  }

  /** 为持仓挂交易所端 OCO（止盈+止损，触发后市价平多） */
  async placeProtection(pos, tpPct, slPct) {
    let inst = this.getInst(pos.instId);
    if (!inst) {
      await this.loadInstruments();
      inst = this.getInst(pos.instId);
    }
    if (!inst) throw new Error(`${pos.instId} 无合约规格，无法挂止盈止损`);
    const tp = roundToTick(pos.entry_price * (1 + tpPct / 100), inst.tickSz);
    const sl = roundToTick(pos.entry_price * (1 - slPct / 100), inst.tickSz);
    const algoClOrdId = genId('rsit');
    const body = {
      instId: pos.instId,
      tdMode: 'cross',
      side: 'sell',
      ordType: 'oco',
      sz: pos.contractsStr,
      algoClOrdId,
      tpTriggerPx: tp.str,
      tpOrdPx: '-1',
      tpTriggerPxType: 'last',
      slTriggerPx: sl.str,
      slOrdPx: '-1',
      slTriggerPxType: 'last',
    };
    if (pos.posSide === 'long') body.posSide = 'long'; // 开平仓模式：sell + long = 平多
    else body.reduceOnly = true; // 买卖模式：只减仓
    const rows = await this.client.placeAlgoOrder(body);
    const r = rows?.[0] || {};
    if (!r.algoId) throw new Error('未返回 algoId');
    pos.algoId = r.algoId;
    pos.algoClOrdId = algoClOrdId;
    pos.tp_sl_attached = true;
    pos.take_profit_price = tp.value;
    pos.stop_loss_price = sl.value;
    pos.tp_pct = tpPct;
    pos.sl_pct = slPct;
    this.log('info', `[模拟盘] ${pos.instId} 已挂交易所 OCO：止盈 ${tp.str} / 止损 ${sl.str}（触发后市价）algoId=${r.algoId}`);
    return pos;
  }

  async cancelProtection(pos) {
    if (!pos.algoId) return false;
    try {
      await this.client.cancelAlgos([{ algoId: pos.algoId, instId: pos.instId }]);
      this.log('info', `[模拟盘] 已撤销 ${pos.instId} 止盈止损委托 algoId=${pos.algoId}`);
      pos.tp_sl_attached = false;
      return true;
    } catch (e) {
      this.log('warn', `[模拟盘] 撤销 ${pos.instId} 止盈止损失败：${e.message}`);
      return false;
    }
  }

  /** 市价平掉本程序持有的张数（只减仓，不动其他仓位） */
  async marketClose(pos, reason = 'manual') {
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
    const r = await this._placeOrderIdempotent(body);
    pos.status = 'closing';
    pos.close_reason = pos.close_reason || reason;
    pos.close_ordId = r.ordId || null;
    this.log('sell', `[模拟盘] 已提交市价平仓 ${pos.instId} ${pos.contractsStr} 张（原因：${reasonText(reason)}）ordId=${r.ordId || '—'}`);
    return r;
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
  async resolveClose(pos) {
    const rows = await this.client.getPositionsHistory({ instType: 'SWAP', instId: pos.instId, limit: '20' });
    const openedTs = Number(pos.opened_ts || new Date(pos.at).getTime() || 0);
    const cand = (rows || [])
      .filter((r) => r.direction === 'long' || r.posSide === 'long')
      .filter((r) => Number(r.uTime) >= openedTs - 5000)
      .sort((a, b) => Number(b.uTime) - Number(a.uTime));
    const h = cand[0];
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
    };
  }
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
