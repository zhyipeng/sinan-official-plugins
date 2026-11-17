# 截图（tools.screenshot）

未发布的 0.1.0 独立官方插件，提供两个搜索入口：

- **截图**：隐藏 Sinan 主窗口，直接进入区域选择；完成后自动进入后处理。
- **截图后处理**：直接打开编辑器；页面的“区域截图”按钮也会隐藏窗口并在完成后自动返回。

全局截图热键默认 macOS `Command+Shift+A`、Windows/Linux `Ctrl+Shift+A`，可在司南设置中修改。与搜索“截图”执行相同流程，重复触发进行中的任务会被忽略；系统选区按 Esc 取消。取消、未生成图片或 PNG 无效时直接结束截图并清理临时页面，主窗口保持隐藏；只有得到有效图片才进入后处理。
后处理使用固定 **Painterro 1.2.92（MIT）**，提供箭头、矩形、椭圆、文字、画笔、区域选择、裁剪、像素化、缩放和撤销重做。文字工具在图片上点击位置后输入，点击确定或 Command/Ctrl+Enter 提交。颜色、粗细、字号、粗体/斜体和描边在工具栏调整；需要先选区再裁剪或像素化。

Command/Ctrl+Z、Shift+Z 撤销/重做，C 复制图片，S 保存；文字编辑区保留原生编辑快捷键。新截图重置历史；最多 20 次撤销，按原图大小缩减历史帧数，大图仍可能使用较多内存。文字按纯文本处理，最多 2000 个 Unicode 码点、100 行；标注落入像素，不能逐对象再次编辑。

复制按钮为“复制并关闭”，点击或 Command/Ctrl+C 在图片成功写入宿主剪贴板后隐藏所属窗口与主窗口；失败保留窗口，文字输入及选中文本保留原生复制。保存 PNG 由配套宿主校验后调用 Wails 原生保存对话框，支持选择位置；取消不写文件，不再自动保存到系统图片目录。插件不会接收到所选文件路径。

截图命令成功后继续保持隐藏，待页面读取、解码 PNG 并载入编辑器后再显示后处理；取消、无文件、空图、坏 PNG 以及页面解码失败均保持隐藏。隐藏页面未启动截图时超时清理，不再打开空编辑器。

## 平台与权限

| 平台 | 捕获实现 | 依赖和限制 |
| --- | --- | --- |
| macOS | `/usr/sbin/screencapture -i -s` | 需要系统屏幕录制授权；拒绝、取消、无文件时明确失败；未实机核验授权归属和多屏行为 |
| Windows | 系统 Windows PowerShell 5.1 + WinForms/GDI 选区覆盖层 | 不要求安装第三方模块；使用线程 DPI 感知，虚拟屏幕含负坐标；整个桌面超过 3200 万像素时拒绝；PowerShell 被组织策略禁止、无交互桌面、混合 DPI、HDR 等待验收 |
| Linux X11 | `scrot --select --freeze` | 需要 DISPLAY 及支持上述参数的 scrot |
| Linux Wayland | slurp 选区 + grim 捕获 | 仅支持具备 screencopy/layer-shell 的合成器；GNOME/KDE 的 Portal 选区未接入，不能宣称通用 Wayland 支持 |

需要 API 1 / UI Bridge 2、`clipboard.v1` 、`ui.window-execute.v1` 及 `ui.image-output.v1` 配套宿主；已发布 0.3.1 不具备新能力，不能安装在旧宿主上。manifest 使用 startHidden 及视图级 window.execute/window.show/window.hide/file.savePNG 权限，SDK 快照以原来源提交加显式补丁追溯。Linux 复制仍需要宿主对应 X11 xclip 或 Wayland wl-clipboard。manifest 后台权限仅声明现有 `clipboard.write`，不伪造截图权限字段；原生进程直接使用当前用户系统权限，独立进程不构成安全沙箱。安装必须信任原生插件。

## 数据与生命周期

