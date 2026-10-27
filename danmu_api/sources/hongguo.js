import BaseSource from "./base.js";
import { globals } from "../configs/globals.js";
import { log } from "../utils/log-util.js";
import { httpGet, httpPost, buildQueryString } from "../utils/http-util.js";
import {
  aesCbcEncrypt,
  bytesToHex,
  bytesToBase64,
  convertToAsciiSum,
  hexToBytes,
  md5,
  pkcs7Pad,
  sm3Bytes,
  stringToUtf8Bytes,
} from "../utils/codec-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from "../models/dandan-model.js";
import {
  HONGGUO_SEARCH_VERSION_CODE,
  HONGGUO_SEARCH_VERSION_NAME,
  buildRegisterBody,
  buildRegisterHeaders,
  createAnonymousIdentity,
  hongguoUserAgent,
  parseRegisterResponse,
  signHongguoSearchRequest,
} from "../utils/hongguo-util.js";

const CLIENT_CONFIG = {
  apiHosts: Object.freeze([
    "api5-normal-sinfonlinea.fqnovel.com",
    "api5-normal-sinfonlinec.fqnovel.com",
    "api5-normal-lf.fqnovel.com",
    "api5-normal-lq.fqnovel.com",
    "api5-normal-sinfonlineb.fqnovel.com",
    "api5-normal-hl.fqnovel.com",
  ]),
  baseQuery: {
    iid: "4439167111854618",
    device_id: "4439167111850522",
    channel: "huawei_8662_64",
    device_type: "V2284A",
    cdid: "6100e9f9-a1a0-4f65-ab47-94f5b41b8efb",
    aid: "8662",
    app_name: "novelread",
    version_code: "72932",
    version_name: "7.2.9.32",
    device_platform: "android",
    ac: "wifi",
    os: "android",
    ssmix: "a",
    device_brand: "vivo",
    language: "zh",
    os_api: "32",
    os_version: "12",
    manifest_version_code: "72932",
    resolution: "1080*1920",
    dpi: "280",
    update_version_code: "72932",
    host_abi: "arm64-v8a",
    dragon_device_type: "phone",
    pv_player: "72932",
    compliance_status: "0",
    need_personal_recommend: "1",
    player_so_load: "1",
    is_android_pad_screen: "1",
    rom_version: "V417IR+release-keys",
  },
  sessionHeaders: {
    cookie: "",
    "x-tt-token": "",
    "user-agent": "com.phoenix.read/72932 (Linux; U; Android 12; zh_CN; V2284A; Build/V417IR;tt-ok/3.12.13.20)",
    "x-tt-store-region": "cn-zj",
    "x-tt-store-region-src": "did",
    "passport-sdk-version": "5051452",
    "sdk-version": "2",
  },
};

const WEB_ORIGIN = "https://hongguoduanju.com";
const REGISTER_ORIGIN = "https://log5-applog-lq.fqnovel.com";
const SEARCH_VERSION_NAME = HONGGUO_SEARCH_VERSION_NAME;
const SEARCH_VERSION_CODE = String(HONGGUO_SEARCH_VERSION_CODE);
const SEARCH_AID = Number(CLIENT_CONFIG.baseQuery.aid);
const SEARCH_TAB_TYPE = "11";
const ANONYMOUS_IDENTITY_TTL_MS = 12 * 60 * 60 * 1000;
const ANONYMOUS_IDENTITY_FAILURE_TTL_MS = 30_000;
// 搜索请求本身的超时，以及一次搜索（含 App/网页/SSR 兜底）的总预算。
// 搜索源是和其他源并行等待的，不能让单个源长时间占住整个搜索响应。
const SEARCH_REQUEST_TIMEOUT_MS = 4_000;
const SEARCH_WEB_TIMEOUT_MS = 3_000;
const SEARCH_REGISTER_TIMEOUT_MS = 2_000;
const SEARCH_REGISTER_ATTEMPTS = 2;
const SEARCH_REGISTER_RETRY_DELAY_MS = 150;
const SEARCH_TOTAL_BUDGET_MS = 6_000;
const SEARCH_FALLBACK_RESERVE_MS = 2_000;
// 风控冷却只在“短冷却”时等待，长冷却直接失败并走网页兜底，避免请求挂起。
const SEARCH_COOLDOWN_MAX_WAIT_MS = 1_000;
const SEARCH_COOLDOWN_MAX_MS = 10 * 60 * 1000;
const HONGGUO_REQUEST_TIMEOUT_MS = 8_000;
// 搜索结果的详情阶段同样要有总预算，避免几十部剧的详情串行把响应拖到数分钟。
const HONGGUO_HANDLE_ANIMES_BUDGET_MS = 4_000;
const EPISODE_DETAILS_TTL_MS = 2 * 60 * 1000;
const EPISODE_DETAILS_FAILURE_TTL_MS = 30 * 1000;
const EPISODE_DETAILS_CACHE_MAX = 100;
const SEARCH_DEVICE = Object.freeze({
  brand: "Redmi",
  manufacturer: "Xiaomi",
  model: "25053RT47C",
  osVersion: "12",
  osApi: 31,
  build: "V417IR",
  resolution: CLIENT_CONFIG.baseQuery.resolution,
  dpi: Number(CLIENT_CONFIG.baseQuery.dpi),
  channel: CLIENT_CONFIG.baseQuery.channel,
});

function parseWebSearchResults(html) {
  const marker = '"searchList":';
  const start = html.indexOf(marker);
  if (start < 0) return [];
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "[") return [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = i;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  try { return JSON.parse(html.slice(i, end + 1)); } catch { return []; }
}

// 归一化网页搜索接口（/api/search/result/）返回的单条结果
function normalizeWebSearchItem(item) {
  if (!item || typeof item !== "object") return null;
  const videoDataList = (Array.isArray(item.video_data) ? item.video_data : [item.video_data])
    .filter((value) => value && typeof value === "object");
  const data = videoDataList[0] || {};
  if (isUgcAlbum(item, ...videoDataList, data.album_info)) return null;
  const seriesId = String(data.series_id || item.keyword || "");
  const name = String(data.series_name || data.series_title || item.name || "").trim();
  const episodeCount = Number(data.episode_cnt) || 0;
  if (!seriesId || !name || episodeCount <= 0) return null;
  return {
    seriesId,
    name,
    episodeCount,
    score: "",
    year: extractYearFromTimestamp(data.create_time),
    imageUrl: extractImageUrl(data.series_cover),
  };
}

// 解析网页搜索接口（/api/search/result/）的响应，兼容对象与 JSON 字符串
function parseWebSearchApi(payload) {
  let result = payload;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { throw new Error("网页搜索返回无效 JSON"); }
  }
  const list = result && Array.isArray(result.searchList)
    ? result.searchList
    : (Array.isArray(result) ? result : null);
  if (!list) throw new Error("网页搜索返回无效搜索结果");
  return { items: list.map(normalizeWebSearchItem).filter(Boolean), rawCount: list.length };
}

function parseWebSeriesDetail(html) {
  const marker = '"seriesDetail":';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "{") return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = i;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) break;
  }
  try { return JSON.parse(html.slice(i, end + 1)); } catch { return null; }
}

const COMMENT_SOURCE = 601;
const SERVER_CHANNEL = 1000;
const COMMENT_WINDOW_MS = 30_000;
const COMMENT_COUNT = 90;
const COMMENT_CONCURRENCY = 3;
// 弹幕请求的最小节流间隔（毫秒），随机抖动避免固定节律被平台识别
const COMMENT_THROTTLE_MS = 180;
const COMMENT_THROTTLE_JITTER_MS = 240;
// 详情请求与弹幕分开节流；搜索阶段要快速补齐多部剧详情，不能按弹幕的慢节律发送。
const DETAIL_THROTTLE_MS = 150;
const DETAIL_THROTTLE_JITTER_MS = 101;
const MAX_SEARCH_ITEMS = 20;
const IMAGE_SHRINK =
  "W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1h\n" +
  "Z2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d\n";

const SIGN_KEY = hexToBytes("ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c");
const ARGUS_HEADER = hexToBytes("3ccc");
const ARGUS_PREFIX = hexToBytes("a6e783ee7001100918");
const ARGUS_SUFFIX = hexToBytes("567b");
const ARGUS_XOR_WORD = hexToBytes("d04ffdff");
const LICENSE_ID = 1611921764;
const METASEC_APP_ID = 3019;
const SDK_VERSION = 135135744;
const COUNTER_VALUE = 1388734;
const SIMON_Z = word64(0x046d678b, 0x3dc94c3a);

function concatBytes(...parts) {
  const arrays = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part || []));
  const output = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of arrays) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function randomBytes(length) {
  const output = new Uint8Array(length);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(output);
    return output;
  }
  for (let i = 0; i < length; i++) output[i] = Math.floor(Math.random() * 256);
  return output;
}

function reverseBytes(bytes) {
  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) output[i] = bytes[bytes.length - i - 1];
  return output;
}

function getHeader(headers, name) {
  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === expected && value != null) return String(value);
  }
  return "";
}

function getQueryString(url) {
  const text = String(url || "");
  const question = text.indexOf("?");
  if (question < 0) return "";
  const hash = text.indexOf("#", question);
  return text.slice(question + 1, hash < 0 ? undefined : hash);
}

function getQueryParam(url, name) {
  const expected = String(name);
  for (const pair of getQueryString(url).split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (decodeURIComponent(key) === expected) {
      return decodeURIComponent(separator < 0 ? "" : pair.slice(separator + 1));
    }
  }
  return null;
}

