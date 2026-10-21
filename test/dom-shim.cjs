/**
 * dom-shim.cjs — 在 Node 中为 script.js 提供最小 DOM 垫片。
 *
 * script.js 的入口是 document.addEventListener('DOMContentLoaded', init)，
 * 没有 DOM 就执行不到 init()，测试只能读源码做字符串匹配——
 * 验证的是代码长得像，不是代码能跑。
 *
 * 不用 jsdom 是因为它会带来 node_modules 与 lockfile，破坏本项目
 * 「零依赖、无构建步骤」的定位。script.js 实际用到的 DOM API 约 25 个。
 *
 * 覆盖的 API
 *   document : getElementById / addEventListener / createElement / activeElement / body
 *   Element  : classList / dataset / textContent / style / addEventListener /
 *              setAttribute / removeAttribute / querySelector(All) / closest /
 *              contains / appendChild / remove / innerHTML / title / hidden /
 *              parentElement / children
 *   Canvas   : width / height / getContext / toBlob
 *   2D 上下文 : clearRect / drawImage / getImageData / putImageData / createImageData
 *
 * 有意不支持
 *   - 通配符与后代选择器：script.js 未使用，支持只会让垫片难以推理
 *   - Worker：不提供，使 script.js 走主线程降级分支（该路径需要被覆盖）
 *   - Image 解码：由测试通过 createImageBitmap 的替身直接注入假源
 */

/* ======================================================================
   内部工具
   ====================================================================== */

/** 极简 classList：仅支持 add / remove / toggle / contains */
class ShimClassList {
    constructor(node) {
        this._node = node;
        this._set = new Set();
    }

    add(...names) {
        for (const n of names) {
            if (n) this._set.add(n);
        }
    }

    remove(...names) {
        for (const n of names) this._set.delete(n);
    }

    /** @param {boolean} [force] 传入时强制设为该状态 */
    toggle(name, force) {
        const want = force === undefined ? !this._set.has(name) : Boolean(force);
        if (want) {
            this._set.add(name);
        } else {
            this._set.delete(name);
        }
        return want;
    }

    contains(name) {
        return this._set.has(name);
    }

    toString() {
        return [...this._set].join(' ');
    }
}

/** 把 'a b c' 形式的 class 字符串同步到 classList（innerHTML setter 会改写它） */
function syncClassList(node) {
    const list = node.classList;
    list._set.clear();
    for (const c of String(node._className || '').split(/\s+/)) {
        if (c) list._set.add(c);
    }
}

/**
 * 判断单个元素是否匹配单个选择器。
 *
 * 只支持 script.js 实际用到的语法：标签名、.class、[attr]、[attr="value"]。
 * 不支持通配符、后代选择器等——它们不在本项目的调用面内，
 * 支持它们只会让垫片变得难以推理。
 */
