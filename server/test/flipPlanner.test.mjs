// 反手状态机（纯函数）+ 做空三层开关
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFlip } from '../engine/flipPlanner.js';
import { shortBlockReason, shortEnvBlockReason, assertShortAllowed, shortEnvFlags } from '../engine/shortGate.js';

const none = { close: false, open: null, reverse: false };

test('planFlip：无仓位首次入场（多 / 空），做空被拦截则跳过', () => {
  assert.deepEqual(planFlip({ flipDir: 'long' }), { ...none, open: 'long', skip: null });
  assert.deepEqual(planFlip({ flipDir: 'short' }), { ...none, open: 'short', skip: null });
  const r = planFlip({ flipDir: 'short', shortBlock: '策略未允许做空' });
  assert.deepEqual([r.close, r.open], [false, null]);
  assert.match(r.skip, /策略未允许做空/);
});

test('planFlip：反手 = 先平后开；做空被拦截时持多遇卖出翻转仍平多、不反手', () => {
  assert.deepEqual(planFlip({ heldDir: 'long', flipDir: 'short' }), { close: true, open: 'short', reverse: true, skip: null });
  assert.deepEqual(planFlip({ heldDir: 'short', flipDir: 'long' }), { close: true, open: 'long', reverse: true, skip: null });
  const r = planFlip({ heldDir: 'long', flipDir: 'short', shortBlock: '实盘做空被禁止' });
  assert.equal(r.close, true);
  assert.equal(r.open, null);
  assert.equal(r.reverse, false);
  assert.match(r.skip, /仅平仓不反手/);
  // 持空遇买入翻转：平空 + 开多（做空开关不影响开多）
  assert.equal(planFlip({ heldDir: 'short', flipDir: 'long', shortBlock: '禁止' }).open, 'long');
});

test('planFlip：同向重复信号无动作；已被占用（旧策略 / pending / 外部持仓）一律不动', () => {
  const same = planFlip({ heldDir: 'long', flipDir: 'long' });
  assert.deepEqual([same.close, same.open], [false, null]);
  const occ = planFlip({ heldDir: null, occupied: '该币已有旧策略持仓', flipDir: 'long' });
  assert.deepEqual([occ.close, occ.open], [false, null]);
  assert.equal(occ.skip, '该币已有旧策略持仓');
  // 占用时即使有同币持仓也不平仓（不碰他人仓位）
  assert.equal(planFlip({ heldDir: 'long', occupied: 'x', flipDir: 'short' }).close, false);
});

test('planFlip：仓满只拦新入场，不拦反手（反手占用刚释放的槽位）；平仓永不被风控拦截', () => {
  const full = planFlip({ flipDir: 'long', full: true });
  assert.equal(full.open, null);
  assert.match(full.skip, /持仓已满/);
  assert.deepEqual(planFlip({ heldDir: 'long', flipDir: 'short', full: true }), { close: true, open: 'short', reverse: true, skip: null });
});

test('planFlip：灾难止损冷却中——新入场跳过；反手只平不开；无效方向', () => {
  const r = planFlip({ flipDir: 'long', cooldown: '冷却中：灾难止损，剩余30分钟' });
  assert.equal(r.open, null);
  assert.match(r.skip, /冷却中/);
  const r2 = planFlip({ heldDir: 'short', flipDir: 'long', cooldown: '冷却中：灾难止损' });
  assert.equal(r2.close, true);
  assert.equal(r2.open, null);
  assert.equal(planFlip({ flipDir: 'up' }).open, null);
});

test('做空开关：环境变量默认关；实盘另需 RSI_ALLOW_SHORT_LIVE；现货不可做空；策略开关', () => {
  assert.deepEqual(shortEnvFlags({}), { base: false, live: false });
  assert.match(shortEnvBlockReason('sim', {}), /RSI_ALLOW_SHORT/);
  assert.equal(shortEnvBlockReason('sim', { RSI_ALLOW_SHORT: '1' }), null);
  assert.equal(shortEnvBlockReason('okx_demo', { RSI_ALLOW_SHORT: '1' }), null);
  assert.match(shortEnvBlockReason('okx_live', { RSI_ALLOW_SHORT: '1' }), /RSI_ALLOW_SHORT_LIVE/);
  assert.match(shortEnvBlockReason('okx_live', { RSI_ALLOW_SHORT_LIVE: '1' }), /RSI_ALLOW_SHORT/, '只开 LIVE 不开 BASE 仍拒绝');
  assert.equal(shortEnvBlockReason('okx_live', { RSI_ALLOW_SHORT: '1', RSI_ALLOW_SHORT_LIVE: '1' }), null);
  const E = { RSI_ALLOW_SHORT: '1' };
  assert.equal(shortBlockReason({ direction: 'long', execMode: 'okx_live', cfgAllowShort: false, env: {} }), null, '多头恒放行');
  assert.match(shortBlockReason({ direction: 'short', execMode: 'sim', cfgAllowShort: false, env: E }), /策略设置/);
  assert.match(shortBlockReason({ direction: 'short', execMode: 'sim', tradeMode: 'spot', cfgAllowShort: true, env: E }), /现货/);
  assert.equal(shortBlockReason({ direction: 'short', execMode: 'sim', cfgAllowShort: true, env: E }), null);
  assert.match(shortBlockReason({ direction: 'short', execMode: 'okx_live', cfgAllowShort: true, env: E }), /实盘/);
  assert.match(shortBlockReason({ direction: 'short', execMode: 'sim', cfgAllowShort: true, env: {} }), /RSI_ALLOW_SHORT/);
});

test('做空第 3 层：执行层断言不看策略开关，只看环境变量；实盘默认拒绝', () => {
  assert.doesNotThrow(() => assertShortAllowed('long', 'okx_live', {}));
  assert.throws(() => assertShortAllowed('short', 'sim', {}), /拒绝做空开仓/);
  assert.throws(() => assertShortAllowed('short', 'okx_demo', {}), /拒绝做空开仓/);
  assert.throws(() => assertShortAllowed('short', 'okx_live', { RSI_ALLOW_SHORT: '1' }), /RSI_ALLOW_SHORT_LIVE/);
  assert.doesNotThrow(() => assertShortAllowed('short', 'okx_demo', { RSI_ALLOW_SHORT: '1' }));
  assert.doesNotThrow(() => assertShortAllowed('short', 'okx_live', { RSI_ALLOW_SHORT: '1', RSI_ALLOW_SHORT_LIVE: '1' }));
});
