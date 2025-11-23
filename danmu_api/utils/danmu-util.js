import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { jsonResponse, xmlResponse } from "./http-util.js";

// =====================
// danmu处理相关函数
// =====================

export function groupDanmusByMinute(filteredDanmus, n) {
  // 如果 n 为 0,直接返回原始数据
  if (n === 0) {
    return filteredDanmus.map(danmu => ({
      ...danmu,
      t: danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0])
    }));
  }

  // 按 n 分钟分组
  const groupedByMinute = filteredDanmus.reduce((acc, danmu) => {
    // 获取时间:优先使用 t 字段,如果没有则使用 p 的第一个值
    const time = danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0]);
    // 计算分组(每 n 分钟一组,向下取整)
    const group = Math.floor(time / (n * 60));

    // 初始化分组
    if (!acc[group]) {
      acc[group] = [];
    }

    // 添加到对应分组
    acc[group].push({ ...danmu, t: time });
    return acc;
  }, {});

  // 处理每组的弹幕
  const result = Object.keys(groupedByMinute).map(group => {
    const danmus = groupedByMinute[group];

    // 按消息内容分组
    const groupedByMessage = danmus.reduce((acc, danmu) => {
      const message = danmu.m.split(' X')[0]; // 提取原始消息(去除 Xn 后缀)
      if (!acc[message]) {
        acc[message] = {
          count: 0,
          earliestT: danmu.t,
          cid: danmu.cid,
          p: danmu.p
        };
      }
      acc[message].count += 1;
      // 更新最早时间
      acc[message].earliestT = Math.min(acc[message].earliestT, danmu.t);
      return acc;
    }, {});

    // 转换为结果格式
    return Object.keys(groupedByMessage).map(message => {
      const data = groupedByMessage[message];
      return {
        cid: data.cid,
        p: data.p,
        m: data.count > 1 ? `${message} x ${data.count}` : message,
        t: data.earliestT
      };
    });
  });

  // 展平结果并按时间排序
  return result.flat().sort((a, b) => a.t - b.t);
}

/**
 * 等间隔采样限制弹幕数量
 * @param {Array} danmus 弹幕数组
 * @param {number} limit 限制数量
 * @returns {Array} 限制后的弹幕数组
 */
export function limitDanmusEvenly(danmus, limit) {
  if (!danmus || danmus.length === 0 || limit <= 0) {
    return danmus;
  }

  // 如果弹幕数量小于等于限制，直接返回
  if (danmus.length <= limit) {
    return danmus;
  }

  // 计算采样间隔
  const interval = danmus.length / limit;
  const result = [];

  // 等间隔采样
  for (let i = 0; i < limit; i++) {
    const index = Math.floor(i * interval);
    result.push(danmus[index]);
  }

  log("info", `[Danmu Limit] Original: ${danmus.length}, Limited: ${result.length}, Interval: ${interval.toFixed(2)}`);

  return result;
}

