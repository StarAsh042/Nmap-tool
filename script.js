/*!
 * script.js — 交互与状态层
 *
 * 职责：
 *   - 导入本地图片并绘制到原图画布
 *   - 调用 algorithm.js 完成通道映射
 *   - 导出修复结果为 PNG
 *
 * 本版本为最小闭环：单线程同步处理，尚无状态机、后台线程与历史记录。
 *
 * 算法实现位于 algorithm.js，本文件不重复实现通道映射。
 */
(function () {
    'use strict';

    var Algo = window.NormalMapChannel;

    /* ---------------- 入口 ---------------- */
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        var el = collectElements();
        if (!el.fixBtn || !el.originalCanvas || !el.processedCanvas) {
            return;
        }

        /* ---------------- 运行时状态 ---------------- */
        var sourceInfo = null;      // { name, width, height }
        var lastResult = null;      // { blob, name, width, height }
        var busy = false;

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
            setStatus('info', '导入一张法线贴图后即可开始修复。');
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

                progressLabel: byId('progressLabel'),
                statusMessage: byId('statusMessage')
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
           反馈
           ==================================================================== */
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
            busy = true;
            el.fixBtn.disabled = true;
            el.downloadBtn.disabled = true;

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
            busy = false;

            if (el.originalRes) {
                el.originalRes.textContent = formatSize(w, h);
            }
            showCanvas(el.originalCanvas, true);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = true;
            }
            el.fixBtn.disabled = false;
            setStatus('success', '已载入 ' + sourceInfo.name + '（' + formatSize(w, h) + '），可以开始修复。');
        }

        function failLoad(message) {
            sourceInfo = null;
            busy = false;
            el.fixBtn.disabled = true;
            el.downloadBtn.disabled = true;
            if (el.dropZone) {
                el.dropZone.classList.add('has-error');
            }
            showCanvas(el.originalCanvas, false);
            if (el.originalEmpty) {
                el.originalEmpty.hidden = false;
            }
            setStatus('error', message);
        }

        /* ====================================================================
           处理流程
           ==================================================================== */
        function startProcessing() {
            if (busy) {
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
            busy = true;
            el.fixBtn.disabled = true;
            el.downloadBtn.disabled = true;
            hideProcessed();
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
                Algo.processChannels(src, dstData.data, w, h);
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

            busy = false;
            var elapsed = Math.round(now() - startedAt);

            showCanvas(el.processedCanvas, true);
            if (el.fixedEmpty) {
                el.fixedEmpty.hidden = true;
            }
            if (el.fixedRes) {
                el.fixedRes.textContent = formatSize(imageData.width, imageData.height);
            }
            el.downloadBtn.disabled = false;
            setLabel('耗时 ' + elapsed + ' ms');
            setStatus('success', '通道修复完成：' + formatSize(imageData.width, imageData.height) + '，耗时 ' + elapsed + ' ms。可下载结果或导入新图片。');

            encodeResult(imageData.width, imageData.height);
        }

        function failJob(message) {
            busy = false;
            el.downloadBtn.disabled = true;
            setLabel('处理失败');
            hideProcessed();
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