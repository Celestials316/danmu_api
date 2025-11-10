import { Envs } from './envs.js';

// 动态导入函数（避免循环依赖）
async function importDbUtil() {
  return await import('../utils/db-util.js');
}

async function importRedisUtil() {
  return await import('../utils/redis-util.js');
}

/**
 * 全局变量管理模块
 * 集中管理项目中的静态常量和运行时共享变量
 * ⚠️不是持久化存储，每次冷启动会丢失
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

  // 静态常量
  VERSION: '1.7.3',
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
   * 初始化全局变量，加载环境变量依赖
   * @param {Object} env 环境对象
   * @param {string} deployPlatform 部署平台
   * @returns {Object} 全局配置对象
   */
  async init(env = {}, deployPlatform = 'node') {
    // 如果已经加载过，直接返回
    if (this.configLoaded) {
      console.log('[Globals] 配置已加载，跳过重复初始化');
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
    console.log('[Globals] 当前 TOKEN:', this.envs.TOKEN);

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
              console.log(`[Globals] 从数据库加载了 ${Object.keys(dbConfig).length} 个配置`);

              // 应用数据库配置，覆盖默认值
              this.applyConfig(dbConfig);
              return;
            }
          }
        } catch (error) {
          console.error('[Globals] 数据库加载失败:', error.message);
        }
      }

      // 如果数据库不可用，尝试 Redis
      if (this.envs.redisUrl && this.envs.redisToken) {
        try {
          const { pingRedis, getRedisKey } = await importRedisUtil();

          const pingResult = await pingRedis();
          if (pingResult && pingResult.result === "PONG") {
            const result = await getRedisKey('env_configs');
            if (result && result.result) {
              try {
                const redisConfig = JSON.parse(result.result);
                console.log(`[Globals] 从 Redis 加载了 ${Object.keys(redisConfig).length} 个配置`);

                // 应用 Redis 配置
                this.applyConfig(redisConfig);
              } catch (e) {
                console.error('[Globals] 解析 Redis 配置失败:', e.message);
              }
            }
          }
        } catch (error) {
          console.error('[Globals] Redis 加载失败:', error.message);
        }
      }
    } catch (error) {
      console.error('[Globals] 加载存储配置失败:', error.message);
    }
  },

  /**
   * 应用配置到 envs 和 accessedEnvVars
   * @param {Object} config 配置对象
   */
  applyConfig(config) {
    console.log(`[Globals] 开始应用配置，共 ${Object.keys(config).length} 个`);

    for (const [key, value] of Object.entries(config)) {
      // 🔥 确保值不是 undefined 或 null，转换为空字符串
      const safeValue = (value === null || value === undefined) ? '' : value;
      
      const oldValue = this.envs[key];
      const hasChanged = JSON.stringify(oldValue) !== JSON.stringify(safeValue);

      this.envs[key] = safeValue;
      this.accessedEnvVars[key] = safeValue;

      if (hasChanged) {
        const safeValueStr = String(safeValue);
        const oldValueStr = String(oldValue);
        console.log(`[Globals] 应用配置: ${key} = ${safeValueStr.substring(0, 50)} (旧值: ${oldValueStr.substring(0, 50)})`);
      } else {
        const safeValueStr = String(safeValue);
        console.log(`[Globals] 应用配置: ${key} = ${safeValueStr.substring(0, 50)} (值未变化，但仍刷新)`);
      }
    }

    // 🔥 强制更新 Envs 模块的静态变量
    Envs.env = { ...this.envs }; // 创建新对象引用，触发更新
    Envs.accessedEnvVars.clear(); // 清空旧记录
    Object.entries(this.accessedEnvVars).forEach(([k, v]) => {
      Envs.accessedEnvVars.set(k, v); // 重新同步
    });

    // 特别处理需要重新解析的配置
    if ('VOD_SERVERS' in config) {
      const vodServersConfig = config.VOD_SERVERS;
      this.envs.vodServers = this.parseVodServers(vodServersConfig);
      console.log(`[Globals] VOD 服务器列表已更新，共 ${this.envs.vodServers.length} 个`);
    }

    if ('SOURCE_ORDER' in config) {
      const sourceOrder = config.SOURCE_ORDER;
      this.envs.sourceOrderArr = this.parseSourceOrder(sourceOrder);
      console.log(`[Globals] 数据源顺序已更新: ${this.envs.sourceOrderArr.join(', ')}`);
    }

    if ('PLATFORM_ORDER' in config) {
      const platformOrder = config.PLATFORM_ORDER;
      this.envs.platformOrderArr = this.parsePlatformOrder(platformOrder);
      console.log(`[Globals] 平台顺序已更新: ${this.envs.platformOrderArr.join(', ')}`);
    }

    if ('TOKEN' in config) {
      this.envs.token = config.TOKEN;
      console.log(`[Globals] TOKEN 已更新`);
    }

    // 更新其他派生属性
    this.updateDerivedProperties(config);

    console.log(`[Globals] 配置应用完成`);
  },

  /**
   * 更新派生属性（基于配置变化）
   */
  updateDerivedProperties(config) {
    const changedKeys = Object.keys(config);

    // 更新搜索缓存时间
    if (changedKeys.includes('SEARCH_CACHE_MINUTES')) {
      const minutes = parseInt(config.SEARCH_CACHE_MINUTES) || 1;
      this.envs.searchCacheMinutes = minutes;
      console.log(`[Globals] 搜索缓存时间已更新: ${minutes} 分钟`);
    }

    // 更新评论缓存时间
    if (changedKeys.includes('COMMENT_CACHE_MINUTES')) {
      const minutes = parseInt(config.COMMENT_CACHE_MINUTES) || 1;
      this.envs.commentCacheMinutes = minutes;
      console.log(`[Globals] 评论缓存时间已更新: ${minutes} 分钟`);
    }

    // 🔥 添加 WHITE_RATIO 处理
    if (changedKeys.includes('WHITE_RATIO')) {
      const ratio = parseFloat(config.WHITE_RATIO);
      if (!isNaN(ratio)) {
        this.envs.whiteRatio = ratio;
        this.envs.WHITE_RATIO = ratio;
        console.log(`[Globals] WHITE_RATIO 已更新: ${ratio}`);
      } else {
        console.warn(`[Globals] WHITE_RATIO 值无效 (${config.WHITE_RATIO})，保持原值`);
      }
    }

    // 🔥 添加 BILIBILI_COOKIE 处理（兼容错误拼写）
    if (changedKeys.includes('BILIBILI_COOKIE')) {
      this.envs.bilibiliCookie = config.BILIBILI_COOKIE || '';
      this.envs.bilibliCookie = config.BILIBILI_COOKIE || '';  // ← 兼容错误拼写
      this.envs.BILIBILI_COOKIE = config.BILIBILI_COOKIE || '';
      console.log(`[Globals] BILIBILI_COOKIE 已更新: ${config.BILIBILI_COOKIE ? '已设置' : '已清空'}`);
    }

    // 🔥 添加 TMDB_API_KEY 处理
    if (changedKeys.includes('TMDB_API_KEY')) {
      this.envs.tmdbApiKey = config.TMDB_API_KEY || '';
      this.envs.TMDB_API_KEY = config.TMDB_API_KEY || '';
      console.log(`[Globals] TMDB_API_KEY 已更新: ${config.TMDB_API_KEY ? '已设置' : '已清空'}`);
    }

    // 🔥 添加 BLOCKED_WORDS 处理
    if (changedKeys.includes('BLOCKED_WORDS')) {
      this.envs.blockedWords = config.BLOCKED_WORDS || '';
      this.envs.BLOCKED_WORDS = config.BLOCKED_WORDS || '';
      // 解析为数组
      if (config.BLOCKED_WORDS) {
        this.envs.blockedWordsArr = config.BLOCKED_WORDS
          .split(',')
          .map(w => w.trim())
          .filter(w => w.length > 0);
      } else {
        this.envs.blockedWordsArr = [];
      }
      console.log(`[Globals] BLOCKED_WORDS 已更新: ${this.envs.blockedWordsArr.length} 个屏蔽词`);
    }

    // 🔥 添加 GROUP_MINUTE 处理
    if (changedKeys.includes('GROUP_MINUTE')) {
      const minutes = parseInt(config.GROUP_MINUTE) || 1;
      this.envs.groupMinute = minutes;
      this.envs.GROUP_MINUTE = minutes;
      console.log(`[Globals] GROUP_MINUTE 已更新: ${minutes} 分钟`);
    }

    // 🔥 添加 CONVERT_TOP_BOTTOM_TO_SCROLL 处理
    if (changedKeys.includes('CONVERT_TOP_BOTTOM_TO_SCROLL')) {
      const enabled = String(config.CONVERT_TOP_BOTTOM_TO_SCROLL).toLowerCase() === 'true';
      this.envs.convertTopBottomToScroll = enabled;
      this.envs.CONVERT_TOP_BOTTOM_TO_SCROLL = enabled;
      console.log(`[Globals] CONVERT_TOP_BOTTOM_TO_SCROLL 已更新: ${enabled}`);
    }

    // 更新弹幕限制
    if (changedKeys.includes('DANMU_LIMIT')) {
      const limit = parseInt(config.DANMU_LIMIT) || -1;
      this.envs.danmuLimit = limit;
      console.log(`[Globals] 弹幕限制已更新: ${limit}`);
    }

    // 更新限流配置
    if (changedKeys.includes('RATE_LIMIT_MAX_REQUESTS')) {
      const maxRequests = parseInt(config.RATE_LIMIT_MAX_REQUESTS) || 0;
      this.envs.rateLimitMaxRequests = maxRequests;
      console.log(`[Globals] 限流配置已更新: ${maxRequests} 次/分钟`);
    }

    // 更新 VOD 返回模式
    if (changedKeys.includes('VOD_RETURN_MODE')) {
      this.envs.vodReturnMode = config.VOD_RETURN_MODE;
      console.log(`[Globals] VOD 返回模式已更新: ${config.VOD_RETURN_MODE}`);
    }

    // 更新 VOD 请求超时
    if (changedKeys.includes('VOD_REQUEST_TIMEOUT')) {
      const timeout = parseInt(config.VOD_REQUEST_TIMEOUT) || 10000;
      this.envs.vodRequestTimeout = timeout;
      console.log(`[Globals] VOD 请求超时已更新: ${timeout} 毫秒`);
    }

    // 更新弹幕输出格式
    if (changedKeys.includes('DANMU_OUTPUT_FORMAT')) {
      this.envs.danmuOutputFormat = config.DANMU_OUTPUT_FORMAT || 'json';
      console.log(`[Globals] 弹幕输出格式已更新: ${this.envs.danmuOutputFormat}`);
    }

    // 更新繁简转换设置
    if (changedKeys.includes('DANMU_SIMPLIFIED')) {
      this.envs.danmuSimplified = String(config.DANMU_SIMPLIFIED).toLowerCase() === 'true';
      console.log(`[Globals] 繁简转换已更新: ${this.envs.danmuSimplified}`);
    }

    // 更新记住选择设置
    if (changedKeys.includes('REMEMBER_LAST_SELECT')) {
      this.envs.rememberLastSelect = String(config.REMEMBER_LAST_SELECT).toLowerCase() === 'true';
      console.log(`[Globals] 记住选择已更新: ${this.envs.rememberLastSelect}`);
    }

    // 更新严格匹配设置
    if (changedKeys.includes('STRICT_TITLE_MATCH')) {
      this.envs.strictTitleMatch = String(config.STRICT_TITLE_MATCH).toLowerCase() === 'true';
      console.log(`[Globals] 严格匹配已更新: ${this.envs.strictTitleMatch}`);
    }

    // 更新优酷并发数
    if (changedKeys.includes('YOUKU_CONCURRENCY')) {
      const concurrency = parseInt(config.YOUKU_CONCURRENCY) || 8;
      this.envs.youkuConcurrency = Math.min(concurrency, 16);
      console.log(`[Globals] 优酷并发数已更新: ${this.envs.youkuConcurrency}`);
    }

    // 更新日志级别
    if (changedKeys.includes('LOG_LEVEL')) {
      this.envs.logLevel = config.LOG_LEVEL || 'info';
      console.log(`[Globals] 日志级别已更新: ${this.envs.logLevel}`);
    }

    // 🔥 添加 TITLE_TO_CHINESE 处理
    if (changedKeys.includes('TITLE_TO_CHINESE')) {
      const enabled = String(config.TITLE_TO_CHINESE).toLowerCase() === 'true';
      this.envs.titleToChinese = enabled;
      this.envs.TITLE_TO_CHINESE = enabled;
      console.log(`[Globals] TITLE_TO_CHINESE 已更新: ${enabled}`);
    }

    // 🔥 添加 EPISODE_TITLE_FILTER 处理
    if (changedKeys.includes('EPISODE_TITLE_FILTER')) {
      this.envs.episodeTitleFilter = config.EPISODE_TITLE_FILTER || '';
      this.envs.EPISODE_TITLE_FILTER = config.EPISODE_TITLE_FILTER || '';
      console.log(`[Globals] EPISODE_TITLE_FILTER 已更新`);
    }

    // 🔥 添加 ENABLE_EPISODE_FILTER 处理
    if (changedKeys.includes('ENABLE_EPISODE_FILTER')) {
      const enabled = String(config.ENABLE_EPISODE_FILTER).toLowerCase() === 'true';
      this.envs.enableEpisodeFilter = enabled;
      this.envs.ENABLE_EPISODE_FILTER = enabled;
      console.log(`[Globals] ENABLE_EPISODE_FILTER 已更新: ${enabled}`);
    }
  },

  /**
   * 解析平台顺序
   */
  parsePlatformOrder(platformOrder) {
    if (!platformOrder || platformOrder.trim() === '') {
      return [];
    }

    return platformOrder
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  },

  /**
   * 解析 VOD 服务器配置
   */
  parseVodServers(vodServersConfig) {
    if (!vodServersConfig || vodServersConfig.trim() === '') {
      return [];
    }

    return vodServersConfig
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
  },

  /**
   * 解析数据源顺序
   */
  parseSourceOrder(sourceOrder) {
    const ALLOWED_SOURCES = ['360', 'vod', 'tmdb', 'douban', 'tencent', 'youku', 'iqiyi', 'imgo', 'bilibili', 'renren', 'hanjutv', 'bahamut'];
    const orderArr = sourceOrder
      .split(',')
      .map(s => s.trim())
      .filter(s => ALLOWED_SOURCES.includes(s));

    return orderArr.length > 0 ? orderArr : ['360', 'vod', 'renren', 'hanjutv'];
  },

  /**
   * 获取全局配置对象（单例，可修改）
   * @returns {Object} 全局配置对象本身
   */
  getConfig() {
    const self = this;
    return new Proxy({}, {
      get(target, prop) {
        // 优先返回 envs 中的属性
        if (prop in self.envs) {
          return self.envs[prop];
        }
        // 映射大写常量到小写
        if (prop === 'version') return self.VERSION;
        if (prop === 'maxLogs') return self.MAX_LOGS;
        if (prop === 'maxAnimes') return self.MAX_ANIMES;
        if (prop === 'maxLastSelectMap') return self.MAX_LAST_SELECT_MAP;

        // 其他属性直接返回
        return self[prop];
      },
      set(target, prop, value) {
        // 写操作同步到 Globals
        if (prop in self.envs) {
          self.envs[prop] = value;
        } else {
          self[prop] = value;
        }
        return true;
      }
    });
  },

  /**
   * 获取 Globals 实例（用于直接访问内部状态）
   */
  getInstance() {
    return this;
  }
};

/**
 * 全局配置代理对象
 * 自动转发所有属性访问到 Globals.getConfig()
 */
export const globals = new Proxy({}, {
  get(target, prop) {
    return Globals.getConfig()[prop];
  },
  set(target, prop, value) {
    Globals.getConfig()[prop] = value;
    return true;
  },
  has(target, prop) {
    return prop in Globals.getConfig();
  },
  ownKeys(target) {
    return Reflect.ownKeys(Globals.getConfig());
  },
  getOwnPropertyDescriptor(target, prop) {
    return Object.getOwnPropertyDescriptor(Globals.getConfig(), prop);
  }
});

// 导出 Globals 对象（用于初始化）
export { Globals };