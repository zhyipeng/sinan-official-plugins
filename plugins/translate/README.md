# 翻译

`tools.translate` 0.3.0，独立 Go 后端与隔离 HTML 页面。保留 MyMemory、Google 免费网页接口，新增使用 core 的共享 LLM 引擎。

## 使用

主输入框输入或粘贴文本后选择「翻译」，带入原文自动翻译；内容匹配权重为 0.2，不抢占应用和特定结构工具。按名称打开后可输入文本，点击「翻译」或 Command/Ctrl + Enter。目标默认简体中文，原文与常用语言相同时译成英语；语言及默认引擎在司南设置中配置，页面可临时切换。

译文支持「复制」按钮；无选区时 Command/Ctrl + C 复制完整译文，有选区时保留正常复制。编辑或切换引擎会取消旧任务，迟到结果不覆盖当前内容。原文、译文不持久化，不写日志。

## 全局 LLM

在司南「设置 → LLM」创建多套命名配置，填写 API 地址、模型、可选 API Key。设置全局默认，也可为插件覆盖默认。翻译页选择「LLM」后可选择任一全局配置，空选择跟随插件覆盖或全局默认；设置修改后可点击「刷新配置」。

core 统一管理 Key、地址、模型和 Chat Completions 请求，插件只获取配置 ID/名称，并提交提示词与原文。翻译插件不保存或接收 Key，不包含 LLM HTTP 客户端。不同插件或同一插件的不同服务可在每次调用中选择不同配置。Core 的加密自动解锁与文件保护沿用宿主机制；同时取得主密钥和密文仍可解密，原生插件不构成 OS 沙箱。

用户明确选择开发期丢弃 0.2.0 私有配置：不读取、导入或迁移，也不保留旧配置管理 UI。旧文档不参与新版本，可通过插件中心的数据管理清理。

全局配置支持 OpenAI 兼容 Chat Completions 文本接口；远程 HTTPS 或本机 loopback HTTP，不跟随重定向。协议参考 [OpenAI 官方文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。core 的调用权限、任务预算及生命周期详见宿主 ADR 0064。

## 免费引擎

- MyMemory：公开 REST API，单次最多 500 UTF-8 字节，匿名免费额度由服务端限制。超限时提示缩短或切换引擎，不自动拆分。文档：[技术规格](https://mymemory.translated.net/doc/spec.php)。
- Google：免费网页接口，非 Google Cloud 正式付费接口，受网络、限流或接口变化影响，不保证稳定性。不会自动跨服务回退。

MyMemory 与 LLM 的目标语言选择使用本地识别：单个无重音拉丁字母词优先按英语处理，其他文本使用 whatlanggo。短词、混合语言和繁简可能误判，可手动指定语言。Google 使用服务返回的语言识别。页面最多 5000 Unicode 字符，主输入框匹配最多 20000 UTF-8 字节。

## 宿主与平台

需要支持 `inputMatchScore`、UI Bridge 2 打开参数、`llm` 视图权限及共享 LLM 窄桥的新版宿主（ADR 0064），不能仅按相同开发版本号判断兼容。SDK 来源提交及逐文件哈希记录在 third_party/sinan/UPSTREAM.json，本版与来源提交字节一致。旧宿主拒绝新权限。

macOS、Windows、Linux 的 arm64/amd64 后端均可无 CGO 构建，Windows 使用 `backend/plugin.exe`。页面使用本地资源和窄桥，不放宽 CSP；需要宿主既定 WKWebView、WebView2 119+、WebKitGTK 2.40+ 基线。X11/Wayland 的窗口、焦点和输入法由宿主适配，编译不代表实机验收。

`npm test` 为无界面回归；`node scripts/build-translate.mjs --all` 构建六目标，现有打包入口生成 ZIP 与 SHA-256。未使用真实 API Key、未调用真实 LLM、未运行真实 UI。

0.3.0 已发布：[GitHub Release](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/v0.3.0)。macOS、Windows、Linux CI 构建与无界面检查通过，真实 UI 验收仍待完成；商店资料由 sinan-plugin-registry 维护。

本版所需宿主：sinan 源码 `d594882c5561f6e1f1b0d583efb1c1e34659b461` 或更新，须具备共享 LLM 窄桥；早期同为 0.1.0 的宿主不兼容。
