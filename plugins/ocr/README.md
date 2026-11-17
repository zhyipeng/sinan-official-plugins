# 文字识别 0.2.0（跨平台验证中）

状态：已发布的 0.1.0 仍仅有 macOS arm64；当前 0.2.0 新增六目标构建适配，正在进行原生验证，尚未发布新平台资产。已构建并无界面验证 macOS arm64 原生包；其他目标的后台可编译，不代表具备完整 OCR 运行能力。

## 使用范围

主输入框粘贴图片后，结果列表提供「图片文字识别」入口；打开后带入同一图片、预览原图并自动识别。普通搜索 `ocr` /「文字识别」打开时不读剪贴板，点击「识别剪贴板图片」或在页面 Cmd/Ctrl+V 粘贴图片后自动识别。结果可编辑，无选区时 Cmd/Ctrl+C 复制完整当前结果，有选区时保留正常复制。普通文本粘贴保留原行为，不监听剪贴板变化，不保存图片或历史结果。

仍无插件自己的截图选区或文件拖入。图片粘贴事件中的文件项只用于判断图片操作；实际通过宿主系统剪贴板适配读取一次快照，预览和后台都使用这份快照。读取失败、图片超限或平台剪贴板不可用会显示错误，不偷偷使用旧图继续识别。

最低宿主为司南 0.3.1，须包含 `ui.image-command.v1`、`clipboard.v1` 与 UI Bridge 2 扩展；已发布 v0.2.1 不满足要求。后台初始化核对真实能力，商店登记使用实际包含新接口的最低宿主 0.3.1。后台申请 `clipboard.read`；视图独立申请 `clipboard.read` 与 `clipboard.write`，没有网络、存储或系统输入权限。SDK 快照归一到 UPSTREAM.json 记录的本体提交及逐文件摘要。

## 任务与进程

使用 `command.execute` 和受会话图片约束的 `command.executeImage`，命令为：

| 命令 | 输入 | 结果 |
| --- | --- | --- |
| start | 空字符串 | 立即返回随机任务 ID 和状态；异步识别宿主传入的 PNG；无图片参数时保留显式剪贴板识别路径 |
| poll | 任务 ID | running / done / failed / cancelled，完成时返回文本 |
| cancel | 任务 ID | 取消并清理该任务的文本 |

页面每秒轮询一次，不在 500 ms 页面桥调用内等待 OCR。每插件最多一个在途任务和一个 worker；取消时即使页面已可操作，旧 worker 未结束前仍拒绝新的并行任务。识别限 30 秒，无轮询 5 秒后由 250 ms 清理周期取消；完成结果最多保留一分钟、最多四项。页面隐藏/关闭会尝试取消，桥已撤销时依靠租约兜底，因此不是宿主提供的即时会话撤销通知。

每次任务启动独立原生 worker。父进程通过私有 stdin 管道发送 4 字节大端长度和 PNG，之后保持写端打开；worker 监控 EOF/额外输入。父进程正常结束或被强杀时，写端关闭，worker 直接退出，包括主线程仍在 C++ 推理时。worker 另设 35 秒硬退出时限；父进程的正常取消通过 context 杀掉并 Wait 回收 worker。后台退出不依赖内核回收任意后代进程。

worker 私有管道独立于新增的会话图片 Host API。任务 ID 只用于本插件页面/后台查找，不是操作系统授权凭据或宿主会话绑定。进程隔离、白名单环境和工作管道不构成 OS 沙箱。

图片只在内存和管道内传递，页面和主搜索快照最多 PNG 4 MiB / 1600 万像素（后台旧剪贴板路径仍为 8 MiB）；输出最多 UTF-8 32 KiB，不静默截断。worker stdout、stderr 都有限额，错误不回传原生诊断或用户图片内容。临时图片不落盘；结果在后台内存短暂保留。识别和复制都可能包含标点或阅读顺序错误，应保留人工编辑。

## 引擎与构建

