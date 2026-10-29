// 红果源：由剧集 ID 计算分段（无需联网）
// 由 danmu_api/tests/manual/live-source-checks.js 中无需联网的用例提取而来，用例名与断言未改。

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { getSourceByKey } from '../../sources/registry.js';
import HongguoSource, {
  createArgus, createLadon, buildGorgonSeed, transformGorgonSeed, signHongguoRequest,
  createHongguoEpisodeId, parseHongguoEpisodeId, createHongguoSeriesId, parseHongguoSeriesId,
  isHongguoSeriesId, isHongguoPlayerUrl, parseHongguoPlayerUrl,
} from '../../sources/hongguo.js';
import { mockJsonResponse, resetSearchState } from '../helpers/context.js';
import { Globals } from '../../configs/globals.js';
import { searchAnime } from '../../apis/dandan-api.js';

const hongguoSource = getSourceByKey('hongguo');

test('GET hongguo danmu segments', async () => {
  const episodeId = 'hongguo:v1:series-1:vid-1:60';
  const res = await hongguoSource.getComments(episodeId, 'hongguo', true);
  assert.equal(res.type, 'hongguo');
  assert.equal(res.duration, 60);
  assert.equal(res.segmentList.length, 2);
  assert.notEqual(res.segmentList[0].url, res.segmentList[1].url);
});

// 以下为红果源的纯函数用例：签名算法、gorgon 种子与剧集/全集 ID 编解码，全部离线。

test('hongguo createArgus 注入随机数后稳定，随 query/stub/时间戳变化', () => {
  // argusProtobuf 内部有随机字段（可签次数与随机值），注入 argusRandom/argusSignCount 后整体可复现
  const fixed = { argusRandom: 0x11223344, argusSignCount: 4 };
  const query = '/api/v1/episode';
  const stub = 'a'.repeat(32);
  const first = createArgus(query, stub, 1700000000, fixed);
  assert.match(first, /^[A-Za-z0-9+/]+={0,2}$/, '输出为 base64');
  assert.strictEqual(createArgus(query, stub, 1700000000, fixed), first, '同入参同注入随机数必须得到同一签名');
  assert.notStrictEqual(createArgus('/api/v1/other', stub, 1700000000, fixed), first, 'query 参与签名');
  assert.notStrictEqual(createArgus(query, 'b'.repeat(32), 1700000000, fixed), first, 'stub 参与签名');
  assert.notStrictEqual(createArgus(query, stub, 1700000001, fixed), first, '时间戳参与签名');
  assert.notStrictEqual(createArgus(query, stub, 1700000000, { ...fixed, argusRandom: 0x55667788 }), first,
    '注入的随机值参与签名');
});

test('hongguo createLadon 注入随机前缀后确定，且校验前缀长度', () => {
  const options = { ladonRandom: [1, 2, 3, 4] };
  const first = createLadon(1700000000, 12345, options);
  assert.strictEqual(createLadon(1700000000, 12345, options), first, '同入参同随机前缀必须稳定');
  assert.notStrictEqual(createLadon(1700000000, 54321, options), first, 'aid 参与加密');
  assert.notStrictEqual(createLadon(1700000001, 12345, options), first, '时间戳参与加密');
  assert.notStrictEqual(createLadon(1700000000, 12345, { ladonRandom: [1, 2, 3, 5] }), first, '随机前缀参与加密');
  assert.match(first, /^[A-Za-z0-9+/]+={0,2}$/, '输出为 base64');
  assert.throws(() => createLadon(1700000000, 12345, { ladonRandom: [1, 2, 3] }), RangeError,
    '随机前缀必须是 4 字节');
});

