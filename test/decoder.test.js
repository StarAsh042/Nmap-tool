/**
 * decoder.test.js — wasm 解码器与 JS 加载层的集成测试（TGA / DDS）。
 *
 * 测试重点不是「格式能解开」（那是 Rust 单元测试的事），而是 JS 与 wasm
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

const { NormalMapDecoder } = require('../texture-decoder.js');

const ROOT = join(__dirname, '..');
const WASM_PATH = join(ROOT, 'vendor', 'texture-decoder.wasm');
const B64_PATH = join(ROOT, 'vendor', 'texture-decoder-b64.js');

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
        cached = await NormalMapDecoder.instantiate(readFileSync(WASM_PATH));
    }
    return cached;
}

/* ======================================================================
   基础解码
   ====================================================================== */

test('wasm:导出函数齐全', async () => {
    const inst = await getInstance();
    for (const name of ['memory', 'nm_alloc', 'nm_decode_tga', 'nm_decode_dds', 'nm_free']) {
        assert.ok(inst.exports[name], '缺少导出：' + name);
    }
});

test('wasm:解码未压缩 24 位 TGA，BGR 正确转换为 RGBA', async () => {
    const inst = await getInstance();
    // 2x2：红、绿、蓝、白。TGA 存 BGR，所以红是 [0,0,255]
    const tga = makeTga(2, 2, [[0, 0, 255], [0, 255, 0], [255, 0, 0], [255, 255, 255]]);
    const out = NormalMapDecoder.decodeWith(inst, tga, 100);

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
    const small = NormalMapDecoder.decodeWith(inst, makeTga(2, 2, [[0, 0, 0]]), 1e6);
    assert.equal(small.data.length, 16);

    // 512x512 = 1MB 输出，必然触发 memory.grow，旧视图会被 detach。
    // 如果实现里缓存了 memory.buffer，这一步会读到错误数据或直接抛错。
    const before = inst.exports.memory.buffer.byteLength;
    const big = NormalMapDecoder.decodeWith(inst, makeTga(512, 512, [[10, 20, 30]]), 1e6);
    const after = inst.exports.memory.buffer.byteLength;

    // 断言增长确实发生了：否则这条测试就没覆盖到它声称要覆盖的场景
    assert.ok(after > before, '本次解码应触发内存增长（' + before + ' -> ' + after + '），场景未生效');

    assert.equal(big.width, 512);
    assert.equal(big.height, 512);
    assert.equal(big.data.length, 512 * 512 * 4);
    assert.deepEqual([...big.data.slice(0, 4)], [30, 20, 10, 255], 'BGR(10,20,30) 应为 RGBA(30,20,10)');

    // 再回到小图，确认多次增长后仍能正确解码
    const again = NormalMapDecoder.decodeWith(inst, makeTga(2, 2, [[0, 0, 255]]), 1e6);
    assert.deepEqual([...again.data.slice(0, 4)], [255, 0, 0, 255]);
});

test('wasm:像素数超过上限时拒绝', async () => {
    const inst = await getInstance();
    const tga = makeTga(4, 4, [[0, 0, 0]]);   // 16 像素
    assert.throws(() => NormalMapDecoder.decodeWith(inst, tga, 15), /解码失败/);
    assert.doesNotThrow(() => NormalMapDecoder.decodeWith(inst, tga, 16));
});

test('wasm:垃圾输入抛错而不是返回空数据', async () => {
    const inst = await getInstance();
    assert.throws(() => NormalMapDecoder.decodeWith(inst, new Uint8Array(0), 100), /解码失败/);
    assert.throws(() => NormalMapDecoder.decodeWith(inst, new Uint8Array([1, 2, 3, 4, 5]), 100), /解码失败/);
    assert.throws(() => NormalMapDecoder.decodeWith(inst, new Uint8Array(18), 100), /解码失败/);
});

/* ======================================================================
   DDS
   ====================================================================== */

/** 按小端写一个 u32 到数组末尾 */
function pushU32(arr, v) {
    arr.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
}

/**
 * 构造 128 字节 DDS 头（不含 DX10 扩展）。
 * @param {number} width
 * @param {number} height
 * @param {number} flags dwFlags
 * @param {number} pitch pitchOrLinearSize
 * @param {number[]} pf 32 字节 pixel format
 */
function ddsHeader(width, height, flags, pitch, pf) {
    const v = [0x44, 0x44, 0x53, 0x20];      // "DDS "
    pushU32(v, 124);                          // dwSize
    pushU32(v, flags);
    pushU32(v, height);
    pushU32(v, width);
    pushU32(v, pitch);
    pushU32(v, 0);                            // depth
    pushU32(v, 1);                            // mipMapCount
    for (let i = 0; i < 11; i++) pushU32(v, 0); // reserved
    v.push(...pf);
    pushU32(v, 0x1000);                       // caps = TEXTURE
    for (let i = 0; i < 4; i++) pushU32(v, 0);
    assert.equal(v.length, 128, 'DDS 头必须正好 128 字节');
    return v;
}

/** 未压缩 A8R8G8B8 的 pixel format（内存里是 B,G,R,A） */
function pfA8R8G8B8() {
    const v = [];
    pushU32(v, 32);         // size
    pushU32(v, 0x41);       // RGB | ALPHAPIXELS
    pushU32(v, 0);          // fourCC
    pushU32(v, 32);         // bit count
    pushU32(v, 0x00FF0000); // R mask
    pushU32(v, 0x0000FF00); // G mask
    pushU32(v, 0x000000FF); // B mask
    pushU32(v, 0xFF000000); // A mask
    return v;
}

