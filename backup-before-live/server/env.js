/**
 * 极简 .env 加载器（无第三方依赖）
 * - 仅读取 server/.env.local（已加入 .gitignore）
 * - 不覆盖已存在的系统环境变量
 * - 绝不打印任何变量的值
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ENV_LOCAL_PATH = join(__dirname, '.env.local');

/**
 * @param {string} [file]
 * @returns {{ loaded: boolean, count: number, keys: string[], error?: string }}
 */
export function loadEnvLocal(file = ENV_LOCAL_PATH) {
  if (!existsSync(file)) return { loaded: false, count: 0, keys: [] };
  try {
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
    const keys = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        // 去掉行内注释（值中不含引号时）
        const hash = val.search(/\s#/);
        if (hash >= 0) val = val.slice(0, hash).trim();
      }
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = val;
      }
      keys.push(key);
    }
    return { loaded: true, count: keys.length, keys };
  } catch (e) {
    return { loaded: false, count: 0, keys: [], error: e.message };
  }
}
