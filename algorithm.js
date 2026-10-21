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

    global.NormalMapChannel = {
        MAX_PIXELS: MAX_PIXELS,
        mapRows: mapRows,
        processChannels: processChannels,
        inspectChannels: inspectChannels
    };
})(typeof self !== 'undefined' ? self : this);