test('hongguo buildGorgonSeed 生成 20 字节种子并校验 khronos', () => {
  const url = 'https://api.hongguoduanju.com/api/v1/episode?aid=123&vid=456';
  const seed = buildGorgonSeed(url, { headers: {}, body: null, khronos: 1700000000 });
  assert.ok(seed instanceof Uint8Array);
  assert.strictEqual(seed.length, 20, 'query(4) + body(4) + cookie(4) + 固定 4 + 时间戳(4)');
  assert.strictEqual(Buffer.from(seed.slice(16)).toString('hex'), (1700000000 >>> 0).toString(16).padStart(8, '0'),
    '末尾 4 字节为大端 khronos');
  assert.strictEqual(Buffer.from(buildGorgonSeed(url, { headers: {}, body: null, khronos: 1700000000 })).toString('hex'),
    Buffer.from(seed).toString('hex'), '同入参稳定');

  const withStub = buildGorgonSeed(url, { headers: { 'x-ss-stub': 'c'.repeat(32) }, body: null, khronos: 1700000000 });
  assert.notStrictEqual(Buffer.from(withStub).toString('hex'), Buffer.from(seed).toString('hex'), 'stub 参与种子');
  const withBody = buildGorgonSeed(url, { headers: {}, body: '{"a":1}', khronos: 1700000000 });
  assert.notStrictEqual(Buffer.from(withBody).toString('hex'), Buffer.from(seed).toString('hex'), 'body 摘要参与种子');
  const withCookie = buildGorgonSeed(url, { headers: { cookie: 'sid=abc' }, body: null, khronos: 1700000000 });
  assert.notStrictEqual(Buffer.from(withCookie).toString('hex'), Buffer.from(seed).toString('hex'), 'cookie 摘要参与种子');

  for (const khronos of [-1, 1.5, 0x1_0000_0000, '1700000000', null, undefined]) {
    assert.throws(() => buildGorgonSeed(url, { khronos }), RangeError, `khronos=${String(khronos)} 非法`);
  }
});

test('hongguo transformGorgonSeed 产出 26 字节并回填 header 字段', () => {
  const seed = new Uint8Array(20).map((_, i) => i + 1);
  const out = transformGorgonSeed(seed, { headerByte2: 0x21, headerByte3: 0xe3, parameter: 0x1234 });
  assert.strictEqual(out.length, 26, '6 字节头 + 20 字节载荷');
  assert.deepStrictEqual(Array.from(out.slice(0, 6)), [0x84, 0x04, 0x21, 0xe3, 0x34, 0x12], '头部为大端 parameter');
  assert.strictEqual(Buffer.from(out).toString('hex'),
    Buffer.from(transformGorgonSeed(seed, { headerByte2: 0x21, headerByte3: 0xe3, parameter: 0x1234 })).toString('hex'),
    '同入参稳定');
  assert.notStrictEqual(Buffer.from(transformGorgonSeed(seed, { headerByte2: 0x22, headerByte3: 0xe3 })).toString('hex'),
    Buffer.from(out).toString('hex'), 'headerByte2 参与变换');
  assert.notStrictEqual(Buffer.from(transformGorgonSeed(seed, { headerByte2: 0x21, headerByte3: 0xe4 })).toString('hex'),
    Buffer.from(out).toString('hex'), 'headerByte3 参与变换');
  assert.throws(() => transformGorgonSeed(new Uint8Array(19), {}), TypeError, '种子必须是 20 字节');
});

test('hongguo signHongguoRequest 生成四个签名头且参数可复现', () => {
  const url = 'https://api.hongguoduanju.com/api/v1/episode?aid=123456&vid=789';
  // X-Argus / X-Ladon 内部含随机字段，注入后整个签名集合可完整复现
  const options = {
    timestamp: 1700000000, headerByte2: 0x21, headerByte3: 0xe3,
    ladonRandom: [9, 8, 7, 6], argusRandom: 0x11223344, argusSignCount: 4,
  };
  const headers = signHongguoRequest(url, options);
  assert.deepStrictEqual(Object.keys(headers).sort(),
    ['X-Argus', 'X-Gorgon', 'X-Khronos', 'X-Ladon'], '四个签名头缺一不可');
  assert.strictEqual(headers['X-Khronos'], '1700000000');
  assert.match(headers['X-Gorgon'], /^[0-9a-f]{52}$/, 'X-Gorgon 为 26 字节十六进制');
  assert.match(headers['X-Argus'], /^[A-Za-z0-9+/]+={0,2}$/);
  assert.deepStrictEqual(signHongguoRequest(url, options), headers, '同入参同注入随机数必须完全复现');

  assert.notStrictEqual(signHongguoRequest(url, { ...options, parameter: 7 })['X-Gorgon'], headers['X-Gorgon'],
    'parameter 影响 X-Gorgon');
  assert.throws(() => signHongguoRequest('https://api.hongguoduanju.com/api/v1/episode?vid=789', options),
    TypeError, '缺少数值 aid 时必须报错');
  assert.throws(() => signHongguoRequest(url, { timestamp: -1 }), RangeError, '时间戳必须是无符号 32 位');
});

