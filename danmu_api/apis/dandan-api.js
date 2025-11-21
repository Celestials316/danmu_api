import { globals } from '../configs/globals.js';
import { getPageTitle, jsonResponse } from '../utils/http-util.js';
import { log } from '../utils/log-util.js'
import { setRedisKey, updateRedisCaches } from "../utils/redis-util.js";
import {
    setCommentCache, addAnime, findAnimeIdByCommentId, findTitleById, findUrlById, getCommentCache, getPreferAnimeId,
    getSearchCache, removeEarliestAnime, setPreferByAnimeId, setSearchCache, storeAnimeIdsToMap, writeCacheToFile,
    updateLocalCaches
} from "../utils/cache-util.js";
import { formatDanmuResponse } from "../utils/danmu-util.js";
import { extractEpisodeTitle, convertChineseNumber, parseFileName, createDynamicPlatformOrder, normalizeSpaces } from "../utils/common-util.js";
import { getTMDBChineseTitle } from "../utils/tmdb-util.js";
import Kan360Source from "../sources/kan360.js";
import VodSource from "../sources/vod.js";
import TmdbSource from "../sources/tmdb.js";
import DoubanSource from "../sources/douban.js";
import RenrenSource from "../sources/renren.js";
import HanjutvSource from "../sources/hanjutv.js";
import BahamutSource from "../sources/bahamut.js";
import TencentSource from "../sources/tencent.js";
import IqiyiSource from "../sources/iqiyi.js";
import MangoSource from "../sources/mango.js";
import BilibiliSource from "../sources/bilibili.js";
import YoukuSource from "../sources/youku.js";
import OtherSource from "../sources/other.js";
import {Anime, AnimeMatch, Episodes, Bangumi} from "../models/dandan-model.js";

// =====================
// 兼容弹弹play接口
// =====================

const kan360Source = new Kan360Source();
const vodSource = new VodSource();
const renrenSource = new RenrenSource();
const hanjutvSource = new HanjutvSource();
const bahamutSource = new BahamutSource();
const tencentSource = new TencentSource();
const youkuSource = new YoukuSource();
const iqiyiSource = new IqiyiSource();
const mangoSource = new MangoSource();
const bilibiliSource = new BilibiliSource();
const otherSource = new OtherSource();
const doubanSource = new DoubanSource(tencentSource, iqiyiSource, youkuSource, bilibiliSource);
const tmdbSource = new TmdbSource(doubanSource);

function matchSeason(anime, queryTitle, season) {
  const normalizedAnimeTitle = normalizeSpaces(anime.animeTitle);
  const normalizedQueryTitle = normalizeSpaces(queryTitle);

  if (normalizedAnimeTitle.includes(normalizedQueryTitle)) {
    const title = normalizedAnimeTitle.split("(")[0].trim();
    if (title.startsWith(normalizedQueryTitle)) {
      const afterTitle = title.substring(normalizedQueryTitle.length).trim();
      if (afterTitle === '' && season === 1) {
        return true;
      }
      // match number from afterTitle
      const seasonIndex = afterTitle.match(/\d+/);
      if (seasonIndex && seasonIndex[0] === season.toString()) {
        return true;
      }
      // match chinese number
      const chineseNumber = afterTitle.match(/[一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾]+/);
      if (chineseNumber && convertChineseNumber(chineseNumber[0]) === season) {
        return true;
      }
    }
    return false;
  } else {
    return false;
  }
}

