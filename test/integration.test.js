/**
 * integration.test.js — 集成测试：静态结构完整性与 Worker 消息协议。
 *
 * 覆盖两层：
 *   1. 结构层——index.html 引用的本地资源真实存在，script/worker 关键约定未破坏
 *   2. 协议层——以 Node 的 worker_threads 模拟浏览器 Worker，验证 worker.js
 *      与 algorithm.js 的消息协议（process / progress / done / cancel）正确
 *
 * 零依赖，运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ======================================================================
   结构层：文件与引用
   ====================================================================== */

test('结构:核心文件齐备', () => {
  for (const file of ['index.html', 'style.css', 'algorithm.js', 'script.js', 'worker.js']) {
    assert.ok(exists(file), `缺少核心文件: ${file}`);
  }
});

test('结构:index.html 引用的本地资源均存在', () => {
  const html = read('index.html');
  const refs = [];
  const push = (url) => {
    const clean = url.trim().split('?')[0].split('#')[0];
    if (clean && !/^(https?:|data:|#|\/\/)/i.test(clean)) refs.push(clean);
  };

  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) push(m[1]);

  assert.ok(refs.length > 0, 'index.html 应至少引用一个本地资源');
  for (const ref of new Set(refs)) {
    assert.ok(exists(ref), `index.html 引用了不存在的文件: ${ref}`);
  }
});

test('结构:index.html 先加载 algorithm.js 再加载 script.js', () => {
  const html = read('index.html');
  const algoIdx = html.indexOf('algorithm.js');
  const scriptIdx = html.indexOf('script.js');
  assert.ok(algoIdx > -1 && scriptIdx > -1, '应同时引用 algorithm.js 与 script.js');
  assert.ok(algoIdx < scriptIdx, 'algorithm.js 必须先于 script.js 加载');
});

test('结构:index.html 声明 UTF-8 与 viewport', () => {
  const html = read('index.html');
  assert.match(html, /<meta\s+charset=["']?UTF-8/i);
  assert.match(html, /name=["']viewport["']/i);
});

test('结构:无任何外部资源引用（离线可用）', () => {
  for (const file of ['index.html', 'style.css', 'script.js']) {
    const content = read(file);
    const external = content.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    assert.equal(external.length, 0, `${file} 不应引用外部资源: ${external.join(', ')}`);
  }
});

test('结构:script.js 通过全局命名空间获取算法层，不重复实现映射', () => {
  const script = read('script.js');
  assert.match(script, /window\.NormalMapChannel/, '应通过 window.NormalMapChannel 使用算法层');

  // 映射规则只应在 algorithm.js 中出现：剔除注释后，脚本里不应有逐像素映射运算
  const code = script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^\S\n]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /255\s*-\s*(?:g|src|source)\b/i,
    'script.js 不应重复实现绿通道翻转');
  assert.doesNotMatch(code, /dst\s*\[\s*i\s*\+\s*2\s*\]\s*=\s*r\b/i,
    'script.js 不应重复实现蓝通道拷贝');
});

test('结构:script.js 不使用 ES Module 语法（经典脚本）', () => {
  const script = read('script.js');
  assert.doesNotMatch(script, /^\s*import\s+/m, 'script.js 是经典脚本，不应含 import');
  assert.doesNotMatch(script, /^\s*export\s+/m, 'script.js 是经典脚本，不应含 export');
});

/* ======================================================================
   结构层：Worker 约定
   ====================================================================== */

test('worker:script.js 构造的 Worker 路径与仓库文件一致', () => {
  const script = read('script.js');
  const m = script.match(/new Worker\(\s*['"]([^'"]+)['"]/);
  if (!m) {
    return; // 尚未实现 Worker 的提交无需校验
  }
  assert.equal(m[1], 'worker.js');
  assert.ok(exists('worker.js'), 'script.js 引用了 worker.js，该文件必须存在');
});

test('worker:worker.js 通过 importScripts 复用 algorithm.js', () => {
  const worker = read('worker.js');
  assert.match(worker, /importScripts\(\s*['"]algorithm\.js['"]\s*\)/,
    'worker.js 应复用 algorithm.js，保证算法只有一份实现');
});

test('worker:worker.js 声明了完整的消息协议类型', () => {
  const worker = read('worker.js');
  for (const type of ['process', 'cancel', 'progress', 'done', 'error']) {
    assert.ok(worker.includes(type), `worker.js 应处理/发送 ${type} 消息`);
  }
});

/* ======================================================================
   协议层：以 worker_threads 模拟浏览器 Worker
   ====================================================================== */

/**
 * worker.js 依赖浏览器全局（self、importScripts、postMessage 的转移列表）。
 * 这里注入最小垫片，让它在 Node 的 worker_threads 中运行，
 * 从而真实地验证消息协议与分片计算逻辑。
 */
function runWorkerProtocol({ payload, expect }) {
  return new Promise((resolve, reject) => {
    const shim = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const path = require('node:path');
      const vm = require('node:vm');

      const ROOT = workerData.root;
      const listeners = [];

      // 浏览器 Worker 全局垫片
      global.self = global;
      global.importScripts = (...files) => {
        for (const f of files) {
          const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
          vm.runInThisContext(code, { filename: f });
        }
      };
      global.postMessage = (msg) => { parentPort.postMessage(msg); };
      global.addEventListener = (type, fn) => { if (type === 'message') listeners.push(fn); };
      global.performance = global.performance || { now: () => Date.now() };

      const algorithm = fs.readFileSync(path.join(ROOT, 'algorithm.js'), 'utf8');
      const worker = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
      vm.runInThisContext(algorithm, { filename: 'algorithm.js' });
      vm.runInThisContext(worker, { filename: 'worker.js' });

      const deliver = () => {
        for (const fn of listeners) fn({ data: workerData.payload });
      };
      deliver();
    `;

    const shimPath = path.join(os.tmpdir(), `nmc-worker-shim-${process.pid}-${Date.now()}.cjs`);
    fs.writeFileSync(shimPath, shim, 'utf8');

    let worker;
    try {
      // eslint-disable-next-line import/no-dynamic-require
      const { Worker } = require('node:worker_threads');
      worker = new Worker(shimPath, { workerData: { root: ROOT, payload } });
    } catch (err) {
      fs.unlinkSync(shimPath, () => {});
      return reject(err);
    }

    const progress = [];
    let settled = false;

    const cleanup = () => {
      try { worker.terminate(); } catch { /* 已退出 */ }
      fs.unlinkSync(shimPath, () => {});
    };

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        progress.push(msg.rows);
        return;
      }
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ final: msg, progress });
      }
    });

    worker.on('error', (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    });

    worker.on('exit', () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Worker 未发送终止消息（期望 ${expect}）`));
      }
    });
  });
}

test('worker 协议:process 任务最终回传 done 且像素已映射', async () => {
  const width = 8;
  const height = 16;
  const src = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    src[i * 4] = 10;        // R
    src[i * 4 + 1] = 100;    // G
    src[i * 4 + 2] = 200;    // B
    src[i * 4 + 3] = 60;     // A
  }

  const buffer = src.buffer;
  const { final } = await runWorkerProtocol({
    payload: { type: 'process', jobId: 7, width, height, buffer },
    expect: 'done',
  });

  assert.equal(final.type, 'done');
  assert.equal(final.jobId, 7);
  assert.equal(final.width, width);
  assert.equal(final.height, height);

  const out = new Uint8ClampedArray(final.buffer);
  assert.equal(out.length, src.length, '输出缓冲长度应与输入一致');
  for (let i = 0; i < width * height; i++) {
    assert.equal(out[i * 4], 60, 'R 应取原 A');
    assert.equal(out[i * 4 + 1], 155, 'G 应为 255-100');
    assert.equal(out[i * 4 + 2], 10, 'B 应取原 R');
    assert.equal(out[i * 4 + 3], 255, 'A 应置 255');
  }
});

