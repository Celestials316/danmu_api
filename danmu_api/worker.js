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
  'TOKEN': '自定义API访问令牌,使用默认87654321可以不填写',
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
    
    // 计算已配置的环境变量数量（排除空值、undefined、null）
    const configuredEnvCount = Object.entries(globals.accessedEnvVars).filter(([key, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'string' && value.length === 0) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }).length;

    const totalEnvCount = Object.keys(globals.accessedEnvVars).length;

    // 计算敏感/隐私环境变量的数量
    const sensitiveEnvCount = Object.entries(globals.accessedEnvVars).filter(([key, value]) => {
      // 检查是否为敏感字段
      if (!isSensitiveKey(key)) return false;
      // 检查是否有实际值
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

          const encodedRealValue = String(realValue)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

          return `
            <div class="config-item">
              <div class="config-header">
                <span class="config-label">${key}</span>
                <div class="tooltip-wrapper">
                  <svg class="info-icon" viewBox="0 0 24 24" width="16" height="16">
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
                    <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  <div class="tooltip-content">${description}</div>
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

        // 获取原始完整值用于复制
        const realValue = getRealEnvValue(key);
        const encodedOriginal = String(realValue || value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

        return `
          <div class="config-item">
            <div class="config-header">
              <span class="config-label">${key}</span>
              <div class="tooltip-wrapper">
                <svg class="info-icon" viewBox="0 0 24 24" width="16" height="16">
                  <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
                  <path d="M12 16v-4m0-4h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <div class="tooltip-content">${description}</div>
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
            <div class="server-item">
              <div class="server-badge">${index + 1}</div>
              <div class="server-info">
                <div class="server-name">${serverName}</div>
                <div class="server-url">${serverUrl}</div>
              </div>
            </div>
          `;
        }).join('');
      } else {
        vodServersHtml = defaultVodServers.map((server, index) => `
          <div class="server-item">
            <div class="server-badge default-badge">默认</div>
            <div class="server-info">
              <div class="server-name">${server.name}</div>
              <div class="server-url">${server.url}</div>
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
          <div class="source-item">
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
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --primary-50: #f0f4ff;
      --primary-100: #e0e9ff;
      --primary-200: #c7d7fe;
      --primary-300: #a5b8fc;
      --primary-400: #8b92f9;
      --primary-500: #6366f1;
      --primary-600: #4f46e5;
      --primary-700: #4338ca;
      --primary-800: #3730a3;
      --primary-900: #312e81;
      
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
      --info: #3b82f6;
      
      /* 深色主题 */
      --bg-primary: #0a0a0f;
      --bg-secondary: #13131a;
      --bg-tertiary: #1c1c27;
      --bg-hover: #25253a;
      
      --text-primary: #e5e7eb;
      --text-secondary: #9ca3af;
      --text-tertiary: #6b7280;
      
      --border-color: #2d2d3f;
      --border-light: #3f3f56;
      
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
      --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.6);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      overflow-x: hidden;
    }

    /* 浅色主题 */
    body.light {
      --bg-primary: #f8fafc;
      --bg-secondary: #ffffff;
      --bg-tertiary: #f1f5f9;
      --bg-hover: #e2e8f0;
      
      --text-primary: #1e293b;
      --text-secondary: #475569;
      --text-tertiary: #94a3b8;
      
      --border-color: #e2e8f0;
      --border-light: #cbd5e1;
      
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
      --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
    }

    /* 侧边栏 */
    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: 260px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
      padding: 24px 0;
      overflow-y: auto;
      transition: all 0.3s ease;
      z-index: 1000;
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
    }

    .logo-icon {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: bold;
      color: white;
    }

    .logo-text h1 {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 2px;
    }

    .logo-text p {
      font-size: 12px;
      color: var(--text-tertiary);
    }

    .nav-menu {
      padding: 0 12px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      margin-bottom: 4px;
      border-radius: 8px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
      font-size: 14px;
      font-weight: 500;
    }

    .nav-item:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .nav-item.active {
      background: var(--primary-500);
      color: white;
    }

    .nav-item svg {
      width: 20px;
      height: 20px;
      stroke-width: 2;
    }

    /* 主内容区 */
    .main-content {
      margin-left: 260px;
      min-height: 100vh;
      transition: margin-left 0.3s ease;
    }

    /* 顶部栏 */
    .topbar {
      position: sticky;
      top: 0;
      height: 64px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 0 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 100;
      backdrop-filter: blur(10px);
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .topbar-left h2 {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .topbar-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .theme-toggle {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: var(--bg-tertiary);
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      color: var(--text-primary);
    }

    .theme-toggle:hover {
      background: var(--bg-hover);
      transform: scale(1.05);
    }

    .theme-toggle svg {
      width: 20px;
      height: 20px;
    }

    /* 内容容器 */
    .container {
      padding: 32px;
      max-width: 1400px;
      margin: 0 auto;
    }

    .page-section {
      display: none;
      animation: fadeIn 0.3s ease;
    }

    .page-section.active {
      display: block;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* 统计卡片 */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 24px;
      margin-bottom: 32px;
    }

    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 24px;
      transition: all 0.2s ease;
    }

    .stat-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-lg);
      border-color: var(--primary-500);
    }

    .stat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .stat-title {
      font-size: 14px;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .stat-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .stat-icon.primary {
      background: linear-gradient(135deg, var(--primary-100), var(--primary-200));
      color: var(--primary-700);
    }

    .stat-icon.success {
      background: linear-gradient(135deg, #d1fae5, #a7f3d0);
      color: #059669;
    }

    .stat-icon.warning {
      background: linear-gradient(135deg, #fed7aa, #fbbf24);
      color: #d97706;
    }

    .stat-icon.info {
      background: linear-gradient(135deg, #dbeafe, #bfdbfe);
      color: #2563eb;
    }

    body.light .stat-icon.primary {
      background: var(--primary-100);
      color: var(--primary-600);
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    
    .stat-footer {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border-color);
      font-weight: 500;
    }

    /* 内容卡片 */
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: between;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-color);
    }

    .card-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .card-title svg {
      width: 20px;
      height: 20px;
    }

    /* 徽章 */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge-success {
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }

    .badge-warning {
      background: rgba(245, 158, 11, 0.1);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.2);
    }

    .badge-secondary {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* 配置项 */
    .config-grid {
      display: grid;
      gap: 16px;
    }

    .config-item {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      transition: all 0.2s ease;
    }

    .config-item:hover {
      background: var(--bg-hover);
      border-color: var(--border-light);
    }

    .config-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .config-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--primary-400);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .tooltip-wrapper {
      position: relative;
    }

    .info-icon {
      color: var(--text-tertiary);
      cursor: help;
      transition: color 0.2s;
    }

    .info-icon:hover {
      color: var(--primary-500);
    }

    .tooltip-content {
      position: absolute;
      bottom: calc(100% + 8px);
      right: 0;
      min-width: 250px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
      box-shadow: var(--shadow-lg);
      opacity: 0;
      visibility: hidden;
      transition: all 0.2s ease;
      z-index: 1000;
      pointer-events: none;
    }

    .tooltip-wrapper:hover .tooltip-content {
      opacity: 1;
      visibility: visible;
    }

    .config-value {
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-primary);
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      word-break: break-all;
    }

    .config-value code {
      color: inherit;
      background: none;
    }

    .config-value.value-enabled {
      color: var(--success);
      font-weight: 600;
    }

    .config-value.value-disabled {
      color: var(--error);
      font-weight: 600;
    }

    .config-value.value-empty {
      color: var(--text-tertiary);
      font-style: italic;
    }

    .config-value.sensitive-value {
      cursor: pointer;
      position: relative;
      padding-right: 40px;
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
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-tertiary);
      opacity: 0.6;
      transition: all 0.2s;
    }

    .sensitive-value:hover .eye-icon {
      opacity: 1;
      color: var(--primary-500);
    }

    /* 服务器列表 */
    .server-grid {
      display: grid;
      gap: 12px;
    }

    .server-item {
      display: flex;
      align-items: center;
      gap: 16px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      transition: all 0.2s ease;
    }

    .server-item:hover {
      background: var(--bg-hover);
      border-color: var(--primary-500);
      transform: translateX(4px);
    }

    .server-badge {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--primary-500), var(--primary-600));
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      flex-shrink: 0;
    }

    .server-badge.default-badge {
      background: linear-gradient(135deg, var(--text-tertiary), var(--text-secondary));
    }

    .server-info {
      flex: 1;
      min-width: 0;
    }

    .server-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .server-url {
      font-size: 12px;
      color: var(--text-secondary);
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* 数据源列表 */
    .source-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }

    .source-item {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      transition: all 0.2s ease;
    }

    .source-item:hover {
      background: var(--bg-hover);
      border-color: var(--primary-500);
      transform: translateY(-2px);
    }

    .source-priority {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--primary-500);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
      flex-shrink: 0;
    }

    .source-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--bg-hover), var(--bg-tertiary));
      border: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      color: var(--primary-500);
      flex-shrink: 0;
    }

    .source-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      flex: 1;
    }

    /* 警告框 */
    .alert {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      border-radius: 8px;
      font-size: 14px;
    }

    .alert-icon {
      flex-shrink: 0;
    }

    .alert-error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      color: var(--error);
    }

    .alert-info {
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.2);
      color: var(--info);
    }

    /* 页脚 */
    .footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid var(--border-color);
      text-align: center;
      color: var(--text-tertiary);
      font-size: 14px;
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
      }

      .stats-grid {
        grid-template-columns: 1fr;
        gap: 16px;
      }

      .source-grid {
        grid-template-columns: 1fr;
      }

      .mobile-menu-btn {
        display: flex !important;
      }
    }

    .mobile-menu-btn {
      display: none;
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: var(--bg-tertiary);
      border: none;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      color: var(--text-primary);
      transition: all 0.2s ease;
    }

    .mobile-menu-btn:hover {
      background: var(--bg-hover);
    }

    .mobile-menu-btn svg {
      width: 20px;
      height: 20px;
    }

    /* 移动端遮罩 */
    .mobile-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 999;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .mobile-overlay.show {
      display: block;
      opacity: 1;
    }

    /* 滚动条美化 */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: var(--bg-primary);
    }

    ::-webkit-scrollbar-thumb {
      background: var(--border-light);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--text-tertiary);
    }

    /* Toast 通知 */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px 20px;
      box-shadow: var(--shadow-xl);
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 14px;
      font-weight: 500;
      z-index: 9999;
      animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    .toast-success {
      border-color: var(--success);
      color: var(--success);
    }

    .toast-icon {
      width: 20px;
      height: 20px;
    }
  </style>