function matchesSelector(node, part) {
    const m = /^([a-zA-Z]*)((?:\.[\w-]+|\[[^\]]+\])*)$/.exec(part.trim());
    if (!m) return false;
    const tag = m[1].toUpperCase();
    if (tag && node.tagName !== tag) return false;
    for (const c of m[2].matchAll(/\.([\w-]+)|\[([^\]]+)\]/g)) {
        if (c[1]) {
            if (!node.classList.contains(c[1])) return false;
        } else {
            const attr = c[2];
            const eq = attr.indexOf('=');
            if (eq < 0) {
                if (!node.hasAttribute(attr)) return false;
            } else {
                const k = attr.slice(0, eq);
                const want = attr.slice(eq + 1).replace(/^["']|["']$/g, '');
                if (node.getAttribute(k) !== want) return false;
            }
        }
    }
    return true;
}

/* ======================================================================
   Element
   ====================================================================== */

class ShimElement {
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentElement = null;

        this._className = '';
        this._attrs = {};
        this._dataset = {};
        this._listeners = {};
        this._textContent = '';
        this._innerHTML = '';
        this.style = { setProperty() {}, removeProperty() {} };
        this.hidden = false;
        this.title = '';
        this.disabled = false;
        this.value = '';
        this.files = [];
        this.loading = '';
        this.decoding = '';
        this.alt = '';
        this.rel = '';
        this.href = '';
        this.download = '';

        // classList 必须挂在 _className 之后创建：syncClassList 依赖它，
        // 且下方 classList 的 getter/setter 直接转发到 _classList。
        this._classList = new ShimClassList(this);
        this._classList._set = new Set(
            String(this._className).split(/\s+/).filter(Boolean),
        );
    }

    /* ---- class ---- */
    get className() {
        return this._className;
    }

    set className(value) {
        this._className = String(value);
        syncClassList(this);
    }

    get classList() {
        return this._classList;
    }

    set classList(v) {
        this._classList = v;
    }

    /* ---- 属性 ---- */
    get id() {
        return this._attrs.id || '';
    }

    set id(v) {
        this._attrs.id = v;
    }

    get class() {
        return this._className;
    }

    set class(v) {
        this.className = v;
    }

    setAttribute(name, value) {
        if (name === 'class') {
            this.className = value;
            return;
        }
        this._attrs[name] = String(value);
        if (name.startsWith('data-')) {
            // data-channel → dataset.channel
            const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            this._dataset[key] = String(value);
        }
    }

    getAttribute(name) {
        if (name === 'class') return this._className;
        return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    }

    hasAttribute(name) {
        return name === 'class' ? this._className !== '' : name in this._attrs;
    }

    removeAttribute(name) {
        delete this._attrs[name];
        if (name.startsWith('data-')) {
            const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            delete this._dataset[key];
        }
        if (name === 'class') {
            this.className = '';
        }
    }

    /* ---- dataset ---- */
    get dataset() {
        return this._dataset;
    }

    set dataset(v) {
        this._dataset = v;
    }

    /* ---- 内容 ---- */
    get textContent() {
        return this._textContent;
    }

    set textContent(value) {
        this._textContent = String(value);
        // 真实 DOM 中设置 textContent 会清空子节点
        for (const child of this.children) child.parentElement = null;
        this.children = [];
    }

    get innerHTML() {
        return this._innerHTML;
    }

    set innerHTML(value) {
        this._innerHTML = String(value);
        // 仅需处理 class="..."，垫片不解析真实 HTML
        const m = /class="([^"]*)"/.exec(this._innerHTML);
        if (m) this.className = m[1];
    }

    /* ---- 树 ---- */
    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) {
            this.children.splice(i, 1);
            child.parentElement = null;
        }
        return child;
    }

    remove() {
        if (this.parentElement) {
            this.parentElement.removeChild(this);
        }
    }

    contains(node) {
        if (node === this) return true;
        return this.children.some((c) => c.contains && c.contains(node));
    }

    /**
     * 仅支持 script.js 实际用到的选择器：
     *   按钮  'button[data-action]' / 'button[data-channel], button[data-mode]'
     *   容器  '.history-item'
     * 不支持通配符、后代选择器、属性值匹配等——它们不在本项目的调用面内。
     */
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const parts = String(selector)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const out = [];
        const walk = (node) => {
            for (const child of node.children) {
                if (parts.some((p) => matchesSelector(child, p))) {
                    out.push(child);
                }
                walk(child);
            }
        };
        walk(this);
        return out;
    }

    /**
     * 沿 parentElement 链向上找匹配的元素。
     *
     * 自身也要参与匹配：真实 DOM 的 element.closest() 在元素本身就
     * 匹配选择器时立即返回它自己，而 querySelectorAll 只看后代。
     */
    closest(selector) {
        const parts = String(selector)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        let node = this;
        while (node) {
            if (parts.some((p) => matchesSelector(node, p))) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    /* ---- 事件 ---- */
    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    }

    removeEventListener(type, fn) {
        const arr = this._listeners[type];
        if (arr) {
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
        }
    }

    /**
     * 主动触发已注册监听（垫片特有，真实 DOM 需要外部事件）。
     *
     * 必须用 apply 把 this 绑到元素上：script.js 里有
     *   el.fileInput.addEventListener('change', function () { … this.files … })
     * 这类写法，依赖浏览器以元素为调用者。直接 fn(event) 会让 this
     * 退化为 undefined，报 "Cannot read properties of undefined"。
     */
    __emit(type, event = {}) {
        for (const fn of (this._listeners[type] || []).slice()) {
            fn.call(this, { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event });
        }
    }

    /**
     * 从本元素向上冒泡触发 click。
     *
     * script.js 把 click 挂在 #channelSwitch 上，靠 event.target.closest
     * 找到具体按钮，因此必须在按钮上触发而不能让监听器直接收到。
     *
     * @param {ShimElement} target 实际被点中的元素
     */
    __click(target = this) {
        const chain = [];
        let node = target;
        while (node) {
            chain.push(node);
            node = node.parentElement;
        }
        for (const nodeInPath of chain) {
            nodeInPath.__emit('click', { target });
        }
    }

    /** 供测试读取已注册的监听数量 */
    __listenerCount(type) {
        return (this._listeners[type] || []).length;
    }

    click() {
        this.__emit('click', { target: this });
    }

    focus() {
        if (shimDocument) {
            shimDocument._activeElement = this;
        }
    }
}

