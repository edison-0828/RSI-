/**
 * OKX v5 REST 客户端（仅模拟盘 Demo Trading）
 * - HMAC-SHA256 签名：base64(hmac(secret, timestamp + METHOD + requestPath + body))
 * - 强制携带 x-simulated-trading: 1（实盘在此层硬禁用，无法构造实盘客户端）
 * - 超时、错误解析（code !== '0' 及逐条 sCode）、轻量限速、服务器时间校准
 * - 绝不在日志/错误信息中输出 Key / Secret / Passphrase
 */
import crypto from 'crypto';

export const OKX_REST_BASE = 'https://www.okx.com';

export class OkxApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, sCode?: string, sMsg?: string, httpStatus?: number, path?: string, network?: boolean, data?: any }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'OkxApiError';
    this.code = info.code ?? null;
    this.sCode = info.sCode ?? null;
    this.sMsg = info.sMsg ?? null;
    this.httpStatus = info.httpStatus ?? null;
    this.path = info.path ?? null;
    this.network = !!info.network;
    this.data = info.data ?? null;
  }
}

/**
 * 计算 OK-ACCESS-SIGN
 * @param {string} timestamp ISO 毫秒，如 2020-12-08T09:08:57.715Z
 * @param {string} method GET / POST（大写）
 * @param {string} requestPath 含 query，如 /api/v5/account/balance?ccy=BTC
 * @param {string} body JSON 字符串，GET 为空串
 * @param {string} secretKey
 */
export function signRequest(timestamp, method, requestPath, body, secretKey) {
  const prehash = `${timestamp}${String(method).toUpperCase()}${requestPath}${body || ''}`;
  return crypto.createHmac('sha256', secretKey).update(prehash).digest('base64');
}

function buildQuery(params) {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
}

