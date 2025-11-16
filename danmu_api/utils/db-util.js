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
  // ========== 定义默认值 ==========
  const DEFAULT_VALUES = {
    'TOKEN': '87654321',
    'OTHER_SERVER': 'https://api.danmu.icu',
    'VOD_SERVERS': '金蝉@https://zy.jinchancaiji.com,789@https://www.caiji.cyou,听风@https://gctf.tfdh.top',
    'VOD_RETURN_MODE': 'fastest',
    'VOD_REQUEST_TIMEOUT': '10000',
    'YOUKU_CONCURRENCY': '8',
    'SOURCE_ORDER': '360,vod,renren,hanjutv',
    'EPISODE_TITLE_FILTER': '/(特别|惊喜|纳凉)?企划|合伙人手记|超前(营业|vlog)?|速览|vlog|reaction|纯享|加更(版|篇)?|抢先(看|版|集|篇)?|抢鲜|预告片?|花絮(独家)?|特辑|彩蛋|专访|幕后(故事|花絮|独家)?|直播(陪看|回顾)?|未播(片段)?|衍生|番外篇?|会员(专享|加长|尊享|专属|版)?|片花|精华版?|看点|速看|解读|影评|解说|吐槽|盘点|拍摄花絮|制作花絮|幕后花絮|未播花絮|独家花絮|花絮特辑|先导预告|终极预告|正式预告|官方预告|彩蛋片段|删减片段|未播片段|番外彩蛋|精彩片段|精彩看点|精彩回顾|精彩集锦|看点解析|看点预告|NG镜头|NG花絮|番外特辑|制作特辑|拍摄特辑|幕后特辑|导演特辑|演员特辑|片尾曲|插曲MV|背景音乐|OST|音乐MV|歌曲MV|前季回顾|剧情回顾|往期回顾|内容总结|剧情盘点|精选合集|剪辑合集|混剪视频|独家专访|演员访谈|导演访谈|主创访谈|媒体采访|发布会采访|采访实录|陪看(记)?|试看版|短剧版|精编版|Plus版|独家版|特别版|宣传短片|发布会|解忧局|走心局|火锅局|巅峰时刻|坞里都知道|福持目标坞民|观察室|上班那点事儿|周top|赛段集锦|直拍|REACTION|VLOG|全纪录|开播特辑|先导片|总宣|展演|集锦|旅行日记|精彩分享|剧情揭秘|高光回顾|高光时刻/i',

    // ========== 弹幕屏蔽词配置 ==========
    'BLOCKED_WORDS': '/.{25,}/,/^\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}([日号.]*)?$/,/^(?!哈+$)([a-zA-Z\\u4e00-\\u9fa5])\\1{3,}/,/[0-9]+\\.*[0-9]*\\s*(w|万)+\\s*(\\+|个|人|在看)+/,/^[a-z]{8,}$/,/^(?:qwertyuiop|asdfghjkl|zxcvbnm)$/,/^\\d{6,}$/,/^(\\d)\\1{3,}$/,/[一二三四五六七八九十百\\d]+(刷|周目)/,/第[一二三四五六七八九十百\\d]+(遍|次|集|季|周目)/,/(全体成员|报到|报道|签到|打卡|考古|挖坟|留念|前排|沙发|板凳|末排|后排|同上|同样|我也是|俺也|算我|加我|三连|新人|入坑|万人)/',

    'ENABLE_EPISODE_FILTER': 'false',
    'STRICT_TITLE_MATCH': 'false',
    'CONVERT_TOP_BOTTOM_TO_SCROLL': 'false',
    'DANMU_OUTPUT_FORMAT': 'json',
    'DANMU_SIMPLIFIED': 'true',
    'REMEMBER_LAST_SELECT': 'true',
    'MAX_LAST_SELECT_MAP': '100',
    'RATE_LIMIT_MAX_REQUESTS': '3',
    'LOG_LEVEL': 'info',
    'SEARCH_CACHE_MINUTES': '5',
    'COMMENT_CACHE_MINUTES': '5',
    'GROUP_MINUTE': '1'
  };

  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return {};
  }

  try {
    const result = await client.execute('SELECT key, value FROM env_configs');
    const configs = {};

    // 从数据库加载已配置的值
    for (const row of result.rows) {
      try {
        const key = row.key;
        const valueStr = row.value;
        let parsedValue = JSON.parse(valueStr);

        // ✅ 特殊处理：如果是 EPISODE_TITLE_FILTER，检查是否需要重建为正则表达式
        if (key === 'EPISODE_TITLE_FILTER' && typeof parsedValue === 'string' && parsedValue.length > 0) {
          try {
            const regexMatch = parsedValue.match(/^\/(.+)\/([gimuy]*)$/);
            if (regexMatch) {
              parsedValue = new RegExp(regexMatch[1], regexMatch[2]);
            } else {
              parsedValue = new RegExp(parsedValue);
            }
            log("info", `[database] ✅ 正则表达式已重建: ${key}`);
          } catch (e) {
            log("warn", `[database] ⚠️ 正则解析失败 ${key}: ${e.message}，使用默认值`);
            // ✅ 解析失败时跳过，让后面的默认值逻辑处理
            continue;
          }
        }

        configs[key] = parsedValue;
      } catch (e) {
        log("warn", `[database] 解析配置失败: ${row.key}`);
        configs[row.key] = row.value;
      }
    }

    // ========== 补充默认值 ==========
    for (const [key, defaultValue] of Object.entries(DEFAULT_VALUES)) {
      if (configs[key] === undefined || configs[key] === null || configs[key] === '') {
        let parsedValue = defaultValue;

        // 特殊处理：EPISODE_TITLE_FILTER 需要转换为正则对象
        if (key === 'EPISODE_TITLE_FILTER' && typeof parsedValue === 'string' && parsedValue.length > 0) {
          try {
            const regexMatch = parsedValue.match(/^\/(.+)\/([gimuy]*)$/);
            if (regexMatch) {
              parsedValue = new RegExp(regexMatch[1], regexMatch[2]);
            } else {
              parsedValue = new RegExp(parsedValue);
            }
          } catch (e) {
            log("warn", `[database] ⚠️ 默认正则解析失败 ${key}: ${e.message}`);
            parsedValue = null;
          }
        }

        configs[key] = parsedValue;
        log("info", `[database] 📝 使用默认值: ${key}`);
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

/**
 * 清理所有缓存数据
 */
export async function clearAllCache() {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    await client.execute('DELETE FROM cache_data');
    log("info", "[database] ✅ 已清空所有缓存数据");
    return true;
  } catch (error) {
    log("error", `[database] ❌ 清空缓存失败: ${error.message}`);
    return false;
  }
}

/**
 * 删除指定的缓存键
 * @param {string} key 缓存键
 */
export async function deleteCacheData(key) {
  const client = getDbClient();
  if (!client || !globals.databaseValid) {
    return false;
  }

  try {
    await client.execute({
      sql: 'DELETE FROM cache_data WHERE key = ?',
      args: [key]
    });
    log("info", `[database] ✅ 已删除缓存: ${key}`);
    return true;
  } catch (error) {
    log("error", `[database] ❌ 删除缓存失败 (${key}): ${error.message}`);
    return false;
  }
}
