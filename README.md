# Sinan Official Plugins

Sinan 官方插件源码仓库。

## 包含插件

- **JSON 工具**（`tools.json`，0.4.4）：基于 `vanilla-jsoneditor` 的纯前端插件，当前先提供 JSON 格式化、压缩、语法高亮、撤销/重做及错误位置提示。数值由 `lossless-json` 处理，保留大整数、小数精度与指数写法；重复键会报错，避免静默丢失数据。

## 开发与构建

需要 Node.js 22.12+、npm、Go 1.26 和 Python 3（macOS/Linux 命令为 python3，Windows 为 python）。JSON 工具仍为纯前端，剪贴板使用 Go 后端。

```bash
make setup
make test
make package
```

JSON 构建目录为 `bin/plugins/json-tool`，剪贴板按目标输出到 `bin/targets/<os>-<arch>/clipboard`。`npm run package` 生成 JSON 工具六个平台包和本机目标的剪贴板包；在 macOS 执行 `npm run package:all` 可生成两个插件的全部十二个包。文件名为 `dist/<id>-<版本>-<darwin|windows|linux>-<arm64|amd64>.zip`，各自附带 SHA-256；`dist/assets.json` 记录目标、版本和摘要。构建本身不修改已有安装，不发布商店版本。

## 使用

粘贴 JSON 后点击“格式化”或“压缩”。`⌘/Ctrl + Enter` 格式化，`⌘/Ctrl + Shift + Enter` 压缩。默认两空格缩进，格式错误保留原文。

插件沿用 `tools.json` 与原有 `{text}` 草稿，升级后可继续读取；草稿通过宿主私有 storage 保存，冲突后保留当前输入并暂停自动写入，可显式载入已存草稿。宿主提供返回和拆出按钮，页面只包含业务操作。当前先使用文本模式，树形、表格和查询功能未开放。

## 隔离页面适配

依赖全部锁定并本地打包，无 CDN、网络请求或后端命令；仅声明 storage，继续使用 UI Bridge 2。构建时提取 `vanilla-jsoneditor` 的组件 CSS 为本地文件，CodeMirror 使用 CSSOM constructed stylesheet，保持宿主 CSP 不变；需要支持该能力的现代引擎：macOS Safari 16.4+ 对应 WebKit、Windows WebView2 119+、Linux WebKitGTK 2.40+。该适配针对锁定版本，升级依赖必须核对样式提取与资源预算。

每次构建检查资源数量、单文件 512 KiB 和总量 2 MiB 限制。SDK 使用 `third_party/sinan/UPSTREAM.json` 记录的快照。`make test` 仅运行无界面业务测试，真实桌面、主题和编辑器交互仍需单独验收。

## 主输入框识别

需要支持声明式 `inputMatchers` 和 UI Bridge 2 `launch.get` 的新版司南宿主（ADR 0043）。主输入框中不超过 64 KiB 的合法 JSON 对象、数组会显示“JSON 工具”，选中后原文传入编辑器；数字、字符串、布尔值、null 和非法 JSON 不触发该内容入口。按名称打开仍恢复草稿；带入的文本仅在实际编辑或格式化后保存，不因打开结果自动覆盖旧草稿。

SDK 快照已归一到 `UPSTREAM.json` 记录的本体提交，逐文件记录 SHA-256，并以记录的来源提交及显式增量补丁追溯源码。

## 表达式筛选

工具栏下方输入表达式，停止输入 180 ms 后自动筛选，直接替换编辑器内容，无需 Enter；Enter 或“筛选”按钮可立即应用。在编辑器中按 `⌘/Ctrl + Z` 撤销。同一轮表达式始终基于筛选前的完整 JSON 计算，清空表达式恢复原文及其格式。暂时无效的表达式保留上次成功结果；输入法组合期间不执行筛选。直接编辑（含撤销/重做）、格式化、压缩、清空或载入草稿会结束本轮筛选并清空表达式，后续不会用旧原文覆盖新内容。成功应用沿用草稿保存流程。

支持 `.key.subkey`、`[0][1]`、`this.items`、`.map(x => x.val)`、`.filter(x => x.enabled && x.val >= 2)`，可链式调用。支持回调索引参数、数组/对象投影、条件表达式、`??` 空值回退和严格比较，数值解析和比较保持大整数精度。

这是 JSON 数据表达式子集，使用 Acorn 解析并解释，不执行任意 JavaScript；没有 eval、Function、全局对象、任意函数、赋值、循环或语句块。表达式最多 1024 字节，源文档和结果各最多 1 MiB，求值及输出检查共用 100,000 步预算，嵌套最多 48 层。图片、宿主桥和 CSP 无变更。

插件图标通过 manifest 的可选 `icon` 声明包内文件；JSON 工具的 `icon.svg` 随构建输出。需要支持该字段的新版 Sinan 宿主。缺少图标时宿主显示插件名首字。

## 发布到插件商店