test('hongguo 剧集/全集 ID 编解码往返（含特殊字符与偏移后缀）', () => {
  const episodeId = createHongguoEpisodeId('series-1', 'vid-1', 60.9);
  assert.strictEqual(episodeId, 'hongguo:v1:series-1:vid-1:60', '时长向下取整');
  assert.deepStrictEqual(parseHongguoEpisodeId(episodeId), { seriesId: 'series-1', vid: 'vid-1', duration: 60 });
  assert.deepStrictEqual(parseHongguoEpisodeId(`${episodeId}#seg-2`), { seriesId: 'series-1', vid: 'vid-1', duration: 60 },
    '解析时忽略 # 之后的定位信息');
  assert.deepStrictEqual(parseHongguoEpisodeId(createHongguoEpisodeId('剧名:特别篇', 'vid:1', -5)),
    { seriesId: '剧名:特别篇', vid: 'vid:1', duration: 0 }, '特殊字符需转义，负时长归零');

  const seriesId = createHongguoSeriesId('series:1');
  assert.strictEqual(seriesId, 'hongguo:series:v1:series%3A1');
  assert.deepStrictEqual(parseHongguoSeriesId(seriesId), { seriesId: 'series:1' });
  assert.strictEqual(isHongguoSeriesId(seriesId), true);
  assert.strictEqual(isHongguoSeriesId(episodeId), false, '剧集 ID 不是全集 ID');
  assert.strictEqual(isHongguoSeriesId('random'), false);

  assert.throws(() => parseHongguoEpisodeId('hongguo:v1:a:b'), /无效的红果剧集 ID/);
  assert.throws(() => parseHongguoEpisodeId(''), /无效的红果剧集 ID/);
  assert.throws(() => parseHongguoSeriesId('hongguo:v1:a:b:1'), /无效的红果全集 ID/);
});

test('hongguo parseHongguoPlayerUrl 支持播放页、剧集 ID 与偏移后缀', () => {
  const playerUrl = 'https://www.hongguoduanju.com/player/1234/5678/?foo=bar#hash';
  assert.deepStrictEqual(parseHongguoPlayerUrl(playerUrl), { seriesId: '1234', vid: '5678' });
  assert.deepStrictEqual(parseHongguoPlayerUrl('http://hongguoduanju.com:8080/player/1234/5678'),
    { seriesId: '1234', vid: '5678' }, '支持 http、自定义端口与省略 www');

  const episodeId = createHongguoEpisodeId('series-1', 'vid-1', 60);
  assert.deepStrictEqual(parseHongguoPlayerUrl(episodeId), { seriesId: 'series-1', vid: 'vid-1' });
  for (const suffix of ['@90', '@%50', '@-30', '@% -30'.replace(' ', '')]) {
    assert.deepStrictEqual(parseHongguoPlayerUrl(`${playerUrl}${suffix}`), { seriesId: '1234', vid: '5678' },
      `偏移后缀 ${suffix} 不参与解析`);
  }

  assert.strictEqual(isHongguoPlayerUrl(playerUrl), true);
  assert.strictEqual(isHongguoPlayerUrl('https://example.com/player/1/2'), false);
  assert.strictEqual(isHongguoPlayerUrl(''), false);
  assert.throws(() => parseHongguoPlayerUrl('https://www.hongguoduanju.com/player/1234'), /无效的红果短剧播放链接/);
});

