import test from 'node:test';
import assert from 'node:assert/strict';
import HongguoSource from '../../sources/hongguo.js';
import { globals } from '../../configs/globals.js';
import { httpGet } from '../../utils/http-util.js';
import { withMockFetch } from '../helpers/context.js';

test.beforeEach((context) => {
  const previousLogs = globals.logBuffer;
  const previousLevel = globals.logLevel;
  globals.logBuffer = [];
  globals.logLevel = 'info';
  for (const level of ['info', 'warn', 'error']) context.mock.method(console, level, () => {});
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  context.after(() => {
    globals.logBuffer = previousLogs;
    globals.logLevel = previousLevel;
  });
});

function searchPage(cells = [], options = {}) {
  return { code: 0, search_tabs: [{ tab_type: 11, data: cells, has_more: false, ...options }] };
}

function seriesCell(seriesId = 'short-drama', contentType = 1) {
  return {
    book_id: seriesId,
    video_data: [{ video_detail: { series_title: '测试短剧', episode_cnt: 12, content_type: contentType } }],
  };
}

function albumCell(seriesId, episodeCount) {
  return {
    book_id: seriesId,
    search_high_light: { title: { text: '凡人修仙传' } },
    video_data: [{
      content_type: 1003,
      album_info: { title: '凡人修仙传', episode_cnt: episodeCount, ugc_user_info: { user_id: 'fixture' } },
    }],
  };
}

function webItem(seriesId = 'web-drama') {
  return { video_data: { series_id: seriesId, series_name: '测试短剧', episode_cnt: 12 } };
}

function webUgcItem(seriesId = 'web-ugc') {
  return {
    video_data: {
      series_id: seriesId,
      series_name: '用户合集',
      episode_cnt: 2,
      content_type: 1003,
      ugc_user_info: { user_id: 'fixture' },
    },
  };
}

async function emptyWebResponse(url) {
  const path = new URL(url).pathname;
  if (path === '/api/search/result/') return Response.json({ searchList: [] });
  if (path.startsWith('/search/')) return new Response('<html></html>');
  throw new Error(`Unexpected route: ${path}`);
}

function errorLogs() {
  return globals.logBuffer.filter(entry => entry.level === 'error');
}

function emptyResponseError() {
  const error = new Error('接口返回空响应 (HTTP 200)');
  error.code = 'EMPTY_RESPONSE';
  return error;
}

test('hongguo 搜索过滤实际 UGC 合集，保留普通短剧、漫剧和旧格式短剧', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => searchPage([
    albumCell('7690259991374072894', 2),
    albumCell('7695133626106661913', 8),
    seriesCell(),
    seriesCell('comic-drama', 1004),
    { book_id: 'legacy-drama', video_detail: { series_title: '旧格式短剧', episode_cnt: 20 } },
  ]);
  const results = await source.search('凡人修仙传');
  assert.deepEqual(results.map(item => item.seriesId), ['short-drama', 'comic-drama', 'legacy-drama']);
});

test('hongguo 搜索在内容类型缺失时仍过滤 UGC 合集和无效集数', async () => {
  const source = new HongguoSource();
  const album = albumCell('ugc-without-type', 3);
  delete album.video_data[0].content_type;
  const invalidCells = ['0', -1, 'invalid'].map((episodeCount, index) => ({
    book_id: `invalid-${index}`,
    video_detail: { series_title: '无效集数', episode_cnt: episodeCount },
  }));
  source.fetchSearchPage = async () => searchPage([album, ...invalidCells, seriesCell()]);
  assert.deepEqual((await source.search('测试')).map(item => item.seriesId), ['short-drama']);
});

test('hongguo 第一页只有合集时仍继续翻页查找可用短剧', async () => {
  const source = new HongguoSource();
  const offsets = [];
  const cursors = [];
  source.fetchSearchPage = async (_keyword, offset, _count, options = {}) => {
    offsets.push(offset);
    cursors.push(options.cursor);
    return offset === 0
      ? searchPage([albumCell('ugc', 2)], { has_more: true, next_offset: 6, passback: 'page-1-pass', search_id: 'page-1-search' })
      : searchPage([seriesCell()]);
  };
  assert.deepEqual((await source.search('测试')).map(item => item.seriesId), ['short-drama']);
  assert.deepEqual(offsets, [0, 6]);
  assert.deepEqual(cursors[1], { passback: 'page-1-pass', searchId: 'page-1-search' });
});

