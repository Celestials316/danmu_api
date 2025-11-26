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
      log("info", `[Sohu] 缓存了 ${item.videos.length} 个分集 (aid=${item.aid})`);
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

          for (let i = 0; i < eps.length; i++) {
            const ep = eps[i];
            const epTitle = ep.title || `第${i + 1}集`;
            // 构建完整URL
            const fullUrl = ep.url || `https://tv.sohu.com/item/${anime.mediaId}.html`;
            links.push({
              "name": (i + 1).toString(),
              "url": fullUrl,
              "title": `【sohu】 ${epTitle}`,
              "id": ep.episodeId
            });
          }

          if (links.length > 0) {
            // 将字符串mediaId转换为数字ID (使用哈希函数)
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
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
      // 解析 episodeId (格式: "vid:aid")
      let vid, aid;
      
      // 如果传入的是episodeId格式
      if (url.includes(':')) {
        [vid, aid] = url.split(':');
      } else {
        // 从URL中提取vid和aid
        // 先尝试从URL获取页面内容
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

        const pageContent = typeof pageResponse.data === 'string' ? pageResponse.data : JSON.stringify(pageResponse.data);
        
        // 从页面中提取vid和aid
        const vidMatch = pageContent.match(/var\s+vid\s*=\s*["\']?(\d+)["\']?/);
        const aidMatch = pageContent.match(/var\s+playlistId\s*=\s*["\']?(\d+)["\']?/);
        
        if (!vidMatch || !aidMatch) {
          log("error", "[Sohu] 无法从页面中提取vid或aid");
          return [];
        }

        vid = vidMatch[1];
        aid = aidMatch[1];
      }

      log("info", `[Sohu] 解析得到 vid=${vid}, aid=${aid}`);

      // 获取弹幕 - 默认最大7200秒（2小时）
      const maxTime = 7200;
      const allComments = [];
      const segmentDuration = 60;

      for (let start = 0; start < maxTime; start += segmentDuration) {
        const end = start + segmentDuration;
        const comments = await this.getDanmuSegment(vid, aid, start, end);

        if (comments && comments.length > 0) {
          allComments.push(...comments);
          log("info", `[Sohu] 获取第 ${start / 60 + 1} 分钟: ${comments.length} 条弹幕`);
        } else if (start > 600) {
          // 10分钟后无数据可能到末尾
          break;
        }

        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 100));
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

      const response = await httpGet(`${this.danmuApiUrl}?${params.toString()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://tv.sohu.com/'
        }
      });

      if (!response || !response.data) {
        return [];
      }

      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
      const comments = data?.info?.comments || [];

      return comments;

    } catch (error) {
      log("error", `[Sohu] 获取弹幕段失败 (vid=${vid}, ${start}-${end}s):`, error.message);
      return [];
    }
  }

  parseColor(comment) {
    try {
      const color = comment?.t?.c || '16777215';
      if (typeof color === 'string' && color.startsWith('#')) {
        return parseInt(color.substring(1), 16);
      }
      return parseInt(String(color), 16) || 16777215;
    } catch {
      return 16777215;
    }
  }

  formatComments(comments) {
    return comments.map(item => {
      try {
        // 解析颜色
        const color = this.parseColor(item);

        // 时间（秒）
        const vtime = parseFloat(item.v || 0);

        // 时间戳
        const timestamp = parseInt(item.created || Date.now() / 1000);

        // 用户ID和弹幕ID
        const uid = item.uid || '';
        const danmuId = item.i || '';

        // 弹幕内容
        const content = item.c || '';

        return {
          timepoint: vtime,
          ct: 1, // 滚动弹幕
          size: 25,
          color: color,
          unixtime: timestamp,
          uid: uid,
          content: content,
          cid: String(danmuId)
        };
      } catch (error) {
        log("warn", `[Sohu] 格式化弹幕失败: ${error.message}`);
        return null;
      }
    }).filter(item => item !== null);
  }
}