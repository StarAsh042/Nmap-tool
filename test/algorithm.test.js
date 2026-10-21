/**
 * algorithm.test.js — 通道映射算法层单元测试。
 *
 * 零依赖，直接使用 Node 内置 test runner（node:test + node:assert）。
 *
 * algorithm.js 是经典脚本，其结尾 `(typeof self !== 'undefined' ? self : this)`
 * 在 CommonJS 环境下使 `this === module.exports`，因此可直接 require，
 * 无需为测试改造生产代码。
 *
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { NormalMapChannel: Algo } = require('../algorithm.js');

/* ======================================================================
   测试辅助
   ====================================================================== */

/**
 * 构造一张 width×height 的 RGBA 测试图。
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>number[]} pixel 返回 [r,g,b,a] 的函数
 */
function makeImage(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

/** 读取第 (x,y) 像素 */
function pixelAt(data, width, x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

/* ======================================================================
   导出契约
   ====================================================================== */

test('exports:公开 API 齐全', () => {
  assert.ok(Algo, 'algorithm.js 应导出 NormalMapChannel 命名空间');
  assert.equal(typeof Algo.mapRows, 'function');
  assert.equal(typeof Algo.processChannels, 'function');
  assert.equal(typeof Algo.inspectChannels, 'function');
  assert.equal(typeof Algo.extractChannelRows, 'function');
  assert.equal(typeof Algo.extractChannel, 'function');
  assert.ok(Array.isArray(Algo.CHANNEL_KEYS));
  assert.equal(typeof Algo.MAX_PIXELS, 'number');
});

test('MAX_PIXELS:为正整数且与文档一致', () => {
  assert.ok(Algo.MAX_PIXELS > 0);
  assert.ok(Number.isInteger(Algo.MAX_PIXELS));
  // 33554432 ≈ 8192 × 4096
  assert.equal(Algo.MAX_PIXELS, 33554432);
});

/* ======================================================================
   mapRows — 映射规则
   ====================================================================== */

test('mapRows:按规则重排通道 dst.R=src.A, dst.G=255-src.G, dst.B=src.R, dst.A=255', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 40]);
  const dst = new Uint8ClampedArray(4);

  Algo.mapRows(src, dst, 1, 0, 1);

  assert.deepEqual([...dst], [40, 235, 10, 255],
    'R 应取原 A=40，G 应为 255-20=235，B 应取原 R=10，A 应置 255');
});

test('mapRows:绿通道翻转在边界值 0/255 上正确', () => {
  const src = new Uint8ClampedArray([0, 0, 0, 255]);
  const dst = new Uint8ClampedArray(4);
  Algo.mapRows(src, dst, 1, 0, 1);
  assert.equal(dst[1], 255, 'G=0 应翻转为 255');

  const src2 = new Uint8ClampedArray([0, 255, 0, 255]);
  const dst2 = new Uint8ClampedArray(4);
  Algo.mapRows(src2, dst2, 1, 0, 1);
  assert.equal(dst2[1], 0, 'G=255 应翻转为 0');
});

test('mapRows:丢弃原蓝通道', () => {
  const src = new Uint8ClampedArray([7, 8, 9, 11]);
  const dst = new Uint8ClampedArray([1, 1, 1, 1]);
  Algo.mapRows(src, dst, 1, 0, 1);
  // dst.B 应等于 src.R(=7)，而不是 src.B(=9)
  assert.equal(dst[2], 7);
  assert.notEqual(dst[2], 9);
});

test('mapRows:alpha 不做归一化，取原始值写入红通道', () => {
  const src = new Uint8ClampedArray([0, 0, 0, 128]);
  const dst = new Uint8ClampedArray(4);
  Algo.mapRows(src, dst, 1, 0, 1);
  assert.equal(dst[0], 128, '半透明像素的 A=128 应原样写入 R');
});

test('mapRows:仅处理指定行区间', () => {
  const width = 2;
  const height = 4;
  const src = makeImage(width, height, () => [1, 2, 3, 4]);
  const dst = new Uint8ClampedArray(width * height * 4); // 全 0

  Algo.mapRows(src, dst, width, 1, 3);

  // 第 0 行不应被处理
  assert.deepEqual(pixelAt(dst, width, 0, 0), [0, 0, 0, 0], '区间外的第 0 行应保持为 0');
  // 第 1、2 行应被处理：R=4, G=253, B=1, A=255
  assert.deepEqual(pixelAt(dst, width, 0, 1), [4, 253, 1, 255]);
  assert.deepEqual(pixelAt(dst, width, 1, 2), [4, 253, 1, 255]);
  // 第 3 行不应被处理
  assert.deepEqual(pixelAt(dst, width, 0, 3), [0, 0, 0, 0], '区间外的末行应保持为 0');
});