/* ======================================================================
   Canvas 与 2D 上下文
   ====================================================================== */

/**
 * 像素后端：用 Map 存放每个 canvas 的像素，
 * key 为 `${width}x${height}`，避免 resize 时忘记清空。
 */
class Shim2DContext {
    constructor(canvas) {
        this.canvas = canvas;
        this._pixels = null;
        this.calls = { drawImage: 0, putImageData: 0, getImageData: 0, clearRect: 0 };
    }

    _ensure(w, h) {
        if (!this._pixels || this._pixels.width !== w || this._pixels.height !== h) {
            this._pixels = {
                width: w,
                height: h,
                data: new Uint8ClampedArray(Math.max(0, w * h * 4)),
            };
        }
        return this._pixels;
    }

    clearRect() {
        this.calls.clearRect++;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const px = this._ensure(w, h);
        px.data.fill(0);
    }

    /**
     * 绘制源到画布。
     *
     * source 有两种形态，都必须支持：
     *   - ImageBitmap 替身：裸对象，挂在 __imageData 上（applySource 的路径）
     *   - canvas 元素：像素在它的 2D 上下文的缓冲里（openPreview 的路径）
     * 只处理前者会让浮层预览永远是黑的。
     */
    drawImage(source) {
        this.calls.drawImage++;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const px = this._ensure(w, h);

        // 形态一：带 __imageData 的裸对象
        let data = source && source.__imageData && source.__imageData.data;

        // 形态二：canvas 元素，取其上下文缓冲
        if (!data && source && typeof source.getContext === 'function') {
            const srcCtx = source.getContext('2d');
            if (srcCtx && srcCtx.__pixels) {
                data = srcCtx.__pixels().data;
            }
        }

        if (data) {
            const n = Math.min(px.data.length, data.length);
            px.data.set(data.subarray(0, n));
            return;
        }
        // 无像素可画时按不透明黑填充，至少让尺寸与调用次数可被断言
        for (let i = 3; i < px.data.length; i += 4) px.data[i] = 255;
    }

    /**
     * 回读像素。
     *
     * 真实 canvas 的 getImageData 读的是「当前画面」，也就是最后一次
     * drawImage / putImageData 的结果。若画布从未绘制过，读到的是全透明黑。
     */
    getImageData(x, y, w, h) {
        this.calls.getImageData++;
        const px = this._ensure(this.canvas.width, this.canvas.height);
        return { width: w, height: h, data: px.data };
    }

    putImageData(imageData) {
        this.calls.putImageData++;
        const px = this._ensure(this.canvas.width, this.canvas.height);
        const n = Math.min(px.data.length, imageData.data.length);
        px.data.set(imageData.data.subarray(0, n));
    }

    createImageData(w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) };
    }

    /** 供测试读取当前像素 */
    __pixels() {
        return this._ensure(this.canvas.width, this.canvas.height);
    }
}

class ShimCanvas extends ShimElement {
    constructor() {
        super('canvas');
        this._width = 300;
        this._height = 150;
        this._ctx = new Shim2DContext(this);
        this.__blobCount = 0;
    }

    get width() {
        return this._width;
    }

    /** 赋值会重置像素缓冲，与真实 canvas 一致 */
    set width(v) {
        const n = Number(v) || 0;
        if (n !== this._width) {
            this._width = n;
            this._ctx._pixels = null;
        }
    }

    get height() {
        return this._height;
    }

    set height(v) {
        const n = Number(v) || 0;
        if (n !== this._height) {
            this._height = n;
            this._ctx._pixels = null;
        }
    }

    getContext() {
        return this._ctx;
    }

