# Sinan 官方插件

可选官方插件独立源码仓库，目前包含 JSON 工具（`tools.json`，0.1.0）。内置的应用检索、设置和插件管理继续由 Sinan 本体维护。

需要 Go 1.26+、make；ZIP 打包另需 Python 3，无额外 Python 依赖。

```sh
make test
make build
make package
```

安装目录为 `bin/plugins/json-tool`；ZIP 与 SHA-256 文件位于 `dist/`。产物按 Go 当前目标平台构建，不代表已通过各平台宿主运行验证。

退出正在使用目标插件目录的 Sinan，再通过宿主 CLI 安装：

```sh
/path/to/sinan/bin/sinanctl -plugins /path/to/plugins -trust-native install /path/to/sinan-official-plugins/bin/plugins/json-tool
```

已有版本使用 `upgrade`。也可在可信插件管理界面检查并安装构建目录，显式确认原生信任。当前 UI 需要宿主以 `-plugin-ui` 启动；原生进程不是安全沙箱。草稿最大 32 KiB，保持原插件 ID，因此原有草稿和配置身份不变。

## SDK 与宿主依赖

本仓库通过本地 Go 模块 `replace` 使用 `third_party/sinan` 中的最小协议、Go SDK 和 UI Bridge 快照。来源提交及逐文件 SHA-256 记录在 `UPSTREAM.json`。可在不检出宿主源码、不安装 Wails 的情况下构建；不复制宿主 internal 实现。SDK 正式发布后再迁移到固定发行版本。快照应从指定宿主提交同步更新，禁止将本地临时修改冒充该提交的内容。

## 发布与目录登记

建议标签 `json-tool/v0.1.0`，每个插件独立版本。发布平台 ZIP 后，向 `sinan-plugin-registry` 提交版本记录；尚未上传 GitHub，不虚构仓库地址或可安装版本。本次仅迁移当前源码，原有历史保留在本体仓库，来源提交见 SDK 快照与本体 ADR 0034。

## UI 验证

日常 `make test` 不启动 UI。只有用户明确要求时才运行 `node plugins/json-tool/tests/serve.mjs` 并使用 `tests/ui-regression.js` 做浏览器验证。宿主保留可选跨仓原生集成测试，通过 `SINAN_JSON_PLUGIN_PACKAGE` 指定此仓库构建出的绝对安装目录；详见宿主 README。
