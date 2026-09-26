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
- live：实盘自动下单未启用，仅模拟/预览

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
- 实盘真实下单在服务端硬禁用（客户端强制 `x-simulated-trading: 1`）。
- 新增 API：`GET /api/account`（连通性测试）、`POST /api/kill`、`POST /api/kill/reset`。
