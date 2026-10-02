# RSI 趋势回调自动交易

面向 OKX USDT 现货/永续的全市场扫描与自动交易面板。系统只在已收盘 K 线上计算信号，使用 EMA 判断趋势、RSI 捕捉回调恢复、成交量过滤假突破，并在入场时按 ATR 设置灾难止损。

## 策略规则

默认参数是 15 分钟、RSI(14)、EMA(200)：

- 做多：价格高于 EMA；最近 12 根 RSI 曾低于 35；最新 RSI 从下向上穿越 40；当前成交量达到此前 20 根均量。
- 做空：价格低于 EMA；最近 12 根 RSI 曾高于 65；最新 RSI 从上向下穿越 60；当前成交量达到此前 20 根均量。
- 多单退出：RSI 到达 65，或收盘价跌破 EMA。
- 空单退出：RSI 到达 35，或收盘价升破 EMA。
- 灾难止损：入场时用 `ATR(14) × 2.5` 换算止损距离；这是交易所保护单，不依赖后续程序持续在线。
- 不自动强制反手：退出信号只平仓；满足新的反向入场条件后才开反向仓位。

所有阈值都可在设置面板调整。默认关闭做空。

## 为什么这样组合

单独使用 RSI 超买超卖很容易在单边行情里逆势接刀。EMA(200) 让系统只顺大方向交易；“先超调、再恢复穿越”避免 RSI 一进入超卖就立即抄底；成交量确认进一步过滤无量反弹。ATR 止损随币种波动变化，比所有币统一使用固定百分比更适合全市场扫描。

## 安全边界

- 默认执行方式是本地模拟，不会下真实订单。
- OKX 模拟盘与实盘使用独立凭证、独立持仓与独立持久化文件。
- 实盘需要通过启动检查并输入确认文本。
- 做空需要策略开关和服务端环境变量共同放行；实盘另有一层开关。
- 旧 `supertrend` 和 `rsi_dip` 持仓会作为旧策略持仓保留，仅参与交易所对账，当前 RSI 策略不会接管或叠加。
- 信号按“执行模式 + 币种 + 已收盘 K 线时间”持久化去重，重启不会重复执行同一根 K 线。

## 安装与运行

```bash
npm install
npm run dev
```

前端默认运行在 `http://127.0.0.1:5173`，后端默认监听 `http://127.0.0.1:8787`。

生产构建与验证：

```bash
npm run typecheck
npm test
npm run build
npm start
```

## OKX 凭证

在 `server/.env.local` 配置；不要把该文件提交到版本库。

```dotenv
OKX_DEMO_API_KEY=
OKX_DEMO_SECRET_KEY=
OKX_DEMO_PASSPHRASE=

OKX_LIVE_API_KEY=
OKX_LIVE_SECRET_KEY=
OKX_LIVE_PASSPHRASE=

# 做空总开关
RSI_ALLOW_SHORT=0
# 实盘做空附加开关
RSI_ALLOW_SHORT_LIVE=0
```

建议 API Key 只授予读取和交易权限，不授予提现权限，并绑定固定 IP。

## 主要参数

| 参数 | 默认 | 说明 |
| --- | ---: | --- |
| `bar` | `15m` | K 线周期 |
| `rsi_period` | 14 | Wilder RSI 周期 |
| `ema_period` | 200 | 趋势 EMA 周期 |
| `long_setup_rsi` / `long_entry_rsi` | 35 / 40 | 多头超卖与恢复阈值 |
| `short_setup_rsi` / `short_entry_rsi` | 65 / 60 | 空头超买与恢复阈值 |
| `setup_lookback` | 12 | RSI 超调状态有效的回看根数 |
| `volume_period` / `volume_multiplier` | 20 / 1.0 | 入场量能确认 |
| `exit_long_rsi` / `exit_short_rsi` | 65 / 35 | RSI 目标退出阈值 |
| `atr_period` / `atr_stop_mult` | 14 / 2.5 | 动态灾难止损 |
| `signal_max_age_sec` | 300 | 过期入场信号不追单；退出信号仍执行 |
| `disaster_cooldown_minutes` | 60 | 灾难止损或强平后的同币冷却 |

## 数据与迁移

默认数据目录是 `server/data`，可用 `RSI_DATA_DIR` 重定向。状态 schema 为 v3；从旧版本加载时会保留一次 `.bak-pre-v3` 备份。主要文件：

- `positions.json`：本地模拟与 OKX 模拟盘持仓、待确认订单、已处理信号。
- `live/positions.json`：实盘状态。
- `pnl-ledger.json`：平仓账本。
- `cooldowns.json`：止损冷却。
- `events.log`：重要事件日志。

## 代码结构

```text
server/
  strategies/rsiPullback.js     RSI 目标仓位策略
  engine/rsiPullbackCalc.js     EMA / RSI / ATR 纯指标函数
  engine/flipPlanner.js         目标仓位执行规划（保留旧导出兼容）
  candleStore.js                已收盘 OHLCV 存储与断档检测
  executor.js                   OKX 下单、保护单与对账
  index.js                      扫描、风控、持久化与 API
src/App.tsx                     交易监控台
```

本项目仅供学习研究，不构成投资建议。先使用本地模拟和 OKX 模拟盘验证参数、手续费、滑点与连续亏损承受能力，再考虑实盘。
