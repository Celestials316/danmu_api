import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";

let globals;

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
    'DANMU_OUTPUT_FORMAT': (value) => {
      globals.danmuOutputFormat = value || 'json';
      globals.DANMU_OUTPUT_FORMAT = value || 'json';
      globals.envs.danmuOutputFormat = value || 'json';
      globals.envs.DANMU_OUTPUT_FORMAT = value || 'json';
      Envs.env.danmuOutputFormat = value || 'json';
      Envs.env.DANMU_OUTPUT_FORMAT = value || 'json';
      return `${value || 'json'}`;
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
  'DANMU_SIMPLIFIED': '是否将繁体弹幕转换为简体中文（主要用于巴哈姆特），默认true',
  'DANMU_LIMIT': '弹幕数量限制，-1表示不限制，其他数字为最大返回条数',
  'BLOCKED_WORDS': '弹幕屏蔽词列表，过滤包含指定关键词的弹幕（多个词用逗号分隔）',
  'GROUP_MINUTE': '弹幕合并去重时间窗口（分钟），相同内容在该时间内只保留一条，默认1',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '是否将顶部/底部弹幕转换为滚动弹幕，默认false',
  'WHITE_RATIO': '白色弹幕占比（0-100），-1表示不转换颜色，其他值表示将指定比例弹幕转为白色',

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
  // 🔥 强制刷新全局配置（解决 TOKEN 缓存问题）
  if (Globals.configLoaded) {
    // 如果已加载过，从数据库/Redis 重新加载最新配置
    await Globals.loadConfigFromStorage();
  } else {
    // 首次加载
    globals = await Globals.init(env, deployPlatform);
  }
  
  globals.deployPlatform = deployPlatform;

  const url = new URL(req.url);
  let path = url.pathname;
  const method = req.method;

  await judgeRedisValid(path);

  log("info", `request url: ${JSON.stringify(url)}`);
  log("info", `request path: ${path}`);
  log("info", `client ip: ${clientIp}`);

  if (globals.redisValid && path !== "/favicon.ico" && path !== "/robots.txt") {
    await getRedisCaches();
  }

  function handleHomepage() {
    log("info", "Accessed homepage");

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
      'bahamut': 'BH'
    };

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
  <title>弹幕 API 管理后台 v${globals.VERSION}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
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
    body.light {
      background: linear-gradient(135deg, #f8fafc 0%, #e0e7ff 100%);
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
     --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
     --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
     --shadow-glow: 0 0 20px rgba(99, 102, 241, 0.2);
   }

   body.light::before {
     background: 
       radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.05) 0%, transparent 50%),
       radial-gradient(circle at 80% 80%, rgba(139, 92, 246, 0.05) 0%, transparent 50%),
       radial-gradient(circle at 40% 20%, rgba(59, 130, 246, 0.05) 0%, transparent 50%);
   }

   /* 侧边栏 - 玻璃态设计 */
   .sidebar {
     position: fixed;
     left: 0;
     top: 0;
     bottom: 0;
     width: 280px;
     background: var(--glass-bg);
     backdrop-filter: blur(20px) saturate(180%);
     -webkit-backdrop-filter: blur(20px) saturate(180%);
     border-right: 1px solid var(--glass-border);
     padding: 24px 0;
     overflow-y: auto;
     transition: all 0.3s var(--ease-smooth);
     z-index: 1000;
     box-shadow: var(--shadow-xl);
   }

   .sidebar-logo {
     padding: 0 24px 24px;
     border-bottom: 1px solid var(--border-color);
     margin-bottom: 24px;
   }

   .logo-content {
     display: flex;
     align-items: center;
     gap: 12px;
     animation: slideInLeft 0.5s var(--ease-smooth);
   }

   @keyframes slideInLeft {
     from {
       opacity: 0;
       transform: translateX(-20px);
     }
     to {
       opacity: 1;
       transform: translateX(0);
     }
   }

   .logo-icon {
     width: 48px;
     height: 48px;
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     border-radius: 12px;
     display: flex;
     align-items: center;
     justify-content: center;
     font-size: 24px;
     font-weight: bold;
     color: white;
     box-shadow: var(--shadow-glow);
     animation: pulse 2s ease-in-out infinite;
   }

   @keyframes pulse {
     0%, 100% {
       transform: scale(1);
       box-shadow: var(--shadow-glow);
     }
     50% {
       transform: scale(1.05);
       box-shadow: 0 0 30px rgba(99, 102, 241, 0.5);
     }
   }

   .logo-text h1 {
     font-size: 20px;
     font-weight: 700;
     color: var(--text-primary);
     margin-bottom: 2px;
     background: linear-gradient(135deg, var(--primary-400), var(--primary-600));
     -webkit-background-clip: text;
     -webkit-text-fill-color: transparent;
     background-clip: text;
   }

   .logo-text p {
     font-size: 12px;
     color: var(--text-tertiary);
     font-weight: 500;
   }

   .nav-menu {
     padding: 0 12px;
   }

   .nav-item {
     display: flex;
     align-items: center;
     gap: 12px;
     padding: 14px 16px;
     margin-bottom: 6px;
     border-radius: 10px;
     color: var(--text-secondary);
     cursor: pointer;
     transition: all 0.3s var(--ease-smooth);
     font-size: 14px;
     font-weight: 500;
     position: relative;
     overflow: hidden;
   }

   .nav-item::before {
     content: '';
     position: absolute;
     left: 0;
     top: 0;
     width: 4px;
     height: 100%;
     background: var(--primary-500);
     transform: scaleY(0);
     transition: transform 0.3s var(--ease-smooth);
   }

   .nav-item:hover {
     background: var(--bg-hover);
     color: var(--text-primary);
     transform: translateX(4px);
   }

   .nav-item.active {
     background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
     color: white;
     box-shadow: var(--shadow-glow);
   }

   .nav-item.active::before {
     transform: scaleY(1);
   }

   .nav-item svg {
     width: 20px;
     height: 20px;
     stroke-width: 2;
     transition: transform 0.3s var(--ease-smooth);
   }

   .nav-item:hover svg {
     transform: scale(1.1);
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

   body.light .stat-icon.primary {
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
       flex-direction: column-reverse;
       gap: 8px;
     }

     .modal-footer .btn {
       width: 100%;
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
     
     <div class="nav-item" onclick="switchPage('vod')">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
         <path d="M5 3l14 9-14 9V3z" stroke-width="2"/>
       </svg>
       <span>VOD 采集站</span>
     </div>
     
     <div class="nav-item" onclick="switchPage('sources')">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
         <path d="M4 7h16M4 12h16M4 17h16" stroke-width="2" stroke-linecap="round"/>
       </svg>
       <span>数据源</span>
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
           <div class="stat-footer">
             ${sensitiveEnvCount > 0 ? `🔒 隐私变量: ${sensitiveEnvCount} 个` : '已配置 / 总数'}
           </div>
         </div>
         
         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">VOD 采集站</span>
             <div class="stat-icon success">🎬</div>
           </div>
           <div class="stat-value">${globals.vodServers.length}</div>
           <div class="stat-footer">
             ${globals.vodReturnMode === 'all' ? '📊 返回所有结果' : '⚡ 仅返回最快'}
           </div>
         </div>
         
         <div class="stat-card">
           <div class="stat-header">
             <span class="stat-title">数据源</span>
             <div class="stat-icon info">🔗</div>
           </div>
           <div class="stat-value">${globals.sourceOrderArr.length > 0 ? globals.sourceOrderArr.length : '默认'}</div>
           <div class="stat-footer">
             ${globals.sourceOrderArr.length > 0 ? `🔝 优先: ${globals.sourceOrderArr[0]}` : '📋 使用默认顺序'}
           </div>
         </div>
         
            <div class="stat-card">
              <div class="stat-header">
                <span class="stat-title">持久化存储</span>
                <div class="stat-icon warning">💾</div>
              </div>
              <div class="stat-value">${
                globals.databaseValid ? '数据库' : 
                (redisConfigured && globals.redisValid) ? 'Redis' : 
                '内存模式'
              }</div>
              <div class="stat-footer">
                ${
                  globals.databaseValid ? '✅ 数据库存储' : 
                  (redisConfigured && globals.redisValid) ? '✅ Redis存储' : 
                  '📝 仅内存缓存'
                }
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
           <span class="badge badge-success">
           <span class="status-dot"></span>运行正常
           </span>
         </div>
         <div class="config-grid">
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
               <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" stroke-width="2"/>
             </svg>
             使用统计
           </h3>
         </div>
         <div class="chart-container">
           <canvas id="usageChart"></canvas>
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
           <div class="source-item" onclick="switchPage('vod')" style="cursor: pointer;">
             <div class="source-icon">🎬</div>
             <div class="source-name">采集站管理</div>
           </div>
           <div class="source-item" onclick="switchPage('sources')" style="cursor: pointer;">
             <div class="source-icon">🔗</div>
             <div class="source-name">数据源配置</div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>弹幕 API 服务 v${globals.VERSION} | Made with ❤️ for Better Anime Experience</p>
         <p style="margin-top: 8px; font-size: 12px;">
           快捷键: <span class="keyboard-shortcut">Ctrl+1-4</span> 切换页面 | 
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

     <!-- VOD 采集站页面 -->
     <section id="vod-page" class="page-section">
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M5 3l14 9-14 9V3z" stroke-width="2"/>
             </svg>
             VOD 采集服务器列表
           </h3>
           <div class="card-actions">
             <button class="btn btn-success" onclick="addVodServer()">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M12 4v16m8-8H4" stroke-width="2" stroke-linecap="round"/>
               </svg>
               添加服务器
             </button>
           </div>
         </div>
         <div class="server-grid" id="vodServerGrid">
           ${vodServersHtml}
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" stroke-width="2"/>
             </svg>
             VOD 配置参数
           </h3>
         </div>
         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">返回模式</span>
               <label class="switch">
                 <input type="checkbox" ${globals.vodReturnMode === 'all' ? 'checked' : ''} onchange="toggleVodReturnMode(this)">
                 <span class="switch-slider"></span>
               </label>
             </div>
             <div class="config-value">
               <code>${globals.vodReturnMode === 'all' ? '返回所有站点结果' : '仅返回最快响应站点'}</code>
             </div>
           </div>
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">请求超时</span>
               <button class="icon-btn edit-btn" onclick="editVodTimeout()" title="编辑">
                 <svg viewBox="0 0 24 24" width="16" height="16">
                   <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" fill="none"/>
                   <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" fill="none"/>
                 </svg>
               </button>
             </div>
             <div class="config-value">
               <code>${globals.vodRequestTimeout} 毫秒</code>
             </div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>共 ${globals.vodServers.length} 个采集站 | 支持并发查询</p>
         <p style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
           💡 提示: 点击添加按钮新增采集站 | 可以编辑或删除现有服务器
         </p>
       </div>
     </section>

     <!-- 数据源页面 -->
     <section id="sources-page" class="page-section">
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M4 7h16M4 12h16M4 17h16" stroke-width="2" stroke-linecap="round"/>
             </svg>
             数据源优先级
           </h3>
           <div class="card-actions">
             <button class="btn btn-secondary" onclick="resetSourceOrder()">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke-width="2" stroke-linecap="round"/>
               </svg>
               重置顺序
             </button>
             <button class="btn btn-primary" onclick="saveSourceOrder()">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                 <path d="M5 13l4 4L19 7" stroke-width="2" stroke-linecap="round"/>
               </svg>
               保存顺序
             </button>
           </div>
         </div>
         <div class="alert alert-info">
           <svg class="alert-icon" viewBox="0 0 24 24" width="20" height="20">
             <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
             <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
           </svg>
           <span>拖动数据源卡片可以调整优先级顺序，数字越小优先级越高</span>
         </div>
         <div class="source-grid" id="sourceGrid">
           ${sourcesHtml}
         </div>
       </div>

       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
               <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke-width="2"/>
             </svg>
             匹配策略配置
           </h3>
         </div>
         <div class="config-grid">
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">严格匹配模式</span>
               <label class="switch">
                 <input type="checkbox" ${globals.strictTitleMatch ? 'checked' : ''} onchange="toggleStrictMatch(this)">
                 <span class="switch-slider"></span>
               </label>
             </div>
             <div class="config-value ${globals.strictTitleMatch ? 'value-enabled' : 'value-disabled'}">
               <code>${globals.strictTitleMatch ? '已启用 - 减少误匹配' : '已禁用 - 宽松匹配'}</code>
             </div>
           </div>
           <div class="config-item">
             <div class="config-header">
               <span class="config-label">记住手动选择</span>
               <label class="switch">
                 <input type="checkbox" ${globals.rememberLastSelect ? 'checked' : ''} onchange="toggleRememberSelect(this)">
                 <span class="switch-slider"></span>
               </label>
             </div>
             <div class="config-value ${globals.rememberLastSelect ? 'value-enabled' : 'value-disabled'}">
               <code>${globals.rememberLastSelect ? '已启用 - 优化匹配准确度' : '已禁用'}</code>
             </div>
           </div>
         </div>
       </div>

       <div class="footer">
         <p>共 ${globals.sourceOrderArr.length} 个数据源 | 按优先级排序</p>
         <p style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
           💡 提示: 拖拽调整数据源顺序后记得点击保存
         </p>
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

 <!-- 快捷操作按钮 -->
 <button class="fab" onclick="saveAllConfig()" title="保存所有配置 (Ctrl+S)">
   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
     <path d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" stroke-width="2" stroke-linecap="round"/>
   </svg>
 </button>

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
     initializeChart();
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
     console.log('🚀 应用初始化...');
     
     const savedTheme = localStorage.getItem('theme');
     if (savedTheme === 'light') {
       document.body.classList.add('light');
       updateThemeIcon(true);
     }

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
     const body = document.body;
     const isLight = body.classList.toggle('light');
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
       'vod': 'VOD 采集站',
       'sources': '数据源配置'
     };
     document.getElementById('pageTitle').textContent = titles[pageName];
     closeMobileMenu();
     window.scrollTo({ top: 0, behavior: 'smooth' });
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

   function addVodServer() {
     AppState.currentEditingVodIndex = null;
     document.getElementById('vodModalTitle').textContent = '添加VOD服务器';
     document.getElementById('vodServerName').value = '';
     document.getElementById('vodServerUrl').value = '';
     showModal('editVodModal');
   }

   function editVodServer(index) {
     AppState.currentEditingVodIndex = index;
     const server = AppState.vodServers[index];
     
     let serverName = \`服务器 #\${index + 1}\`;
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
       serverUrl = server.url || server.baseUrl || server.address || '';
     }

     document.getElementById('vodModalTitle').textContent = '编辑VOD服务器';
     document.getElementById('vodServerName').value = serverName;
     document.getElementById('vodServerUrl').value = serverUrl;
     showModal('editVodModal');
   }

   function saveVodServer() {
     const name = document.getElementById('vodServerName').value.trim();
     const url = document.getElementById('vodServerUrl').value.trim();

     if (!name) {
       showToast('请输入服务器名称', 'error');
       return;
     }

     if (!url) {
       showToast('请输入服务器地址', 'error');
       return;
     }

     try {
       new URL(url);
     } catch (e) {
       showToast('服务器地址格式不正确', 'error');
       return;
     }

     const serverString = \`\${name}@\${url}\`;

     if (AppState.currentEditingVodIndex === null) {
       AppState.vodServers.push(serverString);
     } else {
       AppState.vodServers[AppState.currentEditingVodIndex] = serverString;
     }

     localStorage.setItem('danmu_api_vod_servers', JSON.stringify(AppState.vodServers));
     AppState.hasUnsavedChanges = true;
     refreshVodServerList();
     closeModal('editVodModal');
     showToast(AppState.currentEditingVodIndex === null ? 'VOD服务器已添加' : 'VOD服务器已更新', 'success');
   }

   function deleteVodServer(index) {
     if (!confirm('确定要删除这个VOD服务器吗？')) {
       return;
     }

     AppState.vodServers.splice(index, 1);
     localStorage.setItem('danmu_api_vod_servers', JSON.stringify(AppState.vodServers));
     AppState.hasUnsavedChanges = true;
     refreshVodServerList();
     showToast('VOD服务器已删除', 'success');
   }

   function refreshVodServerList() {
     const grid = document.getElementById('vodServerGrid');
     if (!grid) return;

     grid.innerHTML = AppState.vodServers.map((server, index) => {
       let serverName = \`服务器 #\${index + 1}\`;
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
       }

       return \`
         <div class="server-item" data-index="\${index}">
           <div class="server-badge">\${index + 1}</div>
           <div class="server-info">
             <div class="server-name">\${serverName}</div>
             <div class="server-url">\${serverUrl}</div>
           </div>
           <div class="server-actions">
             <button class="icon-btn" onclick="editVodServer(\${index})" title="编辑">
               <svg viewBox="0 0 24 24" width="16" height="16">
                 <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" fill="none"/>
                 <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" fill="none"/>
               </svg>
             </button>
             <button class="icon-btn delete-btn" onclick="deleteVodServer(\${index})" title="删除">
               <svg viewBox="0 0 24 24" width="16" height="16">
                 <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" fill="none"/>
               </svg>
             </button>
           </div>
         </div>
       \`;
     }).join('');
   }

   function toggleVodReturnMode(checkbox) {
     const mode = checkbox.checked ? 'all' : 'fastest';
     AppState.config.VOD_RETURN_MODE = mode;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;

     const configValue = checkbox.closest('.config-item').querySelector('.config-value code');
     configValue.textContent = checkbox.checked ? '返回所有站点结果' : '仅返回最快响应站点';
     showToast(\`VOD返回模式已切换为: \${checkbox.checked ? '返回所有' : '仅返回最快'}\`, 'success');
   }

   function editVodTimeout() {
     const currentTimeout = AppState.config.VOD_REQUEST_TIMEOUT || 10000;
     const newTimeout = prompt('请输入VOD请求超时时间(毫秒):', currentTimeout);
     
     if (newTimeout === null) return;
     
     const timeoutValue = parseInt(newTimeout);
     if (isNaN(timeoutValue) || timeoutValue < 1000) {
       showToast('超时时间必须大于等于1000毫秒', 'error');
       return;
     }

     AppState.config.VOD_REQUEST_TIMEOUT = timeoutValue;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;

     const configItems = document.querySelectorAll('#vod-page .config-item');
     configItems.forEach(item => {
       const label = item.querySelector('.config-label');
       if (label && label.textContent === '请求超时') {
         const codeElement = item.querySelector('.config-value code');
         if (codeElement) {
           codeElement.textContent = \`\${timeoutValue} 毫秒\`;
         }
       }
     });

     showToast('VOD请求超时时间已更新', 'success');
   }

   function initializeDragAndDrop() {
     const sourceGrid = document.getElementById('sourceGrid');
     if (!sourceGrid) return;

     const isMobile = window.innerWidth <= 768;

     if (isMobile) {
       setupMobileSourceReorder();
       return;
     }

     let draggedElement = null;
     let draggedIndex = null;

     sourceGrid.addEventListener('dragstart', function(e) {
       if (!e.target.classList.contains('source-item')) return;
       draggedElement = e.target;
       draggedIndex = parseInt(e.target.dataset.index);
       e.target.classList.add('dragging');
       e.dataTransfer.effectAllowed = 'move';
     });

     sourceGrid.addEventListener('dragend', function(e) {
       if (!e.target.classList.contains('source-item')) return;
       e.target.classList.remove('dragging');
     });

     sourceGrid.addEventListener('dragover', function(e) {
       e.preventDefault();
       e.dataTransfer.dropEffect = 'move';
       const afterElement = getDragAfterElement(sourceGrid, e.clientY);
       const dragging = document.querySelector('.dragging');
       if (afterElement == null) {
         sourceGrid.appendChild(dragging);
       } else {
         sourceGrid.insertBefore(dragging, afterElement);
       }
     });

     sourceGrid.addEventListener('drop', function(e) {
       e.preventDefault();
       const items = Array.from(sourceGrid.querySelectorAll('.source-item'));
       const newOrder = items.map(item => item.dataset.source);
       AppState.sourceOrder = newOrder;
       AppState.hasUnsavedChanges = true;
       items.forEach((item, index) => {
         item.dataset.index = index;
         const priority = item.querySelector('.source-priority');
         if (priority) priority.textContent = index + 1;
       });
       showToast('数据源顺序已调整，记得保存', 'info');
     });
   }

   function setupMobileSourceReorder() {
     const sourceGrid = document.getElementById('sourceGrid');
     if (!sourceGrid) return;

     const items = sourceGrid.querySelectorAll('.source-item');
     items.forEach((item, index) => {
       item.removeAttribute('draggable');
       const moveButtons = document.createElement('div');
       moveButtons.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-left:auto;';

       const upBtn = document.createElement('button');
       upBtn.className = 'icon-btn';
       upBtn.style.cssText = 'width:32px;height:32px;padding:0;';
       upBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M18 15l-6-6-6 6" stroke-width="2" stroke-linecap="round"/></svg>';
       upBtn.onclick = (e) => { e.stopPropagation(); moveSourceUp(index); };

       const downBtn = document.createElement('button');
       downBtn.className = 'icon-btn';
       downBtn.style.cssText = 'width:32px;height:32px;padding:0;';
       downBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M6 9l6 6 6-6" stroke-width="2" stroke-linecap="round"/></svg>';
       downBtn.onclick = (e) => { e.stopPropagation(); moveSourceDown(index); };

       if (index === 0) upBtn.disabled = true;
       if (index === items.length - 1) downBtn.disabled = true;

       moveButtons.appendChild(upBtn);
       moveButtons.appendChild(downBtn);
       item.appendChild(moveButtons);
     });
   }

   function moveSourceUp(index) {
     if (index === 0) return;
     const temp = AppState.sourceOrder[index];
     AppState.sourceOrder[index] = AppState.sourceOrder[index - 1];
     AppState.sourceOrder[index - 1] = temp;
     AppState.hasUnsavedChanges = true;
     refreshSourceGrid();
     showToast('已上移，记得保存', 'info');
   }

   function moveSourceDown(index) {
     if (index >= AppState.sourceOrder.length - 1) return;
     const temp = AppState.sourceOrder[index];
     AppState.sourceOrder[index] = AppState.sourceOrder[index + 1];
     AppState.sourceOrder[index + 1] = temp;
     AppState.hasUnsavedChanges = true;
     refreshSourceGrid();
     showToast('已下移，记得保存', 'info');
   }

   function refreshSourceGrid() {
     const sourceGrid = document.getElementById('sourceGrid');
     if (!sourceGrid) return;

     const sourceIcons = { 'dandan': 'D', 'bilibili': 'B', 'iqiyi': 'I', 'youku': 'Y', 'tencent': 'T', 'mgtv': 'M', 'bahamut': 'BH' };

     sourceGrid.innerHTML = AppState.sourceOrder.map((source, index) => {
       const icon = sourceIcons[source.toLowerCase()] || source.charAt(0).toUpperCase();
       return \`
         <div class="source-item" draggable="\${window.innerWidth > 768}" data-index="\${index}" data-source="\${source}">
           \${window.innerWidth > 768 ? '<div class="drag-handle"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 5h2v2H9V5zm0 6h2v2H9v-2zm0 6h2v2H9v-2zm4-12h2v2h-2V5zm0 6h2v2h-2v-2zm0 6h2v2h-2v-2z" fill="currentColor"/></svg></div>' : ''}
           <div class="source-priority">\${index + 1}</div>
           <div class="source-icon">\${icon}</div>
           <div class="source-name">\${source}</div>
         </div>
       \`;
     }).join('');

     initializeDragAndDrop();
   }

   function getDragAfterElement(container, y) {
     const draggableElements = [...container.querySelectorAll('.source-item:not(.dragging)')];
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

   function saveSourceOrder() {
     localStorage.setItem('danmu_api_source_order', JSON.stringify(AppState.sourceOrder));
     AppState.hasUnsavedChanges = false;
     showToast('数据源优先级已保存', 'success');
   }

   function resetSourceOrder() {
     if (!confirm('确定要重置数据源顺序为默认值吗？')) return;
     const defaultOrder = ['dandan', 'bilibili', 'iqiyi', 'youku', 'tencent', 'mgtv', 'bahamut'];
     AppState.sourceOrder = defaultOrder;
     localStorage.setItem('danmu_api_source_order', JSON.stringify(defaultOrder));
     AppState.hasUnsavedChanges = false;
     location.reload();
   }

   function toggleStrictMatch(checkbox) {
     AppState.config.STRICT_TITLE_MATCH = checkbox.checked;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     const configValue = checkbox.closest('.config-item').querySelector('.config-value');
     configValue.classList.toggle('value-enabled', checkbox.checked);
     configValue.classList.toggle('value-disabled', !checkbox.checked);
     configValue.querySelector('code').textContent = checkbox.checked ? '已启用 - 减少误匹配' : '已禁用 - 宽松匹配';
     showToast(\`严格匹配模式已\${checkbox.checked ? '启用' : '禁用'}\`, 'success');
   }

   function toggleRememberSelect(checkbox) {
     AppState.config.REMEMBER_LAST_SELECT = checkbox.checked;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     const configValue = checkbox.closest('.config-item').querySelector('.config-value');
     configValue.classList.toggle('value-enabled', checkbox.checked);
     configValue.classList.toggle('value-disabled', !checkbox.checked);
     configValue.querySelector('code').textContent = checkbox.checked ? '已启用 - 优化匹配准确度' : '已禁用';
     showToast(\`记住手动选择已\${checkbox.checked ? '启用' : '禁用'}\`, 'success');
   }

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

   function initializeChart() {
     const ctx = document.getElementById('usageChart');
     if (!ctx) return;

     const chart = new Chart(ctx, {
       type: 'line',
       data: {
         labels: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
         datasets: [{
           label: 'API 请求量',
           data: [120, 190, 150, 220, 180, 250, 200],
           borderColor: 'rgb(99, 102, 241)',
           backgroundColor: 'rgba(99, 102, 241, 0.1)',
           tension: 0.4,
           fill: true
         }]
       },
       options: {
         responsive: true,
         maintainAspectRatio: false,
         plugins: {
           legend: {
             display: true,
             position: 'top',
             labels: {
               color: getComputedStyle(document.body).getPropertyValue('--text-primary'),
               font: {
                 family: '-apple-system, BlinkMacSystemFont, "Segoe UI"',
                 size: 12
               }
             }
           }
         },
         scales: {
           y: {
             beginAtZero: true,
             grid: {
               color: getComputedStyle(document.body).getPropertyValue('--border-color')
             },
             ticks: {
               color: getComputedStyle(document.body).getPropertyValue('--text-secondary')
             }
           },
           x: {
             grid: {
               color: getComputedStyle(document.body).getPropertyValue('--border-color')
             },
             ticks: {
               color: getComputedStyle(document.body).getPropertyValue('--text-secondary')
             }
           }
         }
       }
     });

     const observer = new MutationObserver(() => {
       chart.options.plugins.legend.labels.color = getComputedStyle(document.body).getPropertyValue('--text-primary');
       chart.options.scales.y.grid.color = getComputedStyle(document.body).getPropertyValue('--border-color');
       chart.options.scales.y.ticks.color = getComputedStyle(document.body).getPropertyValue('--text-secondary');
       chart.options.scales.x.grid.color = getComputedStyle(document.body).getPropertyValue('--border-color');
       chart.options.scales.x.ticks.color = getComputedStyle(document.body).getPropertyValue('--text-secondary');
       chart.update();
     });

     observer.observe(document.body, {
       attributes: true,
       attributeFilter: ['class']
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
     if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '4') {
       e.preventDefault();
       const pages = ['overview', 'config', 'vod', 'sources'];
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
   return handleHomepage();
 }

 if (path === "/favicon.ico" || path === "/robots.txt") {
   return new Response(null, { status: 204 });
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

      // 1) 数据库（如有）
      let dbSaved = false;
      if (globals.databaseValid) {
        try {
          const { saveEnvConfigs } = await import('./utils/db-util.js');
          dbSaved = await saveEnvConfigs(config);
          log("info", `[config] 数据库保存${dbSaved ? '成功' : '失败'}`);
        } catch (e) {
          log("warn", `[config] 保存到数据库失败: ${e.message}`);
        }
      }

      // 2) Redis：合并而非覆盖
      let redisSaved = false;
      if (globals.redisValid) {
        redisSaved = await mergeSaveToRedis('env_configs', config);
        log("info", `[config] Redis保存${redisSaved ? '成功' : '失败'}`);
      }

      // 3) 🔥 立即应用到当前运行时（关键步骤）
      try {
        // 使用全局 Globals 对象应用配置
        const { Globals } = await import('./configs/globals.js');
        Globals.applyConfig(config);
        log("info", `[config] 配置已应用到运行时`);
      } catch (e) {
        log("error", `[config] 应用配置到运行时失败: ${e.message}`);
        throw e;
      }

      // 4) 重建派生缓存（如果 applyConfigPatch 存在的话）
      try {
        await applyConfigPatch(config);
        log("info", `[config] 派生缓存已重建`);
      } catch (e) {
        log("warn", `[config] 重建派生缓存失败（可忽略）: ${e.message}`);
      }

      const savedTo = [];
      if (dbSaved) savedTo.push('数据库');
      if (redisSaved) savedTo.push('Redis');
      savedTo.push('运行时内存'); // 总是会应用到内存

      log("info", `[config] 配置保存完成: ${savedTo.join('、')}`);
      return jsonResponse({
        success: true,
        message: `配置已保存至 ${savedTo.join('、')}，并立即生效`,
        savedTo,
        appliedConfig: config
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

      // 尝试从数据库加载
      if (globals.databaseValid) {
        const { loadEnvConfigs } = await import('./utils/db-util.js');
        const dbConfig = await loadEnvConfigs();
        if (Object.keys(dbConfig).length > 0) {
          config = { ...config, ...dbConfig };
          loadedFrom.push('数据库');
        }
      }

      // 尝试从 Redis 加载
      if (globals.redisValid && Object.keys(config).length === 0) {
        const { getRedisKey } = await import('./utils/redis-util.js');
        const result = await getRedisKey('env_configs');
        if (result && result.result) {
          try {
            const redisConfig = JSON.parse(result.result);
            config = { ...config, ...redisConfig };
            loadedFrom.push('Redis');
          } catch (e) {
            log("warn", "[config] Redis 配置解析失败");
          }
        }
      }

      // 如果都没有，返回当前内存中的配置
      if (Object.keys(config).length === 0) {
        config = globals.accessedEnvVars;
        loadedFrom.push('内存');
      }

      log("info", `[config] 配置加载成功，来源: ${loadedFrom.join('、')}`);
      return jsonResponse({
        success: true,
        config,
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
  const knownApiPaths = ["api", "v1", "v2"];

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

  // GET /
  if (path === "/" && method === "GET") {
    return handleHomepage();
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


  return jsonResponse({ message: "Not found" }, 404);
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