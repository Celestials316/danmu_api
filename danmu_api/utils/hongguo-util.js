import {
  aesCbcEncrypt,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  md5,
  sm3Bytes,
  stringToUtf8Bytes,
} from "./codec-util.js";

export const HONGGUO_SEARCH_VERSION_NAME = "7.3.9.32";
export const HONGGUO_SEARCH_VERSION_CODE = 73932;

const MASK64 = (1n << 64n) - 1n;
const SHA512_K = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];
const SHA512_H = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const TT_ENCRYPT_PREFIX = hexToBytes(
  "3176c9b6d71579d7e82179c9e7cbde787b54d541bad3b15f2e8fed92293fa25a",
);
const TT_ENCRYPT_CONSTANT = hexToBytes(
  "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",
);
const SBOX = base64ToBytes(
  "+n0Ia5xZs0sEXznQOEqRmQBnpiCf9U2Ccybu3xhmgzOAAxn72f6uqqmwUsYL83klTni0NqxdGieeiNu9PGPsSRXBMB/cuFbUbM3KCUPINaPvHvSW0vwOcnuUhNHqRVpiAj/TEoE0K91+5ijypUYTATsh9mE3KSoN7Yyvv51cuyR2D3XkU4nhmI2xmmVwT1RMWKtub4sjxAcRDLrPoKSO2AU9FLLadMPX577Wf95IFj6FkKFVt3dCIsmGUC4X+WQxLJvxbRxEaOPpqJOXyzJX6+Vxaq3AzMfF/WAdoi1Hp+JRaV56zgpBtpWP97mH4DoGEIq1+FvV8LyS/3wvwugbQOwb2r26mJEMsiuDQTRn+wrYdrVGBVlhI3WQhyrjUBVMrLF5667llUcEaPCGPVGLD8qO5LlO8hKCvA7V9+8oJc9bXelqVQLhM76T5/WtnT45JKji+hdX0HoNCDDWuKON/QeaxB5uImSX0h2wv0VmP2zd2yeApxHcpsVS+MC2yFwAc2B7oBkTqsk1SEvTpM2fmfMQREBUfin0Bh+iq6EvPPavhWI2IX9e3yAas7Tm/3KEj2UmlFp36kN4x0rMLBRrxuh0U/zUHM4xcAMYjJY4MonxOl/X+alpt2M3WMI7w3HLnpIBigtNiJu7T21v4P6lSd5WFgntnMEt7oF92XzRLkJbTcGmXepE/UVOG6E/0YnhfS+q26utWcuxzpooyeD2cDlK1/8w9d28VzsRjbLuALbmGlp8+d7EzS6Au7lMpZ+ECMZvQmzwJ+eLOpxR+2chdUExp8ogQyq3v9l68rX4jCwjg0+PYKAEEzcU4wHFY2ZcdIHfWL1okD3SszT0GZMyKdZJrg1L2AeerB4tC0C4crp2EHGo5FYdSP7lwkeR2ocmnR+Ia8CYviUJlzOjhRZef9xuVOn3qcjow3fQgivsAmKKkg4+sA8F8/GWeDiGNhg8JM8KtFPMYWWkx5TVFX5t73kiNRJqjlIGVXtGZFCV4gzt0xcDopuZ6xz8r9Rzafpf9ywev8jh8592gHFIqpStZPuJxmDDMrNN0uBE3V+oscdoIzTJbRJ/t+sVvqnReJOgDJKk10fjisJwqyZBmnmn2BSFj8BvVtCMEbkuPOKdzw7eA11GPs04Qw8zWtkaZWwiO/wwpojqN6K0jY5RnNZA7vn4hPSul+nKCkVnVwQvg1zVxcSCtqORmB9KrJaBbssbCQivGJVJfVTt+hYxOtq4ZvWl8f4QAQZ0zGPffCgl9s6yT4vlvIdpu4YhBwA25wtQWZsc6GJYGWHyvSdeuh3mmUI9DSq13Fsp8C1MU3tqc04/df9LoTUXVXI5INOw/e8C7Hd+5CvbkMEFnnrUUmskEw==",
);
const BRANCH2_ORDERS = hexToBytes(
  "0f0704000908030a060b050d0e010c020f05080c0009020103070e060b0a0d04060500070c000a04080f010b0d09020e060b02050403080101070a000d0c090e0d070e0f0b0208030c0509010004060a0d0902060f0b0a040807000c0503010e0c090f07060f030e020d0405010b0a000c050a090e0802040407030f01060b000b0f0408020a0700090d06010e03050c0b060a0508020c03070f0e090d0001040906080f050800040a0b030d01020c0e090d0c0604070a03030f00080105020e01000d0f090a0b0e0402080703060c0501080a0c0f0905060b000304020e070d04080f000c0f0e0d0a01060207090503040205080d0b0a0606000e0f070c09030a08040f000b01060d0c0709030e05020a070b050f00020e0108030d0c0609040d070f08050f06040b0a0e0c090002030d0c020704010b0e0e08060f09050003",
);
const MEDUSA_SIGN_KEY = hexToBytes(
  "8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5",
);
const MEDUSA_AES_KEY = hexToBytes("f1593376766ea98d34f31b057a9d5be4");
const MEDUSA_AES_IV = hexToBytes("1fe109a4125283f418de9e051a969e12");
const BRANCH2_SV = [
  0xa7aefe20, 0x7149f1d6, 0x47e4ca07, 0xe9b58f67, 0x93b924de, 0xc614d0f5, 0x38afe0ef, 0xb2bbad73,
  0xe24444c3, 0x9d3aec9b, 0xdf7b37e4, 0xd8b16d40, 0xf8ac31b8, 0x76b9a90b, 0x31d833ee, 0x953fce64,
  0x353595a4, 0x4609c13b, 0x36925008, 0x8c6d0925, 0x5df5c177, 0x1cfbf52b, 0x8a4fa7f0, 0x114ca35e,
  0x8193f984, 0x7a7a8733, 0x316ab4d5, 0x3c20cfc9, 0xa6d84453, 0x3a18500c, 0x798ec47a, 0x97a76b28,
  0x66c4ff96, 0x51716443, 0x0dd2fc3b, 0xb5696da7, 0xbbeb3ac5, 0x5c53d204, 0xd32608ce, 0x7279b9ec,
  0xf4188ecf, 0xf7d793db, 0x332cc491, 0xab76ae15, 0x9bebe727, 0x18a01384, 0x5be9f8a7, 0x5f90a754,
  0x39b663c0, 0x36673c83, 0x7c92f514, 0x9d7d94d7, 0xe2e8d9aa, 0x5f7e9ea9, 0x7abd4551, 0x569e05da,
  0x40a25632, 0x3df5a9a5, 0xbab37d80, 0x454286dc, 0x3f5d4e78, 0x03d7b75d, 0xb1fe4af7, 0xa5ab26a3,
];
const BRANCH0_IV = [0xc4a78580, 0xb3c0fd39, 0xc58c5686, 0xc9aa3ba7, 0xf5a7adf2, 0x963c2ed1];
const BRANCH0_TT = [
  0xebb64faf, 0x07aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
  0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
  0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
  0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
  0x617ce2a6, 0xe423417e, 0x0a40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x05b23bb3,
  0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
  0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
  0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x00284ba7, 0x08387cfa, 0x5fb37586,
];
const BRANCH0_INIT = [
  0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
  984304912, 3005047866, 2874125293, 2152413264,
];
const BRANCH0_ROUNDS = [
  [101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3],
  [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4],
  [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5],
  [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6],
  [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4],
  [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5],
];
const AES_CON2 = [[1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3]];
const AES_ORDER = [
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
  [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
  [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
];
const AES_INIT_WORD = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f];

function concatBytes(...parts) {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : new Uint8Array(part || [])));
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

