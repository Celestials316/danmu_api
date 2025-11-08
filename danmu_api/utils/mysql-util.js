/**
 * MySQL 数据库工具模块
 * 用于管理环境变量配置的持久化存储
 * 
 * 使用方法：
 * 1. 在 .env 文件中配置 MySQL 连接信息
 * 2. 容器启动时自动初始化数据表
 * 3. 通过 Web 页面编辑配置并保存到数据库
 */

import mysql from 'mysql2/promise';

let pool = null;

// 简单日志函数（避免循环依赖）
function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
}

// 定义敏感字段列表
const SENSITIVE_KEYS = [
  'TOKEN',
  'BILIBILI_COOKIE',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'TMDB_API_KEY',
  'PROXY_URL',
  'MYSQL_PASSWORD'
];

/**
 * 初始化 MySQL 连接池
 * @param {Object} config 数据库配置
 * @returns {Promise<mysql.Pool>}
 */
export async function initMySQLPool(config) {
  if (pool) {
    return pool;
  }

  try {
    pool = mysql.createPool({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT || 3306,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASSWORD,
      database: config.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });

    // 测试连接
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();

    log('info', '[MySQL] Connection pool initialized successfully');

    // 初始化数据表
    await initConfigTable();

    return pool;
  } catch (error) {
    log('error', `[MySQL] Failed to initialize connection pool: ${error.message}`);
    pool = null;
    throw error;
  }
}

/**
 * 创建配置表（如果不存在）
 */
async function initConfigTable() {
  if (!pool) {
    throw new Error('MySQL pool not initialized');
  }

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS env_config (
      \`key\` VARCHAR(100) PRIMARY KEY,
      \`value\` TEXT NOT NULL,
      \`description\` TEXT,
      \`is_sensitive\` TINYINT(1) DEFAULT 0,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await pool.execute(createTableSQL);
    log('info', '[MySQL] Config table initialized');
  } catch (error) {
    log('error', `[MySQL] Failed to create config table: ${error.message}`);
    throw error;
  }
}

/**
 * 获取所有配置
 * @returns {Promise<Object>} 配置对象
 */
export async function getAllConfigs() {
  if (!pool) {
    log('warn', '[MySQL] Pool not initialized, skipping config load');
    return {};
  }

  try {
    const [rows] = await pool.execute(
      'SELECT `key`, `value`, `is_sensitive` FROM env_config'
    );

    const configs = {};
    for (const row of rows) {
      configs[row.key] = row.value;
    }

    log('info', `[MySQL] Loaded ${rows.length} configs from database`);
    return configs;
  } catch (error) {
    log('error', `[MySQL] Failed to load configs: ${error.message}`);
    return {};
  }
}

/**
 * 获取单个配置
 * @param {string} key 配置键
 * @returns {Promise<string|null>}
 */
export async function getConfig(key) {
  if (!pool) {
    return null;
  }

  try {
    const [rows] = await pool.execute(
      'SELECT `value` FROM env_config WHERE `key` = ?',
      [key]
    );

    return rows.length > 0 ? rows[0].value : null;
  } catch (error) {
    log('error', `[MySQL] Failed to get config ${key}: ${error.message}`);
    return null;
  }
}

/**
 * 保存配置（批量更新）
 * @param {Object} configs 配置对象
 * @param {Object} descriptions 配置描述对象
 * @param {Array<string>} sensitiveKeys 敏感字段列表
 * @returns {Promise<boolean>}
 */
export async function saveConfigs(configs, descriptions = {}, sensitiveKeys = []) {
  if (!pool) {
    throw new Error('MySQL pool not initialized');
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const [key, value] of Object.entries(configs)) {
      const description = descriptions[key] || '';
      const isSensitive = sensitiveKeys.includes(key) ? 1 : 0;

      await connection.execute(
        `INSERT INTO env_config (\`key\`, \`value\`, \`description\`, \`is_sensitive\`)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           \`value\` = VALUES(\`value\`),
           \`description\` = VALUES(\`description\`),
           \`is_sensitive\` = VALUES(\`is_sensitive\`)`,
        [key, String(value), description, isSensitive]
      );
    }

    await connection.commit();
    log('info', `[MySQL] Saved ${Object.keys(configs).length} configs to database`);
    return true;
  } catch (error) {
    await connection.rollback();
    log('error', `[MySQL] Failed to save configs: ${error.message}`);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * 删除配置
 * @param {string} key 配置键
 * @returns {Promise<boolean>}
 */
export async function deleteConfig(key) {
  if (!pool) {
    throw new Error('MySQL pool not initialized');
  }

  try {
    const [result] = await pool.execute(
      'DELETE FROM env_config WHERE `key` = ?',
      [key]
    );

    log('info', `[MySQL] Deleted config: ${key}`);
    return result.affectedRows > 0;
  } catch (error) {
    log('error', `[MySQL] Failed to delete config ${key}: ${error.message}`);
    throw error;
  }
}

/**
 * 检查 MySQL 连接状态
 * @returns {Promise<boolean>}
 */
export async function checkMySQLConnection() {
  if (!pool) {
    return false;
  }

  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    return true;
  } catch (error) {
    log('error', `[MySQL] Connection check failed: ${error.message}`);
    return false;
  }
}

/**
 * 关闭连接池
 */
export async function closeMySQLPool() {
  if (pool) {
    await pool.end();
    pool = null;
    log('info', '[MySQL] Connection pool closed');
  }
}