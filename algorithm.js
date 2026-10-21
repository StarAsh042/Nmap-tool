/*!
 * algorithm.js — 法线贴图通道映射算法层
 *
 * 经典脚本（非 ES Module），通过 window.NormalMapChannel 暴露全局命名空间，
 * 供主线程（script.js）与 Worker（worker.js）共用，避免算法出现两份实现。
 *
 * 本文件不依赖 DOM、不产生副作用、不发起任何网络请求。
 */
(function (global) {
    'use strict';

    /**
     * 单张图片允许处理的最大像素总量。
     *
     * 取 33554432（约 3355 万像素，≈ 8192 × 4096）：
     * - 足以覆盖常见的 4K / 8K 贴图；
     * - 把单个 ImageData 的内存占用限制在约 128MB（w * h * 4 字节），
     *   避免源缓冲与结果缓冲同时存在时把标签页拖垮。
     */
    var MAX_PIXELS = 33554432;

    /**
     * 逐字节版本的通道映射，是 mapRows 的参考实现与降级路径。
     *
     * 保留这份实现有两个理由：
     *   1. 缓冲不满足字级快路径的前提（小端序、4 字节对齐）时，由它兜底；
     *   2. 它是 mapRows 的语义基准——任何快路径都必须与它逐字节相同。
     * 因此本函数不得为「优化」而修改循环结构。
     *
     * 对 [startRow, endRow) 行区间执行通道映射，结果写入 dst。
     *
     * 映射规则（与 README 保持一致，禁止为「优化」而合并或跳过）：
     *   dst.R = src.A      透明通道拷贝到红通道
     *   dst.G = 255 - src.G  绿色通道黑白翻转
     *   dst.B = src.R      红通道拷贝到蓝通道（原蓝通道被丢弃）
     *   dst.A = 255        透明通道置为不透明
     *
     * 注意：alpha 不做归一化，取原始值；当输入不含透明通道时
     * 浏览器提供的一切 alpha 均为 255，红通道会被整体置为 255。
     *
     * @param {Uint8ClampedArray} src 源像素（RGBA，长度为 width * height * 4）
     * @param {Uint8ClampedArray} dst 目标像素（与 src 等长，可复用同一缓冲之外的空间）
     * @param {number} width 图片宽度（像素）
     * @param {number} startRow 起始行（含）
     * @param {number} endRow 结束行（不含）
     * @returns {number} 实际处理到的结束行
     */
    function mapRowsBytes(src, dst, width, startRow, endRow) {
        for (var y = startRow; y < endRow; y++) {
            var base = y * width * 4;
            for (var x = 0; x < width; x++) {
                var i = base + x * 4;
                var r = src[i];
                var g = src[i + 1];
                var a = src[i + 3];
                dst[i] = a;
                dst[i + 1] = 255 - g;
                dst[i + 2] = r;
                dst[i + 3] = 255;
            }
        }
        return endRow;
    }

    /**
     * 本机字节序是否为小端。
     *
     * 字级路径依赖 RGBA 在 32 位字内的排列顺序（小端下 R 在最低字节）。
     * 大端机器上同一份位运算会得到相反的通道排列，因此必须先探测再决定走哪条路。
     * 主流平台全是小端，这段代码实际上永远走快路径；但"实际上"不等于"保证"。
     */
    var LITTLE_ENDIAN = (function () {
        var probe = new Uint32Array(1);
        probe[0] = 1;
        return new Uint8Array(probe.buffer)[0] === 1;
    })();

    /**
     * 判断两个缓冲能否安全地以 Uint32Array 视图访问。
     *
     * 四个前提缺一不可，任何一条不满足都必须退回逐字节实现：
     *   1. 小端序——否则通道位序是反的；
     *   2. 长度是 4 的倍数——否则最后会残留不足一个像素的尾巴；
     *   3. byteOffset 是 4 的倍数——否则 Uint32Array 构造直接抛 RangeError；
     *   4. 长度足以覆盖 [0, endRow) 行——否则越界读出的 undefined 在两条路径上
     *      会被转换成不同的字节（逐字节路径写 0，字级路径按位运算算出别的值），
     *      这不会崩溃，但会悄悄产生不一致的结果。
     *
     * @param {Uint8ClampedArray} src
     * @param {Uint8ClampedArray} dst
     * @param {number} width
     * @param {number} endRow
     * @returns {boolean}
     */
    function canUseWordView(src, dst, width, endRow) {
        if (!LITTLE_ENDIAN) return false;
        if (!src || !dst || !src.buffer || !dst.buffer) return false;
        if ((src.length & 3) !== 0 || (dst.length & 3) !== 0) return false;
        if ((src.byteOffset & 3) !== 0 || (dst.byteOffset & 3) !== 0) return false;
        var needed = endRow * width * 4;
        return src.length >= needed && dst.length >= needed;
    }

    /**
     * 字级快路径：一次读出一个像素（32 位字），一次写回。
     *
     * 与逐字节版本的区别只在"搬运方式"：逐字节版本每个像素要做 4 次读、4 次写，
     * 字级版本各做 1 次。计算结果完全相同——赋值给 Uint32Array 时引擎会按
     * ToUint32 语义截断，所以负的 int32（例如 a=255 时的 a<<24）会正确落成
     * 0xFF000000，不需要额外的无符号转换。
     *
     * 调用前必须已通过 canUseWordView 的检查。
     *
     * @param {Uint8ClampedArray} src
     * @param {Uint8ClampedArray} dst
     * @param {number} width
     * @param {number} startRow
     * @param {number} endRow
     * @returns {number} 实际处理到的结束行
     */
    function mapRowsWords(src, dst, width, startRow, endRow) {
        var s = new Uint32Array(src.buffer, src.byteOffset, src.length >>> 2);
        var d = new Uint32Array(dst.buffer, dst.byteOffset, dst.length >>> 2);
        for (var y = startRow; y < endRow; y++) {
            var base = y * width;
            for (var x = 0; x < width; x++) {
                var i = base + x;
                var w = s[i];
                var r = w & 255;              // 字节 0
                var g = (w >>> 8) & 255;      // 字节 1
                var a = w >>> 24;             // 字节 3
                // 小端下 32 位字的字节布局是 [R, G, B, A]（R 在最低字节），
                // 所以目标字的排列是：最低字节放 A、次低放 255-G、再次放 R、最高放 255。
                d[i] = (255 << 24) | (r << 16) | ((255 - g) << 8) | a;
            }
        }
        return endRow;
    }

    /**
     * 对 [startRow, endRow) 行区间执行通道映射，结果写入 dst。
     *
     * 满足字级前提时走快路径，否则退回逐字节实现，两者结果逐字节相同。
     * 调用方（worker.js / script.js）无需感知走了哪条路。
     *
     * @param {Uint8ClampedArray} src
     * @param {Uint8ClampedArray} dst
     * @param {number} width
     * @param {number} startRow
     * @param {number} endRow
     * @returns {number} 实际处理到的结束行
     */
    function mapRows(src, dst, width, startRow, endRow) {
        if (canUseWordView(src, dst, width, endRow)) {
            return mapRowsWords(src, dst, width, startRow, endRow);
        }
        return mapRowsBytes(src, dst, width, startRow, endRow);
    }

    /**
     * 整图通道映射（同步执行）。
     *
     * 供一次性处理完整图片的场景使用；需要分片让出主线程时，
     * 请直接按行区间调用 mapRows。
     *
     * @param {Uint8ClampedArray} src
     * @param {Uint8ClampedArray} dst
     * @param {number} width
     * @param {number} height
     * @param {function(number, number)=} onProgress 每处理完一批行调用一次 (rowsDone, height)
     * @returns {number} 处理的总行数
     */
    function processChannels(src, dst, width, height, onProgress) {
        var CHUNK_ROWS = 256;
        for (var row = 0; row < height; row += CHUNK_ROWS) {
            var end = Math.min(height, row + CHUNK_ROWS);
            mapRows(src, dst, width, row, end);
            if (typeof onProgress === 'function') onProgress(end, height);
        }
        return height;
    }

    /**
     * 判定图片是否携带透明通道。
     *
     * 采用「固定采样上限 + 等距步进」：无论图片多大，最多抽样 MAX_SAMPLES 个像素，
     * 且抽样点均匀分布在全图范围内，避免原先按大跨步跳采导致漏判半透明像素。
     *
     * @param {Uint8ClampedArray} src 像素数据（RGBA）
     * @param {number} width
     * @param {number} height
     * @returns {{hasAlpha: boolean, channels: 'RGB'|'RGBA', sampled: number, stride: number}}
     */
    function inspectChannels(src, width, height) {
        var total = width * height;
        if (!total || !src || src.length < total * 4) {
            return { hasAlpha: false, channels: 'RGB', sampled: 0, stride: 0 };
        }
        var MAX_SAMPLES = 20000;
        var stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
        var sampled = 0;
        var hasAlpha = false;
        for (var pixel = 0; pixel < total; pixel += stride) {
            sampled++;
            if (src[pixel * 4 + 3] !== 255) {
                hasAlpha = true;
                break;
            }
        }
        return {
            hasAlpha: hasAlpha,
            channels: hasAlpha ? 'RGBA' : 'RGB',
            sampled: sampled,
            stride: stride
        };
    }

    /**
     * 可预览的通道键，顺序与 RGBA 字节偏移一一对应。
     *
     * 导出给 UI 层用于生成切换按钮，避免界面里散落硬编码的 'R' / 'G' 字符串。
     */
    var CHANNEL_KEYS = ['R', 'G', 'B', 'A'];

    /** 通道键 → 字节偏移 */
    var CHANNEL_OFFSET = { R: 0, G: 1, B: 2, A: 3 };

    /** 合法的显示模式 */
    var CHANNEL_MODES = ['gray', 'rgb'];

    /**
     * 校验并归一化单通道预览的参数。
     *
     * 非法输入一律抛错而非静默降级：预览工具给出错误图像比直接报错更糟，
     * 用户会据此判断通道内容，静默出错等于提供假信息。
     *
     * 只有 undefined 表示「未提供」并回落到默认值 R + gray；
     * 显式的 null 视为非法值并抛错，因为 null 多半来自上游的取值失误，
     * 静默当作默认值会把 bug 藏进最终画面。
     *
     * 返回值同时带上 channel 字段，因此本函数对自身的输出是幂等的——
     * extractChannel 可以把归一化结果直接回传给 extractChannelRows，
     * 分片循环里无需每片重建对象。
     *
     * @param {{channel?: string, mode?: string}} [options]
     * @returns {{channel: string, key: string, mode: string, offset: number}}
     */
    function normalizeChannelOptions(options) {
        var opts = options || {};
        var key = opts.channel === undefined ? 'R' : opts.channel;
        var mode = opts.mode === undefined ? 'gray' : opts.mode;

        if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(CHANNEL_OFFSET, key)) {
            throw new Error(
                'channel 必须是 R / G / B / A 之一，收到：' + String(key)
            );
        }
        if (CHANNEL_MODES.indexOf(mode) < 0) {
            throw new Error(
                'mode 必须是 gray / rgb 之一，收到：' + String(mode)
            );
        }

        return { channel: key, key: key, mode: mode, offset: CHANNEL_OFFSET[key] };
    }

    /**
     * 逐字节版本的单通道提取，是 extractChannelRows 的参考实现与降级路径。
     *
     * 与 mapRowsBytes 同理：不可为「优化」改动循环结构，快路径必须与它逐字节相同。
     *
     * 对 [startRow, endRow) 行区间提取单个通道，结果写入 dst。
     *
     * 显示模式：
     *   gray  通道值同时写入 R/G/B，输出不透明（A=255）
     *   rgb   R/G/B 通道涂成对应原色（其余两色置 0），A 通道无对应原色，退化为 gray
     *
     * 两种模式都强制 A=255。原因是预览画布衬在棋盘格底色上，
     * 若保留原 alpha，半透明区域的通道灰度会被底色混合，读数不再等于真实通道值。
     *
     * @param {Uint8ClampedArray} src 源像素（RGBA）
     * @param {Uint8ClampedArray} dst 目标像素（与 src 等长）
     * @param {number} width 图片宽度（像素）
     * @param {number} startRow 起始行（含）
     * @param {number} endRow 结束行（不含）
     * @param {{channel?: string, mode?: string}} [options] 通道与显示模式，缺省为 R + gray
     * @returns {number} 实际处理到的结束行
     */
    function extractChannelRowsBytes(src, dst, width, startRow, endRow, options) {
        var opts = normalizeChannelOptions(options);
        var offset = opts.offset;
        var tinted = opts.mode === 'rgb' && opts.key !== 'A';

        for (var y = startRow; y < endRow; y++) {
            var base = y * width * 4;
            for (var x = 0; x < width; x++) {
                var i = base + x * 4;
                var v = src[i + offset];
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
        return endRow;
    }

    /**
     * 字级快路径：单通道提取。
     *
     * 与逐字节版本的差别有两处：搬运次数从 4 读 4 写降到 1 读 1 写；
     * 以及把「是否着色」的判断挪到循环之外——逐字节版本每个像素都要判一次
     * tinted，这里拆成两条各自无分支的循环。
     *
     * 着色模式下只点亮一个颜色通道，因此只需把通道值移到对应字节：
     * R 在字节 0、G 在字节 1、B 在字节 2。A 没有对应原色，由调用方按灰度处理。
     *
     * 调用前必须已通过 canUseWordView 的检查。
     *
     * @param {Uint8ClampedArray} src
     * @param {Uint8ClampedArray} dst
     * @param {number} width
     * @param {number} startRow
     * @param {number} endRow
     * @param {number} offset 通道字节偏移（R=0 G=1 B=2 A=3）
     * @param {boolean} tinted 是否按原色着色
     * @returns {number} 实际处理到的结束行
     */
    function extractChannelRowsWords(src, dst, width, startRow, endRow, offset, tinted) {
        var s = new Uint32Array(src.buffer, src.byteOffset, src.length >>> 2);
        var d = new Uint32Array(dst.buffer, dst.byteOffset, dst.length >>> 2);
        var shift = offset * 8;
        var y, base, x, i, v;

        if (!tinted) {
            // 灰度：通道值同时写入 R/G/B 三个字节，A 恒为 255
            for (y = startRow; y < endRow; y++) {
                base = y * width;
                for (x = 0; x < width; x++) {
                    i = base + x;
                    v = (s[i] >>> shift) & 255;
                    d[i] = (255 << 24) | (v << 16) | (v << 8) | v;
                }
            }
            return endRow;
        }

        // 着色：只把通道值放进它自己的字节，其余两色置 0
        for (y = startRow; y < endRow; y++) {
            base = y * width;
            for (x = 0; x < width; x++) {
                i = base + x;
                v = (s[i] >>> shift) & 255;
                d[i] = (255 << 24) | (v << shift);
            }
        }
        return endRow;
    }

    /**
     * 对 [startRow, endRow) 行区间提取单个通道，结果写入 dst。
     *
     * 满足字级前提时走快路径，否则退回逐字节实现，两者结果逐字节相同。
     * 参数校验在任何一条路径之前完成：非法 options 一律抛错，
     * 不会因为走了快路径就跳过校验。
     *
     * @param {Uint8ClampedArray} src 源像素（RGBA）
     * @param {Uint8ClampedArray} dst 目标像素（与 src 等长）
     * @param {number} width 图片宽度（像素）
     * @param {number} startRow 起始行（含）
     * @param {number} endRow 结束行（不含）
     * @param {{channel?: string, mode?: string}} [options] 通道与显示模式，缺省为 R + gray
     * @returns {number} 实际处理到的结束行
     */
    function extractChannelRows(src, dst, width, startRow, endRow, options) {
        if (canUseWordView(src, dst, width, endRow)) {
            var opts = normalizeChannelOptions(options);
            var tinted = opts.mode === 'rgb' && opts.key !== 'A';
            return extractChannelRowsWords(src, dst, width, startRow, endRow, opts.offset, tinted);
        }
        return extractChannelRowsBytes(src, dst, width, startRow, endRow, options);
    }

    /**
     * 整图单通道提取（同步执行）。
     *
     * 与 processChannels 保持同样的分片约定：内部按 CHUNK_ROWS 让出调用栈，
     * 并通过 onProgress 汇报进度，便于主线程在必要时插入取消判断。
     *
     * @param {Uint8ClampedArray} src
     * @param {Uint8ClampedArray} dst
     * @param {number} width
     * @param {number} height
     * @param {{channel?: string, mode?: string}} [options]
     * @param {function(number, number)=} [onProgress]
     * @returns {number} 处理的总行数
     */
    function extractChannel(src, dst, width, height, options, onProgress) {
        var CHUNK_ROWS = 256;
        var opts = normalizeChannelOptions(options);
        for (var row = 0; row < height; row += CHUNK_ROWS) {
            var end = Math.min(height, row + CHUNK_ROWS);
            extractChannelRows(src, dst, width, row, end, opts);
            if (typeof onProgress === 'function') onProgress(end, height);
        }
        return height;
    }

    global.NormalMapChannel = {
        MAX_PIXELS: MAX_PIXELS,
        CHANNEL_KEYS: CHANNEL_KEYS,
        mapRows: mapRows,
        processChannels: processChannels,
        inspectChannels: inspectChannels,
        extractChannelRows: extractChannelRows,
        extractChannel: extractChannel
    };
})(typeof self !== 'undefined' ? self : this);
