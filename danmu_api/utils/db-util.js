import { Envs } from './envs.js';

// 动态导入函数(避免循环依赖)
async function importDbUtil() {
  return await import('../utils/db-util.js');
}

async function importRedisUtil() {
  return await import('../utils/redis-util.js');
}

/**
 * 全局变量管理模块
 * 集中管理项目中的静态常量和运行时共享变量
 * ⚠️不是持久化存储,每次冷启动会丢失
 */
const Globals = {
  // 环境变量相关
  envs: {},
  accessedEnvVars: {},

  // 持久化存储状态
  databaseValid: false,
  redisValid: false,
  redisCacheInitialized: false,
  configLoaded: false,
  storageChecked: false, // 🔥 新增:标记是否已检查存储连接

  // 静态常量
  VERSION: '1.7.4',
  MAX_LOGS: 500,
  MAX_ANIMES: 100,
  MAX_LAST_SELECT_MAP: 1000,

  // 运行时状态
  animes: [],
  episodeIds: [],
  episodeNum: 10001,
  logBuffer: [],
  requestHistory: new Map(),
  lastSelectMap: new Map(),
  lastHashes: {
    animes: null,
    episodeIds: null,
    episodeNum: null,
    lastSelectMap: null
  },
  searchCache: new Map(),
  commentCache: new Map(),

  /**
   * 初始化全局变量,加载环境变量依赖
   * @param {Object} env 环境对象
   * @param {string} deployPlatform 部署平台
   * @returns {Object} 全局配置对象
   */
  async init(env = {}, deployPlatform = 'node') {
    // 如果已经加载过,直接返回
    if (this.configLoaded) {
      console.log('[Globals] 配置已加载,跳过重复初始化');
      return this.getConfig();
    }

    console.log('[Globals] 开始初始化配置...');
    this.envs = Envs.load(env, deployPlatform);
    this.accessedEnvVars = Object.fromEntries(Envs.getAccessedEnvVars());

    // 尝试从数据库加载配置并覆盖
    await this.loadConfigFromStorage();

    // 标记配置已加载
    this.configLoaded = true;
    console.log('[Globals] 配置初始化完成');

    return this.getConfig();
  },

  /**
   * 从持久化存储加载配置
   */
  async loadConfigFromStorage() {
    try {
      // 首先检查数据库连接
      if (this.envs.databaseUrl) {
        try {
          const { checkDatabaseConnection, initDatabase, loadEnvConfigs } = await importDbUtil();

          const isConnected = await checkDatabaseConnection();
          if (isConnected) {
            await initDatabase();

            const dbConfig = await loadEnvConfigs();
            if (Object.keys(dbConfig).length > 0) {
              console.log(`[Globals] ✅ 从数据库加载了 ${Object.keys(dbConfig).length} 个配置`);

              // 应用数据库配置,覆盖默认值
              this.applyConfig(dbConfig);
              return;
            }
          }
        } catch (error) {
          console.error('[Globals] ❌ 数据库加载失败:', error.message);
        }
      }

      // 如果数据库不可用,尝试 Redis
      if (this.envs.redisUrl && this.envs.redisToken) {
        try {
          const { pingRedis, getRedisKey } = await importRedisUtil();

          const pingResult = await pingRedis();
          if (pingResult && pingResult.result === "PONG") {
            const result = await getRedisKey('env_configs');
            if (result && result.result) {
              try {
                const redisConfig = JSON.parse(result.result);
                console.log(`[Globals] ✅ 从 Redis 加载了 ${Object.keys(redisConfig).length} 个配置`);

                // 应用 Redis 配置
                this.applyConfig(redisConfig);
              } catch (e) {
                console.error('[Globals] ❌ 解析 Redis 配置失败:', e.message);
              }
            }
          }
        } catch (error) {
          console.error('[Globals] ❌ Redis 加载失败:', error.message);
        }
      }
    } catch (error) {
      console.error('[Globals] ❌ 加载存储配置失败:', error.message);
    }
  },

  /**
   * 应用配置到 envs 和 accessedEnvVars
   * @param {Object} config 配置对象
   */
  applyConfig(config) {
    const configCount = Object.keys(config).length;

    for (const [key, value] of Object.entries(config)) {
      // 跳过 null 和 undefined
      if (value === null || value === undefined) {
        continue;
      }

      // 直接赋值,保持原始类型
      this.envs[key] = value;
      this.accessedEnvVars[key] = value;
    }

    // 🔥 强制更新 Envs 模块的静态变量
    Envs.env = { ...this.envs };
    Envs.accessedEnvVars.clear();
    Object.entries(this.accessedEnvVars).forEach(([k, v]) => {
      Envs.accessedEnvVars.set(k, v);
    });

    // 特别处理需要重新解析的配置
    if ('VOD_SERVERS' in config) {
      this.envs.vodServers = this.parseVodServers(config.VOD_SERVERS);
    }

    if ('SOURCE_ORDER' in config) {
      this.envs.sourceOrderArr = this.parseSourceOrder(config.SOURCE_ORDER);
    }

    if ('PLATFORM_ORDER' in config) {
      this.envs.platformOrderArr = this.parsePlatformOrder(config.PLATFORM_ORDER);
    }

    if ('TOKEN' in config) {
      this.envs.token = config.TOKEN;
    }

    // 更新其他派生属性
    this.updateDerivedProperties(config);

    console.log(`[Globals] ✅ 配置应用完成 (${configCount} 项)`);
  },

  /**
   * 更新派生属性(基于配置变化)
   */
  updateDerivedProperties(config) {
    const changedKeys = Object.keys(config);

    // 更新搜索缓存时间
    if (changedKeys.includes('SEARCH_CACHE_MINUTES')) {
      const minutes = parseInt(config.SEARCH_CACHE_MINUTES);
      this.envs.searchCacheMinutes = isNaN(minutes) || minutes < 0 ? 5 : minutes;
    }

    // 更新评论缓存时间
    if (changedKeys.includes('COMMENT_CACHE_MINUTES')) {
      const minutes = parseInt(config.COMMENT_CACHE_MINUTES);
      this.envs.commentCacheMinutes = isNaN(minutes) || minutes < 0 ? 5 : minutes;
    }

    // WHITE_RATIO 处理
    if (changedKeys.includes('WHITE_RATIO')) {
      const ratio = parseFloat(config.WHITE_RATIO);
      if (!isNaN(ratio)) {
        this.envs.whiteRatio = ratio;
        this.envs.WHITE_RATIO = ratio;
      }
    }

    // BILIBILI_COOKIE 处理(兼容错误拼写)
    if (changedKeys.includes('BILIBILI_COOKIE')) {
      this.envs.bilibiliCookie = config.BILIBILI_COOKIE || '';
      this.envs.bilibliCookie = config.BILIBILI_COOKIE || '';
      this.envs.BILIBILI_COOKIE = config.BILIBILI_COOKIE || '';
    }

    // TMDB_API_KEY 处理
    if (changedKeys.includes('TMDB_API_KEY')) {
      this.envs.tmdbApiKey = config.TMDB_API_KEY || '';
      this.envs.TMDB_API_KEY = config.TMDB_API_KEY || '';
    }

    // BLOCKED_WORDS 处理
    if (changedKeys.includes('BLOCKED_WORDS')) {
      this.envs.blockedWords = config.BLOCKED_WORDS || '';
      this.envs.BLOCKED_WORDS = config.BLOCKED_WORDS || '';
      if
