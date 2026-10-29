// Forward 插件产物：构建后验证搜索到弹幕的完整链路
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

function createHongguoContext(bundle) {
  const context = vm.createContext({
    fixtureNow: 1700000000000,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Widget: {
      storage: { get: () => null, set() {}, remove() {}, clear() {} },
      http: {
        get: async () => assert.fail('Unexpected GET'),
        post: async () => assert.fail('Unexpected POST'),
      },
    },
  });
  new vm.Script(bundle).runInContext(context, { timeout: 5000 });
  vm.runInContext('Date.now = () => fixtureNow', context);
  return context;
}

function flushForwardTasks() {
  return new Promise(resolve => setImmediate(resolve));
}

function forwardGuestResponse() {
  return { status: 200, data: {
    device_id_str: '7800000000000000001', install_id_str: '7900000000000000001',
  }, headers: { 'Set-Cookie': 'ttreq=fixture; Path=/' } };
}

test('Forward bundles preserve the search-to-comment flow without Node storage', async t => {
  for (const debug of [false, true]) {
    await t.test(debug ? 'debug bundle' : 'release bundle', async bundleTest => {
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

      context.fixtureNow = 1700000000000;
      vm.runInContext('Date.now = () => fixtureNow', context);
      assert.equal(vm.runInContext('typeof globalThis.setTimeout', context), 'undefined');
      const seriesId = '7600000000000000001';
      const hongguoRequests = [];
      let detailRequests = 0;
      context.Widget.http.get = async (url, options) => {
        const request = new URL(url);
        hongguoRequests.push({ path: request.pathname, timeout: options.timeout });
        assert.equal(request.pathname, '/reading/bookapi/search/tab/v');
        assert.equal(options.timeout, 14000);
        context.fixtureNow += 5000;
        return { status: 200, data: { code: 0, search_tabs: [{ tab_type: 11, has_more: false,
          data: [1, 2, 3].map(index => ({ video_data: [{
            series_id: `760000000000000000${index}`, title: '红果预算测试', episode_cnt: 1,
          }] })),
        }] } };
      };
      context.Widget.http.post = async (url, body, options) => {
        const request = new URL(url);
        hongguoRequests.push({ path: request.pathname, timeout: options.timeout });
        if (request.pathname === '/service/2/device_register/') {
          assert.equal(options.timeout, 15000);
          context.fixtureNow += 1000;
          return { status: 200, data: { device_id_str: '7800000000000000001', install_id_str: '7900000000000000001' },
            headers: { 'Set-Cookie': ['ttreq=fixture==; Path=/', 'store-region=cn-gd; Path=/'] } };
        }
        assert.equal(request.pathname, '/novel/player/multi_video_detail/v1/');
        assert.match(options.headers.cookie, /ttreq=fixture==/);
        detailRequests++;
        assert.equal(options.timeout, detailRequests === 1 ? 9000 : 8000);
        context.fixtureNow += detailRequests === 1 ? 1000 : 8000;
        return { status: 200, data: { code: 0, data: { video_data: {
          video_list: [{ vid: '7700000000000000001', vid_index: 1, duration: 30 }],
        } } } };
      };
      const hongguoParams = {
        ...params, title: '红果预算测试', tmdbId: seriesId, sourceOrder: 'hongguo',
        customSourceApiUrl: '', otherServer: '',
      };
      const hongguoResult = await context.searchDanmu(hongguoParams);
      assert.equal(hongguoResult.animes.length, 1);
      assert.equal(hongguoResult.animes[0].bangumiId, seriesId);
      assert.equal(detailRequests, 2);
      assert.equal(hongguoRequests.length, 4);

      await bundleTest.test('hongguo refresh uses only the remaining search budget', async () => {
        const refreshContext = createHongguoContext(bundle);
        const startedAt = refreshContext.fixtureNow;
        const registrationTimeouts = [];
        let searchRequests = 0;
        refreshContext.Widget.http.get = async (url, options) => {
          assert.equal(new URL(url).pathname, '/reading/bookapi/search/tab/v');
          assert.equal(options.timeout, 14000);
          searchRequests++;
          await flushForwardTasks();
          refreshContext.fixtureNow += 13000;
          return { status: 200, data: { BaseResp: { StatusCode: 263175 } } };
        };
        refreshContext.Widget.http.post = async (url, body, options) => {
          assert.equal(new URL(url).pathname, '/service/2/device_register/');
          registrationTimeouts.push(options.timeout);
          await flushForwardTasks();
          if (registrationTimeouts.length === 1) {
            refreshContext.fixtureNow += 1000;
            return forwardGuestResponse();
          }
          refreshContext.fixtureNow += options.timeout;
          throw new Error('fixture host HTTP timeout');
        };
        const refreshed = await refreshContext.searchDanmu(hongguoParams);
        assert.equal(refreshed.animes.length, 0);
        assert.deepEqual(registrationTimeouts, [15000, 1000]);
        assert.equal(refreshContext.fixtureNow - startedAt, 15000);
        assert.equal(searchRequests, 1);
      });

      await bundleTest.test('hongguo timerless searches keep registration deadlines independent', async () => {
        const concurrentContext = createHongguoContext(bundle);
        const startedAt = concurrentContext.fixtureNow;
        const registrations = [];
        const searchTimeouts = [];
        concurrentContext.Widget.http.post = (url, body, options) => {
          assert.equal(new URL(url).pathname, '/service/2/device_register/');
          return new Promise((resolve, reject) => {
            registrations.push({ resolve, reject, timeout: options.timeout });
          });
        };
        concurrentContext.Widget.http.get = async (url, options) => {
          assert.equal(new URL(url).pathname, '/reading/bookapi/search/tab/v');
          searchTimeouts.push(options.timeout);
          return { status: 200, data: { code: 0, search_tabs: [] } };
        };
        const first = concurrentContext.searchDanmu({ ...hongguoParams, title: '并发预算一' });
        await flushForwardTasks();
        concurrentContext.fixtureNow += 5000;
        let secondCompleted = false;
        const second = concurrentContext.searchDanmu({ ...hongguoParams, title: '并发预算二' })
          .then(result => { secondCompleted = true; return result; });
        await flushForwardTasks();
        assert.equal(registrations.length, 2);
        assert.deepEqual(registrations.map(registration => registration.timeout), [15000, 15000]);
        concurrentContext.fixtureNow = startedAt + 15000;
        registrations[0].reject(new Error('fixture host HTTP timeout'));
        assert.equal((await first).animes.length, 0);
        assert.equal(secondCompleted, false);
        concurrentContext.fixtureNow += 1000;
        registrations[1].resolve(forwardGuestResponse());
        assert.equal((await second).animes.length, 0);
        assert.deepEqual(searchTimeouts, [4000]);
        await concurrentContext.searchDanmu({ ...hongguoParams, title: '并发预算三' });
        assert.equal(registrations.length, 2);
        assert.deepEqual(searchTimeouts, [4000, 15000]);
      });
    });
  }
});