// Extracted function for GET /api/v2/search/anime
export async function searchAnime(url, preferAnimeId = null, preferSource = null) {
  const queryTitle = url.searchParams.get("keyword");
  log("info", `Search anime with keyword: ${queryTitle}`);

  // 关键字为空直接返回，不用多余查询
  if (queryTitle === "") {
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: [],
    });
  }

  // 检查搜索缓存
  const cachedResults = getSearchCache(queryTitle);
  if (cachedResults !== null) {
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: cachedResults,
    });
  }

  const curAnimes = [];

  // 链接弹幕解析
  const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,6}(:\d+)?(\/[^\s]*)?$/;
  if (urlRegex.test(queryTitle)) {
    const tmpAnime = Anime.fromJson({
      "animeId": 111,
      "bangumiId": "string",
      "animeTitle": queryTitle,
      "type": "type",
      "typeDescription": "string",
      "imageUrl": "string",
      "startDate": "2025-08-08T13:25:11.189Z",
      "episodeCount": 1,
      "rating": 0,
      "isFavorited": true
    });

    let platform = "unknown";
    if (queryTitle.includes(".qq.com")) {
      platform = "qq";
    } else if (queryTitle.includes(".iqiyi.com")) {
      platform = "qiyi";
    } else if (queryTitle.includes(".mgtv.com")) {
      platform = "imgo";
    } else if (queryTitle.includes(".youku.com")) {
      platform = "youku";
    } else if (queryTitle.includes(".bilibili.com")) {
      platform = "bilibili1";
    }

    const pageTitle = await getPageTitle(queryTitle);

    const links = [{
      "name": "手动解析链接弹幕",
      "url": queryTitle,
      "title": `【${platform}】 ${pageTitle}`
    }];
    curAnimes.push(tmpAnime);
    addAnime(Anime.fromJson({...tmpAnime, links: links}));
    if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();

    // 如果有新的anime获取到，则更新本地缓存
    if (globals.localCacheValid && curAnimes.length !== 0) {
      await updateLocalCaches();
    }
    // 如果有新的anime获取到，则更新redis
    if (globals.redisValid && curAnimes.length !== 0) {
      await updateRedisCaches();
    }

    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      animes: curAnimes,
    });
  }

  try {
    // 根据 sourceOrderArr 动态构建请求数组
    log("info", `Search sourceOrderArr: ${globals.sourceOrderArr}`);
    const requestPromises = globals.sourceOrderArr.map(source => {
      if (source === "360") return kan360Source.search(queryTitle);
      if (source === "vod") return vodSource.search(queryTitle, preferAnimeId, preferSource);
      if (source === "tmdb") return tmdbSource.search(queryTitle);
      if (source === "douban") return doubanSource.search(queryTitle);
      if (source === "renren") return renrenSource.search(queryTitle);
      if (source === "hanjutv") return hanjutvSource.search(queryTitle);
      if (source === "bahamut") return bahamutSource.search(queryTitle);
      if (source === "tencent") return tencentSource.search(queryTitle);
      if (source === "youku") return youkuSource.search(queryTitle);
      if (source === "iqiyi") return iqiyiSource.search(queryTitle);
      if (source === "imgo") return mangoSource.search(queryTitle);
      if (source === "bilibili") return bilibiliSource.search(queryTitle);
    });

    // 执行所有请求并等待结果
    const results = await Promise.all(requestPromises);

    // 创建一个对象来存储返回的结果
    const resultData = {};

    // 动态根据 sourceOrderArr 顺序将结果赋值给对应的来源
    globals.sourceOrderArr.forEach((source, index) => {
      resultData[source] = results[index];  // 根据顺序赋值
    });

    // 解构出返回的结果
    const {
      vod: animesVodResults, 360: animes360, tmdb: animesTmdb, douban: animesDouban, renren: animesRenren,
      hanjutv: animesHanjutv, bahamut: animesBahamut, tencent: animesTencent, youku: animesYouku, iqiyi: animesIqiyi,
      imgo: animesImgo, bilibili: animesBilibili
    } = resultData;

    // 按顺序处理每个来源的结果
    for (const key of globals.sourceOrderArr) {
      if (key === '360') {
        // 等待处理360来源
        await kan360Source.handleAnimes(animes360, queryTitle, curAnimes);
      } else if (key === 'vod') {
        // 等待处理Vod来源（遍历所有VOD服务器的结果）
        if (animesVodResults && Array.isArray(animesVodResults)) {
          for (const vodResult of animesVodResults) {
            if (vodResult && vodResult.list && vodResult.list.length > 0) {
              await vodSource.handleAnimes(vodResult.list, queryTitle, curAnimes, vodResult.serverName);
            }
          }
        }
      } else if (key === 'tmdb') {
        // 等待处理TMDB来源
        await tmdbSource.handleAnimes(animesTmdb, queryTitle, curAnimes);
      } else if (key === 'douban') {
        // 等待处理Douban来源
        await doubanSource.handleAnimes(animesDouban, queryTitle, curAnimes);
      } else if (key === 'renren') {
        // 等待处理Renren来源
        await renrenSource.handleAnimes(animesRenren, queryTitle, curAnimes);
      } else if (key === 'hanjutv') {
        // 等待处理Hanjutv来源
        await hanjutvSource.handleAnimes(animesHanjutv, queryTitle, curAnimes);
      } else if (key === 'bahamut') {
        // 等待处理Bahamut来源
        await bahamutSource.handleAnimes(animesBahamut, queryTitle, curAnimes);
      } else if (key === 'tencent') {
        // 等待处理Tencent来源
        await tencentSource.handleAnimes(animesTencent, queryTitle, curAnimes);
      } else if (key === 'youku') {
        // 等待处理Youku来源
        await youkuSource.handleAnimes(animesYouku, queryTitle, curAnimes);
      } else if (key === 'iqiyi') {
        // 等待处理iQiyi来源
        await iqiyiSource.handleAnimes(animesIqiyi, queryTitle, curAnimes);
      } else if (key === 'imgo') {
        // 等待处理Mango来源
        await mangoSource.handleAnimes(animesImgo, queryTitle, curAnimes);
      } else if (key === 'bilibili') {
        // 等待处理Bilibili来源
        await bilibiliSource.handleAnimes(animesBilibili, queryTitle, curAnimes);
      }
    }
  } catch (error) {
    log("error", "发生错误:", error);
  }

  storeAnimeIdsToMap(curAnimes, queryTitle);

  // 如果启用了集标题过滤，则为每个动漫添加过滤后的 episodes
  if (globals.enableEpisodeFilter) {
    const validAnimes = [];
    for (const anime of curAnimes) {
      // 首先检查动漫名称是否包含过滤关键词
      const animeTitle = anime.animeTitle || '';
      if (globals.episodeTitleFilter.test(animeTitle)) {
        log("info", `[searchAnime] Anime ${anime.animeId} filtered by name: ${animeTitle}`);
        continue; // 跳过该动漫
      }

      const animeData = globals.animes.find(a => a.animeId === anime.animeId);
      if (animeData && animeData.links) {
        let episodesList = animeData.links.map((link, index) => ({
          episodeId: link.id,
          episodeTitle: link.title,
          episodeNumber: index + 1
        }));

        // 应用过滤
        episodesList = episodesList.filter(episode => {
          return !globals.episodeTitleFilter.test(episode.episodeTitle);
        });

        log("info", `[searchAnime] Anime ${anime.animeId} filtered episodes: ${episodesList.length}/${animeData.links.length}`);

        // 只有当过滤后还有有效剧集时才保留该动漫
        if (episodesList.length > 0) {
          validAnimes.push(anime);
        }
      }
    }
    // 用过滤后的动漫列表替换原列表
    curAnimes.length = 0;
    curAnimes.push(...validAnimes);
  }

  // 如果有新的anime获取到，则更新本地缓存
  if (globals.localCacheValid && curAnimes.length !== 0) {
    await updateLocalCaches();
  }
  // 如果有新的anime获取到，则更新redis
  if (globals.redisValid && curAnimes.length !== 0) {
    await updateRedisCaches();
  }

  // 缓存搜索结果
  if (curAnimes.length > 0) {
    setSearchCache(queryTitle, curAnimes);
  }

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: curAnimes,
  });
}

