/**
 * script-runtime.test.js — 在 Node 中真实执行 script.js 的行为测试。
 *
 * script.js 的入口是 document.addEventListener('DOMContentLoaded', init)，
 * 缺少 DOM 时只能读源码做字符串匹配，验证不了运行行为。
 * 本文件配合 test/dom-shim.cjs 让它真正跑起来。
 *
 * 零依赖，运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadScript, flushFrames, importImage, importTga, importWasmImage, runFix } = require('./dom-shim.cjs');

/* ======================================================================
   测试辅助
   ====================================================================== */

/**
 * 装载 script.js 并返回便捷访问器。
 *
 * 默认导入一张 16×16 纯色图，使画布处于 is-visible 状态、浮层可点击。
 */
async function mount({ width = 16, height = 16, fill = [10, 20, 30, 255] } = {}) {
    const { document: doc, cleanup } = await loadScript();
    if (width && height) {
        await importImage(doc, width, height, fill);
    }
    return {
        doc,
        cleanup,
        el(id) {
            const node = doc.getElementById(id);
            assert.ok(node, `缺少元素 #${id}`);
            return node;
        },
        ctx(id) {
            return this.el(id).getContext('2d');
        },
        pixels(id) {
            return this.ctx(id).__pixels();
        },
        /** 打开浮层并等待渲染稳定 */
        async openOverlay(wrapId = 'originalWrap') {
            this.el(wrapId).__click();
            await flushFrames(6);
        },
        /** 关闭浮层并等过渡动画结束（OVERLAY_TRANSITION_MS = 200） */
        async closeOverlay() {
            this.el('overlayClose').__click();
            await new Promise((r) => setTimeout(r, 260));
        },
        channel(name) {
            return this.el('channelSwitch').querySelector(`button[data-channel="${name}"]`);
        },
        mode(name) {
            return this.el('channelSwitch').querySelector(`button[data-mode="${name}"]`);
        },
        /**
         * 点击某个通道 / 模式按钮。
         *
         * 必须走 __click（冒泡）而不是按钮自身的 __emit：
         * script.js 把 click 挂在 #channelSwitch 容器上，
         * 靠 event.target.closest 找到具体按钮。只在按钮上触发
         * 不会走到容器监听器上，会误判为「点击无效」。
         */
        async clickChannel(name) {
            this.channel(name).__click();
            await flushFrames(30);
        },
        async clickMode(name) {
            this.mode(name).__click();
            await flushFrames(30);
        },
    };
}

/** 等关闭浮层的过渡动画 */
const waitClose = () => new Promise((r) => setTimeout(r, 260));

/* ======================================================================
   装载与初始化
   ====================================================================== */

test('装载:DOMContentLoaded 后 init() 真实执行并完成元素绑定', async () => {
    const app = await mount();

    // init() 会给这些元素注册监听，说明它确实跑过了。
    assert.ok(app.el('fileInput').__listenerCount('change') > 0,
        'fileInput 应已注册 change 监听，证明 init() 真实执行');
    assert.ok(app.el('fixBtn').__listenerCount('click') > 0,
        'fixBtn 应已注册 click 监听');
    assert.ok(app.el('overlayClose').__listenerCount('click') > 0,
        'overlayClose 应已注册 click 监听');
    assert.ok(app.el('channelSwitch').__listenerCount('click') > 0,
        '通道切换条应已注册 click 监听');

    app.cleanup();
});

test('装载:导入图片后状态从 idle 变为 ready，按钮解除禁用', async () => {
    const app = await mount({ width: 16, height: 16 });

    assert.equal(app.el('previewOverlay').hidden, true, '初始浮层应关闭');
    assert.equal(app.el('fixBtn').disabled, false, '导入后 fixBtn 应可用');
    assert.equal(
        app.el('originalCanvas').classList.contains('is-visible'),
        true,
        '导入后画布应被标记可见——这是生产代码自己设置的，不是测试伪造的',
    );
    assert.equal(app.el('originalCanvas').width, 16, '画布宽度应等于导入图宽度');

    app.cleanup();
});

test('装载:通道徽标反映导入图是否含透明通道', async () => {
    const opaque = await mount({ width: 8, height: 8, fill: [10, 20, 30, 255] });
    assert.equal(opaque.el('originalChannels').textContent, 'RGB',
        '全不透明图应识别为 RGB');
    assert.match(opaque.el('statusMessage').textContent, /不含透明通道/,
        '不含透明通道时必须警告——修复会丢弃原红通道');
    opaque.cleanup();

    const alpha = await mount({ width: 8, height: 8, fill: [10, 20, 30, 128] });
    assert.equal(alpha.el('originalChannels').textContent, 'RGBA',
        '半透明图应识别为 RGBA');
    alpha.cleanup();
});

