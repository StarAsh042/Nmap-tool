/*!
 * worker.js — 通道映射执行层（经典 Worker，无依赖）
 *
 * 使用 importScripts 复用 algorithm.js，保证算法只有一份实现。
 * 主线程在 file:// 等无法构造 Worker 的环境下会自动降级为主线程分片处理，
 * 因此本文件不可用时不影响功能，只是不再享受后台执行。
 *
 * 消息协议
 *   主线程 → Worker  { type: 'process', jobId, width, height, buffer }
 *                    { type: 'cancel',  jobId }
 *   Worker → 主线程  { type: 'progress', jobId, rows, height }
 *                    { type: 'done',     jobId, width, height, buffer }   // buffer 以 Transferable 回传
 *                    { type: 'cancelled', jobId }
 *                    { type: 'error',    jobId, message }
 */
'use strict';

importScripts('algorithm.js');

var Algo = self.NormalMapChannel;

/* 单次连续计算的时间预算（毫秒）。每用满一个预算就让出事件循环，
   以便及时响应主线程发来的取消消息，并持续上报进度。 */
var CHUNK_BUDGET_MS = 8;

/* 内层循环一次处理的行数，控制单次 mapRows 调用的粒度。 */
var ROWS_PER_CALL = 32;

/* 同一时刻只允许一个任务在跑：{ jobId, cancelled } */
var running = null;

self.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type === 'cancel') {
        if (running && running.jobId === data.jobId) {
            running.cancelled = true;
        }
        return;
    }
    if (data.type === 'process') {
        start(data);
    }
});

function start(data) {
    var jobId = data.jobId;
    var width = data.width | 0;
    var height = data.height | 0;
    var src;
    var dst;
    var dstBuffer;

    try {
        // 同一 Worker 复用：新任务到来即作废旧任务
        if (running) {
            running.cancelled = true;
        }
        src = new Uint8ClampedArray(data.buffer);
        dstBuffer = new ArrayBuffer(src.length);
        dst = new Uint8ClampedArray(dstBuffer);
    } catch (err) {
        self.postMessage({ type: 'error', jobId: jobId, message: describeError(err) });
        return;
    }

    running = { jobId: jobId, cancelled: false };
    var row = 0;

    function step() {
        if (!running || running.jobId !== jobId) {
            return;
        }
        if (running.cancelled) {
            running = null;
            self.postMessage({ type: 'cancelled', jobId: jobId });
            return;
        }

        var frameStart = now();
        try {
            while (row < height && (now() - frameStart) < CHUNK_BUDGET_MS) {
                var end = Math.min(height, row + ROWS_PER_CALL);
                Algo.mapRows(src, dst, width, row, end);
                row = end;
            }
        } catch (err) {
            running = null;
            self.postMessage({ type: 'error', jobId: jobId, message: describeError(err) });
            return;
        }

        self.postMessage({ type: 'progress', jobId: jobId, rows: row, height: height });

        if (row < height) {
            setTimeout(step, 0);
        } else {
            running = null;
            self.postMessage(
                { type: 'done', jobId: jobId, width: width, height: height, buffer: dstBuffer },
                [dstBuffer]
            );
        }
    }

    step();
}

function now() {
    return (self.performance && typeof self.performance.now === 'function')
        ? self.performance.now()
        : Date.now();
}

function describeError(err) {
    if (!err) {
        return '未知错误';
    }
    return err.message ? String(err.message) : String(err);
}