function filterSameEpisodeTitle(filteredTmpEpisodes) {
    const filteredEpisodes = filteredTmpEpisodes.filter((episode, index, episodes) => {
        // 查找当前 episode 标题是否在之前的 episodes 中出现过
        return !episodes.slice(0, index).some(prevEpisode => {
            return prevEpisode.episodeTitle === episode.episodeTitle;
        });
    });
    return filteredEpisodes;
}

async function matchAniAndEp(season, episode, searchData, title, req, platform, preferAnimeId) {
  let resAnime;
  let resEpisode;
  if (season && episode) {
    // 判断剧集
    const normalizedTitle = normalizeSpaces(title);
    for (const anime of searchData.animes) {
      if (globals.rememberLastSelect && preferAnimeId && anime.bangumiId.toString() !== preferAnimeId.toString() &&
          anime.animeId.toString() !== preferAnimeId.toString()) continue;
      if (normalizeSpaces(anime.animeTitle).includes(normalizedTitle)) {
        let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
        const bangumiRes = await getBangumi(originBangumiUrl.pathname);
        const bangumiData = await bangumiRes.json();
        log("info", "判断剧集", bangumiData);

        // 过滤集标题正则条件的 episode
        const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(episode => {
          return !globals.episodeTitleFilter.test(episode.episodeTitle);
        });

        // 过滤集标题一致的 episode，且保留首次出现的集标题的 episode
        const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);
        log("info", "过滤后的集标题", filteredEpisodes.map(episode => episode.episodeTitle));

        if (platform) {
          const firstIndex = filteredEpisodes.findIndex(episode => extractEpisodeTitle(episode.episodeTitle) === platform);
          const indexCount = filteredEpisodes.filter(episode => extractEpisodeTitle(episode.episodeTitle) === platform).length;
          if (indexCount > 0 && indexCount >= episode) {
            // 先判断season
            if (matchSeason(anime, title, season)) {
              resEpisode = filteredEpisodes[firstIndex + episode - 1];
              resAnime = anime;
              break;
            }
          }
        } else {
          if (filteredEpisodes.length >= episode) {
            // 先判断season
            if (matchSeason(anime, title, season)) {
              resEpisode = filteredEpisodes[episode - 1];
              resAnime = anime;
              break;
            }
          }
        }
      }
    }
  } else {
    // 判断电影
    for (const anime of searchData.animes) {
      if (globals.rememberLastSelect && preferAnimeId && anime.bangumiId.toString() !== preferAnimeId.toString()) continue;
      const animeTitle = anime.animeTitle.split("(")[0].trim();
      if (animeTitle === title) {
        let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
        const bangumiRes = await getBangumi(originBangumiUrl.pathname);
        const bangumiData = await bangumiRes.json();
        log("info", bangumiData);

        if (platform) {
          const firstIndex = bangumiData.bangumi.episodes.findIndex(episode => extractEpisodeTitle(episode.episodeTitle) === platform);
          const indexCount = bangumiData.bangumi.episodes.filter(episode => extractEpisodeTitle(episode.episodeTitle) === platform).length;
          if (indexCount > 0) {
            resEpisode = bangumiData.bangumi.episodes[firstIndex];
            resAnime = anime;
            break;
          }
        } else {
          if (bangumiData.bangumi.episodes.length > 0) {
            resEpisode = bangumiData.bangumi.episodes[0];
            resAnime = anime;
            break;
          }
        }
      }
    }
  }
  return {resEpisode, resAnime};
}

