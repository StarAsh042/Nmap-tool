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

    let dxgi = dds.get_dxgi_format();
    let d3d = dds.get_d3d_format();
    let data = dds.get_data(0).ok()?;
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
    // 数据不足时直接拒绝：解码器按块数切片，长度不够会 panic，
    // 而 panic 在 wasm 里等于整个模块抛异常，不如在这里返回失败
    if data.len() < blocks_x * blocks_y * bsize {
        return None;
    }

    let mut words = vec![0u32; pixel_count];
    let (w, h) = (width as usize, height as usize);
    let ok = match fmt {
        DxgiFormat::BC1_UNorm | DxgiFormat::BC1_UNorm_sRGB => {
            texture2ddecoder::decode_bc1(data, w, h, &mut words).is_ok()
        }
        DxgiFormat::BC2_UNorm | DxgiFormat::BC2_UNorm_sRGB => {
            texture2ddecoder::decode_bc2(data, w, h, &mut words).is_ok()
        }
        DxgiFormat::BC3_UNorm | DxgiFormat::BC3_UNorm_sRGB => {
            texture2ddecoder::decode_bc3(data, w, h, &mut words).is_ok()
        }
        DxgiFormat::BC4_UNorm | DxgiFormat::BC4_SNorm => {
            texture2ddecoder::decode_bc4(data, w, h, &mut words).is_ok()
        }
        DxgiFormat::BC5_UNorm | DxgiFormat::BC5_SNorm => {
            texture2ddecoder::decode_bc5(data, w, h, &mut words).is_ok()
        }
        DxgiFormat::BC7_UNorm | DxgiFormat::BC7_UNorm_sRGB => {
            texture2ddecoder::decode_bc7(data, w, h, &mut words).is_ok()
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