function readUint64BE(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

function writeUint64BE(bytes, offset, value) {
  let remaining = value;
  for (let i = 7; i >= 0; i--) {
    bytes[offset + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function readUint64LE(bytes, offset) {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value;
}

function writeUint64LE(bytes, offset, value) {
  let remaining = value;
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function ror64(value, count) {
  const shift = BigInt(Number(count) & 63);
  if (shift === 0n) return value;
  return ((value >> shift) | (value << (64n - shift))) & MASK64;
}

function rol32(value, count) {
  const shift = count & 31;
  if (shift === 0) return value >>> 0;
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function ror32(value, count) {
  const shift = count & 31;
  if (shift === 0) return value >>> 0;
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function le32(value) {
  const output = new Uint8Array(4);
  const number = value >>> 0;
  output[0] = number & 0xff;
  output[1] = (number >>> 8) & 0xff;
  output[2] = (number >>> 16) & 0xff;
  output[3] = (number >>> 24) & 0xff;
  return output;
}

function md5Raw(value) {
  return hexToBytes(md5(value));
}

function sm3(value) {
  return sm3Bytes(value);
}

function varint(value) {
  let remaining = BigInt(value);
  const output = [];
  while (remaining > 127n) {
    output.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  output.push(Number(remaining));
  return Uint8Array.from(output);
}

function zigzag(value) {
  const number = BigInt(value);
  return BigInt.asUintN(64, (number << 1n) ^ (number >> 63n));
}

function pbKey(tag, wire) {
  return varint((BigInt(tag) << 3n) | BigInt(wire));
}

function pbBytes(tag, value) {
  const bytes = value instanceof Uint8Array ? value : stringToUtf8Bytes(String(value));
  if (!bytes.length) return new Uint8Array(0);
  return concatBytes(pbKey(tag, 2), varint(bytes.length), bytes);
}

function pbString(tag, value) {
  return pbBytes(tag, stringToUtf8Bytes(String(value)));
}

function pbSInt(tag, value) {
  return concatBytes(pbKey(tag, 0), varint(zigzag(value)));
}

function pbFloat(tag, value) {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setFloat32(0, value, true);
  return concatBytes(pbKey(tag, 5), output);
}

export function sha512Bytes(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  const bitLength = BigInt(data.length) * 8n;
  const paddedLength = Math.ceil((data.length + 17) / 128) * 128;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  let remaining = bitLength;
  for (let i = 0; i < 16; i++) {
    padded[paddedLength - 1 - i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const state = [...SHA512_H];
  const words = new Array(80);
  for (let offset = 0; offset < paddedLength; offset += 128) {
    for (let i = 0; i < 16; i++) words[i] = readUint64BE(padded, offset + i * 8);
    for (let i = 16; i < 80; i++) {
      const s0 = ror64(words[i - 15], 1n) ^ ror64(words[i - 15], 8n) ^ (words[i - 15] >> 7n);
      const s1 = ror64(words[i - 2], 19n) ^ ror64(words[i - 2], 61n) ^ (words[i - 2] >> 6n);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 80; i++) {
      const s1 = ror64(e, 14n) ^ ror64(e, 18n) ^ ror64(e, 41n);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA512_K[i] + words[i]) & MASK64;
      const s0 = ror64(a, 28n) ^ ror64(a, 34n) ^ ror64(a, 39n);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) & MASK64;
      h = g;
      g = f;
      f = e;
      e = (d + t1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK64;
    }
    state[0] = (state[0] + a) & MASK64;
    state[1] = (state[1] + b) & MASK64;
    state[2] = (state[2] + c) & MASK64;
    state[3] = (state[3] + d) & MASK64;
    state[4] = (state[4] + e) & MASK64;
    state[5] = (state[5] + f) & MASK64;
    state[6] = (state[6] + g) & MASK64;
    state[7] = (state[7] + h) & MASK64;
  }
  const output = new Uint8Array(64);
  for (let i = 0; i < 8; i++) writeUint64BE(output, i * 8, state[i]);
  return output;
}

function ttEncrypt(input) {
  const prefixHash = sha512Bytes(TT_ENCRYPT_PREFIX);
  const keyIv = sha512Bytes(concatBytes(prefixHash, TT_ENCRYPT_CONSTANT));
  const digest = sha512Bytes(input);
  const plain = concatBytes(digest, input);
  const encrypted = aesCbcEncrypt(plain, keyIv.slice(0, 16), keyIv.slice(16, 32));
  return concatBytes(
    new Uint8Array([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]),
    TT_ENCRYPT_PREFIX,
    encrypted,
  );
}

function getIV(iv, data) {
  let value = iv >>> 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if ((i & 1) === 0) {
      value = ((value >>> 4) ^ value ^ (value << 6) ^ byte) >>> 0;
    } else {
      value = ~((value >>> 7) ^ value ^ (byte | (value << 12))) >>> 0;
    }
  }
  return value;
}

function sumMD5(data) {
  let check = 0x20220420 >>> 0;
  for (let i = 0; i < 12; i++) {
    let temp;
    if ((i & 1) === 0) {
      temp = ((check >>> 3) ^ check) >>> 0;
      check = (data[i] ^ (check << 7)) >>> 0;
    } else {
      temp = ((check >>> 5) ^ check) >>> 0;
      check = (data[i] | (check << 11)) >>> 0;
      check = ~check >>> 0;
    }
    check = (check ^ temp) >>> 0;
  }
  return ((check | 4) ^ 0x01000000) >>> 0;
}

function expandWords(data) {
  const words = [];
  for (let offset = 0; offset + 4 <= data.length; offset += 4) {
    words.push(
      ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0,
    );
  }
  let previous = words[0];
  for (let i = 0; i < 112; i++) {
    const next = words[i + 1];
    const distant = words[i + 14];
    const r1 = (rol32(next, 14) ^ rol32(next, 25) ^ (next >>> 3)) >>> 0;
    const r2 = (rol32(distant, 13) ^ rol32(distant, 15) ^ (distant >>> 10)) >>> 0;
    words.push((previous + words[i + 9] + r1 + r2) >>> 0);
    previous = next;
  }
  return words;
}

function mixRounds(state, rounds, words, table, ivV1) {
  for (let i = 0; i < rounds[0]; i++) {
    const base = (ivV1 + i) >>> 0;
    const word = words[base & 127];
    const index = (k) => rounds[k];
    const n1 = (((state[index(3)] ^ state[index(4)]) & state[index(1)]) ^ state[index(3)]) >>> 0;
    const n2 = (rol32(state[index(1)], 26) ^ rol32(state[index(1)], 21) ^ rol32(state[index(1)], 7)) >>> 0;
    const n4 = (word + n1 + n2 + table[base & 63] + state[index(5)]) >>> 0;
    const n5 = (rol32(state[index(2)], 30) ^ rol32(state[index(2)], 19) ^ rol32(state[index(2)], 10)) >>> 0;
    const n6 = ((state[index(2)] & state[index(6)]) | ((state[index(2)] | state[index(6)]) & state[index(7)])) >>> 0;
    const n7 = (n5 + n6) >>> 0;
    const old = state[index(9)];
    const last = state[state.length - 1];
    state.pop();
    state.unshift(last);
    state[index(10)] = (n7 + n4) >>> 0;
    state[index(8)] = (old + n4) >>> 0;
  }
  return state;
}

function branch0F13(querySM3, bodyMD5, ts, khronos, ivV0) {
  const ivV1 = BRANCH0_IV[Math.min(ivV0, BRANCH0_IV.length - 1)];
  const countV1 = (ivV1 + khronos + 1) & 255;
  const countV2 = (ivV1 + khronos) >>> 0;
  const table = BRANCH0_TT.map((value) => ror32(value, countV1));
  const shift = (countV2 + 2) & 7;
  const seed = [0xfa, 0x45, 0x61, 0xd7];
  const pad = Uint8Array.from(seed, (value) => (((value | (value << 8)) >>> shift) & 255));
  const data = concatBytes(querySM3, bodyMD5, ts, pad, hexToBytes("00000000000001a0"));
  const words = expandWords(data);
  const initial = BRANCH0_INIT.map((value) => ror32(value, countV2 & 31));
  const mixed = mixRounds([...initial], BRANCH0_ROUNDS[ivV0], words, table, ivV1);
  const output = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const value = (mixed[i] + initial[i]) >>> 0;
    output[i * 4] = (value >>> 24) & 0xff;
    output[i * 4 + 1] = (value >>> 16) & 0xff;
    output[i * 4 + 2] = (value >>> 8) & 0xff;
    output[i * 4 + 3] = value & 0xff;
  }
  for (let i = 0; i < 16; i++) output[i] ^= output[16 + i];
  return concatBytes(output.slice(0, 16), le32(sumMD5(output.slice(0, 16))));
}

function md5V3Step(kind, a, b, c, d, m, shift, constant) {
  let f;
  switch (kind) {
    case 0: f = (b & c) | (~b & d); break;
    case 1: f = (b & d) | (c & ~d); break;
    case 2: f = b ^ c ^ d; break;
    default: f = c ^ (b | ~d);
  }
  return (b + rol32((a + (f >>> 0) + m + constant) >>> 0, shift)) >>> 0;
}

function md5SumV3(message, countV2, orders, countV1) {
  const table = BRANCH2_SV.map((value) => ror32(value, countV1));
  const start = [
    ror32(0x79e0f2fb, countV2),
    ror32(0xc8b52570, countV2),
    ror32(0xebc2f8cd, countV2),
    ror32(0x7c104d93, countV2),
  ];
  const endCount = (countV2 + 6) & 255;
  const end = [
    ror32(0x19be4866, endCount),
    ror32(0xe85986b4, endCount),
    ror32(0xe19b326e, endCount),
    ror32(0x71d1d7d4, endCount),
  ];
  const words = [];
  for (let i = 0; i < 16; i++) {
    words.push(
      (message[i * 4] | (message[i * 4 + 1] << 8) | (message[i * 4 + 2] << 16) | (message[i * 4 + 3] << 24)) >>> 0,
    );
  }
  let [a, b, c, d] = start;
  const shiftsGroups = [
    [7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21],
  ];
  for (let round = 0; round < 4; round++) {
    const shifts = shiftsGroups[round];
    for (let i = 0; i < 16; i++) {
      const phase = i & 3;
      const word = words[orders[round * 16 + i]];
      const constant = table[round * 16 + i];
      let next;
      switch (phase) {
        case 0: next = md5V3Step(round, a, b, c, d, word, shifts[i], constant); a = next; break;
        case 1: next = md5V3Step(round, d, a, b, c, word, shifts[i], constant); d = next; break;
        case 2: next = md5V3Step(round, c, d, a, b, word, shifts[i], constant); c = next; break;
        default: next = md5V3Step(round, b, c, d, a, word, shifts[i], constant); b = next;
      }
    }
  }
  const digest = concatBytes(
    le32((start[0] + a) ^ end[0]),
    le32((start[1] + b) ^ end[1]),
    le32((start[2] + c) ^ end[2]),
    le32((start[3] + d) ^ end[3]),
  );
  return concatBytes(digest, le32(sumMD5(digest)));
}

function branch2F13(iv, querySM3, bodyMD5, ts, khronos) {
  const value = (iv & 13) * 86;
  const ivV0 = ((value >>> 15) & 255) + ((value >>> 8) & 255);
  const seeds = [0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4];
  const seed = seeds[Math.min(ivV0, seeds.length - 1)];
  const countV1 = (seed + khronos + 1) & 255;
  const countV2 = (seed + khronos) >>> 0;
  const shift = (countV2 + 5) & 7;
  const padSource = [0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];
  const pad = Uint8Array.from(padSource, (item) => (((item | (item << 8)) >>> shift) & 255));
  const input = concatBytes(querySM3, bodyMD5, ts, pad, hexToBytes("a0010000"));
  const begin = ivV0 << 6;
  return md5SumV3(input, countV2, BRANCH2_ORDERS.slice(begin, begin + 64), countV1);
}

function hashF13(querySM3, bodyMD5, ts, khronos) {
  const iv = getIV(getIV(getIV(0x20230928, querySM3), bodyMD5), ts);
  const low = iv & 15;
  const ivV0 = (low * 171) >> 9;
  const branch = low - ivV0 * 3;
  if (branch === 2) return branch2F13(iv, querySM3, bodyMD5, ts, khronos);
  if (branch !== 0) {
    const output = concatBytes(querySM3.slice(0, 16), bodyMD5);
    return concatBytes(output, le32(sumMD5(concatBytes(querySM3, bodyMD5))));
  }
  return branch0F13(querySM3, bodyMD5, ts, khronos, ivV0);
}

class AesV3 {
  constructor(key, khronos) {
    const word = khronos & 3;
    this.box = SBOX.slice(word * 256, word * 256 + 256);
    this.con2 = AES_CON2[word];
    this.order = AES_ORDER[word];
    this.keys = AesV3.expand(key, word);
  }

  static expand(key, word) {
    const init = AES_INIT_WORD[word] >>> 0;
    const box = SBOX.slice(word * 256, word * 256 + 256);
    const initial = concatBytes(le32(init), le32(init), le32(init), le32(init));
    const expanded = new Uint8Array(48);
    for (let i = 0; i < 16; i++) expanded[i] = initial[i] ^ key[i % key.length];
    let rounds = 8;
    for (let i = 4; i < 12; i++) {
      const at = 4 * (i - 1);
      let a = expanded[at];
      let b = expanded[at + 1];
      let c = expanded[at + 2];
      let d = expanded[at + 3];
      if ((i & 3) === 0) {
        const value = (((init >>> (rounds & 24)) ^ box[b]) & 255) >>> 0;
        b = box[c];
        c = box[d];
        d = box[a];
        a = value;
      }
      rounds += 2;
      expanded[at + 4] = a ^ expanded[at - 12];
      expanded[at + 5] = b ^ expanded[at - 11];
      expanded[at + 6] = c ^ expanded[at - 10];
      expanded[at + 7] = d ^ expanded[at - 9];
    }
    const keys = [];
    for (let i = 0; i < 12; i++) keys.push(Array.from(expanded.slice(i * 4, i * 4 + 4)));
    return keys;
  }

  addCon(state, keys, con2) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) state[i][j] ^= keys[i][con2[j]];
    }
  }

  sub(state) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) state[i][j] = this.box[state[i][j]];
    }
    const previous = state.map((row) => row.slice());
    for (let i = 0; i < 4; i++) state[i] = previous[this.con2[i]];
  }

  shift(state) {
    const flat = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) flat.push(state[i][j]);
    }
    for (let i = 0; i < 16; i++) state[i >> 2][i & 3] = flat[this.order[i]];
  }

  static shiftCon(state, con2) {
    const previous = state.map((row) => row.slice());
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) state[i][j] = previous[i][con2[j]];
    }
  }

  static mixColumns(state) {
    const xt = (value) => {
      const shifted = (value << 1) & 255;
      return value & 128 ? shifted ^ 0x1b : shifted;
    };
    for (let i = 0; i < 4; i++) {
      const total = state[0][i] ^ state[1][i] ^ state[2][i] ^ state[3][i];
      const first = state[0][i];
      state[0][i] ^= total ^ xt(state[0][i] ^ state[1][i]);
      state[1][i] ^= total ^ xt(state[1][i] ^ state[2][i]);
      state[2][i] ^= total ^ xt(state[2][i] ^ state[3][i]);
      state[3][i] ^= total ^ xt(state[3][i] ^ first);
    }
  }

  block(value) {
    const state = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) state[i][j] = value[i * 4 + j];
    }
    this.addCon(state, this.keys.slice(0, 4), this.con2);
    for (let i = 1; i < 3; i++) {
      this.sub(state);
      this.shift(state);
      if (i === 1) {
        AesV3.shiftCon(state, this.con2);
        AesV3.mixColumns(state);
      }
      this.addCon(state, this.keys.slice(i * 4, i * 4 + 4), this.con2);
    }
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) state[i][j] ^= this.keys[4 + i][j];
    }
    return state.flat();
  }

  encrypt(data, iv) {
    const source = Uint8Array.from(data);
    const plaintext = new Uint8Array(32);
    for (let i = 0; i < 31; i++) {
      const at = i * 8;
      let value = (source[at] >>> 4) & 2;
      value |= source[at + 1] & 64;
      value |= (source[at + 2] >>> 2) & 1;
      value |= (source[at + 3] << 3) & 128;
      value |= (source[at + 4] >>> 1) & 4;
      value |= (source[at + 5] << 3) & 16;
      value |= (source[at + 6] << 5) & 32;
      value |= (source[at + 7] >>> 4) & 8;
      plaintext[i] = value & 255;
    }
    plaintext[31] = 1;
    const blocks = [];
    let previous = iv;
    for (let offset = 0; offset < 32; offset += 16) {
      const xored = new Uint8Array(16);
      for (let i = 0; i < 16; i++) xored[i] = plaintext[offset + i] ^ previous[i];
      const encrypted = Uint8Array.from(this.block(xored));
      blocks.push(...encrypted);
      previous = encrypted;
    }
    const output = source;
    for (let i = 0; i < 31; i++) {
      const at = i * 8;
      const key = blocks[i];
      output[at] &= 0xdf;
      output[at] |= (key << 4) & 32;
      output[at + 1] &= 0xbf;
      output[at + 1] |= key & 64;
      output[at + 2] &= 0xfb;
      output[at + 2] |= (key << 2) & 4;
      output[at + 3] &= 0xef;
      output[at + 3] |= (key >>> 3) & 16;
      output[at + 4] &= 0xf7;
      output[at + 4] |= (key + key) & 8;
      output[at + 5] &= 0xfd;
      output[at + 5] |= (key >>> 3) & 2;
      output[at + 6] &= 0xfe;
      output[at + 6] |= (key >>> 5) & 1;
      output[at + 7] &= 0x7f;
      output[at + 7] |= (key << 4) & 128;
    }
    return concatBytes(new Uint8Array([blocks[31]]), output);
  }
}