function guestResponse(sequence = 1, separator = ', ') {
  const response = mockJsonResponse({
    device_id_str: `760000000000000000${sequence}`,
    install_id_str: `770000000000000000${sequence}`,
    device_id: 7600000000000000000,
    device_token: 'unused-account-token',
  });
  response.headers.set('set-cookie', [
    'store-region=cn-gd; Path=/; Expires=Thu, 29 Oct 2026 12:00:00 GMT',
    'store-region-src=did; Path=/',
    `ttreq=guest-${sequence}==; Path=/; HttpOnly`,
    'unrelated=not-forwarded; Path=/',
  ].join(separator));
  return response;
}

test('hongguo 匿名注册并发复用、精确保留长 ID、过滤 Cookie 且 12 小时后刷新', async (t) => {
  let now = 1700000000000;
  let registrations = 0;
  const requests = [];
  const registrationBodies = [];
  const source = new HongguoSource();
  source.throttle = async () => {};
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    if (request.pathname === '/service/2/device_register/') {
      registrations++;
      const body = JSON.parse(options.body);
      registrationBodies.push(body);
      assert.equal(body.magic_tag, 'ss_app_log');
      assert.equal(body.header.req_id, request.searchParams.get('req_id'));
      assert.equal(body.header.device_id, '0');
      assert.equal(body.header.install_id, '0');
      assert.match(body.header.cdid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.match(body.header.openudid, /^[0-9a-f]{16}$/);
      assert.equal(options.headers['content-type'], 'application/json; charset=utf-8');
      assert.ok(!options.headers.cookie);
      return guestResponse(registrations, registrations === 1 ? ', ' : ';');
    }
    requests.push(request);
    const body = registrationBodies.at(-1).header;
    assert.equal(request.searchParams.get('device_id'), `760000000000000000${registrations}`);
    assert.equal(request.searchParams.get('iid'), `770000000000000000${registrations}`);
    assert.equal(request.searchParams.get('cdid'), body.cdid);
    assert.equal(request.searchParams.get('openudid'), body.openudid);
    assert.equal(request.searchParams.get('version_name'), body.app_version);
    assert.equal(request.searchParams.get('device_type'), body.device_model);
    assert.equal(options.headers.lc, '101');
    assert.equal(options.headers['x-tt-store-region'], 'cn-gd');
    assert.match(options.headers.cookie, new RegExp(`ttreq=guest-${registrations}==`));
    assert.match(options.headers.cookie, new RegExp(`install_id=770000000000000000${registrations}`));
    assert.doesNotMatch(options.headers.cookie, /Path|Expires|HttpOnly|unrelated|unused-account-token/);
    assert.ok(!options.headers['x-tt-token']);
    assert.match(options.headers['X-Gorgon'], /^[a-f0-9]{52}$/);
    return mockJsonResponse({ code: 0 }, url);
  });

  await Promise.all(Array.from({ length: 4 }, () => source.request('GET', '/reading/bookapi/search/tab/v')));
  assert.equal(registrations, 1);
  assert.equal(requests.length, 4);
  now += 12 * 60 * 60 * 1000 - 1;
  await source.request('GET', '/reading/bookapi/search/tab/v');
  assert.equal(registrations, 1);
  now++;
  await Promise.all(Array.from({ length: 3 }, () => source.request('GET', '/reading/bookapi/search/tab/v')));
  assert.equal(registrations, 2);
  assert.notEqual(registrationBodies[0].header.cdid, registrationBodies[1].header.cdid);
  assert.equal(source.pendingGuestSession, null);
});

