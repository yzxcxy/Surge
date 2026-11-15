# 小米笔记研究记录

## 目标与证据边界

用户提供的 [base.apk](../base.apk) SHA-256 为 `382bb22ff37d143fd28eefdac2f16a2aefae3c55eb2ddeb5baea22915f1ba76d`。REA 将其识别为 APK，并完成 5,570 个归档条目的静态清点；证据 `ev_2baf4dff36ae8fa6f06fbff539ebb10a308879b4c003a149be39c374aa028844`（父证据 `ev_cb579f8439cc773b4f1046943ade2ea414d941168a8950c58b7ab786e517c41f`）。REA 的 JADX provider 未配置，`inspect_android_package` 因缺少 `REA_JADX_MCP_JAR` 失败；因此没有 REA 反编译结论，也没有运行时录屏。

为补足静态信息，使用 Androguard 解析 APK Manifest、资源表、部分编译布局 XML 与 DEX 类名。解析到包名 `com.miui.notes`，版本 `2.4.3.7`，主 Activity `com.miui.notes.ui.NotesListActivity`；APK 中另有 `EditActivity`、`FolderDialogActivity`、`PrivateNotesListActivity` 等声明或类。

编译布局显示：`homepage_fragment` 包含 `HomepageViewPager` 和浮动新建按钮；`new_phone_note_list_fragment` 包含滚动容器、空状态视图、笔记 `RecyclerView` 和两个浮动按钮；`common_note_item_grid` 包含预览图、标题/摘要文字、缩略图和若干状态图标；`hybrid_note_edit_layout` 以 `RichEditorWebView` 为主要编辑区域。资源表同时有 `common_note_item_list`、`fragment_note_search`、`cloud_trash_bin_activity` 与 `new_todo_edit_layout`。这支持主页、网格/列表组件、富文本编辑器、搜索、回收站与待办页面的静态结构判断。

编译菜单 `notes_list_options` 的条目和字符串分别是 Hide、Rename、Pin、Move to、Create a folder、Delete；`normal_note_edit_options` 是 Reminder、Hide/Unhide、Place on Home screen、Move to、Delete；`trash_list_options` 是 Restore 和 Delete permanently。**这些只能证明包内存在对应声明或资源，不能证明当前设备上实际可达、具体手势与运行效果。**

小米官方 [POCO C40 用户手册的 Notes 章节](https://ams-go.buy.mi.com/uk/servicecenter/file/POCO_C40_User_Guide___uk?binaryId=204632&namespaceId=2&publicationId=204657) 描述了：主页“＋”新建；文字、图片、音频；编辑中的模板、清单、格式；长按笔记置顶、隐藏、删除或移动文件夹；回收站恢复；主页搜索；顶部 Tasks 切换。这是官方对该设备/版本的说明，并非对用户提供的 2.4.3.7 APK 的逐项运行验证。

## 交互归纳与 Surge 实现

| 交互 | 依据 | Surge v1 |
| --- | --- | --- |
| 主页快速新建、列表进入编辑 | 官方手册；APK 主入口及列表/编辑资源 | 已实现 |
| 搜索标题和内容 | 官方手册；搜索 fragment 资源 | 已实现，本机解密后搜索 |
| 文件夹分类、移动 | 官方手册；文件夹 Activity 和资源 | 支持新建、重命名、删除分类及笔记移动；空分类作为加密记录同步 |
| 置顶 | 官方手册；置顶字符串资源 | 已实现 |
| 删除与恢复 | 官方手册；回收站资源 | 已实现软删除与恢复 |
| 清单与任务 | 官方手册；待办布局资源 | 支持 Markdown 清单行及底部待办汇总 |
| 图片、音频 | 官方手册及部分资源 | 支持加密附件与基础录音、播放 |
| 提醒、隐藏笔记 | 官方手册及部分资源 | 尚未实现 |

## UI 取舍

Surge 使用搜索栏下方的分类、卡片列表、整页编辑器与键盘上方的插入工具栏；配色、图标与字号均为独立设计。APK 的布局 XML 支持“网格卡片、列表组件、浮动新建入口”作为设计参考。最初静态分析时没有运行该 APK；随后用户提供的截图仅覆盖部分页面，因此不声称像素级复刻。可在具备 Android 设备/模拟器及 JADX provider 时继续验证：主页信息层级、手势、长按菜单、回收站恢复和各尺寸布局。

用户提供的绘图页和笔记内绘图截图显示：绘图页为白色大画布和淡点阵背景，顶部为细线撤销、重做与完成图标，底部用笔尖外形区分工具并以圆点显示颜色；完成后绘图作为笔记正文中的图片展示。截图属于用户私人资料，不随公开仓库分发。Surge 据此采用无文字的笔型工具和原位绘图预览。笔型笔触、颜色弹层与重新编辑方式是 Surge 自行实现，不据此声称与该 APK 完全一致。
