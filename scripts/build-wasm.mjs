/**
 * build-wasm.mjs — 把 Rust 解码器编译成 wasm，并生成两份产物。
 *
 * 产物：
 *   vendor/tga-decoder.wasm     二进制本体，http(s) 下由 fetch 加载
 *   vendor/tga-decoder-b64.js   base64 内联版，供 file:// 兜底
 *
 * 为什么要有 base64 那份：file:// 协议下浏览器会拦截对 .wasm 的 fetch，
 * 双击 index.html 打开时只能靠内联。代价是体积涨三分之一，但只在需要时加载。
 *
 * 用法：
 *   node scripts/build-wasm.mjs             # 正常构建（会访问 crates.io）
 *   node scripts/build-wasm.mjs --offline   # 依赖已缓存时离线构建
 *
 * 前置条件：rustup target add wasm32-unknown-unknown
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'crates', 'tga-decoder', 'Cargo.toml');
const TARGET = 'wasm32-unknown-unknown';
const ARTIFACT = join(ROOT, 'crates', 'tga-decoder', 'target', TARGET, 'release', 'tga_decoder.wasm');
const OUT_DIR = join(ROOT, 'vendor');
const OUT_WASM = join(OUT_DIR, 'tga-decoder.wasm');
const OUT_B64 = join(OUT_DIR, 'tga-decoder-b64.js');
const OUT_STAMP = join(OUT_DIR, 'tga-decoder.source.sha256');

/**
 * 参与指纹计算的源码文件。
 *
 * 为什么要算源码指纹而不是直接比对 wasm 字节：同一份源码在不同平台上编译出的
 * wasm 并不逐字节相同（实测 Windows 77946 字节、Linux 77914 字节，同样的 rustc
 * 版本）。直接比字节会让 CI 永远报警。而源码指纹跨平台稳定，又能精确抓住
 * 「改了 Rust 却忘了重新编译」这个真正要防的问题。
 */
const SOURCE_FILES = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs'];

const extraArgs = process.argv.slice(2);

function runCargo() {
  const args = [
    'build',
    '--release',
    '--target', TARGET,
    '--manifest-path', MANIFEST,
    ...extraArgs
  ];
  try {
    execFileSync('cargo', args, { stdio: 'inherit', cwd: ROOT });
  } catch (err) {
    // 最常见的失败原因不是代码问题，而是没装 wasm 目标，单独提示
    if (String(err && err.message).includes('can\'t find crate for `std`')) {
      console.error('\n找不到 wasm 目标，请先执行：rustup target add ' + TARGET);
    }
    process.exit(1);
  }
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

runCargo();

const wasm = readFileSync(ARTIFACT);
if (wasm.length < 8 || wasm.readUInt32LE(0) !== 0x6d736100) {
  console.error('产物不是合法的 wasm 文件：' + ARTIFACT);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_WASM, wasm);

const b64 = wasm.toString('base64');
writeFileSync(OUT_B64, [
  '/* 本文件由 scripts/build-wasm.mjs 自动生成，请勿手工编辑。',
  ' * 用途：file:// 协议下无法 fetch .wasm，改用内联 base64 兜底。',
  ' * 重新生成：node scripts/build-wasm.mjs */',
  'self.NormalMapTgaWasmBase64 = "' + b64 + '";',
  ''
].join('\n'));

const digest = createHash('sha256').update(wasm).digest('hex');

// 源码指纹：把参与编译的源文件按固定顺序拼起来算一次哈希
const stamp = createHash('sha256');
for (const rel of SOURCE_FILES) {
  const abs = join(ROOT, 'crates', 'tga-decoder', rel);
  stamp.update(rel.split('\\').join('/'));
  stamp.update('\0');
  stamp.update(readFileSync(abs));
  stamp.update('\0');
}
const sourceDigest = stamp.digest('hex');
writeFileSync(OUT_STAMP, sourceDigest + '\n');

console.log('');
console.log('产物已更新：');
console.log('  ' + OUT_WASM + '  ' + kb(wasm.length));
console.log('  ' + OUT_B64 + '  ' + kb(statSync(OUT_B64).size) + '（base64 内联版）');
console.log('  ' + OUT_STAMP + '  ' + sourceDigest.slice(0, 16) + '…（源码指纹）');
console.log('  wasm sha256 ' + digest);
