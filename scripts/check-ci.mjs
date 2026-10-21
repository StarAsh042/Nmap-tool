// check-ci.mjs — 校验 GitHub Actions workflow 的关键约束。
//
// 存在原因：setup-node@v4 的 `cache` 字段只接受 'npm' 等固定值，
// 传入 'none' 会在 CI 上直接报 "Caching for 'none' is not supported"，
// 而 YAML 语法完全合法，本地无法察觉。此脚本做针对性预防。
//
// 用法：node scripts/check-ci.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];

/** 读取 workflow 文件 */
const WORKFLOWS = [
  '.github/workflows/ci.yml',
];

for (const rel of WORKFLOWS) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    errors.push(`缺少 workflow 文件: ${rel}`);
    continue;
  }

  // ---- 检查 1: setup-node 的 cache 字段 ----
  // cache 只接受 'npm' / 'yarn' / 'pnpm' / ''，不接受 'none'
  const setupIdx = text.indexOf('actions/setup-node');
  if (setupIdx === -1) {
    errors.push(`${rel}: 未找到 actions/setup-node 步骤`);
  } else {
    // 从 setup-node 起，向下扫描 with: 块内的字段
    const rest = text.slice(setupIdx);
    const withIdx = rest.indexOf('with:');
    if (withIdx !== -1) {
      const block = rest.slice(withIdx);
      const cacheMatch = block.match(/^\s*cache:\s*(.+)$/m);
      if (cacheMatch) {
        const value = cacheMatch[1].trim().replace(/^['"]|['"]$/g, '');
        const allowed = ['npm', 'yarn', 'pnpm'];
        if (value && !allowed.includes(value)) {
          errors.push(
            `${rel}: setup-node 的 cache='${value}' 非法。` +
            `该字段只接受 ${allowed.map((a) => `'${a}'`).join(' / ')}；` +
            `不需要缓存时应直接省略此字段，而非填 'none'。`,
          );
        }
      }
    }
  }

  // ---- 检查 2: 不应使用 force-push类危险操作 ----
  if (/git\s+push[^\n]*--force(?!-with-lease)/.test(text)) {
    errors.push(`${rel}: 检测到裸 --force 推送，应改用 --force-with-lease`);
  }

  // ---- 检查 3: node-version 应为字符串，避免 YAML 数字被解析成float ----
  const nvMatch = text.match(/node-version:\s*(.+)/);
  if (nvMatch && !/^['"]/.test(nvMatch[1].trim())) {
    errors.push(
      `${rel}: node-version 建议加引号（当前: ${nvMatch[1].trim()}），` +
      `否则 '20.10' 会被 YAML 解析成数字 20.1。`,
    );
  }
}

if (errors.length > 0) {
  console.error('CI 配置检查未通过：\n');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`CI 配置检查通过：${WORKFLOWS.length} 个 workflow`);