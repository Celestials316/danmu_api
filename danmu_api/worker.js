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
  'LOG_LEVEL': '日志级别：error（仅错误）/ warn（警告+错误）/ info（全部日志），默认info',
  'OTHER_SERVER': '兜底第三方弹幕服务器，当所有平台都获取失败时使用，默认api.danmu.icu',
  'VOD_SERVERS': 'VOD影视采集站列表，格式：名称@URL,名称@URL...（多个用逗号分隔）',
  'VOD_RETURN_MODE': 'VOD返回模式：all（返回所有站点结果）/ fastest（仅返回最快响应的站点），默认all',
  'VOD_REQUEST_TIMEOUT': 'VOD单个请求超时时间（毫秒），默认10000（10秒）',
  'BILIBILI_COOKIE': 'B站Cookie，用于获取完整弹幕数据（最少需要SESSDATA字段）',
  'TMDB_API_KEY': 'TMDB API密钥，用于将外语标题转换为中文标题，提升巴哈姆特搜索准确度',
  'SOURCE_ORDER': '数据源优先级排序，影响自动匹配时的搜索顺序（如：bilibili,iqiyi,youku）',
  'PLATFORM_ORDER': '弹幕平台优先级，优先返回指定平台的弹幕数据',
  'TITLE_TO_CHINESE': '在match接口自动匹配时，是否将外语标题转换成中文标题（需配合TMDB_API_KEY使用），默认false',
  'STRICT_TITLE_MATCH': '严格标题匹配模式：仅匹配剧名开头或完全匹配，过滤不相关结果，默认false',
  'EPISODE_TITLE_FILTER': '剧集标题正则过滤表达式，用于过滤预告、花絮等非正片内容',
  'ENABLE_EPISODE_FILTER': '手动选择接口（select）是否启用集标题过滤，默认false',
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式：json（JSON格式）/ xml（Bilibili XML格式），默认json',
  'DANMU_SIMPLIFIED': '是否将繁体弹幕转换为简体中文（主要用于巴哈姆特），默认true',
  'DANMU_LIMIT': '弹幕数量限制，-1表示不限制，其他数字为最大返回条数',
  'BLOCKED_WORDS': '弹幕屏蔽词列表，过滤包含指定关键词的弹幕（多个词用逗号分隔）',
  'GROUP_MINUTE': '弹幕合并去重时间窗口（分钟），相同内容在该时间内只保留一条，默认1',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '是否将顶部/底部弹幕转换为滚动弹幕，默认false',
  'WHITE_RATIO': '白色弹幕占比（0-100），-1表示不转换颜色，其他值表示将指定比例弹幕转为白色',
  'YOUKU_CONCURRENCY': '优酷弹幕请求并发数，默认8，最高16（并发数越高速度越快但资源消耗越大）',
  'SEARCH_CACHE_MINUTES': '搜索结果缓存时间（分钟），减少重复搜索请求，默认1',
  'COMMENT_CACHE_MINUTES': '弹幕数据缓存时间（分钟），减少重复弹幕获取，默认1',
  'REMEMBER_LAST_SELECT': '是否记住用户手动选择结果，优化后续自动匹配准确度，默认true',
  'MAX_LAST_SELECT_MAP': '最后选择映射的缓存大小限制，默认100条（超出后会删除最旧的记录）',
  'PROXY_URL': '代理/反代地址，用于访问巴哈姆特和TMDB（支持混合配置，如：bahamut=proxy1,tmdb=proxy2）',
  'RATE_LIMIT_MAX_REQUESTS': '限流配置：同一IP在1分钟内允许的最大请求次数，默认3（防止滥用）',
  'UPSTASH_REDIS_REST_URL': 'Upstash Redis服务URL，用于持久化存储防止冷启动数据丢失（适用于Vercel/Netlify等平台）',
  'UPSTASH_REDIS_REST_TOKEN': 'Upstash Redis访问令牌，需要配合UPSTASH_REDIS_REST_URL一起使用',
  'redisValid': 'Redis连接状态：已连接 / 未连接（自动检测）',
  'redisUrl': 'Redis服务器地址（显示配置的URL，隐藏敏感信息）',
  'redisToken': 'Redis访问令牌状态（显示是否已配置，隐藏实际令牌）',
  'DATABASE_URL': '数据库连接URL，支持本地SQLite（file:/path/to/db）和Cloudflare D1（libsql://xxx），用于持久化存储缓存和配置数据',
  'DATABASE_AUTH_TOKEN': '数据库认证令牌，远程数据库（如Cloudflare D1）需要配置，本地SQLite文件可不填'
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
    const redisStatusClass = redisConfigured 
      ? (globals.redisValid ? 'badge-success' : 'badge-warning')
      : 'badge-secondary';

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

    const sensitiveEnvCount = Object.entries(globals.accessedEnvVars).filter(([key, value]) => {
      if (!isSensitiveKey(key)) return false;
      if (value === null || value === undefined) return false;
      if (typeof value === 'string' && value.length === 0) return false;
      return true;
    }).length;

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
            <div class="cfg-item" data-key="${key}">
              <div class="cfg-header">
                <span class="cfg-label">${key}</span>
                <div class="cfg-actions">
                  <span class="info-icon" title="${description}">ℹ️</span>
                  <button class="btn-icon" onclick="editEnv('${key}')">✏️</button>
                </div>
              </div>
              <div class="cfg-value sensitive" data-real="${encodedRealValue}" data-masked="${maskedValue}" onclick="toggleSensitive(this)">
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
          <div class="cfg-item" data-key="${key}">
            <div class="cfg-header">
              <span class="cfg-label">${key}</span>
              <div class="cfg-actions">
                <span class="info-icon" title="${description}">ℹ️</span>
                <button class="btn-icon" onclick="editEnv('${key}')">✏️</button>
              </div>
            </div>
            <div class="cfg-value ${valueClass}" data-original="${encodedOriginal}" title="双击复制">
              <code>${displayValue}</code>
            </div>
          </div>
        `;
      })
      .join('');

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
                <button class="btn-icon" onclick="editVod(${index})">✏️</button>
                <button class="btn-icon btn-del" onclick="deleteVod(${index})">🗑️</button>
              </div>
            </div>
          `;
        }).join('');
      } else {
        vodServersHtml = defaultVodServers.map((server, index) => `
          <div class="server-item" data-index="${index}">
            <div class="server-badge">默认</div>
            <div class="server-info">
              <div class="server-name">${server.name}</div>
              <div class="server-url">${server.url}</div>
</div>
           <div class="server-actions">
             <button class="btn-icon" onclick="editVod(${index})">✏️</button>
           </div>
         </div>
       `).join('');
     }
   } catch (error) {
     log("error", `Generate VOD HTML error: ${error.message}`);
     vodServersHtml = `<div class="alert alert-error">无法加载 VOD 服务器列表: ${error.message}</div>`;
   }

   const sourceIcons = {
     'dandan': 'D', 'bilibili': 'B', 'iqiyi': 'I', 'youku': 'Y', 
     'tencent': 'T', 'mgtv': 'M', 'bahamut': 'BH'
   };

   const sourcesHtml = globals.sourceOrderArr.length > 0 
     ? globals.sourceOrderArr.map((source, index) => {
       const icon = sourceIcons[source.toLowerCase()] || source.charAt(0).toUpperCase();
       return `
         <div class="source-item" draggable="true" data-index="${index}" data-source="${source}">
           <span class="drag-handle">⋮⋮</span>
           <div class="source-badge">${index + 1}</div>
           <div class="source-icon">${icon}</div>
           <span class="source-name">${source}</span>
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
     --primary-dark: #4f46e5;
     --success: #10b981;
     --warning: #f59e0b;
     --error: #ef4444;
     --bg-1: #0a0a0f;
     --bg-2: #13131a;
     --bg-3: #1c1c27;
     --text-1: #e5e7eb;
     --text-2: #9ca3af;
     --text-3: #6b7280;
     --border: #2d2d3f;
   }

   body {
     font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
     background: linear-gradient(135deg, var(--bg-1) 0%, #1a1a2e 100%);
     color: var(--text-1);
     line-height: 1.6;
   }

   body.light {
     --bg-1: #f8fafc;
     --bg-2: #ffffff;
     --bg-3: #f1f5f9;
     --text-1: #1e293b;
     --text-2: #475569;
     --text-3: #94a3b8;
     --border: #e2e8f0;
     background: linear-gradient(135deg, #f8fafc 0%, #e0e7ff 100%);
   }

   .container {
     max-width: 1400px;
     margin: 0 auto;
     padding: 20px;
   }

   /* Header */
   .header {
     background: rgba(28, 28, 39, 0.7);
     backdrop-filter: blur(20px);
     border: 1px solid rgba(255, 255, 255, 0.1);
     border-radius: 16px;
     padding: 24px;
     margin-bottom: 24px;
     display: flex;
     justify-content: space-between;
     align-items: center;
     gap: 20px;
   }

   .logo {
     display: flex;
     align-items: center;
     gap: 12px;
   }

   .logo-icon {
     width: 48px;
     height: 48px;
     background: linear-gradient(135deg, var(--primary), var(--primary-dark));
     border-radius: 12px;
     display: flex;
     align-items: center;
     justify-content: center;
     font-size: 24px;
   }

   .logo-text h1 {
     font-size: 20px;
     background: linear-gradient(135deg, var(--primary), var(--primary-dark));
     -webkit-background-clip: text;
     -webkit-text-fill-color: transparent;
   }

   .logo-text p { font-size: 12px; color: var(--text-3); }

   .header-actions {
     display: flex;
     gap: 8px;
     align-items: center;
   }

   /* Tabs */
   .tabs {
     display: flex;
     gap: 8px;
     margin-bottom: 24px;
     border-bottom: 2px solid var(--border);
     overflow-x: auto;
   }

   .tab {
     padding: 12px 24px;
     background: transparent;
     border: none;
     color: var(--text-2);
     font-size: 14px;
     font-weight: 600;
     cursor: pointer;
     border-bottom: 3px solid transparent;
     margin-bottom: -2px;
     white-space: nowrap;
     transition: all 0.3s;
   }

   .tab:hover { color: var(--text-1); background: var(--bg-3); }
   .tab.active {
     color: var(--primary);
     border-bottom-color: var(--primary);
   }

   /* Cards */
   .card {
     background: rgba(28, 28, 39, 0.7);
     backdrop-filter: blur(20px);
     border: 1px solid rgba(255, 255, 255, 0.1);
     border-radius: 16px;
     padding: 24px;
     margin-bottom: 24px;
   }

   .card-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 20px;
     padding-bottom: 16px;
     border-bottom: 2px solid var(--border);
     gap: 12px;
     flex-wrap: wrap;
   }

   .card-title {
     font-size: 18px;
     font-weight: 700;
     display: flex;
     align-items: center;
     gap: 8px;
   }

   /* Stats Grid */
   .stats {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
     gap: 16px;
     margin-bottom: 24px;
   }

   .stat-card {
     background: rgba(28, 28, 39, 0.7);
     backdrop-filter: blur(20px);
     border: 1px solid rgba(255, 255, 255, 0.1);
     border-radius: 16px;
     padding: 20px;
     transition: transform 0.3s;
   }

   .stat-card:hover { transform: translateY(-4px); }

   .stat-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 12px;
   }

   .stat-title {
     font-size: 12px;
     color: var(--text-2);
     font-weight: 600;
     text-transform: uppercase;
   }

   .stat-icon {
     width: 40px;
     height: 40px;
     border-radius: 10px;
     display: flex;
     align-items: center;
     justify-content: center;
     font-size: 20px;
     background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(99, 102, 241, 0.1));
   }

   .stat-value {
     font-size: 28px;
     font-weight: 800;
     margin-bottom: 4px;
   }

   .stat-footer {
     font-size: 12px;
     color: var(--text-3);
   }

   /* Config Items */
   .cfg-grid { display: grid; gap: 12px; }

   .cfg-item {
     background: var(--bg-3);
     border: 1px solid var(--border);
     border-radius: 12px;
     padding: 16px;
     transition: all 0.3s;
   }

   .cfg-item:hover {
     border-color: var(--primary);
     transform: translateX(4px);
   }

   .cfg-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 10px;
   }

   .cfg-label {
     font-size: 12px;
     font-weight: 700;
     color: var(--primary);
     text-transform: uppercase;
   }

   .cfg-actions {
     display: flex;
     gap: 8px;
     align-items: center;
   }

   .cfg-value {
     font-family: 'Consolas', 'Monaco', monospace;
     font-size: 13px;
     background: var(--bg-1);
     padding: 10px 12px;
     border-radius: 8px;
     border: 1px solid var(--border);
     word-break: break-all;
   }

   .cfg-value.value-enabled { color: var(--success); font-weight: 700; }
   .cfg-value.value-disabled { color: var(--error); font-weight: 700; }
   .cfg-value.value-empty { color: var(--text-3); font-style: italic; }

   .cfg-value.sensitive {
     cursor: pointer;
     position: relative;
     padding-right: 40px;
   }

   .cfg-value.sensitive:hover { border-color: var(--primary); }

   .eye-icon {
     position: absolute;
     right: 12px;
     top: 50%;
     transform: translateY(-50%);
     opacity: 0.6;
   }

   .sensitive:hover .eye-icon { opacity: 1; }

   /* Server Items */
   .server-grid { display: grid; gap: 12px; }

   .server-item {
     display: flex;
     align-items: center;
     gap: 12px;
     background: var(--bg-3);
     border: 1px solid var(--border);
     border-radius: 12px;
     padding: 16px;
     transition: all 0.3s;
   }

   .server-item:hover {
     border-color: var(--primary);
     transform: translateX(6px);
   }

   .server-badge {
     width: 36px;
     height: 36px;
     border-radius: 8px;
     background: linear-gradient(135deg, var(--primary), var(--primary-dark));
     color: white;
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     font-size: 14px;
     flex-shrink: 0;
   }

   .server-info { flex: 1; min-width: 0; }

   .server-name {
     font-size: 14px;
     font-weight: 700;
     margin-bottom: 4px;
   }

   .server-url {
     font-size: 12px;
     color: var(--text-2);
     font-family: 'Consolas', 'Monaco', monospace;
     overflow: hidden;
     text-overflow: ellipsis;
     white-space: nowrap;
   }

   .server-actions { display: flex; gap: 8px; }

   /* Source Items */
   .source-grid { display: grid; gap: 12px; }

   .source-item {
     display: flex;
     align-items: center;
     gap: 12px;
     background: var(--bg-3);
     border: 1px solid var(--border);
     border-radius: 12px;
     padding: 14px;
     cursor: grab;
     transition: all 0.3s;
   }

   .source-item:hover {
     border-color: var(--primary);
     transform: translateY(-2px);
   }

   .source-item.dragging { opacity: 0.5; cursor: grabbing; }

   .drag-handle {
     color: var(--text-3);
     cursor: grab;
     font-size: 18px;
   }

   .source-badge {
     width: 28px;
     height: 28px;
     border-radius: 6px;
     background: linear-gradient(135deg, var(--primary), var(--primary-dark));
     color: white;
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     font-size: 12px;
   }

   .source-icon {
     width: 36px;
     height: 36px;
     border-radius: 8px;
     background: var(--bg-2);
     border: 2px solid var(--border);
     display: flex;
     align-items: center;
     justify-content: center;
     font-weight: 800;
     color: var(--primary);
   }

   .source-name {
     font-size: 14px;
     font-weight: 700;
     flex: 1;
   }

   /* Buttons */
   .btn {
     display: inline-flex;
     align-items: center;
     justify-content: center;
     gap: 6px;
     padding: 10px 18px;
     border-radius: 8px;
     font-size: 14px;
     font-weight: 600;
     cursor: pointer;
     border: none;
     transition: all 0.3s;
     white-space: nowrap;
   }

   .btn-primary {
     background: linear-gradient(135deg, var(--primary), var(--primary-dark));
     color: white;
   }

   .btn-primary:hover { transform: translateY(-2px); }

   .btn-secondary {
     background: var(--bg-3);
     color: var(--text-1);
     border: 1px solid var(--border);
   }

   .btn-secondary:hover { border-color: var(--primary); }

   .btn-success {
     background: linear-gradient(135deg, var(--success), #059669);
     color: white;
   }

   .btn-icon {
     width: 32px;
     height: 32px;
     padding: 0;
     border-radius: 8px;
     background: var(--bg-3);
     border: 1px solid var(--border);
     cursor: pointer;
     display: flex;
     align-items: center;
     justify-content: center;
     transition: all 0.3s;
   }

   .btn-icon:hover {
     border-color: var(--primary);
     background: var(--primary);
     color: white;
   }

   .btn-del:hover {
     border-color: var(--error);
     background: var(--error);
   }

   /* Badge */
   .badge {
     display: inline-flex;
     align-items: center;
     gap: 4px;
     padding: 4px 10px;
     border-radius: 6px;
     font-size: 11px;
     font-weight: 700;
     text-transform: uppercase;
   }

   .badge-success {
     background: rgba(16, 185, 129, 0.2);
     color: var(--success);
   }

   .badge-warning {
     background: rgba(245, 158, 11, 0.2);
     color: var(--warning);
   }

   .badge-secondary {
     background: var(--bg-3);
     color: var(--text-2);
   }

   /* Alert */
   .alert {
     padding: 14px 16px;
     border-radius: 10px;
     font-size: 14px;
     margin-bottom: 16px;
     display: flex;
     align-items: center;
     gap: 10px;
   }

   .alert-info {
     background: rgba(59, 130, 246, 0.1);
     border: 1px solid rgba(59, 130, 246, 0.3);
     color: #3b82f6;
   }

   .alert-error {
     background: rgba(239, 68, 68, 0.1);
     border: 1px solid var(--error);
     color: var(--error);
   }

   .alert-success {
     background: rgba(16, 185, 129, 0.1);
     border: 1px solid var(--success);
     color: var(--success);
   }

   /* Modal */
   .modal-overlay {
     position: fixed;
     inset: 0;
     background: rgba(0, 0, 0, 0.7);
     backdrop-filter: blur(8px);
     display: none;
     align-items: center;
     justify-content: center;
     z-index: 9999;
   }

   .modal-overlay.show { display: flex; }

   .modal {
     background: var(--bg-2);
     border: 1px solid var(--border);
     border-radius: 16px;
     padding: 28px;
     max-width: 500px;
     width: 90%;
     max-height: 85vh;
     overflow-y: auto;
   }

   .modal-header {
     display: flex;
     justify-content: space-between;
     align-items: center;
     margin-bottom: 20px;
     padding-bottom: 16px;
     border-bottom: 2px solid var(--border);
   }

   .modal-title {
     font-size: 20px;
     font-weight: 700;
   }

   .modal-close {
     background: transparent;
     border: none;
     font-size: 24px;
     cursor: pointer;
     color: var(--text-2);
     transition: color 0.3s;
   }

   .modal-close:hover { color: var(--error); }

   .modal-body { margin-bottom: 20px; }

   .form-group { margin-bottom: 16px; }

   .form-label {
     display: block;
     font-size: 14px;
     font-weight: 600;
     margin-bottom: 8px;
   }

   .form-input,
   .form-textarea {
     width: 100%;
     padding: 10px 14px;
     background: var(--bg-3);
     border: 1px solid var(--border);
     border-radius: 8px;
     color: var(--text-1);
     font-size: 14px;
     font-family: inherit;
     transition: all 0.3s;
   }

   .form-input:focus,
   .form-textarea:focus {
     outline: none;
     border-color: var(--primary);
   }

   .form-textarea {
     resize: vertical;
     min-height: 100px;
     font-family: 'Consolas', 'Monaco', monospace;
   }

   .form-hint {
     font-size: 12px;
     color: var(--text-3);
     margin-top: 4px;
   }

   .modal-footer {
     display: flex;
     gap: 10px;
     justify-content: flex-end;
   }

   /* Toast */
   .toast-container {
     position: fixed;
     bottom: 20px;
     right: 20px;
     z-index: 99999;
     display: flex;
     flex-direction: column;
     gap: 10px;
     max-width: 400px;
   }

   .toast {
     background: var(--bg-2);
     border: 1px solid var(--border);
     border-radius: 10px;
     padding: 14px 16px;
     display: flex;
     align-items: center;
     gap: 10px;
     font-size: 14px;
     animation: slideIn 0.3s;
   }

   @keyframes slideIn {
     from { transform: translateX(400px); opacity: 0; }
     to { transform: translateX(0); opacity: 1; }
   }

   .toast-success { border-left: 4px solid var(--success); }
   .toast-error { border-left: 4px solid var(--error); }
   .toast-warning { border-left: 4px solid var(--warning); }
   .toast-info { border-left: 4px solid #3b82f6; }

   .toast-close {
     background: transparent;
     border: none;
     font-size: 18px;
     cursor: pointer;
     color: var(--text-2);
     margin-left: auto;
   }

   /* Switch */
   .switch {
     position: relative;
     display: inline-block;
     width: 44px;
     height: 24px;
   }

   .switch input { display: none; }

   .switch-slider {
     position: absolute;
     cursor: pointer;
     inset: 0;
     background: var(--bg-3);
     border: 1px solid var(--border);
     transition: all 0.3s;
     border-radius: 24px;
   }

   .switch-slider:before {
     position: absolute;
     content: "";
     height: 16px;
     width: 16px;
     left: 3px;
     bottom: 3px;
     background: white;
     transition: all 0.3s;
     border-radius: 50%;
   }

   .switch input:checked + .switch-slider {
     background: var(--primary);
     border-color: var(--primary);
   }

   .switch input:checked + .switch-slider:before {
     transform: translateX(20px);
   }

   /* Info Icon */
   .info-icon {
     font-size: 14px;
     cursor: help;
     opacity: 0.6;
     transition: opacity 0.3s;
   }

   .info-icon:hover { opacity: 1; }

   /* Page Sections */
   .page { display: none; }
   .page.active { display: block; }

   /* Responsive */
   @media (max-width: 768px) {
     .container { padding: 12px; }
     
     .header {
       flex-direction: column;
       align-items: flex-start;
       padding: 16px;
     }

     .header-actions {
       width: 100%;
       justify-content: space-between;
     }

     .tabs { gap: 4px; }
     
     .tab {
       padding: 10px 16px;
       font-size: 13px;
     }

     .card { padding: 16px; }

     .stats {
       grid-template-columns: 1fr;
       gap: 12px;
     }

     .card-header {
       flex-direction: column;
       align-items: flex-start;
     }

     .server-item {
       flex-wrap: wrap;
       padding: 12px;
     }

     .server-info {
       width: 100%;
       padding-left: 48px;
     }

     .server-actions {
       width: 100%;
       justify-content: flex-end;
       padding-left: 48px;
     }

     .source-item { cursor: default; }
     .drag-handle { display: none; }

     .modal {
       width: 95%;
       padding: 20px;
     }

     .modal-footer {
       flex-direction: column-reverse;
     }

     .modal-footer .btn { width: 100%; }

     .toast-container {
       bottom: 12px;
       right: 12px;
       left: 12px;
       max-width: none;
     }
   }
 </style>
</head>
<body>
 <div class="toast-container" id="toastContainer"></div>

 <div class="container">
   <!-- Header -->
   <div class="header">
     <div class="logo">
       <div class="logo-icon">🎬</div>
       <div class="logo-text">
         <h1>弹幕 API 管理后台</h1>
         <p>v${globals.VERSION}</p>
       </div>
     </div>
     <div class="header-actions">
       <button class="btn-icon" onclick="toggleTheme()" title="切换主题">🌙</button>
       <button class="btn-icon" onclick="showChangePasswordModal()" title="修改密码">🔑</button>
       <button class="btn-icon" onclick="logout()" title="退出登录">🚪</button>
     </div>
   </div>

   <!-- Tabs -->
   <div class="tabs">
     <button class="tab active" onclick="switchPage('overview')">📊 概览</button>
     <button class="tab" onclick="switchPage('config')">⚙️ 环境配置</button>
     <button class="tab" onclick="switchPage('vod')">🎬 VOD采集站</button>
     <button class="tab" onclick="switchPage('sources')">🔗 数据源</button>
     <button class="tab" onclick="switchPage('danmu')">💬 弹幕配置</button>
   </div>

   <!-- Overview Page -->
   <div id="overview-page" class="page active">
     <div class="stats">
       <div class="stat-card">
         <div class="stat-header">
           <span class="stat-title">环境变量</span>
           <div class="stat-icon">⚙️</div>
         </div>
         <div class="stat-value">${configuredEnvCount}/${totalEnvCount}</div>
         <div class="stat-footer">
           ${sensitiveEnvCount > 0 ? `🔒 隐私变量: ${sensitiveEnvCount} 个` : '已配置 / 总数'}
         </div>
       </div>
       
       <div class="stat-card">
         <div class="stat-header">
           <span class="stat-title">VOD 采集站</span>
           <div class="stat-icon">🎬</div>
         </div>
         <div class="stat-value">${globals.vodServers.length}</div>
         <div class="stat-footer">
           ${globals.vodReturnMode === 'all' ? '📊 返回所有' : '⚡ 最快响应'}
         </div>
       </div>
       
       <div class="stat-card">
         <div class="stat-header">
           <span class="stat-title">数据源</span>
           <div class="stat-icon">🔗</div>
         </div>
         <div class="stat-value">${globals.sourceOrderArr.length > 0 ? globals.sourceOrderArr.length : '默认'}</div>
         <div class="stat-footer">
           ${globals.sourceOrderArr.length > 0 ? `🔝 ${globals.sourceOrderArr[0]}` : '📋 默认顺序'}
         </div>
       </div>
       
       <div class="stat-card">
         <div class="stat-header">
           <span class="stat-title">存储状态</span>
           <div class="stat-icon">💾</div>
         </div>
         <div class="stat-value">${
           globals.databaseValid ? 'DB' : 
           (redisConfigured && globals.redisValid) ? 'Redis' : 
           '内存'
         }</div>
         <div class="stat-footer">
           ${
             globals.databaseValid ? '✅ 数据库' : 
             (redisConfigured && globals.redisValid) ? '✅ Redis' : 
             '📝 仅内存'
           }
         </div>
       </div>
     </div>

     <div class="card">
       <div class="card-header">
         <h3 class="card-title">✅ 系统状态</h3>
         <span class="badge badge-success">运行正常</span>
       </div>
       <div class="cfg-grid">
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">持久化存储</span>
             <span class="badge ${
               globals.databaseValid ? 'badge-success' : 
               (redisConfigured && globals.redisValid) ? 'badge-success' : 
               'badge-secondary'
             }">
               ${
                 globals.databaseValid ? '数据库在线' : 
                 (redisConfigured && globals.redisValid) ? 'Redis在线' : 
                 '未启用'
               }
             </span>
           </div>
           <div class="cfg-value">
             <code>
               ${
                 globals.databaseValid 
                   ? '✅ 数据库存储已启用' 
                   : (redisConfigured && globals.redisValid)
                     ? '✅ Redis存储已启用'
                     : '📝 未配置持久化存储'
               }
             </code>
           </div>
         </div>
         
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">限流配置</span>
             <span class="badge ${globals.rateLimitMaxRequests > 0 ? 'badge-success' : 'badge-secondary'}">
               ${globals.rateLimitMaxRequests > 0 ? '已启用' : '未启用'}
             </span>
           </div>
           <div class="cfg-value">
             <code>
               ${globals.rateLimitMaxRequests > 0 
                 ? `🛡️ ${globals.rateLimitMaxRequests} 次/分钟` 
                 : '🔓 未启用'}
             </code>
           </div>
         </div>
         
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">缓存策略</span>
           </div>
           <div class="cfg-value">
             <code>
               🔍 搜索: ${globals.searchCacheMinutes}分钟 | 💬 弹幕: ${globals.commentCacheMinutes}分钟
             </code>
           </div>
         </div>
       </div>
     </div>
   </div>

   <!-- Config Page -->
   <div id="config-page" class="page">
     <div class="card">
       <div class="card-header">
         <h3 class="card-title">⚙️ 环境变量配置</h3>
         <div style="display: flex; gap: 8px;">
           <button class="btn btn-secondary" onclick="exportConfig()">📥 导出</button>
           <button class="btn btn-primary" onclick="saveAllConfig()">💾 保存全部</button>
         </div>
       </div>
       <div class="cfg-grid" id="configGrid">
         ${envItemsHtml}
       </div>
     </div>
   </div>

   <!-- VOD Page -->
   <div id="vod-page" class="page">
     <div class="card">
       <div class="card-header">
         <h3 class="card-title">🎬 VOD 采集服务器</h3>
         <button class="btn btn-success" onclick="addVodServer()">➕ 添加服务器</button>
       </div>
       <div class="server-grid" id="vodServerGrid">
         ${vodServersHtml}
       </div>
     </div>

     <div class="card">
       <div class="card-header">
         <h3 class="card-title">🎛️ VOD 配置参数</h3>
       </div>
       <div class="cfg-grid">
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">返回模式</span>
             <label class="switch">
               <input type="checkbox" ${globals.vodReturnMode === 'all' ? 'checked' : ''} onchange="toggleVodReturnMode(this)">
               <span class="switch-slider"></span>
             </label>
           </div>
           <div class="cfg-value">
             <code>${globals.vodReturnMode === 'all' ? '返回所有站点结果' : '仅返回最快响应站点'}</code>
           </div>
         </div>
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">请求超时</span>
             <button class="btn-icon" onclick="editVodTimeout()">✏️</button>
           </div>
           <div class="cfg-value">
             <code>${globals.vodRequestTimeout} 毫秒</code>
           </div>
         </div>
       </div>
     </div>
   </div>

   <!-- Sources Page -->
   <div id="sources-page" class="page">
     <div class="card">
       <div class="card-header">
         <h3 class="card-title">🔗 数据源优先级</h3>
         <div style="display: flex; gap: 8px;">
           <button class="btn btn-secondary" onclick="resetSourceOrder()">🔄 重置</button>
           <button class="btn btn-primary" onclick="saveSourceOrder()">💾 保存</button>
         </div>
       </div>
       <div class="alert alert-info">
         ℹ️ 拖动数据源可调整优先级，数字越小优先级越高
       </div>
       <div class="source-grid" id="sourceGrid">
         ${sourcesHtml}
       </div>
     </div>

     <div class="card">
       <div class="card-header">
         <h3 class="card-title">📋 匹配策略</h3>
       </div>
       <div class="cfg-grid">
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">严格匹配</span>
             <label class="switch">
               <input type="checkbox" ${globals.strictTitleMatch ? 'checked' : ''} onchange="toggleStrictMatch(this)">
               <span class="switch-slider"></span>
             </label>
           </div>
           <div class="cfg-value ${globals.strictTitleMatch ? 'value-enabled' : 'value-disabled'}">
             <code>${globals.strictTitleMatch ? '已启用' : '已禁用'}</code>
           </div>
         </div>
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">记住选择</span>
             <label class="switch">
               <input type="checkbox" ${globals.rememberLastSelect ? 'checked' : ''} onchange="toggleRememberSelect(this)">
               <span class="switch-slider"></span>
             </label>
           </div>
           <div class="cfg-value ${globals.rememberLastSelect ? 'value-enabled' : 'value-disabled'}">
             <code>${globals.rememberLastSelect ? '已启用' : '已禁用'}</code>
           </div>
         </div>
       </div>
     </div>
   </div>

   <!-- Danmu Page -->
   <div id="danmu-page" class="page">
     <div class="card">
       <div class="card-header">
         <h3 class="card-title">💬 弹幕处理配置</h3>
       </div>
       <div class="cfg-grid">
         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">输出格式</span>
             <button class="btn-icon" onclick="editDanmuFormat()">✏️</button>
           </div>
           <div class="cfg-value">
             <code>${globals.danmuOutputFormat.toUpperCase()}</code>
           </div>
         </div>

         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">繁体转简体</span>
             <label class="switch">
               <input type="checkbox" ${globals.danmuSimplified ? 'checked' : ''} onchange="toggleDanmuSimplified(this)">
               <span class="switch-slider"></span>
             </label>
           </div>
           <div class="cfg-value ${globals.danmuSimplified ? 'value-enabled' : 'value-disabled'}">
             <code>${globals.danmuSimplified ? '已启用' : '已禁用'}</code>
           </div>
         </div>

         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">数量限制</span>
             <button class="btn-icon" onclick="editDanmuLimit()">✏️</button>
           </div>
           <div class="cfg-value">
             <code>${globals.danmuLimit > 0 ? globals.danmuLimit + ' 条' : '不限制'}</code>
           </div>
         </div>

         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">屏蔽词</span>
             <button class="btn-icon" onclick="editBlockedWords()">✏️</button>
           </div>
           <div class="cfg-value">
             <code>${globals.blockedWordsArr?.length || 0} 个屏蔽词</code>
           </div>
         </div>

         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">合并时间窗口</span>
             <button class="btn-icon" onclick="editGroupMinute()">✏️</button>
           </div>
           <div class="cfg-value">
             <code>${globals.groupMinute} 分钟</code>
           </div>
         </div>

         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">顶底转滚动</span>
             <label class="switch">
               <input type="checkbox" ${globals.convertTopBottomToScroll ? 'checked' : ''} onchange="toggleConvertScroll(this)">
               <span class="switch-slider"></span>
             </label>
           </div>
           <div class="cfg-value ${globals.convertTopBottomToScroll ? 'value-enabled' : 'value-disabled'}">
             <code>${globals.convertTopBottomToScroll ? '已启用' : '已禁用'}</code>
           </div>
         </div>

         <div class="cfg-item">
           <div class="cfg-header">
             <span class="cfg-label">白色弹幕比例</span>
             <button class="btn-icon" onclick="editWhiteRatio()">✏️</button>
           </div>
           <div class="cfg-value">
             <code>${globals.whiteRatio >= 0 ? globals.whiteRatio + '%' : '不转换'}</code>
           </div>
         </div>
       </div>
     </div>
   </div>
 </div>

 <!-- Edit Env Modal -->
 <div class="modal-overlay" id="editEnvModal">
   <div class="modal">
     <div class="modal-header">
       <h3 class="modal-title">✏️ 编辑环境变量</h3>
       <button class="modal-close" onclick="closeModal('editEnvModal')">✕</button>
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
       <button class="btn btn-primary" onclick="saveEnvVar()">💾 保存</button>
     </div>
   </div>
 </div>

 <!-- Edit VOD Modal -->
 <div class="modal-overlay" id="editVodModal">
   <div class="modal">
     <div class="modal-header">
       <h3 class="modal-title" id="vodModalTitle">✏️ 编辑VOD服务器</h3>
       <button class="modal-close" onclick="closeModal('editVodModal')">✕</button>
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
       <button class="btn btn-primary" onclick="saveVodServer()">💾 保存</button>
     </div>
   </div>
 </div>

 <!-- Change Password Modal -->
 <div class="modal-overlay" id="changePasswordModal">
   <div class="modal">
     <div class="modal-header">
       <h3 class="modal-title">🔑 修改密码</h3>
       <button class="modal-close" onclick="closeModal('changePasswordModal')">✕</button>
     </div>
     <div class="modal-body">
       <div class="form-group">
         <label class="form-label">新用户名（可选）</label>
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
     </div>
     <div class="modal-footer">
       <button class="btn btn-secondary" onclick="closeModal('changePasswordModal')">取消</button>
       <button class="btn btn-primary" onclick="changePassword()">✅ 确认修改</button>
     </div>
   </div>
 </div>

 <script>
   // ========== Global State ==========
   const AppState = {
     currentEditingEnv: null,
     currentEditingVodIndex: null,
     sourceOrder: ${JSON.stringify(globals.sourceOrderArr)},
     config: ${JSON.stringify(globals.accessedEnvVars)},
     vodServers: ${JSON.stringify(globals.vodServers)},
     hasUnsavedChanges: false
   };

   const ENV_DESCRIPTIONS = ${JSON.stringify(ENV_DESCRIPTIONS)};

   // ========== Init ==========
   document.addEventListener('DOMContentLoaded', function() {
     initApp();
     initDragAndDrop();
     loadLocalStorage();
   });

   async function initApp() {
     const savedTheme = localStorage.getItem('theme');
     if (savedTheme === 'light') {
       document.body.classList.add('light');
     }

     try {
       const response = await fetch('/api/config/load');
       const result = await response.json();
       
       if (result.success && result.config) {
         AppState.config = { ...AppState.config, ...result.config };
         for (const [key, value] of Object.entries(result.config)) {
           updateConfigDisplay(key, value);
         }
         showToast(\`配置已从 \${result.loadedFrom.join('、')} 加载\`, 'success');
       } else {
         showToast('欢迎使用弹幕 API 管理后台', 'success');
       }
     } catch (error) {
       showToast('欢迎使用弹幕 API 管理后台', 'success');
     }
   }

   function loadLocalStorage() {
     const savedConfig = localStorage.getItem('danmu_api_config');
     if (savedConfig) {
       try {
         AppState.config = { ...AppState.config, ...JSON.parse(savedConfig) };
       } catch (e) {}
     }

     const savedVod = localStorage.getItem('danmu_api_vod_servers');
     if (savedVod) {
       try {
         AppState.vodServers = JSON.parse(savedVod);
       } catch (e) {}
     }

     const savedSource = localStorage.getItem('danmu_api_source_order');
     if (savedSource) {
       try {
         AppState.sourceOrder = JSON.parse(savedSource);
       } catch (e) {}
     }
   }

   // ========== Theme ==========
   function toggleTheme() {
     const isLight = document.body.classList.toggle('light');
     localStorage.setItem('theme', isLight ? 'light' : 'dark');
     showToast(\`已切换到\${isLight ? '浅色' : '深色'}主题\`, 'info');
   }

   // ========== Page Navigation ==========
   function switchPage(pageName) {
     document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
     event.currentTarget.classList.add('active');

     document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
     document.getElementById(pageName + '-page').classList.add('active');

     window.scrollTo({ top: 0, behavior: 'smooth' });
   }

   // ========== Sensitive Toggle ==========
   function toggleSensitive(element) {
     const real = element.dataset.real;
     const masked = element.dataset.masked;
     const isRevealed = element.classList.contains('revealed');
     
     if (isRevealed) {
       element.querySelector('code').textContent = masked;
       element.classList.remove('revealed');
       if (element.hideTimer) clearTimeout(element.hideTimer);
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

   // ========== Edit Env ==========
   function editEnv(key) {
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
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     
     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ config: { [key]: value } })
       });

       const result = await response.json();
       
       if (result.success) {
         AppState.hasUnsavedChanges = false;
         updateConfigDisplay(key, value);
         closeModal('editEnvModal');
         showToast(\`\${key} 已保存到: \${result.savedTo.join('、')}\`, 'success');
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       updateConfigDisplay(key, value);
       closeModal('editEnvModal');
       showToast(\`\${key} 已保存到本地\`, 'warning');
     }
   }

   async function saveAllConfig() {
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     localStorage.setItem('danmu_api_vod_servers', JSON.stringify(AppState.vodServers));
     localStorage.setItem('danmu_api_source_order', JSON.stringify(AppState.sourceOrder));
     
     showToast('正在保存配置...', 'info', 1000);

     try {
       const response = await fetch('/api/config/save', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
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
         showToast(\`配置已保存到: \${result.savedTo.join('、')}\`, 'success');
       } else {
         throw new Error(result.errorMessage || '保存失败');
       }
     } catch (error) {
       showToast('配置已保存到本地', 'warning');
     }
   }

   function updateConfigDisplay(key, value) {
     const configItem = document.querySelector(\`.cfg-item[data-key="\${key}"]\`);
     if (!configItem) return;

     const valueElement = configItem.querySelector('.cfg-value code');
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
       configItem.querySelector('.cfg-value').dataset.real = value.replace(/[&<>"']/g, (m) => ({
         '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
       })[m]);
       configItem.querySelector('.cfg-value').dataset.masked = masked;
     } else if (typeof value === 'boolean') {
       valueElement.textContent = value ? '已启用' : '已禁用';
       const configValueEl = configItem.querySelector('.cfg-value');
       configValueEl.classList.remove('value-enabled', 'value-disabled', 'value-empty');
       configValueEl.classList.add(value ? 'value-enabled' : 'value-disabled');
     } else if (!value) {
       valueElement.textContent = '未配置';
       const configValueEl = configItem.querySelector('.cfg-value');
       configValueEl.classList.remove('value-enabled', 'value-disabled');
       configValueEl.classList.add('value-empty');
     } else {
       valueElement.textContent = value;
       const configValueEl = configItem.querySelector('.cfg-value');
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

   // ========== VOD Management ==========
   function addVodServer() {
     AppState.currentEditingVodIndex = null;
     document.getElementById('vodModalTitle').textContent = '➕ 添加VOD服务器';
     document.getElementById('vodServerName').value = '';
     document.getElementById('vodServerUrl').value = '';
     showModal('editVodModal');
   }

   function editVod(index) {
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

     document.getElementById('vodModalTitle').textContent = '✏️ 编辑VOD服务器';
     document.getElementById('vodServerName').value = serverName;
     document.getElementById('vodServerUrl').value = serverUrl;
     showModal('editVodModal');
   }

   function saveVodServer() {
     const name = document.getElementById('vodServerName').value.trim();
     const url = document.getElementById('vodServerUrl').value.trim();

     if (!name || !url) {
       showToast('请填写完整信息', 'error');
       return;
     }

     try {
       new URL(url);
     } catch (e) {
       showToast('URL格式不正确', 'error');
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

   function deleteVod(index) {
     if (!confirm('确定要删除这个VOD服务器吗？')) return;

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
             <button class="btn-icon" onclick="editVod(\${index})">✏️</button>
             <button class="btn-icon btn-del" onclick="deleteVod(\${index})">🗑️</button>
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

     const configValue = checkbox.closest('.cfg-item').querySelector('.cfg-value code');
     configValue.textContent = checkbox.checked ? '返回所有站点结果' : '仅返回最快响应站点';
     showToast(\`VOD返回模式: \${checkbox.checked ? '返回所有' : '最快响应'}\`, 'success');
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

     const configItems = document.querySelectorAll('#vod-page .cfg-item');
     configItems.forEach(item => {
       const label = item.querySelector('.cfg-label');
       if (label && label.textContent === '请求超时') {
         const codeElement = item.querySelector('.cfg-value code');
         if (codeElement) {
           codeElement.textContent = \`\${timeoutValue} 毫秒\`;
         }
       }
     });

     showToast('VOD请求超时已更新', 'success');
   }

   // ========== Source Order ==========
   function initDragAndDrop() {
     const sourceGrid = document.getElementById('sourceGrid');
     if (!sourceGrid) return;

     if (window.innerWidth <= 768) {
       setupMobileSources();
       return;
     }

     let draggedElement = null;

     sourceGrid.addEventListener('dragstart', function(e) {
       if (!e.target.classList.contains('source-item')) return;
       draggedElement = e.target;
       e.target.classList.add('dragging');
     });

     sourceGrid.addEventListener('dragend', function(e) {
       if (!e.target.classList.contains('source-item')) return;
       e.target.classList.remove('dragging');
     });

     sourceGrid.addEventListener('dragover', function(e) {
       e.preventDefault();
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
         const badge = item.querySelector('.source-badge');
         if (badge) badge.textContent = index + 1;
       });
       showToast('数据源顺序已调整', 'info');
     });
   }

   function setupMobileSources() {
     // 移动端简化处理
     const items = document.querySelectorAll('.source-item');
     items.forEach(item => item.removeAttribute('draggable'));
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
     if (!confirm('确定要重置数据源顺序吗？')) return;
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
     const configValue = checkbox.closest('.cfg-item').querySelector('.cfg-value');
     configValue.classList.toggle('value-enabled', checkbox.checked);
     configValue.classList.toggle('value-disabled', !checkbox.checked);
     configValue.querySelector('code').textContent = checkbox.checked ? '已启用' : '已禁用';
     showToast(\`严格匹配已\${checkbox.checked ? '启用' : '禁用'}\`, 'success');
   }

   function toggleRememberSelect(checkbox) {
     AppState.config.REMEMBER_LAST_SELECT = checkbox.checked;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     const configValue = checkbox.closest('.cfg-item').querySelector('.cfg-value');
     configValue.classList.toggle('value-enabled', checkbox.checked);
     configValue.classList.toggle('value-disabled', !checkbox.checked);
     configValue.querySelector('code').textContent = checkbox.checked ? '已启用' : '已禁用';
     showToast(\`记住选择已\${checkbox.checked ? '启用' : '禁用'}\`, 'success');
   }

   // ========== Danmu Config ==========
   function editDanmuFormat() {
     const current = AppState.config.DANMU_OUTPUT_FORMAT || 'json';
     const newFormat = prompt('请输入弹幕输出格式 (json/xml):', current);
     if (!newFormat || !['json', 'xml'].includes(newFormat.toLowerCase())) return;
     
     AppState.config.DANMU_OUTPUT_FORMAT = newFormat.toLowerCase();
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     
     updateDanmuConfigDisplay('输出格式', newFormat.toUpperCase());
     showToast('弹幕输出格式已更新', 'success');
   }

   function toggleDanmuSimplified(checkbox) {
     AppState.config.DANMU_SIMPLIFIED = checkbox.checked;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     const configValue = checkbox.closest('.cfg-item').querySelector('.cfg-value');
     configValue.classList.toggle('value-enabled', checkbox.checked);
     configValue.classList.toggle('value-disabled', !checkbox.checked);
     configValue.querySelector('code').textContent = checkbox.checked ? '已启用' : '已禁用';
     showToast(\`繁转简已\${checkbox.checked ? '启用' : '禁用'}\`, 'success');
   }

   function editDanmuLimit() {
     const current = AppState.config.DANMU_LIMIT || -1;
     const newLimit = prompt('请输入弹幕数量限制 (-1表示不限制):', current);
     if (newLimit === null) return;
     
     const limitValue = parseInt(newLimit);
     if (isNaN(limitValue)) {
       showToast('请输入有效数字', 'error');
       return;
     }

     AppState.config.DANMU_LIMIT = limitValue;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     
     updateDanmuConfigDisplay('数量限制', limitValue > 0 ? limitValue + ' 条' : '不限制');
     showToast('弹幕数量限制已更新', 'success');
   }

   function editBlockedWords() {
     const current = AppState.config.BLOCKED_WORDS || '';
     const newWords = prompt('请输入屏蔽词，多个词用逗号分隔:', current);
     if (newWords === null) return;

     AppState.config.BLOCKED_WORDS = newWords;
     const wordsArr = newWords ? newWords.split(',').map(w => w.trim()).filter(w => w.length > 0) : [];
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     
     updateDanmuConfigDisplay('屏蔽词', wordsArr.length + ' 个屏蔽词');
     showToast('屏蔽词列表已更新', 'success');
   }

   function editGroupMinute() {
     const current = AppState.config.GROUP_MINUTE || 1;
     const newMinute = prompt('请输入合并时间窗口(分钟):', current);
     if (newMinute === null) return;
     
     const minuteValue = parseInt(newMinute);
     if (isNaN(minuteValue) || minuteValue < 1) {
       showToast('请输入有效数字(>=1)', 'error');
       return;
     }

     AppState.config.GROUP_MINUTE = minuteValue;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     
     updateDanmuConfigDisplay('合并时间窗口', minuteValue + ' 分钟');
     showToast('合并时间窗口已更新', 'success');
   }

   function toggleConvertScroll(checkbox) {
     AppState.config.CONVERT_TOP_BOTTOM_TO_SCROLL = checkbox.checked;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     const configValue = checkbox.closest('.cfg-item').querySelector('.cfg-value');
     configValue.classList.toggle('value-enabled', checkbox.checked);
     configValue.classList.toggle('value-disabled', !checkbox.checked);
     configValue.querySelector('code').textContent = checkbox.checked ? '已启用' : '已禁用';
     showToast(\`顶底转滚动已\${checkbox.checked ? '启用' : '禁用'}\`, 'success');
   }

   function editWhiteRatio() {
     const current = AppState.config.WHITE_RATIO || -1;
     const newRatio = prompt('请输入白色弹幕比例 (0-100，-1表示不转换):', current);
     if (newRatio === null) return;
     
     const ratioValue = parseFloat(newRatio);
     if (isNaN(ratioValue) || (ratioValue < -1 || ratioValue > 100)) {
       showToast('请输入有效数字(-1或0-100)', 'error');
       return;
     }

     AppState.config.WHITE_RATIO = ratioValue;
     localStorage.setItem('danmu_api_config', JSON.stringify(AppState.config));
     AppState.hasUnsavedChanges = true;
     
     updateDanmuConfigDisplay('白色弹幕比例', ratioValue >= 0 ? ratioValue + '%' : '不转换');
     showToast('白色弹幕比例已更新', 'success');
   }

   function updateDanmuConfigDisplay(label, value) {
     const configItems = document.querySelectorAll('#danmu-page .cfg-item');
     configItems.forEach(item => {
       const labelEl = item.querySelector('.cfg-label');
       if (labelEl && labelEl.textContent === label) {
         const codeElement = item.querySelector('.cfg-value code');
         if (codeElement) {
           codeElement.textContent = value;
         }
       }
     });
   }

   // ========== Modal ==========
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

   // ========== Toast ==========
   function showToast(message, type = 'info', duration = 3000) {
     const container = document.getElementById('toastContainer');
     if (!container) return;

     const icons = {
       success: '✅',
       error: '❌',
       warning: '⚠️',
       info: 'ℹ️'
     };

     const toast = document.createElement('div');
     toast.className = \`toast toast-\${type}\`;
     toast.innerHTML = \`
       <span>\${icons[type] || icons.info} \${message}</span>
       <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
     \`;

     container.appendChild(toast);
     setTimeout(() => {
       toast.style.animation = 'slideIn 0.3s reverse';
       setTimeout(() => toast.remove(), 300);
     }, duration);
   }

   // ========== Auth ==========
   async function logout() {
     if (!confirm('确定要退出登录吗？')) return;
     
     try {
       await fetch('/api/logout', { method: 'POST' });
       window.location.href = '/';
     } catch (error) {
       showToast('退出失败', 'error');
     }
   }

   function showChangePasswordModal() {
     document.getElementById('newUsername').value = '';
     document.getElementById('oldPassword').value = '';
     document.getElementById('newPassword').value = '';
     document.getElementById('confirmPassword').value = '';
     showModal('changePasswordModal');
   }

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
       showToast('两次密码不一致', 'error');
       return;
     }
     
     if (newPassword.length < 4) {
       showToast('密码长度至少4位', 'error');
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
         closeModal('changePasswordModal');
         setTimeout(() => logout(), 1500);
       } else {
         showToast(result.message || '修改失败', 'error');
       }
     } catch (error) {
       showToast('修改失败', 'error');
     }
   }

   // ========== Copy on Double Click ==========
   document.addEventListener('dblclick', function(e) {
     const configValue = e.target.closest('.cfg-value');
     if (!configValue) return;
     
     const code = configValue.querySelector('code');
     if (!code) return;
     
     let text = code.textContent;
     
     if (configValue.classList.contains('sensitive') && configValue.dataset.real) {
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
     
     showToast('已复制到剪贴板', 'success', 1500);
   });

   // ========== Keyboard Shortcuts ==========
   document.addEventListener('keydown', function(e) {
     if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '5') {
       e.preventDefault();
       const pages = ['overview', 'config', 'vod', 'sources', 'danmu'];
       const index = parseInt(e.key) - 1;
       if (pages[index]) {
         const tabs = document.querySelectorAll('.tab');
         if (tabs[index]) {
           tabs[index].click();
         }
       }
     }
     
     if ((e.ctrlKey || e.metaKey) && e.key === 's') {
       e.preventDefault();
       saveAllConfig();
     }

     if (e.key === 'Escape') {
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

if (path === "/" && method === "GET") {
  return handleHomepage(req);
}

if (path === "/favicon.ico" || path === "/robots.txt") {
  return new Response(null, { status: 204 });
}

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
       log("warn", `[config] 忽略运行时应用错误，继续保存流程`);
     }

     try {
       await applyConfigPatch(sanitizedConfig);
       log("info", `[config] 派生缓存已重建`);
     } catch (e) {
       log("warn", `[config] 重建派生缓存失败（可忽略）: ${e.message}`);
     }

     const savedTo = [];
     if (dbSaved) savedTo.push('数据库');
     if (redisSaved) savedTo.push('Redis');
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
         log("info", `[config] 正则表达式 ${key} 已转换为字符串`);
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
   log("error", `Invalid or missing token in path: ${path}, expected: ${currentToken.substring(0, 3)}***, got: ${parts[0]?.substring(0, 3)}***`);
   return jsonResponse(
     { errorCode: 401, success: false, errorMessage: "Unauthorized" },
     401
   );
 }
 path = "/" + parts.slice(1).join("/");
}

 log("info", path);

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

 if (path === "/" && method === "GET") {
   return handleHomepage(req);
 }

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
     if (cachedComments) {
       log('info', `[comment] 从缓存返回弹幕数据: ${videoUrl}`);
       return formatDanmuResponse(cachedComments, queryFormat);
     }
     
     log('info', `[comment] 通过URL获取弹幕: ${videoUrl}`);
     return getCommentByUrl(url, videoUrl);
   }

   const episodeIdMatch = path.match(/^\/api\/v2\/comment\/(\d+)$/);
   if (episodeIdMatch) {
     const episodeId = episodeIdMatch[1];
     
     const cachedUrl = findUrlById(episodeId);
     if (cachedUrl) {
       const cachedComments = getCommentCache(cachedUrl);
       if (cachedComments) {
         log('info', `[comment] 从缓存返回弹幕数据 (episodeId: ${episodeId})`);
         return formatDanmuResponse(cachedComments, queryFormat);
       }
     }
     
     log('info', `[comment] 通过episodeId获取弹幕: ${episodeId}`);
     return getComment(path, url);
   }

   return getComment(path, url);
 }

 if (path === "/api/v2/vod/search" && method === "GET") {
   const keyword = url.searchParams.get('keyword') || url.searchParams.get('wd');
   
   if (!keyword) {
     return jsonResponse({
       success: false,
       errorMessage: "缺少搜索关键词参数 keyword 或 wd"
     }, 400);
   }

   try {
     const { searchVodServers } = await import('./apis/vod-api.js');
     const results = await searchVodServers(keyword);
     
     return jsonResponse({
       success: true,
       data: results,
       keyword: keyword,
       totalServers: results.length
     });
   } catch (error) {
     log("error", `[VOD] 搜索失败: ${error.message}`);
     return jsonResponse({
       success: false,
       errorMessage: `搜索失败: ${error.message}`
     }, 500);
   }
 }

 if (path === "/api/logs" && method === "GET") {
   const cookies = req.headers.get('cookie') || '';
   const sessionMatch = cookies.match(/session=([^;]+)/);
   const sessionId = sessionMatch ? sessionMatch[1] : null;
   
   if (!validateSession(sessionId)) {
     return jsonResponse({ success: false, message: '未登录' }, 401);
   }
   
   try {
     const logs = globals.logBuffer || [];
     const limit = parseInt(url.searchParams.get('limit')) || 100;
     const level = url.searchParams.get('level');
     
     let filteredLogs = logs;
     if (level) {
       filteredLogs = logs.filter(log => log.level === level);
     }
     
     return jsonResponse({
       success: true,
       logs: filteredLogs.slice(-limit),
       total: filteredLogs.length
     });
   } catch (error) {
     return jsonResponse({
       success: false,
       errorMessage: '获取日志失败'
     }, 500);
   }
 }

 if (path === "/health" || path === "/ping") {
   return jsonResponse({
     status: "ok",
     version: globals.VERSION,
     timestamp: new Date().toISOString(),
     redis: globals.redisValid ? "connected" : "disconnected",
     database: globals.databaseValid ? "connected" : "disconnected"
   });
 }

 log("warn", `[404] 未找到路径: ${path}`);
 return jsonResponse({
   success: false,
   errorCode: 404,
   errorMessage: "API 路径不存在"
 }, 404);
}

async function saveAdminCredentials(username, password) {
  try {
    if (globals.databaseValid) {
      const { saveEnvConfigs } = await import('./utils/db-util.js');
      await saveEnvConfigs({
        ADMIN_USERNAME: username,
        ADMIN_PASSWORD: password
      });
      log("info", "[auth] 管理员凭据已保存到数据库");
      return true;
    }
    
    if (globals.redisValid) {
      const { setRedisKey } = await import('./utils/redis-util.js');
      await setRedisKey('admin_username', username, true);
      await setRedisKey('admin_password', password, true);
      log("info", "[auth] 管理员凭据已保存到Redis");
      return true;
    }
    
    log("warn", "[auth] 无持久化存储，凭据仅保存在内存中");
    globals.adminUsername = username;
    globals.adminPassword = password;
    return true;
  } catch (error) {
    log("error", `[auth] 保存管理员凭据失败: ${error.message}`);
    return false;
  }
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
      color: #e5e7eb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .login-container {
      background: rgba(28, 28, 39, 0.7);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .logo {
      text-align: center;
      margin-bottom: 32px;
    }

    .logo-icon {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 16px;
    }

    .logo h1 {
      font-size: 24px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo p {
      font-size: 14px;
      color: #9ca3af;
      margin-top: 4px;
    }

    .form-group {
      margin-bottom: 20px;
    }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #e5e7eb;
    }

    .form-input {
      width: 100%;
      padding: 12px 16px;
      background: rgba(19, 19, 26, 0.8);
      border: 1px solid #2d2d3f;
      border-radius: 8px;
      color: #e5e7eb;
      font-size: 14px;
      transition: all 0.3s;
    }

    .form-input:focus {
      outline: none;
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }

    .btn-login {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.3s;
    }

    .btn-login:hover {
      transform: translateY(-2px);
    }

    .btn-login:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .error-message {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid #ef4444;
      color: #ef4444;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
      display: none;
    }

    .error-message.show {
      display: block;
    }

    .default-hint {
      text-align: center;
      font-size: 12px;
      color: #6b7280;
      margin-top: 16px;
      padding: 12px;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 8px;
    }

    @media (max-width: 480px) {
      .login-container {
        padding: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="logo">
      <div class="logo-icon">🎬</div>
      <h1>弹幕 API 管理后台</h1>
      <p>v${globals.VERSION}</p>
    </div>

    <div class="error-message" id="errorMessage"></div>

    <form id="loginForm">
      <div class="form-group">
        <label class="form-label">用户名</label>
        <input type="text" class="form-input" id="username" placeholder="请输入用户名" required autocomplete="username">
      </div>

      <div class="form-group">
        <label class="form-label">密码</label>
        <input type="password" class="form-input" id="password" placeholder="请输入密码" required autocomplete="current-password">
      </div>

      <button type="submit" class="btn-login" id="loginBtn">登录</button>
    </form>

    <div class="default-hint">
      💡 默认账号: admin / admin
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
      
      errorMessage.classList.remove('show');
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
          window.location.href = '/';
        } else {
          showError(result.message || '登录失败');
        }
      } catch (error) {
        showError('网络错误，请重试');
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = '登录';
      }
    });

    function showError(message) {
      errorMessage.textContent = message;
      errorMessage.classList.add('show');
    }

    document.getElementById('username').focus();
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

setInterval(async () => {
  try {
    await cleanupExpiredIPs();
    log('info', '[cleanup] IP限流清理完成');
  } catch (e) {
    log('warn', `[cleanup] IP限流清理失败: ${e.message}`);
  }
}, 5 * 60 * 1000);

export default {
  async fetch(request, env, ctx) {
    const deployPlatform = detectPlatform(env);
    const clientIp = getClientIp(request);
    
    try {
      return await handleRequest(request, env, deployPlatform, clientIp);
    } catch (error) {
      log('error', `[main] 请求处理失败: ${error.message}\n${error.stack}`);
      return jsonResponse({
        success: false,
        errorMessage: '服务器内部错误',
        errorCode: 500
      }, 500);
    }
  }
};

function detectPlatform(env) {
  if (typeof Deno !== 'undefined') return 'deno';
  if (typeof Netlify !== 'undefined') return 'netlify';
  if (env?.ASSETS) return 'cloudflare';
  if (typeof process !== 'undefined' && process.env?.VERCEL) return 'vercel';
  if (typeof EdgeRuntime !== 'undefined') return 'edge';
  return 'unknown';
}

function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
         request.headers.get('x-real-ip') ||
         request.headers.get('x-forwarded-for')?.split(',')[0] ||
         'unknown';
}

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


           