export function convertToDanmakuJson(contents, platform) {
  let danmus = [];
  let cidCounter = 1;

  // 统一处理输入为数组
  let items = [];
  if (typeof contents === "string") {
    // 处理 XML 字符串
    items = [...contents.matchAll(/<d p="([^"]+)">([^<]+)<\/d>/g)].map(match => ({
      p: match[1],
      m: match[2]
    }));
  } else if (contents && Array.isArray(contents.danmuku)) {
    // 处理 danmuku 数组,映射为对象格式
    const typeMap = { right: 1, top: 4, bottom: 5 };
    const hexToDecimal = (hex) => (hex ? parseInt(hex.replace("#", ""), 16) : 16777215);
    items = contents.danmuku.map(item => ({
      timepoint: item[0],
      ct: typeMap[item[1]] !== undefined ? typeMap[item[1]] : 1,
      color: hexToDecimal(item[2]),
      content: item[4]
    }));
  } else if (Array.isArray(contents)) {
    // 处理标准对象数组
    items = contents;
  }

  if (!items.length) {
    // 如果是空数组,直接返回空数组,不抛出异常
    // 这样可以让兜底逻辑有机会执行
    return [];
  }

  for (const item of items) {
    let attributes, m;
    let time, mode, color;

    // 新增:处理新格式的弹幕数据
    if ("progress" in item && "mode" in item && "content" in item) {
      // 处理新格式的弹幕对象
      time = parseFloat((item.progress / 1000).toFixed(2));
      mode = item.mode || 1;
      color = item.color || 16777215;
      m = item.content;
    } else if ("timepoint" in item) {
      // 处理对象数组输入
      time = parseFloat(parseFloat(item.timepoint).toFixed(2));
      mode = item.ct || 0;
      color = item.color || 16777215;
      m = item.content;
    } else {
      if (!("p" in item)) {
        continue;
      }
      // 处理 XML 解析后的格式
      const pValues = item.p.split(",");
      time = parseFloat(parseFloat(pValues[0]).toFixed(2));
      mode = pValues[1] || 0;
      // 支持多种格式的 p 属性
      // 旧格式(4字段):时间,类型,颜色,来源
      // 标准格式(8字段):时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
      // Bilibili格式(9字段):时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID,权重
      if (pValues.length === 4) {
        // 旧格式
        color = pValues[2] || 16777215;
      } else if (pValues.length >= 8) {
        // 新标准格式(8字段或9字段)
        color = pValues[3] || pValues[2] || 16777215;
      } else {
        // 其他格式,尝试从第3或第4位获取颜色
        color = pValues[3] || pValues[2] || 16777215;
      }
      m = item.m;
    }

    attributes = [
      time,
      mode,
      color,
      `[${platform}]`
    ].join(",");

    danmus.push({ p: attributes, m, cid: cidCounter++ });
  }

  // 🔥 优化：缓存正则表达式对象，避免每次重新编译
  if (!globals._cachedBlockedRegexArray || globals._lastBlockedWordsHash !== globals.blockedWords) {
    // 只有当 blockedWords 改变时才重新编译正则
    globals._cachedBlockedRegexArray = globals.blockedWords.split(/(?<=\/),(?=\/)/).map(str => {
      const pattern = str.trim();
      if (pattern.startsWith('/') && pattern.endsWith('/')) {
        try {
          return new RegExp(pattern.slice(1, -1));
        } catch (e) {
          log("error", `无效的正则表达式: ${pattern}`, e);
          return null;
        }
      }
      return null;
    }).filter(regex => regex !== null);

    globals._lastBlockedWordsHash = globals.blockedWords;

    log("info", `原始屏蔽词字符串: ${globals.blockedWords}`);
    const regexArrayToString = array => Array.isArray(array) ? array.map(regex => regex.toString()).join('\n') : String(array);
    log("info", `屏蔽词列表已缓存: ${regexArrayToString(globals._cachedBlockedRegexArray)}`);
  }

  const regexArray = globals._cachedBlockedRegexArray;

  // 🔥 优化：提前终止匹配，减少不必要的正则测试
  const filteredDanmus = danmus.filter(item => {
    const message = item.m;
    // 优先匹配最常见的模式（如长度检查）
    if (message.length >= 25) return false; // 第一个正则是长度检查

    // 然后再执行完整的正则匹配
    for (let i = 1; i < regexArray.length; i++) {
      if (regexArray[i].test(message)) return false;
    }
    return true;
  });

  log("info", `去重分钟数: ${globals.groupMinute}`);
  const groupedDanmus = groupDanmusByMinute(filteredDanmus, globals.groupMinute);

  log("info", `danmus_original: ${danmus.length}`);
  log("info", `danmus_filter: ${filteredDanmus.length}`);
  log("info", `danmus_group: ${groupedDanmus.length}`);

  // ========== 修改：先限制弹幕数量，再进行颜色转换 ==========
  let limitedDanmus = groupedDanmus;

  if (globals.danmuLimit > 0 && groupedDanmus.length > globals.danmuLimit) {
    limitedDanmus = limitDanmusEvenly(groupedDanmus, globals.danmuLimit);
    log("info", `danmus_limited: ${limitedDanmus.length} (from ${groupedDanmus.length})`);
  }

  // 应用弹幕转换规则(在限制数量之后)
  let finalDanmus = limitedDanmus;

  // 获取白色弹幕占比
  const whiteRatio = parseInt(globals.whiteRatio);
  log("info", `[DEBUG] whiteRatio from globals: ${globals.whiteRatio}`);
  log("info", `[DEBUG] Final whiteRatio: ${whiteRatio}`);

  // 只有当 whiteRatio 在 0-100 之间时才执行颜色转换
  if (whiteRatio >= 0 && whiteRatio <= 100) {
    // 统计计数器
    let topBottomCount = 0;
    let colorToWhiteCount = 0;
    let whiteToColorCount = 0;
    let colorKeptCount = 0;
    let whiteKeptCount = 0;

    // 定义彩色弹幕的颜色池
    const colorPalette = [
      16711680,  // 红色 #FF0000
      16744192,  // 橙色 #FF8000
      16776960,  // 黄色 #FFFF00
      65280,     // 绿色 #00FF00
      65535,     // 青色 #00FFFF
      255,       // 蓝色 #0000FF
      10494192,  // 紫色 #A020F0
      16711935,  // 粉色 #FF00FF
      16488046,  // 浅粉 #FB7299
      52479,     // 天蓝 #00CCFF
    ];

    finalDanmus = limitedDanmus.map(danmu => {
      const pValues = danmu.p.split(',');
      if (pValues.length < 3) {
        log("warn", `Invalid danmu format: ${danmu.p}`);
        return danmu;
      }

      let mode = parseInt(pValues[1], 10);
      let color = parseInt(pValues[2], 10);
      let modified = false;

      // 1. 将顶部/底部弹幕转换为滚动弹幕
      if (mode === 4 || mode === 5) {
        topBottomCount++;
        mode = 1;
        modified = true;
      }

      // 2. 颜色转换逻辑
      // whiteRatio = 100: 全部转为白色
      // whiteRatio = 0: 全部转为彩色
      // whiteRatio = 50: 50%白色,50%彩色
      if (whiteRatio === 100) {
        // 全部转为白色
        if (color !== 16777215) {
          colorToWhiteCount++;
          color = 16777215;
          modified = true;
        }
      } else if (whiteRatio === 0) {
        // 全部转为彩色
        if (color === 16777215) {
          whiteToColorCount++;
          color = colorPalette[Math.floor(Math.random() * colorPalette.length)];
          modified = true;
        }
      } else {
        // 根据占比进行转换
        const convertToWhiteProb = whiteRatio / 100;

        if (color !== 16777215) {
          // 彩色弹幕:按概率转为白色
          if (Math.random() < convertToWhiteProb) {
            colorToWhiteCount++;
            color = 16777215;
            modified = true;
          } else {
            colorKeptCount++;
          }
        } else {
          // 白色弹幕:按概率转为彩色
          if (Math.random() < (1 - convertToWhiteProb)) {
            whiteToColorCount++;
            color = colorPalette[Math.floor(Math.random() * colorPalette.length)];
            modified = true;
          } else {
            whiteKeptCount++;
          }
        }
      }

      // 如果有修改,重新构建 p 属性
      if (modified) {
        pValues[1] = mode.toString();
        pValues[2] = color.toString();
        const newP = pValues.join(',');
        return { ...danmu, p: newP };
      }

      return danmu;
    });

    // 统计输出转换结果
    log("info", `[Color Conversion Stats]`);
    log("info", `  - Top/Bottom→Scroll: ${topBottomCount}`);
    log("info", `  - Color→White: ${colorToWhiteCount}`);
    log("info", `  - White→Color: ${whiteToColorCount}`);
    log("info", `  - Color kept: ${colorKeptCount}`);
    log("info", `  - White kept: ${whiteKeptCount}`);
  } else {
    log("info", `[Color Conversion] Skipped (whiteRatio=${whiteRatio}, not in 0-100 range)`);
  }

  // 输出前五条弹幕
  log("info", "Top 5 danmus:", JSON.stringify(finalDanmus.slice(0, 5), null, 2));
  return finalDanmus;
}

