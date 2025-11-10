import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { simpleHash, serializeValue } from "./codec-util.js";
import { 
  initDatabase, 
  saveCacheBatch, 
  loadCacheBatch, 
  checkDatabaseConnection 
} from './db-util.js';

// =====================
// upstash redis 读写请求 （先简单实现，不加锁）
// =====================

// 使用 GET 发送简单命令（如 PING 检查连接）
export async function pingRedis() {
  const url = `${globals.redisUrl}/ping`;
  log("info", `[redis] 开始发送 PING 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`
      }
    });
    return await response.json(); // 预期: ["PONG"]
  } catch (error) {
    log("error", `[redis] 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 使用 GET 发送 GET 命令（读取键值）
export async function getRedisKey(key) {
  const url = `${globals.redisUrl}/get/${key}`;
  log("info", `[redis] 开始发送 GET 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`
      }
    });
    return await response.json(); // 预期: ["value"] 或 null
  } catch (error) {
    log("error", `[redis] 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);  // e.g., 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 使用 POST 发送 SET 命令，仅在值变化时更新
export async function setRedisKey(key, value, forceUpdate = false) {
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化（除非强制更新）
  if (!forceUpdate && globals.lastHashes[key] === currentHash) {
    log("info", `[redis] 键 ${key} 无变化，跳过 SET 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  const url = `${globals.redisUrl}/set/${key}`;
  log("info", `[redis] 开始发送 SET 请求: ${url} (强制更新: ${forceUpdate})`);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: serializedValue
    });
    const result = await response.json();
    globals.lastHashes[key] = currentHash; // 更新哈希值
    log("info", `[redis] 键 ${key} 更新成功`);
    return result; // 预期: {result: "OK"}
  } catch (error) {
    log("error", `[redis] SET 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);
      log("error", '- 原因:', error.cause.message);
    }
    return null;
  }
}

// 使用 POST 发送 SETEX 命令，仅在值变化时更新
export async function setRedisKeyWithExpiry(key, value, expirySeconds) {
  const serializedValue = serializeValue(key, value);
  const currentHash = simpleHash(serializedValue);

  // 检查值是否变化
  if (globals.lastHashes[key] === currentHash) {
    log("info", `[redis] 键 ${key} 无变化，跳过 SETEX 请求`);
    return { result: "OK" }; // 模拟成功响应
  }

  const url = `${globals.redisUrl}/set/${key}?EX=${expirySeconds}`;
  log("info", `[redis] 开始发送 SETEX 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: serializedValue
    });
    const result = await response.json();
    globals.lastHashes[key] = currentHash; // 更新哈希值
    log("info", `[redis] 键 ${key} 更新成功（带过期时间 ${expirySeconds}s）`);
    return result;
  } catch (error) {
    log("error", `[redis] SETEX 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 通用的 pipeline 请求函数
export async function runPipeline(commands) {
  const url = `${globals.redisUrl}/pipeline`;
  log("info", `[redis] 开始发送 PIPELINE 请求:`, url);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${globals.redisToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands) // commands 是一个数组，包含多个 Redis 命令
    });
    const result = await response.json();
    return result; // 返回结果数组，按命令顺序
  } catch (error) {
    log("error", `[redis] Pipeline 请求失败:`, error.message);
    log("error", '- 错误类型:', error.name);
    if (error.cause) {
      log("error", '- 码:', error.cause.code);
      log("error", '- 原因:', error.cause.message);
    }
  }
}

// 优化后的 getRedisCaches，支持从数据库或 Redis 加载
export async function getRedisCaches() {
  if (!globals.redisCacheInitialized) {
    try {
      log("info", 'getRedisCaches start.');

      // 优先尝试从数据库加载
      if (globals.databaseValid) {
        log("info", '[cache] 尝试从数据库加载缓存...');
        const cacheMap = await loadCacheBatch();

        if (Object.keys(cacheMap).length > 0) {
          globals.animes = cacheMap.animes || globals.animes;
          globals.episodeIds = cacheMap.episodeIds || globals.episodeIds;
          globals.episodeNum = cacheMap.episodeNum || globals.episodeNum;

          // 恢复 lastSelectMap
          if (cacheMap.lastSelectMap && typeof cacheMap.lastSelectMap === 'object') {
            globals.lastSelectMap = new Map(Object.entries(cacheMap.lastSelectMap));
            log("info", `[cache] 从数据库恢复 lastSelectMap,共 ${globals.lastSelectMap.size} 条`);
          }

          // 更新哈希值
          globals.lastHashes.animes = simpleHash(JSON.stringify(globals.animes));
          globals.lastHashes.episodeIds = simpleHash(JSON.stringify(globals.episodeIds));
          globals.lastHashes.episodeNum = simpleHash(JSON.stringify(globals.episodeNum));
          globals.lastHashes.lastSelectMap = simpleHash(JSON.stringify(Object.fromEntries(globals.lastSelectMap)));

          globals.redisCacheInitialized = true;
          log("info", '[cache] 从数据库加载缓存成功');
          return;
        }
      }

      // 如果数据库不可用或无数据，尝试 Redis
      if (globals.redisValid) {
        log("info", '[cache] 尝试从 Redis 加载缓存...');
        const keys = ['animes', 'episodeIds', 'episodeNum', 'lastSelectMap'];
        const commands = keys.map(key => ['GET', key]);
        const results = await runPipeline(commands);

        globals.animes = results[0].result ? JSON.parse(results[0].result) : globals.animes;
        globals.episodeIds = results[1].result ? JSON.parse(results[1].result) : globals.episodeIds;
        globals.episodeNum = results[2].result ? JSON.parse(results[2].result) : globals.episodeNum;

        const lastSelectMapData = results[3].result ? JSON.parse(results[3].result) : null;
        if (lastSelectMapData && typeof lastSelectMapData === 'object') {
          globals.lastSelectMap = new Map(Object.entries(lastSelectMapData));
          log("info", `[cache] 从 Redis 恢复 lastSelectMap,共 ${globals.lastSelectMap.size} 条`);
        }

        // 更新哈希值
        globals.lastHashes.animes = simpleHash(JSON.stringify(globals.animes));
        globals.lastHashes.episodeIds = simpleHash(JSON.stringify(globals.episodeIds));
        globals.lastHashes.episodeNum = simpleHash(JSON.stringify(globals.episodeNum));
        globals.lastHashes.lastSelectMap = simpleHash(JSON.stringify(Object.fromEntries(globals.lastSelectMap)));

        log("info", '[cache] 从 Redis 加载缓存成功');
      }

      globals.redisCacheInitialized = true;
      log("info", 'getRedisCaches completed successfully.');
    } catch (error) {
      log("error", `getRedisCaches failed: ${error.message}`, error.stack);
      globals.redisCacheInitialized = true;
    }
  }
}

