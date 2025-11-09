import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";

let globals;

// 环境变量说明配置
const ENV_DESCRIPTIONS = {
  'TOKEN': '自定义API访问令牌,默认87654321',
  'OTHER_SERVER': '兜底第三方弹幕服务器,默认api.danmu.icu',
  'VOD_SERVERS': 'VOD采集站列表,格式:名称@URL,名称@URL...',
  'VOD_RETURN_MODE': 'VOD返回模式: all(返回所有站点) / fastest(仅返回最快站点)',
  'VOD_REQUEST_TIMEOUT': 'VOD单个请求超时时间(毫秒),默认10000',
  'BILIBILI_COOKIE': 'B站Cookie,获取完整弹幕(最少需SESSDATA字段)',
  'YOUKU_CONCURRENCY': '优酷弹幕请求并发数,默认8,最高16',
  'SOURCE_ORDER': '数据源优先级排序,影响自动匹配结果',
  'PLATFORM_ORDER': '弹幕平台优先级,优先返回指定平台弹幕',
  'EPISODE_TITLE_FILTER': '剧集标题正则过滤,过滤预告/花絮等非正片',
  'ENABLE_EPISODE_FILTER': '手动选择接口是否启用集标题过滤,默认false',
  'STRICT_TITLE_MATCH': '严格标题匹配模式,仅匹配开头或完全匹配,默认false',
  'BLOCKED_WORDS': '弹幕屏蔽词列表,过滤指定关键词',
  'GROUP_MINUTE': '弹幕合并去重时间窗口(分钟),默认1分钟',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '顶部/底部弹幕转为滚动弹幕,默认false',
  'WHITE_RATIO': '白色弹幕占比(0-100),-1表示不转换',
  'DANMU_LIMIT': '弹幕数量限制,-1表示不限制',
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式: json / xml,默认json',
  'DANMU_SIMPLIFIED': '繁体弹幕转简体(巴哈姆特),默认true',
  'PROXY_URL': '代理/反代地址(巴哈姆特和TMDB),支持混合配置',
  'TMDB_API_KEY': 'TMDB API Key,提升巴哈搜索准确度(通过日语原名搜索)',
  'RATE_LIMIT_MAX_REQUESTS': '限流配置:1分钟内同IP最大请求次数,默认3',
  'LOG_LEVEL': '日志级别: error / warn / info,默认info',
  'SEARCH_CACHE_MINUTES': '搜索结果缓存时间(分钟),默认1',
  'COMMENT_CACHE_MINUTES': '弹幕数据缓存时间(分钟),默认1',
  'REMEMBER_LAST_SELECT': '记住手动选择结果优化自动匹配,默认true',
  'MAX_LAST_SELECT_MAP': '最后选择映射缓存大小,默认100条',
  'UPSTASH_REDIS_REST_URL': 'Upstash Redis URL,持久化存储防止冷启动数据丢失',
  'UPSTASH_REDIS_REST_TOKEN': 'Upstash Redis Token,配合URL使用',
  'VERSION': '当前服务版本号',
  'redisValid': 'Redis连接状态(已连接/未连接)',
  'redisUrl': 'Redis服务器地址',
  'redisToken': 'Redis访问令牌'
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
 * 获取环境变量的真实值(未加密)
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

  if (globals.envs && actualKey in globals.envs) {
    return globals.envs[actualKey];
  }

  if (typeof process !== 'undefined' && process.env?.[actualKey]) {
    return process.env[actualKey];
  }

  if (actualKey in Globals) {
    return Globals[actualKey];
  }

  return globals.accessedEnvVars[key];
}

