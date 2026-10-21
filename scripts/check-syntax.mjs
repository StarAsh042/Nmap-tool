/**
 * check-syntax.mjs — 对仓库内所有 JavaScript 做语法检查。
 *
 * 零依赖：对每个文件执行 `node --check`。
 * 静态站点没有打包步骤，因此「所有脚本可被解析」是最低限度的构建验证。
 *
 * 实现说明：使用异步 execFile 而非 spawnSync——后者在 Windows 上
 * 以自身 execPath 再 spawn 会命中 EBUSY 限制。
 *
 * 用法：node scripts/check-syntax.mjs
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 跳过目录：依赖与版本控制 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** 递归收集 .js / .mjs 文件 */
function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 目录不存在（例如尚无测试的早期提交）
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(ROOT).sort();

if (files.length === 0) {
  // 本脚本自身尚未提交的早期提交：仓库里还没有 .js 文件属正常情况，
  // 不作为错误处理，否则重建历史的早期提交会被误判为构建失败。
  console.log('仓库中暂无 .js/.mjs 文件，跳过语法检查（尚未提交 JavaScript）');
  process.exit(0);
}

/** 对单个文件执行 node --check */
async function check(file) {
  try {
    await execFileAsync(process.execPath, ['--check', file], { cwd: ROOT });
    return null;
  } catch (err) {
    return (err.stderr ? err.stderr.toString() : String(err)).trim();
  }
}

const failures = [];

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const detail = await check(file);
  if (detail) {
    failures.push({ rel, detail });
    console.error(`fail  ${rel}`);
  } else {
    console.log(`  ok  ${rel}`);
  }
}

if (failures.length > 0) {
  console.error(`\n语法检查未通过：${failures.length}/${files.length} 个文件有问题\n`);
  for (const { rel, detail } of failures) {
    console.error(`--- ${rel} ---\n${detail}\n`);
  }
  process.exit(1);
}

console.log(`\n语法检查通过：${files.length} 个文件`);