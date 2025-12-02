import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { buildQueryString, httpGet, httpPost } from "../utils/http-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { md5, convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";

// =====================
// 获取优酷弹幕 (优化稳定版)
// =====================
export default class YoukuSource extends BaseSource {

  // --- 内部辅助方法 ---

  /**
   * 安全解析 JSON，防止非 JSON 响应导致崩溃
   */
  _safeJSONParse(data) {
    if (!data) return null;
    if (typeof data === "object") return data; // 已经是对象
    try {
      return JSON.parse(data);
    } catch (e) {
      log("warn", `[Youku] JSON解析失败, 数据片段: ${typeof data === 'string' ? data.slice(0, 50) : 'unknown'}`);
      return null;
    }
  }

  /**
   * 异步休眠
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // --- 核心业务逻辑 ---

  convertYoukuUrl(url) {
    // 增强正则：同时支持 vid=xxx 和 id_xxx
    const vidMatch = url.match(/vid=([^&]+)/) || url.match(/id_([a-zA-Z0-9=]+)/);
    if (!vidMatch || !vidMatch[1]) {
      return null;
    }
    return `https://v.youku.com/v_show/id_${vidMatch[1]}.html`;
  }

  /**
   * 过滤优酷搜索项
   */
  filterYoukuSearchItem(component, keyword) {
    const commonData = component.commonData;
    if (!commonData || !commonData.titleDTO) return null;

    // 过滤非优酷内容
    if (commonData.isYouku !== 1 && commonData.hasYouku !== 1) return null;

    const title = commonData.titleDTO.displayName;

    // 过滤黑名单关键词
    const skipKeywords = ["中配版", "抢先看", "非正片", "解读", "揭秘", "赏析", "《"];
    if (skipKeywords.some(kw => title.includes(kw))) return null;

    // 提取年份
    const yearMatch = commonData.feature.match(/[12][890][0-9][0-9]/);
    const year = yearMatch ? parseInt(yearMatch[0]) : null;

    // 清理标题
    let cleanedTitle = title.replace(/<[^>]+>/g, '').replace(/【.+?】/g, '').trim().replace(/:/g, '：');

    // 提取媒体类型
    const mediaType = this._extractMediaType(commonData.cats, commonData.feature);

    return {
      provider: "youku",
      mediaId: commonData.showId,
      title: cleanedTitle,
      type: mediaType,
      year: year,
      imageUrl: commonData.posterDTO ? commonData.posterDTO.vThumbUrl : null,
      episodeCount: commonData.episodeTotal,
      cats: commonData.cats
    };
  }

  async search(keyword) {
    try {
      log("info", `[Youku] 开始搜索: ${keyword}`);

      const encodedKeyword = encodeURIComponent(keyword);
      const encodedUA = encodeURIComponent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36");
      const searchUrl = `https://search.youku.com/api/search?keyword=${encodedKeyword}&userAgent=${encodedUA}&site=1&categories=0&ftype=0&ob=0&pg=1`;

      const response = await httpGet(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.youku.com/'
        }
      });

      if (!response || !response.data) return [];

      const data = this._safeJSONParse(response.data);
      if (!data || !data.pageComponentList) {
        log("info", "[Youku] 搜索无结果");
        return [];
      }

      const results = [];
      for (const component of data.pageComponentList) {
        const filtered = this.filterYoukuSearchItem(component, keyword);
        if (filtered) {
          results.push(filtered);
        }
      }

