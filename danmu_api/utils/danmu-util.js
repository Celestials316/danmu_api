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
 * 智能削峰限制弹幕数量 (平滑密度版)
 *
 * 改进点：
 * 1. 使用「浮点数二分」查找水位线，解决密度锯齿问题。
 * 2. 引入「误差扩散 (Error Diffusion)」机制，将小数部分的配额平滑分摊到时间轴上，密度最接近直线。
 * 3. 性能优化：预处理时间，移除中间的复杂分配逻辑，直接一次遍历生成结果。
 * 4. 严格限制：最终数量绝不会超过 limit，且尽可能接近 limit。
 *
 * @param {Array} danmus 弹幕数组
 * @param {number} limit 限制数量
 * @returns {Array} 限制后的弹幕数组
 */
export function limitDanmusEvenly(danmus, limit) {
  // ===== 0. 快速边界检查 =====
  if (!danmus || danmus.length === 0) return [];
  if (limit <= 0) return [];
  if (danmus.length <= limit) return danmus; // 没超限，直接返回原数组

  // 辅助：快速获取时间（避免重复 split 字符串，提高性能）
  // 假设弹幕对象要么有 t 属性(number)，要么有 p 属性(string "time,type,color...")
  const getTime = (item) => {
    if (item.t !== undefined) return item.t;
    if (item.p !== undefined) {
      // 简单的缓存机制可以加在这里，但为了通用性暂且直接解析
      // 建议数据源头最好直接把 p 解析成 t
      const pStr = String(item.p);
      const firstComma = pStr.indexOf(',');
      return firstComma > -1 ? parseFloat(pStr.slice(0, firstComma)) : parseFloat(pStr);
    }
    return 0;
  };

  // ===== 1. 建桶 (Bucketing) =====
  // 找出最大秒数，建立时间桶。这是 O(N) 操作。
  let maxSecond = 0;
  // 预处理一遍数据，既为了找 maxSecond，也为了过滤无效数据，顺便存好 parsedTime 避免重复解析
  const validItems = [];
  for (let i = 0; i < danmus.length; i++) {
    const item = danmus[i];
    const t = getTime(item);
    if (!Number.isFinite(t) || t < 0) continue;

    if (t > maxSecond) maxSecond = t;
    // 稍微包装一下，避免后续重复 getTime
    validItems.push({ original: item, time: t });
  }

  // 再次检查总数
  if (validItems.length <= limit) return validItems.map(v => v.original);

  const totalBuckets = Math.floor(maxSecond) + 1;
  const buckets = new Array(totalBuckets);
  // 初始化桶
  for (let i = 0; i < totalBuckets; i++) buckets[i] = [];

  // 填充桶
  for (let i = 0; i < validItems.length; i++) {
    const vItem = validItems[i];
    const sec = Math.floor(vItem.time);
    buckets[sec].push(vItem);
  }

  // 统计每秒容量 (Capacity)
  const caps = new Array(totalBuckets);
  for (let i = 0; i < totalBuckets; i++) {
    caps[i] = buckets[i].length;
  }

  // ===== 2. 浮点二分查找 (Floating Binary Search) =====
  // 目标：找到一个浮点数 threshold，使得 sum(min(cap, threshold)) ≈ limit

  let left = 0;
  let right = Math.max(...caps); // 水位线最高就是最拥挤那一秒的数量
  const epsilon = 0.05; // 精度控制，越小越准，但 0.05 足够了

  // 计算在给定水位线下的理论总数（带小数）
  const calcSum = (th) => {
    let sum = 0;
    for (let i = 0; i < totalBuckets; i++) {
      sum += Math.min(caps[i], th);
    }
    return sum;
  };

  // 二分迭代 (固定次数通常比 while (diff > epsilon) 更快且防死循环)
  for (let i = 0; i < 20; i++) {
    const mid = (left + right) / 2;
    if (calcSum(mid) < limit) {
      left = mid; // 说明水位低了，抬高
    } else {
      right = mid; // 说明水位高了，压低
    }
  }

  // 最终的浮点水位线。
  // 我们稍微偏向 left 一点，宁可少拿不要多拿，后面再通过 accumulator 补齐
  const threshold = left; 

  // ===== 3. 误差扩散采样 (Error Diffusion Sampling) =====
  const result = [];
  let accumulator = 0; // 累积的小数“欠款”

  // 这里的关键是：我们按时间顺序遍历，这样误差会平滑地传递到下一秒
  for (let i = 0; i < totalBuckets; i++) {
    const bucket = buckets[i];
    const cap = caps[i];

    if (cap === 0) {
      // 这一秒没弹幕，积攒的配额作废吗？
      // 通常作废，因为不能把配额挪到没有弹幕的时间去。
      // 但为了保证总数尽量接近 limit，如果 limit 很大而弹幕很稀疏，
      // accumulator 可以保留，但不要无限累积。这里简单重置或衰减。
      accumulator = 0; 
      continue;
    }

    // 计算这一秒理论应该拿多少条 (可能是小数，如 5.42)
    const idealCount = Math.min(cap, threshold);

    // 加上之前的余额
    const rawCount = idealCount + accumulator;

    // 取整：实际能拿的条数
    let takeCount = Math.floor(rawCount);

    // 更新余额：把切掉的小数部分留给下一秒
    accumulator = rawCount - takeCount;

    // 安全检查：不能超过本来有的数量
    if (takeCount > cap) {
        // 如果配额比实际有的还多（通常不会发生，因为 min(cap, threshold)），
        // 多余的 accumulator 实际上没法用掉，只能浪费或者存着。
        accumulator += (takeCount - cap); 
        takeCount = cap;
    }

    // 双重安全检查：不要拿负数
    if (takeCount <= 0) continue;

    // 采样逻辑：等间隔抽样 (Step Sampling)
    // 在 bucket 内部做均匀抽取
    if (takeCount >= cap) {
      // 全拿
      for (let k = 0; k < bucket.length; k++) result.push(bucket[k].original);
    } else {
      // 抽样：cap 个里选 takeCount 个
      // 使用 (i * cap / takeCount) 这种浮点步进，能保证最均匀
      const step = cap / takeCount;
      for (let j = 0; j < takeCount; j++) {
        const index = Math.floor(j * step);
        // 防止浮点精度问题导致的越界
        if (index < bucket.length) {
            result.push(bucket[index].original);
        }
      }
    }

    // 紧急熔断：如果因为 accumulator 的累积导致总数已经达到 limit，提前停止
    // 这种情况极少发生，但在 limit 极其严格时很有用
    if (result.length >= limit) break;
  }

  // ===== 4. 排序 (Sorting) =====
  // 结果通常已经是按秒有序的了（因为遍历 buckets 是有序的），
  // 只有同一秒内的弹幕可能乱序（如果原始数据乱序）。
  // 为了保险起见，或者为了合并后绝对有序，进行一次最终排序。
  // 由于数据量已被削减到 limit，这里的排序开销完全可控。
  result.sort((a, b) => getTime(a) - getTime(b));

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

// 🔥 修改：弹弹play格式 - 颜色在第3位，字号在第4位
    // 格式：时间,模式,颜色,字号,时间戳,弹幕池,用户ID,弹幕ID
    const fontSize = globals.danmuFontSize || 25;
    const timestamp = Math.floor(Date.now() / 1000);

    attributes = [
      time,
      mode,
      color,         // 第3位：颜色
      fontSize,      // 第4位：字号
      timestamp,
      0,
      `[${platform}]`,
      cidCounter
    ].join(",");

    danmus.push({ 
      p: attributes, 
      m, 
      cid: cidCounter++
    });
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
    let convertedToWhite = 0;
    let convertedToColor = 0;

    // 定义彩色弹幕的颜色池 (优先使用环境变量配置)
    let colorPalette = [];

    if (globals.danmuColors && globals.danmuColors.length > 0) {
      // 解析配置的 Hex 颜色列表 (#FF0000,#00FF00...)
      colorPalette = globals.danmuColors.split(',')
        .map(c => c.trim())
        .filter(c => /^#?[0-9A-Fa-f]{6}$/.test(c))
        .map(c => parseInt(c.replace('#', ''), 16));
    }

    // 如果配置为空或解析无效，使用默认柔和色盘
    if (colorPalette.length === 0) {
      colorPalette = [
        16758465,  // 樱花粉 #FFB1C1
        16764043,  // 奶油黄 #FFC48B
        11206570,  // 薄荷绿 #AAFFAA
        10027007,  // 冰霜蓝 #98FFFF
        11843064,  // 香芋紫 #B4B5F8
        16755370,  // 蜜桃橘 #FF96AA
        7530472,   // 抹茶绿 #72E7E8
        16761035,  // 芝士黄 #FFD2CB
        13293567,  // 浅藕紫 #CACFFF
      ];
    }

    // ==========================================
    // 均匀分布算法 (Error Diffusion / Dithering)
    // 目的：强制每条弹幕通过“配额”系统分配颜色，
    // 确保在时间轴的任意小片段内，白/彩比例都严格符合设定。
    // ==========================================

    const targetWhiteRate = whiteRatio / 100;
    // 初始设为 0.5 避免开头总是同一颜色，增加一点随机起始感
    let whiteBalance = 0.5; 

    finalDanmus = limitedDanmus.map(danmu => {
      const pValues = danmu.p.split(',');
      if (pValues.length < 3) {
        log("warn", `Invalid danmu format: ${danmu.p}`);
        return danmu;
      }

      let mode = parseInt(pValues[1], 10);
      let color = parseInt(pValues[2], 10); // 🔥 弹弹play格式：颜色在第3位(索引2)
      const originalColor = color; // 记录原始颜色用于统计
      let modified = false;

      // 1. 保留顶部/底部弹幕的原始类型，不再强制转换
      // 如果需要转换，可以通过环境变量 CONVERT_TOP_BOTTOM=true 来启用
      if ((mode === 4 || mode === 5) && globals.convertTopBottom) {
        topBottomCount++;
        mode = 1;
        modified = true;
      }

      // 2. 颜色均匀分配逻辑
      // 这里的逻辑是：不管原来是什么颜色，全部重写，以统一画风

      // 累加白色的"欠款"
      whiteBalance += targetWhiteRate;

      let shouldUseWhite = false;
      if (whiteBalance >= 1.0) {
        // 如果攒够了一个白色配额，这张票给白色
        shouldUseWhite = true;
        whiteBalance -= 1.0; // 扣除配额
      } else {
        // 没攒够，这张票给彩色
        shouldUseWhite = false;
      }

      if (shouldUseWhite) {
        // 设定为白色
        color = 16777215;
      } else {
        // 设定为随机彩色 (从你的色盘中取)
        color = colorPalette[Math.floor(Math.random() * colorPalette.length)];
      }

      // 检查颜色是否发生了实际变化，用于设置 modified 标志和统计
      if (color !== originalColor) {
        modified = true;
        if (color === 16777215) convertedToWhite++;
        else convertedToColor++;
      }

      // 如果有修改,重新构建 p 属性
      if (modified) {
        pValues[1] = mode.toString();
        pValues[2] = color.toString(); // 🔥 弹弹play格式：颜色在第3位(索引2)
        const newP = pValues.join(',');
        return { ...danmu, p: newP };
      }

      return danmu;
    });

    // 统计输出转换结果
    log("info", `[Color Conversion Stats - Uniform Distribution]`);
    if (globals.convertTopBottom) {
      log("info", `  - Top/Bottom→Scroll: ${topBottomCount}`);
    }
    log("info", `  - Total converted to White: ${convertedToWhite}`);
    log("info", `  - Total converted to Palette: ${convertedToColor}`);
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
  // 字体大小（25=中, 18=小），使用全局配置
  const fontSize = globals.danmuFontSize ? String(globals.danmuFontSize) : '25';

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