// RGB 转整数的函数
export function rgbToInt(color) {
  // 检查 RGB 值是否有效
  if (
    typeof color.r !== 'number' || color.r < 0 || color.r > 255 ||
    typeof color.g !== 'number' || color.g < 0 || color.g > 255 ||
    typeof color.b !== 'number' || color.b < 0 || color.b > 255
  ) {
    return -1;
  }
  return color.r * 256 * 256 + color.g * 256 + color.b;
}

// 将弹幕 JSON 数据转换为 XML 格式(Bilibili 标准格式)
export function convertDanmuToXml(danmuData) {
  let xml = '<?xml version="1.0" ?>\n';
  xml += '<i>\n';

  // 添加弹幕数据
  const comments = danmuData.comments || [];
  if (Array.isArray(comments)) {
    for (const comment of comments) {
      // 解析原有的 p 属性,转换为 Bilibili 格式
      const pValue = buildBilibiliDanmuP(comment);
      xml += '    <d p="' + escapeXmlAttr(pValue) + '">' + escapeXmlText(comment.m) + '</d>\n';
    }
  }

  xml += '</i>';
  return xml;
}

// 生成弹幕ID(11位数字)
function generateDanmuId() {
  // 生成11位数字ID
  // 格式: 时间戳后8位 + 随机3位
  const timestamp = Date.now();
  const lastEightDigits = (timestamp % 100000000).toString().padStart(8, '0');
  const randomThreeDigits = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return lastEightDigits + randomThreeDigits;
}

