import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxExecutor } from '../executor.js';

function preparedExecutor() {
  const logs = [];
  const ex = new OkxExecutor({ mode: 'okx_demo', log: (level, msg) => logs.push({ level, msg }) });
  ex.accountConfig = { posMode: 'net_mode', acctLv: '2' };
  ex.instruments.set('BTC-USDT-SWAP', {
    instId: 'BTC-USDT-SWAP',
    ctVal: '0.01',
    ctValCcy: 'BTC',
    lotSz: '1',
    minSz: '1',
    tickSz: '0.1',
    maxLever: 100,
    state: 'live',
  });
  ex.loadInstruments = async () => ex.instruments;
  ex.getDemoTicker = async () => ({ askPx: 100, bidPx: 99.9, last: 100 });
  ex.refreshBalance = async () => ({ usdtAvail: 1000 });
  ex.ensureLeverage = async () => {};
  return { ex, logs };
}

test('开仓响应未明确时保留 pending，避免同币重复下单', async () => {
  const { ex } = preparedExecutor();
  const events = [];
  ex._placeOrderIdempotent = async () => ({ ordId: 'order-1' });
  ex._waitFill = async () => ({ order: { state: 'live', accFillSz: '0', avgPx: '' }, final: false });
  ex.getExchangePosition = async () => null;
  ex.client.getPositions = async () => []; // 开仓前预检：交易所无该币持仓

  const result = await ex.openPosition({
    instId: 'BTC-USDT-SWAP',
    direction: 'long',
    amount: 100,
    leverage: 2,
    tpPct: null,
    slPct: 8,
    maxSpreadPct: 0.3,
    onPending: (event) => events.push(event),
    recheck: () => ({ ok: true }),
  });

  assert.equal(result.uncertain, true);
  assert.deepEqual(events.map((e) => e.phase).filter(Boolean), ['prepared', 'submitted', 'uncertain']);
  assert.equal(events.some((e) => e.action === 'clear'), false);
});

test('部分平仓会记录剩余数量并进入可重试 closing 状态', async () => {
  const { ex } = preparedExecutor();
  let queryCount = 0;
  ex.getExchangePosition = async () => {
    queryCount++;
    return queryCount === 1
      ? { pos: 10, avgPx: 100 }
      : { pos: 4, avgPx: 100 };
  };
  ex._placeOrderIdempotent = async () => ({ ordId: 'close-1' });
  ex._waitFill = async () => ({ order: { state: 'filled', accFillSz: '6' }, final: true });
  const pos = {
    instId: 'BTC-USDT-SWAP',
    contracts: 10,
    contractsStr: '10',
    entry_price: 100,
    posSide: 'net',
    status: 'open',
  };

  const result = await ex.marketClose(pos, 'manual');
  assert.equal(result.complete, false);
  assert.equal(result.remaining, 4);
  assert.equal(pos.status, 'closing');
  assert.equal(pos.contracts, 4);
  assert.equal(pos.close_attempts, 1);
  assert.ok(pos.close_next_retry_at > Date.now());
});