test('hongguo 分页游标会进入下一页的签名 URL', async () => {
  const source = new HongguoSource();
  const identity = { installId: 'install', deviceId: 'device', cdid: 'cdid', openudid: 'openudid' };
  let captured;
  await withMockFetch(async (url) => {
    captured = new URL(url);
    return Response.json(searchPage());
  }, () => source.requestSearchPage('api.example', identity, '测试', 6, 20, {
    cursor: { passback: 'pass/?#1', searchId: 'search id 2' },
  }));
  assert.equal(captured.searchParams.get('offset'), '6');
  assert.equal(captured.searchParams.get('passback'), 'pass/?#1');
  assert.equal(captured.searchParams.get('search_id'), 'search id 2');
});

test('hongguo 不把其他搜索标签的数据当作短剧结果', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => ({ search_tabs: [
    { tab_type: 11, data: [] },
    { tab_type: 99, data: [seriesCell('other-tab')] },
  ] });
  assert.deepEqual(await withMockFetch(emptyWebResponse, () => source.search('测试')), []);
});

test('hongguo 正常空结果只输出信息日志，不报搜索失败', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => searchPage();
  assert.deepEqual(await withMockFetch(emptyWebResponse, () => source.search('不存在')), []);
  assert.deepEqual(errorLogs(), []);
  assert.ok(globals.logBuffer.some(entry => entry.level === 'info' && entry.message.includes('未找到')));
  assert.ok(!globals.logBuffer.some(entry => entry.level === 'warn'));
});

test('hongguo 全部搜索请求失败时保留错误日志', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => { throw new Error('App unavailable'); };
  const results = await withMockFetch(async () => new Response('unavailable', { status: 503 }), () => source.search('测试'));
  assert.deepEqual(results, []);
  assert.ok(errorLogs().some(entry => entry.message.includes('搜索失败')));
  assert.ok(errorLogs().some(entry => entry.message.includes('503')));
});

test('hongguo 无效搜索响应不伪装成正常空结果', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => ({ code: 0 });
  const results = await withMockFetch(async () => new Response('<html>invalid</html>'), () => source.search('测试'));
  assert.deepEqual(results, []);
  assert.ok(errorLogs().some(entry => entry.message.includes('搜索失败')));
});

test('hongguo App 后续分页失败时保留已有结果，不丢弃后转网页', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async (_keyword, offset) => {
    if (offset > 0) throw new Error('second page unavailable');
    return searchPage([seriesCell()], { has_more: true, next_offset: 20 });
  };
  let webRequests = 0;
  const results = await withMockFetch(async (url) => {
    webRequests++;
    return emptyWebResponse(url);
  }, () => source.search('测试'));
  assert.deepEqual(results.map(item => item.seriesId), ['short-drama']);
  assert.equal(webRequests, 0);
});

test('hongguo 网页后续分页失败时也保留已有结果', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => searchPage();
  const results = await withMockFetch(async (url) => {
    if (new URL(url).searchParams.get('page') === '1') return Response.json({ searchList: [webItem()] });
    return new Response('unavailable', { status: 503 });
  }, () => source.search('测试'));
  assert.deepEqual(results.map(item => item.seriesId), ['web-drama']);
});

test('hongguo App 搜索失败后网页 API 仍可兜底', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => { throw new Error('App unavailable'); };
  const results = await withMockFetch(async (url) => Response.json({
    searchList: new URL(url).searchParams.get('page') === '1' ? [webItem()] : [],
  }), () => source.search('测试'));
  assert.deepEqual(results.map(item => item.seriesId), ['web-drama']);
});

test('hongguo 网页搜索兜底同样过滤 UGC 合集', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => searchPage();
  const results = await withMockFetch(async (url) => {
    if (new URL(url).pathname === '/api/search/result/') {
      return Response.json({ searchList: [webUgcItem('web-ugc'), webItem('web-normal')] });
    }
    return new Response('<html></html>');
  }, () => source.search('测试'));
  assert.deepEqual(results.map(item => item.seriesId), ['web-normal']);
});