/** 带 FourCC 的 pixel format（DXT1 / ATI2 等） */
function pfFourCC(code) {
    const v = [];
    pushU32(v, 32);
    pushU32(v, 0x4);        // DDPF_FOURCC
    for (const ch of code) v.push(ch.charCodeAt(0));
    pushU32(v, 0);          // bit count
    for (let i = 0; i < 4; i++) pushU32(v, 0);
    return v;
}

test('wasm:解码未压缩 DDS，BGR 正确转成 RGBA', async () => {
    const inst = await getInstance();
    const file = new Uint8Array([
        ...ddsHeader(2, 2, 0x1007, 8, pfA8R8G8B8()),
        // 内存顺序 B,G,R,A
        10, 20, 30, 200, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 15,
    ]);

    const out = NormalMapDecoder.decodeWith(inst, file, 100, 'dds');
    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
    assert.deepEqual([...out.data.slice(0, 4)], [30, 20, 10, 200], 'B,G,R,A 应转成 R,G,B,A');
    assert.deepEqual([...out.data.slice(4, 8)], [3, 2, 1, 4]);
});

test('wasm:解码 BC1 纯色块', async () => {
    const inst = await getInstance();
    const file = new Uint8Array([
        ...ddsHeader(4, 4, 0x81007, 8, pfFourCC('DXT1')),
        // 两个端点都是 RGB565 纯红 0xF800，索引全 0
        0x00, 0xF8, 0x00, 0xF8, 0, 0, 0, 0,
    ]);

    const out = NormalMapDecoder.decodeWith(inst, file, 100, 'dds');
    assert.equal(out.data.length, 4 * 4 * 4);
    assert.deepEqual([...out.data.slice(0, 4)], [255, 0, 0, 255]);
    assert.deepEqual([...out.data.slice(60, 64)], [255, 0, 0, 255], '块内 16 像素应一致');
});

test('wasm:解码 BC5 双通道', async () => {
    const inst = await getInstance();
    const file = new Uint8Array([
        ...ddsHeader(4, 4, 0x81007, 16, pfFourCC('ATI2')),
        10, 20, 0, 0, 0, 0, 0, 0,   // R 通道：alpha0=10
        30, 40, 0, 0, 0, 0, 0, 0,   // G 通道：alpha0=30
    ]);

    const out = NormalMapDecoder.decodeWith(inst, file, 100, 'dds');
    assert.deepEqual([...out.data.slice(0, 4)], [10, 30, 0, 255],
        'BC5 只有两个通道，B 为 0、A 为 255');
});

test('wasm:块数据不足时抛错而不是崩溃', async () => {
    const inst = await getInstance();
    // 头声明 4x4，BC1 需要 8 字节块，只给 4 字节
    const file = new Uint8Array([
        ...ddsHeader(4, 4, 0x81007, 8, pfFourCC('DXT1')),
        0, 0, 0, 0,
    ]);
    assert.throws(() => NormalMapDecoder.decodeWith(inst, file, 100, 'dds'), /解码失败/);
});

test('wasm:未知格式标识直接拒绝', async () => {
    const inst = await getInstance();
    assert.throws(
        () => NormalMapDecoder.decodeWith(inst, new Uint8Array(16), 100, 'png'),
        /不支持的格式/
    );
});

test('wasm:同一实例连续解码 TGA 与 DDS', async () => {
    const inst = await getInstance();
    // 两种格式共用一个模块，输出缓冲是静态变量，连续调用不能互相干扰
    const tga = NormalMapDecoder.decodeWith(inst, makeTga(2, 2, [[0, 0, 255]]), 100, 'tga');
    assert.deepEqual([...tga.data.slice(0, 4)], [255, 0, 0, 255]);

    const dds = NormalMapDecoder.decodeWith(inst, new Uint8Array([
        ...ddsHeader(4, 4, 0x81007, 8, pfFourCC('DXT1')),
        0x00, 0xF8, 0x00, 0xF8, 0, 0, 0, 0,
    ]), 100, 'dds');
    assert.deepEqual([...dds.data.slice(0, 4)], [255, 0, 0, 255]);

    const tga2 = NormalMapDecoder.decodeWith(inst, makeTga(2, 2, [[0, 255, 0]]), 100, 'tga');
    assert.deepEqual([...tga2.data.slice(0, 4)], [0, 255, 0, 255], '切回 TGA 仍应正确');
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

    const b64 = sandbox.self.NormalMapDecoderWasmBase64;
    assert.equal(typeof b64, 'string');
    assert.ok(b64.length > 0, 'base64 数据不应为空');

    const decoded = Buffer.from(b64, 'base64');
    assert.equal(decoded.length, binary.length, '长度应一致');
    assert.ok(decoded.equals(binary), 'base64 解出的字节应与 .wasm 完全相同');

    // 内联版必须能被实例化，否则 file:// 兜底就是死路
    const inst = await NormalMapDecoder.instantiate(new Uint8Array(decoded));
    const out = NormalMapDecoder.decodeWith(inst, makeTga(2, 2, [[0, 0, 255]]), 100);
    assert.deepEqual([...out.data.slice(0, 4)], [255, 0, 0, 255]);
});
