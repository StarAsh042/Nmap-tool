//! 纹理解码器 —— 编译为 WebAssembly 供浏览器调用。
//!
//! 为什么需要它：浏览器原生只解 PNG / JPEG / WebP 等常见格式，而法线贴图流程里
//! 常见的 TGA 与 DDS 都不在其列。DDS 尤其麻烦——它是容器格式，里面可能是未压缩
//! 像素，也可能是 BC1–BC7 块压缩；手写解析器要覆盖十几种组合，出错时往往表现为
//! 「图能显示但数值不对」，比直接报错更难发现。
//!
//! 对外是裸 C ABI（不用 wasm-bindgen），四个函数：
//!   nm_alloc(len)                    分配输入缓冲，返回指针
//!   nm_decode_tga(ptr, len, max_px)  解码 TGA，返回结果头指针
//!   nm_decode_dds(ptr, len, max_px)  解码 DDS，返回结果头指针
//!   nm_free(ptr, len)                释放输入缓冲
//!
//! 结果头是 4 个 u32：[像素指针, 字节数, 宽, 高]，失败时全为 0。
//! 像素数据留在 wasm 线性内存里由 JS 直接读走，避免再拷一次。
//!
//! ⚠ 调用方必须注意：任何一次内存分配都可能触发 wasm 内存增长，增长会让
//! JS 侧已持有的 ArrayBuffer 视图全部失效（buffer 被 detach）。因此每次
//! 调用之后都要重新取 `memory.buffer`。

use std::io::Cursor;

use ddsfile::{D3DFormat, Dds, DxgiFormat};

/// 解码结果暂存在这里，直到下一次解码覆盖它。
///
/// 之所以用静态变量而不是把指针交给 JS 管理：JS 无法为 wasm 里的 Vec 分配
/// 生命周期，只能由 wasm 自己持有，等下一次调用时释放。
static mut OUTPUT: Option<Vec<u8>> = None;

/// 结果头：[像素指针, 字节数, 宽, 高]
static mut RESULT: [u32; 4] = [0, 0, 0, 0];

/// 取结果头的指针。
///
/// 用 `addr_of!` 而不是 `RESULT.as_ptr()`：后者会对 `static mut` 创建共享引用，
/// 这在 Rust 2024 中已不合法（`static_mut_refs`）。这里本来只需要一个地址。
fn result_ptr() -> *const u32 {
    core::ptr::addr_of!(RESULT).cast::<u32>()
}

/// 把解码结果写进静态变量，返回结果头指针。
fn store(pixels: Vec<u8>, width: u32, height: u32) -> *const u32 {
    unsafe {
        RESULT = [pixels.as_ptr() as u32, pixels.len() as u32, width, height];
        OUTPUT = Some(pixels);
        result_ptr()
    }
}

/// 为输入数据分配一块 wasm 线性内存，返回起始指针。
///
/// 不直接让 JS 从地址 0 开始写：wasm 的静态数据段就落在低地址，
/// 从 0 写会踩掉全局变量和分配器状态。
#[no_mangle]
pub extern "C" fn nm_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf); // 交给 JS 使用，不在这里释放
    ptr
}

/// 释放 nm_alloc 分配的缓冲。
///
/// `len` 必须与分配时一致：`Vec::from_raw_parts` 依赖正确的容量来归还内存。
#[no_mangle]
pub extern "C" fn nm_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

/* ======================================================================
   TGA
   ====================================================================== */

/// 纯函数形式的 TGA 解码实现，便于单元测试直接调用。
///
/// 返回 `(RGBA 像素, 宽, 高)`；失败返回 `None`。
fn decode_tga(input: &[u8], max_pixels: u32) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(input, image::ImageFormat::Tga).ok()?;
    let (width, height) = (img.width(), img.height());
    if width == 0 || height == 0 {
        return None;
    }
    // 先按像素总量拦一道：解码一张几亿像素的图会直接吃光标签页内存
    if (width as u64) * (height as u64) > max_pixels as u64 {
        return None;
    }
    let rgba = img.to_rgba8();
    Some((rgba.into_raw(), width, height))
}