function xmxor(data, key) {
  const length = data.length;
  const encoded = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const at = (i * 4) & 28;
    const first = key[at];
    const second = key[at + 1];
    let value = (((data[i] << 4) | (data[i] >>> 4)) + first) & 255;
    value = (~value ^ second) & 255;
    value = ((value << 3) | (value >>> 5)) & 255;
    value = (value + second) & 255;
    value ^= first;
    encoded[length - i - 1] = ~value & 255;
  }
  const last = encoded[length - 1] ^ encoded[length - 2];
  const first = encoded[0];
  encoded[0] = ((~last & 255) + first) & 255;
  encoded[1] = ((encoded[0] ^ encoded[length - 1] ^ 254) + encoded[1]) & 255;
  const shifted = ((encoded[1] << 3) | (encoded[1] >>> 5)) & 255;
  const correction = ((last - first) ^ (shifted ^ 2)) & 255;
  encoded[2] = (encoded[2] + correction) & 255;
  for (let i = 0; i < length - 4; i++) {
    const rotated = ((encoded[i + 2] << 3) | (encoded[i + 2] >>> 5)) & 255;
    const temp = (rotated ^ encoded[i + 1] ^ (i + 3)) & 255;
    encoded[i + 3] = ((~temp & 255) + encoded[i + 3]) & 255;
  }
  encoded[length - 1] ^= encoded[length - 2];
  let total = 0;
  for (let i = 1; i < length; i++) total = (total + encoded[i]) >>> 0;
  encoded[0] = ((encoded[0] ^ encoded[1]) + (total & 255)) & 255;
  return encoded;
}