export class OkxRestClient {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]
   * @param {string} [opts.secretKey]
   * @param {string} [opts.passphrase]
   * @param {boolean} opts.simulated 必须为 true（模拟盘）
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.minIntervalMs] 请求最小间隔（轻量限速）
   */
  constructor({ apiKey = '', secretKey = '', passphrase = '', simulated, baseUrl = OKX_REST_BASE, timeoutMs = 10000, minIntervalMs = 120 } = {}) {
    if (simulated !== true) {
      // 安全约束：实盘真实下单已硬禁用
      throw new Error('安全约束：仅允许 OKX 模拟盘（x-simulated-trading: 1），实盘真实下单已禁用');
    }
    // 用闭包保存凭证，避免被 JSON.stringify / console.log 意外输出
    const creds = { apiKey: String(apiKey || ''), secretKey: String(secretKey || ''), passphrase: String(passphrase || '') };
    this._getCreds = () => creds;
    this.simulated = true;
    this.baseUrl = String(baseUrl || OKX_REST_BASE).replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this._queue = Promise.resolve();
    this._lastAt = 0;
    this._timeOffsetMs = 0;
    this._timeSyncedAt = 0;
  }

  toJSON() {
    return { baseUrl: this.baseUrl, simulated: true, hasCredentials: this.hasCredentials() };
  }

  hasCredentials() {
    const c = this._getCreds();
    return !!(c.apiKey && c.secretKey && c.passphrase);
  }

  /** 与 OKX 服务器时间校准（避免 50102 时间戳过期） */
  async syncTime() {
    try {
      const t0 = Date.now();
      const data = await this.request('GET', '/api/v5/public/time', { auth: false });
      const t1 = Date.now();
      const serverTs = Number(data?.[0]?.ts);
      if (Number.isFinite(serverTs)) {
        this._timeOffsetMs = serverTs - Math.round((t0 + t1) / 2);
        this._timeSyncedAt = Date.now();
      }
    } catch {
      /* 校准失败则使用本地时间 */
    }
    return this._timeOffsetMs;
  }

  _timestamp() {
    return new Date(Date.now() + this._timeOffsetMs).toISOString();
  }

  /** 串行 + 最小间隔的轻量限速 */
  _schedule(fn) {
    const run = async () => {
      const wait = this._lastAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastAt = Date.now();
      return fn();
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path 如 /api/v5/account/balance
   * @param {{ params?: object, body?: any, auth?: boolean, checkItems?: boolean }} [opts]
   * @returns {Promise<any[]>} data 数组
   */
  request(method, path, { params, body, auth = true, checkItems = method === 'POST' } = {}) {
    return this._schedule(() => this._doRequest(method, path, { params, body, auth, checkItems }));
  }

  async _doRequest(method, path, { params, body, auth, checkItems }) {
    const m = String(method).toUpperCase();
    const requestPath = `${path}${m === 'GET' ? buildQuery(params) : ''}`;
    const bodyStr = m === 'GET' || body === undefined ? '' : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-simulated-trading': '1', // 模拟盘（强制）
    };
    if (auth) {
      if (!this.hasCredentials()) {
        throw new OkxApiError('未配置 OKX 模拟盘 API Key（请在 server/.env.local 填写）', { path });
      }
      const c = this._getCreds();
      const ts = this._timestamp();
      headers['OK-ACCESS-KEY'] = c.apiKey;
      headers['OK-ACCESS-SIGN'] = signRequest(ts, m, requestPath, bodyStr, c.secretKey);
      headers['OK-ACCESS-TIMESTAMP'] = ts;
      headers['OK-ACCESS-PASSPHRASE'] = c.passphrase;
    }

    let res;
    try {
      res = await fetch(`${this.baseUrl}${requestPath}`, {
        method: m,
        headers,
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new OkxApiError(
        isTimeout ? `OKX 请求超时（${this.timeoutMs}ms）：${m} ${path}` : `OKX 网络错误：${m} ${path}：${e?.message || e}`,
        { path, network: true }
      );
    }

    let json = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!json) {
      throw new OkxApiError(`OKX 返回非 JSON（HTTP ${res.status}）：${m} ${path}`, { httpStatus: res.status, path });
    }
    const code = String(json.code ?? '');
    if (code !== '0') {
      // 批量/下单接口：code=1 时逐条 sCode 才是真实原因
      const item = Array.isArray(json.data) ? json.data.find((d) => d && d.sCode && String(d.sCode) !== '0') : null;
      const detail = item ? ` | sCode=${item.sCode} ${item.sMsg || ''}` : '';
      if (code === '50102' && auth) this._timeSyncedAt = 0; // 触发下次重新校时
      throw new OkxApiError(`OKX 错误 code=${code} ${json.msg || ''}${detail}（${m} ${path}）`.replace(/\s+/g, ' '), {
        code,
        sCode: item?.sCode,
        sMsg: item?.sMsg,
        httpStatus: res.status,
        path,
        data: json.data,
      });
    }
    const data = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
    if (checkItems) {
      const bad = data.find((d) => d && d.sCode !== undefined && String(d.sCode) !== '0' && String(d.sCode) !== '');
      if (bad) {
        throw new OkxApiError(`OKX 业务错误 sCode=${bad.sCode} ${bad.sMsg || ''}（${m} ${path}）`, {
          code,
          sCode: bad.sCode,
          sMsg: bad.sMsg,
          httpStatus: res.status,
          path,
          data,
        });
      }
    }
    return data;
  }

  get(path, params, opts = {}) {
    return this.request('GET', path, { ...opts, params });
  }

  post(path, body, opts = {}) {
    return this.request('POST', path, { ...opts, body });
  }

  // ---------- 常用封装 ----------
  getInstruments(instType = 'SWAP') {
    return this.get('/api/v5/public/instruments', { instType }, { auth: false });
  }
  getTicker(instId) {
    return this.get('/api/v5/market/ticker', { instId }, { auth: false });
  }
  getAccountConfig() {
    return this.get('/api/v5/account/config');
  }
  getBalance(ccy = 'USDT') {
    return this.get('/api/v5/account/balance', { ccy });
  }
  getPositions(instType = 'SWAP', instId) {
    return this.get('/api/v5/account/positions', { instType, instId });
  }
  getPositionsHistory(params) {
    return this.get('/api/v5/account/positions-history', params);
  }
  setLeverage(body) {
    return this.post('/api/v5/account/set-leverage', body);
  }
  placeOrder(body) {
    return this.post('/api/v5/trade/order', body);
  }
  getOrder(instId, { ordId, clOrdId } = {}) {
    return this.get('/api/v5/trade/order', { instId, ordId, clOrdId });
  }
  placeAlgoOrder(body) {
    return this.post('/api/v5/trade/order-algo', body);
  }
  getAlgoOrder({ algoId, algoClOrdId }) {
    return this.get('/api/v5/trade/order-algo', { algoId, algoClOrdId });
  }
  getPendingAlgos(params = { ordType: 'oco,conditional', instType: 'SWAP' }) {
    return this.get('/api/v5/trade/orders-algo-pending', params);
  }
  cancelAlgos(list) {
    return this.post('/api/v5/trade/cancel-algos', list);
  }
  getFills(params) {
    return this.get('/api/v5/trade/fills', params);
  }
}
