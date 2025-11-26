import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, httpPost } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";

// =====================
// 获取搜狐视频弹幕
// =====================
export default class SohuSource extends BaseSource {
  constructor() {
    super();
    this.danmuApiUrl = "https://api.danmu.tv.sohu.com/dmh5/dmListAll";
    this.searchApiUrl = "https://m.so.tv.sohu.com/search/pc/keyword";
    this.playlistApiUrl = "https://pl.hd.sohu.com/videolist";
    this.apiKey = "f351515304020cad28c92f70f002261c";
    this.episodesCache = new Map(); // 缓存分集列表
  }

  /**
   * 过滤搜狐视频搜索项
   * @param {Object} item - 搜索项
   * @param {string} keyword - 搜索关键词
   * @returns {Object|null} 过滤后的结果
   */
  filterSohuSearchItem(item, keyword) {
    // 只处理剧集类型 (data_type=257)
    if (item.data_type !== 257) {
      return null;
    }

    if (!item.aid || !item.album_name) {
      return null;
    }

    // 清理标题中的高亮标记
    let title = item.album_name.replace(/<<<|>>>/g, '');

    // 从meta中提取类型信息
    // meta格式: ["20集全", "电视剧 | 内地 | 2018年", "主演：..."]
    let categoryName = null;
    if (item.meta && item.meta.length >= 2) {
      const metaText = item.meta[1].txt; // "电视剧 | 内地 | 2018年"
      const parts = metaText.split('|');
      if (parts.length > 0) {
        categoryName = parts[0].trim(); // "电视剧"
      }
    }

    // 映射类型 - 与360/vod保持一致，使用中文类型
    let type = this.mapCategoryToType(categoryName);

    // 过滤掉不支持的类型
    if (!type) {
      return null;
    }

    // 缓存分集列表（如果搜索结果中包含）
    if (item.videos && item.videos.length > 0) {
      this.episodesCache.set(String(item.aid), item.videos);
      log("debug", `[Sohu] 缓存了 ${item.videos.length} 个分集 (aid=${item.aid})`);
    }

    return {
      provider: "sohu",
      mediaId: String(item.aid),
      title: title,
      type: type,
      year: item.year || 0,
      imageUrl: item.ver_big_pic || "",
      episodeCount: item.total_video_count || 0,
      videos: item.videos || [] // 保存原始视频列表供后续使用
    };
  }

  /**
   * 将搜狐视频的分类名称映射到标准类型
   * @param {string} categoryName - 分类名称
   * @returns {string|null} 标准类型
   */
  mapCategoryToType(categoryName) {
    if (!categoryName) {
      return null;
    }

    const categoryLower = categoryName.toLowerCase();

    // 类型白名单(与360/vod保持一致,使用中文类型)
    const typeMap = {
      '电影': '电影',
      '电视剧': '电视剧',
      '动漫': '动漫',
      '纪录片': '纪录片',
      '综艺': '综艺',
      '综艺节目': '综艺'
    };

    for (const [key, value] of Object.entries(typeMap)) {
      if (categoryLower.includes(key.toLowerCase()) || categoryName.includes(key)) {
        return value;
      }
    }

    // 其他类型不支持
    return null;
  }