    /**
     * 异步回调形式的桩。
     *
     * 必须返回真正的 Blob 实例：script.js 拿到 blob 后会交给
     * URL.createObjectURL，而原生实现会校验入参类型，
     * 传普通对象会抛 ERR_INVALID_ARG_TYPE。
     */
    toBlob(cb, type) {
        this.__blobCount++;
        const blob = new Blob([new Uint8Array(1)], { type: type || 'image/png' });
        // 真实 API 是异步的，用微任务模拟
        Promise.resolve().then(() => cb(blob));
    }

    /** 供测试：造一个可直接 drawImage 的假源 */
    __makeSource(width, height, fill) {
        const data = new Uint8ClampedArray(width * height * 4);
        if (typeof fill === 'function') {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const [r, g, b, a] = fill(x, y);
                    const i = (y * width + x) * 4;
                    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
                }
            }
        }
        return { width, height, __imageData: { data } };
    }
}

/* ======================================================================
   document
   ====================================================================== */

let shimDocument = null;

/** 创建一份干净的 document 垫片 */
function createDocument() {
    const registry = new Map();
    const docListeners = {};

    const body = new ShimElement('body');
    const doc = {
        _registry: registry,
        _activeElement: null,
        _listeners: docListeners,

        get body() {
            return body;
        },

        get activeElement() {
            return doc._activeElement || body;
        },

        getElementById(id) {
            return registry.get(id) || null;
        },

        createElement(tag) {
            const t = String(tag).toLowerCase();
            if (t === 'canvas') return new ShimCanvas();
            return new ShimElement(t);
        },

        addEventListener(type, fn) {
            (docListeners[type] = docListeners[type] || []).push(fn);
        },

        removeEventListener(type, fn) {
            const arr = docListeners[type];
            if (arr) {
                const i = arr.indexOf(fn);
                if (i >= 0) arr.splice(i, 1);
            }
        },

        /** 触发 document 级监听（模拟 DOMContentLoaded / keydown / drop） */
        __emit(type, event = {}) {
            // script.js 的 document 监听器同样可能依赖 this
            for (const fn of (docListeners[type] || []).slice()) {
                fn.call(doc, { type, target: doc, currentTarget: doc, preventDefault() {}, stopPropagation() {}, ...event });
            }
        },

        __listenerCount(type) {
            return (docListeners[type] || []).length;
        },
    };

    shimDocument = doc;
    return doc;
}

/**
 * 构造 script.js 所需的完整 id 集合。
 *
 * script.js 在 init() 开头会检查 fixBtn / originalCanvas / processedCanvas
 * 三者是否存在，缺一即 return，因此这三个必须提供。
 */
const REQUIRED_IDS = [
    'dropZone', 'fileInput', 'fileName',
    'fixBtn', 'downloadBtn',
    'originalCanvas', 'processedCanvas',
    'originalWrap', 'fixedWrap', 'originalEmpty', 'fixedEmpty',
    'originalRes', 'fixedRes', 'originalChannels', 'fixedChannels',
    'historyList', 'historyEmpty', 'clearHistoryBtn',
    'progressTrack', 'progressFill', 'progressLabel', 'statusMessage',
    'statusPill', 'statusPillText',
    'previewOverlay', 'overlayCanvas', 'overlayTitle', 'overlayMeta', 'overlayClose',
    'channelSwitch', 'channelHint',
];

