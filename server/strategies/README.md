# 策略模块

- `contract.js`：策略定义、评估上下文与 Decision 校验。
- `index.js`：注册表与安全评估入口。
- `rsiPullback.js`：当前启用的 RSI 趋势回调策略。

策略是纯函数：输入参数、已收盘 OHLCV 快照和当前持仓方向，输出目标仓位：

- `target: 'long'`：目标为多仓；
- `target: 'short'`：目标为空仓；
- `target: 'flat'`：只退出当前持仓；
- `target: null`：保持不动。

网络、订单、仓位上限、做空总开关、冷却和持久化均由引擎负责，不应写进策略函数。
