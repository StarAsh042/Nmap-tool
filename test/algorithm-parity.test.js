/**
 * algorithm-parity.test.js — 通道映射的逐字节等价测试（特征化测试）。
 *
 * 为什么需要这份测试：
 *   通道映射的对外行为不允许改变，任何"性能优化"都必须产出逐字节相同的结果。
 *   单元测试只能证明"符合我写的断言"，证明不了"和改造前完全一样"。
 *   因此这里自带一份**独立参考实现**：直接照 README 的通道规则从零写出来，
 *   不复用 algorithm.js 里的任何内部函数。被测实现与参考实现来自两份互不相干的
 *   代码，两者逐字节一致，才说明改造没有悄悄改变行为。
 *
 * 这份测试在优化前后都必须通过：
 *   - 优化前：被测实现本身就是逐字节版本，自然一致；
 *   - 优化后：它用来锁住"字级快路径与逐字节路径结果相同"。
 *   所以它不是 TDD 的 RED 阶段测试，而是回归护栏。
 *
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { NormalMapChannel: Algo } = require('../algorithm.js');

/* ======================================================================
   独立参考实现（照 README 的规则写，不引用 algorithm.js 内部实现）
   ====================================================================== */

/** README 规则：dst.R = src.A · dst.G = 255 - src.G · dst.B = src.R · dst.A = 255 */
function refMapRows(src, dst, width, startRow, endRow) {
  for (let y = startRow; y < endRow; y++) {
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      const r = src[i];
      const g = src[i + 1];
      const a = src[i + 3];
      dst[i] = a;
      dst[i + 1] = 255 - g;
      dst[i + 2] = r;
      dst[i + 3] = 255;
    }
  }
}

const OFFSETS = { R: 0, G: 1, B: 2, A: 3 };

/** 单通道提取：gray 三通道同值；rgb 涂原色（A 无原色，退化为 gray）；A 恒为 255 */
function refExtractChannelRows(src, dst, width, startRow, endRow, channel, mode) {
  const offset = OFFSETS[channel];
  const tinted = mode === 'rgb' && channel !== 'A';
  for (let y = startRow; y < endRow; y++) {
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      const v = src[i + offset];
      if (tinted) {
        dst[i] = offset === 0 ? v : 0;
        dst[i + 1] = offset === 1 ? v : 0;
        dst[i + 2] = offset === 2 ? v : 0;
      } else {
        dst[i] = v;
        dst[i + 1] = v;
        dst[i + 2] = v;
      }
      dst[i + 3] = 255;
    }
  }
}

/* ======================================================================
   测试辅助
   ====================================================================== */

/** 确定性伪随机（xorshift32）：用固定种子，测试失败可复现，不依赖 Math.random */
function makeRandom(seed) {
  let s = seed >>> 0 || 1;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s & 255;
  };
}

/** 用确定性随机数填满一个 RGBA 缓冲 */
function fillRandom(length, seed) {
  const data = new Uint8ClampedArray(length);
  const next = makeRandom(seed);
  for (let i = 0; i < length; i++) data[i] = next();
  return data;
}

/** 逐字节比对两个缓冲，失败时报告第一个不一致的位置而不是整块 dump */
function assertSameBytes(actual, expected, message) {
  assert.equal(actual.length, expected.length, message + '：长度不一致');
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      const pixel = Math.floor(i / 4);
      const channel = 'RGBA'[i % 4];
      assert.fail(
        message + '：第 ' + i + ' 字节（像素 ' + pixel + ' 的 ' + channel + ' 通道）不一致，' +
        '实际 ' + actual[i] + '，期望 ' + expected[i]
      );
    }
  }
}

/* ======================================================================
   mapRows 等价性
   ====================================================================== */

test('parity:mapRows 与参考实现在多种尺寸下逐字节一致', () => {
  const sizes = [[1, 1], [3, 1], [1, 5], [17, 13], [64, 64], [127, 3]];
  for (const [width, height] of sizes) {
    const length = width * height * 4;
    const src = fillRandom(length, width * 7919 + height);
    const expected = new Uint8ClampedArray(length);
    const actual = new Uint8ClampedArray(length);

    refMapRows(src, expected, width, 0, height);
    Algo.mapRows(src, actual, width, 0, height);

    assertSameBytes(actual, expected, width + 'x' + height + ' 整图');
  }
});

test('parity:mapRows 在任意行区间上与参考实现一致', () => {
  const width = 29;
  const height = 41;
  const length = width * height * 4;
  const src = fillRandom(length, 20261019);

  // 覆盖：整图、单行、首行、末行、中间区间、越界收敛到 height 的区间
  const ranges = [[0, height], [0, 1], [height - 1, height], [7, 8], [3, 9], [height, height]];

  for (const [start, end] of ranges) {
    const expected = new Uint8ClampedArray(length);
    const actual = new Uint8ClampedArray(length);
    refMapRows(src, expected, width, start, end);
    Algo.mapRows(src, actual, width, start, end);
    assertSameBytes(actual, expected, '行区间 [' + start + ', ' + end + ')');
  }
});

