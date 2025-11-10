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
    for (const [key, value] of Object.entries(config)) {
      const oldValue = this.envs[key];
      this.envs[key] = value;
      this.accessedEnvVars[key] = value;
      console.log(`[Globals] 应用配置: ${key} = ${value} (旧值: ${oldValue})`);
    }

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

    if ('TOKEN' in config) {
      this.envs.token = config.TOKEN;
      console.log(`[Globals] TOKEN 已更新`);
    }
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