function keyHash(signKey, random) {
  const hash = sm3(concatBytes(signKey, le32(random), signKey));
  const first = (random >>> 16) & 255;
  let seed = ((first << 11) | (random >>> 24)) >>> 0;
  seed ^= first >>> 5;
  seed ^= first;
  seed = ~seed >>> 0;
  return [hash, le32(seed)];
}

function deviceProto(deviceId) {
  return concatBytes(
    pbSInt(1, 1),
    pbSInt(2, 2),
    pbString(3, "8662"),
    pbString(4, deviceId),
    pbString(5, "Ai6svO3PyrwDOUSmO6ZcResxu"),
    pbString(6, "!noperm!"),
    pbSInt(7, -888888),
    pbSInt(8, -888888),
    pbSInt(9, 3),
    pbSInt(10, -888888),
    pbString(11, "!notset!"),
    pbString(12, "Asia/Shanghai,8"),
    pbString(13, "zh_CN"),
    pbSInt(14, 4),
    pbFloat(16, 255.24993896484375),
    pbFloat(17, 35.58599090576172),
    pbFloat(18, 3.467449188232422),
    pbFloat(19, 3.467449188232422),
    pbFloat(20, 255.1754913330078),
    pbFloat(21, 42.17544174194336),
    pbString(22, "16"),
    pbSInt(23, 41),
    pbSInt(24, 36),
    pbSInt(25, 1728388016635),
    pbSInt(26, 1728388016635),
    pbSInt(27, 1728388016635),
    pbSInt(28, 1728388016637),
    pbSInt(29, -1),
    pbString(30, "25053RT47C"),
    pbString(31, "Redmi"),
    pbString(32, "25053RT47C"),
    pbString(33, "25053RT47C"),
    pbString(34, "Xiaomi"),
    pbString(35, "Redmi"),
    pbString(36, "Redmi"),
    pbSInt(38, 31),
  );
}

