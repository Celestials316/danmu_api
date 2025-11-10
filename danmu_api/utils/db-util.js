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
    log("info", "[database] 返回已存在的数据库客户端");
    return dbClient;
  }

  try {
    const dbUrl = globals.databaseUrl;
    const authToken = globals.databaseAuthToken;

    log("info", `[database] DATABASE_URL 配置: ${dbUrl ? '已配置' : '未配置'}`);
    log("info", `[database] DATABASE_AUTH_TOKEN 配置: ${authToken ? '已配置' : '未配置'}`);

    if (!dbUrl) {
      log("warn", "[database] 未配置数据库 URL，数据库功能将不可用");
      return null;
    }

    // 本地 SQLite 文件
    if (dbUrl.startsWith('file:')) {
      log("info", "[database] 检测到本地 SQLite 配置，正在初始化...");
      dbClient = createClient({
        url: dbUrl
      });
      log("info", "[database] 本地 SQLite 数据库客户端创建成功");
    }
    // Turso 远程数据库
    else if (authToken) {
      log("info", "[database] 检测到 Turso 远程数据库配置，正在初始化...");
      dbClient = createClient({
        url: dbUrl,
        authToken: authToken
      });
      log("info", "[database] Turso 远程数据库客户端创建成功");
    } else {
      log("error", "[database] 远程数据库需要 DATABASE_AUTH_TOKEN");
      return null;
    }

    return dbClient;
  } catch (error) {
    log("error", `[database] 初始化数据库客户端失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return null;
  }
}

/**
 * 初始化数据库表
 */
export async function initDatabase() {
  log("info", "[database] ========== 开始初始化数据库 ==========");

  const client = getDbClient();
  if (!client) {
    log("warn", "[database] 数据库客户端不可用，跳过初始化");
    globals.databaseValid = false;
    return false;
  }

  try {
    log("info", "[database] 开始创建数据库表...");

    // 创建 env_configs 表（存储环境变量配置）
    log("info", "[database] 正在创建 env_configs 表...");
    await client.execute(`
      CREATE TABLE IF NOT EXISTS env_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    log("info", "[database] env_configs 表创建成功");

    // 创建 cache_data 表（存储缓存数据）
    log("info", "[database] 正在创建 cache_data 表...");
    await client.execute(`
      CREATE TABLE IF NOT EXISTS cache_data (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    log("info", "[database] cache_data 表创建成功");

    log("info", "[database] ✅ 数据库表初始化成功");
    globals.databaseValid = true;
    return true;
  } catch (error) {
    log("error", `[database] ❌ 初始化数据库表失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    globals.databaseValid = false;
    return false;
  }
}

/**
 * 保存环境变量配置到数据库
 * @param {Object} configs 配置对象
 */
export async function saveEnvConfigs(configs) {
  log("info", "[database] ========== 开始保存环境变量配置 ==========");
  log("info", `[database] 准备保存 ${Object.keys(configs).length} 个配置项`);

  const client = getDbClient();
  if (!client) {
    log("warn", "[database] 数据库客户端不可用，无法保存配置");
    return false;
  }

  if (!globals.databaseValid) {
    log("warn", "[database] 数据库状态无效，无法保存配置");
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const statements = [];

    for (const [key, value] of Object.entries(configs)) {
      // 🔥 特殊处理：如果是正则表达式，转换为字符串格式存储
      let saveValue = value;
      if (value instanceof RegExp) {
        saveValue = value.toString();
        log("info", `[database] 正则表达式转换为字符串: ${key} = ${saveValue}`);
      }
      
      const valueStr = JSON.stringify(saveValue);
      log("info", `[database] 准备保存配置: ${key} = ${valueStr.substring(0, 50)}...`);

      statements.push({
        sql: 'INSERT OR REPLACE INTO env_configs (key, value, updated_at) VALUES (?, ?, ?)',
        args: [key, valueStr, timestamp]
      });
    }

    if (statements.length > 0) {
      log("info", `[database] 开始执行批量写入，共 ${statements.length} 条SQL`);
      await client.batch(statements, 'write');
      log("info", `[database] ✅ 成功保存 ${statements.length} 个环境变量配置`);
      return true;
    } else {
      log("warn", "[database] 没有配置需要保存");
      return false;
    }
  } catch (error) {
    log("error", `[database] ❌ 保存环境变量配置失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return false;
  }
}

/**
 * 从数据库加载环境变量配置
 * @returns {Object} 配置对象
 */
export async function loadEnvConfigs() {
  log("info", "[database] ========== 开始加载环境变量配置 ==========");

  const client = getDbClient();
  if (!client) {
    log("warn", "[database] 数据库客户端不可用，无法加载配置");
    return {};
  }

  if (!globals.databaseValid) {
    log("warn", "[database] 数据库状态无效，无法加载配置");
    return {};
  }

  try {
    log("info", "[database] 开始查询 env_configs 表");
    const result = await client.execute('SELECT key, value FROM env_configs');
    log("info", `[database] 查询返回 ${result.rows.length} 行数据`);

    const configs = {};

    for (const row of result.rows) {
      try {
        const key = row.key;
        const valueStr = row.value;
        log("info", `[database] 解析配置: ${key}`);
        
        let parsedValue = JSON.parse(valueStr);
        
        // 🔥 特殊处理：如果是 EPISODE_TITLE_FILTER，检查是否需要重建为正则表达式
        if (key === 'EPISODE_TITLE_FILTER' && typeof parsedValue === 'string' && parsedValue.length > 0) {
          try {
            // 检查是否是正则表达式字符串格式 (例如: "/pattern/flags")
            const regexMatch = parsedValue.match(/^\/(.+)\/([gimuy]*)$/);
            if (regexMatch) {
              // 从 /pattern/flags 格式重建正则表达式
              parsedValue = new RegExp(regexMatch[1], regexMatch[2]);
              log("info", `[database] ✅ 重建正则表达式: ${key} = ${parsedValue}`);
            } else {
              // 纯文本模式，当作正则表达式模式处理
              parsedValue = new RegExp(parsedValue);
              log("info", `[database] ✅ 从文本创建正则表达式: ${key} = ${parsedValue}`);
            }
          } catch (e) {
            log("warn", `[database] ⚠️ 无法解析正则表达式 ${key}: ${e.message}，保持原字符串值`);
          }
        }
        
        configs[key] = parsedValue;
      } catch (e) {
        log("warn", `[database] 配置 ${row.key} 解析失败，使用原始字符串: ${e.message}`);
        configs[row.key] = row.value;
      }
    }

    if (Object.keys(configs).length > 0) {
      log("info", `[database] ✅ 成功加载 ${Object.keys(configs).length} 个环境变量配置`);
      log("info", `[database] 配置键: ${Object.keys(configs).join(', ')}`);
    } else {
      log("info", "[database] 数据库中暂无配置数据");
    }
    return configs;
  } catch (error) {
    log("error", `[database] ❌ 加载环境变量配置失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
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

    log("info", `[database] 保存缓存数据: ${key}`);
    await client.execute({
      sql: 'INSERT OR REPLACE INTO cache_data (key, value, updated_at) VALUES (?, ?, ?)',
      args: [key, serializedValue, timestamp]
    });

    log("info", `[database] ✅ 成功保存缓存数据: ${key}`);
    return true;
  } catch (error) {
    log("error", `[database] ❌ 保存缓存数据失败 (${key}): ${error.message}`);
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
    log("info", `[database] 加载缓存数据: ${key}`);
    const result = await client.execute({
      sql: 'SELECT value FROM cache_data WHERE key = ?',
      args: [key]
    });

    if (result.rows.length > 0) {
      const value = JSON.parse(result.rows[0].value);
      log("info", `[database] ✅ 成功加载缓存数据: ${key}`);
      return value;
    }
    log("info", `[database] 缓存数据不存在: ${key}`);
    return null;
  } catch (error) {
    log("error", `[database] ❌ 加载缓存数据失败 (${key}): ${error.message}`);
    return null;
  }
}

/**
 * 批量保存缓存数据
 * @param {Object} cacheMap 缓存映射对象
 */
export async function saveCacheBatch(cacheMap) {
  log("info", "[database] ========== 开始批量保存缓存 ==========");
  log("info", `[database] 准备保存 ${Object.keys(cacheMap).length} 个缓存项`);

  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    log("warn", "[database] 数据库不可用，无法批量保存缓存");
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
      log("info", `[database] ✅ 成功批量保存 ${statements.length} 个缓存数据`);
      return true;
    }
    return false;
  } catch (error) {
    log("error", `[database] ❌ 批量保存缓存数据失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return false;
  }
}

/**
 * 批量加载缓存数据
 * @returns {Object} 缓存数据映射
 */
export async function loadCacheBatch() {
  log("info", "[database] ========== 开始批量加载缓存 ==========");

  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    log("warn", "[database] 数据库不可用，无法批量加载缓存");
    return {};
  }

  try {
    const result = await client.execute('SELECT key, value FROM cache_data');
    log("info", `[database] 查询返回 ${result.rows.length} 条缓存数据`);

    const cacheMap = {};

    for (const row of result.rows) {
      try {
        cacheMap[row.key] = JSON.parse(row.value);
      } catch (e) {
        log("warn", `[database] 解析缓存数据失败: ${row.key}`);
      }
    }

    if (Object.keys(cacheMap).length > 0) {
      log("info", `[database] ✅ 成功批量加载 ${Object.keys(cacheMap).length} 个缓存数据`);
    }
    return cacheMap;
  } catch (error) {
    log("error", `[database] ❌ 批量加载缓存数据失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return {};
  }
}

/**
 * 判断数据库是否可用
 */
export async function checkDatabaseConnection() {
  log("info", "[database] ========== 检查数据库连接 ==========");

  const client = getDbClient();
  if (!client) {
    log("warn", "[database] 数据库客户端未初始化");
    globals.databaseValid = false;
    return false;
  }

  try {
    log("info", "[database] 执行测试查询...");
    await client.execute('SELECT 1');
    globals.databaseValid = true;
    log("info", "[database] ✅ 数据库连接正常");
    return true;
  } catch (error) {
    globals.databaseValid = false;
    log("error", `[database] ❌ 数据库连接失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return false;
  }
}
