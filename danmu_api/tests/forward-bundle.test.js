// Forward 插件产物：构建后验证搜索到弹幕的完整链路
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

test('Forward bundles preserve the search-to-comment flow without Node storage', async t => {
  for (const debug of [false, true]) {
    await t.test(debug ? 'debug bundle' : 'release bundle', async () => {
      execFileSync(process.execPath, ['build-forward-widget.js', ...(debug ? ['--debug'] : [])], {
        cwd: new URL('../../', import.meta.url),
        timeout: 30000,
        stdio: 'pipe',
      });
      const filename = debug ? 'logvar-danmu.debug.js' : 'logvar-danmu.js';
      const bundle = await fs.readFile(new URL(`../../dist/${filename}`, import.meta.url), 'utf8');
      const storage = new Map();
      const requests = [];
      const comments = [{ p: '1,1,16777215', m: '插件构建回归测试' }];
      const context = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        Widget: {
          storage: {
            get: key => storage.get(key) ?? null,
            set: (key, value) => storage.set(key, value),
            remove: key => storage.delete(key),
            clear: () => storage.clear(),
          },
          http: {
            get: async url => {
              const request = new URL(url);
              assert.strictEqual(request.origin, 'https://forward.test');
              requests.push(request.pathname);
              if (request.pathname === '/api/v2/search/anime') {
                return { status: 200, data: { animes: [{
                  animeId: 9001,
                  bangumiId: '9001',
                  animeTitle: '插件构建测试',
                  startDate: '2026-01-01',
                  type: 'tvseries',
                  typeDescription: 'TV',
                }] } };
              }
              if (request.pathname === '/api/v2/bangumi/9001') {
                return { status: 200, data: { bangumi: { episodes: [{
                  episodeId: 900101,
                  episodeTitle: '第1集',
                  episodeNumber: '1',
                }] } } };
              }
              assert.strictEqual(request.pathname, '/api/v2/comment/900101');
              return { status: 200, data: { comments } };
            },
            post: async () => assert.fail('The fixture does not require POST requests'),
          },
        },
      });

      // A script-only runtime has no module loader, process, Buffer, or filesystem.
      new vm.Script(bundle, { filename }).runInContext(context, { timeout: 5000 });
      const params = {
        title: '插件构建测试',
        type: 'tv',
        tmdbId: '9001',
        season: 1,
        episode: 1,
        sourceOrder: 'local,custom',
        customSourceApiUrl: 'https://forward.test',
        tmdbApiKey: '',
      };
      const search = await context.searchDanmu(params);
      assert.deepStrictEqual(Array.from(search.animes, anime => anime.animeId), [9001]);
      const episodes = await context.getDetailById({ ...params, animeId: 9001 });
      assert.strictEqual(episodes.length, 1);
      const segments = await context.getCommentsById({ ...params, commentId: episodes[0].episodeId });
      assert.strictEqual(segments.length, 1);
      const result = await context.getDanmuWithSegmentTime({ ...params, segmentTime: 0 });
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.comments[0].m, comments[0].m);
      assert.deepStrictEqual(requests, [
        '/api/v2/search/anime',
        '/api/v2/bangumi/9001',
        '/api/v2/comment/900101',
      ]);
      for (const nativeTimers of [true, false]) {
        await verifyHongguoBundle(bundle, filename, nativeTimers);
      }
    });
  }
});

