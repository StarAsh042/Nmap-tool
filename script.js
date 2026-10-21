/*!
 * script.js — 交互与状态层
 *
 * 职责：
 *   - 显式状态机（idle / loading / ready / processing / done / error）
 *   - 导入本地图片并绘制到原图画布
 *   - 调用 algorithm.js 完成通道映射
 *   - 进度与状态反馈
 *   - 导出修复结果为 PNG
 *
 * 本版本引入显式状态机与可见反馈，处理仍在主线程同步完成。
 *
 * 算法实现位于 algorithm.js，本文件不重复实现通道映射。
 */
(function () {
    'use strict';

    var Algo = window.NormalMapChannel;

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

            var startedAt = now();
            hideProcessed();
            setState('processing');
            resetProgress();
            setWaiting(true);
            setLabel('处理中…');
            setStatus('busy', '正在修复通道…（' + formatSize(w, h) + '）');

            var src;
            var dstData;
            try {
                src = ctxOriginal.getImageData(0, 0, w, h).data;
                dstData = ctxProcessed.createImageData(w, h);
            } catch (err) {
                failJob('无法创建像素缓冲区：' + describeError(err));
                return;
            }

            try {
                Algo.processChannels(src, dstData.data, w, h, function (rowsDone, total) {
                    setWaiting(false);
                    var pct = total ? Math.round((rowsDone / total) * 100) : 0;
                    setProgress(pct);
                    setLabel('处理中… ' + pct + '%');
                });
            } catch (err) {
                failJob('处理过程中出错：' + describeError(err));
                return;
            }

            finishJob(dstData, startedAt);
        }

        function finishJob(imageData, startedAt) {
            try {
                el.processedCanvas.width = imageData.width;
                el.processedCanvas.height = imageData.height;
                ctxProcessed.putImageData(imageData, 0, 0);
            } catch (err) {
                failJob('写入处理结果失败：' + describeError(err));
                return;
            }

            var elapsed = Math.round(now() - startedAt);

            setWaiting(false);
            setProgress(100);
            showCanvas(el.processedCanvas, true);
            if (el.fixedEmpty) {
                el.fixedEmpty.hidden = true;
            }
            if (el.fixedRes) {
                el.fixedRes.textContent = formatSize(imageData.width, imageData.height);
            }
            setState('done');
            setLabel('耗时 ' + elapsed + ' ms');
            setStatus('success', '通道修复完成：' + formatSize(imageData.width, imageData.height) + '，耗时 ' + elapsed + ' ms。可下载结果或导入新图片。');

            encodeResult(imageData.width, imageData.height);
        }

        function failJob(message) {
            setWaiting(false);
            setLabel('处理失败');
            hideProcessed();
            setState('error');
            setStatus('error', message + ' 原图仍保留，可重试或更换图片。');
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