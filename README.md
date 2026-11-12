# Sinan Official Plugins

Sinan 官方插件源码仓库。

## 包含插件

- **JSON 工具**（`tools.json`，0.3.0）：基于 `vanilla-jsoneditor` 的纯前端插件，当前先提供 JSON 格式化、压缩、语法高亮、撤销/重做及错误位置提示。数值由 `lossless-json` 处理，保留大整数、小数精度与指数写法；重复键会报错，避免静默丢失数据。

## 开发与构建

需要 Node.js 22.12+、npm；ZIP 打包需要 Python 3，无 Go 后端。

```bash
make setup
make test
make package
```

构建目录为 `bin/plugins/json-tool`，平台无关 ZIP 为 `dist/json-tool-0.3.0-universal.zip`，旁边生成 SHA-256 文件。通过司南插件管理或 CLI 安装、升级；构建本身不修改已有安装，不发布商店版本。

## 使用

粘贴 JSON 后点击“格式化”或“压缩”。`⌘/Ctrl + Enter` 格式化，`⌘/Ctrl + Shift + Enter` 压缩。默认两空格缩进，格式错误保留原文。

插件沿用 `tools.json` 与原有 `{text}` 草稿，升级后可继续读取；草稿通过宿主私有 storage 保存，冲突后保留当前输入并暂停自动写入，可显式载入已存草稿。宿主提供返回和拆出按钮，页面只包含业务操作。当前先使用文本模式，树形、表格和查询功能未开放。

## 隔离页面适配

依赖全部锁定并本地打包，无 CDN、网络请求或后端命令；仅声明 storage，继续使用 UI Bridge 2。构建时提取 `vanilla-jsoneditor` 的组件 CSS 为本地文件，CodeMirror 使用 CSSOM constructed stylesheet，保持宿主 CSP 不变；需要支持该能力的 WebKit（Safari 16.4+）。该适配针对锁定版本，升级依赖必须核对样式提取与资源预算。

每次构建检查资源数量、单文件 512 KiB 和总量 2 MiB 限制。SDK 使用 `third_party/sinan/UPSTREAM.json` 记录的快照。`make test` 仅运行无界面业务测试，真实桌面、主题和编辑器交互仍需单独验收。

## 主输入框识别

需要支持声明式 `inputMatchers` 和 UI Bridge 2 `launch.get` 的新版司南宿主（ADR 0043）。主输入框中不超过 64 KiB 的合法 JSON 对象、数组会显示“JSON 工具”，选中后原文传入编辑器；数字、字符串、布尔值、null 和非法 JSON 不触发该内容入口。按名称打开仍恢复草稿；带入的文本仅在实际编辑或格式化后保存，不因打开结果自动覆盖旧草稿。

SDK 快照已归一到 `UPSTREAM.json` 记录的本体提交，逐文件记录 SHA-256，与该提交的源码字节一致。
