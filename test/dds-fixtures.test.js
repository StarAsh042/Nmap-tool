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
 * 判定标准：
 *   R8G8B8A8 / BC4 / BC5 / BC7  与 texconv 展开结果逐字节一致
 *   BC1 / BC2 / BC3              允许最多 1 的偏差（BC1 颜色插值的舍入差异）
 *
 * 「最大偏差 ≤ 1」这条线同时是回归防线：wasm32 截断 bug 会产生 100+ 的偏差，
 * 一旦回归会立刻红。生成新固件见 scripts/verify-dds.mjs。
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

/**
 * 与 texconv 展开结果逐字节一致的格式。
 * 这些格式的解码路径完全由我们自己控制（见 decode_alpha_block）。
 */
const EXACT_FORMATS = ['R8G8B8A8', 'BC4', 'BC5', 'BC7'];

/**
 * 允许 ±1 偏差的格式。
 * 偏差来自 BC1 颜色插值的舍入：截断 vs 四舍五入，不影响视觉。
 */
const TOLERANT_FORMATS = ['BC1', 'BC2', 'BC3'];

/** 各格式的偏差上限。超出就说明不只是舍入问题了。 */
const MAX_DEVIATION = 1;

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

for (const format of EXACT_FORMATS) {
    test(`dds固件:${format} 与 texconv 展开结果逐字节一致`, async () => {
        const { diff, total } = await compare(format);
        assert.equal(diff, 0, `${format} 有 ${diff}/${total} 字节不一致，解码路径可能有回归`);
    });
}

for (const format of TOLERANT_FORMATS) {
    test(`dds固件:${format} 与 texconv 展开结果一致（允许插值舍入 ±1）`, async () => {
        const { diff, maxDiff, total } = await compare(format);
        assert.ok(
            maxDiff <= MAX_DEVIATION,
            `${format} 最大偏差 ${maxDiff}，超过上限 ${MAX_DEVIATION}。` +
            '要么是插值舍入变了，要么是更严重的回归（wasm32 索引截断会产生 100+ 的偏差）。',
        );
        assert.ok(diff / total < 0.25, `${format} 不一致比例 ${(diff / total * 100).toFixed(1)}% 过高`);
    });
}
