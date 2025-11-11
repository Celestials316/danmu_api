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
  'VERSION': '当前服务版本号(自动生成)',
  'LOG_LEVEL': '日志级别:error/warn/info,默认info',
  'OTHER_SERVER': '兜底第三方弹幕服务器,默认api.danmu.icu',
  'VOD_SERVERS': 'VOD影视采集站列表,格式:名称@URL,名称@URL...',
  'VOD_RETURN_MODE': 'VOD返回模式:all/fastest,默认all',
  'VOD_REQUEST_TIMEOUT': 'VOD请求超时时间(毫秒),默认10000',
  'BILIBILI_COOKIE': 'B站Cookie,用于获取完整弹幕数据',
  'TMDB_API_KEY': 'TMDB API密钥,用于标题转换',
  'SOURCE_ORDER': '数据源优先级排序',
  'PLATFORM_ORDER': '弹幕平台优先级',
  'TITLE_TO_CHINESE': '是否将外语标题转换成中文,默认false',
  'STRICT_TITLE_MATCH': '严格标题匹配模式,默认false',
  'EPISODE_TITLE_FILTER': '剧集标题正则过滤表达式',
  'ENABLE_EPISODE_FILTER': '手动选择接口是否启用集标题过滤,默认false',
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式:json/xml,默认json',
  'DANMU_SIMPLIFIED': '是否将繁体弹幕转换为简体,默认true',
  'DANMU_LIMIT': '弹幕数量限制,-1表示不限制',
  'BLOCKED_WORDS': '弹幕屏蔽词列表(逗号分隔)',
  'GROUP_MINUTE': '弹幕合并去重时间窗口(分钟),默认1',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '是否将顶部/底部弹幕转换为滚动弹幕,默认false',
  'WHITE_RATIO': '白色弹幕占比(0-100),-1表示不转换',
  'YOUKU_CONCURRENCY': '优酷弹幕请求并发数,默认8',
  'SEARCH_CACHE_MINUTES': '搜索结果缓存时间(分钟),默认1',
  'COMMENT_CACHE_MINUTES': '弹幕数据缓存时间(分钟),默认1',
  'REMEMBER_LAST_SELECT': '是否记住用户手动选择,默认true',
  'MAX_LAST_SELECT_MAP': '最后选择映射的缓存大小,默认100',
  'PROXY_URL': '代理/反代地址',
  'RATE_LIMIT_MAX_REQUESTS': '限流配置:同一IP在1分钟内允许的最大请求次数,默认3',
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
    log("info", "[init] 🚀 首次启动,初始化全局配置...");
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
          displayValue = value ? '<span class="badge badge-success">✓ 已启用</span>' : '<span class="badge badge-disabled">✗ 已禁用</span>';
        } else if (value === null || value === undefined || (typeof value === 'string' && value.length === 0)) {
          displayValue = '<span class="badge badge-default">未配置</span>';
        } else if (isSensitive && typeof value === 'string' && value.length > 0) {
          const realValue = getRealEnvValue(key);
          const maskedValue = '●'.repeat(Math.min(String(realValue).length, 16));
          const safeRealValue = typeof realValue === 'string' ? realValue : JSON.stringify(realValue);
          const encodedRealValue = safeRealValue
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

          return `
            <div class="env-card" data-key="${key}">
              <div class="env-card-header">
                <div class="env-title">
                  <svg class="env-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                  <span class="env-label">${key}</span>
                </div>
                <button class="icon-btn" onclick="editEnv('${key}')" title="编辑配置">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
              </div>
              <div class="env-value sensitive" data-real="${encodedRealValue}" onclick="toggleSensitive(this)">
                <span class="masked-text">${maskedValue}</span>
                <svg class="eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
              </div>
              <div class="env-description">${description}</div>
            </div>
          `;
        } else if (Array.isArray(value)) {
          displayValue = value.length > 0 ? `<span class="badge badge-primary">${value.length} 项</span>` : '<span class="badge badge-default">默认值</span>';
        } else if (typeof value === 'string' && value.length > 60) {
          displayValue = value.substring(0, 60) + '...';
        }

        const realValue = getRealEnvValue(key);
        const encodedOriginal = String(realValue || value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

        return `
          <div class="env-card" data-key="${key}">
            <div class="env-card-header">
              <div class="env-title">
                <svg class="env-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="16 18 22 12 16 6"></polyline>
                  <polyline points="8 6 2 12 8 18"></polyline>
                </svg>
                <span class="env-label">${key}</span>
              </div>
              <button class="icon-btn" onclick="editEnv('${key}')" title="编辑配置">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
            </div>
            <div class="env-value" data-original="${encodedOriginal}" ondblclick="copyValue(this)">
              ${displayValue}
            </div>
            <div class="env-description">${description}</div>
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
  <title>弹幕 API 控制面板</title>
  <style>
    :root {
      --primary: #6366f1;
      --primary-dark: #4f46e5;
      --primary-light: #818cf8;
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
      --bg-primary: #ffffff;
      --bg-secondary: #f8fafc;
      --bg-tertiary: #f1f5f9;
      --text-primary: #0f172a;
      --text-secondary: #64748b;
      --text-tertiary: #94a3b8;
      --border: #e2e8f0;
      --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
      --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
      --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);
      --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1);
      --radius: 12px;
      --radius-lg: 16px;
      --radius-sm: 8px;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 24px;
      color: var(--text-primary);
      line-height: 1.6;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      animation: fadeIn 0.5s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ========== 顶部导航 ========== */
    .navbar {
      background: var(--bg-primary);
      border-radius: var(--radius-lg);
      padding: 20px 28px;
      margin-bottom: 24px;
      box-shadow: var(--shadow-lg);
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(10px);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--primary), var(--primary-light));
      border-radius: var(--radius);
      display: flex;
      align-items: center;
     justify-content: center;
     font-size: 24px;
     box-shadow: var(--shadow);
   }

   .logo-text {
     display: flex;
     flex-direction: column;
   }

   .logo-title {
     font-size: 22px;
     font-weight: 700;
     color: var(--text-primary);
     letter-spacing: -0.5px;
   }

   .logo-subtitle {
     font-size: 13px;
     color: var(--text-secondary);
     font-weight: 500;
   }

   .nav-actions {
     display: flex;
     gap: 12px;
     align-items: center;
   }

   /* ========== 按钮样式 ========== */
   .btn {
     padding: 10px 20px;
     border: none;
     border-radius: var(--radius-sm);
     font-size: 14px;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
     display: inline-flex;
     align-items: center;
     gap: 8px;
     white-space: nowrap;
   }

   .btn-primary {
     background: linear-gradient(135deg, var(--primary), var(--primary-dark));
     color: white;
     box-shadow: var(--shadow);
   }

   .btn-primary:hover {
     transform: translateY(-2px);
     box-shadow: var(--shadow-lg);
   }

   .btn-primary:active {
     transform: translateY(0);
   }

   .btn-secondary {
     background: var(--bg-tertiary);
     color: var(--text-primary);
   }

   .btn-secondary:hover {
     background: var(--border);
   }

   .icon-btn {
     width: 36px;
     height: 36px;
     border: none;
     background: transparent;
     color: var(--text-secondary);
     cursor: pointer;
     border-radius: var(--radius-sm);
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.2s;
   }

   .icon-btn:hover {
     background: var(--bg-tertiary);
     color: var(--primary);
   }

   /* ========== 统计卡片 ========== */
   .stats-grid {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
     gap: 20px;
     margin-bottom: 24px;
   }

   .stat-card {
     background: var(--bg-primary);
     border-radius: var(--radius-lg);
     padding: 24px;
     box-shadow: var(--shadow-lg);
     transition: all 0.3s;
     position: relative;
     overflow: hidden;
   }

   .stat-card::before {
     content: '';
     position: absolute;
     top: 0;
     left: 0;
     right: 0;
     height: 4px;
     background: linear-gradient(90deg, var(--primary), var(--primary-light));
     transform: scaleX(0);
     transition: transform 0.3s;
   }

   .stat-card:hover::before {
     transform: scaleX(1);
   }

   .stat-card:hover {
     transform: translateY(-4px);
     box-shadow: var(--shadow-xl);
   }

   .stat-header {
     display: flex;
     align-items: center;
     gap: 12px;
     margin-bottom: 16px;
   }

   .stat-icon {
     width: 48px;
     height: 48px;
     border-radius: var(--radius);
     display: flex;
     align-items: center;
     justify-content: center;
     font-size: 24px;
     background: var(--bg-secondary);
   }

   .stat-icon.primary { background: rgba(99, 102, 241, 0.1); color: var(--primary); }
   .stat-icon.success { background: rgba(16, 185, 129, 0.1); color: var(--success); }
   .stat-icon.warning { background: rgba(245, 158, 11, 0.1); color: var(--warning); }
   .stat-icon.info { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }

   .stat-content {
     flex: 1;
   }

   .stat-label {
     font-size: 13px;
     color: var(--text-secondary);
     font-weight: 500;
     margin-bottom: 4px;
   }

   .stat-value {
     font-size: 28px;
     font-weight: 700;
     color: var(--text-primary);
     line-height: 1.2;
   }

   .stat-footer {
     margin-top: 12px;
     padding-top: 12px;
     border-top: 1px solid var(--border);
     font-size: 12px;
     color: var(--text-tertiary);
     display: flex;
     align-items: center;
     gap: 6px;
   }

   /* ========== 主内容区 ========== */
   .main-card {
     background: var(--bg-primary);
     border-radius: var(--radius-lg);
     padding: 28px;
     box-shadow: var(--shadow-lg);
   }

   .card-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 24px;
     padding-bottom: 20px;
     border-bottom: 2px solid var(--bg-secondary);
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
     color: var(--primary);
   }

   /* ========== 搜索框 ========== */
   .search-container {
     position: relative;
     margin-bottom: 24px;
   }

   .search-input {
     width: 100%;
     padding: 14px 48px 14px 48px;
     border: 2px solid var(--border);
     border-radius: var(--radius);
     font-size: 15px;
     transition: all 0.3s;
     background: var(--bg-secondary);
   }

   .search-input:focus {
     outline: none;
     border-color: var(--primary);
     background: var(--bg-primary);
     box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
   }

   .search-icon {
     position: absolute;
     left: 16px;
     top: 50%;
     transform: translateY(-50%);
     color: var(--text-tertiary);
     pointer-events: none;
   }

   .clear-search {
     position: absolute;
     right: 16px;
     top: 50%;
     transform: translateY(-50%);
     background: none;
     border: none;
     color: var(--text-tertiary);
     cursor: pointer;
     padding: 4px;
     display: none;
   }

   .clear-search:hover {
     color: var(--text-primary);
   }

   /* ========== 环境变量卡片网格 ========== */
   .env-grid {
     display: grid;
     grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
     gap: 20px;
   }

   .env-card {
     background: var(--bg-secondary);
     border: 2px solid var(--border);
     border-radius: var(--radius);
     padding: 20px;
     transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
     position: relative;
   }

   .env-card:hover {
     border-color: var(--primary);
     box-shadow: var(--shadow);
     transform: translateY(-2px);
   }

   .env-card-header {
     display: flex;
     justify-content: space-between;
     align-items: flex-start;
     margin-bottom: 12px;
   }

   .env-title {
     display: flex;
     align-items: center;
     gap: 10px;
     flex: 1;
   }

   .env-icon {
     color: var(--primary);
     flex-shrink: 0;
   }

   .env-label {
     font-weight: 600;
     color: var(--text-primary);
     font-size: 14px;
     word-break: break-word;
   }

   .env-value {
     padding: 12px 14px;
     background: var(--bg-primary);
     border-radius: var(--radius-sm);
     font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
     font-size: 13px;
     word-break: break-all;
     margin-bottom: 10px;
     color: var(--text-primary);
     border: 1px solid var(--border);
     transition: all 0.2s;
     min-height: 42px;
     display: flex;
     align-items: center;
   }

   .env-value:hover {
     border-color: var(--primary);
   }

   .env-value.sensitive {
     cursor: pointer;
     display: flex;
     justify-content: space-between;
     align-items: center;
     user-select: none;
   }

   .env-value.sensitive:hover {
     background: var(--bg-tertiary);
   }

   .masked-text {
     font-size: 16px;
     letter-spacing: 2px;
     color: var(--text-tertiary);
   }

   .eye-icon {
     color: var(--text-tertiary);
     transition: color 0.2s;
     flex-shrink: 0;
   }

   .env-value.sensitive:hover .eye-icon {
     color: var(--primary);
   }

   .env-description {
     font-size: 12px;
     color: var(--text-secondary);
     line-height: 1.5;
   }

   /* ========== 徽章 ========== */
   .badge {
     display: inline-flex;
     align-items: center;
     padding: 4px 10px;
     border-radius: 6px;
     font-size: 12px;
     font-weight: 600;
     white-space: nowrap;
   }

   .badge-success {
     background: rgba(16, 185, 129, 0.1);
     color: var(--success);
   }

   .badge-disabled {
     background: rgba(148, 163, 184, 0.1);
     color: var(--text-tertiary);
   }

   .badge-default {
     background: var(--bg-tertiary);
     color: var(--text-secondary);
   }

   .badge-primary {
     background: rgba(99, 102, 241, 0.1);
     color: var(--primary);
   }

   /* ========== 模态框 ========== */
   .modal {
     display: none;
     position: fixed;
     top: 0;
     left: 0;
     right: 0;
     bottom: 0;
     background: rgba(0, 0, 0, 0.6);
     backdrop-filter: blur(4px);
     align-items: center;
     justify-content: center;
     z-index: 1000;
     padding: 20px;
     animation: fadeIn 0.2s;
   }

   .modal.show {
     display: flex;
   }

   .modal-content {
     background: var(--bg-primary);
     border-radius: var(--radius-lg);
     padding: 32px;
     max-width: 540px;
     width: 100%;
     max-height: 85vh;
     overflow-y: auto;
     box-shadow: var(--shadow-xl);
     animation: slideUp 0.3s cubic-bezier(0.4, 0, 0.2, 1);
   }

   @keyframes slideUp {
     from { opacity: 0; transform: translateY(40px) scale(0.95); }
     to { opacity: 1; transform: translateY(0) scale(1); }
   }

   .modal-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 24px;
     padding-bottom: 16px;
     border-bottom: 2px solid var(--bg-secondary);
   }

   .modal-title {
     font-size: 20px;
     font-weight: 700;
     color: var(--text-primary);
     display: flex;
     align-items: center;
     gap: 10px;
   }

   .close-btn {
     width: 36px;
     height: 36px;
     background: var(--bg-secondary);
     border: none;
     border-radius: var(--radius-sm);
     font-size: 20px;
     cursor: pointer;
     color: var(--text-secondary);
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.2s;
   }

   .close-btn:hover {
     background: var(--border);
     color: var(--text-primary);
     transform: rotate(90deg);
   }

   .form-group {
     margin-bottom: 20px;
   }

   .form-label {
     display: block;
     font-size: 14px;
     font-weight: 600;
     margin-bottom: 8px;
     color: var(--text-primary);
   }

   .form-input, .form-textarea {
     width: 100%;
     padding: 12px 14px;
     border: 2px solid var(--border);
     border-radius: var(--radius-sm);
     font-size: 14px;
     font-family: inherit;
     transition: all 0.3s;
     background: var(--bg-secondary);
   }

   .form-textarea {
     min-height: 120px;
     font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
     resize: vertical;
   }

   .form-input:focus, .form-textarea:focus {
     outline: none;
     border-color: var(--primary);
     background: var(--bg-primary);
     box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
   }

   .form-hint {
     font-size: 12px;
     color: var(--text-secondary);
     margin-top: 6px;
     line-height: 1.5;
   }

   .modal-footer {
     display: flex;
     gap: 12px;
     justify-content: flex-end;
     margin-top: 28px;
     padding-top: 20px;
     border-top: 1px solid var(--border);
   }

   /* ========== Toast 通知 ========== */
   .toast {
     position: fixed;
     bottom: 24px;
     right: 24px;
     background: var(--bg-primary);
     border-radius: var(--radius);
     padding: 16px 20px;
     box-shadow: var(--shadow-xl);
     display: none;
     align-items: center;
     gap: 12px;
     z-index: 2000;
     min-width: 300px;
     max-width: 420px;
     animation: slideInRight 0.3s cubic-bezier(0.4, 0, 0.2, 1);
     border-left: 4px solid var(--primary);
   }

   @keyframes slideInRight {
     from { transform: translateX(400px); opacity: 0; }
     to { transform: translateX(0); opacity: 1; }
   }

   .toast.show {
     display: flex;
   }

   .toast-icon {
     flex-shrink: 0;
     width: 24px;
     height: 24px;
     display: flex;
     align-items: center;
     justify-content: center;
     border-radius: 50%;
   }

   .toast.success {
     border-left-color: var(--success);
   }

   .toast.success .toast-icon {
     background: rgba(16, 185, 129, 0.1);
     color: var(--success);
   }

   .toast.error {
     border-left-color: var(--error);
   }

   .toast.error .toast-icon {
     background: rgba(239, 68, 68, 0.1);
     color: var(--error);
   }

   .toast.info {
     border-left-color: #3b82f6;
   }

   .toast.info .toast-icon {
     background: rgba(59, 130, 246, 0.1);
     color: #3b82f6;
   }

   .toast-content {
     flex: 1;
     font-size: 14px;
     color: var(--text-primary);
     font-weight: 500;
   }

   /* ========== 响应式设计 ========== */
   @media (max-width: 768px) {
     body {
       padding: 12px;
     }

     .navbar {
       flex-direction: column;
       gap: 16px;
       padding: 20px;
     }

     .logo {
       width: 100%;
     }

     .nav-actions {
       width: 100%;
       justify-content: stretch;
     }

     .nav-actions .btn {
       flex: 1;
     }

     .stats-grid {
       grid-template-columns: 1fr;
     }

     .env-grid {
       grid-template-columns: 1fr;
     }

     .main-card {
       padding: 20px;
     }

     .card-header {
       flex-direction: column;
       gap: 16px;
       align-items: flex-start;
     }

     .modal-content {
       padding: 24px;
       margin: 0 12px;
     }

     .toast {
       left: 12px;
       right: 12px;
       bottom: 12px;
     }
   }

   /* ========== 滚动条美化 ========== */
   ::-webkit-scrollbar {
     width: 8px;
     height: 8px;
   }

   ::-webkit-scrollbar-track {
     background: var(--bg-secondary);
     border-radius: 4px;
   }

   ::-webkit-scrollbar-thumb {
     background: var(--border);
     border-radius: 4px;
   }

   ::-webkit-scrollbar-thumb:hover {
     background: var(--text-tertiary);
   }

   /* ========== 加载动画 ========== */
   .loading {
     display: inline-block;
     width: 16px;
     height: 16px;
     border: 2px solid rgba(255, 255, 255, 0.3);
     border-top-color: white;
     border-radius: 50%;
     animation: spin 0.6s linear infinite;
   }

   @keyframes spin {
     to { transform: rotate(360deg); }
   }
 </style>
</head>
<body>
 <div class="container">
   <!-- 顶部导航 -->
   <nav class="navbar">
     <div class="logo">
       <div class="logo-icon">🎬</div>
       <div class="logo-text">
         <div class="logo-title">弹幕 API 控制面板</div>
         <div class="logo-subtitle">环境配置管理系统</div>
       </div>
     </div>
     <div class="nav-actions">
       <button class="btn btn-secondary" onclick="changePassword()">
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
           <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
         </svg>
         修改密码
       </button>
       <button class="btn btn-secondary" onclick="logout()">
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
           <polyline points="16 17 21 12 16 7"></polyline>
           <line x1="21" y1="12" x2="9" y2="12"></line>
         </svg>
         退出登录
       </button>
     </div>
   </nav>

   <!-- 统计卡片 -->
   <div class="stats-grid">
     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon primary">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <polyline points="16 18 22 12 16 6"></polyline>
             <polyline points="8 6 2 12 8 18"></polyline>
           </svg>
         </div>
         <div class="stat-content">
           <div class="stat-label">环境变量配置</div>
           <div class="stat-value">${configuredEnvCount}/${totalEnvCount}</div>
         </div>
       </div>
       <div class="stat-footer">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="20 6 9 17 4 12"></polyline>
         </svg>
         已配置 ${configuredEnvCount} 个变量
       </div>
     </div>
     
     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon success">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
             <line x1="8" y1="21" x2="16" y2="21"></line>
             <line x1="12" y1="17" x2="12" y2="21"></line>
           </svg>
         </div>
         <div class="stat-content">
           <div class="stat-label">持久化存储</div>
           <div class="stat-value">${
             globals.databaseValid ? '数据库' : 
             (redisConfigured && globals.redisValid) ? 'Redis' : 
             '内存'
           }</div>
         </div>
       </div>
       <div class="stat-footer">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           ${
             globals.databaseValid || (redisConfigured && globals.redisValid) ? 
             '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>' : 
             '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>'
           }
         </svg>
         ${
           globals.databaseValid ? '数据库在线' : 
           (redisConfigured && globals.redisValid) ? 'Redis 连接正常' : 
           '仅使用内存缓存'
         }
       </div>
     </div>

     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon warning">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
             <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
             <line x1="12" y1="22.08" x2="12" y2="12"></line>
           </svg>
         </div>
         <div class="stat-content">
           <div class="stat-label">弹幕数据源</div>
           <div class="stat-value">${globals.sourceOrderArr.length || 7}</div>
         </div>
       </div>
       <div class="stat-footer">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="9 11 12 14 22 4"></polyline>
           <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
         </svg>
         ${globals.sourceOrderArr.length > 0 ? `优先使用 ${globals.sourceOrderArr[0]}` : '使用默认优先级'}
       </div>
     </div>

     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon info">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <circle cx="12" cy="12" r="10"></circle>
             <polyline points="12 6 12 12 16 14"></polyline>
           </svg>
         </div>
         <div class="stat-content">
           <div class="stat-label">服务状态</div>
           <div class="stat-value">运行中</div>
         </div>
       </div>
       <div class="stat-footer">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
           <polyline points="22 4 12 14.01 9 11.01"></polyline>
         </svg>
         版本 ${globals.VERSION}
       </div>
     </div>
   </div>

   <!-- 主内容区 -->
   <div class="main-card">
     <div class="card-header">
       <div class="card-title">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
           <circle cx="12" cy="12" r="3"></circle>
         </svg>
         环境变量配置
       </div>
       <button class="btn btn-primary" onclick="saveAll()">
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
           <polyline points="17 21 17 13 7 13 7 21"></polyline>
           <polyline points="7 3 7 8 15 8"></polyline>
         </svg>
         保存全部配置
       </button>
     </div>
     
     <div class="search-container">
       <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <circle cx="11" cy="11" r="8"></circle>
         <path d="m21 21-4.35-4.35"></path>
       </svg>
       <input 
         type="text"
         class="search-input" 
         placeholder="搜索环境变量名称、值或描述..." 
         id="searchInput" 
         oninput="filterEnvs()"
       >
       <button class="clear-search" id="clearSearch" onclick="clearSearch()">
         <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <circle cx="12" cy="12" r="10"></circle>
           <line x1="15" y1="9" x2="9" y2="15"></line>
           <line x1="9" y1="9" x2="15" y2="15"></line>
         </svg>
       </button>
     </div>

     <div class="env-grid" id="envGrid">
       ${envItemsHtml}
     </div>
   </div>
 </div>

 <!-- 编辑环境变量弹窗 -->
 <div class="modal" id="editModal">
   <div class="modal-content">
     <div class="modal-header">
       <h3 class="modal-title">
         <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
           <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
         </svg>
         编辑环境变量
       </h3>
       <button class="close-btn" onclick="closeModal()">×</button>
     </div>
     <div class="form-group">
       <label class="form-label">变量名称</label>
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
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
       <h3 class="modal-title">
         <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
           <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
         </svg>
         修改登录密码
       </h3>
       <button class="close-btn" onclick="closePasswordModal()">×</button>
     </div>
     <div class="form-group">
       <label class="form-label">新用户名（可选）</label>
       <input type="text" class="form-input" id="newUsername" placeholder="留空则保持不变">
     </div>
     <div class="form-group">
       <label class="form-label">当前密码</label>
       <input type="password" class="form-input" id="oldPassword" placeholder="请输入当前密码" required>
     </div>
     <div class="form-group">
       <label class="form-label">新密码</label>
       <input type="password" class="form-input" id="newPassword" placeholder="至少4个字符" required>
     </div>
     <div class="form-group">
       <label class="form-label">确认新密码</label>
       <input type="password" class="form-input" id="confirmPassword" placeholder="再次输入新密码" required>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closePasswordModal()">取消</button>
       <button class="btn btn-primary" onclick="submitPasswordChange()">
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <polyline points="20 6 9 17 4 12"></polyline>
         </svg>
         确认修改
       </button>
     </div>
   </div>
 </div>

 <!-- Toast 通知 -->
 <div class="toast" id="toast">
   <div class="toast-icon"></div>
   <div class="toast-content"></div>
 </div>

 <script>
   const AppState = {
     currentEditingKey: null,
     config: ${JSON.stringify(globals.accessedEnvVars)}
   };

   const ENV_DESCRIPTIONS = ${JSON.stringify(ENV_DESCRIPTIONS)};

   function showToast(message, type = 'info') {
     const toast = document.getElementById('toast');
     const icon = toast.querySelector('.toast-icon');
     const content = toast.querySelector('.toast-content');
     
     content.textContent = message;
     toast.className = 'toast show ' + type;
     
     // 设置图标
     if (type === 'success') {
       icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
     } else if (type === 'error') {
       icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
     } else {
       icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
     }
     
     setTimeout(() => {
       toast.classList.remove('show');
     }, 3500);
   }

   function toggleSensitive(element) {
     const real = element.dataset.real;
     const maskedText = element.querySelector('.masked-text');
     
     if (maskedText && maskedText.textContent.includes('●')) {
       const textarea = document.createElement('textarea');
       textarea.innerHTML = real;
       const actualValue = textarea.value;
       
       maskedText.textContent = actualValue;
       maskedText.style.letterSpacing = 'normal';
       maskedText.style.fontSize = '13px';
       
       setTimeout(() => {
         maskedText.textContent = '●'.repeat(Math.min(actualValue.length, 16));
         maskedText.style.letterSpacing = '2px';
         maskedText.style.fontSize = '16px';
       }, 3000);
     }
   }

   function editEnv(key) {
     AppState.currentEditingKey = key;
     document.getElementById('editKey').value = key;
     
     let currentValue = AppState.config[key];
     if (currentValue === null || currentValue === undefined) {
       currentValue = '';
     } else if (typeof currentValue === 'boolean') {
       currentValue = currentValue.toString();
     } else if (Array.isArray(currentValue)) {
       currentValue = currentValue.join(', ');
     }
     
     document.getElementById('editValue').value = currentValue;
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
     
     const saveBtn = document.querySelector('#editModal .btn-primary');
     const originalText = saveBtn.innerHTML;
     saveBtn.disabled = true;
     saveBtn.innerHTML = '<div class="loading"></div> 保存中...';
     
     try {
       AppState.config[key] = value;
       
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: { [key]: value } })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('配置保存成功！', 'success');
         updateEnvDisplay(key, value);
         closeModal();
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('网络错误: ' + error.message, 'error');
     } finally {
       saveBtn.disabled = false;
       saveBtn.innerHTML = originalText;
     }
   }

   async function saveAll() {
     const saveBtn = document.querySelector('.card-header .btn-primary');
     const originalText = saveBtn.innerHTML;
     saveBtn.disabled = true;
     saveBtn.innerHTML = '<div class="loading"></div> 保存中...';
     
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: AppState.config })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('所有配置已成功保存！', 'success');
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('网络错误: ' + error.message, 'error');
     } finally {
       saveBtn.disabled = false;
       saveBtn.innerHTML = originalText;
     }
   }

   function updateEnvDisplay(key, value) {
     const card = document.querySelector(\`.env-card[data-key="\${key}"]\`);
     if (!card) return;
     
     const valueEl = card.querySelector('.env-value');
     if (!valueEl) return;
     
     let displayValue;
     if (typeof value === 'boolean' || value === 'true' || value === 'false') {
       const boolValue = value === true || value === 'true';
       displayValue = boolValue 
         ? '<span class="badge badge-success">✓ 已启用</span>' 
         : '<span class="badge badge-disabled">✗ 已禁用</span>';
     } else if (!value || value === '') {
       displayValue = '<span class="badge badge-default">未配置</span>';
     } else if (value.length > 60) {
       displayValue = value.substring(0, 60) + '...';
     } else {
       displayValue = value;
     }
     
     valueEl.innerHTML = displayValue;
     
     // 添加更新动画
     card.style.animation = 'none';
     setTimeout(() => {
       card.style.animation = 'fadeIn 0.3s ease-out';
     }, 10);
   }

   function copyValue(element) {
     const original = element.dataset.original;
     if (!original) return;
     
     const textarea = document.createElement('textarea');
     textarea.innerHTML = original;
     const text = textarea.value;
     
     if (navigator.clipboard && navigator.clipboard.writeText) {
       navigator.clipboard.writeText(text).then(() => {
         showToast('已复制到剪贴板', 'success');
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
       showToast('已复制到剪贴板', 'success');
     } catch (err) {
       showToast('复制失败', 'error');
     }
     document.body.removeChild(temp);
   }

   function filterEnvs() {
     const query = document.getElementById('searchInput').value.toLowerCase();
     const clearBtn = document.getElementById('clearSearch');
     const cards = document.querySelectorAll('.env-card');
     
     clearBtn.style.display = query ? 'block' : 'none';
     
     let visibleCount = 0;
     cards.forEach(card => {
       const label = card.querySelector('.env-label').textContent.toLowerCase();
       const value = card.querySelector('.env-value').textContent.toLowerCase();
       const desc = card.querySelector('.env-description').textContent.toLowerCase();
       
       if (label.includes(query) || value.includes(query) || desc.includes(query)) {
         card.style.display = '';
         visibleCount++;
       } else {
         card.style.display = 'none';
       }
     });
     
     // 如果没有结果，显示提示
     const grid = document.getElementById('envGrid');
     let noResultsMsg = document.getElementById('noResultsMsg');
     
     if (visibleCount === 0 && query) {
       if (!noResultsMsg) {
         noResultsMsg = document.createElement('div');
         noResultsMsg.id = 'noResultsMsg';
         noResultsMsg.style.cssText = 'grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--text-secondary);';
         noResultsMsg.innerHTML = \`
           <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin: 0 auto 16px; opacity: 0.3;">
             <circle cx="11" cy="11" r="8"></circle>
             <path d="m21 21-4.35-4.35"></path>
             <line x1="11" y1="8" x2="11" y2="14"></line>
             <line x1="11" y1="16" x2="11.01" y2="16"></line>
           </svg>
           <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">未找到匹配的配置项</div>
           <div style="font-size: 14px;">尝试使用其他关键词搜索</div>
         \`;
         grid.appendChild(noResultsMsg);
       }
     } else if (noResultsMsg) {
       noResultsMsg.remove();
     }
   }

   function clearSearch() {
     document.getElementById('searchInput').value = '';
     filterEnvs();
     document.getElementById('searchInput').focus();
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
       showToast('请输入当前密码', 'error');
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
     
     const submitBtn = document.querySelector('#passwordModal .btn-primary');
     const originalText = submitBtn.innerHTML;
     submitBtn.disabled = true;
     submitBtn.innerHTML = '<div class="loading"></div> 修改中...';
     
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
         showToast('密码修改成功，请重新登录', 'success');
         closePasswordModal();
         setTimeout(() => logout(), 1500);
       } else {
         showToast(result.message || '修改失败，请检查当前密码', 'error');
       }
     } catch (error) {
       showToast('网络错误: ' + error.message, 'error');
     } finally {
       submitBtn.disabled = false;
       submitBtn.innerHTML = originalText;
     }
   }

   async function logout() {
     try {
       await fetch('/api/logout', { method: 'POST' });
       showToast('正在退出...', 'info');
       setTimeout(() => {
         window.location.href = '/';
       }, 800);
     } catch (error) {
       showToast('退出失败', 'error');
     }
   }

   // 快捷键支持
   document.addEventListener('keydown', (e) => {
     // Ctrl/Cmd + S 保存
     if ((e.ctrlKey || e.metaKey) && e.key === 's') {
       e.preventDefault();
       if (document.getElementById('editModal').classList.contains('show')) {
         saveEnv();
       } else {
         saveAll();
       }
     }
     
     // ESC 关闭弹窗
     if (e.key === 'Escape') {
       closeModal();
       closePasswordModal();
     }
     
     // Ctrl/Cmd + K 聚焦搜索框
     if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
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
         
         const sources = result.loadedFrom.join('、');
         showToast(\`配置已从 \${sources} 加载\`, 'success');
       }
     } catch (error) {
       console.error('加载配置失败:', error);
       showToast('配置加载失败', 'error');
     }
   }

   // 页面加载完成后执行
   window.addEventListener('DOMContentLoaded', () => {
     loadConfig();
     
     // 添加输入框回车事件
     const editValue = document.getElementById('editValue');
     editValue.addEventListener('keydown', (e) => {
       if (e.ctrlKey && e.key === 'Enter') {
         saveEnv();
       }
     });
     
     // 搜索框快捷键
     const searchInput = document.getElementById('searchInput');
     searchInput.addEventListener('keydown', (e) => {
       if (e.key === 'Escape') {
         clearSearch();
       }
     });
   });

   // 防止意外离开页面
   let hasUnsavedChanges = false;
   
   window.addEventListener('beforeunload', (e) => {
     if (hasUnsavedChanges) {
       e.preventDefault();
       e.returnValue = '有未保存的更改，确定要离开吗？';
     }
   });

   // 监听配置变化
   const originalSaveEnv = saveEnv;
   saveEnv = function() {
     hasUnsavedChanges = true;
     originalSaveEnv();
   };
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
     --primary: #6366f1;
     --primary-dark: #4f46e5;
     --primary-light: #818cf8;
     --error: #ef4444;
     --bg-primary: #ffffff;
     --bg-secondary: #f8fafc;
     --text-primary: #0f172a;
     --text-secondary: #64748b;
     --border: #e2e8f0;
     --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);
     --radius: 12px;
   }

   * { margin: 0; padding: 0; box-sizing: border-box; }
   
   body {
     font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
     background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
     min-height: 100vh;
     display: flex;
     align-items: center;
     justify-content: center;
     padding: 20px;
   }

   .login-container {
     background: var(--bg-primary);
     border-radius: 20px;
     padding: 48px 40px;
     width: 100%;
     max-width: 440px;
     box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
     animation: slideUp 0.5s cubic-bezier(0.4, 0, 0.2, 1);
   }

   @keyframes slideUp {
     from { opacity: 0; transform: translateY(30px); }
     to { opacity: 1; transform: translateY(0); }
   }

   .logo-section {
     text-align: center;
     margin-bottom: 40px;
   }

   .logo-icon {
     width: 72px;
     height: 72px;
     background: linear-gradient(135deg, var(--primary), var(--primary-light));
     border-radius: 18px;
     display: inline-flex;
     align-items: center;
     justify-content: center;
     font-size: 36px;
     margin-bottom: 20px;
     box-shadow: 0 8px 16px rgba(99, 102, 241, 0.3);
     animation: float 3s ease-in-out infinite;
   }

   @keyframes float {
     0%, 100% { transform: translateY(0); }
     50% { transform: translateY(-10px); }
   }

   .logo-title {
     font-size: 26px;
     font-weight: 700;
     color: var(--text-primary);
     margin-bottom: 8px;
     letter-spacing: -0.5px;
   }

   .logo-subtitle {
     font-size: 14px;
     color: var(--text-secondary);
     font-weight: 500;
   }

   .info-banner {
     background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(129, 140, 248, 0.1));
     border-left: 4px solid var(--primary);
     padding: 16px 20px;
     border-radius: var(--radius);
     margin-bottom: 28px;
     font-size: 13px;
     color: var(--text-primary);
     display: flex;
     align-items: center;
     gap: 12px;
   }

   .info-icon {
     flex-shrink: 0;
     color: var(--primary);
   }

   .error-message {
     background: rgba(239, 68, 68, 0.1);
     border-left: 4px solid var(--error);
     color: #991b1b;
     padding: 14px 20px;
     border-radius: var(--radius);
     margin-bottom: 20px;
     font-size: 13px;
     display: none;
     animation: shake 0.4s;
   }

   @keyframes shake {
     0%, 100% { transform: translateX(0); }
     25% { transform: translateX(-10px); }
     75% { transform: translateX(10px); }
   }

   .form-group {
     margin-bottom: 20px;
   }

   .form-label {
     display: block;
     font-size: 14px;
     font-weight: 600;
     margin-bottom: 8px;
     color: var(--text-primary);
   }

   .input-wrapper {
     position: relative;
   }

   .input-icon {
     position: absolute;
     left: 14px;
     top: 50%;
     transform: translateY(-50%);
     color: var(--text-secondary);
     pointer-events: none;
   }

   .form-input {
     width: 100%;
     padding: 13px 16px 13px 44px;
     border: 2px solid var(--border);
     border-radius: var(--radius);
     font-size: 15px;
     transition: all 0.3s;
     background: var(--bg-secondary);
   }

   .form-input:focus {
     outline: none;
     border-color: var(--primary);
     background: var(--bg-primary);
     box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
   }

   .form-input:focus + .input-icon {
     color: var(--primary);
   }

   .btn-login {
     width: 100%;
     padding: 14px;
     background: linear-gradient(135deg, var(--primary), var(--primary-dark));
     color: white;
     border: none;
     border-radius: var(--radius);
     font-size: 16px;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.3s;
     display: flex;
     align-items: center;
     justify-content: center;
     gap: 8px;
     margin-top: 28px;
   }

   .btn-login:hover {
     transform: translateY(-2px);
     box-shadow: 0 12px 24px rgba(99, 102, 241, 0.3);
   }

   .btn-login:active {
     transform: translateY(0);
   }

   .btn-login:disabled {
     opacity: 0.6;
     cursor: not-allowed;
     transform: none;
   }

   .footer-text {
     text-align: center;
     margin-top: 28px;
     font-size: 12px;
     color: var(--text-secondary);
   }

   .loading-spinner {
     display: inline-block;
     width: 16px;
     height: 16px;
     border: 2px solid rgba(255, 255, 255, 0.3);
     border-top-color: white;
     border-radius: 50%;
     animation: spin 0.6s linear infinite;
   }

   @keyframes spin {
     to { transform: rotate(360deg); }
   }

   @media (max-width: 480px) {
     .login-container {
       padding: 40px 28px;
     }
   }
 </style>
</head>
<body>
 <div class="login-container">
   <div class="logo-section">
     <div class="logo-icon">🎬</div>
     <h1 class="logo-title">弹幕 API</h1>
     <p class="logo-subtitle">管理控制面板</p>
   </div>

   <div class="info-banner">
     <svg class="info-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
       <circle cx="12" cy="12" r="10"></circle>
       <line x1="12" y1="16" x2="12" y2="12"></line>
       <line x1="12" y1="8" x2="12.01" y2="8"></line>
     </svg>
     <span>默认用户名和密码均为 <strong>admin</strong></span>
   </div>

   <div id="errorMessage" class="error-message"></div>

   <form id="loginForm">
     <div class="form-group">
       <label class="form-label">用户名</label>
       <div class="input-wrapper">
         <input type="text" class="form-input" id="username" placeholder="请输入用户名" required autocomplete="username">
         <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
           <circle cx="12" cy="7" r="4"></circle>
         </svg>
       </div>
     </div>

     <div class="form-group">
       <label class="form-label">密码</label>
       <div class="input-wrapper">
         <input type="password" class="form-input" id="password" placeholder="请输入密码" required autocomplete="current-password">
         <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
           <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
         </svg>
       </div>
     </div>

     <button type="submit" class="btn-login" id="loginBtn">
       <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
         <polyline points="10 17 15 12 10 7"></polyline>
         <line x1="15" y1="12" x2="3" y2="12"></line>
       </svg>
       登录
     </button>
   </form>

   <div class="footer-text">
     © 2024 弹幕 API 服务 | 安全登录系统
   </div>
 </div>

 <script>
   const loginForm = document.getElementById('loginForm');
   const errorMessage = document.getElementById('errorMessage');
   const loginBtn = document.getElementById('loginBtn');
   const usernameInput = document.getElementById('username');
   const passwordInput = document.getElementById('password');

   loginForm.addEventListener('submit', async (e) => {
     e.preventDefault();
     
     const username = usernameInput.value.trim();
     const password = passwordInput.value;

     if (!username || !password) {
       showError('请输入用户名和密码');
       return;
     }

     errorMessage.style.display = 'none';
     loginBtn.disabled = true;
     loginBtn.innerHTML = '<div class="loading-spinner"></div> 登录中...';

     try {
       const response = await fetch('/api/login', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ username, password })
       });

       const result = await response.json();

       if (result.success) {
         loginBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> 登录成功';
         setTimeout(() => {
           window.location.href = '/';
         }, 500);
       } else {
         showError(result.message || '用户名或密码错误');
         loginBtn.disabled = false;
         resetLoginButton();
       }
     } catch (error) {
       showError('网络错误，请检查连接后重试');
       loginBtn.disabled = false;
       resetLoginButton();
     }
   });

   function showError(message) {
     errorMessage.textContent = message;
     errorMessage.style.display = 'block';
     passwordInput.value = '';
     passwordInput.focus();
   }

   function resetLoginButton() {
     setTimeout(() => {
       loginBtn.innerHTML = \`
         <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
           <polyline points="10 17 15 12 10 7"></polyline>
           <line x1="15" y1="12" x2="3" y2="12"></line>
         </svg>
         登录
       \`;
     }, 300);
   }

   // 回车键登录
   passwordInput.addEventListener('keypress', (e) => {
     if (e.key === 'Enter') {
       loginForm.dispatchEvent(new Event('submit'));
     }
   });

   // 自动聚焦
   window.addEventListener('DOMContentLoaded', () => {
     usernameInput.focus();
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

