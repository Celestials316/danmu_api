import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { Anime } from "../models/dandan-model.js";

// =====================
// cache数据结构处理函数
// =====================

// 检查搜索缓存是否有效（未过期）
export function isSearchCacheValid(keyword) {
    if (!globals.searchCache.has(keyword)) {
        return false;
    }

    const cached = globals.searchCache.get(keyword);
    const now = Date.now();
    const cacheAgeMinutes = (now - cached.timestamp) / (1000 * 60);

    if (cacheAgeMinutes > globals.searchCacheMinutes) {
        // 缓存已过期，删除它
        globals.searchCache.delete(keyword);
        log("info", `Search cache for "${keyword}" expired after ${cacheAgeMinutes.toFixed(2)} minutes`);
        return false;
    }

    return true;
}

// 获取搜索缓存
export function getSearchCache(keyword) {
    if (isSearchCacheValid(keyword)) {
        log("info", `Using search cache for "${keyword}"`);
        return globals.searchCache.get(keyword).results;
    }
    return null;
}

// 设置搜索缓存
export async function setSearchCache(keyword, results) {
    globals.searchCache.set(keyword, {
        results: results,
        timestamp: Date.now()
    });

    log("info", `Cached search results for "${keyword}" (${results.length} animes)`);

    // 🔥 同步 searchCache 到数据库
    if (globals.databaseValid) {
        try {
            const { saveCacheData } = await import('./db-util.js');
            await saveCacheData('searchCache', Object.fromEntries(globals.searchCache));
            log("info", `[cache] ✅ searchCache已同步到数据库`);
        } catch (error) {
            log("warn", `[cache] 数据库同步失败: ${error.message}`);
        }
    }
}

// 检查弹幕缓存是否有效（未过期）
export function isCommentCacheValid(videoUrl) {
    if (!globals.commentCache.has(videoUrl)) {
        return false;
    }

    const cached = globals.commentCache.get(videoUrl);
    const now = Date.now();
    const cacheAgeMinutes = (now - cached.timestamp) / (1000 * 60);

    if (cacheAgeMinutes > globals.commentCacheMinutes) {
        // 缓存已过期，删除它
        globals.commentCache.delete(videoUrl);
        log("info", `Comment cache for "${videoUrl}" expired after ${cacheAgeMinutes.toFixed(2)} minutes`);
        return false;
    }

    return true;
}

// 获取弹幕缓存
export function getCommentCache(videoUrl) {
    if (isCommentCacheValid(videoUrl)) {
        log("info", `Using comment cache for "${videoUrl}"`);
        return globals.commentCache.get(videoUrl).comments;
    }
    return null;
}

// 设置弹幕缓存
export async function setCommentCache(videoUrl, comments) {
    globals.commentCache.set(videoUrl, {
        comments: comments,
        timestamp: Date.now()
    });

    log("info", `Cached comments for "${videoUrl}" (${comments.length} comments)`);

    // 🔥 同步 commentCache 到数据库
    if (globals.databaseValid) {
        try {
            const { saveCacheData } = await import('./db-util.js');
            await saveCacheData('commentCache', Object.fromEntries(globals.commentCache));
            log("info", `[cache] ✅ commentCache已同步到数据库`);
        } catch (error) {
            log("warn", `[cache] 数据库同步失败: ${error.message}`);
        }
    }
}

// 添加元素到 episodeIds：检查 url 是否存在，若不存在则以自增 id 添加
// 替换后:
export function addEpisode(url, title) {
    // 检查是否已存在相同的 url (只检查URL,不检查title)
    const existingEpisode = globals.episodeIds.find(episode => episode.url === url);
    if (existingEpisode) {
        log("info", `Episode with URL ${url} already exists in episodeIds (id: ${existingEpisode.id}), returning existing episode.`);
        return existingEpisode; // 返回已存在的 episode
    }

    // 自增 episodeNum 并使用作为 id
    globals.episodeNum++;
    const newEpisode = { id: globals.episodeNum, url: url, title: title };

    // 添加新对象
    globals.episodeIds.push(newEpisode);

    log("info", `Added to episodeIds: ${JSON.stringify(newEpisode)}`);
    return newEpisode; // 返回新添加的对象
}

