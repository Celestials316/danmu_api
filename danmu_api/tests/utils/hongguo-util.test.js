import test from 'node:test';
import assert from 'node:assert';
import { createHash, createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  buildRegisterBody,
  buildRegisterHeaders,
  createAnonymousIdentity,
  createHelios,
  createMedusa,
  hongguoUserAgent,
  parseRegisterResponse,
  sha512Bytes,
  signHongguoSearchRequest,
} from '../../utils/hongguo-util.js';

const TT_PREFIX = '3176c9b6d71579d7e82179c9e7cbde787b54d541bad3b15f2e8fed92293fa25a';
const TT_CONSTANT = '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58';
const DEVICE = {
  brand: 'vivo',
  model: 'V2284A',
  osVersion: '12',
  osApi: 32,
  build: 'V417IR',
  resolution: '1080*1920',
  dpi: 280,
  channel: 'huawei_8662_64',
};

test('hongguo sha512Bytes 与 Node 实现一致', () => {
  for (const value of ['', 'abc', 'hello world', 'x'.repeat(1000)]) {
    const actual = Buffer.from(sha512Bytes(Buffer.from(value))).toString('hex');
    const expected = createHash('sha512').update(value).digest('hex');
    assert.equal(actual, expected);
  }
});

test('hongguo createHelios 输出与协议样本一致', () => {
  assert.equal(createHelios(1700000000, 0xa1b2c3d4), '1MOyoSMktRMOaWOxtu7vqc9ac8QQ65N91Uwz7o58l+N5fW1f');
});

test('hongguo createMedusa 输出与协议样本一致', () => {
  const entropy = {
    EnvLaunch: 105,
    EnvPID: 12345,
    NowSecs: 1700000000,
    MessageRandom: 0x11223344,
    Random: 0x55667788,
    PackedRandom: 0x99aabbcc,
  };
  const url = 'https://reading.snssdk.com/reading/bookapi/search/tab/v?iid=1&device_id=2&query=x&ts=1700000000&_rticket=1700000000000';
  assert.equal(
    createMedusa(url, 1700000000, '3489222938627392', '7.3.9.32', entropy),
    'A/FTZfcZDJ/XJo9e1tubFVc+Mn2IdwAB7DXMu6qRASIBOLm/TlXfQI9FRZsRDav+LaUbr3ywvG3rIpkL2C7hfyAf+Gz8bXwLuP70waEDmmG4AyAafqI/OEUxDTC2mm92/xfeRM1fvGY4y73EygpoPOl/t9qmTflK/nIHgVRZ3GvQ/1c4JD/gxtI3//vy4Frmb7DGV1H0Idqlx3wuA74TangogoXlhA61h1DbTssjfA0pKc4YQUEe6q31/wN5adwjL8hRoHuHwdKEdCfeSy5f/Q1CICXLq4geS3VgrxavNnCf62C7J4+OYnsdJ+2D6o/AYuiFAScWNZGss1ajuUYGsr4ms8ulu3Ag4Gh2SU88ue2uFzH95LU6qqx/zTqVwcYj8gMQpJsy2dxR8PeHjqFzVdvdkIVVe6V6VgWlgm2rihjVKQAamnH8tG0ZyIKLZomS3sLOHfXo+w6+RdLEL0crsD4g5l1z3bl7WezEkpv4DIqcI6mDlMpv6fl3tneWX6xUEtpoeSFlVk4PYcGEFWpDZe511ZCmWi8pTv+FS2OCmQEYKOUWdBY2ywpHFbebX43k7IzW+U5DMTQfYlVXvT+5rtY8aj/tZfon8PhRjZ+QD6UkOnjOBLtm7AuUSuoG2IYuBECDKHykc8J4PtgB9T6AV0Mnn9Tq6TMXhFHfFKRTVEqXhk71JnzLVw5VfRUnboDIRZYkAPdYwpXmy1q2b1rrohmIOfMDLLzcp1ABS+8QOG9oWEhBMJ23QrdCQ2Z9UuV8s5/lkRfSnVEmyj84OG5Rg3zSCZlDH4/ngTqxHt1O3VN/tb8zs0k4oDwImMFXGYOf+uZPos9x8NShF6MeKHWhx2w9N6YGibwemyyMbEKEkM0buBpzPHqekP2RcD7Hx5lmWjGGtBhR72IxmVCyVpSVGjjQ4Z1meJrOa9jLWuSM4pJZx1tM1Dwm5758IDg0pvGRX08qgqJ4RrNm+OOd6hT0QNYIjGXvbYOH8iSkI+jP//zPz//9j2ZV',
  );
});

