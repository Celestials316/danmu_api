import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { jsonResponse, xmlResponse } from "./http-util.js";

// =====================
// danmu处理相关函数
// =====================

export function groupDanmusByMinute(filteredDanmus, n) {
  // 如果 n 为 0，直接返回原始数据
  if (n === 0) {
    return filteredDanmus.map(danmu => ({
      ...danmu,
      t: danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0])
    }));
  }

  // 按 n 分钟分组
  const groupedByMinute = filteredDanmus.reduce((acc, danmu) => {
    // 获取时间：优先使用 t 字段，如果没有则使用 p 的第一个值
    const time = danmu.t !== undefined ? danmu.t : parseFloat(danmu.p.split(',')[0]);
    // 计算分组（每 n 分钟一组，向下取整）
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
      const message = danmu.m.split(' X')[0]; // 提取原始消息（去除 Xn 后缀）
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
    // 处理 danmuku 数组，映射为对象格式
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
    // 如果是空数组，直接返回空数组，不抛出异常
    // 这样可以让兜底逻辑有机会执行
    return [];
  }

  for (const item of items) {
    let attributes, m;
    let time, mode, color;

    // 新增：处理新格式的弹幕数据
    if ("progress" in item && "mode" in item && "content" in item) {
      // 处理新格式的弹幕对象
      time = (item.progress / 1000).toFixed(2);
      mode = item.mode || 1;
      color = item.color || 16777215;
      m = item.content;
    } else if ("timepoint" in item) {
      // 处理对象数组输入
      time = parseFloat(item.timepoint).toFixed(2);
      mode = item.ct || 0;
      color = item.color || 16777215;
      m = item.content;
    } else {
      if (!("p" in item)) {
        continue;
      }
      // 处理 XML 解析后的格式
      const pValues = item.p.split(",");
      time = parseFloat(pValues[0]).toFixed(2);
      mode = pValues[1] || 0;

      // 支持多种格式的 p 属性
      // 旧格式（4字段）：时间,类型,颜色,来源
      // 标准格式（8字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
      // Bilibili格式（9字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID,权重
      if (pValues.length === 4) {
        // 旧格式
        color = pValues[2] || 16777215;
      } else if (pValues.length >= 8) {
        // 新标准格式（8字段或9字段）
        color = pValues[3] || 16777215;
      } else {
        // 其他格式，尝试从第3或第4位获取颜色
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

  // 切割字符串成正则表达式数组
  const regexArray = globals.blockedWords.split(/(?<=\/),(?=\/)/).map(str => {
    // 去除两端的斜杠并转换为正则对象
    const pattern = str.trim();
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        // 去除两边的 `/` 并转化为正则
        return new RegExp(pattern.slice(1, -1));
      } catch (e) {
        log("error", `无效的正则表达式: ${pattern}`, e);
        return null;
      }
    }
    return null; // 如果不是有效的正则格式则返回 null
  }).filter(regex => regex !== null); // 过滤掉无效的项

  log("info", `原始屏蔽词字符串: ${globals.blockedWords}`);
  const regexArrayToString = array => Array.isArray(array) ? array.map(regex => regex.toString()).join('\n') : String(array);
  log("info", `屏蔽词列表: ${regexArrayToString(regexArray)}`);

  // 过滤列表
  const filteredDanmus = danmus.filter(item => {
    return !regexArray.some(regex => regex.test(item.m)); // 针对 `m` 字段进行匹配
  });

  log("info", `去重分钟数: ${globals.groupMinute}`);
  const groupedDanmus = groupDanmusByMinute(filteredDanmus, globals.groupMinute);

// 应用弹幕转换规则（在去重之后）
  let convertedDanmus = groupedDanmus;

// 获取颜色转换模式：default/toWhite/toColor
  const colorMode = globals.danmuColorMode || 'default';
  log("info", `[DEBUG] danmuColorMode from globals: ${globals.danmuColorMode}`);
  log("info", `[DEBUG] Final colorMode: ${colorMode}`);
  log("info", `[DEBUG] convertTopBottomToScroll: ${globals.convertTopBottomToScroll}`);

  if (globals.convertTopBottomToScroll || colorMode !== 'default') {
    log("info", `[DEBUG] Entering color conversion logic...`);
  // ... 后面的代码
    let topBottomCount = 0;
    let colorToWhiteCount = 0;
    let whiteToColorCount = 0;
    let colorKeptCount = 0; // 保留的彩色弹幕数
    let whiteKeptCount = 0; // 保留的白色弹幕数

    // 定义彩色弹幕的颜色池
    const colorPalette = [
      0xFF6B9D,  // 粉色
      0x00D0FF,  // 天蓝
      0xFFA500,  // 橙色
      0x7FFF00,  // 春绿
      0xFF1493,  // 深粉
      0x00CED1,  // 深青
      0xFFD700,  // 金色
      0x9370DB,  // 紫色
      0xFF69B4,  // 热粉
      0x87CEEB,  // 天空蓝
      0xFFB6C1,  // 浅粉
      0x98FB98   // 浅绿
    ];

    convertedDanmus = groupedDanmus.map(danmu => {
      const pValues = danmu.p.split(',');
      if (pValues.length < 3) return danmu;

      let mode = parseInt(pValues[1], 10);
      let color = parseInt(pValues[2], 10);
      let modified = false;

      // 1. 将顶部/底部弹幕转换为浮动弹幕
      if (globals.convertTopBottomToScroll && (mode === 4 || mode === 5)) {
        topBottomCount++;
        mode = 1;
        modified = true;
      }

      // 2. 颜色转换逻辑
      if (colorMode === 'toWhite') {
        // 彩色转白色模式（保留20%的彩色）
        if (color !== 16777215) {
          // 80%概率转为白色，20%保持彩色
          if (Math.random() < 0.8) {
            colorToWhiteCount++;
            color = 16777215;
            modified = true;
          } else {
            colorKeptCount++;
          }
        }
      } else if (colorMode === 'toColor') {
        // 白色转彩色模式（保留20%的白色）
        if (color === 16777215) {
          // 80%概率转为彩色，20%保持白色
          if (Math.random() < 0.8) {
            whiteToColorCount++;
            color = colorPalette[Math.floor(Math.random() * colorPalette.length)];
            modified = true;
          } else {
            whiteKeptCount++;
          }
        }
      }

      if (modified) {
        const newP = [pValues[0], mode, color, ...pValues.slice(3)].join(',');
        return { ...danmu, p: newP };
      }
      return danmu;
    });

    // 统计输出转换结果
    if (topBottomCount > 0) {
      log("info", `[danmu convert] 转换了 ${topBottomCount} 条顶部/底部弹幕为浮动弹幕`);
    }
    
    if (colorMode === 'toWhite') {
      log("info", `[danmu convert] 彩转白模式: 转换了 ${colorToWhiteCount} 条彩色→白色, 保留了 ${colorKeptCount} 条彩色`);
    } else if (colorMode === 'toColor') {
      log("info", `[danmu convert] 白转彩模式: 转换了 ${whiteToColorCount} 条白色→彩色, 保留了 ${whiteKeptCount} 条白色`);
    }
  }

  log("info", `danmus_original: ${danmus.length}`);
  log("info", `danmus_filter: ${filteredDanmus.length}`);
  log("info", `danmus_group: ${groupedDanmus.length}`);
  // 输出前五条弹幕
  log("info", "Top 5 danmus:", JSON.stringify(convertedDanmus.slice(0, 5), null, 2));
  return convertedDanmus;
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

// 将弹幕 JSON 数据转换为 XML 格式（Bilibili 标准格式）
export function convertDanmuToXml(danmuData) {
  let xml = '<?xml version="1.0" ?>\n';
  xml += '<i>\n';

  // 添加弹幕数据
  const comments = danmuData.comments || [];
  if (Array.isArray(comments)) {
    for (const comment of comments) {
      // 解析原有的 p 属性，转换为 Bilibili 格式
      const pValue = buildBilibiliDanmuP(comment);
      xml += '    <d p="' + escapeXmlAttr(pValue) + '">' + escapeXmlText(comment.m) + '</d>\n';
    }
  }

  xml += '</i>';
  return xml;
}

// 生成弹幕ID（11位数字）
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