/** 按 index.html 的结构创建带 id 的元素树 */
function buildDocument() {
    const doc = createDocument();
    const make = (tag, id, className) => {
        const el = doc.createElement(tag);
        if (id) el.id = id;
        if (className) el.className = className;
        doc._registry.set(id || className, el);
        return el;
    };

    make('section', 'dropZone', 'panel');
    make('input', 'fileInput');
    make('span', 'fileName');
    make('button', 'fixBtn', 'btn');
    make('button', 'downloadBtn', 'btn');

    /**
     * 预览结构必须还原 index.html 的父子关系：
     *   div.canvas-wrapper#originalWrap > canvas#originalCanvas
     *           + div.empty-state#originalEmpty
     *           + span.channel-badge#originalChannels
     *
     * script.js 的点击处理是
     *   wrap.addEventListener('click', …) → wrap.querySelector('canvas')
     * 因此 canvas 必须是 wrap 的子节点，否则点击根本不会命中。
     */
    const originalWrap = make('div', 'originalWrap', 'canvas-wrapper');
    // res-info 在真实 HTML 中位于 card-header，浮层预览不依赖它，
    // 但 script.js 会写它的 textContent，必须存在
    make('span', 'originalRes', 'res-info');
    const originalCanvas = make('canvas', 'originalCanvas');
    originalWrap.appendChild(originalCanvas);
    originalWrap.appendChild(make('div', 'originalEmpty', 'empty-state'));
    originalWrap.appendChild(make('span', 'originalChannels', 'channel-badge'));

    const fixedWrap = make('div', 'fixedWrap', 'canvas-wrapper');
    make('span', 'fixedRes', 'res-info');
    const processedCanvas = make('canvas', 'processedCanvas');
    fixedWrap.appendChild(processedCanvas);
    fixedWrap.appendChild(make('div', 'fixedEmpty', 'empty-state'));
    fixedWrap.appendChild(make('span', 'fixedChannels', 'channel-badge'));

    make('div', 'historyList', 'history-list');
    make('p', 'historyEmpty', 'empty-hint');
    make('button', 'clearHistoryBtn', 'btn');
    make('div', 'progressTrack', 'progress-track');
    make('div', 'progressFill', 'progress-fill');
    make('span', 'progressLabel', 'progress-label');
    make('p', 'statusMessage', 'status-message');
    make('span', 'statusPill', 'status-pill');
    make('span', 'statusPillText');

    const overlay = make('div', 'previewOverlay', 'overlay');
    // index.html 中该元素带 hidden 属性，初始即关闭。
    // 垫片必须如实还原，否则测试会把「初始没关」误当成 bug。
    overlay.hidden = true;
    const overlayPanel = make('div', null, 'overlay-panel');
    const overlayCanvas = make('canvas', 'overlayCanvas');
    overlay.appendChild(overlayPanel);
    overlayPanel.appendChild(make('span', 'overlayTitle', 'overlay-title'));
    overlayPanel.appendChild(make('span', 'overlayMeta', 'overlay-meta'));
    overlayPanel.appendChild(make('button', 'overlayClose', 'icon-btn'));
    overlayPanel.appendChild(overlayCanvas);

    // 通道切换条：容器 + 5 个通道按钮 + 2 个模式按钮
    const channelSwitch = make('div', 'channelSwitch', 'channel-viewer');
    for (const ch of ['RGB', 'R', 'G', 'B', 'A']) {
        const btn = make('button', null, 'channel-btn');
        btn.setAttribute('data-channel', ch);
        btn.setAttribute('aria-pressed', ch === 'RGB' ? 'true' : 'false');
        channelSwitch.appendChild(btn);
    }
    for (const mode of ['gray', 'rgb']) {
        const btn = make('button', null, 'mode-btn');
        btn.setAttribute('data-mode', mode);
        btn.setAttribute('aria-pressed', mode === 'gray' ? 'true' : 'false');
        channelSwitch.appendChild(btn);
    }
    channelSwitch.appendChild(make('span', 'channelHint', 'channel-hint'));
    overlayPanel.appendChild(channelSwitch);

    doc.body.appendChild(overlay);

    for (const id of REQUIRED_IDS) {
        if (!doc._registry.has(id)) {
            throw new Error(`垫片缺少必需元素：#${id}`);
        }
    }

    return doc;
}

/**
 * 安装全局垫片并执行 script.js，触发其 init()。
 *
 * @param {{width?: number, height?: number}} [opts] 可选：在 init 后预置原图画布尺寸
 * @returns {{document: object, cleanup: function}} 垫片文档与清理函数
 */
