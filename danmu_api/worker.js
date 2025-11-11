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
  'TOKEN': '自定义API访问令牌，使用默认87654321可以不填写',
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
  'redisToken'
];

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.includes(key) ||
    key.toLowerCase().includes('token') ||
    key.toLowerCase().includes('password') ||
    key.toLowerCase().includes('secret') ||
    key.toLowerCase().includes('key') ||
    key.toLowerCase().includes('cookie');
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
          displayValue = value ? '<span class="status-badge status-success">✓ 已启用</span>' : '<span class="status-badge status-disabled">✗ 已禁用</span>';
        } else if (value === null || value === undefined || (typeof value === 'string' && value.length === 0)) {
          displayValue = '<span class="status-badge status-empty">未配置</span>';
        } else if (isSensitive && typeof value === 'string' && value.length > 0) {
          const realValue = getRealEnvValue(key);
          const maskedValue = '•'.repeat(Math.min(String(realValue).length, 20));
          const safeRealValue = typeof realValue === 'string' ? realValue : JSON.stringify(realValue);
          const encodedRealValue = safeRealValue
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

          return `
            <div class="env-item" data-key="${key}">
              <div class="env-header">
                <div class="env-label-wrapper">
                  <span class="env-icon">🔐</span>
                  <span class="env-label">${key}</span>
                </div>
                <button class="icon-btn" onclick="editEnv('${key}')" title="编辑">
                  <svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
                </button>
              </div>
              <div class="env-value sensitive" data-real="${encodedRealValue}" onclick="toggleSensitive(this)">
                <span class="masked-text">${maskedValue}</span>
                <span class="toggle-icon">
                  <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/></svg>
                </span>
              </div>
              <div class="env-desc">${description}</div>
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

        const iconMap = {
          'TOKEN': '🔑',
          'VERSION': '📌',
          'LOG_LEVEL': '📝',
          'BILIBILI_COOKIE': '🍪',
          'TMDB_API_KEY': '🎬',
          'REDIS': '💾',
          'DATABASE': '🗄️',
          'PROXY': '🌐',
          'DANMU': '💬'
        };

        let icon = '⚙️';
        for (const [prefix, emoji] of Object.entries(iconMap)) {
          if (key.toUpperCase().includes(prefix)) {
            icon = emoji;
            break;
          }
        }

        return `
          <div class="env-item" data-key="${key}">
            <div class="env-header">
              <div class="env-label-wrapper">
                <span class="env-icon">${icon}</span>
                <span class="env-label">${key}</span>
              </div>
              <button class="icon-btn" onclick="editEnv('${key}')" title="编辑">
                <svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
              </button>
            </div>
            <div class="env-value" data-original="${encodedOriginal}" ondblclick="copyValue(this)">
              ${displayValue}
            </div>
            <div class="env-desc">${description}</div>
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
  <title>弹幕 API 控制台</title>
  <style>
    :root {
      --primary-gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #d946ef 100%);
      --primary-color: #6366f1;
      --primary-dark: #4f46e5;
      --success-color: #10b981;
      --warning-color: #f59e0b;
      --error-color: #ef4444;
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #cbd5e1;
      --text-tertiary: #94a3b8;
      --border-color: rgba(148, 163, 184, 0.1);
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24);
      --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.06);
      --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1), 0 4px 6px rgba(0, 0, 0, 0.05);
      --shadow-xl: 0 20px 25px rgba(0, 0, 0, 0.15), 0 10px 10px rgba(0, 0, 0, 0.04);
      --glass-bg: rgba(30, 41, 59, 0.7);
      --glass-border: rgba(148, 163, 184, 0.1);
    }

    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box; 
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      background: var(--bg-primary);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.15) 0px, transparent 50%);
      background-attachment: fixed;
      min-height: 100vh;
      padding: 24px;
      color: var(--text-primary);
      overflow-x: hidden;
    }

    /* 背景动画 */
    @keyframes gradient-shift {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.8; }
    }

    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: 
        radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(217, 70, 239, 0.1) 0%, transparent 50%);
      animation: gradient-shift 15s ease-in-out infinite;
      pointer-events: none;
      z-index: -1;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    /* 玻璃态效果 */
    .glass {
      background: var(--glass-bg);
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      box-shadow: var(--shadow-lg);
    }

    /* 头部导航 */
    .header {
      background: var(--glass-bg);
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      padding: 24px 32px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: var(--shadow-lg);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
      transition: left 0.5s;
    }

    .header:hover::before {
      left: 100%;
    }

    .header:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-xl);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 28px;
      font-weight: 800;
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      position: relative;
    }

    .logo-icon {
      font-size: 40px;
      filter: drop-shadow(0 4px 8px rgba(99, 102, 241, 0.4));
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
    }

    .header-actions {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      position: relative;
      overflow: hidden;
    }

    .btn::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.3);
      transform: translate(-50%, -50%);
      transition: width 0.6s, height 0.6s;
    }

    .btn:active::before {
      width: 300px;
      height: 300px;
    }

    .btn-primary {
      background: var(--primary-gradient);
      color: white;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.5);
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover {
      background: var(--bg-secondary);
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    /* 统计卡片 */
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--glass-bg);
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      padding: 28px;
      position: relative;
      overflow: hidden;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: var(--shadow-md);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: var(--primary-gradient);
      transform: scaleX(0);
      transform-origin: left;
      transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .stat-card:hover {
      transform: translateY(-8px);
      box-shadow: var(--shadow-xl);
    }

    .stat-card:hover::before {
      transform: scaleX(1);
    }

    .stat-icon {
      font-size: 48px;
      margin-bottom: 16px;
      display: inline-block;
      filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2));
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .stat-title {
      font-size: 14px;
      color: var(--text-tertiary);
      margin-bottom: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-value {
      font-size: 36px;
      font-weight: 800;
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
      line-height: 1.2;
    }

    .stat-footer {
      font-size: 13px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .stat-footer::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success-color);
      display: inline-block;
      animation: blink 2s ease-in-out infinite;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* 主要内容卡片 */
    .card {
      background: var(--glass-bg);
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--glass-border);
      border-radius: 20px;
      padding: 32px;
      box-shadow: var(--shadow-lg);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .card:hover {
      box-shadow: var(--shadow-xl);
    }

    .card-title {
      font-size: 24px;
      font-weight: 800;
      margin-bottom: 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text-primary);
    }

    .card-title-text {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .card-title-icon {
      font-size: 28px;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
    }

    /* 搜索框 */
    .search-box {
      margin-bottom: 24px;
      position: relative;
    }

    .search-input {
      width: 100%;
      padding: 16px 48px 16px 20px;
      border: 2px solid var(--border-color);
      border-radius: 16px;
      font-size: 15px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .search-input::placeholder {
      color: var(--text-tertiary);
    }

    .search-input:focus {
      outline: none;
      border-color: var(--primary-color);
      background: var(--bg-tertiary);
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
      transform: translateY(-2px);
    }

    .search-icon {
      position: absolute;
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-tertiary);
      pointer-events: none;
    }

    /* 环境变量网格 */
    .env-grid {
      display: grid;
      gap: 20px;
    }

    .env-item {
      background: var(--bg-secondary);
      border: 2px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .env-item::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--primary-gradient);
      transform: scaleY(0);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .env-item:hover {
      border-color: var(--primary-color);
      transform: translateX(4px);
      box-shadow: var(--shadow-md);
    }

    .env-item:hover::before {
      transform: scaleY(1);
    }

    .env-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .env-label-wrapper {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .env-icon {
      font-size: 24px;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
    }

    .env-label {
      font-weight: 700;
      font-size: 15px;
      color: var(--text-primary);
      font-family: 'Courier New', monospace;
      letter-spacing: 0.5px;
    }

    .icon-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      color: var(--text-secondary);
    }

    .icon-btn svg {
      width: 18px;
      height: 18px;
    }

    .icon-btn:hover {
      background: var(--primary-color);
      color: white;
      transform: rotate(15deg) scale(1.1);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    }

    .env-value {
      padding: 16px;
      background: var(--bg-tertiary);
      border-radius: 12px;
      font-family: 'Courier New', 'Consolas', monospace;
      font-size: 14px;
      word-break: break-all;
      margin-bottom: 12px;
      color: var(--text-secondary);
      line-height: 1.6;
      min-height: 52px;
      display: flex;
      align-items: center;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .env-value:hover {
      background: var(--bg-primary);
    }

    .env-value.sensitive {
      cursor: pointer;
      justify-content: space-between;
      user-select: none;
    }

    .env-value.sensitive:hover {
      background: var(--bg-primary);
      border: 2px dashed var(--primary-color);
      padding: 14px;
    }

    .toggle-icon {
      display: flex;
      align-items: center;
      color: var(--text-tertiary);
      transition: all 0.3s;
    }

    .toggle-icon svg {
      width: 20px;
      height: 20px;
    }

    .env-value.sensitive:hover .toggle-icon {
      color: var(--primary-color);
      transform: scale(1.2);
    }

    .env-desc {
      font-size: 13px;
      color: var(--text-tertiary);
      line-height: 1.5;
      padding-left: 36px;
    }

    /* 状态徽章 */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }

    .status-success {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success-color);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .status-disabled {
      background: rgba(148, 163, 184, 0.15);
      color: var(--text-tertiary);
      border: 1px solid rgba(148, 163, 184, 0.3);
    }

    .status-empty {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning-color);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    /* 模态框 */
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(15, 23, 42, 0.8);
      backdrop-filter: blur(8px);
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.3s;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal.show {
      display: flex;
    }

    .modal-content {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 36px;
      max-width: 560px;
      width: 90%;
      max-height: 85vh;
      overflow-y: auto;
      box-shadow: var(--shadow-xl);
      animation: slideUp 0.3s cubic-bezier(0.4, 0, 0.2, 1);
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
      border-bottom: 2px solid var(--border-color);
    }

    .modal-title {
      font-size: 24px;
      font-weight: 800;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .close-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      width: 40px;
      height: 40px;
      border-radius: 12px;
      font-size: 24px;
      cursor: pointer;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .close-btn:hover {
      background: var(--error-color);
      color: white;
      transform: rotate(90deg);
      border-color: var(--error-color);
    }

    .form-group {
      margin-bottom: 24px;
    }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 10px;
      color: var(--text-primary);
      letter-spacing: 0.3px;
    }

    .form-input, .form-textarea {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid var(--border-color);
      border-radius: 12px;
      font-size: 14px;
      font-family: inherit;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .form-textarea {
      min-height: 120px;
      font-family: 'Courier New', monospace;
      resize: vertical;
    }

    .form-input:focus, .form-textarea:focus {
      outline: none;
      border-color: var(--primary-color);
      background: var(--bg-secondary);
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
      transform: translateY(-2px);
    }

    .form-hint {
      font-size: 13px;
      color: var(--text-tertiary);
      margin-top: 8px;
      line-height: 1.5;
      padding: 8px 12px;
      background: var(--bg-primary);
      border-radius: 8px;
      border-left: 3px solid var(--primary-color);
    }

    .modal-footer {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 32px;
      padding-top: 24px;
      border-top: 2px solid var(--border-color);
    }

    /* Toast 提示 */
    .toast {
      position: fixed;
      bottom: 32px;
      right: 32px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 20px 24px;
      box-shadow: var(--shadow-xl);
      display: none;
      align-items: center;
      gap: 16px;
      z-index: 2000;
      min-width: 320px;
      animation: slideInRight 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes slideInRight {
      from {
        opacity: 0;
        transform: translateX(400px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .toast.show {
      display: flex;
    }

    .toast.success {
      border-left: 4px solid var(--success-color);
    }

    .toast.error {
      border-left: 4px solid var(--error-color);
    }

    .toast.info {
      border-left: 4px solid var(--primary-color);
    }

    .toast-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .toast-message {
      flex: 1;
      color: var(--text-primary);
      font-weight: 600;
    }

    /* 自定义滚动条 */
    ::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }

    ::-webkit-scrollbar-track {
      background: var(--bg-primary);
      border-radius: 10px;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--bg-tertiary);
      border-radius: 10px;
      border: 2px solid var(--bg-primary);
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--primary-color);
    }

    /* 响应式设计 */
    @media (max-width: 768px) {
      body {
        padding: 16px;
      }

      .header {
        flex-direction: column;
        gap: 20px;
        padding: 20px;
      }

      .header-actions {
        width: 100%;
        justify-content: center;
      }

      .stats {
        grid-template-columns: 1fr;
      }

      .card {
        padding: 20px;
      }

      .card-title {
        font-size: 20px;
        flex-direction: column;
        align-items: flex-start;
        gap: 16px;
      }

      .modal-content {
        padding: 24px;
        width: 95%;
      }

      .toast {
        right: 16px;
        left: 16px;
        bottom: 16px;
        min-width: unset;
      }

      .env-item {
        padding: 16px;
      }

      .env-desc {
        padding-left: 0;
        margin-top: 8px;
      }
    }

    /* 加载动画 */
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: white;
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

    .empty-icon {
      font-size: 64px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 16px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">
        <span class="logo-icon">🎬</span>
        <span>弹幕 API 控制台</span>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" onclick="changePassword()">
          <svg viewBox="0 0 20 20" fill="currentColor" style="width:18px;height:18px"><path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/></svg>
          修改密码
        </button>
        <button class="btn btn-secondary" onclick="logout()">
          <svg viewBox="0 0 20 20" fill="currentColor" style="width:18px;height:18px"><path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd"/></svg>
          退出登录
        </button>
      </div>
    </div>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-icon">📊</div>
        <div class="stat-title">环境变量配置</div>
        <div class="stat-value">${configuredEnvCount}/${totalEnvCount}</div>
        <div class="stat-footer">已配置项 / 总配置项</div>
      </div>
      
      <div class="stat-card">
        <div class="stat-icon">💾</div>
        <div class="stat-title">持久化存储</div>
        <div class="stat-value">${
          globals.databaseValid ? '数据库' : 
          (redisConfigured && globals.redisValid) ? 'Redis' : 
          '内存'
        }</div>
        <div class="stat-footer">${
          globals.databaseValid ? '✓ 数据库在线' : 
          (redisConfigured && globals.redisValid) ? '✓ Redis 在线' : 
          '⚠ 仅内存缓存'
        }</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">🔗</div>
        <div class="stat-title">弹幕数据源</div>
        <div class="stat-value">${globals.sourceOrderArr.length || 7}</div>
        <div class="stat-footer">${globals.sourceOrderArr.length > 0 ? `优先级: ${globals.sourceOrderArr[0]}` : '使用默认顺序'}</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">⚡</div>
        <div class="stat-title">服务状态</div>
        <div class="stat-value">运行中</div>
        <div class="stat-footer">版本 ${globals.VERSION}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <div class="card-title-text">
          <span class="card-title-icon">⚙️</span>
          <span>环境变量配置</span>
        </div>
        <button class="btn btn-primary" onclick="saveAll()">
          <svg viewBox="0 0 20 20" fill="currentColor" style="width:18px;height:18px"><path d="M7.707 10.293a1 1 0 10-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 11.586V6h5a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h5v5.586l-1.293-1.293zM9 4a1 1 0 012 0v2H9V4z"/></svg>
          保存全部配置
        </button>
      </div>
      
      <div class="search-box">
        <input 
          type="text" 
          class="search-input" 
          placeholder="搜索环境变量名称、值或描述..." 
          id="searchInput" 
          oninput="filterEnvs()"
        >
        <svg class="search-icon" viewBox="0 0 20 20" fill="currentColor" style="width:20px;height:20px">
          <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/>
        </svg>
      </div>

      <div class="env-grid" id="envGrid">
        ${envItemsHtml}
      </div>

      <div id="emptyState" class="empty-state" style="display:none;">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">未找到匹配的环境变量</div>
      </div>
    </div>
  </div>

  <!-- 编辑弹窗 -->
  <div class="modal" id="editModal">
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title">
          <span>✏️</span>
          <span>编辑环境变量</span>
        </h3>
        <button class="close-btn" onclick="closeModal()">×</button>
      </div>
      <div class="form-group">
        <label class="form-label">变量名</label>
        <input type="text" class="form-input" id="editKey" readonly>
      </div>
      <div class="form-group">
        <label class="form-label">配置值</label>
        <textarea class="form-textarea" id="editValue" placeholder="请输入配置值"></textarea>
        <div class="form-hint" id="editHint"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="saveEnv()">
          <svg viewBox="0 0 20 20" fill="currentColor" style="width:16px;height:16px"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
          保存更改
        </button>
      </div>
    </div>
  </div>

  <!-- 修改密码弹窗 -->
  <div class="modal" id="passwordModal">
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title">
          <span>🔑</span>
          <span>修改密码</span>
        </h3>
        <button class="close-btn" onclick="closePasswordModal()">×</button>
      </div>
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
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closePasswordModal()">取消</button>
        <button class="btn btn-primary" onclick="submitPasswordChange()">
          <svg viewBox="0 0 20 20" fill="currentColor" style="width:16px;height:16px"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
          确认修改
        </button>
      </div>
    </div>
  </div>

  <!-- Toast 提示 -->
  <div class="toast" id="toast">
    <div class="toast-icon" id="toastIcon"></div>
    <div class="toast-message" id="toastMessage"></div>
  </div>

  <script>
    const AppState = {
      currentEditingKey: null,
      config: ${JSON.stringify(globals.accessedEnvVars)}
    };

    const ENV_DESCRIPTIONS = ${JSON.stringify(ENV_DESCRIPTIONS)};

    function showToast(message, type = 'info') {
      const toast = document.getElementById('toast');
      const toastIcon = document.getElementById('toastIcon');
      const toastMessage = document.getElementById('toastMessage');
      
      const icons = {
        success: '✓',
        error: '✕',
        info: 'ℹ'
      };
      
      toastIcon.textContent = icons[type] || icons.info;
      toastMessage.textContent = message;
      toast.className = 'toast show ' + type;
      
      setTimeout(() => {
        toast.classList.remove('show');
      }, 4000);
    }

    function toggleSensitive(element) {
      const real = element.dataset.real;
      const maskedText = element.querySelector('.masked-text');
      
      if (maskedText.textContent.includes('•')) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = real;
        maskedText.textContent = textarea.value;
        
        setTimeout(() => {
          maskedText.textContent = '•'.repeat(20);
        }, 3000);
      }
    }

    function editEnv(key) {
      AppState.currentEditingKey = key;
      document.getElementById('editKey').value = key;
      
      const currentValue = AppState.config[key];
      let displayValue = '';
      
      if (typeof currentValue === 'boolean') {
        displayValue = currentValue ? 'true' : 'false';
      } else if (currentValue === null || currentValue === undefined) {
        displayValue = '';
      } else if (Array.isArray(currentValue)) {
        displayValue = currentValue.join(', ');
      } else {
        displayValue = String(currentValue);
      }
      
      document.getElementById('editValue').value = displayValue;
      document.getElementById('editHint').textContent = ENV_DESCRIPTIONS[key] || '';
      document.getElementById('editModal').classList.add('show');
      
      setTimeout(() => {
        document.getElementById('editValue').focus();
      }, 100);
    }

    function closeModal() {
      document.getElementById('editModal').classList.remove('show');
    }

    async function saveEnv() {
      const key = AppState.currentEditingKey;
      const value = document.getElementById('editValue').value.trim();
      
      AppState.config[key] = value;
      
      const saveBtn = event.target;
      const originalText = saveBtn.innerHTML;
      saveBtn.innerHTML = '<span class="loading"></span> 保存中...';
      saveBtn.disabled = true;
      
      try {
        const response = await fetch('/api/config/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: { [key]: value } })
        });

        const result = await response.json();
        
        if (result.success) {
          showToast('✓ 保存成功！配置已更新', 'success');
          updateEnvDisplay(key, value);
          closeModal();
        } else {
          showToast('✕ 保存失败: ' + (result.errorMessage || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('✕ 网络错误: ' + error.message, 'error');
      } finally {
        saveBtn.innerHTML = originalText;
        saveBtn.disabled = false;
      }
    }

    async function saveAll() {
      const saveBtn = event.target;
      const originalText = saveBtn.innerHTML;
      saveBtn.innerHTML = '<span class="loading"></span> 保存中...';
      saveBtn.disabled = true;
      
      try {
        const response = await fetch('/api/config/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: AppState.config })
        });

        const result = await response.json();
        
        if (result.success) {
          showToast('✓ 全部配置已保存成功！', 'success');
        } else {
          showToast('✕ 保存失败: ' + (result.errorMessage || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('✕ 保存失败: ' + error.message, 'error');
      } finally {
        saveBtn.innerHTML = originalText;
        saveBtn.disabled = false;
      }
    }

    function updateEnvDisplay(key, value) {
      const item = document.querySelector(\`.env-item[data-key="\${key}"]\`);
      if (!item) return;
      
      const valueEl = item.querySelector('.env-value');
      
      if (typeof value === 'boolean' || (typeof value === 'string' && (value.toLowerCase() === 'true' || value.toLowerCase() === 'false'))) {
        const isTrue = value === true || value === 'true';
        valueEl.innerHTML = isTrue 
          ? '<span class="status-badge status-success">✓ 已启用</span>' 
          : '<span class="status-badge status-disabled">✗ 已禁用</span>';
      } else if (!value || value === '' || value === 'null' || value === 'undefined') {
        valueEl.innerHTML = '<span class="status-badge status-empty">未配置</span>';
      } else {
        const displayValue = value.length > 80 ? value.substring(0, 80) + '...' : value;
        valueEl.textContent = displayValue;
      }
    }

    function copyValue(element) {
      const original = element.dataset.original;
      if (!original) return;
      
      const textarea = document.createElement('textarea');
      textarea.innerHTML = original;
      const text = textarea.value;
      
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
          showToast('✓ 已复制到剪贴板', 'success');
        }).catch(() => {
          fallbackCopy(text);
        });
      } else {
        fallbackCopy(text);
      }
    }

    function fallbackCopy(text) {
      const temp = document.createElement('textarea');
      temp.value = text;
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.select();
      
      try {
        document.execCommand('copy');
        showToast('✓ 已复制到剪贴板', 'success');
      } catch (err) {
        showToast('✕ 复制失败', 'error');
      }
      
      document.body.removeChild(temp);
    }

    function filterEnvs() {
      const query = document.getElementById('searchInput').value.toLowerCase();
      const items = document.querySelectorAll('.env-item');
      let visibleCount = 0;
      
      items.forEach(item => {
        const label = item.querySelector('.env-label').textContent.toLowerCase();
        const value = item.querySelector('.env-value').textContent.toLowerCase();
        const desc = item.querySelector('.env-desc').textContent.toLowerCase();
        
        if (label.includes(query) || value.includes(query) || desc.includes(query)) {
          item.style.display = '';
          visibleCount++;
        } else {
          item.style.display = 'none';
        }
      });
      
      const emptyState = document.getElementById('emptyState');
      if (visibleCount === 0 && query.length > 0) {
        emptyState.style.display = 'block';
      } else {
        emptyState.style.display = 'none';
      }
    }

    function changePassword() {
      document.getElementById('passwordModal').classList.add('show');
      setTimeout(() => {
        document.getElementById('oldPassword').focus();
      }, 100);
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
        showToast('✕ 请输入旧密码', 'error');
        return;
      }
      
      if (!newPassword) {
        showToast('✕ 请输入新密码', 'error');
        return;
      }
      
      if (newPassword !== confirmPassword) {
        showToast('✕ 两次输入的密码不一致', 'error');
        return;
      }
      
      if (newPassword.length < 4) {
        showToast('✕ 密码长度至少为4位', 'error');
        return;
      }
      
      const submitBtn = event.target;
      const originalText = submitBtn.innerHTML;
      submitBtn.innerHTML = '<span class="loading"></span> 修改中...';
      submitBtn.disabled = true;
      
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
          showToast('✓ 密码修改成功，即将重新登录...', 'success');
          closePasswordModal();
          setTimeout(() => logout(), 2000);
        } else {
          showToast('✕ ' + (result.message || '修改失败'), 'error');
        }
      } catch (error) {
        showToast('✕ 修改失败: ' + error.message, 'error');
      } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
      }
    }

    async function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
        showToast('✓ 已安全退出', 'success');
        setTimeout(() => {
          window.location.href = '/';
        }, 1000);
      } catch (error) {
        showToast('✕ 退出失败', 'error');
      }
    }

    // 快捷键支持
    document.addEventListener('keydown', (e) => {
      // Ctrl+S / Cmd+S 保存
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveAll();
      }
      
      // ESC 关闭弹窗
      if (e.key === 'Escape') {
        closeModal();
        closePasswordModal();
      }
      
      // Ctrl+F / Cmd+F 聚焦搜索
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('searchInput').focus();
      }
    });

    // 初始化加载配置
    async function loadConfig() {
      try {
        const response = await fetch('/api/config/load');
        const result = await response.json();
        
        if (result.success && result.config) {
          AppState.config = { ...AppState.config, ...result.config };
          
          for (const [key, value] of Object.entries(result.config)) {
            updateEnvDisplay(key, value);
          }
          
          showToast(\`✓ 配置已从 \${result.loadedFrom.join('、')} 加载\`, 'success');
        }
      } catch (error) {
        console.error('加载配置失败:', error);
        showToast('⚠ 配置加载失败，使用当前配置', 'info');
      }
    }

    // 页面加载完成后初始化
    window.addEventListener('DOMContentLoaded', () => {
      loadConfig();
      
      // 添加进入动画
      const cards = document.querySelectorAll('.stat-card, .card');
      cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        setTimeout(() => {
          card.style.transition = 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
          card.style.opacity = '1';
          card.style.transform = 'translateY(0)';
        }, index * 100);
      });
    });

    // 监听在线/离线状态
    window.addEventListener('online', () => {
      showToast('✓ 网络连接已恢复', 'success');
    });

    window.addEventListener('offline', () => {
      showToast('⚠ 网络连接已断开', 'error');
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
  <title>登录 - 弹幕 API</title>
  <style>
    :root {
      --primary-gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #d946ef 100%);
      --primary-color: #6366f1;
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #cbd5e1;
      --text-tertiary: #94a3b8;
      --border-color: rgba(148, 163, 184, 0.1);
      --error-color: #ef4444;
      --shadow-xl: 0 20px 25px rgba(0, 0, 0, 0.15), 0 10px 10px rgba(0, 0, 0, 0.04);
    }

    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box; 
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
      background: var(--bg-primary);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.2) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.2) 0px, transparent 50%);
      background-attachment: fixed;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: var(--text-primary);
      position: relative;
      overflow: hidden;
    }

    body::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: 
        radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(217, 70, 239, 0.15) 0%, transparent 50%);
      animation: gradient-shift 15s ease-in-out infinite;
      pointer-events: none;
    }

    @keyframes gradient-shift {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.8; }
    }

    .login-container {
      background: rgba(30, 41, 59, 0.7);
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 48px 40px;
      width: 100%;
      max-width: 440px;
      box-shadow: var(--shadow-xl);
      position: relative;
      z-index: 1;
      animation: slideUp 0.5s cubic-bezier(0.4, 0, 0.2, 1);
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
      font-size: 72px;
      margin-bottom: 20px;
      display: inline-block;
      filter: drop-shadow(0 8px 16px rgba(99, 102, 241, 0.4));
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
    }

    .logo-title {
      font-size: 28px;
      font-weight: 800;
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }

    .logo-subtitle {
      font-size: 15px;
      color: var(--text-tertiary);
      font-weight: 500;
    }

    .hint {
      background: rgba(99, 102, 241, 0.1);
      border-left: 4px solid var(--primary-color);
      padding: 16px 20px;
      border-radius: 12px;
      margin-bottom: 32px;
      font-size: 14px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .hint strong {
      color: var(--text-primary);
      font-weight: 700;
    }

    .error-message {
      background: rgba(239, 68, 68, 0.1);
      border-left: 4px solid var(--error-color);
      color: #fca5a5;
      padding: 16px 20px;
      border-radius: 12px;
      margin-bottom: 24px;
      font-size: 14px;
      display: none;
      animation: shake 0.4s;
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
      font-weight: 700;
      margin-bottom: 10px;
      color: var(--text-primary);
      letter-spacing: 0.3px;
    }

    .input-wrapper {
      position: relative;
    }

    .input-icon {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-tertiary);
      font-size: 20px;
      pointer-events: none;
      transition: all 0.3s;
    }

    .form-input {
      width: 100%;
      padding: 16px 16px 16px 48px;
      border: 2px solid var(--border-color);
      border-radius: 12px;
      font-size: 15px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-weight: 500;
    }

    .form-input::placeholder {
      color: var(--text-tertiary);
    }

    .form-input:focus {
      outline: none;
      border-color: var(--primary-color);
      background: var(--bg-secondary);
      box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
      transform: translateY(-2px);
    }

    .form-input:focus + .input-icon {
      color: var(--primary-color);
    }

    .btn-login {
      width: 100%;
      padding: 16px;
      background: var(--primary-gradient);
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
      margin-top: 32px;
      letter-spacing: 0.5px;
    }

    .btn-login::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.3);
      transform: translate(-50%, -50%);
      transition: width 0.6s, height 0.6s;
    }

    .btn-login:active::before {
      width: 300px;
      height: 300px;
    }

    .btn-login:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.5);
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
      font-size: 13px;
      color: var(--text-tertiary);
      font-weight: 500;
    }

    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @media (max-width: 480px) {
      .login-container {
        padding: 36px 24px;
      }

      .logo-icon {
        font-size: 64px;
      }

      .logo-title {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo">
      <div class="logo-icon">🎬</div>
      <h1 class="logo-title">弹幕 API 控制台</h1>
      <p class="logo-subtitle">欢迎回来，请登录您的账户</p>
    </div>

    <div class="hint">
      💡 默认账号和密码均为 <strong>admin</strong><br>
      首次登录后建议立即修改密码
    </div>

    <div id="errorMessage" class="error-message"></div>

    <form id="loginForm">
      <div class="form-group">
        <label class="form-label">用户名</label>
        <div class="input-wrapper">
          <input type="text" class="form-input" id="username" placeholder="请输入用户名" required autocomplete="username">
          <span class="input-icon">👤</span>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">密码</label>
        <div class="input-wrapper">
          <input type="password" class="form-input" id="password" placeholder="请输入密码" required autocomplete="current-password">
          <span class="input-icon">🔒</span>
        </div>
      </div>

      <button type="submit" class="btn-login" id="loginBtn">
        <span id="btnText">登录</span>
      </button>
    </form>

    <div class="footer">
      © 2025 弹幕 API 服务 · 安全登录
    </div>
  </div>

  <script>
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const loginBtn = document.getElementById('loginBtn');
    const btnText = document.getElementById('btnText');

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      errorMessage.style.display = 'none';
      loginBtn.disabled = true;
      btnText.innerHTML = '<span class="loading"></span>登录中...';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const result = await response.json();

        if (result.success) {
          btnText.textContent = '✓ 登录成功';
          setTimeout(() => {
            window.location.href = '/';
          }, 500);
        } else {
          errorMessage.textContent = '✕ ' + (result.message || '登录失败，请检查用户名和密码');
          errorMessage.style.display = 'block';
          loginBtn.disabled = false;
          btnText.textContent = '登录';
        }
      } catch (error) {
        errorMessage.textContent = '✕ 网络错误，请检查连接后重试';
        errorMessage.style.display = 'block';
        loginBtn.disabled = false;
        btnText.textContent = '登录';
      }
    });

    // Enter 键快速登录
    document.getElementById('password').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        loginForm.dispatchEvent(new Event('submit'));
      }
    });

    // 自动聚焦到用户名输入框
    window.addEventListener('DOMContentLoaded', () => {
      document.getElementById('username').focus();
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