/// 解码 TGA，成功时返回结果头指针，失败时返回的头全为 0。
///
/// # Safety
/// `ptr` 必须指向一块至少 `len` 字节的可读内存（由 nm_alloc 分配）。
#[no_mangle]
pub extern "C" fn nm_decode_tga(ptr: *const u8, len: usize, max_pixels: u32) -> *const u32 {
    unsafe {
        // 先释放上一次的结果，避免连续解码时内存只增不减
        OUTPUT = None;
        RESULT = [0, 0, 0, 0];

        if ptr.is_null() || len == 0 {
            return result_ptr();
        }

        let input = core::slice::from_raw_parts(ptr, len);
        match decode_tga(input, max_pixels) {
            Some((pixels, w, h)) => store(pixels, w, h),
            None => result_ptr(),
        }
    }
}

/* ======================================================================
   DDS
   ====================================================================== */

/// 每像素 4 字节的未压缩格式：返回 Some(是否需要交换 R 与 B)。
///
/// DDS 里 B8G8R8A8 比 R8G8B8A8 常见得多（Direct3D 的默认顺序），两者都必须支持，
/// 否则颜色会整体红蓝互换——这种错误不会报错，只会让人怀疑是贴图本身有问题。
fn uncompressed_bgra(dxgi: Option<DxgiFormat>, d3d: Option<D3DFormat>) -> Option<bool> {
    match (dxgi, d3d) {
        (Some(DxgiFormat::R8G8B8A8_UNorm), _) | (Some(DxgiFormat::R8G8B8A8_UNorm_sRGB), _) => Some(false),
        (Some(DxgiFormat::B8G8R8A8_UNorm), _) | (Some(DxgiFormat::B8G8R8A8_UNorm_sRGB), _) => Some(true),
        // 老式 D3D 头：A8R8G8B8 在内存里是 B,G,R,A
        (_, Some(D3DFormat::A8R8G8B8)) | (_, Some(D3DFormat::X8R8G8B8)) => Some(true),
        (_, Some(D3DFormat::A8B8G8R8)) | (_, Some(D3DFormat::X8B8G8R8)) => Some(false),
        _ => None,
    }
}

/// 直接从头部 FourCC 推断 DXGI 格式。
///
/// `ddsfile` 的映射表覆盖了 `ATI1` / `ATI2`，却漏了同样常见的 `BC4U` / `BC5U`
/// 写法——而 texconv（微软官方工具）默认就写 `BC5U`。真实文件因此解码失败，
/// 手工构造的 `ATI2` 样本却测不出来。这里补齐，避免依赖上游的覆盖范围。
fn dxgi_from_fourcc(dds: &Dds) -> Option<DxgiFormat> {
    let code = dds.header.spf.fourcc.as_ref()?.0.to_le_bytes();
    match &code {
        b"BC5U" | b"ATI2" => Some(DxgiFormat::BC5_UNorm),
        b"BC5S" => Some(DxgiFormat::BC5_SNorm),
        b"BC4U" | b"ATI1" => Some(DxgiFormat::BC4_UNorm),
        b"BC4S" => Some(DxgiFormat::BC4_SNorm),
        b"DXT1" => Some(DxgiFormat::BC1_UNorm),
        b"DXT3" => Some(DxgiFormat::BC2_UNorm),
        b"DXT5" => Some(DxgiFormat::BC3_UNorm),
        _ => None,
    }
}


/// BC1 颜色块的解码，逐行对照 DirectXTex 的 `DecodeBC1` 实现。
///
/// 三个容易想当然、但会差 1 的细节（都是照源码来的，不是试出来的）：
///
/// 1. **乘倒数常量而不是除**：源码是 `XMVectorMultiply(clr, {1/31, 1/63, 1/31, 1})`。
///    `v * f32(1/31)` 与 `v / 31` 在浮点下不是同一个数，边界处会差 1。
/// 2. **先归一化再插值**：`XMVectorLerp` 作用在 0..1 的浮点上，
///    等价于 `a + t * (b - a)`，全程 f32。
/// 3. **转 8 位是 `v*255 + 0.5` 再截断**，即四舍五入，不是截断也不是银行家舍入。
const INV31: f32 = 1.0 / 31.0;
const INV63: f32 = 1.0 / 63.0;

#[inline]
fn lerp_f32(a: f32, b: f32, t: f32) -> f32 {
    a + t * (b - a)
}

#[inline]
fn to_u8(v: f32) -> u8 {
    (v * 255.0 + 0.5) as u8
}

