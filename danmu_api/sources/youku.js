import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { buildQueryString, httpGet, httpPost } from "../utils/http-util.js";
import { printFirst200Chars, titleMatches } from "../utils/common-util.js";
import { md5, convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";

// =====================
// 获取优酷弹幕 (优化版)
// =====================
export default class YoukuSource extends BaseSource {
  
  // 辅助：解析响应数据，兼容 string 或 object
  _parseResponseData(data) {
    if (!data) return null;
    if (typeof data === "object") return data;
    try {
      return JSON.parse(data);
    } catch (e) {
      log("error", "[Youku] JSON解析失败:", e.message);
      return null;
    }
  }

  // 辅助：休眠函数，用于重试间隔
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  convertYoukuUrl(url) {
    // 兼容多种 URL 格式提取 vid
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
      cats: commonData.cats // 保存分类信息用于后续判断
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

      const data = this._parseResponseData(response.data);
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

      // 第一步：获取第一页
      const pageSize = 100;
      const firstPage = await this._getEpisodesPage(id, 1, pageSize);

      if (!firstPage || !firstPage.videos || firstPage.videos.length === 0) {
        return [];
      }

      let allEpisodes = [...firstPage.videos];
      const totalCount = firstPage.total;

      // 第二步：并发获取剩余页面
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
    return this._parseResponseData(response.data);
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Youku] sourceAnimes 无效");
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
            // 确保 url 存在，若不存在则构造
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
          log("error", `[Youku] 处理 Anime 出错: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return processYoukuAnimes;
  }

  _processAndFormatEpisodes(rawEpisodes, mediaType = 'variety') {
    // 复制数组防止修改原数据
    let filteredEpisodes = [...rawEpisodes];

    return filteredEpisodes.map((ep, index) => {
      const episodeIndex = index + 1;
      const title = this._formatEpisodeTitle(ep, episodeIndex, mediaType);
      
      // 处理 ID，youku 有时返回 id=XXXX
      let safeId = ep.id;
      if (safeId && safeId.includes("=")) {
          safeId = safeId.replace("=", "_"); // 简单的清理
      }

      return {
        vid: ep.id, // 保留原始 ID 用于弹幕获取
        title: title,
        episodeIndex: episodeIndex,
        link: ep.link
      };
    });
  }

  _formatEpisodeTitle(ep, episodeIndex, mediaType) {
    let cleanDisplayName = ep.displayName || ep.title;
    if (!cleanDisplayName) return `第${episodeIndex}集`;

    // 移除日期前缀 (YYYY-MM-DD 或 MM-DD)
    const datePattern = /^(?:\d{2,4}-\d{2}-\d{2}|\d{2}-\d{2})\s*(?=(?:第\d+期))|^(?:\d{2,4}-\d{2}-\d{2}|\d{2}-\d{2})\s*:\s*/;
    cleanDisplayName = cleanDisplayName.replace(datePattern, '').trim();

    if (mediaType === 'movie') return cleanDisplayName;

    if (mediaType === 'variety') {
      const periodMatch = cleanDisplayName.match(/第(\d+)期/);
      // 综艺加上日期后缀以便区分
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
    
    // 合并判断逻辑
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

    // 1. URL 修正与 ID 提取
    if (id.includes("youku.com/video?vid")) {
        id = this.convertYoukuUrl(id);
    }
    
    // 鲁棒的 ID 提取 (优先匹配 id_XXX，其次尝试路径分割)
    let video_id = null;
    const idRegex = /id_([a-zA-Z0-9=]+)/;
    const idMatch = id.match(idRegex);
    if (idMatch) {
        video_id = idMatch[1];
    } else {
        // 后备方案：分割路径
        const pathParts = id.split('?')[0].split('/').filter(Boolean);
        for (let part of pathParts) {
            if (part.includes('.html')) {
                video_id = part.split('.')[0];
                if (video_id.startsWith('id_')) video_id = video_id.slice(3);
                break;
            }
        }
    }
    
    if (!video_id) {
        log("error", "[Youku] 无法解析 video_id:", id);
        return [];
    }
    log("info", `[Youku] Parsed video_id: ${video_id}`);

    // 2. 获取视频详情 (Title, Duration)
    const api_video_info = "https://openapi.youku.com/v2/videos/show.json";
    let title = "", duration = 0;

    try {
        const videoInfoUrl = `${api_video_info}?client_id=53e6cc67237fc59a&video_id=${video_id}&package=com.huawei.hwvplayer.youku&ext=show`;
        const res = await httpGet(videoInfoUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
        });
        const data = this._parseResponseData(res.data);
        if (data) {
            title = data.title;
            duration = parseInt(data.duration || 0);
        }
    } catch (e) {
        log("error", "[Youku] 获取视频详情失败:", e.message);
        // 如果获取失败，弹幕也无法计算分段，直接返回
        return [];
    }
    
    if (duration <= 0) {
        log("info", "[Youku] 视频时长无效，无法获取弹幕");
        return [];
    }

    // 3. 获取 CNA 和 Token (核心逻辑优化)
    let cna = "", _m_h5_tk = "", _m_h5_tk_enc = "";
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Referer": "https://v.youku.com"
    };

    try {
        // 获取 CNA
        const cnaRes = await httpGet("https://log.mmstat.com/eg.js", { headers });
        if (cnaRes && cnaRes.headers) {
            const etag = cnaRes.headers["etag"] || cnaRes.headers["Etag"];
            if (etag) cna = etag.replace(/^"|"$/g, '');
        }
        
        // 获取 Token (带重试机制，防止死循环)
        const tkEncUrl = "https://acs.youku.com/h5/mtop.com.youku.aplatform.weakget/1.0/?jsv=2.5.1&appKey=24679788";
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                const tkRes = await httpGet(tkEncUrl, { headers });
                if (tkRes && tkRes.headers) {
                    const setCookie = tkRes.headers["set-cookie"] || tkRes.headers["Set-Cookie"];
                    if (setCookie) {
                        // 统一转为 string 数组处理
                        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
                        const cookieStr = cookies.join(';');
                        
                        const tkMatch = cookieStr.match(/_m_h5_tk=([^;]+)/);
                        const encMatch = cookieStr.match(/_m_h5_tk_enc=([^;]+)/);
                        
                        if (tkMatch) _m_h5_tk = tkMatch[1];
                        if (encMatch) _m_h5_tk_enc = encMatch[1];
                        
                        if (_m_h5_tk) break; // 成功获取
                    }
                }
            } catch (e) {
                log("warn", `[Youku] 获取 Token 失败 (尝试 ${retryCount + 1}/${maxRetries}):`, e.message);
            }
            retryCount++;
            await this._sleep(500); // 失败等待
        }

        if (!_m_h5_tk) {
            log("error", "[Youku] 无法获取 _m_h5_tk，停止弹幕获取");
            return [];
        }

    } catch (e) {
        log("error", "[Youku] Token 初始化流程异常:", e.message);
        return [];
    }

    // 4. 定义加密辅助函数 (保持闭包内定义，防止污染全局)
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

    // 5. 弹幕分段请求逻辑
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

        // 构造 payload
        // 确保 key 排序 (Youku 签名要求)
        const msg_b64encode = base64Encode(utf8ToLatin1(JSON.stringify(msg)));
        msg.msg = msg_b64encode;
        // 签名混淆盐值
        msg.sign = md5(`${msg_b64encode}MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr`).toString().toLowerCase();

        const dataPayload = JSON.stringify(msg);
        const t = Date.now();
        const appKey = "24679788";
        // Token 签名 (取前32位)
        const tokenPart = _m_h5_tk.substring(0, 32);
        const signSource = [tokenPart, t, appKey, dataPayload].join("&");
        const finalSign = md5(signSource).toString().toLowerCase();

        const params = {
            jsv: "2.5.6",
            appKey: appKey,
            t: t,
            sign: finalSign,
            api: "mopen.youku.danmu.list",
            v: "1.0",
            type: "originaljson",
            dataType: "jsonp",
            timeout: "20000",
            jsonpIncPrefix: "utility",
        };

        const api_danmaku = "https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/";
        const url = `${api_danmaku}?${buildQueryString(params)}`;

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

            // 检查响应
            if (response && response.data) {
                const resData = this._parseResponseData(response.data);
                if (resData && resData.data && resData.data.result) {
                    const innerResult = JSON.parse(resData.data.result);
                    if (innerResult.code !== "-1" && innerResult.data && innerResult.data.result) {
                         return innerResult.data.result;
                    }
                } else if (resData && resData.ret && resData.ret[0] && resData.ret[0].includes("TOKEN")) {
                    // 如果在这里检测到 Token 过期，理论上应该重试，
                    // 但由于是并发请求，这里只记录日志，避免逻辑过于复杂导致崩溃
                    log("warn", `[Youku] Token 可能已过期 (mat=${mat})`);
                }
            }
        } catch (e) {
            log("warn", `[Youku] 分段 ${mat} 请求失败: ${e.message}`);
        }
        return [];
    };

    // 6. 执行分段请求
    const step = 60; // 60秒一分段
    const max_mat = Math.floor(duration / step) + 1;
    let contents = [];
    const concurrency = globals.youkuConcurrency || 5; // 默认并发数 5，防止风控
    
    log("info", `[Youku] 总分段数: ${max_mat}, 并发数: ${concurrency}`);

    const mats = Array.from({ length: max_mat }, (_, i) => i);
    
    // 分批处理
    for (let i = 0; i < mats.length; i += concurrency) {
        const batch = mats.slice(i, i + concurrency).map((m) => requestOneMat(m));
        
        try {
            const settled = await Promise.allSettled(batch);
            for (const s of settled) {
                if (s.status === "fulfilled" && Array.isArray(s.value)) {
                    contents = contents.concat(s.value);
                }
            }
            // 批次间微小延迟，降低被封概率
            if (i + concurrency < mats.length) await this._sleep(100);
            
        } catch (e) {
            log("error", "[Youku] 批量请求异常:", e.message);
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
                  if (prop.pos === 1) content.ct = 5; // 顶部
                  else if (prop.pos === 2) content.ct = 4; // 底部
              }
          }
      } catch (e) {
          // 忽略单个弹幕格式化错误
      }
      return content;
    });
  }
}
