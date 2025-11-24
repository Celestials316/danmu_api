// server.js - 智能服务器启动器：根据 Node.js 环境自动选择最优启动模式

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import http from 'http';
import https from 'https';
import url from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';
// 🔥 导入并初始化 Globals
import { Globals } from './danmu_api/configs/globals.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置文件路径在项目根目录（server.js 的上一级目录）
const envPath = path.join(__dirname, '..', '.env');
const yamlPath = path.join(__dirname, '..', 'config.yaml');

/**
 * 从 YAML 文件加载配置
 * @returns {Object} 解析后的配置对象
 */
function loadYamlConfig() {
  try {
    if (!fs.existsSync(yamlPath)) {
      return {};
    }
    const yamlContent = fs.readFileSync(yamlPath, 'utf8');
    const config = yaml.load(yamlContent) || {};
    console.log('[server] config.yaml file loaded successfully');
    return config;
  } catch (e) {
    console.log('[server] Error loading config.yaml:', e.message);
    return {};
  }
}

/**
 * 将 YAML 配置对象转换为环境变量
 * @param {Object} config YAML 配置对象
 */
function applyYamlConfig(config) {
  if (!config || typeof config !== 'object') {
    return;
  }

  // 递归处理嵌套对象，转换为 UPPER_SNAKE_CASE 环境变量
  const flattenConfig = (obj, prefix = '') => {
    for (const [key, value] of Object.entries(obj)) {
      const envKey = prefix ? `${prefix}_${key.toUpperCase()}` : key.toUpperCase();

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // 递归处理嵌套对象
        flattenConfig(value, envKey);
      } else if (Array.isArray(value)) {
        // 数组转换为逗号分隔的字符串
        process.env[envKey] = value.join(',');
      } else {
        // 基本类型直接转换为字符串
        process.env[envKey] = String(value);
      }
    }
  };

  flattenConfig(config);
}

function loadEnv() {
  try {
    // 先加载 YAML 配置（优先级较低）
    const yamlConfig = loadYamlConfig();
    applyYamlConfig(yamlConfig);

    // 再加载 .env 文件（优先级较高，会覆盖 YAML 配置）
    dotenv.config({ path: envPath, override: true });
    console.log('[server] .env file loaded successfully');
  } catch (e) {
    console.log('[server] dotenv not available or .env file not found, using system environment variables');
  }
}

// 初始加载
loadEnv();

// 监听 .env 和 config.yaml 文件变化（仅在文件存在时）
let envWatcher = null;
let reloadTimer = null;
let mainServer = null;
let proxyServer = null;

async function setupEnvWatcher() {
  const envExists = fs.existsSync(envPath);
  const yamlExists = fs.existsSync(yamlPath);

  if (!envExists && !yamlExists) {
    console.log('[server] Neither .env nor config.yaml found, skipping file watcher');
    return;
  }

  try {
    const chokidar = await import('chokidar');
    const watchPaths = [];
    if (envExists) watchPaths.push(envPath);
    if (yamlExists) watchPaths.push(yamlPath);

    envWatcher = chokidar.watch(watchPaths, {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100
      }
    });

    envWatcher.on('change', (changedPath) => {
      // 防抖：避免短时间内多次触发
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }

      reloadTimer = setTimeout(() => {
        const fileName = path.basename(changedPath);
        console.log(`[server] ${fileName} changed, reloading environment variables...`);

        // 读取新的配置文件内容
        try {
          const newEnvKeys = new Set();

          // 如果是 .env 文件变化
          if (changedPath === envPath && fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const lines = envContent.split('\n');

            // 解析 .env 文件中的所有键
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith('#')) {
                const match = trimmed.match(/^([^=]+)=/);
                if (match) {
                  newEnvKeys.add(match[1]);
                }
              }
            }
          }

          // 如果是 config.yaml 文件变化
          if (changedPath === yamlPath && fs.existsSync(yamlPath)) {
            const yamlConfig = loadYamlConfig();
            const flattenKeys = (obj, prefix = '') => {
              for (const [key, value] of Object.entries(obj)) {
                const envKey = prefix ? `${prefix}_${key.toUpperCase()}` : key.toUpperCase();
                newEnvKeys.add(envKey);
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                  flattenKeys(value, envKey);
                }
              }
            };
            flattenKeys(yamlConfig);
          }

          // 删除 process.env 中旧的键（不在新配置文件中的键）
          for (const key of Object.keys(process.env)) {
            if (!newEnvKeys.has(key)) {
              delete process.env[key];
            }
          }

          // 重新加载环境变量
          loadEnv();

          console.log('[server] Environment variables reloaded successfully');
          console.log('[server] Updated keys:', Array.from(newEnvKeys).join(', '));
        } catch (error) {
          console.log('[server] Error reloading configuration files:', error.message);
        }

        reloadTimer = null;
      }, 200); // 200ms 防抖
    });

    envWatcher.on('unlink', (deletedPath) => {
      const fileName = path.basename(deletedPath);
      console.log(`[server] ${fileName} deleted, using remaining configuration files`);
    });

    envWatcher.on('error', (error) => {
      console.log('[server] File watcher error:', error.message);
    });

    const watchedFiles = watchPaths.map(p => path.basename(p)).join(' and ');
    console.log(`[server] Configuration file watcher started for: ${watchedFiles}`);
  } catch (e) {
    console.log('[server] chokidar not available, configuration hot reload disabled');
  }
}