/// BC1/BC2/BC3 共用的颜色块解码。
///
/// @param use_alpha c0 <= c1 时索引 3 是否为「透明黑」
fn decode_bc1_color_block(data: &[u8], block: &mut [u32; 16], use_alpha: bool) {
    let c0 = u16::from_le_bytes([data[0], data[1]]);
    let c1 = u16::from_le_bytes([data[2], data[3]]);
    let r0 = ((c0 >> 11) & 31) as u32;
    let g0 = ((c0 >> 5) & 63) as u32;
    let b0 = (c0 & 31) as u32;
    let r1 = ((c1 >> 11) & 31) as u32;
    let g1 = ((c1 >> 5) & 63) as u32;
    let b1 = (c1 & 31) as u32;

    // 归一化到 0..1（乘预计算倒数，与源码一致）
    let n0 = [r0 as f32 * INV31, g0 as f32 * INV63, b0 as f32 * INV31];
    let n1 = [r1 as f32 * INV31, g1 as f32 * INV63, b1 as f32 * INV31];

    let mut pal = [[0u8; 4]; 4];
    pal[0] = [to_u8(n0[0]), to_u8(n0[1]), to_u8(n0[2]), 255];
    pal[1] = [to_u8(n1[0]), to_u8(n1[1]), to_u8(n1[2]), 255];
    if c0 > c1 {
        for (slot, t) in [(2usize, 1.0f32 / 3.0f32), (3usize, 2.0f32 / 3.0f32)] {
            pal[slot] = [
                to_u8(lerp_f32(n0[0], n1[0], t)),
                to_u8(lerp_f32(n0[1], n1[1], t)),
                to_u8(lerp_f32(n0[2], n1[2], t)),
                255,
            ];
        }
    } else {
        pal[2] = [
            to_u8(lerp_f32(n0[0], n1[0], 0.5)),
            to_u8(lerp_f32(n0[1], n1[1], 0.5)),
            to_u8(lerp_f32(n0[2], n1[2], 0.5)),
            255,
        ];
        pal[3] = [0, 0, 0, if use_alpha { 0 } else { 255 }];
    }

    let mut d = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
    for slot in block.iter_mut() {
        let p = pal[(d & 3) as usize];
        d >>= 2;
        *slot = ((p[0] as u32) << 16) | ((p[1] as u32) << 8) | (p[2] as u32) | ((p[3] as u32) << 24);
    }
}

/// 解一个 8 字节的 alpha 块（BC3 的 alpha 段、BC4、BC5 的单个通道）。
///
/// 为什么不用 texture2ddecoder 的 `decode_bc3_alpha`：它把 48 位索引字段写成
/// `(u64::from_le_bytes(data[..8]) >> 16) as usize`。`usize` 在 x86_64 上是 64 位，
/// 在 **wasm32 上是 32 位**——高 16 位被静默截断。32 位只够前 11 个像素（每像素
/// 3 位），所以每个 4×4 块的第 11–15 个像素在浏览器里必然解错。
///
/// 这个 bug 在 64 位主机上的单元测试永远发现不了，只有真实文件 + wasm 才暴露。
/// 我们用 u64 全程保存索引，绕开它。
///
/// @param data 8 字节：a0, a1, 6 字节索引位
/// @param words 16 个像素的输出缓冲（BGRA 打包）
/// @param channel 写入哪个通道（0=B 1=G 2=R 3=A）
fn decode_alpha_block(data: &[u8], words: &mut [u32], channel: usize) {
    let a0 = data[0] as u32;
    let a1 = data[1] as u32;

    let mut pal = [0u32; 8];
    pal[0] = a0;
    pal[1] = a1;
    if a0 > a1 {
        // 8 值模式：a0 与 a1 之间线性插值 6 档
        for i in 1..=6u32 {
            // +3 是四舍五入：DirectXTex（texconv）用 round，截断会产生 1 的偏差
            pal[(i + 1) as usize] = ((7 - i) * a0 + i * a1 + 3) / 7;
        }
    } else {
        // 6 值模式：插值 4 档，另外两档固定为 0 与 255
        for i in 1..=4u32 {
            pal[(i + 1) as usize] = ((5 - i) * a0 + i * a1 + 2) / 5;
        }
        pal[6] = 0;
        pal[7] = 255;
    }

    // 48 位索引，必须用 u64 承载——用 usize 会在 wasm32 上被截断
    let mut bits: u64 = 0;
    for i in 0..6 {
        bits |= (data[2 + i] as u64) << (8 * i);
    }

    let shift = (channel * 8) as u32;
    let mask = !(0xFFu32 << shift);
    for (i, word) in words.iter_mut().enumerate().take(16) {
        let idx = ((bits >> (3 * i)) & 7) as usize;
        *word = (*word & mask) | (pal[idx] << shift);
    }
}