test('hongguo 注册失败不缓存半成品，下次调用可重试', async (t) => {
  const invalidResponses = [
    { data: '' },
    { data: { device_id_str: '0', install_id_str: '7700000000000000001' }, cookie: 'ttreq=fixture' },
    { data: { device_id: 7600000000000000000, install_id: 7700000000000000000 }, cookie: 'ttreq=fixture' },
    { data: { device_id_str: '7600000000000000001', install_id_str: '7700000000000000001' } },
  ];
  for (const invalid of invalidResponses) {
    await t.test(JSON.stringify(invalid), async (subtest) => {
      const source = new HongguoSource();
      let registrations = 0;
      subtest.mock.method(globalThis, 'fetch', async () => {
        registrations++;
        if (registrations > 1) return guestResponse();
        const response = mockJsonResponse(invalid.data);
        if (invalid.cookie) response.headers.set('set-cookie', invalid.cookie);
        return response;
      });
      const results = await Promise.allSettled([source.ensureGuestSession(), source.ensureGuestSession()]);
      assert.ok(results.every((result) => result.status === 'rejected'));
      assert.equal(registrations, 1);
      assert.equal(source.guestSession, null);
      assert.equal(source.pendingGuestSession, null);
      const session = await source.ensureGuestSession();
      assert.equal(await source.ensureGuestSession(), session);
      assert.equal(registrations, 2);
    });
  }
});

test('hongguo 匿名注册不依赖 WebCrypto、randomUUID 或二进制请求体', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(typeof options.body, 'string');
    const body = JSON.parse(options.body);
    assert.match(body.header.cdid, /^[a-f0-9-]{36}$/);
    return guestResponse();
  });
  const source = new HongguoSource();
  const session = await source.ensureGuestSession();
  assert.equal(session.query.device_id, '7600000000000000001');
});

test('hongguo 设备拒绝只刷新一次，并发失败共用新身份', async (t) => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  source.getApiHosts = () => [source.preferredApiHost];
  let registrations = 0;
  let rejected = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    if (request.pathname === '/service/2/device_register/') return guestResponse(++registrations);
    if (request.searchParams.get('device_id') === '7600000000000000001') {
      rejected++;
      return mockJsonResponse({ BaseResp: { StatusCode: rejected % 2 ? 263175 : 263176 } });
    }
    return mockJsonResponse({ code: 0 });
  });
  const results = await Promise.all(Array.from({ length: 3 }, () => source.request('GET', '/reading/bookapi/search/tab/v')));
  assert.ok(results.every((result) => result.code === 0));
  assert.equal(registrations, 2);
  assert.equal(rejected, 3);

  t.mock.method(globalThis, 'fetch', async (url) => new URL(url).pathname === '/service/2/device_register/'
    ? guestResponse(++registrations)
    : mockJsonResponse({ BaseResp: { StatusCode: 263175 } }));
  await assert.rejects(source.request('GET', '/reading/bookapi/search/tab/v'), /匿名设备身份已失效/);
  assert.equal(registrations, 3);
});

test('hongguo 优先 App 搜索并携带匿名参数，支持嵌套 series_id、分页与去重', async () => {
  const source = new HongguoSource();
  let requests = 0;
  source.searchWeb = async () => assert.fail('App 搜索成功不应请求网页');
  const cell = { video_data: [{ series_id: '7600000000000000001', title: '测试短剧', episode_cnt: 2 }] };
  source.request = async (method, path, { extraQuery }) => {
    requests++;
    assert.equal(method, 'GET');
    assert.equal(path, '/reading/bookapi/search/tab/v');
    assert.equal(extraQuery.tab_type, '11');
    assert.equal(extraQuery.user_is_login, '0');
    assert.equal(extraQuery.count, '20');
    assert.equal(extraQuery.bookshelf_search_plan, '4');
    assert.equal(extraQuery.bookstore_tab, '16');
    if (requests === 2) {
      assert.equal(extraQuery.offset, '20');
      assert.equal(extraQuery.passback, 'next-page');
      assert.equal(extraQuery.search_id, 'search-fixture');
      cell.video_data[0].series_id = 7600000000000000000;
      cell.video_data[0].video_detail = { series_id_str: '7600000000000000001' };
    }
    return { search_tabs: [
      { tab_type: 1 },
      { tab_type: 11, data: [cell], has_more: requests === 1, next_offset: 20, passback: 'next-page', search_id: 'search-fixture' },
    ] };
  };
  const results = await source.search('测试短剧');
  assert.equal(requests, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].seriesId, '7600000000000000001');
  assert.equal(results[0].episodeCount, 2);
  assert.equal(results[0].name, '测试短剧');
});