async function fallbackMatchAniAndEp(searchData, req, season, episode, resEpisode, resAnime) {
  for (const anime of searchData.animes) {
    let originBangumiUrl = new URL(req.url.replace("/match", `bangumi/${anime.bangumiId}`));
    const bangumiRes = await getBangumi(originBangumiUrl.pathname);
    const bangumiData = await bangumiRes.json();
    log("info", bangumiData);
    if (season && episode) {
      // 过滤集标题正则条件的 episode
      const filteredTmpEpisodes = bangumiData.bangumi.episodes.filter(episode => {
        return !globals.episodeTitleFilter.test(episode.episodeTitle);
      });

      // 过滤集标题一致的 episode，且保留首次出现的集标题的 episode
      const filteredEpisodes = filterSameEpisodeTitle(filteredTmpEpisodes);

      if (filteredEpisodes.length >= episode) {
        resEpisode = filteredEpisodes[episode - 1];
        resAnime = anime;
        break;
      }
    } else {
      if (bangumiData.bangumi.episodes.length > 0) {
        resEpisode = bangumiData.bangumi.episodes[0];
        resAnime = anime;
        break;
      }
    }
  }
  return {resEpisode, resAnime};
}

// Extracted function for POST /api/v2/match
export async function matchAnime(url, req) {
  try {
    // 获取请求体
    const body = await req.json();

    // 验证请求体是否有效
    if (!body) {
      log("error", "Request body is empty");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Empty request body" },
        400
      );
    }

    // 处理请求体中的数据
    // 假设请求体包含一个字段，比如 { query: "anime name" }
    const { fileName } = body;
    if (!fileName) {
      log("error", "Missing fileName parameter in request body");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing fileName parameter" },
        400
      );
    }

    // 解析fileName，提取平台偏好
    const { cleanFileName, preferredPlatform } = parseFileName(fileName);
    log("info", `Processing anime match for query: ${fileName}`);
    log("info", `Parsed cleanFileName: ${cleanFileName}, preferredPlatform: ${preferredPlatform}`);

    const regex = /^(.+?)[.\s]+S(\d+)E(\d+)/i;
    const match = cleanFileName.match(regex);

    let title, season, episode;

    if (match) {
      // 匹配到 S##E## 格式
      title = match[1].trim();
      season = parseInt(match[2], 10);
      episode = parseInt(match[3], 10);

      // ============ 新标题提取逻辑（重点）============
      // 目标：
      // 1. 优先保留最干净、最像剧名的那一段（通常是开头）
      // 2. 支持：纯中文、纯英文、中英混排、带年份的、中文+单个字母（如亲爱的X）
      // 3. 自动去掉后面的年份、技术参数等垃圾

      // 情况1：开头是中文（最常见的中文字幕组文件名）
      const chineseStart = title.match(/^[\u4e00-\u9fa5·]+(?:[A-Za-z0-9]?)/); // 允许中文后面紧跟一个字母/数字，如 亲爱的X、无忧渡
      if (chineseStart) {
        title = chineseStart[0];
      }
      // 情况2：开头是英文（欧美剧常见，如 Blood.River）
      else if (/^[A-Za-z0-9]/.test(title)) {
        // 从开头一直取到第一个明显的技术字段或年份之前
        const engMatch = title.match(/^([A-Za-z0-9.&\s]+?)(?=\.\d{4}|$)/);
        if (engMatch) {
          title = engMatch[1].trim().replace(/[._]/g, ' '); // Blood.River → Blood River（也可以保留.看你喜好）
          // 如果你想保留原样点号，就去掉上面这行 replace
        }
      }
      // 情况3：中文+英文混排（如 爱情公寓.ipartment.2009）
      else {
        // 先尝试取到第一个年份或分辨率之前的所有内容，再优先保留中文开头部分
        const beforeYear = title.split(/\.(?:19|20)\d{2}|2160p|1080p|720p|H265|iPhone/)[0];
        const chineseInMixed = beforeYear.match(/^[\u4e00-\u9fa5·]+/);
        title = chineseInMixed ? chineseInMixed[0] : beforeYear.trim();
      }

      // 最后再保险清理一次常见的年份尾巴（防止漏网）
      title = title.replace(/\.\d{4}$/i, '').trim();
    } else {
      // 没有 S##E## 格式，尝试提取第一个片段作为标题
      // 匹配第一个中文/英文标题部分（在年份、分辨率等技术信息之前）
      const titleRegex = /^([^.\s]+(?:[.\s][^.\s]+)*?)(?:[.\s](?:\d{4}|(?:19|20)\d{2}|\d{3,4}p|S\d+|E\d+|WEB|BluRay|Blu-ray|HDTV|DVDRip|BDRip|x264|x265|H\.?264|H\.?265|AAC|AC3|DDP|TrueHD|DTS|10bit|HDR|60FPS))/i;
      const titleMatch = cleanFileName.match(titleRegex);

      title = titleMatch ? titleMatch[1].replace(/[._]/g, ' ').trim() : cleanFileName;
      season = null;
      episode = null;
    }

    // 如果外语标题转换中文开关已开启，则尝试获取中文标题
    if (globals.titleToChinese) {
      // 如果title中包含.，则用空格替换
      title = await getTMDBChineseTitle(title.replace('.', ' '), season, episode);
    }

    log("info", "Parsed title, season, episode", { title, season, episode });

    // 获取prefer animeIdgetPreferAnimeId
    const [preferAnimeId, preferSource] = getPreferAnimeId(title);
    log("info", `prefer animeId: ${preferAnimeId} from ${preferSource}`);

    let originSearchUrl = new URL(req.url.replace("/match", `/search/anime?keyword=${title}`));
    const searchRes = await searchAnime(originSearchUrl, preferAnimeId, preferSource);
    const searchData = await searchRes.json();
    log("info", `searchData: ${searchData.animes}`);

    let resAnime;
    let resEpisode;

    // 根据指定平台创建动态平台顺序
    const dynamicPlatformOrder = createDynamicPlatformOrder(preferredPlatform);
    log("info", `Original platformOrderArr: ${globals.platformOrderArr}`);
    log("info", `Dynamic platformOrder: ${dynamicPlatformOrder}`);
    log("info", `Preferred platform: ${preferredPlatform || 'none'}`);

    for (const platform of dynamicPlatformOrder) {
      const __ret = await matchAniAndEp(season, episode, searchData, title, req, platform, preferAnimeId);
      resEpisode = __ret.resEpisode;
      resAnime = __ret.resAnime;

      if (resAnime) {
        log("info", `Found match with platform: ${platform || 'default'}`);
        break;
      }
    }

    // 如果都没有找到则返回第一个满足剧集数的剧集
    if (!resAnime) {
      const __ret = await fallbackMatchAniAndEp(searchData, req, season, episode, resEpisode, resAnime);
      resEpisode = __ret.resEpisode;
      resAnime = __ret.resAnime;
    }

    let resData = {
      "errorCode": 0,
      "success": true,
      "errorMessage": "",
      "isMatched": false,
      "matches": []
    };

    if (resEpisode) {
      resData["isMatched"] = true;
      resData["matches"] = [
        AnimeMatch.fromJson({
          "episodeId": resEpisode.episodeId,
          "animeId": resAnime.animeId,
          "animeTitle": resAnime.animeTitle,
          "episodeTitle": resEpisode.episodeTitle,
          "type": resAnime.type,
          "typeDescription": resAnime.typeDescription,
          "shift": 0,
          "imageUrl": resAnime.imageUrl
        })
      ]
    }

    log("info", `resMatchData: ${resData}`);

    // 示例返回
    return jsonResponse(resData);
  } catch (error) {
    // 处理 JSON 解析错误或其他异常
    log("error", `Failed to parse request body: ${error.message}`);
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: "Invalid JSON body" },
      400
    );
  }
}