async function handleRequest(req, env, deployPlatform, clientIp) {
  globals = Globals.init(env, deployPlatform);

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
      ? (globals.redisValid ? '已连接' : '已配置未连接') 
      : '未配置';
    const redisStatusClass = redisConfigured 
      ? (globals.redisValid ? 'status-online' : 'status-warning')
      : 'status-offline';

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

    // 生成环境变量HTML
    const envItemsHtml = Object.entries(globals.accessedEnvVars)
      .map(([key, value]) => {
        let valueClass = '';
        let displayValue = value;
        const description = ENV_DESCRIPTIONS[key] || '环境变量';
        const isSensitive = isSensitiveKey(key);
        
        if (typeof value === 'boolean') {
          valueClass = value ? 'boolean-true' : 'boolean-false';
          displayValue = value ? '✓ 已启用' : '✗ 已禁用';
        } else if (value === null || value === undefined || (typeof value === 'string' && value.length === 0)) {
          valueClass = 'not-configured';
          displayValue = '未配置';
        } else if (isSensitive && typeof value === 'string' && value.length > 0) {
          const realValue = getRealEnvValue(key);
          const maskedValue = '•'.repeat(Math.min(String(realValue).length, 32));
          
          const encodedRealValue = String(realValue)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
          
          return `
            <div class="env-item">
              <div class="env-header">
                <div class="env-key">${key}</div>
                <div class="tooltip">
                  <span class="info-icon">ⓘ</span>
                  <span class="tooltip-text">${description}</span>
                </div>
              </div>
              <div class="env-value sensitive" 
                   data-real="${encodedRealValue}" 
                   data-masked="${maskedValue}"
                   onclick="toggleSensitiveValue(this)"
                   title="点击查看真实值(3秒后自动隐藏)">${maskedValue}</div>
            </div>
          `;
        } else if (Array.isArray(value)) {
          if (value.length > 0) {
            displayValue = value.join(', ');
          } else {
            valueClass = 'not-configured';
            displayValue = '默认';
          }
        } else if (typeof value === 'string' && value.length > 100) {
          displayValue = value.substring(0, 100) + '...';
        }
        
        return `
          <div class="env-item">
            <div class="env-header">
              <div class="env-key">${key}</div>
              <div class="tooltip">
                <span class="info-icon">ⓘ</span>
                <span class="tooltip-text">${description}</span>
              </div>
            </div>
            <div class="env-value ${valueClass}">${displayValue}</div>
          </div>
        `;
      })
      .join('');

    // 生成VOD服务器HTML - 从环境变量动态获取
    let vodServersHtml = '';
    
    // 解析默认 VOD 服务器（与 envs.js 保持一致）
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
          
          // 处理不同的数据类型
          if (typeof server === 'string') {
            // 字符串格式: "名称@URL"
            serverUrl = server;
            if (server.includes('@')) {
              const parts = server.split('@');
              serverName = parts[0];
              serverUrl = parts.slice(1).join('@');
            }
          } else if (typeof server === 'object' && server !== null) {
            // 对象格式: { name: '名称', url: 'URL' } 或 { name: '名称', baseUrl: 'URL' }
            serverName = server.name || server.title || serverName;
            serverUrl = server.url || server.baseUrl || server.address || JSON.stringify(server);
          } else {
            serverUrl = String(server);
          }
          
          return `
            <div class="list-item">
              <div class="list-icon">🎬</div>
              <div class="list-content">
                <div class="list-title">${serverName}</div>
                <div class="list-value">${serverUrl}</div>
              </div>
              <div class="list-badge">#${index + 1}</div>
            </div>
          `;
        }).join('');
      } else {
        vodServersHtml = defaultVodServers.map((server, index) => `
          <div class="list-item">
            <div class="list-icon">🎬</div>
            <div class="list-content">
              <div class="list-title">${server.name} (默认)</div>
              <div class="list-value">${server.url}</div>
            </div>
            <div class="list-badge">默认</div>
          </div>
        `).join('');
      }
    } catch (error) {
      log("error", `Generate VOD HTML error: ${error.message}`);
      vodServersHtml = `
        <div class="list-item">
          <div class="list-icon">⚠️</div>
          <div class="list-content">
            <div class="list-title">加载错误</div>
            <div class="list-value">无法加载 VOD 服务器列表: ${error.message}</div>
          </div>
        </div>
      `;
    }


    // 生成数据源HTML
    const sourceIcons = {
      'dandan': '🎯',
      'bilibili': '📺',
      'iqiyi': '🎬',
      'youku': '▶️',
      'tencent': '🎞️',
      'mgtv': '📹',
      'bahamut': '🎴'
    };

    const sourcesHtml = globals.sourceOrderArr.length > 0 
      ? globals.sourceOrderArr.map((source, index) => {
        const icon = sourceIcons[source.toLowerCase()] || '🔗';
        
        return `
          <div class="list-item">
            <div class="list-icon">${icon}</div>
            <div class="list-content">
              <div class="list-title">${source}</div>
              <div class="list-value">优先级: ${index + 1}</div>
            </div>
            <div class="list-badge">#${index + 1}</div>
          </div>
        `;
      }).join('')
      : `
        <div class="list-item">
          <div class="list-icon">⚠️</div>
          <div class="list-content">
            <div class="list-title">未配置数据源</div>
            <div class="list-value">使用默认数据源顺序</div>
          </div>
        </div>
      `;

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>弹幕 API 服务 - Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --primary: #667eea;
      --secondary: #764ba2;
      --accent: #ff6ec3;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      
      --bg-dark: #0f0f23;
      --bg-card-dark: rgba(30, 30, 50, 0.8);
      --text-dark: #e5e7eb;
      --text-secondary-dark: #9ca3af;
      --border-dark: rgba(255, 255, 255, 0.12);
      
      --bg-light: #f8fafc;
      --bg-card-light: #ffffff;
      --text-light: #1e293b;
      --text-secondary-light: #64748b;
      --border-light: #e2e8f0;
    }
    
    html {
      overflow-x: hidden;
      scroll-behavior: smooth;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: var(--bg-dark);
      color: var(--text-dark);
      min-height: 100vh;
      transition: background 0.3s ease, color 0.3s ease;
      overflow-x: hidden;
    }
    
    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: 
        radial-gradient(circle at 20% 50%, rgba(102, 126, 234, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(255, 110, 199, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 40% 20%, rgba(59, 130, 246, 0.1) 0%, transparent 50%);
      animation: drift 25s ease-in-out infinite;
      z-index: 0;
      transition: opacity 0.3s ease;
    }
    
    @keyframes drift {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      33% { transform: translate(-5%, 5%) rotate(5deg); }
      66% { transform: translate(5%, -3%) rotate(-5deg); }
    }
    
    .theme-toggle {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 1001;
      width: 56px;
      height: 56px;
      background: var(--bg-card-dark);
      backdrop-filter: blur(20px);
      border: 2px solid var(--border-dark);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5em;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    
    .theme-toggle:hover {
      transform: scale(1.1) rotate(15deg);
      border-color: var(--primary);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    
    .theme-toggle.hide,
    .back-button.hide {
      opacity: 0;
      pointer-events: none;
      transform: translateY(-80px);
    }
    
    .back-button {
      position: fixed;
      top: 20px;
      left: 20px;
      z-index: 1001;
      width: 56px;
      height: 56px;
      background: var(--bg-card-dark);
      backdrop-filter: blur(20px);
      border: 2px solid var(--border-dark);
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.4em;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      opacity: 0;
      pointer-events: none;
    }
    
    .back-button.show {
      opacity: 1;
      pointer-events: all;
    }
    
    .back-button:hover {
      transform: scale(1.1) translateX(-5px);
      border-color: var(--primary);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 100px 20px 40px;
      position: relative;
      z-index: 1;
    }
    
    .page {
      animation: fadeInUp 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .page.page-out {
      animation: fadeOut 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }
    
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    @keyframes fadeOut {
      to {
        opacity: 0;
        transform: translateY(-20px);
      }
    }
    
    .hero {
      text-align: center;
      padding: 40px 20px 60px;
      margin-bottom: 40px;
    }
    
    .hero-icon {
      font-size: 4.5em;
      margin-bottom: 20px;
      display: inline-block;
      animation: float 3s ease-in-out infinite;
      filter: drop-shadow(0 4px 8px rgba(102, 126, 234, 0.3));
    }
    
    @keyframes float {
      0%, 100% { transform: translateY(0px) rotate(0deg); }
      50% { transform: translateY(-15px) rotate(5deg); }
    }
    
    .hero h1 {
      font-size: clamp(2em, 5vw, 3em);
      font-weight: 800;
      margin-bottom: 15px;
      background: linear-gradient(135deg, #667eea 0%, #ff6ec3 50%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      letter-spacing: -0.5px;
    }
    
    .hero-subtitle {
      font-size: clamp(0.95em, 2.5vw, 1.15em);
      color: var(--text-secondary-dark);
      max-width: 600px;
      margin: 0 auto 25px;
      line-height: 1.7;
    }
    
    .version-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 24px;
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.2), rgba(118, 75, 162, 0.2));
      border: 2px solid rgba(102, 126, 234, 0.4);
      border-radius: 25px;
      font-size: 0.9em;
      font-weight: 600;
      color: #a5b4fc;
      transition: all 0.3s ease;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
      margin-bottom: 50px;
    }
    
    .stat-card {
      background: var(--bg-card-dark);
      backdrop-filter: blur(20px);
      border: 2px solid var(--border-dark);
      border-radius: 20px;
      padding: 35px 25px;
      text-align: center;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
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
      background: linear-gradient(90deg, var(--primary), var(--accent));
      transform: scaleX(0);
      transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .stat-card:hover {
      transform: translateY(-8px);
      border-color: rgba(102, 126, 234, 0.6);
      box-shadow: 0 12px 30px rgba(102, 126, 234, 0.3);
    }
    
    .stat-card:hover::before {
      transform: scaleX(1);
    }
    
    .stat-icon {
      font-size: 3em;
      margin-bottom: 15px;
      opacity: 0.9;
    }
    
    .stat-value {
      font-size: 2.2em;
      font-weight: 800;
      color: var(--text-dark);
      margin-bottom: 10px;
    }
    
    .stat-label {
      font-size: 0.9em;
      color: var(--text-secondary-dark);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-weight: 600;
    }
    
    .redis-card {
      background: var(--bg-card-dark);
      backdrop-filter: blur(20px);
      border: 2px solid var(--border-dark);
      border-radius: 20px;
      padding: 35px;
      margin-bottom: 40px;
      transition: all 0.3s ease;
    }
    
    .redis-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 15px;
      flex-wrap: wrap;
      gap: 15px;
    }
    
    .redis-title {
      font-size: 1.4em;
      font-weight: 700;
      color: var(--text-dark);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 20px;
      border-radius: 25px;
      font-size: 0.9em;
      font-weight: 700;
      transition: all 0.3s ease;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .status-online {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 2px solid rgba(16, 185, 129, 0.4);
    }
    
    .status-warning {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 2px solid rgba(245, 158, 11, 0.4);
    }
    
    .status-offline {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 2px solid rgba(239, 68, 68, 0.4);
    }
    
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s ease-in-out infinite;
      box-shadow: 0 0 8px currentColor;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.9); }
    }
    
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 25px;
      margin-bottom: 50px;
    }
    
    .feature-card {
      background: var(--bg-card-dark);
      backdrop-filter: blur(20px);
      border: 2px solid var(--border-dark);
      border-radius: 20px;
      padding: 35px 30px;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }
    
    .feature-card::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(255, 110, 199, 0.1));
      opacity: 0;
      transition: opacity 0.4s ease;
      pointer-events: none;
    }
    
    .feature-card:hover {
      transform: translateY(-8px) scale(1.02);
      border-color: var(--primary);
      box-shadow: 0 16px 40px rgba(102, 126, 234, 0.35);
    }
    
    .feature-card:hover::after {
      opacity: 1;
    }
    
    .feature-icon {
      font-size: 3.5em;
      margin-bottom: 20px;
      display: block;
      position: relative;
      z-index: 1;
    }
    
    .feature-title {
      font-size: 1.3em;
      font-weight: 700;
      color: var(--text-dark);
      margin-bottom: 12px;
      position: relative;
      z-index: 1;
    }
    
    .feature-desc {
      font-size: 0.95em;
      color: var(--text-secondary-dark);
      line-height: 1.6;
      position: relative;
      z-index: 1;
    }
    
    .feature-badge {
      position: absolute;
      top: 15px;
      right: 15px;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: white;
      padding: 6px 14px;
      border-radius: 15px;
      font-size: 0.75em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      z-index: 1;
    }
    
    .detail-page {
      display: none;
    }
    
    .detail-page.active {
      display: block;
    }
    
    .detail-header {
      text-align: center;
      margin-bottom: 50px;
    }
    
    .detail-icon {
      font-size: 4em;
      margin-bottom: 20px;
      display: inline-block;
    }
    
    .detail-title {
      font-size: 2.5em;
      font-weight: 800;
      margin-bottom: 15px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .detail-subtitle {
      font-size: 1.1em;
      color: var(--text-secondary-dark);
      max-width: 600px;
      margin: 0 auto;
    }
    
    .env-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 20px;
    }
    
    .env-item {
      background: var(--bg-card-dark);
      border: 2px solid var(--border-dark);
      border-radius: 16px;
      padding: 24px;
      transition: all 0.3s ease;
    }
    
    .env-item:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(102, 126, 234, 0.5);
      transform: translateY(-3px);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.25);
    }
    
    .env-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    
    .env-key {
      font-size: 0.95em;
      color: #a5b4fc;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      flex: 1;
    }
    
    .info-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
     background: rgba(102, 126, 234, 0.25);
     color: #a5b4fc;
     font-size: 14px;
     font-weight: bold;
     cursor: help;
     transition: all 0.3s ease;
     border: 2px solid rgba(102, 126, 234, 0.5);
     flex-shrink: 0;
     font-style: normal;
   }
   
   .info-icon:hover {
     background: rgba(102, 126, 234, 0.4);
     transform: scale(1.15);
     border-color: rgba(102, 126, 234, 0.7);
   }
   
   .env-value {
     color: var(--text-dark);
     font-family: 'Courier New', monospace;
     font-size: 0.9em;
     word-break: break-all;
     padding: 14px 18px;
     background: rgba(0, 0, 0, 0.25);
     border-radius: 10px;
     border: 1px solid rgba(255, 255, 255, 0.08);
     position: relative;
     transition: all 0.3s ease;
     line-height: 1.6;
   }
   
   .env-value.boolean-true {
     color: #34d399;
     font-weight: 600;
   }
   
   .env-value.boolean-false {
     color: #f87171;
     font-weight: 600;
   }
   
   .env-value.not-configured {
     color: var(--text-secondary-dark);
     font-style: italic;
   }
   
   .env-value.sensitive {
     cursor: pointer;
     user-select: none;
     padding-right: 45px;
   }
   
   .env-value.sensitive:hover {
     background: rgba(0, 0, 0, 0.4);
     border-color: rgba(102, 126, 234, 0.4);
   }
   
   .env-value.sensitive.revealed {
     color: #fbbf24;
     background: rgba(245, 158, 11, 0.2);
     border-color: rgba(245, 158, 11, 0.4);
   }
   
   .env-value.sensitive::after {
     content: '👁️‍🗨️';
     position: absolute;
     right: 14px;
     top: 50%;
     transform: translateY(-50%);
     font-size: 1.2em;
     opacity: 0;
     transition: opacity 0.3s ease;
   }
   
   .env-value.sensitive:hover::after {
     opacity: 0.7;
   }
   
   .env-value.sensitive.revealed::after {
     content: '👁️';
     opacity: 1;
   }
   
   .tooltip {
     position: relative;
   }
   
   .tooltip .tooltip-text {
     visibility: hidden;
     width: 260px;
     background: rgba(17, 24, 39, 0.98);
     color: #e5e7eb;
     text-align: left;
     border-radius: 12px;
     padding: 14px 18px;
     position: absolute;
     z-index: 1000;
     bottom: 150%;
     right: 0;
     opacity: 0;
     transition: opacity 0.3s, visibility 0.3s;
     font-size: 0.85em;
     line-height: 1.6;
     border: 2px solid rgba(102, 126, 234, 0.5);
     box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
     pointer-events: none;
     backdrop-filter: blur(10px);
     white-space: normal;
   }
   
   .tooltip .tooltip-text::after {
     content: "";
     position: absolute;
     top: 100%;
     right: 10px;
     border-width: 8px;
     border-style: solid;
     border-color: rgba(17, 24, 39, 0.98) transparent transparent transparent;
   }
   
   .tooltip:hover .tooltip-text {
     visibility: visible;
     opacity: 1;
   }
   
   .list-grid {
     display: grid;
     gap: 15px;
   }
   
   .list-item {
     background: var(--bg-card-dark);
     border: 2px solid var(--border-dark);
     border-radius: 14px;
     padding: 20px 24px;
     transition: all 0.3s ease;
     display: flex;
     align-items: center;
     gap: 15px;
   }
   
   .list-item:hover {
     background: rgba(255, 255, 255, 0.05);
     border-color: rgba(102, 126, 234, 0.5);
     transform: translateX(5px);
     box-shadow: 0 4px 15px rgba(102, 126, 234, 0.25);
   }
   
   .list-icon {
     font-size: 2em;
     flex-shrink: 0;
   }
   
   .list-content {
     flex: 1;
     min-width: 0;
   }
   
   .list-title {
     font-size: 1.05em;
     font-weight: 600;
     color: var(--text-dark);
     margin-bottom: 5px;
   }
   
   .list-value {
     font-size: 0.9em;
     color: var(--text-secondary-dark);
     font-family: 'Courier New', monospace;
     word-break: break-all;
   }
   
   .list-badge {
     background: linear-gradient(135deg, rgba(102, 126, 234, 0.25), rgba(118, 75, 162, 0.25));
     color: #a5b4fc;
     padding: 6px 14px;
     border-radius: 20px;
     font-size: 0.8em;
     font-weight: 700;
     text-transform: uppercase;
     letter-spacing: 0.5px;
     white-space: nowrap;
     border: 2px solid rgba(102, 126, 234, 0.4);
   }
   
   .footer {
     text-align: center;
     padding: 50px 20px 30px;
     color: var(--text-secondary-dark);
     font-size: 0.95em;
   }
   
   .footer-heart {
     color: var(--accent);
     animation: heartbeat 1.5s ease-in-out infinite;
     display: inline-block;
   }
   
   @keyframes heartbeat {
     0%, 100% { transform: scale(1); }
     10%, 30% { transform: scale(1.2); }
     20%, 40% { transform: scale(1); }
   }
   
   .footer-links {
     margin-top: 15px;
     display: flex;
     justify-content: center;
     gap: 20px;
     flex-wrap: wrap;
   }
   
   .footer-link {
     color: var(--text-secondary-dark);
     text-decoration: none;
     transition: color 0.3s ease;
     font-weight: 500;
   }
   
   .footer-link:hover {
     color: var(--primary);
   }
   
   /* 浅色模式样式优化 */
   body.light-mode {
     background: var(--bg-light);
     color: var(--text-light);
   }
   
   body.light-mode::before {
     background: 
       radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.08) 0%, transparent 50%),
       radial-gradient(circle at 80% 80%, rgba(236, 72, 153, 0.08) 0%, transparent 50%),
       radial-gradient(circle at 40% 20%, rgba(59, 130, 246, 0.05) 0%, transparent 50%);
   }
   
   body.light-mode .theme-toggle,
   body.light-mode .back-button {
     background: var(--bg-card-light);
     border-color: var(--border-light);
     box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
   }
   
   body.light-mode .theme-toggle:hover,
   body.light-mode .back-button:hover {
     box-shadow: 0 8px 25px rgba(99, 102, 241, 0.3);
   }
   
   body.light-mode .hero h1,
   body.light-mode .detail-title {
     background: linear-gradient(135deg, #6366f1 0%, #ec4899 50%, #8b5cf6 100%);
     -webkit-background-clip: text;
     -webkit-text-fill-color: transparent;
     background-clip: text;
   }
   
   body.light-mode .hero-subtitle,
   body.light-mode .detail-subtitle {
     color: var(--text-secondary-light);
   }
   
   body.light-mode .version-badge {
     background: rgba(99, 102, 241, 0.12);
     border-color: rgba(99, 102, 241, 0.3);
     color: #6366f1;
   }
   
   body.light-mode .stat-card,
   body.light-mode .redis-card,
   body.light-mode .feature-card,
   body.light-mode .env-item,
   body.light-mode .list-item {
     background: var(--bg-card-light);
     border-color: var(--border-light);
     box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
   }
   
   body.light-mode .stat-card:hover,
   body.light-mode .feature-card:hover,
   body.light-mode .env-item:hover,
   body.light-mode .list-item:hover {
     box-shadow: 0 8px 25px rgba(99, 102, 241, 0.15);
   }
   
   body.light-mode .stat-value,
   body.light-mode .redis-title,
   body.light-mode .feature-title,
   body.light-mode .list-title {
     color: var(--text-light);
   }
   
   body.light-mode .stat-label,
   body.light-mode .feature-desc,
   body.light-mode .list-value,
   body.light-mode .footer {
     color: var(--text-secondary-light);
   }
   
   body.light-mode .env-key {
     color: #6366f1;
   }
   
   body.light-mode .env-value {
     background: #f1f5f9;
     border-color: #e2e8f0;
     color: var(--text-light);
   }
   
   body.light-mode .env-value.boolean-true {
     color: #059669;
   }
   
   body.light-mode .env-value.boolean-false {
     color: #dc2626;
   }
   
   body.light-mode .env-value.not-configured {
     color: var(--text-secondary-light);
   }
   
   body.light-mode .env-value.sensitive:hover {
     background: #e2e8f0;
     border-color: rgba(99, 102, 241, 0.4);
   }
   
   body.light-mode .env-value.sensitive.revealed {
     color: #d97706;
     background: rgba(245, 158, 11, 0.15);
     border-color: rgba(245, 158, 11, 0.4);
   }
   
   body.light-mode .info-icon {
     background: rgba(99, 102, 241, 0.15);
     color: #6366f1;
     border-color: rgba(99, 102, 241, 0.4);
   }
   
   body.light-mode .info-icon:hover {
     background: rgba(99, 102, 241, 0.25);
   }
   
   body.light-mode .tooltip .tooltip-text {
     background: rgba(30, 41, 59, 0.98);
     border-color: rgba(99, 102, 241, 0.4);
   }
   
   body.light-mode .status-online {
     background: rgba(16, 185, 129, 0.15);
     color: #059669;
     border-color: rgba(16, 185, 129, 0.4);
   }
   
   body.light-mode .status-warning {
     background: rgba(245, 158, 11, 0.15);
     color: #d97706;
     border-color: rgba(245, 158, 11, 0.4);
   }
   
   body.light-mode .status-offline {
     background: rgba(239, 68, 68, 0.15);
     color: #dc2626;
     border-color: rgba(239, 68, 68, 0.4);
   }
   
   body.light-mode .list-badge {
     background: rgba(99, 102, 241, 0.15);
     color: #6366f1;
     border-color: rgba(99, 102, 241, 0.3);
   }
   
   @media (max-width: 768px) {
     .container {
       padding: 80px 15px 30px;
     }
     
     .theme-toggle,
     .back-button {
       width: 48px;
       height: 48px;
       font-size: 1.3em;
       top: 15px;
     }
     
     .stats-grid {
       grid-template-columns: repeat(2, 1fr);
       gap: 15px;
     }
     
     .features-grid {
       grid-template-columns: 1fr;
     }
     
     .env-grid {
       grid-template-columns: 1fr;
     }
     
     .tooltip .tooltip-text {
       width: 220px;
       right: -50px;
     }
   }
   
   @media (max-width: 480px) {
     .stats-grid {
       grid-template-columns: 1fr;
     }
     
     .redis-header {
       flex-direction: column;
       align-items: flex-start;
     }
     
     .tooltip .tooltip-text {
       width: 200px;
       right: -20px;
     }
   }
 </style>
</head>
<body>
 <div id="theme-toggle-btn" class="theme-toggle" title="切换主题" role="button" tabindex="0">
   <span id="theme-icon">🌙</span>
 </div>
 
 <div id="back-btn" class="back-button" title="返回首页" role="button" tabindex="0">
   <span>←</span>
 </div>
 
 <div class="container">
   <div id="home-page" class="page">
     <div class="hero">
       <div class="hero-icon">🎬</div>
       <h1>弹幕 API 服务</h1>
       <p class="hero-subtitle">
         高性能弹幕数据接口服务,支持多平台弹幕获取、智能匹配与缓存管理
       </p>
       <span class="version-badge">
         <span>🚀</span>
         <span>v${globals.VERSION}</span>
       </span>
     </div>
     
     <div class="stats-grid">
       <div class="stat-card">
         <div class="stat-icon">⚙️</div>
         <div class="stat-value">${Object.keys(globals.accessedEnvVars).length}</div>
         <div class="stat-label">环境变量</div>
       </div>
        <div class="stat-card">
          <div class="stat-icon">🎬</div>
          <div class="stat-value">${globals.vodServers.length}</div>
          <div class="stat-label">采集站</div>
        </div>
       <div class="stat-card">
         <div class="stat-icon">🔗</div>
         <div class="stat-value">${globals.sourceOrderArr.length}</div>
         <div class="stat-label">数据源</div>
       </div>
       <div class="stat-card">
         <div class="stat-icon">💾</div>
         <div class="stat-value">${redisConfigured ? (globals.redisValid ? '✓' : '✗') : '—'}</div>
         <div class="stat-label">Redis 缓存</div>
       </div>
     </div>
     
     <div class="redis-card">
       <div class="redis-header">
         <h3 class="redis-title">
           <span>💾</span>
           <span>缓存服务状态</span>
         </h3>
         <span class="status-badge ${redisStatusClass}">
           <span class="status-dot"></span>
           <span>${redisStatusText}</span>
         </span>
       </div>
       <p style="color: var(--text-secondary-dark); font-size: 0.95em; line-height: 1.6;">
         ${redisConfigured 
           ? (globals.redisValid 
             ? '✅ Redis 缓存服务运行正常,已启用持久化存储和智能缓存优化。' 
             : '⚠️ Redis 已配置但连接失败,请检查配置信息和网络连接。')
           : '📝 未配置 Redis 缓存服务,数据将仅保存在内存中(重启后丢失)。'}
       </p>
     </div>
     
     <div class="features-grid">
       <div class="feature-card" onclick="showPage('env')">
         <span class="feature-badge">配置</span>
         <div class="feature-icon">🔧</div>
         <h3 class="feature-title">环境变量</h3>
         <p class="feature-desc">查看和管理所有环境变量配置,包括 API 密钥、服务器设置等</p>
       </div>
       
        <div class="feature-card" onclick="showPage('vod')">
          <span class="feature-badge">${globals.vodServers.length} 个</span>
          <div class="feature-icon">🎬</div>
          <h3 class="feature-title">VOD 采集站</h3>
          <p class="feature-desc">视频资源采集服务器列表,支持多站点并发查询和智能匹配</p>
        </div>
       
       <div class="feature-card" onclick="showPage('sources')">
         <span class="feature-badge">${globals.sourceOrderArr.length} 个</span>
         <div class="feature-icon">🗂️</div>
         <h3 class="feature-title">数据源</h3>
         <p class="feature-desc">查看弹幕数据源优先级排序,影响自动匹配和查询策略</p>
       </div>
     </div>
     
     <div class="footer">
       <p>Made with <span class="footer-heart">♥</span> for Better Anime Experience</p>
        <div class="footer-links">
          <a href="#" class="footer-link" onclick="showPage('env'); return false;">环境变量</a>
          <a href="#" class="footer-link" onclick="showPage('vod'); return false;">采集站配置</a>
          <a href="#" class="footer-link" onclick="showPage('sources'); return false;">数据源</a>
        </div>
     </div>
   </div>
   
   <div id="env-page" class="page detail-page">
     <div class="detail-header">
       <div class="detail-icon">🔧</div>
       <h2 class="detail-title">环境变量配置</h2>
       <p class="detail-subtitle">
         当前系统配置的所有环境变量,敏感信息已加密显示,点击可查看明文
       </p>
     </div>
     
     <div class="env-grid">
       ${envItemsHtml}
     </div>
     
     <div class="footer">
       <p>配置变量总数: <strong>${Object.keys(globals.accessedEnvVars).length}</strong></p>
     </div>
   </div>
   
   <div id="vod-page" class="page detail-page">
      <div class="detail-header">
        <div class="detail-icon">🎬</div>
        <h2 class="detail-title">VOD 采集服务器</h2>
        <p class="detail-subtitle">
          视频资源采集站列表,支持多个服务器并发查询。格式: 名称@URL
        </p>
      </div>
     
     <div class="list-grid">
       ${vodServersHtml}
     </div>
     
     <div class="redis-card" style="margin-top: 30px;">
       <div class="redis-header">
         <h3 class="redis-title">
           <span>⚙️</span>
           <span>VOD 配置</span>
         </h3>
       </div>
       <div class="list-grid">
         <div class="list-item">
           <div class="list-icon">🔄</div>
           <div class="list-content">
             <div class="list-title">返回模式</div>
             <div class="list-value">${globals.vodReturnMode === 'all' ? '返回所有结果' : '返回最快响应'}</div>
           </div>
           <div class="list-badge">${globals.vodReturnMode}</div>
         </div>
         <div class="list-item">
           <div class="list-icon">⏱️</div>
           <div class="list-content">
             <div class="list-title">请求超时</div>
             <div class="list-value">${globals.vodRequestTimeout} 毫秒</div>
           </div>
         </div>
       </div>
     </div>
     
      <div class="footer">
        <p>采集站总数: <strong>${globals.vodServers.length}</strong> | 支持并发查询,自动选择最快响应</p>
      </div>
   </div>
   
   <div id="sources-page" class="page detail-page">
     <div class="detail-header">
       <div class="detail-icon">🗂️</div>
       <h2 class="detail-title">数据源配置</h2>
       <p class="detail-subtitle">
         弹幕数据源优先级排序,数字越小优先级越高,影响自动匹配策略
       </p>
     </div>
     
     <div class="list-grid">
       ${sourcesHtml}
     </div>
     
     <div class="redis-card" style="margin-top: 30px;">
       <div class="redis-header">
         <h3 class="redis-title">
           <span>🎯</span>
           <span>匹配策略</span>
         </h3>
       </div>
       <div class="list-grid">
         <div class="list-item">
           <div class="list-icon">🔍</div>
           <div class="list-content">
             <div class="list-title">严格匹配模式</div>
             <div class="list-value">${globals.strictTitleMatch ? '已启用 - 减少误匹配' : '已禁用 - 宽松匹配'}</div>
           </div>
           <div class="list-badge">${globals.strictTitleMatch ? 'ON' : 'OFF'}</div>
         </div>
         <div class="list-item">
           <div class="list-icon">📝</div>
           <div class="list-content">
             <div class="list-title">记住手动选择</div>
             <div class="list-value">${globals.rememberLastSelect ? '已启用 - 优化匹配准确度' : '已禁用'}</div>
           </div>
           <div class="list-badge">${globals.rememberLastSelect ? 'ON' : 'OFF'}</div>
         </div>
       </div>
     </div>
     
     <div class="footer">
       <p>数据源总数: <strong>${globals.sourceOrderArr.length}</strong></p>
     </div>
   </div>
 </div>
 
 <script>
   let currentPage = 'home';
   let lastScrollTop = 0;
   let scrollTimeout;
   
   // 滚动检测,隐藏/显示按钮
   window.addEventListener('scroll', function() {
     const themeToggle = document.getElementById('theme-toggle-btn');
     const backBtn = document.getElementById('back-btn');
     const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
     
     clearTimeout(scrollTimeout);
     
     if (scrollTop > lastScrollTop && scrollTop > 100) {
       // 向下滚动,隐藏按钮
       themeToggle.classList.add('hide');
       if (currentPage !== 'home') {
         backBtn.classList.add('hide');
       }
     } else {
       // 向上滚动或在顶部,显示按钮
       themeToggle.classList.remove('hide');
       if (currentPage !== 'home') {
         backBtn.classList.remove('hide');
       }
     }
     
     lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
     
     // 停止滚动2秒后显示按钮
     scrollTimeout = setTimeout(function() {
       themeToggle.classList.remove('hide');
       if (currentPage !== 'home') {
         backBtn.classList.remove('hide');
       }
     }, 2000);
   }, false);
   
   function showPage(pageName) {
     if (currentPage === pageName) return;
     
     const currentPageEl = document.getElementById(currentPage + '-page');
     if (currentPageEl) {
       currentPageEl.classList.add('page-out');
       setTimeout(() => {
         currentPageEl.style.display = 'none';
         currentPageEl.classList.remove('page-out', 'active');
       }, 300);
     }
     
     setTimeout(() => {
       const newPageEl = document.getElementById(pageName + '-page');
       if (newPageEl) {
         newPageEl.style.display = 'block';
         setTimeout(() => newPageEl.classList.add('active'), 10);
       }
       
       const backBtn = document.getElementById('back-btn');
       if (pageName === 'home') {
         backBtn.classList.remove('show');
       } else {
         backBtn.classList.add('show');
         backBtn.classList.remove('hide');
       }
       
       currentPage = pageName;
       window.scrollTo({ top: 0, behavior: 'smooth' });
     }, 300);
   }
   
   document.getElementById('back-btn').addEventListener('click', () => {
     showPage('home');
   });
   
   function toggleSensitiveValue(element) {
     const textarea = document.createElement('textarea');
     textarea.innerHTML = element.dataset.real;
     const realValue = textarea.value;
     const maskedValue = element.dataset.masked;
     const isRevealed = element.classList.contains('revealed');
     
     if (isRevealed) {
       element.textContent = maskedValue;
       element.classList.remove('revealed');
       element.title = '点击查看真实值(3秒后自动隐藏)';
       
       if (element.hideTimer) {
         clearTimeout(element.hideTimer);
         delete element.hideTimer;
       }
     } else {
       element.textContent = realValue;
       element.classList.add('revealed');
       element.title = '点击隐藏 / 3秒后自动隐藏';
       
       element.hideTimer = setTimeout(() => {
         if (element.classList.contains('revealed')) {
           element.textContent = maskedValue;
           element.classList.remove('revealed');
           element.title = '点击查看真实值(3秒后自动隐藏)';
         }
         delete element.hideTimer;
       }, 3000);
     }
   }
   
   // 主题切换
   (function() {
     const toggleBtn = document.getElementById('theme-toggle-btn');
     const themeIcon = document.getElementById('theme-icon');
     const body = document.body;
     const themeKey = 'danmu-api-theme';
     
     let savedTheme = 'dark';
     try {
       savedTheme = localStorage.getItem(themeKey) || 'dark';
     } catch (e) {
       console.warn('Could not access localStorage for theme');
     }
     
     if (savedTheme === 'light') {
       body.classList.add('light-mode');
       themeIcon.textContent = '☀️';
     }
     
     function toggleTheme() {
       const isLight = body.classList.toggle('light-mode');
       const newTheme = isLight ? 'light' : 'dark';
       
       themeIcon.textContent = isLight ? '☀️' : '🌙';
       
       themeIcon.style.transform = 'scale(0.8) rotate(180deg)';
       setTimeout(() => {
         themeIcon.style.transform = 'scale(1) rotate(0deg)';
       }, 200);
       
       try {
         localStorage.setItem(themeKey, newTheme);
       } catch (e) {
         console.warn('Could not save theme to localStorage');
       }
     }
     
     toggleBtn.addEventListener('click', toggleTheme);
     themeIcon.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
   })();
   
   // 键盘快捷键
   document.addEventListener('keydown', (e) => {
     if (e.key === 'Escape' && currentPage !== 'home') {
       showPage('home');
     }
     
     if (e.key === '1' && currentPage === 'home') {
       showPage('env');
     } else if (e.key === '2' && currentPage === 'home') {
       showPage('vod');
     } else if (e.key === '3' && currentPage === 'home') {
       showPage('sources');
     }
     
     if (e.key === 't' || e.key === 'T') {
       document.getElementById('theme-toggle-btn').click();
     }
   });
   
   // 双击复制功能
   document.querySelectorAll('.env-value, .list-value').forEach(element => {
     element.addEventListener('dblclick', function() {
       const text = this.textContent;
       if (text === '未配置' || text === '默认') return;
       
       if (this.classList.contains('sensitive') && this.dataset.real) {
         const textarea = document.createElement('textarea');
         textarea.innerHTML = this.dataset.real;
         copyToClipboard(textarea.value);
       } else {
         copyToClipboard(text);
       }
       
       showToast('已复制到剪贴板 ✓');
     });
   });
   
   function copyToClipboard(text) {
     if (navigator.clipboard && window.isSecureContext) {
       navigator.clipboard.writeText(text);
     } else {
       const textArea = document.createElement('textarea');
       textArea.value = text;
       textArea.style.position = 'fixed';
       textArea.style.left = '-999999px';
       document.body.appendChild(textArea);
       textArea.focus();
       textArea.select();
       try {
         document.execCommand('copy');
       } catch (err) {
         console.error('Failed to copy:', err);
       }
       document.body.removeChild(textArea);
     }
   }
   
   function showToast(message) {
     const toast = document.createElement('div');
     toast.textContent = message;
     toast.style.cssText = 'position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(100px); background: linear-gradient(135deg, rgba(102, 126, 234, 0.95), rgba(118, 75, 162, 0.95)); color: white; padding: 14px 28px; border-radius: 25px; font-weight: 600; font-size: 0.95em; z-index: 10000; box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4); backdrop-filter: blur(10px); transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); pointer-events: none;';
     
     document.body.appendChild(toast);
     
     setTimeout(() => {
       toast.style.transform = 'translateX(-50%) translateY(0)';
     }, 10);
     
     setTimeout(() => {
       toast.style.transform = 'translateX(-50%) translateY(100px)';
       toast.style.opacity = '0';
       setTimeout(() => {
         document.body.removeChild(toast);
       }, 300);
     }, 2000);
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
   return handleHomepage();
 }

 if (path === "/favicon.ico" || path === "/robots.txt") {
   return new Response(null, { status: 204 });
 }

 // --- 校验 token ---
 const parts = path.split("/").filter(Boolean);
 if (parts.length < 1 || parts[0] !== globals.token) {
   log("error", `Invalid or missing token in path: ${path}`);
   return jsonResponse(
     { errorCode: 401, success: false, errorMessage: "Unauthorized" },
     401
   );
 }
 
 path = "/" + parts.slice(1).join("/");

 log("info", path);

 // 智能处理API路径前缀
 if (path !== "/" && path !== "/api/logs") {
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
   if (!path.startsWith('/api/v2') && path !== '/' && !path.startsWith('/api/logs')) {
     log("info", `[Path Check] Path is missing /api/v2 prefix. Adding...`);
     path = '/api/v2' + path;
   }

   if (path === pathBeforePrefixCheck) {
     log("info", `[Path Check] Prefix Check: No prefix addition needed.`);
   }

   log("info", `[Path Check] Final normalized path: "${path}"`);
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
   const logText = globals.logBuffer
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


