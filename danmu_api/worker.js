import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";

let globals;

// ========== 会话管理 ==========
const sessions = new Map();
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

function generateSessionId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
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

// ========== 配置管理 ==========
async function mergeSaveToRedis(key, patch) {
  try {
    const { getRedisKey, setRedisKey } = await import('./utils/redis-util.js');
    const existing = await getRedisKey(key);
    let base = {};
    if (existing?.result) {
      try { base = JSON.parse(existing.result) || {}; } catch (_) { base = {}; }
    }
    const merged = { ...base, ...patch };
    const res = await setRedisKey(key, JSON.stringify(merged), true);
    if (res?.result === 'OK') {
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

  if ('TOKEN' in patch) globals.token = patch.TOKEN;

  // 环境变量处理器
  const ENV_HANDLERS = {
    'BILIBILI_COOKIE': (v) => {
      globals.bilibiliCookie = globals.bilibliCookie = globals.BILIBILI_COOKIE = v || '';
      globals.envs.bilibiliCookie = globals.envs.bilibliCookie = globals.envs.BILIBILI_COOKIE = v || '';
      Envs.env.bilibiliCookie = Envs.env.bilibliCookie = Envs.env.BILIBILI_COOKIE = v || '';
      return v ? '已设置' : '已清空';
    },
    'TMDB_API_KEY': (v) => {
      globals.tmdbApiKey = globals.TMDB_API_KEY = v || '';
      globals.envs.tmdbApiKey = globals.envs.TMDB_API_KEY = v || '';
      Envs.env.tmdbApiKey = Envs.env.TMDB_API_KEY = v || '';
      return v ? '已设置' : '已清空';
    },
    'WHITE_RATIO': (v) => {
      const ratio = parseFloat(v);
      if (!isNaN(ratio)) {
        globals.whiteRatio = globals.WHITE_RATIO = ratio;
        globals.envs.whiteRatio = globals.envs.WHITE_RATIO = ratio;
        Envs.env.whiteRatio = Envs.env.WHITE_RATIO = ratio;
        return `${ratio}`;
      }
      return null;
    },
    'BLOCKED_WORDS': (v) => {
      globals.blockedWords = globals.BLOCKED_WORDS = v || '';
      globals.envs.blockedWords = globals.envs.BLOCKED_WORDS = v || '';
      globals.blockedWordsArr = v ? v.split(',').map(w => w.trim()).filter(w => w) : [];
      globals.envs.blockedWordsArr = globals.blockedWordsArr;
      Envs.env.blockedWords = Envs.env.BLOCKED_WORDS = v || '';
      Envs.env.blockedWordsArr = globals.blockedWordsArr;
      return `${globals.blockedWordsArr.length} 个屏蔽词`;
    },
    'GROUP_MINUTE': (v) => {
      const m = parseInt(v) || 1;
      globals.groupMinute = globals.GROUP_MINUTE = m;
      globals.envs.groupMinute = globals.envs.GROUP_MINUTE = m;
      Envs.env.groupMinute = Envs.env.GROUP_MINUTE = m;
      return `${m} 分钟`;
    },
    'CONVERT_TOP_BOTTOM_TO_SCROLL': (v) => {
      const e = String(v).toLowerCase() === 'true';
      globals.convertTopBottomToScroll = globals.CONVERT_TOP_BOTTOM_TO_SCROLL = e;
      globals.envs.convertTopBottomToScroll = globals.envs.CONVERT_TOP_BOTTOM_TO_SCROLL = e;
      Envs.env.convertTopBottomToScroll = Envs.env.CONVERT_TOP_BOTTOM_TO_SCROLL = e;
      return `${e}`;
    },
    'DANMU_SIMPLIFIED': (v) => {
      const e = String(v).toLowerCase() === 'true';
      globals.danmuSimplified = globals.DANMU_SIMPLIFIED = e;
      globals.envs.danmuSimplified = globals.envs.DANMU_SIMPLIFIED = e;
      Envs.env.danmuSimplified = Envs.env.DANMU_SIMPLIFIED = e;
      return `${e}`;
    },
    'DANMU_LIMIT': (v) => {
      const l = parseInt(v) || -1;
      globals.danmuLimit = globals.DANMU_LIMIT = l;
      globals.envs.danmuLimit = globals.envs.DANMU_LIMIT = l;
      Envs.env.danmuLimit = Envs.env.DANMU_LIMIT = l;
      return `${l}`;
    },
    'DANMU_OUTPUT_FORMAT': (v) => {
      globals.danmuOutputFormat = globals.DANMU_OUTPUT_FORMAT = v || 'json';
      globals.envs.danmuOutputFormat = globals.envs.DANMU_OUTPUT_FORMAT = v || 'json';
      Envs.env.danmuOutputFormat = Envs.env.DANMU_OUTPUT_FORMAT = v || 'json';
      return v || 'json';
    }
  };

  for (const [key, value] of Object.entries(patch)) {
    if (ENV_HANDLERS[key]) {
      const result = ENV_HANDLERS[key](value);
      if (result !== null) {
        log('info', `[config] ${key} 已更新: ${result}`);
      }
    }
  }

  const safeCall = async (fn, label) => {
    try { await fn(); log('info', `[config] ${label} 成功`); }
    catch (e) { log('warn', `[config] ${label} 失败: ${e.message}`); }
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
    }, 'SOURCE_ORDER');
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
        } else if (globals.rateLimiter?.setMax) {
          globals.rateLimiter.setMax(parseInt(globals.envs.RATE_LIMIT_MAX_REQUESTS, 10));
        }
      } catch (_) {}
    }, 'RATE_LIMIT');
  }

  if (need.has('SEARCH_CACHE_MINUTES') || need.has('COMMENT_CACHE_MINUTES') || 
      need.has('REMEMBER_LAST_SELECT') || need.has('MAX_LAST_SELECT_MAP')) {
    await safeCall(async () => {
      try {
        if (globals.caches?.search?.setTTL) {
          globals.caches.search.setTTL(parseInt(globals.envs.SEARCH_CACHE_MINUTES || '1', 10) * 60);
        }
        if (globals.caches?.comment?.setTTL) {
          globals.caches.comment.setTTL(parseInt(globals.envs.COMMENT_CACHE_MINUTES || '1', 10) * 60);
        }
        if (globals.lastSelectMap?.resize && globals.envs.MAX_LAST_SELECT_MAP) {
          globals.lastSelectMap.resize(parseInt(globals.envs.MAX_LAST_SELECT_MAP, 10));
        }
        if (typeof globals.setRememberLastSelect === 'function') {
          const on = String(globals.envs.REMEMBER_LAST_SELECT).toLowerCase() === 'true';
          globals.setRememberLastSelect(on);
        }
      } catch (_) {}
    }, '缓存策略');
  }
}