// 优雅关闭：清理文件监听器
function cleanupWatcher() {
  if (envWatcher) {
    console.log('[server] Closing file watcher...');
    envWatcher.close();
    envWatcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  // 优雅关闭主服务器
  if (mainServer) {
    console.log('[server] Closing main server...');
    mainServer.close(() => {
      console.log('[server] Main server closed');
    });
  }
  // 优雅关闭代理服务器
  if (proxyServer) {
    console.log('[server] Closing proxy server...');
    proxyServer.close(() => {
      console.log('[server] Proxy server closed');
    });
  }
  // 给服务器一点时间关闭后退出
  setTimeout(() => {
    console.log('[server] Exit complete.');
    process.exit(0);
  }, 500);
}

// 监听进程退出信号
process.on('SIGTERM', cleanupWatcher);
process.on('SIGINT', cleanupWatcher);

// 导入 ES module 兼容层
import './esm-shim.js';

// --- 版本兼容性检测工具 ---
// 辅助函数：比较两个版本号字符串
function compareVersion(version1, version2) {
  const v1Parts = version1.split('.').map(Number);
  const v2Parts = version2.split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;

    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
  }

  return 0;
}

// 检测是否需要异步启动（兼容层模式）
async function needsAsyncStartup() {
  try {
    const nodeVersion = process.versions.node;
    const isNodeCompatible = compareVersion(nodeVersion, '20.19.0') >= 0;

    // 尝试检测已安装的 node-fetch 版本
    const packagePath = path.join(__dirname, '..', 'node_modules', 'node-fetch', 'package.json');

    if (!fs.existsSync(packagePath)) {
      console.log('[server] Cannot detect node-fetch, using sync startup');
      return false;
    }

    const pkgContent = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(pkgContent);
    const isNodeFetchV3 = pkg.version.startsWith('3.');

    const needsAsync = !isNodeCompatible && isNodeFetchV3;

    console.log(`[server] Environment check: Node ${nodeVersion}, node-fetch ${pkg.version}`);
    console.log(`[server] Node.js compatible (>=20.19.0): ${isNodeCompatible}`);
    console.log(`[server] node-fetch v3: ${isNodeFetchV3}`);
    console.log(`[server] Needs async startup: ${needsAsync}`);

    return needsAsync;

  } catch (e) {
    console.log('[server] Cannot detect node-fetch, using sync startup');
    return false;
  }
}

