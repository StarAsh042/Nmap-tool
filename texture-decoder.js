/*!
 * texture-decoder.js — 纹理解码器的 JS 加载层（经典脚本，无依赖）
 *
 * 负责三件事：
 *   1. 加载并实例化 vendor/texture-decoder.wasm（http 下走 fetch，file:// 下走内联 base64）
 *   2. 处理 JS 与 wasm 之间的数据搬运
 *   3. 把裸像素包装成 { width, height, data } 交给上层
 *
 * 暴露 global.NormalMapDecoder：
 *   load()                             加载并缓存 wasm 实例
 *   instantiate(bytes)                 从字节实例化（不缓存）
 *   decodeWith(inst, bytes, maxPx, fmt) 在给定实例上解码
 *   decodeBytes(bytes, maxPx, fmt)     从字节解码，内部自动加载
 *   decode(file, maxPx, fmt)           从 File 解码，内部自动加载
 *   isSupported()                      当前环境是否具备 wasm 能力
 *
 * fmt 取值 'tga' / 'dds'，默认 'tga'。两种格式共用一个 wasm 模块，
 * 只是调用的导出函数不同——合并比拆成两个模块省一套加载逻辑，
 * 而体积只多了 DDS 那部分（用户只有真的导入对应格式才会加载这个模块）。
 *
 * ⚠ 最容易踩的坑：wasm 里任何一次内存分配都可能触发 memory.grow，
 * 增长会让 JS 已持有的 ArrayBuffer 视图全部失效（detached）。所以每次
 * 调用 wasm 之后都必须重新取 memory.buffer，不能复用之前的视图。
 */
(function (global) {
    'use strict';

    var WASM_URL = 'vendor/texture-decoder.wasm';
    var B64_URL = 'vendor/texture-decoder-b64.js';

    /** 格式 → wasm 导出函数名。新增格式时只改这里。 */
    var EXPORTS = {
        tga: 'nm_decode_tga',
        dds: 'nm_decode_dds'
    };

    /** 已实例化的模块，加载成功后就一直复用 */
    var instance = null;
    /** 正在进行的加载，避免并发重复加载 */
    var pending = null;

    function isSupported() {
        return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
    }

    /** 动态注入一个经典脚本，用于 file:// 下加载 base64 内联版 */
    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var el = document.createElement('script');
            el.src = src;
            el.onload = function () { resolve(); };
            el.onerror = function () { reject(new Error('无法加载 ' + src)); };
            document.head.appendChild(el);
        });
    }

    function base64ToBytes(b64) {
        var binary = global.atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /** http(s) 下优先取二进制：比 base64 小三分之一，也不用多一次解码 */
    function fetchWasm() {
        if (typeof global.fetch !== 'function') {
            return Promise.reject(new Error('当前环境不支持 fetch'));
        }
        return global.fetch(WASM_URL).then(function (res) {
            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }
            return res.arrayBuffer();
        }).then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    /** file:// 下 fetch 会被拦截，退回内联 base64 */
    function inlineWasm() {
        return loadScript(B64_URL).then(function () {
            var b64 = global.NormalMapDecoderWasmBase64;
            if (typeof b64 !== 'string' || !b64) {
                throw new Error('内联 wasm 数据缺失');
            }
            return base64ToBytes(b64);
        });
    }

    function instantiate(bytes) {
        return WebAssembly.instantiate(bytes, {}).then(function (result) {
            // 老实现返回 {instance, module}，新实现返回 instance
            return result.instance || result;
        });
    }

    function load() {
        if (instance) {
            return Promise.resolve(instance);
        }
        if (pending) {
            return pending;
        }
        pending = fetchWasm()
            .catch(function () { return inlineWasm(); })
            .then(instantiate)
            .then(function (inst) {
                instance = inst;
                pending = null;
                return inst;
            })
            .catch(function (err) {
                pending = null;
                throw err;
            });
        return pending;
    }

    /**
     * 在给定实例上解码。
     *
     * @param {WebAssembly.Instance} inst
     * @param {Uint8Array} input 文件字节
     * @param {number} maxPixels 像素总量上限，超限直接拒绝
     * @param {string} [format] 'tga' 或 'dds'，默认 'tga'
     * @returns {{width: number, height: number, data: Uint8ClampedArray}}
     */
    function decodeWith(inst, input, maxPixels, format) {
        var kind = format || 'tga';
        var exportName = EXPORTS[kind];
        if (!exportName) {
            throw new Error('不支持的格式：' + kind);
        }

        var ex = inst.exports;
        var mem = ex.memory;

        if (typeof ex.nm_alloc !== 'function' || typeof ex[exportName] !== 'function') {
            throw new Error('wasm 模块导出的函数不完整（缺少 ' + exportName + '）');
        }

        // 不能从地址 0 开始写：wasm 的静态数据段就在低地址
        var inPtr = ex.nm_alloc(input.length);
        if (!inPtr) {
            throw new Error('wasm 内存分配失败');
        }

        try {
            // nm_alloc 可能已触发内存增长，这里重新取 buffer
            var buf = mem.buffer;
            if (inPtr + input.length > buf.byteLength) {
                throw new Error('wasm 内存不足');
            }
            new Uint8Array(buf, inPtr, input.length).set(input);

            var headPtr = ex[exportName](inPtr, input.length, maxPixels >>> 0);

            // 解码过程中分配输出缓冲，可能再次触发增长，旧视图已失效
            var buf2 = mem.buffer;
            var head = new Uint32Array(buf2, headPtr, 4);
            var dataPtr = head[0];
            var byteLen = head[1];
            var width = head[2];
            var height = head[3];

            if (!dataPtr || !byteLen || !width || !height) {
                throw new Error(
                    kind.toUpperCase() + ' 解码失败：文件可能已损坏、格式不受支持，或不是 ' + kind.toUpperCase() + ' 文件'
                );
            }

            // 像素还在 wasm 线性内存里，拷一份出来再释放输入缓冲
            var pixels = new Uint8ClampedArray(buf2, dataPtr, byteLen).slice();
            return { width: width, height: height, data: pixels };
        } finally {
            ex.nm_free(inPtr, input.length);
        }
    }

    function decodeBytes(bytes, maxPixels, format) {
        return load().then(function (inst) {
            return decodeWith(inst, bytes, maxPixels, format);
        });
    }

    function decode(file, maxPixels, format) {
        if (!file || typeof file.arrayBuffer !== 'function') {
            return Promise.reject(new Error('文件对象不支持读取'));
        }
        return load().then(function (inst) {
            return file.arrayBuffer().then(function (buf) {
                return decodeWith(inst, new Uint8Array(buf), maxPixels, format);
            });
        });
    }

    global.NormalMapDecoder = {
        isSupported: isSupported,
        load: load,
        instantiate: instantiate,
        decodeWith: decodeWith,
        decodeBytes: decodeBytes,
        decode: decode
    };
})(typeof self !== 'undefined' ? self : this);