function encodeVarint(value) {
  let remaining = Number(value);
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw new RangeError("protobuf varint must be a safe non-negative integer");
  const output = [];
  while (remaining >= 0x80) {
    output.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  output.push(remaining);
  return new Uint8Array(output);
}

function pbVarint(field, value) {
  return concatBytes(encodeVarint(field * 8), encodeVarint(value));
}

function pbBytes(field, value) {
  const encoded = value instanceof Uint8Array ? value : stringToUtf8Bytes(String(value));
  return concatBytes(encodeVarint(field * 8 + 2), encodeVarint(encoded.length), encoded);
}

function word64(lo, hi) {
  return { lo: lo >>> 0, hi: hi >>> 0 };
}

function xor64(...values) {
  let lo = 0;
  let hi = 0;
  for (const value of values) {
    lo ^= value.lo;
    hi ^= value.hi;
  }
  return word64(lo, hi);
}

function and64(a, b) {
  return word64(a.lo & b.lo, a.hi & b.hi);
}

function not64(value) {
  return word64(~value.lo, ~value.hi);
}

function add64(a, b) {
  const lo = (a.lo + b.lo) >>> 0;
  return word64(lo, (a.hi + b.hi + (lo < a.lo ? 1 : 0)) >>> 0);
}

function rol64(value, count) {
  const shift = ((count % 64) + 64) % 64;
  if (shift === 0) return word64(value.lo, value.hi);
  if (shift < 32) {
    return word64(
      (value.lo << shift) | (value.hi >>> (32 - shift)),
      (value.hi << shift) | (value.lo >>> (32 - shift)),
    );
  }
  if (shift === 32) return word64(value.hi, value.lo);
  const rest = shift - 32;
  return word64(
    (value.hi << rest) | (value.lo >>> (32 - rest)),
    (value.lo << rest) | (value.hi >>> (32 - rest)),
  );
}

function ror64(value, count) {
  return rol64(value, 64 - (count % 64));
}

function readWord64LE(bytes, offset = 0) {
  const lo = (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const hi = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
  return word64(lo, hi);
}

function writeWord64LE(output, offset, value) {
  for (let i = 0; i < 4; i++) {
    output[offset + i] = (value.lo >>> (i * 8)) & 0xff;
    output[offset + 4 + i] = (value.hi >>> (i * 8)) & 0xff;
  }
}

function simonZBit(index) {
  return word64(index < 32 ? (SIMON_Z.lo >>> index) & 1 : (SIMON_Z.hi >>> (index - 32)) & 1, 0);
}

function simonRoundKeys(key) {
  const words = Array.from({ length: 4 }, (_, index) => readWord64LE(key, index * 8));
  for (let index = 4; index < 72; index++) {
    let mixed = xor64(ror64(words[index - 1], 3), words[index - 3]);
    mixed = xor64(mixed, ror64(mixed, 1));
    words.push(xor64(not64(words[index - 4]), mixed, simonZBit((index - 4) % 62), word64(3, 0)));
  }
  return words;
}

function simonEncrypt(block, roundKeys) {
  let left = readWord64LE(block, 0);
  let right = readWord64LE(block, 8);
  for (const key of roundKeys) {
    const oldRight = right;
    const nonlinear = and64(rol64(right, 1), rol64(right, 8));
    right = xor64(left, nonlinear, rol64(right, 2), key);
    left = oldRight;
  }
  const output = new Uint8Array(16);
  writeWord64LE(output, 0, left);
  writeWord64LE(output, 8, right);
  return output;
}

function argusProtobuf(query, stub, timestamp, options) {
  const bodyInput = /^[0-9a-f]{32}$/i.test(stub) ? hexToBytes(stub) : new Uint8Array(16);
  const randomValue = options.argusRandom == null ? readWord32LE(randomBytes(4)) : options.argusRandom >>> 0;
  const signCount = options.argusSignCount == null ? 2 + (randomBytes(1)[0] % 49) * 2 : options.argusSignCount;
  const nested = concatBytes(
    pbVarint(1, signCount),
    pbVarint(2, COUNTER_VALUE),
    pbVarint(3, COUNTER_VALUE),
    pbVarint(4, COUNTER_VALUE),
  );
  return concatBytes(
    pbVarint(1, 0x20200929 * 2),
    pbVarint(2, 2),
    pbVarint(3, randomValue),
    pbBytes(4, METASEC_APP_ID),
    pbBytes(6, LICENSE_ID),
    pbBytes(7, "6.8.1.32"),
    pbBytes(8, "v04.07.01-ml-android"),
    pbVarint(9, SDK_VERSION),
    pbBytes(10, new Uint8Array(8)),
    pbVarint(12, timestamp * 2),
    pbBytes(13, sm3Bytes(bodyInput).slice(0, 6)),
    pbBytes(14, sm3Bytes(stringToUtf8Bytes(query)).slice(0, 6)),
    pbBytes(15, nested),
    pbBytes(20, "none"),
    pbVarint(21, 738),
  );
}

function readWord32LE(bytes) {
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

export function createArgus(query, stub, timestamp, options = {}) {
  const protobuf = pkcs7Pad(argusProtobuf(query, stub, timestamp, options));
  const simonKey = sm3Bytes(concatBytes(SIGN_KEY, ARGUS_HEADER, ARGUS_SUFFIX, SIGN_KEY));
  const roundKeys = simonRoundKeys(simonKey);
  const encrypted = [];
  for (let offset = 0; offset < protobuf.length; offset += 16) {
    encrypted.push(simonEncrypt(protobuf.slice(offset, offset + 16), roundKeys));
  }

  const xorKey = concatBytes(ARGUS_XOR_WORD, ARGUS_XOR_WORD);
  const encoded = concatBytes(xorKey, ...encrypted);
  for (let index = 8; index < encoded.length; index++) encoded[index] ^= encoded[index % 8];
  const container = concatBytes(ARGUS_PREFIX, reverseBytes(encoded), ARGUS_SUFFIX);
  const key = hexToBytes(md5(SIGN_KEY.slice(0, 16)));
  const iv = hexToBytes(md5(SIGN_KEY.slice(16)));
  return bytesToBase64(concatBytes(ARGUS_HEADER, aesCbcEncrypt(container, key, iv)));
}

function ladonRoundKeys(randomPrefix, aid) {
  const asciiDigest = stringToUtf8Bytes(md5(concatBytes(randomPrefix, stringToUtf8Bytes(String(aid)))));
  const table = new Uint8Array(288);
  table.set(asciiDigest);
  const queue = Array.from({ length: 4 }, (_, index) => readWord64LE(table, index * 8));
  let left = queue.shift();
  let right = queue.shift();
  for (let index = 0; index < 0x22; index++) {
    const mixed = xor64(add64(ror64(right, 8), left), word64(index, 0));
    queue.push(mixed);
    left = xor64(mixed, ror64(left, 61));
    writeWord64LE(table, (index + 1) * 8, left);
    right = queue.shift();
  }
  return Array.from({ length: 0x22 }, (_, index) => readWord64LE(table, index * 8));
}

function ladonEncryptBlock(block, roundKeys) {
  let left = readWord64LE(block, 0);
  let right = readWord64LE(block, 8);
  for (const key of roundKeys) {
    right = xor64(key, add64(left, ror64(right, 8)));
    left = xor64(right, ror64(left, 61));
  }
  const output = new Uint8Array(16);
  writeWord64LE(output, 0, left);
  writeWord64LE(output, 8, right);
  return output;
}

export function createLadon(timestamp, aid, options = {}) {
  const randomPrefix = options.ladonRandom == null
    ? randomBytes(4)
    : new Uint8Array(options.ladonRandom);
  if (randomPrefix.length !== 4) throw new RangeError("ladonRandom must be four bytes");
  const data = stringToUtf8Bytes(`${timestamp}-${LICENSE_ID}-${METASEC_APP_ID}`);
  const paddedSize = Math.ceil(data.length / 16) * 16;
  const padded = new Uint8Array(paddedSize);
  padded.set(data);
  const padding = 16 - (data.length % 16);
  if (data.length + padding <= paddedSize) padded.fill(padding, data.length);
  const roundKeys = ladonRoundKeys(randomPrefix, aid);
  const ciphertext = [];
  for (let offset = 0; offset < padded.length; offset += 16) {
    ciphertext.push(ladonEncryptBlock(padded.slice(offset, offset + 16), roundKeys));
  }
  return bytesToBase64(concatBytes(randomPrefix, ...ciphertext));
}

function md5Prefix(value) {
  const bytes = value instanceof Uint8Array ? value : stringToUtf8Bytes(String(value));
  return hexToBytes(md5(bytes)).slice(0, 4);
}

export function buildGorgonSeed(url, { headers = {}, body = null, khronos } = {}) {
  if (!Number.isInteger(khronos) || khronos < 0 || khronos > 0xffffffff) {
    throw new RangeError("khronos must be an unsigned 32-bit integer");
  }
  const stub = getHeader(headers, "x-ss-stub").trim();
  let bodyPrefix = new Uint8Array(4);
  if (/^[0-9a-f]{32}$/i.test(stub)) bodyPrefix = hexToBytes(stub.slice(0, 8));
  else if (body != null) {
    const bodyBytes = body instanceof Uint8Array ? body : stringToUtf8Bytes(String(body));
    if (bodyBytes.length > 0) bodyPrefix = md5Prefix(bodyBytes);
  }
  const cookie = getHeader(headers, "cookie");
  const timestamp = new Uint8Array([
    (khronos >>> 24) & 0xff,
    (khronos >>> 16) & 0xff,
    (khronos >>> 8) & 0xff,
    khronos & 0xff,
  ]);
  return concatBytes(
    md5Prefix(getQueryString(url)),
    bodyPrefix,
    cookie ? md5Prefix(cookie) : new Uint8Array(4),
    new Uint8Array([0x00, 0x01, 0x07, 0x04]),
    timestamp,
  );
}

function reverseBits(value) {
  let result = ((value << 1) & 0xaa) | ((value >>> 1) & 0x55);
  result = ((result << 2) & 0xcc) | ((result >>> 2) & 0x33);
  return ((result << 4) | (result >>> 4)) & 0xff;
}

export function transformGorgonSeed(seed, { headerByte2, headerByte3, parameter = 0 } = {}) {
  const input = seed instanceof Uint8Array ? seed : new Uint8Array(seed || []);
  if (input.length !== 20) throw new TypeError("seed must contain 20 bytes");
  const key = new Uint8Array([0x4a, parameter & 0xff, 0x16, headerByte3, 0x47, 0x6c, parameter >>> 8, headerByte2]);
  const sbox = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + sbox[i] + key[i & 7]) & 0xff;
    sbox[i] = sbox[j];
  }
  const payload = new Uint8Array(input);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < payload.length; offset++) {
    i = (i + 1) & 0xff;
    j = (j + sbox[i]) & 0xff;
    sbox[i] = sbox[j];
    payload[offset] ^= sbox[(sbox[i] + sbox[j]) & 0xff];
  }
  const lengthMask = (~payload.length) & 0xff;
  for (let offset = 0; offset < payload.length; offset++) {
    const swappedNibbles = ((payload[offset] << 4) | (payload[offset] >>> 4)) & 0xff;
    payload[offset] = reverseBits(swappedNibbles ^ payload[(offset + 1) % payload.length]) ^ lengthMask;
  }
  return concatBytes(new Uint8Array([0x84, 0x04, headerByte2, headerByte3, parameter & 0xff, parameter >>> 8]), payload);
}

