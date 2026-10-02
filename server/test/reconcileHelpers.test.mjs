// 对账方向化：空头 pos<0 不再被误判为「仓位消失」；方向不一致只报警
import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeRowDirection, matchExchangePos, classifyPosition } from '../engine/reconcileHelpers.js';

const INST = 'ETH-USDT-SWAP';
const net = (pos, extra = {}) => ({ instId: INST, posSide: 'net', pos: String(pos), avgPx: '2000', liqPx: '2400', ...extra });

test('exchangeRowDirection：net 按符号；long_short 按 posSide；0 / 非法 → null', () => {
  assert.equal(exchangeRowDirection(net(3)), 'long');
  assert.equal(exchangeRowDirection(net(-3)), 'short');
  assert.equal(exchangeRowDirection({ posSide: 'long', pos: '2' }), 'long');
  assert.equal(exchangeRowDirection({ posSide: 'short', pos: '2' }), 'short');
  assert.equal(exchangeRowDirection(net(0)), null);
  assert.equal(exchangeRowDirection({ pos: 'x' }), null);
});

test('matchExchangePos：返回绝对张数；按期望方向匹配', () => {
  const m = matchExchangePos([net(-5)], INST, 'short');
  assert.equal(m.pos, 5);
  assert.equal(m.signedPos, -5);
  assert.equal(m.direction, 'short');
  assert.equal(m.avgPx, 2000);
  assert.equal(m.liqPx, 2400);
  assert.equal(matchExchangePos([net(-5)], INST, 'long'), null);
  assert.equal(matchExchangePos([net(-5)], INST, null).direction, 'short');
  assert.equal(matchExchangePos([net(5), { ...net(1), instId: 'X' }], 'X', 'long').pos, 1);
});

test('classifyPosition：空头 pos<0 → match（旧代码按 pos>0 会误判消失）；方向相反 → direction_mismatch；无仓位 → gone', () => {
  const shortPos = { instId: INST, direction: 'short' };
  const longPos = { instId: INST, direction: 'long' };
  const legacy = { instId: INST }; // 旧持仓无 direction → 当作多头
  assert.equal(classifyPosition([net(-5)], shortPos).state, 'match');
  assert.equal(classifyPosition([net(-5)], shortPos).xp.pos, 5);
  assert.equal(classifyPosition([net(5)], longPos).state, 'match');
  assert.equal(classifyPosition([net(5)], legacy).state, 'match');
  const mm = classifyPosition([net(-5)], longPos);
  assert.equal(mm.state, 'direction_mismatch');
  assert.equal(mm.other.direction, 'short');
  assert.equal(classifyPosition([net(5)], shortPos).state, 'direction_mismatch');
  assert.equal(classifyPosition([], shortPos).state, 'gone');
  assert.equal(classifyPosition([net(0)], shortPos).state, 'gone');
  assert.equal(classifyPosition([{ ...net(-5), instId: 'OTHER' }], shortPos).state, 'gone');
});
