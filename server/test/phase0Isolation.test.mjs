// 阶段 0：路径与环境隔离。运行：node --test server/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveDataDir, dataDirOverridden, DEFAULT_DATA_DIR } from '../dataDir.js';
import { loadEnvLocal } from '../env.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(here, '..');
const REAL_DATA = join(SERVER_DIR, 'data');

/** 递归快照目录（路径 + 大小 + mtime），用于证明没碰真实 data 目录 */
function snapshotDir(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      out.push(`${p}|${st.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test('dataDir：未设置变量 → 默认 server/data；新变量优先；旧变量继续生效', () => {
  assert.equal(resolveDataDir({}), DEFAULT_DATA_DIR);
  assert.equal(DEFAULT_DATA_DIR, REAL_DATA);
  assert.equal(dataDirOverridden({}), false);
  assert.equal(resolveDataDir({ RSI_BOTTOM_HUNTER_DATA_DIR: '/tmp/old' }), resolve('/tmp/old'));
  assert.equal(resolveDataDir({ RSI_DATA_DIR: '/tmp/new' }), resolve('/tmp/new'));
  assert.equal(resolveDataDir({ RSI_DATA_DIR: '/tmp/new', RSI_BOTTOM_HUNTER_DATA_DIR: '/tmp/old' }), resolve('/tmp/new'));
  assert.equal(dataDirOverridden({ RSI_DATA_DIR: '/tmp/new' }), true);
  assert.equal(dataDirOverridden({ RSI_BOTTOM_HUNTER_DATA_DIR: '/tmp/old' }), true);
});

test('env.js：RSI_NO_ENV_LOCAL=1 时不读取 .env.local（直接跳过，连 existsSync 都不碰）', () => {
  const old = process.env.RSI_NO_ENV_LOCAL;
  process.env.RSI_NO_ENV_LOCAL = '1';
  try {
    const r = loadEnvLocal();
    assert.equal(r.loaded, false);
    assert.equal(r.count, 0);
    assert.deepEqual(r.keys, []);
    assert.equal(r.skipped, true);
  } finally {
    if (old === undefined) delete process.env.RSI_NO_ENV_LOCAL;
    else process.env.RSI_NO_ENV_LOCAL = old;
  }
});

test('env.js：显式传入的其它文件不受 RSI_NO_ENV_LOCAL 影响（仍可加载；变量名为一次性测试名）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-envtest-'));
  const old = process.env.RSI_NO_ENV_LOCAL;
  process.env.RSI_NO_ENV_LOCAL = '1';
  try {
    const f = join(dir, 'x.env');
    writeFileSync(f, 'RSI_TEST_ONLY_VAR_A=1\n', 'utf8');
    const r = loadEnvLocal(f);
    assert.equal(r.loaded, true);
    assert.deepEqual(r.keys, ['RSI_TEST_ONLY_VAR_A']);
  } finally {
    delete process.env.RSI_TEST_ONLY_VAR_A;
    if (old === undefined) delete process.env.RSI_NO_ENV_LOCAL;
    else process.env.RSI_NO_ENV_LOCAL = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

function runChild(extraEnv) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^OKX_/.test(k)) delete env[k];
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [join(here, 'fixtures', 'importIndexChild.mjs')], { env, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@JSON@@'));
  return { status: r.status, stderr: r.stderr, out: line ? JSON.parse(line.slice(8)) : null, stdout: r.stdout };
}

test('隔离变量下 import index.js：不监听端口、进程自行退出、数据只落在临时目录、不碰真实 data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-iso-'));
  try {
    // 预置一个“已有旧 sim 持仓”的状态文件，证明读取走的是临时目录
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'positions.json'),
      JSON.stringify({ positions: [{ instId: 'ZZZ-USDT-SWAP', exec_mode: 'sim', entry_price: 1, amount: 10, leverage: 1, status: 'open' }] }),
      'utf8'
    );
    const before = snapshotDir(REAL_DATA);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const r = runChild({ RSI_NO_LISTEN: '1', RSI_DATA_DIR: dir, RSI_NO_ENV_LOCAL: '1', PORT: String(port) });
    assert.equal(r.status, 0, `子进程应正常退出（无监听 / 无定时器让进程挂住）：${r.stderr}`);
    assert.ok(r.out, `应有 JSON 输出：${r.stdout}`);
    assert.equal(r.out.hasHook, true);
    assert.equal(resolve(r.out.dataDir), resolve(dir), '数据目录应为临时目录');
    assert.equal(r.out.portFree, true, 'import 后端口仍空闲 = 没有 listen');
    assert.deepEqual(r.out.positionsAtLoad, ['ZZZ-USDT-SWAP'], '应从临时目录读取到预置持仓');
    assert.deepEqual(r.out.legacyAtLoad, [{ instId: 'ZZZ-USDT-SWAP', strategy_id: 'rsi_dip', direction: 'long' }], '旧持仓补默认字段');
    // 写入也发生在临时目录
    const written = r.out.positionsFile?.positions?.map((p) => p.instId) || [];
    assert.ok(written.includes('AAA-USDT-SWAP'), 'sim 开仓后 positions.json 应写入临时目录');
    assert.deepEqual(snapshotDir(REAL_DATA), before, '真实 server/data 不应有任何变化');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('冒烟（sim，无网络）：bootstrap 历史翻转不算信号；新收盘的买入翻转 → 开多；旧持仓不被管理；clamp 与策略 clamp 一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsi-smoke-'));
  try {
    writeFileSync(
      join(dir, 'positions.json'),
      JSON.stringify({ positions: [{ instId: 'ZZZ-USDT-SWAP', exec_mode: 'sim', entry_price: 1, amount: 10, leverage: 1, status: 'open' }] }),
      'utf8'
    );
    const port = 20000 + Math.floor(Math.random() * 20000);
    const r = runChild({ RSI_NO_LISTEN: '1', RSI_DATA_DIR: dir, RSI_NO_ENV_LOCAL: '1', PORT: String(port) });
    assert.equal(r.status, 0, r.stderr);
    const o = r.out;
    assert.deepEqual(o.cfg, { atr_period: 10, atr_multiplier: 3, atr_method: 'rma', allow_short: false, flip_only: true });
    assert.deepEqual(o.afterBootstrap.signals, [], '启动 bootstrap 里的历史翻转不算信号');
    assert.deepEqual(o.afterBootstrap.positions, ['ZZZ-USDT-SWAP'], '启动时不会按当前趋势入场（flip_only）');
    const aaa = o.positionsAfter.find((p) => p.instId === 'AAA-USDT-SWAP');
    assert.ok(aaa, 'bar 164 买入翻转后应开多');
    assert.equal(aaa.direction, 'long');
    assert.equal(aaa.strategy_id, 'supertrend');
    assert.equal(aaa.exec_mode, 'sim');
    assert.equal(aaa.tp, null, '无止盈');
    assert.ok(Math.abs(aaa.sl - aaa.entry * 0.92) < 1e-9, '灾难止损 8%');
    assert.equal(o.positionsAfter.some((p) => p.instId === 'BBB-USDT-SWAP'), false, '无翻转的币不开仓');
    const legacy = o.positionsAfter.find((p) => p.instId === 'ZZZ-USDT-SWAP');
    assert.equal(legacy.strategy_id, 'rsi_dip', '旧持仓不被 SuperTrend 接管或平仓');
    assert.deepEqual(o.clampMismatch, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未设置 RSI_NO_LISTEN 时不导出测试钩子（现网路径无新增暴露面）— 静态检查 index.js 源码', () => {
  const src = readFileSync(join(SERVER_DIR, 'index.js'), 'utf8');
  assert.match(src, /export const __test = NO_LISTEN/);
  assert.match(src, /process\.env\.RSI_NO_LISTEN === '1'/);
  assert.doesNotMatch(src, /RSI_ENGINE_SHADOW/, '影子运行已随 RSI 移除');
});