export function signHongguoRequest(url, options = {}) {
  const timestamp = options.timestamp == null
    ? (options.khronos == null ? Math.floor(Date.now() / 1000) : options.khronos)
    : options.timestamp;
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
    throw new RangeError("timestamp must be an unsigned 32-bit integer");
  }
  const aid = parseInt(getQueryParam(url, "aid"), 10);
  if (!Number.isSafeInteger(aid)) throw new TypeError("signed URL must contain a numeric aid parameter");
  const random = randomBytes(2);
  const headerByte2 = options.headerByte2 == null ? ((random[0] % 7) + 1) << 5 : options.headerByte2;
  const headerByte3 = options.headerByte3 == null ? 0xe0 | (random[1] & 0x0f) : options.headerByte3;
  const headers = options.headers || {};
  const seed = buildGorgonSeed(url, { headers, body: options.body, khronos: timestamp });
  return {
    "X-Argus": createArgus(getQueryString(url), getHeader(headers, "x-ss-stub").trim(), timestamp, options),
    "X-Gorgon": bytesToHex(transformGorgonSeed(seed, { headerByte2, headerByte3, parameter: options.parameter || 0 })),
    "X-Khronos": String(timestamp),
    "X-Ladon": createLadon(timestamp, aid, options),
  };
}

export function createHongguoEpisodeId(seriesId, vid, durationSeconds) {
  return `hongguo:v1:${encodeURIComponent(String(seriesId))}:${encodeURIComponent(String(vid))}:${Math.max(0, Math.trunc(Number(durationSeconds) || 0))}`;
}

export function createHongguoSeriesId(seriesId) {
  return `hongguo:series:v1:${encodeURIComponent(String(seriesId))}`;
}

export function parseHongguoSeriesId(value) {
  const rawValue = String(value || "").split("#", 1)[0];
  const match = rawValue.match(/^hongguo:series:v1:([^:]+)$/);
  if (!match) throw new Error("无效的红果全集 ID");
  return { seriesId: decodeURIComponent(match[1]) };
}

export function isHongguoSeriesId(value) {
  try {
    parseHongguoSeriesId(value);
    return true;
  } catch {
    return false;
  }
}

export function parseHongguoEpisodeId(value) {
  const rawValue = String(value || "").split("#", 1)[0];
  const match = rawValue.match(/^hongguo:v1:([^:]+):([^:]+):(\d+)$/);
  if (!match) throw new Error("无效的红果剧集 ID");
  return {
    seriesId: decodeURIComponent(match[1]),
    vid: decodeURIComponent(match[2]),
    duration: Number(match[3]),
  };
}

export function parseHongguoPlayerUrl(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/@%?-?\d+(?:\.\d+)?$/, "");
  if (normalized.split("#", 1)[0].startsWith("hongguo:v1:")) {
    const info = parseHongguoEpisodeId(normalized);
    return { seriesId: info.seriesId, vid: info.vid };
  }
  const match = normalized.match(
    /^https?:\/\/(?:www\.)?hongguoduanju\.com(?::\d+)?\/player\/(\d+)\/(\d+)\/?(?:\?[^#]*)?(?:#.*)?$/i,
  );
  if (!match) throw new Error("无效的红果短剧播放链接");
  return { seriesId: match[1], vid: match[2] };
}

export function isHongguoPlayerUrl(value) {
  try {
    parseHongguoPlayerUrl(value);
    return true;
  } catch {
    return false;
  }
}

function extractImageUrl(value) {
  if (typeof value === "string") {
    const url = value.trim();
    return url.startsWith("//") ? `https:${url}` : url;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractImageUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  for (const key of ["url", "main_url", "download_url", "url_list", "urlList", "urls"]) {
    const url = extractImageUrl(value[key]);
    if (url) return url;
  }
  return "";
}

function extractYearFromTimestamp(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const milliseconds = timestamp >= 1e12 ? timestamp : timestamp * 1000;
    const year = new Date(milliseconds).getUTCFullYear();
    if (year >= 1900 && year <= 2100) return year;
  }
  return null;
}

function isUgcAlbum(...items) {
  return items.some((item) => Number(item?.content_type) === 1003 || Boolean(item?.ugc_user_info));
}

function parseSearchCell(cell) {
  const seriesId = cell && (cell.book_id || cell.search_result_id);
  if (!seriesId) return null;
  const detailList = (Array.isArray(cell.video_detail) ? cell.video_detail : [cell.video_detail])
    .filter((value) => value && typeof value === "object");
  const videoDataList = (Array.isArray(cell.video_data) ? cell.video_data : [cell.video_data])
    .filter((value) => value && typeof value === "object");
  const detail = detailList[0] || {};
  const videoData = videoDataList[0] || {};
  const inner = videoData.video_detail || {};
  const albumInfo = videoData.album_info || inner.album_info || detail.album_info || {};
  if (isUgcAlbum(cell, ...detailList, ...videoDataList, inner, albumInfo)) return null;
  const episodeCount = Number(detail.episode_cnt || videoData.episode_cnt || inner.episode_cnt || albumInfo.episode_cnt || 0);
  if (!Number.isFinite(episodeCount) || episodeCount <= 0) return null;
  const highlighted = cell.search_high_light && cell.search_high_light.title && cell.search_high_light.title.text;
  const title = String(highlighted || detail.series_title || videoData.title || inner.series_title || albumInfo.title || "")
    .replace(/<[^>]+>/g, "")
    .trim();
  if (!title) return null;
  return {
    seriesId: String(seriesId),
    name: title,
    episodeCount: Number(episodeCount) || 0,
    score: videoData.score || inner.score || albumInfo.score || "",
    year: extractYearFromTimestamp(
      albumInfo.create_time,
      inner.create_time,
      videoData.create_time,
      detail.create_time,
      cell.create_time,
    ),
    imageUrl: extractImageUrl(
      inner.series_cover || videoData.cover || detail.series_cover || albumInfo.cover || cell.series_cover || cell.cover,
    ),
  };
}

function parseDanmuResponse(payload) {
  const output = [];
  const data = payload && payload.data;
  for (const item of (data && data.data_list) || []) {
    const comment = item.comment || {};
    const common = comment.common || {};
    const content = common.content || {};
    const expand = comment.expand || {};
    const text = String(content.text || "").trim();
    const offsetMs = Number(expand.offset_time);
    if (!text || !Number.isFinite(offsetMs)) continue;
    output.push({
      commentId: String(comment.comment_id || ""),
      offsetMs: Math.max(0, Math.trunc(offsetMs)),
      text,
      diggCount: Math.max(0, Math.trunc(Number((comment.stat || {}).digg_count) || 0)),
    });
  }
  return output;
}

function dedupeDanmus(items) {
  const seen = new Map();
  for (const item of items) {
    const key = item.commentId ? `id:${item.commentId}` : `anonymous:${item.offsetMs}:${item.text}`;
    seen.set(key, item);
  }
  return [...seen.values()].sort((a, b) => a.offsetMs - b.offsetMs || a.commentId.localeCompare(b.commentId) || a.text.localeCompare(b.text));
}

class HongguoSearchTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "HongguoSearchTimeoutError";
    this.searchTimeout = true;
  }
}

class HongguoSearchCooldownError extends Error {
  constructor(coolDownMs) {
    super(`红果搜索触发了 ${Math.ceil(coolDownMs / 1000)}s 风控冷却`);
    this.name = "HongguoSearchCooldownError";
    this.coolDownMs = coolDownMs;
  }
}

function createAbortError() {
  const error = new Error("红果搜索已取消");
  error.name = "AbortError";
  return error;
}

function hasReliableTimers() {
  return globalThis.__FORWARD_WIDGET__ !== true || globalThis.__FORWARD_HAS_NATIVE_TIMERS__ === true;
}