// 环境变量说明
const ENV_DESCRIPTIONS = {
  'TOKEN': '自定义API访问令牌，默认87654321',
  'VERSION': '当前服务版本号',
  'LOG_LEVEL': '日志级别：error/warn/info',
  'OTHER_SERVER': '兜底第三方弹幕服务器',
  'VOD_SERVERS': 'VOD影视采集站列表，格式：名称@URL,名称@URL...',
  'VOD_RETURN_MODE': 'VOD返回模式：all/fastest',
  'VOD_REQUEST_TIMEOUT': 'VOD请求超时时间（毫秒）',
  'BILIBILI_COOKIE': 'B站Cookie，用于获取完整弹幕',
  'TMDB_API_KEY': 'TMDB API密钥',
  'SOURCE_ORDER': '数据源优先级排序',
  'PLATFORM_ORDER': '弹幕平台优先级',
  'TITLE_TO_CHINESE': '是否将外语标题转换成中文',
  'STRICT_TITLE_MATCH': '严格标题匹配模式',
  'EPISODE_TITLE_FILTER': '剧集标题正则过滤',
  'ENABLE_EPISODE_FILTER': '手动选择接口是否启用集标题过滤',
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式：json/xml',
  'DANMU_SIMPLIFIED': '是否将繁体弹幕转换为简体',
  'DANMU_LIMIT': '弹幕数量限制',
  'BLOCKED_WORDS': '弹幕屏蔽词列表',
  'GROUP_MINUTE': '弹幕合并去重时间窗口',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '是否将顶部/底部弹幕转换为滚动弹幕',
  'WHITE_RATIO': '白色弹幕占比',
  'YOUKU_CONCURRENCY': '优酷弹幕请求并发数',
  'SEARCH_CACHE_MINUTES': '搜索结果缓存时间',
  'COMMENT_CACHE_MINUTES': '弹幕数据缓存时间',
  'REMEMBER_LAST_SELECT': '是否记住用户手动选择结果',
  'MAX_LAST_SELECT_MAP': '最后选择映射的缓存大小',
  'PROXY_URL': '代理/反代地址',
  'RATE_LIMIT_MAX_REQUESTS': '限流配置：同一IP在1分钟内允许的最大请求次数',
  'UPSTASH_REDIS_REST_URL': 'Upstash Redis服务URL',
  'UPSTASH_REDIS_REST_TOKEN': 'Upstash Redis访问令牌',
  'redisValid': 'Redis连接状态',
  'redisUrl': 'Redis服务器地址',
  'redisToken': 'Redis访问令牌状态',
  'DATABASE_URL': '数据库连接URL',
  'DATABASE_AUTH_TOKEN': '数据库认证令牌'
};