test('mapRows:返回结束行', () => {
  const src = new Uint8ClampedArray(4 * 10);
  const dst = new Uint8ClampedArray(4 * 10);
  assert.equal(Algo.mapRows(src, dst, 1, 2, 5), 5);
});

test('mapRows:空区间为安全的空操作', () => {
  const src = new Uint8ClampedArray([1, 2, 3, 4]);
  const dst = new Uint8ClampedArray([9, 9, 9, 9]);
  assert.equal(Algo.mapRows(src, dst, 1, 3, 3), 3);
  assert.deepEqual([...dst], [9, 9, 9, 9], 'startRow === endRow 时不应写入任何像素');
});

test('mapRows:源与目标为不同缓冲时不产生别名问题', () => {
  const src = makeImage(3, 2, (x, y) => [x * 10, y * 20, 30, 40]);
  const copy = new Uint8ClampedArray(src);
  const dst = new Uint8ClampedArray(src.length);

  Algo.mapRows(src, dst, 3, 0, 2);

  assert.deepEqual([...src], [...copy], 'mapRows 不应修改源缓冲');
});

/* ======================================================================
   processChannels — 整图同步处理
   ====================================================================== */

test('processChannels:整图处理结果与逐行 mapRows 一致', () => {
  const width = 5;
  const height = 7;
  const src = makeImage(width, height, (x, y) => [(x * 3) % 256, (y * 5) % 256, 99, (x + y) % 256]);

  const whole = new Uint8ClampedArray(src.length);
  Algo.processChannels(src, whole, width, height);

  const rowByRow = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    Algo.mapRows(src, rowByRow, width, y, y + 1);
  }

  assert.deepEqual([...whole], [...rowByRow]);
});

test('processChannels:返回总行数', () => {
  const src = new Uint8ClampedArray(2 * 9 * 4);
  const dst = new Uint8ClampedArray(2 * 9 * 4);
  assert.equal(Algo.processChannels(src, dst, 2, 9), 9);
});

test('processChannels:通过 onProgress 回调上报进度', () => {
  const width = 4;
  const height = 600; // > CHUNK_ROWS(256)，确保多次回调
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);

  const calls = [];
  Algo.processChannels(src, dst, width, height, (rowsDone, total) => {
    calls.push([rowsDone, total]);
  });

  assert.ok(calls.length >= 2, `应多次上报进度，实际 ${calls.length} 次`);
  for (const [rowsDone, total] of calls) {
    assert.equal(total, height, '第二个参数应为总行数');
    assert.ok(rowsDone > 0 && rowsDone <= height, '进度值应在 (0, height] 区间');
  }
  // 进度单调不减，且最后一次为 height
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i][0] > calls[i - 1][0], '进度应单调递增');
  }
  assert.equal(calls[calls.length - 1][0], height, '最后一次进度应为 height');
});

test('processChannels:可省略 onProgress', () => {
  const src = new Uint8ClampedArray([1, 2, 3, 4]);
  const dst = new Uint8ClampedArray(4);
  assert.doesNotThrow(() => Algo.processChannels(src, dst, 1, 1));
});

test('processChannels:非函数 onProgress 被安全忽略', () => {
  const src = new Uint8ClampedArray([1, 2, 3, 4]);
  const dst = new Uint8ClampedArray(4);
  assert.doesNotThrow(() => Algo.processChannels(src, dst, 1, 1, 'not-a-function'));
});

/* ======================================================================
   inspectChannels — 透明通道探测
   ====================================================================== */

test('inspectChannels:全不透明图判定为 RGB', () => {
  const width = 8;
  const height = 8;
  const src = makeImage(width, height, () => [10, 20, 30, 255]);
  const info = Algo.inspectChannels(src, width, height);

  assert.equal(info.hasAlpha, false);
  assert.equal(info.channels, 'RGB');
  assert.ok(info.sampled > 0);
  assert.ok(info.stride >= 1);
});

test('inspectChannels:含半透明像素判定为 RGBA', () => {
  const width = 8;
  const height = 8;
  const src = makeImage(width, height, (x, y) => (x === 3 && y === 5 ? [10, 20, 30, 128] : [10, 20, 30, 255]));
  const info = Algo.inspectChannels(src, width, height);

  assert.equal(info.hasAlpha, true);
  assert.equal(info.channels, 'RGBA');
});