function sleep(milliseconds, signal = null) {
  if (!hasReliableTimers()) {
    return milliseconds > 0
      ? Promise.reject(new HongguoSearchCooldownError(milliseconds))
      : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function remainingSearchTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function ensureSearchTime(deadline, stage, signal = null) {
  if (signal?.aborted || Date.now() >= deadline) {
    throw new HongguoSearchTimeoutError(`${stage}超时`);
  }
}

function timeoutForSearch(deadline, maximum) {
  const remaining = remainingSearchTime(deadline);
  if (remaining <= 0) throw new HongguoSearchTimeoutError("红果搜索超时");
  return Math.max(1, Math.min(maximum, remaining));
}

function withSearchDeadline(promise, deadline, message, signal = null) {
  const remaining = remainingSearchTime(deadline);
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(createAbortError());
    promise.then(
      (value) => {
        cleanup();
        if (signal?.aborted) reject(createAbortError());
        else if (Date.now() >= deadline) reject(new HongguoSearchTimeoutError(message));
        else resolve(value);
      },
      fail,
    );
    if (signal?.aborted) return onAbort();
    if (remaining <= 0) return fail(new HongguoSearchTimeoutError(message));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (hasReliableTimers() && Number.isFinite(remaining)) {
      timer = setTimeout(() => fail(new HongguoSearchTimeoutError(message)), remaining);
    }
  });
}

function createSharedTask(run, cleanup) {
  const task = { controller: new AbortController(), waiters: 0, settled: false, promise: null, cleanup };
  task.promise = Promise.resolve().then(() => run(task.controller.signal)).finally(() => {
    task.settled = true;
    cleanup(task);
  });
  return task;
}

async function joinSharedTask(task, { signal = null, deadline = Infinity } = {}, message) {
  task.waiters++;
  try {
    return await withSearchDeadline(task.promise, deadline, message, signal);
  } finally {
    task.waiters--;
    if (!task.waiters && !task.settled) {
      task.cleanup(task);
      task.controller.abort();
    }
  }
}

function cloneEpisodeDetails(details) {
  return { ...details, episodes: details.episodes.map((episode) => ({ ...episode })) };
}

function isTransientRegisterError(error) {
  const message = String(error?.message || "");
  if (error?.searchTimeout) return true;
  if (["AbortError", "TypeError"].includes(error?.name)) return true;
  return /HTTP error! status: (?:429|5\d\d)|fetch failed|network|timeout/i.test(message);
}

