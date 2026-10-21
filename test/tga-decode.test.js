/**
 * tga-decode.test.js — wasm 解码器与 JS 加载层的集成测试。
 *
 * 测试重点不是「TGA 能解开」（那是 Rust 单元测试的事），而是 JS 与 wasm
 * 之间那段搬运协议：
 *   - nm_alloc 拿到的指针是否被正确使用（不能从地址 0 写）
 *   - 内存增长后是否重新取了 memory.buffer（旧视图会被 detach）
 *   - 结果头 [像素指针, 字节数, 宽, 高] 是否被正确解读
 *   - 失败路径是否抛错而不是返回空数据
 *
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const { NormalMapTga } = require('../tga-decoder.js');

const ROOT = join(__dirname, '..');
const WASM_PATH = join(ROOT, 'vendor', 'tga-decoder.wasm');
const B64_PATH = join(ROOT, 'vendor', 'tga-decoder-b64.js');

/** 构造一张未压缩 24 位 TGA。bgr 按行优先给出，每项是 [b, g, r]。 */
function makeTga(width, height, bgr) {
    const out = new Uint8Array(18 + width * height * 3);
    out[2] = 2;                       // image_type = 未压缩真彩色
    out[12] = width & 255;            // width 低字节
    out[13] = (width >> 8) & 255;
    out[14] = height & 255;           // height 低字节
    out[15] = (height >> 8) & 255;
    out[16] = 24;                     // pixel_depth
    out[17] = 0x20;                   // top-left 原点
    for (let i = 0; i < width * height; i++) {
        const px = bgr[i % bgr.length];
        out[18 + i * 3] = px[0];
        out[19 + i * 3] = px[1];
        out[20 + i * 3] = px[2];
    }
    return out;
}

let cached = null;
async function getInstance() {
    if (!cached) {
        cached = await NormalMapTga.instantiate(readFileSync(WASM_PATH));
    }
    return cached;
}

/* ======================================================================
   基础解码
   ====================================================================== */

test('wasm:导出函数齐全', async () => {
    const inst = await getInstance();
    for (const name of ['memory', 'nm_alloc', 'nm_decode_tga', 'nm_free']) {
        assert.ok(inst.exports[name], '缺少导出：' + name);
    }
});

test('wasm:解码未压缩 24 位 TGA，BGR 正确转换为 RGBA', async () => {
    const inst = await getInstance();
    // 2x2：红、绿、蓝、白。TGA 存 BGR，所以红是 [0,0,255]
    const tga = makeTga(2, 2, [[0, 0, 255], [0, 255, 0], [255, 0, 0], [255, 255, 255]]);
    const out = NormalMapTga.decodeWith(inst, tga, 100);

    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
    assert.equal(out.data.length, 16);
    assert.deepEqual([...out.data.slice(0, 4)], [255, 0, 0, 255], '第 1 像素应为红色');
    assert.deepEqual([...out.data.slice(4, 8)], [0, 255, 0, 255], '第 2 像素应为绿色');
    assert.deepEqual([...out.data.slice(8, 12)], [0, 0, 255, 255], '第 3 像素应为蓝色');
    assert.deepEqual([...out.data.slice(12, 16)], [255, 255, 255, 255], '第 4 像素应为白色');
});

test('wasm:连续解码不同尺寸，验证内存增长后视图仍然有效', async () => {
    const inst = await getInstance();

    // 小图先来一次，让内存处于「刚好够用」的状态
    const small = NormalMapTga.decodeWith(inst, makeTga(2, 2, [[0, 0, 0]]), 1e6);
    assert.equal(small.data.length, 16);

    // 512x512 = 1MB 输出，必然触发 memory.grow，旧视图会被 detach。
    // 如果实现里缓存了 memory.buffer，这一步会读到错误数据或直接抛错。
    const before = inst.exports.memory.buffer.byteLength;
    const big = NormalMapTga.decodeWith(inst, makeTga(512, 512, [[10, 20, 30]]), 1e6);
    const after = inst.exports.memory.buffer.byteLength;

    // 断言增长确实发生了：否则这条测试就没覆盖到它声称要覆盖的场景
    assert.ok(after > before, '本次解码应触发内存增长（' + before + ' -> ' + after + '），场景未生效');

    assert.equal(big.width, 512);
    assert.equal(big.height, 512);
    assert.equal(big.data.length, 512 * 512 * 4);
    assert.deepEqual([...big.data.slice(0, 4)], [30, 20, 10, 255], 'BGR(10,20,30) 应为 RGBA(30,20,10)');

    // 再回到小图，确认多次增长后仍能正确解码
    const again = NormalMapTga.decodeWith(inst, makeTga(2, 2, [[0, 0, 255]]), 1e6);
    assert.deepEqual([...again.data.slice(0, 4)], [255, 0, 0, 255]);
});

test('wasm:像素数超过上限时拒绝', async () => {
    const inst = await getInstance();
    const tga = makeTga(4, 4, [[0, 0, 0]]);   // 16 像素
    assert.throws(() => NormalMapTga.decodeWith(inst, tga, 15), /解码失败/);
    assert.doesNotThrow(() => NormalMapTga.decodeWith(inst, tga, 16));
});

test('wasm:垃圾输入抛错而不是返回空数据', async () => {
    const inst = await getInstance();
    assert.throws(() => NormalMapTga.decodeWith(inst, new Uint8Array(0), 100), /解码失败/);
    assert.throws(() => NormalMapTga.decodeWith(inst, new Uint8Array([1, 2, 3, 4, 5]), 100), /解码失败/);
    assert.throws(() => NormalMapTga.decodeWith(inst, new Uint8Array(18), 100), /解码失败/);
});

/* ======================================================================
   base64 兜底
   ====================================================================== */

test('base64:内联版与二进制产物字节一致', async () => {
    const binary = readFileSync(WASM_PATH);
    // 用独立上下文执行生成文件，模拟浏览器里 <script> 注入的效果
    const sandbox = { self: {} };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(B64_PATH, 'utf8'), sandbox);

    const b64 = sandbox.self.NormalMapTgaWasmBase64;
    assert.equal(typeof b64, 'string');
    assert.ok(b64.length > 0, 'base64 数据不应为空');

    const decoded = Buffer.from(b64, 'base64');
    assert.equal(decoded.length, binary.length, '长度应一致');
    assert.ok(decoded.equals(binary), 'base64 解出的字节应与 .wasm 完全相同');

    // 内联版必须能被实例化，否则 file:// 兜底就是死路
    const inst = await NormalMapTga.instantiate(new Uint8Array(decoded));
    const out = NormalMapTga.decodeWith(inst, makeTga(2, 2, [[0, 0, 255]]), 100);
    assert.deepEqual([...out.data.slice(0, 4)], [255, 0, 0, 255]);
});
