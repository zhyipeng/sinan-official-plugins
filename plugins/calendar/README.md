# 日历

`tools.calendar` 0.1.2，纯前端只读日历，使用 MIT 许可的 [React DayPicker](https://daypicker.dev/) 10.0.2 与 [chinese-days](https://github.com/vsme/chinese-days) 1.5.10。

支持月历、年月切换、回到今天、农历与生肖、传统节日、二十四节气，以及中国大陆放假与调休补班角标。点击日期查看详情，点击本月节日或节气跳转。保留 DayPicker 的方向键导航与中文可访问性标签，布局适配窄窗口并使用宿主主题变量。没有日程、账号、在线同步或通知。

## 数据边界

公历浏览限定 1901–2099 年，避免农历算法的起始年不完整。放假与补班数据随锁定的 chinese-days 版本离线打包，当前覆盖 2004–2027 年；未收录年份保留农历与节日，明确显示“放假安排未收录”，不推测调休。普通周末不标为法定放假。传统节日、节气和国务院放假安排分开处理；节气是上游算法计算结果，不是实时天文数据。

已逐项核对当年及下一年数据来源：[2026 年国务院通知](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)、[2027 年国务院通知](https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm)。后续年份需更新依赖并复核，插件不联网自动更新数据。数据按当地民用日期展示，不把日期经 UTC 字符串转换；农历对应同一公历日期。

## 构建与使用

```text
node scripts/build-calendar.mjs
npm test
npm run package
```

构建目录为 `bin/plugins/calendar`，安装包为 `dist/tools.calendar-0.1.2-<os>-<arch>.zip`，在司南插件中心从 ZIP 安装后搜索“日历”打开。六目标复用同一纯前端内容；构建和打包不会自动安装或发布。

使用宿主既有声明式插件、隔离 HTML UI、UI Bridge 2 ready 和包内图标能力，不增加协议、SDK、后端、权限或持久化数据。依赖及 CSS 均在本地打包，不使用 CDN、远程字体、内联脚本、动态 style 注入或完整 Wails Bridge；打包保留第三方 MIT 许可证。资源检查沿用单文件 512 KiB、总量 2 MiB、128 文件上限。

## 跨平台验证

编译目标沿用 Safari 16.4、Chromium 119、Firefox 115；需配套现代 WKWebView、WebView2 或 WebKitGTK 和支持上述桥/图标能力的司南宿主。不依赖平台命令、原生后端、X11 或 Wayland API，但不能据此宣称目标引擎均已验收。

无界面测试覆盖春节/除夕、闰月、节气、2026/2027 放假与补班、未知年份降级、日期边界、不同时区，以及真实 React 组件静态渲染和可访问性属性。三平台 CI 已追加构建与测试入口；CI 结果、各目标系统运行、主题、键盘/输入法、焦点、缩放和原生 WebView 实机交互须分别验收。未进行真实桌面或浏览器交互验收，不将六目标 ZIP 视为已发布支持。