async function loadScript({ width = 0, height = 0 } = {}) {
    const doc = buildDocument();

    // algorithm.js 的 UMD 结尾会挂到 globalThis.NormalMapChannel，
    // 直接 require 复用生产代码本身，不复制一份实现
    const algo = require('../algorithm.js').NormalMapChannel;

    /**
     * 只注入 script.js 真实用到的全局，其余保留 Node 原生对象。
     *
     * 不要覆盖 global.URL：宿主环境的 fs 垫片依赖原生 URL，
     * 替换后报错会伪装成 "Right-hand side of 'instanceof' is not callable"。
     * 因此 ObjectURL 相关方法用 defineProperty 追加，不替换对象本身。
     */
    const saved = new Map();
    function define(name, value) {
        saved.set(name, Object.getOwnPropertyDescriptor(global, name));
        Object.defineProperty(global, name, {
            value,
            writable: true,
            configurable: true,
            enumerable: true,
        });
    }

    define('document', doc);
    define('NormalMapChannel', algo);
    define('requestAnimationFrame', (fn) => setTimeout(fn, 0));
    define('cancelAnimationFrame', (id) => clearTimeout(id));

    // 不提供 Worker：script.js 会走主线程降级分支，正是需要覆盖的路径
    if (!('Worker' in global)) {
        define('Worker', undefined);
    }

    if (!URL.createObjectURL) {
        URL.createObjectURL = () => 'blob:shim';
        URL.revokeObjectURL = () => {};
    }

    if (typeof global.ImageData !== 'function') {
        define('ImageData', class ImageData {
            constructor(data, w, h) {
                this.data = data;
                this.width = w;
                this.height = h;
            }
        });
    }

    // script.js 用到 window 的三处：NormalMapChannel、addEventListener、performance。
    // 不把 window 指向 global 本身——global 没有 addEventListener。
    const winListeners = {};
    const shimWindow = {
        NormalMapChannel: algo,
        performance: global.performance,
        addEventListener(type, fn) {
            (winListeners[type] = winListeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = winListeners[type];
            if (arr) {
                const i = arr.indexOf(fn);
                if (i >= 0) arr.splice(i, 1);
            }
        },
    };
    define('window', shimWindow);

    try {
        // 加载 script.js：它注册 DOMContentLoaded 监听，随即触发以执行 init()
        delete require.cache[require.resolve('../script.js')];
        require('../script.js');
        doc.__emit('DOMContentLoaded');
    } catch (err) {
        // 装载失败也要还原，不能留下半套全局污染后续测试
        restore();
        throw err;
    }

    /**
     * 全局保持安装状态，直到调用方 cleanup()。
     *
     * 不能在 init() 之后立刻还原：script.js 的事件处理器里用的是裸
     * `document`（例如拖拽拦截的 onDocumentDrag），而不是捕获的引用。
     * 一旦还原，任何后续点击都会抛 "document is not defined"。
     * Node 的 test runner 中同一文件内的测试顺序不保证，
     * 因此这里用「引用计数 + 显式 cleanup」而非依赖测试自行调用。
     */
    return { document: doc, cleanup: restore };

    function restore() {
        for (const [name, desc] of saved) {
            if (desc) {
                Object.defineProperty(global, name, desc);
            } else {
                delete global[name];
            }
        }
    }
}

/** 等待若干轮事件循环，让 rAF 分片跑完 */
async function flushFrames(times = 60) {
    for (let i = 0; i < times; i++) {
        await new Promise((r) => setTimeout(r, 0));
    }
}

/**
 * 走真实导入流程装载一张测试图。
 *
 * 不手动给 canvas 加 is-visible，而是驱动 script.js 自己的
 * loadFile → applySource → showCanvas 链路，让状态由生产代码设置。
 *
 * @param {object} doc loadScript 返回的 document
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number,number]} fill RGBA
 */
async function importImage(doc, width, height, fill) {
    const canvas = doc.getElementById('originalCanvas');
    const source = canvas.__makeSource(width, height, () => fill);

    const fakeFile = {
        name: 'test.png',
        size: width * height * 4,
    };

    // createImageBitmap 的替身：把「文件」变成 script.js 能绘制的源
    const prevBitmap = global.createImageBitmap;
    global.createImageBitmap = async () => ({
        width,
        height,
        close() {},
        __imageData: source.__imageData,
    });

    try {
        const input = doc.getElementById('fileInput');
        input.files = [fakeFile];
        input.value = 'C:\\fakepath\\test.png';
        input.__emit('change');
        // loadFile 内部是 Promise 链（decodeImage → applySource）
        await flushFrames(12);
    } finally {
        if (prevBitmap === undefined) delete global.createImageBitmap;
        else global.createImageBitmap = prevBitmap;
    }
}

/**
 * 触发「开始修复」并等待主线程分片处理完成。
 * 不提供 Worker，因此走的是主线程降级分支——这正是需要覆盖的路径。
 */
async function runFix(doc) {
    doc.getElementById('fixBtn').__emit('click');
    await flushFrames(200);
}

module.exports = {
    buildDocument,
    createDocument,
    loadScript,
    flushFrames,
    importImage,
    runFix,
    ShimElement,
    ShimCanvas,
    Shim2DContext,
    REQUIRED_IDS,
};
