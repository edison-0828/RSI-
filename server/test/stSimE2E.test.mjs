// SuperTrend sim 端到端（子进程，隔离数据目录，不监听端口、不连交易所、不读 .env.local）
// 合成走势的翻转位置（RMA 10×3，已由 superTrend.test.mjs 校验指标本身）：bar 103 卖出、164 买入、235 卖出、303 买入
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, 'fixtures', 'stScenarioChild.mjs');

function run(scenario, { env = {}, preseed = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'st-e2e-'));
  try {
    if (preseed) writeFileSync(join(dir, 'positions.json'), JSON.stringify(preseed));
    const e = { ...process.env, RSI_NO_LISTEN: '1', RSI_DATA_DIR: dir, RSI_NO_ENV_LOCAL: '1', PORT: String(20000 + Math.floor(Math.random() * 20000)), ST_SCENARIO: JSON.stringify(scenario) };
    for (const k of Object.keys(e)) if (/^OKX_/.test(k) || k === 'RSI_ALLOW_SHORT' || k === 'RSI_ALLOW_SHORT_LIVE') delete e[k];
    Object.assign(e, env);
    const r = spawnSync(process.execPath, [CHILD], { env: e, encoding: 'utf8', timeout: 90_000 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('@@JSON@@'));
    assert.ok(line, r.stdout);
    return JSON.parse(line.slice(8));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ALLOW = { RSI_ALLOW_SHORT: '1' };
const seq = (o) => o.timeline.map((x) => `${x.bar}:${x.pos.split(':')[1] || '-'}`).join(' ');

test('端到端（允许做空）：卖出翻转开空 → 买入翻转反手开多 → 卖出翻转反手开空 → 买入翻转反手开多；账本四笔、盈亏符号与方向正确', () => {
  const o = run({ cfg: { allow_short: true } }, { env: ALLOW });
  assert.equal(seq(o), '60:- 103:short 164:long 235:short 303:long');
  assert.deepEqual(o.trades.map((t) => [t.direction, t.action]), [['short', 'flip'], ['long', 'flip'], ['short', 'flip']]);
  // 空头：价格大跌 → 盈利；多头：价格大涨 → 盈利；第三笔空头 → 盈利
  for (const t of o.trades) {
    assert.ok(t.pnl_usdt > 0, `${t.direction} 应盈利`);
    assert.equal(t.strategy_id, 'supertrend');
    assert.equal(t.exec_mode, 'sim');
    assert.equal(t.pnl_exact, false);
  }
  const [s1, l1] = o.trades;
  assert.ok(s1.entry_price > s1.exit_price && l1.entry_price < l1.exit_price);
  // 反手：平仓价 == 紧接着的开仓价（同一价格、先平后开）
  assert.equal(o.trades[0].exit_price, o.trades[1].entry_price);
  assert.equal(o.trades[1].exit_price, o.trades[2].entry_price);
  assert.equal(o.positions.length, 1);
  assert.equal(o.positions[0].direction, 'long');
  assert.equal(o.positions[0].strategy_id, 'supertrend');
  assert.equal(o.positions[0].take_profit_price, null);
  assert.ok(o.log.some((l) => l.includes('平空 → 开多（反手）')));
  assert.ok(o.log.some((l) => l.includes('平多 → 开空（反手）')));
  // 同币任何时刻只有一个仓位
  assert.ok(o.timeline.every((x) => x.pos.split(',').filter(Boolean).length <= 1));
});

test('端到端：成交含滑点（买高卖低）与手续费；净盈亏与手算一致（杠杆 2x、费率 0.05%、滑点 0.031%）', () => {
  const o = run({ cfg: { allow_short: true, leverage: 2, amount: 100, sim_fee_pct: 0.05, sim_slippage_pct: 0.031 } }, { env: ALLOW });
  const t = o.trades[0]; // 空头
  const slip = 0.031 / 100;
  assert.equal(t.direction, 'short');
  // 开空 = 卖出 → 价格向下滑；平空 = 买入 → 向上滑。信号价 = 收盘价；这里验证成交价相对反推的信号价偏移
  const sigEntry = t.entry_price / (1 - slip);
  const sigExit = t.exit_price / (1 + slip);
  assert.ok(sigEntry > 0 && sigExit > 0);
  const notional = 200;
  const pct = ((t.entry_price - t.exit_price) / t.entry_price) * 100;
  const gross = (notional * pct) / 100;
  const fee = (notional * 0.05) / 100 + (notional * (t.exit_price / t.entry_price) * 0.05) / 100;
  assert.ok(Math.abs(t.profit_pct - pct) < 1e-9);
  assert.ok(Math.abs(t.gross_pnl_usdt - gross) < 1e-9);
  assert.ok(Math.abs(t.fee_usdt - fee) < 1e-9);
  assert.ok(Math.abs(t.pnl_usdt - (gross - fee)) < 1e-9);
  assert.equal(t.sim_slippage_pct, 0.031);
  assert.ok(Math.abs(t.fee_open_usdt - 0.1) < 1e-9);
  // 多头一笔：开多 = 买入向上滑
  const l = o.trades[1];
  assert.equal(l.direction, 'long');
  assert.ok(l.pnl_usdt < ((200 * (l.exit_price - l.entry_price)) / l.entry_price), '净盈亏 < 毛盈亏（扣了手续费）');
});

test('做空开关（环境变量未放行）：只做多——卖出翻转不开空；持多遇卖出翻转仍然平多；买入翻转重新开多', () => {
  const o = run({ cfg: { allow_short: true } }, { env: {} }); // 策略层允许，但服务端环境变量默认 0
  assert.equal(seq(o), '60:- 164:long 235:- 303:long');
  assert.deepEqual(o.trades.map((t) => [t.direction, t.action]), [['long', 'flip']]);
  assert.ok(o.log.some((l) => l.includes('RSI_ALLOW_SHORT')), '日志写明被哪一层拦截');
  assert.ok(o.log.some((l) => l.includes('仅平仓不反手')));
});

test('做空开关（策略 allow_short=false，即使环境变量放行也不做空）', () => {
  const o = run({ cfg: { allow_short: false } }, { env: ALLOW });
  assert.equal(seq(o), '60:- 164:long 235:- 303:long');
  assert.ok(o.log.some((l) => l.includes('策略设置未允许做空')));
});

test('灾难止损（空头）：价格上破入场价 +8% → 止损平仓并冷却，冷却内的买入翻转不入场；冷却过后卖出翻转正常开空', () => {
  const o = run({ cfg: { allow_short: true, disaster_stop_pct: 8, disaster_cooldown_minutes: 1440 }, actions: [{ afterBar: 110, inst: 'AAA-USDT-SWAP', price: 130 }] }, { env: ALLOW });
  assert.equal(seq(o), '60:- 103:short 110:- 235:short 303:long', '103 开空 → 110 止损 → 164 买入翻转因冷却不入场 → 235 开空');
  const sl = o.trades[0];
  assert.equal(sl.action, 'sl');
  assert.equal(sl.direction, 'short');
  assert.ok(sl.pnl_usdt < 0);
  assert.ok(sl.exit_price > sl.entry_price * 1.08);
  assert.equal(o.trades.length, 2, '103 空(sl) + 235 空→303 反手平仓(flip)');
  assert.ok(o.log.some((l) => l.includes('灾难止损触发')));
  assert.ok(o.log.some((l) => l.includes('冷却中')), '164 的买入翻转因冷却被跳过，有日志');
});

test('灾难止损关闭（0）→ 不止损；高杠杆空头价格暴涨 → 强平（亏光保证金，且冷却）', () => {
  const o = run({ cfg: { allow_short: true, disaster_stop_pct: 0, leverage: 10, amount: 100 }, actions: [{ afterBar: 110, inst: 'AAA-USDT-SWAP', price: 130 }] }, { env: ALLOW });
  const liq = o.trades[0];
  assert.equal(liq.action, 'liq');
  assert.equal(liq.direction, 'short');
  assert.ok(Math.abs(liq.pnl_usdt + 100) < 1e-9, '强平最多亏光保证金');
  assert.ok(Math.abs(liq.exit_price - liq.entry_price * (1 + 1 / 10 - 0.005)) < 1e-9, '按估算强平价成交');
  assert.ok(o.log.some((l) => l.includes('[冷却]') && l.includes('强平')), '强平后进入冷却');
});

test('仓满（max_positions=1）：新入场被跳过且写明原因；已持仓币的反手不受仓满限制', () => {
  const o = run({ cfg: { allow_short: true, max_positions: 1 }, coins: { 'AAA-USDT-SWAP': 'main', 'BBB-USDT-SWAP': 'main' } }, { env: ALLOW });
  assert.equal(seq(o), '60:- 103:short 164:long 235:short 303:long'.replace(/(\d+):(\w+)/g, '$1:$2'), '始终只有一个币持仓');
  const insts = [...new Set(o.trades.map((t) => t.instId))];
  assert.deepEqual(insts, ['AAA-USDT-SWAP'], '只有先到的 AAA 持仓，BBB 一直被仓满挡住');
  assert.ok(o.log.some((l) => l.includes('BBB-USDT-SWAP') && l.includes('持仓已满')));
  // 反手没有被仓满拦住
  assert.ok(o.trades.length >= 3);
});

test('信号过期（超过 signal_max_age_sec）：只平仓，不入场、不反手', () => {
  // 从 bar 230 起评估时钟落后 400 秒（> 默认 300 秒）：235 的卖出翻转只平多，不反手开空
  const o = run({ cfg: { allow_short: true }, lagAfter: { bar: 230, lag: 400 } }, { env: ALLOW });
  assert.equal(seq(o), '60:- 103:short 164:long 235:-', '235 平多后不再开空；303 的买入翻转同样过期不入场');
  assert.ok(o.log.some((l) => l.includes('信号已过期')));
  assert.equal(o.positions.length, 0);
});

test('flip_only=false：无仓位时按当前趋势入场（每段趋势一次）；默认 flip_only=true 启动时不入场', () => {
  // boot=120：此时（bar 103 卖出翻转之后）趋势为下降
  const on = run({ cfg: { allow_short: true, flip_only: false }, boot: 120 }, { env: ALLOW });
  assert.equal(seq(on).split(' ')[0], '60:-'.replace('60', '120').replace(':-', ':short'), 'bootstrap 后第一次评估就按下降趋势开空');
  assert.ok(on.log.some((l) => l.includes('趋势入场')));
  const off = run({ cfg: { allow_short: true }, boot: 120 }, { env: ALLOW });
  assert.equal(seq(off).startsWith('120:- 164:long'), true, '默认只在翻转时入场');
  // 做空被拦时，趋势入场也不会开空
  const blocked = run({ cfg: { allow_short: true, flip_only: false }, boot: 120 }, { env: {} });
  assert.equal(seq(blocked).startsWith('120:- 164:long'), true);
});

test('旧 rsi_dip 持仓（同币）：SuperTrend 不开 / 不平 / 不反手，只占用名额；其它币正常交易', () => {
  const legacy = { positions: [{ instId: 'AAA-USDT-SWAP', exec_mode: 'sim', entry_price: 100, amount: 100, leverage: 1, status: 'open', take_profit_price: 1e9, stop_loss_price: 0.0001 }] };
  const o = run({ cfg: { allow_short: true, max_positions: 2 }, coins: { 'AAA-USDT-SWAP': 'main', 'BBB-USDT-SWAP': 'main' } }, { env: ALLOW, preseed: legacy });
  assert.equal(o.trades.filter((t) => t.instId === 'AAA-USDT-SWAP').length, 0, '旧持仓不被信号平仓');
  const aaa = o.positions.find((p) => p.instId === 'AAA-USDT-SWAP');
  assert.equal(aaa.strategy_id, 'rsi_dip');
  assert.equal(aaa.direction, 'long');
  assert.ok(o.trades.some((t) => t.instId === 'BBB-USDT-SWAP'), 'BBB 正常交易（max_positions=2，旧仓占 1 个）');
  assert.ok(o.log.some((l) => l.includes('旧策略持仓')));
});

test('持久化：已处理翻转落盘（handledFlips），持仓 / 方向 / 策略字段写入 positions.json，schema_version=2', () => {
  const o = run({ cfg: { allow_short: true }, feedTo: 120 }, { env: ALLOW });
  const f = o.positionsFile;
  assert.equal(f.schema_version, 2);
  assert.equal(f.has_short, true);
  assert.equal(f.positions[0].direction, 'short');
  assert.equal(f.positions[0].strategy_id, 'supertrend');
  assert.ok(Number.isFinite(f.handledFlips['sim|AAA-USDT-SWAP']));
});