// --- 核心 HTTP 服务器（端口 9321）逻辑 ---
async function createServer() {
  // 🔥 初始化 Globals（确保在处理请求前完成）
  await Globals.init(process.env, 'node');
  console.log('[server] Globals initialized successfully');

  const nodeFetch = await import('node-fetch');
  const fetch = nodeFetch.default;
  const { Request, Response } = nodeFetch;

  const workerModule = await import('./worker.js');
  const { handleRequest } = workerModule;

  return http.createServer(async (req, res) => {
    try {
      const fullUrl = `http://${req.headers.host}${req.url}`;

      // 获取请求客户端的ip
      let clientIp = 'unknown';

      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        clientIp = forwardedFor.split(',')[0].trim();
        console.log(`[server] Using X-Forwarded-For IP: ${clientIp}`);
      } else if (req.headers['x-real-ip']) {
        clientIp = req.headers['x-real-ip'];
        console.log(`[server] Using X-Real-IP: ${clientIp}`);
      } else {
        clientIp = req.socket.remoteAddress || 'unknown';
        console.log(`[server] Using direct connection IP: ${clientIp}`);
      }

      // 清理IPv6前缀
      if (clientIp && clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
      }

      // 异步读取请求体
      let body;
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        });
      }

      const webRequest = new Request(fullUrl, {
        method: req.method,
        headers: req.headers,
        body: body || undefined,
      });

      const webResponse = await handleRequest(webRequest, process.env, "node", clientIp);

      res.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const responseText = await webResponse.text();
      res.end(responseText);
    } catch (error) {
      console.error('Server error:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
}

// 代理服务器逻辑
function createProxyServer() {
  return http.createServer((req, res) => {
    const queryObject = url.parse(req.url, true).query;

    if (queryObject.url) {
      const proxyConfig = process.env.PROXY_URL || '';
      let forwardProxy = null;
      let bahamutRP = null;
      let tmdbRP = null;
      let universalRP = null;

      if (proxyConfig) {
        const proxyConfigs = proxyConfig.split(',').map(s => s.trim()).filter(s => s);

        for (const config of proxyConfigs) {
          if (config.startsWith('bahamut@')) {
            bahamutRP = config.substring(8).trim().replace(/\/+$/, '');
            console.log('[Proxy Server] Bahamut reverse proxy detected:', bahamutRP);
          } else if (config.startsWith('tmdb@')) {
            tmdbRP = config.substring(5).trim().replace(/\/+$/, '');
            console.log('[Proxy Server] TMDB reverse proxy detected:', tmdbRP);
          } else if (config.startsWith('@')) {
            universalRP = config.substring(1).trim().replace(/\/+$/, '');
            console.log('[Proxy Server] Universal reverse proxy detected:', universalRP);
          } else {
            forwardProxy = config.trim();
            console.log('[Proxy Server] Forward proxy detected:', forwardProxy);
          }
        }
      }

      const targetUrl = queryObject.url;
      console.log('[Proxy Server] Target URL:', targetUrl);

      const originalUrlObj = new URL(targetUrl);
      let options = {
        hostname: originalUrlObj.hostname,
        port: originalUrlObj.port || (originalUrlObj.protocol === 'https:' ? 443 : 80),
        path: originalUrlObj.pathname + originalUrlObj.search,
        method: 'GET',
        headers: { ...req.headers }
      };
      delete options.headers.host;

      let protocol = originalUrlObj.protocol === 'https:' ? https : http;
      let finalReverseProxy = null;

      if (bahamutRP && originalUrlObj.hostname.includes('gamer.com.tw')) {
        finalReverseProxy = bahamutRP;
        console.log('[Proxy Server] Using Bahamut-specific reverse proxy');
      } else if (tmdbRP && originalUrlObj.hostname.includes('tmdb.org')) {
        finalReverseProxy = tmdbRP;
        console.log('[Proxy Server] Using TMDB-specific reverse proxy');
      } else if (universalRP) {
        finalReverseProxy = universalRP;
        console.log('[Proxy Server] Using universal reverse proxy');
      }

      if (finalReverseProxy) {
        try {
          const reverseUrlObj = new URL(finalReverseProxy);
          options.hostname = reverseUrlObj.hostname;
          options.port = reverseUrlObj.port || (reverseUrlObj.protocol === 'https:' ? 443 : 80);
          protocol = reverseUrlObj.protocol === 'https:' ? https : http;

          const baseReversePath = reverseUrlObj.pathname.replace(/\/$/, '');
          let logMessage = '';

          if (finalReverseProxy === universalRP) {
            options.path = baseReversePath + '/' + targetUrl.replace(':/', '');
            logMessage = `[Proxy Server] Universal RP rewriting to: ${protocol === https ? 'https' : 'http'}://${options.hostname}:${options.port}${options.path}`;
          } else {
            options.path = baseReversePath + originalUrlObj.pathname + originalUrlObj.search;
            logMessage = `[Proxy Server] Specific RP rewriting to: ${protocol === https ? 'https' : 'http'}://${options.hostname}:${options.port}${options.path}`;
          }

          console.log(logMessage);

        } catch (e) {
          console.error('[Proxy Server] Invalid reverse proxy URL:', finalReverseProxy, e.message);
          res.statusCode = 500;
          res.end('Proxy Error: Invalid Reverse Proxy URL');
          return;
        }
      } else if (forwardProxy) {
        console.log('[Proxy Server] Using forward proxy agent:', forwardProxy);
        options.agent = new HttpsProxyAgent(forwardProxy);
      } else {
        console.log('[Proxy Server] No proxy configured, direct connection');
      }

      const proxyReq = protocol.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });

      proxyReq.on('error', (err) => {
        console.error('Proxy request error:', err);
        res.statusCode = 500;
        res.end('Proxy Error: ' + err.message);
      });

      proxyReq.end();
    } else {
      res.statusCode = 400;
      res.end('Bad Request: Missing URL parameter');
    }
  });
}

// --- 启动函数 ---
async function startServerSync() {
  console.log('[server] Starting server synchronously (optimal path)');

  await setupEnvWatcher();

  mainServer = await createServer();
  mainServer.listen(9321, '0.0.0.0', () => {
    console.log('Server running on http://0.0.0.0:9321');
  });

  proxyServer = createProxyServer();
  proxyServer.listen(5321, '0.0.0.0', () => {
    console.log('Proxy server running on http://0.0.0.0:5321');
  });
}

async function startServerAsync() {
  try {
    console.log('[server] Starting server asynchronously (compatibility mode for Node.js <20.19.0 + node-fetch v3)');

    await setupEnvWatcher();

    if (typeof global.loadNodeFetch === 'function') {
      console.log('[server] Pre-loading node-fetch v3...');
      await global.loadNodeFetch();
      console.log('[server] node-fetch v3 loaded successfully');
    }

    mainServer = await createServer();
    mainServer.listen(9321, '0.0.0.0', () => {
      console.log('Server running on http://0.0.0.0:9321 (compatibility mode)');
    });

    proxyServer = createProxyServer();
    proxyServer.listen(5321, '0.0.0.0', () => {
      console.log('Proxy server running on http://0.0.0.0:5321 (compatibility mode)');
    });

  } catch (error) {
    console.error('[server] Failed to start server:', error);
    process.exit(1);
  }
}

// --- 启动决策逻辑 ---
const needsAsync = await needsAsyncStartup();
if (needsAsync) {
  await startServerAsync();
} else {
  await startServerSync();
}