import { createClient } from '@libsql/client';
import { globals } from '../configs/globals.js';
import { log } from './log-util.js';

let dbClient = null;

/**
 * 获取数据库客户端
 * @returns {Object} 数据库客户端
 */
function getDbClient() {
  if (dbClient) {
    return dbClient;
  }

  try {
    const dbUrl = globals.databaseUrl;
    const authToken = globals.databaseAuthToken;

    if (!dbUrl) {
      log("warn", "[database] 未配置数据库 URL，数据库功能将不可用");
      return null;
    }

    // 本地 SQLite 文件
    if (dbUrl.startsWith('file:')) {
      dbClient = createClient({ url: dbUrl });
      log("info", "[database] ✅ 本地 SQLite 客户端已创建");
    }
    // Turso 远程数据库
    else if (authToken) {
      dbClient = createClient({ url: dbUrl, authToken: authToken });
      log("info", "[database] ✅ Turso 远程客户端已创建");
    } else {
      log("error", "[database] ❌ 远程数据库需要 DATABASE_AUTH_TOKEN");
      return null;
    }

    return dbClient;
  } catch (error) {
    log("error", `[database] ❌ 初始化客户端失败: ${error.message}`);
    return null;
  }
}

/**
 * 初始化数据库表
 */
export async function initDatabase() {
  const client = getDbClient();
  if (!client) {
    globals.databaseValid = false;
    return false;
  }

  try {
    // 创建 env_configs 表（存储环境变量配置）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS env_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // 创建 cache_data 表（存储缓存数据）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS cache_data (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    globals.databaseValid = true;
    log("info", "[database] ✅ 数据库表初始化完成");
    return true;
  } catch (error) {
    globals.databaseValid = false;
    log("error", `[database] ❌ 初始化表失败: ${error.message}`);
    return false;
  }
}

/**
 * 保存环境变量配置到数据库
 * @param {Object} configs 配置对象
 */
export async function saveEnvConfigs(configs) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const statements = [];

    for (const [key, value] of Object.entries(configs)) {
      // 特殊处理：如果是正则表达式，转换为字符串格式存储
      let saveValue = value;
      if (value instanceof RegExp) {
        saveValue = value.toString();
      }

      const valueStr = JSON.stringify(saveValue);
      statements.push({
        sql: 'INSERT OR REPLACE INTO env_configs (key, value, updated_at) VALUES (?, ?, ?)',
        args: [key, valueStr, timestamp]
      });
    }

    if (statements.length > 0) {
      await client.batch(statements, 'write');
      log("info", `[database] ✅ 保存配置完成 (${statements.length} 项)`);
      return true;
    }
    return false;
  } catch (error) {
    log("error", `[database] ❌ 保存配置失败: ${error.message}`);
    return false;
  }
}

/**
 * 从数据库加载环境变量配置
 * @returns {Object} 配置对象
 */
export async function loadEnvConfigs() {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return {};
  }

  try {
    const result = await client.execute('SELECT key, value FROM env_configs');
    const configs = {};

    for (const row of result.rows) {
      try {
        const key = row.key;
        const valueStr = row.value;
        let parsedValue = JSON.parse(valueStr);

        // 特殊处理：如果是 EPISODE_TITLE_FILTER，检查是否需要重建为正则表达式
        if (key === 'EPISODE_TITLE_FILTER' && typeof parsedValue === 'string' && parsedValue.length > 0) {
          try {
            const regexMatch = parsedValue.match(/^\/(.+)\/([gimuy]*)$/);
            if (regexMatch) {
              parsedValue = new RegExp(regexMatch[1], regexMatch[2]);
            } else {
              parsedValue = new RegExp(parsedValue);
            }
          } catch (e) {
            log("warn", `[database] ⚠️ 正则解析失败 ${key}: ${e.message}`);
          }
        }

        configs[key] = parsedValue;
      } catch (e) {
        log("warn", `[database] 解析配置失败: ${row.key}`);
        configs[row.key] = row.value;
      }
    }

    if (Object.keys(configs).length > 0) {
      log("info", `[database] ✅ 加载配置完成 (${Object.keys(configs).length} 项)`);
    }
    return configs;
  } catch (error) {
    log("error", `[database] ❌ 加载配置失败: ${error.message}`);
    return {};
  }
}

/**
 * 保存缓存数据到数据库
 * @param {string} key 缓存键
 * @param {any} value 缓存值
 */
export async function saveCacheData(key, value) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const serializedValue = JSON.stringify(value);

    await client.execute({
      sql: 'INSERT OR REPLACE INTO cache_data (key, value, updated_at) VALUES (?, ?, ?)',
      args: [key, serializedValue, timestamp]
    });

    return true;
  } catch (error) {
    log("error", `[database] ❌ 保存缓存失败 (${key}): ${error.message}`);
    return false;
  }
}

/**
 * 从数据库加载缓存数据
 * @param {string} key 缓存键
 * @returns {any} 缓存值
 */
export async function loadCacheData(key) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return null;
  }

  try {
    const result = await client.execute({
      sql: 'SELECT value FROM cache_data WHERE key = ?',
      args: [key]
    });

    if (result.rows.length > 0) {
      return JSON.parse(result.rows[0].value);
    }
    return null;
  } catch (error) {
    log("error", `[database] ❌ 加载缓存失败 (${key}): ${error.message}`);
    return null;
  }
}

/**
 * 批量保存缓存数据
 * @param {Object} cacheMap 缓存映射对象
 */
export async function saveCacheBatch(cacheMap) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const statements = [];

    for (const [key, value] of Object.entries(cacheMap)) {
      const serializedValue = JSON.stringify(value);
      statements.push({
        sql: 'INSERT OR REPLACE INTO cache_data (key, value, updated_at) VALUES (?, ?, ?)',
        args: [key, serializedValue, timestamp]
      });
    }

    if (statements.length > 0) {
      await client.batch(statements, 'write');
      log("info", `[database] ✅ 批量保存缓存完成 (${statements.length} 项)`);
      return true;
    }
    return false;
  } catch (error) {
    log("error", `[database] ❌ 批量保存缓存失败: ${error.message}`);
    return false;
  }
}

/**
 * 批量加载缓存数据
 * @returns {Object} 缓存数据映射
 */
export async function loadCacheBatch() {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return {};
  }

  try {
    const result = await client.execute('SELECT key, value FROM cache_data');
    const cacheMap = {};

    for (const row of result.rows) {
      try {
        cacheMap[row.key] = JSON.parse(row.value);
      } catch (e) {
        log("warn", `[database] 解析缓存失败: ${row.key}`);
      }
    }

    if (Object.keys(cacheMap).length > 0) {
      log("info", `[database] ✅ 批量加载缓存完成 (${Object.keys(cacheMap).length} 项)`);
    }
    return cacheMap;
  } catch (error) {
    log("error", `[database] ❌ 批量加载缓存失败: ${error.message}`);
    return {};
  }
}

/**
 * 判断数据库是否可用
 */
export async function checkDatabaseConnection() {
  const client = getDbClient();
  if (!client) {
    globals.databaseValid = false;
    return false;
  }

  try {
    await client.execute('SELECT 1');
    globals.databaseValid = true;
    log("info", "[database] ✅ 数据库连接正常");
    return true;
  } catch (error) {
    globals.databaseValid = false;
    log("error", `[database] ❌ 数据库连接失败: ${error.message}`);
    return false;
  }
}
