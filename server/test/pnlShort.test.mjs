// 账本 / 平仓匹配 / 冷却 / 升级迁移：空头记账符号、方向不串、旧数据补默认并备份
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickCloseRecord } from '../closeMatch.js';
import { CoinGuard, GUARD_DEFAULTS } from '../coinGuard.js';
import { withStrategyDefaults, isManagedPosition, needsUpgrade, backupOnce } from '../engine/normalize.js';

async function freshPnl() {
  const dir = mkdtempSync(join(tmpdir(), 'st-pnl-'));
  const old = process.env.RSI_DATA_DIR;
  process.env.RSI_DATA_DIR = dir;
  const pnl = await import(`../pnl.js?short=${Date.now()}-${Math.random()}`);
  return { dir, pnl, restore: () => { if (old === undefined) delete process.env.RSI_DATA_DIR; else process.env.RSI_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }); } };
}

test('账本：空头价格下跌记为盈利，上涨记为亏损；带 direction / strategy_id；flip 动作；仪表盘分策略 / 分方向汇总', async () => {
  const { pnl, restore } = await freshPnl();
  try {
    const S = { instId: 'ETH-USDT-SWAP', exec_mode: 'sim', direction: 'short', strategy_id: 'supertrend', strategy_version: 1, signal_meta: { flip_bar_ts: 1 }, amount: 100, leverage: 2, entry_price: 100, at: new Date().toISOString(), simulated: true, mode: 'swap' };
    const t1 = pnl.recordClose(S, 90, 'flip', 10, {});
    assert.equal(t1.direction, 'short');
    assert.equal(t1.side, 'short');
    assert.equal(t1.strategy_id, 'supertrend');
    assert.equal(t1.action, 'flip');
    assert.ok(Math.abs(t1.pnl_usdt - 20) < 1e-9, '保证金100 × 2x × 10% = 20 盈利');
    const t2 = pnl.recordClose({ ...S, instId: 'A-USDT-SWAP' }, 110, 'sl', -10, {});
    assert.ok(Math.abs(t2.pnl_usdt + 20) < 1e-9);
    const L = pnl.recordClose({ ...S, instId: 'B-USDT-SWAP', direction: 'long' }, 110, 'flip', 10, { pnl_usdt: 18.5, sim: true, fee_usdt: 1.5, gross_pnl_usdt: 20 });
    assert.equal(L.pnl_usdt, 18.5);
    assert.equal(L.pnl_exact, false, '本地模拟的成交 pnl 不是交易所精确值');
    assert.equal(L.direction, 'long');
    // 旧调用（无 direction / strategy_id 的持仓）：默认 long / rsi_dip
    const legacy = pnl.recordClose({ instId: 'C-USDT-SWAP', exec_mode: 'sim', amount: 10, leverage: 1, entry_price: 1, at: new Date().toISOString() }, 1.1, 'tp', 10, {});
    assert.equal(legacy.direction, 'long');
    assert.equal(legacy.strategy_id, 'rsi_dip');
    const dash = pnl.buildPnLDashboard([{ instId: 'OPEN-USDT-SWAP', exec_mode: 'sim', direction: 'short', strategy_id: 'supertrend', amount: 100, leverage: 1, entry_price: 100, last_price: 95 }], 'sim');
    assert.equal(dash.open[0].direction, 'short');
    assert.ok(Math.abs(dash.open[0].pnl_usdt - 5) < 1e-9, '空头价格 100→95，浮盈 +5');
    assert.ok(dash.by_strategy && dash.by_direction, '分策略 / 分方向汇总');
    const dirs = JSON.stringify(dash.by_direction);
    assert.match(dirs, /short/);
    assert.match(dirs, /long/);
  } finally {
    restore();
  }
});

