/**
 * OKX WebSocket 管理：K 线（business）+ tickers（public）
 * - 每连接 ≤ maxArgsPerConn 个 channel args
 * - 自动重连 + ping
 */
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const WS_PUBLIC = 'wss://ws.okx.com:8443/ws/v5/public';
export const WS_BUSINESS = 'wss://ws.okx.com:8443/ws/v5/business';

const BAR_TO_CHANNEL = {
  '1m': 'candle1m',
  '3m': 'candle3m',
  '5m': 'candle5m',
  '15m': 'candle15m',
  '30m': 'candle30m',
  '1H': 'candle1H',
  '2H': 'candle2H',
  '4H': 'candle4H',
  '6H': 'candle6H',
  '12H': 'candle12H',
  '1D': 'candle1D',
  '1Dutc': 'candle1Dutc',
  '1W': 'candle1W',
  '1Wutc': 'candle1Wutc',
  '1M': 'candle1M',
  '1Mutc': 'candle1Mutc',
};

export function barToCandleChannel(bar) {
  const key = String(bar || '1H');
  return BAR_TO_CHANNEL[key] || 'candle1H';
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

class OkxWsConn {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {Array<{channel:string,instId:string}>} opts.args
   * @param {(msg:object)=>void} opts.onData
   * @param {(level:string,msg:string)=>void} [opts.log]
   * @param {string} [opts.label]
   */
  constructor({ url, args, onData, log, label }) {
    this.url = url;
    this.args = args;
    this.onData = onData;
    this.log = log || (() => {});
    this.label = label || 'ws';
    this.ws = null;
    this.alive = false;
    this.closed = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.lastMsgAt = null;
    this.subscribed = 0;
  }

  connect() {
    if (this.closed) return;
    this.cleanupSocket();
    this.log('info', `[${this.label}] 连接 ${this.url} args=${this.args.length}`);
    // ws 不会自动读取 Node fetch 的代理设置；行情连接需要显式使用代理。
    const proxyUrl = process.env.WSS_PROXY || process.env.wss_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
    const ws = new WebSocket(this.url, proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {});
    this.ws = ws;

    ws.on('open', () => {
      this.alive = true;
      this.reconnectAttempt = 0;
      this.log('info', `[${this.label}] 已连接，订阅 ${this.args.length} 个频道`);
      // 分批 subscribe，避免单帧过大
      const batches = chunk(this.args, 20);
      for (const batch of batches) {
        ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
      }
      this.startPing();
    });

    ws.on('message', (raw) => {
      this.lastMsgAt = Date.now();
      const text = raw.toString();
      if (text === 'pong') return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.event === 'subscribe') {
        this.subscribed += 1;
        return;
      }
      if (msg.event === 'error') {
        this.log('warn', `[${this.label}] 订阅错误: ${msg.msg || msg.code || JSON.stringify(msg)}`);
        return;
      }
      if (msg.event === 'channel-conn-count' || msg.event === 'notice') return;
      if (msg.arg && msg.data) {
        try {
          this.onData(msg);
        } catch (e) {
          this.log('warn', `[${this.label}] onData 异常: ${e.message}`);
        }
      }
    });

    ws.on('close', () => {
      this.alive = false;
      this.stopPing();
      if (this.closed) return;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log('warn', `[${this.label}] 错误: ${err.message}`);
    });
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send('ping');
      } catch {
        /* ignore */
      }
    }, 20000);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30000, 1000 * Math.pow(1.6, Math.min(this.reconnectAttempt, 10)));
    this.log('warn', `[${this.label}] 断开，${Math.round(delay / 1000)}s 后重连 (第 ${this.reconnectAttempt} 次)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  cleanupSocket() {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.alive = false;
  }

  close() {
    this.closed = true;
    this.cleanupSocket();
  }
}

export class OkxWsManager {
  /**
   * @param {object} opts
   * @param {(level:string,msg:string)=>void} [opts.log]
   * @param {number} [opts.maxArgsPerConn]
   */
  constructor({ log, maxArgsPerConn = 50 } = {}) {
    this.log = log || (() => {});
    this.maxArgsPerConn = Math.max(10, Math.min(100, maxArgsPerConn));
    /** @type {OkxWsConn[]} */
    this.conns = [];
    this.candleSubs = 0;
    this.tickerSubs = 0;
    this.lastMsgAt = null;
    this.onCandle = null;
    this.onTicker = null;
  }

  /**
   * @param {object} opts
   * @param {string[]} opts.instIds
   * @param {string} opts.bar
   * @param {(instId:string, candle:any[])=>void} opts.onCandle
   * @param {(instId:string, ticker:object)=>void} opts.onTicker
   */
  start({ instIds, bar, onCandle, onTicker }) {
    this.stop();
    this.onCandle = onCandle;
    this.onTicker = onTicker;
    const ids = [...new Set((instIds || []).filter(Boolean))];
    const candleChannel = barToCandleChannel(bar);
    const candleArgs = ids.map((instId) => ({ channel: candleChannel, instId }));
    const tickerArgs = ids.map((instId) => ({ channel: 'tickers', instId }));
    this.candleSubs = candleArgs.length;
    this.tickerSubs = tickerArgs.length;

    const candleChunks = chunk(candleArgs, this.maxArgsPerConn);
    const tickerChunks = chunk(tickerArgs, this.maxArgsPerConn);

    this.log(
      'info',
      `WS 启动：K线 channel=${candleChannel} ×${candleArgs.length}（${candleChunks.length} 连接）| tickers ×${tickerArgs.length}（${tickerChunks.length} 连接）`
    );

    candleChunks.forEach((args, i) => {
      const conn = new OkxWsConn({
        url: WS_BUSINESS,
        args,
        label: `candle#${i + 1}`,
        log: this.log,
        onData: (msg) => {
          this.lastMsgAt = Date.now();
          const instId = msg.arg?.instId;
          if (!instId || !Array.isArray(msg.data)) return;
          for (const row of msg.data) {
            this.onCandle?.(instId, row);
          }
        },
      });
      this.conns.push(conn);
      conn.connect();
    });

    tickerChunks.forEach((args, i) => {
      const conn = new OkxWsConn({
        url: WS_PUBLIC,
        args,
        label: `ticker#${i + 1}`,
        log: this.log,
        onData: (msg) => {
          this.lastMsgAt = Date.now();
          const instId = msg.arg?.instId;
          if (!instId || !Array.isArray(msg.data)) return;
          for (const row of msg.data) {
            this.onTicker?.(instId, row);
          }
        },
      });
      this.conns.push(conn);
      conn.connect();
    });
  }

  stop() {
    for (const c of this.conns) c.close();
    this.conns = [];
    this.candleSubs = 0;
    this.tickerSubs = 0;
    this.lastMsgAt = null;
  }

  status() {
    const connected = this.conns.length > 0 && this.conns.every((c) => c.alive);
    const anyAlive = this.conns.some((c) => c.alive);
    const reconnecting = this.conns.length > 0 && !connected && anyAlive === false
      ? this.conns.some((c) => !c.closed)
      : this.conns.some((c) => !c.alive && !c.closed);
    return {
      connected,
      reconnecting: !connected && this.conns.length > 0 && this.conns.some((c) => !c.closed),
      connCount: this.conns.length,
      aliveCount: this.conns.filter((c) => c.alive).length,
      candleSubs: this.candleSubs,
      tickerSubs: this.tickerSubs,
      lastMsgAt: this.lastMsgAt ? new Date(this.lastMsgAt).toISOString() : null,
    };
  }
}

export default OkxWsManager;
