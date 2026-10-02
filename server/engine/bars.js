/** K 线周期工具（纯函数） */
const BAR_UNIT_MS = { m: 60_000, H: 3_600_000, D: 86_400_000, W: 604_800_000 };

/** '15m' → 900000；无法解析返回 0 */
export function barToMs(bar) {
  const m = /^(\d+)([mHDW])$/.exec(String(bar || ''));
  return m ? Number(m[1]) * BAR_UNIT_MS[m[2]] : 0;
}

export default { barToMs };