test('hongguo 网页 API 不可用时仍可解析 SSR 搜索数据', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => { throw new Error('App unavailable'); };
  const results = await withMockFetch(async (url) => {
    if (new URL(url).pathname === '/api/search/result/') return new Response('unavailable', { status: 503 });
    return new Response(`<script>${JSON.stringify({ searchList: [webItem('ssr-drama')] })}</script>`);
  }, () => source.search('测试'));
  assert.deepEqual(results.map(item => item.seriesId), ['ssr-drama']);
});

test('hongguo 已知 UGC 详情不再请求不存在的网页详情', async () => {
  const source = new HongguoSource();
  source.request = async () => ({ data: { ugc: { video_data: { content_type: 1003, video_list: [] } } } });
  let webRequests = 0;
  const details = await withMockFetch(async () => {
    webRequests++;
    return new Response('not found', { status: 404 });
  }, () => source.getEpisodes('ugc'));
  assert.deepEqual(details.episodes, []);
  assert.equal(webRequests, 0);
  assert.deepEqual(errorLogs(), []);
});

test('hongguo 详情响应外层标记 UGC 时同样跳过网页兜底', async () => {
  const source = new HongguoSource();
  source.request = async () => ({
    data: {
      series: {
        content_type: 1003,
        video_data: { video_list: [{ vid: 'should-not-be-used', vid_index: 1 }] },
      },
    },
  });
  let webRequests = 0;
  const details = await withMockFetch(async () => {
    webRequests++;
    return new Response('not found', { status: 404 });
  }, () => source.getEpisodes('series'));
  assert.deepEqual(details.episodes, []);
  assert.equal(webRequests, 0);
  assert.deepEqual(errorLogs(), []);
});

test('hongguo 网页详情 404 作为无资源处理而不刷错误日志', async () => {
  const source = new HongguoSource();
  source.request = async () => ({ code: 0, data: {} });
  const details = await withMockFetch(async () => new Response('not found', { status: 404 }), () => source.getEpisodes('missing'));
  assert.deepEqual(details.episodes, []);
  assert.deepEqual(errorLogs(), []);
});

test('hongguo 仅详情兜底允许 404，通用 HTTP 请求仍报告 404', async () => {
  await withMockFetch(async () => new Response('not found', { status: 404 }), async () => {
    await assert.rejects(httpGet('https://example.com/not-found'), /404/);
  });
  assert.ok(errorLogs().some(entry => entry.message.includes('404')));
});

test('hongguo 网页详情 503 等真正故障仍保留错误日志', async () => {
  const source = new HongguoSource();
  source.request = async () => ({ code: 0, data: {} });
  await withMockFetch(async () => new Response('unavailable', { status: 503 }), () => source.getEpisodes('missing'));
  assert.ok(errorLogs().some(entry => entry.message.includes('503')));
});

test('hongguo 正常短剧和漫剧的 API 分集仍可解析', async () => {
  for (const contentType of [1, 1004]) {
    const source = new HongguoSource();
    source.request = async () => ({ data: { series: { video_data: {
      content_type: contentType,
      video_list: [{ vid: 'second', vid_index: 2 }, { vid: 'first', vid_index: 1, duration: 90 }],
    } } } });
    const details = await source.getEpisodes('series');
    assert.deepEqual(details.episodes.map(item => item.vid), ['first', 'second']);
    assert.equal(details.episodes[0].duration, 90);
    assert.deepEqual(errorLogs(), []);
  }
});

test('hongguo 普通短剧 API 无分集时仍保留网页详情兜底', async () => {
  const source = new HongguoSource();
  source.request = async () => ({ data: { series: { video_data: { content_type: 1, video_list: [] } } } });
  const html = '<script>{"seriesDetail":{"vid_list":[{"vid":"web-episode","duration":60}]}}</script>';
  const details = await withMockFetch(async () => new Response(html), () => source.getEpisodes('series'));
  assert.equal(details.episodes[0].vid, 'web-episode');
});