function isSearchCancellation(error, deadline = Infinity, signal = null) {
  return Boolean(error?.searchTimeout)
    || Boolean(signal?.aborted)
    || Date.now() >= deadline;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

function getFragmentNumber(value, name) {
  const hashIndex = String(value || "").indexOf("#");
  if (hashIndex < 0) return null;
  const expected = String(name);
  const fragment = String(value).slice(hashIndex + 1);
  for (const pair of fragment.split("&")) {
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (decodeURIComponent(key) !== expected) continue;
    const number = Number(decodeURIComponent(separator < 0 ? "" : pair.slice(separator + 1)));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export default class HongguoSource extends BaseSource {
  constructor() {
    super();
    this.preferredApiHost = CLIENT_CONFIG.apiHosts[0];
    this.nextRequestAt = 0;
    this.throttleQueue = [];
    this.throttleRunning = false;
    this.playerEpisodeResolutions = new Map();
    this.activeCommentRequests = 0;
    this.commentRequestWaiters = [];
    this.lastDanmu = [];
    this.durationCache = new Map();
    this.episodeDetailsCache = new Map();
    this.pendingEpisodeDetails = new Map();
    this.pendingEpisodeDanmu = new Map();
    this.searchIdentity = null;
    this.searchIdentityCreatedAt = 0;
    this.searchIdentityPromise = null;
    this.searchIdentityTask = null;
    this.searchIdentityFailureUntil = 0;
    this.searchCooldownUntil = 0;
  }

  buildUrl(path, extraQuery = {}, apiHost = this.preferredApiHost) {
    const query = { ...CLIENT_CONFIG.baseQuery, ...extraQuery, _rticket: String(Date.now()) };
    return `https://${apiHost || CLIENT_CONFIG.apiHosts[0]}${path}?${buildQueryString(query)}`;
  }

  getApiHosts() {
    const preferred = this.preferredApiHost;
    if (!preferred || !CLIENT_CONFIG.apiHosts.includes(preferred)) return [...CLIENT_CONFIG.apiHosts];
    return [preferred, ...CLIENT_CONFIG.apiHosts.filter((host) => host !== preferred)];
  }

  parseApiResponse(response) {
    const status = response && response.status != null ? `HTTP ${response.status}` : "未知 HTTP 状态";
    if (!response || !("data" in response)) throw new Error(`无效响应 (${status})`);
    const statusCode = response.status == null ? null : Number(response.status);
    if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
      throw new Error(`接口返回 ${status}`);
    }
    if (typeof response.data !== "string") {
      if (!response.data || typeof response.data !== "object") throw new Error(`无效响应 (${status})`);
      return response.data;
    }

    const text = response.data.trim();
    if (!text) {
      const error = new Error(`接口返回空响应 (${status})`);
      error.code = "EMPTY_RESPONSE";
      throw error;
    }
    try {
      const result = JSON.parse(text);
      if (!result || typeof result !== "object") throw new Error("JSON 根节点不是对象");
      return result;
    } catch (error) {
      throw new Error(`接口返回无效 JSON (${status}): ${error.message}`);
    }
  }

  async throttle(baseMs = 600, jitterMs = 401, signal = null, deadline = Infinity) {
    ensureSearchTime(deadline, "红果请求排队", signal);
    if (!hasReliableTimers()) return;
    if (this.throttleQueue.length >= 100) throw new Error("红果请求队列已满");
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let timer = null;
      const entry = { baseMs, jitterMs, deadline, controller, resolve, reject, cleanup: null };
      const cancel = () => {
        const index = this.throttleQueue.indexOf(entry);
        if (index >= 0) this.throttleQueue.splice(index, 1);
        controller.abort();
        entry.cleanup();
        reject(signal?.aborted ? createAbortError() : new HongguoSearchTimeoutError("红果请求排队超时"));
      };
      entry.cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener?.("abort", cancel);
      };
      signal?.addEventListener?.("abort", cancel, { once: true });
      if (hasReliableTimers() && Number.isFinite(deadline)) {
        timer = setTimeout(cancel, remainingSearchTime(deadline));
      }
      this.throttleQueue.push(entry);
      this.drainThrottleQueue();
    });
  }

  async drainThrottleQueue() {
    if (this.throttleRunning) return;
    this.throttleRunning = true;
    try {
      while (this.throttleQueue.length) {
        const entry = this.throttleQueue[0];
        try {
          ensureSearchTime(entry.deadline, "红果请求排队", entry.controller.signal);
          const wait = Math.max(0, this.nextRequestAt - Date.now());
          if (Date.now() + wait >= entry.deadline) throw new HongguoSearchTimeoutError("红果请求排队超时");
          if (wait) await sleep(wait, entry.controller.signal);
          ensureSearchTime(entry.deadline, "红果请求排队", entry.controller.signal);
          this.nextRequestAt = Date.now() + entry.baseMs + Math.floor(Math.random() * entry.jitterMs);
          entry.resolve();
        } catch (error) {
          entry.reject(error);
        } finally {
          entry.cleanup();
          if (this.throttleQueue[0] === entry) this.throttleQueue.shift();
        }
      }
    } finally {
      this.throttleRunning = false;
    }
  }

  checkResponse(payload) {
    if (!payload || typeof payload !== "object") throw new Error("平台返回了无效响应");
    const code = payload.code;
    if (code == null || code === 0) return;
    const message = String(payload.message || payload.msg || "未知错误");
    const normalizedMessage = message.toLowerCase();
    const authFailed = [401, 403, 8, 1001].includes(Number(code)) ||
      ["token", "login", "登录", "未登录", "expire"].some((word) => normalizedMessage.includes(word));
    if (authFailed) throw new Error(`鉴权失败 code=${code}: ${message}`);
    // 频控冷却指令：服务端以 JSON 返回 {"min_ban_time": 3, "max_ban_time": 5, "ban_rate": 0}
    let coolDownMs = 0;
    try {
      const detail = JSON.parse(message);
      if (detail && typeof detail === "object") {
        coolDownMs = Math.max(0, Number(detail.min_ban_time) || Number(detail.max_ban_time) || 0) * 1000;
      }
    } catch { /* message 不是 JSON 时忽略 */ }
    if (coolDownMs > 0) {
      const error = new Error(`风控冷却: 需暂停 ${Math.round(coolDownMs / 1000)}s (code=${code})`);
      error.coolDownMs = coolDownMs;
      return error;
    }
    throw new Error(`风控或平台异常 code=${code}: ${message}`);
  }

  async request(method, path, { body = null, extraQuery = {}, comment = false, signal = null, deadline = Infinity } = {}) {
    const apiHosts = this.getApiHosts();
    const failures = [];
    const payload = body == null ? null : JSON.stringify(body);
    for (let index = 0; index < apiHosts.length; index++) {
      const apiHost = apiHosts[index];
      // 风控冷却是按设备身份生效的（与具体主机无关），在主机内做有限次退避重试，之后再切换线路
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let releaseCommentSlot = null;
        try {
          ensureSearchTime(deadline, "红果请求", signal);
          releaseCommentSlot = comment ? await this.acquireCommentSlot() : null;
          await this.throttle(
            comment ? COMMENT_THROTTLE_MS : DETAIL_THROTTLE_MS,
            comment ? COMMENT_THROTTLE_JITTER_MS : DETAIL_THROTTLE_JITTER_MS,
            signal,
            deadline,
          );
          ensureSearchTime(deadline, "红果请求", signal);
          const url = this.buildUrl(path, extraQuery, apiHost);
          const headers = {};
          for (const [key, value] of Object.entries(CLIENT_CONFIG.sessionHeaders)) {
            if (value) headers[key] = String(value);
          }
          headers["content-type"] = "application/json; charset=utf-8";
          if (comment) {
            headers["comment-source"] = String(COMMENT_SOURCE);
            headers["server-channel"] = String(SERVER_CHANNEL);
            headers["x-ss-stub"] = "";
          } else if (payload != null) {
            headers["x-ss-stub"] = md5(stringToUtf8Bytes(payload)).toUpperCase();
          }
          Object.assign(headers, signHongguoRequest(url, { headers }));
          let response;
          try {
            ensureSearchTime(deadline, "红果请求", signal);
            const options = { headers, timeout: timeoutForSearch(deadline, HONGGUO_REQUEST_TIMEOUT_MS), signal };
            response = method === "GET"
              ? await httpGet(url, options)
              : await httpPost(url, payload, options);
          } finally {
            if (releaseCommentSlot) releaseCommentSlot();
          }
          ensureSearchTime(deadline, "红果请求", signal);
          const result = this.parseApiResponse(response);
          const responseError = this.checkResponse(result);
          if (responseError) throw responseError;
          this.preferredApiHost = apiHost;
          return result;
        } catch (error) {
          if (isSearchCancellation(error, deadline, signal)) throw error;
          if (error && error.coolDownMs) {
            // 短冷却可在当前主机内等待；长冷却直接换线/失败，避免把详情或弹幕请求挂住。
            if (error.coolDownMs <= SEARCH_COOLDOWN_MAX_WAIT_MS) {
              log("warn", `[Hongguo] ${apiHost} 触发短风控冷却 ${Math.round(error.coolDownMs / 1000)}s，等待后重试`);
              await sleep(Math.min(error.coolDownMs + Math.floor(Math.random() * 250), remainingSearchTime(deadline)), signal);
              if (attempt < maxAttempts - 1) continue;
            }
          }
          const message = error && error.message ? error.message : String(error);
          failures.push({ host: apiHost, message });
          const nextApiHost = apiHosts[index + 1];
          if (nextApiHost) {
            log("warn", `[Hongguo] ${apiHost} 请求失败，切换到 ${nextApiHost}: ${message}`);
          }
          break;
        } finally {
          if (releaseCommentSlot) releaseCommentSlot();
        }
      }
    }
    const details = failures.map(({ host, message }) => `${host}: ${message}`).join(" | ");
    const requestError = new Error(`红果请求失败，${apiHosts.length} 条线路均不可用: ${details}`);
    requestError.name = "HongguoHostError";
    requestError.failures = failures;
    throw requestError;
  }

  async getSearchIdentity(forceRefresh = false, failedIdentity = null, options = {}) {
    ensureSearchTime(options.deadline ?? Infinity, "红果设备注册", options.signal);
    if (this.searchIdentityTask) return joinSharedTask(this.searchIdentityTask, options, "红果设备注册超时");
    const now = Date.now();
    const canReuse = !forceRefresh || (failedIdentity && this.searchIdentity !== failedIdentity);
    if (canReuse && this.searchIdentity && now - this.searchIdentityCreatedAt < ANONYMOUS_IDENTITY_TTL_MS) {
      return this.searchIdentity;
    }
    if (!forceRefresh && this.searchIdentityFailureUntil > now) {
      throw new Error("红果匿名设备注册失败，冷却中");
    }
    this.searchIdentity = null;
    this.searchIdentityCreatedAt = 0;
    const task = createSharedTask(async (signal) => {
      ensureSearchTime(Infinity, "红果设备注册", signal);
      const anonymous = createAnonymousIdentity();
      const body = await buildRegisterBody(anonymous, SEARCH_DEVICE, Date.now());
      const headers = buildRegisterHeaders(SEARCH_DEVICE, body);
      const targetUrl = `${REGISTER_ORIGIN}/service/2/device_register/?req_id=${encodeURIComponent(anonymous.reqId)}&tt_data=a`;
      let response;
      for (let attempt = 0; attempt < SEARCH_REGISTER_ATTEMPTS; attempt++) {
        const requestController = new AbortController();
        const cancelRequest = () => requestController.abort();
        signal.addEventListener("abort", cancelRequest, { once: true });
        try {
          ensureSearchTime(Infinity, "红果设备注册", signal);
          response = await withSearchDeadline(
            httpPost(targetUrl, body, { headers, timeout: SEARCH_REGISTER_TIMEOUT_MS, signal: requestController.signal }),
            Date.now() + SEARCH_REGISTER_TIMEOUT_MS,
            "红果设备注册请求超时",
            signal,
          );
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          if (attempt + 1 >= SEARCH_REGISTER_ATTEMPTS || !isTransientRegisterError(error)) {
            throw error;
          }
          log("warn", `[Hongguo] 匿名设备注册失败，准备重试: ${error.message}`);
          requestController.abort();
          await sleep(SEARCH_REGISTER_RETRY_DELAY_MS, signal);
        } finally {
          signal.removeEventListener("abort", cancelRequest);
          requestController.abort();
        }
      }
      ensureSearchTime(Infinity, "红果设备注册", signal);
      if (!response) throw new Error("红果匿名设备注册失败");
      const registered = parseRegisterResponse(response.data);
      const identity = { ...anonymous, ...registered, createdAt: Date.now() };
      this.searchIdentity = identity;
      this.searchIdentityCreatedAt = identity.createdAt;
      this.searchIdentityFailureUntil = 0;
      log("info", `[Hongguo] 匿名设备已注册 ${String(identity.deviceId).slice(0, 6)}***`);
      return identity;
    }, (finished) => {
      if (this.searchIdentityTask === finished) {
        this.searchIdentityTask = null;
        this.searchIdentityPromise = null;
      }
    });
    task.promise = task.promise.catch((error) => {
      if (!task.controller.signal.aborted && !this.searchIdentityTask) {
        this.searchIdentity = null;
        this.searchIdentityCreatedAt = 0;
        this.searchIdentityFailureUntil = Date.now() + ANONYMOUS_IDENTITY_FAILURE_TTL_MS;
      }
      if (!task.controller.signal.aborted) log("warn", `[Hongguo] 匿名设备注册失败: ${error.message}`);
      throw error;
    });
    this.searchIdentityTask = task;
    this.searchIdentityPromise = task.promise;
    return joinSharedTask(task, options, "红果设备注册超时");
  }

  buildSearchPairs(identity, keyword, offset, count, cursor = {}) {
    const pairs = [
      ["iid", identity.installId],
      ["device_id", identity.deviceId],
      ["ac", "wifi"],
      ["channel", SEARCH_DEVICE.channel],
      ["aid", String(SEARCH_AID)],
      ["app_name", "novelread"],
      ["cdid", identity.cdid],
      ["version_code", SEARCH_VERSION_CODE],
      ["version_name", SEARCH_VERSION_NAME],
      ["device_platform", "android"],
      ["os", "android"],
      ["ssmix", "a"],
      ["device_type", SEARCH_DEVICE.model],
      ["device_brand", SEARCH_DEVICE.brand],
      ["language", "zh"],
      ["os_api", String(SEARCH_DEVICE.osApi)],
      ["os_version", SEARCH_DEVICE.osVersion],
      ["manifest_version_code", SEARCH_VERSION_CODE],
      ["resolution", SEARCH_DEVICE.resolution],
      ["dpi", String(SEARCH_DEVICE.dpi)],
      ["update_version_code", SEARCH_VERSION_CODE],
      ["host_abi", "arm64-v8a"],
      ["dragon_device_type", "phone"],
      ["pv_player", SEARCH_VERSION_CODE],
      ["compliance_status", "0"],
      ["need_personal_recommend", "1"],
      ["player_so_load", "1"],
      ["is_android_pad_screen", "0"],
      ["openudid", identity.openudid],
      ["query", keyword],
      ["tab_type", SEARCH_TAB_TYPE],
      ["count", String(count)],
      ["offset", String(offset)],
      ["use_correct", "true"],
      ["bookshelf_search_plan", "4"],
      ["search_source", "1"],
      ["tab_name", "feed"],
      ["bookstore_tab", "16"],
      ["user_is_login", "0"],
    ];
    if (cursor.passback) pairs.push(["passback", String(cursor.passback)]);
    if (cursor.searchId) pairs.push(["search_id", String(cursor.searchId)]);
    return pairs;
  }

  async requestSearchPage(apiHost, identity, keyword, offset, count, options = {}) {
    const deadline = options.deadline ?? (Date.now() + SEARCH_TOTAL_BUDGET_MS);
    ensureSearchTime(deadline, "红果搜索请求", options.signal);
    const now = Date.now();
    const khronos = Math.floor(now / 1000);
    const cursor = options.cursor || {};
    const query = this.buildSearchPairs(identity, keyword, offset, count, cursor)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const url = `https://${apiHost}/reading/bookapi/search/tab/v?${query}&ts=${khronos}&_rticket=${now}`;
    const readingRandom = (readWord32LE(randomBytes(4)) & 0x7fffffff) || 1;
    const headers = {
      "Accept": "application/json; charset=utf-8",
      "x-xs-from-web": "0",
      "x-ss-req-ticket": String(now),
      "x-tt-request-tag": "t=0;n=0",
      "sdk-version": "2",
      "passport-sdk-version": "50561",
      "x-vc-bdturing-sdk-version": "3.7.2.cn",
      "x-tt-dt": "",
      "User-Agent": hongguoUserAgent(SEARCH_DEVICE),
      "x-ss-dp": "8662",
      "lc": "101",
      "x-reading-request": `${now}-${readingRandom}`,
      ...signHongguoSearchRequest(url, {
        deviceId: identity.deviceId,
        versionName: SEARCH_VERSION_NAME,
        timestamp: khronos,
      }),
      "x-argus": createArgus(getQueryString(url), "", khronos),
      "x-ladon": createLadon(khronos, SEARCH_AID),
    };
    const response = await httpGet(url, {
      headers,
      timeout: timeoutForSearch(deadline, SEARCH_REQUEST_TIMEOUT_MS),
      signal: options.signal,
    });
    const payload = this.parseApiResponse(response);
    const responseError = this.checkResponse(payload);
    if (responseError) throw responseError;
    return payload;
  }

  async throttleSearch(signal = null, deadline = Date.now() + SEARCH_TOTAL_BUDGET_MS) {
    while (true) {
      ensureSearchTime(deadline, "红果搜索", signal);
      const cooldownMs = this.searchCooldownUntil - Date.now();
      if (cooldownMs > SEARCH_COOLDOWN_MAX_WAIT_MS) {
        throw new HongguoSearchCooldownError(cooldownMs);
      }
      if (cooldownMs > 0) {
        await sleep(Math.min(cooldownMs, remainingSearchTime(deadline)), signal);
        continue;
      }
      await this.throttle(600, 401, signal, deadline);
      if (this.searchCooldownUntil <= Date.now()) return;
    }
  }

  async fetchSearchPage(keyword, offset, count, options = {}) {
    const deadline = options.deadline ?? (Date.now() + SEARCH_TOTAL_BUDGET_MS);
    const signal = options.signal || null;
    const cursor = options.cursor || {};
    ensureSearchTime(deadline, "红果搜索", signal);
    let identity = await withSearchDeadline(this.getSearchIdentity(false, null, { deadline, signal }), deadline, "红果设备注册超时", signal);
    const failures = [];
    for (let round = 0; round < 2; round++) {
      let sawEmptyResponse = false;
      for (const apiHost of this.getApiHosts()) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            ensureSearchTime(deadline, "红果搜索", signal);
            await this.throttleSearch(signal, deadline);
            ensureSearchTime(deadline, "红果搜索", signal);
            const payload = await withSearchDeadline(
              this.requestSearchPage(apiHost, identity, keyword, offset, count, { deadline, signal, cursor }),
              deadline,
              "红果搜索请求超时",
              signal,
            );
            this.preferredApiHost = apiHost;
            return payload;
          } catch (error) {
            if (isSearchCancellation(error, deadline, signal)) throw error;
            const coolDownMs = Number(error?.coolDownMs);
            if (Number.isFinite(coolDownMs) && coolDownMs > 0) {
              this.searchCooldownUntil = Math.max(
                this.searchCooldownUntil,
                Date.now() + Math.min(coolDownMs, SEARCH_COOLDOWN_MAX_MS),
              );
              if (coolDownMs > SEARCH_COOLDOWN_MAX_WAIT_MS) {
                throw new HongguoSearchCooldownError(coolDownMs);
              }
              if (attempt >= 2) throw error;
              log("warn", `[Hongguo] 搜索触发短风控冷却 ${Math.ceil(coolDownMs / 1000)}s，等待后重试当前线路`);
              continue;
            }
            const message = error && error.message ? error.message : String(error);
            failures.push({ host: apiHost, message });
            if (error?.code === "EMPTY_RESPONSE") sawEmptyResponse = true;
            break;
          }
        }
      }
      if (round === 0 && sawEmptyResponse) {
        log("warn", "[Hongguo] 搜索线路均未成功且存在空响应，刷新匿名设备后重试");
        identity = await withSearchDeadline(
          this.getSearchIdentity(true, identity, { deadline, signal }),
          deadline,
          "红果设备刷新超时",
          signal,
        );
        continue;
      }
      break;
    }
    const details = failures.map(({ host, message }) => `${host}: ${message}`).join(" | ");
    throw new Error(`红果搜索失败: ${details}`);
  }

  async search(keyword) {
    const results = [];
    const seen = new Set();
    let hasSuccessfulSearch = false;
    let timedOut = false;
    const controller = new AbortController();
    const deadline = Date.now() + SEARCH_TOTAL_BUDGET_MS;
    const timer = hasReliableTimers() ? setTimeout(() => controller.abort(), SEARCH_TOTAL_BUDGET_MS) : null;
    const appController = new AbortController();
    const appDeadline = deadline - SEARCH_FALLBACK_RESERVE_MS;
    try {
      let offset = 0;
      let cursor = { passback: "", searchId: "" };
      if (!hasReliableTimers()) log("info", "[Hongguo] 当前插件运行时没有原生定时器，使用网页搜索");
      try {
        for (let page = 0; hasReliableTimers() && page < 3 && results.length < MAX_SEARCH_ITEMS; page++) {
          const payload = await this.fetchSearchPage(keyword, offset, MAX_SEARCH_ITEMS, {
            deadline: appDeadline,
            signal: appController.signal,
            cursor,
          });
          if (!Array.isArray(payload?.search_tabs)) throw new Error("客户端搜索返回无效搜索结果");
          hasSuccessfulSearch = true;
          const tab = payload.search_tabs.find((item) => String(item?.tab_type) === SEARCH_TAB_TYPE);
          const data = Array.isArray(tab?.data) ? tab.data : [];
          for (const cell of data) {
            const item = parseSearchCell(cell);
            if (!item || seen.has(item.seriesId)) continue;
            seen.add(item.seriesId);
            results.push(item);
            if (results.length >= MAX_SEARCH_ITEMS) break;
          }
          const nextOffset = Number(tab?.next_offset);
          if (!tab?.has_more || !data.length || !Number.isFinite(nextOffset) || nextOffset <= offset) break;
          cursor = {
            passback: String(tab?.passback || cursor.passback || ""),
            searchId: String(tab?.search_id || cursor.searchId || ""),
          };
          offset = nextOffset;
        }
      } catch (error) {
        timedOut = controller.signal.aborted || Date.now() >= deadline;
        log("warn", `[Hongguo] 客户端搜索失败: ${error.message}，${results.length ? "保留已获取结果" : "尝试网页搜索"}`);
      } finally {
        appController.abort();
      }
      if (results.length) {
        log("info", `[Hongguo] 搜索找到 ${results.length} 个结果`);
        return results;
      }
      if (timedOut) {
        log("warn", `[Hongguo] 搜索超过 ${SEARCH_TOTAL_BUDGET_MS / 1000}s 预算，跳过网页兜底`);
        return [];
      }
      if (hasSuccessfulSearch) log("info", "[Hongguo] 客户端搜索未找到可用短剧，尝试网页搜索");
      try {
        for (let page = 1; page <= 3 && results.length < MAX_SEARCH_ITEMS; page++) {
          ensureSearchTime(deadline, "红果网页搜索", controller.signal);
          const targetUrl = `${WEB_ORIGIN}/api/search/result/?query=${encodeURIComponent(keyword)}&page=${page}`;
          const response = await httpGet(targetUrl, {
            headers: { accept: "application/json" },
            timeout: timeoutForSearch(deadline, SEARCH_WEB_TIMEOUT_MS),
            signal: controller.signal,
          });
          ensureSearchTime(deadline, "红果网页搜索", controller.signal);
          const { items, rawCount } = parseWebSearchApi(response.data);
          hasSuccessfulSearch = true;
          for (const item of items) {
            if (seen.has(item.seriesId)) continue;
            seen.add(item.seriesId);
            results.push(item);
            if (results.length >= MAX_SEARCH_ITEMS) break;
          }
          if (rawCount === 0) break;
        }
      } catch (error) {
        timedOut = isSearchCancellation(error, deadline, controller.signal);
        log("warn", `[Hongguo] web search unavailable: ${error.message}`);
      }
      if (results.length) return results;
      if (timedOut) {
        log("warn", `[Hongguo] 搜索超过 ${SEARCH_TOTAL_BUDGET_MS / 1000}s 预算，跳过 SSR 兜底`);
        return [];
      }
      try {
        ensureSearchTime(deadline, "红果网页搜索", controller.signal);
        const targetUrl = `${WEB_ORIGIN}/search/${encodeURIComponent(keyword)}`;
        const response = await httpGet(targetUrl, {
          headers: { accept: "text/html" },
          timeout: timeoutForSearch(deadline, SEARCH_WEB_TIMEOUT_MS),
          signal: controller.signal,
        });
        ensureSearchTime(deadline, "红果网页搜索", controller.signal);
        const html = typeof response.data === "string" ? response.data : "";
        if (html.includes('"searchList":')) hasSuccessfulSearch = true;
        const items = parseWebSearchResults(html)
          .map(normalizeWebSearchItem).filter(Boolean);
        if (items.length) return items.slice(0, MAX_SEARCH_ITEMS);
      } catch (error) {
        timedOut = isSearchCancellation(error, deadline, controller.signal);
        log("warn", `[Hongguo] web search SSR unavailable: ${error.message}`);
      }
      if (timedOut) {
        log("warn", `[Hongguo] 搜索超过 ${SEARCH_TOTAL_BUDGET_MS / 1000}s 预算`);
        return [];
      }
      log(hasSuccessfulSearch ? "info" : "error", hasSuccessfulSearch ? "[Hongguo] 未找到可用短剧" : "[Hongguo] 搜索失败");
      return [];
    } finally {
      if (timer !== null) clearTimeout(timer);
      controller.abort();
      appController.abort();
    }
  }

  async getEpisodes(seriesId, options = {}) {
    ensureSearchTime(options.deadline ?? Infinity, "红果详情", options.signal);
    const key = String(seriesId);
    const cached = this.episodeDetailsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cloneEpisodeDetails(cached.value);
    this.episodeDetailsCache.delete(key);
    const pending = this.pendingEpisodeDetails.get(key);
    if (pending) return cloneEpisodeDetails(await joinSharedTask(pending, options, "红果详情阶段超时"));
    const task = createSharedTask(async (signal) => {
      const deadline = Date.now() + HONGGUO_REQUEST_TIMEOUT_MS;
      const details = await withSearchDeadline(
        this.fetchEpisodeDetails(key, { signal, deadline }), deadline, "红果详情请求超时", signal,
      );
      ensureSearchTime(deadline, "红果详情", signal);
      const ttl = details.episodes.length ? EPISODE_DETAILS_TTL_MS : EPISODE_DETAILS_FAILURE_TTL_MS;
      this.episodeDetailsCache.set(key, { expiresAt: Date.now() + ttl, value: details });
      while (this.episodeDetailsCache.size > EPISODE_DETAILS_CACHE_MAX) {
        this.episodeDetailsCache.delete(this.episodeDetailsCache.keys().next().value);
      }
      return details;
    }, (finished) => {
      finished.controller.abort();
      if (this.pendingEpisodeDetails.get(key) === finished) this.pendingEpisodeDetails.delete(key);
    });
    this.pendingEpisodeDetails.set(key, task);
    return cloneEpisodeDetails(await joinSharedTask(task, options, "红果详情阶段超时"));
  }

  async fetchEpisodeDetails(seriesId, { signal = null, deadline = Date.now() + HONGGUO_REQUEST_TIMEOUT_MS } = {}) {
    const emptyDetails = { episodes: [], year: null, imageUrl: "" };
    const body = {
      biz_param: {
        detail_page_version: 0,
        disable_digg_stat: false,
        disable_video_relate_book: false,
        image_shrink_datas_str: IMAGE_SHRINK,
        need_all_video_definition: false,
        need_mp4_align: false,
        screen_width_px: "900",
        source: 7,
        use_os_player: false,
        use_server_dns: false,
      },
      series_id: String(seriesId),
    };

    const parseApiEpisodes = (payload) => {
      const responseData = payload && payload.data || {};
      const entry = responseData[String(seriesId)] || responseData;
      const videoData = entry && entry.video_data || {};
      if (isUgcAlbum(
        entry,
        entry?.video_detail,
        entry?.album_info,
        videoData,
        videoData.video_detail,
        videoData.album_info,
      )) {
        log("info", `[Hongguo] 跳过不支持的用户合集 ${seriesId}`);
        return emptyDetails;
      }
      const episodes = (videoData.video_list || []).map((item) => ({
        index: Number(item.vid_index) || 0,
        vid: String(item.vid || ""),
        title: String(item.episode_title || "").trim().slice(0, 30),
        duration: Math.max(0, Number(item.duration) || 0),
        commentCount: Math.max(0, Number(item.comment_count) || 0),
        imageUrl: extractImageUrl(item.episode_cover || item.cover),
      })).filter((item) => item.vid).sort((a, b) => a.index - b.index);
      if (!episodes.length) return null;
      return {
        episodes,
        year: extractYearFromTimestamp(videoData.create_time),
        imageUrl: extractImageUrl(videoData.series_cover) ||
          (episodes.find((episode) => episode.imageUrl) || {}).imageUrl ||
          "",
      };
    };

    try {
      ensureSearchTime(deadline, "红果详情", signal);
      const apiResult = hasReliableTimers()
        ? parseApiEpisodes(await this.request("POST", "/novel/player/multi_video_detail/v1/", { body, signal, deadline }))
        : null;
      if (apiResult) return apiResult;
      log("info", `[Hongguo] API detail returned no episodes for series ${seriesId}, falling back to web detail`);
    } catch (error) {
      if (isSearchCancellation(error, deadline, signal)) throw error;
      log("warn", `[Hongguo] API detail unavailable: ${error.message}, falling back to web detail`);
    }

    try {
      ensureSearchTime(deadline, "红果网页详情", signal);
      const targetUrl = `${WEB_ORIGIN}/detail?series_id=${encodeURIComponent(seriesId)}`;
      const response = await httpGet(targetUrl, {
        headers: { accept: "text/html" },
        timeout: timeoutForSearch(deadline, HONGGUO_REQUEST_TIMEOUT_MS),
        validStatusCodes: [404],
        signal,
      });
      ensureSearchTime(deadline, "红果网页详情", signal);
      if (response.status === 404) {
        log("info", `[Hongguo] 网页未收录剧集 ${seriesId}`);
        return emptyDetails;
      }
      const detail = parseWebSeriesDetail(typeof response.data === "string" ? response.data : "");
      if (detail && Array.isArray(detail.vid_list) && detail.vid_list.length) {
        return {
          episodes: detail.vid_list.map((item, index) => {
            const value = item && typeof item === "object" ? item : {};
            const vid = typeof item === "object"
              ? (value.vid || value.video_id || value.id || "")
              : item;
            if (!vid) return null;
            return {
              index: index + 1,
              vid: String(vid),
              title: String(value.episode_title || value.title || `第${index + 1}集`).trim().slice(0, 30),
              duration: Math.max(0, Number(value.duration || value.video_duration) || 0),
              commentCount: Math.max(0, Number(value.comment_count) || 0),
              imageUrl: extractImageUrl(value.episode_cover || value.cover),
            };
          }).filter(Boolean),
          year: extractYearFromTimestamp(detail.create_time),
          imageUrl: extractImageUrl(detail.series_cover),
        };
      }
    } catch (error) {
      if (isSearchCancellation(error, deadline, signal)) throw error;
      log("warn", `[Hongguo] web detail unavailable: ${error.message}`);
    }
    return emptyDetails;
  }

  async resolveEpisodeInfo(value) {
    let raw = typeof value === "object" && value !== null
      ? String(value.url || value.id || value.value || "")
      : String(value || "");
    raw = raw.trim();
    const embedded = raw.match(/hongguo:v1:[^\s#]+:[^\s#]+:\d+/);
    if (embedded) {
      try { return parseHongguoEpisodeId(embedded[0]); } catch { /* continue */ }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (raw.split("#", 1)[0].startsWith("hongguo:v1:")) return parseHongguoEpisodeId(raw);
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded === raw) break;
        raw = decoded;
      } catch { break; }
    }

    const player = parseHongguoPlayerUrl(raw);
    const cacheKey = `${player.seriesId}:${player.vid}`;
    let resolution = this.playerEpisodeResolutions.get(cacheKey);
    if (!resolution) {
      resolution = (async () => {
        const details = await this.getEpisodes(player.seriesId);
        const episode = details.episodes.find((item) => item.vid === player.vid);
        if (!episode) {
          throw new Error(`播放链接中的 vid ${player.vid} 不属于剧集 ${player.seriesId}`);
        }
        return {
          seriesId: player.seriesId,
          vid: player.vid,
          duration: episode.duration,
        };
      })();
      this.playerEpisodeResolutions.set(cacheKey, resolution);
    }

    try {
      return await resolution;
    } catch (error) {
      if (this.playerEpisodeResolutions.get(cacheKey) === resolution) {
        this.playerEpisodeResolutions.delete(cacheKey);
      }
      throw error;
    }
  }

  createCommentSlotRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.commentRequestWaiters.shift();
      if (next) {
        next(this.createCommentSlotRelease());
      } else {
        this.activeCommentRequests--;
      }
    };
  }

  async acquireCommentSlot() {
    if (this.activeCommentRequests < COMMENT_CONCURRENCY) {
      this.activeCommentRequests++;
      return this.createCommentSlotRelease();
    }
    return new Promise((resolve) => this.commentRequestWaiters.push(resolve));
  }

  resolveSeriesId(value) {
    if (isHongguoSeriesId(value)) return parseHongguoSeriesId(value).seriesId;
    if (String(value || "").split("#", 1)[0].startsWith("hongguo:v1:")) {
      return parseHongguoEpisodeId(value).seriesId;
    }
    return parseHongguoPlayerUrl(value).seriesId;
  }

  shouldMergeAllEpisodes(value) {
    return isHongguoSeriesId(value) || Boolean(globals.hongguoMergeAllEpisodes);
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    if (!Array.isArray(sourceAnimes)) return [];
    const transformed = [];
    const filtered = sourceAnimes.filter((item) => titleMatches(item.name, queryTitle, querySeason));
    const deadline = Date.now() + HONGGUO_HANDLE_ANIMES_BUDGET_MS;
    let detailsTimedOut = false;
    const detailsList = await mapWithConcurrency(filtered, 3, async (anime) => {
      if (Date.now() >= deadline) {
        detailsTimedOut = true;
        return null;
      }
      try {
        return await this.getEpisodes(anime.seriesId, { deadline });
      } catch (error) {
        if (isSearchCancellation(error, deadline)) {
          detailsTimedOut = true;
          return null;
        }
        log("warn", `[Hongguo] 获取剧集详情失败(${anime.seriesId}): ${error.message}`);
        return null;
      }
    });
    if (detailsTimedOut) {
      log("warn", `[Hongguo] 详情阶段超过 ${HONGGUO_HANDLE_ANIMES_BUDGET_MS / 1000}s 预算，已保留完成的剧集`);
    }
    for (let index = 0; index < filtered.length; index++) {
      const anime = filtered[index];
      const details = detailsList[index];
      if (!details) continue;
      const episodes = details.episodes;
      const links = globals.hongguoMergeAllEpisodes && episodes.length
        ? [{
            name: "全集",
            url: createHongguoSeriesId(anime.seriesId),
            title: "【hongguo】 全集",
          }]
        : episodes.map((episode) => {
            const episodeTitle = `第${episode.index}集${episode.title ? ` ${episode.title}` : ""}`;
            return {
              name: episodeTitle,
              url: createHongguoEpisodeId(anime.seriesId, episode.vid, episode.duration),
              title: `【hongguo】 ${episodeTitle}`,
            };
          });
      if (!links.length) continue;
      const year = Number.isInteger(anime.year)
        ? anime.year
        : (Number.isInteger(details.year) ? details.year : null);
      const item = {
        animeId: convertToAsciiSum(anime.seriesId),
        bangumiId: String(anime.seriesId),
        animeTitle: `${anime.name}${year ? `(${year})` : ""}【短剧】from hongguo`,
        type: "短剧",
        typeDescription: "短剧",
        imageUrl: anime.imageUrl || details.imageUrl || "",
        startDate: generateValidStartDate(year),
        episodeCount: links.length,
        rating: Number(anime.score) || 0,
        isFavorited: true,
        source: "hongguo",
      };
      transformed.push(item);
      addAnime({ ...item, links }, detailStore);
      if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
    }
    this.sortAndPushAnimesByYear(transformed, curAnimes);
    return transformed;
  }

  buildCommentBody(info, startMs, cursor) {
    return {
      comment_source: COMMENT_SOURCE,
      server_channel: SERVER_CHANNEL,
      group_id: info.vid,
      group_type: 30,
      comment_type: 20,
      sort: 1,
      business_param: {
        book_id: info.seriesId,
        start_offset_time: Math.max(0, Math.trunc(startMs)),
        playlet_item_duration: Math.max(0, Math.trunc(info.duration * 1000)),
        need_danmaku_guide_type: [1, 3, 4, 2],
      },
      count: COMMENT_COUNT,
      cursor: String(cursor || ""),
      aid: Number(CLIENT_CONFIG.baseQuery.aid),
      compliance_status: 0,
    };
  }

  async fetchCommentWindow(info, startMs, cursor = "") {
    const path = `/novel/commentapi/comment/list/${encodeURIComponent(info.vid)}/v1/`;
    const payload = await this.request("POST", path, {
      body: this.buildCommentBody(info, startMs, cursor),
      comment: true,
    });
    const data = payload.data || {};
    const listInfo = data.common_list_info || {};
    const extra = data.extra || {};
    let nextStart = Number(extra.next_query_danmaku_list_time);
    if (!Number.isFinite(nextStart)) nextStart = startMs + COMMENT_WINDOW_MS;
    if (nextStart <= startMs) nextStart = startMs + COMMENT_WINDOW_MS;
    return {
      comments: parseDanmuResponse(payload),
      nextStart,
      cursor: String(listInfo.cursor || ""),
      hasMore: Boolean(listInfo.has_more),
    };
  }

  async getDanmuForEpisode(info) {
    const durationMs = info.duration * 1000;
    const comments = [];
    const seenMarkers = new Set();
    let startMs = 0;
    let cursor = "";
    const maxRequests = Math.max(1, Math.ceil(durationMs / COMMENT_WINDOW_MS) + 5);
    for (let requestIndex = 0; requestIndex < maxRequests; requestIndex++) {
      const marker = `${startMs}:${cursor}`;
      if (seenMarkers.has(marker)) break;
      seenMarkers.add(marker);
      const page = await this.fetchCommentWindow(info, startMs, cursor);
      comments.push(...page.comments);
      if (durationMs && page.nextStart >= durationMs) break;
      if (!page.hasMore && !durationMs) break;
      startMs = page.nextStart;
      cursor = page.cursor;
    }
    return comments;
  }

  async getSeriesDanmu(seriesId) {
    const details = await this.getEpisodes(seriesId);
    let cumulativeMs = 0;
    const episodeTasks = details.episodes.map((episode) => {
      const task = { episode, offsetMs: cumulativeMs };
      cumulativeMs += Math.max(0, Number(episode.duration) || 0) * 1000;
      return task;
    });
    const groupedComments = await mapWithConcurrency(episodeTasks, COMMENT_CONCURRENCY, async ({ episode, offsetMs }) => {
      const episodeComments = await this.getDanmuForEpisode({
        seriesId: String(seriesId),
        vid: episode.vid,
        duration: episode.duration,
      });
      return episodeComments.map((comment) => ({
        ...comment,
        offsetMs: comment.offsetMs + offsetMs,
      }));
    });
    const comments = [];
    for (const episodeComments of groupedComments) {
      comments.push(...episodeComments);
    }
    return dedupeDanmus(comments);
  }

  async getEpisodeDanmu(id) {
    try {
      if (this.shouldMergeAllEpisodes(id)) {
        return await this.getSeriesDanmu(this.resolveSeriesId(id));
      }
      const info = await this.resolveEpisodeInfo(id);
      const cacheKey = `${info.seriesId}:${info.vid}`;
      // in-flight 去重：同一集并发请求只抓取一次，避免重复命中接口加重风控
      const pending = this.pendingEpisodeDanmu.get(cacheKey);
      if (pending) {
        log("info", `[Hongguo] 复用进行中的整段弹幕请求: ${cacheKey}`);
        return pending;
      }
      const task = (async () => {
        const comments = dedupeDanmus(await this.getDanmuForEpisode(info));
        if (!info.duration && comments.length) {
          const maxOffset = Math.max(...comments.map((item) => Number(item.offsetMs) || 0));
          if (maxOffset > 0) this.durationCache.set(cacheKey, Math.ceil(maxOffset / 1000) + 30);
        }
        this.lastDanmu = comments;
        return comments;
      })().catch((error) => {
        // 仅网络/风控等抓取阶段失败才允许回退 lastDanmu
        const fetchError = new Error(`弹幕抓取失败: ${error.message}`);
        fetchError.danmuFetchFailed = true;
        throw fetchError;
      }).finally(() => {
        this.pendingEpisodeDanmu.delete(cacheKey);
      });
      this.pendingEpisodeDanmu.set(cacheKey, task);
      return task;
    } catch (error) {
      log("error", `[Hongguo] 获取弹幕失败(${String(id).slice(0, 80)}): ${error.message}`);
      // 链接/ID 解析失败等不应回退旧数据，避免误报并重复输出；仅抓取失败时回退最近一次成功结果
      if (error.danmuFetchFailed && this.lastDanmu && this.lastDanmu.length) return this.lastDanmu;
      return [];
    }
  }

  async getEpisodeDanmuSegments(id) {
    try {
      if (this.shouldMergeAllEpisodes(id)) {
        return await this.getSeriesDanmuSegments(this.resolveSeriesId(id));
      }
      const info = await this.resolveEpisodeInfo(id);
      const episodeId = createHongguoEpisodeId(info.seriesId, info.vid, info.duration);
      const segmentList = [];
      // 详情页偶尔没有对应播放器页（通常是后续集），用 10 分钟窗口覆盖短剧常见时长；
      // 弹幕接口会在无更多数据时提前停止，不会实际请求完整 10 分钟。
      let effectiveDuration = info.duration > 0 ? info.duration : this.durationCache.get(`${info.seriesId}:${info.vid}`) || 0;
      if (!effectiveDuration) {
        const comments = await this.getDanmuForEpisode(info);
        const maxOffset = comments.reduce((max, item) => Math.max(max, Number(item.offsetMs) || 0), 0);
        effectiveDuration = maxOffset > 0 ? Math.ceil(maxOffset / 1000) + 30 : 600;
        this.durationCache.set(`${info.seriesId}:${info.vid}`, effectiveDuration);
      }
      for (let start = 0; start < effectiveDuration; start += COMMENT_WINDOW_MS / 1000) {
        segmentList.push({
          type: "hongguo",
          segment_start: start,
          segment_end: Math.min(start + COMMENT_WINDOW_MS / 1000, effectiveDuration),
          url: `${episodeId}#segment=${start}`,
        });
      }
      return new SegmentListResponse({ type: "hongguo", segmentList, duration: effectiveDuration });
    } catch (error) {
      log("error", `[Hongguo] 创建弹幕分段失败: ${error.message}`);
      return new SegmentListResponse({ type: "hongguo", segmentList: [] });
    }
  }

  async getSeriesDanmuSegments(seriesId) {
    const details = await this.getEpisodes(seriesId);
    const segmentList = [];
    let cumulativeSeconds = 0;
    for (const episode of details.episodes) {
      const duration = Math.max(0, Number(episode.duration) || 600);
      const episodeId = createHongguoEpisodeId(seriesId, episode.vid, duration);
      for (let start = 0; start < duration; start += COMMENT_WINDOW_MS / 1000) {
        const end = Math.min(start + COMMENT_WINDOW_MS / 1000, duration);
        segmentList.push({
          type: "hongguo",
          segment_start: cumulativeSeconds + start,
          segment_end: cumulativeSeconds + end,
          url: `${episodeId}#segment=${start}&offset=${cumulativeSeconds}`,
        });
      }
      cumulativeSeconds += duration;
    }
    return new SegmentListResponse({ type: "hongguo", segmentList, duration: cumulativeSeconds });
  }

  async getEpisodeSegmentDanmu(segment) {
    try {
      const segmentUrl = typeof segment === "string" ? segment : segment.url;
      const info = await this.resolveEpisodeInfo(segmentUrl);
      const globalOffsetSeconds = Math.max(0, getFragmentNumber(segmentUrl, "offset") || 0);
      const fragmentStart = getFragmentNumber(segmentUrl, "segment");
      const localStartSeconds = Math.max(0, fragmentStart == null
        ? Number(segment.segment_start || 0) - globalOffsetSeconds
        : fragmentStart);
      const segmentDurationSeconds = typeof segment === "string" ? COMMENT_WINDOW_MS / 1000 : Math.max(0, Number(segment.segment_end) - Number(segment.segment_start));
      const localEndSeconds = Math.min(info.duration > 0 ? info.duration : localStartSeconds + segmentDurationSeconds, localStartSeconds + segmentDurationSeconds);
      const startMs = localStartSeconds * 1000;
      const endMs = Math.max(startMs, localEndSeconds * 1000);
      const page = await this.fetchCommentWindow(info, startMs, "");
      const offsetMs = globalOffsetSeconds * 1000;
      return dedupeDanmus(page.comments
        .filter((item) => item.offsetMs >= startMs && item.offsetMs < endMs)
        .map((item) => ({ ...item, offsetMs: item.offsetMs + offsetMs })));
    } catch (error) {
      log("error", `[Hongguo] 获取分段弹幕失败: ${error.message}`);
      return [];
    }
  }

  formatComments(comments) {
    return comments.map((comment) => ({
      p: `${(comment.offsetMs / 1000).toFixed(2)},1,16777215,[hongguo]`,
      m: comment.text,
      t: comment.offsetMs / 1000,
      like: comment.diggCount,
    }));
  }
}
