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
      const valueStr = JSON.stringify(value);
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
        configs[key] = JSON.parse(valueStr);
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

/**
 * 初始化用户表
 */
export async function initUserTable() {
  log("info", "[database] 开始创建用户表...");

  const client = getDbClient();
  if (!client) {
    log("warn", "[database] 数据库客户端不可用，跳过用户表创建");
    return false;
  }

  try {
    // 创建用户表
    await client.execute(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // 🔥 修复：创建 session 表，使用 INTEGER 存储 Unix 时间戳
    await client.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    // 创建索引优化查询
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_session_expires ON sessions(expires_at)
    `);

    log("info", "[database] ✅ 用户表和 Session 表创建成功");
    return true;
  } catch (error) {
    log("error", `[database] ❌ 创建用户表失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return false;
  }
}

/**
 * 检查是否存在管理员用户
 */
export async function hasAdminUser() {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    const result = await client.execute({
      sql: 'SELECT COUNT(*) as count FROM users WHERE username = ?',
      args: ['admin']
    });

    const hasAdmin = result.rows[0].count > 0;
    log("info", `[database] 管理员用户存在: ${hasAdmin}`);
    return hasAdmin;
  } catch (error) {
    log("error", `[database] 检查管理员用户失败: ${error.message}`);
    return false;
  }
}

/**
 * 创建管理员用户
 */
export async function createAdminUser(password) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    const { hashPassword } = await import('./auth-util.js');
    const hashedPassword = hashPassword(password);
    const timestamp = new Date().toISOString();

    await client.execute({
      sql: 'INSERT INTO users (username, password, created_at, updated_at) VALUES (?, ?, ?, ?)',
      args: ['admin', hashedPassword, timestamp, timestamp]
    });

    log("info", "[database] ✅ 管理员用户创建成功");
    return true;
  } catch (error) {
    log("error", `[database] ❌ 创建管理员用户失败: ${error.message}`);
    return false;
  }
}

/**
 * 验证用户登录
 */
export async function verifyUser(username, password) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    log("warn", "[database] 数据库不可用，无法验证用户");
    return false;
  }

  try {
    log("info", `[database] 🔐 验证用户: ${username}`);
    
    const result = await client.execute({
      sql: 'SELECT password FROM users WHERE username = ?',
      args: [username]
    });

    if (result.rows.length === 0) {
      log("warn", `[database] ⚠️ 用户不存在: ${username}`);
      return false;
    }

    const { verifyPassword } = await import('./auth-util.js');
    const isValid = verifyPassword(password, result.rows[0].password);
    
    if (isValid) {
      log("info", `[database] ✅ 用户验证成功: ${username}`);
    } else {
      log("warn", `[database] ❌ 密码验证失败: ${username}`);
    }
    
    return isValid;
  } catch (error) {
    log("error", `[database] 验证用户失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return false;
  }
}

/**
 * 修改密码
 */
export async function changePassword(username, newPassword) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    const { hashPassword } = await import('./auth-util.js');
    const hashedPassword = hashPassword(newPassword);
    const timestamp = new Date().toISOString();

    await client.execute({
      sql: 'UPDATE users SET password = ?, updated_at = ? WHERE username = ?',
      args: [hashedPassword, timestamp, username]
    });

    log("info", `[database] ✅ 用户 ${username} 密码修改成功`);
    return true;
  } catch (error) {
    log("error", `[database] ❌ 修改密码失败: ${error.message}`);
    return false;
  }
}

/**
 * 🔥 修复：创建 Session（使用 Unix 时间戳）
 */
export async function createSession(username, sessionId, expiresInHours = 24) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    log("error", "[database] 创建 Session 失败: 数据库不可用");
    return false;
  }

  try {
    // 使用 Unix 时间戳（秒）
    const createdAtUnix = Math.floor(Date.now() / 1000);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);

    log("info", `[database] 📝 创建 Session: ${sessionId.substring(0, 8)}...`);
    log("info", `[database]   用户: ${username}`);
    log("info", `[database]   创建时间: ${new Date(createdAtUnix * 1000).toISOString()}`);
    log("info", `[database]   过期时间: ${new Date(expiresAtUnix * 1000).toISOString()}`);
    log("info", `[database]   Unix 时间戳: created=${createdAtUnix}, expires=${expiresAtUnix}`);

    const result = await client.execute({
      sql: 'INSERT OR REPLACE INTO sessions (session_id, username, created_at, expires_at) VALUES (?, ?, ?, ?)',
      args: [sessionId, username, createdAtUnix, expiresAtUnix]
    });

    log("info", `[database] ✅ Session 插入成功，影响行数: ${result.rowsAffected || 1}`);

    // 立即查询验证
    const verify = await client.execute({
      sql: 'SELECT session_id, username, created_at, expires_at FROM sessions WHERE session_id = ?',
      args: [sessionId]
    });

    if (verify.rows.length === 0) {
      log("error", "[database] ❌ Session 写入后立即查询失败！");
      return false;
    }

    const verifyData = verify.rows[0];
    log("info", `[database] ✅ Session 写入验证成功:`);
    log("info", `[database]   - session_id: ${verifyData.session_id.substring(0, 8)}...`);
    log("info", `[database]   - username: ${verifyData.username}`);
    log("info", `[database]   - created_at: ${verifyData.created_at} (${new Date(verifyData.created_at * 1000).toISOString()})`);
    log("info", `[database]   - expires_at: ${verifyData.expires_at} (${new Date(verifyData.expires_at * 1000).toISOString()})`);

    return true;
  } catch (error) {
    log("error", `[database] ❌ 创建 Session 失败: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return false;
  }
}