执行 `npm test`、`npm run package`；macOS 可用 `npm run package:all` 构建全矩阵。JSON 工具为纯前端，六种目标复用源码；不同构建系统的文本换行可能影响包摘要，以每个实际发行资产为准。剪贴板原生入口按 OS/CPU 独立构建，打包时检查 Mach-O / PE / ELF 头，拒绝错标。Windows 的入口为 `backend/plugin.exe`，其余为 `backend/plugin`，ZIP 写入固定文件时间及 POSIX 执行位。

支持目标：macOS、Windows、Linux 的 ARM64 与 AMD64。剪贴板 0.2.0 起系统适配移到宿主，插件后端为纯 Go，可交叉构建六目标；macOS 宿主仍需要 Cocoa/CGO。Windows PowerShell 可直接用上述 npm/Node 命令，不需要 Make 或 shell 通配符。单个目标例如 `node scripts/build-clipboard.mjs --target=windows-amd64`；同一命令可指定多个 `--target`。

`.github/workflows/platforms.yml` 为手动触发的三系统全矩阵构建（无界面测试、两 CPU 目标并上传安装包），不访问真实剪贴板或启动窗口。commit/PR 不再自动触发，以节省 Actions 用量。编译和数据测试不代替真实 WebView、热键、焦点和跨应用输入验收。

提交源码后，以插件 ID 和清单版本创建 `<plugin-id>-v<版本>` 标签（例如 `tools.calendar-v0.1.2`）。推送该标签会触发 `.github/workflows/release.yml`：在 macOS 运行无界面测试、构建六目标包，并以草稿方式创建并发布对应 GitHub Release（只新增该版本资产，不覆盖已发布版本；已存在的非草稿 Release 会拒绝）。OCR 完整包依赖固定上游源码与模型，仍需按 `plugins/ocr/README` 本地构建后手动上传，CI 会显式失败。发布后仍需人工取得真实 Release ID、Asset ID，将版本、源码提交、兼容协议、宿主最低版本、平台、大小、SHA-256 和下载地址登记到 `sinan-plugin-registry/plugins/<plugin-id>/plugin.json` 的 releases 中，状态设为 published。目录 main 更新后商店刷新即可安装。CI 只发布 GitHub Release 资产，不修改商店，避免把构建产物直接视为已审核版本。

## 剪贴板插件

新增 **剪贴板**（`tools.clipboard` 0.1.1），使用 Go 原生后台进程和隔离 HTML 界面，支持文本/图片历史、本地持久化及 `⌘/Ctrl + Shift + V` 呼出与自动粘贴。需要新版宿主的 ADR 0056 接口；安装时确认原生信任。构建现在还需要 Go 1.26；`npm run package` 附加本机目标的剪贴板 ZIP，macOS 的 `npm run package:all` 包含全部六目标。功能、平台依赖与限制见 [剪贴板说明](plugins/clipboard/README.md)。SDK 快照已归一到 UPSTREAM.json 记录的本体提交，逐文件摘要与记录的来源及显式补丁一致。

## 翻译插件

**翻译**（`tools.translate` 0.3.0）支持 MyMemory、Google 免费网页接口与 core 共享 LLM。主输入框带入原文，页面可切换语言、引擎及全局 LLM 配置；支持复制按钮与 Command/Ctrl + C，内容匹配基础分为 0.2。

LLM 在司南全局设置统一配置，插件只获取 ID/名称、提交提示词与输入，不管理 Key 或 HTTP。支持多插件复用和同插件不同服务选择不同配置；0.2.0 私有配置直接忽略，不提供迁移。需配套支持宿主 ADR 0064 的新构建。

构建、测试与打包入口继续在既有插件后处理翻译，六目标产物不代表已发布或实机验收。详情见[翻译说明](plugins/translate/README.md)。SDK 快照已归一到所需宿主提交，记录逐文件 SHA-256；本版无额外补丁。

翻译 0.3.0 已发布至 [GitHub Release](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/v0.3.0)，六目标包与 SHA-256 已上传；平台 CI 构建和无界面检查通过，实机 UI/真实 LLM 调用未验收。需新版宿主源码 d594882 或更新。

## 日历插件

新增 **日历**（`tools.calendar` 0.1.2），基于 React DayPicker 的纯前端月历，支持农历、传统节日、节气和中国大陆放假/补班标记，不管理日程。支持年月跳转、今天、中文键盘导航和宿主主题。假期数据离线收录 2004–2027 年；范围外显示未收录，不推测调休。

`npm run build` / `build:all` 在现有插件后追加日历构建，`npm run package` / `package:all` 追加六目标日历 ZIP。CI 同步接入，不自动安装或发布；详见[日历说明](plugins/calendar/README.md)。

