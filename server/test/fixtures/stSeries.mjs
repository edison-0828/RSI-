// 测试用合成 K 线：先缓涨 → 下跌（卖出翻转）→ 反弹（买入翻转）→ 下跌（卖出翻转）→ 反弹（买入翻转）
export const T0 = 1_790_000_000_000;
export const BAR = 900_000;
export function closes(n = 400) {
  const c = [];
  for (let i = 0; i < n; i++) {
    let v;
    if (i < 100) v = 100 + i * 0.05 + Math.sin(i / 4) * 0.8;
    else if (i < 160) v = 105 - (i - 100) * 0.9 + Math.sin(i / 4) * 0.5;
    else if (i < 230) v = 51 + (i - 160) * 1.1 + Math.sin(i / 4) * 0.5;
    else if (i < 300) v = 128 - (i - 230) * 1.1 + Math.sin(i / 4) * 0.5;
    else v = 51 + (i - 300) * 1.2 + Math.sin(i / 4) * 0.5;
    c.push(v);
  }
  return c;
}
/** OKX 格式 K 线 [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm] */
export function candle(i, c, confirm = '1') {
  return [String(T0 + i * BAR), String(c), String(c * 1.003), String(c * 0.997), String(c), '1', '1', '1', confirm];
}
