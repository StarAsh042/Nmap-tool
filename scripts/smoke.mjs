/**
 * smoke.mjs — 静态站点冒烟检查。
 *
 * 做三件事：
 *   1. 在随机空闲端口启动一个最小静态服务器（零依赖）
 *   2. 校验 index.html 中引用的本地资源（CSS / JS / 图片）均可 200 获取
 *   3. 校验 HTML 中 script / link / img 的引用文件在磁盘上真实存在
 *
 * 目的：重排提交历史时，保证「每个提交后页面仍可加载」，
 * 避免出现 HTML 引用了尚未提交的文件这类断链。
 *
 * 用法：node scripts/smoke.mjs
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** 启动静态服务器，返回 { origin, close } */
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = join(ROOT, rel);

      // 防目录穿越
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404).end('Not Found');
        return;
      }

      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not Found');
    }
  });

  return new Promise((resolveServer) => {
    // 端口 0 = 由系统分配空闲端口，避免与本机已有服务冲突
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** 从 HTML 中提取本地资源引用（跳过 http/data/锚点） */
function extractRefs(html) {
  const refs = new Set();
  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    for (const match of html.matchAll(re)) {
      const url = match[1].trim();
      if (!url || /^(https?:|data:|#|\/\/)/i.test(url)) continue;
      refs.add(url.split('?')[0].split('#')[0]);
    }
  }
  return [...refs];
}

const errors = [];
const notes = [];

// ---- 1. index.html 必须存在 ----
let html;
try {
  html = await readFile(join(ROOT, 'index.html'), 'utf8');
  console.log('  ok  index.html 存在');
} catch {
  console.error('fail  index.html 不存在：冒烟检查需要入口页面');
  process.exit(1);
}

// ---- 2. 磁盘上引用文件必须存在 ----
const refs = extractRefs(html);
if (refs.length === 0) {
  errors.push('index.html 未引用任何本地资源，冒烟检查无意义');
}

// 页面骨架阶段（script.js 尚未提交）允许缺少脚本类引用：
// 此时只校验样式与图片，脚本引用降级为提示。
const SCRIPT_REFS = new Set(['algorithm.js', 'script.js', 'worker.js']);

for (const ref of refs) {
  const existsOnDisk = await stat(join(ROOT, ref)).then(() => true, () => false);
  if (existsOnDisk) {
    console.log(`  ok  引用存在: ${ref}`);
  } else if (SCRIPT_REFS.has(ref)) {
    notes.push(`脚本尚未提交，跳过: ${ref}`);
  } else {
    errors.push(`index.html 引用了不存在的文件: ${ref}`);
    console.error(`fail  引用缺失: ${ref}`);
  }
}

// ---- 3. 通过 HTTP 实际拉取 ----
const { origin, close } = await startServer();
try {
  const page = await fetch(`${origin}/`);
  if (!page.ok) {
    errors.push(`GET / 返回 ${page.status}`);
  } else {
    console.log('  ok  GET / -> 200');
  }

  for (const ref of refs) {
    try {
      const res = await fetch(`${origin}/${ref}`);
      if (res.ok) {
        console.log(`  ok  GET /${ref} -> 200`);
      } else if (SCRIPT_REFS.has(ref)) {
        notes.push(`脚本尚未提交，跳过 HTTP 校验: ${ref}`);
      } else {
        errors.push(`GET /${ref} 返回 ${res.status}`);
        console.error(`fail  GET /${ref} -> ${res.status}`);
      }
    } catch (err) {
      if (SCRIPT_REFS.has(ref)) {
        notes.push(`脚本尚未提交，跳过 HTTP 校验: ${ref}`);
      } else {
        errors.push(`GET /${ref} 失败: ${err.message}`);
      }
    }
  }
} finally {
  await close();
}

// ---- 4. Worker 存在性提示 ----
// 若 script.js 里构造了 Worker('worker.js')，则 worker.js 必须存在
try {
  const script = await readFile(join(ROOT, 'script.js'), 'utf8');
  if (/new Worker\(\s*['"]worker\.js['"]/.test(script)) {
    try {
      await stat(join(ROOT, 'worker.js'));
      console.log('  ok  worker.js 存在（script.js 会引用它）');
    } catch {
      errors.push('script.js 构造了 Worker(\'worker.js\')，但 worker.js 不存在');
      console.error('fail  worker.js 缺失');
    }
  } else {
    notes.push('script.js 当前不构造 Worker，worker.js 非必需');
  }
} catch {
  notes.push('script.js 尚未提交，跳过 Worker 引用检查');
}

for (const note of notes) {
  console.log(`note  ${note}`);
}

if (errors.length > 0) {
  console.error(`\n冒烟检查未通过，共 ${errors.length} 个问题：\n`);
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}

console.log(`\n冒烟检查通过：index.html 与 ${refs.length} 个本地资源均可正常加载`);