test('closeMatch：先多后空反手时，空头不会匹配到上一笔多头的平仓记录（方向不串）；旧持仓缺省 long', () => {
  const T = 1_790_000_000_000;
  const INST = 'ETH-USDT-SWAP';
  const longRec = { instId: INST, direction: 'long', cTime: String(T), uTime: String(T + 60_000), openAvgPx: '100', closeAvgPx: '110', type: '2' };
  const shortRec = { instId: INST, direction: 'short', cTime: String(T + 61_000), uTime: String(T + 600_000), openAvgPx: '110', closeAvgPx: '100', type: '2' };
  const shortPos = { instId: INST, direction: 'short', entry_price: 110, opened_ts: T + 61_500, order_cts: T + 61_000 };
  assert.equal(pickCloseRecord([longRec], shortPos), null);
  assert.equal(pickCloseRecord([longRec, shortRec], shortPos), shortRec);
  const longPos = { instId: INST, entry_price: 100, opened_ts: T + 100, order_cts: T }; // 旧持仓：无 direction
  assert.equal(pickCloseRecord([shortRec, longRec], longPos), longRec);
});

test('coinGuard：supertrend 灾难止损冷却（按策略隔离，信号平仓不冷却）；旧版冷却文件（无 strategy_id）加载后归入 rsi_dip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-guard-'));
  try {
    let now = Date.parse('2026-10-01T10:00:00+08:00');
    const g = new CoinGuard({ path: join(dir, 'cooldowns.json'), now: () => now, log: () => {} });
    const r = g.onDisasterStop('sim', 'BTC-USDT-SWAP', { strategyId: 'supertrend', minutes: 60, lossPct: -8 });
    assert.equal(r.kind, 'disaster');
    assert.match(g.check('sim', 'BTC-USDT-SWAP', 'supertrend').text, /灾难止损/);
    assert.equal(g.check('sim', 'BTC-USDT-SWAP', 'rsi_dip'), null, '不同策略互不影响');
    assert.equal(g.check('okx_demo', 'BTC-USDT-SWAP', 'supertrend'), null, '不同模式互不影响');
    assert.equal(g.onDisasterStop('sim', 'X-USDT-SWAP', { strategyId: 'supertrend', minutes: 0 }), null, 'minutes=0 → 不冷却');
    const saved = JSON.parse(readFileSync(join(dir, 'cooldowns.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.items.some((x) => x.strategy_id === 'supertrend'), true);
    now += 61 * 60 * 1000;
    assert.equal(g.check('sim', 'BTC-USDT-SWAP', 'supertrend'), null, '60 分钟后解除');
    // 旧版文件：{version:1,items:[{instId,exec_mode,slTimes,cooldown}]}（无 strategy_id）
    const until = now + 3600_000;
    writeFileSync(join(dir, 'cooldowns.json'), JSON.stringify({ version: 1, items: [{ instId: 'SENT-USDT-SWAP', exec_mode: 'okx_live', slTimes: [now - 1000], cooldown: { until, kind: 'normal', reason: 'x', at: now - 1000 } }] }));
    const g2 = new CoinGuard({ path: join(dir, 'cooldowns.json'), now: () => now, log: () => {} });
    assert.equal(g2.load(GUARD_DEFAULTS), 1);
    assert.ok(g2.check('okx_live', 'SENT-USDT-SWAP', 'rsi_dip'));
    assert.equal(g2.check('okx_live', 'SENT-USDT-SWAP', 'supertrend'), null, '旧冷却不会阻止 supertrend');
    assert.equal(g2.list(GUARD_DEFAULTS)[0].strategy_id, 'rsi_dip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('升级迁移：旧持仓补 strategy_id=rsi_dip / direction=long；isManagedPosition 只认 supertrend；backupOnce 只备份一次且不改原文件', () => {
  const old = { instId: 'SENT-USDT-SWAP', posSide: 'net', tp_pct: 8, sl_pct: 6, exec_mode: 'okx_live' };
  assert.equal(needsUpgrade(old), true);
  const n = withStrategyDefaults(old);
  assert.equal(n.strategy_id, 'rsi_dip');
  assert.equal(n.direction, 'long');
  assert.equal(isManagedPosition(n), false);
  assert.equal(isManagedPosition({ strategy_id: 'supertrend', direction: 'short' }), true);
  assert.equal(needsUpgrade(n), false);
  const dir = mkdtempSync(join(tmpdir(), 'st-bak-'));
  try {
    const f = join(dir, 'positions.json');
    writeFileSync(f, '{"a":1}');
    assert.equal(backupOnce(f), true);
    assert.equal(readFileSync(`${f}.bak-pre-v2`, 'utf8'), '{"a":1}');
    writeFileSync(f, '{"a":2}');
    assert.equal(backupOnce(f), false, '备份只做一次');
    assert.equal(readFileSync(`${f}.bak-pre-v2`, 'utf8'), '{"a":1}', '已有备份不被覆盖');
    assert.equal(backupOnce(join(dir, 'none.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('升级迁移（端到端子进程）：旧 positions.json / cooldowns.json / pnl-ledger.json 加载后补默认，升级前生成 .bak-pre-v2，旧账本首次写盘前备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-mig-'));
  try {
    mkdirSync(join(dir, 'live'), { recursive: true });
    const legacyPos = { instId: 'SENT-USDT-SWAP', exec_mode: 'okx_live', entry_price: 0.022, amount: 20, leverage: 5, contracts: 10, status: 'open', algoId: 'A1', posSide: 'net', tp_pct: 8, sl_pct: 6 };
    writeFileSync(join(dir, 'live', 'positions.json'), JSON.stringify({ positions: [legacyPos] }));
    writeFileSync(join(dir, 'positions.json'), JSON.stringify({ positions: [{ instId: 'AAA-USDT-SWAP', exec_mode: 'sim', entry_price: 1, amount: 10, leverage: 1, status: 'open' }] }));
    writeFileSync(join(dir, 'cooldowns.json'), JSON.stringify({ version: 1, items: [] }));
    const ledger = JSON.stringify({ trades: [{ id: 't1', instId: 'X-USDT-SWAP', action: 'tp', exec_mode: 'sim', pnl_usdt: 1, closed_at: new Date().toISOString() }], riskEvents: [] });
    writeFileSync(join(dir, 'pnl-ledger.json'), ledger);
    const env = { ...process.env, RSI_NO_LISTEN: '1', RSI_DATA_DIR: dir, RSI_NO_ENV_LOCAL: '1', PORT: '23999' };
    for (const k of Object.keys(env)) if (/^OKX_/.test(k)) delete env[k];
    const code = `
      const m = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
      const t = m.__test;
      const live = t.positions.get('SENT-USDT-SWAP');
      const p = await import(${JSON.stringify(new URL('../pnl.js', import.meta.url).href)});
      p.recordClose({ instId: 'Y-USDT-SWAP', exec_mode: 'sim', amount: 1, leverage: 1, entry_price: 1 }, 1, 'manual', 0, {});
      t.saveState();
      console.log('@@' + JSON.stringify({ live: { s: live.strategy_id, d: live.direction, mode: live.exec_mode }, sim: t.positions.get('AAA-USDT-SWAP').strategy_id, trades: p.listTrades(10, 'sim').length }));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
    assert.deepEqual(out.live, { s: 'rsi_dip', d: 'long', mode: 'okx_live' });
    assert.equal(out.sim, 'rsi_dip');
    assert.equal(out.trades, 2, '旧账本记录保留，新记录追加');
    assert.equal(existsSync(join(dir, 'live', 'positions.json.bak-pre-v2')), true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'live', 'positions.json.bak-pre-v2'), 'utf8')).positions[0].algoId, 'A1', '备份是升级前的原文');
    assert.equal(existsSync(join(dir, 'positions.json.bak-pre-v2')), true);
    assert.equal(existsSync(join(dir, 'cooldowns.json.bak-pre-v2')), true);
    assert.equal(readFileSync(join(dir, 'pnl-ledger.json.bak-pre-v2'), 'utf8'), ledger, '账本在首次写盘前备份');
    const after = JSON.parse(readFileSync(join(dir, 'live', 'positions.json'), 'utf8'));
    assert.equal(after.schema_version, 2);
    assert.equal(after.positions[0].strategy_id, 'rsi_dip');
    assert.equal(after.has_short, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