test('hongguo 搜索签名返回完整请求头', () => {
  const entropy = {
    EnvLaunch: 105,
    EnvPID: 12345,
    NowSecs: 1700000000,
    MessageRandom: 0x11223344,
    Random: 0x55667788,
    PackedRandom: 0x99aabbcc,
    HeliosRandom: 0xa1b2c3d4,
  };
  const headers = signHongguoSearchRequest('https://example.com/path?a=1&ts=1700000000', {
    deviceId: '3489222938627392',
    timestamp: 1700000000,
    entropy,
  });
  assert.deepEqual(Object.keys(headers).sort(), ['x-helios', 'x-khronos', 'x-medusa']);
  assert.equal(headers['x-khronos'], '1700000000');
  assert.ok(headers['x-medusa'].length > 100);
  assert.ok(headers['x-helios'].length > 20);

  const signed = signHongguoSearchRequest('https://example.com/path?a=1&ts=1700000000', {
    deviceId: '3489222938627392',
    timestamp: 1700000000,
    entropy,
    argus: 'argus-value',
    ladon: 'ladon-value',
  });
  assert.equal(signed['x-argus'], 'argus-value');
  assert.equal(signed['x-ladon'], 'ladon-value');
});

test('hongguo 匿名设备注册体可解密并与请求头匹配', async () => {
  const identity = {
    cdid: '11111111-1111-4111-8111-111111111111',
    openudid: '0011223344556677',
    clientudid: '22222222-2222-4222-8222-222222222222',
    oaid: '33333333-3333-4333-8333-333333333333',
    reqId: '44444444-4444-4444-8444-444444444444',
  };
  const generatedAt = 1700000000000;
  const body = await buildRegisterBody(identity, DEVICE, generatedAt);
  assert.equal(Buffer.from(body.slice(0, 6)).toString('hex'), '746305100000');

  const prefixHash = createHash('sha512').update(Buffer.from(TT_PREFIX, 'hex')).digest();
  const keyIv = createHash('sha512')
    .update(Buffer.concat([prefixHash, Buffer.from(TT_CONSTANT, 'hex')]))
    .digest();
  const decipher = createDecipheriv('aes-128-cbc', keyIv.subarray(0, 16), keyIv.subarray(16, 32));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(body.subarray(6 + 32))),
    decipher.final(),
  ]);
  const digest = decrypted.subarray(0, 64);
  const compressed = decrypted.subarray(64);
  assert.equal(digest.toString('hex'), createHash('sha512').update(compressed).digest('hex'));

  const payload = JSON.parse(gunzipSync(compressed).toString('utf8'));
  assert.equal(payload.magic_tag, 'ss_app_log');
  assert.equal(payload._gen_time, generatedAt);
  assert.equal(payload.header.cdid, identity.cdid);
  assert.equal(payload.header.openudid, identity.openudid);
  assert.equal(payload.header.device_model, DEVICE.model);
  assert.equal(payload.header.device_brand, DEVICE.brand);
  assert.equal(payload.header.oaid.id, identity.oaid);
  assert.equal(payload.header.oaid.time, String(generatedAt - 200));

  const headers = buildRegisterHeaders(DEVICE, body);
  assert.equal(headers['X-SS-STUB'], createHash('md5').update(body).digest('hex').toUpperCase());
  assert.equal(headers['x-ss-dp'], '8662');
  assert.equal(headers['User-Agent'], hongguoUserAgent(DEVICE));
});

test('hongguo 注册响应解析与匿名身份生成', () => {
  assert.deepEqual(
    parseRegisterResponse({ device_id_str: '123', install_id_str: '456' }),
    { deviceId: '123', installId: '456' },
  );
  assert.deepEqual(
    parseRegisterResponse({ data: { device_id: 123, install_id: 456 } }),
    { deviceId: '123', installId: '456' },
  );
  assert.throws(() => parseRegisterResponse({ device_id_str: '0', install_id_str: '456' }), /注册失败/);

  const identity = createAnonymousIdentity();
  assert.match(identity.cdid, /^[0-9a-f-]{36}$/);
  assert.match(identity.openudid, /^[0-9a-f]{16}$/);
  assert.match(identity.oaid, /^[0-9a-f-]{36}$/);
  assert.match(identity.oaidReqId, /^[0-9a-f-]{36}$/);
  assert.match(identity.reqId, /^[0-9a-f-]{36}$/);
  assert.notEqual(identity.oaid, identity.oaidReqId);
  assert.notEqual(identity.cdid, identity.clientudid);
});
