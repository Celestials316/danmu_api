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
 * 智能削峰限制弹幕数量 (优化版 Water-Filling 算法 - 秒级精度)
 * 目标: 让每秒的弹幕量尽量均匀，削减高峰期，保留低谷期，总和接近limit
 * 
 * 优化点:
 * - 减少不必要的排序操作
 * - 使用更高效的数据结构
 * - 优化时间复杂度从 O(n²) 到 O(n log n)
 * - 改用秒级分桶以提高精度
 * 
 * @param {Array} danmus 弹幕数组
 * @param {number} limit 限制数量
 * @returns {Array} 限制后的弹幕数组
 */
export function limitDanmusEvenly(danmus, limit) {
  // ===== 边界检查 =====
  if (!danmus || danmus.length === 0 || limit <= 0) {
    return danmus || [];
  }

  if (danmus.length <= limit) {
    return danmus;
  }

  // ===== 第一步: 按秒分桶（使用普通对象代替 Map 以提升性能）=====
  const secondBuckets = {};
  const getTime = (item) => item.t !== undefined ? item.t : parseFloat(item.p.split(',')[0]);
  
  for (let i = 0; i < danmus.length; i++) {
    const item = danmus[i];
    const second = Math.floor(getTime(item));
    
    if (!secondBuckets[second]) {
      secondBuckets[second] = [];
    }
    secondBuckets[second].push(item);
  }

  // 提取秒键并排序（只排序一次）
  const sortedSeconds = Object.keys(secondBuckets).map(Number).sort((a, b) => a - b);
  const bucketSizes = sortedSeconds.map(s => secondBuckets[s].length);
  const totalBuckets = sortedSeconds.length;

  // ===== 第二步: 二分查找最优 Cap 值 =====
  // 目标: 找到最大的 Cap，使得 sum(min(每秒弹幕数, Cap)) <= limit
  let low = 1;
  let high = Math.max(...bucketSizes);
  let optimalCap = 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    
    // 快速计算当前 Cap 下的总弹幕数
    let sum = 0;
    for (let i = 0; i < totalBuckets; i++) {
      sum += Math.min(bucketSizes[i], mid);
      if (sum > limit) break; // 提前终止
    }

    if (sum <= limit) {
      optimalCap = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // ===== 第三步: 根据 Cap 值收集弹幕 =====
  const result = [];
  
  for (let i = 0; i < totalBuckets; i++) {
    const second = sortedSeconds[i];
    const bucket = secondBuckets[second];
    const bucketSize = bucket.length;
    
    if (bucketSize <= optimalCap) {
      // 该秒弹幕数 <= Cap，全部保留
      result.push(...bucket);
    } else {
      // 该秒弹幕数 > Cap，等间隔采样
      const step = bucketSize / optimalCap;
      for (let j = 0; j < optimalCap; j++) {
        const index = Math.floor(j * step);
        result.push(bucket[index]);
      }
    }
  }

  // ===== 第四步: 最终排序（只排序一次）=====
  result.sort((a, b) => {
    const ta = getTime(a);
    const tb = getTime(b);
    return ta - tb;
  });

  // ===== 日志输出 =====
  log("info", 
    `[Danmu Limit] Optimized (Second-level): ` +
    `Cap/Sec ≈ ${optimalCap}, ` +
    `Buckets: ${totalBuckets}, ` +
    `Original: ${danmus.length}, ` +
    `Limited: ${result.length}`
  );

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

    // 修复 HTML 实体编码的表情及转换多平台文本表情
    if (m) {
      m = m.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(dec));

      // 多平台通用表情映射表 (B站/腾讯/爱奇艺/优酷/芒果/抖音/快手等)
      const emojiMap = {
        // ========================
        // 1. 通用/QQ系/腾讯视频 (最常用)
        // ========================
        "微笑": "🙂", "撇嘴": "😟", "色": "😍", "发呆": "😶",
        "得意": "😎", "流泪": "😭", "害羞": "😳", "闭嘴": "🤐",
        "睡": "😴", "大哭": "😭", "尴尬": "😅", "发怒": "😡",
        "调皮": "😜", "呲牙": "😁", "惊讶": "😲", "难过": "☹️",
        "酷": "😎", "冷汗": "😓", "抓狂": "😫", "吐": "🤮",
        "偷笑": "🤭", "可爱": "🥰", "白眼": "🙄", "傲慢": "😏",
        "饥饿": "😋", "困": "😪", "惊恐": "😱", "流汗": "😓",
        "憨笑": "😄", "大兵": "💂", "奋斗": "💪", "咒骂": "🤬",
        "疑问": "❓", "嘘": "🤫", "晕": "😵", "折磨": "😖",
        "衰": "🥀", "骷髅": "💀", "敲打": "🔨", "再见": "👋",
        "擦汗": "😓", "抠鼻": "👃", "鼓掌": "👏", "糗大了": "😵",
        "坏笑": "😈", "左哼哼": "😤", "右哼哼": "😤", "哈欠": "🥱",
        "鄙视": "👎", "委屈": "🥺", "快哭了": "😿", "阴险": "😈",
        "亲亲": "😘", "吓": "😱", "可怜": "🥺", "菜刀": "🔪",
        "西瓜": "🍉", "啤酒": "🍺", "篮球": "🏀", "乒乓": "🏓",
        "咖啡": "☕", "饭": "🍚", "猪头": "🐷", "玫瑰": "🌹",
        "凋谢": "🥀", "示爱": "💋", "爱心": "❤️", "心碎": "💔",
        "蛋糕": "🎂", "闪电": "⚡", "炸弹": "💣", "刀": "🔪",
        "足球": "⚽", "瓢虫": "🐞", "便便": "💩", "月亮": "🌙",
        "太阳": "☀️", "礼物": "🎁", "拥抱": "🫂", "强": "💪",
        "弱": "👎", "握手": "🤝", "胜利": "✌️", "抱拳": "🙏",
        "勾引": "🤙", "拳头": "👊", "差劲": "👎", "爱你": "🤟",
        "NO": "🙅", "OK": "👌", "好的": "👌", "给力": "💪", "飞吻": "😘",
        "跳跳": "💃", "发抖": "🥶", "怄火": "😠", "转圈": "💫",
        "磕头": "🙇", "回头": "🔙", "跳绳": "🏃", "挥手": "👋",
        "激动": "🤩", "街舞": "🕺", "献吻": "😘", "左太极": "☯️",
        "右太极": "☯️", "双喜": "㊗️", "鞭炮": "🧨", "灯笼": "🏮",
        "K歌": "🎤", "发财": "💰", "福": "🧧", "麻将": "🀄",
        "啤酒": "🍺", "干杯": "🍻", "庆祝": "🎉", "炸弹": "💣",
        "刀": "🔪", "手枪": "🔫", "青蛙": "🐸", "猪": "🐷",
        "熊猫": "🐼", "兔子": "🐰", "小鸡": "🐤", "幽灵": "👻",
        "圣诞": "🎅", "外星": "👽", "钻石": "💎", "礼物": "🎁",
        "铃铛": "🔔", "蛋糕": "🎂", "音乐": "🎵", "便便": "💩",
        "药": "💊", "针筒": "💉", "红包": "🧧", "发": "💰",

        // ========================
        // 2. Bilibili 特有/热词
        // ========================
        "笑哭": "😂", "喜极": "😂", "吃瓜": "🍉", "妙啊": "😏",
        "滑稽": "😏", "奸笑": "😏", "呆": "😐", "无语": "😑",
        "生病": "😷", "辣眼睛": "🙈", "歪嘴": "😏", "星星眼": "🤩",
        "酸了": "🍋", "黑脸": "😒", "喝茶": "🍵", "剪刀手": "✌️",
        "dog": "🐶", "狗头": "🐶", "保命": "🐶", "doge": "🐶",
        "tv_dog": "🐶", "热词系列_dog": "🐶", "狗": "🐶",
        "猫头": "🐱", "tv_cat": "🐱", "打call": "📣",
        "高能": "⚡", "前方高能": "⚡", "跪": "🧎", "跪了": "🧎",
        "小电视_笑": "📺", "tv_smile": "📺",
        "小电视_哭": "📺", "tv_cry": "📺",
        "小电视_吃瓜": "🍉", "tv_melon": "🍉",
        "灵魂出窍": "👻", "幽灵": "👻",
        "热词系列_知识增加": "📚", "知识增加": "📚",
        "热词系列_三连": "👍", "三连": "👍", "一键三连": "👍",
        "热词系列_好耶": "🎉", "好耶": "🎉",
        "热词系列_泪目": "😭", "泪目": "😭",
        "热词系列_爱了": "❤️", "爱了": "❤️", "爱了爱了": "❤️",
        "热词系列_可以": "👌", "可以": "👌",
        "热词系列_打卡": "📍", "打卡": "✅",
        "热词系列_破防": "💔", "破防": "💔", "破防了": "💔",
        "热词系列_666": "👍", "666": "👍", "六六六": "👍",
        "热词系列_吹爆": "💥", "吹爆": "💥",
        "热词系列_问号": "❓", "问号": "❓", "黑人问号": "❓",
        "热词系列_大师球": "⚾", "大师球": "⚾",
        "热词系列_排面": "😎", "排面": "😎", "有排面": "😎",
        "热词系列_害怕": "😱", "害怕": "😱",
        "热词系列_AWSL": "😭", "AWSL": "😭", "awsl": "😭",
        "热词系列_奥力给": "💪", "奥力给": "💪",
        "热词系列_我不李姐": "🤷", "我不李姐": "🤷",
        "热词系列_真香": "🍚", "真香": "🍚",
        "热词系列_危": "⚠️", "危": "⚠️",
        "嗑瓜子": "🍉", "脱单": "💑", "单身": "🐶",
        "锦鲤": "🐟", "福利": "🎁", "红包": "🧧",
        "棒": "👍", "牛": "🐮", "牛啊": "🐮", "牛批": "🐮",
        "好家伙": "😲", "绝了": "👍", "绝绝子": "👍",
        "yyds": "🐮", "YYDS": "🐮", "永远的神": "🐮",
        "芭比Q": "🔥", "芭比Q了": "🔥", "完了": "😱",
        "社死": "💀", "栓Q": "😅", "栓q": "😅",
        "服了": "😓", "无语子": "😑", "整破防了": "💔",
        "小丑竟是我自己": "🤡", "小丑": "🤡",
        "裂开": "💔", "CPU": "🤯", "破大防": "💔",
        "纯良": "😇", "文明观猴": "🐵",
        "就这": "😏", "就这?": "😏",
        "爷青回": "😭", "爷青结": "😭",
        "爷的青春结束了": "😭", "爷的青春回来了": "😭",

        // ========================
        // 3. 优酷 (Youku) / 土豆
        // ========================
        "稀饭": "😍", "愤怒": "😡", "吐血": "🤮", "汗": "😓",
        "搞笑": "😆", "怒": "😡", "哭": "😭", "赞": "👍",
        "踩": "👎", "大笑": "😄", "偷笑": "🤭",
        "惊讶": "😲", "难过": "😞", "害羞": "😳", "闭嘴": "🤐",
        "无语": "😶", "困": "😴", "累": "😫", "睡觉": "😴",
        "加油": "💪", "求": "🙏", "拜拜": "👋", "顶": "👍",

        // ========================
        // 4. 爱奇艺 (iQIYI)
        // ========================
        "机智": "🤓", "如花": "🌸", "开心": "😄", "大笑": "😆",
        "热情": "🥰", "眨眼": "😉", "鄙视": "😒", "晕": "😵",
        "衰": "😔", "睡": "💤", "发呆": "😶", "尴尬": "😅",
        "吐": "🤮", "大哭": "😭", "流泪": "😢", "发怒": "😠",
        "惊讶": "😲", "奋斗": "💪", "胜利": "✌️", "赞": "👍",

        // ========================
        // 5. 芒果TV (Mango)
        // ========================
        "MG_喜爱": "😍", "MG_大笑": "😄", "MG_尴尬": "😅",
        "MG_生气": "😡", "MG_大哭": "😭", "MG_惊讶": "😲",
        "MG_无语": "😶", "MG_卖萌": "😜", "MG_委屈": "🥺",
        "MG_赞": "👍", "MG_踩": "👎", "MG_加油": "💪",

        // ========================
        // 6. 抖音/快手常用表情
        // ========================
        "点赞": "👍", "比心": "🫶", "送心": "💝", "玫瑰": "🌹",
        "赞": "👍", "加油": "💪", "666": "👍", "鼓掌": "👏",
        "握手": "🤝", "耶": "✌️", "OK": "👌", "加一": "➕",
        "机智": "🤓", "可爱": "🥰", "石化": "🗿", "捂脸": "🤦",
        "思考": "🤔", "吃惊": "😮", "尬": "😅", "无奈": "😑",
        "再见": "👋", "庆祝": "🎉", "烟花": "🎆", "气球": "🎈",
        "红包": "🧧", "钱": "💰", "发财": "💵", "福": "🧧",
        "玫瑰": "🌹", "爱心": "❤️", "心碎": "💔", "火": "🔥",
        "冰": "❄️", "雪": "⛄", "太阳": "☀️", "月亮": "🌙",
        "星星": "⭐", "彩虹": "🌈", "汗": "💦",

        // ========================
        // 7. 更多通用 Emoji 别名
        // ========================
        "笑脸": "😊", "微笑": "🙂", "哈哈": "😄", "哭笑": "😂",
        "笑死": "😂", "笑出声": "😆", "笑cry": "😂",
        "天使": "😇", "色色": "😍", "亲": "😘", "飞吻": "😘",
        "钦定": "😎", "墨镜": "😎", "面无表情": "😐",
        "无聊": "😑", "翻白眼": "🙄", "呆滞": "😶",
        "安慰": "🤗", "拥抱": "🫂", "想想": "🤔", "思考": "🤔",
        "嘴巴拉链": "🤐", "嘘": "🤫", "说谎": "🤥",
        "打哈欠": "🥱", "困死": "😪", "流口水": "🤤",
        "睡着": "😴", "口罩": "😷", "生病": "🤒", "发烧": "🤒",
        "受伤": "🤕", "恶心": "🤢", "吐": "🤮", "打喷嚏": "🤧",
        "牛仔": "🤠", "派对": "🥳", "伪装": "🥸",
        "戴眼镜": "🤓", "书呆子": "🤓",
        "恶魔笑": "😈", "恶魔": "👿", "骷髅": "💀", "鬼": "👻",
        "外星人": "👽", "机器人": "🤖", "粑粑": "💩",
        "红心": "❤️", "橙心": "🧡", "黄心": "💛", "绿心": "💚",
        "蓝心": "💙", "紫心": "💜", "棕心": "🤎", "黑心": "🖤",
        "白心": "🤍", "心动": "💓", "心跳": "💗", "心碎": "💔",
        "爱心箭": "💘", "💯": "💯", "火": "🔥", "冷": "🥶",
        "热": "🥵", "汗滴": "💦", "晕": "💫", "炸": "💥",
        "闪": "✨", "星": "⭐", "灯泡": "💡",

        // ========================
        // 8. 常见动物
        // ========================
        "猫": "🐱", "狗": "🐶", "熊": "🐻", "兔": "🐰",
        "鼠": "🐭", "虎": "🐯", "牛": "🐮", "猪": "🐷",
        "鸡": "🐔", "鸭": "🦆", "鸟": "🐦", "鱼": "🐟",
        "蜜蜂": "🐝", "蝴蝶": "🦋", "蜗牛": "🐌",
        "企鹅": "🐧", "猴": "🐵", "考拉": "🐨",

        // ========================
        // 9. 食物饮料
        // ========================
        "面": "🍜", "汉堡": "🍔", "薯条": "🍟", "披萨": "🍕",
        "热狗": "🌭", "寿司": "🍣", "便当": "🍱",
        "饺子": "🥟", "包子": "🥟", "米饭": "🍚",
        "面条": "🍜", "冰淇淋": "🍦", "甜甜圈": "🍩",
        "果汁": "🧃", "茶": "🍵", "奶茶": "🧋",
        "可乐": "🥤", "牛奶": "🥛", "酒": "🍷",
        "苹果": "🍎", "香蕉": "🍌", "葡萄": "🍇",
        "草莓": "🍓", "桃": "🍑", "柠檬": "🍋",

        // ========================
        // 10. 常见手势
        // ========================
        "点赞": "👍", "踩": "👎", "OK": "👌", "耶": "✌️",
        "拳": "👊", "拳头": "✊", "鼓掌": "👏",
        "合十": "🙏", "祈祷": "🙏", "握手": "🤝",
        "竖中指": "🖕", "招手": "👋", "比心": "🫰",
        "爱你": "🤟", "摇滚": "🤘", "写字": "✍️",
        "肌肉": "💪", "手指": "👉", "手指左": "👈",
        "手指上": "👆", "手指下": "👇",

        // ========================
        // 11. 运动/活动
        // ========================
        "足球": "⚽", "篮球": "🏀", "棒球": "⚾",
        "网球": "🎾", "台球": "🎱", "羽毛球": "🏸",
        "健身": "🏋️", "跑步": "🏃", "游泳": "🏊",
        "滑雪": "⛷️", "跳舞": "💃", "唱歌": "🎤",
        "吉他": "🎸", "钢琴": "🎹", "游戏": "🎮",

        // ========================
        // 12. 符号/标志
        // ========================
        "警告": "⚠️", "禁止": "🚫", "对勾": "✅",
        "叉": "❌", "感叹": "❗", "问号": "❓",
        "心形感叹号": "❣️", "循环": "🔁",
        "音乐": "🎵", "喇叭": "📣", "铃": "🔔",
        "静音": "🔇", "电池": "🔋", "充电": "🔌",
        "搜索": "🔍", "锁": "🔒", "解锁": "🔓",
        "钥匙": "🔑", "工具": "🔧", "扳手": "🔧"
      };

      // 替换 [xxx] 格式的表情代码
      // 逻辑: 匹配中括号内的内容, 在映射表中查找, 找到则替换, 否则保留原样
      m = m.replace(/\[([^\]]+)\]/g, (match, key) => {
        // 1. 直接匹配键名
        if (emojiMap[key]) return emojiMap[key];

        // 2. 尝试小写匹配（兼容大小写不敏感的场景）
        const lowerKey = key.toLowerCase();
        const matchedKey = Object.keys(emojiMap).find(k => k.toLowerCase() === lowerKey);
        if (matchedKey) return emojiMap[matchedKey];

        // 3. 如果未找到匹配，保留原样
        return match;
      });
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