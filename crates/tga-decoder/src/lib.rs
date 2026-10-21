//! TGA 解码器 —— 编译为 WebAssembly 供浏览器调用。
//!
//! 为什么需要它：浏览器原生不支持 TGA 解码，而手写一个覆盖 RLE / 色表 /
//! 16 位色深 / 原点翻转的 TGA 解析器容易在边角情况上出错。`image` crate 的
//! TGA 解码器经过长期使用，只开 `tga` 特性时体积也可控。
//!
//! 对外只有三个函数，全部走裸 C ABI（不用 wasm-bindgen）：
//!   nm_alloc(len)                    分配输入缓冲，返回指针
//!   nm_decode_tga(ptr, len, max_px)  解码，返回结果头指针
//!   nm_free(ptr, len)                释放输入缓冲
//!
//! 结果头是 4 个 u32：[像素指针, 字节数, 宽, 高]，失败时全为 0。
//! 像素数据留在 wasm 线性内存里由 JS 直接读走，避免再拷一次。
//!
//! ⚠ 调用方必须注意：任何一次内存分配都可能触发 wasm 内存增长，增长会让
//! JS 侧已持有的 ArrayBuffer 视图全部失效（buffer 被 detach）。因此每次
//! 调用之后都要重新取 `memory.buffer`。

use std::slice;

/// 解码结果暂存在这里，直到下一次解码覆盖它。
///
/// 之所以用静态变量而不是把指针交给 JS 管理：JS 无法为 wasm 里的 Vec 分配
/// 生命周期，只能由 wasm 自己持有，等下一次调用时释放。
static mut OUTPUT: Option<Vec<u8>> = None;

/// 结果头：[像素指针, 字节数, 宽, 高]
static mut RESULT: [u32; 4] = [0, 0, 0, 0];

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

/// 纯函数形式的解码实现，便于单元测试直接调用。
///
/// 返回 `(RGBA 像素, 宽, 高)`；失败返回 `None`。
fn decode_bytes(input: &[u8], max_pixels: u32) -> Option<(Vec<u8>, u32, u32)> {
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

/// 取结果头的指针。
///
/// 用 `addr_of!` 而不是 `RESULT.as_ptr()`：后者会对 `static mut` 创建共享引用，
/// 这在 Rust 2024 中已不合法（`static_mut_refs`）。这里本来只需要一个地址。
fn result_ptr() -> *const u32 {
    core::ptr::addr_of!(RESULT).cast::<u32>()
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

        let input = slice::from_raw_parts(ptr, len);
        let (pixels, width, height) = match decode_bytes(input, max_pixels) {
            Some(v) => v,
            None => return result_ptr(),
        };

        RESULT = [pixels.as_ptr() as u32, pixels.len() as u32, width, height];
        OUTPUT = Some(pixels);
        result_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn decodes_uncompressed_24bit() {
        // 2x2：纯红、纯绿、纯蓝、白（TGA 存的是 BGR）
        let tga = make_tga(2, 2, &[[0, 0, 255], [0, 255, 0], [255, 0, 0], [255, 255, 255]]);
        let (pixels, w, h) = decode_bytes(&tga, 100).expect("应解码成功");
        assert_eq!((w, h), (2, 2));
        assert_eq!(pixels.len(), 2 * 2 * 4);
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255], "BGR(0,0,255) 应解成 RGBA 红");
        assert_eq!(&pixels[4..8], &[0, 255, 0, 255], "BGR(0,255,0) 应解成 RGBA 绿");
        assert_eq!(&pixels[8..12], &[0, 0, 255, 255], "BGR(255,0,0) 应解成 RGBA 蓝");
        assert_eq!(&pixels[12..16], &[255, 255, 255, 255]);
    }

    #[test]
    fn rejects_pixel_count_over_limit() {
        let tga = make_tga(2, 2, &[[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
        assert!(decode_bytes(&tga, 3).is_none(), "4 像素超过上限 3 时应拒绝");
        assert!(decode_bytes(&tga, 4).is_some(), "上限恰好等于像素数时应通过");
    }

    #[test]
    fn rejects_garbage_input() {
        assert!(decode_bytes(&[], 100).is_none());
        assert!(decode_bytes(&[1, 2, 3, 4, 5], 100).is_none());
        assert!(decode_bytes(&[0u8; 18], 100).is_none(), "全零头是无效图像");
    }
}