/// 把一个 4×4 块写进整图，超出边界的部分丢弃。
fn copy_block(bx: usize, by: usize, width: usize, height: usize, block: &[u32; 16], out: &mut [u32]) {
    for y in 0..4 {
        let py = by * 4 + y;
        if py >= height {
            break;
        }
        for x in 0..4 {
            let px = bx * 4 + x;
            if px >= width {
                break;
            }
            out[py * width + px] = block[y * 4 + x];
        }
    }
}

/// BC4：单通道，按惯例铺成灰度（R=G=B）。
///
/// texconv 把 BC4 展开成 RGBA8 时也是这么做的，保持一致。
fn decode_bc4_ours(blocks: &[u8], width: usize, height: usize, out: &mut [u32]) {
    let bx_count = width.div_ceil(4);
    let by_count = height.div_ceil(4);
    for by in 0..by_count {
        for bx in 0..bx_count {
            let off = (by * bx_count + bx) * 8;
            let mut block = [0u32; 16];
            decode_alpha_block(&blocks[off..off + 8], &mut block, 2); // R
            for word in block.iter_mut() {
                let v = (*word >> 16) & 0xFF;
                *word = (255 << 24) | (v << 16) | (v << 8) | v; // R=G=B，A=255
            }
            copy_block(bx, by, width, height, &block, out);
        }
    }
}

/// BC5：两个通道块，前 8 字节给 R，后 8 字节给 G，B 为 0、A 为 255。
fn decode_bc5_ours(blocks: &[u8], width: usize, height: usize, out: &mut [u32]) {
    let bx_count = width.div_ceil(4);
    let by_count = height.div_ceil(4);
    for by in 0..by_count {
        for bx in 0..bx_count {
            let off = (by * bx_count + bx) * 16;
            let mut block = [0u32; 16];
            decode_alpha_block(&blocks[off..off + 8], &mut block, 2);      // R
            decode_alpha_block(&blocks[off + 8..off + 16], &mut block, 1); // G
            for word in block.iter_mut() {
                *word |= 255 << 24; // A=255，B 保持 0
            }
            copy_block(bx, by, width, height, &block, out);
        }
    }
}

/// BC3：独立的 alpha 块 + BC1 颜色块。
///
/// ⚠ 布局是 **alpha 在前、颜色在后**（DXT5 的约定），写反了不会报错，
/// 只会解出一张完全错位的图。
///
/// 颜色部分复用库的 `decode_bc1_block`（它用 u32 承载 32 位索引，没有截断问题），
/// alpha 部分用我们自己的实现，避开 wasm32 上的截断 bug。
fn decode_bc3_ours(blocks: &[u8], width: usize, height: usize, out: &mut [u32]) {
    let bx_count = width.div_ceil(4);
    let by_count = height.div_ceil(4);
    for by in 0..by_count {
        for bx in 0..bx_count {
            let off = (by * bx_count + bx) * 16;
            // 顺序很重要：颜色解码会写入 A=255，先解 alpha 会被覆盖掉
            let mut block = [0u32; 16];
            decode_bc1_color_block(&blocks[off + 8..off + 16], &mut block, true); // 颜色在后
            decode_alpha_block(&blocks[off..off + 8], &mut block, 3);          // A 在前，最后写
            copy_block(bx, by, width, height, &block, out);
        }
    }
}


/// BC2：显式 4 位 alpha + BC1 颜色块。
///
/// 布局与 BC3 一样是 **alpha 在前、颜色在后**。alpha 不是插值，是每个像素
/// 4 位直接给值（0..15 映射到 0..255，即乘 17）。
fn decode_bc2_ours(blocks: &[u8], width: usize, height: usize, out: &mut [u32]) {
    let bx_count = width.div_ceil(4);
    let by_count = height.div_ceil(4);
    for by in 0..by_count {
        for bx in 0..bx_count {
            let off = (by * bx_count + bx) * 16;
            let mut block = [0u32; 16];
            decode_bc1_color_block(&blocks[off + 8..off + 16], &mut block, false);
            for (i, slot) in block.iter_mut().enumerate() {
                // 每字节装两个像素：偶数像素取低 4 位，奇数取高 4 位
                let nib = (blocks[off + i / 2] >> ((i % 2) * 4)) & 0x0F;
                *slot = (*slot & 0x00FF_FFFF) | (((nib as u32) * 17) << 24);
            }
            copy_block(bx, by, width, height, &block, out);
        }
    }
}