test('inspectChannels:alpha=0 的全透明图判定为 RGBA', () => {
  const src = new Uint8ClampedArray([1, 2, 3, 0]);
  const info = Algo.inspectChannels(src, 1, 1);
  assert.equal(info.hasAlpha, true);
  assert.equal(info.channels, 'RGBA');
});

test('inspectChannels:缓冲长度不足时安全降级为 RGB', () => {
  const info = Algo.inspectChannels(new Uint8ClampedArray([1, 2, 3, 4]), 100, 100);
  assert.equal(info.hasAlpha, false);
  assert.equal(info.channels, 'RGB');
  assert.equal(info.sampled, 0);
  assert.equal(info.stride, 0);
});

test('inspectChannels:空输入安全降级为 RGB', () => {
  for (const [src, w, h] of [
    [new Uint8ClampedArray(0), 0, 0],
    [null, 4, 4],
    [undefined, 4, 4],
  ]) {
    const info = Algo.inspectChannels(src, w, h);
    assert.equal(info.hasAlpha, false, '无效输入应判定为无透明通道');
    assert.equal(info.channels, 'RGB');
  }
});

test('inspectChannels:抽样上限为 20000 个样本', () => {
  // 4 万像素，抽样上限 20000 => stride 应为 2
  const width = 200;
  const height = 200; // 40000 像素
  const src = makeImage(width, height, () => [1, 2, 3, 255]);
  const info = Algo.inspectChannels(src, width, height);

  assert.ok(info.stride >= 2, '大图应使用等距步进抽样');
  assert.ok(info.sampled <= 20000 + 1, '抽样数不应超过上限');
});

test('inspectChannels:小图 stride 为 1（全量扫描）', () => {
  const width = 10;
  const height = 10; // 100 像素 < 20000
  const src = makeImage(width, height, () => [1, 2, 3, 255]);
  const info = Algo.inspectChannels(src, width, height);
  assert.equal(info.stride, 1);
});

/* ======================================================================
   端到端：真实映射语义
   ====================================================================== */

test('端到端:不透明图的修复结果符合 README 描述', () => {
  const width = 2;
  const height = 2;
  // 红=100, 绿=50, 蓝=200, alpha=255（无透明通道）
  const src = makeImage(width, height, () => [100, 50, 200, 255]);
  const dst = new Uint8ClampedArray(src.length);

  Algo.processChannels(src, dst, width, height);

  // R = A = 255（无透明通道 ⇒ 红通道整体置 255）
  // G = 255 - 50 = 205
  // B = 原 R = 100
  // A = 255
  assert.deepEqual(pixelAt(dst, width, 0, 0), [255, 205, 100, 255]);
  assert.deepEqual(pixelAt(dst, width, 1, 1), [255, 205, 100, 255]);
});

test('端到端:带透明通道时红通道取原 alpha', () => {
  const width = 1;
  const height = 1;
  const src = makeImage(width, height, () => [10, 20, 30, 77]);
  const dst = new Uint8ClampedArray(src.length);

  Algo.processChannels(src, dst, width, height);

  assert.deepEqual(pixelAt(dst, width, 0, 0), [77, 235, 10, 255]);
});

test('端到端:映射后输出始终为不透明', () => {
  const width = 4;
  const height = 4;
  const src = makeImage(width, height, (x, y) => [x, y, 0, (x * y) % 256]);
  const dst = new Uint8ClampedArray(src.length);

  Algo.processChannels(src, dst, width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assert.equal(pixelAt(dst, width, x, y)[3], 255, `(${x},${y}) 的 alpha 应为 255`);
    }
  }
});

test('端到端:处理是幂等上下文无关的（重复处理会再次翻转绿通道）', () => {
  // 明确记录语义：算法是通道重排而非归一化，重复执行会再次翻转 G
  const width = 1;
  const height = 1;
  const src = new Uint8ClampedArray([10, 100, 20, 255]);

  const once = new Uint8ClampedArray(4);
  Algo.processChannels(src, once, width, height);

  const twice = new Uint8ClampedArray(4);
  Algo.processChannels(once, twice, width, height);

  assert.equal(once[1], 155, '首次处理 G=255-100=155');
  assert.equal(twice[1], 100, '二次处理 G=255-155=100，回到原值');
});

