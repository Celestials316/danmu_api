import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";

let globals;

// ========== 登录会话管理 ==========
const sessions = new Map();
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

function generateSessionId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function validateSession(sessionId) {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  
  if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT) {
      sessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

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

async function applyConfigPatch(patch) {
  const deployPlatform = globals.deployPlatform || 'unknown';

  for (const [k, v] of Object.entries(patch)) {
    globals.envs[k] = v;
    if (globals.accessedEnvVars) globals.accessedEnvVars[k] = v;
  }

  const { Envs } = await import('./configs/envs.js');
  Envs.env = globals.envs;

  if ('TOKEN' in patch) {
    globals.token = patch.TOKEN;
  }

  const ENV_VAR_HANDLERS = {
    'BILIBILI_COOKIE': (value) => {
      globals.bilibiliCookie = value || '';
      globals.bilibliCookie = value || '';
      globals.BILIBILI_COOKIE = value || '';
      globals.envs.bilibiliCookie = value || '';
      globals.envs.bilibliCookie = value || '';
      globals.envs.BILIBILI_COOKIE = value || '';
      Envs.env.bilibiliCookie = value || '';
      Envs.env.bilibliCookie = value || '';
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

  for (const [key, value] of Object.entries(patch)) {
    if (ENV_VAR_HANDLERS[key]) {
      const result = ENV_VAR_HANDLERS[key](value);
      if (result !== null) {
        log('info', `[config] ${key} 已立即更新: ${result}`);
      }
    }
  }

  const safeCall = async (fn, label) => {
    try { await fn(); log('info', `[config] 重建派生缓存成功: ${label}`); }
    catch (e) { log('warn', `[config] 重建派生缓存失败: ${label}: ${e.message}`); }
  };

  const need = new Set(Object.keys(patch));

  if (need.has('VOD_SERVERS') || need.has('PROXY_URL') || need.has('VOD_REQUEST_TIMEOUT')) {
    await safeCall(async () => {
      const { Envs } = await import('./configs/envs.js');
      Envs.env = globals.envs;
      if (typeof Envs.resolveVodServers === 'function') {
        globals.vodServers = Envs.resolveVodServers(globals.envs);
      }
    }, 'VOD_SERVERS');
  }

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

const ENV_DESCRIPTIONS = {
  'TOKEN': '自定义API访问令牌,使用默认87654321可以不填写',
  'VERSION': '当前服务版本号（自动生成）',
  'LOG_LEVEL': '日志级别：error/warn/info，默认info',
  'OTHER_SERVER': '兜底第三方弹幕服务器，默认api.danmu.icu',
  'VOD_SERVERS': 'VOD影视采集站列表，格式：名称@URL,名称@URL...',
  'VOD_RETURN_MODE': 'VOD返回模式：all/fastest，默认all',
  'VOD_REQUEST_TIMEOUT': 'VOD请求超时时间（毫秒），默认10000',
  'BILIBILI_COOKIE': 'B站Cookie，用于获取完整弹幕数据',
  'TMDB_API_KEY': 'TMDB API密钥，用于标题转换',
  'SOURCE_ORDER': '数据源优先级排序',
  'PLATFORM_ORDER': '弹幕平台优先级',
  'TITLE_TO_CHINESE': '是否将外语标题转换成中文，默认false',
  'STRICT_TITLE_MATCH': '严格标题匹配模式，默认false',
  'EPISODE_TITLE_FILTER': '剧集标题正则过滤表达式',
  'ENABLE_EPISODE_FILTER': '手动选择接口是否启用集标题过滤，默认false',
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式：json/xml，默认json',
  'DANMU_SIMPLIFIED': '是否将繁体弹幕转换为简体，默认true',
  'DANMU_LIMIT': '弹幕数量限制，-1表示不限制',
  'BLOCKED_WORDS': '弹幕屏蔽词列表（逗号分隔）',
  'GROUP_MINUTE': '弹幕合并去重时间窗口（分钟），默认1',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '是否将顶部/底部弹幕转换为滚动弹幕，默认false',
  'WHITE_RATIO': '白色弹幕占比（0-100），-1表示不转换',
  'YOUKU_CONCURRENCY': '优酷弹幕请求并发数，默认8',
  'SEARCH_CACHE_MINUTES': '搜索结果缓存时间（分钟），默认1',
  'COMMENT_CACHE_MINUTES': '弹幕数据缓存时间（分钟），默认1',
  'REMEMBER_LAST_SELECT': '是否记住用户手动选择，默认true',
  'MAX_LAST_SELECT_MAP': '最后选择映射的缓存大小，默认100',
  'PROXY_URL': '代理/反代地址',
  'RATE_LIMIT_MAX_REQUESTS': '限流配置：同一IP在1分钟内允许的最大请求次数，默认3',
  'UPSTASH_REDIS_REST_URL': 'Upstash Redis服务URL',
  'UPSTASH_REDIS_REST_TOKEN': 'Upstash Redis访问令牌',
  'redisValid': 'Redis连接状态',
  'redisUrl': 'Redis服务器地址',
  'redisToken': 'Redis访问令牌状态',
  'DATABASE_URL': '数据库连接URL',
  'DATABASE_AUTH_TOKEN': '数据库认证令牌'
};

const SENSITIVE_KEYS = [
  'TOKEN',
  'BILIBILI_COOKIE',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'TMDB_API_KEY',
  'PROXY_URL',
  'redisUrl',
  'redisToken',
  'DATABASE_URL',
  'DATABASE_AUTH_TOKEN'
];

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.includes(key) ||
    key.toLowerCase().includes('token') ||
    key.toLowerCase().includes('password') ||
    key.toLowerCase().includes('secret') ||
    key.toLowerCase().includes('key') ||
    key.toLowerCase().includes('cookie') ||
    key.toLowerCase().includes('url');
}

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

  if (globals.accessedEnvVars && actualKey in globals.accessedEnvVars) {
    const value = globals.accessedEnvVars[actualKey];
    if (value !== null && value !== undefined) {
      return typeof value === 'string' ? value : String(value);
    }
  }

  if (typeof process !== 'undefined' && process.env?.[actualKey]) {
    return String(process.env[actualKey]);
  }

  if (actualKey in Globals) {
    const value = Globals[actualKey];
    return typeof value === 'string' ? value : String(value);
  }

  return '';
}

async function handleRequest(req, env, deployPlatform, clientIp) {
  if (!Globals.configLoaded) {
    log("info", "[init] 🚀 首次启动，初始化全局配置...");
    globals = await Globals.init(env, deployPlatform);
    log("info", "[init] ✅ 全局配置初始化完成");
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

function handleHomepage(req) {
  log("info", "Accessed homepage");
  
  const cookies = req.headers.get('cookie') || '';
  const sessionMatch = cookies.match(/session=([^;]+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;
  
  if (!validateSession(sessionId)) {
    return getLoginPage();
  }

  const redisConfigured = !!(globals.redisUrl && globals.redisToken);
  const redisStatusText = redisConfigured 
    ? (globals.redisValid ? '在线' : '离线') 
    : '未配置';

  if (!globals.accessedEnvVars) {
    globals.accessedEnvVars = {};
  }
  if (!globals.vodServers) {
    globals.vodServers = [];
  }
  if (!globals.sourceOrderArr) {
    globals.sourceOrderArr = [];
  }

  const configuredEnvCount = Object.entries(globals.accessedEnvVars).filter(([key, value]) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value.length === 0) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }).length;

  const totalEnvCount = Object.keys(globals.accessedEnvVars).length;

  const envItemsHtml = Object.entries(globals.accessedEnvVars)
    .map(([key, value]) => {
      let displayValue = value;
      const description = ENV_DESCRIPTIONS[key] || '环境变量';
      const isSensitive = isSensitiveKey(key);

      if (typeof value === 'boolean') {
        displayValue = value ? '✅ 已启用' : '❌ 已禁用';
      } else if (value === null || value === undefined || (typeof value === 'string' && value.length === 0)) {
        displayValue = '未配置';
      } else if (isSensitive && typeof value === 'string' && value.length > 0) {
        const realValue = getRealEnvValue(key);
        const maskedValue = '*'.repeat(Math.min(String(realValue).length, 32));
        const safeRealValue = typeof realValue === 'string' ? realValue : JSON.stringify(realValue);
        const encodedRealValue = safeRealValue
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

        return `
          <div class="config-card" data-key="${key}">
            <div class="config-header">
              <div class="config-badge ${isSensitive ? 'sensitive' : 'normal'}">
                ${isSensitive ? '🔒 敏感' : '📝 常规'}
              </div>
              <div class="config-actions">
                <button class="action-btn" onclick="editEnv('${key}')" title="编辑">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
                <button class="action-btn" onclick="deleteEnv('${key}')" title="清空">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            </div>
            <div class="config-title">${key}</div>
            <div class="config-value sensitive" data-real="${encodedRealValue}" data-masked="${maskedValue}" onclick="toggleSensitive(this)">
              <span class="value-text">${maskedValue}</span>
              <span class="toggle-icon">👁️</span>
            </div>
            <div class="config-desc">${description}</div>
          </div>
        `;
      } else if (Array.isArray(value)) {
        displayValue = value.length > 0 ? value.join(', ') : '默认值';
      } else if (typeof value === 'string' && value.length > 80) {
        displayValue = value.substring(0, 80) + '...';
      }

      const realValue = getRealEnvValue(key);
      const encodedOriginal = String(realValue || value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      return `
        <div class="config-card" data-key="${key}">
          <div class="config-header">
            <div class="config-badge normal">📝 常规</div>
            <div class="config-actions">
              <button class="action-btn" onclick="editEnv('${key}')" title="编辑">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
              <button class="action-btn" onclick="copyValue('${key}')" title="复制">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
            </div>
          </div>
          <div class="config-title">${key}</div>
          <div class="config-value" data-original="${encodedOriginal}">
            <span class="value-text">${displayValue}</span>
          </div>
          <div class="config-desc">${description}</div>
        </div>
      `;
    })
    .join('');

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>弹幕 API 管理中心</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    :root {
      --bg-main: #0a0e27;
      --bg-card: rgba(255, 255, 255, 0.03);
      --bg-glass: rgba(255, 255, 255, 0.05);
      --bg-hover: rgba(255, 255, 255, 0.08);
      --text-primary: #ffffff;
      --text-secondary: #a0aec0;
      --text-tertiary: #718096;
      --border-color: rgba(255, 255, 255, 0.1);
      --gradient-primary: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      --gradient-success: linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%);
      --gradient-warning: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
      --gradient-info: linear-gradient(135deg, #30cfd0 0%, #330867 100%);
      --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.1);
      --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.2);
      --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.3);
      --shadow-glow: 0 0 20px rgba(102, 126, 234, 0.3);
    }

    [data-theme="light"] {
      --bg-main: #f7fafc;
      --bg-card: #ffffff;
      --bg-glass: rgba(255, 255, 255, 0.9);
      --bg-hover: #edf2f7;
      --text-primary: #1a202c;
      --text-secondary: #4a5568;
      --text-tertiary: #718096;
      --border-color: #e2e8f0;
      --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.08);
      --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.12);
      --shadow-glow: 0 0 20px rgba(102, 126, 234, 0.2);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-main);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.6;
      overflow-x: hidden;
      transition: all 0.3s ease;
    }

    /* 背景动画 */
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: 
        radial-gradient(circle at 20% 30%, rgba(102, 126, 234, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 80% 70%, rgba(118, 75, 162, 0.1) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .app-container {
      display: flex;
      min-height: 100vh;
      position: relative;
      z-index: 1;
    }

    /* 侧边栏 */
    .sidebar {
      width: 280px;
      background: var(--bg-glass);
      backdrop-filter: blur(20px);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease;
      position: fixed;
      height: 100vh;
      left: 0;
      top: 0;
      z-index: 1000;
    }

    .sidebar-header {
      padding: 32px 24px;
      border-bottom: 1px solid var(--border-color);
    }

    .logo-container {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: var(--gradient-primary);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: var(--shadow-glow);
    }

    .logo-text h1 {
      font-size: 20px;
      font-weight: 700;
      background: var(--gradient-primary);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo-text p {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 2px;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .sidebar-nav {
      flex: 1;
      padding: 24px 0;
      overflow-y: auto;
    }

    .nav-section {
      margin-bottom: 32px;
      padding: 0 16px;
    }

    .nav-section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
      padding: 0 12px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 12px;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s ease;
      cursor: pointer;
      margin-bottom: 4px;
    }

    .nav-item:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
      transform: translateX(4px);
    }

    .nav-item.active {
      background: var(--gradient-primary);
      color: white;
      box-shadow: var(--shadow-glow);
    }

    .nav-icon {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .sidebar-footer {
      padding: 24px;
      border-top: 1px solid var(--border-color);
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      border-radius: 12px;
      background: var(--bg-hover);
    }

    .user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--gradient-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: 600;
      color: white;
    }

    .user-details h4 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 2px;
    }

    .user-details p {
      font-size: 12px;
      color: var(--text-tertiary);
    }

    /* 主内容区 */
    .main-content {
      flex: 1;
      margin-left: 280px;
      padding: 32px;
      transition: margin-left 0.3s ease;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      gap: 24px;
    }

    .page-title {
      flex: 1;
    }

    .page-title h2 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .page-title p {
      font-size: 14px;
      color: var(--text-tertiary);
    }

    .topbar-actions {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .search-box {
      position: relative;
    }

    .search-input {
      width: 300px;
      padding: 12px 16px 12px 44px;
      border: 1px solid var(--border-color);
      border-radius: 12px;
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      color: var(--text-primary);
      font-size: 14px;
      transition: all 0.3s ease;
    }

    .search-input:focus {
      outline: none;
      border-color: rgba(102, 126, 234, 0.5);
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    .search-icon {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-tertiary);
    }

    .icon-btn {
      width: 44px;
      height: 44px;
      border: 1px solid var(--border-color);
      border-radius: 12px;
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    }

    .icon-btn:hover {
      background: var(--bg-hover);
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .icon-btn.active::after {
      content: '';
      position: absolute;
      top: 8px;
      right: 8px;
      width: 8px;
      height: 8px;
      background: #ef4444;
      border-radius: 50%;
      border: 2px solid var(--bg-glass);
    }

    /* 统计卡片 */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      margin-bottom: 32px;
    }

    .stat-card {
      background: var(--bg-glass);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 28px;
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: var(--gradient-primary);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .stat-card:hover {
      transform: translateY(-4px);
      box-shadow: var(--shadow-lg);
    }

    .stat-card:hover::before {
      opacity: 1;
    }

    .stat-card.gradient-success::before {
      background: var(--gradient-success);
    }

    .stat-card.gradient-warning::before {
      background: var(--gradient-warning);
    }

    .stat-card.gradient-info::before {
      background: var(--gradient-info);
    }

    .stat-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 20px;
    }

    .stat-icon {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      background: var(--gradient-primary);
      box-shadow: var(--shadow-glow);
    }

    .stat-card.gradient-success .stat-icon {
      background: var(--gradient-success);
      box-shadow: 0 0 20px rgba(132, 250, 176, 0.3);
    }

    .stat-card.gradient-warning .stat-icon {
      background: var(--gradient-warning);
      box-shadow: 0 0 20px rgba(250, 112, 154, 0.3);
    }

    .stat-card.gradient-info .stat-icon {
      background: var(--gradient-info);
      box-shadow: 0 0 20px rgba(48, 207, 208, 0.3);
    }

    .stat-trend {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.1);
      color: #10b981;
    }

    .stat-trend.down {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .stat-content h3 {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 36px;
      font-weight: 700;
      margin-bottom: 12px;
      background: var(--gradient-primary);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stat-card.gradient-success .stat-value {
      background: var(--gradient-success);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stat-card.gradient-warning .stat-value {
      background: var(--gradient-warning);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stat-card.gradient-info .stat-value {
      background: var(--gradient-info);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stat-footer {
      font-size: 13px;
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* 配置卡片网格 */
    .config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 20px;
      margin-top: 24px;
    }

    .config-card {
      background: var(--bg-glass);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .config-card::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--gradient-primary);
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    }

    .config-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
      border-color: rgba(102, 126, 234, 0.3);
    }

    .config-card:hover::after {
      opacity: 0.03;
    }

    .config-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .config-badge {
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .config-badge.sensitive {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .config-badge.normal {
      background: rgba(59, 130, 246, 0.1);
      color: #3b82f6;
    }

    .config-actions {
      display: flex;
      gap: 8px;
    }

    .action-btn {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 8px;
      background: var(--bg-hover);
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .action-btn:hover {
      background: var(--gradient-primary);
      color: white;
      transform: scale(1.1);
    }

    .config-title {
      font-size: 16px;
      font-weight: 600;
      font-family: 'Courier New', monospace;
      margin-bottom: 12px;
      color: var(--text-primary);
    }

    .config-value {
      padding: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 12px;
      word-break: break-all;
      line-height: 1.6;
      transition: all 0.2s ease;
    }

    .config-value.sensitive {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }

    .config-value.sensitive:hover {
      border-color: rgba(102, 126, 234, 0.3);
      background: var(--bg-hover);
    }

    .config-value.revealed {
      color: #667eea;
      user-select: text;
    }

    .toggle-icon {
      opacity: 0.5;
      transition: opacity 0.2s ease;
    }

    .config-value.sensitive:hover .toggle-icon {
      opacity: 1;
    }

    .config-desc {
      font-size: 12px;
      color: var(--text-tertiary);
      line-height: 1.5;
    }

    /* 按钮样式 */
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.3s ease;
      text-decoration: none;
    }

    .btn-primary {
      background: var(--gradient-primary);
      color: white;
      box-shadow: var(--shadow-glow);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
    }

    .btn-secondary {
      background: var(--bg-glass);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
    }

    /* 模态框 */
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
      align-items: center;
      justify-content: center;
      z-index: 2000;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal.show {
      display: flex;
    }

    .modal-content {
      background: var(--bg-glass);
      backdrop-filter: blur(40px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 40px;
      max-width: 560px;
      width: 90%;
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: var(--shadow-lg);
      animation: slideUp 0.3s ease;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(40px);
      }
      to {
        opacity: 1;
       transform: translateY(0);
     }
   }

   .modal-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 28px;
     padding-bottom: 20px;
     border-bottom: 1px solid var(--border-color);
   }

   .modal-title {
     font-size: 24px;
     font-weight: 700;
     background: var(--gradient-primary);
     -webkit-background-clip: text;
     -webkit-text-fill-color: transparent;
     background-clip: text;
   }

   .close-btn {
     width: 40px;
     height: 40px;
     border: none;
     border-radius: 10px;
     background: var(--bg-hover);
     color: var(--text-secondary);
     font-size: 24px;
     cursor: pointer;
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.2s ease;
   }

   .close-btn:hover {
     background: rgba(239, 68, 68, 0.1);
     color: #ef4444;
     transform: rotate(90deg);
   }

   .form-group {
     margin-bottom: 24px;
   }

   .form-label {
     display: block;
     font-size: 14px;
     font-weight: 600;
     margin-bottom: 10px;
     color: var(--text-primary);
   }

   .form-input,
   .form-textarea {
     width: 100%;
     padding: 14px 18px;
     border: 1px solid var(--border-color);
     border-radius: 12px;
     font-size: 14px;
     font-family: inherit;
     background: var(--bg-card);
     color: var(--text-primary);
     transition: all 0.3s ease;
   }

   .form-textarea {
     min-height: 140px;
     font-family: 'Courier New', monospace;
     resize: vertical;
     line-height: 1.6;
   }

   .form-input:focus,
   .form-textarea:focus {
     outline: none;
     border-color: rgba(102, 126, 234, 0.5);
     box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
     background: var(--bg-glass);
   }

   .form-hint {
     font-size: 12px;
     color: var(--text-tertiary);
     margin-top: 8px;
     line-height: 1.5;
     display: flex;
     align-items: flex-start;
     gap: 8px;
   }

   .form-hint::before {
     content: '💡';
     flex-shrink: 0;
   }

   .modal-footer {
     display: flex;
     gap: 12px;
     justify-content: flex-end;
     margin-top: 32px;
     padding-top: 24px;
     border-top: 1px solid var(--border-color);
   }

   /* Toast 通知 */
   .toast {
     position: fixed;
     bottom: 32px;
     right: 32px;
     background: var(--bg-glass);
     backdrop-filter: blur(40px);
     border: 1px solid var(--border-color);
     border-radius: 16px;
     padding: 20px 24px;
     box-shadow: var(--shadow-lg);
     display: none;
     align-items: center;
     gap: 16px;
     z-index: 3000;
     animation: slideInRight 0.3s ease;
     max-width: 420px;
     min-width: 320px;
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

   .toast.show {
     display: flex;
   }

   .toast.success {
     border-left: 4px solid #10b981;
   }

   .toast.error {
     border-left: 4px solid #ef4444;
   }

   .toast.info {
     border-left: 4px solid #3b82f6;
   }

   .toast-icon {
     font-size: 24px;
     flex-shrink: 0;
   }

   .toast-content {
     flex: 1;
   }

   .toast-title {
     font-size: 14px;
     font-weight: 600;
     margin-bottom: 4px;
     color: var(--text-primary);
   }

   .toast-message {
     font-size: 13px;
     color: var(--text-secondary);
     line-height: 1.5;
   }

   /* 卡片容器 */
   .card {
     background: var(--bg-glass);
     backdrop-filter: blur(20px);
     border: 1px solid var(--border-color);
     border-radius: 20px;
     padding: 32px;
     margin-bottom: 24px;
   }

   .card-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 28px;
   }

   .card-title {
     font-size: 20px;
     font-weight: 700;
     display: flex;
     align-items: center;
     gap: 12px;
   }

   .card-title-icon {
     font-size: 24px;
   }

   /* 工具栏 */
   .toolbar {
     display: flex;
     gap: 12px;
     margin-bottom: 24px;
     flex-wrap: wrap;
   }

   .filter-group {
     display: flex;
     gap: 8px;
     padding: 8px;
     background: var(--bg-card);
     border-radius: 12px;
     border: 1px solid var(--border-color);
   }

   .filter-btn {
     padding: 8px 16px;
     border: none;
     border-radius: 8px;
     background: transparent;
     color: var(--text-secondary);
     font-size: 13px;
     font-weight: 500;
     cursor: pointer;
     transition: all 0.2s ease;
   }

   .filter-btn:hover {
     background: var(--bg-hover);
     color: var(--text-primary);
   }

   .filter-btn.active {
     background: var(--gradient-primary);
     color: white;
   }

   /* 空状态 */
   .empty-state {
     text-align: center;
     padding: 60px 24px;
   }

   .empty-icon {
     font-size: 64px;
     margin-bottom: 20px;
     opacity: 0.5;
   }

   .empty-title {
     font-size: 18px;
     font-weight: 600;
     margin-bottom: 8px;
     color: var(--text-primary);
   }

   .empty-desc {
     font-size: 14px;
     color: var(--text-tertiary);
     margin-bottom: 24px;
   }

   /* 加载动画 */
   .loading-spinner {
     width: 40px;
     height: 40px;
     border: 4px solid var(--border-color);
     border-top-color: #667eea;
     border-radius: 50%;
     animation: spin 0.8s linear infinite;
     margin: 40px auto;
   }

   @keyframes spin {
     to { transform: rotate(360deg); }
   }

   /* 响应式设计 */
   @media (max-width: 1024px) {
     .sidebar {
       transform: translateX(-100%);
     }

     .sidebar.open {
       transform: translateX(0);
     }

     .main-content {
       margin-left: 0;
     }

     .config-grid {
       grid-template-columns: 1fr;
     }

     .stats-grid {
       grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
     }
   }

   @media (max-width: 768px) {
     .main-content {
       padding: 20px 16px;
     }

     .topbar {
       flex-direction: column;
       align-items: flex-start;
     }

     .search-input {
       width: 100%;
     }

     .topbar-actions {
       width: 100%;
       justify-content: space-between;
     }

     .modal-content {
       padding: 28px 24px;
     }

     .toast {
       bottom: 20px;
       right: 20px;
       left: 20px;
       max-width: none;
     }
   }

   /* 滚动条样式 */
   ::-webkit-scrollbar {
     width: 8px;
     height: 8px;
   }

   ::-webkit-scrollbar-track {
     background: var(--bg-card);
     border-radius: 4px;
   }

   ::-webkit-scrollbar-thumb {
     background: var(--border-color);
     border-radius: 4px;
     transition: background 0.2s ease;
   }

   ::-webkit-scrollbar-thumb:hover {
     background: var(--text-tertiary);
   }

   /* 移动端侧边栏遮罩 */
   .sidebar-overlay {
     display: none;
     position: fixed;
     top: 0;
     left: 0;
     right: 0;
     bottom: 0;
     background: rgba(0, 0, 0, 0.5);
     backdrop-filter: blur(4px);
     z-index: 999;
   }

   .sidebar-overlay.show {
     display: block;
   }

   /* 菜单按钮（移动端） */
   .menu-toggle {
     display: none;
   }

   @media (max-width: 1024px) {
     .menu-toggle {
       display: flex;
     }
   }

   /* 快捷键提示 */
   .keyboard-hint {
     display: inline-flex;
     align-items: center;
     gap: 4px;
     padding: 4px 8px;
     background: var(--bg-card);
     border: 1px solid var(--border-color);
     border-radius: 6px;
     font-size: 11px;
     font-family: 'Courier New', monospace;
     color: var(--text-tertiary);
   }

   /* 徽章 */
   .badge {
     display: inline-flex;
     align-items: center;
     padding: 4px 10px;
     border-radius: 12px;
     font-size: 11px;
     font-weight: 600;
     letter-spacing: 0.5px;
   }

   .badge-success {
     background: rgba(16, 185, 129, 0.1);
     color: #10b981;
   }

   .badge-warning {
     background: rgba(245, 158, 11, 0.1);
     color: #f59e0b;
   }

   .badge-error {
     background: rgba(239, 68, 68, 0.1);
     color: #ef4444;
   }

   .badge-info {
     background: rgba(59, 130, 246, 0.1);
     color: #3b82f6;
   }

   /* 进度条 */
   .progress-bar {
     width: 100%;
     height: 6px;
     background: var(--bg-card);
     border-radius: 3px;
     overflow: hidden;
     position: relative;
   }

   .progress-fill {
     height: 100%;
     background: var(--gradient-primary);
     border-radius: 3px;
     transition: width 0.3s ease;
   }

   /* 动画效果 */
   @keyframes pulse {
     0%, 100% { opacity: 1; }
     50% { opacity: 0.5; }
   }

   .pulse {
     animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
   }

   @keyframes bounce {
     0%, 100% { transform: translateY(0); }
     50% { transform: translateY(-10px); }
   }

   .bounce {
     animation: bounce 1s infinite;
   }
 </style>
</head>
<body>
 <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>

 <div class="app-container">
   <!-- 侧边栏 -->
   <aside class="sidebar" id="sidebar">
     <div class="sidebar-header">
       <div class="logo-container">
         <div class="logo-icon">🎬</div>
         <div class="logo-text">
           <h1>弹幕 API</h1>
           <p>Management</p>
         </div>
       </div>
     </div>

     <nav class="sidebar-nav">
       <div class="nav-section">
         <div class="nav-section-title">主要功能</div>
         <a class="nav-item active" href="#dashboard" onclick="showSection('dashboard')">
           <div class="nav-icon">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <rect x="3" y="3" width="7" height="7"></rect>
               <rect x="14" y="3" width="7" height="7"></rect>
               <rect x="14" y="14" width="7" height="7"></rect>
               <rect x="3" y="14" width="7" height="7"></rect>
             </svg>
           </div>
           <span>控制台</span>
         </a>
         <a class="nav-item" href="#config" onclick="showSection('config')">
           <div class="nav-icon">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <circle cx="12" cy="12" r="3"></circle>
               <path d="M12 1v6m0 6v6m5.66-13.66l-4.24 4.24m0 6.84l4.24 4.24M23 12h-6m-6 0H1m18.66 5.66l-4.24-4.24m0-6.84l4.24-4.24"></path>
             </svg>
           </div>
           <span>环境配置</span>
         </a>
         <a class="nav-item" href="#logs" onclick="showSection('logs')">
           <div class="nav-icon">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
               <polyline points="14 2 14 8 20 8"></polyline>
               <line x1="16" y1="13" x2="8" y2="13"></line>
               <line x1="16" y1="17" x2="8" y2="17"></line>
               <polyline points="10 9 9 9 8 9"></polyline>
             </svg>
           </div>
           <span>系统日志</span>
         </a>
       </div>

       <div class="nav-section">
         <div class="nav-section-title">系统设置</div>
         <a class="nav-item" href="#api-docs" onclick="showSection('api-docs')">
           <div class="nav-icon">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
               <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
             </svg>
           </div>
           <span>API 文档</span>
         </a>
         <a class="nav-item" href="#" onclick="changePassword()">
           <div class="nav-icon">
             <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
               <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
             </svg>
           </div>
           <span>修改密码</span>
         </a>
       </div>
     </nav>

     <div class="sidebar-footer">
       <div class="user-info">
         <div class="user-avatar">A</div>
         <div class="user-details">
           <h4>管理员</h4>
           <p>超级管理员</p>
         </div>
       </div>
     </div>
   </aside>

   <!-- 主内容区 -->
   <main class="main-content">
     <!-- 顶部栏 -->
     <div class="topbar">
       <div class="page-title">
         <h2>控制台</h2>
         <p>系统概览与实时监控</p>
       </div>
       <div class="topbar-actions">
         <button class="icon-btn menu-toggle" onclick="toggleSidebar()" title="菜单">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <line x1="3" y1="12" x2="21" y2="12"></line>
             <line x1="3" y1="6" x2="21" y2="6"></line>
             <line x1="3" y1="18" x2="21" y2="18"></line>
           </svg>
         </button>
         <div class="search-box">
           <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <circle cx="11" cy="11" r="8"></circle>
             <path d="m21 21-4.35-4.35"></path>
           </svg>
           <input type="text" class="search-input" id="globalSearch" placeholder="搜索配置项..." oninput="filterConfigs()">
         </div>
         <button class="icon-btn" onclick="toggleTheme()" title="切换主题">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <circle cx="12" cy="12" r="5"></circle>
             <line x1="12" y1="1" x2="12" y2="3"></line>
             <line x1="12" y1="21" x2="12" y2="23"></line>
             <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
             <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
             <line x1="1" y1="12" x2="3" y2="12"></line>
             <line x1="21" y1="12" x2="23" y2="12"></line>
             <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
             <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
           </svg>
         </button>
         <button class="icon-btn" onclick="showNotifications()" title="通知">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
             <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
           </svg>
         </button>
         <button class="btn btn-secondary" onclick="logout()">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
             <polyline points="16 17 21 12 16 7"></polyline>
             <line x1="21" y1="12" x2="9" y2="12"></line>
           </svg>
           退出登录
         </button>
       </div>
     </div>

     <!-- 统计卡片 -->
     <div class="stats-grid">
       <div class="stat-card">
         <div class="stat-header">
           <div class="stat-icon">⚙️</div>
           <div class="stat-trend">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
             </svg>
             ${Math.round((configuredEnvCount / totalEnvCount) * 100)}%
           </div>
         </div>
         <div class="stat-content">
           <h3>环境变量配置</h3>
           <div class="stat-value">${configuredEnvCount}/${totalEnvCount}</div>
           <div class="stat-footer">
             <span class="badge badge-info">已配置</span>
             <span>${totalEnvCount - configuredEnvCount} 项待配置</span>
           </div>
         </div>
       </div>

       <div class="stat-card gradient-success">
         <div class="stat-header">
           <div class="stat-icon">💾</div>
           <span class="badge ${
             globals.databaseValid ? 'badge-success' : 
             (globals.redisValid ? 'badge-info' : 'badge-warning')
           }">
             ${
               globals.databaseValid ? '数据库' : 
               (globals.redisValid ? 'Redis' : '内存')
             }
           </span>
         </div>
         <div class="stat-content">
           <h3>持久化存储</h3>
           <div class="stat-value">${
             globals.databaseValid ? '数据库' : 
             (globals.redisValid ? 'Redis' : '内存')
           }</div>
           <div class="stat-footer">
             <span class="badge ${
               globals.databaseValid ? 'badge-success' : 
               (globals.redisValid ? 'badge-success' : 'badge-warning')
             }">
               ${
                 globals.databaseValid ? '✅ 在线' : 
                 (globals.redisValid ? '✅ 在线' : '⚠️ 仅内存')
               }
             </span>
           </div>
         </div>
       </div>

       <div class="stat-card gradient-warning">
         <div class="stat-header">
           <div class="stat-icon">🔗</div>
           <div class="stat-trend">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
             </svg>
             活跃
           </div>
         </div>
         <div class="stat-content">
           <h3>弹幕数据源</h3>
           <div class="stat-value">${globals.sourceOrderArr.length || 7}</div>
           <div class="stat-footer">
             <span class="badge badge-warning">优先: ${globals.sourceOrderArr[0] || '默认'}</span>
           </div>
         </div>
       </div>

       <div class="stat-card gradient-info">
         <div class="stat-header">
           <div class="stat-icon">🚀</div>
           <span class="badge badge-success">运行中</span>
         </div>
         <div class="stat-content">
           <h3>服务状态</h3>
           <div class="stat-value">正常</div>
           <div class="stat-footer">
             <span class="badge badge-info">版本 ${globals.VERSION}</span>
           </div>
         </div>
       </div>
     </div>

     <!-- 配置管理卡片 -->
     <div class="card">
       <div class="card-header">
         <div class="card-title">
           <span class="card-title-icon">⚙️</span>
           <span>环境变量配置</span>
         </div>
         <div style="display: flex; gap: 12px;">
           <button class="btn btn-secondary" onclick="refreshConfig()">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <polyline points="23 4 23 10 17 10"></polyline>
               <polyline points="1 20 1 14 7 14"></polyline>
               <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
             </svg>
             刷新
           </button>
           <button class="btn btn-primary" onclick="saveAllConfig()">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
               <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
               <polyline points="17 21 17 13 7 13 7 21"></polyline>
               <polyline points="7 3 7 8 15 8"></polyline>
             </svg>
             保存全部
             <span class="keyboard-hint">Ctrl+S</span>
           </button>
         </div>
       </div>

       <div class="toolbar">
         <div class="filter-group">
           <button class="filter-btn active" onclick="filterByType('all')">全部</button>
           <button class="filter-btn" onclick="filterByType('sensitive')">🔒 敏感</button>
           <button class="filter-btn" onclick="filterByType('configured')">✅ 已配置</button>
           <button class="filter-btn" onclick="filterByType('empty')">⚠️ 未配置</button>
         </div>
       </div>

       <div class="config-grid" id="configGrid">
         ${envItemsHtml}
       </div>

       <div class="empty-state" id="emptyState" style="display: none;">
         <div class="empty-icon">🔍</div>
         <div class="empty-title">未找到配置项</div>
         <div class="empty-desc">尝试调整搜索关键词或筛选条件</div>
       </div>
     </div>
   </main>
 </div>

 <!-- 编辑配置弹窗 -->
 <div class="modal" id="editModal">
   <div class="modal-content">
     <div class="modal-header">
       <h3 class="modal-title">✏️ 编辑环境变量</h3>
       <button class="close-btn" onclick="closeModal()">×</button>
     </div>
     <div class="form-group">
       <label class="form-label">变量名</label>
       <input type="text" class="form-input" id="editKey" readonly style="background: var(--bg-card); cursor: not-allowed;">
     </div>
     <div class="form-group">
       <label class="form-label">配置值</label>
       <textarea class="form-textarea" id="editValue" placeholder="请输入配置值..."></textarea>
       <div class="form-hint" id="editHint"></div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeModal()">取消</button>
       <button class="btn btn-primary" onclick="saveEnvConfig()">
         <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="20 6 9 17 4 12"></polyline>
         </svg>
         保存更改
       </button>
     </div>
   </div>
 </div>

 <!-- 修改密码弹窗 -->
 <div class="modal" id="passwordModal">
   <div class="modal-content">
     <div class="modal-header">
       <h3 class="modal-title">🔑 修改登录凭据</h3>
       <button class="close-btn" onclick="closePasswordModal()">×</button>
     </div>
     <div class="form-group">
       <label class="form-label">新用户名（可选）</label>
       <input type="text" class="form-input" id="newUsername" placeholder="留空则不修改">
       <div class="form-hint">如不需要修改用户名，请留空</div>
     </div>
     <div class="form-group">
       <label class="form-label">当前密码</label>
       <input type="password" class="form-input" id="oldPassword" placeholder="请输入当前密码" required>
     </div>
     <div class="form-group">
       <label class="form-label">新密码</label>
       <input type="password" class="form-input" id="newPassword" placeholder="请输入新密码（至少4位）" required>
       <div class="form-hint">密码长度至少为4位字符</div>
     </div>
     <div class="form-group">
       <label class="form-label">确认新密码</label>
       <input type="password" class="form-input" id="confirmPassword" placeholder="请再次输入新密码" required>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closePasswordModal()">取消</button>
       <button class="btn btn-primary" onclick="submitPasswordChange()">
         <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="20 6 9 17 4 12"></polyline>
         </svg>
         确认修改
       </button>
     </div>
   </div>
 </div>

 <!-- Toast 通知 -->
 <div class="toast" id="toast">
   <span class="toast-icon" id="toastIcon"></span>
   <div class="toast-content">
     <div class="toast-title" id="toastTitle"></div>
     <div class="toast-message" id="toastMessage"></div>
   </div>
 </div>

 <script>
   // ========== 全局状态管理 ==========
   const AppState = {
     currentEditingKey: null,
     config: ${JSON.stringify(globals.accessedEnvVars)},
     revealedSecrets: new Map(),
     currentFilter: 'all',
     theme: localStorage.getItem('theme') || 'dark'
   };

   const ENV_DESCRIPTIONS = ${JSON.stringify(ENV_DESCRIPTIONS)};

   // ========== 主题管理 ==========
   function initTheme() {
     document.documentElement.setAttribute('data-theme', AppState.theme);
   }

   function toggleTheme() {
     AppState.theme = AppState.theme === 'dark' ? 'light' : 'dark';
     document.documentElement.setAttribute('data-theme', AppState.theme);
     localStorage.setItem('theme', AppState.theme);
     showToast('主题切换', AppState.theme === 'dark' ? '已切换到深色模式' : '已切换到浅色模式', 'info');
   }

   // ========== Toast 通知 ==========
   function showToast(title, message, type = 'info') {
     const toast = document.getElementById('toast');
     const icon = document.getElementById('toastIcon');
     const titleEl = document.getElementById('toastTitle');
     const messageEl = document.getElementById('toastMessage');
     
     const icons = {
       success: '✅',
       error: '❌',
       info: 'ℹ️',
       warning: '⚠️'
     };
     
     icon.textContent = icons[type] || icons.info;
     titleEl.textContent = title;
     messageEl.textContent = message;
     toast.className = 'toast show ' + type;
     
     setTimeout(() => {
       toast.classList.remove('show');
     }, 4000);
   }

   // ========== 侧边栏管理 ==========
   function toggleSidebar() {
     const sidebar = document.getElementById('sidebar');
     const overlay = document.getElementById('sidebarOverlay');
     sidebar.classList.toggle('open');
     overlay.classList.toggle('show');
   }

   function closeSidebar() {
     const sidebar = document.getElementById('sidebar');
     const overlay = document.getElementById('sidebarOverlay');
     sidebar.classList.remove('open');
     overlay.classList.remove('show');
   }

   function showSection(section) {
     const navItems = document.querySelectorAll('.nav-item');
     navItems.forEach(item => item.classList.remove('active'));
     event.currentTarget.classList.add('active');
     
     // 这里可以添加切换不同内容区域的逻辑
     showToast('导航', \`切换到 \${section} 页面\`, 'info');
     
     if (window.innerWidth <= 1024) {
       closeSidebar();
     }
   }

   // ========== 敏感信息显示/隐藏 ==========
   function toggleSensitive(element) {
     const real = element.dataset.real;
     const masked = element.dataset.masked;
     const key = element.closest('.config-card').dataset.key;
     
     if (AppState.revealedSecrets.has(key)) {
       clearTimeout(AppState.revealedSecrets.get(key));
       AppState.revealedSecrets.delete(key);
     }
     
     const textarea = document.createElement('textarea');
     textarea.innerHTML = real;
     const realValue = textarea.value;
     
     const valueText = element.querySelector('.value-text');
     const toggleIcon = element.querySelector('.toggle-icon');
     
     if (element.classList.contains('revealed')) {
       valueText.textContent = masked;
       toggleIcon.textContent = '👁️';
       element.classList.remove('revealed');
     } else {
       valueText.textContent = realValue;
       toggleIcon.textContent = '🔓';
       element.classList.add('revealed');
       
       const timeoutId = setTimeout(() => {
         valueText.textContent = masked;
         toggleIcon.textContent = '👁️';
         element.classList.remove('revealed');
         AppState.revealedSecrets.delete(key);
       }, 5000);
       
       AppState.revealedSecrets.set(key, timeoutId);
     }
   }

   // ========== 编辑配置 ==========
   function editEnv(key) {
     AppState.currentEditingKey = key;
     document.getElementById('editKey').value = key;
     document.getElementById('editValue').value = AppState.config[key] || '';
     document.getElementById('editHint').textContent = ENV_DESCRIPTIONS[key] || '';
     document.getElementById('editModal').classList.add('show');
   }

   function closeModal() {
     document.getElementById('editModal').classList.remove('show');
     AppState.currentEditingKey = null;
   }

   async function saveEnvConfig() {
     const key = AppState.currentEditingKey;
     const value = document.getElementById('editValue').value.trim();
     
     if (!key) {
       showToast('错误', '无效的配置项', 'error');
       return;
     }
     
     AppState.config[key] = value;
     
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: { [key]: value } })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('保存成功', \`\${key} 配置已更新\`, 'success');
         updateEnvDisplay(key, value);
         closeModal();
       } else {
         showToast('保存失败', result.errorMessage || '未知错误', 'error');
       }
     } catch (error) {
       showToast('网络错误', error.message, 'error');
     }
   }

   // ========== 删除/清空配置 ==========
   function deleteEnv(key) {
     if (!confirm(\`确定要清空 \${key} 的配置吗？\`)) {
       return;
     }
     
     AppState.config[key] = '';
     
     fetch('/api/config/save', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ config: { [key]: '' } })
     })
     .then(res => res.json())
     .then(result => {
       if (result.success) {
         showToast('清空成功', \`\${key} 已清空\`, 'success');
         updateEnvDisplay(key, '');
       } else {
         showToast('清空失败', result.errorMessage || '未知错误', 'error');
       }
     })
     .catch(error => {
       showToast('网络错误', error.message, 'error');
     });
   }

   // ========== 更新配置显示 ==========
   function updateEnvDisplay(key, value) {
     const card = document.querySelector(\`.config-card[data-key="\${key}"]\`);
     if (!card) return;
     
     const valueEl = card.querySelector('.config-value');
     const valueText = valueEl.querySelector('.value-text');
     
     if (valueEl.classList.contains('sensitive')) {
       const realValue = typeof value === 'string' ? value : String(value);
       const maskedValue = '*'.repeat(Math.min(realValue.length, 32));
       
       const encodedRealValue = realValue
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;')
         .replace(/'/g, '&#39;');
       
       valueEl.dataset.real = encodedRealValue;
       valueEl.dataset.masked = maskedValue;
       valueText.textContent = maskedValue;
       valueEl.classList.remove('revealed');
       return;
     }
     
     if (typeof value === 'boolean') {
       valueText.textContent = value ? '✅ 已启用' : '❌ 已禁用';
     } else if (!value) {
       valueText.textContent = '未配置';
     } else {
       valueText.textContent = value.length > 80 ? value.substring(0, 80) + '...' : value;
     }
   }

   // ========== 复制配置值 ==========
   function copyValue(key) {
     const card = document.querySelector(\`.config-card[data-key="\${key}"]\`);
     if (!card) return;
     
     const valueEl = card.querySelector('.config-value');
     let text = '';
     
     if (valueEl.classList.contains('sensitive')) {
       const textarea = document.createElement('textarea');
       textarea.innerHTML = valueEl.dataset.real;
       text = textarea.value;
     } else {
       text = valueEl.dataset.original || valueEl.querySelector('.value-text').textContent;
     }
     
     if (navigator.clipboard) {
       navigator.clipboard.writeText(text).then(() => {
         showToast('复制成功', \`\${key} 已复制到剪贴板\`, 'success');
       });
     } else {
       const temp = document.createElement('textarea');
       temp.value = text;
       document.body.appendChild(temp);
       temp.select();
       document.execCommand('copy');
       document.body.removeChild(temp);
       showToast('复制成功', \`\${key} 已复制到剪贴板\`, 'success');
     }
   }

   // ========== 保存全部配置 ==========
   async function saveAllConfig() {
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: AppState.config })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('保存成功', '全部配置已保存', 'success');
       } else {
         showToast('保存失败', result.errorMessage || '未知错误', 'error');
       }
     } catch (error) {
       showToast('网络错误', error.message, 'error');
     }
   }

   // ========== 刷新配置 ==========
   async function refreshConfig() {
     try {
       const response = await fetch('/api/config/load');
       const result = await response.json();
       
       if (result.success && result.config) {
         AppState.config = { ...AppState.config, ...result.config };
         for (const [key, value] of Object.entries(result.config)) {
           updateEnvDisplay(key, value);
         }
         showToast('刷新成功', \`配置已从 \${result.loadedFrom.join('、')} 加载\`, 'success');
       }
     } catch (error) {
       showToast('刷新失败', error.message, 'error');
     }
   }

   // ========== 筛选配置 ==========
   function filterByType(type) {
     AppState.currentFilter = type;
     
     const filterBtns = document.querySelectorAll('.filter-btn');
     filterBtns.forEach(btn => btn.classList.remove('active'));
     event.currentTarget.classList.add('active');
     
     const cards = document.querySelectorAll('.config-card');
     const emptyState = document.getElementById('emptyState');
     let visibleCount = 0;
     
     cards.forEach(card => {
       const key = card.dataset.key;
       const value = AppState.config[key];
       const isSensitive = card.querySelector('.config-badge.sensitive') !== null;
       const isConfigured = value && value.length > 0;
       
       let shouldShow = true;
       
       switch(type) {
         case 'sensitive':
           shouldShow = isSensitive;
           break;
         case 'configured':
           shouldShow = isConfigured;
           break;
         case 'empty':
           shouldShow = !isConfigured;
           break;
         case 'all':
         default:
           shouldShow = true;
       }
       
       card.style.display = shouldShow ? '' : 'none';
       if (shouldShow) visibleCount++;
     });
     
     emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
   }

   // ========== 搜索配置 ==========
   function filterConfigs() {
     const query = document.getElementById('globalSearch').value.toLowerCase();
     const cards = document.querySelectorAll('.config-card');
     const emptyState = document.getElementById('emptyState');
     let visibleCount = 0;
     
     cards.forEach(card => {
       const key = card.dataset.key.toLowerCase();
       const title = card.querySelector('.config-title').textContent.toLowerCase();
       const desc = card.querySelector('.config-desc').textContent.toLowerCase();
       const value = card.querySelector('.config-value .value-text').textContent.toLowerCase();
       
       const matches = key.includes(query) || title.includes(query) || 
                      desc.includes(query) || value.includes(query);
       
       // 同时考虑当前的筛选状态
       let typeMatch = true;
       if (AppState.currentFilter !== 'all') {
         const isSensitive = card.querySelector('.config-badge.sensitive') !== null;
         const isConfigured = AppState.config[card.dataset.key] && 
                             AppState.config[card.dataset.key].length > 0;
         
         switch(AppState.currentFilter) {
           case 'sensitive':
             typeMatch = isSensitive;
             break;
           case 'configured':
             typeMatch = isConfigured;
             break;
           case 'empty':
             typeMatch = !isConfigured;
             break;
         }
       }
       
       const shouldShow = matches && typeMatch;
       card.style.display = shouldShow ? '' : 'none';
       if (shouldShow) visibleCount++;
     });
     
     emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
   }

   // ========== 修改密码 ==========
   function changePassword() {
     document.getElementById('passwordModal').classList.add('show');
   }

   function closePasswordModal() {
     document.getElementById('passwordModal').classList.remove('show');
     document.getElementById('newUsername').value = '';
     document.getElementById('oldPassword').value = '';
     document.getElementById('newPassword').value = '';
     document.getElementById('confirmPassword').value = '';
   }

   async function submitPasswordChange() {
     const newUsername = document.getElementById('newUsername').value.trim();
     const oldPassword = document.getElementById('oldPassword').value;
     const newPassword = document.getElementById('newPassword').value;
     const confirmPassword = document.getElementById('confirmPassword').value;
     
     if (!oldPassword) {
       showToast('验证失败', '请输入当前密码', 'error');
       return;
     }
     
     if (!newPassword) {
       showToast('验证失败', '请输入新密码', 'error');
       return;
     }
     
     if (newPassword !== confirmPassword) {
       showToast('验证失败', '两次输入的密码不一致', 'error');
       return;
     }
     
     if (newPassword.length < 4) {
       showToast('验证失败', '密码长度至少为4位', 'error');
       return;
     }
     
     try {
       const response = await fetch('/api/change-password', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           oldPassword,
           newPassword,
           newUsername: newUsername || undefined
         })
       });
       
       const result = await response.json();
       
       if (result.success) {
         showToast('修改成功', '密码已更新，请重新登录', 'success');
         closePasswordModal();
         setTimeout(() => logout(), 2000);
       } else {
         showToast('修改失败', result.message || '修改失败', 'error');
       }
     } catch (error) {
       showToast('网络错误', error.message, 'error');
     }
   }

   // ========== 退出登录 ==========
   async function logout() {
     try {
       await fetch('/api/logout', { method: 'POST' });
       showToast('退出登录', '正在退出...', 'info');
       setTimeout(() => {
         window.location.href = '/';
       }, 1000);
     } catch (error) {
       showToast('退出失败', error.message, 'error');
     }
   }

   // ========== 通知中心 ==========
   function showNotifications() {
     showToast('通知中心', '暂无新通知', 'info');
   }

   // ========== 快捷键支持 ==========
   document.addEventListener('keydown', (e) => {
     // Ctrl+S 保存
     if ((e.ctrlKey || e.metaKey) && e.key === 's') {
       e.preventDefault();
       saveAllConfig();
     }
     
     // Esc 关闭弹窗
     if (e.key === 'Escape') {
       closeModal();
       closePasswordModal();
       closeSidebar();
     }
     
     // Ctrl+K 聚焦搜索框
     if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
       e.preventDefault();
       document.getElementById('globalSearch').focus();
     }
   });

   // ========== 初始化 ==========
   function init() {
     initTheme();
     loadConfig();
     
     // 自动刷新配置（可选）
     setInterval(() => {
       refreshConfig();
     }, 300000); // 每5分钟刷新一次
     
     console.log('%c弹幕 API 管理中心', 'color: #667eea; font-size: 24px; font-weight: bold;');
     console.log('%c系统已就绪 ✨', 'color: #10b981; font-size: 14px;');
   }

// ========== 加载配置 ==========
    async function loadConfig() {
      try {
        const response = await fetch('/api/config/load');
        const result = await response.json();
        
        if (result.success && result.config) {
          AppState.config = { ...AppState.config, ...result.config };
          for (const [key, value] of Object.entries(result.config)) {
            updateEnvDisplay(key, value);
          }
          showToast('配置加载', `已从 ${result.loadedFrom.join('、')} 加载配置`, 'success');
        }
      } catch (error) {
        console.error('加载配置失败:', error);
        showToast('加载失败', '无法加载配置数据', 'error');
      }
    }

    // 页面加载完成后初始化
    window.addEventListener('DOMContentLoaded', init);
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

  if (path === "/" && method === "GET") {
    return handleHomepage(req);
  }

  if (path === "/favicon.ico" || path === "/robots.txt") {
    return new Response(null, { status: 204 });
  }

  // POST /api/config/save
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

      log("info", `[config] 开始保存环境变量配置，共 ${Object.keys(config).length} 个`);

      const sanitizedConfig = {};
      for (const [key, value] of Object.entries(config)) {
        if (value === null || value === undefined) {
          log("warn", `[config] 跳过空值配置: ${key}`);
          continue;
        }

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

      let dbSaved = false;
      if (globals.databaseValid) {
        try {
          const { saveEnvConfigs } = await import('./utils/db-util.js');
          dbSaved = await saveEnvConfigs(sanitizedConfig);
          log("info", `[config] 数据库保存${dbSaved ? '成功' : '失败'}`);
        } catch (e) {
          log("warn", `[config] 保存到数据库失败: ${e.message}`);
        }
      }
      
      let redisSaved = false;
      if (globals.redisValid) {
        redisSaved = await mergeSaveToRedis('env_configs', sanitizedConfig);
        log("info", `[config] Redis保存${redisSaved ? '成功' : '失败'}`);
      }

      try {
        const { Globals } = await import('./configs/globals.js');
        Globals.applyConfig(sanitizedConfig);
        log("info", `[config] 配置已应用到运行时`);
      } catch (e) {
        log("error", `[config] 应用配置到运行时失败: ${e.message}`);
      }

      try {
        await applyConfigPatch(sanitizedConfig);
        log("info", `[config] 派生缓存已重建`);
      } catch (e) {
        log("warn", `[config] 重建派生缓存失败: ${e.message}`);
      }

      const savedTo = [];
      if (dbSaved) savedTo.push('数据库');
      if (redisSaved) savedTo.push('Redis');
      savedTo.push('运行时内存');

      log("info", `[config] 配置保存完成: ${savedTo.join('、')}`);
      return jsonResponse({
        success: true,
        message: `配置已保存至 ${savedTo.join('、')}`,
        savedTo,
        appliedConfig: sanitizedConfig
      });

    } catch (error) {
      log("error", `[config] 保存配置失败: ${error.message}`);
      return jsonResponse({
        success: false,
        errorMessage: `保存失败: ${error.message}`
      }, 500);
    }
  }

  // GET /api/config/load
  if (path === "/api/config/load" && method === "GET") {
    try {
      log("info", "[config] 开始加载环境变量配置");

      let config = {};
      let loadedFrom = [];

      if (globals.databaseValid) {
        const { loadEnvConfigs } = await import('./utils/db-util.js');
        const dbConfig = await loadEnvConfigs();
        if (Object.keys(dbConfig).length > 0) {
          config = { ...config, ...dbConfig };
          loadedFrom.push('数据库');
        }
      }

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

      if (Object.keys(config).length === 0) {
        config = globals.accessedEnvVars;
        loadedFrom.push('内存');
      }

      const serializedConfig = {};
      for (const [key, value] of Object.entries(config)) {
        if (value instanceof RegExp) {
          serializedConfig[key] = value.source;
        } else {
          serializedConfig[key] = value;
        }
      }

      log("info", `[config] 配置加载成功，来源: ${loadedFrom.join('、')}`);
      return jsonResponse({
        success: true,
        config: serializedConfig,
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

  // Token 验证
  const parts = path.split("/").filter(Boolean);
  const currentToken = String(globals.token || globals.envs.TOKEN || globals.accessedEnvVars.TOKEN || "87654321");
  log("info", `[Token Check] 当前 TOKEN: ${currentToken.substring(0, 3)}***`);

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
      log("error", `Invalid or missing token`);
      return jsonResponse(
        { errorCode: 401, success: false, errorMessage: "Unauthorized" },
        401
      );
    }
    path = "/" + parts.slice(1).join("/");
  }

  log("info", path);

  // 路径规范化
  const excludedPaths = [
    '/',
    '/api/logs',
    '/api/config/save',
    '/api/config/load',
    '/api/login',
    '/api/logout',
    '/api/change-password',
    '/favicon.ico',
    '/robots.txt'
  ];

  const shouldNormalizePath = !excludedPaths.some(excluded => path === excluded || path.startsWith(excluded));

  if (shouldNormalizePath) {
    while (path.startsWith('/api/v2/api/v2/')) {
      path = path.substring('/api/v2'.length);
    }

    if (!path.startsWith('/api/v2')) {
      path = '/api/v2' + path;
    }
  }

  // POST /api/login
  if (path === "/api/login" && method === "POST") {
    try {
      const body = await req.json();
      const { username, password } = body;
      
      let storedUsername = 'admin';
      let storedPassword = 'admin';
      
      try {
        if (globals.redisValid) {
          const { getRedisKey } = await import('./utils/redis-util.js');
          const userResult = await getRedisKey('admin_username');
          const passResult = await getRedisKey('admin_password');
          if (userResult?.result) storedUsername = userResult.result;
          if (passResult?.result) storedPassword = passResult.result;
        } else if (globals.databaseValid) {
          const { loadEnvConfigs } = await import('./utils/db-util.js');
          const configs = await loadEnvConfigs();
          if (configs.ADMIN_USERNAME) storedUsername = configs.ADMIN_USERNAME;
          if (configs.ADMIN_PASSWORD) storedPassword = configs.ADMIN_PASSWORD;
        }
      } catch (e) {
        log("warn", "[login] 加载账号密码失败，使用默认值");
      }
      
      if (username === storedUsername && password === storedPassword) {
        const sessionId = generateSessionId();
        sessions.set(sessionId, { 
          username, 
          createdAt: Date.now() 
        });
        
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `session=${sessionId}; Path=/; Max-Age=${SESSION_TIMEOUT / 1000}; HttpOnly; SameSite=Strict`
          }
        });
      }
      
      return jsonResponse({ success: false, message: '用户名或密码错误' }, 401);
    } catch (error) {
      return jsonResponse({ success: false, message: '登录失败' }, 500);
    }
  }

  // POST /api/logout
  if (path === "/api/logout" && method === "POST") {
    const cookies = req.headers.get('cookie') || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    if (sessionMatch) {
      sessions.delete(sessionMatch[1]);
    }
    
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=; Path=/; Max-Age=0'
      }
    });
  }

  // POST /api/change-password
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
      
      let storedUsername = 'admin';
      let storedPassword = 'admin';
      
      try {
        if (globals.redisValid) {
          const { getRedisKey } = await import('./utils/redis-util.js');
          const userResult = await getRedisKey('admin_username');
          const passResult = await getRedisKey('admin_password');
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
      
      const saveSuccess = await saveAdminCredentials(newUsername || storedUsername, newPassword);
      
      if (saveSuccess) {
        return jsonResponse({ success: true, message: '密码修改成功' });
      } else {
        return jsonResponse({ success: false, message: '密码修改失败' }, 500);
      }
    } catch (error) {
      return jsonResponse({ success: false, message: '修改失败' }, 500);
    }
  }

  // 弹幕 API 路由（保持完整）
  if (path === "/api/v2/search/anime" && method === "GET") {
    return searchAnime(url);
  }

  if (path === "/api/v2/search/episodes" && method === "GET") {
    return searchEpisodes(url);
  }

  if (path === "/api/v2/match" && method === "POST") {
    return matchAnime(url, req);
  }
  
  if (path.startsWith("/api/v2/bangumi/") && method === "GET") {
    return getBangumi(path);
  }

  if (path.startsWith("/api/v2/comment") && method === "GET") {
    const queryFormat = url.searchParams.get('format');
    const videoUrl = url.searchParams.get('url');

    if (videoUrl) {
      const cachedComments = getCommentCache(videoUrl);
      if (cachedComments !== null) {
        log("info", `[Rate Limit] Cache hit for URL: ${videoUrl}`);
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
          log("warn", `[Rate Limit] IP ${clientIp} exceeded rate limit`);
          return jsonResponse(
            { errorCode: 429, success: false, errorMessage: "Too many requests" },
            429
          );
        }

        recentRequests.push(currentTime);
        globals.requestHistory.set(clientIp, recentRequests);
      }

      return getCommentByUrl(videoUrl, queryFormat);
    }

    if (!path.startsWith("/api/v2/comment/")) {
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing commentId or url" },
        400
      );
    }

    const commentId = parseInt(path.split("/").pop());
    let urlForComment = findUrlById(commentId);

    if (urlForComment) {
      const cachedComments = getCommentCache(urlForComment);
      if (cachedComments !== null) {
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
        return jsonResponse(
          { errorCode: 429, success: false, errorMessage: "Too many requests" },
          429
        );
      }

      recentRequests.push(currentTime);
      globals.requestHistory.set(clientIp, recentRequests);
    }

    return getComment(path, queryFormat);
  }

  if (path === "/api/logs" && method === "GET") {
    const format = url.searchParams.get('format') || 'text';
    const level = url.searchParams.get('level');
    const limit = parseInt(url.searchParams.get('limit')) || globals.logBuffer.length;
    const lastId = parseInt(url.searchParams.get('lastId')) || -1;

    let logs = globals.logBuffer;

    if (level) {
      logs = logs.filter(log => log.level === level);
    }

    if (lastId >= 0) {
      const lastIndex = logs.findIndex((log, index) => index > lastId);
      if (lastIndex > 0) {
        logs = logs.slice(lastIndex);
      } else {
        logs = [];
      }
    }

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

function getLoginPage() {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - 弹幕 API 管理中心</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    :root {
      --bg-main: #0a0e27;
      --bg-card: rgba(255, 255, 255, 0.03);
      --bg-glass: rgba(255, 255, 255, 0.05);
      --bg-hover: rgba(255, 255, 255, 0.08);
      --text-primary: #ffffff;
      --text-secondary: #a0aec0;
      --text-tertiary: #718096;
      --border-color: rgba(255, 255, 255, 0.1);
      --gradient-primary: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.3);
      --shadow-glow: 0 0 20px rgba(102, 126, 234, 0.3);
    }

    [data-theme="light"] {
      --bg-main: #f7fafc;
      --bg-card: #ffffff;
      --bg-glass: rgba(255, 255, 255, 0.9);
      --bg-hover: #edf2f7;
      --text-primary: #1a202c;
      --text-secondary: #4a5568;
      --text-tertiary: #718096;
      --border-color: #e2e8f0;
      --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.12);
      --shadow-glow: 0 0 20px rgba(102, 126, 234, 0.2);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-main);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      transition: all 0.3s ease;
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
        radial-gradient(circle at 20% 30%, rgba(102, 126, 234, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 70%, rgba(118, 75, 162, 0.15) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .theme-toggle {
      position: fixed;
      top: 32px;
      right: 32px;
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: var(--bg-glass);
      backdrop-filter: blur(20px);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      z-index: 100;
    }

    .theme-toggle:hover {
      transform: scale(1.1) rotate(180deg);
      box-shadow: var(--shadow-glow);
    }

    .login-container {
      background: var(--bg-glass);
      backdrop-filter: blur(40px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 48px;
      width: 100%;
      max-width: 480px;
      box-shadow: var(--shadow-lg);
      animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      z-index: 1;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(40px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .logo {
      text-align: center;
      margin-bottom: 40px;
    }

    .logo-icon {
      font-size: 64px;
      margin-bottom: 20px;
      display: inline-block;
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }

    .logo-title {
      font-size: 28px;
      font-weight: 700;
      background: var(--gradient-primary);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }

    .logo-subtitle {
      font-size: 14px;
      color: var(--text-tertiary);
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .hint {
      background: rgba(102, 126, 234, 0.1);
      border-left: 4px solid #667eea;
      padding: 16px 20px;
      border-radius: 12px;
      margin-bottom: 32px;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .hint strong {
      color: #667eea;
      font-weight: 600;
    }

    .error-message {
      background: rgba(239, 68, 68, 0.1);
      border-left: 4px solid #ef4444;
      color: #ef4444;
      padding: 16px 20px;
      border-radius: 12px;
      margin-bottom: 24px;
      font-size: 13px;
      display: none;
      animation: shake 0.5s ease;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-10px); }
      75% { transform: translateX(10px); }
    }

    .form-group {
      margin-bottom: 24px;
    }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
      color: var(--text-primary);
    }

    .form-input {
      width: 100%;
      padding: 14px 18px;
      border: 1px solid var(--border-color);
      border-radius: 12px;
      font-size: 14px;
      font-family: inherit;
      background: var(--bg-card);
      color: var(--text-primary);
      transition: all 0.3s ease;
    }

    .form-input:focus {
      outline: none;
      border-color: rgba(102, 126, 234, 0.5);
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
      background: var(--bg-glass);
    }

    .btn-login {
      width: 100%;
      padding: 16px;
      background: var(--gradient-primary);
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: var(--shadow-glow);
      margin-top: 8px;
    }

    .btn-login:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
    }

    .btn-login:active {
      transform: translateY(0);
    }

    .btn-login:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .footer {
      text-align: center;
      margin-top: 32px;
      font-size: 12px;
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    @media (max-width: 480px) {
      .login-container {
        padding: 36px 28px;
      }
      
      .theme-toggle {
        top: 20px;
        right: 20px;
      }
    }
  </style>
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()" title="切换主题">🌓</button>

  <div class="login-container">
    <div class="logo">
      <div class="logo-icon">🎬</div>
      <h1 class="logo-title">弹幕 API</h1>
      <p class="logo-subtitle">Management Center</p>
    </div>

    <div class="hint">
      💡 默认账号密码均为 <strong>admin</strong>
    </div>

    <div id="errorMessage" class="error-message"></div>

    <form id="loginForm">
      <div class="form-group">
        <label class="form-label">用户名</label>
        <input type="text" class="form-input" id="username" placeholder="请输入用户名" required autofocus>
      </div>

      <div class="form-group">
        <label class="form-label">密码</label>
        <input type="password" class="form-input" id="password" placeholder="请输入密码" required>
      </div>

      <button type="submit" class="btn-login" id="loginBtn">
        <span>登录</span>
      </button>
    </form>

    <div class="footer">
      <span>🔒</span>
      <span>安全登录</span>
    </div>
  </div>

  <script>
    // 主题管理
    function initTheme() {
      const savedTheme = localStorage.getItem('theme') || 'dark';
      document.documentElement.setAttribute('data-theme', savedTheme);
      updateThemeIcon(savedTheme);
    }

    function toggleTheme() {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      updateThemeIcon(newTheme);
    }

    function updateThemeIcon(theme) {
      const btn = document.querySelector('.theme-toggle');
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    }

    initTheme();

    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const loginBtn = document.getElementById('loginBtn');

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      errorMessage.style.display = 'none';
      loginBtn.disabled = true;
      loginBtn.innerHTML = '<span>登录中...</span>';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const result = await response.json();

        if (result.success) {
          loginBtn.innerHTML = '<span>✅ 登录成功</span>';
          setTimeout(() => {
            window.location.href = '/';
          }, 500);
        } else {
          errorMessage.textContent = result.message || '登录失败，请检查用户名和密码';
          errorMessage.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.innerHTML = '<span>登录</span>';
        }
      } catch (error) {
        errorMessage.textContent = '网络错误，请稍后重试';
        errorMessage.style.display = 'block';
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<span>登录</span>';
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

async function saveAdminCredentials(username, password) {
  try {
    let saved = false;
    
    if (globals.redisValid) {
      const { setRedisKey } = await import('./utils/redis-util.js');
      const userResult = await setRedisKey('admin_username', username, true);
      const passResult = await setRedisKey('admin_password', password, true);
      saved = userResult?.result === 'OK' && passResult?.result === 'OK';
    }
    
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

// Cloudflare Workers 入口
export default {
  async fetch(request, env, ctx) {
    const clientIp = request.headers.get('cf-connecting-ip') || 
                     request.headers.get('x-forwarded-for') || 
                     'unknown';
    return handleRequest(request, env, "cloudflare", clientIp);
  },
};

// Vercel 入口
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

// Netlify 入口
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