// Extracted function for GET /api/v2/search/episodes
export async function searchEpisodes(url) {
  const anime = url.searchParams.get("anime");
  const episode = url.searchParams.get("episode") || "";

  log("info", `Search episodes with anime: ${anime}, episode: ${episode}`);

  if (!anime) {
    log("error", "Missing anime parameter");
    return jsonResponse(
      { errorCode: 400, success: false, errorMessage: "Missing anime parameter" },
      400
    );
  }

  // 先搜索动漫
  let searchUrl = new URL(`/search/anime?keyword=${anime}`, url.origin);
  const searchRes = await searchAnime(searchUrl);
  const searchData = await searchRes.json();

  if (!searchData.success || !searchData.animes || searchData.animes.length === 0) {
    log("info", "No anime found for the given title");
    return jsonResponse({
      errorCode: 0,
      success: true,
      errorMessage: "",
      hasMore: false,
      animes: []
    });
  }

  let resultAnimes = [];

  // 遍历所有找到的动漫，获取它们的集数信息
  for (const animeItem of searchData.animes) {
    const bangumiUrl = new URL(`/bangumi/${animeItem.bangumiId}`, url.origin);
    const bangumiRes = await getBangumi(bangumiUrl.pathname);
    const bangumiData = await bangumiRes.json();

    if (bangumiData.success && bangumiData.bangumi && bangumiData.bangumi.episodes) {
      let filteredEpisodes = bangumiData.bangumi.episodes;

      // 根据 episode 参数过滤集数
      if (episode) {
        if (episode === "movie") {
          // 仅保留剧场版结果
          filteredEpisodes = bangumiData.bangumi.episodes.filter(ep =>
            animeItem.typeDescription && (
              animeItem.typeDescription.includes("电影") ||
              animeItem.typeDescription.includes("剧场版") ||
              ep.episodeTitle.toLowerCase().includes("movie") ||
              ep.episodeTitle.includes("剧场版")
            )
          );
        } else if (/^\d+$/.test(episode)) {
          // 纯数字，仅保留指定集数
          const targetEpisode = parseInt(episode);
          filteredEpisodes = bangumiData.bangumi.episodes.filter(ep =>
            parseInt(ep.episodeNumber) === targetEpisode
          );
        }
      }

      // 只有当过滤后还有集数时才添加到结果中
      if (filteredEpisodes.length > 0) {
        resultAnimes.push(Episodes.fromJson({
          animeId: animeItem.animeId,
          animeTitle: animeItem.animeTitle,
          type: animeItem.type,
          typeDescription: animeItem.typeDescription,
          episodes: filteredEpisodes.map(ep => ({
            episodeId: ep.episodeId,
            episodeTitle: ep.episodeTitle
          }))
        }));
      }
    }
  }

  log("info", `Found ${resultAnimes.length} animes with filtered episodes`);

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    animes: resultAnimes
  });
}

