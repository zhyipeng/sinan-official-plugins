# 计算

`tools.calculator` 0.2.0（待发布）是可独立安装的官方插件，包含主搜索计算和计算稿纸。计算业务在插件内，不依赖完整 Wails Bridge，使用宿主共享剪贴板 API；登记格式不变。

## 使用

- 主输入框输入 `30*24`、`0.1+0.2`、`sqrt(9)` 等完整表达式，结果列表直接显示数值；回车或点击选中结果会复制数值并收起主搜索窗口。无效表达式不产生计算结果；纯数字和仅带正负号的数字不抢占搜索。
- 搜索“计算”或“计算稿纸”打开页面。每行即时计算，点击右侧结果复制；编辑行内按 Command/Ctrl + Enter 同样复制。Enter 换行，空行 Backspace 删除该行，支持多行粘贴。中文输入法组合期间 Enter 不触发换行。
- 右侧切换历史稿纸，底部新建，顶部删除当前稿纸。删除需要在页面内再次点击“确认删除”。默认跟随宿主明暗主题。
- 编辑停止 1.2 秒或输入框失焦后自动保存；保存成功显示“已保存”。关闭前应等待保存完成。多窗口修订冲突、存储不可用时保留当前输入并停止写入，可通过“备份”全选复制 JSON 后重新打开；当前未提供备份导入。

## 运算规则

支持十进制、科学计数法、四则运算、括号、`^` 乘方、后缀 `%`、`pi` / `π`、`e`，以及 `sqrt`、`abs`、`sin`、`cos`、`tan`、`ln`、`log`（以 10 为底）、`round`、`floor`、`ceil`、`min`、`max`。三角函数单位为弧度；`round` 的中点远离零取整。乘方右结合，`-2^2` 为 `-4`。

`10%` 表示 `0.1`，所以 `200*10% = 20`、`200+10% = 200.1`，不采用部分实体计算器的相对百分比规则。不支持千分位输入、隐式乘法、变量赋值或单位换算。

有限小数四则运算与整数乘方使用精确有理数；循环小数按 15 位有效数字显示；数学常数、非整数乘方及超越函数使用浮点近似。原生搜索端和页面端采用独立的有界解析器，以同一组用例校验语义；页面本地计算，不按键调用宿主桥。不会使用 eval、Function 或 shell 执行表达式。

每行最多 512 字节，嵌套预算 64，整数指数绝对值不超过 1000，中间有理数分子/分母最多 2048 位二进制。每页最多 100 行，最多 50 页；总 JSON 数据遵守宿主 32 KiB 配额，实际可保留数量由内容长度决定。容量不足明确提示，不自动删除历史。私有稿纸使用普通本地存储，不宣称加密。

## 平台与依赖

需要支持进程 Search Provider、direct 命令、隔离 UI Bridge 2 和私有 storage 的宿主；以本仓库 SDK 快照和当前司南源码的安装校验为基线，不以相同开发版本号推定兼容。安装时需要信任原生进程；`clipboard.write` 同时用于宿主 API 能力检查，不代表操作系统沙箱。初始化必须检测 `hostCapabilities` 的 `clipboard.v1`；旧宿主拒绝激活新版插件。

- macOS：由宿主 Cocoa 适配写入文本，插件不再调用 pbcopy。
- Windows：由宿主 Win32 适配写入 Unicode 文本，插件不再实现系统调用。
- Linux X11：需要桌面会话和 `xclip`。
- Linux Wayland：优先使用 `WAYLAND_DISPLAY`，需要 `wl-clipboard` 的 `wl-copy`；不会静默改走 X11。缺少会话或工具时返回明确错误。

原生入口为纯 Go，可交叉构建三系统的 arm64 / amd64；Windows 包使用 `backend/plugin.exe`。UI 复用 WKWebView / WebView2 / WebKitGTK 隔离承载，不注入可信 Shell，使用现有静态 CSP、宿主主题、BigInt 和本地打包的 React；目标语法为 Safari 16.4 / Chromium 119 / Firefox 115，不使用 CDN 或动态 style 注入。

## 构建与验证

在仓库根目录执行：

```sh
npm test
node scripts/build-calculator.mjs --all
node scripts/package.mjs
```

`npm run build` / `build:all` 和三系统 CI 均在已有插件后追加计算插件；安装包生成到 `dist/tools.calculator-0.2.0-<os>-<arch>.zip`，附带 SHA-256。单目标可使用 `--target=windows-amd64` 等参数。

本次本地验证：macOS arm64 无界面前端用例、Go 竞态测试、Go 静态检查、临时宿主目录安装与搜索、六目标交叉构建和包头校验通过。整仓前端 100 项、Python 2 项及既有原生插件竞态回归通过。测试使用模拟剪贴板调用，不读取或修改真实剪贴板。

尚未执行三目标系统实际剪贴板写入、WKWebView / WebView2 / WebKitGTK、输入法、焦点、拆出、主题与 DPI 的真实 UI 验收；远端三平台 CI 与正式发布现已完成，见下方发行记录。构建成功不代表实机交互已通过。


## 首次发行

[0.1.0 Release](https://github.com/zhyipeng/sinan-official-plugins/releases/tag/tools.calculator-v0.1.0) 已上传 macOS、Windows、Linux 的 arm64/amd64 六目标包与 SHA-256；[三平台 CI](https://github.com/zhyipeng/sinan-official-plugins/actions/runs/43799988731) 无界面测试及构建通过，安装包已核验清单、图标与原生入口架构。商店资料登记真实发行资产；需支持独立发布标签的司南源码 c518ca5 或更新。真实剪贴板与桌面 UI 验收仍未执行。

## 0.2.0 重构

系统剪贴板调用迁至司南宿主，搜索回车与页面复制均使用 Go SDK 的 `HostFromContext(ctx).ClipboardWrite`。计算、搜索与稿纸存储保持插件职责；删除三端重复适配及其专用测试，宿主接管相应平台测试。需要司南 0.2.0 或更新版本及 [ADR 0066](../../../sinan/docs/adr/0066-host-clipboard-api.md) 能力；已发布 0.1.0 资产保持不变。六目标交叉构建和无界面回归通过不代表真实剪贴板验收。
