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
      dbClient = createClient({
        url: dbUrl
      });
      log("info", "[database] 使用本地 SQLite 数据库");
    }
    // Turso 远程数据库
    else if (authToken) {
      dbClient = createClient({
        url: dbUrl,
        authToken: authToken
      });
      log("info", "[database] 使用 Turso 远程数据库");
    } else {
      log("error", "[database] 远程数据库需要 AUTH_TOKEN");
      return null;
    }

    return dbClient;
  } catch (error) {
    log("error", `[database] 初始化数据库客户端失败: ${error.message}`);
    return null;
  }
}

/**
 * 初始化数据库表
 */
export async function initDatabase() {
  const client = getDbClient();
  if (!client) {
    log("warn", "[database] 数据库客户端不可用，跳过初始化");
    return false;
  }

  try {
    log("info", "[database] 开始初始化数据库表...");

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

    log("info", "[database] 数据库表初始化成功");
    globals.databaseValid = true;
    return true;
  } catch (error) {
    log("error", `[database] 初始化数据库表失败: ${error.message}`);
    globals.databaseValid = false;
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
    log("warn", "[database] 数据库不可用，无法保存配置");
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const statements = [];

    for (const [key, value] of Object.entries(configs)) {
      statements.push({
        sql: 'INSERT OR REPLACE INTO env_configs (key, value, updated_at) VALUES (?, ?, ?)',
        args: [key, JSON.stringify(value), timestamp]
      });
    }

    if (statements.length > 0) {
      await client.batch(statements, 'write');
      log("info", `[database] 成功保存 ${statements.length} 个环境变量配置`);
      return true;
    }
    return false;
  } catch (error) {
    log("error", `[database] 保存环境变量配置失败: ${error.message}`);
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
    log("warn", "[database] 数据库不可用，无法加载配置");
    return {};
  }

  try {
    const result = await client.execute('SELECT key, value FROM env_configs');
    const configs = {};

    for (const row of result.rows) {
      try {
        configs[row.key] = JSON.parse(row.value);
      } catch (e) {
        configs[row.key] = row.value;
      }
    }

    if (Object.keys(configs).length > 0) {
      log("info", `[database] 成功加载 ${Object.keys(configs).length} 个环境变量配置`);
    }
    return configs;
  } catch (error) {
    log("error", `[database] 加载环境变量配置失败: ${error.message}`);
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

    log("info", `[database] 成功保存缓存数据: ${key}`);
    return true;
  } catch (error) {
    log("error", `[database] 保存缓存数据失败 (${key}): ${error.message}`);
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
      const value = JSON.parse(result.rows[0].value);
      log("info", `[database] 成功加载缓存数据: ${key}`);
      return value;
    }
    return null;
  } catch (error) {
    log("error", `[database] 加载缓存数据失败 (${key}): ${error.message}`);
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
      log("info", `[database] 成功批量保存 ${statements.length} 个缓存数据`);
      return true;
    }
    return false;
  } catch (error) {
    log("error", `[database] 批量保存缓存数据失败: ${error.message}`);
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
        log("warn", `[database] 解析缓存数据失败: ${row.key}`);
      }
    }

    if (Object.keys(cacheMap).length > 0) {
      log("info", `[database] 成功批量加载 ${Object.keys(cacheMap).length} 个缓存数据`);
    }
    return cacheMap;
  } catch (error) {
    log("error", `[database] 批量加载缓存数据失败: ${error.message}`);
    return {};
  }
}

/**
 * 判断数据库是否可用
 */
export async function checkDatabaseConnection() {
  const client = getDbClient();
  if (!client) {
    return false;
  }

  try {
    await client.execute('SELECT 1');
    globals.databaseValid = true;
    log("info", "[database] 数据库连接正常");
    return true;
  } catch (error) {
    globals.databaseValid = false;
    log("error", `[database] 数据库连接失败: ${error.message}`);
    return false;
  }
}