async function verifyHongguoBundle(bundle, filename, nativeTimers) {
  const storage = new Map();
  const requests = [];
  const seriesId = '7000000000000000001';
  const episode = { vid: 'fixture-episode', vid_index: 1, duration: 60, episode_title: '第1集' };
  const context = vm.createContext({
    ...(nativeTimers ? { setTimeout, clearTimeout } : {}),
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Widget: {
      storage: {
        get: key => storage.get(key) ?? null,
        set: (key, value) => storage.set(key, value),
        remove: key => storage.delete(key),
        clear: () => storage.clear(),
      },
      http: {
        get: async (url, options) => {
          const request = new URL(url);
          requests.push(request.pathname);
          assert.ok(options.timeout > 0);
          if (request.pathname === '/reading/bookapi/search/tab/v') {
            assert.ok(nativeTimers);
            assert.ok(options.headers['x-medusa']);
            return { status: 200, data: { code: 0, search_tabs: [{ tab_type: 11, data: [{
              book_id: seriesId,
              video_detail: { series_title: '构建测试短剧', episode_cnt: 1 },
            }] }] } };
          }
          if (request.pathname === '/api/search/result/') {
            assert.ok(!nativeTimers);
            return { status: 200, data: { searchList: request.searchParams.get('page') === '1' ? [{
              video_data: { series_id: seriesId, series_name: '构建测试短剧', episode_cnt: 1 },
            }] : [] } };
          }
          assert.strictEqual(request.pathname, '/detail');
          return { status: 200, data: `<script>{"seriesDetail":${JSON.stringify({ vid_list: [episode] })}}</script>` };
        },
        post: async (url, body, options) => {
          const request = new URL(url);
          requests.push(request.pathname);
          assert.ok(options.timeout > 0);
          if (request.pathname === '/service/2/device_register/') {
            assert.ok(nativeTimers);
            assert.strictEqual(Object.prototype.toString.call(body), '[object Uint8Array]');
            return { status: 200, data: { device_id_str: 'fixture-device', install_id_str: 'fixture-install' } };
          }
          if (request.pathname === '/novel/player/multi_video_detail/v1/') {
            return { status: 200, data: { code: 0, data: { [seriesId]: { video_data: { video_list: [episode] } } } } };
          }
          assert.ok(request.pathname.startsWith('/novel/commentapi/'));
          return { status: 200, data: { code: 0, data: {
            data_list: [{ comment: { comment_id: 'fixture', common: { content: { text: '红果构建回归' } }, expand: { offset_time: 1000 } } }],
            common_list_info: { has_more: false },
            extra: { next_query_danmaku_list_time: 60000 },
          } } };
        },
      },
    },
  });
  new vm.Script(bundle, { filename }).runInContext(context, { timeout: 5000 });
  assert.strictEqual(context.__FORWARD_HAS_NATIVE_TIMERS__, nativeTimers);
  const params = { title: '构建测试短剧', sourceOrder: 'hongguo', tmdbApiKey: '', hongguoMergeAllEpisodes: false };
  const search = await context.searchDanmu(params);
  assert.strictEqual(search.animes.length, 1, `${filename}, nativeTimers=${nativeTimers}`);
  const details = await context.getDetailById({ ...params, animeId: search.animes[0].animeId });
  assert.strictEqual(details.length, 1);
  const segments = await context.getCommentsById({ ...params, commentId: details[0].episodeId });
  assert.ok(segments.length > 0);
  const comments = await context.getDanmuWithSegmentTime({ ...params, segmentTime: 0 });
  assert.strictEqual(comments.comments[0].m, '红果构建回归');
  assert.strictEqual(requests.includes('/service/2/device_register/'), nativeTimers);
  const redacted = vm.runInContext(`redactSensitiveLogText('failed https://fixture.test/?device_id=PRIVATE_DEVICE&req_id=PRIVATE_REQUEST&query=ok')`, context);
  assert.ok(!redacted.includes('PRIVATE_'));
  assert.ok(redacted.includes('query=ok'));
  if (filename.includes('debug')) {
    const trace = vm.runInContext(`JSON.stringify(redactForwardTraceValue({
      message: 'failed https://fixture.test/?openudid=PRIVATE_OPEN',
      device_id: 'PRIVATE_DEVICE', oaid: { id: 'PRIVATE_OAID' }
    }))`, context);
    assert.ok(!trace.includes('PRIVATE_'), trace);
  }
}

test('Forward 定时器保留宿主延迟及取消语义', async () => {
  const context = vm.createContext({ setTimeout, clearTimeout, console });
  new vm.Script(await fs.readFile(new URL('../../forward/custom-polyfill.js', import.meta.url), 'utf8')).runInContext(context);
  context.fired = false;
  vm.runInContext('setTimeout(() => { globalThis.fired = true; }, 30)', context);
  await Promise.resolve();
  assert.strictEqual(context.fired, false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.strictEqual(context.fired, true);
  vm.runInContext('globalThis.fired = false; const timer = setTimeout(() => { globalThis.fired = true; }, 20); clearTimeout(timer)', context);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.strictEqual(context.fired, false);
});