// 删除指定 URL 的对象从 episodeIds
export function removeEpisodeByUrl(url) {
    const initialLength = globals.episodeIds.length;
    globals.episodeIds = globals.episodeIds.filter(episode => episode.url !== url);
    const removedCount = initialLength - globals.episodeIds.length;
    if (removedCount > 0) {
        log("info", `Removed ${removedCount} episode(s) from episodeIds with URL: ${url}`);
        return true;
    }
    log("error", `No episode found in episodeIds with URL: ${url}`);
    return false;
}

// 根据 ID 查找 URL
export function findUrlById(id) {
    const episode = globals.episodeIds.find(episode => episode.id === id);
    if (episode) {
        log("info", `Found URL for ID ${id}: ${episode.url}`);
        return episode.url;
    }
    log("error", `No URL found for ID: ${id}`);
    return null;
}

// 根据 ID 查找 TITLE
export function findTitleById(id) {
    const episode = globals.episodeIds.find(episode => episode.id === id);
    if (episode) {
        log("info", `Found TITLE for ID ${id}: ${episode.title}`);
        return episode.title;
    }
    log("error", `No TITLE found for ID: ${id}`);
    return null;
}

// 添加 anime 对象到 animes，并将其 links 添加到 episodeIds
// 替换后:
export async function addAnime(anime) {
    anime = Anime.fromJson(anime);
    try {
        // 确保 anime 有 links 属性且是数组
        if (!anime.links || !Array.isArray(anime.links)) {
            log("error", `Invalid or missing links in anime: ${JSON.stringify(anime)}`);
            return false;
        }

        // 🔥 检查是否已存在相同 animeId 的 anime
        const existingAnimeIndex = globals.animes.findIndex(a => a.animeId === anime.animeId);
        
        // 🔥 如果 anime 已存在,只更新其位置,不重新添加 episodeIds
        if (existingAnimeIndex !== -1) {
            const existingAnime = globals.animes[existingAnimeIndex];
            globals.animes.splice(existingAnimeIndex, 1);
            globals.animes.push(existingAnime);
            log("info", `Anime ${anime.animeId} already exists, moved to latest position (keeping existing episodeIds)`);
            return true;
        }

        // 🔥 只有新 anime 才添加 episodeIds
        const newLinks = [];
        anime.links.forEach(link => {
            if (link.url) {
                const episode = addEpisode(link.url, link.title);
                if (episode) {
                    newLinks.push(episode);
                }
            } else {
                log("error", `Invalid link in anime, missing url: ${JSON.stringify(link)}`);
            }
        });

        // 创建新的 anime 副本
        const animeCopy = Anime.fromJson({ ...anime, links: newLinks });

        // 将新的添加到数组末尾(最新位置)
        globals.animes.push(animeCopy);
        log("info", `Added anime to latest position: ${anime.animeId}`);

        // 检查是否超过 MAX_ANIMES,超过则删除最早的
        if (globals.animes.length > globals.MAX_ANIMES) {
            const removeSuccess = removeEarliestAnime();
            if (!removeSuccess) {
                log("error", "Failed to remove earliest anime, but continuing");
            }
        }

        log("info", `animes: ${JSON.stringify(
          globals.animes,
          (key, value) => key === 'links' ? value.length : value
        )}`);

        // 🔥 同步到数据库
        if (globals.databaseValid) {
            try {
                const { saveCacheBatch } = await import('./db-util.js');
                await saveCacheBatch({
                    animes: globals.animes,
                    episodeIds: globals.episodeIds,
                    episodeNum: globals.episodeNum
                });
                log("info", `[cache] ✅ anime数据已同步到数据库`);
            } catch (error) {
                log("warn", `[cache] 数据库同步失败: ${error.message}`);
            }
        }

        return true;
    } catch (error) {
        log("error", `addAnime failed: ${error.message}`);
        return false;
    }
}

