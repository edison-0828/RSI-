// 运行：node --test server/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCloseRecord, closeKeyOf, tradeCloseKey, usedKeysFromTrades } from '../closeMatch.js';

const T = (s) => Date.parse(`2026-09-28T${s}+08:00`);
const INST = 'SENT-USDT-SWAP';

// 09-28 SENT：第一笔 22:47 开（0.02243）→ 00:39:24 止损（0.02193）；第二笔 00:39:26 开（0.02199）→ 01:10 止盈
const recPrev = { instId: INST, direction: 'long', cTime: String(T('00:05:10')), uTime: String(T('00:39:24.500')), openAvgPx: '0.02243', closeAvgPx: '0.02193', realizedPnl: '-1.15', type: '2' };
const recOwn = { instId: INST, direction: 'long', cTime: String(T('00:39:25.900')), uTime: String(T('01:10:03')), openAvgPx: '0.02199', closeAvgPx: '0.02243', realizedPnl: '0.95', type: '2' };
const pos2 = { instId: INST, entry_price: 0.02199, opened_ts: T('00:39:26.800'), at: new Date(T('00:39:26.800')).toISOString(), order_cts: T('00:39:25.700') };
const pos2Legacy = { instId: INST, entry_price: 0.02199, opened_ts: T('00:39:26.800') }; // 升级前开的仓（无 order_cts）

test('本仓位平仓记录尚未出现时，不误用上一笔仓位的平仓记录（SENT 复现）', () => {
  assert.equal(pickCloseRecord([recPrev], pos2), null);
  assert.equal(pickCloseRecord([recPrev], pos2Legacy), null);
});

test('本仓位平仓记录出现后正确匹配', () => {
  assert.equal(pickCloseRecord([recOwn, recPrev], pos2), recOwn);
  assert.equal(pickCloseRecord([recPrev, recOwn], pos2Legacy), recOwn);
});

test('已被其它仓位使用过的平仓记录不再使用', () => {
  const used = new Set([closeKeyOf(INST, recOwn)]);
  assert.equal(pickCloseRecord([recOwn], pos2, used), null);
});

test('上一笔很短命（开仓时间也接近）时，仍靠平仓时间/开仓均价/已用键排除', () => {
  const quick = { ...recPrev, cTime: String(T('00:39:10')), uTime: String(T('00:39:24.500')) };
  assert.equal(pickCloseRecord([quick], pos2Legacy), null); // 平仓早于本仓位开仓
  const samePx = { ...quick, openAvgPx: '0.02199', uTime: String(T('00:39:27')) }; // 极端：时间重叠、均价相同
  assert.equal(pickCloseRecord([samePx], pos2Legacy, new Set([closeKeyOf(INST, samePx)])), null);
});

test('多条候选取开仓后最早的一条；只认多头', () => {
  const later = { ...recOwn, uTime: String(T('02:00:00')) };
  const short = { ...recOwn, direction: 'short', uTime: String(T('01:00:00')) };
  assert.equal(pickCloseRecord([later, short, recOwn], pos2), recOwn);
});

test('账本已用键：新记录 close_key；旧记录由 closed_at 还原（与 uTime 一致）', () => {
  const legacy = { instId: INST, exec_mode: 'okx_live', pnl_exact: true, closed_at: new Date(Number(recPrev.uTime)).toISOString() };
  assert.equal(tradeCloseKey(legacy), closeKeyOf(INST, recPrev));
  assert.equal(tradeCloseKey({ instId: INST, exec_mode: 'sim', pnl_exact: false, closed_at: legacy.closed_at }), null);
  const used = usedKeysFromTrades([legacy, { close_key: 'X|1' }]);
  assert.ok(used.has(closeKeyOf(INST, recPrev)) && used.has('X|1'));
  // 旧逻辑下第二笔会拿到 recPrev；现在账本里已有第一笔 → 即使时间条件放宽也不会重复使用
  assert.equal(pickCloseRecord([recPrev], { ...pos2Legacy, opened_ts: T('00:39:20') }, used), null);
});
