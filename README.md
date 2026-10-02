# SuperTrend 翻转交易 · 全市场扫描

按前端 `mode` 扫描 OKX USDT 现货/永续：成交量过滤 → 15 分钟 K 线 SuperTrend → 趋势翻转即平仓并反手（可多可空）。

> 本项目由原「RSI抄底宝」改造而来，RSI 逻辑已移除（改造前代码备份见使用者本机备份目录）。

## 项目简介

策略以 TradingView Pine v4「SuperTrend」为准（`atr = changeATR ? atr(Periods) : sma(tr, Periods)`，`src = hl2`，`up/dn` 带 `close[1]` 判定，`trend` 初值 1，判定用 `up1/dn1`）：

- **买入翻转**（trend 由 -1 → 1）：平空（若有）并开多；
- **卖出翻转**（trend 由 1 → -1）：平多（若有）并开空；
- 只在**已收盘**的 K 线上判定；启动时历史上的翻转不算信号；同一次翻转只处理一次（落盘去重）；
- 默认只做多：做空需要三层开关全部放行（见下），做空被拦时持多遇卖出翻转仍会平多；
- 灾难止损（默认 8%）只是兜底：模拟盘按价格检查，交易所端挂 conditional 算法单；正常出场靠信号翻转；
- 灾难止损 / 强平后该币对本策略冷却 60 分钟；信号平仓、手动平仓、急停不冷却。

三种执行模式：

- **本地模拟**（含滑点与手续费、强平价估算）
- **OKX 模拟盘**
- **OKX 实盘**（真实资金，谨慎）

> 本次改造仅在**本地模拟**下做了端到端验证；OKX 模拟盘 / 实盘路径（含做空、反手、conditional 灾难止损单）已写好但**未经真实交易所验证**。

## 技术栈

- **前端**：React + TypeScript + Vite
- **后端**：Node.js
- **交易所 API**：OKX（现货/永续合约）

## 启动

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

- 前端地址：http://127.0.0.1:5173
- API 地址：http://127.0.0.1:8787

## 使用方法

1. 选择交易模式（现货 `spot` / 永续 `swap`）与配置文件（默认 `demo`）
2. 设置参数：最小成交额、Universe 上限、ATR 周期 / 倍数 / 方法、灾难止损、是否允许做空、金额、最大持仓
3. 点击「开始全市场扫描」

## 默认参数

| 参数 | 默认值 |
|------|--------|
| minVolUsd24h（24小时成交量） | 300,000 USDT |
| universeLimit（扫描币种数量） | 120（最大 200） |
| scanConcurrency（扫描并发数） | 6 |

## 策略参数（`/api/scan/start` 与界面「策略设置」）

| 参数 | 默认 | 说明 |
|------|------|------|
| bar | 15m | K 线周期，只在已收盘 K 线判定 |
| atr_period | 10 | ATR 周期（Pine 的 Periods） |
| atr_multiplier | 3 | ATR 倍数（Pine 的 Multiplier） |
| atr_method | rma | `rma` = Pine `atr()`；`sma` = `sma(tr, Periods)`（Pine 的 changeATR=false） |
| disaster_stop_pct | 8 | 灾难止损 %，0 = 关闭 |
| allow_short | false | 策略层做空开关（还需环境变量放行） |
| flip_only | true | 只在翻转时入场；false 时无仓位按当前趋势入场 |
| disaster_cooldown_minutes | 60 | 灾难止损 / 强平后冷却 |
| signal_max_age_sec | 300 | 翻转超过此时间才处理时只平不开 |
| sim_fee_pct / sim_slippage_pct | 0.05 / 0.031 | 本地模拟单边手续费 / 滑点 |
| warmup_bars | 150 | 启动预热所需 K 线数 |

默认 `mode=swap`。现货模式不支持做空。

## 做空与反手：三层开关（默认全部关闭）

1. 服务端环境变量 `RSI_ALLOW_SHORT=1`（本地模拟 / OKX 模拟盘放行）；**实盘另需** `RSI_ALLOW_SHORT_LIVE=1`；
2. 策略参数 `allow_short=true`（界面「允许做空」）；实盘启动检查弹窗还要再输入「确认做空」（接口字段 `short_confirm_text`）；
3. 执行层 `assertShortAllowed` 断言兜底（即使上层 bug 也不会真的下空单）。