/// BC1：颜色块，含 1 位透明模式。
///
/// 当块内两个端点满足 c0 <= c1 时，索引 3 表示「透明黑」，DirectXTex 与 DXT1
/// 规范都是这么解的。库的 `decode_bc1` 走的是不透明分支，会把这类像素解成
/// 不透明黑，与参考实现不一致——所以这里用 `decode_bc1a_block`。
fn decode_bc1_ours(blocks: &[u8], width: usize, height: usize, out: &mut [u32]) {
    let bx_count = width.div_ceil(4);
    let by_count = height.div_ceil(4);
    for by in 0..by_count {
        for bx in 0..bx_count {
            let off = (by * bx_count + bx) * 8;
            let mut block = [0u32; 16];
            decode_bc1_color_block(&blocks[off..off + 8], &mut block, true);
            copy_block(bx, by, width, height, &block, out);
        }
    }
}

/// 每种块压缩格式的单块字节数；不支持返回 None。
fn block_size(fmt: DxgiFormat) -> Option<usize> {
    match fmt {
        DxgiFormat::BC1_UNorm | DxgiFormat::BC1_UNorm_sRGB => Some(8),
        DxgiFormat::BC2_UNorm | DxgiFormat::BC2_UNorm_sRGB => Some(16),
        DxgiFormat::BC3_UNorm | DxgiFormat::BC3_UNorm_sRGB => Some(16),
        DxgiFormat::BC4_UNorm | DxgiFormat::BC4_SNorm => Some(8),
        DxgiFormat::BC5_UNorm | DxgiFormat::BC5_SNorm => Some(16),
        DxgiFormat::BC7_UNorm | DxgiFormat::BC7_UNorm_sRGB => Some(16),
        _ => None,
    }
}

/// 纯函数形式的 DDS 解码实现。
///
/// 只解最顶层 mip 与第一张面——本工具处理单张 2D 贴图，立方体贴图的其余面、
/// 纹理数组的其余层、更小的 mip 对用户都没有意义。
///
/// 返回 `(RGBA 像素, 宽, 高)`；失败返回 `None`。
fn decode_dds(input: &[u8], max_pixels: u32) -> Option<(Vec<u8>, u32, u32)> {
    let dds = Dds::read(Cursor::new(input)).ok()?;
    let (width, height) = (dds.get_width(), dds.get_height());
    if width == 0 || height == 0 {
        return None;
    }
    if (width as u64) * (height as u64) > max_pixels as u64 {
        return None;
    }

    let dxgi = dds.get_dxgi_format().or_else(|| dxgi_from_fourcc(&dds));
    let d3d = dds.get_d3d_format();

    // 直接用 dds.data 而不是 get_data(0)：后者要先算 pitch，而 pitch 依赖
    // 格式能被识别——BC5U 这类 ddsfile 不认识的 FourCC 会在那里就报错，
    // 我们的兜底根本轮不到执行。dds.data 是「头部之后的所有字节」，
    // 自己按格式算出需要多少、切出来即可。
    let data: &[u8] = &dds.data;
    let pixel_count = (width as usize) * (height as usize);

    // ---- 未压缩 ----
    if let Some(swap_rb) = uncompressed_bgra(dxgi, d3d) {
        if data.len() < pixel_count * 4 {
            return None;
        }
        let mut out = vec![0u8; pixel_count * 4];
        for i in 0..pixel_count {
            let s = i * 4;
            if swap_rb {
                out[s] = data[s + 2];
                out[s + 1] = data[s + 1];
                out[s + 2] = data[s];
            } else {
                out[s] = data[s];
                out[s + 1] = data[s + 1];
                out[s + 2] = data[s + 2];
            }
            out[s + 3] = data[s + 3];
        }
        return Some((out, width, height));
    }

    // ---- 块压缩 ----
    let fmt = dxgi?;
    let bsize = block_size(fmt)?;
    let blocks_x = (width as usize).div_ceil(4);
    let blocks_y = (height as usize).div_ceil(4);
    let needed = blocks_x * blocks_y * bsize;
    // 数据不足时直接拒绝：解码器按块数切片，长度不够会 panic，
    // 而 panic 在 wasm 里等于整个模块抛异常，不如在这里返回失败
    if data.len() < needed {
        return None;
    }
    // 切掉后面的 mip 层级，只把最顶层交给解码器
    let blocks = &data[..needed];

    let mut words = vec![0u32; pixel_count];
    let (w, h) = (width as usize, height as usize);
    let ok = match fmt {
        DxgiFormat::BC1_UNorm | DxgiFormat::BC1_UNorm_sRGB => {
            decode_bc1_ours(blocks, w, h, &mut words);
            true
        }
        DxgiFormat::BC2_UNorm | DxgiFormat::BC2_UNorm_sRGB => {
            decode_bc2_ours(blocks, w, h, &mut words);
            true
        }
        // BC3 / BC4 / BC5 都含 alpha 块，库实现在 wasm32 上会截断索引，
        // 因此走我们自己的实现（见 decode_alpha_block 的说明）
        DxgiFormat::BC3_UNorm | DxgiFormat::BC3_UNorm_sRGB => {
            decode_bc3_ours(blocks, w, h, &mut words);
            true
        }
        DxgiFormat::BC4_UNorm | DxgiFormat::BC4_SNorm => {
            decode_bc4_ours(blocks, w, h, &mut words);
            true
        }
        DxgiFormat::BC5_UNorm | DxgiFormat::BC5_SNorm => {
            decode_bc5_ours(blocks, w, h, &mut words);
            true
        }
        DxgiFormat::BC7_UNorm | DxgiFormat::BC7_UNorm_sRGB => {
            texture2ddecoder::decode_bc7(blocks, w, h, &mut words).is_ok()
        }
        _ => false,
    };
    if !ok {
        return None;
    }

    // texture2ddecoder 的 u32 输出在内存里是 B,G,R,A 顺序
    // （它的 color() 用 u32::from_le_bytes([b, g, r, a])），必须换成 RGBA
    let mut out = vec![0u8; pixel_count * 4];
    for (i, &word) in words.iter().enumerate() {
        let p = i * 4;
        out[p] = (word >> 16) as u8;
        out[p + 1] = (word >> 8) as u8;
        out[p + 2] = word as u8;
        out[p + 3] = (word >> 24) as u8;
    }
    Some((out, width, height))
}