      log("info", `[Youku] 搜索找到 ${results.length} 个有效结果`);
      return results;

    } catch (error) {
      log("error", "[Youku] 搜索出错:", error.message);
      return [];
    }
  }

  async getEpisodes(id) {
    try {
      log("info", `[Youku] 获取分集列表: show_id=${id}`);

      const pageSize = 100;
      const firstPage = await this._getEpisodesPage(id, 1, pageSize);

      if (!firstPage || !firstPage.videos || firstPage.videos.length === 0) {
        return [];
      }

      let allEpisodes = [...firstPage.videos];
      const totalCount = firstPage.total;

      if (totalCount > pageSize) {
        const totalPages = Math.ceil(totalCount / pageSize);
        log("info", `[Youku] 检测到 ${totalCount} 个分集，并发请求剩余 ${totalPages - 1} 页`);

        const pagePromises = [];
        for (let page = 2; page <= totalPages; page++) {
          pagePromises.push(this._getEpisodesPage(id, page, pageSize));
        }

        const results = await Promise.allSettled(pagePromises);
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value && result.value.videos) {
            allEpisodes.push(...result.value.videos);
          }
        }
      }

      log("info", `[Youku] 共获取 ${allEpisodes.length} 集`);
      return allEpisodes;

    } catch (error) {
      log("error", "[Youku] 获取分集出错:", error.message);
      return [];
    }
  }

  async _getEpisodesPage(showId, page, pageSize) {
    const url = `https://openapi.youku.com/v2/shows/videos.json?client_id=53e6cc67237fc59a&package=com.huawei.hwvplayer.youku&ext=show&show_id=${showId}&page=${page}&count=${pageSize}`;

    const response = await httpGet(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response || !response.data) return null;
    return this._safeJSONParse(response.data);
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Youku] sourceAnimes 参数无效");
      return [];
    }

    const processYoukuAnimes = await Promise.all(sourceAnimes
      .filter(s => titleMatches(s.title, queryTitle))
      .map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.mediaId);
          if (!eps || eps.length === 0) return;

          const mediaType = this._extractMediaType(anime.cats, anime.type);
          const formattedEps = this._processAndFormatEpisodes(eps, mediaType);

          let links = [];
          for (const ep of formattedEps) {
            // 确保 url 完整
            const fullUrl = ep.link || `https://v.youku.com/v_show/id_${ep.vid}.html`;
            links.push({
              "name": ep.episodeIndex.toString(),
              "url": fullUrl,
              "title": `【youku】 ${ep.title}`
            });
          }

          if (links.length > 0) {
            const numericAnimeId = convertToAsciiSum(anime.mediaId);
            let transformedAnime = {
              animeId: numericAnimeId,
              bangumiId: anime.mediaId,
              animeTitle: `${anime.title}(${anime.year || 'N/A'})【${anime.type}】from youku`,
              type: anime.type,
              typeDescription: anime.type,
              imageUrl: anime.imageUrl,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "youku",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Youku] 处理 Anime 异常: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return processYoukuAnimes;
  }

  _processAndFormatEpisodes(rawEpisodes, mediaType = 'variety') {
    let filteredEpisodes = [...rawEpisodes];

    return filteredEpisodes.map((ep, index) => {
      const episodeIndex = index + 1;
      const title = this._formatEpisodeTitle(ep, episodeIndex, mediaType);
      
      // 清理 ID 中的特殊字符
      let safeId = ep.id;
      if (safeId && safeId.includes("=")) {
          safeId = safeId.replace("=", "_");
      }

      return {
        vid: ep.id,
        title: title,
        episodeIndex: episodeIndex,
        link: ep.link
      };
    });
  }

  _formatEpisodeTitle(ep, episodeIndex, mediaType) {
    let cleanDisplayName = ep.displayName || ep.title;
    if (!cleanDisplayName) return `第${episodeIndex}集`;

    const datePattern = /^(?:\d{2,4}-\d{2}-\d{2}|\d{2}-\d{2})\s*(?=(?:第\d+期))|^(?:\d{2,4}-\d{2}-\d{2}|\d{2}-\d{2})\s*:\s*/;
    cleanDisplayName = cleanDisplayName.replace(datePattern, '').trim();

    if (mediaType === 'movie') return cleanDisplayName;

    if (mediaType === 'variety') {
      const periodMatch = cleanDisplayName.match(/第(\d+)期/);
      const dateSuffix = ep.published ? ` ${ep.published.split(' ')[0]}` : '';
      if (periodMatch) {
        return `第${periodMatch[1]}期${dateSuffix} ${cleanDisplayName}`;
      } else {
        return `第${episodeIndex}期${dateSuffix} ${cleanDisplayName}`;
      }
    }

    if (/^第\d+集/.test(cleanDisplayName)) return cleanDisplayName;
    return `第${episodeIndex}集 ${cleanDisplayName}`;
  }

  _extractMediaType(cats, feature) {
    const catsLower = (cats || '').toLowerCase();
    const featureLower = (feature || '').toLowerCase();
    const checkStr = catsLower + " " + featureLower;

    if (checkStr.includes('综艺') || checkStr.includes('variety')) return 'variety';
    if (checkStr.includes('电影') || checkStr.includes('movie')) return 'movie';
    if (checkStr.includes('动漫') || checkStr.includes('anime')) return 'anime';
    if (checkStr.includes('电视剧') || checkStr.includes('drama')) return 'drama';

    return 'drama';
  }

  async getEpisodeDanmu(id) {
    log("info", "开始请求优酷弹幕:", id);
    if (!id) return [];

    // 1. URL/ID 处理
    if (id.includes("youku.com/video?vid")) {
        id = this.convertYoukuUrl(id);
    }
    
    // 从 URL 或纯 ID 中提取 video_id
    let video_id = null;
    const idRegex = /(?:id_|vid=)([a-zA-Z0-9=]+)/;
    const idMatch = id.match(idRegex);
    
    if (idMatch) {
        video_id = idMatch[1];
    } else {
        // 兼容 /v_show/id_XXXX.html 格式分割
        const parts = id.split('/');
        for (let part of parts) {
            if (part.includes('.html')) {
                const raw = part.split('.')[0];
                if (raw.startsWith('id_')) video_id = raw.slice(3);
                break;
            }
        }
    }
    
    if (!video_id) {
        log("error", `[Youku] 无效的 URL 或 ID: ${id}`);
        return [];
    }
    log("info", `[Youku] 解析到 video_id: ${video_id}`);

    // 2. 获取视频时长
    const api_video_info = "https://openapi.youku.com/v2/videos/show.json";
    let duration = 0;

    try {
        const videoInfoUrl = `${api_video_info}?client_id=53e6cc67237fc59a&video_id=${video_id}&package=com.huawei.hwvplayer.youku&ext=show`;
        const res = await httpGet(videoInfoUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            },
            allow_redirects: false
        });
        const data = this._safeJSONParse(res.data);
        if (data) {
            log("info", `[Youku] 视频标题: ${data.title}, 时长: ${data.duration}`);
            duration = parseInt(data.duration || 0);
        }
    } catch (e) {
        log("error", "[Youku] 获取视频信息失败:", e.message);
        return [];
    }
    
    if (duration <= 0) return [];

    // 3. 获取 CNA 和 Token
    let cna = "", _m_h5_tk = "", _m_h5_tk_enc = "";
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Referer": "https://v.youku.com"
    };

    try {
        // 获取 CNA
        const cnaRes = await httpGet("https://log.mmstat.com/eg.js", { headers, allow_redirects: false });
        if (cnaRes && cnaRes.headers) {
            const etag = cnaRes.headers["etag"] || cnaRes.headers["Etag"];
            if (etag) cna = etag.replace(/^"|"$/g, '');
        }
        
        // 获取 Token (带重试机制)
        const tkEncUrl = "https://acs.youku.com/h5/mtop.com.youku.aplatform.weakget/1.0/?jsv=2.5.1&appKey=24679788";
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                const tkRes = await httpGet(tkEncUrl, { headers, allow_redirects: false });
                if (tkRes && tkRes.headers) {
                    const setCookie = tkRes.headers["set-cookie"] || tkRes.headers["Set-Cookie"];
                    if (setCookie) {
                        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
                        const cookieStr = cookies.join(';');
                        
                        const tkMatch = cookieStr.match(/_m_h5_tk=([^;]+)/);
                        const encMatch = cookieStr.match(/_m_h5_tk_enc=([^;]+)/);
                        
                        if (tkMatch) _m_h5_tk = tkMatch[1];
                        if (encMatch) _m_h5_tk_enc = encMatch[1];
                        
                        if (_m_h5_tk) break; 
                    }
                }
            } catch (e) {
                log("warn", `[Youku] Token 获取重试 (${retryCount + 1}/${maxRetries}): ${e.message}`);
            }
            if (!_m_h5_tk) {
                retryCount++;
                await this._sleep(500);
            } else {
                break;
            }
        }

        if (!_m_h5_tk) {
            log("error", "[Youku] 无法获取 _m_h5_tk，终止。");
            return [];
        }

    } catch (e) {
        log("error", "[Youku] Token 初始化异常:", e.message);
        return [];
    }

    // 4. 定义加密函数 (保持在方法内)
    const utf8ToLatin1 = (str) => {
        let result = '';
        for (let i = 0; i < str.length; i++) {
          const charCode = str.charCodeAt(i);
          result += (charCode > 255) ? encodeURIComponent(str[i]) : str[i];
        }
        return result;
    };

    const base64Encode = (input) => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let output = '';
        let buffer = 0, bufferLength = 0;
        for (let i = 0; i < input.length; i++) {
          buffer = (buffer << 8) | input.charCodeAt(i);
          bufferLength += 8;
          while (bufferLength >= 6) {
            output += chars[(buffer >> (bufferLength - 6)) & 0x3F];
            bufferLength -= 6;
          }
        }
        if (bufferLength > 0) output += chars[(buffer << (6 - bufferLength)) & 0x3F];
        while (output.length % 4 !== 0) output += '=';
        return output;
    };

    // 5. 单个分段请求函数
    const requestOneMat = async (mat) => {
        const msg = {
            ctime: Date.now(),
            ctype: 10004,
            cver: "v1.0",
            guid: cna,
            mat: mat,
            mcount: 1,
            pid: 0,
            sver: "3.1.0",
            type: 1,
            vid: video_id,
        };

        const msg_b64encode = base64Encode(utf8ToLatin1(JSON.stringify(msg)));
        msg.msg = msg_b64encode;
        msg.sign = md5(`${msg_b64encode}MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr`).toString().toLowerCase();

        const dataPayload = JSON.stringify(msg);
        const t = Date.now();
        const appKey = "24679788";
        const tokenPart = _m_h5_tk.substring(0, 32);
        const signSource = [tokenPart, t, appKey, dataPayload].join("&");
        
        const params = {
            jsv: "2.5.6",
            appKey: appKey,
            t: t,
            sign: md5(signSource).toString().toLowerCase(),
            api: "mopen.youku.danmu.list",
            v: "1.0",
            type: "originaljson",
            dataType: "jsonp",
            timeout: "20000",
            jsonpIncPrefix: "utility",
        };

        const url = `https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/?${buildQueryString(params)}`;

        try {
            const response = await httpPost(url, buildQueryString({ data: dataPayload }), {
                headers: {
                    "Cookie": `_m_h5_tk=${_m_h5_tk};_m_h5_tk_enc=${_m_h5_tk_enc};`,
                    "Referer": "https://v.youku.com",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                },
                allow_redirects: false
            });

            if (response && response.data) {
                const resData = this._safeJSONParse(response.data);
                if (resData && resData.data && resData.data.result) {
                    const inner = JSON.parse(resData.data.result);
                    if (inner.code !== "-1" && inner.data && inner.data.result) {
                        return inner.data.result;
                    }
                }
            }
        } catch (e) {
            log("warn", `[Youku] 分段 ${mat} 失败: ${e.message}`);
        }
        return [];
    };

    // 6. 批量执行
    const step = 60;
    const max_mat = Math.floor(duration / step) + 1;
    let contents = [];
    
    // --- 核心修改：使用 globals.youkuConcurrency，默认为 8 ---
    const concurrency = globals.youkuConcurrency || 8; 
    
    log("info", `[Youku] 总分段: ${max_mat}, 并发: ${concurrency}`);

    const mats = Array.from({ length: max_mat }, (_, i) => i);
    
    for (let i = 0; i < mats.length; i += concurrency) {
        const batch = mats.slice(i, i + concurrency).map((m) => requestOneMat(m));
        
        try {
            const settled = await Promise.allSettled(batch);
            for (const s of settled) {
                if (s.status === "fulfilled" && Array.isArray(s.value)) {
                    contents = contents.concat(s.value);
                }
            }
            if (i + concurrency < mats.length) await this._sleep(100);
        } catch (e) {
            log("error", "[Youku] 批量处理异常:", e.message);
        }
    }

    printFirst200Chars(contents);
    return contents;
  }

  formatComments(comments) {
    if (!Array.isArray(comments)) return [];
    
    return comments.map(item => {
      const content = {
        timepoint: 0,
        ct: 1,
        size: 25,
        color: 16777215,
        unixtime: Math.floor(Date.now() / 1000),
        uid: 0,
        content: "",
      };
      
      try {
          content.timepoint = (item.playat || 0) / 1000;
          content.content = item.content || "";
          
          if (item.propertis) {
              const prop = JSON.parse(item.propertis);
              if (prop?.color) content.color = prop.color;
              if (prop?.pos) {
                  if (prop.pos === 1) content.ct = 5;
                  else if (prop.pos === 2) content.ct = 4;
              }
          }
      } catch (e) {
          // 容错
      }
      return content;
    });
  }
}
