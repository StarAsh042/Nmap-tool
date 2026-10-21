/*!
 * script.js — 交互与状态层
 *
 * 职责：
 *   - 显式状态机（idle / loading / ready / processing / done / error）
 *   - 任务令牌与取消，消除「处理中导入新图」造成的竞态
 *   - 执行层调度：Worker 优先，不可用时降级为主线程分片
 *   - 结果导出（toBlob + ObjectURL）与历史记录快照管理
 *   - 统一可见反馈出口 setStatus，取代原先只会写 console 的 log()
 *
 * 算法实现位于 algorithm.js，本文件不重复实现通道映射。
 */
(function () {
    'use strict';

    var Algo = window.NormalMapChannel;

    /* 单文件体积上限（150MB）：超过它时解码本身就可能拖垮标签页 */
    var MAX_FILE_BYTES = 157286400;

    /* 历史记录条数上限，超出后释放最旧的快照 */
    var HISTORY_LIMIT = 12;

    /* 主线程分片参数 */
    var MAIN_BLOCK_ROWS = 16;
    var MAIN_BUDGET_MS = 10;

    /* 进度文案的最小更新间隔，避免高频刷新 */
    var LABEL_THROTTLE_MS = 120;

    /* 浏览器无法解码、但用户常会尝试拖动进来的扩展名 */
    var UNSUPPORTED_EXTENSIONS = ['tga', 'exr', 'dds', 'hdr', 'psd', 'tif', 'tiff'];

    /* 浮层过渡时长，与 CSS 中 --dur 保持一致 */
    var OVERLAY_TRANSITION_MS = 200;

    /* 静态图标（常量字符串，不含任何用户数据） */
    var ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>';
    var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>';

    var STATE_META = {
        idle: { level: 'idle', text: '等待导入' },
        loading: { level: 'busy', text: '读取中' },
        ready: { level: 'ready', text: '已就绪' },
        processing: { level: 'busy', text: '处理中' },
        done: { level: 'done', text: '已完成' },
        error: { level: 'error', text: '需要处理' }
    };

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var el = collectElements();
        if (!el.fixBtn || !el.originalCanvas || !el.processedCanvas) {
            return;
        }

        /* ---------------- 运行时状态 ---------------- */
        var appState = 'idle';
        var sourceInfo = null;      // { name, width, height, hasAlpha, channels }
        var overLimit = false;
        var lastResult = null;      // { blob, name, width, height }
        var historyItems = [];      // 不可变快照数组
        var historySeq = 0;
        var jobSeq = 0;
        var activeJob = null;
        var worker = null;
        var workerAvailable = typeof Worker === 'function';
        var dragDepth = 0;
        var lastFocused = null;
        var overlayTimer = null;

        var ctxOriginal = el.originalCanvas.getContext('2d', { willReadFrequently: true });
        var ctxProcessed = el.processedCanvas.getContext('2d');
        var ctxOverlay = el.overlayCanvas ? el.overlayCanvas.getContext('2d') : null;

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
            renderHistory();
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
                originalWrap: byId('originalWrap'),
                fixedWrap: byId('fixedWrap'),
                originalEmpty: byId('originalEmpty'),
                fixedEmpty: byId('fixedEmpty'),
                originalRes: byId('originalRes'),
                fixedRes: byId('fixedRes'),
                originalChannels: byId('originalChannels'),
                fixedChannels: byId('fixedChannels'),

                historyList: byId('historyList'),
                historyEmpty: byId('historyEmpty'),
                clearHistoryBtn: byId('clearHistoryBtn'),

                progressTrack: byId('progressTrack'),
                progressFill: byId('progressFill'),
                progressLabel: byId('progressLabel'),
                statusMessage: byId('statusMessage'),

                statusPill: byId('statusPill'),
                statusPillText: byId('statusPillText'),

                overlay: byId('previewOverlay'),
                overlayCanvas: byId('overlayCanvas'),
                overlayTitle: byId('overlayTitle'),
                overlayMeta: byId('overlayMeta'),
                overlayClose: byId('overlayClose')
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
                    handleFiles(files);
                });
            }

            if (el.fixBtn) {
                el.fixBtn.addEventListener('click', startProcessing);
            }
            if (el.downloadBtn) {
                el.downloadBtn.addEventListener('click', handleDownload);
            }
            if (el.clearHistoryBtn) {
                el.clearHistoryBtn.addEventListener('click', clearHistory);
            }
            if (el.historyList) {
                el.historyList.addEventListener('click', onHistoryClick);
            }

            [el.originalWrap, el.fixedWrap].forEach(function (wrap) {
                if (!wrap) {
                    return;
                }
                wrap.addEventListener('click', function () {
                    var canvas = wrap.querySelector('canvas');
                    if (!canvas || !canvas.classList.contains('is-visible') || !canvas.width) {
                        return;
                    }
                    openPreview(canvas);
                });
            });

            if (el.overlayClose) {
                el.overlayClose.addEventListener('click', closePreview);
            }
            if (el.overlay) {
                el.overlay.addEventListener('click', function (event) {
                    if (event.target && event.target.dataset && event.target.dataset.action === 'close-preview') {
                        closePreview();
                    }
                });
            }
            document.addEventListener('keydown', function (event) {
                if (event.key === 'Escape') {
                    closePreview();
                }
            });

            // 全页拦截文件拖拽，避免拖到空白处时浏览器直接打开图片
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (type) {
                document.addEventListener(type, onDocumentDrag, false);
            });

            window.addEventListener('beforeunload', function () {
                historyItems.forEach(releaseEntry);
                historyItems = [];
            });
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
                el.fixBtn.disabled = busy || !sourceInfo || overLimit;
            }
            if (el.downloadBtn) {
                el.downloadBtn.disabled = appState !== 'done';
            }
            if (el.fileInput) {
                el.fileInput.disabled = busy;
            }
            if (el.clearHistoryBtn) {
                el.clearHistoryBtn.disabled = historyItems.length === 0;
            }
            if (el.dropZone) {
                el.dropZone.classList.toggle('is-busy', busy);
            }
            if (el.historyEmpty) {
                el.historyEmpty.hidden = historyItems.length > 0;
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

        function updateChannelBadge(node, text, options) {
            if (!node) {
                return;
            }
            if (!text) {
                node.textContent = '';
                node.classList.remove('is-visible', 'is-pending');
                node.removeAttribute('data-channel');
                return;
            }
            node.textContent = text;
            node.classList.add('is-visible');
            node.classList.toggle('is-pending', Boolean(options && options.pending));
            if (options && options.channel) {
                node.setAttribute('data-channel', options.channel);
            } else {
                node.removeAttribute('data-channel');
            }
        }

        function showCanvas(canvas, visible) {
            canvas.classList.toggle('is-visible', visible);
            var wrap = canvas.parentElement;
            if (!wrap) {
                return;
            }
            var clickable = visible && canvas.width > 0;
            wrap.classList.toggle('is-clickable', clickable);
            if (clickable) {
                wrap.title = '点击放大查看原尺寸';
            } else {
                wrap.removeAttribute('title');
            }
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
        function onDocumentDrag(event) {
            if (!hasFilePayload(event)) {
                return;
            }
            event.preventDefault();

            var busy = appState === 'loading' || appState === 'processing';
            if (event.type === 'dragenter') {
                dragDepth++;
                if (el.dropZone) {
                    el.dropZone.classList.add('drag-over');
                }
            } else if (event.type === 'dragleave') {
                dragDepth = Math.max(0, dragDepth - 1);
                if (dragDepth === 0 && el.dropZone) {
                    el.dropZone.classList.remove('drag-over');
                }
            } else if (event.type === 'dragover') {
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
                }
            } else if (event.type === 'drop') {
                dragDepth = 0;
                if (el.dropZone) {
                    el.dropZone.classList.remove('drag-over');
                }
                handleFiles(event.dataTransfer ? event.dataTransfer.files : null);
            }
        }

        function hasFilePayload(event) {
            var dt = event.dataTransfer;
            if (!dt || !dt.types) {
                return false;
            }
            for (var i = 0; i < dt.types.length; i++) {
                if (dt.types[i] === 'Files') {
                    return true;
                }
            }
            return false;
        }

        function handleFiles(files) {
            if (!files || !files.length) {
                return;
            }
            if (appState === 'loading' || appState === 'processing') {
                setStatus('warning', '当前任务尚未结束，请稍候再导入新图片。');
                return;
            }
            var note = '';
            if (files.length > 1) {
                note = '（本次共拖入 ' + files.length + ' 张图片，仅处理第一张）';
            }
            loadFile(files[0], note);
        }

        function loadFile(file, note) {
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
            updateChannelBadge(el.originalChannels, '', null);
            updateChannelBadge(el.fixedChannels, '', null);
            showCanvas(el.originalCanvas, false);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = false;
            }
            resetProgress();
            setWaiting(false);
            setLabel('等待处理');
            setStatus('busy', '正在读取 ' + (file.name || '图片') + ' …');

            if (file.size > MAX_FILE_BYTES) {
                failLoad('文件体积为 ' + formatBytes(file.size) + '，超过 ' + formatBytes(MAX_FILE_BYTES) + ' 上限。请先压缩或缩小图片。');
                return;
            }

            decodeImage(file).then(function (source) {
                if (!source || !source.width || !source.height) {
                    releaseSource(source);
                    throw new Error('图片尺寸无效');
                }
                applySource(source, file, note);
            }).catch(function (err) {
                failLoad(buildDecodeErrorMessage(file, err));
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

        function releaseSource(source) {
            if (source && typeof source.close === 'function') {
                try {
                    source.close();
                } catch (err) {
                    /* 忽略：部分实现不支持 close */
                }
            }
        }

        function applySource(source, file, note) {
            var w = source.width;
            var h = source.height;
            overLimit = w * h > Algo.MAX_PIXELS;

            sourceInfo = {
                name: file.name || 'image',
                width: w,
                height: h,
                hasAlpha: false,
                channels: 'RGB'
            };

            // 超限时不再分配画布内存（避免在已经很大的图上再叠一份缓冲）
            if (overLimit) {
                releaseSource(source);
                if (el.originalRes) {
                    el.originalRes.textContent = formatSize(w, h);
                }
                setState('error');
                setStatus('error', '图片像素总量为 ' + formatSize(w, h) + '，超过可处理上限（约 3355 万像素）。请先缩小图片后再试。');
                return;
            }

            try {
                el.originalCanvas.width = w;
                el.originalCanvas.height = h;
                ctxOriginal.clearRect(0, 0, w, h);
                ctxOriginal.drawImage(source, 0, 0);
            } catch (err) {
                releaseSource(source);
                failLoad('无法绘制到画布：' + describeError(err) + '。图片可能超过浏览器画布上限。');
                return;
            }
            releaseSource(source);

            if (el.originalRes) {
                el.originalRes.textContent = formatSize(w, h);
            }
            showCanvas(el.originalCanvas, true);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = true;
            }

            try {
                var pixels = ctxOriginal.getImageData(0, 0, w, h).data;
                var info = Algo.inspectChannels(pixels, w, h);
                sourceInfo.hasAlpha = info.hasAlpha;
                sourceInfo.channels = info.channels;
            } catch (err) {
                // 预读失败不阻断流程：真正处理时会再次尝试并给出明确错误
                sourceInfo.channels = 'RGB';
            }
            updateChannelBadge(el.originalChannels, sourceInfo.channels, { channel: sourceInfo.channels });

            var suffix = note ? ' ' + note : '';
            setState('ready');
            if (!sourceInfo.hasAlpha) {
                setStatus('warning', '已载入 ' + sourceInfo.name + '（' + formatSize(w, h) + '，RGB）。该图不含透明通道：修复后红通道将被整体置为 255，原红通道信息不可逆丢失。' + suffix);
            } else {
                setStatus('success', '已载入 ' + sourceInfo.name + '（' + formatSize(w, h) + '，' + sourceInfo.channels + '），可以开始修复。' + suffix);
            }
        }

        function failLoad(message) {
            sourceInfo = null;
            overLimit = false;
            lastResult = null;
            setState('error');
            if (el.dropZone) {
                el.dropZone.classList.add('has-error');
            }
            showCanvas(el.originalCanvas, false);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = false;
            }
            updateChannelBadge(el.originalChannels, '', null);
            resetProgress();
            setWaiting(false);
            setLabel('等待处理');
            setStatus('error', message);
        }

        function buildDecodeErrorMessage(file, err) {
            var name = (file && file.name) || '';
            var parts = name.split('.');
            var ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
            if (UNSUPPORTED_EXTENSIONS.indexOf(ext) >= 0) {
                return '浏览器无法解码 .' + ext + ' 文件，请先转换为 PNG 或 JPEG 再导入。';
            }
            return '无法解码该图片（' + describeError(err) + '）。请确认文件是完整的 PNG / JPEG / WebP 等常见格式。';
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
            if (w * h > Algo.MAX_PIXELS) {
                overLimit = true;
                setState('error');
                setStatus('error', '图片像素总量超出可处理上限，请先缩小图片。');
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

            setState('processing');
            resetProgress();
            setWaiting(true);
            setLabel('准备中…');
            setStatus('busy', '正在修复通道…（' + formatSize(w, h) + '）');
            hideProcessed();
            updateChannelBadge(el.fixedChannels, '正在生成…', { pending: true });

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
            setLabel('耗时 ' + elapsed + ' ms');
            showCanvas(el.processedCanvas, true);
            if (el.fixedEmpty) {
                el.fixedEmpty.hidden = true;
            }
            if (el.fixedRes) {
                el.fixedRes.textContent = formatSize(job.width, job.height);
            }
            updateChannelBadge(el.fixedChannels, 'RGB', { channel: 'RGB' });
            setState('done');
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
            updateChannelBadge(el.fixedChannels, '', null);
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
           结果导出与历史记录
           ==================================================================== */
        function clearResult() {
            lastResult = null;
            hideProcessed();
            if (el.fixedRes) {
                el.fixedRes.textContent = '';
            }
            updateChannelBadge(el.fixedChannels, '', null);
            syncControls();
        }

        function encodeResult(w, h) {
            if (typeof el.processedCanvas.toBlob !== 'function') {
                setStatus('warning', '当前环境不支持异步导出，下载时可能需要短暂等待。');
                return;
            }
            el.processedCanvas.toBlob(function (blob) {
                if (!blob) {
                    setStatus('warning', '结果编码失败，下载时会重新尝试编码。');
                    return;
                }
                var name = outputName();
                lastResult = { blob: blob, name: name, width: w, height: h };
                addHistoryEntry(blob, name, w, h);
            }, 'image/png');
        }

        function handleDownload() {
            if (appState !== 'done') {
                return;
            }
            var name = outputName();
            if (lastResult && lastResult.blob) {
                saveBlob(lastResult.blob, name);
                setStatus('success', '已开始下载 ' + name);
                return;
            }
            if (typeof el.processedCanvas.toBlob !== 'function') {
                setStatus('error', '当前环境不支持导出该画布。');
                return;
            }
            setStatus('busy', '正在编码 PNG…');
            el.processedCanvas.toBlob(function (blob) {
                if (!blob) {
                    setStatus('error', '导出失败：无法编码为 PNG。');
                    return;
                }
                lastResult = {
                    blob: blob,
                    name: name,
                    width: el.processedCanvas.width,
                    height: el.processedCanvas.height
                };
                saveBlob(blob, name);
                setStatus('success', '已开始下载 ' + name);
            }, 'image/png');
        }

        function outputName() {
            var base = sourceInfo && sourceInfo.name ? sourceInfo.name : 'image';
            base = base.replace(/\.[^./\\]+$/, '');
            base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
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

        function addHistoryEntry(blob, name, width, height) {
            var entry = {
                id: 'entry-' + (++historySeq),
                name: name,
                width: width,
                height: height,
                blob: blob,
                url: URL.createObjectURL(blob),
                createdAt: Date.now()
            };
            historyItems.unshift(entry);
            while (historyItems.length > HISTORY_LIMIT) {
                releaseEntry(historyItems.pop());
            }
            renderHistory();
        }

        function releaseEntry(entry) {
            if (!entry || !entry.url) {
                return;
            }
            try {
                URL.revokeObjectURL(entry.url);
            } catch (err) {
                /* 忽略 */
            }
            entry.url = '';
        }

        function findEntry(id) {
            for (var i = 0; i < historyItems.length; i++) {
                if (historyItems[i].id === id) {
                    return historyItems[i];
                }
            }
            return null;
        }

        function renderHistory() {
            if (!el.historyList) {
                return;
            }
            el.historyList.textContent = '';

            historyItems.forEach(function (entry) {
                var item = document.createElement('div');
                item.className = 'history-item';
                item.dataset.id = entry.id;

                var thumb = document.createElement('img');
                thumb.className = 'history-thumb';
                thumb.src = entry.url;
                thumb.alt = entry.name + ' 的修复结果缩略图';
                thumb.loading = 'lazy';
                thumb.decoding = 'async';

                var meta = document.createElement('div');
                meta.className = 'history-meta';
                var name = document.createElement('div');
                name.className = 'history-name';
                name.textContent = entry.name;
                name.title = entry.name;
                var sub = document.createElement('div');
                sub.className = 'history-sub';
                sub.textContent = formatSize(entry.width, entry.height) + ' · ' + formatTime(entry.createdAt);
                meta.appendChild(name);
                meta.appendChild(sub);

                var actions = document.createElement('div');
                actions.className = 'history-actions';
                actions.appendChild(makeIconButton('icon-btn', '下载 ' + entry.name, ICON_DOWNLOAD, 'download'));
                actions.appendChild(makeIconButton('icon-btn is-danger', '移除 ' + entry.name, ICON_TRASH, 'remove'));

                item.appendChild(thumb);
                item.appendChild(meta);
                item.appendChild(actions);
                el.historyList.appendChild(item);
            });

            syncControls();
        }

        function makeIconButton(className, label, svg, action) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = className;
            btn.setAttribute('aria-label', label);
            btn.title = label;
            btn.dataset.action = action;
            btn.innerHTML = svg;
            return btn;
        }

        function onHistoryClick(event) {
            var btn = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
            if (!btn) {
                return;
            }
            var item = btn.closest('.history-item');
            if (!item) {
                return;
            }
            var id = item.dataset.id;
            var action = btn.dataset.action;

            if (action === 'remove') {
                removeHistoryEntry(id);
            } else if (action === 'download') {
                downloadHistoryEntry(id);
            }
        }

        function downloadHistoryEntry(id) {
            var entry = findEntry(id);
            if (!entry) {
                return;
            }
            saveBlob(entry.blob, entry.name);
            setStatus('success', '已开始下载 ' + entry.name);
        }

        function removeHistoryEntry(id) {
            for (var i = 0; i < historyItems.length; i++) {
                if (historyItems[i].id === id) {
                    releaseEntry(historyItems[i]);
                    historyItems.splice(i, 1);
                    renderHistory();
                    setStatus('info', '已移除 1 条历史记录。');
                    return;
                }
            }
        }

        function clearHistory() {
            historyItems.forEach(releaseEntry);
            historyItems = [];
            renderHistory();
            setStatus('info', '历史记录已清空。');
        }

        /* ====================================================================
           原尺寸预览浮层
           ==================================================================== */
        function openPreview(sourceCanvas) {
            if (!ctxOverlay || !el.overlay || !el.overlayCanvas) {
                return;
            }
            if (overlayTimer) {
                clearTimeout(overlayTimer);
                overlayTimer = null;
            }
            try {
                el.overlayCanvas.width = sourceCanvas.width;
                el.overlayCanvas.height = sourceCanvas.height;
                ctxOverlay.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                ctxOverlay.drawImage(sourceCanvas, 0, 0);
            } catch (err) {
                setStatus('error', '无法放大预览：' + describeError(err));
                return;
            }

            if (el.overlayTitle) {
                el.overlayTitle.textContent = sourceCanvas === el.originalCanvas ? '原图 · 原尺寸预览' : '修复结果 · 原尺寸预览';
            }
            if (el.overlayMeta) {
                el.overlayMeta.textContent = formatSize(sourceCanvas.width, sourceCanvas.height);
            }

            lastFocused = document.activeElement;
            el.overlay.hidden = false;
            requestAnimationFrame(function () {
                if (el.overlay) {
                    el.overlay.classList.add('is-open');
                }
            });
            if (el.overlayClose) {
                el.overlayClose.focus();
            }
        }

        function closePreview() {
            if (!el.overlay || el.overlay.hidden) {
                return;
            }
            el.overlay.classList.remove('is-open');
            if (overlayTimer) {
                clearTimeout(overlayTimer);
            }
            overlayTimer = setTimeout(function () {
                el.overlay.hidden = true;
                // 释放放大预览占用的画布内存
                if (el.overlayCanvas) {
                    el.overlayCanvas.width = 0;
                    el.overlayCanvas.height = 0;
                }
                overlayTimer = null;
            }, OVERLAY_TRANSITION_MS);

            if (lastFocused && typeof lastFocused.focus === 'function') {
                lastFocused.focus();
            }
            lastFocused = null;
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

        function formatTime(timestamp) {
            try {
                return new Date(timestamp).toLocaleTimeString();
            } catch (err) {
                return '';
            }
        }
    }
})();