export function createMedusa(rawUrl, khronos, deviceId, versionName, entropy) {
  const resolvedVersionName = versionName || HONGGUO_SEARCH_VERSION_NAME;
  const queryIndex = rawUrl.indexOf("?");
  const queryRaw = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : "";
  const querySM3 = sm3(stringToUtf8Bytes(queryRaw));
  const bodyMD5 = new Uint8Array(16);
  const queryBody = hashF13(querySM3, bodyMD5, le32(khronos), khronos);
  const check = (((querySM3[0] & 63) << 14) | 0x18000001 | ((queryBody[0] & 63) << 8)) >>> 0;
  const nested = concatBytes(
    pbSInt(1, 111),
    pbSInt(2, 10),
    pbSInt(3, 694367),
    pbSInt(5, 586952199),
  );
  const nested13 = concatBytes(pbSInt(1, entropy.NowSecs), pbSInt(2, -2), pbSInt(4, 200));
  const environment = concatBytes(
    pbSInt(1, entropy.EnvLaunch),
    pbSInt(2, 146331399),
    pbSInt(3, 146331396),
    pbSInt(5, 7),
    pbString(6, "v04.06.04.03-bugfix"),
    pbSInt(7, entropy.EnvPID),
    pbBytes(12, deviceProto(deviceId)),
    pbBytes(13, nested13),
    pbString(14, resolvedVersionName),
  );
  const queryHash = sm3(concatBytes(stringToUtf8Bytes(queryRaw), bodyMD5, stringToUtf8Bytes("none")));
  const fixed2 = hexToBytes("4001000000000000");
  const message = concatBytes(
    pbBytes(1, hexToBytes("f7e85ffad7d7dc3bd62ac87057cf6118")),
    pbSInt(2, 3),
    pbSInt(3, entropy.MessageRandom),
    pbString(4, "8662"),
    pbString(5, deviceId),
    pbString(6, "1588093228"),
    pbString(7, resolvedVersionName),
    pbString(8, "v04.06.04-ml-android"),
    pbSInt(9, 67503104),
    pbBytes(10, fixed2),
    pbSInt(12, khronos),
    pbBytes(13, queryBody),
    pbBytes(14, querySM3.slice(0, 6)),
    pbBytes(15, nested),
    pbString(16, "AXYQOS6n2m60x1fVZHIrH3iol"),
    pbSInt(17, khronos),
    pbBytes(19, queryHash),
    pbString(20, "none"),
    pbSInt(21, 312),
    pbBytes(23, environment),
    pbString(24, '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}'),
  );
  const [hash, seed] = keyHash(MEDUSA_SIGN_KEY, entropy.Random);
  let transformed = concatBytes(fixed2, xmxor(message, hash));
  transformed.reverse();
  for (let i = 0; i < transformed.length; i++) transformed[i] ^= seed[(~i) & 3];
  const random = entropy.Random >>> 0;
  const packed = concatBytes(
    new Uint8Array([0x35]),
    le32(entropy.PackedRandom),
    le32(check),
    transformed,
    new Uint8Array([(random >>> 16) & 255, (random >>> 24) & 255]),
  );
  const encrypted = new AesV3(MEDUSA_AES_KEY, khronos).encrypt(packed, MEDUSA_AES_IV);
  const version = hexToBytes("03000000f7e85ffad7d7dc3bd62ac87057cf6118");
  const prefix = new Uint8Array(20);
  for (let i = 0; i < 5; i++) {
    const value = version[i * 4] | (version[i * 4 + 1] << 8) | (version[i * 4 + 2] << 16) | (version[i * 4 + 3] << 24);
    prefix.set(le32((value ^ khronos) >>> 0), i * 4);
  }
  return bytesToBase64(concatBytes(
    prefix,
    new Uint8Array([random & 255, (random >>> 8) & 255, 0, 1]),
    encrypted,
  ));
}

