import { Envs } from './envs.js';

/**
 * 全局变量管理模块
 * 集中管理项目中的静态常量和运行时共享变量
 * ⚠️不是持久化存储，每次冷启动会丢失
 */
export const Globals = {
  // 缓存环境变量
  envs: {},
  accessedEnvVars: {},

  // 静态常量
  VERSION: '1.7.0',
  MAX_LOGS: 500, // 日志存储，最多保存 500 行
  MAX_ANIMES: 100,

  // 运行时状态
  animes: [],
  episodeIds: [],
  episodeNum: 10001, // 全局变量,用于自增 ID
  logBuffer: [],
  requestHistory: new Map(), // 记录每个 IP 地址的请求历史
  redisValid: false, // redis是否生效
  redisCacheInitialized: false, // redis 缓存是否已初始化
  lastSelectMap: new Map(), // 存储查询关键字上次选择的animeId，用于下次match自动匹配时优先选择该anime
  lastHashes: { // 存储上一次各变量哈希值
    animes: null,
    episodeIds: null,
    episodeNum: null,
    lastSelectMap: null
  },
  searchCache: new Map(), // 搜索结果缓存，存储格式：{ keyword: { results, timestamp } }
  commentCache: new Map(), // 弹幕缓存，存储格式：{ videoUrl: { comments, timestamp } }

  /**
   * 初始化全局变量，加载环境变量依赖
   * @param {Object} env 环境对象
   * @param {string} deployPlatform 部署平台
   * @returns {Object} 全局配置对象
   */
  init(env = {}, deployPlatform = 'node') {
    this.envs = Envs.load(env, deployPlatform);
    this.accessedEnvVars = Object.fromEntries(Envs.getAccessedEnvVars());
    return this.getConfig();
  },

  /**
   * 渲染环境变量状态的 HTML 页面
   * @returns {string} HTML 字符串
   */
  renderHtmlStatusPage() {
    const envs = this.accessedEnvVars;
    const version = this.VERSION;

    // CSS 样式
    const style = `
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f7f6; color: #333; }
  .container { max-width: 800px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
  header { background-color: #0052cc; color: white; padding: 20px 40px; border-top-left-radius: 8px; border-top-right-radius: 8px; }
  header h1 { margin: 0; font-size: 24px; }
  header span { float: right; font-size: 16px; color: #bde0ff; font-weight: normal; margin-top: 8px; }
  .content { padding: 30px 40px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #ddd; }
  th { background-color: #f8f8f8; font-size: 14px; text-transform: uppercase; color: #555; }
  td { font-size: 14px; word-break: break-all; }
  td:first-child { font-weight: 600; color: #004a99; width: 30%; }
  tr:hover { background-color: #f1f1f1; }
  footer { font-size: 12px; text-align: center; color: #999; padding: 20px 40px; border-top: 1px solid #f0f0f0; }
</style>
`;

    // HTML 头部
    let html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>服务状态 - 环境变量</title>
  ${style}
</head>
<body>
  <div class="container">
    <header>
      <h1>服务状态 <span>版本: ${version}</span></h1>
    </header>
    <div class="content">
      <h2>环境变量配置</h2>
      <table>
        <thead>
          <tr>
            <th>环境变量</th>
            <th>当前值</th>
          </tr>
        </thead>
        <tbody>
`;

    // HTML 表格内容
    // 确保按键排序
    const sortedKeys = Object.keys(envs).sort();
    for (const key of sortedKeys) {
      let value = envs[key];
      
      // 对数组和布尔值进行友好显示
      if (Array.isArray(value)) {
        value = value.length > 0 ? \`[\${value.join(', ')}]\` : '[]';
      } else if (typeof value === 'boolean') {
        value = value ? 'true' : 'false';
      } else if (value === null || value === undefined) {
        value = '<em>(未设置)</em>';
      } else {
        // 转义HTML，防止XSS
        value = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      
      html += \`
      <tr>
        <td>${key}</td>
        <td>${value}</td>
      </tr>
\`;
    }

    // HTML 尾部
    html += `
        </tbody>
      </table>
    </div>
    <footer>
      <p>环境变量已加载</p>
    </footer>
  </div>
</body>
</html>
`;
    return html;
  },

  /**
   * 获取全局配置快照
   * @returns {Object} 当前全局配置
   */
  /**
   * 获取全局配置对象（单例，可修改）
   * @returns {Object} 全局配置对象本身
   */
  getConfig() {
    // 使用 Proxy 保持接口兼容性
    const self = this;
    return new Proxy({}, {
      get(target, prop) {
        // 优先返回 envs 中的属性（保持原有的平铺效果）
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
};

/**
 * 全局配置代理对象
 * 自动转发所有属性访问到 Globals.getConfig()
 * 使用示例：
 *   import { globals } from './globals.js';
 *   console.log(globals.version);  // 直接访问，无需调用 getConfig()
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