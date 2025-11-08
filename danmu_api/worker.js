import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";
import { saveConfigs, checkMySQLConnection } from "./utils/mysql-util.js";

let globals;

// 环境变量说明配置
const ENV_DESCRIPTIONS = {
  'TOKEN': '自定义用户token，用于API访问鉴权',
  'OTHER_SERVER': '兜底第三方弹幕服务器地址',
  'VOD_SERVERS': 'VOD服务器列表，支持多个并发查询',
  'VOD_RETURN_MODE': 'VOD返回模式：all(全部) 或 fastest(最快)',
  'VOD_REQUEST_TIMEOUT': 'VOD服务器请求超时时间(毫秒)',
  'BILIBILI_COOKIE': 'B站Cookie，可获取完整弹幕',
  'YOUKU_CONCURRENCY': '优酷弹幕请求并发数(1-16)',
  'SOURCE_ORDER': '数据源排序，影响匹配优先级',
  'PLATFORM_ORDER': '自动匹配优选平台顺序',
  'EPISODE_TITLE_FILTER': '剧集标题正则过滤规则',
  'ENABLE_EPISODE_FILTER': '手动选择接口是否启用集标题过滤',
  'STRICT_TITLE_MATCH': '严格标题匹配模式，减少误匹配',
  'BLOCKED_WORDS': '弹幕屏蔽词列表',
  'GROUP_MINUTE': '弹幕合并去重时间窗口(分钟)',
  'CONVERT_TOP_BOTTOM_TO_SCROLL': '顶部/底部弹幕转为滚动弹幕',
  'WHITE_RATIO': '白色弹幕占比，0表示全彩色弹幕，100表示全白色弹幕，默认值为-1表示不转换',
  'DANMU_OUTPUT_FORMAT': '弹幕输出格式：json 或 xml',
  'DANMU_SIMPLIFIED': '繁体弹幕转简体(巴哈姆特)',
  'PROXY_URL': '代理/反代地址(巴哈姆特和TMDB)',
  'TMDB_API_KEY': 'TMDB API Key，提升巴哈搜索准确度',
  'RATE_LIMIT_MAX_REQUESTS': '1分钟内同IP最大请求次数',
  'LOG_LEVEL': '日志级别：error/warn/info',
  'SEARCH_CACHE_MINUTES': '搜索结果缓存时间(分钟)',
  'COMMENT_CACHE_MINUTES': '弹幕数据缓存时间(分钟)',
  'REMEMBER_LAST_SELECT': '记住手动选择结果用于优化匹配',
  'MAX_LAST_SELECT_MAP': '最后选择映射缓存大小限制',
  'UPSTASH_REDIS_REST_URL': 'Upstash Redis URL，持久化存储',
  'UPSTASH_REDIS_REST_TOKEN': 'Upstash Redis Token，持久化存储',
  'VERSION': '当前服务版本号',
  'redisValid': 'Redis连接状态',
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
 * @param {string} key 环境变量键名
 * @returns {boolean} 是否敏感
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
 * 获取环境变量的真实值（未加密）
 * @param {string} key 环境变量键名
 * @returns {any} 真实值
 */
function getRealEnvValue(key) {
  // 映射显示键名到实际存储键名
  const keyMapping = {
    'redisUrl': 'UPSTASH_REDIS_REST_URL',
    'redisToken': 'UPSTASH_REDIS_REST_TOKEN',
    'bilibliCookie': 'BILIBILI_COOKIE',
    'tmdbApiKey': 'TMDB_API_KEY',
    'proxyUrl': 'PROXY_URL',
    'token': 'TOKEN'
  };

  const actualKey = keyMapping[key] || key;

  // 优先从 globals.envs 获取（存储的是原始值）
  if (globals.envs && actualKey in globals.envs) {
    return globals.envs[actualKey];
  }

  // 其次从环境变量获取
  if (typeof process !== 'undefined' && process.env?.[actualKey]) {
    return process.env[actualKey];
  }

  // 最后从 Globals 本身获取
  if (actualKey in Globals) {
    return Globals[actualKey];
  }

  return globals.accessedEnvVars[key];
}

async function handleRequest(req, env, deployPlatform, clientIp) {
  // 加载全局变量和环境变量配置
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
fufunction handleHomepage() {
  log("info", "Accessed homepage");

  const redisConfigured = !!(globals.redisUrl && globals.redisToken);
  const redisStatusText = redisConfigured 
    ? (globals.redisValid ? '已连接' : '已配置未连接') 
    : '未配置';
  const redisStatusClass = redisConfigured 
    ? (globals.redisValid ? 'status-online' : 'status-warning')
    : 'status-offline';

  // MySQL 状态 - 添加安全检查
  const mysqlConfigured = !!(globals.envs && globals.envs.MYSQL_HOST && globals.envs.MYSQL_USER);
  const mysqlStatusText = mysqlConfigured 
    ? (globals.mysqlValid ? '已连接' : '已配置未连接') 
    : '未配置';
  const mysqlStatusClass = mysqlConfigured 
    ? (globals.mysqlValid ? 'status-online' : 'status-warning')
    : 'status-offline';

  // 确保 accessedEnvVars 存在
  const accessedEnvVars = globals.accessedEnvVars || {};

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>弹幕 API 服务</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    html {
      overflow-x: hidden;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      background: #0f0f23;
      color: #e5e7eb;
      min-height: 100vh;
      padding: 20px;
      position: relative;
      overflow-x: hidden;
      transition: background 0.3s ease, color 0.3s ease;
    }
    
    /* 动态背景效果 */
    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: 
        radial-gradient(circle at 20% 50%, rgba(120, 119, 198, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(255, 110, 199, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 40% 20%, rgba(59, 130, 246, 0.1) 0%, transparent 50%);
      animation: drift 20s ease-in-out infinite;
      z-index: 0;
      transition: background 0.3s ease;
    }
    
    @keyframes drift {
      0%, 100% { transform: translate(0, 0); }
      50% { transform: translate(-5%, 5%); }
    }
    
    .container {
      max-width: 900px;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }
    
    /* 主标题区域 */
    .hero {
      text-align: center;
      padding: 60px 20px;
      margin-bottom: 40px;
      animation: fadeInUp 0.8s ease-out;
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
    
    .hero-icon {
      font-size: 4em;
      margin-bottom: 20px;
      display: inline-block;
      animation: float 3s ease-in-out infinite;
    }
    
    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
    }
    
    .hero h1 {
      font-size: 2.5em;
      font-weight: 700;
      margin-bottom: 15px;
      background: linear-gradient(135deg, #667eea 0%, #ff6ec3 50%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      transition: all 0.3s ease;
    }
    
    .hero-subtitle {
      font-size: 1.1em;
      color: #9ca3af;
      max-width: 600px;
      margin: 0 auto;
      line-height: 1.6;
      transition: color 0.3s ease;
    }
    
    .version-badge {
      display: inline-block;
      margin-top: 20px;
      padding: 8px 20px;
      background: rgba(102, 126, 234, 0.2);
      border: 1px solid rgba(102, 126, 234, 0.3);
      border-radius: 20px;
      font-size: 0.9em;
      font-weight: 600;
      color: #a5b4fc;
      transition: all 0.3s ease;
    }
    
    /* 状态卡片网格 */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
      animation: fadeInUp 0.8s ease-out 0.2s both;
    }
    
    .stat-card {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 30px;
      text-align: center;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #667eea, #ff6ec3);
      transform: scaleX(0);
      transition: transform 0.3s ease;
    }
    
    .stat-card:hover {
      transform: translateY(-5px);
      border-color: rgba(102, 126, 234, 0.5);
      background: rgba(255, 255, 255, 0.08);
    }
    
    .stat-card:hover::before {
      transform: scaleX(1);
    }
    
    .stat-icon {
      font-size: 2.5em;
      margin-bottom: 15px;
      opacity: 0.9;
    }
    
    .stat-value {
      font-size: 2em;
      font-weight: 700;
      color: #fff;
      margin-bottom: 8px;
      transition: color 0.3s ease;
    }
    
    .stat-label {
      font-size: 0.9em;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 1px;
      transition: color 0.3s ease;
    }
    
    /* Redis 状态卡片 */
    .redis-card {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 30px;
      margin-bottom: 30px;
      animation: fadeInUp 0.8s ease-out 0.4s both;
      transition: all 0.3s ease;
    }
    
    .redis-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 15px;
    }
    
    .redis-title {
      font-size: 1.3em;
      font-weight: 600;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: color 0.3s ease;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: 600;
      transition: all 0.3s ease;
    }
    
    .status-online {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    
    .status-warning {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    
    .status-offline {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      animation: pulse 2s ease-in-out infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    /* 环境变量网格 */
    .env-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 15px;
    }
    
    .env-item {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 15px;
      transition: all 0.3s ease;
    }
    
    .env-item:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(102, 126, 234, 0.3);
    }
    
    .env-key-wrapper {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    
    .env-key {
      font-size: 0.85em;
      color: #a5b4fc;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: color 0.3s ease;
    }
    
    .info-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(102, 126, 234, 0.3);
      color: #a5b4fc;
      font-size: 12px;
      cursor: help;
      transition: all 0.3s ease;
      border: 1px solid rgba(102, 126, 234, 0.4);
      flex-shrink: 0;
    }
    
    .info-icon:hover {
      background: rgba(102, 126, 234, 0.5);
      transform: scale(1.1);
    }
    
    .env-value {
      color: #e5e7eb;
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
      word-break: break-all;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      position: relative;
      transition: all 0.3s ease;
    }
    
    .env-value.boolean-true {
      color: #34d399;
    }
    
    .env-value.boolean-false {
      color: #f87171;
    }
    
    .env-value.not-configured {
      color: #9ca3af;
      font-style: italic;
    }
    
    .env-value.sensitive {
      cursor: pointer;
      user-select: none;
    }
    
    .env-value.sensitive:hover {
      background: rgba(0, 0, 0, 0.5);
      border-color: rgba(102, 126, 234, 0.3);
    }
    
    .env-value.sensitive.revealed {
      color: #fbbf24;
      background: rgba(245, 158, 11, 0.1);
      border-color: rgba(245, 158, 11, 0.3);
    }
    
    .env-value.sensitive::after {
      content: '🙈';
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.9em;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    .env-value.sensitive:hover::after {
      opacity: 0.6;
    }
    
    .env-value.sensitive.revealed::after {
      content: '👁️';
      opacity: 0.8;
    }
    
    /* Tooltip 样式 */
    .tooltip {
      position: relative;
    }
    
    .tooltip .tooltip-text {
      visibility: hidden;
      width: 220px;
      background: rgba(17, 24, 39, 0.98);
      color: #e5e7eb;
      text-align: left;
      border-radius: 8px;
      padding: 10px 12px;
      position: absolute;
      z-index: 1000;
      bottom: 125%;
      left: 50%;
      margin-left: -110px;
      opacity: 0;
      transition: opacity 0.3s, visibility 0.3s;
      font-size: 0.8em;
      line-height: 1.4;
      border: 1px solid rgba(102, 126, 234, 0.3);
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2);
      pointer-events: none;
    }
    
    .tooltip .tooltip-text::after {
      content: "";
      position: absolute;
      top: 100%;
      left: 50%;
      margin-left: -6px;
      border-width: 6px;
      border-style: solid;
      border-color: rgba(17, 24, 39, 0.98) transparent transparent transparent;
    }
    
    .tooltip:hover .tooltip-text {
      visibility: visible;
      opacity: 1;
    }
    
    /* 页脚 */
    .footer {
      text-align: center;
      padding: 40px 20px 20px;
      color: #6b7280;
      font-size: 0.9em;
      animation: fadeInUp 0.8s ease-out 0.6s both;
      transition: color 0.3s ease;
    }
    
    .footer-heart {
      color: #ff6ec3;
      animation: heartbeat 1.5s ease-in-out infinite;
    }
    
    @keyframes heartbeat {
      0%, 100% { transform: scale(1); }
      10%, 30% { transform: scale(1.1); }
      20%, 40% { transform: scale(1); }
    }
    
    /* 响应式设计 */
    @media (max-width: 768px) {
      .hero {
        padding: 40px 15px;
      }
      
      .hero h1 {
        font-size: 2em;
      }
      
      .hero-subtitle {
        font-size: 1em;
      }
      
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 15px;
      }
      
      .stat-card {
        padding: 20px;
      }
      
      .stat-value {
        font-size: 1.6em;
      }
      
      .env-grid {
        grid-template-columns: 1fr;
      }
      
      .tooltip .tooltip-text {
        width: 180px;
        margin-left: -90px;
        font-size: 0.75em;
      }
    }
    
    @media (max-width: 480px) {
      .hero h1 {
        font-size: 1.6em;
      }
      
      .stats-grid {
        grid-template-columns: 1fr;
      }
      
      .tooltip .tooltip-text {
        width: 160px;
        margin-left: -80px;
      }
    }

    /* --- START: 主题切换按钮(滑动开关样式) --- */
    .theme-toggle {
      position: absolute !important;
      top: 20px !important;
      right: 20px !important;
      left: auto !important;
      z-index: 1001;
      width: 60px;
      height: 30px;
      background: rgba(255, 255, 255, 0.1);
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-radius: 30px;
      cursor: pointer;
      display: flex;
      align-items: center;
      padding: 3px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      user-select: none;
      position: relative;
    }
    
    .theme-toggle:hover {
      border-color: rgba(255, 255, 255, 0.4);
      transform: scale(1.05);
    }
    
    /* 滑块 */
    .theme-toggle-slider {
      position: absolute;
      width: 22px;
      height: 22px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7em;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      left: 3px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    
    /* 图标容器 */
    .theme-toggle-icons {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 5px;
      font-size: 0.85em;
      pointer-events: none;
    }
    
    .icon-moon, .icon-sun {
      opacity: 0.5;
      transition: opacity 0.3s ease;
    }
    
    /* 暗色模式:月亮高亮 */
    .icon-moon {
      opacity: 1;
    }
    
    /* 亮色模式样式 */
    body.light-mode .theme-toggle {
      background: rgba(0, 0, 0, 0.05);
      border-color: rgba(0, 0, 0, 0.1);
    }
    
    body.light-mode .theme-toggle:hover {
      border-color: rgba(0, 0, 0, 0.2);
    }
    
    body.light-mode .theme-toggle-slider {
      left: calc(100% - 25px);
      background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    }
    
    body.light-mode .icon-moon {
      opacity: 0.4;
    }
    
    body.light-mode .icon-sun {
      opacity: 1;
    }

    /* --- START: 亮色模式 (Light Mode) --- */
    body.light-mode {
      background: #f9fafb;
      color: #111827;
    }
    body.light-mode::before {
      background: 
        radial-gradient(circle at 20% 50%, rgba(120, 119, 198, 0.03) 0%, transparent 50%),
        radial-gradient(circle at 80% 80%, rgba(255, 110, 199, 0.03) 0%, transparent 50%),
        radial-gradient(circle at 40% 20%, rgba(59, 130, 246, 0.02) 0%, transparent 50%);
    }
    body.light-mode .hero h1 {
      background: none;
      -webkit-background-clip: unset;
      -webkit-text-fill-color: unset;
      background-clip: unset;
      color: #1f2937;
    }
    body.light-mode .hero-subtitle {
      color: #4b5563;
    }
    body.light-mode .version-badge {
      background: rgba(0, 0, 0, 0.05);
      border: 1px solid rgba(0, 0, 0, 0.1);
      color: #4b5563;
    }
    body.light-mode .stat-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      backdrop-filter: none;
    }
    body.light-mode .stat-card:hover {
      transform: translateY(-5px);
      border-color: #d1d5db;
      background: #ffffff;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.03);
    }
    body.light-mode .stat-card::before {
      background: linear-gradient(90deg, #4f46e5, #ec4899);
    }
    body.light-mode .stat-value {
      color: #1f2937;
    }
    body.light-mode .stat-label {
      color: #6b7280;
    }
    body.light-mode .redis-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      backdrop-filter: none;
    }
    body.light-mode .redis-title {
      color: #1f2937;
    }
    body.light-mode .status-online {
      background: rgba(16, 185, 129, 0.1);
      color: #059669;
      border: 1px solid rgba(16, 185, 129, 0.2);
    }
    body.light-mode .status-warning {
      background: rgba(245, 158, 11, 0.1);
      color: #d97706;
      border: 1px solid rgba(245, 158, 11, 0.2);
    }
    body.light-mode .status-offline {
      background: rgba(239, 68, 68, 0.1);
      color: #dc2626;
      border: 1px solid rgba(239, 68, 68, 0.2);
    }
    body.light-mode .env-item {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
    }
    body.light-mode .env-item:hover {
      background: #f3f4f6;
      border-color: rgba(79, 70, 229, 0.3);
    }
    body.light-mode .env-key {
      color: #4f46e5;
    }
    body.light-mode .info-icon {
      background: rgba(79, 70, 229, 0.1);
      color: #4f46e5;
      border: 1px solid rgba(79, 70, 229, 0.2);
    }
    body.light-mode .info-icon:hover {
      background: rgba(79, 70, 229, 0.2);
    }
    body.light-mode .env-value {
      color: #374151;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
    }
    body.light-mode .env-value.boolean-true {
      color: #059669;
    }
    body.light-mode .env-value.boolean-false {
      color: #dc2626;
    }
    body.light-mode .env-value.not-configured {
      color: #6b7280;
    }
    body.light-mode .env-value.sensitive:hover {
      background: #e5e7eb;
      border-color: rgba(79, 70, 229, 0.3);
    }
    body.light-mode .env-value.sensitive.revealed {
      color: #d97706;
      background: rgba(254, 243, 226, 1);
      border-color: rgba(245, 158, 11, 0.2);
    }
    body.light-mode .tooltip .tooltip-text {
      background: #1f2937;
      color: #f9fafb;
      border: 1px solid rgba(0, 0, 0, 0.1);
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }
    body.light-mode .tooltip .tooltip-text::after {
      border-color: #1f2937 transparent transparent transparent;
    }
    body.light-mode .footer {
      color: #4b5563;
    }
    body.light-mode .footer-heart {
      color: #ec4899;
    }
    body.light-mode .theme-toggle {
      background: #ffffff;
      color: #4b5563;
      border: 1px solid #d1d5db;
    }
    body.light-mode .theme-toggle:hover {
      background: #f9fafb;
    }
    /* --- END: 亮色模式 --- */

    /* 编辑按钮样式 */
    .edit-config-btn {
      position: fixed;
      bottom: 30px;
      right: 30px;
      width: 60px;
      height: 60px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 50%;
      border: none;
      color: white;
      font-size: 1.5em;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      transition: all 0.3s ease;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .edit-config-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
    }

    .edit-config-btn:active {
      transform: scale(0.95);
    }

    /* 模态框样式 */
    .modal {
      display: none;
      position: fixed;
      z-index: 2000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(5px);
      animation: fadeIn 0.3s ease;
    }

    .modal.active {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .modal-content {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 16px;
      padding: 30px;
      max-width: 800px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideUp 0.3s ease;
    }

    body.light-mode .modal-content {
      background: #ffffff;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      from {
        transform: translateY(50px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 2px solid rgba(102, 126, 234, 0.2);
    }

    .modal-title {
      font-size: 1.5em;
      font-weight: 700;
      color: #1f2937;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 1.5em;
      color: #6b7280;
      cursor: pointer;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: all 0.3s ease;
    }

    .close-btn:hover {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .config-form {
      display: grid;
      gap: 20px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .form-label {
      font-size: 0.9em;
      font-weight: 600;
      color: #374151;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .form-input {
      padding: 12px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 0.95em;
      font-family: 'Courier New', monospace;
      transition: all 0.3s ease;
      color: #1f2937;
      background: #f9fafb;
    }

    .form-input:focus {
      outline: none;
      border-color: #667eea;
      background: white;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    .form-input.sensitive {
      letter-spacing: 0.1em;
    }

    .form-actions {
      display: flex;
      gap: 12px;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 2px solid rgba(102, 126, 234, 0.1);
    }

    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 1em;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      flex: 1;
    }

    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .btn-secondary {
      background: #e5e7eb;
      color: #374151;
    }

    .btn-secondary:hover {
      background: #d1d5db;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 16px 24px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: none;
      align-items: center;
      gap: 12px;
      z-index: 3000;
      animation: slideInRight 0.3s ease;
    }

    .toast.active {
      display: flex;
    }

    .toast.success {
      border-left: 4px solid #10b981;
    }

    .toast.error {
      border-left: 4px solid #ef4444;
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

    /* 禁用编辑按钮样式 */
    .edit-config-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background: #9ca3af;
    }

    .edit-config-btn:disabled:hover {
      transform: none;
      box-shadow: none;
    }
  </style>
</head>
<body>
  <!-- 主题切换按钮 -->
  <div id="theme-toggle-btn" class="theme-toggle" title="切换主题" role="button" tabindex="0">
    <div class="theme-toggle-slider">
      <span style="font-size: 0.9em;">🌙</span>
    </div>
    <div class="theme-toggle-icons">
      <span class="icon-moon">🌙</span>
      <span class="icon-sun">☀️</span>
    </div>
  </div>

  <!-- 编辑配置按钮 -->
  <button class="edit-config-btn" id="editConfigBtn" ${!mysqlConfigured ? 'disabled title="MySQL未配置"' : 'title="编辑配置"'}>
    ⚙️
  </button>

  <div class="container">
    <div class="hero">
      <div class="hero-icon">🎬</div>
      <h1>弹幕 API 服务</h1>
      <p class="hero-subtitle">
        高性能弹幕数据接口服务,支持多平台弹幕获取与搜索
      </p>
      <span class="version-badge">v${globals.VERSION || '1.0.0'}</span>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">⚙️</div>
        <div class="stat-value">${Object.keys(accessedEnvVars).length}</div>
        <div class="stat-label">环境变量</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📡</div>
        <div class="stat-value">${globals.vodServers ? globals.vodServers.length : 0}</div>
        <div class="stat-label">VOD 服务器</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🔗</div>
        <div class="stat-value">${globals.sourceOrderArr ? globals.sourceOrderArr.length : 0}</div>
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
          缓存服务状态
        </h3>
        <span class="status-badge ${redisStatusClass}">
          <span class="status-dot"></span>
          ${redisStatusText}
        </span>
      </div>
      <div class="env-grid">
        ${Object.entries(accessedEnvVars)
          .map(([key, value]) => {
            let valueClass = '';
            let displayValue = value;
            const description = ENV_DESCRIPTIONS[key] || '环境变量';
            const isSensitive = isSensitiveKey(key);
            
            // 处理不同类型的值
            if (typeof value === 'boolean') {
              valueClass = value ? 'boolean-true' : 'boolean-false';
              displayValue = value ? '✓ 已启用' : '✗ 已禁用';
            } else if (value === null || value === undefined || (typeof value === 'string' && value.length === 0)) {
              // 未配置的情况统一显示
              valueClass = 'not-configured';
              displayValue = '未配置';
            } else if (isSensitive && typeof value === 'string' && value.length > 0) {
              // 敏感信息的处理
              const realValue = getRealEnvValue(key);
              const maskedValue = '•'.repeat(Math.min(String(realValue).length, 32));
              
              // 使用 HTML 实体编码来保存真实值
              const encodedRealValue = String(realValue)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
              
              return `
                <div class="env-item">
                  <div class="env-key-wrapper">
                    <div class="env-key">${key}</div>
                    <div class="tooltip">
                      <span class="info-icon">i</span>
                      <span class="tooltip-text">${description}</span>
                    </div>
                  </div>
                  <div class="env-value sensitive" 
                       data-real="${encodedRealValue}" 
                       data-masked="${maskedValue}"
                       onclick="toggleSensitiveValue(this)"
                       title="点击查看真实值（3秒后自动隐藏）">${maskedValue}</div>
                </div>
              `;
            } else if (Array.isArray(value)) {
              // 数组类型：如果有值显示具体值，没有值显示"默认"
              if (value.length > 0) {
                displayValue = value.join(', ');
              } else {
                valueClass = 'not-configured';
                displayValue = '默认';
              }
            } else if (typeof value === 'string' && value.length > 100) {
              // 过长的字符串截断
              displayValue = value.substring(0, 100) + '...';
            }
            
            return `
              <div class="env-item">
                <div class="env-key-wrapper">
                  <div class="env-key">${key}</div>
                  <div class="tooltip">
                    <span class="info-icon">i</span>
                    <span class="tooltip-text">${description}</span>
                  </div>
                </div>
                <div class="env-value ${valueClass}">${displayValue}</div>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>

    <!-- MySQL 状态卡片 -->
    <div class="redis-card">
      <div class="redis-header">
        <h3 class="redis-title">
          <span>🗄️</span>
          MySQL 数据库
        </h3>
        <span class="status-badge ${mysqlStatusClass}">
          <span class="status-dot"></span>
          ${mysqlStatusText}
        </span>
      </div>
      ${mysqlConfigured ? `
        <div class="env-grid">
          <div class="env-item">
            <div class="env-key-wrapper">
              <div class="env-key">HOST</div>
            </div>
            <div class="env-value">${globals.envs.MYSQL_HOST || '未配置'}</div>
          </div>
          <div class="env-item">
            <div class="env-key-wrapper">
              <div class="env-key">DATABASE</div>
            </div>
            <div class="env-value">${globals.envs.MYSQL_DATABASE || 'danmu_api'}</div>
          </div>
        </div>
      ` : `
        <p style="color: #6b7280; font-size: 0.9em; margin-top: 10px;">
          MySQL 未配置，请在环境变量中设置 MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD
        </p>
      `}
    </div>
    
    <div class="footer">
      Made with <span class="footer-heart">♥</span> for Better Anime Experience
    </div>
  </div>

  <!-- 配置编辑模态框 -->
  <div class="modal" id="configModal">
    <div class="modal-content">
      <div class="modal-header">
        <h2 class="modal-title">⚙️ 编辑配置</h2>
        <button class="close-btn" onclick="closeModal()">×</button>
      </div>
      <form class="config-form" id="configForm">
        ${Object.entries(accessedEnvVars)
          .filter(([key]) => !['redisValid', 'redisUrl', 'redisToken', 'VERSION'].includes(key))
          .map(([key, value]) => {
            const description = ENV_DESCRIPTIONS[key] || '';
            const isSensitive = isSensitiveKey(key);
            const inputType = isSensitive ? 'password' : 'text';
            
            let displayValue = value;
            if (typeof value === 'boolean') {
              displayValue = value ? 'true' : 'false';
            } else if (value === null || value === undefined || (typeof value === 'string' && value.length === 0)) {
              displayValue = '';
            } else if (Array.isArray(value)) {
              displayValue = value.join(', ');
            }

            return `
              <div class="form-group">
                <label class="form-label" for="config_${key}">
                  ${key}
                  <div class="tooltip">
                    <span class="info-icon">i</span>
                    <span class="tooltip-text">${description}</span>
                  </div>
                </label>
                <input 
                  type="${inputType}" 
                  id="config_${key}" 
                  name="${key}"
                  class="form-input ${isSensitive ? 'sensitive' : ''}"
                  value="${displayValue}"
                  placeholder="${description}"
                />
              </div>
            `;
          })
          .join('')}
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal()">取消</button>
          <button type="submit" class="btn btn-primary">保存配置</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Toast 通知 -->
  <div class="toast" id="toast">
    <span id="toastIcon"></span>
    <span id="toastMessage"></span>
  </div>

  <script>
    /**
     * 切换敏感信息的显示状态
     * @param {HTMLElement} element 被点击的环境变量值元素
     */
    function toggleSensitiveValue(element) {
      // 解码HTML实体
      const textarea = document.createElement('textarea');
      textarea.innerHTML = element.dataset.real;
      const realValue = textarea.value;
      const maskedValue = element.dataset.masked;
      const isRevealed = element.classList.contains('revealed');
      
      if (isRevealed) {
        // 当前是显示状态，切换回隐藏
        element.textContent = maskedValue;
        element.classList.remove('revealed');
        element.title = '点击查看真实值（3秒后自动隐藏）';
        
        // 清除定时器（如果存在）
        if (element.hideTimer) {
          clearTimeout(element.hideTimer);
          delete element.hideTimer;
        }
      } else {
        // 当前是隐藏状态，显示真实值
        element.textContent = realValue;
        element.classList.add('revealed');
        element.title = '点击隐藏 / 3秒后自动隐藏';
        
        // 3秒后自动隐藏
        element.hideTimer = setTimeout(() => {
          if (element.classList.contains('revealed')) {
            element.textContent = maskedValue;
            element.classList.remove('revealed');
            element.title = '点击查看真实值（3秒后自动隐藏）';
          }
          delete element.hideTimer;
        }, 3000);
      }
    }

    // --- START: 主题切换逻辑 ---
    (function() {
      const toggleBtn = document.getElementById('theme-toggle-btn');
      if (!toggleBtn) return;
      
      const body = document.body;
      const slider = toggleBtn.querySelector('.theme-toggle-slider');
      const themeKey = 'theme-preference';
      
      // 检查localStorage中保存的主题
      let savedTheme = 'dark'; // 默认为暗色
      try {
        savedTheme = localStorage.getItem(themeKey) || 'dark';
      } catch (e) {
        console.warn('Could not access localStorage for theme');
      }
      
      // 应用保存的主题
      if (savedTheme === 'light') {
        body.classList.add('light-mode');
        if (slider) slider.innerHTML = '<span style="font-size: 0.9em;">☀️</span>';
      }

      // 切换主题函数
      function toggleTheme() {
        const isLight = body.classList.toggle('light-mode');
        const newTheme = isLight ? 'light' : 'dark';
        
        // 更新滑块图标
        if (slider) {
          slider.innerHTML = isLight 
            ? '<span style="font-size: 0.9em;">☀️</span>' 
            : '<span style="font-size: 0.9em;">🌙</span>';
        }
        
        // 保存偏好到localStorage
        try {
          localStorage.setItem(themeKey, newTheme);
        } catch (e) {
          console.warn('Could not save theme to localStorage');
        }
      }

      // 添加点击事件
      toggleBtn.addEventListener('click', toggleTheme);
      
      // 添加键盘支持(按回车切换)
      toggleBtn.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleTheme();
        }
      });
    })();
    // --- END: 主题切换逻辑 ---

    // 配置编辑功能
    const modal = document.getElementById('configModal');
    const editBtn = document.getElementById('editConfigBtn');
    const configForm = document.getElementById('configForm');
    const toast = document.getElementById('toast');

    // 打开模态框
    editBtn?.addEventListener('click', () => {
      if (!editBtn.disabled) {
        modal.classList.add('active');
      }
    });

    // 关闭模态框
    function closeModal() {
      modal.classList.remove('active');
    }

    // 点击模态框外部关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    // 显示通知
    function showToast(message, type = 'success') {
      toast.className = \`toast active \${type}\`;
      document.getElementById('toastIcon').textContent = type === 'success' ? '✓' : '✗';
      document.getElementById('toastMessage').textContent = message;

      setTimeout(() => {
        toast.classList.remove('active');
      }, 3000);
    }

    // 提交表单
    configForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const formData = new FormData(configForm);
      const configs = {};

      for (const [key, value] of formData.entries()) {
        configs[key] = value;
      }

      const submitBtn = configForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = '保存中...';

      try {
        const token = window.location.pathname.split('/')[1] || '${globals.token}';
        const response = await fetch(\`/\${token}/api/config/update\`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ configs })
        });

        const result = await response.json();

        if (result.success) {
          showToast('配置保存成功！页面将在 2 秒后刷新', 'success');
          setTimeout(() => {
            window.location.reload();
          }, 2000);
        } else {
          showToast(\`保存失败: \${result.errorMessage}\`, 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = '保存配置';
        }
      } catch (error) {
        showToast(\`网络错误: \${error.message}\`, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '保存配置';
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

  // --- 校验 token ---
  const parts = path.split("/").filter(Boolean); // 去掉空段
  if (parts.length < 1 || parts[0] !== globals.token) {
    log("error", `Invalid or missing token in path: ${path}`);
    return jsonResponse(
      { errorCode: 401, success: false, errorMessage: "Unauthorized" },
      401
    );
  }
  // 移除 token 部分,剩下的才是真正的路径
  path = "/" + parts.slice(1).join("/");

  log("info", path);

  // 智能处理API路径前缀,确保最终有一个正确的 /api/v2
  if (path !== "/" && path !== "/api/logs") {
      log("info", `[Path Check] Starting path normalization for: "${path}"`);
      const pathBeforeCleanup = path; // 保存清理前的路径检查是否修改

      // 1. 清理:应对"用户填写/api/v2"+"客户端添加/api/v2"导致的重复前缀
      while (path.startsWith('/api/v2/api/v2/')) {
          log("info", `[Path Check] Found redundant /api/v2 prefix. Cleaning...`);
          // 从第二个 /api/v2 的位置开始截取,相当于移除第一个
          path = path.substring('/api/v2'.length);
      }

      // 打印日志:只有在发生清理时才显示清理后的路径,否则显示"无需清理"
      if (path !== pathBeforeCleanup) {
          log("info", `[Path Check] Path after cleanup: "${path}"`);
      } else {
          log("info", `[Path Check] Path after cleanup: No cleanup needed.`);
      }

      // 2. 补全:如果路径缺少前缀(例如请求原始路径为 /search/anime),则补全
      const pathBeforePrefixCheck = path;
      if (!path.startsWith('/api/v2') && path !== '/' && !path.startsWith('/api/logs')) {
          log("info", `[Path Check] Path is missing /api/v2 prefix. Adding...`);
          path = '/api/v2' + path;
      }

      // 打印日志:只有在发生添加前缀时才显示添加后的路径,否则显示"无需补全"
      if (path === pathBeforePrefixCheck) {
          log("info", `[Path Check] Prefix Check: No prefix addition needed.`);
      }

      log("info", `[Path Check] Final normalized path: "${path}"`);
  }

  // GET /
  if (path === "/" && method === "GET") {
    return handleHomepage();
  }

  // POST /{token}/api/config/update - 更新配置
  if (path === "/api/config/update" && method === "POST") {
    return handleConfigUpdate(req);
  }

  // GET /{token}/api/config/status - 获取数据库状态
  if (path === "/api/config/status" && method === "GET") {
    return handleConfigStatus();
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

    // ⚠️ 限流设计说明:
    // 1. 先检查缓存,缓存命中时直接返回,不计入限流次数
    // 2. 只有缓存未命中时才执行限流检查和网络请求
    // 3. 这样可以避免频繁访问同一弹幕时被限流,提高用户体验

    // 如果有url参数,则通过URL获取弹幕
    if (videoUrl) {
      // 先检查缓存
      const cachedComments = getCommentCache(videoUrl);
      if (cachedComments !== null) {
        log("info", `[Rate Limit] Cache hit for URL: ${videoUrl}, skipping rate limit check`);
        const responseData = { count: cachedComments.length, comments: cachedComments };
        return formatDanmuResponse(responseData, queryFormat);
      }

      // 缓存未命中,执行限流检查(如果 rateLimitMaxRequests > 0 则启用限流)
      if (globals.rateLimitMaxRequests > 0) {
        const currentTime = Date.now();
        const oneMinute = 60 * 1000;

        // 清理所有过期的 IP 记录
        cleanupExpiredIPs(currentTime);

        // 检查该 IP 地址的历史请求
        if (!globals.requestHistory.has(clientIp)) {
          globals.requestHistory.set(clientIp, []);
        }

        const history = globals.requestHistory.get(clientIp);
        const recentRequests = history.filter(timestamp => currentTime - timestamp <= oneMinute);

        // 如果最近 1 分钟内的请求次数超过限制,返回 429 错误
        if (recentRequests.length >= globals.rateLimitMaxRequests) {
          log("warn", `[Rate Limit] IP ${clientIp} exceeded rate limit (${recentRequests.length}/${globals.rateLimitMaxRequests} requests in 1 minute)`);
          return jsonResponse(
            { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
            429
          );
        }

        // 记录本次请求时间戳
        recentRequests.push(currentTime);
        globals.requestHistory.set(clientIp, recentRequests);
        log("info", `[Rate Limit] IP ${clientIp} request count: ${recentRequests.length}/${globals.rateLimitMaxRequests}`);
      }

      // 通过URL获取弹幕
      return getCommentByUrl(videoUrl, queryFormat);
    }

    // 否则通过commentId获取弹幕
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
      // 检查弹幕缓存 - 缓存命中时直接返回,不计入限流
      const cachedComments = getCommentCache(urlForComment);
      if (cachedComments !== null) {
        log("info", `[Rate Limit] Cache hit for URL: ${urlForComment}, skipping rate limit check`);
        const responseData = { count: cachedComments.length, comments: cachedComments };
        return formatDanmuResponse(responseData, queryFormat);
      }
    }

    // 缓存未命中,执行限流检查(如果 rateLimitMaxRequests > 0 则启用限流)
    if (globals.rateLimitMaxRequests > 0) {
      // 获取当前时间戳(单位:毫秒)
      const currentTime = Date.now();
      const oneMinute = 60 * 1000;  // 1分钟 = 60000 毫秒

      // 清理所有过期的 IP 记录
      cleanupExpiredIPs(currentTime);

      // 检查该 IP 地址的历史请求
      if (!globals.requestHistory.has(clientIp)) {
        // 如果该 IP 地址没有请求历史,初始化一个空队列
        globals.requestHistory.set(clientIp, []);
      }

      const history = globals.requestHistory.get(clientIp);

      // 过滤掉已经超出 1 分钟的请求
      const recentRequests = history.filter(timestamp => currentTime - timestamp <= oneMinute);

      // 如果最近的请求数量大于等于配置的限制次数,则限制请求
      if (recentRequests.length >= globals.rateLimitMaxRequests) {
        log("warn", `[Rate Limit] IP ${clientIp} exceeded rate limit (${recentRequests.length}/${globals.rateLimitMaxRequests} requests in 1 minute)`);
        return jsonResponse(
          { errorCode: 429, success: false, errorMessage: "Too many requests, please try again later" },
          429
        );
      }

      // 记录本次请求时间戳
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

/**
 * 处理配置更新请求
 */
async function handleConfigUpdate(req) {
  try {
    // 检查 MySQL 连接
    if (!globals.mysqlValid) {
      return jsonResponse(
        { 
          errorCode: 503, 
          success: false, 
          errorMessage: "MySQL database not configured or not connected" 
        },
        503
      );
    }

    // 解析请求体
    const body = await req.json();
    const { configs } = body;

    if (!configs || typeof configs !== 'object') {
      return jsonResponse(
        { 
          errorCode: 400, 
          success: false, 
          errorMessage: "Invalid request body, 'configs' object required" 
        },
        400
      );
    }

    // 验证配置字段
    const validKeys = Object.keys(ENV_DESCRIPTIONS);
    const invalidKeys = Object.keys(configs).filter(key => !validKeys.includes(key));
    
    if (invalidKeys.length > 0) {
      return jsonResponse(
        { 
          errorCode: 400, 
          success: false, 
          errorMessage: `Invalid config keys: ${invalidKeys.join(', ')}` 
        },
        400
      );
    }

    // 保存到数据库
    await saveConfigs(configs, ENV_DESCRIPTIONS, SENSITIVE_KEYS);

    // 重新加载环境变量（更新内存中的配置）
    globals.envs = await Envs.load(process.env, 'node');
    globals.accessedEnvVars = Object.fromEntries(Envs.getAccessedEnvVars());

    log("info", `[Config] Updated ${Object.keys(configs).length} configuration(s)`);

    return jsonResponse({
      success: true,
      message: "Configuration updated successfully",
      updated: Object.keys(configs)
    });

  } catch (error) {
    log("error", `[Config] Update failed: ${error.message}`);
    return jsonResponse(
      { 
        errorCode: 500, 
        success: false, 
        errorMessage: error.message 
      },
      500
    );
  }
}

/**
 * 处理配置状态查询
 */
async function handleConfigStatus() {
  try {
    const mysqlConnected = await checkMySQLConnection();
    
    return jsonResponse({
      success: true,
      mysql: {
        configured: !!(globals.envs.MYSQL_HOST && globals.envs.MYSQL_USER),
        connected: mysqlConnected
      }
    });
  } catch (error) {
    log("error", `[Config] Status check failed: ${error.message}`);
    return jsonResponse(
      { 
        errorCode: 500, 
        success: false, 
        errorMessage: error.message 
      },
      500
    );
  }
}

// --- Cloudflare Workers 入口 ---
export default {
  async fetch(request, env, ctx) {
    // 获取客户端的真实 IP
    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

    return handleRequest(request, env, "cloudflare", clientIp);
  },
};

// --- Vercel 入口 ---
export async function vercelHandler(req, res) {
  // 从请求头获取真实 IP
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';

  const cfReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body:
      req.method === "POST" || req.method === "PUT"
        ? JSON.stringify(req.body)
        : undefined,
  });

  const response = await handleRequest(cfReq, process.env, "vercel", clientIp);

  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const text = await response.text();
  res.send(text);
}

// --- Netlify 入口 ---
export async function netlifyHandler(event, context) {
  // 获取客户端 IP
  const clientIp = event.headers['x-nf-client-connection-ip'] ||
                    event.headers['x-forwarded-for'] ||
                    context.ip ||
                    'unknown';

  // 构造标准 Request 对象
  const url = event.rawUrl || `https://${event.headers.host}${event.path}`;

  const request = new Request(url, {
    method: event.httpMethod,
    headers: new Headers(event.headers),
    body: event.body ? event.body : undefined,
  });

  // 调用核心处理函数
  const response = await handleRequest(request, process.env, "netlify", clientIp);

  // 转换为 Netlify 响应格式
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
  };
}

// 为了测试导出 handleRequest
export { handleRequest};