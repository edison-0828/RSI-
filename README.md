# RSI抄底宝 · 全市场扫描

按前端 `mode` 扫描 OKX USDT 现货/永续：成交量过滤 → 批量 RSI → demo 模拟买卖。

## 项目简介

RSI抄底宝是一款基于 RSI（相对强弱指标）的量化交易系统，支持全市场扫描并自动识别超卖信号进行抄底交易。系统支持三种执行模式：

- **本地模拟**：完全模拟交易，永不下单
- **OKX 模拟盘**：使用 OKX 模拟盘账户进行交易
- **OKX 实盘**：使用真实资金进行交易（需谨慎）

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
2. 设置参数：最小成交额、Universe 上限、RSI 阈值、金额、最大持仓
3. 点击「开始全市场扫描」

## 默认参数

| 参数 | 默认值 |
|------|--------|
| minVolUsd24h（24小时成交量） | 1,000,000 USDT |
| universeLimit（扫描币种数量） | 40（UI 可调 10–100） |
| scanConcurrency（扫描并发数） | 4 |

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

1. **开仓**：市价买入（全仓、唯一 clOrdId）
2. **查询成交均价**
3. **止盈止损**：在交易所端设置 OCO 订单（若失败则市价平仓）
4. **对账**：每 20 秒与交易所同步持仓/止盈止损/平仓记录
5. **持仓存储**：`server/data/positions.json`

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

重要日志（warn/error/buy/sell/tp/sl）追加写入 `server/data/events.log`（JSON 格式，按行存储，20MB 轮转）

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
- `RSI_ENGINE_SHADOW=1`：影子运行，仅比对“旧判断 vs 策略 evaluate”，不一致写 `[回归]` 警告日志，不影响下单

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
│   ├── strategies/        # 策略接口、注册表、RSI 抄底策略
│   ├── engine/            # 持仓数学、信号适配等引擎纯函数
│   └── env.js             # 环境变量
├── package.json           # 项目配置
└── vite.config.ts         # Vite 配置
```

## 许可证

本项目仅供学习和研究使用，请遵守交易所相关规则，务必控制风险。