环境变量必须是真实进程环境变量（`.env.local` 里的不算）。

## 旧版 RSI 持仓的处理

升级后首次加载 `positions.json` 时，旧持仓会补上 `strategy_id=rsi_dip`、`direction=long`（并先备份为 `*.bak-pre-v2`）。这些仓位：

- SuperTrend **不会**对其开 / 平 / 反手（界面标「旧策略·只对账」）；
- 仍计入最大持仓数与「同币单仓」占用；
- 继续对账，并维护交易所上的 OCO 保护单，由交易所止盈 / 止损平仓，平仓后照常入账；
- 冷却仍走旧的止损冷却逻辑。

## 信号回放（离线）

```bash
node scripts/replay-signals.mjs --file <K线文件> [--coin BTC-USDT-SWAP] [--period 10] [--mult 3] [--method rma|sma] [--limit 700]
```

只读文件，不联网、不下单、不碰 `server/data`。输出 JSONL（每行一次翻转），汇总写 stderr。

## 执行方式

| 模式 | 说明 |
|------|------|
| 本地模拟（默认） | 纯模拟交易，永不下单 |
| OKX 模拟盘 | 使用模拟盘 Key 交易 |
| OKX 实盘 | 真实资金交易，需确认 |

## API

写接口（`POST` / `PUT` / `PATCH` / `DELETE`）需要本地会话令牌。浏览器界面会自动处理；脚本调用时先请求 `GET /api/session`，再把返回的 `token` 放入 `X-RSI-Session` 请求头。后端只允许本机界面 Origin，令牌在每次重启后自动更新。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/universe` | POST | 获取交易品种列表 |
| `/api/scan/start` | POST | 开始扫描 |
| `/api/scan/stop` | POST | 停止扫描 |
| `/api/scan/status` | GET | 获取扫描状态 |
| `/api/positions` | GET | 获取当前持仓 |
| `/api/signals` | GET | 获取信号列表 |
| `/api/account` | GET | 账户连通性测试 |
| `/api/kill` | POST | 急停（可选择全部平仓） |
| `/api/kill/reset` | POST | 解除急停 |
| `/api/live/check` | POST | 实盘启动前检查 |
| `/api/monitor/start` | POST | 启动监控（仅模拟盘） |

## OKX 模拟盘配置

1. 复制 `server/.env.local.example` 为 `server/.env.local`
2. 填写以下模拟盘 API 密钥：
   - `OKX_DEMO_API_KEY`
   - `OKX_DEMO_SECRET_KEY`
   - `OKX_DEMO_PASSPHRASE`

> ⚠️ 注意：仅使用模拟盘 Key，切勿提交到代码仓库

3. 重启后端服务
4. 在界面选择 `swap` 模式，执行方式选择「OKX 模拟盘」
5. 点击「测试连接」验证配置

### 模拟盘交易流程

1. **开仓**：市价开多（buy）/ 开空（sell）（全仓、net 模式、唯一 clOrdId）
2. **查询成交均价**
3. **灾难止损**：交易所端挂 conditional 算法单（reduceOnly，全仓平仓；若失败则市价平仓）
4. **反手**：先平后开，两笔订单
5. **对账**：每 20 秒与交易所同步持仓/止盈止损/平仓记录
6. **持仓存储**：`server/data/positions.json`

### 风控机制

- 单日亏损上限：默认 50U
- 每小时下单上限：默认 10 单
- 最大点差：默认 0.3%
- 余额检查
- 急停功能：`POST /api/kill`，`{closeAll:true}` 全部平仓
- 急停解除：`POST /api/kill/reset`
- 清空盈亏展示历史不会清除当日风控累计，也不会绕过单日亏损上限
- 下单前会持久化 pending 记录；响应超时或进程重启后按订单号自动核实并接管，核实前不重复下单
- 手动/急停平仓若只成交一部分，会保留或恢复保护单，并按指数退避自动平掉剩余仓位

### 跳过冷却机制

| 跳过原因 | 冷却时间 |
|----------|----------|
| 点差/无报价 | 5 分钟 |
| 下单前复核未通过 | 1 分钟 |
| 余额不足/低于最小张数/模拟盘无此合约 | 10 分钟 |

### 日志

重要日志（warn/error/buy/sell/flip/sl 等）追加写入 `server/data/events.log`（JSON 格式，按行存储，20MB 轮转）

## OKX 实盘配置

> ⚠️ 真实资金交易，请谨慎操作！

1. 在 `server/.env.local` 填写实盘 API 密钥：
   - `OKX_LIVE_API_KEY`
   - `OKX_LIVE_SECRET_KEY`
   - `OKX_LIVE_PASSPHRASE`

2. API 密钥权限要求：
   - 仅开通「读取+交易」权限
   - 不开提现权限
   - 绑定 IP

3. 重启后端
4. 界面选择 `swap` → 执行方式「OKX 实盘（真实资金）」

### 实盘启动检查

首次切换会套用保守默认值（浏览器本地保存各执行方式参数）：
- 每笔保证金：20U
- 杠杆倍数：5x
- 最大持仓：3
- 单日亏损上限：30U
- 每小时下单上限：5

点击「开始实盘扫描」后，后端会进行以下检查：
1. Key 已配置
2. Key 无提现权限
3. 账户模式 ≥ 合约模式
4. 持仓模式为买卖模式（net_mode）
5. 可用 USDT ≥ 每笔保证金

全部通过后，需手动输入「确认实盘」才会开始交易。

### 实盘限制

- 实盘杠杆最高 20x
- `/api/monitor/start` 不能启动实盘
- 实盘持仓与账本单独存放：
  - `server/data/live/positions.json`
  - `server/data/live/pnl-ledger.json`

### 实盘风控

- 每小时下单数与今日已实现盈亏按执行方式分开统计
- 急停全部平仓会按交易所持仓数量平掉本程序开的实盘仓位（外部手动仓位不动）

## 测试 / 演练用环境变量（可选，默认全部不设置 = 行为不变）

- `RSI_DATA_DIR`：把 `server/data` 重定向到其它目录（旧变量 `RSI_BOTTOM_HUNTER_DATA_DIR` 仍然有效，新变量优先）
- `RSI_NO_ENV_LOCAL=1`：不读取 `server/.env.local`
- `RSI_NO_LISTEN=1`：import `server/index.js` 时不监听端口、不启动对账定时器（务必同时设置 `RSI_DATA_DIR`）
- `RSI_ALLOW_SHORT=1` / `RSI_ALLOW_SHORT_LIVE=1`：做空放行开关（见上文，默认均不设置）

策略接口说明见 `server/strategies/README.md`。

## 目录结构

```
├── src/                    # 前端源码
│   ├── App.tsx            # 主应用组件
│   ├── main.tsx           # 入口文件
│   └── styles.css         # 样式文件
├── server/                # 后端服务
│   ├── index.js           # 主服务入口
│   ├── executor.js        # 执行器
│   ├── okxRest.js         # OKX REST API
│   ├── okxWs.js           # OKX WebSocket
│   ├── pnl.js             # 盈亏计算
│   ├── candleStore.js     # K线数据存储
│   ├── strategies/        # 策略接口、注册表、SuperTrend 策略
│   ├── engine/            # SuperTrend 计算、持仓数学（多空）、反手规划、做空开关等纯函数
│   └── env.js             # 环境变量
├── scripts/               # replay-signals.mjs 离线回放等
├── package.json           # 项目配置
└── vite.config.ts         # Vite 配置
```

## 升级 / 回滚注意

- 改动后需**重启 API**（8787）才生效；重启前确认没有正在运行的扫描；`npm run build` 会重写 `dist/`。
- 升级会把 `positions.json` / `pnl-ledger.json` / `cooldowns.json` 迁移为 v2 格式（首次写盘前各备份一份 `*.bak-pre-v2`）。
- 回滚到旧版前，请确认没有空头持仓（`positions.json` 里 `has_short=true` 表示存在）：旧版不识别空头。

## 许可证

本项目仅供学习和研究使用，请遵守交易所相关规则，务必控制风险。