/* ======================================================================
   extractChannelRows / extractChannel — 单通道灰度与 RGB 着色预览
   ====================================================================== */

test('CHANNEL_KEYS:按 R/G/B/A 顺序暴露通道下标', () => {
  assert.deepEqual(Algo.CHANNEL_KEYS, ['R', 'G', 'B', 'A']);
});

test('extractChannelRows:灰度模式下取指定通道并置为不透明', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 40]);
  const dst = new Uint8ClampedArray(4);

  Algo.extractChannelRows(src, dst, 1, 0, 1, { channel: 'G', mode: 'gray' });

  assert.deepEqual([...dst], [20, 20, 20, 255],
    'G 通道值 20 应铺满 RGB，alpha 置 255 以免被棋盘格底色干扰');
});

test('extractChannelRows:A 通道取原始 alpha 值作为灰度', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 128]);
  const dst = new Uint8ClampedArray(4);

  Algo.extractChannelRows(src, dst, 1, 0, 1, { channel: 'A', mode: 'gray' });

  assert.deepEqual([...dst], [128, 128, 128, 255]);
});

test('extractChannelRows:rgb 着色模式下把该通道涂成对应原色', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 40]);

  const rDst = new Uint8ClampedArray(4);
  Algo.extractChannelRows(src, rDst, 1, 0, 1, { channel: 'R', mode: 'rgb' });
  assert.deepEqual([...rDst], [10, 0, 0, 255], 'R 通道应以纯红调呈现');

  const gDst = new Uint8ClampedArray(4);
  Algo.extractChannelRows(src, gDst, 1, 0, 1, { channel: 'G', mode: 'rgb' });
  assert.deepEqual([...gDst], [0, 20, 0, 255], 'G 通道应以纯绿调呈现');

  const bDst = new Uint8ClampedArray(4);
  Algo.extractChannelRows(src, bDst, 1, 0, 1, { channel: 'B', mode: 'rgb' });
  assert.deepEqual([...bDst], [0, 0, 30, 255], 'B 通道应以纯蓝调呈现');
});

test('extractChannelRows:rgb 模式下 A 通道退化为灰度', () => {
  // A 通道没有对应的原色，着色模式对它没有意义，必须回退到灰度而不是涂成红色
  const src = new Uint8ClampedArray([10, 20, 30, 128]);
  const dst = new Uint8ClampedArray(4);

  Algo.extractChannelRows(src, dst, 1, 0, 1, { channel: 'A', mode: 'rgb' });

  assert.deepEqual([...dst], [128, 128, 128, 255]);
});

test('extractChannelRows:非法 channel 抛错而非静默出错', () => {
  const src = new Uint8ClampedArray(4);
  const dst = new Uint8ClampedArray(4);
  // 注意 undefined 不在此列：undefined 表示「未提供」，合法回落到 R 通道。
  // 但显式的 null 是上游取值失误，必须报错，否则 bug 会被藏进最终画面。
  for (const bad of ['X', '', null, 2, 'rgb', 'r']) {
    assert.throws(
      () => Algo.extractChannelRows(src, dst, 1, 0, 1, { channel: bad }),
      /channel/i,
      `channel=${String(bad)} 应抛出可读错误`,
    );
  }
});

test('extractChannelRows:channel 为 undefined 时回落到 R 通道', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 40]);
  const dst = new Uint8ClampedArray(4);

  Algo.extractChannelRows(src, dst, 1, 0, 1, { channel: undefined });

  assert.deepEqual([...dst], [10, 10, 10, 255], '未提供 channel 时应取 R');
});

test('extractChannelRows:非法 mode 抛错', () => {
  const src = new Uint8ClampedArray(4);
  const dst = new Uint8ClampedArray(4);
  assert.throws(
    () => Algo.extractChannelRows(src, dst, 1, 0, 1, { channel: 'R', mode: 'sepia' }),
    /mode/i,
  );
});

test('extractChannelRows:缺省 options 时回退为 R 通道灰度', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 40]);
  const dst = new Uint8ClampedArray(4);
  assert.doesNotThrow(() => Algo.extractChannelRows(src, dst, 1, 0, 1));
  assert.deepEqual([...dst], [10, 10, 10, 255]);
});

