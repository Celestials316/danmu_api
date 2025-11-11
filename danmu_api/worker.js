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

    // 环境变量列表生成(用于设置页面)
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
            <div class="env-item" data-key="${key}">
              <div class="env-header">
                <span class="env-label">${key}</span>
                <button class="edit-btn" onclick="editEnv('${key}')" title="编辑">✏️</button>
              </div>
              <div class="env-value sensitive" data-real="${encodedRealValue}" data-masked="${maskedValue}" onclick="toggleSensitive(this)" ondblclick="copySensitiveValue(this, event)">
                ${maskedValue} <span class="eye-icon">👁️</span>
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

        return `
          <div class="env-item" data-key="${key}">
            <div class="env-header">
              <span class="env-label">${key}</span>
              <button class="edit-btn" onclick="editEnv('${key}')" title="编辑">✏️</button>
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
  <title>弹幕 API 控制中心</title>
  <style>
    :root {
      --bg-primary: #f5f7fa;
      --bg-secondary: #ffffff;
      --bg-tertiary: #f8fafc;
      --text-primary: #1a202c;
      --text-secondary: #4a5568;
      --text-tertiary: #718096;
      --border-color: #e2e8f0;
      --accent-primary: #667eea;
      --accent-secondary: #764ba2;
      --accent-success: #48bb78;
      --accent-warning: #ed8936;
      --accent-danger: #f56565;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
      --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
      --sidebar-width: 260px;
    }

    [data-theme="dark"] {
      --bg-primary: #1a202c;
      --bg-secondary: #2d3748;
      --bg-tertiary: #4a5568;
      --text-primary: #f7fafc;
      --text-secondary: #e2e8f0;
      --text-tertiary: #cbd5e1;
      --border-color: #4a5568;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
      --shadow-md: 0 4px 6px rgba(0,0,0,0.3);
      --shadow-lg: 0 10px 15px rgba(0,0,0,0.4);
    }

    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box; 
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      transition: all 0.3s ease;
    }

    /* 侧边栏 */
    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: var(--sidebar-width);
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      padding: 24px 0;
      overflow-y: auto;
      z-index: 100;
      transition: transform 0.3s ease;
    }

    .sidebar.hidden {
      transform: translateX(-100%);
    }

    .logo-section {
      padding: 0 20px 24px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 20px;
    }

    .logo-container {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      font-size: 32px;
    }

    .logo-text h1 {
      font-size: 18px;
      font-weight: 700;
      background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo-text p {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 2px;
    }

    .nav-menu {
      list-style: none;
      padding: 0 12px;
    }

    .nav-item {
      margin-bottom: 4px;
    }

    .nav-link {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 8px;
      color: var(--text-secondary);
      text-decoration: none;
      transition: all 0.2s ease;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }

    .nav-link:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .nav-link.active {
      background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
      color: white;
      box-shadow: var(--shadow-sm);
    }

    .nav-icon {
      font-size: 20px;
      width: 24px;
      text-align: center;
    }

    /* 主内容区 */
    .main-content {
      margin-left: var(--sidebar-width);
      min-height: 100vh;
      transition: margin-left 0.3s ease;
    }

    .main-content.expanded {
      margin-left: 0;
    }

    .top-bar {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 16px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 90;
     box-shadow: var(--shadow-sm);
   }

   .top-bar-left {
     display: flex;
     align-items: center;
     gap: 16px;
   }

   .menu-toggle {
     width: 40px;
     height: 40px;
     border: none;
     background: var(--bg-tertiary);
     border-radius: 8px;
     cursor: pointer;
     font-size: 20px;
     display: none;
     align-items: center;
     justify-content: center;
     transition: all 0.2s ease;
   }

   .menu-toggle:hover {
     background: var(--border-color);
   }

   .page-title {
     font-size: 20px;
     font-weight: 700;
     color: var(--text-primary);
   }

   .top-bar-actions {
     display: flex;
     gap: 12px;
     align-items: center;
   }

   .theme-toggle {
     width: 40px;
     height: 40px;
     border-radius: 8px;
     border: 1px solid var(--border-color);
     background: var(--bg-tertiary);
     color: var(--text-primary);
     cursor: pointer;
     font-size: 18px;
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.3s ease;
   }

   .theme-toggle:hover {
     transform: scale(1.05);
     background: var(--accent-primary);
     color: white;
     border-color: var(--accent-primary);
   }

   .btn {
     padding: 10px 20px;
     border: none;
     border-radius: 8px;
     font-size: 14px;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.3s ease;
     display: flex;
     align-items: center;
     gap: 8px;
   }

   .btn-primary {
     background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
     color: white;
     box-shadow: var(--shadow-sm);
   }

   .btn-primary:hover {
     transform: translateY(-2px);
     box-shadow: var(--shadow-md);
   }

   .btn-secondary {
     background: var(--bg-tertiary);
     color: var(--text-primary);
     border: 1px solid var(--border-color);
   }

   .btn-secondary:hover {
     background: var(--border-color);
   }

   .btn-sm {
     padding: 8px 16px;
     font-size: 13px;
   }

   /* 内容容器 */
   .container {
     padding: 28px;
     max-width: 1600px;
   }

   /* 统计卡片 */
   .stats-grid {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
     gap: 20px;
     margin-bottom: 28px;
   }

   .stat-card {
     background: var(--bg-secondary);
     border-radius: 12px;
     padding: 24px;
     box-shadow: var(--shadow-md);
     border: 1px solid var(--border-color);
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
     background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
   }

   .stat-card:hover {
     transform: translateY(-4px);
     box-shadow: var(--shadow-lg);
   }

   .stat-card.success::before {
     background: linear-gradient(90deg, #48bb78, #38a169);
   }

   .stat-card.warning::before {
     background: linear-gradient(90deg, #ed8936, #dd6b20);
   }

   .stat-card.info::before {
     background: linear-gradient(90deg, #4299e1, #3182ce);
   }

   .stat-header {
     display: flex;
     justify-content: space-between;
     align-items: flex-start;
     margin-bottom: 16px;
   }

   .stat-icon {
     font-size: 36px;
     opacity: 0.9;
   }

   .stat-badge {
     padding: 4px 12px;
     border-radius: 12px;
     font-size: 11px;
     font-weight: 600;
     text-transform: uppercase;
   }

   .badge-success {
     background: rgba(72, 187, 120, 0.1);
     color: var(--accent-success);
   }

   .badge-warning {
     background: rgba(237, 137, 54, 0.1);
     color: var(--accent-warning);
   }

   .badge-danger {
     background: rgba(245, 101, 101, 0.1);
     color: var(--accent-danger);
   }

   .stat-title {
     font-size: 13px;
     color: var(--text-tertiary);
     margin-bottom: 8px;
     font-weight: 500;
   }

   .stat-value {
     font-size: 32px;
     font-weight: 700;
     color: var(--text-primary);
     margin-bottom: 8px;
   }

   .stat-footer {
     font-size: 12px;
     color: var(--text-secondary);
     display: flex;
     align-items: center;
     gap: 6px;
   }

   /* 卡片布局 */
   .card {
     background: var(--bg-secondary);
     border-radius: 12px;
     padding: 24px;
     box-shadow: var(--shadow-md);
     border: 1px solid var(--border-color);
     margin-bottom: 24px;
   }

   .card-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 24px;
     padding-bottom: 16px;
     border-bottom: 1px solid var(--border-color);
   }

   .card-title {
     font-size: 18px;
     font-weight: 700;
     color: var(--text-primary);
     display: flex;
     align-items: center;
     gap: 10px;
   }

   .card-title-icon {
     font-size: 22px;
   }

   /* 快速设置项 */
   .quick-settings {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
     gap: 20px;
   }

   .setting-item {
     background: var(--bg-tertiary);
     border-radius: 10px;
     padding: 20px;
     border: 1px solid var(--border-color);
     transition: all 0.3s ease;
   }

   .setting-item:hover {
     border-color: var(--accent-primary);
     box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
   }

   .setting-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 12px;
   }

   .setting-label {
     font-weight: 600;
     color: var(--text-primary);
     font-size: 14px;
   }

   .setting-control {
     display: flex;
     align-items: center;
     gap: 12px;
     margin-bottom: 8px;
   }

   .setting-input {
     flex: 1;
     padding: 10px 14px;
     border: 1px solid var(--border-color);
     border-radius: 8px;
     font-size: 14px;
     background: var(--bg-secondary);
     color: var(--text-primary);
     transition: all 0.3s ease;
   }

   .setting-input:focus {
     outline: none;
     border-color: var(--accent-primary);
     box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
   }

   .setting-input[type="range"] {
     height: 6px;
     background: var(--border-color);
     border-radius: 3px;
     outline: none;
     -webkit-appearance: none;
   }

   .setting-input[type="range"]::-webkit-slider-thumb {
     -webkit-appearance: none;
     width: 18px;
     height: 18px;
     background: var(--accent-primary);
     border-radius: 50%;
     cursor: pointer;
     box-shadow: 0 2px 4px rgba(0,0,0,0.2);
   }

   .setting-input[type="range"]::-moz-range-thumb {
     width: 18px;
     height: 18px;
     background: var(--accent-primary);
     border-radius: 50%;
     cursor: pointer;
     border: none;
     box-shadow: 0 2px 4px rgba(0,0,0,0.2);
   }

   .setting-value {
     min-width: 60px;
     padding: 8px 12px;
     background: var(--accent-primary);
     color: white;
     border-radius: 6px;
     text-align: center;
     font-weight: 600;
     font-size: 13px;
   }

   .setting-desc {
     font-size: 12px;
     color: var(--text-tertiary);
     line-height: 1.5;
   }

   /* 切换开关 */
   .switch {
     position: relative;
     width: 48px;
     height: 26px;
     background: var(--border-color);
     border-radius: 13px;
     cursor: pointer;
     transition: all 0.3s ease;
   }

   .switch.active {
     background: var(--accent-success);
   }

   .switch::after {
     content: '';
     position: absolute;
     top: 3px;
     left: 3px;
     width: 20px;
     height: 20px;
     background: white;
     border-radius: 50%;
     transition: all 0.3s ease;
     box-shadow: 0 2px 4px rgba(0,0,0,0.2);
   }

   .switch.active::after {
     left: 25px;
   }

   /* 环境变量网格 */
   .env-grid {
     display: grid;
     gap: 16px;
   }

   .env-item {
     border: 1px solid var(--border-color);
     border-radius: 10px;
     padding: 18px;
     transition: all 0.3s ease;
     background: var(--bg-tertiary);
   }

   .env-item:hover {
     border-color: var(--accent-primary);
     box-shadow: 0 4px 12px rgba(102, 126, 234, 0.1);
     transform: translateX(4px);
   }

   .env-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 12px;
   }

   .env-label {
     font-weight: 600;
     color: var(--accent-primary);
     font-size: 13px;
     font-family: 'Courier New', monospace;
   }

   .edit-btn {
     background: none;
     border: none;
     font-size: 16px;
     cursor: pointer;
     opacity: 0.5;
     transition: all 0.3s ease;
     padding: 4px 8px;
     border-radius: 6px;
   }

   .edit-btn:hover {
     opacity: 1;
     background: var(--bg-secondary);
     transform: scale(1.1);
   }

   .env-value {
     padding: 12px 14px;
     background: var(--bg-secondary);
     border-radius: 8px;
     font-family: 'Courier New', monospace;
     font-size: 13px;
     word-break: break-all;
     margin-bottom: 10px;
     color: var(--text-primary);
     border: 1px solid var(--border-color);
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
     border-color: var(--accent-primary);
   }

   .env-value.sensitive.revealed {
     user-select: text;
     color: var(--accent-secondary);
   }

   .eye-icon {
     font-size: 14px;
     opacity: 0.6;
     transition: opacity 0.3s ease;
   }

   .env-value.sensitive:hover .eye-icon {
     opacity: 1;
   }

   .env-desc {
     font-size: 12px;
     color: var(--text-tertiary);
     line-height: 1.5;
   }

   /* 搜索框 */
   .search-box {
     margin-bottom: 20px;
   }

   .search-input {
     width: 100%;
     padding: 12px 18px 12px 44px;
     border: 1px solid var(--border-color);
     border-radius: 10px;
     font-size: 14px;
     background: var(--bg-tertiary);
     color: var(--text-primary);
     transition: all 0.3s ease;
     background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%23718096' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E");
     background-repeat: no-repeat;
     background-position: 14px center;
   }

   .search-input:focus {
     outline: none;
     border-color: var(--accent-primary);
     box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
     background-color: var(--bg-secondary);
   }

   /* 模态框 */
   .modal {
     display: none;
     position: fixed;
     top: 0;
     left: 0;
     right: 0;
     bottom: 0;
     background: rgba(0,0,0,0.6);
     backdrop-filter: blur(4px);
     align-items: center;
     justify-content: center;
     z-index: 1000;
     animation: fadeIn 0.2s ease;
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
     border-radius: 16px;
     padding: 32px;
     max-width: 540px;
     width: 90%;
     max-height: 85vh;
     overflow-y: auto;
     box-shadow: var(--shadow-lg);
     border: 1px solid var(--border-color);
     animation: slideUp 0.3s ease;
   }

   @keyframes slideUp {
     from { 
       opacity: 0;
       transform: translateY(20px);
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
     margin-bottom: 24px;
     padding-bottom: 16px;
     border-bottom: 1px solid var(--border-color);
   }

   .modal-title {
     font-size: 20px;
     font-weight: 700;
     color: var(--text-primary);
   }

   .close-btn {
     background: var(--bg-tertiary);
     border: none;
     width: 32px;
     height: 32px;
     border-radius: 8px;
     font-size: 20px;
     cursor: pointer;
     color: var(--text-secondary);
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.3s ease;
   }

   .close-btn:hover {
     background: var(--border-color);
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
     border: 1px solid var(--border-color);
     border-radius: 8px;
     font-size: 14px;
     font-family: inherit;
     background: var(--bg-tertiary);
     color: var(--text-primary);
     transition: all 0.3s ease;
   }

   .form-textarea {
     min-height: 120px;
     font-family: 'Courier New', monospace;
     resize: vertical;
   }

   .form-input:focus, .form-textarea:focus {
     outline: none;
     border-color: var(--accent-primary);
     box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
     background: var(--bg-secondary);
   }

   .form-hint {
     font-size: 12px;
     color: var(--text-tertiary);
     margin-top: 6px;
     line-height: 1.5;
   }

   .modal-footer {
     display: flex;
     gap: 12px;
     justify-content: flex-end;
     margin-top: 24px;
     padding-top: 16px;
     border-top: 1px solid var(--border-color);
   }

   /* Toast提示 */
   .toast {
     position: fixed;
     bottom: 28px;
     right: 28px;
     background: var(--bg-secondary);
     border-radius: 10px;
     padding: 16px 24px;
     box-shadow: var(--shadow-lg);
     display: none;
     align-items: center;
     gap: 12px;
     z-index: 2000;
     border: 1px solid var(--border-color);
     animation: slideInRight 0.3s ease;
     max-width: 400px;
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

   .toast.success { border-left: 4px solid var(--accent-success); }
   .toast.error { border-left: 4px solid var(--accent-danger); }
   .toast.info { border-left: 4px solid #4299e1; }

   .toast-icon {
     font-size: 20px;
   }

   .toast-message {
     color: var(--text-primary);
     font-size: 14px;
     font-weight: 500;
   }

   /* 页面内容 */
   .page {
     display: none;
   }

   .page.active {
     display: block;
   }

   /* 响应式 */
   @media (max-width: 1024px) {
     .sidebar {
       transform: translateX(-100%);
     }

     .sidebar.show {
       transform: translateX(0);
     }

     .main-content {
       margin-left: 0;
     }

     .menu-toggle {
       display: flex;
     }
   }

   @media (max-width: 480px) {
     .quick-settings {
       gap: 16px;
     }

     .setting-item {
       padding: 14px;
     }

     .setting-input {
       padding: 10px 12px;
       font-size: 13px;
     }

     .card {
       padding: 20px 16px;
     }
   }

   @media (max-width: 768px) {
     .container {
       padding: 20px 16px;
     }

     .stats-grid {
       grid-template-columns: 1fr;
     }

     .quick-settings {
       grid-template-columns: 1fr;
     }

     .setting-item {
       padding: 16px;
     }

     .setting-control {
       flex-direction: column;
       align-items: stretch;
     }

     .setting-input {
       width: 100%;
     }

     .top-bar {
       padding: 12px 16px;
     }

     .modal-content {
       padding: 24px 20px;
     }

     .toast {
       bottom: 20px;
       right: 16px;
       left: 16px;
       max-width: none;
     }
   }

   ::-webkit-scrollbar {
     width: 8px;
     height: 8px;
   }

   ::-webkit-scrollbar-track {
     background: var(--bg-tertiary);
     border-radius: 4px;
   }

   ::-webkit-scrollbar-thumb {
     background: var(--border-color);
     border-radius: 4px;
   }

   ::-webkit-scrollbar-thumb:hover {
     background: var(--text-tertiary);
   }
 </style>
</head>
<body>
 <!-- 侧边栏 -->
 <aside class="sidebar" id="sidebar">
   <div class="logo-section">
     <div class="logo-container">
       <div class="logo-icon">🎬</div>
       <div class="logo-text">
         <h1>弹幕 API</h1>
         <p>控制中心</p>
       </div>
     </div>
   </div>
   
   <ul class="nav-menu">
     <li class="nav-item">
       <a class="nav-link active" onclick="showPage('dashboard')">
         <span class="nav-icon">📊</span>
         <span>控制面板</span>
       </a>
     </li>
     <li class="nav-item">
       <a class="nav-link" onclick="showPage('settings')">
         <span class="nav-icon">⚙️</span>
         <span>环境变量</span>
       </a>
     </li>
     <li class="nav-item">
       <a class="nav-link" onclick="showPage('logs')">
         <span class="nav-icon">📝</span>
         <span>运行日志</span>
       </a>
     </li>
     <li class="nav-item">
       <a class="nav-link" onclick="changePassword()">
         <span class="nav-icon">🔑</span>
         <span>修改密码</span>
       </a>
     </li>
     <li class="nav-item">
       <a class="nav-link" onclick="logout()">
         <span class="nav-icon">🚪</span>
         <span>退出登录</span>
       </a>
     </li>
   </ul>
 </aside>

 <!-- 主内容区 -->
 <div class="main-content" id="mainContent">
   <!-- 顶部栏 -->
   <div class="top-bar">
     <div class="top-bar-left">
       <button class="menu-toggle" id="menuToggle" onclick="toggleSidebar()">☰</button>
       <h2 class="page-title" id="pageTitle">控制面板</h2>
     </div>
     <div class="top-bar-actions">
       <button class="theme-toggle" onclick="toggleTheme()" title="切换主题">🌓</button>
     </div>
   </div>

   <div class="container">
     <!-- 控制面板页面 -->
     <div class="page active" id="dashboard">
       <!-- 统计卡片 -->
       <div class="stats-grid">
         <div class="stat-card success">
           <div class="stat-header">
             <div class="stat-icon">📊</div>
             <span class="stat-badge badge-success">活跃</span>
           </div>
           <div class="stat-title">环境变量配置</div>
           <div class="stat-value">${configuredEnvCount}/${totalEnvCount}</div>
           <div class="stat-footer">
             <span>✅</span>
             <span>已配置 ${Math.round((configuredEnvCount/totalEnvCount)*100)}%</span>
           </div>
         </div>

         <div class="stat-card ${globals.databaseValid || (redisConfigured && globals.redisValid) ? 'success' : 'warning'}">
           <div class="stat-header">
             <div class="stat-icon">💾</div>
             <span class="stat-badge ${globals.databaseValid || (redisConfigured && globals.redisValid) ? 'badge-success' : 'badge-warning'}">
               ${globals.databaseValid || (redisConfigured && globals.redisValid) ? '在线' : '离线'}
             </span>
           </div>
           <div class="stat-title">持久化存储</div>
           <div class="stat-value">${
             globals.databaseValid ? '数据库' : 
             (redisConfigured && globals.redisValid) ? 'Redis' : 
             '内存'
           }</div>
           <div class="stat-footer">
             <span>${globals.databaseValid || (redisConfigured && globals.redisValid) ? '🟢' : '🟡'}</span>
             <span>${
               globals.databaseValid ? '数据库连接正常' : 
               (redisConfigured && globals.redisValid) ? 'Redis连接正常' : 
               '仅使用内存缓存'
             }</span>
           </div>
         </div>

         <div class="stat-card info">
           <div class="stat-header">
             <div class="stat-icon">🔗</div>
             <span class="stat-badge badge-success">运行中</span>
           </div>
           <div class="stat-title">弹幕数据源</div>
           <div class="stat-value">${globals.sourceOrderArr.length || 7}</div>
           <div class="stat-footer">
             <span>⚡</span>
             <span>${globals.sourceOrderArr.length > 0 ? `优先: ${globals.sourceOrderArr[0]}` : '使用默认顺序'}</span>
           </div>
         </div>

         <div class="stat-card">
           <div class="stat-header">
             <div class="stat-icon">🚀</div>
             <span class="stat-badge badge-success" id="versionBadge">检查中</span>
           </div>
           <div class="stat-title">服务版本</div>
           <div class="stat-value" id="currentVersion">${globals.VERSION || 'v1.0'}</div>
           <div class="stat-footer">
             <span id="versionIcon">📦</span>
             <span id="versionStatus">检查更新中...</span>
           </div>
         </div>


       <!-- 快速配置 -->
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <span class="card-title-icon">⚡</span>
             快速配置
           </h3>
           <button class="btn btn-primary btn-sm" onclick="saveQuickSettings()">💾 保存设置</button>
         </div>

         <div class="quick-settings">
           <!-- 白色弹幕占比 -->
           <div class="setting-item">
             <div class="setting-header">
               <span class="setting-label">🎨 白色弹幕占比</span>
             </div>
             <div class="setting-control">
               <input 
                 type="range" 
                 class="setting-input" 
                 id="whiteRatio" 
                 min="-1" 
                 max="100" 
                 value="${globals.whiteRatio || -1}"
                 oninput="updateRangeValue('whiteRatio', this.value)"
               >
               <span class="setting-value" id="whiteRatioValue">${globals.whiteRatio || -1}${globals.whiteRatio === -1 ? '' : '%'}</span>
             </div>
             <div class="setting-desc">
               设置白色弹幕的占比(0-100%)，-1表示不转换颜色
             </div>
           </div>

           <!-- 弹幕限制 -->
           <div class="setting-item">
             <div class="setting-header">
               <span class="setting-label">📊 弹幕数量限制</span>
             </div>
             <div class="setting-control">
               <input 
                 type="number" 
                 class="setting-input" 
                 id="danmuLimit" 
                 value="${globals.danmuLimit || -1}"
                 placeholder="输入数量，-1为不限制"
               >
             </div>
             <div class="setting-desc">
               限制返回的弹幕数量，-1表示不限制
             </div>
           </div>

           <!-- 繁简转换 -->
           <div class="setting-item">
             <div class="setting-header">
               <span class="setting-label">🔤 繁体转简体</span>
               <div class="switch ${globals.danmuSimplified !== false ? 'active' : ''}" 
                    id="danmuSimplified" 
                    onclick="toggleSwitch('danmuSimplified')">
               </div>
             </div>
             <div class="setting-desc">
               自动将繁体中文弹幕转换为简体中文
             </div>
           </div>

<!-- 弹幕类型转换 -->
           <div class="setting-item">
             <div class="setting-header">
               <span class="setting-label">🔄 顶底转滚动</span>
               <div class="switch ${globals.convertTopBottomToScroll ? 'active' : ''}" 
                    id="convertTopBottomToScroll" 
                    onclick="toggleSwitch('convertTopBottomToScroll')">
               </div>
             </div>
             <div class="setting-desc">
               将顶部/底部弹幕转换为滚动弹幕
             </div>
           </div>

           <!-- 合并时间窗口 -->
           <div class="setting-item">
             <div class="setting-header">
               <span class="setting-label">⏱️ 合并时间窗口</span>
             </div>
             <div class="setting-control">
               <input 
                 type="number" 
                 class="setting-input" 
                 id="groupMinute" 
                 value="${globals.groupMinute || 1}"
                 min="1"
                 max="10"
                 placeholder="输入分钟数"
               >
             </div>
             <div class="setting-desc">
               弹幕合并去重的时间窗口(分钟)
             </div>
           </div>

           <!-- 输出格式 -->
           <div class="setting-item">
             <div class="setting-header">
               <span class="setting-label">📄 输出格式</span>
             </div>
             <div class="setting-control">
               <select class="setting-input" id="danmuOutputFormat">
                 <option value="json" ${globals.danmuOutputFormat === 'json' ? 'selected' : ''}>JSON</option>
                 <option value="xml" ${globals.danmuOutputFormat === 'xml' ? 'selected' : ''}>XML</option>
               </select>
             </div>
             <div class="setting-desc">
               弹幕数据的输出格式
             </div>
           </div>
         </div>
       </div>
     </div>

     <!-- 环境变量设置页面 -->
     <div class="page" id="settings">
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <span class="card-title-icon">⚙️</span>
             环境变量配置
           </h3>
           <button class="btn btn-primary btn-sm" onclick="saveAll()">💾 保存全部</button>
         </div>
         
         <div class="search-box">
           <input type="text" class="search-input" placeholder="搜索环境变量..." id="searchInput" oninput="filterEnvs()">
         </div>

         <div class="env-grid" id="envGrid">
           ${envItemsHtml}
         </div>
       </div>
     </div>

     <!-- 运行日志页面 -->
     <div class="page" id="logs">
       <div class="card">
         <div class="card-header">
           <h3 class="card-title">
             <span class="card-title-icon">📝</span>
             运行日志
           </h3>
           <button class="btn btn-secondary btn-sm" onclick="refreshLogs()">🔄 刷新</button>
         </div>
         
         <div style="background: var(--bg-tertiary); border-radius: 8px; padding: 20px; min-height: 400px; font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.6; color: var(--text-primary); overflow-x: auto;">
           <div id="logContent">加载中...</div>
         </div>
       </div>
     </div>
   </div>
 </div>

 <!-- 编辑环境变量弹窗 -->
 <div class="modal" id="editModal">
   <div class="modal-content">
     <div class="modal-header">
       <h3 class="modal-title">✏️ 编辑环境变量</h3>
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
       <button class="btn btn-primary" onclick="saveEnv()">保存</button>
     </div>
   </div>
 </div>

 <!-- 修改密码弹窗 -->
 <div class="modal" id="passwordModal">
   <div class="modal-content">
     <div class="modal-header">
       <h3 class="modal-title">🔑 修改密码</h3>
       <button class="close-btn" onclick="closePasswordModal()">×</button>
     </div>
     <div class="form-group">
       <label class="form-label">新用户名(可选)</label>
       <input type="text" class="form-input" id="newUsername" placeholder="留空则不修改">
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
       <button class="btn btn-primary" onclick="submitPasswordChange()">确认修改</button>
     </div>
   </div>
 </div>

 <!-- Toast 提示 -->
 <div class="toast" id="toast">
   <span class="toast-icon" id="toastIcon"></span>
   <span class="toast-message" id="toastMessage"></span>
 </div>

 <script>
   // ========== 状态管理 ==========
   const AppState = {
     currentEditingKey: null,
     config: ${JSON.stringify(globals.accessedEnvVars)},
     revealedSecrets: new Map(),
     currentPage: 'dashboard',
     quickSettings: {
       whiteRatio: ${globals.whiteRatio || -1},
       danmuLimit: ${globals.danmuLimit || -1},
       danmuSimplified: ${globals.danmuSimplified !== false},
       convertTopBottomToScroll: ${globals.convertTopBottomToScroll || false},
       groupMinute: ${globals.groupMinute || 1},
       danmuOutputFormat: '${globals.danmuOutputFormat || 'json'}'
     }
   };

   const ENV_DESCRIPTIONS = ${JSON.stringify(ENV_DESCRIPTIONS)};

   // ========== 主题管理 ==========
   function initTheme() {
     const savedTheme = localStorage.getItem('theme') || 'light';
     document.documentElement.setAttribute('data-theme', savedTheme);
     updateThemeIcon(savedTheme);
   }

   function toggleTheme() {
     const currentTheme = document.documentElement.getAttribute('data-theme');
     const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
     document.documentElement.setAttribute('data-theme', newTheme);
     localStorage.setItem('theme', newTheme);
     updateThemeIcon(newTheme);
     showToast(newTheme === 'dark' ? '已切换到深色模式' : '已切换到浅色模式', 'info');
   }

   function updateThemeIcon(theme) {
     const btn = document.querySelector('.theme-toggle');
     btn.textContent = theme === 'dark' ? '☀️' : '🌙';
   }

   // ========== 侧边栏管理 ==========
   function toggleSidebar() {
     const sidebar = document.getElementById('sidebar');
     const mainContent = document.getElementById('mainContent');
     
     if (window.innerWidth <= 1024) {
       sidebar.classList.toggle('show');
     } else {
       sidebar.classList.toggle('hidden');
       mainContent.classList.toggle('expanded');
     }
   }

   // ========== 页面切换 ==========
   function showPage(pageName) {
     // 更新页面显示
     document.querySelectorAll('.page').forEach(page => {
       page.classList.remove('active');
     });
     document.getElementById(pageName).classList.add('active');

     // 更新导航高亮
     document.querySelectorAll('.nav-link').forEach(link => {
       link.classList.remove('active');
     });
     event.currentTarget.classList.add('active');

     // 更新页面标题
     const titles = {
       'dashboard': '控制面板',
       'settings': '环境变量',
       'logs': '运行日志'
     };
     document.getElementById('pageTitle').textContent = titles[pageName] || '控制面板';

     AppState.currentPage = pageName;

     // 移动端自动关闭侧边栏
     if (window.innerWidth <= 1024) {
       document.getElementById('sidebar').classList.remove('show');
     }

     // 如果是日志页面，自动加载日志
     if (pageName === 'logs') {
       refreshLogs();
     }
   }

   // ========== Toast 提示 ==========
   function showToast(message, type = 'info') {
     const toast = document.getElementById('toast');
     const icon = document.getElementById('toastIcon');
     const msg = document.getElementById('toastMessage');
     
     const icons = {
       success: '✅',
       error: '❌',
       info: 'ℹ️'
     };
     
     icon.textContent = icons[type] || icons.info;
     msg.textContent = message;
     toast.className = 'toast show ' + type;
     
     setTimeout(() => {
       toast.classList.remove('show');
     }, 3000);
   }

   // ========== 快速设置 ==========
   function updateRangeValue(id, value) {
     document.getElementById(id + 'Value').textContent = value + (value == -1 ? '' : '%');
     AppState.quickSettings[id] = parseInt(value);
   }

   function toggleSwitch(id) {
     const switchEl = document.getElementById(id);
     switchEl.classList.toggle('active');
     AppState.quickSettings[id] = switchEl.classList.contains('active');
   }

   async function saveQuickSettings() {
     try {
       // 收集快速设置的值
       const settings = {
         WHITE_RATIO: document.getElementById('whiteRatio').value,
         DANMU_LIMIT: document.getElementById('danmuLimit').value,
         DANMU_SIMPLIFIED: document.getElementById('danmuSimplified').classList.contains('active') ? 'true' : 'false',
         CONVERT_TOP_BOTTOM_TO_SCROLL: document.getElementById('convertTopBottomToScroll').classList.contains('active') ? 'true' : 'false',
         GROUP_MINUTE: document.getElementById('groupMinute').value,
         DANMU_OUTPUT_FORMAT: document.getElementById('danmuOutputFormat').value
       };

       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: settings })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('✅ 快速设置已保存！', 'success');
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   // ========== 环境变量管理 ==========
   function toggleSensitive(element) {
     const real = element.dataset.real;
     const masked = element.dataset.masked;
     const key = element.closest('.env-item').dataset.key;
     
     if (AppState.revealedSecrets.has(key)) {
       clearTimeout(AppState.revealedSecrets.get(key));
       AppState.revealedSecrets.delete(key);
     }
     
     const textarea = document.createElement('textarea');
     textarea.innerHTML = real;
     const realValue = textarea.value;
     element.innerHTML = realValue + ' <span class="eye-icon">🔓</span>';
     element.classList.add('revealed');
     
     const timeoutId = setTimeout(() => {
       element.innerHTML = masked + ' <span class="eye-icon">👁️</span>';
       element.classList.remove('revealed');
       AppState.revealedSecrets.delete(key);
     }, 3000);
     
     AppState.revealedSecrets.set(key, timeoutId);
   }

   function copySensitiveValue(element, event) {
     event.stopPropagation();
     const real = element.dataset.real;
     const textarea = document.createElement('textarea');
     textarea.innerHTML = real;
     const text = textarea.value;
     
     if (navigator.clipboard) {
       navigator.clipboard.writeText(text);
     } else {
       const temp = document.createElement('textarea');
       temp.value = text;
       document.body.appendChild(temp);
       temp.select();
       document.execCommand('copy');
       document.body.removeChild(temp);
     }
     
     showToast('📋 已复制到剪贴板', 'success');
   }

   function copyValue(element) {
     const original = element.dataset.original;
     if (!original) return;
     
     const textarea = document.createElement('textarea');
     textarea.innerHTML = original;
     const text = textarea.value;
     
     if (navigator.clipboard) {
       navigator.clipboard.writeText(text);
     } else {
       const temp = document.createElement('textarea');
       temp.value = text;
       document.body.appendChild(temp);
       temp.select();
       document.execCommand('copy');
       document.body.removeChild(temp);
     }
     
     showToast('📋 已复制到剪贴板', 'success');
   }

   function editEnv(key) {
     AppState.currentEditingKey = key;
     document.getElementById('editKey').value = key;
     document.getElementById('editValue').value = AppState.config[key] || '';
     document.getElementById('editHint').textContent = ENV_DESCRIPTIONS[key] || '';
     document.getElementById('editModal').classList.add('show');
   }

   function closeModal() {
     document.getElementById('editModal').classList.remove('show');
   }

   async function saveEnv() {
     const key = AppState.currentEditingKey;
     const value = document.getElementById('editValue').value.trim();
     
     AppState.config[key] = value;
     
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: { [key]: value } })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('✅ 保存成功！', 'success');
         updateEnvDisplay(key, value);
         closeModal();
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   async function saveAll() {
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: AppState.config })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('✅ 全部配置已保存！', 'success');
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   function updateEnvDisplay(key, value) {
     const item = document.querySelector('.env-item[data-key="' + key + '"]');
     if (!item) return;
     
     const valueEl = item.querySelector('.env-value');
     
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
       valueEl.innerHTML = maskedValue + ' <span class="eye-icon">👁️</span>';
       valueEl.classList.remove('revealed');
       return;
     }
     
     if (typeof value === 'boolean') {
       valueEl.textContent = value ? '✅ 已启用' : '❌ 已禁用';
     } else if (!value) {
       valueEl.textContent = '未配置';
     } else {
       valueEl.textContent = value.length > 80 ? value.substring(0, 80) + '...' : value;
     }
   }

   function filterEnvs() {
     const query = document.getElementById('searchInput').value.toLowerCase();
     const items = document.querySelectorAll('.env-item');
     
     items.forEach(item => {
       const label = item.querySelector('.env-label').textContent.toLowerCase();
       const value = item.querySelector('.env-value').textContent.toLowerCase();
       const desc = item.querySelector('.env-desc').textContent.toLowerCase();
       
       if (label.includes(query) || value.includes(query) || desc.includes(query)) {
         item.style.display = '';
       } else {
         item.style.display = 'none';
       }
     });
   }

   // ========== 密码管理 ==========
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
         showToast(result.message || '修改失败', 'error');
       }
     } catch (error) {
       showToast('修改失败: ' + error.message, 'error');
     }
   }

   // ========== 登录登出 ==========
   async function logout() {
     try {
       await fetch('/api/logout', { method: 'POST' });
       window.location.href = '/';
     } catch (error) {
       showToast('退出失败', 'error');
     }
   }

   // ========== 日志管理 ==========
   async function refreshLogs() {
     try {
       const response = await fetch('/api/logs?format=text&limit=1000');
       const logs = await response.text();
       document.getElementById('logContent').textContent = logs || '暂无日志';
     } catch (error) {
       document.getElementById('logContent').textContent = '加载失败: ' + error.message;
     }
   }

   // ========== 点击主内容区关闭侧边栏 ==========
   document.addEventListener('DOMContentLoaded', function() {
     const mainContent = document.getElementById('mainContent');
     if (mainContent) {
       mainContent.addEventListener('click', function(e) {
         if (window.innerWidth <= 1024) {
           const sidebar = document.getElementById('sidebar');
           if (sidebar && sidebar.classList.contains('show')) {
             // 防止点击按钮时触发
             if (!e.target.closest('.menu-toggle')) {
               toggleSidebar();
             }
           }
         }
       });
     }
   });


   // ========== Docker 版本检查 ==========
   async function checkDockerVersion() {
     const username = 'w254992';
     const repository = 'danmu-api';
     // 修复：使用反引号模板字符串
     const currentVersion = `${globals.VERSION || "v1.0"}`;
     
     try {
       const response = await fetch(`https://hub.docker.com/v2/repositories/${username}/${repository}/tags`);
       const data = await response.json();
       
       if (data && data.results && data.results.length > 0) {
         const versionTags = data.results
           .filter(tag => tag.name !== 'latest' && /^\d+\.\d+\.\d+$/.test(tag.name))
           .sort((a, b) => {
             const versionA = a.name.split('.').map(Number);
             const versionB = b.name.split('.').map(Number);
             for (let i = 0; i < 3; i++) {
               if (versionA[i] !== versionB[i]) {
                 return versionB[i] - versionA[i];
               }
             }
             return 0;
           });
         
         if (versionTags.length > 0) {
           const latestVersion = versionTags[0].name;
           const latestDate = new Date(versionTags[0].last_updated).toLocaleDateString('zh-CN');
           
           document.getElementById('versionStatus').innerHTML = 
             `最新版本: <strong>${latestVersion}</strong> (发布于 ${latestDate})`;
           
           const current = currentVersion.replace(/^v/, '').split('.').map(Number);
           const latest = latestVersion.split('.').map(Number);
           let isLatest = true;
           
           for (let i = 0; i < 3; i++) {
             if (current[i] < latest[i]) {
               isLatest = false;
               break;
             } else if (current[i] > latest[i]) {
               break;
             }
           }
           
           const badge = document.getElementById('versionBadge');
           const icon = document.getElementById('versionIcon');
           
           if (isLatest) {
             badge.textContent = '最新';
             badge.className = 'stat-badge badge-success';
             icon.textContent = '✅';
           } else {
             badge.textContent = '有更新';
             badge.className = 'stat-badge badge-warning';
             icon.textContent = '🔔';
             document.getElementById('versionStatus').innerHTML += 
               ` <a href="https://hub.docker.com/r/${username}/${repository}/tags" target="_blank" style="color: var(--accent-primary); text-decoration: none; font-weight: 600;">→ 查看更新</a>`;
           }
           return;
         }
       }
       
       throw new Error('无法获取版本信息');
       
     } catch (error) {
       console.error('检查版本失败:', error);
       document.getElementById('versionBadge').textContent = '稳定';
       document.getElementById('versionBadge').className = 'stat-badge badge-success';
       document.getElementById('versionIcon').textContent = '📦';
       document.getElementById('versionStatus').textContent = '版本检查失败';
     }
   }


   // ========== 初始化加载 ==========

   async function loadConfig() {

     try {
       const response = await fetch('/api/config/load');
       const result = await response.json();
       
       if (result.success && result.config) {
         AppState.config = { ...AppState.config, ...result.config };
         for (const [key, value] of Object.entries(result.config)) {
           updateEnvDisplay(key, value);
         }
         showToast(\`✅ 配置已从 \${result.loadedFrom.join('、')} 加载\`, 'success');
       }
     } catch (error) {
       console.error('加载配置失败:', error);
     }
   }

   // ========== 快捷键支持 ==========
   document.addEventListener('keydown', (e) => {
     if ((e.ctrlKey || e.metaKey) && e.key === 's') {
       e.preventDefault();
       if (AppState.currentPage === 'dashboard') {
         saveQuickSettings();
       } else if (AppState.currentPage === 'settings') {
         saveAll();
       }
     }
     if (e.key === 'Escape') {
       closeModal();
       closePasswordModal();
     }
   });

   // ========== 响应式处理 ==========
   window.addEventListener('resize', () => {
     if (window.innerWidth > 1024) {
       document.getElementById('sidebar').classList.remove('show');
     }
   });

   // ========== 初始化 ==========
   initTheme();
   loadConfig();
   checkDockerVersion();
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

  // 弹幕 API 路由
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
      --bg-primary: #f5f7fa;
      --bg-secondary: #ffffff;
      --text-primary: #1a202c;
      --text-secondary: #64748b;
      --border-color: #e2e8f0;
      --accent-primary: #667eea;
      --accent-secondary: #764ba2;
      --shadow: 0 10px 25px rgba(0,0,0,0.1);
    }

    [data-theme="dark"] {
      --bg-primary: #1a202c;
      --bg-secondary: #2d3748;
      --text-primary: #f7fafc;
      --text-secondary: #cbd5e1;
      --border-color: #4a5568;
      --shadow: 0 10px 25px rgba(0,0,0,0.4);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      transition: all 0.3s ease;
    }

    .login-container {
      background: var(--bg-secondary);
      border-radius: 24px;
      padding: 48px 40px;
      width: 100%;
      max-width: 420px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border-color);
      animation: slideUp 0.5s ease;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .theme-toggle-login {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 48px;
      height: 48px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: white;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
    }

    .theme-toggle-login:hover {
      transform: scale(1.1);
      background: rgba(255, 255, 255, 0.3);
    }

    .logo {
      text-align: center;
      margin-bottom: 36px;
    }

    .logo-icon {
      font-size: 72px;
      margin-bottom: 16px;
      filter: drop-shadow(0 4px 8px rgba(0,0,0,0.1));
    }

    .logo-title {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }

    .logo-subtitle {
      font-size: 14px;
      color: var(--text-secondary);
    }

    .hint {
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
      border-left: 4px solid var(--accent-primary);
      padding: 14px 18px;
      border-radius: 10px;
      margin-bottom: 28px;
      font-size: 13px;
      color: var(--text-primary);
    }

    .hint strong {
      color: var(--accent-primary);
      font-weight: 600;
    }

    .error-message {
      background: rgba(245, 101, 101, 0.1);
      border-left: 4px solid var(--accent-danger);
      color: #dc2626;
      padding: 14px 18px;
      border-radius: 10px;
      margin-bottom: 20px;
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
      background: var(--bg-primary);
      color: var(--text-primary);
      transition: all 0.3s ease;
    }

    .form-input:focus {
      outline: none;
      border-color: var(--accent-primary);
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    .btn-login {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    }

    .btn-login:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
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
      margin-top: 28px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    @media (max-width: 480px) {
      .login-container {
        padding: 36px 28px;
      }
    }
  </style>
</head>
<body>
  <button class="theme-toggle-login" onclick="toggleTheme()" title="切换主题">🌓</button>

  <div class="login-container">
    <div class="logo">
      <div class="logo-icon">🎬</div>
      <h1 class="logo-title">弹幕 API</h1>
      <p class="logo-subtitle">控制中心</p>
    </div>

    <div class="hint">
      💡 默认账号密码均为 <strong>admin</strong>
    </div>

    <div id="errorMessage" class="error-message"></div>

    <form id="loginForm">
      <div class="form-group">
        <label class="form-label">用户名</label>
        <input type="text" class="form-input" id="username" placeholder="请输入用户名" required>
      </div>

      <div class="form-group">
        <label class="form-label">密码</label>
        <input type="password" class="form-input" id="password" placeholder="请输入密码" required>
      </div>

      <button type="submit" class="btn-login" id="loginBtn">登录</button>
    </form>

    <div class="footer">
      弹幕 API 服务 | 安全登录
    </div>
  </div>

  <script>
    function initTheme() {
      const savedTheme = localStorage.getItem('theme') || 'light';
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
      const btn = document.querySelector('.theme-toggle-login');
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
      loginBtn.textContent = '登录中...';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const result = await response.json();

        if (result.success) {
          loginBtn.textContent = '✅ 登录成功';
          setTimeout(() => {
            window.location.href = '/';
          }, 500);
        } else {
          errorMessage.textContent = result.message || '登录失败';
          errorMessage.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.textContent = '登录';
        }
      } catch (error) {
        errorMessage.textContent = '网络错误，请重试';
        errorMessage.style.display = 'block';
        loginBtn.disabled = false;
        loginBtn.textContent = '登录';
      }
    });

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
    