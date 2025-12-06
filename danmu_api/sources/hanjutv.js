import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { convertToAsciiSum } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";

// 辅助函数：简单的延时，防止请求过快
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =====================
// 获取韩剧TV弹幕 (优化版)
// =====================
export default class HanjutvSource extends BaseSource {

  // 提取分类映射为类属性或静态属性，避免重复定义
  getCateMap() {
    return { 1: "韩剧", 2: "综艺", 3: "电影", 4: "日剧", 5: "美剧", 6: "泰剧", 7: "国产剧" };
  }

  getCategory(key) {
    return this.getCateMap()[key] || "其他";
  }

  async search(keyword) {
    try {
      const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/search/aggregate/search?keyword=${keyword}&scope=101&page=1`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      if (!resp || !resp.data) {
        log("info", "hanjutvSearch: 请求失败或无数据返回");
        return [];
      }

      if (!resp.data.seriesData || !resp.data.seriesData.seriesList) {
        log("info", "hanjutvSearch: seriesData 或 seriesList 不存在");
        return [];
      }

      // log("info", `hanjutvSearch: ${JSON.stringify(resp.data.seriesData.seriesList)}`);

      let resList = [];
      for (const anime of resp.data.seriesData.seriesList) {
        // 确保 sid 存在
        if(anime.sid) {
            const animeId = convertToAsciiSum(anime.sid);
            resList.push({...anime, animeId});
        }
      }
      return resList;
    } catch (error) {
      log("error", "hanjutvSearch error:", {
        message: error.message,
        name: error.name,
      });
      return [];
    }
  }

  // 优化：合并 Detail 和 Episodes 的请求，因为它们其实是同一个接口
  async getSeriesFullData(id) {
    try {
      const resp = await httpGet(`https://hxqapi.hiyun.tv/wapi/series/series/detail?sid=${id}`, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      if (!resp || !resp.data) {
        return null;
      }
      return resp.data;
    } catch (error) {
      log("error", `getSeriesFullData error for id ${id}: ${error.message}`);
      return null;
    }
  }

  // 保留原有方法以防其他地方单独调用，但内部逻辑保持独立
  async getDetail(id) {
    const data = await this.getSeriesFullData(id);
    return data && data.series ? data.series : [];
  }

  async getEpisodes(id) {
    const data = await this.getSeriesFullData(id);
    if (data && data.episodes) {
      return data.episodes.sort((a, b) => a.serialNo - b.serialNo);
    }
    return [];
  }

  // ==========================================
  // 核心逻辑修改：处理搜索结果和详情获取
  // ==========================================
  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[Hanjutv] sourceAnimes is not a valid array");
      return [];
    }

    // 1. 智能过滤策略
    let targetAnimes = [];
    let isFuzzyMatch = false; // 🔥 新增标记：是否使用了模糊/信任匹配

    if (sourceAnimes.length === 1) {
      // 如果只返回一个结果，大概率是别名匹配（如：搜"不幸的幸会"返回"讨厌的爱情"），直接信任，不过滤
      log("info", `[Hanjutv] Single result found, skipping title check for: ${sourceAnimes[0].name}`);
      targetAnimes = sourceAnimes;
      isFuzzyMatch = true; // 🔥 标记为真
    } else {
      // 如果有多个结果，进行标题匹配，过滤掉不相关的干扰项
      targetAnimes = sourceAnimes.filter(s => titleMatches(s.name, queryTitle));
    }

    if (targetAnimes.length === 0) {
        log("info", "[Hanjutv] No matching animes found after filtering.");
        return [];
    }

    // 2. 串行处理 + 合并请求 (优化性能与防封)
    // 使用 for...of 循环代替 Promise.all，避免瞬间发出过多请求
    for (const anime of targetAnimes) {
        try {
            // 合并请求：一次拿回详情和集数
            const fullData = await this.getSeriesFullData(anime.sid);

            if (!fullData || !fullData.series) {
                continue;
            }

            const detail = fullData.series;
            const episodes = fullData.episodes || [];

            // 排序集数
            const sortedEpisodes = episodes.sort((a, b) => a.serialNo - b.serialNo);

            let links = [];
            for (const ep of sortedEpisodes) {
                // 构建集数标题
                const epTitle = ep.title && ep.title.trim() !== "" 
                    ? `第${ep.serialNo}集：${ep.title}` 
                    : `第${ep.serialNo}集`;

                links.push({
                    "name": epTitle,
                    "url": ep.pid, // 使用 pid 作为播放ID
                    "title": `【hanjutv】 ${epTitle}`
                });
            }

            if (links.length > 0) {
                // 日期处理增强
                let updateYear = new Date().getFullYear();
                if (anime.updateTime) {
                    try {
                        const d = new Date(anime.updateTime);
                        if (!isNaN(d.getTime())) {
                            updateYear = d.getFullYear();
                        }
                    } catch (e) {}
                }

                const categoryStr = this.getCategory(detail.category);

                let transformedAnime = {
                    animeId: anime.animeId,
                    bangumiId: String(anime.animeId),
                    animeTitle: `${anime.name}(${updateYear})【${categoryStr}】from hanjutv`,
                    type: categoryStr,
                    typeDescription: categoryStr,
                    imageUrl: anime.image ? anime.image.thumb : "",
                    startDate: generateValidStartDate(updateYear),
                    episodeCount: links.length,
                    rating: detail.rank,
                    isFavorited: true,
                    source: "hanjutv",
                    matchedByKeyword: isFuzzyMatch ? queryTitle : null // 🔥 新增：如果是模糊匹配，记录原始搜索词
                };

                tmpAnimes.push(transformedAnime);

                // 写入缓存（这一步适配了你的项目结构）
                addAnime({...transformedAnime, links: links});

                if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
            }

            // 简单的速率限制：每个请求后休息 50ms - 100ms
            // 如果你觉得搜索慢，可以把这个去掉，但保留它更安全
            await sleep(50); 

        } catch (error) {
            log("error", `[Hanjutv] Error processing anime ${anime.name}: ${error.message}`);
        }
    }

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    // 为了保持原有接口一致性，返回处理完的数组
    return tmpAnimes;
  }

  async getEpisodeDanmu(id) {
    let allDanmus = [];
    let fromAxis = 0;
    const maxAxis = 100000000;
    let retryCount = 0;

    try {
      while (fromAxis < maxAxis) {
        const url = `https://hxqapi.zmdcq.com/api/danmu/playItem/list?fromAxis=${fromAxis}&pid=${id}&toAxis=${maxAxis}`;

        try {
            const resp = await httpGet(url, {
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
              },
              retries: 1,
            });

            // 将当前请求的 danmus 拼接到总数组
            if (resp.data && resp.data.danmus) {
              allDanmus = allDanmus.concat(resp.data.danmus);
            }

            // 获取 nextAxis，更新 fromAxis
            const nextAxis = resp.data && resp.data.nextAxis ? resp.data.nextAxis : maxAxis;

            if (nextAxis >= maxAxis || nextAxis <= fromAxis) {
              break; // 结束条件
            }
            fromAxis = nextAxis;

            // 防止弹幕页数过多导致的请求过快
            await sleep(100);

        } catch (innerError) {
            // 单页失败重试逻辑
            retryCount++;
            if (retryCount > 3) break; 
            log("info", `[Hanjutv] Fetch danmu page error, retrying... ${innerError.message}`);
            await sleep(500);
        }
      }

      return allDanmus;
    } catch (error) {
      log("error", "fetchHanjutvEpisodeDanmu error:", {
        message: error.message,
        name: error.name,
      });
      return allDanmus;
    }
  }

  formatComments(comments) {
    return comments.map(c => ({
      cid: Number(c.did),
      // 这里的 25 是字号，Python代码里固定了，这里我也加上默认值保持稳健
      p: `${(c.t / 1000).toFixed(2)},${c.tp === 2 ? 5 : c.tp},25,${Number(c.sc)},[hanjutv]`,
      m: c.con,
      t: Math.round(c.t / 1000)
    }));
  }
}