/**
 * serve.mjs — 零依赖静态服务器，供本地浏览器预览。
 *
 * 存在意义：直接双击 index.html（file:// 协议）时浏览器会拦截
 * Worker 与模块加载，页面自动降级为主线程处理。启动本脚本可获得
 * 与线上一致的运行环境（后台线程 + Transferable 零拷贝）。
 *
 * 用法：
 *   node scripts/serve.mjs            # 默认 8080 端口
 *   node scripts/serve.mjs 3000       # 指定端口
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = join(ROOT, urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));

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
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}).listen(PORT, () => {
  console.log(`静态服务器已启动：http://localhost:${PORT}/`);
  console.log('按 Ctrl+C 停止');
});