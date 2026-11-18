# 截图（tools.screenshot）

0.3.0 面向 macOS 和 Windows，支持 Apple Silicon、Intel x64 和 Windows ARM64。使用「截图」搜索命令或全局快捷键开始。macOS 默认 Command+Shift+A，Windows 默认 Ctrl+Shift+A，可在 Sinan 设置中修改。

## 遮罩

- 可在任一显示器开始框选，单个选区限定在开始框选的屏幕。
- 默认优先匹配光标下的窗口内元素。Tab 切换整窗和元素模式，滚轮切换元素候选。单击采用高亮候选，拖动自由框选。选区可移位、拖边调整或用方向键微调。
- 遮罩工具栏支持箭头、矩形、文字和马赛克。箭头、矩形和文字可以使用预设色或输入十六进制颜色。用选区工具选中标注后可拖动或改色，支持撤销。
- 复制或保存后关闭遮罩。OCR 通过可选的 `tools.ocr` 0.3.0 或更新版本识别标注后的 PNG。OCR 无法打开时，可在错误提示中复制本次截图或打开插件中心。
- Esc 或右键取消，Return 复制。Windows 使用 Ctrl+C、Ctrl+S、Ctrl+Z，macOS 使用 Command 组合键。

## 平台

| 平台 | 实现及边界 |
| --- | --- |
| macOS 14+ | ScreenCaptureKit 和 AppKit 原生遮罩。屏幕录制与元素吸附的辅助功能授权由 macOS 管理，元素不可用时可吸附窗口或自由框选。 |
| macOS 12–13 | 系统区域截图，成功后直接复制到剪贴板。 |
| Windows 10 1703+ / Windows 11 | 随包分发的 Win32 原生 GUI 程序。各屏以物理像素抓帧，遮罩使用 Per-Monitor DPI v2；UI Automation 在后台查询目标窗口内的元素边界。应用未暴露可用元素或系统限制访问时回退到整窗。 |
| Linux | 0.3.0 起停止截图插件支持与发行，已发行的 0.1.0 为历史版本。 |

原图限单屏 3200 万像素、全部屏幕合计 9600 万像素。PNG 复制与保存上限 8 MiB，OCR 交接上限 4 MiB。原生进程仅将 OCR 图片或旧版 macOS 截图暂存到私有临时目录。宿主版本须为 0.4.0 或更新，复用现有剪贴板、隐藏任务和插件交接能力。

0.3.0 移除了独立的「截图后处理」入口及其图片编辑、导入和粘贴流程。正常截图的标注、保存和复制均在原生遮罩内完成。

## 开发构建

```text
node scripts/build-screenshot.mjs
node scripts/build-screenshot.mjs --all
python3 scripts/check-screenshot.py
```

macOS 目标需要 Xcode 命令行工具及 macOS 14 或更新 SDK。从 macOS 或 Windows 构建 Windows 辅助程序时，脚本使用按 SHA-256 固定的 LLVM-MinGW，首次构建需要 Python 3.12 和网络。已有该工具链时可设置 `SINAN_SCREENSHOT_LLVM_MINGW` 指向其目录。Windows 插件的运行不依赖开发工具链。

[0.3.0 发行](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.screenshot-v0.3.0) 已公开，四份 ZIP 已回下载核对。macOS arm64 和 Windows x64 通过无界面检查及模拟 Host API 的 stdio 测试，Windows x64 原生绘制检查通过，Windows ARM64 已交叉构建。真实桌面的遮罩、焦点、多屏、输入法及元素命中待验收。

[0.1.0 历史发行](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.screenshot-v0.1.0)
