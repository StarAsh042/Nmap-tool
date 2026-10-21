# test/fixtures/dds — 真实 DDS 固件

这些 `.dds` 文件由 **微软 texconv（DirectXTex）** 生成，用途是验证我们的 wasm
解码器在**真实文件**上的行为。

## 它们为什么存在

手工构造的测试样本只能验证「我的构造对不对」。在真实文件上才发现过四个问题，
每一个都藏在「真实工具会怎么写」而不是「规范怎么写」里：

1. `BC5U` FourCC——`ddsfile` 只认 `ATI2`，真实文件直接解码失败
2. `texture2ddecoder` 在 wasm32 上把 48 位索引截断成 32 位，
   每个 4×4 块的第 11–15 个像素解错（64 位主机上的单元测试发现不了）
3. BC4 单通道没有铺成灰度
4. BC1 没有处理 1 位透明模式

## 目录结构

```
<格式>/decoded.dds        texconv 从源图压缩出的 DDS
ref_<格式>/reference.dds  texconv 把上面的 DDS 自己展开成的 RGBA8
```

`reference.dds` 是**参照实现的行为**，不是「正确答案」的绝对标准。我们以它
为基准逐一比对，目前**七种格式全部逐字节一致**。

BC1/BC2/BC3 曾经差 ±1，原因是颜色插值写成了「先展开成 8 位再插值」。
DirectXTex 的做法是先把 RGB565 乘倒数常量归一化到 0..1、在浮点域插值、
最后 `v*255+0.5` 截断——照抄源码后差值归零。这类细节猜不出来，只能读源码。

## 重新生成

需要本机装有 texconv（Windows，可从 `github.com/microsoft/DirectXTex` 的
release 下载单个 `texconv.exe`，无需安装）。然后执行：

```
node scripts/verify-dds.mjs --regenerate
```

该脚本会用仓库内的 `tex_ss_5027_bs_face_n.png` 重新生成全部固件并跑一遍比对。
未指定 `--regenerate` 时只比对，不覆盖文件。

## 已知局限

- 只覆盖 texconv 这一种工具的输出。其他工具（Compressonator、Photoshop 插件、
  SDK 编码器）的头部写法可能不同。
- 未覆盖 BC6H、立方体贴图、纹理数组。