/// 解码 DDS，成功时返回结果头指针，失败时返回的头全为 0。
///
/// # Safety
/// `ptr` 必须指向一块至少 `len` 字节的可读内存（由 nm_alloc 分配）。
#[no_mangle]
pub extern "C" fn nm_decode_dds(ptr: *const u8, len: usize, max_pixels: u32) -> *const u32 {
    unsafe {
        OUTPUT = None;
        RESULT = [0, 0, 0, 0];

        if ptr.is_null() || len == 0 {
            return result_ptr();
        }

        let input = core::slice::from_raw_parts(ptr, len);
        match decode_dds(input, max_pixels) {
            Some((pixels, w, h)) => store(pixels, w, h),
            None => result_ptr(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------------- TGA ---------------- */

    /// 构造一张未压缩 24 位 TGA。
    /// 头 18 字节：type=2（未压缩真彩色）、24 位、左上原点。
    fn make_tga(width: u16, height: u16, bgr: &[[u8; 3]]) -> Vec<u8> {
        let mut out = vec![
            0,          // id_length
            0,          // colormap_type
            2,          // image_type = 未压缩真彩色
            0, 0, 0, 0, 0, // colormap spec
            0, 0, 0, 0, // x_origin / y_origin
            0, 0, // width（下面填）
            0, 0, // height（下面填）
            24,         // pixel_depth
            0x20,       // image_descriptor：top-left 原点
        ];
        out[12..14].copy_from_slice(&width.to_le_bytes());
        out[14..16].copy_from_slice(&height.to_le_bytes());
        for px in bgr {
            out.extend_from_slice(px); // TGA 的 24 位是 BGR 顺序
        }
        out
    }

    #[test]
    fn tga_decodes_uncompressed_24bit() {
        // 2x2：纯红、纯绿、纯蓝、白（TGA 存的是 BGR）
        let tga = make_tga(2, 2, &[[0, 0, 255], [0, 255, 0], [255, 0, 0], [255, 255, 255]]);
        let (pixels, w, h) = decode_tga(&tga, 100).expect("应解码成功");
        assert_eq!((w, h), (2, 2));
        assert_eq!(pixels.len(), 2 * 2 * 4);
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255], "BGR(0,0,255) 应解成 RGBA 红");
        assert_eq!(&pixels[4..8], &[0, 255, 0, 255], "BGR(0,255,0) 应解成 RGBA 绿");
        assert_eq!(&pixels[8..12], &[0, 0, 255, 255], "BGR(255,0,0) 应解成 RGBA 蓝");
        assert_eq!(&pixels[12..16], &[255, 255, 255, 255]);
    }

    #[test]
    fn tga_rejects_pixel_count_over_limit() {
        let tga = make_tga(2, 2, &[[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
        assert!(decode_tga(&tga, 3).is_none(), "4 像素超过上限 3 时应拒绝");
        assert!(decode_tga(&tga, 4).is_some(), "上限恰好等于像素数时应通过");
    }

    #[test]
    fn tga_rejects_garbage_input() {
        assert!(decode_tga(&[], 100).is_none());
        assert!(decode_tga(&[1, 2, 3, 4, 5], 100).is_none());
        assert!(decode_tga(&[0u8; 18], 100).is_none(), "全零头是无效图像");
    }

    /* ---------------- DDS ---------------- */

    /// 构造 128 字节 DDS 头（不含 DX10 扩展）。
    fn dds_header(width: u32, height: u32, flags: u32, pitch: u32, pf: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(128);
        v.extend_from_slice(b"DDS ");
        v.extend_from_slice(&124u32.to_le_bytes());    // dwSize
        v.extend_from_slice(&flags.to_le_bytes());     // dwFlags
        v.extend_from_slice(&height.to_le_bytes());
        v.extend_from_slice(&width.to_le_bytes());
        v.extend_from_slice(&pitch.to_le_bytes());     // pitchOrLinearSize
        v.extend_from_slice(&0u32.to_le_bytes());      // depth
        v.extend_from_slice(&1u32.to_le_bytes());      // mipMapCount
        for _ in 0..11 {
            v.extend_from_slice(&0u32.to_le_bytes());  // reserved
        }
        v.extend_from_slice(pf);                       // 32 字节 pixel format
        v.extend_from_slice(&0x1000u32.to_le_bytes()); // caps = TEXTURE
        for _ in 0..4 {
            v.extend_from_slice(&0u32.to_le_bytes());  // caps2..4 + reserved2
        }
        assert_eq!(v.len(), 128);
        v
    }

    /// 未压缩 A8R8G8B8 的 pixel format（内存里是 B,G,R,A）。
    fn pf_a8r8g8b8() -> Vec<u8> {
        let mut pf = Vec::new();
        pf.extend_from_slice(&32u32.to_le_bytes());          // size
        pf.extend_from_slice(&0x41u32.to_le_bytes());        // RGB | ALPHAPIXELS
        pf.extend_from_slice(&0u32.to_le_bytes());           // fourCC
        pf.extend_from_slice(&32u32.to_le_bytes());          // bit count
        pf.extend_from_slice(&0x00FF0000u32.to_le_bytes());  // R mask
        pf.extend_from_slice(&0x0000FF00u32.to_le_bytes());  // G mask
        pf.extend_from_slice(&0x000000FFu32.to_le_bytes());  // B mask
        pf.extend_from_slice(&0xFF000000u32.to_le_bytes());  // A mask
        pf
    }

    /// 带 FourCC 的 pixel format（DXT1 等老式头）。
    fn pf_fourcc(code: &[u8; 4]) -> Vec<u8> {
        let mut pf = Vec::new();
        pf.extend_from_slice(&32u32.to_le_bytes());
        pf.extend_from_slice(&0x4u32.to_le_bytes());   // DDPF_FOURCC
        pf.extend_from_slice(code);
        pf.extend_from_slice(&0u32.to_le_bytes());     // bit count
        for _ in 0..4 {
            pf.extend_from_slice(&0u32.to_le_bytes());  // masks
        }
        pf
    }

    #[test]
    fn dds_decodes_uncompressed_bgra8() {
        let (w, h) = (2u32, 2u32);
        let mut file = dds_header(w, h, 0x1007, w * 4, &pf_a8r8g8b8());
        // 内存顺序 B,G,R,A：第一个像素 B=10,G=20,R=30,A=200
        file.extend_from_slice(&[10, 20, 30, 200, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 15]);

        let (pixels, dw, dh) = decode_dds(&file, 100).expect("应解码成功");
        assert_eq!((dw, dh), (w, h));
        assert_eq!(&pixels[0..4], &[30, 20, 10, 200], "B,G,R,A 应转成 R,G,B,A");
        assert_eq!(&pixels[4..8], &[3, 2, 1, 4]);
    }

    #[test]
    fn dds_decodes_bc1_solid_colour() {
        // BC1 块：两个端点都是 RGB565 纯红 (0xF800)，索引全 0 -> 全取端点 0
        let (w, h) = (4u32, 4u32);
        let mut file = dds_header(w, h, 0x81007, 8, &pf_fourcc(b"DXT1"));
        file.extend_from_slice(&[0x00, 0xF8, 0x00, 0xF8, 0, 0, 0, 0]);

        let (pixels, _, _) = decode_dds(&file, 100).expect("应解码成功");
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255], "纯红块应解成 RGBA 红");
        assert_eq!(&pixels[60..64], &[255, 0, 0, 255], "块内 16 像素应一致");
    }

    #[test]
    fn dds_decodes_bc5_two_channel() {
        // BC5 = 两个 BC4 通道块：前 8 字节给 R，后 8 字节给 G。
        // alpha0=10, alpha1=20, 索引全 0 -> 全取 alpha0
        let (w, h) = (4u32, 4u32);
        let mut file = dds_header(w, h, 0x81007, 16, &pf_fourcc(b"ATI2"));
        file.extend_from_slice(&[10, 20, 0, 0, 0, 0, 0, 0]);  // R 通道
        file.extend_from_slice(&[30, 40, 0, 0, 0, 0, 0, 0]);  // G 通道

        let (pixels, _, _) = decode_dds(&file, 100).expect("BC5 应解码成功");
        assert_eq!(&pixels[0..4], &[10, 30, 0, 255], "R/G 取两个通道的首端点，B 为 0");
    }

    #[test]
    fn dds_decodes_bc5_with_bc5u_fourcc() {
        // texconv（微软官方工具）默认写 "BC5U"，而 ddsfile 的映射表只认 "ATI2"。
        // 这条用例锁住我们自己的 FourCC 兜底：真实文件用 BC5U，手工样本用 ATI2，
        // 只测 ATI2 会漏掉这个真实的兼容问题。
        let (w, h) = (4u32, 4u32);
        let mut file = dds_header(w, h, 0x81007, 16, &pf_fourcc(b"BC5U"));
        file.extend_from_slice(&[10, 20, 0, 0, 0, 0, 0, 0]);
        file.extend_from_slice(&[30, 40, 0, 0, 0, 0, 0, 0]);

        let (pixels, _, _) = decode_dds(&file, 100).expect("BC5U 应解码成功");
        assert_eq!(&pixels[0..4], &[10, 30, 0, 255]);
    }

    #[test]
    fn dds_decodes_bc4_with_bc4u_fourcc() {
        let (w, h) = (4u32, 4u32);
        let mut file = dds_header(w, h, 0x81007, 8, &pf_fourcc(b"BC4U"));
        file.extend_from_slice(&[10, 20, 0, 0, 0, 0, 0, 0]);

        let (pixels, _, _) = decode_dds(&file, 100).expect("BC4U 应解码成功");
        assert_eq!(&pixels[0..4], &[10, 10, 10, 255], "单通道应铺到 R/G/B");
    }

    #[test]
    fn dds_rejects_truncated_block_data() {
        // 头声明 4x4，但块数据只有 4 字节（BC1 需要 8 字节）
        let mut file = dds_header(4, 4, 0x81007, 8, &pf_fourcc(b"DXT1"));
        file.extend_from_slice(&[0, 0, 0, 0]);
        assert!(decode_dds(&file, 100).is_none(), "块数据不足时应拒绝而不是 panic");
    }

    #[test]
    fn dds_rejects_pixel_count_over_limit() {
        let mut file = dds_header(4, 4, 0x81007, 8, &pf_fourcc(b"DXT1"));
        file.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        assert!(decode_dds(&file, 15).is_none(), "16 像素超过上限 15 时应拒绝");
        assert!(decode_dds(&file, 16).is_some());
    }

    #[test]
    fn dds_rejects_garbage_input() {
        assert!(decode_dds(&[], 100).is_none());
        assert!(decode_dds(&[1, 2, 3, 4], 100).is_none());
        assert!(decode_dds(&[0u8; 128], 100).is_none(), "全零头不是有效 DDS");
    }
}