test('hongguo 普通与强制设备刷新共享同一注册，刷新期间不返回旧身份', async () => {
  const source = new HongguoSource();
  source.searchIdentity = { deviceId: 'old', createdAt: Date.now() };
  source.searchIdentityCreatedAt = Date.now();
  let releaseRegistration;
  let notifyStarted;
  const pendingResponse = new Promise(resolve => { releaseRegistration = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let registrations = 0;
  await withMockFetch(async () => {
    registrations++;
    notifyStarted();
    return pendingResponse;
  }, async () => {
    const pending = [source.getSearchIdentity(true), source.getSearchIdentity(true), source.getSearchIdentity()];
    await started;
    await new Promise(resolve => setImmediate(resolve));
    releaseRegistration(Response.json({ device_id_str: 'new-device', install_id_str: 'new-install' }));
    const identities = await Promise.all(pending);
    assert.equal(registrations, 1);
    assert.ok(identities.every(identity => identity === identities[0]));
    assert.equal(identities[0].deviceId, 'new-device');
    assert.equal(source.searchIdentityPromise, null);
  });
});

test('hongguo 设备注册失败后释放共享任务，后续可重新注册', async () => {
  const source = new HongguoSource();
  let registrations = 0;
  await withMockFetch(async () => {
    registrations++;
    return Response.json(registrations === 1
      ? { device_id_str: '0', install_id_str: '0' }
      : { device_id_str: 'recovered', install_id_str: 'install' });
  }, async () => {
    const results = await Promise.allSettled([source.getSearchIdentity(true), source.getSearchIdentity(true)]);
    assert.equal(registrations, 1);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(source.searchIdentity, null);
    assert.equal(source.searchIdentityPromise, null);
    await assert.rejects(source.getSearchIdentity(), /冷却中/);
    assert.equal(registrations, 1);
    assert.equal((await source.getSearchIdentity(true)).deviceId, 'recovered');
    assert.equal(registrations, 2);
  });
});

test('hongguo 注册网络失败会自动重试一次', async () => {
  const source = new HongguoSource();
  let registrations = 0;
  await withMockFetch(async () => {
    registrations++;
    if (registrations === 1) throw new Error('fetch failed');
    return Response.json({ device_id_str: 'retry-device', install_id_str: 'retry-install' });
  }, async () => {
    const identity = await source.getSearchIdentity();
    assert.equal(identity.deviceId, 'retry-device');
    assert.equal(registrations, 2);
  });
});

test('hongguo 迟到的旧设备失败复用已刷新的身份，不重复注册', async () => {
  const source = new HongguoSource();
  let registrations = 0;
  await withMockFetch(async () => {
    registrations++;
    return Response.json({ device_id_str: `device-${registrations}`, install_id_str: `install-${registrations}` });
  }, async () => {
    const original = await source.getSearchIdentity();
    const refreshed = await source.getSearchIdentity(true, original);
    assert.equal(await source.getSearchIdentity(true, original), refreshed);
    assert.equal(registrations, 2);
  });
});

test('hongguo 搜索身份保持 12 小时有效期，到期后并发只注册一次', async (context) => {
  let now = 1700000000000;
  context.mock.method(Date, 'now', () => now);
  const source = new HongguoSource();
  let registrations = 0;
  await withMockFetch(async () => {
    registrations++;
    return Response.json({ device_id_str: `device-${registrations}`, install_id_str: 'install' });
  }, async () => {
    const original = await source.getSearchIdentity();
    now += 12 * 60 * 60 * 1000 - 1;
    assert.equal(await source.getSearchIdentity(), original);
    now++;
    const refreshed = await Promise.all([source.getSearchIdentity(), source.getSearchIdentity()]);
    assert.equal(registrations, 2);
    assert.notEqual(refreshed[0], original);
    assert.equal(refreshed[0], refreshed[1]);
  });
});

test('hongguo 空响应混合网络超时仍可触发一次设备刷新', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  const original = { deviceId: 'old' };
  const replacement = { deviceId: 'new' };
  let refreshes = 0;
  source.getSearchIdentity = async (force, failedIdentity) => {
    if (!force) return original;
    refreshes++;
    assert.equal(failedIdentity, original);
    return replacement;
  };
  let requests = 0;
  source.requestSearchPage = async (_host, identity) => {
    requests++;
    if (identity === replacement) return searchPage();
    if (requests === 2) throw new Error('network timeout');
    throw emptyResponseError();
  };
  assert.deepEqual(await source.fetchSearchPage('测试', 0, 20), searchPage());
  assert.equal(refreshes, 1);
  assert.equal(requests, source.getApiHosts().length + 1);
});

test('hongguo 纯网络失败不无谓注册新设备，正常空结果也不刷新', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  let refreshes = 0;
  source.getSearchIdentity = async (force) => { if (force) refreshes++; return { deviceId: 'same' }; };
  source.requestSearchPage = async () => { throw new Error('network timeout'); };
  await assert.rejects(source.fetchSearchPage('测试', 0, 20), /network timeout/);
  source.requestSearchPage = async () => searchPage();
  assert.deepEqual(await source.fetchSearchPage('测试', 0, 20), searchPage());
  assert.equal(refreshes, 0);
});