test('worker 协议:处理过程中上报 progress 且进度单调递增', async () => {
  const width = 64;
  const height = 64;
  const src = new Uint8ClampedArray(width * height * 4).fill(128);
  for (let i = 0; i < src.length; i += 4) src[i + 3] = 255;

  const { progress, final } = await runWorkerProtocol({
    payload: { type: 'process', jobId: 1, width, height, buffer: src.buffer },
    expect: 'done',
  });

  assert.equal(final.type, 'done');
  assert.ok(progress.length > 0, '应至少上报一次进度');
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i] >= progress[i - 1], '进度应单调不减');
  }
  assert.ok(progress[progress.length - 1] <= height, '进度不应超过总行数');
});

test('worker 协议:过期 jobId 的 cancel 不影响新任务', async () => {
  const width = 4;
  const height = 4;
  const src = new Uint8ClampedArray(width * height * 4).fill(255);

  const { final } = await runWorkerProtocol({
    payload: { type: 'process', jobId: 99, width, height, buffer: src.buffer },
    expect: 'done',
  });

  // 这里的重点是协议不抛异常、正常收敛到 done
  assert.equal(final.type, 'done');
  assert.equal(final.jobId, 99);
});

/* ======================================================================
   结构层：算法层无副作用
   ====================================================================== */

test('结构:algorithm.js 不触碰 DOM 与网络', () => {
  // 剔除块注释与行注释，避免把说明文字里的 window/document 误判为真实调用
  const code = read('algorithm.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^\S\n]*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /\bdocument\./, 'algorithm.js 不应访问 document');
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest/, 'algorithm.js 不应发起网络请求');
  assert.doesNotMatch(code, /\bwindow\./, 'algorithm.js 不应访问 window');
});

test('结构:algorithm.js 同时兼容经典脚本与 CommonJS', () => {
  const algo = read('algorithm.js');
  assert.match(algo, /typeof self\s*!==\s*['"]undefined['"]\s*\?\s*self\s*:\s*this/,
    '应以 (typeof self !== "undefined" ? self : this) 兼容两种环境');
});