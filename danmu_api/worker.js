import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";

let globals;

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

  function handleHomepage() {
    log("info", "Accessed homepage with repository information");
    
    // 检查 Redis 配置是否存在
    const redisConfigured = !!(globals.redisUrl && globals.redisToken);
    const redisStatusText = redisConfigured 
      ? (globals.redisValid ? '已连接' : '已配置未连接') 
      : '未配置';
    const redisStatusClass = redisConfigured 
      ? (globals.redisValid ? 'status-online' : 'status-warning')
      : 'status-offline';
    
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LogVar Danmu API Server</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 15px;
            color: #333;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            animation: fadeIn 0.6s ease-in;
        }
        
        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .header {
            background: white;
            border-radius: 16px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
        }
        
        .header-top {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .header h1 {
            color: #667eea;
            font-size: 1.8em;
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .emoji {
            font-size: 1.2em;
        }
        
        .version {
            display: inline-flex;
            align-items: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
        }
        
        .description {
            color: #666;
            line-height: 1.8;
            margin-bottom: 20px;
            font-size: 0.95em;
        }
        
        .links {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 20px;
        }
        
        .links a {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 10px 18px;
            background: #f8f9fa;
            color: #667eea;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 500;
            font-size: 0.9em;
            transition: all 0.3s ease;
            border: 2px solid transparent;
        }
        
        .links a:hover {
            background: #667eea;
            color: white;
            border-color: #667eea;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }
        
        .card {
            background: white;
            border-radius: 16px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
            animation: fadeIn 0.6s ease-in;
            animation-delay: 0.2s;
            animation-fill-mode: both;
        }
        
        .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 15px;
            margin-bottom: 25px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f0f0f0;
        }
        
        .card h2 {
            color: #667eea;
            font-size: 1.4em;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .status-badges {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
            white-space: nowrap;
        }
        
        .status-online {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        
        .status-online::before {
            content: '●';
            color: #28a745;
            font-size: 1.2em;
        }
        
        .status-warning {
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
        }
        
        .status-warning::before {
            content: '●';
            color: #ffc107;
            font-size: 1.2em;
        }
        
        .status-offline {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        
        .status-offline::before {
            content: '●';
            color: #dc3545;
            font-size: 1.2em;
        }
        
        .env-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 15px;
        }
        
        .env-item {
            background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%);
            border-radius: 12px;
            padding: 16px;
            border-left: 4px solid #667eea;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        
        .env-item::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.05) 0%, rgba(118, 75, 162, 0.05) 100%);
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        
        .env-item:hover {
            transform: translateY(-3px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.15);
        }
        
        .env-item:hover::before {
            opacity: 1;
        }
        
        .env-key {
            font-weight: 600;
            color: #667eea;
            margin-bottom: 10px;
            font-size: 0.9em;
            word-break: break-word;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .env-key::before {
            content: '▸';
            color: #764ba2;
            font-weight: bold;
        }
        
        .env-value {
            color: #333;
            font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
            background: white;
            padding: 10px 14px;
            border-radius: 8px;
            word-break: break-all;
            font-size: 0.88em;
            border: 1px solid #e9ecef;
            box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05);
        }
        
        .env-value.boolean-true {
            color: #28a745;
            font-weight: 600;
        }
        
        .env-value.boolean-false {
            color: #dc3545;
            font-weight: 600;
        }
        
        .notice {
            background: linear-gradient(135deg, #fff3cd 0%, #fffbea 100%);
            border-left: 4px solid #ffc107;
            padding: 20px;
            border-radius: 12px;
            color: #856404;
            line-height: 1.8;
            box-shadow: 0 2px 8px rgba(255, 193, 7, 0.1);
        }
        
        .notice strong {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 1.05em;
            margin-bottom: 10px;
            color: #856404;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        
        .stat-card {
            background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%);
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            border: 2px solid #e9ecef;
            transition: all 0.3s ease;
        }
        
        .stat-card:hover {
            transform: translateY(-3px);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
            border-color: #667eea;
        }
        
        .stat-number {
            font-size: 2em;
            font-weight: 700;
            color: #667eea;
            margin-bottom: 5px;
        }
        
        .stat-label {
            color: #666;
            font-size: 0.9em;
        }
        
        .footer {
            text-align: center;
            padding: 20px;
            color: white;
            font-size: 0.9em;
            opacity: 0.9;
        }
        
        .footer a {
            color: white;
            text-decoration: underline;
        }
        
        /* 响应式设计 */
        @media (max-width: 768px) {
            body {
                padding: 10px;
            }
            
            .header {
                padding: 20px;
            }
            
            .header h1 {
                font-size: 1.4em;
            }
            
            .card {
                padding: 20px;
            }
            
            .card h2 {
                font-size: 1.2em;
            }
            
            .env-grid {
                grid-template-columns: 1fr;
            }
            
            .links {
                flex-direction: column;
            }
            
            .links a {
                width: 100%;
                justify-content: center;
            }
            
            .card-header {
                flex-direction: column;
                align-items: flex-start;
            }
            
            .status-badges {
                width: 100%;
            }
            
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
        
        @media (max-width: 480px) {
            .header h1 {
                font-size: 1.2em;
            }
            
            .version {
                font-size: 0.75em;
                padding: 5px 12px;
            }
            
            .description {
                font-size: 0.9em;
            }
            
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            .stat-number {
                font-size: 1.6em;
            }
        }
        
        /* 滚动条美化 */
        ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }
        
        ::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
        }
        
        ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 10px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.5);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-top">
                <h1><span class="emoji">🎬</span> LogVar Danmu API</h1>
                <span class="version">v${globals.VERSION}</span>
            </div>
            <p class="description">
                一个人人都能部署的基于 JavaScript 的弹幕 API 服务器，支持爱优腾芒哔人韩巴弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持 Vercel/Netlify/EdgeOne/Cloudflare/Docker/Claw 等部署方式。
            </p>
            <div class="links">
                <a href="https://github.com/huangxd-/danmu_api.git" target="_blank">
                    📦 GitHub 仓库
                </a>
                <a href="https://t.me/ddjdd_bot" target="_blank">
                    🤖 TG 机器人
                </a>
                <a href="https://t.me/logvar_danmu_group" target="_blank">
                    👥 TG 互助群
                </a>
                <a href="https://t.me/logvar_danmu_channel" target="_blank">
                    📢 TG 频道
                </a>
            </div>
        </div>
        
        <div class="card">
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-number">${Object.keys(globals.accessedEnvVars).length}</div>
                    <div class="stat-label">环境变量</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${globals.vodServers.length}</div>
                    <div class="stat-label">VOD 服务器</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${globals.sourceOrderArr.length}</div>
                    <div class="stat-label">数据源</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${redisConfigured ? (globals.redisValid ? '✓' : '✗') : '-'}</div>
                    <div class="stat-label">Redis 状态</div>
                </div>
            </div>
        </div>
        
        <div class="card">
            <div class="card-header">
                <h2><span class="emoji">⚙️</span> 环境变量配置</h2>
                <div class="status-badges">
                    <span class="status-badge ${redisStatusClass}">
                        Redis ${redisStatusText}
                    </span>
                </div>
            </div>
            <div class="env-grid">
                ${Object.entries(globals.accessedEnvVars)
                  .map(([key, value]) => {
                    let valueClass = '';
                    let displayValue = value;
                    
                    if (typeof value === 'boolean') {
                      valueClass = value ? 'boolean-true' : 'boolean-false';
                      displayValue = value ? '✓ true' : '✗ false';
                    } else if (value === null || value === undefined) {
                      displayValue = '(未设置)';
                    } else if (typeof value === 'string' && value.length === 0) {
                      displayValue = '(空字符串)';
                    } else if (typeof value === 'string' && value.length > 50) {
                      displayValue = value.substring(0, 50) + '...';
                    } else if (Array.isArray(value)) {
                      displayValue = `[${value.length} 项]`;
                    }
                    
                    return `
                      <div class="env-item">
                          <div class="env-key">${key}</div>
                          <div class="env-value ${valueClass}">${displayValue}</div>
                      </div>
                    `;
                  })
                  .join('')}
            </div>
        </div>
        
        <div class="card">
            <div class="notice">
                <strong>⚠️ 免责声明</strong>
                <div>
                    本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。有问题可以提 Issue 或私信机器人，推荐加入互助群咨询，关注频道获取最新更新内容。
                </div>
            </div>
        </div>
        
        <div class="footer">
            Made with ❤️ by LogVar Community | 
            <a href="https://github.com/huangxd-/danmu_api.git" target="_blank">Open Source</a>
        </div>
    </div>
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