test('hongguo App 不可用时保留网页兜底，正常空结果不额外请求网页', async (t) => {
  const source = new HongguoSource();
  t.mock.method(console, 'error', () => {});
  let webRequests = 0;
  const expected = [{ seriesId: '7600000000000000001' }];
  source.searchWeb = async () => { webRequests++; return expected; };
  source.request = async () => { throw new Error('fixture registration unavailable'); };
  assert.deepEqual(await source.search('短剧'), expected);
  assert.equal(webRequests, 1);
  source.request = async () => ({ code: 0, search_tabs: [] });
  assert.deepEqual(await source.search('不存在的短剧'), []);
  assert.equal(webRequests, 1);
});

test('hongguo 分集及弹幕复用同一匿名会话，保留原有弹幕签名约定', async (t) => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  const seriesId = '7600000000000000001';
  const vid = '7600000000000000002';
  let registrations = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url);
    if (request.pathname === '/service/2/device_register/') return guestResponse(++registrations);
    assert.match(options.headers.cookie, /ttreq=guest-1==/);
    const body = JSON.parse(options.body);
    if (request.pathname === '/novel/player/multi_video_detail/v1/') {
      assert.equal(body.series_id, seriesId);
      assert.match(options.headers['x-ss-stub'], /^[A-F0-9]{32}$/);
      return mockJsonResponse({ code: 0, data: { [seriesId]: { video_data: {
        video_list: [{ vid, vid_index: 1, duration: 60 }],
      } } } });
    }
    assert.equal(request.pathname, `/novel/commentapi/comment/list/${vid}/v1/`);
    assert.equal(options.headers['x-ss-stub'], '');
    assert.equal(options.headers['comment-source'], '601');
    assert.equal(options.headers['server-channel'], '1000');
    assert.equal(body.group_id, vid);
    assert.equal(body.business_param.book_id, seriesId);
    return mockJsonResponse({ code: 0, data: {
      data_list: [{ comment: { comment_id: 'comment-1', common: { content: { text: '测试弹幕' } }, expand: { offset_time: 1234 } } }],
      common_list_info: { has_more: false },
    } });
  });
  const details = await source.getEpisodes(seriesId);
  assert.equal(details.episodes.length, 1);
  const result = await source.fetchCommentWindow({ seriesId, ...details.episodes[0] }, 0);
  assert.equal(result.comments[0].text, '测试弹幕');
  assert.equal(result.comments[0].offsetMs, 1234);
  assert.equal(registrations, 1);
});

function readySource() {
  const source = new HongguoSource();
  source.guestSession = { query: {}, headers: {}, expiresAt: Number.MAX_SAFE_INTEGER };
  source.throttle = async () => {};
  return source;
}

function searchResponse(count = 1) {
  return mockJsonResponse({ code: 0, search_tabs: [{ tab_type: 11, has_more: false,
    data: Array.from({ length: count }, (_, index) => ({ video_data: [{
      series_id: `760000000000000000${index + 1}`, title: '预算测试', episode_cnt: 1,
    }] })),
  }] });
}

function detailResponse() {
  return mockJsonResponse({ code: 0, data: { video_data: {
    video_list: [{ vid: '7700000000000000001', vid_index: 1, duration: 60 }],
  } } });
}

function mockBudgetClock(context) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  context.mock.method(console, 'warn', () => {});
  context.mock.method(console, 'error', () => {});
  context.mock.method(console, 'info', () => {});
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('hongguo 注册正文挂起也在总预算到期返回，不兜底、不缓存迟到身份', async (t) => {
  mockBudgetClock(t);
  const source = new HongguoSource();
  let registrationSignal;
  let finishBody;
  let requests = 0;
  let completed = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    assert.equal(new URL(url).pathname, '/service/2/device_register/');
    registrationSignal = options.signal;
    const response = guestResponse();
    response.text = () => new Promise((resolve) => { finishBody = resolve; });
    return response;
  });
  const pending = source.search('预算测试').then((result) => { completed = true; return result; });
  await flushTasks();
  t.mock.timers.tick(14999);
  await flushTasks();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, []);
  await flushTasks();
  assert.equal(registrationSignal.aborted, true);
  assert.equal(source.pendingGuestSession, null);
  finishBody(JSON.stringify({ device_id_str: '7600000000000000001', install_id_str: '7700000000000000001' }));
  await flushTasks();
  assert.equal(source.guestSession, null);
  assert.equal(requests, 1);
});