test('hongguo 连续空响应仅刷新一次设备，避免无限注册重试', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  let refreshes = 0;
  let requests = 0;
  source.getSearchIdentity = async (force) => { if (force) refreshes++; return { deviceId: 'mock' }; };
  source.requestSearchPage = async () => { requests++; throw emptyResponseError(); };
  await assert.rejects(source.fetchSearchPage('测试', 0, 20), /空响应/);
  assert.equal(refreshes, 1);
  assert.equal(requests, source.getApiHosts().length * 2);
});

test('hongguo 等待节流期间出现冷却时，等待结束后重新排队', async () => {
  const source = new HongguoSource();
  let reservations = 0;
  let retryAfter = 0;
  source.throttle = async () => {
    reservations++;
    if (reservations === 1) {
      retryAfter = Date.now() + 25;
      source.searchCooldownUntil = retryAfter;
    }
  };
  await source.throttleSearch();
  assert.ok(Date.now() >= retryAfter);
  assert.equal(reservations, 2);
});

test('hongguo 搜索在节流结束后生成时间戳和签名', async (context) => {
  let now = 1700000000000;
  context.mock.method(Date, 'now', () => now);
  const source = new HongguoSource();
  source.getSearchIdentity = async () => ({ deviceId: '123', installId: '456', cdid: 'mock', openudid: 'mock' });
  source.throttle = async () => { now += 5000; };
  let captured;
  await withMockFetch(async (url, options) => {
    captured = { url: new URL(url), headers: options.headers };
    return Response.json(searchPage());
  }, () => source.fetchSearchPage('测试', 0, 20));
  assert.equal(captured.url.searchParams.get('_rticket'), String(now));
  assert.equal(captured.url.searchParams.get('ts'), String(now / 1000));
  assert.equal(captured.headers['x-khronos'], String(now / 1000));
  assert.ok(captured.headers['x-argus'].length > 20);
  assert.ok(captured.headers['x-ladon'].length > 20);
});

test('hongguo 搜索风控等待冷却后重试原线路，不立即轮询全部域名', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  source.getSearchIdentity = async () => ({ deviceId: 'same' });
  const calls = [];
  let retryAfter = 0;
  source.requestSearchPage = async (host) => {
    calls.push(host);
    if (calls.length === 1) {
      retryAfter = Date.now() + 25;
      const error = new Error('风控冷却');
      error.coolDownMs = 25;
      throw error;
    }
    assert.ok(Date.now() >= retryAfter);
    return searchPage();
  };
  assert.deepEqual(await source.fetchSearchPage('测试', 0, 20), searchPage());
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
});

test('hongguo 持续风控最多尝试三次，并保留冷却期限而不换设备或线路', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  let refreshes = 0;
  source.getSearchIdentity = async (force) => { if (force) refreshes++; return { deviceId: 'same' }; };
  const hosts = [];
  source.requestSearchPage = async (host) => {
    hosts.push(host);
    const error = new Error('风控冷却');
    error.coolDownMs = 5;
    throw error;
  };
  await assert.rejects(source.fetchSearchPage('测试', 0, 20), /风控冷却/);
  assert.equal(hosts.length, 3);
  assert.equal(new Set(hosts).size, 1);
  assert.equal(refreshes, 0);
  assert.ok(source.searchCooldownUntil > 0);
});

test('hongguo 长冷却不在请求内等待，立即失败并保留冷却期限', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  source.getSearchIdentity = async () => ({ deviceId: 'same' });
  let calls = 0;
  source.requestSearchPage = async () => {
    calls++;
    const error = new Error('风控冷却');
    error.coolDownMs = 60_000;
    throw error;
  };
  const started = Date.now();
  await assert.rejects(source.fetchSearchPage('测试', 0, 20, { deadline: Date.now() + 5_000 }), /风控冷却/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 500);
  assert.ok(source.searchCooldownUntil > Date.now());
});