test('extractChannelRows:仅处理指定行区间，区间外保持不变', () => {
  const width = 2;
  const height = 4;
  const src = makeImage(width, height, (x, y) => [10 + y, 20 + y, 30 + y, 255]);
  const dst = new Uint8ClampedArray(width * height * 4).fill(9);

  Algo.extractChannelRows(src, dst, width, 1, 3, { channel: 'B', mode: 'gray' });

  assert.deepEqual(pixelAt(dst, width, 0, 0), [9, 9, 9, 9], '区间外的第 0 行不应被写入');
  assert.deepEqual(pixelAt(dst, width, 0, 1), [31, 31, 31, 255], '第 1 行 B=30+1=31');
  assert.deepEqual(pixelAt(dst, width, 0, 2), [32, 32, 32, 255], '第 2 行 B=30+2=32');
  assert.deepEqual(pixelAt(dst, width, 0, 3), [9, 9, 9, 9], '区间外的末行不应被写入');
});

test('extractChannelRows:返回结束行且空区间为安全空操作', () => {
  const src = new Uint8ClampedArray([1, 2, 3, 4]);
  const dst = new Uint8ClampedArray([9, 9, 9, 9]);

  assert.equal(Algo.extractChannelRows(src, dst, 1, 2, 5, { channel: 'R' }), 5);

  const guard = new Uint8ClampedArray([9, 9, 9, 9]);
  assert.equal(Algo.extractChannelRows(src, guard, 1, 3, 3, { channel: 'R' }), 3);
  assert.deepEqual([...guard], [9, 9, 9, 9], 'startRow === endRow 时不应写入任何像素');
});

test('extractChannelRows:不修改源缓冲', () => {
  const src = makeImage(3, 3, (x, y) => [x * 10, y * 10, 30, 40]);
  const copy = new Uint8ClampedArray(src);
  const dst = new Uint8ClampedArray(src.length);

  Algo.extractChannelRows(src, dst, 3, 0, 3, { channel: 'A', mode: 'gray' });

  assert.deepEqual([...src], [...copy]);
});

test('extractChannel:整图提取结果与逐行调用一致', () => {
  const width = 5;
  const height = 7;
  const src = makeImage(width, height, (x, y) => [(x * 3) % 256, (y * 5) % 256, 99, (x + y) % 256]);

  const whole = new Uint8ClampedArray(src.length);
  Algo.extractChannel(src, whole, width, height, { channel: 'G', mode: 'gray' });

  const rowByRow = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    Algo.extractChannelRows(src, rowByRow, width, y, y + 1, { channel: 'G', mode: 'gray' });
  }

  assert.deepEqual([...whole], [...rowByRow]);
});

test('extractChannel:返回总行数并上报进度', () => {
  const width = 4;
  const height = 600; // > 内部 CHUNK_ROWS，确保多次回调
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);

  const calls = [];
  const rows = Algo.extractChannel(src, dst, width, height, { channel: 'R' }, (done, total) => {
    calls.push([done, total]);
  });

  assert.equal(rows, height);
  assert.ok(calls.length >= 2, `应多次上报进度，实际 ${calls.length} 次`);
  for (const [done, total] of calls) {
    assert.equal(total, height);
    assert.ok(done > 0 && done <= height);
  }
  assert.equal(calls[calls.length - 1][0], height);
});

test('extractChannel:可省略 onProgress 与 options', () => {
  const src = new Uint8ClampedArray([1, 2, 3, 4]);
  const dst = new Uint8ClampedArray(4);
  assert.doesNotThrow(() => Algo.extractChannel(src, dst, 1, 1));
});

test('端到端:修复结果各通道提取互不串扰', () => {
  const width = 1;
  const height = 1;
  // 原图 R=10 G=20 B=30 A=40 => 修复后 R=40 G=235 B=10 A=255
  const src = makeImage(width, height, () => [10, 20, 30, 40]);
  const fixed = new Uint8ClampedArray(src.length);
  Algo.processChannels(src, fixed, width, height);

  const dst = new Uint8ClampedArray(4);
  Algo.extractChannel(fixed, dst, width, height, { channel: 'R', mode: 'gray' });
  assert.deepEqual([...dst], [40, 40, 40, 255], '修复后 R 应为原 alpha=40');

  Algo.extractChannel(fixed, dst, width, height, { channel: 'G', mode: 'gray' });
  assert.deepEqual([...dst], [235, 235, 235, 255], '修复后 G 应为 255-20=235');

  Algo.extractChannel(fixed, dst, width, height, { channel: 'A', mode: 'gray' });
  assert.deepEqual([...dst], [255, 255, 255, 255], '修复后 A 恒为 255，应呈全白');
});