function diffuse(words) {
  const table = [words[0]];
  let first = words[0];
  let second = words[1];
  const queue = [words[2], words[3]];
  for (let i = 0n; i < 34n; i++) {
    let mixed = (ror64(second, 8n) + first) & MASK64;
    mixed ^= i;
    queue.push(mixed);
    mixed ^= ror64(first, 61n);
    mixed &= MASK64;
    table.push(mixed);
    first = mixed;
    second = queue.shift();
  }
  return table;
}

export function createHelios(khronos, random) {
  const digest = md5Raw(concatBytes(le32(random), stringToUtf8Bytes("8662")));
  const ascii = stringToUtf8Bytes(bytesToHex(digest));
  const words = [0, 1, 2, 3].map((index) => readUint64LE(ascii, index * 8));
  const table = diffuse(words);
  const text = stringToUtf8Bytes(`${khronos}-1588093228-8662`);
  const fill = 16 - (text.length % 16);
  const size = Math.ceil((text.length + 1) / 16) * 16;
  const padded = new Uint8Array(size);
  padded.fill(fill);
  padded.set(text);
  const output = [];
  for (let offset = 0; offset < padded.length; offset += 16) {
    let first = readUint64LE(padded, offset);
    let second = readUint64LE(padded, offset + 8);
    for (const value of table.slice(0, 34)) {
      second = (value ^ ((first + ror64(second, 8n)) & MASK64)) & MASK64;
      first = (second ^ ror64(first, 61n)) & MASK64;
    }
    const block = new Uint8Array(16);
    writeUint64LE(block, 0, first);
    writeUint64LE(block, 8, second);
    output.push(block);
  }
  return bytesToBase64(concatBytes(le32(random), ...output));
}

