/*!
 * script.js — 交互与状态层
 *
 * 职责：
 *   - 显式状态机（idle / loading / ready / processing / done / error）
 *   - 任务令牌与取消，消除「处理中导入新图」造成的竞态
 *   - 执行层调度：Worker 优先，不可用时降级为主线程分片
 *   - 导入本地图片并绘制到原图画布
 *   - 进度与状态反馈
 *   - 导出修复结果为 PNG
 *
 * 本版本引入 Worker 执行层与任务取消机制；file:// 等无法构造 Worker 的
 * 环境下自动降级为主线程分片处理。
 *
 * 算法实现位于 algorithm.js，本文件不重复实现通道映射。
 */
(function () {
    'use strict';

    var Algo = window.NormalMapChannel;

    /* 主线程分片参数 */
    var MAIN_BLOCK_ROWS = 16;
    var MAIN_BUDGET_MS = 10;

    /* 进度文案的最小更新间隔，避免高频刷新 */
    var LABEL_THROTTLE_MS = 120;

    var STATE_META = {
        idle: { level: 'idle', text: '等待导入' },
        loading: { level: 'busy', text: '读取中' },
        ready: { level: 'ready', text: '已就绪' },
        processing: { level: 'busy', text: '处理中' },
        done: { level: 'done', text: '已完成' },
        error: { level: 'error', text: '需要处理' }
    };

    /* ---------------- 入口 ---------------- */
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var el = collectElements();
        if (!el.fixBtn || !el.originalCanvas || !el.processedCanvas) {
            return;
        }

        /* ---------------- 运行时状态 ---------------- */
        var appState = 'idle';
        var sourceInfo = null;      // { name, width, height }
        var lastResult = null;      // { blob, name, width, height }
        var jobSeq = 0;
        var activeJob = null;
        var worker = null;
        var workerAvailable = typeof Worker === 'function';

        var ctxOriginal = el.originalCanvas.getContext('2d', { willReadFrequently: true });
        var ctxProcessed = el.processedCanvas.getContext('2d');

        if (!Algo) {
            if (el.statusMessage) {
                el.statusMessage.className = 'status-message is-error';
                el.statusMessage.textContent = '算法模块 algorithm.js 未能加载，页面无法工作。请确认该文件与 index.html 位于同一目录。';
            }
            el.fixBtn.disabled = true;
            return;
        }

        start();

        /* ====================================================================
           启动
           ==================================================================== */
        function start() {
            bindEvents();
            setState('idle');
            setStatus('info', '导入一张法线贴图后即可开始修复。');
            resetProgress();
            setWaiting(false);
            setLabel('等待处理');
            hideProcessed();
        }

        /* ====================================================================
           元素收集
           ==================================================================== */
        function collectElements() {
            return {
                dropZone: byId('dropZone'),
                fileInput: byId('fileInput'),
                fileName: byId('fileName'),

                fixBtn: byId('fixBtn'),
                downloadBtn: byId('downloadBtn'),

                originalCanvas: byId('originalCanvas'),
                processedCanvas: byId('processedCanvas'),
                originalEmpty: byId('originalEmpty'),
                fixedEmpty: byId('fixedEmpty'),
                originalRes: byId('originalRes'),
                fixedRes: byId('fixedRes'),

                progressTrack: byId('progressTrack'),
                progressFill: byId('progressFill'),
                progressLabel: byId('progressLabel'),
                statusMessage: byId('statusMessage'),

                statusPill: byId('statusPill'),
                statusPillText: byId('statusPillText')
            };
        }

        function byId(id) {
            return document.getElementById(id);
        }

        /* ====================================================================
           事件绑定
           ==================================================================== */
        function bindEvents() {
            if (el.fileInput) {
                el.fileInput.addEventListener('change', function () {
                    // 先复制再清空，允许重复选择同一个文件
                    var files = Array.prototype.slice.call(this.files || []);
                    this.value = '';
                    if (files.length) {
                        loadFile(files[0]);
                    }
                });
            }

            if (el.fixBtn) {
                el.fixBtn.addEventListener('click', startProcessing);
            }
            if (el.downloadBtn) {
                el.downloadBtn.addEventListener('click', handleDownload);
            }
        }

        /* ====================================================================
           状态与反馈
           ==================================================================== */
        function setState(next) {
            appState = next;
            var meta = STATE_META[next] || STATE_META.idle;
            if (el.statusPill) {
                el.statusPill.dataset.level = meta.level;
            }
            if (el.statusPillText) {
                el.statusPillText.textContent = meta.text;
            }
            syncControls();
        }

        function syncControls() {
            var busy = appState === 'loading' || appState === 'processing';
            if (el.fixBtn) {
                el.fixBtn.disabled = busy || !sourceInfo;
            }
            if (el.downloadBtn) {
                el.downloadBtn.disabled = appState !== 'done';
            }
            if (el.fileInput) {
                el.fileInput.disabled = busy;
            }
            if (el.dropZone) {
                el.dropZone.classList.toggle('is-busy', busy);
            }
        }

        function setStatus(level, message) {
            if (!el.statusMessage) {
                return;
            }
            el.statusMessage.className = 'status-message is-' + level;
            el.statusMessage.textContent = message;
            // 重新触发一次淡入，让状态变化可被察觉
            el.statusMessage.style.animation = 'none';
            void el.statusMessage.offsetWidth;
            el.statusMessage.style.animation = '';
        }

        function setLabel(text) {
            if (el.progressLabel) {
                el.progressLabel.textContent = text;
            }
        }

        function setProgress(pct) {
            var clamped = Math.max(0, Math.min(100, pct));
            if (el.progressFill) {
                el.progressFill.style.transform = 'scaleX(' + (clamped / 100) + ')';
            }
            if (el.progressTrack) {
                el.progressTrack.setAttribute('aria-valuenow', String(clamped));
                el.progressTrack.classList.toggle('is-complete', clamped >= 100);
            }
        }

        function resetProgress() {
            if (el.progressTrack) {
                el.progressTrack.classList.remove('is-complete');
                el.progressTrack.setAttribute('aria-valuenow', '0');
            }
            if (el.progressFill) {
                el.progressFill.style.transition = 'none';
                el.progressFill.style.transform = 'scaleX(0)';
                void el.progressFill.offsetWidth;
                el.progressFill.style.transition = '';
            }
        }

        function setWaiting(isWaiting) {
            if (el.progressTrack) {
                el.progressTrack.classList.toggle('is-indeterminate', isWaiting);
            }
        }

        function showCanvas(canvas, visible) {
            canvas.classList.toggle('is-visible', visible);
        }

        function hideProcessed() {
            showCanvas(el.processedCanvas, false);
            if (el.fixedEmpty) {
                el.fixedEmpty.hidden = false;
            }
        }

        /* ====================================================================
           文件导入
           ==================================================================== */
        function loadFile(file) {
            cancelActiveJob();
            clearResult();
            setState('loading');
            if (el.dropZone) {
                el.dropZone.classList.remove('has-error');
            }

            if (el.fileName) {
                el.fileName.textContent = (file.name || '未命名文件') + ' · ' + formatBytes(file.size);
            }
            if (el.originalRes) {
                el.originalRes.textContent = '';
            }
            if (el.fixedRes) {
                el.fixedRes.textContent = '';
            }
            showCanvas(el.originalCanvas, false);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = false;
            }
            setLabel('等待处理');
            resetProgress();
            setWaiting(false);
            setStatus('busy', '正在读取 ' + (file.name || '图片') + ' …');

            decodeImage(file).then(function (source) {
                applySource(source, file);
            }).catch(function (err) {
                failLoad('无法解码该图片（' + describeError(err) + '）。请确认文件是完整的 PNG / JPEG / WebP 等常见格式。');
            });
        }

        function decodeImage(file) {
            if (typeof createImageBitmap === 'function') {
                return createImageBitmap(file).catch(function () {
                    return decodeWithObjectURL(file);
                });
            }
            return decodeWithObjectURL(file);
        }

        function decodeWithObjectURL(file) {
            return new Promise(function (resolve, reject) {
                var url = URL.createObjectURL(file);
                var img = new Image();
                img.onload = function () {
                    URL.revokeObjectURL(url);
                    resolve(img);
                };
                img.onerror = function () {
                    URL.revokeObjectURL(url);
                    reject(new Error('图片解码失败'));
                };
                img.src = url;
            });
        }

        function applySource(source, file) {
            var w = source.width;
            var h = source.height;

            try {
                el.originalCanvas.width = w;
                el.originalCanvas.height = h;
                ctxOriginal.clearRect(0, 0, w, h);
                ctxOriginal.drawImage(source, 0, 0);
            } catch (err) {
                failLoad('无法绘制到画布：' + describeError(err) + '。图片可能超过浏览器画布上限。');
                return;
            }

            sourceInfo = {
                name: file.name || 'image',
                width: w,
                height: h
            };

            if (el.originalRes) {
                el.originalRes.textContent = formatSize(w, h);
            }
            showCanvas(el.originalCanvas, true);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = true;
            }
            setState('ready');
            setStatus('success', '已载入 ' + sourceInfo.name + '（' + formatSize(w, h) + '），可以开始修复。');
        }

        function failLoad(message) {
            sourceInfo = null;
            lastResult = null;
            if (el.dropZone) {
                el.dropZone.classList.add('has-error');
            }
            showCanvas(el.originalCanvas, false);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = false;
            }
            resetProgress();
            setWaiting(false);
            setLabel('等待处理');
            setState('error');
            setStatus('error', message);
        }

        /* ====================================================================
           处理流程
           ==================================================================== */
        function startProcessing() {
            if (appState === 'loading' || appState === 'processing') {
                return;
            }
            if (!sourceInfo) {
                setStatus('warning', '请先导入一张图片。');
                return;
            }

            var w = el.originalCanvas.width;
            var h = el.originalCanvas.height;
            if (!w || !h) {
                setStatus('error', '原图尺寸无效，请重新导入。');
                return;
            }

            cancelActiveJob();
            clearResult();

            var job = {
                id: ++jobSeq,
                width: w,
                height: h,
                rows: 0,
                reported: -1,
                labelTs: 0,
                startedAt: 0,
                cancelled: false,
                mode: null
            };
            activeJob = job;

            hideProcessed();
            setState('processing');
            resetProgress();
            setWaiting(true);
            setLabel('准备中…');
            setStatus('busy', '正在修复通道…（' + formatSize(w, h) + '）');

            job.startedAt = now();
            runJob(job);
        }

        function runJob(job) {
            var wk = getWorker();
            if (!wk) {
                runOnMainThread(job, null);
                return;
            }

            var imageData;
            try {
                imageData = ctxOriginal.getImageData(0, 0, job.width, job.height);
            } catch (err) {
                failJob(job, '无法读取原图像素：' + describeError(err) + '。图片可能超过浏览器的画布上限。');
                return;
            }

            job.mode = 'worker';
            try {
                wk.postMessage({
                    type: 'process',
                    jobId: job.id,
                    width: job.width,
                    height: job.height,
                    buffer: imageData.data.buffer
                }, [imageData.data.buffer]);
            } catch (err) {
                // 传输失败（例如实现不支持 Transferable）：销毁后台线程并降级
                workerAvailable = false;
                destroyWorker();
                job.mode = 'main';
                setStatus('busy', '已切换为主线程处理…');
                runOnMainThread(job, null);
            }
        }

        function runOnMainThread(job, imageData) {
            job.mode = 'main';
            job.rows = 0;
            job.reported = -1;

            var w = job.width;
            var h = job.height;
            var src;
            var dstData;
            try {
                src = (imageData && imageData.data && imageData.data.length)
                    ? imageData.data
                    : ctxOriginal.getImageData(0, 0, w, h).data;
                dstData = ctxProcessed.createImageData(w, h);
            } catch (err) {
                failJob(job, '无法创建像素缓冲区：' + describeError(err));
                return;
            }

            var dst = dstData.data;

            function frame() {
                if (job.cancelled || activeJob !== job) {
                    return;
                }
                var frameStart = now();
                try {
                    while (job.rows < h && (now() - frameStart) < MAIN_BUDGET_MS) {
                        var end = Math.min(h, job.rows + MAIN_BLOCK_ROWS);
                        Algo.mapRows(src, dst, w, job.rows, end);
                        job.rows = end;
                    }
                } catch (err) {
                    failJob(job, '处理过程中出错：' + describeError(err));
                    return;
                }
                reportProgress(job);
                if (job.rows < h) {
                    requestAnimationFrame(frame);
                } else {
                    finishJob(job, dstData);
                }
            }

            requestAnimationFrame(frame);
        }

        function reportProgress(job) {
            if (job.reported === job.rows) {
                return;
            }
            job.reported = job.rows;
            setWaiting(false);

            var pct = job.height ? Math.round((job.rows / job.height) * 100) : 0;
            setProgress(pct);

            var nowTs = now();
            if (pct >= 100 || (nowTs - job.labelTs) > LABEL_THROTTLE_MS) {
                job.labelTs = nowTs;
                setLabel('生成中… ' + pct + '%');
            }
        }

        function finishJob(job, imageData) {
            if (job.cancelled || activeJob !== job) {
                return;
            }
            try {
                if (el.processedCanvas.width !== job.width || el.processedCanvas.height !== job.height) {
                    el.processedCanvas.width = job.width;
                    el.processedCanvas.height = job.height;
                }
                ctxProcessed.putImageData(imageData, 0, 0);
            } catch (err) {
                failJob(job, '写入处理结果失败：' + describeError(err));
                return;
            }

            activeJob = null;
            var elapsed = Math.round(now() - job.startedAt);

            setWaiting(false);
            setProgress(100);
            showCanvas(el.processedCanvas, true);
            if (el.fixedEmpty) {
                el.fixedEmpty.hidden = true;
            }
            if (el.fixedRes) {
                el.fixedRes.textContent = formatSize(job.width, job.height);
            }
            setState('done');
            setLabel('耗时 ' + elapsed + ' ms');
            setStatus('success', '通道修复完成：' + formatSize(job.width, job.height) + '，耗时 ' + elapsed + ' ms。可下载结果或导入新图片。');

            encodeResult(job.width, job.height);
        }

        function failJob(job, message) {
            if (activeJob === job) {
                activeJob = null;
            }
            job.cancelled = true;
            setWaiting(false);
            setLabel('处理失败');
            hideProcessed();
            setState('error');
            setStatus('error', message + ' 原图仍保留，可重试或更换图片。');
        }

        function cancelActiveJob() {
            var job = activeJob;
            if (!job) {
                return;
            }
            job.cancelled = true;
            activeJob = null;
            if (job.mode === 'worker' && worker) {
                try {
                    worker.postMessage({ type: 'cancel', jobId: job.id });
                } catch (err) {
                    /* 忽略：Worker 可能已不可用 */
                }
            }
        }

        /* ====================================================================
           执行层：Worker 调度与降级
           ==================================================================== */
        function getWorker() {
            if (!workerAvailable) {
                return null;
            }
            if (worker) {
                return worker;
            }
            try {
                worker = new Worker('worker.js');
                worker.addEventListener('message', onWorkerMessage);
                worker.addEventListener('error', onWorkerError);
            } catch (err) {
                workerAvailable = false;
                worker = null;
            }
            return worker;
        }

        function destroyWorker() {
            if (!worker) {
                return;
            }
            try {
                worker.terminate();
            } catch (err) {
                /* 忽略 */
            }
            worker = null;
        }

        function onWorkerError(event) {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault();
            }
            var job = activeJob;
            destroyWorker();
            workerAvailable = false;
            if (!job || job.cancelled) {
                return;
            }
            setStatus('warning', '后台线程不可用，已自动切换为主线程处理。');
            resetProgress();
            setWaiting(true);
            setLabel('处理中…');
            runOnMainThread(job, null);
        }

        function onWorkerMessage(event) {
            var data = event.data || {};
            var job = activeJob;
            if (!job || data.jobId !== job.id) {
                return;   // 过期任务的消息一律忽略
            }

            if (data.type === 'progress') {
                job.rows = data.rows || 0;
                reportProgress(job);
                return;
            }

            if (data.type === 'done') {
                var imageData = null;
                var pixels = null;
                try {
                    pixels = new Uint8ClampedArray(data.buffer);
                    imageData = new ImageData(pixels, job.width, job.height);
                } catch (err) {
                    imageData = null;
                }
                if (!imageData && pixels) {
                    try {
                        imageData = ctxProcessed.createImageData(job.width, job.height);
                        imageData.data.set(pixels);
                    } catch (err2) {
                        failJob(job, '无法构建处理结果：' + describeError(err2));
                        return;
                    }
                }
                if (!imageData) {
                    failJob(job, '后台线程返回的数据不可用。');
                    return;
                }
                finishJob(job, imageData);
                return;
            }

            if (data.type === 'error') {
                setStatus('warning', '后台处理失败（' + (data.message || '未知错误') + '），正在改用主线程重试…');
                workerAvailable = false;
                destroyWorker();
                resetProgress();
                setWaiting(true);
                setLabel('处理中…');
                runOnMainThread(job, null);
            }
        }

        /* ====================================================================
           结果导出
           ==================================================================== */
        function clearResult() {
            lastResult = null;
            hideProcessed();
            if (el.fixedRes) {
                el.fixedRes.textContent = '';
            }
            syncControls();
        }

        function encodeResult(w, h) {
            if (typeof el.processedCanvas.toBlob !== 'function') {
                return;
            }
            el.processedCanvas.toBlob(function (blob) {
                if (blob) {
                    lastResult = { blob: blob, name: outputName(), width: w, height: h };
                }
            }, 'image/png');
        }

        function handleDownload() {
            if (appState !== 'done') {
                return;
            }
            if (!lastResult || !lastResult.blob) {
                return;
            }
            saveBlob(lastResult.blob, lastResult.name);
            setStatus('success', '已开始下载 ' + lastResult.name);
        }

        function outputName() {
            var base = sourceInfo && sourceInfo.name ? sourceInfo.name : 'image';
            base = base.replace(/\.[^./\\]+$/, '');
            if (!base) {
                base = 'image';
            }
            return base + '_fixed.png';
        }

        function saveBlob(blob, filename) {
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            link.remove();
            // 延迟释放，确保浏览器已完成读取
            setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 10000);
        }

        /* ====================================================================
           工具函数
           ==================================================================== */
        function now() {
            return (window.performance && typeof window.performance.now === 'function')
                ? window.performance.now()
                : Date.now();
        }

        function describeError(err) {
            if (!err) {
                return '未知错误';
            }
            return err.message ? String(err.message) : String(err);
        }

        function formatSize(width, height) {
            return width + ' × ' + height;
        }

        function formatBytes(bytes) {
            if (typeof bytes !== 'number' || isNaN(bytes)) {
                return '未知大小';
            }
            if (bytes < 1024) {
                return bytes + ' B';
            }
            if (bytes < 1048576) {
                return (bytes / 1024).toFixed(1) + ' KB';
            }
            return (bytes / 1048576).toFixed(1) + ' MB';
        }
    }
})();