const SENSITIVE_KEYS = ['TOKEN', 'BILIBILI_COOKIE', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 
                        'TMDB_API_KEY', 'PROXY_URL', 'redisUrl', 'redisToken'];

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.includes(key) || key.toLowerCase().includes('token') || 
         key.toLowerCase().includes('password') || key.toLowerCase().includes('secret') ||
         key.toLowerCase().includes('key') || key.toLowerCase().includes('cookie');
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
    const redisStatusClass = redisConfigured 
      ? (globals.redisValid ? 'badge-success' : 'badge-warning')
      : 'badge-secondary';

    if (!globals.accessedEnvVars) globals.accessedEnvVars = {};
    if (!globals.vodServers) globals.vodServers = [];
    if (!globals.sourceOrderArr) globals.sourceOrderArr = [];

    const configuredEnvCount = Object.entries(globals.accessedEnvVars).filter(([key, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'string' && value.length === 0) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }).length;

    const totalEnvCount = Object.keys(globals.accessedEnvVars).length;

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
                  <span class="info-icon" title="${description}">ℹ️</span>
                  <button class="icon-btn" onclick="editEnvVar('${key}')">✏️</button>
                </div>
              </div>
              <div class="config-value sensitive-value" 
                   data-real="${encodedRealValue}" 
                   data-masked="${maskedValue}"
                   onclick="toggleSensitive(this)">
                <code>${maskedValue}</code>
                <span class="eye-icon">👁️</span>
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
                <span class="info-icon" title="${description}">ℹ️</span>
                <button class="icon-btn" onclick="editEnvVar('${key}')">✏️</button>
              </div>
            </div>
            <div class="config-value ${valueClass}" data-original="${encodedOriginal}">
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
            <div class="server-item">
              <div class="server-badge">${index + 1}</div>
              <div class="server-info">
                <div class="server-name">${serverName}</div>
                <div class="server-url">${serverUrl}</div>
              </div>
              <div class="server-actions">
                <button class="icon-btn" onclick="editVodServer(${index})">✏️</button>
                <button class="icon-btn" onclick="deleteVodServer(${index})">🗑️</button>
              </div>
            </div>
          `;
        }).join('');
      } else {
        vodServersHtml = defaultVodServers.map((server, index) => `
          <div class="server-item">
            <div class="server-badge">默认</div>
            <div class="server-info">
              <div class="server-name">${server.name}</div>
              <div class="server-url">${server.url}</div>
            </div>
          </div>
        `).join('');
      }
    } catch (error) {
      log("error", `Generate VOD HTML error: ${error.message}`);
      vodServersHtml = `<div class="alert alert-error">无法加载 VOD 服务器列表: ${error.message}</div>`;
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
          <div class="source-item" draggable="true" data-index="${index}" data-source="${source}">
            <div class="source-priority">${index + 1}</div>
            <div class="source-icon">${icon}</div>
            <div class="source-name">${source}</div>
          </div>
        `;
      }).join('')
      : `<div class="alert alert-info">使用默认数据源顺序</div>`;

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>弹幕 API 管理后台 v${globals.VERSION}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --primary: #6366f1;
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
      --bg: #0a0a0f;
      --bg-card: #1c1c27;
      --text: #e5e7eb;
      --text-dim: #9ca3af;
      --border: #2d2d3f;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, var(--bg) 0%, #1a1a2e 100%);
      color: var(--text);
      line-height: 1.6;
    }

    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

    .header {
      background: rgba(28, 28, 39, 0.7);
      backdrop-filter: blur(10px);
      padding: 15px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }

    .header h1 { font-size: 20px; color: var(--primary); }

    .btn {
      padding: 8px 16px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.3s;
    }

    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }

    .card {
      background: rgba(28, 28, 39, 0.7);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }

    .card-title { font-size: 16px; font-weight: 700; }

    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }

    .stat-card {
      background: rgba(28, 28, 39, 0.7);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 15px;
    }

    .stat-label { color: var(--text-dim); font-size: 12px; margin-bottom: 5px; }
    .stat-value { font-size: 24px; font-weight: 700; }

    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }

    .badge-success { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
    .badge-secondary { background: rgba(156, 163, 175, 0.2); color: var(--text-dim); }

    .config-item {
      background: rgba(45, 45, 63, 0.3);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 10px;
    }

    .config-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .config-label { font-weight: 600; font-size: 14px; }

    .config-actions { display: flex; gap: 8px; }

    .icon-btn {
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 16px;
      padding: 4px;
      opacity: 0.7;
      transition: opacity 0.2s;
    }

    .icon-btn:hover { opacity: 1; }

    .info-icon {
      cursor: help;
      opacity: 0.6;
      font-size: 14px;
    }

    .config-value {
      background: rgba(0, 0, 0, 0.2);
      padding: 8px 12px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
    }

    .sensitive-value {
      cursor: pointer;
      position: relative;
      user-select: none;
    }

    .sensitive-value:hover { background: rgba(0, 0, 0, 0.3); }

    .eye-icon {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      opacity: 0.5;
      font-size: 16px;
    }

    .value-enabled { color: var(--success); }
    .value-disabled { color: var(--text-dim); }
    .value-empty { color: var(--text-dim); font-style: italic; }

    .server-item, .source-item {
      background: rgba(45, 45, 63, 0.3);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .server-badge, .source-priority {
      background: var(--primary);
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
      min-width: 30px;
      text-align: center;
    }

    .source-icon {
      width: 32px;
      height: 32px;
      background: var(--primary);
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
    }

    .server-info, .source-name { flex: 1; }

    .server-name { font-weight: 600; margin-bottom: 4px; }
    .server-url { color: var(--text-dim); font-size: 13px; }

    .server-actions { display: flex; gap: 8px; }

    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }

    .modal.active { display: flex; }

    .modal-content {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      max-width: 500px;
      width: 90%;
    }

    .modal-header {
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--border);
    }

    .modal-title { font-size: 18px; font-weight: 700; }

    .form-group { margin-bottom: 15px; }

    .form-label {
      display: block;
      margin-bottom: 6px;
      font-size: 14px;
      font-weight: 600;
    }

    .form-input, .form-textarea {
      width: 100%;
      padding: 10px 12px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 14px;
    }

    .form-textarea { min-height: 100px; resize: vertical; }

    .form-input:focus, .form-textarea:focus {
      outline: none;
      border-color: var(--primary);
    }

    .modal-footer {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 20px;
    }

    .btn-secondary {
      background: rgba(156, 163, 175, 0.2);
      color: var(--text);
    }

    .alert {
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 15px;
    }

    .alert-success { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .alert-error { background: rgba(239, 68, 68, 0.2); color: var(--error); }
    .alert-info { background: rgba(99, 102, 241, 0.2); color: var(--primary); }

    @media (max-width: 768px) {
      .stats { grid-template-columns: 1fr; }
      .header { flex-direction: column; gap: 10px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎬 弹幕 API 管理后台</h1>
    <button class="btn btn-primary" onclick="logout()">退出登录</button>
  </div>

  <div class="container">
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Redis 状态</div>
        <div class="stat-value"><span class="badge ${redisStatusClass}">${redisStatusText}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">已配置环境变量</div>
        <div class="stat-value">${configuredEnvCount} / ${totalEnvCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">敏感变量</div>
        <div class="stat-value">${sensitiveEnvCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">版本号</div>
        <div class="stat-value">v${globals.VERSION}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">🔧 环境变量配置</h2>
      </div>
      <div id="envVars">${envItemsHtml}</div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">📡 VOD 采集站</h2>
        <button class="btn btn-primary" onclick="addVodServer()">+ 添加服务器</button>
      </div>
      <div id="vodServers">${vodServersHtml}</div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">📊 数据源优先级</h2>
      </div>
      <div id="sources">${sourcesHtml}</div>
    </div>
  </div>

  <div id="editModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title" id="modalTitle">编辑配置</h3>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label" id="modalLabel">值</label>
          <input type="text" class="form-input" id="modalInput">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn btn-primary" onclick="saveModal()">保存</button>
      </div>
    </div>
  </div>

  <script>
    let currentEditKey = null;
    let currentEditIndex = null;

    function toggleSensitive(el) {
      const code = el.querySelector('code');
      const realValue = el.dataset.real;
      const maskedValue = el.dataset.masked;
      
      if (code.textContent === maskedValue) {
        code.textContent = realValue;
      } else {
        code.textContent = maskedValue;
      }
    }

    function editEnvVar(key) {
      currentEditKey = key;
      const valueEl = document.querySelector(\`[data-key="\${key}"] .config-value\`);
      let currentValue = '';
      
      if (valueEl.classList.contains('sensitive-value')) {
        currentValue = valueEl.dataset.real;
      } else {
        currentValue = valueEl.dataset.original || '';
      }

      document.getElementById('modalTitle').textContent = \`编辑 \${key}\`;
      document.getElementById('modalLabel').textContent = key;
      document.getElementById('modalInput').value = currentValue;
      document.getElementById('editModal').classList.add('active');
    }

    async function saveModal() {
      if (currentEditKey) {
        const newValue = document.getElementById('modalInput').value;
        try {
          const res = await fetch('/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [currentEditKey]: newValue })
          });
          
          if (res.ok) {
            location.reload();
          } else {
            alert('保存失败');
          }
        } catch (e) {
          alert('保存失败: ' + e.message);
        }
      }
      closeModal();
    }

    function closeModal() {
      document.getElementById('editModal').classList.remove('active');
      currentEditKey = null;
    }

    function addVodServer() {
      const name = prompt('服务器名称:');
      if (!name) return;
      const url = prompt('服务器URL:');
      if (!url) return;
      
      fetch('/admin/vod/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url })
      }).then(() => location.reload());
    }

    function editVodServer(index) {
      const name = prompt('服务器名称:');
      if (!name) return;
      const url = prompt('服务器URL:');
      if (!url) return;
      
      fetch('/admin/vod/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, name, url })
      }).then(() => location.reload());
    }

    function deleteVodServer(index) {
      if (!confirm('确定删除此服务器?')) return;
      
      fetch('/admin/vod/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index })
      }).then(() => location.reload());
    }

    function logout() {
      document.cookie = 'session=; Max-Age=0';
      location.reload();
    }
  </script>
</body>
</html>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  function getLoginPage() {
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - 弹幕 API 管理后台</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #e5e7eb;
    }
    .login-box {
      background: rgba(28, 28, 39, 0.9);
      backdrop-filter: blur(10px);
      border: 1px solid #2d2d3f;
      border-radius: 16px;
      padding: 40px;
      width: 90%;
      max-width: 400px;
    }
    h1 { text-align: center; margin-bottom: 30px; color: #6366f1; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-weight: 600; }
    input {
      width: 100%;
      padding: 12px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid #2d2d3f;
      border-radius: 8px;
      color: #e5e7eb;
      font-size: 14px;
    }
    input:focus { outline: none; border-color: #6366f1; }
    button {
      width: 100%;
      padding: 12px;
      background: #6366f1;
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }
    button:hover { opacity: 0.9; transform: translateY(-1px); }
    .error { color: #ef4444; margin-top: 10px; text-align: center; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>🔐 管理后台登录</h1>
    <form id="loginForm">
      <div class="form-group">
        <label>访问令牌</label>
        <input type="password" id="token" placeholder="请输入TOKEN" required>
      </div>
      <button type="submit">登录</button>
      <div class="error" id="error"></div>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value;
      try {
        const res = await fetch('/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (res.ok) {
          const data = await res.json();
          document.cookie = \`session=\${data.sessionId}; Max-Age=86400; Path=/\`;
          location.reload();
        } else {
          document.getElementById('error').textContent = '令牌错误';
        }
      } catch (e) {
        document.getElementById('error').textContent = '登录失败';
      }
    });
  </script>
</body>
</html>
    `;
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // 路由处理
  if (path === '/' || path === '/admin') {
    return handleHomepage(req);
  }

  if (path === '/admin/login' && method === 'POST') {
    const { token } = await req.json();
    if (token === globals.token) {
      const sessionId = generateSessionId();
      sessions.set(sessionId, { createdAt: Date.now() });
      return jsonResponse({ sessionId });
    }
    return new Response('Unauthorized', { status: 401 });
  }

  if (path === '/admin/config' && method === 'POST') {
    const patch = await req.json();
    await applyConfigPatch(patch);
    await mergeSaveToRedis('CONFIG', patch);
    return jsonResponse({ success: true });
  }

  if (path === '/admin/vod/add' && method === 'POST') {
    const { name, url } = await req.json();
    globals.vodServers.push(`${name}@${url}`);
    await mergeSaveToRedis('CONFIG', { VOD_SERVERS: globals.vodServers.join(',') });
    return jsonResponse({ success: true });
  }

  if (path === '/admin/vod/update' && method === 'POST') {
    const { index, name, url } = await req.json();
    globals.vodServers[index] = `${name}@${url}`;
    await mergeSaveToRedis('CONFIG', { VOD_SERVERS: globals.vodServers.join(',') });
    return jsonResponse({ success: true });
  }

  if (path === '/admin/vod/delete' && method === 'POST') {
    const { index } = await req.json();
    globals.vodServers.splice(index, 1);
    await mergeSaveToRedis('CONFIG', { VOD_SERVERS: globals.vodServers.join(',') });
    return jsonResponse({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}

export default { handleRequest };