export function createSearchEntropy(timestamp) {
  const random = randomBytes(16);
  return {
    EnvLaunch: 100 + Number(random[0] % 21),
    EnvPID: 10001 + (((random[8] | (random[9] << 8)) >>> 0) % 2000),
    NowSecs: timestamp,
    MessageRandom: (random[0] | (random[1] << 8) | (random[2] << 16) | (random[3] << 24)) >>> 0,
    Random: (random[4] | (random[5] << 8) | (random[6] << 16) | (random[7] << 24)) >>> 0,
    PackedRandom: (random[8] | (random[9] << 8) | (random[10] << 16) | (random[11] << 24)) >>> 0,
    GorgonRandom: random[12] | (random[13] << 8),
    HeliosRandom: (random[12] | (random[13] << 8) | (random[14] << 16) | (random[15] << 24)) >>> 0,
  };
}

export function signHongguoSearchRequest(url, options = {}) {
  const timestamp = options.timestamp == null ? Math.floor(Date.now() / 1000) : options.timestamp;
  const entropy = options.entropy || createSearchEntropy(timestamp);
  const headers = {
    "x-khronos": String(timestamp),
    "x-helios": createHelios(timestamp, entropy.HeliosRandom),
    "x-medusa": createMedusa(
      url,
      timestamp,
      String(options.deviceId || ""),
      options.versionName || HONGGUO_SEARCH_VERSION_NAME,
      entropy,
    ),
  };
  // 搜索接口当前只校验 medusa/helios；argus/ladon 由调用方按真实签名实现传入，
  // 不再用时间戳 Base64 伪装成签名头，避免服务端升级校验后误判。
  if (options.argus) headers["x-argus"] = options.argus;
  if (options.ladon) headers["x-ladon"] = options.ladon;
  return headers;
}