// Extracted function for GET /api/v2/bangumi/:animeId
export async function getBangumi(path) {
  const idParam = path.split("/").pop();
  const animeId = parseInt(idParam);

  // 尝试通过 animeId(数字) 或 bangumiId(字符串) 查找
  let anime;
  if (!isNaN(animeId)) {
    // 如果是有效数字,先尝试通过 animeId 查找
    anime = globals.animes.find((a) => a.animeId.toString() === animeId.toString());
  }

  // 如果通过 animeId 未找到,尝试通过 bangumiId 查找
  if (!anime) {
    anime = globals.animes.find((a) => a.bangumiId === idParam);
  }

  if (!anime) {
    log("error", `Anime with ID ${idParam} not found`);
    return jsonResponse(
      { errorCode: 404, success: false, errorMessage: "Anime not found", bangumi: null },
      404
    );
  }
  log("info", `Fetched details for anime ID: ${idParam}`);

  // 构建 episodes 列表
  let episodesList = [];
  for (let i = 0; i < anime.links.length; i++) {
    const link = anime.links[i];
    episodesList.push({
      seasonId: `season-${anime.animeId}`,
      episodeId: link.id,
      episodeTitle: `${link.title}`,
      episodeNumber: `${i+1}`,
      airDate: anime.startDate,
    });
  }

  // 如果启用了集标题过滤，则应用过滤
  if (globals.enableEpisodeFilter) {
    episodesList = episodesList.filter(episode => {
      return !globals.episodeTitleFilter.test(episode.episodeTitle);
    });
    log("info", `[getBangumi] Episode filter enabled. Filtered episodes: ${episodesList.length}/${anime.links.length}`);

    // 如果过滤后没有有效剧集，返回错误
    if (episodesList.length === 0) {
      log("warn", `[getBangumi] No valid episodes after filtering for anime ID ${idParam}`);
      return jsonResponse(
        { errorCode: 404, success: false, errorMessage: "No valid episodes after filtering", bangumi: null },
        404
      );
    }

    // 重新排序episodeNumber
    episodesList = episodesList.map((episode, index) => ({
      ...episode,
      episodeNumber: `${index+1}`
    }));
  }

  const bangumi = Bangumi.fromJson({
    animeId: anime.animeId,
    bangumiId: anime.bangumiId,
    animeTitle: anime.animeTitle,
    imageUrl: anime.imageUrl,
    isOnAir: true,
    airDay: 1,
    isFavorited: anime.isFavorited,
    rating: anime.rating,
    type: anime.type,
    typeDescription: anime.typeDescription,
    seasons: [
      {
        id: `season-${anime.animeId}`,
        airDate: anime.startDate,
        name: "Season 1",
        episodeCount: anime.episodeCount,
      },
    ],
    episodes: episodesList,
  });

  return jsonResponse({
    errorCode: 0,
    success: true,
    errorMessage: "",
    bangumi: bangumi
  });
}