test('hongguo 搜索与详情共用预算，保留已完成候选且忽略迟到响应', async (t) => {
  mockBudgetClock(t);
  resetSearchState();
  const source = readySource();
  let finishSearch;
  let finishDetail;
  let detailSignal;
  let details = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/reading/bookapi/search/tab/v') {
      return new Promise((resolve) => { finishSearch = resolve; });
    }
    assert.equal(path, '/novel/player/multi_video_detail/v1/');
    details++;
    if (details === 1) return detailResponse();
    detailSignal = options.signal;
    return new Promise((resolve) => { finishDetail = resolve; });
  });
  const pendingSearch = source.search('预算测试');
  await flushTasks();
  t.mock.timers.tick(7000);
  finishSearch(searchResponse(3));
  const rawResults = await pendingSearch;
  const animes = [];
  const detailStore = new Map();
  let completed = false;
  const pendingDetails = source.handleAnimes(rawResults, '预算测试', animes, detailStore)
    .then((result) => { completed = true; return result; });
  await flushTasks();
  assert.equal(details, 2);
  t.mock.timers.tick(7999);
  await flushTasks();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  const result = await pendingDetails;
  assert.equal(result.length, 1);
  assert.equal(animes.length, 1);
  assert.equal(animes[0].bangumiId, '7600000000000000001');
  assert.equal(detailStore.size, 1);
  assert.equal(detailSignal.aborted, true);
  finishDetail(detailResponse());
  await flushTasks();
  assert.equal(details, 2);
  assert.equal(animes.length, 1);
  assert.equal(detailStore.size, 1);
  assert.deepEqual(await source.handleAnimes(rawResults, '预算测试', [], new Map()), []);
  assert.equal(details, 2);
});

test('hongguo 风控冷却受总预算限制，超时后不切线路、不后台重试', async (t) => {
  mockBudgetClock(t);
  const source = readySource();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return mockJsonResponse({ code: 100, message: JSON.stringify({ min_ban_time: 3600 }) });
  });
  const pending = source.search('预算测试');
  await flushTasks();
  t.mock.timers.tick(15000);
  assert.deepEqual(await pending, []);
  t.mock.timers.tick(3600000);
  await flushTasks();
  assert.equal(requests, 1);
});

test('hongguo 网页兜底仅使用剩余预算，超时后不请求 SSR', async (t) => {
  mockBudgetClock(t);
  const source = readySource();
  let failApp;
  let webSignal;
  let requests = 0;
  source.request = () => new Promise((resolve, reject) => { failApp = reject; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    assert.equal(new URL(url).pathname, '/api/search/result/');
    webSignal = options.signal;
    return new Promise(() => {});
  });
  const pending = source.search('预算测试');
  await flushTasks();
  t.mock.timers.tick(5000);
  failApp(new Error('fixture App unavailable'));
  await flushTasks();
  t.mock.timers.tick(10000);
  assert.deepEqual(await pending, []);
  assert.equal(webSignal.aborted, true);
  assert.equal(requests, 1);
});

test('hongguo 并发搜索的 15 秒预算及取消信号互不影响', async (t) => {
  mockBudgetClock(t);
  const source = readySource();
  const inFlight = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve) => {
    inFlight.push({ signal: options.signal, finish: resolve });
  }));
  const first = source.search('预算测试一');
  await flushTasks();
  t.mock.timers.tick(5000);
  const second = source.search('预算测试二');
  await flushTasks();
  t.mock.timers.tick(10000);
  const firstResult = await first;
  assert.deepEqual(firstResult, []);
  assert.equal(inFlight[0].signal.aborted, true);
  assert.equal(inFlight[1].signal.aborted, false);
  inFlight[1].finish(searchResponse());
  assert.equal((await second).length, 1);
  inFlight[0].finish(searchResponse());
  await flushTasks();
  assert.deepEqual(firstResult, []);
  assert.equal(inFlight.length, 2);
});

