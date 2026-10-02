/**
 * SuperTrend 指标（KivancOzbilgic Pine v4 标准版）纯函数实现。
 *
 * 逐句对应 Pine：
 *   src = hl2；atr = changeATR ? atr(Periods)（RMA） : sma(tr, Periods)
 *   up = src - Multiplier*atr；up1 = nz(up[1], up)；up := close[1] > up1 ? max(up, up1) : up
 *   dn = src + Multiplier*atr；dn1 = nz(dn[1], dn)；dn := close[1] < dn1 ? min(dn, dn1) : dn
 *   trend = 1；trend := nz(trend[1], trend)
 *   trend := trend == -1 and close > dn1 ? 1 : trend == 1 and close < up1 ? -1 : trend
 *   buySignal = trend == 1 and trend[1] == -1；sellSignal = trend == -1 and trend[1] == 1
 * 注意：trend 判断用的是 up1 / dn1（上一根已更新后的值），不是本根更新后的 up / dn。
 *
 * 与 Pine 的唯一语义差别（与已验证的 Python 回测 ut_engine.supertrend 一致）：
 *   ATR 未就绪的预热段 trend 记为 null（Pine 里恒为 1）；翻转要求前一根、当前根 trend 都已就绪。
 *   这只影响第 period 根（首根 ATR 就绪的 K 线）能否出信号，实盘/回测都要求 warmup ≥ 数十根，不影响。
 *
 * 提供两种等价用法（由同一个 step 函数实现，保证逐位一致）：
 *   1) superTrend(h, l, c, opts)：整段数组一次算完（回放 / 测试 / fixture 对比）
 *   2) createState + stepSuperTrend：逐根增量（实盘 CandleStore 用，状态不依赖窗口起点）
 * 无任何 IO、不读时钟、不改入参。
 */

/** @typedef {{period:number, mult:number, method:'rma'|'sma'}} StOpts */

export const ST_DEFAULTS = Object.freeze({ period: 10, mult: 3, method: 'rma' });

/** 初始状态 */
export function createState(opts = {}) {
  const period = Math.max(1, Math.round(Number(opts.period) || ST_DEFAULTS.period));
  const mult = Number.isFinite(Number(opts.mult)) && Number(opts.mult) > 0 ? Number(opts.mult) : ST_DEFAULTS.mult;
  const method = opts.method === 'sma' ? 'sma' : 'rma';
  return {
    period,
    mult,
    method,
    n: 0, // 已处理的 K 线数
    prevClose: null,
    trWin: [], // rma：首 period 根累积；sma：最近 period 根
    rma: null,
    up: null,
    dn: null,
    trend: 1, // Pine: trend 初值 1
    ready: false, // 上一根是否已有有效 trend
    readyBars: 0, // 已有有效 trend 的 K 线数
  };
}

/**
 * 推进一根已收盘 K 线（不修改入参 state，返回新状态与本根输出）
 * @param {ReturnType<typeof createState>} st
 * @param {{h:number,l:number,c:number}} bar
 * @returns {{state:object, out:{ready:boolean, trend:(1|-1|null), prevTrend:(1|-1|null), buy:boolean, sell:boolean, up:(number|null), dn:(number|null), atr:(number|null)}}}
 */
export function stepSuperTrend(st, bar) {
  const { h, l, c } = bar;
  const p = st.period;
  // True Range：首根 = h - l（Pine: tr 在 close[1] 为 na 时取 high-low）
  const tr = st.prevClose == null ? h - l : Math.max(h - l, Math.abs(h - st.prevClose), Math.abs(l - st.prevClose));
  let trWin = st.trWin;
  let rma = st.rma;
  let atr = null;
  if (st.method === 'rma') {
    if (rma == null) {
      trWin = [...trWin, tr];
      if (trWin.length >= p) {
        rma = trWin.reduce((a, b) => a + b, 0) / p; // 首个值 = SMA(p)
        trWin = [];
      }
    } else {
      rma = (rma * (p - 1) + tr) / p;
    }
    atr = rma;
  } else {
    trWin = [...trWin, tr];
    if (trWin.length > p) trWin = trWin.slice(trWin.length - p);
    atr = trWin.length >= p ? trWin.reduce((a, b) => a + b, 0) / p : null;
  }
  const n = st.n + 1;
  if (atr == null) {
    return {
      state: { ...st, n, prevClose: c, trWin, rma, up: null, dn: null, ready: false },
      out: { ready: false, trend: null, prevTrend: null, buy: false, sell: false, up: null, dn: null, atr: null },
    };
  }
  const src = (h + l) / 2;
  let up = src - st.mult * atr;
  let dn = src + st.mult * atr;
  const up1 = st.up != null ? st.up : up; // nz(up[1], up)
  const dn1 = st.dn != null ? st.dn : dn; // nz(dn[1], dn)
  if (st.prevClose != null && st.prevClose > up1) up = Math.max(up, up1);
  if (st.prevClose != null && st.prevClose < dn1) dn = Math.min(dn, dn1);
  let trend = st.trend;
  if (trend === -1 && c > dn1) trend = 1;
  else if (trend === 1 && c < up1) trend = -1;
  const prevTrend = st.ready ? st.trend : null;
  const buy = prevTrend != null && trend === 1 && prevTrend === -1;
  const sell = prevTrend != null && trend === -1 && prevTrend === 1;
  return {
    state: { ...st, n, prevClose: c, trWin, rma, up, dn, trend, ready: true, readyBars: st.readyBars + 1 },
    out: { ready: true, trend, prevTrend, buy, sell, up, dn, atr },
  };
}

/**
 * 整段计算
 * @param {number[]} h
 * @param {number[]} l
 * @param {number[]} c
 * @param {Partial<StOpts>} opts
 * @returns {{trend:Array<1|-1|null>, up:Array<number|null>, dn:Array<number|null>, atr:Array<number|null>, buy:boolean[], sell:boolean[], state:object}}
 */
export function superTrend(h, l, c, opts = {}) {
  const N = c.length;
  let state = createState(opts);
  const res = { trend: new Array(N), up: new Array(N), dn: new Array(N), atr: new Array(N), buy: new Array(N), sell: new Array(N), state };
  for (let i = 0; i < N; i++) {
    const r = stepSuperTrend(state, { h: h[i], l: l[i], c: c[i] });
    state = r.state;
    res.trend[i] = r.out.trend;
    res.up[i] = r.out.up;
    res.dn[i] = r.out.dn;
    res.atr[i] = r.out.atr;
    res.buy[i] = r.out.buy;
    res.sell[i] = r.out.sell;
  }
  res.state = state;
  return res;
}

export default { ST_DEFAULTS, createState, stepSuperTrend, superTrend };