/* ======================================================================
   主修复流程
   ====================================================================== */

test('修复:主线程降级路径产出符合映射规则的结果', async () => {
    // 不提供 Worker，强制走主线程分片分支
    const app = await mount({ width: 8, height: 8, fill: [10, 20, 30, 40] });

    await runFix(app.doc);

    const px = app.pixels('processedCanvas').data;
    assert.deepEqual(
        [px[0], px[1], px[2], px[3]],
        [40, 235, 10, 255],
        'R 应取原 A=40，G 应为 255-20=235，B 应取原 R=10，A 置 255',
    );
    assert.equal(app.el('downloadBtn').disabled, false, '完成后应可下载');

    app.cleanup();
});

test('修复:wasm 解码的 TGA 使用精确像素，处理阶段不回读画布', async () => {
    const app = await mount({ width: 0, height: 0 });
    await importTga(app.doc, 4, 4, [30, 20, 10, 200]);

    const ctx = app.ctx('originalCanvas');
    const before = ctx.calls.getImageData;

    await runFix(app.doc);

    // 关键契约：处理阶段不能再回读画布。
    // 画布存半透明像素时会先预乘 alpha、读出时再反预乘，这个往返有损：
    // 实测 alpha=200 时 30 会读成 31，alpha=1 时 17 会被读成 0。
    // 本工具把 alpha 搬进红通道，这点损失会直接进入结果。
    assert.equal(ctx.calls.getImageData, before,
        '带 alpha 的 TGA 处理时不应回读画布');

    const px = app.pixels('processedCanvas').data;
    assert.deepEqual(
        [px[0], px[1], px[2], px[3]],
        [200, 235, 30, 255],
        'B 应精确取原 R=30；若变成 31 说明又走了画布往返',
    );

    app.cleanup();
});

test('修复:重复处理同一张 TGA 结果一致', async () => {
    const app = await mount({ width: 0, height: 0 });
    await importTga(app.doc, 4, 4, [30, 20, 10, 200]);

    await runFix(app.doc);
    const first = Array.from(app.pixels('processedCanvas').data.slice(0, 4));

    await runFix(app.doc);
    const second = Array.from(app.pixels('processedCanvas').data.slice(0, 4));

    assert.deepEqual(second, first, '重复处理应得到相同结果');
    assert.deepEqual(second, [200, 235, 30, 255]);

    // 注意：垫片里没有 Worker，这里走的是主线程分支。
    // 「Worker 分支不能直接 transfer 缓存像素」那条约束由浏览器端到端验证覆盖
    // （实测连点两次结果一致），CI 不覆盖，改动 runJob 的搬运逻辑时需手动复验。
    app.cleanup();
});

