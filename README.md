# Gain Map Stego

一种基于增益图元数据的图像隐藏方法。在支持 HDR 的环境中 (如 Android 15+、iOS 18+ 以及主流浏览器)，它可以**直接展示隐藏的内容**；而在不支持的设备或软件中，它看起来只是一张**普通的图片**。

<img src="./poster.avif" width="1200" />

## 引言

`如何在一张看似普通的图像里藏点别的东西` 一直是图像玩法中最有趣的创意之一。过去，互联网上已经出现了许多巧妙的思路，其中最经典、传播最广的两种是**GIF 动图**和**幻影坦克**。

- **GIF 动图**利用平台缩略图只显示首帧的特性，将隐藏图像放在后续帧中。观众只需点开图片，就能在播放过程中看到隐藏的内容。
- **幻影坦克**则通过半透明像素的叠加原理，让图像在不同背景下显示不同内容。观众只需切换背景颜色，就能看到隐藏的部分。

这两种方法有一个共同点：**观众不需要安装任何软件，也无需学习新操作，只要用最常规的方式查看图片，就能轻松看到隐藏内容。**

最近流行起来的**光棱坦克**在此基础上进行了进化，它将表图和里图按棋盘格方式交错叠加：表图保持正常的灰阶分布，而里图被压缩到极窄的亮度区间。虽然隐藏更隐蔽，但想要看清里图就必须手动拉亮度或使用特定的后处理手段，这也显著提高了观众的使用门槛。

不过，这些方法无一例外地因为格式或像素处理的限制，**不同程度地牺牲了图片本身的色彩表现力**。那么，有没有一种方法，**既能完整保留图像的色彩，又能在常规观看流程中直接显示隐藏内容**？

有的兄弟，有的！


## ISO 21496-1

近年来 Adobe 和 Apple 在 HDR 图像领域的探索和发展最终形成了 [ISO 21496-1](https://www.iso.org/standard/86775.html) 标准，它的核心思想是：不再把 HDR 内容当作一张独立的图，而是用一张增益图 (Gain Map) 来描述如何从基础 SDR 图像重建出更高动态范围的版本。在这一标准中，图片文件由两部分组成：

- Base Image (基础图像)：一张普通的 SDR 图像，兼容所有现有平台和设备，确保即使在不支持 HDR 的环境下也能正常显示。
- Gain Map (增益图)：一张与基础图像比例相同的图像，用于描述每个像素在 HDR 条件下应当如何调整亮度和色彩。

当支持该标准的显示设备或软件读取图像时，会将基础图像与增益图结合，通过每像素计算恢复出接近原始 HDR 内容的高动态范围图像；而在不支持的环境中，解码器则会忽略增益图，仅显示基础 SDR 图像，从而实现前向兼容性。

**这一标准的制定目的当然是为了展示 HDR 内容，但是其中多通道增益图的支持让我们拥有了任意改变像素的可能。**


## 技术细节

尽管 ISO 标准不是免费的，但是 Google 的 [Ultra HDR 图片格式](https://developer.android.com/media/platform/hdr-image-format)对 ISO 21496-1 的技术细节有了非常详细的介绍，这里不再赘述。

本项目中的工具 `GainMapStego.exe` 是基于 Google 开源的 [libultrahdr](https://github.com/google/libultrahdr) 实现的，具体的编码过程可以参考 [EncodePage.xaml.cs](./GainMapStego/EncodePage.xaml.cs#L304)


## 下载和使用

请在 [Release](https://github.com/Scighost/GainMapStego/releases) 页面下载最新的 `GainMapStego.exe`，仅支持 Windows 10/11 x64 平台。

因为使用了 WinUI3 NativeAOT 发布，使用前需要安装 [Windows App Runtime](https://learn.microsoft.com/windows/apps/windows-app-sdk/downloads)。


## 示例

<img src="./GainMapStego/sample.jpg" width="400" />

[アリスあまりにもデカすぎる... (@とーます)](https://www.pixiv.net/artworks/133571506)
