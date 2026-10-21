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
    function mapRows(src, dst, width, startRow, endRow) {
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
    function extractChannelRows(src, dst, width, startRow, endRow, options) {
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
