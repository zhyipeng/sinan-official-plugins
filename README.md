# Sinan Official Plugins

Sinan 官方插件源码仓库。

## 包含插件

- **JSON 工具**（`tools.json`，0.4.1）：基于 `vanilla-jsoneditor` 的纯前端插件，当前先提供 JSON 格式化、压缩、语法高亮、撤销/重做及错误位置提示。数值由 `lossless-json` 处理，保留大整数、小数精度与指数写法；重复键会报错，避免静默丢失数据。

## 开发与构建

需要 Node.js 22.12+、npm；ZIP 打包需要 Python 3，无 Go 后端。

```bash
make setup
make test
make package
```

构建目录为 `bin/plugins/json-tool`，平台无关 ZIP 为 `dist/json-tool-0.4.1-universal.zip`，旁边生成 SHA-256 文件。通过司南插件管理或 CLI 安装、升级；构建本身不修改已有安装，不发布商店版本。

## 使用

粘贴 JSON 后点击“格式化”或“压缩”。`⌘/Ctrl + Enter` 格式化，`⌘/Ctrl + Shift + Enter` 压缩。默认两空格缩进，格式错误保留原文。

插件沿用 `tools.json` 与原有 `{text}` 草稿，升级后可继续读取；草稿通过宿主私有 storage 保存，冲突后保留当前输入并暂停自动写入，可显式载入已存草稿。宿主提供返回和拆出按钮，页面只包含业务操作。当前先使用文本模式，树形、表格和查询功能未开放。

## 隔离页面适配

依赖全部锁定并本地打包，无 CDN、网络请求或后端命令；仅声明 storage，继续使用 UI Bridge 2。构建时提取 `vanilla-jsoneditor` 的组件 CSS 为本地文件，CodeMirror 使用 CSSOM constructed stylesheet，保持宿主 CSP 不变；需要支持该能力的 WebKit（Safari 16.4+）。该适配针对锁定版本，升级依赖必须核对样式提取与资源预算。

每次构建检查资源数量、单文件 512 KiB 和总量 2 MiB 限制。SDK 使用 `third_party/sinan/UPSTREAM.json` 记录的快照。`make test` 仅运行无界面业务测试，真实桌面、主题和编辑器交互仍需单独验收。

## 主输入框识别

需要支持声明式 `inputMatchers` 和 UI Bridge 2 `launch.get` 的新版司南宿主（ADR 0043）。主输入框中不超过 64 KiB 的合法 JSON 对象、数组会显示“JSON 工具”，选中后原文传入编辑器；数字、字符串、布尔值、null 和非法 JSON 不触发该内容入口。按名称打开仍恢复草稿；带入的文本仅在实际编辑或格式化后保存，不因打开结果自动覆盖旧草稿。

SDK 快照已归一到 `UPSTREAM.json` 记录的本体提交，逐文件记录 SHA-256，与该提交的源码字节一致。

## 表达式筛选

工具栏下方输入表达式，停止输入 180 ms 后自动筛选，直接替换编辑器内容，无需 Enter；Enter 或“筛选”按钮可立即应用。在编辑器中按 `⌘/Ctrl + Z` 撤销。同一轮表达式始终基于筛选前的完整 JSON 计算，清空表达式恢复原文及其格式。暂时无效的表达式保留上次成功结果；输入法组合期间不执行筛选。直接编辑（含撤销/重做）、格式化、压缩、清空或载入草稿会结束本轮筛选并清空表达式，后续不会用旧原文覆盖新内容。成功应用沿用草稿保存流程。

支持 `.key.subkey`、`[0][1]`、`this.items`、`.map(x => x.val)`、`.filter(x => x.enabled && x.val >= 2)`，可链式调用。支持回调索引参数、数组/对象投影、条件表达式、`??` 空值回退和严格比较，数值解析和比较保持大整数精度。

这是 JSON 数据表达式子集，使用 Acorn 解析并解释，不执行任意 JavaScript；没有 eval、Function、全局对象、任意函数、赋值、循环或语句块。表达式最多 1024 字节，源文档和结果各最多 1 MiB，求值及输出检查共用 100,000 步预算，嵌套最多 48 层。图片、宿主桥和 CSP 无变更。

插件图标通过 manifest 的可选 `icon` 声明包内文件；JSON 工具的 `icon.svg` 随构建输出。需要支持该字段的新版 Sinan 宿主。缺少图标时宿主显示插件名首字。
