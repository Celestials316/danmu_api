import { Globals } from './configs/globals.js';
import { jsonResponse } from './utils/http-util.js';
import { log, formatLogMessage } from './utils/log-util.js'
import { getRedisCaches, judgeRedisValid } from "./utils/redis-util.js";
import { cleanupExpiredIPs, findUrlById, getCommentCache } from "./utils/cache-util.js";
import { formatDanmuResponse } from "./utils/danmu-util.js";
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, searchEpisodes } from "./apis/dandan-api.js";

let globals;

// ==================== 核心处理函数 ====================
async function handleRequest(request, env, platform = "unknown", clientIp = "unknown") {
  const url = new URL(request.url);

  // 处理根路径请求
  if (url.pathname === "/" || url.pathname === "") {
    return new Response(getModernHTML(env, platform, clientIp), {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), { 
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}

// ==================== 现代化 HTML 页面 ====================
function getModernHTML(env, platform, clientIp) {
  const envVars = Object.keys(env || {});
  const redisUrl = env.REDIS_URL || env.KV_URL || env.UPSTASH_REDIS_REST_URL || "";
  
  let redisStatus = "未配置";
  let statusColor = "#94a3b8";
  let statusIcon = "⚪";
  
  if (redisUrl) {
    redisStatus = "已配置";
    statusColor = "#10b981";
    statusIcon = "🟢";
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>环境配置面板</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .container {
      width: 100%;
      max-width: 900px;
      animation: fadeIn 0.6s ease-out;
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
      text-align: center;
      margin-bottom: 40px;
      color: white;
    }

    .header h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 10px;
      text-shadow: 0 2px 10px rgba(0,0,0,0.2);
    }

    .header p {
      font-size: 1rem;
      opacity: 0.9;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }

    .stat-card {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 24px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      transition: all 0.3s ease;
    }

    .stat-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
    }

    .stat-icon {
      font-size: 2rem;
      margin-bottom: 12px;
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #1e293b;
      margin-bottom: 8px;
    }

    .stat-label {
      font-size: 0.9rem;
      color: #64748b;
      font-weight: 500;
    }

    .main-card {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 32px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
    }

    .section {
      margin-bottom: 32px;
    }

    .section:last-child {
      margin-bottom: 0;
    }

    .section-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: #1e293b;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .section-title::before {
      content: "";
      width: 4px;
      height: 24px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 2px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 0;
      border-bottom: 1px solid #e2e8f0;
    }

    .info-row:last-child {
      border-bottom: none;
    }

    .info-label {
      font-weight: 500;
      color: #475569;
      font-size: 0.95rem;
    }

    .info-value {
      font-weight: 600;
      color: #1e293b;
      font-size: 0.95rem;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
      background: ${statusColor}20;
      color: ${statusColor};
    }

    .env-grid {
      display: grid;
      gap: 12px;
    }

    .env-item {
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      padding: 16px;
      border-radius: 12px;
      font-family: "Monaco", "Consolas", monospace;
      font-size: 0.9rem;
      color: #334155;
      border-left: 3px solid #667eea;
      transition: all 0.3s ease;
    }

    .env-item:hover {
      transform: translateX(5px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
    }

    .empty-state {
      text-align: center;
      padding: 32px;
      color: #94a3b8;
      font-size: 0.95rem;
    }

    .footer {
      text-align: center;
      margin-top: 32px;
      color: white;
      font-size: 0.9rem;
      opacity: 0.8;
    }

    /* 移动端适配 */
    @media (max-width: 768px) {
      body {
        padding: 15px;
      }

      .header h1 {
        font-size: 1.8rem;
      }

      .header p {
        font-size: 0.9rem;
      }

      .stats-grid {
        grid-template-columns: 1fr;
        gap: 15px;
      }

      .main-card {
        padding: 20px;
        border-radius: 16px;
      }

      .section-title {
        font-size: 1.1rem;
      }

      .info-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }

      .info-value {
        font-size: 0.9rem;
      }

      .stat-value {
        font-size: 1.6rem;
      }
    }

    @media (max-width: 480px) {
      .header h1 {
        font-size: 1.5rem;
      }

      .stat-card {
        padding: 18px;
      }

      .main-card {
        padding: 16px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚀 环境配置面板</h1>
      <p>系统信息与环境变量概览</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">📊</div>
        <div class="stat-value">${envVars.length}</div>
        <div class="stat-label">环境变量</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">🌐</div>
        <div class="stat-value">${platform}</div>
        <div class="stat-label">运行平台</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">${statusIcon}</div>
        <div class="stat-value">${redisStatus}</div>
        <div class="stat-label">Redis 状态</div>
      </div>
    </div>

    <div class="main-card">
      <div class="section">
        <h2 class="section-title">系统信息</h2>
        <div class="info-row">
          <span class="info-label">运行平台</span>
          <span class="info-value">${platform.toUpperCase()}</span>
        </div>
        <div class="info-row">
          <span class="info-label">客户端 IP</span>
          <span class="info-value">${clientIp}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Redis 状态</span>
          <span class="info-value">
            <span class="status-badge">${statusIcon} ${redisStatus}</span>
          </span>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">环境变量列表</h2>
        ${envVars.length > 0 
          ? `<div class="env-grid">${envVars.map(key => `<div class="env-item">${key}</div>`).join("")}</div>`
          : `<div class="empty-state">暂无环境变量配置</div>`
        }
      </div>
    </div>

    <div class="footer">
      © ${new Date().getFullYear()} 个人环境配置面板
    </div>
  </div>
</body>
</html>`;
}

// ==================== Cloudflare Workers 入口 ====================
export default {
  async fetch(request, env, ctx) {
    const clientIp = request.headers.get('cf-connecting-ip') || 
                     request.headers.get('x-forwarded-for') || 
                     'unknown';
    return handleRequest(request, env, "cloudflare", clientIp);
  },
};

// ==================== Vercel 入口 ====================
export async function vercelHandler(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || 
                   req.connection.remoteAddress || 
                   'unknown';

  const cfReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "POST" || req.method === "PUT" 
      ? JSON.stringify(req.body) 
      : undefined,
  });

  const response = await handleRequest(cfReq, process.env, "vercel", clientIp);
  
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await response.text());
}

// ==================== Netlify 入口 ====================
export async function netlifyHandler(event, context) {
  const clientIp = event.headers['x-nf-client-connection-ip'] ||
                   event.headers['x-forwarded-for'] ||
                   context.ip ||
                   'unknown';

  const url = event.rawUrl || `https://${event.headers.host}${event.path}`;
  const request = new Request(url, {
    method: event.httpMethod,
    headers: new Headers(event.headers),
    body: event.body || undefined,
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
}

// 导出核心函数供测试使用
export { handleRequest };

