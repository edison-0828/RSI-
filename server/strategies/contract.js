/**
 * 策略接口约定 + 校验（见 DESIGN.md 2.1）
 *
 * 一句话：策略是“给定只读行情快照与自己的参数，返回方向 + 触发原因 + 建议止盈止损 + 调试指标”的纯函数。
 */

/** @typedef {'long'|'short'} Direction */
/**
 * @typedef {Object} ParamField
 * @property {string} key
 * @property {string} label
 * @property {'number'|'boolean'|'string'} type
 * @property {number|boolean|string} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} [hint]
 * @property {boolean} [advanced]
 */
/**
 * @typedef {Object} Strategy
 * @property {string}   id            全局唯一，如 'supertrend'（将写入 positions / 账本 / 冷却）
 * @property {string}   name          展示名
 * @property {number}   version       逻辑版本；改动信号语义必须 +1
 * @property {Direction[]} directions 该策略可能产生的方向（supertrend: ['long','short']）
 * @property {ParamField[]} params    参数声明
 * @property {Array<object>} presets  快速预设（可为空数组）
 * @property {(raw:object)=>object} clamp      参数夹紧并补默认值
 * @property {(p:object)=>{bar:string, closedBars:number}} needs  需要的数据
 * @property {(ctx:EvalCtx)=>Decision} evaluate 纯函数；不得读时钟/随机数/网络/全局变量
 */
/**
 * @typedef {Object} EvalCtx
 * @property {string} instId
 * @property {'scan'|'recheck'} phase   recheck = 下单前复核
 * @property {object} params            本策略已夹紧的参数
 * @property {{price:number|null, bid:number|null, ask:number|null,
 *             bars:number, barMs:number, lastBarTs:number|null,
 *             st?:{ready:boolean, readyBars:number, trend:(1|-1|null), up:number|null, dn:number|null, atr:number|null,
 *                  flip:{ts:number,dir:'long'|'short',closeAt:number,close:number}|null, trendSince:number|null}}} market
 * @property {{tradable:boolean}} flags tradable=false：例如 okx_demo 下该币模拟盘不存在
 */
/**
 * @typedef {Object} Decision
 * @property {Direction|null} direction
 * @property {boolean} signal
 * @property {string}  text
 * @property {{kind:string, reason:string}|null} blocked
 * @property {number} [tpPct]
 * @property {number} [slPct]
 * @property {Object} metrics
 * @property {Object} [meta]
 * @property {boolean} [waitingClose]
 */

const DIRECTIONS = new Set(['long', 'short']);

/**
 * 校验策略定义；不合法抛 Error（中文）
 * @param {Strategy} s
 */
export function validateStrategy(s) {
  const bad = (m) => {
    throw new Error(`策略定义不合法：${m}`);
  };
  if (!s || typeof s !== 'object') bad('必须是对象');
  if (typeof s.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s.id)) bad('id 必须是小写字母开头的字母数字下划线');
  if (typeof s.name !== 'string' || !s.name) bad(`${s.id} 缺少 name`);
  if (!Number.isInteger(s.version) || s.version < 1) bad(`${s.id} 的 version 必须是 ≥1 的整数`);
  if (!Array.isArray(s.directions) || s.directions.length === 0 || !s.directions.every((d) => DIRECTIONS.has(d))) {
    bad(`${s.id} 的 directions 必须是 long/short 的非空数组`);
  }
  if (!Array.isArray(s.params)) bad(`${s.id} 的 params 必须是数组`);
  for (const f of s.params) {
    if (!f || typeof f.key !== 'string' || !f.key) bad(`${s.id} 的参数声明缺少 key`);
    if (typeof f.label !== 'string') bad(`${s.id}.${f.key} 缺少 label`);
    if (!['number', 'boolean', 'string'].includes(f.type)) bad(`${s.id}.${f.key} 的 type 不合法`);
    if (f.default === undefined) bad(`${s.id}.${f.key} 缺少 default`);
  }
  if (!Array.isArray(s.presets)) bad(`${s.id} 的 presets 必须是数组`);
  for (const fn of ['clamp', 'needs', 'evaluate']) {
    if (typeof s[fn] !== 'function') bad(`${s.id} 缺少函数 ${fn}`);
  }
  return true;
}

/**
 * 校验 Decision；不合法抛 Error（中文）
 * @param {Decision} d
 * @param {Strategy} [strategy] 提供时额外校验 direction 属于 strategy.directions
 */
export function validateDecision(d, strategy) {
  const bad = (m) => {
    throw new Error(`Decision 不合法：${m}`);
  };
  if (!d || typeof d !== 'object') bad('必须是对象');
  if (d.direction !== null && !DIRECTIONS.has(d.direction)) bad('direction 必须是 long/short/null');
  if (strategy && d.direction !== null && !strategy.directions.includes(d.direction)) {
    bad(`direction=${d.direction} 不在策略 ${strategy.id} 声明的方向内`);
  }
  if (typeof d.signal !== 'boolean') bad('signal 必须是布尔值');
  if (d.signal && d.direction === null) bad('signal=true 时 direction 不能为 null');
  if (typeof d.text !== 'string') bad('text 必须是字符串');
  if (d.blocked !== null && d.blocked !== undefined) {
    if (typeof d.blocked !== 'object' || typeof d.blocked.kind !== 'string' || typeof d.blocked.reason !== 'string') {
      bad('blocked 必须是 null 或 {kind, reason}');
    }
  } else if (d.blocked === undefined) bad('blocked 必须显式给出（可为 null）');
  for (const k of ['tpPct', 'slPct']) {
    if (d[k] !== undefined && !(Number.isFinite(d[k]) && d[k] > 0)) bad(`${k} 若给出必须是 >0 的有限数`);
  }
  if (!d.metrics || typeof d.metrics !== 'object') bad('metrics 必须是对象');
  if (d.waitingClose !== undefined && typeof d.waitingClose !== 'boolean') bad('waitingClose 必须是布尔值');
  return true;
}

export default { validateStrategy, validateDecision };