// 删除最早添加的 anime，并从 episodeIds 删除其 links 中的 url
export function removeEarliestAnime() {
    if (globals.animes.length === 0) {
        log("error", "No animes to remove.");
        return false;
    }

    // 移除最早的 anime（第一个元素）
    const removedAnime = globals.animes.shift();
    log("info", `Removed earliest anime: ${JSON.stringify(removedAnime)}`);

    // 从 episodeIds 删除该 anime 的所有 links 中的 url
    if (removedAnime.links && Array.isArray(removedAnime.links)) {
        removedAnime.links.forEach(link => {
            if (link.url) {
                removeEpisodeByUrl(link.url);
            }
        });
    }

    return true;
}

// 将所有动漫的 animeId 存入 lastSelectMap 的 animeIds 数组中
export async function storeAnimeIdsToMap(curAnimes, key) {
    const uniqueAnimeIds = new Set();
    for (const anime of curAnimes) {
        uniqueAnimeIds.add(anime.animeId);
    }

    // 保存旧的prefer值
    const oldValue = globals.lastSelectMap.get(key);
    const oldPrefer = oldValue?.prefer;

    // 如果key已存在，先删除它（为了更新顺序，保证 FIFO）
    if (globals.lastSelectMap.has(key)) {
        globals.lastSelectMap.delete(key);
    }

    // 添加新记录，保留prefer字段
    globals.lastSelectMap.set(key, {
        animeIds: [...uniqueAnimeIds],
        ...(oldPrefer !== undefined && { prefer: oldPrefer })
    });

    // 检查是否超过 MAX_LAST_SELECT_MAP，超过则删除最早的
    if (globals.lastSelectMap.size > globals.MAX_LAST_SELECT_MAP) {
        const firstKey = globals.lastSelectMap.keys().next().value;
        globals.lastSelectMap.delete(firstKey);
        log("info", `Removed earliest entry from lastSelectMap: ${firstKey}`);
    }

    // 🔥 同步到数据库
    if (globals.databaseValid) {
        try {
            const { saveCacheData } = await import('./db-util.js');
            await saveCacheData('lastSelectMap', Object.fromEntries(globals.lastSelectMap));
            log("info", `[cache] ✅ lastSelectMap已同步到数据库`);
        } catch (error) {
            log("warn", `[cache] 数据库同步失败: ${error.message}`);
        }
    }
}

// 根据给定的 commentId 查找对应的 animeId
export function findAnimeIdByCommentId(commentId) {
  for (const anime of globals.animes) {
    for (const link of anime.links) {
      if (link.id === commentId) {
        return anime.animeId;
      }
    }
  }
  return null;
}

// 通过 animeId 查找 lastSelectMap 中 animeIds 包含该 animeId 的 key，并设置其 prefer 为 animeId
export function setPreferByAnimeId(animeId) {
  for (const [key, value] of globals.lastSelectMap.entries()) {
    if (value.animeIds && value.animeIds.includes(animeId)) {
      value.prefer = animeId;
      globals.lastSelectMap.set(key, value); // 确保更新被保存
      return key; // 返回被修改的 key
    }
  }
  return null; // 如果没有找到匹配的 key，返回 null
}

// 通过title查询优选animeId
export function getPreferAnimeId(title) {
  const value = globals.lastSelectMap.get(title);
  if (!value || !value.prefer) {
    return null;
  }
  return value.prefer;
}

// 清理所有过期的 IP 记录（超过 1 分钟没有请求的 IP）
export function cleanupExpiredIPs(currentTime) {
  const oneMinute = 60 * 1000;
  let cleanedCount = 0;

  for (const [ip, timestamps] of globals.requestHistory.entries()) {
    const validTimestamps = timestamps.filter(ts => currentTime - ts <= oneMinute);
    if (validTimestamps.length === 0) {
      globals.requestHistory.delete(ip);
      cleanedCount++;
      log("info", `[Rate Limit] Cleaned up expired IP record: ${ip}`);
    } else if (validTimestamps.length < timestamps.length) {
      globals.requestHistory.set(ip, validTimestamps);
    }
  }

  if (cleanedCount > 0) {
    log("info", `[Rate Limit] Cleanup completed: removed ${cleanedCount} expired IP records`);
  }
}