</head>
<body>
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
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" stroke="currentColor" fill="none"/>
        </svg>
        <span>概览</span>
      </div>
      
      <div class="nav-item" onclick="switchPage('config')">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor"/>
        </svg>
        <span>环境配置</span>
      </div>
      
      <div class="nav-item" onclick="switchPage('vod')">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M5 3l14 9-14 9V3z" stroke="currentColor"/>
        </svg>
        <span>VOD 采集站</span>
      </div>
      
      <div class="nav-item" onclick="switchPage('sources')">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor"/>
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
        <button class="mobile-menu-btn" onclick="toggleMobileMenu()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 6h16M4 12h16M4 18h16" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
        <h2 id="pageTitle">系统概览</h2>
      </div>
      <div class="topbar-right">
        <button class="theme-toggle" onclick="toggleTheme()" title="切换主题">
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
              ${sensitiveEnvCount > 0 ? `隐私变量: ${sensitiveEnvCount} 个` : '已配置 / 总数'}
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-header">
              <span class="stat-title">VOD 采集站</span>
              <div class="stat-icon success">🎬</div>
            </div>
            <div class="stat-value">${globals.vodServers.length}</div>
            <div class="stat-footer">
              ${globals.vodReturnMode === 'all' ? '返回所有结果' : '仅返回最快'}
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-header">
              <span class="stat-title">数据源</span>
              <div class="stat-icon info">🔗</div>
            </div>
            <div class="stat-value">${globals.sourceOrderArr.length > 0 ? globals.sourceOrderArr.length : '默认'}</div>
            <div class="stat-footer">
              ${globals.sourceOrderArr.length > 0 ? `优先: ${globals.sourceOrderArr[0]}` : '使用默认顺序'}
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-header">
              <span class="stat-title">Redis 缓存</span>
              <div class="stat-icon warning">💾</div>
            </div>
            <div class="stat-value">${redisConfigured ? (globals.redisValid ? '在线' : '离线') : '未配置'}</div>
            <div class="stat-footer">
              ${redisConfigured 
                ? (globals.redisValid ? '持久化存储' : '连接失败') 
                : '仅内存缓存'}
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
          </div>
          <div class="config-grid">
            <div class="config-item">
              <div class="config-header">
                <span class="config-label">Redis 缓存</span>
                <span class="badge ${redisStatusClass}">
                  <span class="status-dot"></span>
                  <span>${redisStatusText}</span>
                </span>
              </div>
              <div class="config-value" style="background: none; border: none; padding: 0;">
                <code style="color: var(--text-secondary); font-size: 13px;">
                  ${redisConfigured 
                    ? (globals.redisValid 
                      ? '✅ 缓存服务运行正常，已启用持久化存储' 
                      : '⚠️ 已配置但连接失败，请检查配置信息')
                    : '📝 未配置，数据仅保存在内存中（重启后丢失）'}
                </code>
              </div>
            </div>
            
            <div class="config-item">
              <div class="config-header">
                <span class="config-label">限流配置</span>
                <span class="badge badge-secondary">
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
          </div>
          <div class="config-grid">
            ${envItemsHtml}
          </div>
        </div>

        <div class="footer">
          <p>共 ${totalEnvCount} 个环境变量，已配置 ${configuredEnvCount} 个 | 双击配置值可复制完整内容</p>
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
          </div>
          <div class="server-grid">
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
              </div>
              <div class="config-value">
                <code>${globals.vodReturnMode === 'all' ? '返回所有站点结果' : '仅返回最快响应站点'}</code>
              </div>
            </div>
            <div class="config-item">
              <div class="config-header">
                <span class="config-label">请求超时</span>
              </div>
              <div class="config-value">
                <code>${globals.vodRequestTimeout} 毫秒</code>
              </div>
            </div>
          </div>
        </div>

        <div class="footer">
          <p>共 ${globals.vodServers.length} 个采集站 | 支持并发查询</p>
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
          </div>
          <div class="source-grid">
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
              </div>
              <div class="config-value ${globals.strictTitleMatch ? 'value-enabled' : 'value-disabled'}">
                <code>${globals.strictTitleMatch ? '已启用 - 减少误匹配' : '已禁用 - 宽松匹配'}</code>
              </div>
            </div>
            <div class="config-item">
              <div class="config-header">
                <span class="config-label">记住手动选择</span>
              </div>
              <div class="config-value ${globals.rememberLastSelect ? 'value-enabled' : 'value-disabled'}">
                <code>${globals.rememberLastSelect ? '已启用 - 优化匹配准确度' : '已禁用'}</code>
              </div>
            </div>
          </div>
        </div>

        <div class="footer">
          <p>共 ${globals.sourceOrderArr.length} 个数据源 | 按优先级排序</p>
        </div>
      </section>
    </div>
  </main>

  <script>
    // 主题切换
    function toggleTheme() {
      const body = document.body;
      const icon = document.getElementById('themeIcon');
      const isLight = body.classList.toggle('light');
      
      if (isLight) {
        icon.innerHTML = '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2"/>';
      } else {
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2"/>';
      }
      
      localStorage.setItem('theme', isLight ? 'light' : 'dark');
    }

    // 初始化主题
    (function() {
      const savedTheme = localStorage.getItem('theme');
      if (savedTheme === 'light') {
        document.body.classList.add('light');
        document.getElementById('themeIcon').innerHTML = '<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2"/>';
      }
    })();

    // 页面切换
    function switchPage(pageName) {
      // 更新导航激活状态
      document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
      });
      event.currentTarget.classList.add('active');

      // 更新页面内容
      document.querySelectorAll('.page-section').forEach(section => {
        section.classList.remove('active');
      });
      document.getElementById(pageName + '-page').classList.add('active');

      // 更新页面标题
      const titles = {
        'overview': '系统概览',
        'config': '环境配置',
        'vod': 'VOD 采集站',
        'sources': '数据源配置'
      };
      document.getElementById('pageTitle').textContent = titles[pageName];

      // 关闭移动端菜单
      closeMobileMenu();
    }

    // 切换敏感信息显示
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

    // 双击复制
    document.addEventListener('dblclick', function(e) {
      const configValue = e.target.closest('.config-value');
      if (configValue) {
        const code = configValue.querySelector('code');
        if (!code) return;
        
        let text = code.textContent;
        
        // 如果是敏感信息，复制真实值
        if (configValue.classList.contains('sensitive-value') && configValue.dataset.real) {
          const textarea = document.createElement('textarea');
          textarea.innerHTML = configValue.dataset.real;
          text = textarea.value;
        } else {
          // 对于非敏感信息，也需要获取原始值
          const originalValue = configValue.dataset.original;
          if (originalValue) {
            const textarea = document.createElement('textarea');
            textarea.innerHTML = originalValue;
            text = textarea.value;
          }
        }
        
        if (text === '未配置' || text === '默认值' || text === '已启用' || text === '已禁用') return;
        
        copyToClipboard(text);
        showToast('已复制到剪贴板');
      }
    });

    // 复制到剪贴板
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

    // 显示提示
    function showToast(message) {
      const toast = document.createElement('div');
      toast.className = 'toast toast-success';
      toast.innerHTML = \`
        <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
        </svg>
        <span>\${message}</span>
      \`;
      
      document.body.appendChild(toast);
      
      setTimeout(() => {
        toast.style.animation = 'slide Out 0.3s ease forwards';
        setTimeout(() => document.body.removeChild(toast), 300);
      }, 2000);
    }

    // 移动端菜单
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

    // 键盘快捷键
    document.addEventListener('keydown', function(e) {
      // Ctrl/Cmd + 数字键切换页面
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '4') {
        e.preventDefault();
        const pages = ['overview', 'config', 'vod', 'sources'];
        const index = parseInt(e.key) - 1;
        if (pages[index]) {
          document.querySelectorAll('.nav-item')[index].click();
        }
      }
      
      // Ctrl/Cmd + K 切换主题
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        toggleTheme();
      }

      // ESC 关闭移动端菜单
      if (e.key === 'Escape') {
        closeMobileMenu();
      }
    });

    // 添加滑出动画
    const style = document.createElement('style');
    style.textContent = \`
      @keyframes slideOut {
        to {
          transform: translateX(400px);
          opacity: 0;
        }
      }
    \`;
    document.head.appendChild(style);
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

  // 如果 token 是默认值 87654321
  if (globals.token === "87654321") {
    // 检查第一段是否是已知的 API 路径（不是 token）
    const knownApiPaths = ["api", "v1", "v2"];

    if (parts.length > 0) {
      // 如果第一段是正确的默认 token
      if (parts[0] === "87654321") {
        // 移除 token，继续处理
        path = "/" + parts.slice(1).join("/");
      } else if (!knownApiPaths.includes(parts[0])) {
        // 第一段不是已知的 API 路径，可能是错误的 token
        // 返回 401
        log("error", `Invalid token in path: ${path}`);
        return jsonResponse(
          { errorCode: 401, success: false, errorMessage: "Unauthorized" },
          401
        );
      }
      // 如果第一段是已知的 API 路径（如 "api"），允许直接访问
    }
  } else {
    // token 不是默认值，必须严格校验
    if (parts.length < 1 || parts[0] !== globals.token) {
      log("error", `Invalid or missing token in path: ${path}`);
      return jsonResponse(
        { errorCode: 401, success: false, errorMessage: "Unauthorized" },
        401
      );
    }
    // 移除 token 部分，剩下的才是真正的路径
    path = "/" + parts.slice(1).join("/");
  }

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