test('hongguo 一个等待者超时不会取消其他搜索共用的匿名注册', async (t) => {
  mockBudgetClock(t);
  const source = new HongguoSource();
  let finishRegistration;
  let registrationSignal;
  let registrations = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    registrations++;
    registrationSignal = options.signal;
    return new Promise((resolve) => { finishRegistration = resolve; });
  });
  const firstBudget = { deadline: Date.now() + 1000, controller: new AbortController() };
  const secondBudget = { deadline: Date.now() + 5000, controller: new AbortController() };
  const first = assert.rejects(source.ensureGuestSession(firstBudget), { name: 'HongguoSearchTimeout' });
  const second = source.ensureGuestSession(secondBudget);
  await flushTasks();
  t.mock.timers.tick(1000);
  await first;
  assert.equal(registrationSignal.aborted, false);
  finishRegistration(guestResponse());
  assert.equal((await second).query.device_id, '7600000000000000001');
  assert.equal(registrations, 1);
  assert.ok(source.guestSession);
});

test('hongguo 注册等待挂接前预算到期不会产生未处理拒绝', async (context) => {
  for (const expireAtRead of [5, 8]) {
    await context.test(`clock read ${expireAtRead}`, () => {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import HongguoSource from ${JSON.stringify(new URL('../../sources/hongguo.js', import.meta.url).href)};
        const source = new HongguoSource();
        const originalNow = Date.now;
        const startedAt = originalNow();
        let clockReads = 0;
        source.registerGuestSession = async () => ({
          query: {}, headers: {}, expiresAt: startedAt + 3600000,
        });
        const budget = { deadline: startedAt + 1, controller: new AbortController() };
        Date.now = () => startedAt + (++clockReads >= ${expireAtRead} ? 2 : 0);
        try {
          await assert.rejects(source.ensureGuestSession(budget), { name: 'HongguoSearchTimeout' });
        } finally {
          Date.now = originalNow;
        }
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(source.pendingGuestSession, null);
        assert.equal(source.guestSession, null);
      `], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
    });
  }
});

test('hongguo 节流队列无法在预算内开始时不再排队或发请求', async (t) => {
  mockBudgetClock(t);
  const source = readySource();
  source.throttle = HongguoSource.prototype.throttle;
  source.nextRequestAt = Date.now() + 20000;
  t.mock.method(globalThis, 'fetch', () => assert.fail('预算外不应发起 HTTP 请求'));
  assert.deepEqual(await source.search('预算测试'), []);
  assert.equal(source.nextRequestAt, Date.now() + 20000);
});

test('hongguo 超时不会阻止聚合搜索返回其他源的成功结果', async (t) => {
  mockBudgetClock(t);
  resetSearchState();
  Globals.init({ SOURCE_ORDER: 'hongguo,custom', LOG_LEVEL: 'error' });
  t.after(resetSearchState);
  const custom = getSourceByKey('custom');
  t.mock.method(hongguoSource, 'ensureGuestSession', async () => ({ query: {}, headers: {} }));
  t.mock.method(hongguoSource, 'throttle', async () => {});
  t.mock.method(custom, 'search', async () => []);
  t.mock.method(custom, 'handleAnimes', async (results, title, animes) => {
    animes.push({ animeId: 99101, bangumiId: '99101', animeTitle: '预算测试【短剧】from custom',
      source: 'custom', type: '短剧', episodeCount: 1 });
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => { requests++; return new Promise(() => {}); });
  const pending = searchAnime(new URL('http://localhost/api/v2/search/anime?keyword=预算测试'), null, null, new Map());
  await flushTasks();
  t.mock.timers.tick(15000);
  const body = await (await pending).json();
  assert.equal(body.success, true);
  assert.deepEqual(body.animes.map((anime) => anime.source), ['custom']);
  assert.equal(requests, 1);
});
