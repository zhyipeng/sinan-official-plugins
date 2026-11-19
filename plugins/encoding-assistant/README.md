# 编码助手

`tools.encoding-assistant` 是独立安装的纯前端插件。搜索「编码助手」可以列出五个入口：

| 搜索入口 | 内容触发 | 操作 |
| --- | --- | --- |
| 时间转换 | 10 位秒、13 位毫秒 Unix 时间戳，或 `YYYY-MM-DD` / `YYYY/MM/DD` 开头的日期时间 | 普通打开填入当前时间；显示系统时区、UTC-0 和自选时区，并支持复制。 |
| Base64 编码 / 解码 | 无 | UTF-8 文本编码与解码；也接受 URL-safe Base64。 |
| 生成 UUID | 无 | 打开即生成同一个 UUID v4 的标准、无连字符、全大写和全小写形态；按 Cmd/Ctrl + 1–4 分别复制。 |
| Hash 计算 | 无 | MD5、SHA-1、SHA-256、SHA-384、SHA-512；前两项仅用于旧格式兼容。 |
| 二维码编码 / 解码 | HTTP(S) 网址、粘贴到主输入框的图片 | 网址自动生成二维码；图片自动解码。也可在界面手动输入文本、选择图片或粘贴解码。 |

无显式时区的时间字符串按系统本地时间解释；带 `Z` 或 `±HH:mm` 的输入按显式偏移解释。手动输入可指定非标准位数时间戳的单位。自选时区采用 IANA 名称，可增删；仅时区列表写入宿主隔离存储，转换内容、网址和图片均不持久化，也不发送到网络。解码出的内容按文本显示，不会打开网址。

## 构建与兼容

- `npm run build:encoding-assistant` 输出 `bin/plugins/encoding-assistant`，可从司南插件中心导入该目录。`npm run package:all` 通过官方打包脚本生成六目标本地 ZIP。
- 宿主使用 API 1、UI Bridge 2，需具备输入匹配、会话图片、视图剪贴板及 `ui.image-input.v1`，以具备这些能力的司南 0.4.0 为基线。视图按用途分别声明 `storage`、`clipboard.write`、`clipboard.read` 和 `file.openImage`，无原生后端。
- 构建包内置 QR 和 Hash 依赖及许可，无 CDN。二维码编码限制 2300 UTF-8 字节；解码画布最长边限制 2048 像素，原图中的二维码太小时建议先裁剪。选图和粘贴沿用宿主格式、大小及资源限制。
- 构建目标覆盖 macOS/WKWebView、Windows/WebView2、Linux/WebKitGTK 的现有隔离视图。包相同不等于运行验收；各平台真实 Canvas 图片解码、系统选图、剪贴板、主题、键盘和输入法交互（Linux 区分 X11/Wayland）尚待实机验证。正式版本见 GitHub Releases，尚未登记商店。