test('parity:mapRows 在通道边界值上逐字节一致', () => {
  // g=0 与 g=255 是 255-g 的两个边界；全 0 与全 255 覆盖饱和情形
  const cases = [
    { name: '全 0', r: 0, g: 0, b: 0, a: 0 },
    { name: '全 255', r: 255, g: 255, b: 255, a: 255 },
    { name: 'G=0', r: 12, g: 0, b: 34, a: 56 },
    { name: 'G=255', r: 12, g: 255, b: 34, a: 56 },
    { name: '半透明', r: 200, g: 100, b: 50, a: 128 }
  ];

  for (const c of cases) {
    const width = 8;
    const height = 8;
    const length = width * height * 4;
    const src = new Uint8ClampedArray(length);
    for (let i = 0; i < length; i += 4) {
      src[i] = c.r; src[i + 1] = c.g; src[i + 2] = c.b; src[i + 3] = c.a;
    }
    const expected = new Uint8ClampedArray(length);
    const actual = new Uint8ClampedArray(length);
    refMapRows(src, expected, width, 0, height);
    Algo.mapRows(src, actual, width, 0, height);
    assertSameBytes(actual, expected, c.name);
  }
});

/* ======================================================================
   extractChannelRows 等价性
   ====================================================================== */

test('parity:extractChannelRows 覆盖 4 通道 × 2 模式', () => {
  const width = 23;
  const height = 19;
  const length = width * height * 4;
  const src = fillRandom(length, 424242);

  for (const channel of ['R', 'G', 'B', 'A']) {
    for (const mode of ['gray', 'rgb']) {
      const expected = new Uint8ClampedArray(length);
      const actual = new Uint8ClampedArray(length);
      refExtractChannelRows(src, expected, width, 0, height, channel, mode);
      Algo.extractChannelRows(src, actual, width, 0, height, { channel: channel, mode: mode });
      assertSameBytes(actual, expected, channel + ' / ' + mode);
    }
  }
});

test('parity:extractChannelRows 在通道边界值上逐字节一致', () => {
  const width = 8;
  const height = 8;
  const length = width * height * 4;
  const src = new Uint8ClampedArray(length);
  // 让四个通道分别是 0 / 255 / 中间值，覆盖取值为 0 与 255 的两个端点
  for (let i = 0; i < length; i += 4) {
    src[i] = 0; src[i + 1] = 255; src[i + 2] = 128; src[i + 3] = 0;
  }
  for (const channel of ['R', 'G', 'B', 'A']) {
    for (const mode of ['gray', 'rgb']) {
      const expected = new Uint8ClampedArray(length);
      const actual = new Uint8ClampedArray(length);
      refExtractChannelRows(src, expected, width, 0, height, channel, mode);
      Algo.extractChannelRows(src, actual, width, 0, height, { channel: channel, mode: mode });
      assertSameBytes(actual, expected, channel + ' / ' + mode + ' 边界值');
    }
  }
});

/* ======================================================================
   退化输入：对齐与长度异常时必须仍与参考实现一致
   ====================================================================== */

test('parity:非 4 字节对齐的缓冲仍与参考实现一致', () => {
  const width = 16;
  const height = 9;
  const length = width * height * 4;
  const backing = new ArrayBuffer(length + 8);
  const src = new Uint8ClampedArray(backing, 2, length);   // byteOffset = 2，无法用 Uint32Array 视图
  const fill = fillRandom(length, 777);
  src.set(fill);

  const dstBacking = new ArrayBuffer(length + 8);
  const dst = new Uint8ClampedArray(dstBacking, 2, length);

  const expected = new Uint8ClampedArray(length);
  refMapRows(src, expected, width, 0, height);
  Algo.mapRows(src, dst, width, 0, height);

  assertSameBytes(dst, expected, '非对齐 mapRows');
});

test('parity:长度不足一个像素但为 4 的倍数时仍与参考实现一致', () => {
  // 缓冲长度是 4 的倍数，但比 width*height*4 少一个像素。
  // 越界读出的 undefined 在两条路径上会被转换成不同字节，因此快路径必须拒绝这种输入。
  const width = 5;
  const height = 4;
  const full = width * height * 4;
  const src = fillRandom(full, 5150).subarray(0, full - 4);
  const dst = new Uint8ClampedArray(full - 4);
  const expected = new Uint8ClampedArray(full - 4);

  refMapRows(src, expected, width, 0, height);
  Algo.mapRows(src, dst, width, 0, height);

  assertSameBytes(dst, expected, '长度不足 1 像素');
});

test('parity:长度不是 4 的倍数时仍与参考实现一致', () => {
  // 这是退化输入（正常 ImageData 一定对齐），只要求两条路径给出相同结果，不崩溃
  const width = 5;
  const height = 4;
  const full = width * height * 4;
  const src = fillRandom(full, 31337).subarray(0, full - 1);
  const expected = new Uint8ClampedArray(full - 1);
  const actual = new Uint8ClampedArray(full - 1);

  refMapRows(src, expected, width, 0, height);
  Algo.mapRows(src, actual, width, 0, height);

  assertSameBytes(actual, expected, '长度非 4 倍数');
});
