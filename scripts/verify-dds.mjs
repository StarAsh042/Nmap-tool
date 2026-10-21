#!/usr/bin/env node
/**
 * verify-dds.mjs — 用 texconv 验证 wasm 解码器的真实 DDS 兼容性。
 *
 * 做什么：
 *   1. 用 texconv 把源图压缩成每种 DDS 格式
 *   2. 再用 texconv 把压缩结果自己展开成 RGBA8（= 参照实现的行为）
 *   3. 用我们的 wasm 解码同一个 DDS，与参照逐字节比对
 *
 * 为什么需要它：手工构造的样本只能验证「我的构造对不对」。真实工具会写出
 * 想不到的东西——BC5U 这个 FourCC、DXT1a 的 1 位透明模式——只有真实文件
 * 能暴露。PR #9 一次就抓出四个问题，其中一个（wasm32 索引截断）在 64 位
 * 主机上的单元测试里永远发现不了。
 *
 * 用法：
 *   node scripts/verify-dds.mjs             只比对，不覆盖固件
 *   node scripts/verify-dds.mjs --regenerate 重新生成固件并比对
 *
 * 依赖：本机装有 texconv（PATH 中或 --texconv 指定）。没装时给出明确提示，
 * 不会假装通过。CI 不装 texconv，跑的是 test/dds-fixtures.test.js，
 * 它直接读入库的固件，不需要 texconv。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NormalMapDecoder } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'texture-decoder.js'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'dds');
const WASM = join(ROOT, 'vendor', 'texture-decoder.wasm');
const SOURCE = join(ROOT, 'tex_ss_5027_bs_face_n.png');

const WIDTH = 64;
const HEIGHT = 64;

/** 固件覆盖的全部格式，每一种都要求与 texconv 展开结果逐字节一致 */
const FORMATS = ['R8G8B8A8', 'BC1', 'BC2', 'BC3', 'BC4', 'BC5', 'BC7'];

const args = process.argv.slice(2);
const regenerate = args.includes('--regenerate');
const texconvArg = args[args.indexOf('--texconv') + 1];
const TEXCONV = texconvArg || 'texconv';

function runTexconv(argv) {
  const result = spawnSync(TEXCONV, argv, { encoding: 'utf8' });
  if (result.error) {
    console.error('');
    console.error(`找不到 texconv：${TEXCONV}`);
    console.error('');
    console.error('安装方式：从微软 DirectXTex 的 GitHub release 下载单个 texconv.exe');
    console.error('  https://github.com/microsoft/DirectXTex/releases');
    console.error('');
    console.error('然后用 --texconv 指定路径，例如：');
    console.error(`  node scripts/verify-dds.mjs --texconv "E:\\Program Files\\texconv\\texconv.exe"`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`texconv 执行失败：\n${result.stderr || result.stdout}`);
    process.exit(2);
  }
}

function decode(path) {
  const inst = normalmapInstance;
  return NormalMapDecoder.decodeWith(inst, new Uint8Array(readFileSync(path)), 1e7, 'dds');
}

function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) {
    return { diff: a.data.length, maxDiff: 255, total: a.data.length, sizeMismatch: true };
  }
  let diff = 0;
  let maxDiff = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d !== 0) {
      diff++;
      if (d > maxDiff) maxDiff = d;
    }
  }
  return { diff, maxDiff, total: a.data.length, sizeMismatch: false };
}

let normalmapInstance;

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`找不到源图：${SOURCE}`);
    process.exit(2);
  }

  const formats = FORMATS;

  if (regenerate) {
    console.log(`重新生成固件（${WIDTH}x${HEIGHT}，源图 tex_ss_5027_bs_face_n.png）`);
    const tmp = join(FIXTURES, '.tmp');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    // texconv 的 -o 只接受目录，且输出文件名跟随输入名，所以每格式一个目录
    for (const format of formats) {
      const dxgi = format === 'R8G8B8A8' ? 'R8G8B8A8_UNORM' : `${format}_UNORM`;
      const compressed = join(tmp, `${format}_decoded`);
      const expanded = join(tmp, `${format}_ref`);
      mkdirSync(compressed, { recursive: true });
      mkdirSync(expanded, { recursive: true });

      runTexconv(['-w', String(WIDTH), '-h', String(HEIGHT), '-f', dxgi, '-m', '1', '-y', '-o', compressed, SOURCE]);
      const raw = join(compressed, 'tex_ss_5027_bs_face_n.dds');
      const target = join(FIXTURES, format, 'decoded.dds');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(raw));

      runTexconv(['-f', 'R8G8B8A8_UNORM', '-m', '1', '-y', '-o', expanded, target]);
      const expandedFile = join(expanded, 'decoded.dds');
      const refTarget = join(FIXTURES, `ref_${format}`, 'reference.dds');
      mkdirSync(dirname(refTarget), { recursive: true });
      writeFileSync(refTarget, readFileSync(expandedFile));
    }
    rmSync(tmp, { recursive: true, force: true });
    console.log('固件已更新\n');
  }

  normalmapInstance = await NormalMapDecoder.instantiate(readFileSync(WASM));

  let failed = 0;
  for (const format of formats) {
    const compressedPath = join(FIXTURES, format, 'decoded.dds');
    const referencePath = join(FIXTURES, `ref_${format}`, 'reference.dds');
    if (!existsSync(compressedPath) || !existsSync(referencePath)) {
      console.log(`  ${format.padEnd(9)} 缺少固件，跳过（可用 --regenerate 生成）`);
      continue;
    }
    const { diff, maxDiff, total, sizeMismatch } = compare(decode(compressedPath), decode(referencePath));
    const ok = diff === 0 && !sizeMismatch;
    const detail = ok ? '完全一致' : `差异 ${diff}/${total} 字节，最大偏差 ${maxDiff}`;
    console.log(`  ${format.padEnd(9)} ${String(detail).padEnd(28)} ${ok ? '✓' : '✗'}`);
    if (!ok) {
      failed++;
      console.log(`            ${format} 本应逐字节一致，出现回归`);
    }
  }

  console.log('');
  if (failed > 0) {
    console.error(`${failed} 个格式比对失败`);
    process.exit(1);
  }
  console.log('全部通过：解码器与 texconv 行为一致');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