// Extracted function for GET /api/v2/comment/:commentId
export async function getComment(path, queryFormat) {
  const commentId = parseInt(path.split("/").pop());
  let url = findUrlById(commentId);
  let title = findTitleById(commentId);
  let plat = title ? (title.match(/【(.*?)】/) || [null])[0]?.replace(/[【】]/g, '') : null;
  log("info", "comment url...", url);
  log("info", "comment title...", title);
  log("info", "comment platform...", plat);
  if (!url) {
    log("error", `Comment with ID ${commentId} not found`);
    return jsonResponse({ count: 0, comments: [] }, 404);
  }
  log("info", `Fetched comment ID: ${commentId}`);

  // 检查弹幕缓存
  const cachedComments = getCommentCache(url);
  if (cachedComments !== null) {
    const responseData = { count: cachedComments.length, comments: cachedComments };
    return formatDanmuResponse(responseData, queryFormat);
  }

  log("info", "开始从本地请求弹幕...", url);
  let danmus = [];
  if (url.includes('.qq.com')) {
    danmus = await tencentSource.getComments(url, plat);
  } else if (url.includes('.iqiyi.com')) {
    danmus = await iqiyiSource.getComments(url, plat);
  } else if (url.includes('.mgtv.com')) {
    danmus = await mangoSource.getComments(url, plat);
  } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
    // 如果是 b23.tv 短链接，先解析为完整 URL
    if (url.includes('b23.tv')) {
      url = await bilibiliSource.resolveB23Link(url);
    }
    danmus = await bilibiliSource.getComments(url, plat);
  } else if (url.includes('.youku.com')) {
    danmus = await youkuSource.getComments(url, plat);
  }

  // 请求其他平台弹幕
  const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
  if (!urlPattern.test(url)) {
    if (plat === "renren") {
      danmus = await renrenSource.getComments(url, plat);
    } else if (plat === "hanjutv") {
      danmus = await hanjutvSource.getComments(url, plat);
    } else if (plat === "bahamut") {
      danmus = await bahamutSource.getComments(url, plat);
    }
  }

  // 如果弹幕为空，则请求第三方弹幕服务器作为兜底
  if (danmus.length === 0 && urlPattern.test(url)) {
    danmus = await otherSource.getComments(url, "other_server");
  }

  const [animeId, source] = findAnimeIdByCommentId(commentId);

  // 🔥 修复：只记录一次，避免重复显示
  if (title && animeId) {
    try {
      // 查找番剧名称
      let animeTitle = '';
      const animeObj = globals.animes.find(a => a.animeId == animeId);
      if (animeObj) animeTitle = animeObj.animeTitle;

      // 构建唯一的显示Key：【番剧名】集名
      // 🔥 修复：清理标题中的 from 来源标识，防止Key过长
      const cleanEpTitle = title ? title.replace(/\s+from\s+.*$/i, '').trim() : title;
      const displayKey = animeTitle ? `【${animeTitle}】${cleanEpTitle}` : cleanEpTitle;

      // 检查是否已存在，避免重复记录
      const existing = globals.lastSelectMap.get(displayKey);
      if (!existing || existing.timestamp < Date.now() - 60000) { // 1分钟内不重复记录
        const matchInfo = {
          id: animeId,
          source: source || plat || 'auto',
          count: danmus.length,
          limit: globals.danmuLimit,
          timestamp: Date.now(),
          animeTitle: animeTitle,
          episodeTitle: title
        };
        
        // 更新内存映射
        globals.lastSelectMap.set(displayKey, matchInfo);
        log("info", `[lastSelect] 记录匹配信息: ${displayKey.substring(0, 50)}...`);

        // 🔥 持久化保存到 Redis/数据库
        try {
          if (globals.databaseValid) {
            const { saveCacheData } = await import('../utils/db-util.js');
            const mapObj = Object.fromEntries(globals.lastSelectMap);
            await saveCacheData('lastSelectMap', mapObj);
            log("info", `[lastSelect] 已保存到数据库`);
          } else if (globals.redisValid) {
            const { setRedisKey } = await import('../utils/redis-util.js');
            const mapObj = Object.fromEntries(globals.lastSelectMap);
            await setRedisKey('lastSelectMap', JSON.stringify(mapObj), true);
            log("info", `[lastSelect] 已保存到 Redis`);
          } else if (globals.localCacheValid) {
            const { writeCacheToFile } = await import('../utils/cache-util.js');
            const mapObj = Object.fromEntries(globals.lastSelectMap);
            writeCacheToFile('lastSelectMap', JSON.stringify(mapObj));
            log("info", `[lastSelect] 已保存到本地文件`);
          }
        } catch (saveError) {
          log("warn", `[lastSelect] 持久化保存失败: ${saveError.message}`);
        }
      }
    } catch (error) {
      log("warn", `[lastSelect] 记录匹配信息失败: ${error.message}`);
    }
  }

  // 缓存弹幕结果
  if (danmus.length > 0) {
    setCommentCache(url, danmus);
  }

  const responseData = { count: danmus.length, comments: danmus };
  return formatDanmuResponse(responseData, queryFormat);
}