日历 0.1.2 已[正式发布](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/v0.1.2)，六目标包与摘要已上传，[三平台 CI](https://github.com/zhyipeng/sinan-official-plugins/actions/runs/43791121005) 无界面检查与构建通过，实机 UI 未验收。版本从 0.1.2 首发以避开仓库已有的 v0.1.0 / v0.1.1 标签。

## 插件独立版本与发布标签

每个插件独立维护 `manifest.version`，同一仓库内允许多个插件同时为 0.1.0。新发布统一使用 `<plugin-id>-v<version>`，例如 `tools.calendar-v0.1.0` 与 `tools.clipboard-v0.1.0`，资产文件名和包版本不变。运行 `npm run release:tag -- calendar`（或 `node scripts/release-tag.mjs calendar`）从实际清单取得正确标签，再用于创建 Git 标签及 GitHub Release。标签生成不会推送、发布或修改安装。

宿主和登记校验器继续兼容历史 `v<version>`，已发布标签/资产/目录记录保持不变。目录按插件 ID 去重版本，同一插件的同一版本仍不可覆盖或重复登记。命名空间标签需要支持此扩展的新宿主，旧宿主会拒绝包含新标签的目录快照；更新宿主前不要迁移现有记录。日历已发行的 0.1.2 不降级，后续版本不再因其他插件标签占用而跳号。

## 计算插件

新增 **计算**（`tools.calculator` 0.1.0）：主输入框识别完整计算表达式，结果列表直接展示数值，选中执行后复制；独立稿纸页面支持多行即时计算、结果复制、新建/删除、历史切换与本地自动保存。支持四则运算、括号、百分比、乘方及常用函数，精确处理十进制四则运算。

构建、测试、六目标打包和三系统 CI 在已有插件后追加处理，不修改宿主协议或 SDK。Linux 复制分别依赖 X11 的 xclip、Wayland 的 wl-copy，缺失时明确报错。六目标交叉构建与无界面回归不代表实机 UI 验收或正式发布，详见[计算说明](plugins/calculator/README.md)。


## 官方图标风格

全部官方插件统一为浅色圆角底板与蓝色线条图形，画布、配色、线宽和商店资料同步要求见 [开发约定](AGENTS.md#官方插件图标规范)。图标更新随后续正常版本发布，不覆盖已有发行包；已安装的旧包保留原图标，直至升级。


## 统一图标发行

JSON 工具 0.4.4、剪贴板 0.1.2、翻译 0.3.1、日历 0.1.3 使用统一浅底蓝线图标；计算 0.1.0 首次上架同一风格。使用插件独立标签发布，保留历史发行包。三平台 CI、真实资产和商店登记分别核对；实机 UI 验收仍未执行。

五个版本均已正式发布：

| 插件 | 版本 / Release |
| --- | --- |
| JSON 工具 | [0.4.4](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.json-v0.4.4) |
| 剪贴板 | [0.1.2](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.clipboard-v0.1.2) |
| 翻译 | [0.3.1](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.translate-v0.3.1) |
| 日历 | [0.1.3](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.calendar-v0.1.3) |
| 计算 | [0.1.0](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.calculator-v0.1.0) |

[三平台 CI](https://github.com/zhyipeng/sinan-official-plugins/actions/runs/43799988731) 无界面测试与构建通过；每个插件均上传三系统 arm64/amd64 共六个 ZIP 和摘要。资产版本、图标、原生入口架构与 GitHub SHA-256 已核验，商店登记使用真实 Release/Asset ID。新标签需要支持独立发布标签的司南源码 c518ca5 或更新；真实桌面交互仍未验收。

## 共享剪贴板 0.2.0

计算、剪贴板插件的系统读写统一使用司南宿主 API，两个插件版本均为 0.2.0。最低宿主版本为 0.2.1，并在初始化核对 `clipboard.v1` 能力；历史发行包和商店记录保持不变。Go 与页面 SDK 快照来自 UPSTREAM.json 所指的本体提交，文件哈希已同步。新发行使用 `tools.calculator-v0.2.0`、`tools.clipboard-v0.2.0` 标签，[三平台无界面 CI](https://github.com/zhyipeng/sinan-official-plugins/actions/runs/43806605442) 与六目标包核验均已通过，两个 Release 已公开，最低要求 [Sinan v0.2.1](https://github.com/zhyipeng/sinan/releases/tag/v0.2.1)；本体六目标原生构建与无界面检查也已通过。真实系统剪贴板与 UI 尚未验收。


## 离线文字识别

新增 `tools.ocr` 0.1.0，首发准备仅提供 macOS arm64 完整包，最低宿主 0.3.0。主输入框粘贴图片后打开匹配入口，会带入图片、显示原图并自动识别；插件内 Cmd/Ctrl+V 粘图识别，Cmd/Ctrl+C 复制可编辑结果。识别和模型均在本地，不需要 Python 或联网。

完整原生包、合成图片识别及 worker 回收已在 macOS arm64 无界面验证；Windows/Linux 仅后台编译，尚无完整包，真实系统剪贴板与三端 WebView 未验收。来源与构建方法见[OCR 说明](plugins/ocr/README.md)。SDK 快照已归一到新增会话图片接口的本体提交，商店只登记真实发布资产。
