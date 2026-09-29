import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('清空展示历史不会重置当日亏损风控累计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-pnl-risk-'));
  const old = process.env.RSI_BOTTOM_HUNTER_DATA_DIR;
  process.env.RSI_BOTTOM_HUNTER_DATA_DIR = dir;
  try {
    const pnl = await import(`../pnl.js?risk-test=${Date.now()}`);
    pnl.recordClose(
      {
        instId: 'BTC-USDT-SWAP',
        exec_mode: 'okx_live',
        amount: 100,
        leverage: 1,
        entry_price: 100,
        at: new Date().toISOString(),
      },
      90,
      'sl',
      -10,
      { pnl_usdt: -10 }
    );
    assert.equal(pnl.todayRealized('okx_live'), -10);

    pnl.clearTrades('okx_live');
    assert.equal(pnl.listTrades(50, 'okx_live').length, 0);
    assert.equal(pnl.todayRealized('okx_live'), -10);
    const dashboard = pnl.buildPnLDashboard([], 'okx_live');
    assert.equal(dashboard.realized_usdt, 0);
    assert.equal(dashboard.today_realized_usdt, -10);

    const reloaded = await import(`../pnl.js?risk-reload=${Date.now()}`);
    assert.equal(reloaded.listTrades(50, 'okx_live').length, 0);
    assert.equal(reloaded.todayRealized('okx_live'), -10);
  } finally {
    if (old === undefined) delete process.env.RSI_BOTTOM_HUNTER_DATA_DIR;
    else process.env.RSI_BOTTOM_HUNTER_DATA_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