export function createAnonymousIdentity() {
  const uuid = () => {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return {
    cdid: uuid(),
    openudid: bytesToHex(randomBytes(8)),
    clientudid: uuid(),
    oaid: uuid(),
    oaidReqId: uuid(),
    reqId: uuid(),
  };
}

function buildRegisterHeader(identity, device, generatedAt) {
  return {
    display_name: "红果免费短剧",
    update_version_code: HONGGUO_SEARCH_VERSION_CODE,
    manifest_version_code: HONGGUO_SEARCH_VERSION_CODE,
    app_version_minor: HONGGUO_SEARCH_VERSION_NAME,
    aid: 8662,
    channel: device.channel,
    package: "com.phoenix.read",
    app_version: HONGGUO_SEARCH_VERSION_NAME,
    version_code: HONGGUO_SEARCH_VERSION_CODE,
    os: "Android",
    os_version: device.osVersion,
    os_api: String(device.osApi),
    device_model: device.model,
    device_brand: device.brand,
    device_manufacturer: device.manufacturer || device.brand,
    cpu_abi: "arm64-v8a",
    language: "zh",
    timezone: 8,
    access: "wifi",
    region: "CN",
    tz_name: "Asia/Shanghai",
    tz_offset: 28800,
    cdid: identity.cdid,
    openudid: identity.openudid,
    clientudid: identity.clientudid,
    ipv6_list: [],
    sim_serial_number: [],
    oaid: {
      hw_id_version_code: "0",
      id: identity.oaid,
      is_track_limited: "false",
      query_times: "1",
      req_id: identity.oaidReqId || identity.reqId,
      take_ms: "6",
      time: String(generatedAt - 200),
    },
    oaid_may_support: true,
    req_id: identity.reqId,
    device_platform: "android",
    guest_mode: 0,
    is_system_app: 0,
    sdk_flavor: "china",
    device_id: "0",
    install_id: "0",
  };
}

export async function buildRegisterBody(identity, device, generatedAt) {
  const pako = await import("pako");
  const header = buildRegisterHeader(identity, device, generatedAt);
  const plaintext = stringToUtf8Bytes(
    `{"magic_tag":"ss_app_log","header":${JSON.stringify(header)},"_gen_time":${generatedAt}}`,
  );
  const compressed = pako.gzip(plaintext);
  return ttEncrypt(compressed);
}

export function buildRegisterHeaders(device, body) {
  return {
    "User-Agent": hongguoUserAgent(device),
    "Content-Type": "application/octet-stream;tt-data=a",
    "log-encode-type": "gzip",
    "sdk-version": "2",
    "passport-sdk-version": "5051452",
    "x-vc-bdturing-sdk-version": "4.0.3.cn",
    "x-ss-dp": "8662",
    "X-SS-STUB": md5(body).toUpperCase(),
  };
}

export function parseRegisterResponse(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const source = data && typeof data === "object" && data.data && typeof data.data === "object"
    ? data.data
    : data || {};
  const deviceId = String(source.device_id_str || source.device_id || "");
  const installId = String(source.install_id_str || source.install_id || "");
  if (!deviceId || !installId || deviceId === "0" || installId === "0") {
    throw new Error("红果匿名设备注册失败");
  }
  return { deviceId, installId };
}

export function hongguoUserAgent(device) {
  return `com.phoenix.read/${HONGGUO_SEARCH_VERSION_CODE} (Linux; U; Android ${device.osVersion}; zh_CN; ${device.model}; Build/${device.build}; Cronet/TTNetVersion:8d40f833 2026-03-03 QuicVersion:21ac1950 2025-11-18)`;
}
