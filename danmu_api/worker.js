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
  'TOKEN': '自定义API访问令牌',
  'VERSION': '当前服务版本号',
  'LOG_LEVEL': '日志级别：error/warn/info',
  'OTHER_SERVER': '兜底第三方弹幕服务器',
  'VOD_SERVERS': 'VOD影视采集站列表',
  'VOD_RETURN_MODE': 'VOD返回模式：all/fastest',
  'VOD_REQUEST_TIMEOUT': 'VOD请求超时时间（毫秒）',
  'BILIBILI_COOKIE': 'B站Cookie',
  'TMDB_API_KEY': 'TMDB API密钥',
  'SOURCE_ORDER': '数据源优先级',
  'PLATFORM_ORDER': '弹幕平台优先级',
  'TITLE_TO_CHINESE': '是否转换标题为中文',
  'STRICT_TITLE_MATCH': '严格标题匹配',
  'EPISODE_TITLE_FILTER': '剧集标题过滤正则',
  'ENABLE_EPISODE_FILTER': '启用集标题过滤',
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式',
  'DANMU_SIMPLIFIED': '繁简转换',
  'DANMU_LIMIT': '弹幕数量限制',
  'BLOCKED_WORDS': '弹幕屏蔽词',
  'GROUP_MINUTE': '弹幕合并时间窗口',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '转换顶底弹幕',
  'WHITE_RATIO': '白色弹幕占比',
  'YOUKU_CONCURRENCY': '优酷并发数',
  'SEARCH_CACHE_MINUTES': '搜索缓存时间',
  'COMMENT_CACHE_MINUTES': '弹幕缓存时间',
  'REMEMBER_LAST_SELECT': '记住用户选择',
  'MAX_LAST_SELECT_MAP': '选择缓存大小',
  'PROXY_URL': '代理地址',
  'RATE_LIMIT_MAX_REQUESTS': '限流配置',
  'UPSTASH_REDIS_REST_URL': 'Redis服务URL',
  'UPSTASH_REDIS_REST_TOKEN': 'Redis访问令牌',
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
  'DATABASE_URL',
  'DATABASE_AUTH_TOKEN'
];