/**
 * 🔥 修复：验证 Session（使用 Unix 时间戳）
 */
export async function verifySession(sessionId) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    log("error", "[database] Session 验证失败: 数据库不可用");
    return null;
  }

  try {
    log("info", `[database] 🔍 验证 Session: ${sessionId.substring(0, 8)}...`);

    const result = await client.execute({
      sql: 'SELECT username, expires_at, created_at FROM sessions WHERE session_id = ?',
      args: [sessionId]
    });

    log("info", `[database] 📊 查询结果: ${result.rows.length} 行`);

    if (result.rows.length === 0) {
      log("warn", `[database] ⚠️ Session 不存在: ${sessionId.substring(0, 8)}...`);

      // 查询所有 Session 用于调试
      const allSessions = await client.execute({
        sql: 'SELECT session_id, username, created_at, expires_at FROM sessions ORDER BY expires_at DESC LIMIT 10'
      });

      log("info", `[database] 📋 当前数据库中的 Session (${allSessions.rows.length} 条):`);
      allSessions.rows.forEach(row => {
        const createdDate = new Date(row.created_at * 1000);
        const expiresDate = new Date(row.expires_at * 1000);
        log("info", `  - ${row.session_id.substring(0, 8)}... | ${row.username} | 创建:${createdDate.toISOString()} | 过期:${expiresDate.toISOString()}`);
      });

      return null;
    }

    const session = result.rows[0];
    const expiresAtUnix = session.expires_at;
    const createdAtUnix = session.created_at;
    const nowUnix = Math.floor(Date.now() / 1000);

    // 转换为日期对象用于日志显示
    const expiresAt = new Date(expiresAtUnix * 1000);
    const createdAt = new Date(createdAtUnix * 1000);
    const now = new Date(nowUnix * 1000);

    log("info", `[database] ⏰ Session 信息:`);
    log("info", `[database]   - 用户: ${session.username}`);
    log("info", `[database]   - 创建时间: ${createdAt.toISOString()} (Unix: ${createdAtUnix})`);
    log("info", `[database]   - 过期时间: ${expiresAt.toISOString()} (Unix: ${expiresAtUnix})`);
    log("info", `[database]   - 当前时间: ${now.toISOString()} (Unix: ${nowUnix})`);
    log("info", `[database]   - 剩余时间: ${Math.round((expiresAtUnix - nowUnix) / 60)} 分钟`);

    if (expiresAtUnix < nowUnix) {
      log("warn", `[database] ⏳ Session 已过期，删除: ${sessionId.substring(0, 8)}...`);
      await client.execute({
        sql: 'DELETE FROM sessions WHERE session_id = ?',
        args: [sessionId]
      });
      return null;
    }

    log("info", `[database] ✅ Session 验证成功: 用户=${session.username}`);
    return session.username;

  } catch (error) {
    log("error", `[database] ❌ 验证 Session 异常: ${error.message}`);
    log("error", `[database] 错误堆栈: ${error.stack}`);
    return null;
  }
}

/**
 * 删除 Session
 */
export async function deleteSession(sessionId) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    log("info", `[database] 🗑️ 删除 Session: ${sessionId.substring(0, 8)}...`);

    const result = await client.execute({
      sql: 'DELETE FROM sessions WHERE session_id = ?',
      args: [sessionId]
    });

    if (result.rowsAffected > 0) {
      log("info", `[database] ✅ Session 删除成功`);
      return true;
    } else {
      log("warn", `[database] ⚠️ Session 不存在，无需删除`);
      return false;
    }
  } catch (error) {
    log("error", `[database] ❌ 删除 Session 失败: ${error.message}`);
    return false;
  }
}

/**
 * 清理过期 Session
 */
export async function cleanupExpiredSessions() {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    
    const result = await client.execute({
      sql: 'DELETE FROM sessions WHERE expires_at < ?',
      args: [nowUnix]
    });

    if (result.rowsAffected > 0) {
      log("info", `[database] 🧹 清理过期 Session: ${result.rowsAffected} 条`);
    }

    return true;
  } catch (error) {
    log("error", `[database] ❌ 清理过期 Session 失败: ${error.message}`);
    return false;
  }
}
