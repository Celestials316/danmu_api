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
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: #333;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        .header {
            background: white;
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        
        .header h1 {
            color: #667eea;
            margin-bottom: 10px;
            font-size: 2em;
        }
        
        .version {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 4px 12px;
            border-radius: 16px;
            font-size: 0.9em;
            margin-bottom: 15px;
        }
        
        .description {
            color: #666;
            line-height: 1.6;
            margin-bottom: 15px;
        }
        
        .links {
            margin-top: 15px;
        }
        
        .links a {
            display: inline-block;
            color: #667eea;
            text-decoration: none;
            margin-right: 20px;
            font-weight: 500;
            transition: color 0.3s;
        }
        
        .links a:hover {
            color: #764ba2;
            text-decoration: underline;
        }
        
        .card {
            background: white;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        
        .card h2 {
            color: #667eea;
            margin-bottom: 20px;
            font-size: 1.5em;
            border-bottom: 2px solid #f0f0f0;
            padding-bottom: 10px;
        }
        
        .env-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 15px;
        }
        
        .env-item {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 15px;
            border-left: 4px solid #667eea;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        
        .env-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        
        .env-key {
            font-weight: 600;
            color: #667eea;
            margin-bottom: 8px;
            font-size: 0.95em;
            word-break: break-word;
        }
        
        .env-value {
            color: #333;
            font-family: 'Courier New', monospace;
            background: white;
            padding: 8px 12px;
            border-radius: 4px;
            word-break: break-all;
            font-size: 0.9em;
        }
        
        .env-value.boolean-true {
            color: #28a745;
        }
        
        .env-value.boolean-false {
            color: #dc3545;
        }
        
        .notice {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            border-radius: 8px;
            color: #856404;
            line-height: 1.6;
        }
        
        .status-badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: 600;
            margin-left: 10px;
        }
        
        .status-online {
            background: #d4edda;
            color: #155724;
        }
        
        .status-offline {
            background: #f8d7da;
            color: #721c24;
        }
        
        @media (max-width: 768px) {
            .env-grid {
                grid-template-columns: 1fr;
            }
            
            .header h1 {
                font-size: 1.5em;
            }
            
            .links a {
                display: block;
                margin: 10px 0;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎬 LogVar Danmu API Server</h1>
            <span class="version">v${globals.VERSION}</span>
            <p class="description">
                一个人人都能部署的基于 js 的弹幕 API 服务器,支持爱优腾芒哔人韩巴弹幕直接获取,兼容弹弹play的搜索、详情查询和弹幕获取接口规范,并提供日志记录,支持vercel/netlify/edgeone/cloudflare/docker/claw等部署方式,不用提前下载弹幕,没有nas或小鸡也能一键部署。
            </p>
            <div class="links">
                <a href="https://github.com/huangxd-/danmu_api.git" target="_blank">📦 GitHub 仓库</a>
                <a href="https://t.me/ddjdd_bot" target="_blank">🤖 TG 机器人</a>
                <a href="https://t.me/logvar_danmu_group" target="_blank">👥 TG 互助群</a>
                <a href="https://t.me/logvar_danmu_channel" target="_blank">📢 TG 频道</a>
            </div>
        </div>
        
        <div class="card">
            <h2>
                ⚙️ 环境变量配置
                <span class="status-badge ${globals.redisValid ? 'status-online' : 'status-offline'}">
                    Redis: ${globals.redisValid ? '已连接' : '未连接'}
                </span>
            </h2>
            <div class="env-grid">
                ${Object.entries(globals.accessedEnvVars)
                  .map(([key, value]) => {
                    let valueClass = '';
                    let displayValue = value;
                    
                    if (typeof value === 'boolean') {
                      valueClass = value ? 'boolean-true' : 'boolean-false';
                      displayValue = value ? '✓ true' : '✗ false';
                    } else if (value === null || value === undefined) {
                      displayValue = 'null';
                    } else if (typeof value === 'string' && value.length > 50) {
                      displayValue = value.substring(0, 50) + '...';
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
                <strong>⚠️ 免责声明:</strong> 本项目仅为个人爱好开发,代码开源。如有任何侵权行为,请联系本人删除。有问题提issue或私信机器人都ok。推荐加互助群咨询,关注频道获取最新更新内容。
            </div>
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
