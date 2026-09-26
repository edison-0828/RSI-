# RSI抄底宝 · 全市场扫描

按前端 `mode` 扫描 OKX USDT 现货/永续：成交量过滤 → 批量 RSI → demo 模拟买卖。

## 启动
```bash
npm install
npm run dev
```
- 前端 http://127.0.0.1:5173
- API http://127.0.0.1:8787

## 用法
1. 选 mode（spot / swap）与 profile（默认 demo）
2. 设最小成交额、Universe 上限、RSI 阈值、金额、最大持仓
3. 点「开始全市场扫描」

## 默认参数
- minVolUsd24h = 1_000_000
- universeLimit = 40（UI 可调 10–100）
- scanConcurrency = 4
- 执行方式：本地模拟（默认，永不下单）/ OKX 模拟盘 / OKX 实盘（真实资金，需确认）

## API
- POST /api/universe
- POST /api/scan/start|stop ，GET /api/scan/status
- GET /api/positions ，GET /api/signals

## OKX 模拟盘执行（USDT 永续）
1. 复制 `server/.env.local.example` 为 `server/.env.local`，填写 `OKX_DEMO_API_KEY` / `OKX_DEMO_SECRET_KEY` / `OKX_DEMO_PASSPHRASE`（模拟盘 Key，勿提交）。
2. 重启后端；界面选 `swap` → 执行方式「OKX 模拟盘」，点「测试连接」。
3. 开仓：市价买入（全仓、唯一 clOrdId）→ 查询成交均价 → 交易所端 OCO 止盈止损（失败即市价平仓）。
4. 每 20 秒与交易所对账（仓位/止盈止损/平仓记录），持仓保存在 `server/data/positions.json`。
5. 风控：单日亏损上限（默认 50U）、每小时下单上限（默认 10）、最大点差（默认 0.3%）、余额检查、急停（`POST /api/kill`，`{closeAll:true}` 全部平仓；`POST /api/kill/reset` 解除）。
- 模拟盘请求强制携带 `x-simulated-trading: 1`；模拟盘模式下 universe 只扫描模拟盘存在的合约（合约列表缓存 30 分钟定期刷新）。
- 跳过冷却：某币因点差/无报价跳过冷却 5 分钟，下单前复核未通过 1 分钟，其他原因（余额不足、低于最小张数、模拟盘无此合约等）10 分钟；信号列显示「已跳过」及原因。
- 重要日志（warn/error/buy/sell/tp/sl）追加写入 `server/data/events.log`（按行 JSON，20MB 轮转）。
- 新增 API：`GET /api/account`（连通性测试）、`POST /api/kill`、`POST /api/kill/reset`。

## OKX 实盘执行（USDT 永续 · 真实资金）
1. 在 `server/.env.local` 填写 `OKX_LIVE_API_KEY` / `OKX_LIVE_SECRET_KEY` / `OKX_LIVE_PASSPHRASE`（只开「读取+交易」，不开提现，绑定 IP），重启后端。
2. 界面选 `swap` → 执行方式「OKX 实盘（真实资金）」；首次切换会套用保守默认值（每笔保证金 20U、5x、最大持仓 3、日亏上限 30U、每小时 5 单），各执行方式的参数分开保存（浏览器本地）。
3. 点「开始实盘扫描」→ 后端只读检查：Key 已配置、Key 无提现权限、账户模式 ≥ 合约模式、持仓模式为买卖模式（net_mode）、可用 USDT ≥ 每笔保证金；全部通过后在确认框手动输入「确认实盘」才会开始。
4. 后端强制：`POST /api/scan/start` 在 `exec_mode=okx_live` 时必须带 `confirm_text: "确认实盘"`，否则 400；实盘杠杆最高 20x；`/api/monitor/start` 不能启动实盘。
5. 实盘持仓与账本单独存放：`server/data/live/positions.json`、`server/data/live/pnl-ledger.json`；每小时下单数与今日已实现盈亏按执行方式分开统计。
6. 流程与模拟盘相同：点差/余额检查 → 张数计算 → 市价单等待完全成交 → closeFraction=1 全仓 OCO → 每 20 秒对账/重挂 → 失败保护性平仓；急停并全部平仓会按交易所持仓数量平掉本程序开的实盘仓位（外部手动仓位不动）。
- 新增 API：`POST /api/live/check`（只读启动检查）、`GET /api/account?mode=okx_live`。