test('hongguo 冷却期间的新搜索直接跳过 App 请求', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  source.getSearchIdentity = async () => ({ deviceId: 'same' });
  source.searchCooldownUntil = Date.now() + 60_000;
  let calls = 0;
  source.requestSearchPage = async () => { calls++; return searchPage(); };
  await assert.rejects(source.fetchSearchPage('测试', 0, 20, { deadline: Date.now() + 5_000 }), /风控冷却/);
  assert.equal(calls, 0);
});

test('hongguo 搜索请求超过总预算会快速失败', async () => {
  const source = new HongguoSource();
  source.throttle = async () => {};
  source.getSearchIdentity = async () => ({ deviceId: 'same' });
  source.requestSearchPage = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(
    source.fetchSearchPage('测试', 0, 20, { deadline: Date.now() + 50 }),
    /超时/,
  );
  assert.ok(Date.now() - started < 400);
});

test('hongguo 详情结果会缓存并合并并发请求', async () => {
  const source = new HongguoSource();
  let requests = 0;
  source.request = async () => {
    requests++;
    await new Promise(resolve => setImmediate(resolve));
    return { data: { 'series-cache': { video_data: {
      content_type: 1,
      video_list: [{ vid: 'episode-1', vid_index: 1, duration: 60 }],
    } } } };
  };
  const [first, second] = await Promise.all([
    source.getEpisodes('series-cache'),
    source.getEpisodes('series-cache'),
  ]);
  assert.deepEqual(first.episodes.map(item => item.vid), ['episode-1']);
  assert.deepEqual(second.episodes.map(item => item.vid), ['episode-1']);
  assert.equal(requests, 1);
  await source.getEpisodes('series-cache');
  assert.equal(requests, 1);
});

test('hongguo 网页第一页只有合集时继续读取后续短剧', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => searchPage();
  const pages = [];
  const results = await withMockFetch(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    return Response.json({ searchList: page === 1 ? [webUgcItem()] : page === 2 ? [webItem()] : [] });
  }, () => source.search('测试'));
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(results.map(item => item.seriesId), ['web-drama']);
});

test('hongguo App 单次超时不跳过仍有预算的网页兜底', async () => {
  const source = new HongguoSource();
  source.fetchSearchPage = async () => { throw new DOMException('request timeout', 'AbortError'); };
  const results = await withMockFetch(async (url) => Response.json({
    searchList: new URL(url).searchParams.get('page') === '1' ? [webItem()] : [],
  }), () => source.search('测试'));
  assert.deepEqual(results.map(item => item.seriesId), ['web-drama']);
});

test('hongguo 慢 App 请求用尽阶段预算后仍能请求网页', { timeout: 12000 }, async () => {
  const source = new HongguoSource();
  source.searchIdentity = { deviceId: 'fixture', installId: 'fixture' };
  source.searchIdentityCreatedAt = Date.now();
  let appAborted = false;
  let appTimeout;
  const results = await withMockFetch(async (url, options) => {
    if (String(url).includes('/reading/')) {
      appTimeout = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        appAborted = true;
        reject(new DOMException('request timeout', 'AbortError'));
      }, { once: true }));
    }
    return Response.json({ searchList: new URL(url).searchParams.get('page') === '1' ? [webItem()] : [] });
  }, () => source.search('测试'));
  assert.ok(appTimeout);
  assert.equal(appAborted, true);
  assert.deepEqual(results.map(item => item.seriesId), ['web-drama']);
});

test('hongguo 注册正文卡住时有限重试后释放任务并进入负缓存', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new HongguoSource();
  let registrations = 0;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  await withMockFetch(async (_url, options) => {
    registrations++;
    notifyStarted();
    return new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new DOMException('timeout', 'AbortError')), { once: true });
      },
    }));
  }, async () => {
    const failed = assert.rejects(source.getSearchIdentity(), /timeout|超时/);
    await started;
    context.mock.timers.tick(2000);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(150);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(2000);
    await failed;
    assert.equal(registrations, 2);
    assert.equal(source.searchIdentityPromise, null);
    assert.equal(source.searchIdentityTask, null);
    assert.ok(source.searchIdentityFailureUntil > Date.now());
    await assert.rejects(source.getSearchIdentity(), /冷却中/);
  });
});