原图和导出 PNG 限制 8 MiB、3200 万像素，每块原始字节 36 KiB，通过现有 command.execute 传输，不放宽 64 KiB 请求及 192 KiB 页面响应预算，不修改 CSP。页面用 Blob + createImageBitmap 解码并绘制 Canvas，不加载 data/blob URL。图像仅在内存及私有临时目录中处理，临时文件在捕获返回时删除；进程被系统强杀时不能保证临时文件清理。截图失败保留上一张原图和标注，不自动保存历史。

每插件最多一个原生选区任务，2 分钟硬预算，宿主持有最长 125 秒的隐藏执行请求，后台 Go 保持私有截图租约；15 秒无活动回收任务和上传缓存。页面退出主动取消，宿主关闭 stdio 后插件取消并等待直接捕获子进程结束；未扩展宿主对任意后代进程的回收能力。截图期间不依赖隐藏页面计时器；任务结束后宿主只恢复原活动会话窗口，撤销或替换不会唤回旧页面。

## 构建和验证

```text
node scripts/build-screenshot.mjs
node scripts/build-screenshot.mjs --all
npm test
python3 scripts/check-screenshot.py
```

输出在 `bin/targets/<os>-<arch>/screenshot`。已接入通用 build、test、package 与三平台手动 CI；源码和交叉构建不代表真实系统支持或正式发行。包由通用打包器核验 Mach-O/PE/ELF 与 .exe 入口，Windows 后台使用 GUI 子系统。

本轮在 macOS arm64 通过 121 项 JS、11 项 Python、五个后台竞态检查、截图六目标构建/静态检查及通用打包；具体结果见宿主仓库 `docs/adr/0076-hidden-window-commands.md`。未读取真实屏幕/系统剪贴板、触发授权或启动原生窗口/浏览器；Windows/Linux 原生工具执行、三端 WebView/焦点/多屏/DPI 均未实机验收。未发布、未登记商店、未修改现有安装。

## Painterro 私有适配

不使用 CDN、运行时 style 元素、字体、dom-to-image、data/blob 图片 URL 或组件自带原生剪贴板入口。构建从原包源码生成静态样式、DOM SVG 图标和 Canvas 文字渲染，原图直接由 ImageBitmap 绘入 Canvas；文件/URL 打开、图片粘贴拼接、尺寸扩展和滤镜入口未开放。复制/保存仍通过原有受控桥，宿主 CSP、资源类型与调用预算不变。原包来源和文件摘要记录在 painterro-upstream.json，构建补丁在 scripts/painterro-csp.mjs，包内含完整 MIT 许可。

本轮 127 项 JS、11 项 Python 与五个后台竞态检查通过；六目标构建、通用打包、宿主严格 UI 资源加载和包校验通过。实际组件在 linkedom/模拟 Canvas 中验证，不是浏览器或 WebView 实机验收。界面 4 个资源、149,935 字节；仍须配套本轮支持 ui.window-execute.v1 的宿主，已发布 v0.3.1 不支持。三端中文输入、CSP/图标、焦点和多屏/DPI 未实机验证，未发布或修改现有安装。

## 导入与粘贴图片

截图后处理可直接点击“导入图片”，使用宿主 Wails 原生选择对话框打开 PNG、JPEG 或 GIF（首帧）；也可在非文字编辑区域按 macOS Command+V / Windows、Linux Ctrl+V 粘贴剪贴板图片。无需先截图，新图成功载入后进入相同编辑器。取消、剪贴板无图或图片解码失败保留当前内容，文字输入区域保留普通文本粘贴。

需配套支持 ui.image-input.v1 的本轮新宿主，新增视图 file.openImage/clipboard.read 权限，旧宿主不支持。源文件上限 8 MiB、1600 万像素，宿主转为最多 4 MiB PNG 快照；剪贴板图片沿用 4 MiB/1600 万像素限制。文件路径不进入插件页面，页面只读取当前会话的私有资源 URL。支持独立导入及原生 paste 事件的无界面用例已添加，三端真实文件选择、WebView 和剪贴板交互尚未验收。