// 常用弹幕配置模板
const QUICK_CONFIGS = {
  'adjust_white_ratio': {
    name: '白色弹幕占比',
    icon: '⚪',
    desc: '点击调节白色弹幕比例',
    type: 'slider',
    configKey: 'WHITE_RATIO',
    min: -1,
    max: 100,
    step: 1,
    unit: '%',
    defaultValue: 30,
    hint: '设置白色弹幕的占比。-1表示不处理，0表示全部转换，100表示全部保留为白色'
  },
  'adjust_danmu_limit': {
    name: '弹幕数量限制',
    icon: '📊',
    desc: '点击调节弹幕数量上限',
    type: 'slider',
    configKey: 'DANMU_LIMIT',
    min: -1,
    max: 5000,
    step: 100,
    unit: '条',
    defaultValue: -1,
    hint: '限制返回的弹幕数量。-1表示不限制'
  },
  'adjust_group_minute': {
    name: '弹幕合并时间',
    icon: '⏱️',
    desc: '点击调节合并时间窗口',
    type: 'slider',
    configKey: 'GROUP_MINUTE',
    min: 1,
    max: 10,
    step: 1,
    unit: '分钟',
    defaultValue: 1,
    hint: '设置弹幕合并的时间窗口，相同内容在此时间内只保留一条'
  },
  'format_json': {
    name: 'JSON格式',
    icon: '📝',
    desc: '输出JSON格式弹幕',
    type: 'direct',
    configs: {
      'DANMU_OUTPUT_FORMAT': 'json'
    }
  },
  'format_xml': {
    name: 'XML格式',
    icon: '📄',
    desc: '输出XML格式弹幕',
    type: 'direct',
    configs: {
      'DANMU_OUTPUT_FORMAT': 'xml'
    }
  },
  'format_ass': {
    name: 'ASS格式',
    icon: '🎬',
    desc: '输出ASS字幕格式',
    type: 'direct',
    configs: {
      'DANMU_OUTPUT_FORMAT': 'ass'
    }
  },
  'toggle_simplified': {
    name: '繁简转换',
    icon: '🔄',
    desc: '切换弹幕繁简转换',
    type: 'toggle',
    configKey: 'DANMU_SIMPLIFIED',
    hint: '开启后将繁体弹幕转换为简体'
  },
  'toggle_convert_position': {
    name: '转换顶底弹幕',
    icon: '↕️',
    desc: '切换顶底弹幕转换',
    type: 'toggle',
    configKey: 'CONVERT_TOP_BOTTOM_TO_SCROLL',
    hint: '开启后将顶部和底部弹幕转换为滚动弹幕'
  }
};

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

    // 生成快捷配置卡片
    const quickConfigsHtml = Object.entries(QUICK_CONFIGS).map(([id, config]) => `
      <div class="quick-config-card" onclick="applyQuickConfig('${id}')">
        <div class="quick-config-icon">${config.icon}</div>
        <div class="quick-config-info">
          <div class="quick-config-name">${config.name}</div>
          <div class="quick-config-desc">${config.desc}</div>
        </div>
      </div>
    `).join('');

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
                <div class="env-info">
                  <span class="env-label">${key}</span>
                  <span class="env-desc">${description}</span>
                </div>
                <button class="edit-btn" onclick="editEnv('${key}')" title="编辑">✏️</button>
              </div>
              <div class="env-value sensitive" data-real="${encodedRealValue}" data-masked="${maskedValue}" onclick="toggleSensitive(this)" ondblclick="copySensitiveValue(this, event)">
                ${maskedValue} <span class="eye-icon">👁️</span>
              </div>
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
              <div class="env-info">
                <span class="env-label">${key}</span>
                <span class="env-desc">${description}</span>
              </div>
              <button class="edit-btn" onclick="editEnv('${key}')" title="编辑">✏️</button>
            </div>
            <div class="env-value" data-original="${encodedOriginal}" ondblclick="copyValue(this)">
              ${displayValue}
            </div>
          </div>
        `;
      })
      .join('');

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#667eea">
  <title>弹幕 API 管理中心</title>
  <style>
    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
    }
    
    :root {
      --primary: #667eea;
      --secondary: #764ba2;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --info: #3b82f6;
      --bg-1: #0f172a;
      --bg-2: #1e293b;
      --bg-3: #334155;
      --text-1: #f1f5f9;
      --text-2: #cbd5e1;
      --text-3: #94a3b8;
      --border: #334155;
    }

    [data-theme="light"] {
      --primary: #6366f1;
      --secondary: #8b5cf6;
      --bg-1: #f8fafc;
      --bg-2: #ffffff;
      --bg-3: #f1f5f9;
      --text-1: #0f172a;
      --text-2: #475569;
      --text-3: #64748b;
      --border: #e2e8f0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      background: var(--bg-1);
      color: var(--text-1);
      line-height: 1.6;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      padding-bottom: env(safe-area-inset-bottom);
    }

    /* 顶栏优化 - 移动端适配 */
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 0.75rem 1rem;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      position: sticky;
      top: 0;
      z-index: 100;
      padding-top: max(0.75rem, env(safe-area-inset-top));
      transition: all 0.3s ease;
    }

    [data-theme="light"] .header {
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      box-shadow: 0 2px 15px rgba(99, 102, 241, 0.2);
    }

    .header-content {
      max-width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: white;
      flex: 1;
      min-width: 0;
    }

    .logo-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
    }

    .logo-text {
      flex: 1;
      min-width: 0;
    }

    .logo-text h1 {
      font-size: 1rem;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .logo-text p {
      font-size: 0.65rem;
      opacity: 0.9;
      display: none;
    }

    .header-actions {
      display: flex;
      gap: 0.375rem;
      flex-shrink: 0;
    }

    .icon-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      border-radius: 10px;
      border: none;
      background: rgba(255,255,255,0.2);
      color: white;
      cursor: pointer;
      font-size: 1.1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      backdrop-filter: blur(10px);
     -webkit-user-select: none;
     user-select: none;
   }

   .icon-btn:active {
     transform: scale(0.95);
     background: rgba(255,255,255,0.3);
   }

   .container {
     max-width: 100%;
     padding: 1rem;
     padding-bottom: calc(1rem + env(safe-area-inset-bottom));
   }

   /* 状态卡片 - 移动端优化 */
   .dashboard {
     display: grid;
     grid-template-columns: repeat(2, 1fr);
     gap: 0.75rem;
     margin-bottom: 1rem;
   }

   .stat-card {
     background: var(--bg-2);
     border-radius: 12px;
     padding: 1rem;
     border: 1px solid var(--border);
     position: relative;
     overflow: hidden;
     transition: all 0.2s ease;
   }

   .stat-card::before {
     content: '';
     position: absolute;
     top: 0;
     left: 0;
     right: 0;
     height: 3px;
     background: linear-gradient(90deg, var(--primary), var(--secondary));
   }

   .stat-card:active {
     transform: scale(0.98);
   }

   .stat-header {
     display: flex;
     justify-content: space-between;
     align-items: flex-start;
     margin-bottom: 0.5rem;
   }

   .stat-icon {
     font-size: 1.5rem;
   }

   .stat-status {
     padding: 0.25rem 0.5rem;
     border-radius: 12px;
     font-size: 0.65rem;
     font-weight: 600;
   }

   .status-online {
     background: rgba(16, 185, 129, 0.15);
     color: var(--success);
   }

   .status-offline {
     background: rgba(239, 68, 68, 0.15);
     color: var(--danger);
   }

   .stat-title {
     font-size: 0.7rem;
     color: var(--text-3);
     margin-bottom: 0.25rem;
     font-weight: 500;
   }

   .stat-value {
     font-size: 1.25rem;
     font-weight: 700;
     color: var(--text-1);
     margin-bottom: 0.25rem;
     word-break: break-all;
   }

   .stat-footer {
     font-size: 0.65rem;
     color: var(--text-2);
   }

   /* 分区容器 */
   .section {
     background: var(--bg-2);
     border-radius: 12px;
     padding: 1rem;
     margin-bottom: 1rem;
     border: 1px solid var(--border);
   }

   .section-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 1rem;
     padding-bottom: 0.75rem;
     border-bottom: 2px solid var(--border);
     gap: 0.5rem;
   }

   .section-title {
     font-size: 1.1rem;
     font-weight: 700;
     display: flex;
     align-items: center;
     gap: 0.5rem;
     flex: 1;
     min-width: 0;
   }

   .section-title span {
     white-space: nowrap;
     overflow: hidden;
     text-overflow: ellipsis;
   }

   /* 快捷配置 - 移动端优化 */
   .quick-configs {
     display: grid;
     grid-template-columns: repeat(2, 1fr);
     gap: 0.75rem;
   }

   .quick-config-card {
     background: linear-gradient(135deg, var(--bg-3), var(--bg-2));
     border-radius: 12px;
     padding: 1rem;
     cursor: pointer;
     border: 2px solid var(--border);
     transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
     display: flex;
     flex-direction: column;
     align-items: center;
     text-align: center;
     min-height: 100px;
     position: relative;
     overflow: hidden;
   }

   .quick-config-card::before {
     content: '';
     position: absolute;
     top: 0;
     left: 0;
     right: 0;
     height: 3px;
     background: linear-gradient(90deg, var(--primary), var(--secondary));
     transform: scaleX(0);
     transition: transform 0.3s ease;
   }

   .quick-config-card:hover::before,
   .quick-config-card:active::before {
     transform: scaleX(1);
   }

   .quick-config-card:active {
     transform: translateY(-2px);
     border-color: var(--primary);
     box-shadow: 0 6px 20px rgba(102, 126, 234, 0.25);
   }

   .quick-config-icon {
     font-size: 2rem;
     margin-bottom: 0.5rem;
     filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
   }

   .quick-config-info {
     flex: 1;
     display: flex;
     flex-direction: column;
     gap: 0.25rem;
   }

   .quick-config-name {
     font-size: 0.85rem;
     font-weight: 700;
     color: var(--text-1);
   }

   .quick-config-desc {
     font-size: 0.7rem;
     color: var(--text-3);
     line-height: 1.4;
   }

   /* 搜索框 */
   .search-box {
     margin-bottom: 1rem;
   }

   .search-input {
     width: 100%;
     padding: 0.875rem 1rem 0.875rem 2.75rem;
     border: 2px solid var(--border);
     border-radius: 10px;
     font-size: 0.875rem;
     background: var(--bg-3);
     color: var(--text-1);
     transition: all 0.2s ease;
     background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E");
     background-repeat: no-repeat;
     background-position: 1rem center;
   }

   .search-input:focus {
     outline: none;
     border-color: var(--primary);
     box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
   }

   /* 环境变量列表 */
   .env-grid {
     display: grid;
     gap: 0.75rem;
   }

   .env-item {
     background: var(--bg-3);
     border-radius: 10px;
     padding: 1rem;
     border: 2px solid transparent;
     transition: all 0.2s ease;
   }

   .env-item:active {
     border-color: var(--primary);
     transform: translateX(3px);
   }

   .env-header {
     display: flex;
     justify-content: space-between;
     align-items: flex-start;
     margin-bottom: 0.75rem;
     gap: 0.5rem;
   }

   .env-info {
     flex: 1;
     min-width: 0;
   }

   .env-label {
     font-weight: 600;
     color: var(--primary);
     font-size: 0.8rem;
     font-family: 'Courier New', monospace;
     display: block;
     margin-bottom: 0.25rem;
     word-break: break-all;
   }

   .env-desc {
     font-size: 0.7rem;
     color: var(--text-3);
     line-height: 1.4;
   }

   .edit-btn {
     background: var(--bg-2);
     border: 1px solid var(--border);
     font-size: 1.1rem;
     cursor: pointer;
     padding: 0.375rem 0.625rem;
     border-radius: 8px;
     transition: all 0.2s ease;
     flex-shrink: 0;
     min-width: 36px;
     height: 36px;
     display: flex;
     align-items: center;
     justify-content: center;
   }

   .edit-btn:active {
     background: var(--border);
     transform: scale(0.95);
   }

   .env-value {
     padding: 0.75rem;
     background: var(--bg-2);
     border-radius: 8px;
     font-family: 'Courier New', monospace;
     font-size: 0.75rem;
     word-break: break-all;
     color: var(--text-1);
     border: 1px solid var(--border);
     line-height: 1.5;
   }

   .env-value.sensitive {
     cursor: pointer;
     display: flex;
     justify-content: space-between;
     align-items: center;
     user-select: none;
     gap: 0.5rem;
   }

   .env-value.sensitive:active {
     background: var(--bg-1);
     border-color: var(--primary);
   }

   .env-value.sensitive.revealed {
     user-select: text;
     color: var(--secondary);
   }

   .eye-icon {
     font-size: 1rem;
     opacity: 0.6;
     flex-shrink: 0;
   }

   /* 按钮样式 */
   .btn {
     padding: 0.75rem 1.25rem;
     border: none;
     border-radius: 10px;
     font-size: 0.875rem;
     font-weight: 600;
     cursor: pointer;
     transition: all 0.2s ease;
     display: inline-flex;
     align-items: center;
     justify-content: center;
     gap: 0.375rem;
     white-space: nowrap;
     min-height: 44px;
     -webkit-user-select: none;
     user-select: none;
   }

   .btn:active {
     transform: scale(0.97);
   }

   .btn-primary {
     background: linear-gradient(135deg, var(--primary), var(--secondary));
     color: white;
     box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
   }

   .btn-secondary {
     background: var(--bg-3);
     color: var(--text-1);
     border: 2px solid var(--border);
   }

   .btn-danger {
     background: var(--danger);
     color: white;
   }

   .btn-small {
     padding: 0.5rem 0.875rem;
     font-size: 0.8rem;
     min-height: 36px;
   }

   /* 模态框 */
   .modal {
     display: none;
     position: fixed;
     top: 0;
     left: 0;
     right: 0;
     bottom: 0;
     background: rgba(0,0,0,0.7);
     backdrop-filter: blur(5px);
     align-items: center;
     justify-content: center;
     z-index: 1000;
     padding: 1rem;
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
     background: var(--bg-2);
     border-radius: 16px;
     padding: 1.5rem;
     max-width: 600px;
     width: 100%;
     max-height: 85vh;
     overflow-y: auto;
     box-shadow: 0 20px 60px rgba(0,0,0,0.3);
     border: 1px solid var(--border);
     animation: slideUp 0.25s ease;
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

   .modal-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 1.25rem;
     padding-bottom: 1rem;
     border-bottom: 2px solid var(--border);
   }

   .modal-title {
     font-size: 1.25rem;
     font-weight: 700;
     color: var(--text-1);
   }

   .close-btn {
     background: var(--bg-3);
     border: none;
     width: 36px;
     height: 36px;
     min-width: 36px;
     border-radius: 8px;
     font-size: 1.5rem;
     cursor: pointer;
     color: var(--text-2);
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.2s ease;
     flex-shrink: 0;
   }

   .close-btn:active {
     background: var(--border);
     transform: rotate(90deg);
   }

   .form-group {
     margin-bottom: 1.25rem;
   }

   .form-label {
     display: block;
     font-size: 0.875rem;
     font-weight: 600;
     margin-bottom: 0.5rem;
     color: var(--text-1);
   }

   .form-input, .form-textarea {
     width: 100%;
     padding: 0.875rem;
     border: 2px solid var(--border);
     border-radius: 10px;
     font-size: 0.875rem;
     font-family: inherit;
     background: var(--bg-3);
     color: var(--text-1);
     transition: all 0.2s ease;
   }

   .form-textarea {
     min-height: 120px;
     font-family: 'Courier New', monospace;
     resize: vertical;
     line-height: 1.5;
   }

   .form-input:focus, .form-textarea:focus {
     outline: none;
     border-color: var(--primary);
     box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
     background: var(--bg-2);
   }

   .form-hint {
     font-size: 0.75rem;
     color: var(--text-3);
     margin-top: 0.375rem;
     line-height: 1.4;
   }

   .modal-footer {
     display: flex;
     gap: 0.75rem;
     justify-content: flex-end;
     margin-top: 1.5rem;
     padding-top: 1rem;
     border-top: 2px solid var(--border);
   }
   /* 滑块配置模态框 */
   .slider-modal .modal-content {
     max-width: 500px;
   }

   .slider-group {
     margin: 1.5rem 0;
   }

   .slider-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 1rem;
   }

   .slider-label {
     font-size: 0.9rem;
     font-weight: 600;
     color: var(--text-1);
   }

   .slider-value {
     font-size: 1.25rem;
     font-weight: 700;
     color: var(--primary);
     font-family: 'Courier New', monospace;
   }

   .slider-container {
     position: relative;
     padding: 1rem 0;
   }

   .slider {
     -webkit-appearance: none;
     appearance: none;
     width: 100%;
     height: 8px;
     border-radius: 5px;
     background: linear-gradient(to right, var(--primary) 0%, var(--primary) 50%, var(--bg-3) 50%, var(--bg-3) 100%);
     outline: none;
     transition: all 0.2s ease;
   }

   .slider::-webkit-slider-thumb {
     -webkit-appearance: none;
     appearance: none;
     width: 24px;
     height: 24px;
     border-radius: 50%;
     background: linear-gradient(135deg, var(--primary), var(--secondary));
     cursor: pointer;
     box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
     transition: all 0.2s ease;
   }

   .slider::-webkit-slider-thumb:hover {
     transform: scale(1.2);
     box-shadow: 0 4px 12px rgba(102, 126, 234, 0.6);
   }

   .slider::-webkit-slider-thumb:active {
     transform: scale(1.1);
   }

   .slider::-moz-range-thumb {
     width: 24px;
     height: 24px;
     border-radius: 50%;
     background: linear-gradient(135deg, var(--primary), var(--secondary));
     cursor: pointer;
     border: none;
     box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
     transition: all 0.2s ease;
   }

   .slider::-moz-range-thumb:hover {
     transform: scale(1.2);
     box-shadow: 0 4px 12px rgba(102, 126, 234, 0.6);
   }

   .slider-marks {
     display: flex;
     justify-content: space-between;
     margin-top: 0.5rem;
     padding: 0 2px;
   }

   .slider-mark {
     font-size: 0.7rem;
     color: var(--text-3);
     font-weight: 500;
   }

   .slider-hint {
     font-size: 0.75rem;
     color: var(--text-3);
     margin-top: 0.75rem;
     padding: 0.75rem;
     background: var(--bg-3);
     border-radius: 8px;
     line-height: 1.5;
   }

   /* Toast 提示 */
   .toast {
     position: fixed;
     bottom: calc(2rem + env(safe-area-inset-bottom));
     left: 1rem;
     right: 1rem;
     background: var(--bg-2);
     border-radius: 12px;
     padding: 1rem;
     box-shadow: 0 10px 40px rgba(0,0,0,0.3);
     display: none;
     align-items: center;
     gap: 0.75rem;
     z-index: 2000;
     border: 2px solid var(--border);
     animation: slideInUp 0.3s ease;
   }

   @keyframes slideInUp {
     from { 
       transform: translateY(100px);
       opacity: 0;
     }
     to { 
       transform: translateY(0);
       opacity: 1;
     }
   }

   .toast.show {
     display: flex;
   }

   .toast.success { border-left: 4px solid var(--success); }
   .toast.error { border-left: 4px solid var(--danger); }
   .toast.info { border-left: 4px solid var(--info); }
   .toast.warning { border-left: 4px solid var(--warning); }

   .toast-icon {
     font-size: 1.5rem;
     flex-shrink: 0;
   }

   .toast-message {
     color: var(--text-1);
     font-size: 0.875rem;
     font-weight: 500;
     flex: 1;
   }

   /* 日志容器 */
   .log-container {
     background: #1a1a1a;
     border-radius: 10px;
     padding: 1rem;
     font-family: 'Courier New', monospace;
     font-size: 0.7rem;
     max-height: 350px;
     overflow-y: auto;
     border: 2px solid var(--border);
   }

   .log-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 0.75rem;
     padding-bottom: 0.5rem;
     border-bottom: 1px solid var(--border);
     gap: 0.5rem;
     flex-wrap: wrap;
   }

   .log-controls {
     display: flex;
     gap: 0.375rem;
     flex-wrap: wrap;
   }

   .log-filter {
     padding: 0.375rem 0.625rem;
     border-radius: 6px;
     border: none;
     background: var(--bg-3);
     color: var(--text-2);
     cursor: pointer;
     font-size: 0.7rem;
     transition: all 0.2s ease;
     white-space: nowrap;
   }

   .log-filter:active {
     transform: scale(0.95);
   }

   .log-filter.active {
     background: var(--primary);
     color: white;
   }

   .log-line {
     padding: 0.25rem;
     margin-bottom: 0.125rem;
     border-radius: 4px;
     line-height: 1.5;
     word-break: break-all;
   }

   .log-line.info { color: #60a5fa; }
   .log-line.warn { color: #fbbf24; }
   .log-line.error { color: #f87171; }

   .log-timestamp {
     opacity: 0.6;
     margin-right: 0.375rem;
     font-size: 0.65rem;
   }

   /* 平板适配 */
   @media (min-width: 640px) {
     .container { 
       padding: 1.5rem;
       max-width: 1200px;
       margin: 0 auto;
     }
     
     .header-content {
       max-width: 1200px;
       margin: 0 auto;
     }

     .dashboard {
       grid-template-columns: repeat(4, 1fr);
       gap: 1rem;
     }

     .quick-configs {
       grid-template-columns: repeat(4, 1fr);
       gap: 1rem;
     }

     .logo-text p {
       display: block;
     }

     .toast {
       left: auto;
       right: 2rem;
       max-width: 400px;
     }

     .section {
       padding: 1.5rem;
     }

     .stat-card {
       padding: 1.25rem;
     }
   }

   /* 大屏适配 */
   @media (min-width: 1024px) {
     .header {
       padding: 1rem 2rem;
     }

     .logo-icon {
       font-size: 2rem;
     }

     .logo-text h1 {
       font-size: 1.25rem;
     }

     .icon-btn {
       width: 40px;
       height: 40px;
       min-width: 40px;
     }
   }

   /* 滚动条样式 */
   ::-webkit-scrollbar {
     width: 6px;
     height: 6px;
   }

   ::-webkit-scrollbar-track {
     background: var(--bg-3);
     border-radius: 3px;
   }

   ::-webkit-scrollbar-thumb {
     background: var(--border);
     border-radius: 3px;
   }

   ::-webkit-scrollbar-thumb:hover {
     background: var(--text-3);
   }

   /* 防止页面缩放 */
   input, textarea, select {
     font-size: 16px !important;
   }
 </style>
</head>
<body>
 <div class="header">
   <div class="header-content">
     <div class="logo">
       <div class="logo-icon">🎬</div>
       <div class="logo-text">
         <h1>弹幕 API 管理</h1>
         <p>Danmu API Center</p>
       </div>
     </div>
     <div class="header-actions">
       <button class="icon-btn" onclick="toggleTheme()" title="主题">🌓</button>
       <button class="icon-btn" onclick="showLogs()" title="日志">📋</button>
       <button class="icon-btn" onclick="changePassword()" title="密码">🔑</button>
       <button class="icon-btn" onclick="logout()" title="退出">🚪</button>
     </div>
   </div>
 </div>

 <div class="container">
   <div class="dashboard">
     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon">⚙️</div>
         <span class="stat-status status-online">运行</span>
       </div>
       <div class="stat-title">配置状态</div>
       <div class="stat-value">${configuredEnvCount}/${totalEnvCount}</div>
       <div class="stat-footer">已配置项</div>
     </div>
     
     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon">💾</div>
         <span class="stat-status ${(globals.databaseValid || (redisConfigured && globals.redisValid)) ? 'status-online' : 'status-offline'}">
           ${globals.databaseValid ? 'DB' : (redisConfigured && globals.redisValid) ? 'Redis' : '内存'}
         </span>
       </div>
       <div class="stat-title">存储方式</div>
       <div class="stat-value">${
         globals.databaseValid ? 'Database' : 
         (redisConfigured && globals.redisValid) ? 'Redis' : 
         'Memory'
       }</div>
       <div class="stat-footer">${
         globals.databaseValid ? '✅ 数据库' : 
         (redisConfigured && globals.redisValid) ? '✅ 缓存' : 
         '⚠️ 临时'
       }</div>
     </div>

     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon">🔗</div>
         <span class="stat-status status-online">${globals.sourceOrderArr.length || 7}</span>
       </div>
       <div class="stat-title">数据源</div>
       <div class="stat-value">${globals.sourceOrderArr[0] || 'DanDan'}</div>
       <div class="stat-footer">优先源</div>
     </div>

     <div class="stat-card">
       <div class="stat-header">
         <div class="stat-icon">📊</div>
         <span class="stat-status status-online">v${globals.VERSION}</span>
       </div>
       <div class="stat-title">服务版本</div>
       <div class="stat-value">${globals.deployPlatform || 'Unknown'}</div>
       <div class="stat-footer">部署平台</div>
     </div>
   </div>

   <div class="section">
     <div class="section-header">
       <h2 class="section-title">
         <span>⚡ 快速配置</span>
       </h2>
     </div>
     <div class="quick-configs">
       ${quickConfigsHtml}
     </div>
   </div>

   <div class="section">
     <div class="section-header">
       <h2 class="section-title">
         <span>🔧 环境变量</span>
       </h2>
       <button class="btn btn-primary btn-small" onclick="saveAll()">💾 保存</button>
     </div>
     
     <div class="search-box">
       <input type="text" class="search-input" placeholder="搜索配置项..." id="searchInput" oninput="filterEnvs()">
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
       <h3 class="modal-title">✏️ 编辑配置</h3>
       <button class="close-btn" onclick="closeModal()">×</button>
     </div>
     <div class="form-group">
       <label class="form-label">变量名称</label>
       <input type="text" class="form-input" id="editKey" readonly>
     </div>
     <div class="form-group">
       <label class="form-label">变量值</label>
       <textarea class="form-textarea" id="editValue" placeholder="请输入配置值"></textarea>
       <div class="form-hint" id="editHint"></div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeModal()">取消</button>
       <button class="btn btn-primary" onclick="saveEnv()">💾 保存</button>
     </div>
   </div>
 </div>

 <!-- 修改密码弹窗 -->
 <div class="modal" id="passwordModal">
   <div class="modal-content">
     <div class="modal-header">
       <h3 class="modal-title">🔑 修改凭证</h3>
       <button class="close-btn" onclick="closePasswordModal()">×</button>
     </div>
     <div class="form-group">
       <label class="form-label">新用户名（可选）</label>
       <input type="text" class="form-input" id="newUsername" placeholder="留空不修改">
     </div>
     <div class="form-group">
       <label class="form-label">当前密码</label>
       <input type="password" class="form-input" id="oldPassword" placeholder="请输入当前密码" required>
     </div>
     <div class="form-group">
       <label class="form-label">新密码</label>
       <input type="password" class="form-input" id="newPassword" placeholder="至少4位" required>
     </div>
     <div class="form-group">
       <label class="form-label">确认密码</label>
       <input type="password" class="form-input" id="confirmPassword" placeholder="再次输入" required>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closePasswordModal()">取消</button>
       <button class="btn btn-primary" onclick="submitPasswordChange()">🔒 确认</button>
     </div>
   </div>
 </div>
 <!-- 滑块配置弹窗 -->
 <div class="modal slider-modal" id="sliderModal">
   <div class="modal-content">
     <div class="modal-header">
       <h3 class="modal-title" id="sliderModalTitle">⚙️ 调节配置</h3>
       <button class="close-btn" onclick="closeSliderModal()">×</button>
     </div>
     <div class="slider-group">
       <div class="slider-header">
         <span class="slider-label" id="sliderLabel">配置值</span>
         <span class="slider-value" id="sliderValue">0</span>
       </div>
       <div class="slider-container">
         <input type="range" class="slider" id="configSlider" min="0" max="100" step="1" value="0">
         <div class="slider-marks">
           <span class="slider-mark" id="sliderMin">0</span>
           <span class="slider-mark" id="sliderMax">100</span>
         </div>
       </div>
       <div class="slider-hint" id="sliderHint">拖动滑块调节配置值</div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeSliderModal()">取消</button>
       <button class="btn btn-primary" onclick="saveSliderConfig()">💾 应用</button>
     </div>
   </div>
 </div>

 <!-- 日志查看弹窗 -->
 <div class="modal" id="logsModal">
   <div class="modal-content" style="max-width: 900px;">
     <div class="modal-header">
       <h3 class="modal-title">📋 系统日志</h3>
       <button class="close-btn" onclick="closeLogsModal()">×</button>
     </div>
     <div class="log-container">
       <div class="log-header">
         <span style="color: var(--text-2); font-weight: 600; font-size: 0.75rem;">实时日志</span>
         <div class="log-controls">
           <button class="log-filter active" data-level="all" onclick="filterLogs('all')">全部</button>
           <button class="log-filter" data-level="info" onclick="filterLogs('info')">信息</button>
           <button class="log-filter" data-level="warn" onclick="filterLogs('warn')">警告</button>
           <button class="log-filter" data-level="error" onclick="filterLogs('error')">错误</button>
           <button class="log-filter" onclick="clearLogs()">清空</button>
         </div>
       </div>
       <div id="logContent" style="color: #a0a0a0;"></div>
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeLogsModal()">关闭</button>
       <button class="btn btn-primary" onclick="refreshLogs()">🔄 刷新</button>
     </div>
   </div>
 </div>

 <!-- Toast 提示 -->
 <div class="toast" id="toast">
   <span class="toast-icon" id="toastIcon"></span>
   <span class="toast-message" id="toastMessage"></span>
 </div>

 <script>
   // 全局状态
   const AppState = {
     currentEditingKey: null,
     config: ${JSON.stringify(globals.accessedEnvVars)},
     revealedSecrets: new Map(),
     logFilter: 'all',
     logs: []
   };

   const ENV_DESCRIPTIONS = ${JSON.stringify(ENV_DESCRIPTIONS)};
   const QUICK_CONFIGS = ${JSON.stringify(QUICK_CONFIGS)};

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
     showToast(\`已切换到\${newTheme === 'dark' ? '深色' : '浅色'}模式\`, 'info');
   }

   function updateThemeIcon(theme) {
     const btns = document.querySelectorAll('.icon-btn');
     if (btns[0]) btns[0].textContent = theme === 'dark' ? '☀️' : '🌙';
   }

   // Toast 提示
   function showToast(message, type = 'info') {
     const toast = document.getElementById('toast');
     const icon = document.getElementById('toastIcon');
     const msg = document.getElementById('toastMessage');
     
     const icons = {
       success: '✅',
       error: '❌',
       info: 'ℹ️',
       warning: '⚠️'
     };
     
     icon.textContent = icons[type] || icons.info;
     msg.textContent = message;
     toast.className = \`toast show \${type}\`;
     
     setTimeout(() => {
       toast.classList.remove('show');
     }, 3500);
   }

   // 敏感信息显示/隐藏
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
     }, 5000);
     
     AppState.revealedSecrets.set(key, timeoutId);
   }

   // 复制敏感信息
   function copySensitiveValue(element, event) {
     event.stopPropagation();
     const real = element.dataset.real;
     const textarea = document.createElement('textarea');
     textarea.innerHTML = real;
     const text = textarea.value;
     
     copyToClipboard(text);
     showToast('📋 已复制到剪贴板', 'success');
   }

   // 复制普通值
   function copyValue(element) {
     const original = element.dataset.original;
     if (!original) return;
     
     const textarea = document.createElement('textarea');
     textarea.innerHTML = original;
     const text = textarea.value;
     
     copyToClipboard(text);
     showToast('📋 已复制到剪贴板', 'success');
   }

   // 通用复制函数
   function copyToClipboard(text) {
     if (navigator.clipboard) {
       navigator.clipboard.writeText(text);
     } else {
       const temp = document.createElement('textarea');
       temp.value = text;
       temp.style.position = 'fixed';
       temp.style.opacity = '0';
       document.body.appendChild(temp);
       temp.select();
       document.execCommand('copy');
       document.body.removeChild(temp);
     }
   }

   // 编辑环境变量
   function editEnv(key) {
     AppState.currentEditingKey = key;
     document.getElementById('editKey').value = key;
     document.getElementById('editValue').value = AppState.config[key] || '';
     document.getElementById('editHint').textContent = ENV_DESCRIPTIONS[key] || '该环境变量的配置值';
     document.getElementById('editModal').classList.add('show');
   }

   function closeModal() {
     document.getElementById('editModal').classList.remove('show');
   }

   // 保存单个环境变量
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
         showToast(\`✅ \${key} 保存成功\`, 'success');
         updateEnvDisplay(key, value);
         closeModal();
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   // 保存全部配置
   async function saveAll() {
     showToast('正在保存配置...', 'info');
     
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: AppState.config })
       });

       const result = await response.json();
       
       if (result.success) {
         showToast('✅ 配置已保存', 'success');
         if (result.savedTo) {
           console.log('配置已保存到:', result.savedTo);
         }
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   // 更新界面显示
   function updateEnvDisplay(key, value) {
     const item = document.querySelector(\`.env-item[data-key="\${key}"]\`);
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
     } else if (!value || (typeof value === 'string' && value.length === 0)) {
       valueEl.textContent = '未配置';
     } else {
       const displayValue = typeof value === 'string' && value.length > 80 
         ? value.substring(0, 80) + '...' 
         : value;
       valueEl.textContent = displayValue;
     }
   }

   // 搜索过滤
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
     
     if (query && visibleCount === 0) {
       showToast('未找到匹配项', 'warning');
     }
   }

   // 快捷配置应用
   // 快捷配置相关变量
   let currentSliderConfig = null;

   async function applyQuickConfig(configId) {
     const config = QUICK_CONFIGS[configId];
     if (!config) {
       showToast('配置模板不存在', 'error');
       return;
     }

     // 滑块类型配置
     if (config.type === 'slider') {
       openSliderModal(configId, config);
       return;
     }

     // 切换类型配置
     if (config.type === 'toggle') {
       const currentValue = AppState.config[config.configKey];
       const newValue = String(currentValue).toLowerCase() !== 'true';
       const configToSave = { [config.configKey]: String(newValue) };
       
       showToast(`正在${newValue ? '启用' : '禁用'} ${config.name}...`, 'info');
       
       try {
         const response = await fetch('/api/config/save', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ config: configToSave })
         });

         const result = await response.json();
         
         if (result.success) {
           AppState.config[config.configKey] = String(newValue);
           showToast(`✅ ${config.name} 已${newValue ? '启用' : '禁用'}`, 'success');
           updateEnvDisplay(config.configKey, String(newValue));
         } else {
           showToast('操作失败: ' + (result.errorMessage || '未知错误'), 'error');
         }
       } catch (error) {
         showToast('操作失败: ' + error.message, 'error');
       }
       return;
     }

     // 直接应用类型配置
     if (config.type === 'direct') {
       showToast(`正在应用 ${config.name}...`, 'info');
       
       Object.assign(AppState.config, config.configs);
       
       try {
         const response = await fetch('/api/config/save', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ config: config.configs })
         });

         const result = await response.json();
         
         if (result.success) {
           showToast(`✅ ${config.name} 已应用`, 'success');
           
           for (const [key, value] of Object.entries(config.configs)) {
             updateEnvDisplay(key, value);
           }
         } else {
           showToast('应用失败: ' + (result.errorMessage || '未知错误'), 'error');
         }
       } catch (error) {
         showToast('应用失败: ' + error.message, 'error');
       }
     }
   }

   function openSliderModal(configId, config) {
     currentSliderConfig = { id: configId, ...config };
     
     document.getElementById('sliderModalTitle').innerHTML = `${config.icon} ${config.name}`;
     document.getElementById('sliderLabel').textContent = config.name;
     document.getElementById('sliderHint').textContent = config.hint || '拖动滑块调节配置值';
     
     const slider = document.getElementById('configSlider');
     slider.min = config.min;
     slider.max = config.max;
     slider.step = config.step;
     
     const currentValue = AppState.config[config.configKey];
     const numValue = parseInt(currentValue) || config.defaultValue;
     slider.value = numValue;
     
     updateSliderDisplay(numValue, config);
     
     document.getElementById('sliderMin').textContent = config.min === -1 ? '不限' : config.min + config.unit;
     document.getElementById('sliderMax').textContent = config.max + config.unit;
     
     document.getElementById('sliderModal').classList.add('show');
     
     slider.oninput = function() {
       updateSliderDisplay(parseInt(this.value), config);
       updateSliderBackground(this);
     };
     
     updateSliderBackground(slider);
   }

   function updateSliderDisplay(value, config) {
     const displayValue = value === -1 ? '不限制' : value + config.unit;
     document.getElementById('sliderValue').textContent = displayValue;
   }

   function updateSliderBackground(slider) {
     const value = slider.value;
     const min = slider.min;
     const max = slider.max;
     const percentage = ((value - min) / (max - min)) * 100;
     slider.style.background = `linear-gradient(to right, var(--primary) 0%, var(--primary) ${percentage}%, var(--bg-3) ${percentage}%, var(--bg-3) 100%)`;
   }

   function closeSliderModal() {
     document.getElementById('sliderModal').classList.remove('show');
     currentSliderConfig = null;
   }

   async function saveSliderConfig() {
     if (!currentSliderConfig) return;
     
     const slider = document.getElementById('configSlider');
     const value = slider.value;
     const config = currentSliderConfig;
     
     const configToSave = { [config.configKey]: value };
     
     showToast(`正在保存 ${config.name}...`, 'info');
     
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: configToSave })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.config[config.configKey] = value;
         showToast(`✅ ${config.name} 已设置为 ${value === '-1' ? '不限制' : value + config.unit}`, 'success');
         updateEnvDisplay(config.configKey, value);
         closeSliderModal();
       } else {
         showToast('保存失败: ' + (result.errorMessage || '未知错误'), 'error');
       }
     } catch (error) {
       showToast('保存失败: ' + error.message, 'error');
     }
   }

   // 修改密码相关
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
       showToast('请输入当前密码', 'error');
       return;
     }
     
     if (!newPassword) {
       showToast('请输入新密码', 'error');
       return;
     }
     
     if (newPassword !== confirmPassword) {
       showToast('两次密码不一致', 'error');
       return;
     }
     
     if (newPassword.length < 4) {
       showToast('密码至少4位', 'error');
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
         showToast('✅ 修改成功，请重新登录', 'success');
         closePasswordModal();
         setTimeout(() => logout(), 2000);
       } else {
         showToast(result.message || '修改失败', 'error');
       }
     } catch (error) {
       showToast('修改失败: ' + error.message, 'error');
     }
   }

   // 日志查看相关
   let logRefreshInterval = null;

   function showLogs() {
     document.getElementById('logsModal').classList.add('show');
     refreshLogs();
     
     logRefreshInterval = setInterval(() => {
       refreshLogs(true);
     }, 3000);
   }

   function closeLogsModal() {
     document.getElementById('logsModal').classList.remove('show');
     if (logRefreshInterval) {
       clearInterval(logRefreshInterval);
       logRefreshInterval = null;
     }
   }

   async function refreshLogs(silent = false) {
     try {
       const response = await fetch(\`/api/logs?format=json&limit=100\`);
       const result = await response.json();
       
       if (result.success && result.logs) {
         AppState.logs = result.logs;
         displayLogs();
         
         if (!silent) {
           showToast(\`📋 已加载 \${result.logs.length} 条日志\`, 'info');
         }
       }
     } catch (error) {
       if (!silent) {
         showToast('加载日志失败: ' + error.message, 'error');
       }
     }
   }

   function displayLogs() {
     const logContent = document.getElementById('logContent');
     if (!logContent) return;
     
     const filteredLogs = AppState.logFilter === 'all' 
       ? AppState.logs 
       : AppState.logs.filter(log => log.level === AppState.logFilter);
     
     if (filteredLogs.length === 0) {
       logContent.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-3);">暂无日志</div>';
       return;
     }
     
     const logsHtml = filteredLogs.map(log => {
       const message = typeof log.message === 'string' 
         ? log.message 
         : JSON.stringify(log.message);
       
       return \`
         <div class="log-line \${log.level}">
           <span class="log-timestamp">\${log.timestamp || ''}</span>
           <span>[\${log.level.toUpperCase()}]</span>
           <span>\${escapeHtml(message)}</span>
         </div>
       \`;
     }).join('');
     
     logContent.innerHTML = logsHtml;
     logContent.scrollTop = logContent.scrollHeight;
   }

   function filterLogs(level) {
     AppState.logFilter = level;
     
     document.querySelectorAll('.log-filter').forEach(btn => {
       btn.classList.remove('active');
       if (btn.dataset.level === level) {
         btn.classList.add('active');
       }
     });
     
     displayLogs();
   }

   function clearLogs() {
     if (confirm('确定清空日志显示？')) {
       AppState.logs = [];
       displayLogs();
       showToast('✅ 日志已清空', 'success');
     }
   }

   function escapeHtml(text) {
     const div = document.createElement('div');
     div.textContent = text;
     return div.innerHTML;
   }

   // 退出登录
   async function logout() {
     try {
       await fetch('/api/logout', { method: 'POST' });
       window.location.href = '/';
     } catch (error) {
       showToast('退出失败', 'error');
     }
   }

   // 加载配置
   async function loadConfig() {
     try {
       const response = await fetch('/api/config/load');
       const result = await response.json();
       
       if (result.success && result.config) {
         AppState.config = { ...AppState.config, ...result.config };
         
         for (const [key, value] of Object.entries(result.config)) {
           updateEnvDisplay(key, value);
         }
         
         console.log('配置已加载:', result.loadedFrom);
       }
     } catch (error) {
       console.error('加载配置失败:', error);
     }
   }

   // 快捷键支持
   document.addEventListener('keydown', (e) => {
     if ((e.ctrlKey || e.metaKey) && e.key === 's') {
       e.preventDefault();
       saveAll();
     }
     
     if (e.key === 'Escape') {
       closeModal();
       closePasswordModal();
       closeLogsModal();
       closeSliderModal();
     }
     
     if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
       e.preventDefault();
       showLogs();
     }
   });

   // 防止双击缩放
   let lastTouchEnd = 0;
   document.addEventListener('touchend', (e) => {
     const now = Date.now();
     if (now - lastTouchEnd <= 300) {
       e.preventDefault();
     }
     lastTouchEnd = now;
   }, false);

   // 初始化
   initTheme();
   loadConfig();
   
   console.log('%c🎬 弹幕 API 管理中心', 'font-size: 20px; font-weight: bold; color: #667eea;');
   console.log('%c快捷键提示:', 'font-weight: bold; color: #8b5cf6;');
   console.log('Ctrl/Cmd + S: 保存配置');
   console.log('Ctrl/Cmd + L: 查看日志');
   console.log('ESC: 关闭弹窗');
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
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="theme-color" content="#667eea">
<title>登录 - 弹幕 API</title>
<style>
  * { 
    margin: 0; 
    padding: 0; 
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent;
  }
  
  :root {
    --primary: #667eea;
    --secondary: #764ba2;
    --danger: #ef4444;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    -webkit-font-smoothing: antialiased;
  }

  .login-container {
    background: white;
    border-radius: 20px;
    padding: 2rem 1.5rem;
    width: 100%;
    max-width: 400px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
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

  .logo {
    text-align: center;
    margin-bottom: 2rem;
  }

  .logo-icon {
    font-size: 4rem;
    margin-bottom: 0.75rem;
    animation: float 3s ease-in-out infinite;
  }

  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
  }

  .logo-title {
    font-size: 1.5rem;
    font-weight: 700;
    background: linear-gradient(135deg, var(--primary), var(--secondary));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }

  .logo-subtitle {
    font-size: 0.875rem;
    color: #64748b;
  }

  .hint {
    background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
    border-left: 4px solid var(--primary);
    padding: 0.875rem 1rem;
    border-radius: 10px;
    margin-bottom: 1.5rem;
    font-size: 0.8rem;
    color: #334155;
    line-height: 1.5;
  }

  .hint strong {
    color: var(--primary);
    font-weight: 600;
  }

  .error-message {
    background: rgba(239, 68, 68, 0.1);
    border-left: 4px solid var(--danger);
    color: #dc2626;
    padding: 0.875rem 1rem;
    border-radius: 10px;
    margin-bottom: 1rem;
    font-size: 0.8rem;
    display: none;
    animation: shake 0.5s ease;
  }

  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-10px); }
    75% { transform: translateX(10px); }
  }

  .form-group {
    margin-bottom: 1.25rem;
  }

  .form-label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    color: #0f172a;
  }

  .form-input {
    width: 100%;
    padding: 0.875rem 1rem;
    border: 2px solid #e2e8f0;
    border-radius: 10px;
    font-size: 1rem;
    background: #f8fafc;
    color: #0f172a;
    transition: all 0.2s ease;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    background: white;
  }

  .btn-login {
    width: 100%;
    padding: 1rem;
    background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
    color: white;
    border: none;
    border-radius: 10px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    min-height: 48px;
  }

  .btn-login:active {
    transform: scale(0.98);
  }

  .btn-login:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
  }

  .footer {
    text-align: center;
    margin-top: 1.5rem;
    font-size: 0.75rem;
    color: #64748b;
  }

  @media (min-width: 480px) {
    .login-container {
      padding: 2.5rem 2rem;
    }
    
    .logo-icon {
      font-size: 4.5rem;
    }
  }

  /* 防止输入框缩放 */
  input {
    font-size: 16px !important;
  }
</style>
</head>
<body>
<div class="login-container">
  <div class="logo">
    <div class="logo-icon">🎬</div>
    <h1 class="logo-title">弹幕 API</h1>
    <p class="logo-subtitle">管理后台登录</p>
  </div>

  <div class="hint">
    💡 默认账号密码均为 <strong>admin</strong>
  </div>

  <div id="errorMessage" class="error-message"></div>

  <form id="loginForm">
    <div class="form-group">
      <label class="form-label">用户名</label>
      <input type="text" class="form-input" id="username" placeholder="请输入用户名" required autofocus autocomplete="username">
    </div>

    <div class="form-group">
      <label class="form-label">密码</label>
      <input type="password" class="form-input" id="password" placeholder="请输入密码" required autocomplete="current-password">
    </div>

    <button type="submit" class="btn-login" id="loginBtn">登录</button>
  </form>

  <div class="footer">
    弹幕 API 服务 | 安全登录
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
        errorMessage.textContent = result.message || '登录失败，请检查用户名和密码';
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

  // 防止双击缩放
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      e.preventDefault();
    }
    lastTouchEnd = now;
  }, false);
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
    log("info", `[save-credentials] Redis 保存${saved ? '成功' : '失败'}`);
  }
  
  if (globals.databaseValid) {
    const { saveEnvConfigs } = await import('./utils/db-util.js');
    const dbSaved = await saveEnvConfigs({
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password
    });
    saved = saved || dbSaved;
    log("info", `[save-credentials] 数据库保存${dbSaved ? '成功' : '失败'}`);
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