test('hongguo 一个注册等待者取消不影响另一个等待者', async () => {
  const source = new HongguoSource();
  const cancelled = new AbortController();
  let release;
  let requestSignal;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  await withMockFetch(async (_url, options) => {
    requestSignal = options.signal;
    notifyStarted();
    return new Promise(resolve => { release = resolve; });
  }, async () => {
    const first = assert.rejects(source.getSearchIdentity(false, null, { signal: cancelled.signal }), { name: 'AbortError' });
    const second = source.getSearchIdentity();
    await started;
    cancelled.abort();
    await first;
    assert.equal(requestSignal.aborted, false);
    release(Response.json({ device_id_str: 'shared-device', install_id_str: 'shared-install' }));
    assert.equal((await second).deviceId, 'shared-device');
    assert.equal(source.searchIdentityPromise, null);
  });
});

test('hongguo 所有注册等待者取消后终止请求且可立即重试', async () => {
  const source = new HongguoSource();
  const controller = new AbortController();
  let signal;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  await withMockFetch(async (_url, options) => {
    signal = options.signal;
    notifyStarted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
  }, async () => {
    const rejected = assert.rejects(source.getSearchIdentity(false, null, { signal: controller.signal }), { name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(source.searchIdentityPromise, null);
    assert.equal(source.searchIdentityFailureUntil, 0);
  });
  await withMockFetch(async () => Response.json({ device_id_str: 'retry', install_id_str: 'retry' }), async () => {
    assert.equal((await source.getSearchIdentity()).deviceId, 'retry');
  });
});

test('hongguo 详情等待者独立计时，不取消仍被其他调用者使用的任务', async () => {
  const source = new HongguoSource();
  let signal;
  let release;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  source.fetchEpisodeDetails = async (_key, options) => {
    signal = options.signal;
    notifyStarted();
    return new Promise(resolve => { release = resolve; });
  };
  const first = assert.rejects(source.getEpisodes('shared', { deadline: Date.now() + 40 }), /超时/);
  const second = source.getEpisodes('shared');
  await started;
  await first;
  assert.equal(signal.aborted, false);
  release({ episodes: [{ vid: 'episode', duration: 60 }], year: null, imageUrl: '' });
  const details = await second;
  details.episodes[0].duration = 999;
  assert.equal((await source.getEpisodes('shared')).episodes[0].duration, 60);
  assert.equal(source.pendingEpisodeDetails.size, 0);
});

test('hongguo 详情阶段预算结束后取消最后一个等待者，不再换线或缓存空结果', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  const source = new HongguoSource();
  let requests = 0;
  let signal;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  await withMockFetch(async (_url, options) => {
    requests++;
    signal = options.signal;
    notifyStarted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
  }, async () => {
    const handled = source.handleAnimes([{ seriesId: 'slow', name: '测试' }], '测试', [], new Map());
    await started;
    context.mock.timers.tick(4000);
    assert.deepEqual(await handled, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(requests, 1);
    assert.equal(source.pendingEpisodeDetails.size, 0);
    assert.equal(source.episodeDetailsCache.size, 0);
  });
});

test('hongguo 批量取消节流等待不留下远期占位', async () => {
  const source = new HongguoSource();
  const controller = new AbortController();
  const results = Promise.allSettled(Array.from({ length: 30 }, () => source.throttle(20, 0, controller.signal)));
  controller.abort();
  await results;
  assert.equal(source.throttleQueue.length, 0);
  assert.ok(source.nextRequestAt - Date.now() <= 20);
  await source.throttle(1, 0, null, Date.now() + 200);
  assert.equal(source.throttleQueue.length, 0);
});

test('hongguo 排队预算不足不推进 nextRequestAt，预先取消不占队列', async () => {
  const source = new HongguoSource();
  source.nextRequestAt = Date.now() + 1000;
  const previous = source.nextRequestAt;
  await assert.rejects(source.throttle(600, 0, null, Date.now() + 20), /超时/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.throttle(600, 0, controller.signal));
  assert.equal(source.nextRequestAt, previous);
  assert.equal(source.throttleQueue.length, 0);
});

test('hongguo 弹幕节流失败也释放已获取的并发槽位', async () => {
  const source = new HongguoSource();
  source.throttle = async () => { const error = new Error('cancelled'); error.searchTimeout = true; throw error; };
  await assert.rejects(source.request('POST', '/comments', { comment: true }), /cancelled/);
  assert.equal(source.activeCommentRequests, 0);
});