// Extracted function for GET /api/v2/comment?url=xxx
export async function getCommentByUrl(videoUrl, queryFormat) {
  try {
    // 验证URL参数
    if (!videoUrl || typeof videoUrl !== 'string') {
      log("error", "Missing or invalid url parameter");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Missing or invalid url parameter", count: 0, comments: [] },
        400
      );
    }

    videoUrl = videoUrl.trim();

    // 验证URL格式
    if (!videoUrl.startsWith('http')) {
      log("error", "Invalid url format, must start with http or https");
      return jsonResponse(
        { errorCode: 400, success: false, errorMessage: "Invalid url format, must start with http or https", count: 0, comments: [] },
        400
      );
    }

    log("info", `Processing comment request for URL: ${videoUrl}`);

    let url = videoUrl;
    // 检查弹幕缓存
    const cachedComments = getCommentCache(url);
    if (cachedComments !== null) {
      const responseData = {
        errorCode: 0,
        success: true,
        errorMessage: "",
        count: cachedComments.length,
        comments: cachedComments
      };
      return formatDanmuResponse(responseData, queryFormat);
    }

    log("info", "开始从本地请求弹幕...", url);
    let danmus = [];

    // 根据URL域名判断平台并获取弹幕
    if (url.includes('.qq.com')) {
      danmus = await tencentSource.getComments(url, "qq");
    } else if (url.includes('.iqiyi.com')) {
      danmus = await iqiyiSource.getComments(url, "qiyi");
    } else if (url.includes('.mgtv.com')) {
      danmus = await mangoSource.getComments(url, "imgo");
    } else if (url.includes('.bilibili.com') || url.includes('b23.tv')) {
      // 如果是 b23.tv 短链接，先解析为完整 URL
      if (url.includes('b23.tv')) {
        url = await bilibiliSource.resolveB23Link(url);
      }
      danmus = await bilibiliSource.getComments(url, "bilibili1");
    } else if (url.includes('.youku.com')) {
      danmus = await youkuSource(url, "youku");
    } else {
      // 如果不是已知平台，尝试第三方弹幕服务器
      const urlPattern = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(\/.*)?$/i;
      if (urlPattern.test(url)) {
        danmus = await otherSource.getComments(url, "other_server");
      }
    }

    log("info", `Successfully fetched ${danmus.length} comments from URL`);

    // 🔥 修复：记录 URL 方式的请求信息（简化版，避免重复）
    try {
      const urlPath = url.split('/').pop() || 'Unknown Video';
      const { cleanFileName } = parseFileName(urlPath);
      const displayKey = `[URL] ${cleanFileName || urlPath.substring(0, 30)}`;
      
      // 检查是否已存在
      const existing = globals.lastSelectMap.get(displayKey);
      if (!existing || existing.timestamp < Date.now() - 60000) {
        const matchInfo = {
          id: 'URL直连',
          source: 'url',
          count: danmus.length,
          limit: globals.danmuLimit,
          timestamp: Date.now(),
          animeTitle: '',
          episodeTitle: cleanFileName || urlPath
        };

        globals.lastSelectMap.set(displayKey, matchInfo);
        log("info", `[lastSelect] 记录URL请求: ${displayKey.substring(0, 50)}...`);
        
        // 持久化保存
        if (globals.databaseValid) {
          const { saveCacheData } = await import('../utils/db-util.js');
          const mapObj = Object.fromEntries(globals.lastSelectMap);
          await saveCacheData('lastSelectMap', mapObj);
        } else if (globals.redisValid) {
          const { setRedisKey } = await import('../utils/redis-util.js');
          const mapObj = Object.fromEntries(globals.lastSelectMap);
          await setRedisKey('lastSelectMap', JSON.stringify(mapObj), true);
        }
      }
    } catch (e) {
      log("warn", `[lastSelect] 记录URL匹配信息失败: ${e.message}`);
    }

    // 缓存弹幕结果
    if (danmus.length > 0) {
      setCommentCache(url, danmus);
    }

    const responseData = {
      errorCode: 0,
      success: true,
      errorMessage: "",
      count: danmus.length,
      comments: danmus
    };
    return formatDanmuResponse(responseData, queryFormat);
  } catch (error) {
    // 处理异常
    log("error", `Failed to process comment by URL request: ${error.message}`);
    return jsonResponse(
      { errorCode: 500, success: false, errorMessage: "Internal server error", count: 0, comments: [] },
      500
    );
  }
}