test('修复:不含 alpha 的 TGA 不保留整图副本，仍回读画布', async () => {
    // alpha=255 时画布往返是无损的，没必要为此多占一份整图内存
    // （8K 图就是 128MB）。这里断言该优化生效。
    const app = await mount({ width: 0, height: 0 });
    await importTga(app.doc, 4, 4, [30, 20, 10, 255]);

    const ctx = app.ctx('originalCanvas');
    const before = ctx.calls.getImageData;

    await runFix(app.doc);

    assert.ok(ctx.calls.getImageData > before,
        'alpha=255 时应回读画布（无损），说明没有保留多余副本');

    const px = app.pixels('processedCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [255, 235, 30, 255]);

    app.cleanup();
});



test('修复:DDS 文件把 dds 格式传给解码器', async () => {
    const app = await mount({ width: 0, height: 0 });
    const calls = await importWasmImage(app.doc, {
        name: 'test.dds', width: 4, height: 4, fill: [30, 20, 10, 200],
    });

    // 把 .dds 当 tga 解也会报错，但错误信息不会指出是分流的错。
    // 这里直接断言传给解码器的格式，定位问题更快。
    assert.equal(calls.length, 1, '应调用解码器一次');
    assert.equal(calls[0].format, 'dds', '扩展名 .dds 应把 dds 传给解码器');

    await runFix(app.doc);
    const px = app.pixels('processedCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [200, 235, 30, 255],
        'DDS 解码结果应与 TGA 走同一条通道映射');

    app.cleanup();
});

test('修复:TGA 文件仍把 tga 格式传给解码器', async () => {
    const app = await mount({ width: 0, height: 0 });
    const calls = await importWasmImage(app.doc, {
        name: 'test.tga', width: 4, height: 4, fill: [30, 20, 10, 200],
    });

    assert.equal(calls[0].format, 'tga', '扩展名 .tga 不应被误判成其他格式');
    app.cleanup();
});

test('修复:进度条到达 100% 并给出耗时', async () => {
    const app = await mount({ width: 16, height: 16 });

    await runFix(app.doc);

    assert.equal(app.el('progressTrack').getAttribute('aria-valuenow'), '100',
        '进度应走到 100');
    assert.match(app.el('progressLabel').textContent, /耗时 \d+ ms/,
        '应显示本次耗时');

    app.cleanup();
});

test('修复:处理后画布可见且通道徽标为 RGB', async () => {
    const app = await mount({ width: 8, height: 8 });

    await runFix(app.doc);

    assert.equal(app.el('processedCanvas').classList.contains('is-visible'), true,
        '处理完成后结果画布应可见');
    assert.equal(app.el('fixedChannels').textContent, 'RGB',
        '修复结果恒为不透明 RGB');

    app.cleanup();
});

/* ======================================================================
   浮层
   ====================================================================== */

test('浮层:点击预览图打开浮层，标题标明来源', async () => {
    const app = await mount();

    await app.openOverlay();

    assert.equal(app.el('previewOverlay').hidden, false, '浮层应已打开');
    assert.match(app.el('overlayTitle').textContent, /原图/,
        '标题应标明这是原图的预览');

    app.cleanup();
});

test('浮层:原图与修复结果的标题可区分', async () => {
    const app = await mount({ width: 8, height: 8 });

    await app.openOverlay('originalWrap');
    const originalTitle = app.el('overlayTitle').textContent;

    await app.closeOverlay();
    await runFix(app.doc);
    await app.openOverlay('fixedWrap');
    const fixedTitle = app.el('overlayTitle').textContent;

    assert.match(fixedTitle, /修复结果/);
    assert.notEqual(originalTitle, fixedTitle, '两张卡的标题应能区分');

    app.cleanup();
});

test('浮层:关闭时把画布尺寸归零，释放大图内存', async () => {
    const app = await mount({ width: 64, height: 64 });

    await app.openOverlay();
    assert.equal(app.el('overlayCanvas').width, 64, '打开时画布应为原图尺寸');

    await app.closeOverlay();

    assert.equal(app.el('overlayCanvas').width, 0, '关闭后应把宽度归零');
    assert.equal(app.el('overlayCanvas').height, 0, '关闭后应把高度归零');

    app.cleanup();
});

/* ======================================================================
   通道预览
   ====================================================================== */

test('通道:合成视图不回读像素，走 drawImage 零成本路径', async () => {
    const app = await mount({ width: 16, height: 16 });

    await app.openOverlay();
    const overlayCtx = app.ctx('overlayCanvas');

    assert.equal(overlayCtx.calls.drawImage, 1, '合成视图应只 drawImage 一次');
    assert.equal(overlayCtx.calls.getImageData, 0,
        '合成视图不应回读像素——这正是它在大图上依然轻量的原因');

    app.cleanup();
});

test('通道:切到 G 通道后像素为该通道的灰度', async () => {
    const app = await mount({ width: 16, height: 16, fill: [10, 200, 30, 255] });

    await app.openOverlay();
    app.channel('G').__click();
    await flushFrames(30);

    const px = app.pixels('overlayCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [200, 200, 200, 255],
        'G=200 应铺满 RGB 且不透明');

    app.cleanup();
});

test('通道:RGB 着色模式把通道涂成对应原色', async () => {
    const app = await mount({ width: 16, height: 16, fill: [10, 200, 30, 255] });

    await app.openOverlay();
    app.channel('B').__click();
    await flushFrames(30);
    app.mode('rgb').__click();
    await flushFrames(30);

    const px = app.pixels('overlayCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [0, 0, 30, 255],
        'B=30 在着色模式下应是纯蓝调');

    app.cleanup();
});

test('通道:alpha 通道被铺满不透明，避免棋盘格污染读数', async () => {
    // 半透明像素：若预览保留原 alpha，灰度会被棋盘格底色混合，读数失真
    const app = await mount({ width: 16, height: 16, fill: [10, 20, 30, 128] });

    await app.openOverlay();
    app.channel('A').__click();
    await flushFrames(30);

    const px = app.pixels('overlayCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [128, 128, 128, 255],
        'A=128 应铺满灰度且 alpha 置 255');

    app.cleanup();
});

test('通道:RGB 着色对 A 通道退化为灰度', async () => {
    const app = await mount({ width: 16, height: 16, fill: [10, 20, 30, 128] });

    await app.openOverlay();
    app.channel('A').__click();
    await flushFrames(30);
    app.mode('rgb').__click();
    await flushFrames(30);

    const px = app.pixels('overlayCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [128, 128, 128, 255],
        'A 没有对应原色，着色应等同灰度而非涂成红色');

    app.cleanup();
});

test('通道:切换后 aria-pressed 跟随选中状态', async () => {
    const app = await mount();

    await app.openOverlay();
    assert.equal(app.channel('RGB').getAttribute('aria-pressed'), 'true',
        '初始应在合成视图');

    app.channel('R').__click();
    await flushFrames(30);

    assert.equal(app.channel('R').getAttribute('aria-pressed'), 'true',
        '点 R 后 R 应为选中');
    assert.equal(app.channel('RGB').getAttribute('aria-pressed'), 'false',
        '合成视图应变为未选中');

    app.cleanup();
});

test('通道:合成视图下切 RGB 着色不重绘，只给提示', async () => {
    const app = await mount();

    await app.openOverlay();
    const before = app.ctx('overlayCanvas').calls.drawImage;

    app.mode('rgb').__click();
    await flushFrames(30);

    assert.equal(app.ctx('overlayCanvas').calls.drawImage, before,
        '合成视图下切模式不应触发重绘');
    assert.match(app.el('channelHint').textContent, /仅在选择单个通道时生效/,
        '应提示该模式对单通道才有意义');

    app.cleanup();
});

test('通道:每次打开浮层都回到合成视图，不记忆上次选择', async () => {
    const app = await mount({ width: 16, height: 16, fill: [10, 200, 30, 255] });

    await app.openOverlay();
    app.channel('G').__click();
    await flushFrames(30);
    assert.equal(app.channel('G').getAttribute('aria-pressed'), 'true');

    await app.closeOverlay();
    await app.openOverlay();

    assert.equal(app.channel('RGB').getAttribute('aria-pressed'), 'true',
        '重新打开时应回到合成视图');
    assert.equal(app.channel('G').getAttribute('aria-pressed'), 'false',
        '上次选择的通道不应被记住');

    app.cleanup();
});

test('通道:快速连点不同通道，最终画面与最后点击的一致', async () => {
    // previewJobId 令牌就是为这个场景设计的：过期的 rAF 结果必须被丢弃
    const app = await mount({ width: 32, height: 32, fill: [10, 200, 30, 255] });

    await app.openOverlay();
    app.channel('R').__click();
    app.channel('G').__click();
    app.channel('B').__click();
    // 不 flush：三次点击的提取任务都还在队列里
    await flushFrames(60);

    const px = app.pixels('overlayCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [30, 30, 30, 255],
        '最终应显示最后点击的 B 通道，而不是先点的那些');

    app.cleanup();
});

test('通道:修复结果也可查看单通道，且映射后 A 恒为 255', async () => {
    const app = await mount({ width: 8, height: 8, fill: [10, 20, 30, 40] });

    await runFix(app.doc);
    await app.openOverlay('fixedWrap');
    app.channel('A').__click();
    await flushFrames(30);

    const px = app.pixels('overlayCanvas').data;
    assert.deepEqual([px[0], px[1], px[2], px[3]], [255, 255, 255, 255],
        '修复后 alpha 恒为 255，A 通道应呈全白');

    app.cleanup();
});

/* ======================================================================
   事件
   ====================================================================== */

test('事件:点击遮罩关闭浮层', async () => {
    const app = await mount();

    await app.openOverlay();
    assert.equal(app.el('previewOverlay').hidden, false);

    // 遮罩的关闭动作由 overlay 上的 data-action 判定
    app.el('previewOverlay').__emit('click', {
        target: { dataset: { action: 'close-preview' } },
    });
    await waitClose();

    assert.equal(app.el('previewOverlay').hidden, true, '点遮罩应关闭浮层');
    app.cleanup();
});

test('事件:Escape 关闭浮层', async () => {
    const app = await mount();

    await app.openOverlay();
    app.doc.__emit('keydown', { key: 'Escape' });
    await waitClose();

    assert.equal(app.el('previewOverlay').hidden, true, 'Esc 应关闭浮层');
    app.cleanup();
});

test('事件:非 Escape 按键不关闭浮层', async () => {
    const app = await mount();

    await app.openOverlay();
    app.doc.__emit('keydown', { key: 'a' });
    await flushFrames(6);

    assert.equal(app.el('previewOverlay').hidden, false, '普通按键不应关闭浮层');
    app.cleanup();
});

test('事件:未渲染的画布不可点击打开浮层', async () => {
    const app = await mount();

    // processedCanvas 尚未处理，classList 无 is-visible
    assert.equal(app.el('processedCanvas').classList.contains('is-visible'), false,
        '前置条件：结果画布此时确实不可见');

    app.el('fixedWrap').__click();
    await flushFrames(6);

    assert.equal(app.el('previewOverlay').hidden, true,
        '画布未渲染时点击不应打开浮层');
    app.cleanup();
});