使用固定 RapidOCRLite v5.0.0a6（`63bef543c782a0d81db2af056e1dfba550c6dd87`）的 C ABI 和 PP-OCRv6 small 两份权重。模型和字典的 SHA-256 在构建脚本中固定；不使用其他模型。推理库从源码构建，追加严格浮点选项，关闭 Metal/Vulkan，不使用 Python、OpenCV 或 ONNX Runtime。

macOS 原生组件显式采用与宿主一致的 12.0 最低构建目标，已核对后台、worker 和动态库的 Mach-O 最低版本；本轮实际只在当前 macOS 上运行，不能把最低构建目标当作旧系统实机验收。

默认构建采用 fast-math 时，前期实验发现漏行和不稳定；严格浮点后本批样本不再复现。引擎仍为 alpha，模型来源、转换分发者、字典改动与许可已记录在 THIRD_PARTY_NOTICES.txt；更多真实样本与跨编译器验证尚未完成。

为避免改变已有插件的普通构建依赖，OCR 使用独立入口：

```sh
npm run build:ocr -- --source=/绝对路径/RapidOCRLite --models=/绝对路径/models --cmake=/绝对路径/cmake --ninja=/绝对路径/ninja
```

上游目录必须处于固定提交且无改动；构建不会覆盖它。模型目录包含 `PP-OCRv6_det_small.onnx`、`PP-OCRv6_rec_small.onnx`、`dictionary.txt`，字典从同一识别模型元数据导出。CMake、C++20 编译器及 Go/CGO 是构建依赖；模型/二进制放在 bin 下，不提交到源码。构建只允许当前目标系统与架构，不能把本机二进制重命名成其他目标。macOS 采用 12.0 构建目标，Linux 基线为 Ubuntu 24.04/glibc 2.39；Windows 使用固定 LLVM-MinGW UCRT 工具链，DLL 与所需运行库放在 worker 同目录，包内附运行库许可。

产物在 `bin/targets/<os>-<arch>/ocr`，之后可用 `node scripts/package.mjs` 的既有打包流程收集（其余插件需按已有流程准备）。打包器核对后台/worker 原生架构，保存 Unix worker 执行位，下载包和解压内容均不得超过 64 MiB。此版本已公开 Release 并登记 macOS arm64 商店资产，其他目标不登记。

## 平台边界

| 目标 | 状态与限制 |
| --- | --- |
| macOS arm64 | 完整包本地构建与模拟宿主 stdio 识别通过；真实剪贴板、页面、焦点和拆出未验收 |
| macOS amd64 | 可在对应本机尝试原生构建，本轮未构建或运行 |
| Windows arm64/amd64 | 后台交叉编译和静态检查通过；已增加 UTF-8 文件路径与 DLL 分发适配，原生 CI 待验证，不登记新资产 |
| Linux arm64/amd64 | 后台交叉编译和静态检查通过；已增加相对 RPATH 与 Ubuntu 24.04 运行库基线，原生 CI 待验证，不登记新资产 |

三端共用任务与管道实现，Windows 子进程显式隐藏控制台。Linux 的剪贴板由宿主区分 X11/xclip 与 Wayland/wl-clipboard；缺少会话或工具会返回错误。OCR 引擎本身不调用桌面协议；不将 X11 成功视为 Wayland 截图能力。

## 验证

