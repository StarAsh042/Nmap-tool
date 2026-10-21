/**
 * dds-fixtures.test.js — 用真实 DDS 固件验证解码器。
 *
 * 固件由微软 texconv（DirectXTex）生成，覆盖常见工具实际会写出的头部写法：
 * 未压缩 R8G8B8A8、BC1–BC7，以及 texconv 自己展开成的 RGBA8 参照。
 *
 * 为什么需要真实固件：手工构造的样本只能验证「我的构造对不对」。在真实文件
 * 上才发现过四个问题——BC5U FourCC 不被识别、库在 wasm32 上截断索引、
 * BC4 没铺灰度、BC1 没处理 1 位透明。这些都写不进手工样本，因为它们藏在
 * 「真实工具会怎么写」而不是「规范怎么写」里。
 *
 * 判定标准：**全部格式与 texconv 展开结果逐字节一致**。
 *
 * 这个标准不是一开始就有的。BC1/BC2/BC3 曾经差 ±1，原因是颜色插值用了
 * 「先展开成 8 位再插值」的写法；DirectXTex 是先把 RGB565 归一化到 0..1、
 * 在浮点域插值、最后 `v*255+0.5` 截断。照抄源码后差值归零。
 *
 * 零容忍同时是回归防线：wasm32 截断 bug 会产生 100+ 的偏差，
 * 任何舍入写错都会产生 1 的偏差，两者都会让测试立刻红。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { NormalMapDecoder } = require('../texture-decoder.js');

const ROOT = join(__dirname, '..');
const FIXTURES = join(__dirname, 'fixtures', 'dds');
const WASM_PATH = join(ROOT, 'vendor', 'texture-decoder.wasm');

const FIXTURE_WIDTH = 64;
const FIXTURE_HEIGHT = 64;

/** 固件覆盖的全部格式，每一种都要求与 texconv 展开结果逐字节一致。 */
const FORMATS = ['R8G8B8A8', 'BC1', 'BC2', 'BC3', 'BC4', 'BC5', 'BC7'];

let instance = null;

async function getInstance() {
    if (!instance) {
        instance = await NormalMapDecoder.instantiate(readFileSync(WASM_PATH));
    }
    return instance;
}

/**
 * 解码固件并与参照比对。
 * @returns {{diff: number, maxDiff: number, total: number, width: number, height: number}}
 */
async function compare(format) {
    const inst = await getInstance();
    const ours = NormalMapDecoder.decodeWith(
        inst,
        new Uint8Array(readFileSync(join(FIXTURES, format, 'decoded.dds'))),
        1e7,
        'dds',
    );
    const ref = NormalMapDecoder.decodeWith(
        inst,
        new Uint8Array(readFileSync(join(FIXTURES, `ref_${format}`, 'reference.dds'))),
        1e7,
        'dds',
    );

    assert.equal(ours.width, FIXTURE_WIDTH, `${format} 固件宽度应为 ${FIXTURE_WIDTH}`);
    assert.equal(ours.height, FIXTURE_HEIGHT, `${format} 固件高度应为 ${FIXTURE_HEIGHT}`);
    assert.equal(ours.data.length, ref.data.length, '两侧像素数应一致');

    let diff = 0;
    let maxDiff = 0;
    for (let i = 0; i < ours.data.length; i++) {
        const d = Math.abs(ours.data[i] - ref.data[i]);
        if (d !== 0) {
            diff++;
            if (d > maxDiff) maxDiff = d;
        }
    }
    return { diff, maxDiff, total: ours.data.length, width: ours.width, height: ours.height };
}

for (const format of FORMATS) {
    test(`dds固件:${format} 与 texconv 展开结果逐字节一致`, async () => {
        const { diff, total, maxDiff } = await compare(format);
        assert.equal(
            diff,
            0,
            `${format} 有 ${diff}/${total} 字节不一致（最大偏差 ${maxDiff}），解码路径可能有回归`,
        );
    });
}