  async search(keyword) {
    try {
      log("info", `[Sohu] 开始搜索: ${keyword}`);

      const params = new URLSearchParams({
        key: keyword,
        type: '1',
        page: '1',
        page_size: '20',
        user_id: '',
        tabsChosen: '0',
        poster: '4',
        tuple: '6',
        extSource: '1',
        show_star_detail: '3',
        pay: '1',
        hl: '3',
        uid: String(Date.now()),
        passport: '',
        plat: '-1',
        ssl: '0'
      });

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://so.tv.sohu.com/',
        'Origin': 'https://so.tv.sohu.com'
      };

      const response = await httpGet(`${this.searchApiUrl}?${params.toString()}`, { headers });

      if (!response || !response.data) {
        log("info", "[Sohu] 搜索响应为空");
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      if (!data.data || !data.data.items || data.data.items.length === 0) {
        log("info", `[Sohu] 搜索 '${keyword}' 未找到结果`);
        return [];
      }

      // 过滤和处理搜索结果
      const results = [];
      for (const item of data.data.items) {
        const filtered = this.filterSohuSearchItem(item, keyword);
        if (filtered) {
          results.push(filtered);
        }
      }

      log("info", `[Sohu] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[Sohu] 搜索出错:", error.message);
      return [];
    }
  }

  async getEpisodes(mediaId) {
    try {
      log("info", `[Sohu] 获取分集列表: aid=${mediaId}`);

      // 方案1：优先使用缓存的分集列表
      let videosData = this.episodesCache.get(mediaId);

      if (!videosData) {
        // 方案2：调用播放列表API作为后备
        log("info", `[Sohu] 缓存未命中，调用播放列表API (aid=${mediaId})`);

        const params = new URLSearchParams({
          playlistid: mediaId,
          api_key: this.apiKey
        });

        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://tv.sohu.com/'
        };

        const response = await httpGet(`${this.playlistApiUrl}?${params.toString()}`, { headers });

        if (!response || !response.data) {
          log("error", "[Sohu] 获取分集列表响应为空");
          return [];
        }

        // 解析JSONP响应
        let text = response.data;
        if (typeof text !== 'string') {
          text = JSON.stringify(text);
        }

        let data;
        if (text.startsWith('jsonp')) {
          // 提取括号内的JSON
          const start = text.indexOf('(') + 1;
          const end = text.lastIndexOf(')');
          if (start > 0 && end > start) {
            const jsonStr = text.substring(start, end);
            data = JSON.parse(jsonStr);
          } else {
            log("error", "[Sohu] 无法解析JSONP响应");
            return [];
          }
        } else {
          data = typeof text === 'string' ? JSON.parse(text) : text;
        }

        // 提取视频列表
        videosData = data.videos || [];
      }

      if (!videosData || videosData.length === 0) {
        log("warn", `[Sohu] 未找到分集列表 (aid=${mediaId})`);
        return [];
      }

      // 转换为标准格式
      const episodes = [];
      for (let i = 0; i < videosData.length; i++) {
        const video = videosData[i];
        const vid = String(video.vid);
        const title = video.video_name || video.name || `第${i + 1}集`;
        let url = video.url_html5 || video.pageUrl || '';

        // 转换为HTTPS
        if (url.startsWith('http://')) {
          url = url.replace('http://', 'https://');
        }

        // episodeId 格式: "vid:aid"
        episodes.push({
          vid: vid,
          title: title,
          episodeId: `${vid}:${mediaId}`,
          url: url
        });
      }

      log("info", `[Sohu] 成功获取 ${episodes.length} 个分集 (aid=${mediaId})`);
      return episodes;

    } catch (error) {
      log("error", "[Sohu] 获取分集列表出错:", error.message);
      return [];
    }
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Sohu] sourceAnimes is not a valid array");
      return [];
    }

    const processSohuAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);
          let links = [];

          // 先计算 numericAnimeId，用于生成分集ID
          const numericAnimeId = convertToAsciiSum(anime.mediaId);

          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            const epTitle = ep.title || `第${i + 1}集`;
            const fullUrl = ep.url || `https://tv.sohu.com/item/${anime.mediaId}.html`;

            // 🔥 关键修复：为每个分集生成唯一的数字 ID
            // 格式：animeId * 1000000 + 分集序号
            const episodeNumericId = numericAnimeId * 1000000 + (i + 1);

            links.push({
              "name": (i + 1).toString(),
              "url": fullUrl,
              "title": `【sohu】 ${epTitle}`,
              "id": episodeNumericId  // ✅ 使用纯数字 ID
            });
          }

          if (links.length > 0) {
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year})【${anime.type}】from sohu`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "sohu",
            };

            tmpAnimes.push(transformedAnime);

            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Sohu] Error processing anime: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return processSohuAnimes;
  }

  async getComments(url, platform) {
    log("info", "[Sohu] 开始从本地请求搜狐视频弹幕...", url);

    try {
      let vid, aid;

      // 🔥 修复：支持数字ID和URL两种格式
      if (url.includes('tv.sohu.com')) {
        // 情况1：传入的是完整 URL
        const pageResponse = await httpGet(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://tv.sohu.com/'
          }
        });

        if (!pageResponse || !pageResponse.data) {
          log("error", "[Sohu] 无法获取页面内容");
          return [];
        }

        const pageContent = typeof pageResponse.data === 'string' 
          ? pageResponse.data 
          : JSON.stringify(pageResponse.data);

        // 从页面中提取vid和aid
        const vidMatch = pageContent.match(/var\s+vid\s*=\s*["\']?(\d+)["\']?/);
        const aidMatch = pageContent.match(/var\s+playlistId\s*=\s*["\']?(\d+)["\']?/);

        if (!vidMatch || !aidMatch) {
          log("error", "[Sohu] 无法从页面中提取vid或aid");
          return [];
        }

        vid = vidMatch[1];
        aid = aidMatch[1];
      } else {
        // 情况2：传入的是数字 episodeId，需要从 globals.animes 中查找对应的 URL
        const episodeId = parseInt(url);
        let foundLink = null;

        for (const anime of globals.animes) {
          if (anime.links) {
            foundLink = anime.links.find(link => link.id === episodeId);
            if (foundLink) {
              log("info", `[Sohu] 找到 episodeId ${episodeId} 对应的URL: ${foundLink.url}`);
              // 递归调用，使用找到的 URL
              return await this.getComments(foundLink.url, platform);
            }
          }
        }

        if (!foundLink) {
          log("error", `[Sohu] 未找到 episodeId ${episodeId} 对应的URL`);
          return [];
        }
      }

      log("info", `[Sohu] 解析得到 vid=${vid}, aid=${aid}`);

      // 获取弹幕 - 优化：动态调整最大时长
      const maxTime = 7200; // 最大2小时
      const allComments = [];
      const segmentDuration = 60;
      let consecutiveEmptySegments = 0; // 连续空分段计数

      for (let start = 0; start < maxTime; start += segmentDuration) {
        const end = start + segmentDuration;
        const comments = await this.getDanmuSegment(vid, aid, start, end);

        if (comments && comments.length > 0) {
          allComments.push(...comments);
          consecutiveEmptySegments = 0; // 重置计数器
          
          // 只在第一个和每10分钟输出一次日志
          if (start === 0 || (start / 60) % 10 === 0) {
            log("info", `[Sohu] 已获取 ${start / 60 + 1} 分钟弹幕: 累计 ${allComments.length} 条`);
          }
        } else {
          consecutiveEmptySegments++;
          
          // 优化：连续3个空分段(3分钟)后提前终止
          if (consecutiveEmptySegments >= 3 && start >= 600) {
            log("info", `[Sohu] 连续3分钟无弹幕，提前终止 (已获取 ${start / 60} 分钟)`);
            break;
          }
        }

        // 减少延迟以提高速度（从100ms改为50ms）
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (allComments.length === 0) {
        log("info", "[Sohu] 该视频暂无弹幕数据");
        return [];
      }

      log("info", `[Sohu] 共获取 ${allComments.length} 条原始弹幕`);

      // 格式化弹幕
      const formattedComments = this.formatComments(allComments);

      printFirst200Chars(formattedComments);

      return formattedComments;

    } catch (error) {
      log("error", "[Sohu] 获取弹幕出错:", error.message);
      return [];
    }
  }

  async getDanmuSegment(vid, aid, start, end) {
    try {
      const params = new URLSearchParams({
        act: 'dmlist_v2',
        vid: vid,
        aid: aid,
        pct: '2',
        time_begin: String(start),
        time_end: String(end),
        dct: '1',
        request_from: 'h5_js'
      });

      const url = `${this.danmuApiUrl}?${params.toString()}`;

      const response = await httpGet(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://tv.sohu.com/'
        }
      });

      if (!response || !response.data) {
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;

      // 只在第一次调用时打印API响应（减少日志输出）
      if (start === 0) {
        log("debug", `[Sohu] API 响应结构: ${JSON.stringify(data).substring(0, 500)}...`);
      }

      const comments = data?.info?.comments || data?.comments || [];

      // 只在第一次调用时打印弹幕数据结构
      if (comments.length > 0 && start === 0) {
        log("debug", `[Sohu] 弹幕数据示例: ${JSON.stringify(comments[0])}`);
      }

      return comments;

    } catch (error) {
      log("error", `[Sohu] 获取弹幕段失败 (vid=${vid}, ${start}-${end}s):`, error.message);
      return [];
    }
  }

  /**
   * 解析弹幕颜色
   * @param {Object} item - 弹幕项
   * @returns {number} 十进制颜色值
   */
  parseColor(item) {
    try {
      // 搜狐弹幕可能的颜色字段：color, cl, c
      const colorStr = item.color || item.cl || item.c || '';
      
      if (!colorStr) {
        return 16777215; // 默认白色
      }

      // 如果是十六进制字符串（如 "#ffffff" 或 "ffffff"）
      if (typeof colorStr === 'string') {
        const hex = colorStr.replace('#', '');
        const decimal = parseInt(hex, 16);
        return isNaN(decimal) ? 16777215 : decimal;
      }

      // 如果已经是数字
      if (typeof colorStr === 'number') {
        return colorStr;
      }

      return 16777215; // 默认白色
    } catch (error) {
      log("debug", `[Sohu] 解析颜色失败: ${error.message}`);
      return 16777215;
    }
  }

  formatComments(comments) {
    if (!comments || !Array.isArray(comments)) {
      log("warn", "[Sohu] formatComments 接收到无效的 comments 参数");
      return [];
    }

    const formatted = [];
    let errorCount = 0;

    for (let i = 0; i < comments.length; i++) {
      try {
        const item = comments[i];

        // 打印第一条数据用于调试
        if (i === 0) {
          log("debug", `[Sohu] 弹幕原始数据示例: ${JSON.stringify(item)}`);
        }

        // 尝试所有可能的内容字段
        const content = item.c || item.m || item.content || item.text || item.msg || item.message || '';

        if (!content || content.trim() === '') {
          continue;
        }

        const color = this.parseColor(item);
        const vtime = parseFloat(item.v || item.time || 0);
        const timestamp = parseInt(item.created || item.timestamp || Date.now() / 1000);
        const uid = item.uid || item.user_id || '';
        const danmuId = item.i || item.id || '';

        formatted.push({
          timepoint: vtime,
          ct: 1,
          size: 25,
          color: color,
          unixtime: timestamp,
          uid: uid,
          content: content,
          cid: String(danmuId)
        });
      } catch (error) {
        errorCount++;
        // 只输出前3个错误，避免日志过多
        if (errorCount <= 3) {
          log("warn", `[Sohu] 格式化单条弹幕失败: ${error.message}`);
        }
      }
    }

    // 如果有大量错误，输出汇总信息
    if (errorCount > 3) {
      log("warn", `[Sohu] 共有 ${errorCount} 条弹幕格式化失败（仅显示前3条错误）`);
    }

    return formatted;
  }
}