- `npm test` 包含页面状态/迟到任务/复制失败测试，以及后台任务、租约、超时、输出预算和假 worker 进程测试；不访问系统剪贴板。
- `node scripts/check-ocr-backend.mjs --all` 检查六目标后台编译和静态检查，产物位于独立 `bin/ocr-backends`，不会伪装成可发行的 OCR 包。[三平台 CI](https://github.com/zhyipeng/sinan-official-plugins/actions/runs/43830703763) 已通过该检查。
- `tests/stdio-smoke.py` 使用模拟宿主 Host API 和合成 PNG，对本地真实后台与真实 worker 验证 11 图输出、单任务限制、非图片拒绝、正常取消，以及强杀后台后 worker 退出；`--sandbox` 可在 macOS 系统级禁网运行。
- 真正的桌面 UI、系统剪贴板、WebView、主题、输入法、拆出和截图权限未验收。没有自动安装到用户日常插件目录。

更多前期数据见 [Sinan 原生验证报告](../../../sinan/docs/research/ocr-native-validation.md)。


本轮快照 URL 只属于当前视图，新图成功读取后旧 URL 失效；原图资源沿用每会话 256 请求 / 8 MiB 累计交付限制，耗尽后须重新打开插件。主搜索图片识别不会重读系统剪贴板。

本轮无界面结果：官方 108 项 JS/3 项打包及四个后台竞态检查通过；六目标后台 build/vet 通过。模拟宿主的真实 worker 在系统级禁网下通过 11 张合成图、传入快照独立于剪贴板、取消及后台退出回收验证；页面行为使用 VM 假 DOM 测试，未启动真实 WebView 或读取真实剪贴板。


[正式发行包](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.ocr-v0.1.0) 已回下载核对摘要、清单、模型、原生架构、执行位、图标与许可。最低宿主为 [Sinan 0.3.1](https://github.com/zhyipeng/sinan/releases/tag/v0.3.1)，0.3.0 已取消发行；使用原始源码标签文档时，以发行说明和商店中的 0.3.1 最低版本为准。没有修改既有发行资产。


## 六目标原生验证

手动触发 `.github/workflows/ocr.yml`，分别使用 macOS、Windows、Linux 的 arm64/amd64 原生 runner。`scripts/prepare-ocr.py` 获取固定源提交、模型和字典，Windows 工具链为 LLVM-MinGW 20261104 UCRT（按宿主架构选包，并核对固定 SHA-256）。不会覆盖已有不匹配的源目录或输入文件。

`node scripts/ocr-ci.mjs` 依次构建、仅打包该 OCR 目标，并将实际 ZIP 解压到含空格/中文的临时目录，使用同一批 11 张合成 PNG 验证真实 worker、输入快照、取消和父进程退出回收。macOS 额外用系统机制禁网；Windows/Linux 不将未执行的 OS 级禁网描述为验证通过。各目标上传 ZIP、摘要和验证 JSON，不自动发布或修改商店记录。

模型和字典路径仅在构建私有副本中修补为 `std::filesystem::u8path`，原始上游不变；保留严格浮点和 CPU SIMD 运行时分派。Windows 只从对应目标工具链目录收集实际导入的非系统 DLL，缺失或未知依赖明确失败。Linux/macOS 的 worker 使用相对于可执行文件的库路径，重定位测试不依赖 PATH/LD_LIBRARY_PATH/DYLD_LIBRARY_PATH。

待六目标原生构建和合成图验证完成后，再为真实资产记录支持范围；已有 0.1.0 发行包与商店记录保持不变。真实 WebView、输入法、权限和系统剪贴板仍需另行验收。


跨 ISA 验证记录：终端样本在 ARM 基准中把 `go test ./...` 识别为 `go test /...`，x86 AVX2 路径识别为 `go test ./..`，均漏一个点。报告保留两种实际输出；以源文本编辑距离和字符差均不劣于既有基准、每图两次稳定为质量门槛，不强制复制某一架构的既有识别错误，也不将这种合成测试描述为完美准确率。Windows worker 配合无控制台子系统与 CREATE_NO_WINDOW 避免额外 conhost，回收检查允许最多 5 秒的系统进程枚举收敛，但不忽略残留进程。


Windows 控制台补充：仅设置 HideWindow/CREATE_NO_WINDOW 仍可能为控制台子系统程序分配后台 conhost。OCR 后台和 worker 均以 `-H=windowsgui` 构建，不创建 GUI 窗口，仍通过显式继承的 stdio 管道通信；打包器校验两者为 PE32+ GUI 子系统。保留零残留子进程检查，不将 conhost 从断言中静默过滤。


原生验证全部成功后，可手动运行 `.github/workflows/ocr-publish.yml`，填入对应 run ID。发布 job 独立取得写权限，只解析六份 ZIP 和验证报告，不执行其中程序；按原生 run 的源码提交创建标签并发布，核对远端摘要后提供发布身份 JSON。不是普通 commit/tag 自动发布；已公开版本以及摘要不匹配的草稿文件都拒绝覆盖。商店登记仍需使用核验后的实际 Release/Asset ID。
