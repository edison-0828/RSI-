# 策略接口说明（阶段 1）

策略 = 纯函数 `evaluate(ctx) → Decision`：给定只读行情快照与自己的参数，返回方向 + 触发原因 + 建议止盈止损 + 调试指标。
完整契约见 `contract.js` 顶部的 JSDoc，设计依据见 `docs`/DESIGN.md 第 2 节。

## 约束
1. `evaluate` 必须是**确定性纯函数**：同输入同输出；不读时钟 / 随机数 / 网络 / 全局变量；不修改入参；不下单；不写日志。
   日志（节流）、冷却文案追加、持仓/风控判断都由引擎（`index.js`）负责。
2. `Decision.direction` 必须属于策略声明的 `directions`；`tpPct/slPct` 若给出必须 > 0。
3. `evaluate` 抛异常由引擎用 `evaluateSafely` 捕获：该策略该币本轮视为“无信号”，不影响其他策略与对账。
4. 改动信号语义必须 `version + 1`。
5. 阶段 1 要求所有启用策略的 `needs().bar` 相同。

## 文件
- `contract.js`：类型说明 + `validateStrategy` / `validateDecision`
- `index.js`：注册表 `registerStrategy / getStrategy / listStrategies / evaluateSafely`（内置 `rsi_dip`）
- `rsiDip.js`：RSI 抄底（含可选布林带下轨过滤、可选收盘确认）。逐行对应改造前 `index.js` 的现网语句；`bbFilter.js` 未改动
- 引擎侧适配在 `../engine/signalAdapter.js`（CandleStore 快照 → `EvalCtx`；`Decision` → 信号行字段 / 复核返回值）

## 环境变量（阶段 0 / 1，均默认关闭 = 现网行为）
| 变量 | 作用 |
|---|---|
| `RSI_DATA_DIR` | 数据目录（positions / cooldowns / events.log / pnl-ledger）。优先于旧变量 `RSI_BOTTOM_HUNTER_DATA_DIR`（旧变量继续生效）。必须是真实进程环境变量 |
| `RSI_NO_ENV_LOCAL=1` | 不读取 `server/.env.local`（不加载任何 Key） |
| `RSI_NO_LISTEN=1` | import `server/index.js` 时不监听端口、不启动 20 秒对账定时器；同时导出 `__test` 钩子（仅测试 / 演练）。仍会读取数据目录，所以必须同时设 `RSI_DATA_DIR` |
| `RSI_ENGINE_SHADOW=1` | 影子运行：信号评估 / 下单前复核时，同时用改造前的旧判断（`engine/legacyShadow.js`）比对策略结果；不一致只写 `[回归]` 警告日志，绝不影响信号与下单 |
