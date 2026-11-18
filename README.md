# Surge

Surge 是开源的本地优先便签。项目包含 Web/PWA、Android（Capacitor）、可选的 Docker 同步服务端，以及向 Obsidian 单向同步的插件。笔记先写入本机；启用同步后再与服务端交换加密操作。

## 本地使用

Android 安装后直接进入笔记，无需服务器或启动口令。旧版本已经保存的加密笔记在升级后需要输入一次旧口令完成迁移，之后直接打开。

Web 在仓库根目录运行 `npm run web`，打开 `http://localhost:8788` 即可记录。浏览器需要通过本机地址或 HTTPS 访问，才能使用 WebCrypto。清除 Android 应用数据或浏览器站点数据会删除未同步的本地笔记与附件；请自行备份。

## 可选：Docker 同步

1. 生成访问令牌：`openssl rand -hex 32`。
2. 复制 `.env.example` 为 `.env`，将 `SURGE_TOKEN` 换成刚生成的令牌。
3. 启动：`docker compose up -d --build`。
4. 在应用的“设置 → 同步”中输入服务器地址、令牌和同步口令，点击“连接并同步”。

跨设备访问时，请用反向代理为同步服务配置 HTTPS；Android 客户端也应填 HTTPS 地址。本地模式不需要首次联网。已有本地笔记启用同步时，会在本机用服务器盐值重新加密操作和附件，再上传；恢复网络后自动同步。同步口令用于让其他设备解密，无法由服务器找回。

### Android

仓库已包含 `android/` 原生工程。安装 Node 26 和 Android Studio/Android SDK 后运行：

```sh
npm install
npm run android:sync
cd android && ./gradlew assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/`。修改 `web/` 后重新运行 `npm run android:sync`。此工程把同一个离线 Web 客户端封装为 Android 应用；笔记存于 Android WebView 的 IndexedDB 中。

Android 安装包可从 [GitHub Releases](https://github.com/yzxcxy/Surge/releases) 获取。应用内“设置 → 应用更新”会在手动点击“检查更新”后查询 GitHub 最新正式版本；有新版本时打开 APK 下载页。覆盖安装需要新 APK 与旧版本使用同一签名证书。Android 15 模拟器的安装与离线同步测试见 [测试报告](docs/android-test-report.md)。

### Obsidian

```sh
cd obsidian
npm install
npm run build
```

将 `obsidian/manifest.json`、`obsidian/main.js` 和 `obsidian/styles.css` 放入库目录 `.obsidian/plugins/surge-sync/`，在 Obsidian 社区插件设置中启用。设置相同的 HTTPS 服务端地址和访问令牌，并在“笔记保存位置”中输入库内文件夹路径（默认 `Surge`，支持 `资料/Surge` 等路径）。点击“保存并迁移”后，下一次成功同步会把已有的受管理笔记移到新目录，并清理旧位置。执行“Surge: 解锁并同步”，输入与 Web/Android 相同的加密口令。

插件只从 Surge 服务端拉取**普通笔记**（`kind: note`），待办和思维导图不同步。笔记文件以标题命名，同一文件夹内的重名笔记会使用 `标题 (2).md` 等数字后缀；稳定 ID 只放在笔记属性 `surge-id` 中。旧版带 `--<ID>` 的笔记文件会在下次成功同步时改名。Obsidian 中的创建、编辑、移动或删除不会回传。每 30 秒自动同步一次，也可点侧栏同步按钮；本地改动会在下次成功同步时恢复为 Surge 的内容。插件只管理当前或曾用同步目录中带 `surge-id` 的 Markdown 文件（也识别旧版生成的 `--<ID>.md` 文件名）。Surge 中删除或彻底删除的笔记、以及已同步的待办或思维导图，会从库中永久删除对应文件（不进入 Obsidian 回收站）；若恢复为普通笔记，下一次同步会重新创建。没有同步标识的其他文件不会被删除。断网或解密失败时不清理本地文件。

图片、绘图、导图、录音和普通文件会从服务端下载并解密，存到所选目录的 `_attachments/`，笔记正文会改用 Obsidian 可打开的相对链接。重复引用同一附件只保存一份；源端删除笔记或移除引用后，不再被任何有效笔记引用的附件会删除。密码条目不会解密导出到普通文件，其 `surge-blob:` 引用会保留。口令只保存在本次运行的内存中，重启后需再次输入。

## 同步与隐私

- 每次 Surge 字段修改生成独立操作，先落地到 IndexedDB。新建本地库时，客户端生成 AES-256-GCM 密钥并保存在设备的 IndexedDB 中，因此打开应用无需输入口令；本机访问控制可使用操作系统的应用锁。启用同步时，客户端用 PBKDF2-SHA-256（310,000 次）从同步口令派生密钥，并在本机重新加密操作与附件。服务端只保存密文操作和附件。Obsidian 插件只接收操作，不会上传本地编辑。
- 服务端按操作 ID 去重，按游标增量下发。客户端对同一字段按 `(Lamport 计数, 设备 ID)` 确定赢家；所有设备收到同一操作集合后得到同一笔记。不同字段的离线修改可以合并。
- **同一字段的并发编辑采用确定性覆盖**。v1 不做逐字符合并；被覆盖的历史值仍在操作日志中，但目前没有可视化冲突恢复界面。重要长文档建议用 Obsidian 的版本备份。
- 标题、正文、文件夹名、置顶和删除状态均加密。服务端仍能看到设备 ID、笔记随机 ID、字段类别、操作顺序、时间流量与密文长度。访问令牌保存在浏览器本地存储或 Obsidian 插件设置中，不上传加密口令。
- Obsidian 插件会把笔记解密成库中的普通 Markdown 文件，以便 Obsidian 编辑和搜索；这些本机文件由你的 Obsidian 库保护策略负责。
- 服务端是单用户、单实例部署。持久化数据在 Docker 卷 `surge_data` 的 `salt`、`ops.jsonl` 和 `blobs/` 中；请备份该卷。丢失盐值或加密口令将无法解密旧笔记。
- 首页可切换列表与宫格；搜索栏下方可管理分类，空分类也会跨设备同步。长按笔记可批量置顶、移动或删除。编辑页的图片点选后显示操作图标，思维导图使用整页大纲输入；底部 T 可切换文字格式工具。每篇笔记可选择背景，列表和宫格中会显示对应颜色。底部“待办”汇总 Markdown 勾选项，并可勾选完成。标题和正文的历史版本可在笔记菜单中查看和恢复；恢复会写入新操作，不会删掉旧版本。毛玻璃效果默认开启，可在设置中关闭；设置中还可切换简体中文或英文界面，以及跟随系统、浅色或深色主题。英文界面部分动态提示尚未翻译。
- v1 各种记录方式和已知边界见 [功能清单](docs/feature-status.md)。S3 和 WebDAV 不在当前实现范围内。

## 本地开发与验证

```sh
SURGE_TOKEN=local-development-token-123456789 npm run server
npm test
cd obsidian && npx tsc --noEmit && npm run build
```

测试覆盖加密操作、两设备离线修改后的收敛、上传去重、未授权访问、加密附件的持久化，以及本地笔记迁移到服务器盐值后的历史保留。

## 小米笔记参考

交互依据、APK 静态分析证据与尚未验证的部分见 [研究记录](docs/xiaomi-notes-research.md)。Surge 借鉴快速新建、列表/卡片浏览、文件夹、搜索、置顶及回收站的操作组织；界面和代码均独立实现。

## 许可

[MIT](LICENSE)
