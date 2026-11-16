# Android 构建与模拟器测试

首次测试：2026-11-14；最近回归：2026-11-16。主机：Apple Silicon macOS。Android 虚拟设备：Pixel 6、Android 15（API 35，Google APIs，ARM64）。

## 构建与交付物

- 真机测试包：[surge-android-device-test.apk](https://github.com/yzxcxy/Surge/releases/download/v1.4.0/surge-android-device-test.apk)，由 `assembleRelease` 的未签名 APK 对齐后，以独立的本机测试密钥签名。包名 `org.surge.notes`，`versionCode=7`、`versionName=1.4.0`，最低 Android 6.0（API 23），目标 API 35。SHA-256：`1ddc60520e776ebed0d209510f867e59dd994687b5b67c02c0aeccc336631741`；签名证书 SHA-256：`9acac77ddfd6bc6e545744b9eeb612a3c0b1a3700d0eea7f3baf80f968ff2345`。`zipalign -c` 和 `apksigner verify` 均通过（v1、v2、v3）。签名密钥保存在本机 `~/.local/share/surge/signing/`，未纳入项目或 APK；后续覆盖安装需使用同一密钥。
- 上述真机包没有调试构建的自签 CA 信任配置；尚未在用户的实体设备上测试。若设备已装相同包名的调试签名版本，Android 不允许直接覆盖安装。
- Docker Compose 服务 `surge-surge-1` 在 `8787` 端口运行，`GET /api/health` 返回 `{"ok":true}`；重启容器后随机盐值保持一致。测试结束时，正式 Docker 卷的操作日志游标仍为 0。
- 安装 OpenJDK 21、Android SDK 平台 35、Build Tools 35、Platform Tools 和 Emulator，并执行 `npm run android:sync` 与 `./gradlew assembleDebug --no-daemon`，构建成功。
- 调试包位于本机 `dist/surge-android-debug.apk`，包名 `org.surge.notes`，大小约 3.9 MiB；本次 SHA-256：`493cd95891108651469dd0164925520448ebbc29b5296487ca6116e0f95ec96d`。
- `npm test` 通过，覆盖加密操作、离线修改收敛、操作去重、鉴权、加密附件及服务端重启持久化。
- Obsidian 插件的 `npx tsc --noEmit` 和 `npm run build` 通过。

## 模拟器端到端结果

测试连接到独立的 Node 服务（端口 `18788`）与临时 HTTPS 代理（端口 `8443`），没有向正式 Docker 服务写入测试笔记。Android 模拟器使用 `https://10.0.2.2:8443` 连接主机。

| 操作 | 观察结果 |
| --- | --- |
| 安装并启动 APK | 首页与设置页正常渲染，连接后显示“已同步”。 |
| 联网新建标题和正文 | Android 列表出现笔记，服务端收到 6 条加密操作；服务端日志未出现明文标题。 |
| 停止测试服务后编辑正文 | Android 仍可编辑，IndexedDB 保留 2 条待上传操作，状态显示“同步失败”。 |
| 断网时强制停止并重启应用 | 解锁后笔记和离线修改仍在，待同步操作未丢失。 |
| 恢复测试服务并触发同步 | 状态回到“已同步”；服务端操作数增加到 8，解密后正文包含离线编辑内容，服务端原始 JSON 无该明文。 |

截图：[Android 模拟器界面](android-emulator-preview.png)。

2026-11-15 更新了移动端首页和编辑页布局，移除宣传语，将分类入口移至顶部，增加底部“笔记/待办”切换。重新安装调试包后，在可见 Android 15 模拟器中验证了列表和宫格显示、笔记卡片进入编辑页、返回列表及分类弹层开关。[新版首页截图](android-ui-home-preview.png) · [宫格截图](android-ui-grid-preview.png)。

同日的独立浏览器数据目录测试确认：仅启动静态 Web 服务（`npm run web`，无同步 API）即可创建本地笔记和待办；新本地库刷新后直接打开。另一独立数据目录验证了本地笔记启用同步时的重新加密迁移、服务端收敛和历史版本保留；服务端返回的操作 JSON 中不含测试笔记明文。Android 模拟器中的应用也已用本地模式启动，底部标签避开了系统手势条。

## 2026-11-15 分类、编辑器与键盘回归

- 用两个独立浏览器数据目录测试了分类创建、重命名、删除、中文输入法组合事件、空分类跨端同步和删除后的收敛。分类记录没有出现在普通笔记列表。[分类入口截图](android-ui-v2-home.png)。测试图片、绘图、导图和密码条目可加密保存；附件同步到独立测试服务并在第二设备下载，服务端文件和操作日志检索不到测试明文。
- 编辑器改为整页，正文不显示内部附件标记；插入工具栏位于正文下方。Android 15 的 WebView 在键盘弹出时仍报告 `visualViewport.height≈915 CSS px`，原生键盘 inset 桥接后编辑器高度和工具栏底边均为 `≈578 CSS px`，工具栏贴在键盘上方。[编辑页键盘截图](android-editor-keyboard-final.png)。
- 搜索框聚焦时出现的左侧条来自该模拟器的 Gboard“用手写笔在文本框书写”功能。关闭该输入法选项后，重启 Surge 再次聚焦搜索框，显示底部完整键盘和搜索键。[搜索键盘截图](android-search-final.png)。Surge 搜索框使用 `type=search`，聚焦时关闭应用自身的分类弹层。
- 重新构建并安装调试 APK；Docker 容器重建后 `/api/health` 返回 `{"ok":true}`；Obsidian 插件的 TypeScript 检查和打包通过。

## 2026-11-15 所见即所得编辑器回归

- Web 正文改为可编辑的排版区域。独立 Chrome 数据目录实测：普通段落、待办勾选和表格单元格均在原位显示与编辑；插入 PNG 后图片显示在正文中，正文不出现 `surge-blob:` 标记。返回列表、重开笔记和刷新页面后，勾选状态、单元格和图片均还原。
- Android 调试包重新构建并安装到 API 35 模拟器。正文获得焦点时系统键盘弹出，插入工具栏保持在键盘上方。[编辑页键盘截图](android-rich-editor-keyboard.png)。
- `npm test` 3 项通过；Obsidian 插件 `tsc --noEmit` 和构建通过。Docker Compose 重新构建并启动，`GET /api/health` 返回 `{"ok":true}`。

## 2026-11-15 绘图编辑器回归

- 根据用户提供的绘图截图，绘图页改为全屏白色点阵画布，顶部为细线图标，底部以笔尖造型展示铅笔、毛笔、荧光笔、钢笔和橡皮；颜色与粗细从图标打开。 [新版 Android 绘图截图](android-drawing-final.png)。
- Chrome 独立数据目录验证：五种笔型分别使用不同线宽、透明度或橡皮白色笔触；撤销、重做及色点选择正常。插入绘图、点击“编辑绘图”、继续画、保存和重开笔记后，正文仍只有一张绘图，附件引用更新。
- Android 15 模拟器验证：旧 PNG 绘图可载入新画布并继续编辑；曾发现将附件的 Base64URL 数据误作图片 URL 导致空白，已修复并以模拟器截图复测。

## 2026-11-15 编辑工具栏图标回归

- 把笔记编辑页的 12 个文字按钮改成线性 SVG 图标，并为每个按钮保留中文 `aria-label` 和 `title`。Android 模拟器中工具栏仍贴在键盘上方，[首屏截图](android-editor-icons.png)；左右滑动后可见后续入口，[滑动截图](android-editor-icons-scroll.png)。
- Chrome 独立数据目录检查 12 个按钮均有图标和可访问名称；点击表格图标仍在正文插入表格。`npm test` 3 项及 Obsidian 插件类型检查、构建通过。

## 2026-11-15 版本 1.1.0 回归

- 浏览器回归：空白新建后返回，笔记数量保持不变；输入 `- ` 后正文立即出现列表；设置中可以打开回收站并返回。编辑器已移除分享按钮、“插入代办”和“导出 Markdown”菜单项。
- 置顶笔记按顺序排在普通笔记前，主页面的分类入口只含“全部”和自建分类；回收站入口在设置中。应用图标在 Web 和 Android 上更换为便签图形。
- `npm test` 6 项通过，含 GitHub 仓库解析与最新 Release 资产选择。`npm run android:sync`、Android `assembleDebug assembleRelease`、Obsidian 插件构建通过。新调试包在 API 35 模拟器覆盖安装并启动，`dumpsys` 显示 `versionCode=2`、`versionName=1.1.0`。Docker `GET /api/health` 返回 `{"ok":true}`。
- 应用更新由设置中的手动操作触发，请求 GitHub 最新正式版本；新版本有 APK 资产时打开其下载地址。当前只验证了 API 解析和模拟器启动，尚未在实体设备上验证安装包下载与覆盖安装。

## 测试证书边界

模拟器集成测试使用临时自签 CA。公开证书仅放在 `android/app/src/debug/res/raw/`，私钥留在主机临时目录。`android/app/src/debug/AndroidManifest.xml` 为调试构建配置 CA 信任；运行 `:app:processReleaseManifest` 后，release 合并清单没有此信任配置。这个 APK 是调试包，不应作为正式发行包。Android 官方文档对 `debug-overrides` 的定义见 [Network security configuration](https://developer.android.com/privacy-and-security/security-config)。

后续还需在实体 Android 设备和实际公网 HTTPS 部署上验证；本报告的网络与重启结论来自上述模拟器及本机服务。

## 2026-11-16 版本 1.1.1

重新打包并用相同的本机签名密钥签署 Android 包，`versionCode=3`。版本 1.1.1 的 GitHub 标签与应用源码对应，更新检查保留 GitHub API 限流时的公开版本清单备用来源。`npm test` 6 项、本机 Android debug/release 构建和签名校验均通过。

## 2026-11-16 版本 1.2.0

- 按开发阶段的产品取舍，移除公式入口、公式解析和 KaTeX 依赖及资源；APK 内未发现对应资源。旧的公式标记按普通文本显示。
- 浏览器回归了图片后光标落点、媒体图标操作、背景色与卡片一致、导图全屏大纲输入、表格列宽、常用 Emoji 搜索和插入、T 格式工具栏、移动分类及长按批量操作。
- 在 Android 15 模拟器安装调试包并启动，首页和笔记编辑页正常显示；`dumpsys` 显示 `versionCode=4`、`versionName=1.2.0`。`npm test` 6 项、Obsidian 类型检查与构建、Docker 健康检查及测试包签名校验通过。

## 2026-11-16 版本 1.2.1

- 设置中的更新检查固定使用 Surge 仓库，不再显示可编辑的仓库地址。图片工具栏合并相册与拍照入口。
- 浏览器回归：插入待办后光标位于勾选框右侧；回车创建下一条待办。Android 15 模拟器用真实回车键确认续建待办。
- Android 15 模拟器真实点按正文中的绘图后，图片操作栏保持可见；点击绘画图标可重新打开全屏画布。修复触屏产生的第二次 `click` 让操作栏立即关闭的问题。
- `npm test` 6 项、Obsidian 类型检查与构建、Android debug/release 构建和 APK 签名校验通过；模拟器覆盖安装后的 `dumpsys` 显示 `versionCode=5`、`versionName=1.2.1`。

## 2026-11-16 版本 1.3.0

- 修复毛玻璃模式覆盖笔记内页背景的 CSS 优先级；Android WebView 的计算样式确认浅粉背景已应用于编辑页。布局切换按钮关闭系统蓝色点击高亮，保留键盘焦点样式。
- 思维导图改为一份大纲与导图双视图：唯一中心主题、主题层级、导图节点点选与文字编辑、同级/子级添加及删除；保存后重新打开仍保留结构。
- Android 15 模拟器真实点按大纲输入框后，键盘弹出时导图窗口高度约 578 CSS px，底部快捷栏位于其底边；真实回车从中心主题创建一级子主题。切换到导图视图后，节点与底部编辑操作正常显示。
- `npm test` 6 项、Obsidian 类型检查与构建、Android debug/release 构建、APK 对齐及签名校验通过。

## 2026-11-16 版本 1.4.0

- 待办和引用：非空项回车续建，空项回车退出，空项退格删除；Shift+回车保留段内换行。Android 15 模拟器真实回车键与退格键分别验证了退出和删除待办项。
- 格式栏增加下划线、删除线、有序/无序列表、引用、分割线和左/中/右对齐；引用改用双引号图标并可再次点击退出。移除独立表情入口；正文保留连续空格。浏览器检查了格式操作以及 Markdown 保存后重新渲染的往返结果。
- 思维导图编辑窗设为可平移、不可双指缩放；Android WebView 计算样式为 `touch-action: pan-x pan-y`。
- `npm test` 6 项、Android debug/release 构建、APK 对齐及签名校验通过；模拟器覆盖安装后显示 `versionCode=7`、`versionName=1.4.0`。