// 优化后的 updateRedisCaches，支持更新到数据库和 Redis
export async function updateRedisCaches() {
  try {
    log("info", 'updateCaches start.');
    const variables = [
      { key: 'animes', value: globals.animes },
      { key: 'episodeIds', value: globals.episodeIds },
      { key: 'episodeNum', value: globals.episodeNum },
      { key: 'lastSelectMap', value: globals.lastSelectMap }
    ];

    const updates = [];
    const cacheMap = {};

    for (const { key, value } of variables) {
      const serializedValue = key === 'lastSelectMap' 
        ? JSON.stringify(Object.fromEntries(value)) 
        : JSON.stringify(value);
      const currentHash = simpleHash(serializedValue);

      if (currentHash !== globals.lastHashes[key]) {
        updates.push({ key, hash: currentHash });
        cacheMap[key] = key === 'lastSelectMap' ? Object.fromEntries(value) : value;
      }
    }

    if (updates.length === 0) {
      log("info", '[cache] 无变化,跳过更新');
      return;
    }

    log("info", `[cache] 检测到 ${updates.length} 个变化: ${updates.map(u => u.key).join(', ')}`);

    // 同时更新数据库和 Redis
    const dbSuccess = globals.databaseValid ? await saveCacheBatch(cacheMap) : false;
    const redisSuccess = globals.redisValid ? await updateRedis(variables, updates) : false;

    // 至少一个成功就更新哈希值
    if (dbSuccess || redisSuccess) {
      updates.forEach(({ key, hash }) => {
        globals.lastHashes[key] = hash;
      });
      log("info", `[cache] 更新成功 - 数据库: ${dbSuccess ? '成功' : '跳过'}, Redis: ${redisSuccess ? '成功' : '跳过'}`);
    } else {
      log("warn", '[cache] 所有存储方式均失败');
    }
  } catch (error) {
    log("error", `updateRedisCaches failed: ${error.message}`, error.stack);
  }
}

// Redis 更新辅助函数
async function updateRedis(variables, updates) {
  try {
    const commands = [];
    for (const { key, value } of variables) {
      const serializedValue = key === 'lastSelectMap' 
        ? JSON.stringify(Object.fromEntries(value)) 
        : JSON.stringify(value);
      const currentHash = simpleHash(serializedValue);

      if (updates.some(u => u.key === key)) {
        commands.push(['SET', key, serializedValue]);
      }
    }

    if (commands.length > 0) {
      const results = await runPipeline(commands);
      const failureCount = results.filter(r => !r || r.result !== 'OK').length;
      return failureCount === 0;
    }
    return false;
  } catch (error) {
    log("error", `[redis] 更新失败: ${error.message}`);
    return false;
  }
}

// 判断持久化存储是否可用（Redis 或数据库）
export async function judgeRedisValid(path) {
  if (path === "/favicon.ico" || path === "/robots.txt") {
    return;
  }

  log("info", "[storage] ========== 检查持久化存储状态 ==========");

  // 检查数据库
  if (!globals.databaseValid && globals.databaseUrl) {
    log("info", "[storage] 检测到数据库配置，开始检查数据库连接...");
    await checkDatabaseConnection();
    if (globals.databaseValid) {
      log("info", "[storage] 数据库连接成功，开始初始化数据库表...");
      await initDatabase();
    } else {
      log("warn", "[storage] 数据库连接失败");
    }
  } else if (!globals.databaseUrl) {
    log("info", "[storage] 未配置数据库");
  } else {
    log("info", `[storage] 数据库状态: ${globals.databaseValid ? '已连接' : '未连接'}`);
  }

  // 检查 Redis
  if (!globals.redisValid && globals.redisUrl && globals.redisToken) {
    log("info", "[storage] 检测到 Redis 配置，开始检查 Redis 连接...");
    const res = await pingRedis();
    if (res && res.result && res.result === "PONG") {
      globals.redisValid = true;
      log("info", "[storage] ✅ Redis 连接成功");
    } else {
      log("warn", "[storage] ❌ Redis 连接失败");
    }
  } else if (!globals.redisUrl || !globals.redisToken) {
    log("info", "[storage] 未配置 Redis");
  } else {
    log("info", `[storage] Redis 状态: ${globals.redisValid ? '已连接' : '未连接'}`);
  }

  log("info", `[storage] 持久化存储总结 - 数据库: ${globals.databaseValid ? '✅' : '❌'}, Redis: ${globals.redisValid ? '✅' : '❌'}`);
}