// 构建 Bilibili 格式的 p 属性值（8个字段）
function buildBilibiliDanmuP(comment) {
  // Bilibili 格式: 时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
  // 示例: 5.0,5,25,16488046,1751533608,0,0,13190629936

  const pValues = comment.p.split(',');
  const timeNum = parseFloat(pValues[0]) || 0;
  const time = timeNum.toFixed(1); // 时间（秒，保留1位小数）
  const mode = pValues[1] || '1'; // 类型（1=滚动, 4=底部, 5=顶部）
  const fontSize = '25'; // 字体大小（25=中, 18=小）

  // 颜色字段（输入总是4字段格式：时间,类型,颜色,平台）
  const color = pValues[2] || '16777215'; // 默认白色

  // 使用固定值以符合标准格式
  const timestamp = '1751533608'; // 固定时间戳
  const pool = '0'; // 弹幕池（固定为0）
  const userHash = '0'; // 用户Hash（固定为0）
  const danmuId = generateDanmuId(); // 弹幕ID（11位数字）

  return `${time},${mode},${fontSize},${color},${timestamp},${pool},${userHash},${danmuId}`;
}

// 转义 XML 属性值
function escapeXmlAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 转义 XML 文本内容
function escapeXmlText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 根据格式参数返回弹幕数据（JSON 或 XML）
export function formatDanmuResponse(danmuData, queryFormat) {
  // 确定最终使用的格式：查询参数 > 环境变量 > 默认值
  let format = queryFormat || globals.danmuOutputFormat;
  format = format.toLowerCase();

  log("info", `[Format] Using format: ${format}`);

  if (format === 'xml') {
    try {
      const xmlData = convertDanmuToXml(danmuData);
      return xmlResponse(xmlData);
    } catch (error) {
      log("error", `Failed to convert to XML: ${error.message}`);
      // 转换失败时回退到 JSON
      return jsonResponse(danmuData);
    }
  }

  // 默认返回 JSON
  return jsonResponse(danmuData);
}