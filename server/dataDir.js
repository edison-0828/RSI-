/**
 * 数据目录解析（阶段 0：路径隔离）
 * 优先级：RSI_DATA_DIR（新，统一入口） > RSI_BOTTOM_HUNTER_DATA_DIR（旧，继续生效） > 默认 server/data
 * 注意：必须是真正的进程环境变量；写在 server/.env.local 里无效（pnl.js 先于 .env.local 加载）。
 */
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 默认数据目录（未设置任何环境变量时） */
export const DEFAULT_DATA_DIR = join(__dirname, 'data');

/** 是否通过环境变量重定向了数据目录 */
export function dataDirOverridden(env = process.env) {
  return !!(env.RSI_DATA_DIR || env.RSI_BOTTOM_HUNTER_DATA_DIR);
}

/** @returns {string} 绝对路径 */
export function resolveDataDir(env = process.env) {
  if (env.RSI_DATA_DIR) return resolve(env.RSI_DATA_DIR);
  if (env.RSI_BOTTOM_HUNTER_DATA_DIR) return resolve(env.RSI_BOTTOM_HUNTER_DATA_DIR);
  return DEFAULT_DATA_DIR;
}

export default { DEFAULT_DATA_DIR, dataDirOverridden, resolveDataDir };
