// 阶段 1：策略契约与注册表
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStrategy, validateDecision } from '../strategies/contract.js';
import { registerStrategy, getStrategy, listStrategies, evaluateSafely } from '../strategies/index.js';
import rsiDip from '../strategies/rsiDip.js';

const mkStrategy = (patch = {}) => ({
  id: 'toy_x',
  name: '玩具',
  version: 1,
  directions: ['long'],
  params: [{ key: 'a', label: 'A', type: 'number', default: 1 }],
  presets: [],
  clamp: (r) => ({ a: Number(r?.a) || 1 }),
  needs: () => ({ bar: '15m', closedBars: 10 }),
  evaluate: () => ({ direction: null, signal: false, text: '未触发', blocked: null, metrics: {} }),
  ...patch,
});

test('注册表：内置 rsi_dip 已注册；getStrategy / listStrategies', () => {
  assert.equal(getStrategy('rsi_dip'), rsiDip);
  assert.ok(listStrategies().some((s) => s.id === 'rsi_dip'));
  assert.equal(getStrategy('不存在'), undefined);
});

test('注册表：重复 id 拒绝；不合法定义拒绝；合法的可注册', () => {
  assert.throws(() => registerStrategy(mkStrategy({ id: 'rsi_dip' })), /重复/);
  assert.throws(() => registerStrategy(mkStrategy({ id: 'Bad-Id' })), /id/);
  assert.throws(() => registerStrategy(mkStrategy({ version: 0 })), /version/);
  assert.throws(() => registerStrategy(mkStrategy({ directions: [] })), /directions/);
  assert.throws(() => registerStrategy(mkStrategy({ directions: ['up'] })), /directions/);
  assert.throws(() => registerStrategy(mkStrategy({ evaluate: undefined })), /evaluate/);
  assert.throws(() => registerStrategy(mkStrategy({ params: [{ key: 'a', label: 'A', type: 'number' }] })), /default/);
  const s = registerStrategy(mkStrategy({ id: 'toy_registry_ok' }));
  assert.equal(getStrategy('toy_registry_ok'), s);
  assert.throws(() => registerStrategy(mkStrategy({ id: 'toy_registry_ok' })), /重复/);
});

test('validateStrategy(rsi_dip) 通过；声明 directions=[long]、version=1', () => {
  assert.equal(validateStrategy(rsiDip), true);
  assert.deepEqual(rsiDip.directions, ['long']);
  assert.equal(rsiDip.version, 1);
});

test('validateDecision：合法 / 非法', () => {
  const ok = { direction: null, signal: false, text: 't', blocked: null, metrics: {} };
  assert.equal(validateDecision(ok), true);
  assert.equal(validateDecision({ ...ok, direction: 'long', signal: true, tpPct: 1, slPct: 2 }, rsiDip), true);
  assert.throws(() => validateDecision({ ...ok, direction: 'up' }), /direction/);
  assert.throws(() => validateDecision({ ...ok, direction: 'short' }, rsiDip), /不在策略/);
  assert.throws(() => validateDecision({ ...ok, signal: true }), /direction 不能为 null/);
  assert.throws(() => validateDecision({ ...ok, tpPct: 0 }), /tpPct/);
  assert.throws(() => validateDecision({ ...ok, slPct: -1 }), /slPct/);
  assert.throws(() => validateDecision({ ...ok, text: 1 }), /text/);
  assert.throws(() => validateDecision({ ...ok, blocked: { kind: 'x' } }), /blocked/);
  assert.throws(() => validateDecision({ ...ok, metrics: null }), /metrics/);
});

test('rsiDip.evaluate 的输出始终通过 validateDecision（各类输入）', () => {
  const p = rsiDip.clamp({ rsi_buy_threshold: 99, bb_filter_enabled: true });
  const closes = Array.from({ length: 60 }, (_, i) => 100 - i * 0.3 + (i % 3));
  for (const ctx of [
    { instId: 'A', phase: 'scan', params: p, market: { price: 80, closes, forming: null, bars: 60, barMs: 900000 }, flags: { tradable: true } },
    { instId: 'A', phase: 'scan', params: p, market: { price: 80, closes, forming: { ts: 1, close: 79 }, bars: 60, barMs: 900000 }, flags: { tradable: true } },
    { instId: 'A', phase: 'scan', params: p, market: { price: null, closes: [], forming: null, bars: 0, barMs: 0 }, flags: { tradable: true } },
    { instId: 'A', phase: 'recheck', params: p, market: { price: 80, closes, forming: null, bars: 60, barMs: 900000 }, flags: { tradable: false } },
  ]) {
    assert.equal(validateDecision(rsiDip.evaluate(ctx), rsiDip), true);
  }
});

test('clamp：旧配置缺字段补默认；幂等；与 clampConfig 规则一致', () => {
  const d = rsiDip.clamp({});
  assert.deepEqual(d, { bar: '15m', rsi_period: 6, rsi_buy_threshold: 20, take_profit_pct: 8, stop_loss_pct: 6, confirm_on_close: false, bb_filter_enabled: false, bb_period: 20, bb_mult: 2 });
  assert.deepEqual(rsiDip.clamp(d), d, '幂等');
  assert.equal(rsiDip.clamp({ rsi_period: 1 }).rsi_period, 2);
  assert.equal(rsiDip.clamp({ rsi_buy_threshold: '25' }).rsi_buy_threshold, 25);
  assert.equal(rsiDip.clamp({ confirm_on_close: 'true' }).confirm_on_close, true);
  assert.equal(rsiDip.clamp({ bb_period: 9999 }).bb_period, 100);
  assert.deepEqual(rsiDip.needs(d), { bar: '15m', closedBars: 7 });
  assert.deepEqual(rsiDip.needs({ ...d, bb_filter_enabled: true }), { bar: '15m', closedBars: 19 });
});

test('策略抛异常被隔离：一个策略崩溃不影响其它策略的评估', () => {
  const bomb = mkStrategy({ id: 'toy_bomb', evaluate: () => { throw new Error('炸了'); } });
  const good = mkStrategy({ id: 'toy_good', evaluate: () => ({ direction: 'long', signal: true, text: 'ok', blocked: null, metrics: {} }) });
  const errs = [];
  const results = [bomb, good].map((s) => evaluateSafely(s, {}, (e, st) => errs.push(`${st.id}:${e.message}`)));
  assert.equal(results[0], null);
  assert.equal(results[1].signal, true);
  assert.deepEqual(errs, ['toy_bomb:炸了']);
});
