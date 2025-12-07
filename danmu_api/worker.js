import { Globals, globals } from './configs/globals.js'; // 🔥 直接导入 globals
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";


// ========== 登录会话管理 (持久化/内存降级方案) ==========
const sessions = new Map(); // 用于内存会话存储
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24小时过期

function generateSessionId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function validateSession(sessionId) {
  if (!sessionId) return false;
  
  try {
    // 1. 优先使用 Redis
    if (globals.redisValid) {
      const { getRedisKey } = await import('./utils/redis-util.js');
      const result = await getRedisKey(`session:${sessionId}`);
      if (!result?.result) return false;
      const session = JSON.parse(result.result);
      if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
        await deleteSession(sessionId);
        return false;
      }
      return true;
    }
    
    // 2. 降级到数据库
    if (globals.databaseValid) {
      const { loadCacheData } = await import('./utils/db-util.js');
      const sessionKey = `session:${sessionId}`;
      const session = await loadCacheData(sessionKey);
      if (!session) return false;
      if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
        await deleteSession(sessionId);
        return false;
      }
      return true;
    }
    
    // 3. 降级到内存
    const session = sessions.get(sessionId);
    if (!session) return false;
    
    if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
      sessions.delete(sessionId);
      log("info", `[session] 内存会话已过期并移除: ${sessionId.substring(0, 8)}...`);
      return false;
    }
    
    return true;
    
  } catch (error) {
    log("error", `[session] 验证会话失败: ${error.message}`);
    return false;
  }
}

async function saveSession(sessionId, username) {
  const session = {
    username,
    createdAt: Date.now()
  };
  
  try {
    // 1. 优先使用 Redis 存储
    if (globals.redisValid) {
      const { setRedisKey } = await import('./utils/redis-util.js');
      await setRedisKey(
        `session:${sessionId}`, 
        JSON.stringify(session),
        true,
        Math.floor(SESSION_TIMEOUT / 1000)
      );
      log("info", "[session] 会话已保存至 Redis");
      return true;
    }
    
    // 2. 降级到数据库存储
    if (globals.databaseValid) {
      const { saveCacheData } = await import('./utils/db-util.js');
      const sessionKey = `session:${sessionId}`;
      await saveCacheData(sessionKey, session);
      log("info", "[session] 会话已保存至数据库");
      return true;
    }
    
    // 3. 降级到内存存储
    sessions.set(sessionId, session);
    log("warn", "[session] 未配置持久化存储，会话将保存在内存中（重启后失效）");
    return true; // 关键：即使只存入内存也返回成功

  } catch (error) {
    log("error", `[session] 保存会话失败: ${error.message}`);
    return false;
  }
}

async function deleteSession(sessionId) {
  try {
    // 1. 从 Redis 删除
    if (globals.redisValid) {
      const { setRedisKey } = await import('./utils/redis-util.js');
      await setRedisKey(`session:${sessionId}`, '', true, 1);
    }
    
    // 2. 从数据库删除
    if (globals.databaseValid) {
      const { saveCacheData } = await import('./utils/db-util.js');
      const sessionKey = `session:${sessionId}`;
      await saveCacheData(sessionKey, null);
    }

    // 3. 从内存删除
    if (sessions.has(sessionId)) {
      sessions.delete(sessionId);
    }
  } catch (error) {
    log("error", `[session] 删除会话失败: ${error.message}`);
  }
}

// 每小时清理一次内存中过期的会话，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  if (sessions.size === 0) return;

  let clearedCount = 0;
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT) {
      sessions.delete(id);
      clearedCount++;
    }
  }
  if (clearedCount > 0) {
    log("info", `[session] 定时任务：清除了 ${clearedCount} 个过期的内存会话`);
  }
}, 60 * 60 * 1000);

/**
 * 合并写入 Redis：读取现有 -> 合并 patch -> 写回
 */
async function mergeSaveToRedis(key, patch) {
  try {
    const { getRedisKey, setRedisKey } = await import('./utils/redis-util.js');
    const existing = await getRedisKey(key);
    let base = {};
    if (existing && existing.result) {
      try { base = JSON.parse(existing.result) || {}; } catch (_) { base = {}; }
    }
    const merged = { ...base, ...patch };
    const res = await setRedisKey(key, JSON.stringify(merged), true);
    if (res && res.result === 'OK') {
      const { simpleHash } = await import('./utils/codec-util.js');
      globals.lastHashes[key] = simpleHash(JSON.stringify(merged));
      return true;
    }
    return false;
  } catch (e) {
    log('warn', `[config] mergeSaveToRedis 失败: ${e.message}`);
    return false;
  }
}

/**
 * 应用配置补丁到运行时：同步快照 + 按需重建派生缓存
 */
async function applyConfigPatch(patch) {
  // 从 globals 获取 deployPlatform（已在 handleRequest 中设置）
  const deployPlatform = globals.deployPlatform || 'unknown';

  // 1) 更新运行时快照
  for (const [k, v] of Object.entries(patch)) {
    globals.envs[k] = v;
    if (globals.accessedEnvVars) globals.accessedEnvVars[k] = v;
  }

  const { Envs } = await import('./configs/envs.js');
  Envs.env = globals.envs;

  // 2) 特殊变量即时刷新
  if ('TOKEN' in patch) {
    globals.token = patch.TOKEN;
  }

   // 🔥 自动处理所有环境变量更新（增强版：同步到 Envs 模块）
   const ENV_VAR_HANDLERS = {
     'BILIBILI_COOKIE': (value) => {
       globals.bilibiliCookie = value || '';
       globals.bilibliCookie = value || '';  // ← 兼容错误拼写
       globals.BILIBILI_COOKIE = value || '';
       globals.envs.bilibiliCookie = value || '';
       globals.envs.bilibliCookie = value || '';  // ← 兼容错误拼写
       globals.envs.BILIBILI_COOKIE = value || '';
       Envs.env.bilibiliCookie = value || '';
       Envs.env.bilibliCookie = value || '';  // ← 兼容错误拼写
       Envs.env.BILIBILI_COOKIE = value || '';
       return `${value ? '已设置' : '已清空'}`;
     },
     'TMDB_API_KEY': (value) => {
       globals.tmdbApiKey = value || '';
       globals.TMDB_API_KEY = value || '';
       globals.envs.tmdbApiKey = value || '';
       globals.envs.TMDB_API_KEY = value || '';
       Envs.env.tmdbApiKey = value || '';
       Envs.env.TMDB_API_KEY = value || '';
       return `${value ? '已设置' : '已清空'}`;
     },
     'WHITE_RATIO': (value) => {
       const ratio = parseFloat(value);
       if (!isNaN(ratio)) {
         globals.whiteRatio = ratio;
         globals.WHITE_RATIO = ratio;
         globals.envs.whiteRatio = ratio;
         globals.envs.WHITE_RATIO = ratio;
         Envs.env.whiteRatio = ratio;
         Envs.env.WHITE_RATIO = ratio;
         return `${ratio}`;
       }
       return null;
     },
     'BLOCKED_WORDS': (value) => {
       globals.blockedWords = value || '';
       globals.BLOCKED_WORDS = value || '';
       globals.envs.blockedWords = value || '';
       globals.envs.BLOCKED_WORDS = value || '';
       globals.blockedWordsArr = value ? value.split(',').map(w => w.trim()).filter(w => w.length > 0) : [];
       globals.envs.blockedWordsArr = globals.blockedWordsArr;
       Envs.env.blockedWords = value || '';
       Envs.env.BLOCKED_WORDS = value || '';
       Envs.env.blockedWordsArr = globals.blockedWordsArr;
       return `${globals.blockedWordsArr.length} 个屏蔽词`;
     },
     'GROUP_MINUTE': (value) => {
       const minutes = parseInt(value) || 1;
       globals.groupMinute = minutes;
       globals.GROUP_MINUTE = minutes;
       globals.envs.groupMinute = minutes;
       globals.envs.GROUP_MINUTE = minutes;
       Envs.env.groupMinute = minutes;
       Envs.env.GROUP_MINUTE = minutes;
       return `${minutes} 分钟`;
     },
     'CONVERT_TOP_BOTTOM_TO_SCROLL': (value) => {
       const enabled = String(value).toLowerCase() === 'true';
       globals.convertTopBottomToScroll = enabled;
       globals.CONVERT_TOP_BOTTOM_TO_SCROLL = enabled;
       globals.envs.convertTopBottomToScroll = enabled;
       globals.envs.CONVERT_TOP_BOTTOM_TO_SCROLL = enabled;
       Envs.env.convertTopBottomToScroll = enabled;
       Envs.env.CONVERT_TOP_BOTTOM_TO_SCROLL = enabled;
       return `${enabled}`;
     },
     'DANMU_SIMPLIFIED': (value) => {
       const enabled = String(value).toLowerCase() === 'true';
       globals.danmuSimplified = enabled;
       globals.DANMU_SIMPLIFIED = enabled;
       globals.envs.danmuSimplified = enabled;
       globals.envs.DANMU_SIMPLIFIED = enabled;
       Envs.env.danmuSimplified = enabled;
       Envs.env.DANMU_SIMPLIFIED = enabled;
       return `${enabled}`;
     },
     'DANMU_LIMIT': (value) => {
       const limit = parseInt(value) || -1;
       globals.danmuLimit = limit;
       globals.DANMU_LIMIT = limit;
       globals.envs.danmuLimit = limit;
       globals.envs.DANMU_LIMIT = limit;
       Envs.env.danmuLimit = limit;
       Envs.env.DANMU_LIMIT = limit;
       return `${limit}`;
     },
     'SEARCH_CACHE_MINUTES': (value) => {
       const minutes = parseInt(value);
       if (!isNaN(minutes) && minutes >= 0) {
         globals.searchCacheMinutes = minutes;
         globals.SEARCH_CACHE_MINUTES = minutes;
         globals.envs.searchCacheMinutes = minutes;
         globals.envs.SEARCH_CACHE_MINUTES = minutes;
         Envs.env.searchCacheMinutes = minutes;
         Envs.env.SEARCH_CACHE_MINUTES = minutes;
         return `${minutes} 分钟`;
       }
       return null;
     },
     'COMMENT_CACHE_MINUTES': (value) => {
       const minutes = parseInt(value);
       if (!isNaN(minutes) && minutes >= 0) {
         globals.commentCacheMinutes = minutes;
         globals.COMMENT_CACHE_MINUTES = minutes;
         globals.envs.commentCacheMinutes = minutes;
         globals.envs.COMMENT_CACHE_MINUTES = minutes;
         Envs.env.commentCacheMinutes = minutes;
         Envs.env.COMMENT_CACHE_MINUTES = minutes;
         return `${minutes} 分钟`;
       }
       return null;
     },
     'DANMU_OUTPUT_FORMAT': (value) => {
       globals.danmuOutputFormat = value || 'json';
       globals.DANMU_OUTPUT_FORMAT = value || 'json';
       globals.envs.danmuOutputFormat = value || 'json';
       globals.envs.DANMU_OUTPUT_FORMAT = value || 'json';
       Envs.env.danmuOutputFormat = value || 'json';
       Envs.env.DANMU_OUTPUT_FORMAT = value || 'json';
       return `${value || 'json'}`;
     },
     'DANMU_FONTSIZE': (value) => {
       const size = parseInt(value) || 25;
       globals.danmuFontSize = size;
       globals.DANMU_FONTSIZE = size;
       globals.envs.danmuFontSize = size;
       globals.envs.DANMU_FONTSIZE = size;
       Envs.env.danmuFontSize = size;
       Envs.env.DANMU_FONTSIZE = size;
       return `${size}px`;
     },
     'DANMU_COLORS': (value) => {
       globals.danmuColors = value || '';
       globals.DANMU_COLORS = value || '';
       globals.envs.danmuColors = value || '';
       globals.envs.DANMU_COLORS = value || '';
       Envs.env.danmuColors = value || '';
       Envs.env.DANMU_COLORS = value || '';
       return `${value ? '已更新颜色池' : '使用默认色盘'}`;
     }
   };

  // 自动处理所有定义好的环境变量
  for (const [key, value] of Object.entries(patch)) {
    if (ENV_VAR_HANDLERS[key]) {
      const result = ENV_VAR_HANDLERS[key](value);
      if (result !== null) {
        log('info', `[config] ${key} 已立即更新: ${result}`);
      }
    }
  }

  // 3) 派生缓存重建（按需、存在才调用）
  const safeCall = async (fn, label) => {
    try { await fn(); log('info', `[config] 重建派生缓存成功: ${label}`); }
    catch (e) { log('warn', `[config] 重建派生缓存失败: ${label}: ${e.message}`); }
  };

  const need = new Set(Object.keys(patch));

  // VOD 采集站解析
  if (need.has('VOD_SERVERS') || need.has('PROXY_URL') || need.has('VOD_REQUEST_TIMEOUT')) {
    await safeCall(async () => {
      const { Envs } = await import('./configs/envs.js');
      Envs.env = globals.envs;
      if (typeof Envs.resolveVodServers === 'function') {
        globals.vodServers = Envs.resolveVodServers(globals.envs);
      }
    }, 'VOD_SERVERS');
  }

  // 数据源排序
  if (need.has('SOURCE_ORDER') || need.has('PLATFORM_ORDER')) {
    await safeCall(async () => {
      const { Envs } = await import('./configs/envs.js');
      Envs.env = globals.envs;
      if (typeof Envs.resolveSourceOrder === 'function') {
        globals.sourceOrderArr = Envs.resolveSourceOrder(globals.envs, deployPlatform);
      }
      if (typeof Envs.resolvePlatformOrder === 'function') {
        globals.platformOrderArr = Envs.resolvePlatformOrder(globals.envs, deployPlatform);
      }
    }, 'SOURCE_ORDER/PLATFORM_ORDER');
  }

  // 代理
  if (need.has('PROXY_URL')) {
    await safeCall(async () => {
      try {
        const { buildProxyAgent } = await import('./utils/net-util.js');
        if (typeof buildProxyAgent === 'function') {
          globals.proxyAgent = buildProxyAgent(globals.envs.PROXY_URL);
        }
      } catch (_) {}
    }, 'PROXY_URL');
  }

  // 限流
  if (need.has('RATE_LIMIT_MAX_REQUESTS')) {
    await safeCall(async () => {
      try {
        const { setRateLimitMax } = await import('./utils/rate-limit.js');
        if (typeof setRateLimitMax === 'function') {
          setRateLimitMax(parseInt(globals.envs.RATE_LIMIT_MAX_REQUESTS, 10));
        } else if (globals.rateLimiter && typeof globals.rateLimiter.setMax === 'function') {
          globals.rateLimiter.setMax(parseInt(globals.envs.RATE_LIMIT_MAX_REQUESTS, 10));
        }
      } catch (_) {}
    }, 'RATE_LIMIT_MAX_REQUESTS');
  }

  // 缓存策略
  if (
    need.has('SEARCH_CACHE_MINUTES') ||
    need.has('COMMENT_CACHE_MINUTES') ||
    need.has('REMEMBER_LAST_SELECT') ||
    need.has('MAX_LAST_SELECT_MAP')
  ) {
    await safeCall(async () => {
      try {
        if (globals.caches?.search && typeof globals.caches.search.setTTL === 'function') {
          globals.caches.search.setTTL(parseInt(globals.envs.SEARCH_CACHE_MINUTES || '1', 10) * 60);
        }
        if (globals.caches?.comment && typeof globals.caches.comment.setTTL === 'function') {
          globals.caches.comment.setTTL(parseInt(globals.envs.COMMENT_CACHE_MINUTES || '1', 10) * 60);
        }
        if (globals.lastSelectMap && typeof globals.lastSelectMap.resize === 'function' && globals.envs.MAX_LAST_SELECT_MAP) {
          globals.lastSelectMap.resize(parseInt(globals.envs.MAX_LAST_SELECT_MAP, 10));
        }
        if (typeof globals.setRememberLastSelect === 'function' && typeof globals.envs.REMEMBER_LAST_SELECT !== 'undefined') {
          const on = String(globals.envs.REMEMBER_LAST_SELECT).toLowerCase() === 'true';
          globals.setRememberLastSelect(on);
        }
      } catch (_) {}
    }, '缓存策略');
  }

  // 文本处理相关钩子（若你的项目有）
  if (
    need.has('DANMU_SIMPLIFIED') ||
    need.has('WHITE_RATIO') ||
    need.has('CONVERT_TOP_BOTTOM_TO_SCROLL') ||
    need.has('EPISODE_TITLE_FILTER')
  ) {
    await safeCall(async () => {
      try {
        if (typeof globals.reconfigureTextPipeline === 'function') {
          globals.reconfigureTextPipeline(globals.envs);
        }
      } catch (_) {}
    }, '弹幕文本处理');
  }
}


// 环境变量说明配置
// 环境变量说明配置
const ENV_DESCRIPTIONS = {
  // ========== 基础配置 ==========
  'TOKEN': '自定义API访问令牌，使用默认87654321可以不填写',
  'VERSION': '当前服务版本号（自动生成）',
  'LOG_LEVEL': '日志级别：error（仅错误）/ warn（警告+错误）/ info（全部日志），默认info',

  // ========== 数据源配置 ==========
  'OTHER_SERVER': '兜底第三方弹幕服务器，当所有平台都获取失败时使用，默认api.danmu.icu',
  'VOD_SERVERS': 'VOD影视采集站列表，格式：名称@URL,名称@URL...（多个用逗号分隔）',
  'VOD_RETURN_MODE': 'VOD返回模式：all（返回所有站点结果）/ fastest（仅返回最快响应的站点），默认all',
  'VOD_REQUEST_TIMEOUT': 'VOD单个请求超时时间（毫秒），默认10000（10秒）',

  // ========== 平台认证配置 ==========
  'BILIBILI_COOKIE': 'B站Cookie，用于获取完整弹幕数据（最少需要SESSDATA字段）',
  'TMDB_API_KEY': 'TMDB API密钥，用于将外语标题转换为中文标题，提升巴哈姆特搜索准确度',

  // ========== 数据源优先级 ==========
  'SOURCE_ORDER': '数据源优先级排序，影响自动匹配时的搜索顺序（如：bilibili,iqiyi,youku）',
  'PLATFORM_ORDER': '弹幕平台优先级，优先返回指定平台的弹幕数据',

  // ========== 标题匹配配置 ==========
  'TITLE_TO_CHINESE': '在match接口自动匹配时，是否将外语标题转换成中文标题（需配合TMDB_API_KEY使用），默认false',
  'STRICT_TITLE_MATCH': '严格标题匹配模式：仅匹配剧名开头或完全匹配，过滤不相关结果，默认false',
  'EPISODE_TITLE_FILTER': '剧集标题正则过滤表达式，用于过滤预告、花絮等非正片内容',
  'ENABLE_EPISODE_FILTER': '手动选择接口（select）是否启用集标题过滤，默认false',

  // ========== 弹幕处理配置 ==========
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式：json（JSON格式）/ xml（Bilibili XML格式），默认json',
  'DANMU_FONTSIZE': '弹幕字体大小，默认25（18=小, 25=标准, 36=大），仅对 XML 格式生效',
  'DANMU_SIMPLIFIED': '是否将繁体弹幕转换为简体中文（主要用于巴哈姆特），默认true',
  'DANMU_LIMIT': '弹幕数量限制，-1表示不限制，其他数字为最大返回条数',
  'BLOCKED_WORDS': '弹幕屏蔽词列表，过滤包含指定关键词的弹幕（多个词用逗号分隔）',
  'GROUP_MINUTE': '弹幕合并去重时间窗口（分钟），相同内容在该时间内只保留一条，默认1',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '是否将顶部/底部弹幕转换为滚动弹幕，默认false',
  'WHITE_RATIO': '白色弹幕占比（0-100），-1表示不转换颜色，其他值表示将指定比例弹幕转为白色',
  'DANMU_COLORS': '彩色弹幕颜色池，使用英文逗号分隔的Hex颜色值（如 #FF0000,#00FF00），留空则使用默认糖果色',

  // ========== 性能优化配置 ==========
  'YOUKU_CONCURRENCY': '优酷弹幕请求并发数，默认8，最高16（并发数越高速度越快但资源消耗越大）',
  'SEARCH_CACHE_MINUTES': '搜索结果缓存时间（分钟），减少重复搜索请求，默认1',
  'COMMENT_CACHE_MINUTES': '弹幕数据缓存时间（分钟），减少重复弹幕获取，默认1',
  'REMEMBER_LAST_SELECT': '是否记住用户手动选择结果，优化后续自动匹配准确度，默认true',
  'MAX_LAST_SELECT_MAP': '最后选择映射的缓存大小限制，默认100条（超出后会删除最旧的记录）',

  // ========== 网络配置 ==========
  'PROXY_URL': '代理/反代地址，用于访问巴哈姆特和TMDB（支持混合配置，如：bahamut=proxy1,tmdb=proxy2）',
  'RATE_LIMIT_MAX_REQUESTS': '限流配置：同一IP在1分钟内允许的最大请求次数，默认3（防止滥用）',

  // ========== 持久化存储配置 ==========
  // Upstash Redis（适用于无服务器平台）
  'UPSTASH_REDIS_REST_URL': 'Upstash Redis服务URL，用于持久化存储防止冷启动数据丢失（适用于Vercel/Netlify等平台）',
  'UPSTASH_REDIS_REST_TOKEN': 'Upstash Redis访问令牌，需要配合UPSTASH_REDIS_REST_URL一起使用',
  'redisValid': 'Redis连接状态：已连接 / 未连接（自动检测）',
  'redisUrl': 'Redis服务器地址（显示配置的URL，隐藏敏感信息）',
  'redisToken': 'Redis访问令牌状态（显示是否已配置，隐藏实际令牌）',

  // SQLite数据库（通用持久化方案）
  'DATABASE_URL': '数据库连接URL，支持本地SQLite（file:/path/to/db）和Cloudflare D1（libsql://xxx），用于持久化存储缓存和配置数据',
  'DATABASE_AUTH_TOKEN': '数据库认证令牌，远程数据库（如Cloudflare D1）需要配置，本地SQLite文件可不填'
};

// 定义敏感字段列表
const SENSITIVE_KEYS = [
  'TOKEN',
  'BILIBILI_COOKIE',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'TMDB_API_KEY',
  'PROXY_URL',
  'redisUrl',
  'redisToken'
];

/**
 * 判断环境变量是否为敏感信息
 */
function isSensitiveKey(key) {
  return SENSITIVE_KEYS.includes(key) ||
    key.toLowerCase().includes('token') ||
    key.toLowerCase().includes('password') ||
    key.toLowerCase().includes('secret') ||
    key.toLowerCase().includes('key') ||
    key.toLowerCase().includes('cookie');
}

/**
 * 获取环境变量的真实值(未加密) - 服务端版本
 */
/**
 * 获取环境变量的真实值(未加密) - 服务端版本
 */
function getRealEnvValue(key) {
  const keyMapping = {
    'redisUrl': 'UPSTASH_REDIS_REST_URL',
    'redisToken': 'UPSTASH_REDIS_REST_TOKEN',
    'bilibliCookie': 'BILIBILI_COOKIE',
    'tmdbApiKey': 'TMDB_API_KEY',
    'proxyUrl': 'PROXY_URL',
    'token': 'TOKEN'
  };

  const actualKey = keyMapping[key] || key;

  // 优先从 globals.accessedEnvVars 获取（这是真实值）
  if (globals.accessedEnvVars && actualKey in globals.accessedEnvVars) {
    const value = globals.accessedEnvVars[actualKey];
    // 🔥 确保返回字符串类型
    if (value !== null && value !== undefined) {
      return typeof value === 'string' ? value : String(value);
    }
  }

  // 备用方案：从 process.env 获取
  if (typeof process !== 'undefined' && process.env?.[actualKey]) {
    return String(process.env[actualKey]);
  }

  // 最后尝试从 Globals 获取默认值
  if (actualKey in Globals) {
    const value = Globals[actualKey];
    return typeof value === 'string' ? value : String(value);
  }

  // 如果都没有，返回空字符串
  return '';
}

async function handleRequest(req, env, deployPlatform, clientIp) {
  // ✅ 只在首次请求或 globals 未初始化时初始化
  if (!globals.configLoaded) {
    log("info", "[init] 🚀 首次启动，初始化全局配置...");
    
    // 使用双重检查锁定模式，避免并发初始化
    if (!globals.initializationLock) {
      globals.initializationLock = true;
      
      try {
        await Globals.init(env, deployPlatform);
        log("info", "[init] ✅ 全局配置初始化完成");
      } catch (error) {
        log("error", `[init] ❌ 初始化失败: ${error.message}`);
        globals.initializationLock = false;
        
        return new Response(JSON.stringify({
          errorCode: 500,
          success: false,
          errorMessage: "Configuration initialization failed"
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } else {
      // 等待其他请求完成初始化
      let retries = 0;
      while (!globals.configLoaded && retries < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
      }
      
      if (!globals.configLoaded) {
        return new Response(JSON.stringify({
          errorCode: 503,
          success: false,
          errorMessage: "Server is initializing, please retry"
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  }

  // ✅ 现在可以安全设置 deployPlatform
  globals.deployPlatform = deployPlatform;

  // ... 后续代码保持不变

  const url = new URL(req.url);
  let path = url.pathname;
  const method = req.method;

    // 🔥 优先检查数据库连接
  if (!globals.storageChecked && path !== "/favicon.ico" && path !== "/robots.txt") {
    if (globals.databaseValid) {
      try {
        const { loadCacheBatch } = await import('./utils/db-util.js');
        const cacheData = await loadCacheBatch();
        
        // 加载缓存数据到内存
        if (cacheData.animes && Object.keys(cacheData.animes).length > 0) {
          globals.animes = cacheData.animes;
          log("info", `[storage] 📦 从数据库加载搜索缓存: ${Object.keys(cacheData.animes).length} 条`);
        }
        if (cacheData.episodeIds && Object.keys(cacheData.episodeIds).length > 0) {
          globals.episodeIds = cacheData.episodeIds;
          log("info", `[storage] 📦 从数据库加载剧集映射: ${Object.keys(cacheData.episodeIds).length} 条`);
        }
        if (cacheData.episodeNum && Object.keys(cacheData.episodeNum).length > 0) {
          globals.episodeNum = cacheData.episodeNum;
          log("info", `[storage] 📦 从数据库加载集数映射: ${Object.keys(cacheData.episodeNum).length} 条`);
        }
        if (cacheData.lastSelectMap) {
          globals.lastSelectMap = new Map(Object.entries(cacheData.lastSelectMap));
          log("info", `[storage] 📦 从数据库加载用户选择: ${globals.lastSelectMap.size} 条`);
        }
        
        log("info", "[storage] ✅ 从数据库加载缓存数据完成（优先级最高）");
      } catch (error) {
        log("error", `[storage] ❌ 数据库缓存加载失败: ${error.message}`);
      }
    }
    
    // 🔥 如果数据库不可用，检查 Redis
    if (!globals.databaseValid) {
      await judgeRedisValid(path);
      if (globals.redisValid) {
        await getRedisCaches();
        log("info", "[storage] ✅ 从 Redis 加载缓存数据");
      }
    }
    
    globals.storageChecked = true;
  }

  log("info", `request url: ${JSON.stringify(url)}`);
  log("info", `request path: ${path}`);
  log("info", `client ip: ${clientIp}`);

async function handleHomepage(req, deployPlatform = 'unknown') {
  log("info", "Accessed homepage");

  // 🔥 Netlify 部署时跳过登录验证
  const isNetlify = deployPlatform === 'netlify' || 
                    process.env.NETLIFY === 'true' || 
                    process.env.CONTEXT === 'production';
  
  if (!isNetlify) {
    // 检查登录状态
    const cookies = req.headers.get('cookie') || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    const sessionId = sessionMatch ? sessionMatch[1] : null;

    const isValid = await validateSession(sessionId);
    if (!isValid) {
      return getLoginPage();
    }
  } else {
    log("info", "[Netlify] 跳过登录验证，直接进入主页");
  }


    const redisConfigured = !!(globals.redisUrl && globals.redisToken);
    const redisStatusText = redisConfigured 
      ? (globals.redisValid ? '在线' : '离线') 
      : '未配置';
    const redisStatusClass = redisConfigured 
      ? (globals.redisValid ? 'badge-success' : 'badge-warning')
      : 'badge-secondary';

    // 安全检查：确保必要的属性存在
    if (!globals.accessedEnvVars) {
      globals.accessedEnvVars = {};
    }
    if (!globals.vodServers) {
      globals.vodServers = [];
    }
    if (!globals.sourceOrderArr) {
      globals.sourceOrderArr = [];
    }

    // 计算已配置的环境变量数量
    const configuredEnvCount = Object.entries(globals.accessedEnvVars).filter(([key, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'string' && value.length === 0) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }).length;

    const totalEnvCount = Object.keys(globals.accessedEnvVars).length;

    // 计算敏感环境变量的数量
    const sensitiveEnvCount = Object.entries(globals.accessedEnvVars).filter(([key, value]) => {
      if (!isSensitiveKey(key)) return false;
      if (value === null || value === undefined) return false;
      if (typeof value === 'string' && value.length === 0) return false;
      return true;
    }).length;

// 生成环境变量HTML
    const envItemsHtml = Object.entries(globals.accessedEnvVars)
      .filter(([key]) => {
        // 🔥 过滤掉自动管理的内部变量
        const autoManagedKeys = ['SOURCE_STATUS', 'PLATFORM_STATUS'];
        return !autoManagedKeys.includes(key);
      })
      .map(([key, value]) => {
        let valueClass = '';
        let displayValue = value;
        const description = ENV_DESCRIPTIONS[key] || '环境变量';
        const isSensitive = isSensitiveKey(key);

        if (typeof value === 'boolean') {
          valueClass = value ? 'value-enabled' : 'value-disabled';
          displayValue = value ? '已启用' : '已禁用';
        } else if (value === null || value === undefined || (typeof value === 'string' && value.length === 0)) {
          valueClass = 'value-empty';
          displayValue = '未配置';
        } else if (isSensitive && typeof value === 'string' && value.length > 0) {
          const realValue = getRealEnvValue(key);
          const maskedValue = '•'.repeat(Math.min(String(realValue).length, 24));

        // 确保 realValue 是字符串类型
        const safeRealValue = typeof realValue === 'string' ? realValue : JSON.stringify(realValue);
        const encodedRealValue = safeRealValue
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');


          return `
            <div class="config-item" data-key="${key}">
              <div class="config-header">
                <span class="config-label">${key}</span>
                <div class="config-actions">
                  <div class="tooltip-wrapper">
                    <svg class="info-icon" viewBox="0 0 24 24" width="16" height="16">
                      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
                      <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <div class="tooltip-content">${description}</div>
                  </div>
                  <button class="icon-btn edit-btn" onclick="editEnvVar('${key}')" title="编辑">
                    <svg viewBox="0 0 24 24" width="16" height="16">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" fill="none"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" fill="none"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="config-value sensitive-value" 
                   data-real="${encodedRealValue}" 
                   data-masked="${maskedValue}"
                   onclick="toggleSensitive(this)"
                   title="点击显示/隐藏">
                <code>${maskedValue}</code>
                <svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16">
                  <path fill="none" stroke="currentColor" stroke-width="2" d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                  <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
                </svg>
              </div>
            </div>
          `;
        } else if (Array.isArray(value)) {
          if (value.length > 0) {
            displayValue = value.join(', ');
          } else {
            valueClass = 'value-empty';
            displayValue = '默认值';
          }
        } else if (typeof value === 'string' && value.length > 100) {
          displayValue = value.substring(0, 100) + '...';
        }

        const realValue = getRealEnvValue(key);
        const encodedOriginal = String(realValue || value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

        return `
          <div class="config-item" data-key="${key}">
            <div class="config-header">
              <span class="config-label">${key}</span>
              <div class="config-actions">
                <div class="tooltip-wrapper">
                  <svg class="info-icon" viewBox="0 0 24 24" width="16" height="16">
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
                    <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  <div class="tooltip-content">${description}</div>
                </div>
                <button class="icon-btn edit-btn" onclick="editEnvVar('${key}')" title="编辑">
                  <svg viewBox="0 0 24 24" width="16" height="16">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" fill="none"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="config-value ${valueClass}" data-original="${encodedOriginal}" title="双击复制完整内容">
              <code>${displayValue}</code>
            </div>
          </div>
        `;
      })
      .join('');

    // 生成VOD服务器HTML
    let vodServersHtml = '';
    const defaultVodServersStr = '金蝉@https://zy.jinchancaiji.com,789@https://www.caiji.cyou,听风@https://gctf.tfdh.top';
    const defaultVodServers = defaultVodServersStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map((item, index) => {
        if (item.includes('@')) {
          const [name, url] = item.split('@').map(s => s.trim());
          return { name: name || `vod-${index + 1}`, url };
        }
        return { name: `vod-${index + 1}`, url: item };
      })
      .filter(server => server.url && server.url.length > 0);

    try {
      if (globals.vodServers && globals.vodServers.length > 0) {
        vodServersHtml = globals.vodServers.map((server, index) => {
          let serverName = `服务器 #${index + 1}`;
          let serverUrl = '';

          if (typeof server === 'string') {
            serverUrl = server;
            if (server.includes('@')) {
              const parts = server.split('@');
              serverName = parts[0];
              serverUrl = parts.slice(1).join('@');
            }
          } else if (typeof server === 'object' && server !== null) {
            serverName = server.name || server.title || serverName;
            serverUrl = server.url || server.baseUrl || server.address || JSON.stringify(server);
          } else {
            serverUrl = String(server);
          }

          return `
            <div class="server-item" data-index="${index}">
              <div class="server-badge">${index + 1}</div>
              <div class="server-info">
                <div class="server-name">${serverName}</div>
                <div class="server-url">${serverUrl}</div>
              </div>
              <div class="server-actions">
                <button class="icon-btn" onclick="editVodServer(${index})" title="编辑">
                  <svg viewBox="0 0 24 24" width="16" height="16">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" fill="none"/>
                  </svg>
                </button>
                <button class="icon-btn delete-btn" onclick="deleteVodServer(${index})" title="删除">
                  <svg viewBox="0 0 24 24" width="16" height="16">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" fill="none"/>
                  </svg>
                </button>
              </div>
            </div>
          `;
        }).join('');
      } else {
        vodServersHtml = defaultVodServers.map((server, index) => `
          <div class="server-item" data-index="${index}">
            <div class="server-badge default-badge">默认</div>
            <div class="server-info">
              <div class="server-name">${server.name}</div>
              <div class="server-url">${server.url}</div>
            </div>
            <div class="server-actions">
              <button class="icon-btn" onclick="editVodServer(${index})" title="编辑">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" fill="none"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" fill="none"/>
                </svg>
              </button>
            </div>
          </div>
        `).join('');
      }
    } catch (error) {
      log("error", `Generate VOD HTML error: ${error.message}`);
      vodServersHtml = `
        <div class="alert alert-error">
          <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M12 8v4m0 4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>无法加载 VOD 服务器列表: ${error.message}</span>
        </div>
      `;
    }

// 生成数据源HTML
    const sourceIcons = {
      'dandan': 'D',
      'bilibili': 'B',
      'iqiyi': 'I',
      'youku': 'Y',
      'tencent': 'T',
      'mgtv': 'M',
      'bahamut': 'BH',
      'hanjutv': 'H'  // ✅ 已添加
    };
    
// 生成最近匹配列表HTML - 完美版 (修复集数识别+智能显示)
let recentMatchesHtml = '';
try {
  // 1. 获取 Map 数据
  let mapEntries = [];
  if (globals.lastSelectMap) {
    mapEntries = globals.lastSelectMap instanceof Map
      ? Array.from(globals.lastSelectMap.entries())
      : Object.entries(globals.lastSelectMap);
  }

  // 按时间倒序
  mapEntries.sort((a, b) => {
    const tA = a[1]?.timestamp || a[1]?.time || a[1]?.date || a[1]?.createdAt || 0;
    const tB = b[1]?.timestamp || b[1]?.time || b[1]?.date || b[1]?.createdAt || 0;
    return tB - tA;
  });

  // 2. 过滤与统计
  const uniqueEntries = [];
  const sourceStats = {};
  let totalMatches = 0;

  // 辅助函数：转义HTML属性值
  const escapeAttr = (str) => {
    return String(str || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '&quot;')
      .replace(/\n/g, ' ');
  };

  // 🔥 核心：智能集数提取函数
  const extractEpisodeNumber = (episodeTitle, animeTitle, episodeId) => {
    let epNum = null;
    
    // 优先级1: 从 episodeTitle 提取
    if (episodeTitle) {
      const patterns = [
        /第(\d+)[集话]/,           // 第5集、第5话
        /EP?[\s._-]?(\d+)/i,      // EP05、E05、ep5
        /^(\d+)$/,                 // 纯数字 "05"
        /[\[【](\d+)[\]】]/,       // [05]、【05】
        /_(\d+)/,                  // _05
        /(\d+)\s*-/,               // 05 -
      ];
      
      for (const pattern of patterns) {
        const match = String(episodeTitle).match(pattern);
        if (match) {
          epNum = parseInt(match[1], 10);
          break;
        }
      }
    }
    
    // 优先级2: 从 episodeId 提取（末尾数字）
    if (!epNum && episodeId) {
      const idMatch = String(episodeId).match(/[_\-](\d{1,4})$/);
      if (idMatch) {
        epNum = parseInt(idMatch[1], 10);
      }
    }
    
    // 优先级3: 从 animeTitle 提取 (S01E05 格式)
    if (!epNum && animeTitle) {
      const seasonEpMatch = String(animeTitle).match(/S\d+E(\d+)/i);
      if (seasonEpMatch) {
        epNum = parseInt(seasonEpMatch[1], 10);
      }
    }
    
    return epNum || 1; // 默认返回1
  };

  // 🔥 核心：智能季数提取函数
  const extractSeasonNumber = (animeTitle) => {
    if (!animeTitle) return 1;
    const seasonMatch = String(animeTitle).match(/S(\d+)/i) || 
                       String(animeTitle).match(/第(\d+)季/);
    return seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
  };

  // 🔥 核心：判断副标题是否已包含完整集数信息
  const hasEpisodeInSubtitle = (subtitle) => {
    if (!subtitle) return false;
    return /第\d+[集话]|EP?\d+|^(\d{1,3})$|[\[【]\d+[\]】]/i.test(String(subtitle));
  };

  if (mapEntries.length > 0) {
    const displayedKeys = new Set();
    for (const [key, value] of mapEntries) {
      if (uniqueEntries.length >= 10) break;

      if (!value || typeof value !== 'object') continue;
      const targetId = value.id || value.animeId || value.episodeId;
      if (!targetId || ['未匹配', '无数据', 'null', 'undefined'].includes(String(targetId))) continue;

      const cleanKeyName = String(key).replace(/\s*from\s+.*$/i, '').trim();
      const uniqueKey = value.animeTitle ? `${value.animeTitle}-${value.episodeTitle}` : cleanKeyName;

      const src = (value.source || value.type || 'auto').toLowerCase();
      sourceStats[src] = (sourceStats[src] || 0) + 1;
      totalMatches++;

      if (!displayedKeys.has(uniqueKey)) {
        displayedKeys.add(uniqueKey);
        uniqueEntries.push([key, value]);
      }
    }
  }

  // 3. 渲染逻辑
  if (uniqueEntries.length > 0) {
    const THEMES = {
      'dandan':    { name: '弹弹Play', color: '#F472B6', bg: 'linear-gradient(135deg, #EC4899, #DB2777)', shadow: 'rgba(236, 72, 153, 0.4)', icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>' },
      'bilibili':  { name: 'B站', color: '#23ADE5', bg: 'linear-gradient(135deg, #00aeec, #0077aa)', shadow: 'rgba(35, 173, 229, 0.4)', icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17.813 4.653h.854c1.51.054 2.769.746 3.76 2.092 1.079 1.492 1.607 3.356 1.573 5.56v1.373c.067 2.373-.556 4.316-1.85 5.827-1.127 1.32-2.585 2.005-4.32 2.022H6.26c-1.745-.02-3.21-.707-4.346-2.022C.62 17.994-.003 16.05 0 13.678v-1.373c.007-2.193.53-4.067 1.597-5.56.992-1.346 2.251-2.038 3.76-2.092h.854l-1.82-4.144a.69.69 0 0 1 .15-.815.69.69 0 0 1 .83-.097l4.996 2.628h3.33l4.997-2.628a.69.69 0 0 1 .83.097.691.691 0 0 1 .15.815l-1.86 4.144zM7.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm9 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>' },
      'iqiyi':     { name: '爱奇艺', color: '#00CC4C', bg: 'linear-gradient(135deg, #00cc36, #009929)', shadow: 'rgba(0, 204, 76, 0.4)', icon: 'QIYI' },
      'youku':     { name: '优酷', color: '#00A0E9', bg: 'linear-gradient(135deg, #0bafff, #2979ff)', shadow: 'rgba(0, 160, 233, 0.4)', icon: 'YOU' },
      'tencent':   { name: '腾讯视频', color: '#FF7F00', bg: 'linear-gradient(135deg, #ff7f00, #ff5f00)', shadow: 'rgba(255, 127, 0, 0.4)', icon: 'QQ' },
      'imgo':      { name: '芒果TV', color: '#FF5F00', bg: 'linear-gradient(135deg, #ff5f00, #e65100)', shadow: 'rgba(255, 95, 0, 0.4)', icon: 'MG' },
      'sohu':      { name: '搜狐视频', color: '#FFD100', bg: 'linear-gradient(135deg, #ffd100, #ffb300)', shadow: 'rgba(255, 209, 0, 0.4)', icon: 'SOHU' },
      'letv':      { name: '乐视', color: '#E41F2B', bg: 'linear-gradient(135deg, #e41f2b, #c60b17)', shadow: 'rgba(228, 31, 43, 0.4)', icon: 'LE' },
      'renren':    { name: '人人影视', color: '#00A1D6', bg: 'linear-gradient(135deg, #29b6f6, #0288d1)', shadow: 'rgba(41, 182, 246, 0.4)', icon: 'RR' },
      'bahamut':   { name: '巴哈姆特', color: '#1CB4D3', bg: 'linear-gradient(135deg, #00b4d8, #0077b6)', shadow: 'rgba(28, 180, 211, 0.4)', icon: 'BAHA' },
      '360':       { name: '360影视', color: '#22C55E', bg: 'linear-gradient(135deg, #4ade80, #22c55e)', shadow: 'rgba(34, 197, 94, 0.4)', icon: '360' },
      'hanjutv':   { name: '韩剧TV', color: '#10B981', bg: 'linear-gradient(135deg, #34d399, #059669)', shadow: 'rgba(16, 185, 129, 0.4)', icon: '韩剧' }, // ✅ 已添加
      'vod':       { name: '点播资源', color: '#8B5CF6', bg: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', shadow: 'rgba(139, 92, 246, 0.4)', icon: 'VOD' },
      'douban':    { name: '豆瓣', color: '#00B51D', bg: 'linear-gradient(135deg, #00b51d, #009417)', shadow: 'rgba(0, 181, 29, 0.4)', icon: '豆瓣' },
      'default':   { name: '其他', color: '#818CF8', bg: 'linear-gradient(135deg, #6366f1, #4f46e5)', shadow: 'rgba(129, 140, 248, 0.4)', icon: 'API' }
    };

    const getTheme = (key) => {
      const k = String(key).toLowerCase();
      if (k.includes('bilibili')) return THEMES.bilibili;
      if (k.includes('iqiyi') || k.includes('qiyi')) return THEMES.iqiyi;
      if (k.includes('youku')) return THEMES.youku;
      if (k.includes('tencent') || k.includes('qq')) return THEMES.tencent;
      if (k.includes('mgtv')) return THEMES.mgtv;
      if (k.includes('sohu')) return THEMES.sohu;
      if (k.includes('letv') || k.includes('le.com')) return THEMES.letv;
      if (k.includes('renren') || k.includes('yyets')) return THEMES.renren;
      if (k.includes('bahamut')) return THEMES.bahamut;
      if (k.includes('360')) return THEMES['360'];
      if (k.includes('dandan')) return THEMES.dandan;
      if (k.includes('hanjutv')) return THEMES.hanjutv; // ✅ 已添加
      if (k.includes('vod')) return THEMES.vod;
      return THEMES.default;
    };

    const timeAgo = (ts) => {
      if (!ts) return '';
      const diff = Date.now() - ts;
      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) return '刚刚';
      if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
      if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
      return Math.floor(seconds / 86400) + ' 天前';
    };

    const topSourceEntry = Object.entries(sourceStats).sort((a, b) => b[1] - a[1])[0];
    const topSourceTheme = topSourceEntry ? getTheme(topSourceEntry[0]) : THEMES.default;

    // 🔥 生成列表 HTML
    const listHtml = uniqueEntries.map(([key, value], index) => {
      const src = (value.source || value.type || 'auto').toLowerCase();
      const theme = getTheme(src);
      
      const rawId = String(value.id || value.animeId || value.episodeId || '');
      const rawEpTitle = String(value.episodeTitle || '');
      const rawAnimeTitle = (value.animeTitle || String(key)).replace(/\s*from\s+.*$/i, '');

      // 提取年份
      const yearMatch = rawAnimeTitle.match(/[(（](\d{4})[)）]/);
      const year = yearMatch ? yearMatch[1] : null;

      // 清理主标题
      let mainTitle = rawAnimeTitle
        .replace(/【.*?】|\[.*?\]/g, '')
        .replace(/[(（]\d{4}[)）]/g, '')
        .replace(/S\d+E\d+/i, '')
        .replace(/第\s*\d+\s*[集话季]/, '')
        .trim();

      // 🔥 智能提取集数和季数
      const epNumber = extractEpisodeNumber(rawEpTitle, rawAnimeTitle, rawId);
      const seasonNumber = extractSeasonNumber(rawAnimeTitle);

      // 🔥 智能处理副标题显示
      let displaySub = rawEpTitle;
      if (displaySub === mainTitle) displaySub = '';
      
      // 移除主标题重复内容
      displaySub = displaySub
        .replace(mainTitle, '')
        .replace(/【.*?】|\[.*?\]/g, '')
        .replace(/\s*from\s+.*$/i, '');
      
      // 🔥 关键：不要从副标题中移除集数信息，保持原样
      displaySub = displaySub.replace(/^[\s\-\._:：]+|[\s\-\._:：]+$/g, '').trim();

      // 🔥 智能判断：是否显示集数徽章
      // 规则：如果副标题已包含完整集数信息，则不显示徽章
      const showEpisodeBadge = !hasEpisodeInSubtitle(displaySub);

      const timeDisplay = timeAgo(value.timestamp || value.time || value.date || value.createdAt);
      const danmuCount = value.count !== undefined ? value.count : 0;
      const danmuCountStr = danmuCount > 9999 ? (danmuCount/10000).toFixed(1) + 'w' : danmuCount;

      const hideClass = index >= 3 ? 'match-item-hidden' : '';
      const displayStyle = index >= 3 ? 'display: none;' : '';

      const safeId = escapeAttr(rawId);
      const safeTitle = escapeAttr(mainTitle);
      const safeSrc = escapeAttr(src);

      return `
        <div class="match-card ${hideClass}" style="${displayStyle}">
          <div class="card-glow" style="background: radial-gradient(circle at 95% 10%, ${theme.color}15 0%, transparent 60%);"></div>
          <div class="match-content" style="position: relative; display: flex; align-items: flex-start; gap: 14px;">
            <div class="match-icon" style="background: ${theme.bg}; box-shadow: 0 4px 12px ${theme.shadow};">
              ${theme.icon.includes('<svg') ? theme.icon : theme.icon}
            </div>

            <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
                <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding-right: 8px;">
                  <div class="match-title" title="${safeTitle}">${mainTitle}</div>
                  ${year ? `<div class="match-year">${year}</div>` : ''}
                </div>
                <div class="match-time">${timeDisplay}</div>
              </div>

              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-height: 20px;">
                ${showEpisodeBadge ? `
                  <div class="ep-badge" style="color: ${theme.color}; background: ${theme.color}15; border-color: ${theme.color}30;">第${epNumber}集</div>
                ` : ''}
                ${displaySub ? `<div class="ep-sub">${displaySub}</div>` : ''}
              </div>

              <div style="display: flex; align-items: center; justify-content: space-between; border-top: 1px dashed var(--border-color); padding-top: 8px; margin-top: auto;">
                <div style="display: flex; gap: 6px; align-items: center; flex: 1; min-width: 0; padding-right: 10px;">
                  <span style="font-size: 10px; color: ${theme.color}; font-weight: 600; flex-shrink: 0;">${theme.name}</span>
                  <div class="match-id-box" title="点击复制 ID: ${rawId}" onclick="navigator.clipboard.writeText('${safeId}');try{showToast('ID已复制')}catch(e){}">
                    <code>${rawId.replace(/^.*?[_\-](?=\d+$)/, '')}</code>
                  </div>
                </div>
                
                ${danmuCount > 0 ? `
                <div class="danmu-action-btn" onclick="toggleDanmuMenu(event, '${safeId}', '${safeTitle}', ${seasonNumber}, ${epNumber}, '${safeSrc}')" title="智能查看 (自动防过期)">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                  <span>${danmuCountStr}</span>
                  <div class="danmu-arrow">›</div>
                </div>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    recentMatchesHtml = `
      <style>
        .match-card {
          position: relative;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          border-radius: 16px;
          padding: 16px;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          overflow: hidden;
          cursor: default;
          animation: slideInUp 0.3s ease-out;
        }
        .match-card:hover {
          transform: translateY(-2px);
          border-color: var(--primary-500);
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
          z-index: 2;
        }
        .card-glow { pointer-events: none; position: absolute; inset: 0; opacity: 0; transition: opacity 0.4s ease; }
        .match-card:hover .card-glow { opacity: 1; }
        
        .match-icon {
          width: 48px; height: 48px; border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          font-size: 14px; font-weight: 800; color: #fff; flex-shrink: 0;
        }
        .match-title {
          font-size: 15px; font-weight: 700; color: var(--text-primary);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.4;
        }
        .match-year {
          padding: 1px 5px; background: var(--bg-secondary); color: var(--text-tertiary);
          font-size: 10px; border-radius: 4px; border: 1px solid var(--border-color); flex-shrink: 0;
        }
        .match-time { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; flex-shrink: 0; }
        .ep-badge {
          display: inline-flex; align-items: center; padding: 2px 8px;
          font-size: 12px; font-weight: 800; border-radius: 6px; border: 1px solid transparent;
        }
        .ep-sub {
          font-size: 12px; color: var(--text-secondary); font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .match-id-box {
          display: flex; align-items: center; gap: 4px; opacity: 0.6; cursor: pointer; max-width: 100%;
          border-left: 1px solid var(--border-color); padding-left: 6px; transition: opacity 0.2s;
        }
        .match-id-box:hover { opacity: 1; color: var(--primary-500); }
        .match-id-box code { font-size: 10px; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        
        .danmu-action-btn {
          display: flex; align-items: center; gap: 4px; 
          color: var(--text-primary); font-weight: 700; font-size: 11px;
          background: var(--bg-hover); padding: 4px 10px; border-radius: 20px;
          cursor: pointer; transition: all 0.2s; border: 1px solid transparent;
        }
        .danmu-action-btn:hover {
          background: var(--primary-500); color: white; border-color: var(--primary-600);
          transform: scale(1.05); box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        }
        .danmu-arrow { width: 0; overflow: hidden; transition: width 0.2s; opacity: 0; }
        .danmu-action-btn:hover .danmu-arrow { width: auto; opacity: 1; margin-left: 2px; }

        .show-more-btn {
          width: 100%; padding: 12px; margin-top: 8px;
          background: var(--bg-tertiary); border: 1px dashed var(--border-color);
          border-radius: 12px; color: var(--text-secondary); font-size: 13px; font-weight: 600;
          cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .show-more-btn:hover {
          background: var(--bg-hover); color: var(--primary-500); border-color: var(--primary-500);
        }
        
        .popover-menu {
          position: fixed; background: var(--bg-secondary); border: 1px solid var(--border-color);
          border-radius: 12px; padding: 6px; display: none; flex-direction: column; gap: 2px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 10000; animation: popIn 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
          min-width: 160px;
        }
        .popover-menu.active { display: flex; }
        
        .popover-item {
          padding: 10px 12px; font-size: 13px; color: var(--text-primary); cursor: pointer;
          border-radius: 8px; display: flex; align-items: center; gap: 10px; transition: background 0.2s;
          text-decoration: none; position: relative; overflow: hidden;
        }
        .popover-item:hover { background: var(--bg-hover); color: var(--primary-500); }
        .popover-header {
          padding: 8px 12px; font-size: 11px; color: var(--text-tertiary); font-weight: 700;
          border-bottom: 1px solid var(--border-color); margin-bottom: 4px; text-transform: uppercase;
        }
        
        .popover-spinner {
          width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent;
          border-radius: 50%; animation: spin 0.8s linear infinite; display: none;
        }
        .popover-item.loading .popover-spinner { display: block; }
        .popover-item.loading .item-icon { display: none; }
        
        @keyframes popIn { from { opacity: 0; transform: scale(0.9) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
        <div style="background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; flex-direction: column;">
            <span style="font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; font-weight: 600;">总匹配</span>
            <span style="font-size: 20px; font-weight: 800; color: var(--text-primary); line-height: 1.2;">${totalMatches}</span>
          </div>
          <div style="width: 36px; height: 36px; border-radius: 10px; background: var(--bg-hover); display: flex; align-items: center; justify-content: center; color: var(--primary-500);">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </div>
        </div>
        <div style="background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; flex-direction: column;">
            <span style="font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; font-weight: 600;">主要来源</span>
            <span style="font-size: 16px; font-weight: 700; color: ${topSourceTheme.color}; line-height: 1.2;">${topSourceEntry ? (THEMES[topSourceEntry[0]]?.name || topSourceEntry[0]) : '无'}</span>
          </div>
          <div style="width: 36px; height: 36px; border-radius: 10px; background: ${topSourceTheme.bg}; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 10px; box-shadow: 0 4px 10px ${topSourceTheme.shadow};">
            TOP
          </div>
        </div>
      </div>

      <div id="recentMatchList" style="display: flex; flex-direction: column; gap: 12px;">
        ${listHtml}
      </div>

      ${uniqueEntries.length > 3 ? `
        <button id="expandMatchesBtn" class="show-more-btn" onclick="toggleMoreMatches()">
          <span>显示更多 (${uniqueEntries.length - 3})</span>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      ` : ''}

      <div id="danmuPopover" class="popover-menu" onmouseleave="this.classList.remove('active')">
        <div class="popover-header">智能查看 (自动防过期)</div>
        <div class="popover-item" id="btnSmartJson" onclick="">
          <span class="item-icon" style="color:#F59E0B">{}</span> 
          <span class="popover-spinner"></span>
          <div>
            <div style="font-weight:600">JSON 格式</div>
            <div class="status-text" style="font-size:10px; opacity:0.6">过期自动重连</div>
          </div>
        </div>
        <div class="popover-item" id="btnSmartXml" onclick="">
          <span class="item-icon" style="color:#3B82F6">&lt;/&gt;</span>
          <span class="popover-spinner"></span>
          <div>
            <div style="font-weight:600">XML 格式</div>
            <div class="status-text" style="font-size:10px; opacity:0.6">兼容播放器</div>
          </div>
        </div>
      </div>

      <script>
        function toggleMoreMatches() {
          const hiddenItems = document.querySelectorAll('.match-item-hidden');
          const btn = document.getElementById('expandMatchesBtn');
          const isExpanded = btn.classList.contains('expanded');
          
          hiddenItems.forEach(item => {
            item.style.display = isExpanded ? 'none' : 'block';
            if (!isExpanded) {
              item.style.animation = 'slideInUp 0.3s ease-out';
            }
          });
          
          if (isExpanded) {
            btn.innerHTML = '<span>显示更多 (${uniqueEntries.length - 3})</span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
            btn.classList.remove('expanded');
            document.getElementById('recentMatchList').scrollIntoView({behavior: 'smooth', block: 'start'});
          } else {
            btn.innerHTML = '<span>收起列表</span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>';
            btn.classList.add('expanded');
          }
        }

        // 存储当前操作的弹幕信息
        let currentDanmuTarget = {};

        function toggleDanmuMenu(event, id, title, season, episode, source) {
          event.stopPropagation();
          event.preventDefault();
          
          const popover = document.getElementById('danmuPopover');
          if (popover.parentNode !== document.body) {
            document.body.appendChild(popover);
          }

          const btn = event.currentTarget;
          const rect = btn.getBoundingClientRect();
          
          currentDanmuTarget = { id, title, season, episode, source };
          
          const btnJson = document.getElementById('btnSmartJson');
          const btnXml = document.getElementById('btnSmartXml');
          
          resetSmartBtn(btnJson);
          resetSmartBtn(btnXml);
          
          btnJson.onclick = () => handleSmartView('json', btnJson);
          btnXml.onclick = () => handleSmartView('xml', btnXml);
          
          popover.style.top = (rect.bottom + 8) + 'px';
          if (rect.left + 180 > window.innerWidth) {
             popover.style.left = 'auto';
             popover.style.right = '16px';
          } else {
             popover.style.left = (rect.left - 20) + 'px';
          }
          
          popover.classList.add('active');
          
          const closeHandler = (e) => {
            if (!popover.contains(e.target) && !btn.contains(e.target)) {
              popover.classList.remove('active');
              document.removeEventListener('click', closeHandler);
            }
          };
          setTimeout(() => document.addEventListener('click', closeHandler), 10);
        }

        function resetSmartBtn(btn) {
          btn.classList.remove('loading');
          btn.querySelector('.status-text').textContent = btn.id.includes('Json') ? '过期自动重连' : '兼容播放器';
          btn.style.opacity = '1';
          btn.style.pointerEvents = 'auto';
        }

        // 🔥 核心智能函数：检测有效性 -> 自动重配 -> 打开页面
        async function handleSmartView(format, btnElement) {
          const { id, title, season, episode, source } = currentDanmuTarget;
          const statusText = btnElement.querySelector('.status-text');
          
          btnElement.classList.add('loading');
          statusText.textContent = '正在检测有效性...';
          
          try {
            const isUrl = id.toString().startsWith('http');
            const checkUrl = '/api/v2/comment' + (isUrl ? '?url=' + encodeURIComponent(id) : '/' + id) + '?format=json&limit=1';
            
            let finalId = id;
            let finalIsUrl = isUrl;
            let needRematch = false;

            try {
              const res = await fetch(checkUrl);
              const data = await res.json();
              if (!data.success || (data.count === 0 && !data.comments)) {
                needRematch = true;
              }
            } catch (e) {
              needRematch = true;
            }

            if (needRematch) {
              statusText.textContent = '资源过期，正在重配...';
              
              const seasonStr = season.toString().padStart(2, '0');
              const episodeStr = episode.toString().padStart(2, '0');
              const matchQuery = \`\${title}.S\${seasonStr}E\${episodeStr}\`;
              
              console.log('🔄 自动重配:', matchQuery);
              
              const matchRes = await fetch('/api/v2/match', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: matchQuery })
              });
              
              const matchData = await matchRes.json();
              
              if (matchData.success && matchData.isMatched && matchData.matches.length > 0) {
                finalId = matchData.matches[0].episodeId;
                finalIsUrl = false;
                statusText.textContent = '重配成功，正在打开...';
                if(window.showToast) window.showToast('✅ 自动修复成功，正在打开...', 'success');
              } else {
                throw new Error('无法重新匹配该资源');
              }
            } else {
              statusText.textContent = '链接有效，正在打开...';
            }

            const baseUrl = '/api/v2/comment' + (finalIsUrl ? '?url=' + encodeURIComponent(finalId) : '/' + finalId);
            const sep = finalIsUrl ? '&' : '?';
            const targetUrl = baseUrl + sep + 'format=' + format;
            
            window.open(targetUrl, '_blank');
            
            setTimeout(() => {
               document.getElementById('danmuPopover').classList.remove('active');
               resetSmartBtn(btnElement);
            }, 1000);

          } catch (error) {
            console.error('❌ 智能加载失败:', error);
            statusText.textContent = '获取失败: ' + error.message;
            statusText.style.color = '#EF4444';
            btnElement.classList.remove('loading');
            if(window.showToast) window.showToast('❌ ' + error.message, 'error');
          }
        }
      </script>
    `;

  } else {
    // 空状态
    recentMatchesHtml = `
      <div style="padding: 48px 24px; text-align: center; background: var(--bg-tertiary); border: 1px dashed var(--border-color); border-radius: 16px; display: flex; flex-direction: column; align-items: center;">
        <div style="opacity: 0.5; margin-bottom: 16px; color: var(--text-tertiary);">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1"><path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"/><path d="M12 8v4l3 3"/></svg>
        </div>
        <div style="font-size: 14px; color: var(--text-secondary);">暂无匹配记录</div>
      </div>
    `;
  }
} catch (e) {
  console.error("❌ 渲染匹配列表失败", e);
  recentMatchesHtml = `<div style="padding: 20px; color: #ef4444; font-size: 12px; text-align: center;">渲染异常: ${e.message}</div>`;
}

    const sourcesHtml = globals.sourceOrderArr.length > 0 
      ? globals.sourceOrderArr.map((source, index) => {
        const icon = sourceIcons[source.toLowerCase()] || source.charAt(0).toUpperCase();
        return `
          <div class="source-item draggable" draggable="true" data-index="${index}" data-source="${source}">
            <div class="drag-handle">
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M9 5h2v2H9V5zm0 6h2v2H9v-2zm0 6h2v2H9v-2zm4-12h2v2h-2V5zm0 6h2v2h-2v-2zm0 6h2v2h-2v-2z" fill="currentColor"/>
              </svg>
            </div>
            <div class="source-priority">${index + 1}</div>
            <div class="source-icon">${icon}</div>
            <div class="source-name">${source}</div>
          </div>
        `;
      }).join('')
      : `
        <div class="alert alert-info">
          <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>使用默认数据源顺序</span>
        </div>
      `;

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>弹幕 API 管理后台</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script>
    (function() {
      const theme = localStorage.getItem('theme') || 'light';
      document.documentElement.setAttribute('data-theme', theme);
      // 直接在 html 标签设置 class，避免闪烁
      if (theme === 'light') {
        document.documentElement.classList.add('light');
      }
    })();
  </script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      /* 主色调 - 优雅的紫蓝渐变 */
      --primary-50: #eef2ff;
      --primary-100: #e0e7ff;
      --primary-200: #c7d2fe;
      --primary-300: #a5b4fc;
      --primary-400: #818cf8;
      --primary-500: #6366f1;
      --primary-600: #4f46e5;
      --primary-700: #4338ca;
      --primary-800: #3730a3;
      --primary-900: #312e81;
      
      /* 功能色 */
      --success: #10b981;
      --success-light: #d1fae5;
      --warning: #f59e0b;
      --warning-light: #fef3c7;
      --error: #ef4444;
      --error-light: #fee2e2;
      --info: #3b82f6;
      --info-light: #dbeafe;
      
      /* 深色主题 - 更深邃的配色 */
      --bg-primary: #0a0a0f;
      --bg-secondary: #13131a;
      --bg-tertiary: #1c1c27;
      --bg-hover: #25253a;
      --bg-glass: rgba(28, 28, 39, 0.7);
      
      --text-primary: #e5e7eb;
      --text-secondary: #9ca3af;
      --text-tertiary: #6b7280;
      
      --border-color: #2d2d3f;
      --border-light: #3f3f56;
      
      /* 玻璃态效果 */
      --glass-bg: rgba(255, 255, 255, 0.05);
      --glass-border: rgba(255, 255, 255, 0.1);
      --glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
      
      /* 阴影系统 */
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -1px rgba(0, 0, 0, 0.3);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.3);
      --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.6), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
      --shadow-glow: 0 0 20px rgba(99, 102, 241, 0.3);
      
      /* 动画曲线 */
      --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
      --ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      color: var(--text-primary);
      line-height: 1.6;
      overflow-x: hidden;
      position: relative;
    }

    /* 动态背景粒子效果 */
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: 
        radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(139, 92, 246, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 40% 20%, rgba(59, 130, 246, 0.1) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
      animation: bgFloat 20s ease-in-out infinite;
    }

    @keyframes bgFloat {
      0%, 100% { transform: translate(0, 0); }
      33% { transform: translate(30px, -30px); }
      66% { transform: translate(-20px, 20px); }
    }

    /* 浅色主题 */
   html.light,
   html.light body {
     background: linear-gradient(135deg, #f8fafc 0%, #e0e7ff 100%);
   }
   
   html.light {
     --bg-primary: #f8fafc;
     --bg-secondary: #ffffff;
     --bg-tertiary: #f1f5f9;
     --bg-hover: #e2e8f0;
     --bg-glass: rgba(255, 255, 255, 0.8);
     
     --text-primary: #1e293b;
     --text-secondary: #475569;
     --text-tertiary: #94a3b8;
     
     --border-color: #e2e8f0;
     --border-light: #cbd5e1;
     
     --glass-bg: rgba(255, 255, 255, 0.7);
     --glass-border: rgba(0, 0, 0, 0.1);
     --glass-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);
     
     --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
     --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
   }

   html.light body::before {
     background: 
       radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.05) 0%, transparent 50%),
       radial-gradient(circle at 80% 80%, rgba(139, 92, 246, 0.05) 0%, transparent 50%),
       radial-gradient(circle at 40% 20%, rgba(59, 130, 246, 0.05) 0%, transparent 50%);
   }

   /* 侧边栏 - 极简现代设计 */
   .sidebar {
     position: fixed;
     left: 0;
     top: 0;
     bottom: 0;
     width: 260px;
     background: var(--bg-secondary);
     border-right: 1px solid var(--border-color);
     padding: 0;
     overflow-y: auto;
     transition: all 0.3s var(--ease-smooth);
     z-index: 1000;
     display: flex;
     flex-direction: column;
   }

   .sidebar-logo {
     padding: 32px 24px;
     border-bottom: 1px solid var(--border-color);
     flex-shrink: 0;
   }

   .logo-content {
     display: flex;
     align-items: center;
     gap: 14px;
   }

   .logo-icon {
     width: 44px;
     height: 44px;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     border-radius: 10px;
     display: flex;
     align-items: center;
     justify-content: center;
     font-size: 22px;
     color: white;
     flex-shrink: 0;
     transition: all 0.3s var(--ease-smooth);
   }

   .logo-content:hover .logo-icon {
     transform: rotate(-5deg) scale(1.05);
     box-shadow: 0 8px 20px rgba(99, 102, 241, 0.4);
   }

   .logo-text h1 {
     font-size: 18px;
     font-weight: 700;
     color: var(--text-primary);
     margin-bottom: 2px;
     letter-spacing: -0.5px;
   }

   .logo-text p {
     font-size: 11px;
     color: var(--text-tertiary);
     font-weight: 600;
     text-transform: uppercase;
     letter-spacing: 1px;
   }

   .nav-menu {
     padding: 16px 12px;
     flex: 1;
     overflow-y: auto;
   }

   .nav-item {
     display: flex;
     align-items: center;
     gap: 12px;
     padding: 12px 14px;
     margin-bottom: 4px;
     border-radius: 8px;
     color: var(--text-secondary);
     cursor: pointer;
     transition: all 0.2s var(--ease-smooth);
     font-size: 14px;
     font-weight: 500;
     position: relative;
     border: 1px solid transparent;
   }

   .nav-item:hover {
     background: var(--bg-tertiary);
     color: var(--text-primary);
     border-color: var(--border-light);
     transform: translateX(2px);
   }

   .nav-item.active {
     background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(99, 102, 241, 0.1));
     color: var(--primary-400);
     border-color: var(--primary-500);
     box-shadow: 0 2px 8px rgba(99, 102, 241, 0.15);
   }

   .nav-item svg {
     width: 20px;
     height: 20px;
     stroke-width: 2;
     flex-shrink: 0;
     transition: transform 0.2s var(--ease-smooth);
   }

   .nav-item:hover svg {
     transform: scale(1.1);
   }

   .nav-item.active svg {
     color: var(--primary-500);
     transform: scale(1.05);
   }


   /* 主内容区 */
   .main-content {
     margin-left: 280px;
     min-height: 100vh;
     transition: margin-left 0.3s var(--ease-smooth);
     position: relative;
     z-index: 1;
   }

   /* 顶部栏 - 玻璃态 */
   .topbar {
     position: sticky;
     top: 0;
     height: 72px;
     background: var(--glass-bg);
     backdrop-filter: blur(20px) saturate(180%);
     -webkit-backdrop-filter: blur(20px) saturate(180%);
     border-bottom: 1px solid var(--glass-border);
     padding: 0 32px;
     display: flex;
     align-items: center;
     justify-content: space-between;
     z-index: 100;
     box-shadow: var(--shadow-md);
   }

   .topbar-left {
     display: flex;
     align-items: center;
     gap: 20px;
   }

   .topbar-left h2 {
     font-size: 24px;
     font-weight: 700;
     color: var(--text-primary);
     background: linear-gradient(135deg, var(--primary-400), var(--primary-600));
     -webkit-background-clip: text;
     -webkit-text-fill-color: transparent;
     background-clip: text;
   }

   .topbar-right {
     display: flex;
     align-items: center;
     gap: 12px;
   }

   /* 搜索框 */
   .search-box {
     position: relative;
     width: 280px;
   }

   .search-input {
     width: 100%;
     height: 40px;
     padding: 0 40px 0 16px;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 10px;
     color: var(--text-primary);
     font-size: 14px;
     transition: all 0.3s var(--ease-smooth);
   }

   .search-input:focus {
     outline: none;
     border-color: var(--primary-500);
     box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
   }

   .search-icon {
     position: absolute;
     right: 12px;
     top: 50%;
     transform: translateY(-50%);
     color: var(--text-tertiary);
     pointer-events: none;
   }

   /* 图标按钮 */
   .icon-btn {
     width: 40px;
     height: 40px;
     border-radius: 10px;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     cursor: pointer;
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.3s var(--ease-smooth);
     color: var(--text-primary);
     position: relative;
     overflow: hidden;
   }

   .icon-btn::before {
     content: '';
     position: absolute;
     inset: 0;
     background: var(--primary-500);
     opacity: 0;
     transition: opacity 0.3s var(--ease-smooth);
   }

   .icon-btn:hover {
     border-color: var(--primary-500);
     transform: translateY(-2px);
     box-shadow: var(--shadow-md);
   }

   .icon-btn:hover::before {
     opacity: 0.1;
   }

   .icon-btn svg {
     width: 20px;
     height: 20px;
     position: relative;
     z-index: 1;
   }

   .icon-btn.delete-btn:hover {
     border-color: var(--error);
     color: var(--error);
   }

   .theme-toggle {
     position: relative;
   }

   .theme-toggle svg {
     transition: transform 0.3s var(--ease-smooth);
   }

   .theme-toggle:hover svg {
     transform: rotate(20deg);
   }

   /* 通知按钮 */
   .notification-btn {
     position: relative;
   }

   .notification-badge {
     position: absolute;
     top: -4px;
     right: -4px;
     width: 18px;
     height: 18px;
     background: var(--error);
     border-radius: 50%;
     display: flex;
     align-items: center;
     justify-content: center;
     font-size: 10px;
     font-weight: 700;
     color: white;
     border: 2px solid var(--bg-secondary);
     animation: bounce 1s ease-in-out infinite;
   }

   @keyframes bounce {
     0%, 100% { transform: scale(1); }
     50% { transform: scale(1.1); }
   }

   /* 内容容器 */
   .container {
     padding: 32px;
     max-width: 1600px;
     margin: 0 auto;
     animation: fadeInUp 0.5s var(--ease-smooth);
   }

   @keyframes fadeInUp {
     from {
       opacity: 0;
       transform: translateY(20px);
     }
     to {
       opacity: 1;
       transform: translateY(0);
     }
   }

   .page-section {
     display: none;
   }

   .page-section.active {
     display: block;
     animation: fadeIn 0.3s var(--ease-smooth);
   }

   @keyframes fadeIn {
     from {
       opacity: 0;
     }
     to {
       opacity: 1;
     }
   }

   /* 统计卡片 - 增强版 */
   .stats-grid {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
     gap: 24px;
     margin-bottom: 32px;
   }

   .stat-card {
     background: var(--glass-bg);
     backdrop-filter: blur(20px) saturate(180%);
     -webkit-backdrop-filter: blur(20px) saturate(180%);
     border: 1px solid var(--glass-border);
     border-radius: 16px;
     padding: 28px;
     transition: all 0.3s var(--ease-smooth);
     position: relative;
     overflow: hidden;
   }

   .stat-card::before {
     content: '';
     position: absolute;
     top: 0;
     left: 0;
     width: 100%;
     height: 4px;
     background: linear-gradient(90deg, var(--primary-500), var(--primary-600));
     transform: scaleX(0);
     transform-origin: left;
     transition: transform 0.3s var(--ease-smooth);
   }

   .stat-card:hover {
     transform: translateY(-4px);
     box-shadow: var(--shadow-xl);
     border-color: var(--primary-500);
   }

   .stat-card:hover::before {
     transform: scaleX(1);
   }

   .stat-header {
     display: flex;
     align-items: center;
     justify-content: space-between;
     margin-bottom: 20px;
   }

   .stat-title {
     font-size: 14px;
     color: var(--text-secondary);
     font-weight: 600;
     text-transform: uppercase;
     letter-spacing: 0.5px;
   }

   .stat-icon {
     width: 48px;
     height: 48px;
     border-radius: 12px;
     display: flex;
     align-items: center;
     justify-content: center;
     font-size: 24px;
     transition: transform 0.3s var(--ease-smooth);
   }

   .stat-card:hover .stat-icon {
     transform: scale(1.1) rotate(5deg);
   }

   .stat-icon.primary {
     background: linear-gradient(135deg, var(--primary-100), var(--primary-200));
     color: var(--primary-700);
     box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
   }

   .stat-icon.success {
     background: linear-gradient(135deg, #d1fae5, #a7f3d0);
     color: #059669;
     box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
   }

   .stat-icon.warning {
     background: linear-gradient(135deg, #fed7aa, #fbbf24);
     color: #d97706;
     box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
   }

   .stat-icon.info {
     background: linear-gradient(135deg, #dbeafe, #bfdbfe);
     color: #2563eb;
     box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
   }

   html.light .stat-icon.primary {
     background: var(--primary-100);
     color: var(--primary-600);
   }

   .stat-value {
     font-size: 36px;
     font-weight: 800;
     color: var(--text-primary);
     margin-bottom: 8px;
     line-height: 1;
     background: linear-gradient(135deg, var(--text-primary), var(--text-secondary));
     -webkit-background-clip: text;
     -webkit-text-fill-color: transparent;
     background-clip: text;
   }
   
   .stat-footer {
     font-size: 13px;
     color: var(--text-secondary);
     margin-top: 12px;
     padding-top: 12px;
     border-top: 1px solid var(--border-color);
     font-weight: 500;
     display: flex;
     align-items: center;
     gap: 6px;
   }

   .stat-trend {
     display: inline-flex;
     align-items: center;
     gap: 4px;
     padding: 2px 8px;
     border-radius: 6px;
     font-size: 12px;
     font-weight: 600;
   }

   .stat-trend.up {
     background: var(--success-light);
     color: var(--success);
   }

   .stat-trend.down {
     background: var(--error-light);
     color: var(--error);
   }

   /* 内容卡片 - 增强版 */
   .card {
     background: var(--glass-bg);
     backdrop-filter: blur(20px) saturate(180%);
     -webkit-backdrop-filter: blur(20px) saturate(180%);
     border: 1px solid var(--glass-border);
     border-radius: 16px;
     padding: 28px;
     margin-bottom: 24px;
     box-shadow: var(--shadow-md);
     transition: all 0.3s var(--ease-smooth);
   }

   .card:hover {
     box-shadow: var(--shadow-lg);
   }

   .card-header {
     display: flex;
     align-items: center;
     justify-content: space-between;
     margin-bottom: 24px;
     padding-bottom: 20px;
     border-bottom: 2px solid var(--border-color);
   }

   .card-title {
     font-size: 20px;
     font-weight: 700;
     color: var(--text-primary);
     display: flex;
     align-items: center;
     gap: 12px;
   }

   .card-title svg {
     width: 24px;
     height: 24px;
     color: var(--primary-500);
   }

   .card-actions {
     display: flex;
     gap: 8px;
   }

   /* 按钮组件 */
   .btn {
     display: inline-flex;
     align-items: center;
     justify-content: center;
     gap: 8px;
     padding: 10px 20px;
     border-radius: 10px;
     font-size: 14px;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.3s var(--ease-smooth);
     border: none;
     position: relative;
     overflow: hidden;
   }

   .btn::before {
     content: '';
     position: absolute;
     inset: 0;
     background: linear-gradient(135deg, transparent, rgba(255, 255, 255, 0.1));
     transform: translateX(-100%);
     transition: transform 0.3s var(--ease-smooth);
   }

   .btn:hover::before {
     transform: translateX(100%);
   }

   .btn-primary {
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     color: white;
     box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
   }

   .btn-primary:hover {
     transform: translateY(-2px);
     box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4);
   }

   .btn-secondary {
     background: var(--bg-tertiary);
     color: var(--text-primary);
     border: 1px solid var(--border-color);
   }

   .btn-secondary:hover {
     border-color: var(--primary-500);
     background: var(--bg-hover);
   }

   .btn-success {
     background: linear-gradient(135deg, var(--success), #059669);
     color: white;
     box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
   }

   .btn-success:hover {
     transform: translateY(-2px);
     box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4);
   }

   .btn svg {
     width: 18px;
     height: 18px;
   }

   /* 徽章 - 增强版 */
   .badge {
     display: inline-flex;
     align-items: center;
     gap: 6px;
     padding: 6px 14px;
     border-radius: 8px;
     font-size: 12px;
     font-weight: 700;
     text-transform: uppercase;
     letter-spacing: 0.5px;
     transition: all 0.3s var(--ease-smooth);
   }

   .badge-success {
     background: linear-gradient(135deg, var(--success-light), var(--success));
     color: white;
     box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
   }

   .badge-warning {
     background: linear-gradient(135deg, var(--warning-light), var(--warning));
     color: white;
     box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
   }

   .badge-secondary {
     background: var(--bg-tertiary);
     color: var(--text-secondary);
     border: 1px solid var(--border-color);
   }

   .badge-info {
     background: linear-gradient(135deg, var(--info-light), var(--info));
     color: white;
     box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
   }

   .status-dot {
     width: 8px;
     height: 8px;
     border-radius: 50%;
     background: currentColor;
     animation: statusPulse 2s ease-in-out infinite;
   }

   @keyframes statusPulse {
     0%, 100% {
       opacity: 1;
       transform: scale(1);
     }
     50% {
       opacity: 0.5;
       transform: scale(1.2);
     }
   }

   /* 配置项 - 增强版 */
   .config-grid {
     display: grid;
     gap: 16px;
   }

   .config-item {
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 12px;
     padding: 20px;
     transition: all 0.3s var(--ease-smooth);
     position: relative;
   }

   .config-item::before {
     content: '';
     position: absolute;
     left: 0;
     top: 0;
     width: 4px;
     height: 100%;
     background: var(--primary-500);
     border-radius: 12px 0 0 12px;
     transform: scaleY(0);
     transition: transform 0.3s var(--ease-smooth);
   }

   .config-item:hover {
     background: var(--bg-hover);
     border-color: var(--border-light);
     transform: translateX(4px);
   }

   .config-item:hover::before {
     transform: scaleY(1);
   }

   .config-item.editing {
     border-color: var(--primary-500);
     box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
   }

   .config-header {
     display: flex;
     align-items: center;
     justify-content: space-between;
     margin-bottom: 14px;
   }

   .config-label {
     font-size: 13px;
     font-weight: 700;
     color: var(--primary-400);
     text-transform: uppercase;
     letter-spacing: 0.8px;
   }

   .config-actions {
     display: flex;
     align-items: center;
     gap: 8px;
   }

   .tooltip-wrapper {
     position: relative;
   }

   .info-icon {
     color: var(--text-tertiary);
     cursor: help;
     transition: all 0.3s var(--ease-smooth);
   }

   .info-icon:hover {
     color: var(--primary-500);
     transform: scale(1.1);
   }

   .tooltip-content {
     position: absolute;
     bottom: calc(100% + 12px);
     right: 0;
     min-width: 280px;
     max-width: 400px;
     background: var(--bg-primary);
     border: 1px solid var(--border-color);
     border-radius: 10px;
     padding: 14px;
     font-size: 12px;
     color: var(--text-secondary);
     line-height: 1.6;
     box-shadow: var(--shadow-xl);
     opacity: 0;
     visibility: hidden;
     transition: all 0.3s var(--ease-smooth);
     z-index: 1000;
     pointer-events: none;
   }

   .tooltip-content::after {
     content: '';
     position: absolute;
     top: 100%;
     right: 20px;
     border: 8px solid transparent;
     border-top-color: var(--border-color);
   }

   .tooltip-wrapper:hover .tooltip-content {
     opacity: 1;
     visibility: visible;
     transform: translateY(-4px);
   }

   .config-value {
     font-family: 'Monaco', 'Menlo', 'Consolas', 'SF Mono', monospace;
     font-size: 13px;
     color: var(--text-primary);
     background: var(--bg-primary);
     padding: 12px 14px;
     border-radius: 8px;
     border: 1px solid var(--border-color);
     word-break: break-all;
     transition: all 0.3s var(--ease-smooth);
   }

   .config-value code {
     color: inherit;
     background: none;
   }

   .config-value.value-enabled {
     color: var(--success);
     font-weight: 700;
   }

   .config-value.value-disabled {
     color: var(--error);
     font-weight: 700;
   }

   .config-value.value-empty {
     color: var(--text-tertiary);
     font-style: italic;
   }

   .config-value.sensitive-value {
     cursor: pointer;
     position: relative;
     padding-right: 45px;
     user-select: none;
   }

   .config-value.sensitive-value:hover {
     border-color: var(--primary-500);
     background: var(--bg-secondary);
   }

   .config-value.sensitive-value.revealed {
     color: var(--warning);
     user-select: text;
   }

   .eye-icon {
     position: absolute;
     right: 14px;
     top: 50%;
     transform: translateY(-50%);
     color: var(--text-tertiary);
     opacity: 0.6;
     transition: all 0.3s var(--ease-smooth);
   }

   .sensitive-value:hover .eye-icon {
     opacity: 1;
     color: var(--primary-500);
   }

   /* 编辑按钮样式 */
   .edit-btn {
     width: 32px;
     height: 32px;
     padding: 0;
   }

   .edit-btn:hover {
     background: var(--primary-500);
     color: white;
   }

   /* 服务器列表 - 增强版 */
   .server-grid {
     display: grid;
     gap: 14px;
   }

   .server-item {
     display: flex;
     align-items: center;
     gap: 16px;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 12px;
     padding: 20px;
     transition: all 0.3s var(--ease-smooth);
     position: relative;
   }

   .server-item::before {
     content: '';
     position: absolute;
     left: 0;
     top: 0;
     width: 4px;
     height: 100%;
     background: linear-gradient(180deg, var(--primary-500), var(--primary-600));
     border-radius: 12px 0 0 12px;
     transform: scaleY(0);
     transition: transform 0.3s var(--ease-smooth);
   }

   .server-item:hover {
     background: var(--bg-hover);
     border-color: var(--primary-500);
     transform: translateX(6px);
     box-shadow: var(--shadow-md);
   }

   .server-item:hover::before {
     transform: scaleY(1);
   }

   .server-badge {
     width: 42px;
     height: 42px;
     border-radius: 10px;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     color: white;
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     font-size: 16px;
     flex-shrink: 0;
     box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
   }

   .server-badge.default-badge {
     background: linear-gradient(135deg, var(--text-tertiary), var(--text-secondary));
   }

   .server-info {
     flex: 1;
     min-width: 0;
   }

   .server-name {
     font-size: 15px;
     font-weight: 700;
     color: var(--text-primary);
     margin-bottom: 6px;
   }

   .server-url {
     font-size: 12px;
     color: var(--text-secondary);
     font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
     overflow: hidden;
     text-overflow: ellipsis;
     white-space: nowrap;
   }

   .server-actions {
     display: flex;
     gap: 8px;
     flex-shrink: 0;
   }

   /* 数据源列表 - 可拖拽 */
   .source-grid {
     display: grid;
     gap: 14px;
   }

   .source-item {
     display: flex;
     align-items: center;
     gap: 14px;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 12px;
     padding: 18px;
     transition: all 0.3s var(--ease-smooth);
     cursor: grab;
   }

   .source-item:hover {
     background: var(--bg-hover);
     border-color: var(--primary-500);
     transform: translateY(-2px);
     box-shadow: var(--shadow-md);
   }

   .source-item.dragging {
     opacity: 0.5;
     cursor: grabbing;
   }

   .source-item.drag-over {
     border-color: var(--primary-500);
     background: var(--bg-hover);
     box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
   }

   .drag-handle {
     color: var(--text-tertiary);
     cursor: grab;
     transition: all 0.3s var(--ease-smooth);
   }

   .drag-handle:active {
     cursor: grabbing;
   }

   .source-item:hover .drag-handle {
     color: var(--primary-500);
   }

   .source-priority {
     width: 32px;
     height: 32px;
     border-radius: 8px;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     color: white;
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     font-size: 14px;
     flex-shrink: 0;
     box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
   }

   .source-icon {
     width: 40px;
     height: 40px;
     border-radius: 10px;
     background: linear-gradient(135deg, var(--bg-hover), var(--bg-tertiary));
     border: 2px solid var(--border-color);
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     font-size: 16px;
     color: var(--primary-500);
     flex-shrink: 0;
     transition: all 0.3s var(--ease-smooth);
   }

   .source-item:hover .source-icon {
     transform: rotate(5deg) scale(1.1);
     border-color: var(--primary-500);
   }

   .source-name {
     font-size: 15px;
     font-weight: 700;
     color: var(--text-primary);
     flex: 1;
   }

   /* 警告框 - 增强版 */
   .alert {
     display: flex;
     align-items: flex-start;
     gap: 14px;
     padding: 18px 20px;
     border-radius: 12px;
     font-size: 14px;
     line-height: 1.6;
     animation: slideInDown 0.3s var(--ease-smooth);
   }

   @keyframes slideInDown {
     from {
       opacity: 0;
       transform: translateY(-10px);
     }
     to {
       opacity: 1;
       transform: translateY(0);
     }
   }

   .alert-icon {
     flex-shrink: 0;
     margin-top: 2px;
   }

   .alert-error {
     background: linear-gradient(135deg, var(--error-light), rgba(239, 68, 68, 0.1));
     border: 1px solid var(--error);
     color: var(--error);
   }

   .alert-info {
     background: linear-gradient(135deg, var(--info-light), rgba(59, 130, 246, 0.1));
     border: 1px solid var(--info);
     color: var(--info);
   }

   .alert-success {
     background: linear-gradient(135deg, var(--success-light), rgba(16, 185, 129, 0.1));
     border: 1px solid var(--success);
     color: var(--success);
   }

   .alert-warning {
     background: linear-gradient(135deg, var(--warning-light), rgba(245, 158, 11, 0.1));
     border: 1px solid var(--warning);
     color: var(--warning);
   }

   /* Modal 弹窗 */
   .modal-overlay {
     position: fixed;
     inset: 0;
     background: rgba(0, 0, 0, 0.7);
     backdrop-filter: blur(8px);
     -webkit-backdrop-filter: blur(8px);
     display: flex;
     align-items: center;
     justify-content: center;
     z-index: 9999;
     opacity: 0;
     visibility: hidden;
     transition: all 0.3s var(--ease-smooth);
   }

   .modal-overlay.show {
     opacity: 1;
     visibility: visible;
   }

   .modal {
     background: var(--glass-bg);
     backdrop-filter: blur(20px) saturate(180%);
     -webkit-backdrop-filter: blur(20px) saturate(180%);
     border: 1px solid var(--glass-border);
     border-radius: 20px;
     padding: 32px;
     max-width: 600px;
     width: 90%;
     max-height: 85vh;
     overflow-y: auto;
     box-shadow: var(--shadow-xl);
     transform: scale(0.9);
     transition: transform 0.3s var(--ease-bounce);
   }

   .modal-overlay.show .modal {
     transform: scale(1);
   }

   .modal-header {
     display: flex;
     align-items: center;
     justify-content: space-between;
     margin-bottom: 24px;
     padding-bottom: 20px;
     border-bottom: 2px solid var(--border-color);
   }

   .modal-title {
     font-size: 22px;
     font-weight: 700;
     color: var(--text-primary);
     display: flex;
     align-items: center;
     gap: 12px;
   }

   .modal-close {
     width: 36px;
     height: 36px;
     border-radius: 8px;
     background: var(--bg-tertiary);
     border: none;
     cursor: pointer;
     display: flex;
     align-items: center;
     justify-content: center;
     color: var(--text-secondary);
     transition: all 0.3s var(--ease-smooth);
   }

   .modal-close:hover {
     background: var(--error);
     color: white;
     transform: rotate(90deg);
   }

   .modal-body {
     margin-bottom: 24px;
   }

   .form-group {
     margin-bottom: 20px;
   }

   .form-label {
     display: block;
     font-size: 14px;
     font-weight: 600;
     color: var(--text-primary);
     margin-bottom: 10px;
   }

   .form-input,
   .form-textarea,
   .form-select {
     width: 100%;
     padding: 12px 16px;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 10px;
     color: var(--text-primary);
     font-size: 14px;
     font-family: inherit;
     transition: all 0.3s var(--ease-smooth);
   }
   /* 滑块容器 - 优化对齐版本 */
   .range-wrapper {
     position: relative;
     width: 100%;
     height: 22px;
     display: flex;
     align-items: center;
     margin: 12px 0 8px 0;
   }

   .range-progress {
     position: absolute;
     top: 50%;
     transform: translateY(-50%);
     left: 0;
     height: 8px;
     background: linear-gradient(90deg, 
       var(--primary-500) 0%, 
       var(--primary-600) 100%);
     border-radius: 10px 0 0 10px;
     pointer-events: none;
     transition: width 0.15s cubic-bezier(0.4, 0, 0.2, 1);
     z-index: 1;
     box-shadow: 0 0 8px rgba(99, 102, 241, 0.3);
   }

   /* 滑块样式 - 优化对齐版本 */
   .form-range {
     -webkit-appearance: none;
     width: 100%;
     height: 8px;
     border-radius: 10px;
     background: var(--border-color);
     outline: none;
     transition: all 0.3s var(--ease-smooth);
     position: relative;
     cursor: pointer;
     z-index: 2;
     margin: 0;
   }

   .form-range::-webkit-slider-thumb {
     -webkit-appearance: none;
     appearance: none;
     width: 22px;
     height: 22px;
     border-radius: 50%;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     cursor: pointer;
     border: 3px solid var(--bg-secondary);
     box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
     transition: all 0.2s var(--ease-smooth);
     margin-top: -7px;
   }

   .form-range::-webkit-slider-thumb:hover {
     transform: scale(1.15);
     box-shadow: 0 3px 12px rgba(99, 102, 241, 0.6);
     border-width: 4px;
   }

   .form-range::-webkit-slider-thumb:active {
     transform: scale(1.05);
     box-shadow: 0 2px 6px rgba(99, 102, 241, 0.8);
   }

   .form-range::-moz-range-thumb {
     width: 22px;
     height: 22px;
     border-radius: 50%;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     cursor: pointer;
     border: 3px solid var(--bg-secondary);
     box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
     transition: all 0.2s var(--ease-smooth);
     border: none;
   }

   .form-range::-moz-range-thumb:hover {
     transform: scale(1.15);
     box-shadow: 0 3px 12px rgba(99, 102, 241, 0.6);
   }

   .form-range::-moz-range-thumb:active {
     transform: scale(1.05);
     box-shadow: 0 2px 6px rgba(99, 102, 241, 0.8);
   }

   .form-range::-webkit-slider-runnable-track {
     width: 100%;
     height: 8px;
     cursor: pointer;
     background: transparent;
     border-radius: 10px;
   }

   .form-range::-moz-range-track {
     width: 100%;
     height: 8px;
     cursor: pointer;
     background: transparent;
     border-radius: 10px;
     border: none;
   }

   /* 滑块标签组 - 精简版 */
   .range-labels {
     display: flex;
     justify-content: space-between;
     margin-top: 8px;
     padding: 0;
     font-size: 11px;
     font-weight: 600;
     color: var(--text-tertiary);
     user-select: none;
   }

   .range-labels span {
     padding: 3px 6px;
     background: transparent;
     border-radius: 4px;
     transition: all 0.2s var(--ease-smooth);
   }

   .range-labels span:hover {
     background: var(--bg-hover);
     color: var(--text-primary);
   }

   .form-input:focus,
   .form-textarea:focus,
   .form-select:focus {
     outline: none;
     border-color: var(--primary-500);
     box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
   }

   .form-textarea {
     resize: vertical;
     min-height: 100px;
     font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
   }

   .form-hint {
     font-size: 12px;
     color: var(--text-tertiary);
     margin-top: 6px;
   }

   .modal-footer {
     display: flex;
     gap: 12px;
     justify-content: flex-end;
   }

   /* Toast 通知 - 增强版 */
   .toast-container {
     position: fixed;
     bottom: 24px;
     right: 24px;
     z-index: 99999;
     display: flex;
     flex-direction: column;
     gap: 12px;
     max-width: 400px;
   }

   .toast {
     background: var(--glass-bg);
     backdrop-filter: blur(20px) saturate(180%);
     -webkit-backdrop-filter: blur(20px) saturate(180%);
     border: 1px solid var(--glass-border);
     border-radius: 12px;
     padding: 16px 20px;
     box-shadow: var(--shadow-xl);
     display: flex;
     align-items: center;
     gap: 14px;
     font-size: 14px;
     font-weight: 600;
     animation: slideInRight 0.3s var(--ease-smooth);
     position: relative;
     overflow: hidden;
   }

   @keyframes slideInRight {
     from {
       transform: translateX(400px);
       opacity: 0;
     }
     to {
       transform: translateX(0);
       opacity: 1;
     }
   }

   .toast::before {
     content: '';
     position: absolute;
     left: 0;
     top: 0;
     width: 4px;
     height: 100%;
     background: currentColor;
   }

   .toast-success {
     color: var(--success);
   }

   .toast-error {
     color: var(--error);
   }

   .toast-warning {
     color: var(--warning);
   }

   .toast-info {
     color: var(--info);
   }

   .toast-icon {
     width: 24px;
     height: 24px;
     flex-shrink: 0;
   }

   .toast-content {
     flex: 1;
     color: var(--text-primary);
   }

   .toast-close {
     width: 24px;
     height: 24px;
     border-radius: 6px;
     background: transparent;
     border: none;
     cursor: pointer;
     display: flex;
     align-items: center;
     justify-content: center;
     color: var(--text-tertiary);
     transition: all 0.3s var(--ease-smooth);
     flex-shrink: 0;
   }

   .toast-close:hover {
     background: var(--bg-hover);
     color: var(--text-primary);
   }

   /* 图表容器 */
   .chart-container {
     position: relative;
     height: 300px;
     margin-top: 20px;
   }

   /* 页脚 */
   .footer {
     margin-top: 60px;
     padding-top: 32px;
     border-top: 2px solid var(--border-color);
     text-align: center;
     color: var(--text-tertiary);
     font-size: 14px;
     animation: fadeIn 0.5s var(--ease-smooth);
   }

   .footer p {
     margin-bottom: 8px;
   }

   /* 加载动画 */
   .loading-spinner {
     display: inline-block;
     width: 20px;
     height: 20px;
     border: 3px solid var(--border-color);
     border-top-color: var(--primary-500);
     border-radius: 50%;
     animation: spin 0.8s linear infinite;
   }

   @keyframes spin {
     to { transform: rotate(360deg); }
   }

   /* 空状态 */
   .empty-state {
     text-align: center;
     padding: 60px 20px;
     color: var(--text-tertiary);
   }

   .empty-state-icon {
     font-size: 64px;
     margin-bottom: 20px;
     opacity: 0.5;
   }

   .empty-state-title {
     font-size: 20px;
     font-weight: 600;
     color: var(--text-secondary);
     margin-bottom: 12px;
   }

   .empty-state-description {
     font-size: 14px;
     margin-bottom: 24px;
   }

   /* 桌面/移动端显示控制 */
   .desktop-only {
     display: flex;
   }

   .mobile-only {
     display: none;
   }

   @media (max-width: 768px) {
     .desktop-only {
       display: none;
     }

     .mobile-only {
       display: flex;
     }
   }

   /* 移动端适配 */
   @media (max-width: 768px) {
     .sidebar {
       transform: translateX(-100%);
     }

     .sidebar.mobile-open {
       transform: translateX(0);
     }

     .main-content {
       margin-left: 0;
     }

     .container {
       padding: 16px;
     }

     .topbar {
       padding: 0 16px;
       height: 60px;
     }

     .topbar-left {
       flex: 1;
       min-width: 0;
     }

     .topbar-left h2 {
       font-size: 16px;
       white-space: nowrap;
       overflow: hidden;
       text-overflow: ellipsis;
     }

     .topbar-right {
       gap: 8px;
     }

     .search-box {
       display: none;
     }

     .stats-grid {
       grid-template-columns: 1fr;
       gap: 12px;
     }

     .stat-card {
       padding: 20px;
     }

     .stat-value {
       font-size: 28px;
     }

     .server-item {
       flex-direction: column;
       align-items: flex-start;
       gap: 12px;
       padding: 16px;
     }

     .server-badge {
       position: absolute;
       top: 16px;
       left: 16px;
       width: 32px;
       height: 32px;
       font-size: 14px;
     }

     .server-info {
       width: 100%;
       padding-left: 48px;
     }

     .server-name {
       font-size: 14px;
     }

     .server-url {
       font-size: 11px;
       word-break: break-all;
     }

     .server-actions {
       width: 100%;
       justify-content: flex-end;
       padding-left: 48px;
     }

     .source-item {
       cursor: default;
       padding: 14px;
       gap: 10px;
     }

     .drag-handle {
       display: none;
     }

     .source-priority {
       width: 28px;
       height: 28px;
       font-size: 12px;
     }

     .source-icon {
       width: 36px;
       height: 36px;
       font-size: 14px;
     }

     .source-name {
       font-size: 14px;
     }

     .mobile-menu-btn {
       display: flex !important;
     }

     .modal {
       width: 95%;
       padding: 20px;
       max-height: 90vh;
     }

     .modal-title {
       font-size: 18px;
     }

     .form-input,
     .form-textarea,
     .form-select {
       font-size: 16px;
     }

     .toast-container {
       bottom: 12px;
       right: 12px;
       left: 12px;
       max-width: none;
     }

     .toast {
       padding: 12px 16px;
       font-size: 13px;
     }

     .card {
       padding: 16px;
       margin-bottom: 16px;
     }

     .card-header {
       flex-direction: column;
       align-items: flex-start;
       gap: 12px;
     }

     .card-title {
       font-size: 16px;
     }

     .card-actions {
       width: 100%;
     }

     .card-actions .btn {
       flex: 1;
       font-size: 13px;
       padding: 8px 12px;
     }

     .config-item {
       padding: 14px;
     }

     .config-label {
       font-size: 12px;
     }

     .config-value {
       font-size: 12px;
       padding: 10px 12px;
     }

     .fab {
       bottom: 20px;
       right: 20px;
       width: 48px;
       height: 48px;
     }

     .fab svg {
       width: 20px;
       height: 20px;
     }

     .stat-header {
       margin-bottom: 16px;
     }

     .stat-icon {
       width: 40px;
       height: 40px;
       font-size: 20px;
     }

     .stat-footer {
       font-size: 12px;
     }

     .modal-footer {
       flex-direction: column;
       gap: 8px;
     }

     .modal-footer .btn {
       width: 100%;
       justify-content: center;
     }

     .modal-footer > div {
       display: none;
     }

     .config-actions {
       gap: 6px;
     }

     .icon-btn {
       width: 36px;
       height: 36px;
     }

     .icon-btn svg {
       width: 18px;
       height: 18px;
     }

     .chart-container {
       height: 250px;
     }

     .footer {
       font-size: 12px;
       margin-top: 40px;
     }

     .keyboard-shortcut {
       display: none;
     }
   }

   .mobile-menu-btn {
     display: none;
   }


   /* 移动端遮罩 */
   .mobile-overlay {
     display: none;
     position: fixed;
     inset: 0;
     background: rgba(0, 0, 0, 0.6);
     backdrop-filter: blur(4px);
     z-index: 999;
     opacity: 0;
     transition: opacity 0.3s var(--ease-smooth);
   }

   .mobile-overlay.show {
     display: block;
     opacity: 1;
   }
   /* 快速配置专用样式 */
   .quick-config-item {
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 12px;
     padding: 20px;
     margin-bottom: 20px;
     transition: all 0.3s var(--ease-smooth);
   }

   .quick-config-item:hover {
     border-color: var(--border-light);
     box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
   }

   .config-item-header {
     display: flex;
     align-items: center;
     justify-content: space-between;
     margin-bottom: 16px;
   }

   .config-item-title {
     display: flex;
     align-items: center;
     gap: 8px;
     font-size: 15px;
     font-weight: 600;
     color: var(--text-primary);
   }

   .config-icon {
     font-size: 20px;
   }

   .config-value-display {
     color: var(--primary-400);
     font-weight: 800;
     font-size: 18px;
     font-family: 'Monaco', monospace;
     min-width: 80px;
     text-align: right;
   }

   .edit-lock-btn {
     width: 32px;
     height: 32px;
     border-radius: 8px;
     background: var(--bg-primary);
     border: 1px solid var(--border-color);
     cursor: pointer;
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.3s var(--ease-smooth);
     color: var(--text-secondary);
     position: relative;
   }

   .edit-lock-btn:hover {
     background: var(--bg-hover);
     border-color: var(--primary-500);
     color: var(--primary-500);
     transform: scale(1.05);
   }

   .edit-lock-btn.unlocked {
     background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(99, 102, 241, 0.05));
     border-color: var(--primary-500);
     color: var(--primary-500);
   }

   .edit-lock-btn.unlocked:hover {
     background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(99, 102, 241, 0.1));
   }

   .form-range.locked {
     cursor: not-allowed;
     opacity: 0.6;
   }

   .form-range.locked::-webkit-slider-thumb {
     cursor: not-allowed;
   }

   .form-range.locked::-moz-range-thumb {
     cursor: not-allowed;
   }

   .form-select.locked,
   .form-input.locked {
     cursor: not-allowed;
     opacity: 0.6;
     background: var(--bg-secondary);
   }

   /* 滚动条美化 */
   ::-webkit-scrollbar {
     width: 10px;
     height: 10px;
   }

   ::-webkit-scrollbar-track {
     background: var(--bg-primary);
     border-radius: 10px;
   }

   ::-webkit-scrollbar-thumb {
     background: linear-gradient(180deg, var(--primary-500), var(--primary-600));
     border-radius: 10px;
     border: 2px solid var(--bg-primary);
   }

   ::-webkit-scrollbar-thumb:hover {
     background: linear-gradient(180deg, var(--primary-600), var(--primary-700));
   }

   /* 进度条 */
   .progress-bar {
     width: 100%;
     height: 8px;
     background: var(--bg-tertiary);
     border-radius: 10px;
     overflow: hidden;
     margin-top: 12px;
   }

   .progress-fill {
     height: 100%;
     background: linear-gradient(90deg, var(--primary-500), var(--primary-600));
     border-radius: 10px;
     transition: width 0.3s var(--ease-smooth);
   }

   /* 开关按钮 */
   .switch {
     position: relative;
     display: inline-block;
     width: 48px;
     height: 26px;
   }

   .switch input {
     opacity: 0;
     width: 0;
     height: 0;
   }

   .switch-slider {
     position: absolute;
     cursor: pointer;
     inset: 0;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     transition: all 0.3s var(--ease-smooth);
     border-radius: 26px;
   }

   .switch-slider:before {
     position: absolute;
     content: "";
     height: 18px;
     width: 18px;
     left: 3px;
     bottom: 3px;
     background: white;
     transition: all 0.3s var(--ease-smooth);
     border-radius: 50%;
     box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
   }

   .switch input:checked + .switch-slider {
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     border-color: var(--primary-500);
   }

   .switch input:checked + .switch-slider:before {
     transform: translateX(22px);
   }

   /* 标签页 */
   .tabs {
     display: flex;
     gap: 8px;
     margin-bottom: 24px;
     border-bottom: 2px solid var(--border-color);
   }

   .tab-item {
     padding: 12px 24px;
     background: transparent;
     border: none;
     color: var(--text-secondary);
     font-size: 14px;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.3s var(--ease-smooth);
     border-bottom: 3px solid transparent;
     margin-bottom: -2px;
   }

   .tab-item:hover {
     color: var(--text-primary);
     background: var(--bg-hover);
   }

   .tab-item.active {
     color: var(--primary-500);
     border-bottom-color: var(--primary-500);
   }

   /* 分割线 */
   .divider {
     height: 1px;
     background: linear-gradient(90deg, transparent, var(--border-color), transparent);
     margin: 24px 0;
   }

   /* 快捷操作浮动按钮 */
   .fab {
     position: fixed;
     bottom: 32px;
     right: 32px;
     width: 56px;
     height: 56px;
     border-radius: 50%;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     color: white;
     border: none;
     cursor: pointer;
     display: flex;
     align-items: center;
     justify-content: center;
     box-shadow: 0 8px 24px rgba(99, 102, 241, 0.4);
     transition: all 0.3s var(--ease-smooth);
     z-index: 999;
   }

   .fab:hover {
     transform: scale(1.1) rotate(90deg);
     box-shadow: 0 12px 32px rgba(99, 102, 241, 0.5);
   }

   .fab svg {
     width: 24px;
     height: 24px;
   }

   /* 快捷键提示 */
   .keyboard-shortcut {
     display: inline-flex;
     align-items: center;
     gap: 4px;
     padding: 2px 8px;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 6px;
     font-size: 12px;
     font-weight: 600;
     color: var(--text-secondary);
     font-family: 'Monaco', 'Menlo', monospace;
   }
/* 标签页内容 */
   .source-tab-content {
     display: none;
     animation: fadeIn 0.3s var(--ease-smooth);
   }

   .source-tab-content.active {
     display: block;
   }

   /* 现代化源列表网格 */
   .source-modern-grid {
     display: grid;
     gap: 16px;
     grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
   }

   @media (max-width: 768px) {
     .source-modern-grid {
       grid-template-columns: 1fr;
     }
   }

   /* 现代化源卡片 */
   .source-modern-item {
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 12px;
     padding: 18px;
     transition: all 0.3s var(--ease-smooth);
     cursor: grab;
     position: relative;
     display: flex;
     align-items: center;
     gap: 14px;
   }

   .source-modern-item:hover {
     background: var(--bg-hover);
     border-color: var(--primary-500);
     transform: translateY(-2px);
     box-shadow: var(--shadow-md);
   }

   .source-modern-item.dragging {
     opacity: 0.5;
     cursor: grabbing;
   }

   .source-modern-item.drag-over {
     border-color: var(--primary-500);
     background: var(--bg-hover);
     box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
   }

   .source-modern-item.disabled {
     opacity: 0.5;
     background: var(--bg-secondary);
   }

   .source-modern-item.disabled .source-modern-name {
     text-decoration: line-through;
     color: var(--text-tertiary);
   }

   /* 拖拽手柄 */
   .source-modern-handle {
     color: var(--text-tertiary);
     cursor: grab;
     transition: all 0.3s var(--ease-smooth);
     flex-shrink: 0;
   }

   .source-modern-handle:active {
     cursor: grabbing;
   }

   .source-modern-item:hover .source-modern-handle {
     color: var(--primary-500);
   }

   /* 源优先级徽章 */
   .source-modern-priority {
     width: 32px;
     height: 32px;
     border-radius: 8px;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     color: white;
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     font-size: 14px;
     flex-shrink: 0;
     box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
   }

   /* 源图标 */
   .source-modern-icon {
     width: 40px;
     height: 40px;
     border-radius: 10px;
     background: linear-gradient(135deg, var(--bg-hover), var(--bg-tertiary));
     border: 2px solid var(--border-color);
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     font-size: 16px;
     color: var(--primary-500);
     flex-shrink: 0;
     transition: all 0.3s var(--ease-smooth);
   }

   .source-modern-item:hover .source-modern-icon {
     transform: rotate(5deg) scale(1.1);
     border-color: var(--primary-500);
   }

   /* 源信息 */
   .source-modern-info {
     flex: 1;
     min-width: 0;
   }

   .source-modern-name {
     font-size: 15px;
     font-weight: 700;
     color: var(--text-primary);
     margin-bottom: 4px;
   }

   .source-modern-desc {
     font-size: 12px;
     color: var(--text-tertiary);
     line-height: 1.4;
   }

   /* 源状态开关 */
   .source-modern-toggle {
     flex-shrink: 0;
   }

   .source-modern-toggle .switch {
     width: 44px;
     height: 24px;
   }

   .source-modern-toggle .switch-slider:before {
     width: 16px;
     height: 16px;
     left: 3px;
     bottom: 3px;
   }

   .source-modern-toggle .switch input:checked + .switch-slider:before {
     transform: translateX(20px);
   }
   /* 日志容器样式 - 增强版 */
   .log-container {
     background: var(--bg-primary);
     border: 1px solid var(--border-color);
     border-radius: 12px;
     padding: 0;
     min-height: 400px;
     max-height: 650px;
     overflow: hidden;
     font-family: 'Monaco', 'Menlo', 'Consolas', 'SF Mono', monospace;
     display: flex;
     flex-direction: column;
   }

   .log-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     padding: 14px 16px;
     border-bottom: 2px solid var(--border-color);
     flex-wrap: wrap;
     gap: 12px;
     background: var(--bg-secondary);
     border-radius: 12px 12px 0 0;
     flex-shrink: 0;
     position: sticky;
     top: 0;
     z-index: 10;
     backdrop-filter: blur(10px);
   }

   .log-header-title {
     display: flex;
     align-items: center;
     gap: 10px;
     font-weight: 600;
     font-size: 13px;
     color: var(--text-primary);
   }

   .log-status-badge {
     display: inline-flex;
     align-items: center;
     gap: 5px;
     padding: 4px 10px;
     border-radius: 6px;
     font-size: 11px;
     font-weight: 700;
     text-transform: uppercase;
     letter-spacing: 0.5px;
   }

   .log-status-badge.paused {
     background: rgba(245, 158, 11, 0.15);
     color: var(--warning);
     border: 1px solid var(--warning);
   }

   .log-status-badge.running {
     background: rgba(16, 185, 129, 0.15);
     color: var(--success);
     border: 1px solid var(--success);
     animation: statusPulse 2s ease-in-out infinite;
   }

   .log-content-wrapper {
     flex: 1;
     overflow-y: auto;
     padding: 12px 16px;
     background: var(--bg-primary);
     border-radius: 0 0 12px 12px;
     position: relative;
   }

   .log-content-wrapper.paused::after {
     content: '⏸️ 已暂停 - 点击恢复继续滚动';
     position: absolute;
     top: 12px;
     right: 16px;
     background: rgba(245, 158, 11, 0.9);
     color: white;
     padding: 6px 12px;
     border-radius: 6px;
     font-size: 11px;
     font-weight: 700;
     box-shadow: 0 2px 8px rgba(245, 158, 11, 0.4);
     animation: fadeInDown 0.3s ease-out;
     pointer-events: none;
   }

   @keyframes fadeInDown {
     from {
       opacity: 0;
       transform: translateY(-10px);
     }
     to {
       opacity: 1;
       transform: translateY(0);
     }
   }

   .log-content-wrapper::-webkit-scrollbar {
     width: 8px;
   }

   .log-content-wrapper::-webkit-scrollbar-track {
     background: var(--bg-tertiary);
     border-radius: 0 0 8px 0;
   }

   .log-content-wrapper::-webkit-scrollbar-thumb {
     background: linear-gradient(180deg, var(--primary-500), var(--primary-600));
     border-radius: 10px;
     border: 2px solid var(--bg-tertiary);
   }

   .log-content-wrapper::-webkit-scrollbar-thumb:hover {
     background: linear-gradient(180deg, var(--primary-600), var(--primary-700));
   }

   .log-controls {
     display: flex;
     gap: 8px;
     flex-wrap: wrap;
     align-items: center;
   }

   .log-control-group {
     display: flex;
     gap: 6px;
     align-items: center;
   }

   .log-control-divider {
     width: 1px;
     height: 24px;
     background: var(--border-color);
     margin: 0 4px;
   }

   .log-filter {
     padding: 5px 12px;
     border-radius: 6px;
     border: 1px solid var(--border-color);
     background: var(--bg-tertiary);
     color: var(--text-secondary);
     cursor: pointer;
     font-size: 12px;
     font-weight: 600;
     transition: all 0.3s var(--ease-smooth);
     white-space: nowrap;
   }

   .log-filter:hover {
     border-color: var(--primary-500);
     background: var(--bg-hover);
     color: var(--text-primary);
     transform: translateY(-1px);
   }

   .log-filter.active {
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     color: white;
     border-color: var(--primary-500);
     box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
   }

   .log-action-btn {
     padding: 6px 12px;
     border-radius: 6px;
     border: 1px solid var(--border-color);
     background: var(--bg-tertiary);
     color: var(--text-primary);
     cursor: pointer;
     font-size: 12px;
     font-weight: 600;
     transition: all 0.3s var(--ease-smooth);
     display: inline-flex;
     align-items: center;
     gap: 5px;
     white-space: nowrap;
   }

   .log-action-btn:hover {
     border-color: var(--primary-500);
     background: var(--bg-hover);
     transform: translateY(-1px);
   }

   .log-action-btn.pause-btn.active {
     background: linear-gradient(135deg, var(--warning), #f59e0b);
     color: white;
     border-color: var(--warning);
     box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
   }

   .log-action-btn.clear-btn:hover {
     background: var(--error);
     color: white;
     border-color: var(--error);
   }

   .log-line {
     padding: 8px 12px;
     line-height: 1.5;
     word-break: break-all;
     font-size: 12px;
     color: var(--text-secondary);
     transition: all 0.2s var(--ease-smooth);
     border: none;
     background: transparent;
     margin-bottom: 2px;
     border-radius: 6px;
     border-left: 3px solid transparent;
     animation: slideInFromLeft 0.3s ease-out;
   }

   @keyframes slideInFromLeft {
     from {
       opacity: 0;
       transform: translateX(-10px);
     }
     to {
       opacity: 1;
       transform: translateX(0);
     }
   }

   .log-line:hover {
     background: var(--bg-hover);
     color: var(--text-primary);
     transform: translateX(2px);
   }

   .log-line.info {
     color: var(--info);
   }

   .log-line.info:hover {
     border-left-color: var(--info);
     background: rgba(59, 130, 246, 0.05);
   }

   .log-line.warn {
     color: var(--warning);
   }

   .log-line.warn:hover {
     border-left-color: var(--warning);
     background: rgba(245, 158, 11, 0.05);
   }

   .log-line.error {
     color: var(--error);
   }

   .log-line.error:hover {
     border-left-color: var(--error);
     background: rgba(239, 68, 68, 0.05);
   }

   .log-timestamp {
     opacity: 0.6;
     margin-right: 8px;
     font-size: 10px;
     color: var(--text-tertiary);
   }

   .log-level {
     display: inline-block;
     padding: 0 4px;
     font-size: 10px;
     font-weight: 700;
     margin-right: 8px;
     text-transform: uppercase;
   }

   .log-line.info .log-level {
     color: var(--info);
   }

   .log-line.warn .log-level {
     color: var(--warning);
   }

   .log-line.error .log-level {
     color: var(--error);
   }

   .log-stats {
     display: flex;
     align-items: center;
     gap: 12px;
     font-size: 11px;
     color: var(--text-tertiary);
     margin-left: auto;
   }

   .log-stat-item {
     display: flex;
     align-items: center;
     gap: 4px;
     padding: 4px 8px;
     background: var(--bg-tertiary);
     border-radius: 5px;
     border: 1px solid var(--border-color);
   }

   /* 移动端适配 */
   @media (max-width: 768px) {
     .log-container {
       min-height: 300px;
       max-height: 500px;
       padding: 10px;
     }

     .log-header {
       flex-direction: column;
       align-items: flex-start;
     }

     .log-controls {
       width: 100%;
     }

     .log-filter {
       flex: 1;
       text-align: center;
       min-width: 60px;
     }

     .log-line {
       font-size: 10px;
       line-height: 1.2;
     }

     .log-timestamp {
       font-size: 9px;
     }

     .log-level {
       font-size: 9px;
     }
   }

   /* 数据表格 */
   .data-table {
     width: 100%;
     border-collapse: separate;
     border-spacing: 0;
     margin-top: 16px;
   }

   .data-table th {
     background: var(--bg-tertiary);
     color: var(--text-secondary);
     font-size: 13px;
     font-weight: 700;
     text-transform: uppercase;
     letter-spacing: 0.5px;
     padding: 14px 16px;
     text-align: left;
     border-bottom: 2px solid var(--border-color);
   }

   .data-table th:first-child {
     border-radius: 10px 0 0 0;
   }

   .data-table th:last-child {
     border-radius: 0 10px 0 0;
   }

   .data-table td {
     padding: 14px 16px;
     border-bottom: 1px solid var(--border-color);
     color: var(--text-primary);
     font-size: 14px;
   }

   .data-table tr:hover td {
     background: var(--bg-hover);
   }

   /* 代码块 */
   .code-block {
     background: var(--bg-primary);
     border: 1px solid var(--border-color);
     border-radius: 10px;
     padding: 16px;
     margin: 16px 0;
     overflow-x: auto;
     font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
     font-size: 13px;
     line-height: 1.6;
     color: var(--text-primary);
   }

   .code-block pre {
     margin: 0;
   }

   /* 动画类 */
   .fade-in {
     animation: fadeIn 0.3s var(--ease-smooth);
   }

   .slide-in-up {
     animation: slideInUp 0.3s var(--ease-smooth);
   }

   @keyframes slideInUp {
     from {
       opacity: 0;
       transform: translateY(20px);
     }
     to {
       opacity: 1;
       transform: translateY(0);
     }
   }

   .scale-in {
     animation: scaleIn 0.3s var(--ease-bounce);
   }

   @keyframes scaleIn {
     from {
       opacity: 0;
       transform: scale(0.9);
     }
     to {
       opacity: 1;
       transform: scale(1);
     }
   }

   /* ========== 新增：弹幕测试页面样式 ========== */
   /* 优化后的手动搜索布局 - 单视图切换模式 */
   .manual-search-container {
     position: relative;
     min-height: 400px;
     background: var(--bg-tertiary);
     border: 1px solid var(--border-color);
     border-radius: 16px;
     overflow: hidden;
   }

   /* 视图容器 */
   .search-view {
     width: 100%;
     height: 100%;
     padding: 20px;
     transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
     opacity: 1;
   }

   .search-view.hidden-left {
     transform: translateX(-20%);
     opacity: 0;
     pointer-events: none;
     position: absolute;
     top: 0;
     left: 0;
     visibility: hidden;
   }

   .search-view.hidden-right {
     transform: translateX(20%);
     opacity: 0;
     pointer-events: none;
     position: absolute;
     top: 0;
     left: 0;
     visibility: hidden;
   }
   
   .search-view.active {
     position: relative;
     transform: translateX(0);
     opacity: 1;
     visibility: visible;
     z-index: 1;
   }

   /* 动漫网格列表 */
   .anime-grid {
     display: grid;
     grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
     gap: 16px;
     padding-bottom: 20px;
     align-items: start;
   }

   .anime-card {
     background: var(--bg-primary);
     border: 1px solid var(--border-color);
     border-radius: 12px;
     overflow: hidden;
     cursor: pointer;
     transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
     display: flex;
     flex-direction: column;
     box-shadow: var(--shadow-sm);
     height: 100%;
     position: relative;
   }

   .anime-card:hover {
     transform: translateY(-4px);
     border-color: var(--primary-500);
     box-shadow: 0 12px 24px -8px rgba(99, 102, 241, 0.3);
   }

   .anime-cover-wrapper {
     position: relative;
     width: 100%;
     aspect-ratio: 2/3;
     overflow: hidden;
     background: var(--bg-secondary);
   }

   .anime-cover {
     width: 100%;
     height: 100%;
     object-fit: cover;
     transition: transform 0.5s ease;
   }

   .anime-card:hover .anime-cover {
     transform: scale(1.08);
   }

   /* 类型角标 */
   .anime-badge {
     position: absolute;
     top: 6px;
     right: 6px;
     background: rgba(0, 0, 0, 0.65);
     backdrop-filter: blur(4px);
     color: white;
     font-size: 10px;
     padding: 2px 6px;
     border-radius: 4px;
     font-weight: 600;
     z-index: 2;
     border: 0.5px solid rgba(255,255,255,0.2);
   }

   .anime-info {
     padding: 10px;
     flex: 1;
     display: flex;
     flex-direction: column;
     gap: 6px;
   }

   .anime-title {
     font-size: 14px;
     font-weight: 600;
     color: var(--text-primary);
     display: -webkit-box;
     -webkit-line-clamp: 2;
     -webkit-box-orient: vertical;
     overflow: hidden;
     line-height: 1.4;
     margin-bottom: auto;
   }

   .anime-tags {
     display: flex;
     flex-wrap: wrap;
     gap: 4px;
     margin-top: 4px;
   }

   .anime-tag {
     font-size: 10px;
     padding: 2px 6px;
     border-radius: 4px;
     background: var(--bg-secondary);
     color: var(--text-secondary);
     border: 1px solid var(--border-color);
     white-space: nowrap;
   }

   .anime-tag.highlight {
     background: rgba(99, 102, 241, 0.1);
     color: var(--primary-400);
     border-color: rgba(99, 102, 241, 0.2);
   }

   /* 剧集列表视图样式 */
   .episode-view-header {
     display: flex;
     align-items: center;
     gap: 16px;
     margin-bottom: 24px;
     padding-bottom: 16px;
     border-bottom: 1px solid var(--border-color);
     position: sticky;
     top: 0;
     background: var(--bg-tertiary);
     z-index: 10;
     padding-top: 10px;
     margin-top: -10px;
   }

   .back-btn {
     display: flex;
     align-items: center;
     gap: 6px;
     padding: 8px 14px;
     background: var(--bg-secondary);
     border: 1px solid var(--border-color);
     border-radius: 8px;
     color: var(--text-secondary);
     font-size: 13px;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.2s;
     flex-shrink: 0;
   }

   .back-btn:hover {
     background: var(--bg-hover);
     color: var(--text-primary);
     border-color: var(--text-tertiary);
     transform: translateX(-2px);
   }

   .selected-anime-info {
     flex: 1;
     overflow: hidden;
   }

   .selected-anime-title {
     font-size: 18px;
     font-weight: 700;
     color: var(--text-primary);
     white-space: nowrap;
     overflow: hidden;
     text-overflow: ellipsis;
   }

   /* 优化后的剧集容器 */
   .episode-grid {
     display: grid;
     grid-template-columns: repeat(auto-fill, minmax(75px, 1fr));
     gap: 10px;
     max-height: 550px;
     overflow-y: auto;
     padding-right: 4px;
     padding-bottom: 20px;
     transition: all 0.3s ease;
   }

   /* 列表模式样式 */
   .episode-grid.list-mode {
     grid-template-columns: 1fr;
     gap: 8px;
   }

   .episode-btn {
     padding: 12px 4px;
     background: var(--bg-primary);
     border: 1px solid var(--border-color);
     border-radius: 8px;
     color: var(--text-primary);
     font-size: 14px;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
     text-align: center;
     white-space: nowrap;
     overflow: hidden;
     text-overflow: ellipsis;
     user-select: none;
     position: relative;
     display: flex;
     align-items: center;
     justify-content: center;
   }

   /* 列表模式下的按钮样式 - 优化对齐 */
   .episode-btn.list-mode {
     padding: 10px 16px;
     justify-content: flex-start; /* 改为左对齐 */
     text-align: left;
     gap: 15px; /* 增加集数和标题的间距 */
   }

   .episode-btn .ep-title {
     display: none;
   }

   /* 列表模式 - 集数样式 */
   .episode-btn.list-mode .ep-num {
     font-size: 16px;
     font-weight: 700;
     color: var(--primary-500);
     min-width: 45px; /* 固定宽度确保对齐 */
     text-align: center;
   }
   
   .episode-btn.list-mode.active .ep-num {
     color: white;
   }

   /* 列表模式 - 标题样式 */
   .episode-btn.list-mode .ep-title {
     display: block;
     font-size: 14px;
     color: var(--text-primary); /* 颜色加深一点 */
     font-weight: normal;
     white-space: nowrap;
     overflow: hidden;
     text-overflow: ellipsis;
     flex: 1;
     text-align: left; /* 关键：改为左对齐 */
     opacity: 0.8;
   }
   
   .episode-btn.list-mode:hover .ep-title {
     opacity: 1;
     color: var(--primary-500);
   }
   
   .episode-btn.list-mode.active .ep-title {
     color: rgba(255,255,255,0.9);
     opacity: 1;
   }
   
   .episode-btn.list-mode.active .ep-title {
     color: rgba(255,255,255,0.9);
   }

   .episode-btn:hover {
     background: var(--bg-hover);
     border-color: var(--primary-500);
     transform: translateY(-2px);
     box-shadow: 0 4px 12px rgba(99, 102, 241, 0.15);
     color: var(--primary-500);
   }

   .episode-btn.active {
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     border-color: var(--primary-500);
     color: white;
     box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
   }
   
   /* 视图切换按钮 */
   .view-toggle-btn {
     margin-left: auto;
     background: var(--bg-hover);
     border: 1px solid var(--border-color);
     border-radius: 8px;
     width: 32px; 
     height: 32px;
     display: flex; 
     align-items: center; 
     justify-content: center;
     cursor: pointer;
     color: var(--text-secondary);
     transition: all 0.2s;
   }
   .view-toggle-btn:hover, .view-toggle-btn.active {
     color: var(--primary-500);
     border-color: var(--primary-500);
     background: var(--bg-secondary);
   }

   /* 移动端适配优化 */
   @media (max-width: 768px) {
     .manual-search-container {
       border: none;
       background: transparent;
       border-radius: 0;
       min-height: auto;
     }

     .search-view {
       padding: 0;
     }
     
     /* 移动端网格更紧凑 */
     .anime-grid {
       grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
       gap: 10px;
     }
     
     .anime-title {
       font-size: 12px;
       line-height: 1.3;
       -webkit-line-clamp: 2;
     }

     .anime-tag {
       font-size: 9px;
       padding: 1px 4px;
     }

     .episode-view-header {
       gap: 10px;
       margin-bottom: 12px;
       padding-bottom: 10px;
       background: var(--bg-primary); /* 移动端背景适配 */
       border-bottom: 1px solid var(--border-color);
       margin-left: -16px;
       margin-right: -16px;
       padding-left: 16px;
       padding-right: 16px;
     }

     .selected-anime-title {
       font-size: 15px;
     }
     
     .back-btn {
       padding: 6px 10px;
       font-size: 12px;
     }
     
     .episode-grid {
       grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
       max-height: none;
       gap: 8px;
     }

     .episode-btn {
        padding: 10px 2px;
        font-size: 12px;
        border-radius: 6px;
     }
   }

   /* 匹配结果卡片动画 */
     @keyframes slideInFromLeft {
       from {
         opacity: 0;
         transform: translateX(-30px);
       }
       to {
         opacity: 1;
         transform: translateX(0);
       }
     }

     /* 加载动画优化 */
     .loading-spinner {
       animation: spin 1s cubic-bezier(0.68, -0.55, 0.265, 1.55) infinite;
     }

     @keyframes spin {
       0% { transform: rotate(0deg); }
       100% { transform: rotate(360deg); }
     }
   /* ========== 优化：播放按钮特效 ========== */
   .btn-play-pulse {
     background: linear-gradient(135deg, var(--primary-500), #8b5cf6);
     color: white;
     box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.7);
     animation: pulse-purple 2s infinite;
     border: none;
     font-weight: 600;
   }
   
   .btn-play-pulse:hover {
     animation: none;
     transform: translateY(-2px);
     box-shadow: 0 6px 20px rgba(139, 92, 246, 0.4);
   }

   @keyframes pulse-purple {
     0% {
       transform: scale(0.95);
       box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.7);
     }
     70% {
       transform: scale(1);
       box-shadow: 0 0 0 10px rgba(139, 92, 246, 0);
     }
     100% {
       transform: scale(0.95);
       box-shadow: 0 0 0 0 rgba(139, 92, 246, 0);
     }
   }
   /* ========== 优化：高级设置折叠与轮廓按钮 ========== */
   .advanced-toggle {
     display: flex;
     align-items: center;
     gap: 6px;
     font-size: 13px;
     color: var(--primary-500);
     cursor: pointer;
     background: none;
     border: none;
     padding: 8px 0;
     margin-bottom: 8px;
     font-weight: 600;
     transition: all 0.2s;
   }
   
   .advanced-toggle:hover {
     color: var(--primary-600);
     opacity: 0.8;
   }
   
   .advanced-toggle svg {
     transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
   }
   
   .advanced-toggle.active svg {
     transform: rotate(180deg);
   }
   
   .advanced-options {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
     gap: 12px;
     max-height: 0;
     overflow: hidden;
     opacity: 0;
     transform: translateY(-10px);
     transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
     margin-bottom: 0;
   }
   
   .advanced-options.show {
     max-height: 500px; /* 足够的高度 */
     opacity: 1;
     transform: translateY(0);
     margin-bottom: 16px;
     padding-bottom: 4px;
   }

   /* 轮廓按钮 (用于查看源码) */
   .btn-outline {
     background: transparent;
     border: 1px solid var(--border-color);
     color: var(--text-secondary);
     transition: all 0.2s;
   }
   
   .btn-outline:hover {
     border-color: var(--primary-500);
     color: var(--primary-500);
     background: rgba(99, 102, 241, 0.05);
   }
/* 最近匹配卡片移动端优化 */
@media (max-width: 768px) {
  .server-grid > div[style*="position: relative"] {
    padding: 10px !important;
    gap: 10px !important;
  }
  
  .server-grid > div[style*="width: 48px"] {
    width: 40px !important;
    height: 40px !important;
  }
  
  .server-grid > div[style*="font-size: 14px"] {
    font-size: 13px !important;
  }
  
  .server-grid > div[style*="font-size: 12px"] {
    font-size: 11px !important;
  }
}
 </style>
</head>
<body>
 <!-- Toast 容器 -->
 <div class="toast-container" id="toastContainer"></div>

 <!-- 移动端遮罩 -->
 <div class="mobile-overlay" id="mobileOverlay" onclick="closeMobileMenu()"></div>

 <!-- 侧边栏 -->
 <aside class="sidebar" id="sidebar">
   <div class="sidebar-logo">
     <div class="logo-content">
       <div class="logo-icon">🎬</div>
       <div class="logo-text">
         <h1>弹幕 API</h1>
         <p>v${globals.VERSION}</p>
       </div>
     </div>
   </div>
   
   <nav class="nav-menu">
     <div class="nav-item active" onclick="switchPage('overview')">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
         <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" stroke-width="2"/>
       </svg>
       <span>概览</span>
     </div>
     
     <div class="nav-item" onclick="switchPage('config')">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
         <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke-width="2"/>
         <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke-width="2"/>
       </svg>
       <span>环境配置</span>
     </div>
            
       <div class="nav-item" onclick="switchPage('sources')">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" stroke-width="2"/>
         </svg>
         <span>搜索源管理</span>
       </div>
       
       <div class="nav-item" onclick="switchPage('danmuTest')">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" stroke-width="2"/>
         </svg>
         <span>弹幕测试</span>
       </div>

       <div class="nav-item" onclick="switchPage('push')">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M5 10l7-7m0 0l7 7m-7-7v18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
         </svg>
         <span>推送管理</span>
       </div>
       
       <div class="nav-item" onclick="switchPage('cache')">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" stroke-width="2"/>
         </svg>
         <span>缓存管理</span>
       </div>
       
       <div class="nav-item" onclick="switchPage('about')">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
         </svg>
         <span>关于</span>
       </div>
     </nav>
   </aside>

 <!-- 主内容区 -->
 <main class="main-content">
   <!-- 顶部栏 -->
   <header class="topbar">
     <div class="topbar-left">
       <button class="mobile-menu-btn icon-btn" onclick="toggleMobileMenu()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M4 6h16M4 12h16M4 18h16" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
       <h2 id="pageTitle">系统概览</h2>
     </div>
       <div class="topbar-right">
         <div class="search-box">
           <input type="text" class="search-input" placeholder="搜索配置..." id="globalSearch">
           <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor">
             <circle cx="11" cy="11" r="8" stroke-width="2"/>
             <path d="m21 21-4.35-4.35" stroke-width="2" stroke-linecap="round"/>
           </svg>
         </div>
         <!-- 日志按钮 -->
         <button class="icon-btn" onclick="showLogsModal()" title="查看日志 (Ctrl+L)">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
             <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" stroke-width="2" stroke-linecap="round"/>
           </svg>
         </button>
         <!-- 桌面端显示通知按钮 -->
         <button class="icon-btn notification-btn desktop-only" title="通知">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
             <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" stroke-width="2" stroke-linecap="round"/>
           </svg>
           <span class="notification-badge">3</span>
         </button>
         <!-- 移动端显示搜索按钮 -->
         <button class="icon-btn mobile-search-btn mobile-only" onclick="toggleMobileSearch()" title="搜索">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
             <circle cx="11" cy="11" r="8" stroke-width="2"/>
             <path d="m21 21-4.35-4.35" stroke-width="2" stroke-linecap="round"/>
           </svg>
         </button>
         <button class="icon-btn theme-toggle" onclick="toggleTheme()" title="切换主题 (Ctrl+K)">
           <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
             <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke-width="2"/>
           </svg>
         </button>
         <button class="icon-btn" onclick="showChangePasswordModal()" title="修改密码">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
             <path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" stroke-width="2"/>
           </svg>
         </button>
         <button class="icon-btn" onclick="logout()" title="退出登录">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
             <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" stroke-width="2" stroke-linecap="round"/>
            </svg>
         </button>
       </div>
   </header>

   <!-- 内容容器 -->
   <div class="container">
     <!-- 概览页面 -->
     <section id="overview-page" class="page-section active">
              <div class="stats-grid">
         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">环境变量</span>
             <div class="stat-icon primary">⚙️</div>
           </div>
           <div class="stat-value">${configuredEnvCount}/${totalEnvCount}</div>
           <div class="stat-footer" style="display: flex; align-items: center; justify-content: space-between;">
             <span>${sensitiveEnvCount > 0 ? `🔒 隐私变量: ${sensitiveEnvCount} 个` : '已配置 / 总数'}</span>
             <button onclick="showAllEnvVars()" class="icon-btn" style="width: 32px; height: 32px; margin-left: auto;" title="查看完整配置 (JSON)">
               <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" stroke-width="2" stroke-linecap="round"/>
               </svg>
             </button>
           </div>
         </div>
         
         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">部署平台</span>
             <div class="stat-icon warning">🚀</div>
           </div>
           <div class="stat-value">${
             process.env.VERCEL ? 'Vercel' :
             process.env.NETLIFY ? 'Netlify' :
             process.env.CF_PAGES ? 'Cloudflare Pages' :
             (typeof caches !== 'undefined' && 'default' in caches) ? 'Cloudflare Workers' :
             process.env.RENDER ? 'Render' :
             process.env.RAILWAY_ENVIRONMENT ? 'Railway' :
             process.env.KUBERNETES_SERVICE_HOST ? 'Kubernetes' :
             '标准部署'
           }</div>
           <div class="stat-footer">
             ${
               process.env.VERCEL ? '▲ Vercel 部署' :
               process.env.NETLIFY ? '🌐 Netlify 部署' :
               process.env.CF_PAGES ? '☁️ CF Pages' :
               (typeof caches !== 'undefined' && 'default' in caches) ? '⚡ CF Workers' :
               process.env.RENDER ? '🎨 Render 部署' :
               process.env.RAILWAY_ENVIRONMENT ? '🚂 Railway 部署' :
               process.env.KUBERNETES_SERVICE_HOST ? '☸️ K8s 部署' :
               '🐳 容器/本地'
             }
           </div>
         </div>
         
         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">API版本</span>
             <div class="stat-icon info">🚀</div>
           </div>
           <div class="stat-value">v${globals.VERSION}</div>
           <div class="stat-footer" style="display: flex; align-items: center; justify-content: space-between;">
             <div id="versionStatus" style="flex: 1;">
               <span class="loading-spinner" style="display: inline-block; margin-right: 6px;"></span>
               正在检查更新...
             </div>
             <div style="display: flex; gap: 8px; align-items: center;">
               <button onclick="checkForUpdates()" class="icon-btn" style="width: 32px; height: 32px; flex-shrink: 0;" title="手动检查更新">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 16px; height: 16px;">
                   <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                 </svg>
               </button>
               <button id="updateBtn" onclick="performUpdate()" class="icon-btn" style="width: 32px; height: 32px; flex-shrink: 0; display: none; background: var(--warning); border-color: var(--warning);" title="一键更新">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 16px; height: 16px;">
                   <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                 </svg>
               </button>
             </div>
           </div>
         </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
             </svg>
             系统状态
           </h3>
           <div style="display: flex; align-items: center; gap: 12px;">
             <span class="badge badge-success">
               <span class="status-dot"></span>运行正常
             </span>
             <button class="btn btn-primary" onclick="showQuickConfig()" style="padding: 8px 16px; font-size: 13px;">
               <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" stroke-width="2" stroke-linecap="round"/>
               </svg>
               快速配置
             </button>
           </div>
         </div>
         <div class="config-grid">
              <div class="config-item">
                <div class="config-header">
                  <span class="config-label">API 地址</span>
                  <button class="icon-btn" onclick="copyApiUrl(event)" title="复制 API 地址">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-width="2"/>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke-width="2"/>
                    </svg>
                  </button>
                </div>
                <div class="config-value sensitive-value" id="apiUrlDisplay" onclick="toggleApiUrl()" ondblclick="copyApiUrl(event)" title="点击显示/隐藏完整地址，双击复制">
                  <code id="apiUrlText" style="word-break: break-all;"></code>
                  <svg class="eye-icon" viewBox="0 0 24 24" width="16" height="16">
                    <path fill="none" stroke="currentColor" stroke-width="2" d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                    <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
                  </svg>
                </div>
              </div>

              <div class="config-item">
                <div class="config-header">
                  <span class="config-label">持久化存储</span>
                  <span class="badge ${
                    globals.databaseValid ? 'badge-success' : 
                    (redisConfigured && globals.redisValid) ? 'badge-success' : 
                    'badge-secondary'
                  }">
                    <span class="status-dot"></span>
                    <span>${
                      globals.databaseValid ? '数据库在线' : 
                      (redisConfigured && globals.redisValid) ? 'Redis在线' : 
                      '未启用'
                    }</span>
                  </span>
                </div>
                <div class="config-value" style="background: none; border: none; padding: 0;">
                  <code style="color: var(--text-secondary); font-size: 13px;">
                    ${
                      globals.databaseValid 
                        ? '✅ 数据库存储已启用，配置和缓存将持久化保存' 
                        : (redisConfigured && globals.redisValid)
                          ? '✅ Redis存储已启用,配置和缓存将持久化保存'
                          : (redisConfigured && !globals.redisValid)
                            ? '⚠️ Redis已配置但连接失败，请检查配置信息'
                            : '📝 未配置持久化存储，数据仅保存在内存中（重启后丢失）'
                    }
                  </code>
                </div>
              </div>
           
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">限流配置</span>
               <span class="badge ${globals.rateLimitMaxRequests > 0 ? 'badge-info' : 'badge-secondary'}">
                 ${globals.rateLimitMaxRequests > 0 ? '已启用' : '未启用'}
               </span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px;">
                 ${globals.rateLimitMaxRequests > 0 
                   ? `🛡️ 每 IP 限制 ${globals.rateLimitMaxRequests} 次/分钟` 
                   : '🔓 未启用请求限流'}
               </code>
             </div>
           </div>
           
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">缓存策略</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px;">
                 🔍 搜索: ${globals.searchCacheMinutes} 分钟 | 💬 弹幕: ${globals.commentCacheMinutes} 分钟
               </code>
             </div>
           </div>
           
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">弹幕处理</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px;">
                 ${globals.danmuLimit > 0 
                   ? `📊 限制 ${globals.danmuLimit} 条` 
                   : '♾️ 不限制数量'} | 
                 ${globals.danmuSimplified ? '🇨🇳 繁转简' : '🌐 保持原样'} | 
                 格式: ${globals.danmuOutputFormat.toUpperCase()}
               </code>
             </div>
           </div>
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
             </svg>
             最近匹配信息
           </h3>
           <div style="display: flex; align-items: center; gap: 8px;">
             <span class="badge badge-secondary" style="font-weight: normal;">最新 5 条</span>
             <button class="icon-btn" onclick="window.location.reload()" title="刷新列表" style="width: 28px; height: 28px;">
               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor">
                 <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="2" stroke-linecap="round"/>
               </svg>
             </button>
           </div>
         </div>
         <div class="server-grid" style="gap: 0;">
           ${recentMatchesHtml}
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke-width="2"/>
             </svg>
             快速导航
           </h3>
         </div>
         <div class="source-grid">
           <div class="source-item" onclick="switchPage('config')" style="cursor: pointer;">
             <div class="source-icon">⚙️</div>
             <div class="source-name">环境配置</div>
           </div>
           <div class="source-item" onclick="switchPage('about')" style="cursor: pointer;">
             <div class="source-icon">ℹ️</div>
             <div class="source-name">关于系统</div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>弹幕 API 服务 v${globals.VERSION} | Made with ❤️ for Better Anime Experience</p>
         <p style="margin-top: 8px; font-size: 12px;">
           快捷键: <span class="keyboard-shortcut">Ctrl+1-3</span> 切换页面 | 
           <span class="keyboard-shortcut">Ctrl+K</span> 切换主题 | 
           <span class="keyboard-shortcut">Ctrl+S</span> 保存配置
         </p>
       </div>
     </section>

     <!-- 环境配置页面 -->
     <section id="config-page" class="page-section">
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke-width="2"/>
               <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke-width="2"/>
             </svg>
             环境变量配置
           </h3>
           <div class="card-actions">
             <button class="btn btn-secondary" onclick="exportConfig()">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" stroke-width="2" stroke-linecap="round"/>
               </svg>
               导出配置
             </button>
             <button class="btn btn-primary" onclick="saveAllConfig()">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" stroke-width="2" stroke-linecap="round"/>
               </svg>
               保存全部
             </button>
           </div>
         </div>
         <div class="config-grid" id="configGrid">
           ${envItemsHtml}
         </div>
       </div>

       <div class="footer">
         <p>共 ${totalEnvCount} 个环境变量，已配置 ${configuredEnvCount} 个</p>
         <p style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
           💡 提示: 双击配置值可复制完整内容 | 点击编辑按钮可修改配置 | 敏感信息会自动隐藏
         </p>
       </div>
     </section>

     <!-- 关于页面 -->
     <section id="about-page" class="page-section">
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
             </svg>
             关于弹幕 API
           </h3>
           <div style="display: flex; align-items: center; gap: 12px;">
             <span class="badge badge-success">
               <span class="status-dot"></span>v${globals.VERSION}
             </span>
             <a href="https://github.com/huangxd-/danmu_api" target="_blank" rel="noopener" class="btn btn-secondary" style="padding: 8px 16px; text-decoration: none; font-size: 13px;">
               <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 6px;">
                 <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
               </svg>
               GitHub 仓库
             </a>
           </div>
         </div>
         
         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">项目简介</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 🎬 弹幕 API 是一个强大的多平台弹幕聚合服务，支持从哔哩哔哩、爱奇艺、优酷、腾讯视频、芒果TV、巴哈姆特等主流视频平台获取弹幕。<br><br>
                 ✨ 提供智能标题匹配、弹幕去重过滤、繁简转换、格式转换等实用功能，适用于各类视频播放器集成。<br><br>
                 🚀 支持多种部署平台，包括 Cloudflare Workers、Vercel、Netlify 等，并提供 Redis/SQLite/D1 持久化存储方案。
               </code>
             </div>
           </div>
           
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">核心功能</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 <strong>🎯 多平台弹幕聚合</strong><br>
                 • 哔哩哔哩：支持完整弹幕获取（需配置Cookie）<br>
                 • 爱奇艺：支持番剧和电影弹幕<br>
                 • 优酷：支持高并发弹幕获取<br>
                 • 腾讯视频：支持番剧弹幕<br>
                 • 芒果TV：支持综艺和电视剧弹幕<br>
                 • 巴哈姆特动画疯：支持繁体弹幕（可自动转简体）<br>
                 • VOD 采集站：支持自定义影视采集站接入<br><br>
                 
                 <strong>🔍 智能匹配系统</strong><br>
                 • 支持文件名智能解析和标题匹配<br>
                 • 支持外语标题自动转中文（需配置TMDB）<br>
                 • 支持记住用户手动选择结果<br>
                 • 支持剧集标题正则过滤<br><br>
                 
                 <strong>🎨 弹幕处理增强</strong><br>
                 • 智能去重：按时间窗口合并相同弹幕<br>
                 • 内容过滤：支持屏蔽词列表<br>
                 • 繁简转换：自动转换繁体弹幕<br>
                 • 颜色处理：支持白色弹幕占比调整<br>
                 • 位置转换：可将顶部/底部弹幕转为滚动<br>
                 • 数量限制：支持限制返回弹幕数量<br>
                 • 格式输出：支持 JSON/XML 双格式<br><br>
                 
                 <strong>💾 持久化存储</strong><br>
                 • Upstash Redis：适用于 Serverless 平台<br>
                 • SQLite：本地文件存储<br>
                 • Cloudflare D1：云端 SQLite<br>
                 • 配置热更新：支持运行时修改配置<br><br>
                 
                 <strong>🛡️ 性能与安全</strong><br>
                 • IP 访问限流防滥用<br>
                 • 智能缓存减少重复请求<br>
                 • 代理支持绕过地域限制<br>
                 • 管理后台密码保护
               </code>
             </div>
           </div>
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" stroke-width="2"/>
             </svg>
             API 接口文档
           </h3>
         </div>
         
         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">搜索番剧</span>
               <span class="badge badge-info">GET</span>
             </div>
             <div class="config-value">
               <code>/api/v2/search/anime?kayword={关键词}</code>
             </div>
             <div style="margin-top: 12px; padding: 12px; background: var(--bg-primary); border-radius: 8px; font-size: 12px; color: var(--text-secondary);">
               <strong>参数：</strong><br>
               • anime: 番剧名称（必填）<br><br>
               <strong>示例：</strong><br>
               <code style="color: var(--primary-400);">/api/v2/search/anime?anime=进击的巨人</code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">搜索剧集</span>
               <span class="badge badge-info">GET</span>
             </div>
             <div class="config-value">
               <code>/api/v2/search/episodes?anime={番剧名}&episode={集数}</code>
             </div>
             <div style="margin-top: 12px; padding: 12px; background: var(--bg-primary); border-radius: 8px; font-size: 12px; color: var(--text-secondary);">
               <strong>参数：</strong><br>
               • anime: 番剧名称（必填）<br>
               • episode: 集数（必填）<br><br>
               <strong>示例：</strong><br>
               <code style="color: var(--primary-400);">/api/v2/search/episodes?anime=进击的巨人&episode=1</code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">智能匹配</span>
               <span class="badge badge-success">POST</span>
             </div>
             <div class="config-value">
               <code>/api/v2/match</code>
             </div>
             <div style="margin-top: 12px; padding: 12px; background: var(--bg-primary); border-radius: 8px; font-size: 12px; color: var(--text-secondary);">
               <strong>请求体：</strong><br>
               <code style="color: var(--primary-400);">{"fileName": "[Nekomoe kissaten][Attack on Titan][01][1080p].mp4"}</code><br><br>
               <strong>功能：</strong><br>
               • 自动解析文件名（支持网盘命名、特殊格式）<br>
               • 智能匹配番剧和集数<br>
               • 支持中/英文标题（需配置 TMDB_API_KEY）<br>
               • 支持 @语法指定平台优先级（如：赴山海 S01E28 @qiyi）<br>
               • 支持带年份格式（如：爱情公寓.ipartment.2009.S03E05）<br><br>
               <strong>支持的命名格式：</strong><br>
               • 标准格式：<code style="color: var(--primary-400);">进击的巨人 S01E01</code><br>
               • 网盘格式：<code style="color: var(--primary-400);">无忧渡.S01E01.2160p.WEB-DL.H265.DDP.5.1</code><br>
               • 英文格式：<code style="color: var(--primary-400);">Blood.River.S01E05</code><br>
               • 带年份格式：<code style="color: var(--primary-400);">爱情公寓.ipartment.2009.S03E05.H.265.25fps.mkv</code><br>
               • 平台优先：<code style="color: var(--primary-400);">赴山海 S01E28 @qiyi</code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">获取弹幕</span>
               <span class="badge badge-info">GET</span>
             </div>
             <div class="config-value">
               <code>/api/v2/comment/{commentId}?format={json|xml}</code>
             </div>
             <div style="margin-top: 12px; padding: 12px; background: var(--bg-primary); border-radius: 8px; font-size: 12px; color: var(--text-secondary);">
               <strong>参数：</strong><br>
               • commentId: 弹幕ID（必填）<br>
               • format: 输出格式（可选，默认json）<br><br>
               <strong>或使用URL方式：</strong><br>
               <code style="color: var(--primary-400);">/api/v2/comment?url={视频URL}&format=xml</code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">获取番剧信息</span>
               <span class="badge badge-info">GET</span>
             </div>
             <div class="config-value">
               <code>/api/v2/bangumi/{animeId}</code>
             </div>
             <div style="margin-top: 12px; padding: 12px; background: var(--bg-primary); border-radius: 8px; font-size: 12px; color: var(--text-secondary);">
               <strong>参数：</strong><br>
               • animeId: 番剧ID（必填）<br><br>
               <strong>返回：</strong>番剧详细信息和所有剧集列表
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">查看日志</span>
               <span class="badge badge-info">GET</span>
             </div>
             <div class="config-value">
               <code>/api/logs?format={text|json}&level={info|warn|error}</code>
             </div>
             <div style="margin-top: 12px; padding: 12px; background: var(--bg-primary); border-radius: 8px; font-size: 12px; color: var(--text-secondary);">
               <strong>参数：</strong><br>
               • format: 输出格式（可选，默认text）<br>
               • level: 日志级别过滤（可选）<br>
               • limit: 返回数量限制（可选）
             </div>
           </div>
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" stroke-width="2"/>
             </svg>
             技术栈与架构
           </h3>
         </div>
         
         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">运行环境</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 <strong>支持平台：</strong><br>
                 • Cloudflare Workers（推荐）<br>
                 • Vercel Serverless Functions<br>
                 • Netlify Functions<br>
                 • 其他支持 Node.js 的平台<br><br>
                 
                 <strong>语言与框架：</strong><br>
                 • JavaScript (ES Modules)<br>
                 • Web Standards API<br>
                 • Fetch API / Node HTTP
               </code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">持久化方案</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 <strong>Upstash Redis</strong><br>
                 • 适用于 Serverless 平台<br>
                 • HTTP REST API 访问<br>
                 • 全球边缘节点<br><br>
                 
                 <strong>SQLite 本地存储</strong><br>
                 • 适用于 VPS/Docker 部署<br>
                 • 零配置开箱即用<br>
                 • 支持文件持久化<br><br>
                 
                 <strong>Cloudflare D1</strong><br>
                 • 云端 SQLite 数据库<br>
                 • 与 Workers 深度集成<br>
                 • 自动备份和同步
               </code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">前端技术</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 • 原生 JavaScript（无框架依赖）<br>
                 • Chart.js 数据可视化<br>
                 • 现代化玻璃态 UI 设计<br>
                 • 响应式布局支持移动端<br>
                 • CSS Grid / Flexbox 布局<br>
                 • 深色/浅色主题切换
               </code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">核心依赖</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 <strong>数据获取：</strong><br>
                 • @upstash/redis (Redis客户端)<br>
                 • node-fetch (HTTP 请求)<br>
                 • libsql (SQLite 客户端)<br><br>
                 
                 <strong>数据处理：</strong><br>
                 • opencc-js (繁简转换)<br>
                 • 内置弹幕去重算法<br>
                 • 智能标题匹配引擎
               </code>
             </div>
           </div>
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
             </svg>
             使用指南
           </h3>
         </div>
         
         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">快速开始</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 <strong>1️⃣ 配置环境变量</strong><br>
                 在"环境配置"页面设置必要的环境变量：<br>
                 • TOKEN: 自定义API访问令牌（可选）<br>
                 • BILIBILI_COOKIE: B站Cookie获取完整弹幕<br>
                 • TMDB_API_KEY: TMDB密钥用于标题转换<br><br>
                 
                 <strong>2️⃣ 配置持久化存储（可选）</strong><br>
                 • Upstash Redis: 配置 UPSTASH_REDIS_REST_URL 和 TOKEN<br>
                 • SQLite: 配置 DATABASE_URL (本地部署)<br>
                 • Cloudflare D1: 绑定 D1 数据库<br><br>
                 
                 <strong>3️⃣ 开始使用</strong><br>
                 配置完成后即可通过 API 接口获取弹幕数据
               </code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">常见问题</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 <strong>Q: 如何获取B站Cookie？</strong><br>
                 A: 登录 bilibili.com 后，按F12打开开发者工具，在 Application → Cookies 中找到 SESSDATA 字段，至少需要复制该字段的值。<br><br>
                 
                 <strong>Q: 为什么要配置持久化存储？</strong><br>
                 A: Serverless 平台会定期清理内存，配置持久化可以保存配置、缓存和用户选择记录，避免冷启动后数据丢失。<br><br>
                 
                 <strong>Q: 如何修改管理员密码？</strong><br>
                 A: 点击右上角密钥图标，输入旧密码后设置新密码。首次登录默认账号密码均为 admin。<br><br>
                 
                 <strong>Q: 弹幕数量太多怎么办？</strong><br>
                 A: 在环境配置中设置 DANMU_LIMIT 参数限制返回数量，推荐设置为 3000-8000 条。<br><br>
                 
                 <strong>Q: 支持哪些视频平台？</strong><br>
                 A: 目前支持哔哩哔哩、爱奇艺、优酷、腾讯视频、芒果TV、巴哈姆特动画疯，以及自定义 VOD 采集站。
               </code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">性能优化建议</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 • 配置 Redis/数据库启用持久化缓存<br>
                 • 适当增加缓存时间（SEARCH_CACHE_MINUTES）<br>
                 • 启用"记住最后选择"功能提高匹配准确度<br>
                 • 设置访问限流防止恶意请求<br>
                 • 优酷弹幕建议并发数设为8（平衡速度和资源）<br>
                 • 开启弹幕简化和去重减少数据量
               </code>
             </div>
           </div>
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" stroke-width="2"/>
             </svg>
             贡献与支持
           </h3>
         </div>
         
         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">开源协议</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 <strong>MIT License</strong><br><br>
                 本项目采用 MIT 开源协议，您可以自由地：<br>
                 • 使用：个人或商业用途均可<br>
                 • 修改：根据需求定制功能<br>
                 • 分发：分享给其他人使用<br>
                 • 二次开发：基于此项目创建衍生项目<br><br>
                 唯一要求：保留原作者版权声明
               </code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">参与贡献</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 欢迎提交 Issue 和 Pull Request！<br><br>
                 <strong>贡献方式：</strong><br>
                 • 报告 Bug 或提出功能建议<br>
                 • 完善文档和使用说明<br>
                 • 提交代码修复或新功能<br>
                 • 分享使用经验和部署教程<br><br>
                 
                 <strong>项目地址：</strong><br>
                 <a href="https://github.com/huangxd-/danmu_api" target="_blank" style="color: var(--primary-400); text-decoration: none;">
                   https://github.com/huangxd-/danmu_api
                 </a>
               </code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">致谢</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                 感谢以下项目和服务：<br><br>
                 • 弹弹Play API 提供基础弹幕数据<br>
                 • Upstash 提供 Redis 云服务<br>
                 • Cloudflare 提供 Workers 和 D1 服务<br>
                 • TMDB 提供影视数据库 API<br>
                 • 各视频平台提供弹幕数据源<br>
                 • 所有贡献者和使用者的支持
               </code>
             </div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>弹幕 API 服务 v${globals.VERSION} | Made with ❤️ for Better Anime Experience</p>
         <p style="margin-top: 12px; font-size: 13px; line-height: 1.6;">
           <a href="https://github.com/huangxd-/danmu_api" target="_blank" rel="noopener" style="color: var(--primary-400); text-decoration: none; margin-right: 16px;">📦 GitHub</a>
           <a href="https://github.com/huangxd-/danmu_api/issues" target="_blank" rel="noopener" style="color: var(--primary-400); text-decoration: none; margin-right: 16px;">🐛 反馈问题</a>
           <a href="https://github.com/huangxd-/danmu_api/blob/main/README.md" target="_blank" rel="noopener" style="color: var(--primary-400); text-decoration: none;">📖 完整文档</a>
         </p>
         <p style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
           💡 提示: 如有疑问请查看使用指南或访问 GitHub 仓库
         </p>
       </div>
     </section>

          <!-- 搜索源管理页面 -->
     <section id="sources-page" class="page-section">
       <!-- 标签页导航 -->
       <div class="tabs" style="margin-bottom: 24px;">
         <button class="tab-item active" onclick="switchSourceTab('search')">
           <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" style="margin-right: 6px;">
             <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke-width="2"/>
           </svg>
           搜索源
         </button>
         <button class="tab-item" onclick="switchSourceTab('platform')">
           <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" style="margin-right: 6px;">
             <path d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" stroke-width="2"/>
           </svg>
           弹幕平台
         </button>
         <button class="tab-item" onclick="switchSourceTab('vod')">
           <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" style="margin-right: 6px;">
             <path d="M5 3l14 9-14 9V3z" stroke-width="2"/>
           </svg>
           VOD
         </button>
         <button class="tab-item" onclick="switchSourceTab('settings')">
           <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" style="margin-right: 6px;">
             <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke-width="2"/>
             <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke-width="2"/>
           </svg>
           源配置
         </button>
       </div>

       <!-- 搜索源管理标签页 -->
       <div id="searchSourceTab" class="source-tab-content active">
         <div class="card">
           <div class="card-header">
             <h3 class="card-title">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke-width="2"/>
               </svg>
               搜索源优先级配置
             </h3>
             <div class="card-actions">
               <button class="btn btn-secondary" onclick="resetSourceOrder()">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 恢复默认
               </button>
               <button class="btn btn-primary" onclick="saveSourceOrder()">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 保存配置
               </button>
             </div>
           </div>

           <div class="alert alert-info" style="margin-bottom: 24px;">
             <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
               <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
               <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
             </svg>
             <span>💡 拖拽调整搜索源顺序，关闭的源不会被使用。排序越靠前优先级越高</span>
           </div>

           <div id="sourceOrderList" class="source-modern-grid">
             <!-- 动态生成源列表 -->
           </div>
         </div>
       </div>

       <!-- 弹幕平台管理标签页 -->
       <div id="platformSourceTab" class="source-tab-content">
         <div class="card">
           <div class="card-header">
             <h3 class="card-title">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" stroke-width="2"/>
               </svg>
               弹幕平台优先级配置
             </h3>
             <div class="card-actions">
               <button class="btn btn-secondary" onclick="resetPlatformOrder()">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 清空配置
               </button>
               <button class="btn btn-primary" onclick="savePlatformOrder()">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 保存顺序
               </button>
             </div>
           </div>

           <div class="alert alert-info" style="margin-bottom: 24px;">
             <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
               <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
               <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
             </svg>
             <span>💡 拖拽调整弹幕平台顺序，关闭的平台不会返回弹幕。自动匹配时优先返回靠前平台的弹幕</span>
           </div>

           <div id="platformOrderList" class="source-modern-grid">
             <!-- 动态生成平台列表 -->
           </div>
         </div>
       </div>

       <!-- VOD 采集站标签页 -->
       <div id="vodSourceTab" class="source-tab-content">
         <div class="card">
           <div class="card-header">
             <h3 class="card-title">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M5 3l14 9-14 9V3z" stroke-width="2"/>
               </svg>
               VOD 影视采集站管理
             </h3>
             <div class="card-actions">
               <button class="btn btn-secondary" onclick="testAllVodServers()">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
                 </svg>
                 测试全部
               </button>
               <button class="btn btn-primary" onclick="showAddVodModal()">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M12 4v16m8-8H4" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 添加采集站
               </button>
             </div>
           </div>

           <div class="alert alert-info" style="margin-bottom: 24px;">
             <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
               <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
               <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
             </svg>
             <span>💡 VOD 采集站用于搜索影视资源，可自由添加和删除。内置采集站不可删除</span>
           </div>

           <div id="vodHealthList" class="server-grid">
             <!-- 动态生成采集站列表 -->
           </div>

           <!-- 性能对比图表 -->
           <div class="card" style="margin-top: 24px;">
             <div class="card-header">
               <h3 class="card-title">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" stroke-width="2"/>
                 </svg>
                 性能对比分析
               </h3>
             </div>
             <div class="chart-container">
               <canvas id="vodPerformanceChart"></canvas>
             </div>
           </div>
         </div>
       </div>

       <!-- 源配置标签页 -->
       <div id="settingsSourceTab" class="source-tab-content">
         <div class="card">
           <div class="card-header">
             <h3 class="card-title">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke-width="2"/>
                 <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke-width="2"/>
               </svg>
               高级配置
             </h3>
             <div class="card-actions">
               <button class="btn btn-primary" onclick="saveSourceSettings()">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                   <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 保存配置
               </button>
             </div>
           </div>

           <div class="config-grid">
             <!-- VOD 返回模式 -->
             <div class="config-item">
               <div class="config-header">
                 <span class="config-label">VOD 返回模式</span>
                 <span class="badge badge-info" id="vodReturnModeBadge">fastest</span>
               </div>
               <select class="form-select" id="vodReturnModeSelect" onchange="updateVodReturnModeBadge()">
                 <option value="fastest">fastest - 仅返回最快响应的站点</option>
                 <option value="all">all - 返回所有站点结果</option>
               </select>
               <div class="form-hint">fastest 模式响应更快但结果较少，all 模式结果完整但可能有重复</div>
             </div>

             <!-- VOD 请求超时 -->
             <div class="config-item">
               <div class="config-header">
                 <span class="config-label">VOD 请求超时</span>
                 <span class="config-value-display" id="vodTimeoutValue">10000</span>
               </div>
               <div class="range-wrapper">
                 <div class="range-progress" id="vodTimeoutProgress" style="width: 50%"></div>
                 <input type="range" class="form-range" id="vodTimeoutRange" min="5000" max="30000" step="1000" value="10000"
                        oninput="updateRangeProgress(this, 'vodTimeoutProgress', 'vodTimeoutValue', 5000, 30000, val => val + ' ms')">
               </div>
               <div class="range-labels">
                 <span>5秒</span>
                 <span>15秒</span>
                 <span>30秒</span>
               </div>
               <div class="form-hint">单个 VOD 站点的请求超时时间，建议 10-15 秒</div>
             </div>
           </div>
         </div>

         <div class="card">
           <div class="card-header">
             <h3 class="card-title">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
               </svg>
               配置说明
             </h3>
           </div>
           <div class="config-grid">
             <div class="config-item">
               <div class="config-value" style="background: none; border: none; padding: 0;">
                 <code style="color: var(--text-secondary); font-size: 13px; line-height: 1.8;">
                   <strong>📚 搜索源说明</strong><br>
                   • <strong>360</strong>: 360影视搜索源（独立源，非 VOD）<br>
                   • <strong>VOD</strong>: VOD 影视采集站集合<br>
                   • <strong>其他源</strong>: TMDB、豆瓣、腾讯、优酷、爱奇艺等<br><br>
                   
                   <strong>🎬 弹幕平台说明</strong><br>
                   • 配置后自动匹配时会按顺序优先返回对应平台弹幕<br>
                   • 如果不配置，则返回第一个满足条件的平台<br>
                   • 关闭的平台不会返回弹幕数据<br><br>
                   
                   <strong>📡 VOD 采集站说明</strong><br>
                   • 用于搜索影视资源和获取播放链接<br>
                   • 支持添加自定义采集站<br>
                   • fastest 模式适合快速响应，all 模式适合完整结果
                 </code>
               </div>
             </div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>搜索源管理 | 配置数据源优先级、弹幕平台和 VOD 采集站</p>
       </div>
     </section>

     <section id="danmuTest-page" class="page-section">
       <div class="card" style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.05), rgba(139, 92, 246, 0.05));">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke-width="2"/>
             </svg>
             弹幕获取测试
           </h3>
           <div class="tabs" style="border-bottom: none; margin-bottom: 0;">
             <button class="tab-item active" onclick="switchDanmuMode('match')" id="tab-match">自动匹配</button>
             <button class="tab-item" onclick="switchDanmuMode('search')" id="tab-search">手动搜索</button>
           </div>
         </div>

         <div style="padding: 0 8px;">
           <div class="form-group" style="margin-bottom: 12px;">
             <label class="form-label" id="danmuInputLabel" style="font-size: 14px; margin-bottom: 6px; display: block;">🎬 文件名 / 标题 / 视频链接</label>
             <div style="display: flex; gap: 8px; align-items: stretch;">
               <input type="text" class="form-input" id="danmuTestInput" 
                      placeholder="请输入..." 
                      style="font-size: 15px; padding: 12px 14px; flex: 1; min-width: 0;">
               <button class="btn btn-primary" onclick="performDanmuAction()" id="danmuActionBtn" style="padding: 0 16px; flex-shrink: 0; white-space: nowrap; display: flex; align-items: center; justify-content: center;">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width: 20px; height: 20px;">
                   <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke-width="2"/>
                 </svg>
                 <span id="danmuActionText" class="desktop-only" style="margin-left: 6px;">自动匹配</span>
               </button>
             </div>
             <div class="form-hint" id="danmuInputHint" style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary); line-height: 1.4;">
               💡 自动解析文件名 (如: 藏海传 S01E01) 或粘贴视频链接
             </div>
           </div>

           <button class="advanced-toggle" id="advancedToggleBtn" onclick="toggleAdvancedSettings()">
             <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
             <span>高级设置 (指定年份/集数)</span>
           </button>

           <div id="matchOptions" class="advanced-options">
              <input type="hidden" id="danmuTestApiType" value="match">
              
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label" style="font-size: 13px;">📅 年份 (可选)</label>
                <input type="number" class="form-input" id="danmuTestYear" 
                       placeholder="2024" min="1900" max="2099" style="padding: 11px 12px;">
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label" style="font-size: 13px;">🎞️ 季数 (可选)</label>
                <input type="number" class="form-input" id="danmuTestSeason" 
                       placeholder="1" min="1" style="padding: 11px 12px;">
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label" style="font-size: 13px;">📺 集数 (可选)</label>
                <input type="number" class="form-input" id="danmuTestEpisode" 
                       placeholder="1" min="1" style="padding: 11px 12px;">
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label" style="font-size: 13px;">🎯 指定平台</label>
                <select class="form-select" id="danmuTestPlatform" style="padding: 11px 12px;">
                  <option value="">自动匹配</option>
                  <option value="qiyi">🥝 爱奇艺</option>
                  <option value="bilibili1">📺 哔哩哔哩</option>
                  <option value="imgo">🎬 IMGO</option>
                  <option value="youku">📹 优酷</option>
                  <option value="qq">🐧 腾讯视频</option>
                  <option value="bahamut">🎮 巴哈姆特</option>
                </select>
              </div>
           </div>
         </div>
       </div>

       <div id="manualSearchResults" style="display: none; margin-top: 24px;">
         <div class="manual-search-container">
           <div id="animeListView" class="search-view active">
             <div style="margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between;">
               <div style="font-size: 14px; font-weight: 600; color: var(--text-secondary); display: flex; align-items: center; gap: 8px;">
                 <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8" stroke-width="2"/><path d="m21 21-4.35-4.35" stroke-width="2"/></svg>
                 搜索结果
               </div>
             </div>
             <div id="animeListContainer" class="anime-grid">
               <div style="grid-column: 1/-1; text-align: center; padding: 80px 0; color: var(--text-tertiary);">
                 <div style="font-size: 48px; opacity: 0.2; margin-bottom: 16px;">🔍</div>
                 <div>输入关键词开始搜索</div>
               </div>
             </div>
           </div>

           <div id="episodeListView" class="search-view hidden-right">
             <div class="episode-view-header">
               <button class="back-btn" onclick="backToAnimeList()">
                 <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                 返回列表
               </button>
               <div class="selected-anime-info">
                 <div id="selectedAnimeTitle" class="selected-anime-title">番剧标题</div>
                 <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px;">请选择集数以获取弹幕</div>
               </div>
             </div>
             
             <div id="episodeListContainer">
               </div>
           </div>
         </div>
       </div>

       <div class="card" id="matchResultCard" style="display: none; border-left: 4px solid var(--success); margin-top: 24px; animation: slideInFromLeft 0.4s ease-out;">
         <div class="card-header" style="padding-bottom: 16px;">
           <h3 class="card-title" style="color: var(--success);">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
             </svg>
             匹配成功
           </h3>
           <div class="card-actions">
             <button class="btn btn-outline" onclick="viewRawData('json')" style="padding: 6px 12px; font-size: 12px;">
               <span style="font-family: monospace; font-weight: 700;">{}</span> 原始 JSON
             </button>
           </div>
         </div>
         <div style="display: grid; gap: 12px; padding: 0 8px;">
           <div style="display: flex; align-items: center; gap: 12px; padding: 14px; background: var(--bg-tertiary); border-radius: 10px;">
             <div style="width: 48px; height: 48px; background: linear-gradient(135deg, var(--success), #059669); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0;">
               🎬
             </div>
             <div style="flex: 1; min-width: 0;">
               <div style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 4px;" id="matchedAnimeTitle">-</div>
               <div style="font-size: 13px; color: var(--text-secondary);" id="matchedEpisodeTitle">-</div>
             </div>
           </div>
           <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px;">
             <div style="padding: 12px; background: var(--bg-primary); border-radius: 8px; text-align: center;">
               <div style="font-size: 11px; color: var(--text-tertiary); margin-bottom: 4px;">平台</div>
               <div style="font-size: 15px; font-weight: 700; color: var(--primary-400);" id="matchedPlatform">-</div>
             </div>
             <div style="padding: 12px; background: var(--bg-primary); border-radius: 8px; text-align: center;">
               <div style="font-size: 11px; color: var(--text-tertiary); margin-bottom: 4px;">季数</div>
               <div style="font-size: 15px; font-weight: 700; color: var(--primary-400);" id="matchedSeason">-</div>
             </div>
             <div style="padding: 12px; background: var(--bg-primary); border-radius: 8px; text-align: center;">
               <div style="font-size: 11px; color: var(--text-tertiary); margin-bottom: 4px;">集数</div>
               <div style="font-size: 15px; font-weight: 700; color: var(--primary-400);" id="matchedEpisode">-</div>
             </div>
             <div style="padding: 12px; background: var(--bg-primary); border-radius: 8px; text-align: center;">
               <div style="font-size: 11px; color: var(--text-tertiary); margin-bottom: 4px;">弹幕ID</div>
               <div style="font-size: 15px; font-weight: 700; color: var(--primary-400); font-family: monospace;" id="matchedEpisodeId">-</div>
             </div>
           </div>
         </div>
       </div>

       <div class="card" style="margin-top: 24px;">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" stroke-width="2"/>
             </svg>
             弹幕预览
           </h3>
           <div class="card-actions" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
             <span id="danmuTestCount" class="badge badge-info" style="font-size: 13px; padding: 6px 12px;">0 条</span>
             
             <div id="danmuExportGroup" style="display: none; gap: 10px; flex-wrap: wrap;">
               <details style="position: relative; display: inline-block;">
                 <summary class="btn btn-outline" style="padding: 8px 16px; font-size: 13px; list-style: none; cursor: pointer; display: flex; align-items: center;">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                   导出下载
                   <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" style="margin-left: 4px; opacity: 0.7;"><polyline points="6 9 12 15 18 9"></polyline></svg>
                 </summary>
                 <div style="position: absolute; top: calc(100% + 5px); left: 0; min-width: 110px; background: var(--bg-card, #fff); border: 1px solid var(--border-color, #eee); box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-radius: 6px; z-index: 100; padding: 4px; display: flex; flex-direction: column; gap: 2px;">
                   <button onclick="exportDanmu('json')" class="btn-ghost" style="text-align: left; padding: 8px 12px; font-size: 13px; width: 100%; border: none; background: transparent; cursor: pointer; border-radius: 4px;">📥 JSON 文件</button>
                   <button onclick="exportDanmu('xml')" class="btn-ghost" style="text-align: left; padding: 8px 12px; font-size: 13px; width: 100%; border: none; background: transparent; cursor: pointer; border-radius: 4px;">📥 XML 文件</button>
                 </div>
               </details>

               <details style="position: relative; display: inline-block;">
                 <summary class="btn btn-outline" style="padding: 8px 16px; font-size: 13px; list-style: none; cursor: pointer; display: flex; align-items: center;">
                   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" style="margin-right: 6px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                   在线查看
                   <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" style="margin-left: 4px; opacity: 0.7;"><polyline points="6 9 12 15 18 9"></polyline></svg>
                 </summary>
                 <div style="position: absolute; top: calc(100% + 5px); left: 0; min-width: 110px; background: var(--bg-card, #fff); border: 1px solid var(--border-color, #eee); box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-radius: 6px; z-index: 100; padding: 4px; display: flex; flex-direction: column; gap: 2px;">
                   <button onclick="viewRawData('json')" class="btn-ghost" style="text-align: left; padding: 8px 12px; font-size: 13px; width: 100%; border: none; background: transparent; cursor: pointer; border-radius: 4px;">📄 查看 JSON</button>
                   <button onclick="viewRawData('xml')" class="btn-ghost" style="text-align: left; padding: 8px 12px; font-size: 13px; width: 100%; border: none; background: transparent; cursor: pointer; border-radius: 4px;">📄 查看 XML</button>
                 </div>
               </details>
             </div>
             
             <script>
               document.addEventListener('click', function(e) {
                 document.querySelectorAll('details').forEach(function(details) {
                   if (!details.contains(e.target)) {
                     details.removeAttribute('open');
                   }
                 });
               });
             </script>
             
             <button class="btn btn-secondary" onclick="clearDanmuTest()" style="padding: 7px 14px; font-size: 13px;">
               <span>清空</span>
             </button>
           </div>
         </div>
         
         <div id="danmuChartWrapper" style="display: none; margin-bottom: 16px; padding: 16px; background: var(--bg-primary); border-radius: 12px; border: 1px solid var(--border-color);">
            <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"><path d="M3 3v18h18M18.4 8.1l1.6 1.6-6 6-4-4-6 6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              弹幕密度分布
            </div>
            <div style="height: 140px; width: 100%;">
              <canvas id="danmuTimeChart"></canvas>
            </div>
         </div>

         <div id="danmuPreviewContainer" style="min-height: 320px; max-height: 520px; overflow-y: auto; background: var(--bg-primary); border-radius: 12px; padding: 16px;">
           <div style="text-align: center; padding: 80px 20px; color: var(--text-tertiary);">
             <div style="font-size: 56px; margin-bottom: 20px; opacity: 0.6;">💬</div>
             <div style="font-size: 17px; font-weight: 600; margin-bottom: 10px; color: var(--text-secondary);">暂无弹幕数据</div>
             <div style="font-size: 14px; opacity: 0.8;">输入番剧名称或视频链接开始测试</div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>弹幕测试工具 | 支持自动匹配与手动精确搜索</p>
       </div>
     </section>

     <section id="push-page" class="page-section">
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
             </svg>
             推送配置
           </h3>
         </div>
         <div class="config-grid">
           <div class="config-item" style="border-left: 4px solid var(--primary-500);">
             <div class="config-header">
               <span class="config-label">推送目标 URL</span>
               <button class="icon-btn" onclick="document.getElementById('pushTargetUrl').value=''; localStorage.removeItem('danmu_push_url'); showToast('已清空地址','info');" title="清空地址" style="width: 24px; height: 24px;">
                 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"><path d="M18 6L6 18M6 6l12 12" stroke-width="2" stroke-linecap="round"/></svg>
               </button>
             </div>
             <div class="form-group" style="margin-bottom: 8px;">
               <input type="text" class="form-input" id="pushTargetUrl" placeholder="http://192.168.1.x:xxxx/danmu/push?url=">
               
               <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center;">
                 <span style="font-size: 12px; color: var(--text-tertiary); font-weight: 600;">快速预设:</span>
                 <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px; height: auto; border-radius: 6px;" onclick="applyPushPreset('okvideo')">
                   📺 OK影视
                 </button>
                 <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px; height: auto; border-radius: 6px;" onclick="applyPushPreset('kodi')">
                   🍿 Kodi (示例)
                 </button>
                 <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px; height: auto; border-radius: 6px;" onclick="applyPushPreset('potplayer')">
                   💿 PotPlayer (示例)
                 </button>
               </div>

               <div class="form-hint" style="margin-top: 12px;">请输入接收弹幕的播放器地址。系统会自动在末尾追加 <code style="background:var(--bg-secondary);padding:2px 4px;border-radius:4px;">http://.../comment/id.xml</code> 链接</div>
             </div>
           </div>
           
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">搜索动漫</span>
             </div>
             <div style="display: flex; gap: 8px;">
               <input type="text" class="form-input" id="pushSearchInput" placeholder="输入动漫名称..." onkeypress="if(event.key==='Enter') searchAnimeForPush()">
               <button class="btn btn-primary" onclick="searchAnimeForPush()" id="pushSearchBtn">
                 <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8" stroke-width="2"/><path d="m21 21-4.35-4.35" stroke-width="2"/></svg>
                 搜索
               </button>
             </div>
           </div>
         </div>
       </div>

       <div id="pushResultsContainer" style="display: none; margin-top: 24px;">
         <div class="manual-search-container">
           <div id="pushAnimeListView" class="search-view active">
             <div style="margin-bottom: 16px; font-size: 14px; font-weight: 600; color: var(--text-secondary);">
               搜索结果
             </div>
             <div id="pushAnimeGrid" class="anime-grid">
               </div>
           </div>

           <div id="pushEpisodeListView" class="search-view hidden-right">
             <div class="episode-view-header">
               <button class="back-btn" onclick="backToPushAnimeList()">
                 <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                 返回列表
               </button>
               <div class="selected-anime-info">
                 <div id="pushSelectedAnimeTitle" class="selected-anime-title">番剧标题</div>
                 <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px;">点击集数推送弹幕</div>
               </div>
             </div>
             
             <div id="pushEpisodeGrid" class="episode-grid">
               </div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>弹幕推送 | 将 API 获取的弹幕推送到指定设备</p>
       </div>
     </section>

     <section id="cache-page" class="page-section">
       <div class="stats-grid">
         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">搜索缓存</span>
             <div class="stat-icon primary">🔍</div>
           </div>
           <div class="stat-value" id="searchCacheCount">0</div>
           <div class="stat-footer">
             <span id="searchCacheSize">0 KB</span>
           </div>
         </div>

         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">弹幕缓存</span>
             <div class="stat-icon success">💬</div>
           </div>
           <div class="stat-value" id="commentCacheCount">0</div>
           <div class="stat-footer">
             <span id="commentCacheSize">0 KB</span>
           </div>
         </div>

         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">存储状态</span>
             <div class="stat-icon warning">💾</div>
           </div>
           <div class="stat-value" id="storageStatus">检查中</div>
           <div class="stat-footer">
             <span id="storageType">-</span>
           </div>
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" stroke-width="2"/>
             </svg>
             缓存数据浏览
           </h3>
           <div class="card-actions">
             <button class="btn btn-secondary" onclick="refreshCacheData()">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="2"/>
               </svg>
               刷新
             </button>
             <button class="btn btn-primary" onclick="showClearCacheModal()">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke-width="2"/>
               </svg>
               清理缓存
             </button>
           </div>
         </div>

         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">Redis 连接状态</span>
               <span class="badge" id="redisStatusBadge">检查中...</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px;" id="redisStatusText">正在检测 Redis 连接...</code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">数据库连接状态</span>
               <span class="badge" id="dbStatusBadge">检查中...</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px;" id="dbStatusText">正在检测数据库连接...</code>
             </div>
           </div>

           <div class="config-item">
             <div class="config-header">
               <span class="config-label">最后选择记录</span>
               <span class="badge badge-info" id="lastSelectCountBadge">0 条</span>
             </div>
             <div class="config-value" style="background: none; border: none; padding: 0;">
               <code style="color: var(--text-secondary); font-size: 13px;" id="lastSelectStatus">未启用或无数据</code>
             </div>
           </div>
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" stroke-width="2"/>
             </svg>
             缓存详细信息
           </h3>
         </div>
         <div id="cacheDetailList" style="max-height: 400px; overflow-y: auto;">
           <!-- 动态加载缓存详情 -->
         </div>
       </div>

       <div class="footer">
         <p>缓存管理 | 监控和管理系统缓存数据</p>
       </div>
     </section>
   </div>
 </main>

 <!-- 编辑环境变量模态框 -->
 <div class="modal-overlay" id="editEnvModal">
   <div class="modal">
     <div class="modal-header">
       <h3 class="modal-title">
         <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
           <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke-width="2"/>
           <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke-width="2"/>
         </svg>
         编辑环境变量
       </h3>
       <button class="modal-close" onclick="closeModal('editEnvModal')">
         <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
           <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
     </div>
     <div class="modal-body">
       <div class="form-group">
         <label class="form-label">环境变量名</label>
         <input type="text" class="form-input" id="editEnvKey" readonly>
       </div>
       <div class="form-group">
         <label class="form-label">配置值</label>
         <textarea class="form-textarea" id="editEnvValue" placeholder="请输入配置值"></textarea>
         <div class="form-hint" id="editEnvHint"></div>
       </div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeModal('editEnvModal')">取消</button>
       <button class="btn btn-primary" onclick="saveEnvVar()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
         </svg>
         保存
       </button>
     </div>
   </div>
 </div>

 <!-- 编辑VOD服务器模态框 -->
 <div class="modal-overlay" id="editVodModal">
   <div class="modal">
     <div class="modal-header">
       <h3 class="modal-title">
         <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
           <path d="M5 3l14 9-14 9V3z" stroke-width="2"/>
         </svg>
         <span id="vodModalTitle">编辑VOD服务器</span>
       </h3>
       <button class="modal-close" onclick="closeModal('editVodModal')">
         <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
           <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
     </div>
     <div class="modal-body">
       <div class="form-group">
         <label class="form-label">服务器名称</label>
         <input type="text" class="form-input" id="vodServerName" placeholder="例如: 金蝉采集">
       </div>
       <div class="form-group">
         <label class="form-label">服务器地址</label>
         <input type="text" class="form-input" id="vodServerUrl" placeholder="https://example.com/api">
         <div class="form-hint">请输入完整的 VOD 采集站 API 地址</div>
       </div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeModal('editVodModal')">取消</button>
       <button class="btn btn-primary" onclick="saveVodServer()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
         </svg>
         保存
       </button>
     </div>
   </div>
 </div>

<!-- 修改密码模态框 -->
<div class="modal-overlay" id="changePasswordModal">
  <div class="modal">
    <div class="modal-header">
      <h3 class="modal-title">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
          <path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" stroke-width="2"/>
        </svg>
        修改密码
      </h3>
      <button class="modal-close" onclick="closeModal('changePasswordModal')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
          <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">新用户名（可选）</label>
        <input type="text" class="form-input" id="newUsername" placeholder="留空则不修改用户名">
      </div>
      <div class="form-group">
        <label class="form-label">旧密码</label>
        <input type="password" class="form-input" id="oldPassword" placeholder="请输入当前密码" required>
      </div>
      <div class="form-group">
        <label class="form-label">新密码</label>
        <input type="password" class="form-input" id="newPassword" placeholder="请输入新密码" required>
      </div>
      <div class="form-group">
        <label class="form-label">确认新密码</label>
        <input type="password" class="form-input" id="confirmPassword" placeholder="请再次输入新密码" required>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal('changePasswordModal')">取消</button>
      <button class="btn btn-primary" onclick="changePassword()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
        </svg>
        确认修改
      </button>
    </div>
  </div>
</div>

 <!-- 日志查看模态框 -->
 <div class="modal-overlay" id="logsModal">
   <div class="modal" style="max-width: 1100px; max-height: 90vh;">
     <div class="modal-header">
       <h3 class="modal-title">
         <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
           <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" stroke-width="2" stroke-linecap="round"/>
         </svg>
         系统日志
       </h3>
       <button class="modal-close" onclick="closeModal('logsModal')">
         <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
           <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
     </div>
     <div class="modal-body" style="max-height: 75vh; padding: 0;">
       <div class="log-container">
         <div class="log-header">
           <div class="log-header-title">
             <span>📋 实时日志</span>
             <span class="log-status-badge running" id="logStatusBadge">
               <span class="status-dot"></span>
               <span id="logStatusText">运行中</span>
             </span>
           </div>
           <div class="log-controls">
             <div class="log-control-group">
               <button class="log-filter active" data-level="all" onclick="filterLogs('all')">全部</button>
               <button class="log-filter" data-level="info" onclick="filterLogs('info')">信息</button>
               <button class="log-filter" data-level="warn" onclick="filterLogs('warn')">警告</button>
               <button class="log-filter" data-level="error" onclick="filterLogs('error')">错误</button>
             </div>
             <div class="log-control-divider"></div>
             <div class="log-control-group">
               <button class="log-action-btn pause-btn" id="pauseLogsBtn" onclick="toggleLogPause()" title="暂停/恢复自动滚动 (空格键)">
                 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" id="pauseIcon">
                   <path d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" id="playIcon" style="display: none;">
                   <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" fill="currentColor"/>
                   <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
                 </svg>
                 <span id="pauseBtnText">暂停</span>
               </button>
               <button class="log-action-btn clear-btn" onclick="clearLogs()" title="清空日志显示">
                 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor">
                   <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke-width="2" stroke-linecap="round"/>
                 </svg>
                 清空
               </button>
             </div>
           </div>
           <div class="log-stats">
             <div class="log-stat-item">
               <span>📊</span>
               <span id="logCount">0 条</span>
             </div>
           </div>
         </div>
         <div class="log-content-wrapper" id="logContentWrapper">
           <div id="logContent"></div>
         </div>
       </div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeModal('logsModal')">关闭</button>
       <button class="btn btn-primary" onclick="refreshLogs()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="2" stroke-linecap="round"/>
         </svg>
         手动刷新
       </button>
     </div>
   </div>
 </div>

 <!-- 清理缓存确认弹窗 -->
 <div class="modal-overlay" id="clearCacheModal">
   <div class="modal">
     <div class="modal-header">
       <h3 class="modal-title">
         <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
           <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke-width="2"/>
         </svg>
         清理缓存
       </h3>
       <button class="modal-close" onclick="closeModal('clearCacheModal')">
         <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
           <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
     </div>
     <div class="modal-body">
       <div class="alert alert-warning" style="margin-bottom: 20px;">
         <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
           <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" stroke-width="2"/>
         </svg>
         <span>⚠️ 清理缓存后，下次请求可能需要重新获取数据</span>
       </div>
       <div class="form-group">
         <label class="form-label">选择要清理的缓存类型</label>
         <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 12px;">
           <div style="display: flex; align-items: center; gap: 10px;">
             <input type="checkbox" id="clearSearchCache" checked style="width: 18px; height: 18px; cursor: pointer;">
             <label for="clearSearchCache" style="cursor: pointer; font-size: 14px;">搜索缓存</label>
           </div>
           <div style="display: flex; align-items: center; gap: 10px;">
             <input type="checkbox" id="clearCommentCache" checked style="width: 18px; height: 18px; cursor: pointer;">
             <label for="clearCommentCache" style="cursor: pointer; font-size: 14px;">弹幕缓存</label>
           </div>
           <div style="display: flex; align-items: center; gap: 10px;">
             <input type="checkbox" id="clearLastSelect" style="width: 18px; height: 18px; cursor: pointer;">
             <label for="clearLastSelect" style="cursor: pointer; font-size: 14px;">最后选择记录</label>
           </div>
           <div style="display: flex; align-items: center; gap: 10px;">
             <input type="checkbox" id="clearAllCache" onchange="toggleClearAll(this)" style="width: 18px; height: 18px; cursor: pointer;">
             <label for="clearAllCache" style="cursor: pointer; font-size: 14px; font-weight: 600; color: var(--error);">清空全部缓存</label>
           </div>
         </div>
       </div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeModal('clearCacheModal')">取消</button>
       <button class="btn btn-primary" onclick="executeClearCache()" style="background: var(--error); border-color: var(--error);">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke-width="2"/>
         </svg>
         确认清理
       </button>
     </div>
   </div>
 </div>

 <!-- 快速配置模态框 - 优化版（防误触 + 单滚动条）-->
 <div class="modal-overlay" id="quickConfigModal">
   <div class="modal" style="max-width: 760px; max-height: 90vh;">
     <div class="modal-header">
       <h3 class="modal-title">
         <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
           <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" stroke-width="2" stroke-linecap="round"/>
         </svg>
         快速配置
       </h3>
       <button class="modal-close" onclick="closeModal('quickConfigModal')">
         <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
           <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
     </div>
     <div class="modal-body">
       <!-- 提示信息 -->
       <div class="alert alert-info" style="margin: 0 0 24px 0; border-radius: 12px;">
         <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
           <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
           <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
         </svg>
         <span>💡 点击🔒图标解锁后才能修改配置</span>
       </div>

       <!-- 弹幕白色占比 -->
       <div class="quick-config-item">
         <div class="config-item-header">
           <div class="config-item-title">
             <span class="config-icon">🎨</span>
             <span>弹幕白色占比</span>
           </div>
           <div style="display: flex; align-items: center; gap: 12px;">
             <span id="whiteRatioValue" class="config-value-display">-1</span>
             <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickWhiteRatio')" title="点击解锁编辑">
               <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/>
               </svg>
               <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/>
               </svg>
             </button>
           </div>
         </div>
         <div class="range-wrapper">
           <div class="range-progress" id="whiteRatioProgress" style="width: 0%"></div>
           <input type="range" class="form-range locked" id="quickWhiteRatio" min="-1" max="100" step="1" value="-1" disabled
                  oninput="updateRangeProgress(this, 'whiteRatioProgress', 'whiteRatioValue', -1, 100)">
         </div>
         <div class="range-labels">
           <span>不转换</span>
           <span>50%</span>
           <span>全白</span>
         </div>
         <div class="form-hint">-1 = 不转换颜色 | 0-100 = 指定白色弹幕占比百分比</div>
       </div>

       <div class="quick-config-item">
         <div class="config-item-header">
           <div class="config-item-title">
             <span class="config-icon">🌈</span>
             <span>彩色弹幕配色</span>
           </div>
           <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickDanmuColors')" title="点击解锁编辑">
             <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/><path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/></svg>
             <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/><path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/></svg>
           </button>
         </div>
         <div style="display: flex; gap: 8px; margin-bottom: 12px;">
           <button class="btn btn-secondary" onclick="setDanmuColorPreset('macaron')" style="flex: 1; padding: 6px; font-size: 12px; border-left: 3px solid #FFB1C1;">🍬 糖果柔和</button>
           <button class="btn btn-secondary" onclick="setDanmuColorPreset('neon')" style="flex: 1; padding: 6px; font-size: 12px; border-left: 3px solid #00FF99;">⚡ 赛博霓虹</button>
           <button class="btn btn-secondary" onclick="setDanmuColorPreset('bilibili')" style="flex: 1; padding: 6px; font-size: 12px; border-left: 3px solid #23ADE5;">📺 B站经典</button>
         </div>
         <input type="text" class="form-input locked" id="quickDanmuColors" placeholder="默认色盘 (留空)" readonly>
         <div class="form-hint">留空使用默认柔和色盘。非白色弹幕将从该色盘中随机选取颜色。</div>
       </div>

<!-- 弹幕数量限制 -->
       <div class="quick-config-item">
         <div class="config-item-header">
           <div class="config-item-title">
             <span class="config-icon">📊</span>
             <span>弹幕数量限制</span>
           </div>
           <div style="display: flex; align-items: center; gap: 12px;">
             <span id="danmuLimitValue" class="config-value-display">不限制</span>
             <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickDanmuLimit')" title="点击解锁编辑">
               <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/>
               </svg>
               <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/>
               </svg>
             </button>
           </div>
         </div>
         <div class="range-wrapper">
           <div class="range-progress" id="danmuLimitProgress" style="width: 0%"></div>
           <input type="range" class="form-range locked" id="quickDanmuLimit" min="-1" max="15000" step="100" value="-1" disabled
                  oninput="updateRangeProgress(this, 'danmuLimitProgress', 'danmuLimitValue', -1, 15000, val => val === -1 ? '不限制' : val)">
         </div>
         <div class="range-labels">
           <span>不限制</span>
           <span>7500条</span>
           <span>15000条</span>
         </div>
         <div class="form-hint">设置每次请求返回的最大弹幕条数（-1 表示不限制）</div>
       </div>

       <div class="quick-config-item">
         <div class="config-item-header">
           <div class="config-item-title">
             <span class="config-icon">Aa</span>
             <span>弹幕字体大小</span>
           </div>
           <div style="display: flex; align-items: center; gap: 12px;">
             <span id="danmuFontSizeValue" class="config-value-display">25</span>
             <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickDanmuFontSize')" title="点击解锁编辑">
               <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/>
               </svg>
               <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/>
               </svg>
             </button>
           </div>
         </div>
         <div class="range-wrapper">
           <div class="range-progress" id="danmuFontSizeProgress" style="width: 0%"></div>
           <input type="range" class="form-range locked" id="quickDanmuFontSize" min="10" max="50" step="1" value="25" disabled
                  oninput="updateRangeProgress(this, 'danmuFontSizeProgress', 'danmuFontSizeValue', 10, 50, val => val + 'px')">
         </div>
         <div class="range-labels">
           <span>10px</span>
           <span>25px (标准)</span>
           <span>50px</span>
         </div>
         <div class="form-hint">调整 XML 输出的弹幕字体大小</div>
       </div>

       <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px;">
         <div class="quick-config-item" style="margin-bottom: 0;">
           <div class="config-item-header">
             <div class="config-item-title">
               <span class="config-icon">📝</span>
               <span>输出格式</span>
             </div>
             <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickOutputFormat')" title="点击解锁编辑">
               <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/>
               </svg>
               <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/>
               </svg>
             </button>
           </div>
           <select class="form-select locked" id="quickOutputFormat" disabled>
             <option value="json">JSON 格式</option>
             <option value="xml">XML 格式</option>
           </select>
         </div>

         <div class="quick-config-item" style="margin-bottom: 0;">
           <div class="config-item-header">
             <div class="config-item-title">
               <span class="config-icon">🔑</span>
               <span>访问令牌</span>
             </div>
             <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickToken')" title="点击解锁编辑">
               <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/>
               </svg>
               <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/>
               </svg>
             </button>
           </div>
           <input type="text" class="form-input locked" id="quickToken" placeholder="87654321" readonly>
         </div>
       </div>

       <!-- 搜索缓存时间 -->
       <div class="quick-config-item">
         <div class="config-item-header">
           <div class="config-item-title">
             <span class="config-icon">🔍</span>
             <span>搜索缓存时间</span>
           </div>
           <div style="display: flex; align-items: center; gap: 12px;">
             <span id="searchCacheValue" class="config-value-display">1</span>
             <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickSearchCache')" title="点击解锁编辑">
               <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/>
               </svg>
               <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/>
               </svg>
             </button>
           </div>
         </div>
         <div class="range-wrapper">
           <div class="range-progress" id="searchCacheProgress" style="width: 0%"></div>
           <input type="range" class="form-range locked" id="quickSearchCache" min="1" max="30" step="1" value="1" disabled
                  oninput="updateRangeProgress(this, 'searchCacheProgress', 'searchCacheValue', 1, 30, val => val + ' 分钟')">
         </div>
         <div class="range-labels">
           <span>1分钟</span>
           <span>15分钟</span>
           <span>30分钟</span>
         </div>
         <div class="form-hint">搜索结果缓存时间，减少重复API请求</div>
       </div>

       <!-- 弹幕缓存时间 -->
       <div class="quick-config-item">
         <div class="config-item-header">
           <div class="config-item-title">
             <span class="config-icon">💬</span>
             <span>弹幕缓存时间</span>
           </div>
           <div style="display: flex; align-items: center; gap: 12px;">
             <span id="commentCacheValue" class="config-value-display">1</span>
             <button class="edit-lock-btn" onclick="toggleQuickConfigLock(this, 'quickCommentCache')" title="点击解锁编辑">
               <svg class="lock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 0110 0v4" stroke-width="2"/>
               </svg>
               <svg class="unlock-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="display: none;">
                 <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"/>
                 <path d="M7 11V7a5 5 0 019.9-1" stroke-width="2"/>
               </svg>
             </button>
           </div>
         </div>
         <div class="range-wrapper">
           <div class="range-progress" id="commentCacheProgress" style="width: 0%"></div>
           <input type="range" class="form-range locked" id="quickCommentCache" min="1" max="60" step="1" value="1" disabled
                  oninput="updateRangeProgress(this, 'commentCacheProgress', 'commentCacheValue', 1, 60, val => val + ' 分钟')">
         </div>
         <div class="range-labels">
           <span>1分钟</span>
           <span>30分钟</span>
           <span>60分钟</span>
         </div>
         <div class="form-hint">弹幕数据缓存时间，减少重复弹幕获取</div>
       </div>
     </div>
     <div class="modal-footer" style="display: flex; gap: 10px; align-items: center;">
       <button class="btn btn-secondary" onclick="closeModal('quickConfigModal')">
         取消
       </button>
       <button class="btn btn-secondary" onclick="closeModal('quickConfigModal'); switchPage('config');" 
               style="display: flex; align-items: center; gap: 6px;">
         <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor">
           <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke-width="2"/>
           <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke-width="2"/>
         </svg>
         <span>全部变量</span>
       </button>
       <div style="flex: 1;"></div>
       <button class="btn btn-primary" onclick="saveQuickConfig()" style="display: flex; align-items: center; gap: 8px;">
         <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
           <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
         </svg>
         <span>保存配置</span>
       </button>
     </div>
   </div>
 </div>

 <!-- 快捷操作按钮 -->
 <button class="fab" onclick="saveAllConfig()" title="保存所有配置 (Ctrl+S)">
   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
     <path d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" stroke-width="2" stroke-linecap="round"/>
   </svg>
 </button>
 <!-- 查看所有环境变量模态框 -->
 <div class="modal-overlay" id="allEnvVarsModal">
   <div class="modal" style="max-width: 900px; max-height: 90vh;">
     <div class="modal-header">
       <h3 class="modal-title">
         <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor">
           <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" stroke-width="2"/>
         </svg>
         环境变量完整配置 (JSON)
       </h3>
       <button class="modal-close" onclick="closeModal('allEnvVarsModal')">
         <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor">
           <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
     </div>
     <div class="modal-body" style="padding: 0;">
       <div class="alert alert-info" style="margin: 20px 20px 0 20px; border-radius: 12px;">
         <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
           <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
           <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
         </svg>
         <span>💡 以下为所有环境变量的真实值（未脱敏），请注意保护敏感信息</span>
       </div>
       
       <div style="padding: 20px; max-height: 60vh; overflow-y: auto;">
         <div style="position: relative;">
           <button onclick="copyAllEnvJson()" class="btn btn-secondary" style="position: absolute; top: 12px; right: 12px; z-index: 10; padding: 8px 16px; font-size: 13px;">
             <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
               <rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-width="2"/>
               <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke-width="2"/>
             </svg>
             复制全部
           </button>
           <pre id="allEnvVarsJson" style="
             background: var(--bg-primary);
             border: 1px solid var(--border-color);
             border-radius: 12px;
             padding: 24px 20px 20px 20px;
             margin: 0;
             overflow-x: auto;
             font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
             font-size: 13px;
             line-height: 1.6;
             color: var(--text-primary);
             white-space: pre-wrap;
             word-break: break-all;
           "></pre>
         </div>
       </div>
     </div>
     <div class="modal-footer" style="padding: 20px; border-top: 2px solid var(--border-color);">
       <button class="btn btn-secondary" onclick="downloadEnvJson()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
           <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" stroke-width="2" stroke-linecap="round"/>
         </svg>
         下载 JSON
       </button>
       <div style="flex: 1;"></div>
       <button class="btn btn-secondary" onclick="closeModal('allEnvVarsModal')">关闭</button>
     </div>
   </div>
 </div>

 <script>
   // ==================== 全局状态管理 ====================
   const AppState = {
     currentEditingEnv: null,
     currentEditingVodIndex: null,
     sourceOrder: ${JSON.stringify(globals.sourceOrderArr)},
     config: ${JSON.stringify(globals.accessedEnvVars)},
     vodServers: ${JSON.stringify(globals.vodServers)},
     hasUnsavedChanges: false
   };

   // ==================== 环境变量描述字典 ====================
   const ENV_DESCRIPTIONS = ${JSON.stringify(ENV_DESCRIPTIONS)};

   // ==================== 初始化 ====================
   document.addEventListener('DOMContentLoaded', function() {
     initializeApp();
     initializeDragAndDrop();
     loadLocalStorageData();
     setupGlobalSearch();

     let resizeTimer;
     window.addEventListener('resize', function() {
       clearTimeout(resizeTimer);
       resizeTimer = setTimeout(() => {
         const currentPage = document.querySelector('.page-section.active');
         if (currentPage && currentPage.id === 'sources-page') {
           refreshSourceGrid();
         }
       }, 250);
     });
   });

   async function initializeApp() {
     // 防止重复初始化
     if (window._appInitialized) {
       console.log('⚠️ 应用已初始化，跳过重复调用');
       return;
     }
     window._appInitialized = true;
     
     console.log('🚀 应用初始化...');
     
     const savedTheme = localStorage.getItem('theme');
     if (savedTheme === null || savedTheme === 'light') {
       document.documentElement.classList.add('light');
       updateThemeIcon(true);
       if (savedTheme === null) {
         localStorage.setItem('theme', 'light');
       }
     } else {
       updateThemeIcon(false);
     }

     // 初始化 API 地址显示
     updateApiUrlDisplay();
     // 检查版本更新
     checkForUpdates();

     // 尝试从服务器加载配置
     try {
       const response = await fetch('/api/config/load');
       const result = await response.json();
       
       if (result.success && result.config) {
         console.log('✅ 从服务器加载配置成功:', result.loadedFrom.join('、'));
         
         // 合并服务器配置到本地状态
         AppState.config = { ...AppState.config, ...result.config };
         
         // 同步更新显示
         for (const [key, value] of Object.entries(result.config)) {
           updateConfigDisplay(key, value);
         }
         
         showToast(\`配置已从 \${result.loadedFrom.join('、')} 加载\`, 'success');
       } else {
         showToast('欢迎回来! 弹幕 API 管理后台已就绪', 'success');
       }
     } catch (error) {
       console.error('从服务器加载配置失败:', error);
       showToast('欢迎回来! 弹幕 API 管理后台已就绪', 'success');
     }
   }

   function loadLocalStorageData() {
     const savedConfig = localStorage.getItem('danmu_api_config');
     if (savedConfig) {
       try {
         const config = JSON.parse(savedConfig);
         AppState.config = { ...AppState.config, ...config };
         console.log('✅ 已加载本地配置');
       } catch (e) {
         console.error('❌ 加载本地配置失败:', e);
       }
     }

     const savedVodServers = localStorage.getItem('danmu_api_vod_servers');
     if (savedVodServers) {
       try {
         AppState.vodServers = JSON.parse(savedVodServers);
         console.log('✅ 已加载 VOD 服务器配置');
       } catch (e) {
         console.error('❌ 加载 VOD 配置失败:', e);
       }
     }

     const savedSourceOrder = localStorage.getItem('danmu_api_source_order');
     if (savedSourceOrder) {
       try {
         AppState.sourceOrder = JSON.parse(savedSourceOrder);
         console.log('✅ 已加载数据源顺序');
       } catch (e) {
         console.error('❌ 加载数据源顺序失败:', e);
       }
     }
   }

   function toggleTheme() {
     const html = document.documentElement;
     const isLight = html.classList.toggle('light');
     updateThemeIcon(isLight);
     localStorage.setItem('theme', isLight ? 'light' : 'dark');
     showToast(\`已切换到\${isLight ? '浅色' : '深色'}主题\`, 'info');
   }

   function updateThemeIcon(isLight) {
     const icon = document.getElementById('themeIcon');
     if (isLight) {
       icon.innerHTML = '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2"/>';
     } else {
       icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2"/>';
     }
   }

   function switchPage(pageName) {
     document.querySelectorAll('.nav-item').forEach(item => {
       item.classList.remove('active');
     });
     event.currentTarget.classList.add('active');

     document.querySelectorAll('.page-section').forEach(section => {
       section.classList.remove('active');
     });
     document.getElementById(pageName + '-page').classList.add('active');

     const titles = {
       'overview': '系统概览',
       'config': '环境配置',
       'about': '关于系统',
       'sources': '搜索源管理',
       'danmuTest': '弹幕测试',
       'push': '弹幕推送',
       'cache': '缓存管理'
     };
     document.getElementById('pageTitle').textContent = titles[pageName];
     
     // 页面切换后执行特定初始化
     if (pageName === 'sources') {
       initSourcesPage();
     } else if (pageName === 'danmuTest') {
       initDanmuTestPage();
     } else if (pageName === 'cache') {
       initCachePage();
     }
     
     closeMobileMenu();
     window.scrollTo({ top: 0, behavior: 'smooth' });
   }

   // ========== 搜索源管理功能 ==========
   let vodHealthData = [];
   let vodPerformanceChart = null;
   
   // 所有可用的搜索源列表（360独立于vod）
   const ALL_SOURCES = ['360', 'vod', 'tmdb', 'douban', 'tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'renren', 'hanjutv', 'bahamut'];
   
   // 所有可用的弹幕平台列表
   const ALL_PLATFORMS = ['qiyi', 'bilibili1', 'imgo', 'youku', 'qq', 'renren', 'hanjutv', 'bahamut'];
   
   // 源名称映射
   const SOURCE_NAMES = {
     '360': '360影视',
     'vod': 'VOD采集站',
     'tmdb': 'TMDB',
     'douban': '豆瓣',
     'tencent': '腾讯视频',
     'youku': '优酷',
     'iqiyi': '爱奇艺',
     'imgo': 'IMGO',
     'bilibili': '哔哩哔哩',
     'renren': '人人影视',
     'hanjutv': '韩剧TV',
     'bahamut': '巴哈姆特'
   };
   
   // 源描述映射
   const SOURCE_DESCRIPTIONS = {
     '360': '360影视搜索引擎（独立源）',
     'vod': 'VOD影视采集站集合',
     'tmdb': 'The Movie Database 国际影视数据库',
     'douban': '豆瓣电影数据源',
     'tencent': '腾讯视频官方源',
     'youku': '优酷视频官方源',
     'iqiyi': '爱奇艺视频官方源',
     'imgo': 'IMGO 动漫数据库',
     'bilibili': '哔哩哔哩视频源',
     'renren': '人人影视字幕组',
     'hanjutv': '韩剧TV数据源',
     'bahamut': '巴哈姆特动画疯'
   };
   
   // 平台名称映射
   const PLATFORM_NAMES = {
     'qiyi': '爱奇艺',
     'bilibili1': '哔哩哔哩',
     'imgo': 'IMGO',
     'youku': '优酷',
     'qq': '腾讯视频',
     'renren': '人人影视',
     'hanjutv': '韩剧TV',
     'bahamut': '巴哈姆特'
   };
   
   // 平台描述映射
   const PLATFORM_DESCRIPTIONS = {
     'qiyi': '爱奇艺弹幕平台',
     'bilibili1': '哔哩哔哩弹幕平台',
     'imgo': 'IMGO 弹幕平台',
     'youku': '优酷弹幕平台',
     'qq': '腾讯视频弹幕平台',
     'renren': '人人影视弹幕平台',
     'hanjutv': '韩剧TV弹幕平台',
     'bahamut': '巴哈姆特弹幕平台'
   };
   
   // 源状态管理（启用/禁用）
   let sourceStatus = {};
   let platformStatus = {};

   function initSourcesPage() {
     console.log('初始化搜索源管理页面');
     
     // 1. 动态合并环境变量中的自定义源到 ALL_SOURCES
     if (AppState.config.SOURCE_ORDER) {
       const configuredSources = AppState.config.SOURCE_ORDER.split(',').map(s => s.trim()).filter(s => s);
       configuredSources.forEach(s => {
         if (!ALL_SOURCES.includes(s)) ALL_SOURCES.push(s);
       });
     }

     // 2. 动态合并环境变量中的自定义平台到 ALL_PLATFORMS
     if (AppState.config.PLATFORM_ORDER) {
       const configuredPlatforms = AppState.config.PLATFORM_ORDER.split(',').map(s => s.trim()).filter(s => s);
       configuredPlatforms.forEach(p => {
         if (!ALL_PLATFORMS.includes(p)) ALL_PLATFORMS.push(p);
       });
     }

     // 3. 初始化源状态 (基于 SOURCE_ORDER 环境变量作为事实标准)
     // 如果配置了 SOURCE_ORDER，则只启用在其中的项，其他的禁用。如果没有配置，则默认全部启用。
     if (AppState.config.SOURCE_ORDER) {
       const activeSources = new Set(AppState.config.SOURCE_ORDER.split(',').map(s => s.trim()));
       ALL_SOURCES.forEach(source => {
         sourceStatus[source] = activeSources.has(source);
       });
     } else {
       // 首次使用或未配置，默认全部启用
       ALL_SOURCES.forEach(source => sourceStatus[source] = true);
       // 尝试读取旧的辅助状态配置（如果有）
       if (AppState.config.SOURCE_STATUS) {
         try {
           const savedStatus = JSON.parse(AppState.config.SOURCE_STATUS);
           Object.assign(sourceStatus, savedStatus);
         } catch (e) { console.warn('解析 SOURCE_STATUS 失败'); }
       }
     }
     
     // 4. 初始化平台状态 (同理)
     if (AppState.config.PLATFORM_ORDER) {
       const activePlatforms = new Set(AppState.config.PLATFORM_ORDER.split(',').map(s => s.trim()));
       ALL_PLATFORMS.forEach(platform => {
         platformStatus[platform] = activePlatforms.has(platform);
       });
     } else {
       ALL_PLATFORMS.forEach(platform => platformStatus[platform] = true);
       if (AppState.config.PLATFORM_STATUS) {
         try {
           const savedStatus = JSON.parse(AppState.config.PLATFORM_STATUS);
           Object.assign(platformStatus, savedStatus);
         } catch (e) { console.warn('解析 PLATFORM_STATUS 失败'); }
       }
     }
     
     loadSourceOrderList();
     loadPlatformOrderList();
     loadVodHealthList();
     loadSourceSettings();
   }
   
   // 切换源标签页
   function switchSourceTab(tabName) {
     // 更新标签按钮状态
     document.querySelectorAll('.tabs .tab-item').forEach(btn => {
       btn.classList.remove('active');
     });
     event.target.closest('.tab-item').classList.add('active');
     
     // 更新标签页内容
     document.querySelectorAll('.source-tab-content').forEach(content => {
       content.classList.remove('active');
     });
     
     const tabMap = {
       'search': 'searchSourceTab',
       'platform': 'platformSourceTab',
       'vod': 'vodSourceTab',
       'settings': 'settingsSourceTab'
     };
     
     const targetTab = document.getElementById(tabMap[tabName]);
     if (targetTab) {
       targetTab.classList.add('active');
     }
   }
   // 加载搜索源顺序列表
   function loadSourceOrderList() {
     const container = document.getElementById('sourceOrderList');
     if (!container) return;

     // 1. 解析环境变量中的顺序（这些是启用的，且有顺序）
     let activeOrder = [];
     const sourceOrderEnv = AppState.config.SOURCE_ORDER;
     
     if (sourceOrderEnv) {
       activeOrder = sourceOrderEnv.split(',').map(s => s.trim()).filter(s => s);
     } else {
       // 默认缺省
       activeOrder = ['360', 'vod', 'renren', 'hanjutv'];
     }
     
     // 2. 构建完整列表：先放启用的（按顺序），再放禁用的（按默认顺序）
     // 这样确保列表里包含所有 ALL_SOURCES 里的项
     const finalOrder = [...activeOrder];
     
     // 找出所有不在 activeOrder 里的源，追加到后面
     ALL_SOURCES.forEach(source => {
       if (!finalOrder.includes(source)) {
         finalOrder.push(source);
       }
     });

     const html = finalOrder.map((source, index) => {
       const sourceName = SOURCE_NAMES[source] || source;
       const sourceDesc = SOURCE_DESCRIPTIONS[source] || '自定义数据源';
       // 简单的图标逻辑：如果是已知源用已知图标，否则取首字母
       let icon = source.substring(0, 2).toUpperCase();
       if (source === '360') icon = '360';
       
       // 状态判断：必须显式为 true (基于 initSourcesPage 的初始化逻辑)
       const isEnabled = sourceStatus[source] === true;
       const disabledClass = isEnabled ? '' : 'disabled';
       
       // 优先级显示：只有启用的才显示数字，禁用的显示 -
       const priorityDisplay = isEnabled ? (activeOrder.indexOf(source) + 1) : '-';
       const priorityClass = isEnabled ? '' : 'style="background: var(--text-tertiary);"';
       
       return \`
         <div class="source-modern-item draggable \${disabledClass}" draggable="true" data-index="\${index}" data-source="\${source}">
           <div class="source-modern-handle">
             <svg viewBox="0 0 24 24" width="16" height="16">
               <path d="M9 5h2v2H9V5zm0 6h2v2H9v-2zm0 6h2v2H9v-2zm4-12h2v2h-2V5zm0 6h2v2h-2v-2zm0 6h2v2h-2v-2z" fill="currentColor"/>
             </svg>
           </div>
           <div class="source-modern-priority" \${priorityClass}>\${priorityDisplay}</div>
           <div class="source-modern-icon">\${icon}</div>
           <div class="source-modern-info">
             <div class="source-modern-name">\${sourceName}</div>
             <div class="source-modern-desc">\${sourceDesc}</div>
           </div>
           <div class="source-modern-toggle">
             <label class="switch">
               <input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="toggleSource('\${source}', this.checked)">
               <span class="switch-slider"></span>
             </label>
           </div>
         </div>
       \`;
     }).join('');

     container.innerHTML = html;
     initDragAndDrop('sourceOrderList');
   }
   
   // 切换源启用状态
   function toggleSource(source, enabled) {
     sourceStatus[source] = enabled;
     
     const item = document.querySelector(\`.source-modern-item[data-source="\${source}"]\`);
     if (item) {
       if (enabled) {
         item.classList.remove('disabled');
       } else {
         item.classList.add('disabled');
       }
     }
     
     showToast(\`\${SOURCE_NAMES[source] || source} 已\${enabled ? '启用' : '禁用'}\`, enabled ? 'success' : 'warning', 2000);
   }

   // 加载弹幕平台顺序列表
   function loadPlatformOrderList() {
     const container = document.getElementById('platformOrderList');
     if (!container) return;

     // 1. 解析环境变量中的顺序（启用的）
     let activeOrder = [];
     const platformOrderEnv = AppState.config.PLATFORM_ORDER;
     
     if (platformOrderEnv) {
       activeOrder = platformOrderEnv.split(',').map(s => s.trim()).filter(s => s);
     }
     
     // 2. 构建完整列表：先放启用的，再放禁用的
     const finalOrder = [...activeOrder];
     ALL_PLATFORMS.forEach(platform => {
       if (!finalOrder.includes(platform)) {
         finalOrder.push(platform);
       }
     });

     const html = finalOrder.map((platform, index) => {
       const platformName = PLATFORM_NAMES[platform] || platform;
       const platformDesc = PLATFORM_DESCRIPTIONS[platform] || '自定义平台';
       const icon = platform.substring(0, 2).toUpperCase();
       
       const isEnabled = platformStatus[platform] === true;
       const disabledClass = isEnabled ? '' : 'disabled';
       
       const priorityDisplay = isEnabled ? (activeOrder.indexOf(platform) + 1) : '-';
       const priorityClass = isEnabled ? '' : 'style="background: var(--text-tertiary);"';
       
       return \`
         <div class="source-modern-item draggable \${disabledClass}" draggable="true" data-index="\${index}" data-platform="\${platform}">
           <div class="source-modern-handle">
             <svg viewBox="0 0 24 24" width="16" height="16">
               <path d="M9 5h2v2H9V5zm0 6h2v2H9v-2zm0 6h2v2H9v-2zm4-12h2v2h-2V5zm0 6h2v2h-2v-2zm0 6h2v2h-2v-2z" fill="currentColor"/>
             </svg>
           </div>
           <div class="source-modern-priority" \${priorityClass}>\${priorityDisplay}</div>
           <div class="source-modern-icon">\${icon}</div>
           <div class="source-modern-info">
             <div class="source-modern-name">\${platformName}</div>
             <div class="source-modern-desc">\${platformDesc}</div>
           </div>
           <div class="source-modern-toggle">
             <label class="switch">
               <input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="togglePlatform('\${platform}', this.checked)">
               <span class="switch-slider"></span>
             </label>
           </div>
         </div>
       \`;
     }).join('');

     container.innerHTML = html;
     initDragAndDrop('platformOrderList');
   }
   
   // 切换平台启用状态
   function togglePlatform(platform, enabled) {
     platformStatus[platform] = enabled;
     
     const item = document.querySelector(\`.source-modern-item[data-platform="\${platform}"]\`);
     if (item) {
       if (enabled) {
         item.classList.remove('disabled');
       } else {
         item.classList.add('disabled');
       }
     }
     
     showToast(\`\${PLATFORM_NAMES[platform] || platform} 已\${enabled ? '启用' : '禁用'}\`, enabled ? 'success' : 'warning', 2000);
   }

   // 初始化拖拽功能
   function initDragAndDrop(containerId) {
     const container = document.getElementById(containerId);
     if (!container) return;

     let draggedItem = null;

     container.addEventListener('dragstart', function(e) {
       if (e.target.classList.contains('draggable')) {
         draggedItem = e.target;
         e.target.classList.add('dragging');
       }
     });

     container.addEventListener('dragend', function(e) {
       if (e.target.classList.contains('draggable')) {
         e.target.classList.remove('dragging');
       }
     });

     container.addEventListener('dragover', function(e) {
       e.preventDefault();
       const afterElement = getDragAfterElement(container, e.clientY);
       const dragging = container.querySelector('.dragging');
       
       if (afterElement == null) {
         container.appendChild(dragging);
       } else {
         container.insertBefore(dragging, afterElement);
       }
     });

     function getDragAfterElement(container, y) {
       const draggableElements = [...container.querySelectorAll('.draggable:not(.dragging)')];

       return draggableElements.reduce((closest, child) => {
         const box = child.getBoundingClientRect();
         const offset = y - box.top - box.height / 2;

         if (offset < 0 && offset > closest.offset) {
           return { offset: offset, element: child };
         } else {
           return closest;
         }
       }, { offset: Number.NEGATIVE_INFINITY }).element;
     }
   }

   // 保存搜索源顺序
   async function saveSourceOrder() {
     const container = document.getElementById('sourceOrderList');
     if (!container) return;

     const items = container.querySelectorAll('.source-modern-item');
     const newOrder = Array.from(items).map(item => item.dataset.source);
     
     // 过滤掉禁用的源
     const enabledOrder = newOrder.filter(source => sourceStatus[source] !== false);

     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           config: { 
             SOURCE_ORDER: enabledOrder.join(','),
             SOURCE_STATUS: JSON.stringify(sourceStatus)
           }
         })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.config.SOURCE_ORDER = enabledOrder.join(',');
         AppState.config.SOURCE_STATUS = JSON.stringify(sourceStatus);
         showToast(\`搜索源配置已保存（启用 \${enabledOrder.length}/\${newOrder.length} 个源）\`, 'success');
         loadSourceOrderList(); // 重新加载以更新优先级数字
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   // 保存弹幕平台顺序
   async function savePlatformOrder() {
     const container = document.getElementById('platformOrderList');
     if (!container) return;

     const items = container.querySelectorAll('.source-modern-item');
     const newOrder = Array.from(items).map(item => item.dataset.platform);
     
     // 过滤掉禁用的平台
     const enabledOrder = newOrder.filter(platform => platformStatus[platform] !== false);

     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           config: { 
             PLATFORM_ORDER: enabledOrder.join(','),
             PLATFORM_STATUS: JSON.stringify(platformStatus)
           }
         })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.config.PLATFORM_ORDER = enabledOrder.join(',');
         AppState.config.PLATFORM_STATUS = JSON.stringify(platformStatus);
         showToast(\`弹幕平台配置已保存（启用 \${enabledOrder.length}/\${newOrder.length} 个平台）\`, 'success');
         loadPlatformOrderList(); // 重新加载以更新优先级数字
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   // 恢复默认搜索源顺序
   async function resetSourceOrder() {
     if (!confirm('确定要恢复默认搜索源顺序吗？')) return;

     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           config: { SOURCE_ORDER: '360,vod,renren,hanjutv' }
         })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.config.SOURCE_ORDER = '360,vod,renren,hanjutv';
         loadSourceOrderList();
         showToast('已恢复默认搜索源顺序', 'success');
       } else {
         throw new Error(result.errorMessage || '恢复失败');
       }
     } catch (error) {
       showToast('恢复失败: ' + error.message, 'error');
     }
   }

   // 恢复默认弹幕平台顺序
   async function resetPlatformOrder() {
     if (!confirm('确定要清空弹幕平台优先级配置吗？清空后将返回第一个满足条件的平台。')) return;

     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           config: { PLATFORM_ORDER: '' }
         })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.config.PLATFORM_ORDER = '';
         loadPlatformOrderList();
         showToast('已清空弹幕平台优先级配置', 'success');
       } else {
         throw new Error(result.errorMessage || '恢复失败');
       }
     } catch (error) {
       showToast('恢复失败: ' + error.message, 'error');
     }
   }
   // 加载源配置设置
   function loadSourceSettings() {
     const vodReturnMode = AppState.config.VOD_RETURN_MODE || 'fastest';
     const vodTimeout = parseInt(AppState.config.VOD_REQUEST_TIMEOUT) || 10000;
     
     const modeSelect = document.getElementById('vodReturnModeSelect');
     const timeoutRange = document.getElementById('vodTimeoutRange');
     
     if (modeSelect) {
       modeSelect.value = vodReturnMode;
       updateVodReturnModeBadge();
     }
     
     if (timeoutRange) {
       timeoutRange.value = vodTimeout;
       updateRangeProgress(timeoutRange, 'vodTimeoutProgress', 'vodTimeoutValue', 5000, 30000, val => val + ' ms');
     }
   }
   
   // 更新 VOD 返回模式徽章
   function updateVodReturnModeBadge() {
     const select = document.getElementById('vodReturnModeSelect');
     const badge = document.getElementById('vodReturnModeBadge');
     
     if (!select || !badge) return;
     
     badge.textContent = select.value;
   }
   
   // 保存源配置设置
   async function saveSourceSettings() {
     const vodReturnMode = document.getElementById('vodReturnModeSelect').value;
     const vodTimeout = document.getElementById('vodTimeoutRange').value;
     
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           config: {
             VOD_RETURN_MODE: vodReturnMode,
             VOD_REQUEST_TIMEOUT: vodTimeout
           }
         })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.config.VOD_RETURN_MODE = vodReturnMode;
         AppState.config.VOD_REQUEST_TIMEOUT = vodTimeout;
         showToast('源配置已保存', 'success');
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }
   function loadVodHealthList() {
     const container = document.getElementById('vodHealthList');
     if (!container) return;
     const vodServers = AppState.vodServers;

     if (!vodServers || vodServers.length === 0) {
       container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-title">暂无采集站</div></div>';
       return;
     }

     const html = vodServers.map((server, index) => {
       let serverName = \`服务器 #\${index + 1}\`;
       let serverUrl = '';
       let isBuiltin = false;

       if (typeof server === 'string') {
         serverUrl = server;
         if (server.includes('@')) {
           const parts = server.split('@');
           serverName = parts[0];
           serverUrl = parts.slice(1).join('@');
           isBuiltin = serverName.toLowerCase() === '360kan';
         }
       } else if (typeof server === 'object' && server !== null) {
         serverName = server.name || server.title || serverName;
         serverUrl = server.url || server.baseUrl || server.address || '';
         isBuiltin = server.builtin || serverName.toLowerCase() === '360kan';
       }

       const builtinBadge = isBuiltin ? '<div class="server-badge default-badge" style="position: absolute; top: 16px; right: 16px; font-size: 11px; padding: 2px 8px;">内置</div>' : '';
       const deleteButton = !isBuiltin ? \`
         <button class="icon-btn delete-btn" onclick="deleteVodServer(\${index})" title="删除">
           <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
             <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2"/>
           </svg>
         </button>
       \` : '';

       return \`
         <div class="server-item" data-index="\${index}" id="vod-health-\${index}" style="position: relative;">
           \${builtinBadge}
           <div class="server-badge">\${index + 1}</div>
           <div class="server-info">
             <div class="server-name">\${serverName}</div>
             <div class="server-url">\${serverUrl}</div>
             <div style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
               <span id="vod-status-\${index}" style="display: inline-flex; align-items: center; gap: 4px;">
                 <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary);"></span>
                 未测试
               </span>
               <span style="margin: 0 8px;">|</span>
               <span id="vod-time-\${index}">- ms</span>
             </div>
           </div>
           <div class="server-actions">
             <button class="icon-btn" onclick="testSingleVod(\${index})" title="测试连接">
               <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" fill="currentColor"/>
                 <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
               </svg>
             </button>
             <button class="icon-btn" onclick="editVodServer(\${index})" title="编辑">
               <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                 <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke-width="2"/>
                 <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke-width="2"/>
               </svg>
             </button>
             \${deleteButton}
           </div>
         </div>
       \`;
     }).join('');

     container.innerHTML = html;
   }

   // 显示添加采集站弹窗
   function showAddVodModal() {
     AppState.currentEditingVodIndex = undefined;
     document.getElementById('vodModalTitle').textContent = '添加采集站';
     document.getElementById('vodServerName').value = '';
     document.getElementById('vodServerUrl').value = '';
     document.getElementById('vodServerName').readOnly = false;
     console.log('[VOD] 进入新增模式，currentEditingVodIndex:', AppState.currentEditingVodIndex);
     showModal('editVodModal');
   }

   // 编辑采集站
   function editVodServer(index) {
     const server = AppState.vodServers[index];
     let serverName = '';
     let serverUrl = '';

     if (typeof server === 'string') {
       if (server.includes('@')) {
         const parts = server.split('@');
         serverName = parts[0];
         serverUrl = parts.slice(1).join('@');
       } else {
         serverUrl = server;
       }
     } else if (server && typeof server === 'object') {
       serverName = server.name || '';
       serverUrl = server.url || '';
     }

     // 设置编辑索引（关键步骤）
     AppState.currentEditingVodIndex = index;
     
     document.getElementById('vodModalTitle').textContent = '编辑采集站';
     document.getElementById('vodServerName').value = serverName;
     document.getElementById('vodServerUrl').value = serverUrl;
     document.getElementById('vodServerName').readOnly = false;
     
     console.log('进入编辑模式，索引: ' + index + ', 名称: ' + serverName);
     showModal('editVodModal');
   }

   // 删除采集站
   async function deleteVodServer(index) {
     const server = AppState.vodServers[index];
     let serverName = typeof server === 'string' 
       ? (server.includes('@') ? server.split('@')[0] : '服务器')
       : (server.name || '服务器');

     if (!confirm(\`确定要删除采集站 "\${serverName}" 吗？\`)) {
       return;
     }

     AppState.vodServers.splice(index, 1);
     await saveVodServersConfig();
     loadVodHealthList();
     showToast(\`采集站 "\${serverName}" 已删除\`, 'success');
   }

   // 保存采集站配置
   async function saveVodServer() {
     const name = document.getElementById('vodServerName').value.trim();
     const url = document.getElementById('vodServerUrl').value.trim();

     if (!name) {
       showToast('请输入采集站名称', 'error');
       return;
     }

     if (!url) {
       showToast('请输入采集站地址', 'error');
       return;
     }

     if (!url.startsWith('http://') && !url.startsWith('https://')) {
       showToast('采集站地址必须以 http:// 或 https:// 开头', 'error');
       return;
     }

     const serverStr = name + '@' + url;

     const isEditMode = typeof AppState.currentEditingVodIndex === 'number' && 
                        AppState.currentEditingVodIndex >= 0;
     
     console.log('[VOD] 保存模式:', isEditMode ? '编辑' : '新增', ', 索引:', AppState.currentEditingVodIndex);

     const exists = AppState.vodServers.some((s, index) => {
       if (isEditMode && index === AppState.currentEditingVodIndex) {
         return false;
       }
       
       const existingName = typeof s === 'string' 
         ? (s.includes('@') ? s.split('@')[0] : '')
         : (s.name || '');
       return existingName.toLowerCase() === name.toLowerCase();
     });

     if (exists) {
       showToast('采集站 "' + name + '" 已存在', 'error');
       return;
     }

     if (isEditMode) {
       console.log('[VOD] 编辑采集站，索引:', AppState.currentEditingVodIndex);
       AppState.vodServers[AppState.currentEditingVodIndex] = serverStr;
     } else {
       console.log('[VOD] 新增采集站:', name);
       AppState.vodServers.push(serverStr);
       console.log('[VOD] 采集站已添加，当前总数:', AppState.vodServers.length);
     }

     await saveVodServersConfig();
     
     AppState.currentEditingVodIndex = undefined;
     
     closeModal('editVodModal');
     loadVodHealthList();
     showToast('采集站 "' + name + '" 已保存', 'success');
   }

   // 保存采集站配置到服务器
   async function saveVodServersConfig() {
     const vodServersStr = AppState.vodServers.map(s => {
       if (typeof s === 'string') return s;
       return s.name + '@' + s.url;
     }).join(',');

     console.log('[VOD] 准备保存配置，共', AppState.vodServers.length, '个采集站');
     console.log('[VOD] 配置字符串:', vodServersStr);

     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           config: { VOD_SERVERS: vodServersStr }
         })
       });

       const result = await response.json();
       
       if (!result.success) {
         throw new Error(result.errorMessage || '保存失败');
       }
       
       console.log('[VOD] 配置保存成功，保存到:', result.savedTo ? result.savedTo.join('、') : '未知');
       
     } catch (error) {
       console.error('[VOD] 保存采集站配置失败:', error);
       showToast('保存失败: ' + error.message, 'error');
       throw error;
     }
   }

   // 测试单个采集站
   async function testSingleVod(index) {
     const statusEl = document.getElementById(\`vod-status-\${index}\`);
     const timeEl = document.getElementById(\`vod-time-\${index}\`);
     
     if (!statusEl || !timeEl) return;

     statusEl.innerHTML = '<span class="loading-spinner" style="width: 12px; height: 12px; border-width: 2px;"></span> 测试中...';
     timeEl.textContent = '- ms';

     try {
       const server = AppState.vodServers[index];
       let serverUrl = '';
       
       if (typeof server === 'string') {
         serverUrl = server.includes('@') ? server.split('@').slice(1).join('@') : server;
       } else if (server && server.url) {
         serverUrl = server.url;
       }

       if (!serverUrl) {
         throw new Error('无效的服务器地址');
       }

       const startTime = Date.now();
       const response = await fetch(\`/api/vod/test?url=\${encodeURIComponent(serverUrl)}\`, {
         method: 'GET',
         signal: AbortSignal.timeout(10000)
       });

       const endTime = Date.now();
       const responseTime = endTime - startTime;

       if (response.ok) {
         const result = await response.json();
         if (result.success) {
           statusEl.innerHTML = \`
             <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--success); display: inline-block;"></span>
             <span style="color: var(--success);">在线</span>
           \`;
           timeEl.textContent = \`\${responseTime} ms\`;
           timeEl.style.color = responseTime < 1000 ? 'var(--success)' : responseTime < 3000 ? 'var(--warning)' : 'var(--error)';
           
           vodHealthData[index] = { status: 'online', time: responseTime };
         } else {
           throw new Error(result.error || '测试失败');
         }
       } else {
         throw new Error(\`HTTP \${response.status}\`);
       }
     } catch (error) {
       console.error(\`采集站测试失败[\${index}]:\`, error);
       statusEl.innerHTML = \`
         <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--error); display: inline-block;"></span>
         <span style="color: var(--error);">离线</span>
       \`;
       timeEl.textContent = '超时';
       timeEl.style.color = 'var(--error)';
       
       vodHealthData[index] = { status: 'offline', time: 0 };
     }

     updateVodPerformanceChart();
   }

   // 测试所有采集站
   async function testAllVodServers() {
     showToast('开始测试所有采集站...', 'info', 2000);
     vodHealthData = [];
     
     const servers = AppState.vodServers;
     for (let i = 0; i < servers.length; i++) {
       await testSingleVod(i);
       await new Promise(resolve => setTimeout(resolve, 500));
     }
     
     showToast('所有采集站测试完成', 'success');
   }

   // 更新性能对比图表
   function updateVodPerformanceChart() {
     const ctx = document.getElementById('vodPerformanceChart');
     if (!ctx) return;

     const labels = AppState.vodServers.map((server, index) => {
       if (typeof server === 'string') {
         return server.includes('@') ? server.split('@')[0] : \`服务器\${index + 1}\`;
       }
       return server.name || \`服务器\${index + 1}\`;
     });

     const data = vodHealthData.map(item => item ? item.time : 0);
     const colors = vodHealthData.map(item => {
       if (!item || item.status === 'offline') return 'rgba(239, 68, 68, 0.6)';
       if (item.time < 1000) return 'rgba(16, 185, 129, 0.6)';
       if (item.time < 3000) return 'rgba(245, 158, 11, 0.6)';
       return 'rgba(239, 68, 68, 0.6)';
     });

     if (vodPerformanceChart) {
       vodPerformanceChart.destroy();
     }

     vodPerformanceChart = new Chart(ctx, {
       type: 'bar',
       data: {
         labels: labels,
         datasets: [{
           label: '响应时间 (ms)',
           data: data,
           backgroundColor: colors,
           borderColor: colors.map(c => c.replace('0.6', '1')),
           borderWidth: 1
         }]
       },
       options: {
         responsive: true,
         maintainAspectRatio: false,
         plugins: {
           legend: { display: false },
           tooltip: {
             callbacks: {
               label: function(context) {
                 const value = context.parsed.y;
                 if (value === 0) return '离线或未测试';
                 return \`响应时间: \${value} ms\`;
               }
             }
           }
         },
         scales: {
           y: {
             beginAtZero: true,
             title: { display: true, text: '响应时间 (ms)' },
             grid: { color: 'rgba(255, 255, 255, 0.1)' },
             ticks: { color: '#9ca3af' }
           },
           x: {
             grid: { color: 'rgba(255, 255, 255, 0.1)' },
             ticks: { color: '#9ca3af' }
           }
         }
       }
     });
   }

   // ========== 弹幕测试功能 ==========
   // ========== 弹幕测试功能 ==========
   let currentDanmuData = [];
   let filteredDanmuData = [];
   let danmuTimeChart = null;
   let currentDanmuMode = 'match'; // 'match' | 'search'
   let currentApiUrl = ''; // 保存当前请求的API地址

   function initDanmuTestPage() {
     console.log('初始化弹幕测试页面');
     currentDanmuData = [];
     filteredDanmuData = [];
     currentApiUrl = '';
     // 默认模式
     switchDanmuMode('match');
     
     // 确保高级设置初始状态正确
     const options = document.getElementById('matchOptions');
     const toggle = document.getElementById('advancedToggleBtn');
     if (options) options.classList.remove('show');
     if (toggle) toggle.classList.remove('active');
   }

   // 切换高级设置显示
   function toggleAdvancedSettings() {
     const options = document.getElementById('matchOptions');
     const toggle = document.getElementById('advancedToggleBtn');
     
     if (options.classList.contains('show')) {
       options.classList.remove('show');
       toggle.classList.remove('active');
     } else {
       options.classList.add('show');
       toggle.classList.add('active');
     }
   }

   // 切换模式
   function switchDanmuMode(mode) {
     currentDanmuMode = mode;
     
     // 更新 Tab 样式
     document.querySelectorAll('.tabs .tab-item').forEach(btn => btn.classList.remove('active'));
     document.getElementById(\`tab-\${mode}\`).classList.add('active');

     // 更新 UI 显示
     const advancedToggle = document.getElementById('advancedToggleBtn');
     const matchOptions = document.getElementById('matchOptions');
     const manualResults = document.getElementById('manualSearchResults');
     const matchResultCard = document.getElementById('matchResultCard');
     const actionText = document.getElementById('danmuActionText');
     const inputLabel = document.getElementById('danmuInputLabel');
     const inputHint = document.getElementById('danmuInputHint');
     const input = document.getElementById('danmuTestInput');

     if (mode === 'match') {
       advancedToggle.style.display = 'flex';
       manualResults.style.display = 'none';
       // 保持高级选项的折叠状态，不强制显示
       // 只有当有匹配ID时才显示结果卡片
       if (matchResultCard.querySelector('#matchedEpisodeId').textContent !== '-') {
         matchResultCard.style.display = 'block';
       } else {
         matchResultCard.style.display = 'none';
       }
       actionText.textContent = '自动匹配';
       inputLabel.textContent = '🎬 文件名 / 标题 / 视频链接';
       input.placeholder = '请输入...';
       inputHint.textContent = '💡 自动解析文件名 (如: 藏海传 S01E01) 或粘贴视频链接 (如: https://youku.com/...)';
     } else {
       advancedToggle.style.display = 'none';
       matchOptions.classList.remove('show'); // 搜索模式下强制隐藏
       manualResults.style.display = 'block';
       matchResultCard.style.display = 'none';
       actionText.textContent = '搜索动漫';
       inputLabel.textContent = '🔍 动漫/电影名称';
       input.placeholder = '请输入...';
       inputHint.textContent = '💡 搜索动漫数据库 (如: 进击的巨人、流浪地球)，并手动选择集数';
     }
   }

   // 执行动作（匹配或搜索）
   async function performDanmuAction() {
     const input = document.getElementById('danmuTestInput').value.trim();
     if (!input) {
       showToast('请输入内容', 'warning');
       return;
     }

     if (currentDanmuMode === 'match') {
       await executeAutoMatch(input);
     } else {
       await executeManualSearch(input);
     }
   }

   // 逻辑1：自动匹配 (Auto Match)
   async function executeAutoMatch(input) {
     const matchResultCard = document.getElementById('matchResultCard');
     matchResultCard.style.display = 'none';
     
     clearDanmuPreview();
     showLoading('正在智能匹配...', 'Auto Match 接口');

     const year = document.getElementById('danmuTestYear').value.trim();
     const season = document.getElementById('danmuTestSeason').value.trim();
     const episode = document.getElementById('danmuTestEpisode').value.trim();
     const platform = document.getElementById('danmuTestPlatform').value;

     try {
       let apiUrl = '';
       let matchInfo = null;

       if (input.startsWith('http://') || input.startsWith('https://')) {
         apiUrl = '/api/v2/comment?url=' + encodeURIComponent(input);
       } else {
         // 构建搜索字符串，转义正则中的特殊字符
         let searchQuery = input
           .replace(/\\.(mkv|mp4|avi|flv|wmv|mov|rmvb|webm)$/i, '')
           .replace(/[\\[\\](){}]/g, ' ')
           .trim();
         
         if (year && !/\\.(19|20)\\d{2}\\./.test(searchQuery)) searchQuery += '.' + year;
         
         const finalSeason = season || '1';
         if (episode) {
           searchQuery += ' S' + finalSeason.padStart(2, '0') + 'E' + episode.padStart(2, '0');
         } else if (season) {
           searchQuery += ' S' + season.padStart(2, '0');
         }
         
         if (platform) searchQuery += ' @' + platform;

         showToast('🔍 正在匹配: ' + searchQuery, 'info', 2000);
         
         // 调用 Match 接口
         const matchResponse = await fetch('/api/v2/match', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ fileName: searchQuery })
         });
         
         const matchResult = await matchResponse.json();
         if (!matchResult.success) throw new Error(matchResult.errorMessage || '匹配失败');
         if (!matchResult.isMatched || !matchResult.matches || matchResult.matches.length === 0) {
           throw new Error('未找到匹配结果');
         }
         
         matchInfo = matchResult.matches[0];
         showToast('✅ 匹配成功: ' + matchInfo.animeTitle, 'success');
         displayMatchResult(matchInfo);
         
         apiUrl = '/api/v2/comment/' + matchInfo.episodeId;
       }

       // 默认以 JSON 格式请求数据
       await fetchAndDisplayDanmu(apiUrl + '?format=json');

     } catch (error) {
       showError('匹配失败', error.message);
     }
   }

   // 逻辑2：手动搜索 (Manual Search)
   async function executeManualSearch(keyword) {
     const animeContainer = document.getElementById('animeListContainer');
     
     // 确保回到列表视图
     backToAnimeList();
     
     animeContainer.innerHTML = \`
       <div style="grid-column: 1/-1; text-align: center; padding: 60px 0; color: var(--text-secondary);">
         <span class="loading-spinner" style="width: 32px; height: 32px; border-width: 3px;"></span> 
         <div style="margin-top: 16px;">正在搜索动漫...</div>
       </div>\`;
     
     try {
       const response = await fetch(\`/api/v2/search/anime?keyword=\${encodeURIComponent(keyword)}\`);
       const result = await response.json();
       
       if (!result.success || !result.animes || result.animes.length === 0) {
         animeContainer.innerHTML = \`
           <div style="grid-column: 1/-1; text-align: center; padding: 60px 0; color: var(--text-tertiary);">
             <div style="font-size: 48px; margin-bottom: 12px; opacity: 0.5;">🤔</div>
             未找到相关动漫，请尝试更换关键词
           </div>\`;
         return;
       }
       
       renderAnimeList(result.animes);
     } catch (error) {
       animeContainer.innerHTML = \`<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--error);">搜索出错: \${error.message}</div>\`;
     }
   }

   // 渲染动漫列表 (优化标题和标签显示)
   function renderAnimeList(animes) {
     const container = document.getElementById('animeListContainer');
     
     // 扩展类型映射
     const typeMap = {
       'tvseries': 'TV剧', 'tv': 'TV动画', 'movie': '剧场版', 'ova': 'OVA', 
       'jpmovie': '电影', 'web': 'Web', 'music': 'MV', 'ona': 'ONA', 'special': '特别篇'
     };

     // 平台名称映射
     const sourceMap = {
       'dandan': '弹弹Play', '360': '360影视', 'vod': 'VOD',
       'bilibili': 'B站', 'iqiyi': '爱奇艺', 'youku': '优酷',
       'tencent': '腾讯', 'qq': '腾讯', 'mgtv': '芒果', 
       'bahamut': '巴哈', 'tmdb': 'TMDB', 'douban': '豆瓣',
       'hanjutv': '韩剧TV', 'renren': '人人影视'
     };

     const html = animes.map(anime => {
       // 1. 优化类型显示：优先使用 typeDescription，没有则查表，最后用 rawType
       const rawType = anime.type ? anime.type.toLowerCase() : '';
       let typeLabel = anime.typeDescription || typeMap[rawType] || rawType.toUpperCase();
       if (typeLabel === 'unknown') typeLabel = '动漫';
       
       // 2. 获取平台标签
       const sourceKey = (anime.source || 'dandan').toLowerCase();
       const platformLabel = sourceMap[sourceKey] || sourceKey.toUpperCase();

       // 3. 标题清洗逻辑 - 更加保守，防止误删标题
       let displayTitle = anime.animeTitle || '';
       // 仅移除末尾的 source 标记 (如 "from dandan")
       displayTitle = displayTitle.replace(/\s*from\s+.*$/i, '');
       // 移除纯文件后缀，保留括号内容
       displayTitle = displayTitle.trim();

       // 4. 年份处理
       let year = '';
       if (anime.year) {
         year = anime.year;
       } else if (anime.startDate && anime.startDate.length >= 4) {
         year = anime.startDate.substring(0, 4);
       }
       
       // 5. 集数处理
       let episodeText = '';
       if (anime.episodeCount && anime.episodeCount > 0) {
         episodeText = `${anime.episodeCount}集`;
       } else if (anime.episodes && anime.episodes.length > 0) {
         episodeText = `${anime.episodes.length}集`;
       }

       // 6. 评分处理
       const ratingHtml = anime.rating 
         ? `<span class="anime-tag highlight" style="background:rgba(245, 158, 11, 0.1);color:#f59e0b;border-color:rgba(245, 158, 11, 0.2);">★ ${anime.rating}</span>` 
         : '';

       return `
       <div class="anime-card" onclick="loadEpisodes('${anime.animeId}', '${escapeHtml(anime.animeTitle)}', this)">
         <div class="anime-cover-wrapper">
           <img src="${anime.imageUrl || ''}" class="anime-cover" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAiIGhlaWdodD0iMTUwIiB2aWV3Qm94PSIwIDAgMTAwIDE1MCI+PHJlY3Qgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxNTAiIGZpbGw9IiMzMzMiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzY2NiIgZm9udC1zaXplPSIxNCI+Tm8gSW1hZ2U8L3RleHQ+PC9zdmc+'">
           <div class="anime-badge">${platformLabel}</div>
           <div class="anime-overlay">
             <span class="anime-select-btn">选择此番</span>
           </div>
         </div>
         <div class="anime-info">
           <div class="anime-title" title="${escapeHtml(anime.animeTitle)}">${escapeHtml(displayTitle)}</div>
           <div class="anime-tags">
             ${year ? `<span class="anime-tag">${year}</span>` : ''}
             <span class="anime-tag" style="background:rgba(99, 102, 241, 0.1);color:#818cf8;border-color:rgba(99, 102, 241, 0.2);">${typeLabel}</span>
             ${episodeText ? `<span class="anime-tag">${episodeText}</span>` : ''}
             ${ratingHtml}
           </div>
         </div>
       </div>
     `}).join('');
     
     container.innerHTML = html;
   }



   // 加载剧集列表
   // ========== 剧集列表视图管理 ==========
   let currentEpisodesData = []; // 存储当前剧集数据
   let isEpisodeListMode = false; // 是否为列表详情模式
   let currentContext = 'test';   // 'test' | 'push'

   // 切换视图模式
   function toggleEpisodeViewMode() {
     isEpisodeListMode = !isEpisodeListMode;
     const btn = document.getElementById('viewToggleBtn');
     if(btn) {
        btn.innerHTML = isEpisodeListMode 
          ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>' 
          : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
        btn.title = isEpisodeListMode ? "切换为网格视图" : "切换为详情列表";
     }
     renderEpisodes();
   }

   // 渲染剧集列表 (通用)
   function renderEpisodes() {
     const containerId = currentContext === 'push' ? 'pushEpisodeGrid' : 'episodeListContainer';
     const container = document.getElementById(containerId);
     if (!container) return;

     if (!currentEpisodesData || currentEpisodesData.length === 0) {
       container.innerHTML = \`
         <div style="text-align: center; padding: 80px 0; color: var(--text-tertiary);">
           <div style="font-size: 48px; opacity: 0.5; margin-bottom: 16px;">📭</div>
           暂无剧集数据
         </div>\`;
       return;
     }

     // 更新容器样式
     if (isEpisodeListMode) {
       container.classList.add('list-mode');
     } else {
       container.classList.remove('list-mode');
     }

     const html = currentEpisodesData.map(ep => {
       const title = ep.episodeTitle || '';
       const num = ep.episodeNumber || (index + 1);
       const clickAction = currentContext === 'push' 
         ? \`executePushDanmu('\${ep.episodeId}', '\${escapeHtml(title || num)}', this)\`
         : \`loadEpisodeDanmu('\${ep.episodeId}', this)\`;
       
       const btnClass = isEpisodeListMode ? 'episode-btn list-mode' : 'episode-btn';
       
       return \`
         <div class="\${btnClass}" title="\${escapeHtml(title)}" onclick="\${clickAction}">
           <span class="ep-num">\${num}</span>
           \${isEpisodeListMode ? \`<span class="ep-title">\${escapeHtml(title)}</span>\` : ''}
         </div>
       \`;
     }).join('');

     container.innerHTML = html;
   }

   // 辅助：更新头部以包含切换按钮
   function updateEpisodeHeader(titleElId) {
     // 查找 header，插入切换按钮（如果不存在）
     const headerId = currentContext === 'push' ? 'pushEpisodeListView' : 'episodeListView';
     const headerContainer = document.querySelector(\`#\${headerId} .episode-view-header\`);
     
     if (headerContainer && !headerContainer.querySelector('.view-toggle-btn')) {
       const toggleBtn = document.createElement('button');
       toggleBtn.id = 'viewToggleBtn';
       toggleBtn.className = 'view-toggle-btn';
       toggleBtn.title = "切换视图模式";
       toggleBtn.onclick = toggleEpisodeViewMode;
       toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'; // 默认显示列表图标（点击切到列表）
       
       // 重置图标状态
       if(isEpisodeListMode) {
          toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
       }

       headerContainer.appendChild(toggleBtn);
     }
   }

   // 加载剧集列表 (弹幕测试页)
   async function loadEpisodes(animeId, animeTitle, cardElement) {
     currentContext = 'test';
     const listView = document.getElementById('animeListView');
     const episodeView = document.getElementById('episodeListView');
     const container = document.getElementById('episodeListContainer');
     const titleEl = document.getElementById('selectedAnimeTitle');
     
     // 1. 设置标题
     titleEl.textContent = animeTitle;
     titleEl.title = animeTitle;
     
     // 2. 切换视图动画
     listView.classList.remove('active');
     listView.classList.add('hidden-left');
     
     episodeView.classList.remove('hidden-right');
     episodeView.classList.add('active');
     
     // 3. 显示加载状态
     container.innerHTML = \`
       <div style="text-align: center; padding: 100px 0; color: var(--text-secondary);">
         <span class="loading-spinner" style="width: 40px; height: 40px; border-width: 3px;"></span>
         <div style="margin-top: 20px;">正在获取剧集列表...</div>
       </div>\`;
     
     // 4. 滚动到顶部
     const searchContainer = document.querySelector('.manual-search-container');
     if (searchContainer) searchContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
     
     try {
       const response = await fetch(\`/api/v2/bangumi/\${animeId}\`);
       const result = await response.json();
       
       if (!result.success || !result.bangumi || !result.bangumi.episodes) {
         throw new Error('无法获取剧集列表');
       }
       
       currentEpisodesData = result.bangumi.episodes;
       updateEpisodeHeader();
       renderEpisodes();
       
     } catch (error) {
       container.innerHTML = \`
         <div style="text-align: center; padding: 60px 20px; color: var(--error);">
           <div style="font-size: 40px; margin-bottom: 16px;">❌</div>
           <div>加载失败: \${error.message}</div>
           <button onclick="loadEpisodes('\${animeId}', '\${escapeHtml(animeTitle)}')" class="btn btn-secondary" style="margin-top: 16px;">重试</button>
         </div>\`;
     }
   }

   // 返回番剧列表视图
   function backToAnimeList() {
     const listView = document.getElementById('animeListView');
     const episodeView = document.getElementById('episodeListView');
     
     if (listView && episodeView) {
       episodeView.classList.remove('active');
       episodeView.classList.add('hidden-right');
       
       listView.classList.remove('hidden-left');
       listView.classList.add('active');
     }
   }

   // 加载特定剧集的弹幕
   async function loadEpisodeDanmu(episodeId, btnElement) {
     // 高亮选中剧集
     document.querySelectorAll('.episode-btn').forEach(b => b.classList.remove('active'));
     if (btnElement) btnElement.classList.add('active');
     
     clearDanmuPreview();
     showLoading('正在获取弹幕...', \`Episode ID: \${episodeId}\`);
     
     try {
       await fetchAndDisplayDanmu(\`/api/v2/comment/\${episodeId}?format=json\`);
     } catch (error) {
       showError('获取弹幕失败', error.message);
     }
   }

   // 🔥 获取并显示弹幕（记录基础URL）
   async function fetchAndDisplayDanmu(url) {
     // 保存当前的基础 API 地址（去除 ?format=... 部分以便重新构造）
     const urlObj = new URL(url, window.location.origin);
     urlObj.searchParams.delete('format');
     currentApiUrl = urlObj.pathname + urlObj.search;
     
     const response = await fetch(url);
     const result = await response.json();
     
     if (result.success === false) {
       throw new Error(result.errorMessage || '接口返回错误');
     }

     // 兼容不同的返回格式
     let comments = [];
     if (Array.isArray(result)) comments = result;
     else if (result.comments) comments = result.comments;
     else if (result.danmus) comments = result.danmus;

     currentDanmuData = comments;
     filteredDanmuData = [...currentDanmuData];
     
     if (currentDanmuData.length === 0) {
       showEmptyState();
     } else {
       displayDanmuList(filteredDanmuData);
       updateDanmuStats();
       showToast(\`🎉 成功获取 \${currentDanmuData.length} 条弹幕\`, 'success');
       
       // 显示导出按钮组
       const exportGroup = document.getElementById('danmuExportGroup');
       if (exportGroup) exportGroup.style.display = 'flex';
     }
   }
   
   // 🔥 查看原始数据 (Webpage)
   function viewRawData(format) {
     if (!currentApiUrl) {
       showToast('暂无数据链接', 'warning');
       return;
     }
     
     // 构造带 format 参数的完整链接
     const sep = currentApiUrl.includes('?') ? '&' : '?';
     const targetUrl = window.location.origin + currentApiUrl + sep + 'format=' + format;
     
     window.open(targetUrl, '_blank');
     showToast(\`已打开 \${format.toUpperCase()} 弹幕页面\`, 'success');
   }

   // UI 辅助函数：清空预览时隐藏导出按钮
   function clearDanmuPreview() {
     const container = document.getElementById('danmuPreviewContainer');
     container.innerHTML = '';
     document.getElementById('danmuTestCount').textContent = '0 条';
     
     // 隐藏导出按钮组
     const exportGroup = document.getElementById('danmuExportGroup');
     if (exportGroup) exportGroup.style.display = 'none';
     
     currentApiUrl = ''; 
   }

   // ========== 弹幕导出功能 ==========
   function exportDanmu(format) {
     if (!filteredDanmuData || filteredDanmuData.length === 0) {
       showToast('暂无弹幕数据可导出', 'warning');
       return;
     }

     try {
       let content = '';
       let filename = '';
       let mimeType = '';

       if (format === 'json') {
         // JSON 格式导出
         const exportData = {
           count: filteredDanmuData.length,
           comments: filteredDanmuData.map(danmu => ({
             p: danmu.p || (danmu.time || 0) + ',' + (danmu.mode || 1) + ',' + (danmu.color || 16777215) + ',' + Date.now() + ',0,0,0,0',
             m: danmu.m || danmu.text || ''
           })),
           source: 'Danmu API',
           exportTime: new Date().toISOString()
         };
         content = JSON.stringify(exportData, null, 2);
         filename = 'danmu-export-' + Date.now() + '.json';
         mimeType = 'application/json';

       } else if (format === 'xml') {
         // XML 格式导出（Bilibili 兼容格式）
         const xmlLines = ['<?xml version="1.0" encoding="UTF-8"?>'];
         xmlLines.push('<i>');
         xmlLines.push('  <chatserver>chat.bilibili.com</chatserver>');
         xmlLines.push('  <chatid>0</chatid>');
         xmlLines.push('  <mission>0</mission>');
         xmlLines.push('  <maxlimit>' + filteredDanmuData.length + '</maxlimit>');
         xmlLines.push('  <state>0</state>');
         xmlLines.push('  <real_name>0</real_name>');
         xmlLines.push('  <source>Danmu API Export</source>');

         filteredDanmuData.forEach(danmu => {
           // 尝试解析 p 属性，如果不存在则构造默认值
           let p = danmu.p;
           if (!p) {
             const time = danmu.time || 0;
             const mode = danmu.mode || 1;
             const color = danmu.color || 16777215;
             p = \`\${time},\${mode},25,\${color},\${Date.now()},0,0,0\`;
           }
           
           // XML 特殊字符转义
           const text = (danmu.m || danmu.text || '')
             .replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&apos;');
             
           xmlLines.push(\`  <d p="\${p}">\${text}</d>\`);
         });

         xmlLines.push('</i>');
         content = xmlLines.join('\\n');
         filename = 'danmu-export-' + Date.now() + '.xml';
         mimeType = 'application/xml';
       }

       // 创建下载链接并触发下载
       const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
       const url = URL.createObjectURL(blob);
       const a = document.createElement('a');
       a.href = url;
       a.download = filename;
       document.body.appendChild(a); // 兼容性修复
       a.click();
       document.body.removeChild(a); // 清理
       URL.revokeObjectURL(url);

       showToast(\`弹幕已导出为 \${format.toUpperCase()} 格式\`, 'success');

     } catch (error) {
       console.error('导出失败:', error);
       showToast('导出失败: ' + error.message, 'error');
     }
   }

   function showLoading(title, subtitle) {
     const container = document.getElementById('danmuPreviewContainer');
     container.innerHTML = \`
       <div style="text-align: center; padding: 80px 20px;">
         <span class="loading-spinner" style="width: 48px; height: 48px; border-width: 4px;"></span>
         <div style="margin-top: 24px; color: var(--text-primary); font-size: 16px; font-weight: 600;">\${title}</div>
         <div style="margin-top: 8px; color: var(--text-tertiary); font-size: 13px;">\${subtitle}</div>
       </div>\`;
   }

   function showEmptyState() {
     const container = document.getElementById('danmuPreviewContainer');
     container.innerHTML = \`
       <div style="text-align: center; padding: 80px 20px; color: var(--text-tertiary);">
         <div style="font-size: 56px; margin-bottom: 20px; opacity: 0.5;">😢</div>
         <div style="font-size: 17px; font-weight: 600; margin-bottom: 10px; color: var(--text-secondary);">未获取到弹幕</div>
         <div style="font-size: 14px; opacity: 0.8;">该视频可能没有弹幕数据</div>
       </div>\`;
   }

   function showError(title, message) {
     const container = document.getElementById('danmuPreviewContainer');
     container.innerHTML = \`
       <div style="text-align: center; padding: 80px 20px; color: var(--error);">
         <div style="font-size: 56px; margin-bottom: 20px; opacity: 0.7;">❌</div>
         <div style="font-size: 17px; font-weight: 600; margin-bottom: 10px;">\${title}</div>
         <div style="font-size: 14px; color: var(--text-secondary); max-width: 400px; margin: 0 auto; line-height: 1.5;">\${message}</div>
       </div>\`;
     showToast(\`❌ \${title}: \${message}\`, 'error');
   }

   // ✅ 显示匹配结果信息
   function displayMatchResult(matchInfo) {
     const matchResultCard = document.getElementById('matchResultCard');
     
     const platformNames = {
       'qiyi': '爱奇艺', 'bilibili1': '哔哩哔哩', 'imgo': 'IMGO', 
       'youku': '优酷', 'qq': '腾讯视频', 'renren': '人人影视', 
       'hanjutv': '韩剧TV', 'bahamut': '巴哈姆特'
     };
     
     document.getElementById('matchedAnimeTitle').textContent = matchInfo.animeTitle || '未知';
     document.getElementById('matchedEpisodeTitle').textContent = matchInfo.episodeTitle || '未知集数';
     document.getElementById('matchedPlatform').textContent = platformNames[matchInfo.type] || matchInfo.type || '未知';
     document.getElementById('matchedSeason').textContent = 'S' + (matchInfo.season || '?').toString().padStart(2, '0');
     document.getElementById('matchedEpisode').textContent = 'E' + (matchInfo.episode || '?').toString().padStart(2, '0');
     document.getElementById('matchedEpisodeId').textContent = matchInfo.episodeId || '-';
     
     matchResultCard.style.display = 'block';
   }

   function displayDanmuList(danmuList) {
     const container = document.getElementById('danmuPreviewContainer');
     if (!danmuList || danmuList.length === 0) {
       showEmptyState();
       return;
     }

     const html = danmuList.slice(0, 500).map((danmu, index) => {
       const time = formatTime(danmu.p?.split(',')[0] || danmu.time || 0);
       const text = danmu.m || danmu.text || '';
       const mode = danmu.p?.split(',')[1] || danmu.mode || '1';
       const color = danmu.p?.split(',')[2] || danmu.color || '16777215';
       
       const modeText = mode === '1' ? '滚动' : mode === '4' ? '底部' : mode === '5' ? '顶部' : '滚动';
       const hexColor = '#' + parseInt(color).toString(16).padStart(6, '0');

       return \`
         <div style="padding: 12px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 12px; transition: background 0.2s;" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='transparent'">
           <div style="min-width: 60px; font-size: 12px; color: var(--text-tertiary); font-family: monospace;">\${time}</div>
           <div style="min-width: 50px;">
             <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; background: var(--bg-tertiary); color: var(--text-secondary);">\${modeText}</span>
           </div>
           <div style="width: 30px; height: 20px; border-radius: 4px; border: 1px solid var(--border-color); background: \${hexColor};" title="\${hexColor}"></div>
           <div style="flex: 1; color: var(--text-primary); font-size: 14px; word-break: break-all;">\${escapeHtml(text)}</div>
         </div>
       \`;
     }).join('');

     container.innerHTML = html;
     
     if (danmuList.length > 500) {
       container.innerHTML += \`<div style="text-align: center; padding: 20px; color: var(--text-tertiary); font-size: 13px;">仅显示前 500 条弹幕，共 \${danmuList.length} 条</div>\`;
     }

     document.getElementById('danmuTestCount').textContent = \`\${danmuList.length} 条\`;
   }

   function formatTime(seconds) {
     const sec = Math.floor(parseFloat(seconds));
     const m = Math.floor(sec / 60);
     const s = sec % 60;
     return \`\${m.toString().padStart(2, '0')}:\${s.toString().padStart(2, '0')}\`;
   }

   function escapeHtml(text) {
     const div = document.createElement('div');
     div.textContent = text;
     return div.innerHTML;
   }

   function applyDanmuFilter() {
     if (!currentDanmuData || currentDanmuData.length === 0) {
       showToast('请先获取弹幕数据', 'warning');
       return;
     }

     const blockedWords = document.getElementById('testBlockedWords').value
       .split(',')
       .map(w => w.trim())
       .filter(w => w.length > 0);
     
     const enableSimplified = document.getElementById('testSimplified').checked;
     const enableConvert = document.getElementById('testTopBottomConvert').checked;

     let filtered = [...currentDanmuData];
     let blockedCount = 0;
     let convertedCount = 0;

     // 屏蔽词过滤
     if (blockedWords.length > 0) {
       const beforeCount = filtered.length;
       filtered = filtered.filter(danmu => {
         const text = danmu.m || danmu.text || '';
         return !blockedWords.some(word => text.includes(word));
       });
       blockedCount = beforeCount - filtered.length;
     }

     // 繁简转换
     if (enableSimplified) {
       filtered = filtered.map(danmu => ({
         ...danmu,
         m: (danmu.m || danmu.text || '').replace(/[繁體]/g, match => {
           const map = { '繁': '繁', '體': '体' };
           return map[match] || match;
         })
       }));
     }

     // 顶底转滚动
     if (enableConvert) {
       filtered = filtered.map(danmu => {
         const p = danmu.p ? danmu.p.split(',') : [];
         if (p[1] === '4' || p[1] === '5') {
           p[1] = '1';
           convertedCount++;
           return { ...danmu, p: p.join(',') };
         }
         return danmu;
       });
     }

     filteredDanmuData = filtered;
     displayDanmuList(filteredDanmuData);

     const statsEl = document.getElementById('filterStats');
     const statsText = document.getElementById('filterStatsText');
     if (statsEl && statsText) {
       const parts = [];
       if (blockedCount > 0) parts.push(\`屏蔽 \${blockedCount} 条\`);
       if (convertedCount > 0) parts.push(\`转换 \${convertedCount} 条\`);
       
       if (parts.length > 0) {
         statsText.textContent = \`✅ 过滤完成: \${parts.join('，')}，剩余 \${filtered.length} 条弹幕\`;
         statsEl.style.display = 'flex';
       } else {
         statsEl.style.display = 'none';
       }
     }

     updateDanmuStats();
   }

   function updateDanmuStats() {
     if (!filteredDanmuData || filteredDanmuData.length === 0) {
       return;
     }

     // 更新时间分布图
     updateDanmuTimeChart();
     
     // 更新词云（简化版）
     updateDanmuWordCloud();
   }

   function updateDanmuTimeChart() {
     const ctxCanvas = document.getElementById('danmuTimeChart');
     const wrapper = document.getElementById('danmuChartWrapper');
     
     if (!ctxCanvas || !wrapper) return;
     
     // 显示容器
     wrapper.style.display = 'block';
     const ctx = ctxCanvas.getContext('2d');

     // 按分钟统计弹幕数量
     const timeSlots = {};
     let maxMinute = 0;
     filteredDanmuData.forEach(danmu => {
       const time = parseFloat(danmu.p?.split(',')[0] || danmu.time || 0);
       const minute = Math.floor(time / 60);
       timeSlots[minute] = (timeSlots[minute] || 0) + 1;
       if (minute > maxMinute) maxMinute = minute;
     });

     const labels = [];
     const data = [];
     const displayMax = Math.min(maxMinute, 180); 
     
     for (let i = 0; i <= displayMax; i++) {
       labels.push(\`\${i}分\`);
       data.push(timeSlots[i] || 0);
     }

     if (danmuTimeChart) {
       danmuTimeChart.destroy();
     }

     const gradient = ctx.createLinearGradient(0, 0, 0, 200);
     gradient.addColorStop(0, 'rgba(99, 102, 241, 0.7)'); // 顶部紫色
     gradient.addColorStop(1, 'rgba(99, 102, 241, 0.0)'); // 底部透明

     danmuTimeChart = new Chart(ctx, {
       type: 'line',
       data: {
         labels: labels,
         datasets: [{
           label: '热度',
           data: data,
           borderColor: '#6366f1',
           borderWidth: 2,
           backgroundColor: gradient,
           tension: 0.4, 
           fill: true,   
           pointRadius: 0, 
           pointHoverRadius: 6,
           pointHitRadius: 20
         }]
       },
       options: {
         responsive: true,
         maintainAspectRatio: false,
         interaction: {
           mode: 'index',
           intersect: false,
         },
         plugins: {
           legend: { display: false },
           tooltip: {
             backgroundColor: 'rgba(15, 23, 42, 0.9)',
             titleColor: '#e2e8f0',
             bodyColor: '#e2e8f0',
             borderColor: 'rgba(255,255,255,0.1)',
             borderWidth: 1,
             padding: 8,
             displayColors: false,
             callbacks: {
               label: function(context) {
                 return \`🔥 弹幕量: \${context.parsed.y}\`;
               }
             }
           }
         },
         scales: {
           y: {
             beginAtZero: true,
             display: false,
           },
           x: {
             grid: { 
               color: 'rgba(255, 255, 255, 0.03)',
               drawBorder: false
             },
             ticks: { 
               color: '#64748b',
               font: { size: 10 },
               maxTicksLimit: 10
             }
           }
         }
       }
     });
   }

   function updateDanmuWordCloud() {
     const container = document.getElementById('danmuWordCloud');
     if (!container) return;

     const words = {};
     filteredDanmuData.forEach(danmu => {
       const text = danmu.m || danmu.text || '';
       const chars = text.split('');
       chars.forEach(char => {
         if (char.match(/[\\u4e00-\\u9fa5a-zA-Z]/)) {
           words[char] = (words[char] || 0) + 1;
         }
       });
     });

     const sorted = Object.entries(words)
       .sort((a, b) => b[1] - a[1])
       .slice(0, 30);

     if (sorted.length === 0) {
       container.innerHTML = '<div style="color: var(--text-tertiary); font-size: 14px;">暂无数据</div>';
       return;
     }

     const maxCount = sorted[0][1];
     const html = sorted.map(([word, count]) => {
       const size = 12 + (count / maxCount) * 24;
       const opacity = 0.5 + (count / maxCount) * 0.5;
       return \`<span style="font-size: \${size}px; opacity: \${opacity}; margin: 4px 8px; display: inline-block; color: var(--primary-400);">\${word}</span>\`;
     }).join('');

     container.innerHTML = \`<div style="padding: 20px; line-height: 2;">\${html}</div>\`;
   }

   function clearDanmuTest() {
     currentDanmuData = [];
     filteredDanmuData = [];
     document.getElementById('danmuTestInput').value = '';
     
     // 重置高级选项
     document.getElementById('danmuTestYear').value = '';
     document.getElementById('danmuTestSeason').value = '';
     document.getElementById('danmuTestEpisode').value = '';
     document.getElementById('danmuTestPlatform').value = '';
     
     // 清空列表
     const animeContainer = document.getElementById('animeListContainer');
     if (animeContainer) {
       animeContainer.innerHTML = '<div style="text-align: center; padding: 40px 0; color: var(--text-tertiary);">请先搜索关键词</div>';
     }
     
     const epContainer = document.getElementById('episodeListContainer');
     if (epContainer) {
       epContainer.innerHTML = '<div style="text-align: center; padding: 60px 0; color: var(--text-tertiary);">请在左侧选择一部动漫/电影</div>';
     }
     
     const animeTitle = document.getElementById('selectedAnimeTitle');
     if (animeTitle) animeTitle.textContent = '未选择动漫';
     
     // 清空结果区域
     const matchResultCard = document.getElementById('matchResultCard');
     if (matchResultCard) matchResultCard.style.display = 'none';
     clearDanmuPreview();
     
     // 隐藏并销毁波纹图
     const chartWrapper = document.getElementById('danmuChartWrapper');
     if (chartWrapper) chartWrapper.style.display = 'none';
     
     if (danmuTimeChart) {
       danmuTimeChart.destroy();
       danmuTimeChart = null;
     }
     
     const filterStats = document.getElementById('filterStats');
     if (filterStats) filterStats.style.display = 'none';
     
     showToast('✨ 已重置测试状态', 'info');
   }

   // ========== 弹幕推送功能 ==========
   
// 页面加载时恢复保存的 URL
function initPushPage() {
  const savedUrl = localStorage.getItem('danmu_push_url');
  if (savedUrl) {
    document.getElementById('pushTargetUrl').value = savedUrl;
  }
}

// 应用推送预设
function applyPushPreset(type) {
  const input = document.getElementById('pushTargetUrl');
  let url = '';
  let name = '';

  switch (type) {
    case 'okvideo':
      url = 'http://127.0.0.1:9978/action?do=refresh&type=danmaku&path=';
      name = 'OK影视';
      break;
    case 'kodi':
      // 这是一个示例地址，用户通常需要修改IP
      url = 'http://192.168.1.5:8080/jsonrpc?Player.Open='; 
      name = 'Kodi';
      break;
    case 'potplayer':
      // 这是一个示例 Web API 插件地址
      url = 'http://127.0.0.1:8080/input?url=';
      name = 'PotPlayer';
      break;
  }

  if (url) {
    input.value = url;
    // 自动保存
    localStorage.setItem('danmu_push_url', url);
    
    // 视觉反馈
    input.style.borderColor = 'var(--primary-500)';
    input.style.backgroundColor = 'var(--bg-hover)';
    setTimeout(() => {
      input.style.borderColor = '';
      input.style.backgroundColor = '';
    }, 300);

    showToast('已应用 ' + name + ' 预设地址', 'success');
  }
}
   const originalSwitchPage = switchPage;
   switchPage = function(pageName) {
     originalSwitchPage(pageName);
     if (pageName === 'push') {
       initPushPage();
     }
   };

   async function searchAnimeForPush() {
     const keyword = document.getElementById('pushSearchInput').value.trim();
     if (!keyword) {
       showToast('请输入搜索关键词', 'warning');
       return;
     }

     const btn = document.getElementById('pushSearchBtn');
     const originalText = btn.innerHTML;
     btn.innerHTML = '<span class="loading-spinner" style="width:14px;height:14px;border-width:2px;"></span>';
     btn.disabled = true;

     const container = document.getElementById('pushResultsContainer');
     const grid = document.getElementById('pushAnimeGrid');
     
     container.style.display = 'block';
     backToPushAnimeList(); // 确保在列表视图
     
     grid.innerHTML = \`
       <div style="grid-column: 1/-1; text-align: center; padding: 60px 0; color: var(--text-secondary);">
         <span class="loading-spinner" style="width: 32px; height: 32px; border-width: 3px;"></span> 
         <div style="margin-top: 16px;">正在搜索...</div>
       </div>\`;

     try {
       const response = await fetch(\`/api/v2/search/anime?keyword=\${encodeURIComponent(keyword)}\`);
       const result = await response.json();

       if (!result.success || !result.animes || result.animes.length === 0) {
         grid.innerHTML = \`
           <div style="grid-column: 1/-1; text-align: center; padding: 60px 0; color: var(--text-tertiary);">
             <div style="font-size: 48px; margin-bottom: 12px; opacity: 0.5;">🤔</div>
             未找到相关动漫
           </div>\`;
       } else {
         renderPushAnimeList(result.animes);
       }
     } catch (error) {
       grid.innerHTML = \`<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--error);">搜索出错: \${error.message}</div>\`;
     } finally {
       btn.innerHTML = originalText;
       btn.disabled = false;
     }
   }

   function renderPushAnimeList(animes) {
     const container = document.getElementById('pushAnimeGrid');
     
     // 简单的类型映射
     const typeMap = { 'tvseries': 'TV剧', 'tv': 'TV动画', 'movie': '剧场版', 'ova': 'OVA' };
     const sourceMap = { 'dandan': '弹弹', 'bilibili': 'B站', 'iqiyi': '爱奇艺', 'qq': '腾讯' };

     const html = animes.map(anime => {
       const typeLabel = typeMap[anime.type?.toLowerCase()] || '动漫';
       const sourceLabel = sourceMap[anime.source?.toLowerCase()] || '其他';
       
       return \`
       <div class="anime-card" onclick="loadPushEpisodes('\${anime.animeId}', '\${escapeHtml(anime.animeTitle)}')">
         <div class="anime-cover-wrapper">
           <img src="\${anime.imageUrl || ''}" class="anime-cover" loading="lazy" onerror="this.src='https://placehold.co/150x225/1c1c27/FFF?text=No+Img'">
           <div class="anime-badge">\${sourceLabel}</div>
         </div>
         <div class="anime-info">
           <div class="anime-title" title="\${anime.animeTitle}">\${anime.animeTitle}</div>
           <div class="anime-tags">
             <span class="anime-tag">\${typeLabel}</span>
             <span class="anime-tag">\${anime.episodeCount || '?'}集</span>
           </div>
         </div>
       </div>
     \`}).join('');
     
     container.innerHTML = html;
   }

   async function loadPushEpisodes(animeId, animeTitle) {
     currentContext = 'push';
     const listView = document.getElementById('pushAnimeListView');
     const episodeView = document.getElementById('pushEpisodeListView');
     const container = document.getElementById('pushEpisodeGrid');
     const titleEl = document.getElementById('pushSelectedAnimeTitle');
     
     titleEl.textContent = animeTitle;
     
     // 切换视图
     listView.classList.remove('active');
     listView.classList.add('hidden-left');
     episodeView.classList.remove('hidden-right');
     episodeView.classList.add('active');
     
     container.innerHTML = '<div style="text-align: center; padding: 40px;"><span class="loading-spinner"></span> 加载中...</div>';

     try {
       const response = await fetch(\`/api/v2/bangumi/\${animeId}\`);
       const result = await response.json();
       
       if (result.success && result.bangumi && result.bangumi.episodes) {
         currentEpisodesData = result.bangumi.episodes;
         updateEpisodeHeader();
         renderEpisodes();
       } else {
         throw new Error('无法获取剧集');
       }
     } catch (error) {
       container.innerHTML = \`<div style="color: var(--error); text-align: center;">加载失败: \${error.message}</div>\`;
     }
   }


   function backToPushAnimeList() {
     const listView = document.getElementById('pushAnimeListView');
     const episodeView = document.getElementById('pushEpisodeListView');
     
     episodeView.classList.remove('active');
     episodeView.classList.add('hidden-right');
     listView.classList.remove('hidden-left');
     listView.classList.add('active');
   }

   async function executePushDanmu(episodeId, episodeTitle, btnElement) {
     const pushUrl = document.getElementById('pushTargetUrl').value.trim();
     
     if (!pushUrl) {
       showToast('请先设置推送目标 URL', 'error');
       document.getElementById('pushTargetUrl').focus();
       // 闪烁提示
       document.getElementById('pushTargetUrl').parentElement.style.animation = 'shake 0.5s';
       setTimeout(() => document.getElementById('pushTargetUrl').parentElement.style.animation = '', 500);
       return;
     }

     // 保存 URL
     localStorage.setItem('danmu_push_url', pushUrl);

     // UI 状态
     const originalText = btnElement.innerText;
     btnElement.innerHTML = '<span class="loading-spinner" style="width:12px;height:12px;border-width:2px;"></span>';
     btnElement.style.pointerEvents = 'none';

     try {
       // 构造 XML 获取地址
       const xmlUrl = window.location.origin + \`/api/v2/comment/\${episodeId}?format=xml\`;
       // 构造推送地址
       const target = pushUrl + encodeURIComponent(xmlUrl);
       
       console.log('Pushing to:', target);

       // 发起请求 (no-cors 模式，因为通常推送到本地播放器会有跨域限制)
       await fetch(target, {
         method: 'GET',
         mode: 'no-cors'
       });

       showToast(\`已推送: \${episodeTitle}\`, 'success');
       btnElement.classList.add('active'); // 标记为已推送
     } catch (error) {
       console.error('推送失败:', error);
       showToast('推送请求发送失败: ' + error.message, 'error');
     } finally {
       btnElement.innerText = originalText;
       btnElement.style.pointerEvents = 'auto';
     }
   }


// ========== 弹幕导出功能 ==========
   // ========== 弹幕导出功能 ==========
   function exportDanmu(format) {
     if (!filteredDanmuData || filteredDanmuData.length === 0) {
       showToast('暂无弹幕数据可导出', 'warning');
       return;
     }

     try {
       let content = '';
       let filename = '';
       let mimeType = '';

       if (format === 'json') {
         // JSON 格式导出
         const exportData = {
           count: filteredDanmuData.length,
           comments: filteredDanmuData.map(danmu => ({
             p: danmu.p || (danmu.time || 0) + ',' + (danmu.mode || 1) + ',' + (danmu.color || 16777215) + ',' + Date.now() + ',0,0,0,0',
             m: danmu.m || danmu.text || ''
           })),
           exportTime: new Date().toISOString()
         };
         content = JSON.stringify(exportData, null, 2);
         filename = 'danmu-' + Date.now() + '.json';
         mimeType = 'application/json';

       } else if (format === 'xml') {
         // XML 格式导出（Bilibili 格式）
         const xmlLines = ['<?xml version="1.0" encoding="UTF-8"?>'];
         xmlLines.push('<i>');
         xmlLines.push('  <chatserver>chat.bilibili.com</chatserver>');
         xmlLines.push('  <chatid>0</chatid>');
         xmlLines.push('  <mission>0</mission>');
         xmlLines.push('  <maxlimit>' + filteredDanmuData.length + '</maxlimit>');
         xmlLines.push('  <state>0</state>');
         xmlLines.push('  <real_name>0</real_name>');
         xmlLines.push('  <source>test</source>');

         filteredDanmuData.forEach(danmu => {
           // 解析原有 p 或使用属性，强制设置字体为 25
           const parts = danmu.p ? danmu.p.split(',') : [];
           const time = parts[0] || danmu.time || 0;
           const mode = parts[1] || danmu.mode || 1;
           // 智能判断颜色位置：如果第3位是大整数(>100)说明是颜色(缺字号)，否则取第4位
           const color = (parts.length > 2 && parseInt(parts[2]) > 100 ? parts[2] : parts[3]) || danmu.color || 16777215;
           const p = time + ',' + mode + ',25,' + color + ',' + Date.now() + ',0,0,0,0';

           const text = (danmu.m || danmu.text || '')
             .replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&apos;');
           xmlLines.push('  <d p="' + p + '">' + text + '</d>');
         });

         xmlLines.push('</i>');
         content = xmlLines.join('\\n');
         filename = 'danmu-' + Date.now() + '.xml';
         mimeType = 'application/xml';
       }

       // 下载文件
       const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
       const url = URL.createObjectURL(blob);
       const a = document.createElement('a');
       a.href = url;
       a.download = filename;
       a.click();
       URL.revokeObjectURL(url);

       showToast('弹幕已导出为 ' + format.toUpperCase() + ' 格式', 'success');

     } catch (error) {
       console.error('导出失败:', error);
       showToast('导出失败: ' + error.message, 'error');
     }
   }
   // ========== 缓存管理功能 ==========
   let cacheData = {
     searchCache: {},
     commentCache: {},
     lastSelect: {},
     redis: { connected: false, url: '', token: '' },
     database: { connected: false, url: '' }
   };

   async function initCachePage() {
     console.log('初始化缓存管理页面');
     await loadCacheStatus();
     await loadCacheData();
   }

   async function loadCacheStatus() {
     try {
       // 检查 Redis 状态
       const redisStatusBadge = document.getElementById('redisStatusBadge');
       const redisStatusText = document.getElementById('redisStatusText');
       const redisConfigured = AppState.config.UPSTASH_REDIS_REST_URL && AppState.config.UPSTASH_REDIS_REST_TOKEN;
       
       if (redisConfigured) {
         redisStatusBadge.className = 'badge badge-success';
         redisStatusBadge.innerHTML = '<span class="status-dot"></span>已连接';
         redisStatusText.textContent = '✅ Redis 已配置并连接';
         cacheData.redis.connected = true;
       } else {
         redisStatusBadge.className = 'badge badge-secondary';
         redisStatusBadge.textContent = '未配置';
         redisStatusText.textContent = '📝 Redis 未配置';
         cacheData.redis.connected = false;
       }

       // 检查数据库状态
       const dbStatusBadge = document.getElementById('dbStatusBadge');
       const dbStatusText = document.getElementById('dbStatusText');
       const dbConfigured = AppState.config.DATABASE_URL;
       
       if (dbConfigured) {
         dbStatusBadge.className = 'badge badge-success';
         dbStatusBadge.innerHTML = '<span class="status-dot"></span>已连接';
         dbStatusText.textContent = '✅ 数据库已配置并连接';
         cacheData.database.connected = true;
       } else {
         dbStatusBadge.className = 'badge badge-secondary';
         dbStatusBadge.textContent = '未配置';
         dbStatusText.textContent = '📝 数据库未配置';
         cacheData.database.connected = false;
       }

       // 更新存储状态
       const storageStatus = document.getElementById('storageStatus');
       const storageType = document.getElementById('storageType');
       
       if (cacheData.database.connected) {
         storageStatus.textContent = '在线';
         storageType.textContent = '数据库（主存储）';
       } else if (cacheData.redis.connected) {
         storageStatus.textContent = '在线';
         storageType.textContent = 'Redis';
       } else {
         storageStatus.textContent = '未启用';
         storageType.textContent = '仅内存';
       }

     } catch (error) {
       console.error('加载缓存状态失败:', error);
       showToast('加载缓存状态失败: ' + error.message, 'error');
     }
   }

   async function loadCacheData() {
     try {
       const response = await fetch('/api/cache/stats');
       const result = await response.json();

       if (result.success) {
         // 更新统计卡片
         document.getElementById('searchCacheCount').textContent = result.searchCacheCount || 0;
         document.getElementById('searchCacheSize').textContent = formatBytes(result.searchCacheSize || 0);
         
         document.getElementById('commentCacheCount').textContent = result.commentCacheCount || 0;
         document.getElementById('commentCacheSize').textContent = formatBytes(result.commentCacheSize || 0);

         // 更新最后选择记录
         const lastSelectCount = result.lastSelectCount || 0;
         document.getElementById('lastSelectCountBadge').textContent = \`\${lastSelectCount} 条\`;
         document.getElementById('lastSelectStatus').textContent = lastSelectCount > 0 
           ? \`已记录 \${lastSelectCount} 个用户选择\` 
           : '未启用或无数据';

         // 更新缓存详情列表
         displayCacheDetails(result.cacheDetails || []);

       } else {
         throw new Error(result.error || '加载失败');
       }
     } catch (error) {
       console.error('加载缓存数据失败:', error);
       showToast('加载缓存数据失败: ' + error.message, 'error');
     }
   }

   function formatBytes(bytes) {
     if (bytes === 0) return '0 B';
     const k = 1024;
     const sizes = ['B', 'KB', 'MB', 'GB'];
     const i = Math.floor(Math.log(bytes) / Math.log(k));
     return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
   }

   function displayCacheDetails(details) {
     const container = document.getElementById('cacheDetailList');
     if (!container) return;

     if (!details || details.length === 0) {
       container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-title">暂无缓存数据</div></div>';
       return;
     }

     const html = details.map(item => \`
       <div class="config-item" style="margin-bottom: 12px;">
         <div class="config-header">
           <span class="config-label">\${item.key}</span>
           <span class="badge badge-info">\${item.type || '未知'}</span>
         </div>
         <div class="config-value" style="background: none; border: none; padding: 0;">
           <code style="color: var(--text-secondary); font-size: 12px;">
             大小: \${formatBytes(item.size || 0)} | 
             创建: \${item.createdAt ? new Date(item.createdAt).toLocaleString() : '未知'}
             \${item.expiresAt ? \` | 过期: \${new Date(item.expiresAt).toLocaleString()}\` : ''}
           </code>
         </div>
       </div>
     \`).join('');

     container.innerHTML = html;
   }

   async function refreshCacheData() {
     showToast('正在刷新缓存数据...', 'info', 1000);
     await loadCacheStatus();
     await loadCacheData();
     showToast('缓存数据已刷新', 'success');
   }

   function showClearCacheModal() {
     // 重置选项
     document.getElementById('clearSearchCache').checked = true;
     document.getElementById('clearCommentCache').checked = true;
     document.getElementById('clearLastSelect').checked = false;
     document.getElementById('clearAllCache').checked = false;
     
     showModal('clearCacheModal');
   }

   function toggleClearAll(checkbox) {
     const allCheckboxes = [
       'clearSearchCache',
       'clearCommentCache',
       'clearLastSelect'
     ];
     
     allCheckboxes.forEach(id => {
       const el = document.getElementById(id);
       if (el) {
         el.checked = checkbox.checked;
         el.disabled = checkbox.checked;
       }
     });
   }

   async function executeClearCache() {
     const clearSearch = document.getElementById('clearSearchCache').checked;
     const clearComment = document.getElementById('clearCommentCache').checked;
     const clearLastSelect = document.getElementById('clearLastSelect').checked;
     const clearAll = document.getElementById('clearAllCache').checked;

     if (!clearSearch && !clearComment && !clearLastSelect && !clearAll) {
       showToast('请至少选择一项要清理的缓存', 'warning');
       return;
     }

     try {
       showToast('正在清理缓存...', 'info', 2000);

       const response = await fetch('/api/cache/clear', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           clearSearch,
           clearComment,
           clearLastSelect,
           clearAll
         })
       });

       const result = await response.json();

       if (result.success) {
         closeModal('clearCacheModal');
         showToast(\`缓存清理成功: \${result.message}\`, 'success');
         await refreshCacheData();
       } else {
         throw new Error(result.error || '清理失败');
       }
     } catch (error) {
       console.error('清理缓存失败:', error);
       showToast('清理缓存失败: ' + error.message, 'error');
     }
   }

   function toggleSensitive(element) {
     const real = element.dataset.real;
     const masked = element.dataset.masked;
     const isRevealed = element.classList.contains('revealed');
     
     if (isRevealed) {
       element.querySelector('code').textContent = masked;
       element.classList.remove('revealed');
       if (element.hideTimer) {
         clearTimeout(element.hideTimer);
       }
     } else {
       const textarea = document.createElement('textarea');
       textarea.innerHTML = real;
       element.querySelector('code').textContent = textarea.value;
       element.classList.add('revealed');
       
       element.hideTimer = setTimeout(() => {
         element.querySelector('code').textContent = masked;
         element.classList.remove('revealed');
       }, 3000);
     }
   }

   function editEnvVar(key) {
     AppState.currentEditingEnv = key;
     const value = AppState.config[key];
     
     document.getElementById('editEnvKey').value = key;
     document.getElementById('editEnvValue').value = value || '';
     document.getElementById('editEnvHint').textContent = ENV_DESCRIPTIONS[key] || '';
     
     showModal('editEnvModal');
   }

   async function saveEnvVar() {
     const key = AppState.currentEditingEnv;
     const value = document.getElementById('editEnvValue').value.trim();
     
     if (!key) {
       showToast('环境变量名不能为空', 'error');
       return;
     }

     AppState.config[key] = value;
     
     // 保存到本地存储
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     
     // 尝试保存到服务器
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json'
         },
         body: JSON.stringify({
           config: { [key]: value }
         })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.hasUnsavedChanges = false;
         updateConfigDisplay(key, value);
         closeModal('editEnvModal');
         showToast(\`环境变量 \${key} 已保存到: \${result.savedTo.join('、')}\`, 'success');
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       console.error('保存到服务器失败:', error);
       updateConfigDisplay(key, value);
       closeModal('editEnvModal');
       showToast(\`环境变量 \${key} 已保存到浏览器本地（服务器保存失败: \${error.message}）\`, 'warning');
     }
   }

   async function saveAllConfig() {
     // 保存到本地存储
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     localStorage.setItem('danmu_api_vod_servers', JSON.stringify(AppState.vodServers));
     localStorage.setItem('danmu_api_source_order', JSON.stringify(AppState.sourceOrder));
     
     showToast('正在保存配置到服务器...', 'info', 1000);

     // 尝试保存到服务器
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json'
         },
         body: JSON.stringify({
           config: {
             ...AppState.config,
             VOD_SERVERS: AppState.vodServers.map(s => {
               if (typeof s === 'string') return s;
               return \`\${s.name}@\${s.url}\`;
             }).join(','),
             SOURCE_ORDER: AppState.sourceOrder.join(',')
           }
         })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.hasUnsavedChanges = false;
         showToast(\`所有配置已保存到: \${result.savedTo.join('、')}\`, 'success');
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       console.error('保存到服务器失败:', error);
       showToast(\`配置已保存到浏览器本地（服务器保存失败: \${error.message}）\`, 'warning');
     }
   }

   function updateConfigDisplay(key, value) {
     const configItem = document.querySelector(\`.config-item[data-key="\${key}"]\`);
     if (!configItem) return;

     const valueElement = configItem.querySelector('.config-value code');
     if (!valueElement) return;

     const SENSITIVE_KEYS = ['TOKEN','BILIBILI_COOKIE','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','TMDB_API_KEY','PROXY_URL','redisUrl','redisToken'];
     const isSensitive = SENSITIVE_KEYS.includes(key) || 
                        key.toLowerCase().includes('token') ||
                        key.toLowerCase().includes('password') ||
                        key.toLowerCase().includes('secret') ||
                        key.toLowerCase().includes('key') ||
                        key.toLowerCase().includes('cookie');

     if (isSensitive && value) {
       const masked = '•'.repeat(Math.min(value.length, 24));
       valueElement.textContent = masked;
       configItem.querySelector('.config-value').dataset.real = value.replace(/[&<>"']/g, (m) => ({
         '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
       })[m]);
       configItem.querySelector('.config-value').dataset.masked = masked;
     } else if (typeof value === 'boolean') {
       valueElement.textContent = value ? '已启用' : '已禁用';
       const configValueEl = configItem.querySelector('.config-value');
       configValueEl.classList.remove('value-enabled', 'value-disabled', 'value-empty');
       configValueEl.classList.add(value ? 'value-enabled' : 'value-disabled');
     } else if (!value) {
       valueElement.textContent = '未配置';
       const configValueEl = configItem.querySelector('.config-value');
       configValueEl.classList.remove('value-enabled', 'value-disabled');
       configValueEl.classList.add('value-empty');
     } else {
       valueElement.textContent = value;
       const configValueEl = configItem.querySelector('.config-value');
       configValueEl.classList.remove('value-enabled', 'value-disabled', 'value-empty');
     }
   }

   function exportConfig() {
     const config = {
       envVars: AppState.config,
       vodServers: AppState.vodServers,
       sourceOrder: AppState.sourceOrder,
       exportTime: new Date().toISOString()
     };

     const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
     const url = URL.createObjectURL(blob);
     const a = document.createElement('a');
     a.href = url;
     a.download = \`danmu-api-config-\${new Date().getTime()}.json\`;
     a.click();
     URL.revokeObjectURL(url);
     showToast('配置已导出', 'success');
   }

   document.addEventListener('DOMContentLoaded', function() {
     initializeApp();
     loadLocalStorageData();
     setupGlobalSearch();
   });

   function showModal(modalId) {
     const modal = document.getElementById(modalId);
     if (!modal) return;
     modal.classList.add('show');
     document.body.style.overflow = 'hidden';
   }

   function closeModal(modalId) {
     const modal = document.getElementById(modalId);
     if (!modal) return;
     modal.classList.remove('show');
     document.body.style.overflow = '';
   }

   document.addEventListener('click', function(e) {
     if (e.target.classList.contains('modal-overlay')) {
       closeModal(e.target.id);
     }
   });

   function showToast(message, type = 'info', duration = 3000) {
     const container = document.getElementById('toastContainer');
     if (!container) return;

     const icons = {
       success: '<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>',
       error: '<path d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>',
       warning: '<path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" stroke-width="2"/>',
       info: '<path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>'
     };

     const toast = document.createElement('div');
     toast.className = \`toast toast-\${type}\`;
     toast.innerHTML = \`
       <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
         \${icons[type] || icons.info}
       </svg>
       <div class="toast-content">\${message}</div>
       <button class="toast-close" onclick="this.parentElement.remove()">
         <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
           <path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
         </svg>
       </button>
     \`;

     container.appendChild(toast);
     setTimeout(() => {
       toast.style.animation = 'slideInRight 0.3s var(--ease-smooth) reverse';
       setTimeout(() => toast.remove(), 300);
     }, duration);
   }

   function setupGlobalSearch() {
     const searchInput = document.getElementById('globalSearch');
     if (!searchInput) return;

     searchInput.addEventListener('input', function(e) {
       const query = e.target.value.toLowerCase().trim();
       
       if (!query) {
         document.querySelectorAll('.config-item, .server-item, .source-item').forEach(item => {
           item.style.display = '';
           item.classList.remove('highlight');
         });
         return;
       }

       document.querySelectorAll('.config-item').forEach(item => {
         const label = item.querySelector('.config-label')?.textContent.toLowerCase() || '';
         const value = item.querySelector('.config-value')?.textContent.toLowerCase() || '';
         const matches = label.includes(query) || value.includes(query);
         item.style.display = matches ? '' : 'none';
         if (matches) item.classList.add('highlight');
       });

       document.querySelectorAll('.server-item').forEach(item => {
         const name = item.querySelector('.server-name')?.textContent.toLowerCase() || '';
         const url = item.querySelector('.server-url')?.textContent.toLowerCase() || '';
         const matches = name.includes(query) || url.includes(query);
         item.style.display = matches ? '' : 'none';
         if (matches) item.classList.add('highlight');
       });

       document.querySelectorAll('.source-item').forEach(item => {
         const name = item.querySelector('.source-name')?.textContent.toLowerCase() || '';
         const matches = name.includes(query);
         item.style.display = matches ? '' : 'none';
         if (matches) item.classList.add('highlight');
       });
     });
   }

   document.addEventListener('dblclick', function(e) {
     const configValue = e.target.closest('.config-value');
     if (!configValue) return;
     
     const code = configValue.querySelector('code');
     if (!code) return;
     
     let text = code.textContent;
     
     if (configValue.classList.contains('sensitive-value') && configValue.dataset.real) {
       const textarea = document.createElement('textarea');
       textarea.innerHTML = configValue.dataset.real;
       text = textarea.value;
     } else {
       const originalValue = configValue.dataset.original;
       if (originalValue) {
         const textarea = document.createElement('textarea');
         textarea.innerHTML = originalValue;
         text = textarea.value;
       }
     }
     
     if (text === '未配置' || text === '默认值' || text === '已启用' || text === '已禁用') return;
     
     copyToClipboard(text);
     showToast('已复制到剪贴板', 'success');
   });

   function copyToClipboard(text) {
     if (navigator.clipboard) {
       navigator.clipboard.writeText(text);
     } else {
       const textarea = document.createElement('textarea');
       textarea.value = text;
       textarea.style.position = 'fixed';
       textarea.style.opacity = '0';
       document.body.appendChild(textarea);
       textarea.select();
       document.execCommand('copy');
       document.body.removeChild(textarea);
     }
   }

   function toggleMobileMenu() {
     const sidebar = document.getElementById('sidebar');
     const overlay = document.getElementById('mobileOverlay');
     sidebar.classList.toggle('mobile-open');
     overlay.classList.toggle('show');
   }

   function closeMobileMenu() {
     const sidebar = document.getElementById('sidebar');
     const overlay = document.getElementById('mobileOverlay');
     sidebar.classList.remove('mobile-open');
     overlay.classList.remove('show');
   }

   function toggleMobileSearch() {
     const searchBox = document.querySelector('.search-box');
     const isVisible = searchBox.style.display === 'block';
     
     if (isVisible) {
       searchBox.style.display = '';
       searchBox.style.position = '';
       searchBox.style.top = '';
       searchBox.style.left = '';
       searchBox.style.right = '';
       searchBox.style.width = '';
       searchBox.style.zIndex = '';
       searchBox.style.background = '';
       searchBox.style.padding = '';
       searchBox.style.borderRadius = '';
       searchBox.style.boxShadow = '';
     } else {
       searchBox.style.display = 'block';
       searchBox.style.position = 'fixed';
       searchBox.style.top = '70px';
       searchBox.style.left = '16px';
       searchBox.style.right = '16px';
       searchBox.style.width = 'auto';
       searchBox.style.zIndex = '9999';
       searchBox.style.background = 'var(--bg-secondary)';
       searchBox.style.padding = '12px';
       searchBox.style.borderRadius = '12px';
       searchBox.style.boxShadow = 'var(--shadow-xl)';
       
       // 自动聚焦搜索框
       setTimeout(() => {
         document.getElementById('globalSearch').focus();
       }, 100);
     }
   }

   // 点击页面其他地方关闭搜索框
   document.addEventListener('click', function(e) {
     const searchBox = document.querySelector('.search-box');
     const searchBtn = document.querySelector('.mobile-search-btn');
     
     if (!searchBox.contains(e.target) && !searchBtn.contains(e.target)) {
       if (window.innerWidth <= 768 && searchBox.style.display === 'block') {
         toggleMobileSearch();
       }
     }
   });

   document.addEventListener('keydown', function(e) {
     if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '3') {
       e.preventDefault();
       const pages = ['overview', 'config', 'about'];
       const index = parseInt(e.key) - 1;
       if (pages[index]) {
         const navItems = document.querySelectorAll('.nav-item');
         if (navItems[index]) {
           navItems[index].click();
         }
       }
     }
     
     if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
       e.preventDefault();
       toggleTheme();
     }

     if ((e.ctrlKey || e.metaKey) && e.key === 's') {
       e.preventDefault();
       saveAllConfig();
     }

     if (e.key === 'Escape') {
       closeMobileMenu();
       document.querySelectorAll('.modal-overlay.show').forEach(modal => {
         closeModal(modal.id);
       });
     }
   });
   

   window.addEventListener('beforeunload', function(e) {
     if (AppState.hasUnsavedChanges) {
       e.preventDefault();
       e.returnValue = '您有未保存的更改，确定要离开吗？';
       return e.returnValue;
     }
   });

   // ========== 登录相关功能 ==========
   // 退出登录
   async function logout() {
     if (!confirm('确定要退出登录吗？')) return;
     
     try {
       await fetch('/api/logout', { method: 'POST' });
       window.location.href = '/';
     } catch (error) {
       showToast('退出失败', 'error');
     }
   }
   // ========== 查看所有环境变量功能 ==========
   // ========== 查看所有环境变量功能 ==========
   async function showAllEnvVars() {
     showModal('allEnvVarsModal');
     
     try {
       // 📡 从服务器加载最新配置
       const response = await fetch('/api/config/load');
       const result = await response.json();
       
       let envData = {};
       
       if (result.success && result.config) {
         envData = result.config;
       } else {
         // 降级到本地状态
         envData = AppState.config;
       }
       
       // 🔥 确保返回的是真实值（服务器端已经不再加密存储）
      const realEnvData = {};
      for (const [key, value] of Object.entries(envData)) {
        // 直接使用值，不再二次处理
        realEnvData[key] = value;
      }
       
       // 添加元数据
       const fullData = {
         _metadata: {
           exportTime: new Date().toISOString(),
           totalCount: Object.keys(realEnvData).length,
           platform: '${globals.deployPlatform || 'unknown'}',
           version: '${globals.VERSION || 'unknown'}'
         },
         ...realEnvData
       };
       
       // 格式化 JSON（美化输出）
       const jsonStr = JSON.stringify(fullData, null, 2);
       
       // 语法高亮（简化版）
       const highlighted = jsonStr
         .replace(/("(?:\\\\.|[^"\\\\])*")\\s*:/g, '<span style="color: #a78bfa;">$1</span>:') // 键名
         .replace(/:\\s*"((?:\\\\.|[^"\\\\])*)"/g, ': <span style="color: #34d399;">"$1"</span>') // 字符串值
         .replace(/:\\s*(true|false)/g, ': <span style="color: #f59e0b;">$1</span>') // 布尔值
         .replace(/:\\s*(-?\\d+(?:\\.\\d+)?)/g, ': <span style="color: #60a5fa;">$1</span>'); // 数字
       
       document.getElementById('allEnvVarsJson').innerHTML = highlighted;
       
     } catch (error) {
       console.error('加载环境变量失败:', error);
       document.getElementById('allEnvVarsJson').textContent = JSON.stringify({
         error: '加载失败',
         message: error.message
       }, null, 2);
     }
   }

   
   // 复制所有环境变量 JSON
   function copyAllEnvJson() {
     const preElement = document.getElementById('allEnvVarsJson');
     if (!preElement) return;
     
     // 移除 HTML 标签，获取纯文本
     const tempDiv = document.createElement('div');
     tempDiv.innerHTML = preElement.innerHTML;
     const plainText = tempDiv.textContent || tempDiv.innerText;
     
     copyToClipboard(plainText);
     showToast('已复制完整配置到剪贴板', 'success');
   }
   
   // 下载环境变量 JSON 文件
   function downloadEnvJson() {
     const preElement = document.getElementById('allEnvVarsJson');
     if (!preElement) return;
     
     // 移除 HTML 标签
     const tempDiv = document.createElement('div');
     tempDiv.innerHTML = preElement.innerHTML;
     const plainText = tempDiv.textContent || tempDiv.innerText;
     
     const blob = new Blob([plainText], { type: 'application/json' });
     const url = URL.createObjectURL(blob);
     const a = document.createElement('a');
     a.href = url;
     a.download = \`danmu-api-env-\${new Date().getTime()}.json\`;
     a.click();
     URL.revokeObjectURL(url);
     showToast('环境变量配置已下载', 'success');
   }

   // ========== 版本检测功能 ==========
   // 全局变量存储版本信息
   let versionInfo = {
     isDocker: false,
     canAutoUpdate: false,
     hasUpdate: false
   };

   async function checkForUpdates() {
     const versionStatus = document.getElementById('versionStatus');
     const updateBtn = document.getElementById('updateBtn');
     if (!versionStatus) return;

     try {
       // 显示加载状态
       versionStatus.innerHTML = '<span class="loading-spinner" style="display: inline-block; margin-right: 6px;"></span>正在检查更新...';
       if (updateBtn) updateBtn.style.display = 'none';
       
       // 通过后端 API 检查版本
       const response = await fetch('/api/version/check', {
         cache: 'no-cache'
       });

       if (!response.ok) {
         throw new Error('网络请求失败');
       }

       const result = await response.json();
       
       if (!result.success) {
         throw new Error(result.error || '版本检查失败');
       }

       const { currentVersion, latestVersion, isDocker, canAutoUpdate } = result;
       
       // 保存版本信息到全局变量
       versionInfo = {
         isDocker: isDocker || false,
         canAutoUpdate: canAutoUpdate || false,
         hasUpdate: false,
         latestVersion
       };

       // 比较版本号
       const isLatest = compareVersions(currentVersion, latestVersion) >= 0;

       if (isLatest) {
         versionStatus.innerHTML = '✅ 已是最新版本';
         if (updateBtn) updateBtn.style.display = 'none';
       } else {
         versionInfo.hasUpdate = true;
         
         if (canAutoUpdate) {
           // Docker 环境，显示一键更新按钮
           versionStatus.innerHTML = \`
             <span style="color: var(--warning);">⚠️ 发现新版本 v\${latestVersion}</span>
           \`;
           if (updateBtn) {
             updateBtn.style.display = 'flex';
             updateBtn.title = '一键更新到 v' + latestVersion;
           }
         } else {
           // 非 Docker 环境，显示手动更新链接
           versionStatus.innerHTML = \`
             <span style="color: var(--warning);">⚠️ 发现新版本 v\${latestVersion}</span>
             <a href="https://github.com/huangxd-/danmu_api/releases" 
                target="_blank" 
                rel="noopener"
                style="color: var(--primary-400); text-decoration: none; margin-left: 8px; font-weight: 600;"
                title="查看更新日志">
               查看详情 →
             </a>
           \`;
         }
       }
     } catch (error) {
       console.error('版本检查失败:', error);
       versionStatus.innerHTML = '✅ 服务运行正常';
       if (updateBtn) updateBtn.style.display = 'none';
     }
   }

   // 执行更新
   async function performUpdate() {
     if (!versionInfo.canAutoUpdate) {
       showToast('当前环境不支持自动更新，请手动更新', 'warning');
       return;
     }

     if (!versionInfo.hasUpdate) {
       showToast('当前已是最新版本', 'info');
       return;
     }

     const confirmMsg = \`确定要更新到 v\${versionInfo.latestVersion} 吗？\n\n更新过程需要 30-60 秒，期间服务会短暂中断。\`;
     if (!confirm(confirmMsg)) {
       return;
     }

     const updateBtn = document.getElementById('updateBtn');
     const versionStatus = document.getElementById('versionStatus');

     try {
       // 禁用按钮
       if (updateBtn) {
         updateBtn.disabled = true;
         updateBtn.style.opacity = '0.6';
       }

       versionStatus.innerHTML = '<span class="loading-spinner" style="display: inline-block; margin-right: 6px;"></span>正在更新容器...';
       showToast('开始更新 Docker 容器...', 'info', 2000);

       const response = await fetch('/api/version/update', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json'
         }
       });

// 🔥 修复：正确处理响应
      let result;
      try {
        result = await response.json();
      } catch (jsonError) {
        // 如果 JSON 解析失败，检查 HTTP 状态码
        if (response.ok) {
          result = { success: true, message: '更新已触发' };
        } else {
          throw new Error('更新请求失败');
        }
      }

      // 检查 HTTP 状态码和 result.success
      if (response.ok && result.success) {
        versionStatus.innerHTML = '✅ 更新触发成功，容器即将重启...';
        showToast(result.message || '更新命令已提交，容器即将重启', 'success', 3000);

        // 30秒后开始检测服务是否恢复
        setTimeout(() => {
          versionStatus.innerHTML = '⏳ 等待服务恢复...';
          checkServiceRecovery();
        }, 30000);

      } else {
        throw new Error(result.error || result.message || '更新失败');
      }

     } catch (error) {
       console.error('更新失败:', error);
       showToast('更新失败: ' + error.message, 'error');
       versionStatus.innerHTML = '❌ 更新失败';
       
       if (updateBtn) {
         updateBtn.disabled = false;
         updateBtn.style.opacity = '1';
       }

       // 3秒后恢复原状态
       setTimeout(() => {
         checkForUpdates();
       }, 3000);
     }
   }

   // 检查服务是否恢复
   async function checkServiceRecovery() {
     const versionStatus = document.getElementById('versionStatus');
     let attempts = 0;
     const maxAttempts = 20; // 最多尝试20次（约60秒）

     const checkInterval = setInterval(async () => {
       attempts++;

       try {
         const response = await fetch('/api/version/check', {
           cache: 'no-cache',
           signal: AbortSignal.timeout(5000) // 5秒超时
         });

         if (response.ok) {
           clearInterval(checkInterval);
           versionStatus.innerHTML = '✅ 服务已恢复，正在刷新...';
           showToast('服务已恢复，页面即将刷新', 'success', 2000);
           
           // 2秒后刷新页面
           setTimeout(() => {
             window.location.reload();
           }, 2000);
         }
       } catch (error) {
         // 服务未恢复，继续等待
         console.log(\`等待服务恢复... (\${attempts}/\${maxAttempts})\`);
       }

       if (attempts >= maxAttempts) {
         clearInterval(checkInterval);
         versionStatus.innerHTML = '⚠️ 服务恢复超时，请手动刷新页面';
         showToast('服务恢复超时，请手动刷新页面检查更新结果', 'warning', 5000);
         
         const updateBtn = document.getElementById('updateBtn');
         if (updateBtn) {
           updateBtn.disabled = false;
           updateBtn.style.opacity = '1';
         }
       }
     }, 3000); // 每3秒检查一次
   }

   /**
    * 比较版本号
    * @param {string} v1 当前版本
    * @param {string} v2 最新版本
    * @returns {number} 1=v1>v2, 0=v1=v2, -1=v1<v2
    */
   function compareVersions(v1, v2) {
     const parts1 = v1.split('.').map(Number);
     const parts2 = v2.split('.').map(Number);

     for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
       const num1 = parts1[i] || 0;
       const num2 = parts2[i] || 0;

       if (num1 > num2) return 1;
       if (num1 < num2) return -1;
     }

     return 0;
   }


   // 更新并复制 API 地址
   function updateApiUrlDisplay() {
     const currentUrl = window.location.origin;
     const currentPath = window.location.pathname;
     
     // 从当前路径中提取 token（如果存在）
     let token = '87654321'; // 默认 token
     const pathParts = currentPath.split('/').filter(Boolean);
     
     // 如果路径中有 token（非空且不是常见的路径关键字）
     if (pathParts.length > 0) {
       const firstPart = pathParts[0];
       const knownPaths = ['api', 'v1', 'v2'];
       if (!knownPaths.includes(firstPart)) {
         token = firstPart;
       }
     }
     
     // 尝试从配置中获取 token
     if (AppState.config && AppState.config.TOKEN && AppState.config.TOKEN !== '87654321') {
       token = AppState.config.TOKEN;
     }
     
     // 如果是默认 token，API 地址不包含 token
     const apiUrl = token === '87654321' ? currentUrl : \`\${currentUrl}/\${token}\`;
     
     // 生成完全星号的遮挡地址（保持相同长度）
     const urlLength = apiUrl.length;
     const maskedUrl = '•'.repeat(urlLength);
     
     const apiUrlElement = document.getElementById('apiUrlText');
     const apiUrlDisplay = document.getElementById('apiUrlDisplay');
     
     if (apiUrlElement && apiUrlDisplay) {
       // 默认显示星号
       apiUrlElement.textContent = maskedUrl;
       // 保存真实地址到 data 属性
       apiUrlDisplay.dataset.real = apiUrl;
       apiUrlDisplay.dataset.masked = maskedUrl;
     }
   }

   function toggleApiUrl() {
     const apiUrlDisplay = document.getElementById('apiUrlDisplay');
     const apiUrlElement = document.getElementById('apiUrlText');
     
     if (!apiUrlDisplay || !apiUrlElement) return;
     
     const real = apiUrlDisplay.dataset.real;
     const masked = apiUrlDisplay.dataset.masked;
     const isRevealed = apiUrlDisplay.classList.contains('revealed');
     
     if (isRevealed) {
       // 已显示，切换回隐藏
       apiUrlElement.textContent = masked;
       apiUrlDisplay.classList.remove('revealed');
       if (apiUrlDisplay.hideTimer) {
         clearTimeout(apiUrlDisplay.hideTimer);
       }
     } else {
       // 显示真实地址
       apiUrlElement.textContent = real;
       apiUrlDisplay.classList.add('revealed');
       
       // 3秒后自动隐藏
       apiUrlDisplay.hideTimer = setTimeout(() => {
         apiUrlElement.textContent = masked;
         apiUrlDisplay.classList.remove('revealed');
       }, 3000);
     }
   }

   function copyApiUrl(event) {
     // 阻止事件冒泡，避免触发 toggleApiUrl
     if (event) {
       event.stopPropagation();
     }
     
     const apiUrlDisplay = document.getElementById('apiUrlDisplay');
     if (!apiUrlDisplay) return;
     
     const apiUrl = apiUrlDisplay.dataset.real;
     if (!apiUrl) return;
     
     copyToClipboard(apiUrl);
     showToast('API 地址已复制到剪贴板', 'success');
   }

   // 显示修改密码弹窗
   function showChangePasswordModal() {
     document.getElementById('newUsername').value = '';
     document.getElementById('oldPassword').value = '';
     document.getElementById('newPassword').value = '';
     document.getElementById('confirmPassword').value = '';
     showModal('changePasswordModal');
   }

   // 修改密码
   async function changePassword() {
     const newUsername = document.getElementById('newUsername').value.trim();
     const oldPassword = document.getElementById('oldPassword').value;
     const newPassword = document.getElementById('newPassword').value;
     const confirmPassword = document.getElementById('confirmPassword').value;
     
     if (!oldPassword) {
       showToast('请输入旧密码', 'error');
       return;
     }
     
     if (!newPassword) {
       showToast('请输入新密码', 'error');
       return;
     }
     
     if (newPassword !== confirmPassword) {
       showToast('两次输入的密码不一致', 'error');
       return;
     }
     
     if (newPassword.length < 4) {
       showToast('密码长度至少为4位', 'error');
       return;
     }
     
     try {
       const response = await fetch('/api/change-password', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json'
         },
         body: JSON.stringify({
           oldPassword,
           newPassword,
           newUsername: newUsername || undefined
         })
       });
       
       const result = await response.json();
       
       if (result.success) {
         showToast('密码修改成功，请重新登录', 'success');
         closeModal('changePasswordModal');
         setTimeout(() => {
           logout();
         }, 1500);
       } else {
         showToast(result.message || '修改失败', 'error');
       }
     } catch (error) {
       showToast('修改失败，请稍后重试', 'error');
     }
   }

   // ========== 日志管理功能 ==========
   const LogManager = {
     logs: [],
     currentFilter: 'all',
     refreshInterval: null,
     isPaused: false,
     shouldAutoScroll: true
   };

   async function showLogsModal() {
     showModal('logsModal');
     LogManager.isPaused = false;
     updatePauseButtonState();
     await refreshLogs();
     
     // 每3秒自动刷新
     LogManager.refreshInterval = setInterval(() => {
       if (!LogManager.isPaused) {
         refreshLogs(true);
       }
     }, 3000);
     
     // 监听用户手动滚动
     setTimeout(() => {
       const logWrapper = document.getElementById('logContentWrapper');
       if (logWrapper) {
         let userScrolling = false;
         let scrollTimeout;
         
         logWrapper.addEventListener('scroll', function() {
           const isAtBottom = logWrapper.scrollHeight - logWrapper.scrollTop <= logWrapper.clientHeight + 50;
           
           if (!isAtBottom) {
             if (!LogManager.isPaused && !userScrolling) {
               userScrolling = true;
               LogManager.shouldAutoScroll = false;
             }
           } else {
             LogManager.shouldAutoScroll = true;
             userScrolling = false;
           }
           
           clearTimeout(scrollTimeout);
           scrollTimeout = setTimeout(() => {
             userScrolling = false;
           }, 1000);
         });
       }
     }, 100);
   }

   async function refreshLogs(silent = false) {
     try {
       const response = await fetch('/api/logs?format=json&limit=200');
       const result = await response.json();
       
       if (result.success && result.logs) {
         const oldCount = LogManager.logs.length;
         LogManager.logs = result.logs;
         
         updateLogCount();
         displayLogs();
         
         if (!silent) {
           showToast(\`已加载 \${result.logs.length} 条日志\`, 'success', 1500);
         }
         
         if (!LogManager.isPaused && result.logs.length > oldCount && LogManager.shouldAutoScroll) {
           scrollToBottom();
         }
       }
     } catch (error) {
       console.error('加载日志失败:', error);
       if (!silent) {
         showToast('加载日志失败: ' + error.message, 'error');
       }
     }
   }

   function displayLogs() {
     const logContent = document.getElementById('logContent');
     if (!logContent) return;
     
     const filteredLogs = LogManager.currentFilter === 'all' 
       ? LogManager.logs 
       : LogManager.logs.filter(log => log.level === LogManager.currentFilter);
     
     if (filteredLogs.length === 0) {
       logContent.innerHTML = '<div style="text-align: center; padding: 3rem; color: var(--text-tertiary);">暂无日志</div>';
       return;
     }
     
     const logsHtml = filteredLogs.map(log => {
       const message = typeof log.message === 'string' 
         ? log.message 
         : JSON.stringify(log.message);
       
       const escapedMessage = message
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;')
         .replace(/'/g, '&#39;');
       
       const shortTime = log.timestamp && log.timestamp.length > 10 ? log.timestamp.substring(5, 19) : (log.timestamp || '');
       
       return \`
         <div class="log-line \${log.level}">
           <span class="log-timestamp">\${shortTime}</span>
           <span class="log-level">[\${log.level}]</span>
           <span>\${escapedMessage}</span>
         </div>
       \`;
     }).join('');
     
     logContent.innerHTML = logsHtml;
   }

   function filterLogs(level) {
     LogManager.currentFilter = level;
     
     document.querySelectorAll('.log-filter').forEach(btn => {
       btn.classList.remove('active');
       if (btn.dataset.level === level) {
         btn.classList.add('active');
       }
     });
     
     displayLogs();
     
     if (!LogManager.isPaused) {
       setTimeout(scrollToBottom, 100);
     }
   }

   function clearLogs() {
     if (!confirm('确定清空日志显示？')) return;
     
     LogManager.logs = [];
     displayLogs();
     updateLogCount();
     showToast('日志已清空', 'success');
   }

   function toggleLogPause() {
     LogManager.isPaused = !LogManager.isPaused;
     updatePauseButtonState();
     
     const wrapper = document.getElementById('logContentWrapper');
     const statusBadge = document.getElementById('logStatusBadge');
     const statusText = document.getElementById('logStatusText');
     
     if (LogManager.isPaused) {
       wrapper.classList.add('paused');
       statusBadge.classList.remove('running');
       statusBadge.classList.add('paused');
       statusText.textContent = '已暂停';
       showToast('日志滚动已暂停', 'warning', 2000);
     } else {
       wrapper.classList.remove('paused');
       statusBadge.classList.remove('paused');
       statusBadge.classList.add('running');
       statusText.textContent = '运行中';
       showToast('日志滚动已恢复', 'success', 2000);
       
       setTimeout(scrollToBottom, 100);
     }
   }

   function updatePauseButtonState() {
     const pauseBtn = document.getElementById('pauseLogsBtn');
     const pauseIcon = document.getElementById('pauseIcon');
     const playIcon = document.getElementById('playIcon');
     const btnText = document.getElementById('pauseBtnText');
     
     if (!pauseBtn) return;
     
     if (LogManager.isPaused) {
       pauseBtn.classList.add('active');
       pauseIcon.style.display = 'none';
       playIcon.style.display = 'block';
       btnText.textContent = '恢复';
     } else {
       pauseBtn.classList.remove('active');
       pauseIcon.style.display = 'block';
       playIcon.style.display = 'none';
       btnText.textContent = '暂停';
     }
   }

   function scrollToBottom() {
     const wrapper = document.getElementById('logContentWrapper');
     if (wrapper) {
       wrapper.scrollTop = wrapper.scrollHeight;
     }
   }

   function updateLogCount() {
     const logCountElement = document.getElementById('logCount');
     if (logCountElement) {
       const filteredCount = LogManager.currentFilter === 'all'
         ? LogManager.logs.length
         : LogManager.logs.filter(log => log.level === LogManager.currentFilter).length;
       
       logCountElement.textContent = \`\${filteredCount} 条\`;
     }
   }

   // 关闭日志窗口时停止自动刷新
   const originalCloseModal = closeModal;
   closeModal = function(modalId) {
     if (modalId === 'logsModal' && LogManager.refreshInterval) {
       clearInterval(LogManager.refreshInterval);
       LogManager.refreshInterval = null;
       LogManager.isPaused = false;
       LogManager.shouldAutoScroll = true;
     }
     originalCloseModal(modalId);
   };

   // 快捷键支持
   document.addEventListener('keydown', function(e) {
     // Ctrl+L 打开日志
     if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
       e.preventDefault();
       const logsModal = document.getElementById('logsModal');
       if (logsModal && !logsModal.classList.contains('show')) {
         showLogsModal();
       }
     }
     
     // 空格键暂停/恢复（仅当日志窗口打开时）
     if (e.code === 'Space') {
       const logsModal = document.getElementById('logsModal');
       if (logsModal && logsModal.classList.contains('show')) {
         e.preventDefault();
         toggleLogPause();
       }
     }
   });
   // 更新滑块进度条和显示值 - 优化版
   function updateRangeProgress(input, progressId, valueId, min, max, formatter = null) {
     const value = parseFloat(input.value);
     const progress = document.getElementById(progressId);
     const valueDisplay = document.getElementById(valueId);
     
     if (!progress || !valueDisplay) return;
     
     // 计算进度百分比
     const percentage = ((value - min) / (max - min)) * 100;
     progress.style.width = Math.max(0, Math.min(100, percentage)) + '%';
     
     // 进度条末端圆角处理
     if (percentage >= 98) {
       progress.style.borderRadius = '10px';
     } else if (percentage <= 2) {
       progress.style.borderRadius = '10px 0 0 10px';
       progress.style.minWidth = '8px'; // 确保最小可见宽度
     } else {
       progress.style.borderRadius = '10px 0 0 10px';
       progress.style.minWidth = '0';
     }
     
     // 更新显示值，添加微动画
     const newValue = formatter && typeof formatter === 'function' 
       ? formatter(value) 
       : String(value);
     
     if (valueDisplay.textContent !== newValue) {
       valueDisplay.style.transform = 'scale(1.08)';
       valueDisplay.textContent = newValue;
       setTimeout(() => {
         valueDisplay.style.transform = 'scale(1)';
       }, 120);
     }
     
     // 为显示值添加过渡效果
     if (!valueDisplay.style.transition) {
       valueDisplay.style.transition = 'transform 0.12s cubic-bezier(0.4, 0, 0.2, 1)';
     }
   }
   // 快速配置锁定/解锁功能 (修复版)
   function toggleQuickConfigLock(button, inputId) {
     const input = document.getElementById(inputId);
     const lockIcon = button.querySelector('.lock-icon');
     const unlockIcon = button.querySelector('.unlock-icon');
     
     // 判断当前是否处于锁定状态 (通过 class 判断更准确)
     const isLocked = input.classList.contains('locked');
     
     if (isLocked) {
       // === 执行解锁 ===
       
       // 针对不同元素类型处理 disabled/readOnly
       if (input.tagName === 'SELECT' || input.type === 'range') {
         input.disabled = false; // 下拉框和滑块需要移除 disabled
       } else {
         input.readOnly = false; // 文本框移除 readOnly
       }
       
       // 样式更新
       input.classList.remove('locked');
       button.classList.add('unlocked');
       lockIcon.style.display = 'none';
       unlockIcon.style.display = 'block';
       button.title = '点击锁定';
       
       // 聚焦到输入框（仅文本框）
       if (input.tagName === 'INPUT' && input.type === 'text') {
         input.focus();
         input.select();
       }
     } else {
       // === 执行锁定 ===
       
       if (input.tagName === 'SELECT' || input.type === 'range') {
         input.disabled = true;
       } else {
         input.readOnly = true;
       }
       
       // 样式更新
       input.classList.add('locked');
       button.classList.remove('unlocked');
       lockIcon.style.display = 'block';
       unlockIcon.style.display = 'none';
       button.title = '点击解锁编辑';
     }
   }

   // ========== 快速配置功能 ==========
   function showQuickConfig() {
     // 加载当前配置值
     const whiteRatio = AppState.config.WHITE_RATIO || '-1';
     const danmuColors = AppState.config.DANMU_COLORS || '';
     const danmuLimit = AppState.config.DANMU_LIMIT || '-1';
     const danmuFontSize = AppState.config.DANMU_FONTSIZE || '25';
     const searchCache = AppState.config.SEARCH_CACHE_MINUTES || '1';
     const commentCache = AppState.config.COMMENT_CACHE_MINUTES || '1';
     
     // 设置滑块值
     document.getElementById('quickWhiteRatio').value = whiteRatio;
     document.getElementById('quickDanmuColors').value = danmuColors;
     document.getElementById('quickDanmuLimit').value = danmuLimit;
     document.getElementById('quickDanmuFontSize').value = danmuFontSize;
     document.getElementById('quickOutputFormat').value = AppState.config.DANMU_OUTPUT_FORMAT || 'json';
     document.getElementById('quickToken').value = AppState.config.TOKEN || '87654321';
     document.getElementById('quickSearchCache').value = searchCache;
     document.getElementById('quickCommentCache').value = commentCache;
     
     // 显示模态框
     showModal('quickConfigModal');
     
     // 延迟更新进度条（确保模态框已显示）
     setTimeout(() => {
       updateRangeProgress(
         document.getElementById('quickWhiteRatio'),
         'whiteRatioProgress',
         'whiteRatioValue',
         -1, 100
       );
       
       updateRangeProgress(
         document.getElementById('quickDanmuLimit'),
         'danmuLimitProgress',
         'danmuLimitValue',
         -1, 10000,
         val => val === -1 ? '不限制' : val
       );

       updateRangeProgress(
         document.getElementById('quickDanmuFontSize'),
         'danmuFontSizeProgress',
         'danmuFontSizeValue',
         10, 50,
         val => val + 'px'
       );
       
       updateRangeProgress(
         document.getElementById('quickSearchCache'),
         'searchCacheProgress',
         'searchCacheValue',
         1, 30
       );
       
       updateRangeProgress(
         document.getElementById('quickCommentCache'),
         'commentCacheProgress',
         'commentCacheValue',
         1, 60
       );
     }, 50);
   }
   // 设置弹幕颜色预设
   function setDanmuColorPreset(type) {
     const input = document.getElementById('quickDanmuColors');
     const lockBtn = input.previousElementSibling.previousElementSibling.querySelector('.edit-lock-btn'); // 获取上面的锁按钮
     
     // 如果被锁定，自动解锁
     if (input.classList.contains('locked')) {
        toggleQuickConfigLock(lockBtn, 'quickDanmuColors');
     }

     let colors = '';
     switch(type) {
       case 'macaron': // 糖果柔和 (默认)
         colors = '#FFB1C1,#FFC48B,#AAFFAA,#98FFFF,#B4B5F8,#FF96AA,#72E7E8,#FFD2CB,#CACFFF';
         break;
       case 'neon': // 赛博霓虹
         colors = '#FF0055,#00FF99,#00CCFF,#FFCC00,#CC00FF,#FF3300,#00FF00,#FF0099';
         break;
       case 'bilibili': // B站经典
         colors = '#FE0302,#FF7204,#FFAA02,#FFD302,#FFFF00,#A0EE00,#00CD00,#019899,#4266BE,#89D5FF,#CC0273';
         break;
     }
     
     input.value = colors;
     // 添加闪烁效果提示已更改
     input.style.backgroundColor = 'var(--bg-hover)';
     setTimeout(() => input.style.backgroundColor = '', 200);
   }

   async function saveQuickConfig() {
     const whiteRatio = document.getElementById('quickWhiteRatio').value;
     const danmuColors = document.getElementById('quickDanmuColors').value.trim();
     const danmuLimit = document.getElementById('quickDanmuLimit').value;
     const danmuFontSize = document.getElementById('quickDanmuFontSize').value;
     const outputFormat = document.getElementById('quickOutputFormat').value;
     const token = document.getElementById('quickToken').value;
     const searchCache = document.getElementById('quickSearchCache').value;
     const commentCache = document.getElementById('quickCommentCache').value;

     // 验证输入
     if (parseInt(whiteRatio) < -1 || parseInt(whiteRatio) > 100) {
       showToast('白色占比必须在 -1 到 100 之间', 'error');
       return;
     }

     if (parseInt(danmuLimit) < -1) {
       showToast('弹幕限制必须大于等于 -1', 'error');
       return;
     }

     if (parseInt(searchCache) < 1 || parseInt(commentCache) < 1) {
       showToast('缓存时间必须大于 0', 'error');
       return;
     }

     // 构建配置对象
     const config = {
       WHITE_RATIO: whiteRatio,
       DANMU_COLORS: danmuColors,
       DANMU_LIMIT: danmuLimit,
       DANMU_FONTSIZE: danmuFontSize,
       DANMU_OUTPUT_FORMAT: outputFormat,
       TOKEN: token,
       SEARCH_CACHE_MINUTES: searchCache,
       COMMENT_CACHE_MINUTES: commentCache
     };

     // 更新本地状态
     AppState.config = { ...AppState.config, ...config };
     
     // 保存到本地存储
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     
     showToast('正在保存配置到服务器...', 'info', 1000);

     // 保存到服务器
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json'
         },
         body: JSON.stringify({ config })
       });

       const result = await response.json();
       
       if (result.success) {
         // 更新显示
         Object.keys(config).forEach(key => {
           updateConfigDisplay(key, config[key]);
         });
         
         // 更新 API 地址显示（如果 TOKEN 改变）
         if (config.TOKEN !== AppState.config.TOKEN) {
           updateApiUrlDisplay();
         }
         
         closeModal('quickConfigModal');
         const savedToText = result.savedTo.join('、');
         showToast('配置已保存到: ' + savedToText, 'success');
         
         // 提示可能需要刷新
         setTimeout(function() {
           showToast('部分配置可能需要刷新页面后生效', 'info', 3000);
         }, 1500);
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       console.error('保存到服务器失败:', error);
       // 即使服务器保存失败，也更新本地显示
       Object.keys(config).forEach(key => {
         updateConfigDisplay(key, config[key]);
       });
       closeModal('quickConfigModal');
       showToast('配置已保存到浏览器本地（服务器保存失败: ' + error.message + ')', 'warning');
     }
   }

 </script>

</body>
</html>
   `;

   return new Response(html, {
     headers: {
       'Content-Type': 'text/html; charset=utf-8',
       'Cache-Control': 'no-cache'
     }
   });
 }

 // GET /
if (path === "/" && method === "GET") {
  return await handleHomepage(req, deployPlatform);
}

if (path === "/favicon.ico" || path === "/robots.txt" || method === "OPTIONS") {
   return new Response(null, {
       status: 204,
       headers: {
           "Access-Control-Allow-Origin": "*",
           "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
           "Access-Control-Allow-Headers": "Content-Type, Authorization, User-Agent"
       }
   });
 }

  // ========== 配置管理 API（在路径规范化之前处理）==========

  // POST /api/config/save - 保存环境变量配置（合并持久化 + 运行时立即生效）
  if (path === "/api/config/save" && method === "POST") {
    try {
      const body = await req.json();
      const { config } = body;

      if (!config || typeof config !== 'object') {
        return jsonResponse({
          success: false,
          errorMessage: "无效的配置数据"
        }, 400);
      }

      log("info", `[config] 开始保存环境变量配置，共 ${Object.keys(config).length} 个: ${Object.keys(config).join(', ')}`);

      // 🔥 过滤和规范化配置值，避免 undefined 导致的错误
      const sanitizedConfig = {};
      for (const [key, value] of Object.entries(config)) {
        // 跳过 null 和 undefined 值
        if (value === null || value === undefined) {
          log("warn", `[config] 跳过空值配置: ${key}`);
          continue;
        }

        // 确保字符串类型
        if (typeof value === 'string') {
          sanitizedConfig[key] = value;
        } else if (typeof value === 'boolean' || typeof value === 'number') {
          sanitizedConfig[key] = String(value);
        } else {
          log("warn", `[config] 跳过无效类型配置: ${key} (${typeof value})`);
        }
      }

      if (Object.keys(sanitizedConfig).length === 0) {
        return jsonResponse({
          success: false,
          errorMessage: "没有有效的配置数据"
        }, 400);
      }

      // 🔥 优先级 1: 保存到数据库
      let dbSaved = false;
      if (globals.databaseValid) {
        try {
          const { saveEnvConfigs } = await import('./utils/db-util.js');
          dbSaved = await saveEnvConfigs(sanitizedConfig);
          log("info", `[config] 数据库保存${dbSaved ? '成功' : '失败'}（优先级最高）`);
        } catch (e) {
          log("warn", `[config] 保存到数据库失败: ${e.message}`);
        }
      }

      // 🔥 优先级 2: 同步到 Redis（如果数据库保存成功）
      let redisSaved = false;
      if (dbSaved && globals.redisValid) {
        try {
          redisSaved = await mergeSaveToRedis('env_configs', sanitizedConfig);
          log("info", `[config] Redis同步${redisSaved ? '成功' : '失败'}（作为备份）`);
        } catch (e) {
          log("warn", `[config] Redis同步失败: ${e.message}`);
        }
      } else if (!dbSaved && globals.redisValid) {
        // 如果数据库保存失败，尝试直接保存到 Redis
        redisSaved = await mergeSaveToRedis('env_configs', sanitizedConfig);
        log("info", `[config] Redis保存${redisSaved ? '成功' : '失败'}`);
      }

      // 3) 🔥 立即应用到当前运行时（关键步骤）
      try {
        // 使用全局 Globals 对象应用配置
        const { Globals } = await import('./configs/globals.js');
        Globals.applyConfig(sanitizedConfig);
        log("info", `[config] 配置已应用到运行时`);
      } catch (e) {
        log("error", `[config] 应用配置到运行时失败: ${e.message}`);
        log("warn", `[config] 忽略运行时应用错误，继续保存流程`);
      }

      // 4) 重建派生缓存（如果 applyConfigPatch 存在的话）
      try {
        await applyConfigPatch(sanitizedConfig);
        log("info", `[config] 派生缓存已重建`);
      } catch (e) {
        log("warn", `[config] 重建派生缓存失败（可忽略）: ${e.message}`);
      }

      const savedTo = [];
      if (dbSaved) {
        savedTo.push('数据库（主存储）');
        if (redisSaved) savedTo.push('Redis（备份）');
      } else if (redisSaved) {
        savedTo.push('Redis');
      }
      savedTo.push('运行时内存');

      log("info", `[config] 配置保存完成: ${savedTo.join('、')}`);
      return jsonResponse({
        success: true,
        message: `配置已保存至 ${savedTo.join('、')}，并立即生效`,
        savedTo,
        appliedConfig: sanitizedConfig
      });

    } catch (error) {
      log("error", `[config] 保存配置失败: ${error.message}\n${error.stack}`);
      return jsonResponse({
        success: false,
        errorMessage: `保存失败: ${error.message}`
      }, 500);
    }
  }

  // GET /api/config/load - 加载环境变量配置
  if (path === "/api/config/load" && method === "GET") {
    try {
      log("info", "[config] 开始加载环境变量配置");

      let config = {};
      let loadedFrom = [];

      // 🔥 优先级 1: 从数据库加载
      if (globals.databaseValid) {
        try {
          const { loadEnvConfigs } = await import('./utils/db-util.js');
          const dbConfig = await loadEnvConfigs();
          if (Object.keys(dbConfig).length > 0) {
            config = { ...config, ...dbConfig };
            loadedFrom.push('数据库（主存储）');
            log("info", "[config] ✅ 从数据库加载配置成功");
          }
        } catch (e) {
          log("warn", `[config] 数据库加载失败: ${e.message}`);
        }
      }

      // 🔥 优先级 2: 如果数据库未加载成功，从 Redis 加载
      if (Object.keys(config).length === 0 && globals.redisValid) {
        try {
          const { getRedisKey } = await import('./utils/redis-util.js');
          const result = await getRedisKey('env_configs');
          if (result && result.result) {
            const redisConfig = JSON.parse(result.result);
            config = { ...config, ...redisConfig };
            loadedFrom.push('Redis');
            log("info", "[config] ✅ 从 Redis 加载配置成功");
          }
        } catch (e) {
          log("warn", `[config] Redis 配置解析失败: ${e.message}`);
        }
      }

      // 🔥 优先级 3: 如果都没有，返回内存中的配置
      if (Object.keys(config).length === 0) {
        config = globals.accessedEnvVars;
        loadedFrom.push('内存（无持久化存储）');
        log("info", "[config] 📝 使用内存默认配置");
      }

      // 🔥 新增：将正则表达式转换为字符串，避免前端显示 [object Object]
      const serializedConfig = {};
      for (const [key, value] of Object.entries(config)) {
        if (value instanceof RegExp) {
          // 转换为可读的正则字符串（仅保留源字符串，不含 / 和标志）
          serializedConfig[key] = value.source;
          log("info", `[config] 正则表达式 ${key} 已转换为字符串: ${value.source.substring(0, 50)}...`);
        } else {
          serializedConfig[key] = value;
        }
      }

      log("info", `[config] 配置加载成功，来源: ${loadedFrom.join('、')}`);
      return jsonResponse({
        success: true,
        config: serializedConfig,  // 🔥 返回序列化后的配置
        loadedFrom
      });

    } catch (error) {
      log("error", `[config] 加载配置失败: ${error.message}`);
      return jsonResponse({
        success: false,
        errorMessage: `加载失败: ${error.message}`
      }, 500);
    }
  }

 // --- 校验 token ---
const parts = path.split("/").filter(Boolean);

// 🔥 强制从 globals 重新获取最新 token（避免缓存）
const currentToken = String(globals.token || globals.envs.TOKEN || globals.accessedEnvVars.TOKEN || "87654321");
log("info", `[Token Check] 当前 TOKEN: ${currentToken.substring(0, 3)}***`);

// 如果 token 是默认值 87654321
if (currentToken === "87654321") {
  const knownApiPaths = ["api", "v1", "v2", "search", "match", "bangumi", "comment"];

  if (parts.length > 0) {
    if (parts[0] === "87654321") {
      path = "/" + parts.slice(1).join("/");
    } else if (!knownApiPaths.includes(parts[0])) {
      log("error", `Invalid token in path: ${path}`);
      return jsonResponse(
        { errorCode: 401, success: false, errorMessage: "Unauthorized" },
        401
      );
    }
  }
} else {
  if (parts.length < 1 || parts[0] !== currentToken) {
    log("error", `Invalid or missing token in path: ${path}, expected: ${currentToken.substring(0, 3)}***, got: ${parts[0]?.substring(0, 3)}***`);
    return jsonResponse(
      { errorCode: 401, success: false, errorMessage: "Unauthorized" },
      401
    );
  }
  path = "/" + parts.slice(1).join("/");
}


  log("info", path);
  // ========== 路径规范化开始 ==========


  // 智能处理API路径前缀
  // 定义不需要添加 /api/v2 前缀的路径
  const excludedPaths = [
    '/',
    '/api/logs',
    '/api/config/save',
    '/api/config/load',
    '/favicon.ico',
    '/robots.txt'
  ];

  const shouldNormalizePath = !excludedPaths.some(excluded => path === excluded || path.startsWith(excluded));

  if (shouldNormalizePath) {
    log("info", `[Path Check] Starting path normalization for: "${path}"`);
    const pathBeforeCleanup = path;

    while (path.startsWith('/api/v2/api/v2/')) {
      log("info", `[Path Check] Found redundant /api/v2 prefix. Cleaning...`);
      path = path.substring('/api/v2'.length);
    }

    if (path !== pathBeforeCleanup) {
      log("info", `[Path Check] Path after cleanup: "${path}"`);
    } else {
      log("info", `[Path Check] Path after cleanup: No cleanup needed.`);
    }

    const pathBeforePrefixCheck = path;
    if (!path.startsWith('/api/v2')) {
      log("info", `[Path Check] Path is missing /api/v2 prefix. Adding...`);
      path = '/api/v2' + path;
    }

    if (path === pathBeforePrefixCheck) {
      log("info", `[Path Check] Prefix Check: No prefix addition needed.`);
    }

    log("info", `[Path Check] Final normalized path: "${path}"`);
  } else {
    log("info", `[Path Check] Path "${path}" is excluded from normalization`);
  }

// GET / - 首页（需要登录）
if (path === "/" && method === "GET") {
  return await handleHomepage(req, deployPlatform);
}

// POST /api/login - 登录
if (path === "/api/login" && method === "POST") {
  try {
    const body = await req.json();
    const { username, password } = body;

    // 从 Redis/数据库加载账号密码
    let storedUsername = 'admin';
    let storedPassword = 'admin';

    try {
      if (globals.redisValid) {
        const { getRedisKey } = await import('./utils/redis-util.js');
        const userResult = await getRedisKey('admin:username');
        const passResult = await getRedisKey('admin:password');
        if (userResult?.result) storedUsername = userResult.result;
        if (passResult?.result) storedPassword = passResult.result;
      } else if (globals.databaseValid) {
        const { loadEnvConfigs } = await import('./utils/db-util.js');
        const configs = await loadEnvConfigs();
        if (configs.ADMIN_USERNAME) storedUsername = configs.ADMIN_USERNAME;
        if (configs.ADMIN_PASSWORD) storedPassword = configs.ADMIN_PASSWORD;
      }
    } catch (e) {
      log("warn", "[login] 加载账号密码失败,使用默认值");
    }

    if (username === storedUsername && password === storedPassword) {
      const sessionId = generateSessionId();
      
      // 保存会话到 Redis
      const saved = await saveSession(sessionId, username);
      
      if (!saved) {
        return jsonResponse({ 
          success: false, 
          message: '登录失败：未配置持久化存储（需要 Redis 或数据库）' 
        }, 500);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${sessionId}; Path=/; Max-Age=${Math.floor(SESSION_TIMEOUT / 1000)}; HttpOnly; SameSite=Strict${req.url.startsWith('https') ? '; Secure' : ''}`
        }
      });
    }

    return jsonResponse({ success: false, message: '用户名或密码错误' }, 401);
  } catch (error) {
    log("error", `[login] 登录失败: ${error.message}`);
    return jsonResponse({ success: false, message: '登录失败' }, 500);
  }
}

// POST /api/logout - 退出登录
if (path === "/api/logout" && method === "POST") {
  const cookies = req.headers.get('cookie') || '';
  const sessionMatch = cookies.match(/session=([^;]+)/);
  if (sessionMatch) {
    await deleteSession(sessionMatch[1]);
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; Path=/; Max-Age=0'
    }
  });
}


  // POST /api/change-password - 修改密码
  if (path === "/api/change-password" && method === "POST") {
    const cookies = req.headers.get('cookie') || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    const sessionId = sessionMatch ? sessionMatch[1] : null;

    if (!validateSession(sessionId)) {
      return jsonResponse({ success: false, message: '未登录' }, 401);
    }

    try {
      const body = await req.json();
      const { oldPassword, newPassword, newUsername } = body;

      // 验证旧密码
      let storedUsername = 'admin';
      let storedPassword = 'admin';

      try {
        if (globals.redisValid) {
          const { getRedisKey } = await import('./utils/redis-util.js');
          const userResult = await getRedisKey('admin:username');
          const passResult = await getRedisKey('admin:password');
          if (userResult?.result) storedUsername = userResult.result;
          if (passResult?.result) storedPassword = passResult.result;
        } else if (globals.databaseValid) {
          const { loadEnvConfigs } = await import('./utils/db-util.js');
          const configs = await loadEnvConfigs();
          if (configs.ADMIN_USERNAME) storedUsername = configs.ADMIN_USERNAME;
          if (configs.ADMIN_PASSWORD) storedPassword = configs.ADMIN_PASSWORD;
        }
      } catch (e) {
        log("warn", "[change-password] 加载账号密码失败");
      }
      if (oldPassword !== storedPassword) {
        return jsonResponse({ success: false, message: '旧密码错误' }, 400);
      }

      // 保存新密码
      const saveSuccess = await saveAdminCredentials(newUsername || storedUsername, newPassword);

      if (saveSuccess) {
        return jsonResponse({ success: true, message: '密码修改成功，请重新登录' });
      } else {
        return jsonResponse({ success: false, message: '密码修改失败' }, 500);
      }
    } catch (error) {
      return jsonResponse({ success: false, message: '修改失败' }, 500);
    }
  }


  // GET /api/v2/search/anime
  if (path === "/api/v2/search/anime" && method === "GET") {
    return searchAnime(url);
  }

  // GET /api/v2/search/episodes
  if (path === "/api/v2/search/episodes" && method === "GET") {
    return searchEpisodes(url);
  }

  // GET /api/v2/match
  if (path === "/api/v2/match" && method === "POST") {
    return matchAnime(url, req);
  }

  // GET /api/v2/bangumi/:animeId
  if (path.startsWith("/api/v2/bangumi/") && method === "GET") {
    return getBangumi(path);
  }

  // GET /api/v2/comment/:commentId or /api/v2/comment?url=xxx
  if (path.startsWith("/api/v2/comment") && method === "GET") {
    const queryFormat = url.searchParams.get('format');
    const videoUrl = url.searchParams.get('url');

    if (videoUrl) {
      const cachedComments = getCommentCache(videoUrl);
      if (cachedComments !== null) {
        log("info", `[Rate Limit] Cache hit for URL: ${videoUrl}, skipping rate limit check`);
        const responseData = { count: cachedComments.length, comments: cachedComments };
        return formatDanmuResponse(responseData, queryFormat);
      }

      if (globals.rateLimitMaxRequests > 0) {
        const currentTime = Date.now();
        const oneMinute = 60 * 1000;

        cleanupExpiredIPs(currentTime);

        if (!globals.requestHistory.has(clientIp)) {
          globals.requestHistory.set(clientIp, []);
        }

        const history = globals.requestHistory.get(clientIp);
        const recentRequests = history.filter(timestamp => currentTime - timestamp <= oneMinute);

        if (recentRequests.length >= globals.rateLimitMaxRequests) {
          log("warn", `[Rate Limit] IP ${clientIp} exceeded rate limit (${recentRequests.length}/${globals.rateLimitMaxRequests} requests in 1 minute)`);
          return jsonResponse(
            { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
            429
          );
        }

        recentRequests.push(currentTime);
        globals.requestHistory.set(clientIp, recentRequests);
        log("info", `[Rate Limit] IP ${clientIp} request count: ${recentRequests.length}/${globals.rateLimitMaxRequests}`);
      }

      return getCommentByUrl(videoUrl, queryFormat);
    }

    if (!path.startsWith("/api/v2/comment/")) {
      log("error", "Missing commentId or url parameter");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing commentId or url parameter" },
        400
      );
    }

    const commentId = parseInt(path.split("/").pop());
    let urlForComment = findUrlById(commentId);

    if (urlForComment) {
      const cachedComments = getCommentCache(urlForComment);
      if (cachedComments !== null) {
        log("info", `[Rate Limit] Cache hit for URL: ${urlForComment}, skipping rate limit check`);
        const responseData = { count: cachedComments.length, comments: cachedComments };
        return formatDanmuResponse(responseData, queryFormat);
      }
    }

    if (globals.rateLimitMaxRequests > 0) {
      const currentTime = Date.now();
      const oneMinute = 60 * 1000;

      cleanupExpiredIPs(currentTime);

      if (!globals.requestHistory.has(clientIp)) {
        globals.requestHistory.set(clientIp, []);
      }

      const history = globals.requestHistory.get(clientIp);
      const recentRequests = history.filter(timestamp => currentTime - timestamp <= oneMinute);

      if (recentRequests.length >= globals.rateLimitMaxRequests) {
        log("warn", `[Rate Limit] IP ${clientIp} exceeded rate limit (${recentRequests.length}/${globals.rateLimitMaxRequests} requests in 1 minute)`);
        return jsonResponse(
          { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
          429
        );
      }

      recentRequests.push(currentTime);
      globals.requestHistory.set(clientIp, recentRequests);
      log("info", `[Rate Limit] IP ${clientIp} request count: ${recentRequests.length}/${globals.rateLimitMaxRequests}`);
    }

    return getComment(path, queryFormat);
  }

  // GET /api/logs
  if (path === "/api/logs" && method === "GET") {
    const format = url.searchParams.get('format') || 'text';
    const level = url.searchParams.get('level'); // 可选：error/warn/info
    const limit = parseInt(url.searchParams.get('limit')) || globals.logBuffer.length;
    const lastId = parseInt(url.searchParams.get('lastId')) || -1;

    let logs = globals.logBuffer;

    // 按级别筛选
    if (level) {
      logs = logs.filter(log => log.level === level);
    }

    // 获取新日志（支持增量更新）
    if (lastId >= 0) {
      const lastIndex = logs.findIndex((log, index) => index > lastId);
      if (lastIndex > 0) {
        logs = logs.slice(lastIndex);
      } else {
        logs = [];
      }
    }

    // 限制数量
    logs = logs.slice(-limit);

    if (format === 'json') {
      return jsonResponse({
        success: true,
        total: globals.logBuffer.length,
        count: logs.length,
        logs: logs,
        maxLogs: globals.MAX_LOGS
      });
    }

    const logText = logs
      .map(
        (log) =>
          `[${log.timestamp}] ${log.level}: ${formatLogMessage(log.message)}`
      )
      .join("\n");
    return new Response(logText, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // GET /api/version/check - 检查版本更新
  if (path === "/api/version/check" && method === "GET") {
    try {
      // 🔥 修改：增加 3000ms (3秒) 超时限制，防止因网络问题阻塞导致网页无法加载
      const response = await fetch(
        'https://raw.githubusercontent.com/huangxd-/danmu_api/refs/heads/main/danmu_api/configs/globals.js',
        { 
          cache: 'no-cache',
          signal: AbortSignal.timeout(3000) 
        }
      );
      
      if (!response.ok) {
        throw new Error('网络请求失败');
      }
      
      const content = await response.text();
      const versionMatch = content.match(/VERSION:\s*['"](\d+\.\d+\.\d+)['"]/);
      
      if (!versionMatch) {
        throw new Error('无法解析版本号');
      }
      
      // 检查是否运行在 Docker 容器中
      const isDocker = process.env.DOCKER_ENV === 'true' || 
                      (typeof process !== 'undefined' && process.env?.DOCKER_ENV === 'true');
      
      return jsonResponse({
        success: true,
        latestVersion: versionMatch[1],
        currentVersion: globals.VERSION,
        isDocker: isDocker,
        canAutoUpdate: isDocker
      });
    } catch (error) {
      // 超时或失败时仅记录日志，不影响主程序运行
      log("warn", `[version] 版本检查跳过: ${error.message}`);
      return jsonResponse({
        success: false,
        error: error.message
      }, 500);
    }
  }


  // POST /api/version/update - 执行 Docker 容器更新
  if (path === "/api/version/update" && method === "POST") {
    try {
      // 验证是否在 Docker 环境中
      const isDocker = process.env.DOCKER_ENV === 'true' || 
                      (typeof process !== 'undefined' && process.env?.DOCKER_ENV === 'true');
      
      if (!isDocker) {
        return new Response(JSON.stringify({
          success: false,
          error: '当前环境不支持自动更新（仅支持 Docker 部署）'
        }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      log("info", "[update] 开始执行 Docker 容器更新...");

      // 🔍 尝试通过 HTTP API 触发 Watchtower 更新
      let watchtowerApiUrl = process.env.WATCHTOWER_HTTP_API_URL || 'http://watchtower:8080';
      let watchtowerToken = process.env.WATCHTOWER_HTTP_API_TOKEN || '';
      
      log("info", `[update] 尝试通过 Watchtower HTTP API 触发更新: ${watchtowerApiUrl}`);

      // 🎯 方案 1: 通过 HTTP API 触发 Watchtower（推荐）
      try {
        const updateUrl = `${watchtowerApiUrl}/v1/update`;
        const headers = {
          'Content-Type': 'application/json'
        };
        
        if (watchtowerToken) {
          headers['Authorization'] = `Bearer ${watchtowerToken}`;
        }
        
        log("info", `[update] 发送 HTTP 请求到 Watchtower: ${updateUrl}`);
        
        const response = await fetch(updateUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            containers: ['danmu-api']
          })
        });
        
        if (response.ok) {
          log("info", "[update] ✅ Watchtower HTTP API 触发成功");
          
          // 🔥 修复：手动构造带 CORS 头的响应，避免依赖外部函数，确保前端能收到成功消息
          return new Response(JSON.stringify({
            success: true,
            message: '✅ 更新已触发，容器将在 30 秒后自动重启',
            method: 'watchtower-http-api',
            updateTriggered: true,
            estimatedTime: 30
          }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': '*'
            }
          });
        } else {
          const errorText = await response.text();
          log("warn", `[update] Watchtower HTTP API 返回错误: ${response.status} - ${errorText}`);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
      } catch (watchtowerError) {
        log("error", `[update] Watchtower HTTP API 失败: ${watchtowerError.message}`);
        // 只有在 Watchtower 确实失败时，才向下执行方案 2
      }

      // 🔧 方案 2: 返回手动更新指令
      log("info", "[update] 自动更新失败，返回手动更新指令");
      
      const manualUpdateCommand = `# 在宿主机执行以下命令更新容器：
docker pull w254992/danmu-api:latest && docker restart danmu-api

# 或者如果使用 docker-compose：
docker-compose pull danmu-api && docker-compose up -d danmu-api`;
      
      return new Response(JSON.stringify({
        success: false,
        error: '⚠️ 自动更新失败：容器内无法执行 Docker 命令',
        method: 'manual',
        suggestion: '请在宿主机手动执行更新命令',
        manualUpdateCommand: manualUpdateCommand,
        watchtowerSetup: `# 如需启用自动更新，请配置 Watchtower HTTP API：
1. 在 docker-compose.yml 中添加环境变量：
   WATCHTOWER_HTTP_API_UPDATE: "true"
   WATCHTOWER_HTTP_API_TOKEN: "your-secret-token"
   
2. 在应用容器中添加环境变量：
   WATCHTOWER_HTTP_API_URL: "http://watchtower:8080"
   WATCHTOWER_HTTP_API_TOKEN: "your-secret-token"
   
3. 重启容器后即可使用一键更新功能`
      }), {
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });

    } catch (error) {
      log("error", `[update] 更新失败: ${error.message}`);
      log("error", `[update] 错误堆栈: ${error.stack}`);
      
      return new Response(JSON.stringify({
        success: false,
        error: `❌ 更新失败: ${error.message}`,
        suggestion: '建议手动执行: docker pull w254992/danmu-api:latest && docker restart danmu-api'
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }


  // GET /api/vod/test - 测试 VOD 服务器连通性
  if (path === "/api/vod/test" && method === "GET") {
    const testUrl = url.searchParams.get('url');
    if (!testUrl) {
      return jsonResponse({ success: false, error: '缺少 URL 参数' }, 400);
    }

    try {
      const startTime = Date.now();
      const response = await fetch(testUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10000)
      });
      const endTime = Date.now();

      if (response.ok) {
        return jsonResponse({
          success: true,
          responseTime: endTime - startTime,
          status: response.status
        });
      } else {
        return jsonResponse({
          success: false,
          error: `HTTP ${response.status}`,
          responseTime: endTime - startTime
        });
      }
    } catch (error) {
      return jsonResponse({
        success: false,
        error: error.message || '连接失败'
      }, 500);
    }
  }

  // GET /api/cache/stats - 获取缓存统计信息
  if (path === "/api/cache/stats" && method === "GET") {
    try {
      let searchCacheCount = 0;
      let commentCacheCount = 0;
      let lastSelectCount = 0;
      let searchCacheSize = 0;
      let commentCacheSize = 0;
      let cacheDetails = [];

      // 🔥 优先从数据库加载最新缓存数据
      if (globals.databaseValid) {
        try {
          const { loadCacheBatch } = await import('./utils/db-util.js');
          const cacheData = await loadCacheBatch();
          
          // 更新内存缓存（确保数据一致性）
          if (cacheData.animes && Object.keys(cacheData.animes).length > 0) {
            globals.animes = cacheData.animes;
          }
          if (cacheData.episodeIds && Object.keys(cacheData.episodeIds).length > 0) {
            globals.episodeIds = cacheData.episodeIds;
          }
          if (cacheData.episodeNum && Object.keys(cacheData.episodeNum).length > 0) {
            globals.episodeNum = cacheData.episodeNum;
          }
          if (cacheData.lastSelectMap) {
            globals.lastSelectMap = new Map(Object.entries(cacheData.lastSelectMap));
          }
          
          log("info", "[cache/stats] ✅ 从数据库重新加载缓存数据");
        } catch (error) {
          log("warn", `[cache/stats] 数据库加载失败，使用内存数据: ${error.message}`);
        }
      }

      // 搜索缓存 - 从 globals.animes 统计
      if (globals.animes && typeof globals.animes === 'object') {
        searchCacheCount = Object.keys(globals.animes).length;
        searchCacheSize = JSON.stringify(globals.animes).length;
        log("info", `[cache/stats] 搜索缓存: ${searchCacheCount} 条`);
      }

      // 弹幕缓存 - 从 globals.episodeIds 和 globals.episodeNum 统计
      if (globals.episodeIds && typeof globals.episodeIds === 'object') {
        const episodeIdsCount = Object.keys(globals.episodeIds).length;
        commentCacheCount += episodeIdsCount;
        commentCacheSize += JSON.stringify(globals.episodeIds).length;
        log("info", `[cache/stats] episodeIds: ${episodeIdsCount} 条`);
      }
      
      if (globals.episodeNum && typeof globals.episodeNum === 'object') {
        const episodeNumCount = Object.keys(globals.episodeNum).length;
        commentCacheCount += episodeNumCount;
        commentCacheSize += JSON.stringify(globals.episodeNum).length;
        log("info", `[cache/stats] episodeNum: ${episodeNumCount} 条`);
      }

      // 最后选择记录
      if (globals.lastSelectMap && globals.lastSelectMap instanceof Map) {
        lastSelectCount = globals.lastSelectMap.size;
        log("info", `[cache/stats] lastSelect: ${lastSelectCount} 条`);
      }

      // 生成缓存详情（示例数据）
      if (searchCacheCount > 0) {
        cacheDetails.push({
          key: '搜索缓存',
          type: '番剧搜索',
          size: searchCacheSize,
          createdAt: Date.now() - 3600000
        });
      }

      if (commentCacheCount > 0) {
        cacheDetails.push({
          key: '弹幕缓存',
          type: '弹幕数据',
          size: commentCacheSize,
          createdAt: Date.now() - 1800000
        });
      }

      return jsonResponse({
        success: true,
        searchCacheCount,
        commentCacheCount,
        lastSelectCount,
        searchCacheSize,
        commentCacheSize,
        cacheDetails
      });

    } catch (error) {
      log("error", `[cache/stats] 获取缓存统计失败: ${error.message}`);
      return jsonResponse({
        success: false,
        error: error.message
      }, 500);
    }
  }

  // POST /api/cache/clear - 清理缓存
  if (path === "/api/cache/clear" && method === "POST") {
    try {
      const body = await req.json();
      const { clearSearch, clearComment, clearLastSelect, clearAll } = body;

      let clearedItems = [];
      // 收集需要清理的 Key 用于持久化层
      const keysToClean = [];
      if (clearAll || clearSearch) keysToClean.push('animes');
      if (clearAll || clearComment) {
        keysToClean.push('episodeIds');
        keysToClean.push('episodeNum');
      }
      if (clearAll || clearLastSelect) keysToClean.push('lastSelectMap');

      // 1. 清理持久化层 (DB/Redis)
      if (globals.databaseValid) {
        try {
          const { clearAllCache, deleteCacheData } = await import('./utils/db-util.js');
          if (clearAll) {
            await clearAllCache();
            clearedItems.push('数据库全量');
          } else if (keysToClean.length > 0) {
            await Promise.all(keysToClean.map(key => deleteCacheData(key)));
          }
        } catch (e) {
          log("warn", `[cache/clear] 数据库清理失败: ${e.message}`);
        }
      }

      if (globals.redisValid) {
        try {
          const { runPipeline, delRedisKey } = await import('./utils/redis-util.js');
          if (clearAll) {
            const allKeys = ['animes', 'episodeIds', 'episodeNum', 'lastSelectMap', 'cache:info'];
            const commands = allKeys.map(k => ['DEL', k]);
            await runPipeline(commands);
            globals.lastHashes = {};
            clearedItems.push('Redis全量');
          } else if (keysToClean.length > 0) {
            await Promise.all(keysToClean.map(key => delRedisKey(key)));
          }
        } catch (e) {
          log("warn", `[cache/clear] Redis 清理失败: ${e.message}`);
        }
      }

      // 2. 清理内存 - 关键：保持引用，清空内容
      // 不要使用 = {} 赋值，这会断开其他模块持有的引用
      const clearObject = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        // 如果是数组，重置长度
        if (Array.isArray(obj)) {
          obj.length = 0;
        } else {
          // 如果是对象，删除所有键
          for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
              delete obj[key];
            }
          }
        }
      };

      if (clearAll || clearSearch) {
        if (globals.caches?.search) globals.caches.search.clear();
        // 这里的关键修复：不要重新赋值 globals.animes = {}
        if (globals.animes) clearObject(globals.animes);
        clearedItems.push('搜索缓存');
      }

      if (clearAll || clearComment) {
        if (globals.caches?.comment) globals.caches.comment.clear();
        // 关键修复：保留引用，清空内容
        if (globals.episodeIds) clearObject(globals.episodeIds);
        if (globals.episodeNum) clearObject(globals.episodeNum);
        // 额外清理可能的 bangumi 缓存
        if (globals.caches?.bangumi && typeof globals.caches.bangumi === 'object') {
             clearObject(globals.caches.bangumi);
        }
        clearedItems.push('弹幕缓存');
      }

      if (clearAll || clearLastSelect) {
        if (globals.lastSelectMap) globals.lastSelectMap.clear();
        clearedItems.push('最后选择记录');
      }

      // 3. 强制重置状态，触发下一次请求的正确初始化
      // 此时因为步骤1已清理了DB，重新校验会得到正确的空状态
      globals.storageChecked = false;

      // 强制垃圾回收（辅助）
      if (global.gc) { try { global.gc(); } catch(e) {} }

      log("info", `[cache/clear] 缓存清理完成 (引用保留模式): ${clearedItems.join('、')}`);

      return jsonResponse({
        success: true,
        message: `已清理: ${clearedItems.join('、')}`,
        clearedItems
      });

    } catch (error) {
      log("error", `[cache/clear] 清理缓存失败: ${error.message}`);
      return jsonResponse({
        success: false,
        error: error.message
      }, 500);
    }
  }



  return jsonResponse({ message: "Not found" }, 404);
}


// ========== 登录页面 HTML ==========
function getLoginPage() {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - 弹幕 API 管理后台</title>
    <script>
    (function() {
      const theme = localStorage.getItem('theme') || 'light';
      document.documentElement.setAttribute('data-theme', theme);
      if (!localStorage.getItem('theme')) {
        document.body.classList.add('light');
      }
    })();
  </script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --primary-500: #6366f1;
      --primary-600: #4f46e5;
      --bg-primary: #0a0a0f;
      --bg-secondary: #13131a;
      --text-primary: #e5e7eb;
      --text-secondary: #9ca3af;
      --border-color: #2d2d3f;
      --error: #ef4444;
      --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.6);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: 
        radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(139, 92, 246, 0.1) 0%, transparent 50%);
      pointer-events: none;
      animation: bgFloat 20s ease-in-out infinite;
    }

    @keyframes bgFloat {
      0%, 100% { transform: translate(0, 0); }
      33% { transform: translate(30px, -30px); }
      66% { transform: translate(-20px, 20px); }
    }

    .login-container {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 420px;
      padding: 20px;
    }

    .login-card {
      background: rgba(28, 28, 39, 0.7);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 48px 40px;
      box-shadow: var(--shadow-xl);
      animation: slideInUp 0.5s ease-out;
    }

    @keyframes slideInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .login-header {
      text-align: center;
      margin-bottom: 40px;
    }

    .logo-icon {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 20px;
      box-shadow: 0 0 30px rgba(99, 102, 241, 0.5);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .login-title {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 8px;
      background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .login-subtitle {
      font-size: 14px;
      color: var(--text-secondary);
    }

    .form-group {
      margin-bottom: 24px;
    }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 10px;
    }

    .form-input {
      width: 100%;
      padding: 14px 16px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      color: var(--text-primary);
      font-size: 14px;
      transition: all 0.3s;
    }

    .form-input:focus {
      outline: none;
      border-color: var(--primary-500);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }

    .btn-primary {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4);
    }

    .btn-primary:active {
      transform: translateY(0);
    }

    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .error-message {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid var(--error);
      color: var(--error);
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
      display: none;
      animation: shake 0.5s;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-10px); }
      75% { transform: translateX(10px); }
    }

    .login-footer {
      text-align: center;
      margin-top: 30px;
      color: var(--text-secondary);
      font-size: 13px;
    }

    .default-hint {
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: var(--primary-500);
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 24px;
      text-align: center;
    }

    @media (max-width: 480px) {
      .login-card {
        padding: 36px 28px;
      }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <div class="logo-icon">🎬</div>
        <h1 class="login-title">弹幕 API</h1>
        <p class="login-subtitle">管理后台登录</p>
      </div>

      <div class="default-hint">
        💡 默认账号密码均为 <strong>admin</strong>
      </div>

      <div id="errorMessage" class="error-message"></div>

      <form id="loginForm">
        <div class="form-group">
          <label class="form-label">用户名</label>
          <input type="text" class="form-input" id="username" placeholder="请输入用户名" required autocomplete="username">
        </div>

        <div class="form-group">
          <label class="form-label">密码</label>
          <input type="password" class="form-input" id="password" placeholder="请输入密码" required autocomplete="current-password">
        </div>

        <button type="submit" class="btn-primary" id="loginBtn">
          登录
        </button>
      </form>

      <div class="login-footer">
        <p>弹幕 API 服务 | 请妥善保管登录凭证</p>
      </div>
    </div>
  </div>

  <script>
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const loginBtn = document.getElementById('loginBtn');

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      errorMessage.style.display = 'none';
      loginBtn.disabled = true;
      loginBtn.textContent = '登录中...';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ username, password })
        });

        const result = await response.json();

        if (result.success) {
          window.location.href = '/';
        } else {
          errorMessage.textContent = result.message || '登录失败，请检查用户名和密码';
          errorMessage.style.display = 'block';
        }
      } catch (error) {
        errorMessage.textContent = '网络错误，请稍后重试';
        errorMessage.style.display = 'block';
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = '登录';
      }
    });

    // 回车登录
    document.getElementById('password').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        loginForm.dispatchEvent(new Event('submit'));
      }
    });
  </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    }
  });
}

// 保存管理员账号密码
async function saveAdminCredentials(username, password) {
  try {
    let saved = false;

    // 保存到 Redis（使用专门的 key）
    if (globals.redisValid) {
      const { setRedisKey } = await import('./utils/redis-util.js');
      const userResult = await setRedisKey('admin:username', username, true);
      const passResult = await setRedisKey('admin:password', password, true);
      saved = userResult?.result === 'OK' && passResult?.result === 'OK';
    }

    // 保存到数据库（使用环境变量配置表）
    if (globals.databaseValid) {
      const { saveEnvConfigs } = await import('./utils/db-util.js');
      const dbSaved = await saveEnvConfigs({
        ADMIN_USERNAME: username,
        ADMIN_PASSWORD: password
      });
      saved = saved || dbSaved;
    }

    return saved;
  } catch (error) {
    log("error", `[save-credentials] 保存失败: ${error.message}`);
    return false;
  }
}


// --- Cloudflare Workers 入口 ---
export default {
  async fetch(request, env, ctx) {
    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    return handleRequest(request, env, "cloudflare", clientIp);
  },
};

// --- Vercel 入口 ---
export async function vercelHandler(req, res) {
  try {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.headers['x-real-ip'] || 
                     req.socket?.remoteAddress || 
                     'unknown';

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['host'] || 'localhost';
    const fullUrl = `${protocol}://${host}${req.url}`;

    let body = undefined;
    if (req.method === "POST" || req.method === "PUT") {
      if (typeof req.body === 'string') {
        body = req.body;
      } else if (req.body && typeof req.body === 'object') {
        body = JSON.stringify(req.body);
      }
    }

    const cfReq = new Request(fullUrl, {
      method: req.method,
      headers: req.headers,
      body: body,
    });

    const response = await handleRequest(cfReq, process.env, "vercel", clientIp);

    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const text = await response.text();
    res.send(text);
  } catch (error) {
    console.error('Vercel handler error:', error);
    res.status(500).json({ 
      errorCode: 500, 
      success: false, 
      errorMessage: "Internal Server Error",
      error: error.message 
    });
  }
}

// --- Netlify 入口 ---
export async function netlifyHandler(event, context) {
  try {
    const clientIp = event.headers['x-nf-client-connection-ip'] ||
                     event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     context.ip ||
                     'unknown';

    const url = event.rawUrl || `https://${event.headers.host}${event.path}`;

    let body = undefined;
    if (event.body) {
      if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString('utf-8');
      } else {
        body = event.body;
      }
    }

    const request = new Request(url, {
      method: event.httpMethod,
      headers: new Headers(event.headers),
      body: body,
    });

    const response = await handleRequest(request, process.env, "netlify", clientIp);

    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      statusCode: response.status,
      headers,
      body: await response.text(),
    };
  } catch (error) {
    console.error('Netlify handler error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        errorCode: 500, 
        success: false, 
        errorMessage: "Internal Server Error",
        error: error.message 
      }),
    };
  }
}

export { handleRequest };