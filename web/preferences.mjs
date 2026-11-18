const translations = {
  '打开旧笔记':'Open old notes', '输入一次旧口令，完成迁移':'Enter your old passphrase to migrate your notes', '旧加密口令':'Old encryption passphrase', '迁移并打开':'Migrate and open',
  '笔记':'Notes', '全部笔记':'All notes', '分类':'Categories', '新建分类':'New category', '新建分类…':'New category…', '离线可用':'Available offline', '仅本机':'On this device', '连接设置':'Connection settings', '立即同步':'Sync now', '设置':'Settings', '返回笔记':'Back to notes', '清空回收站':'Empty trash', '新建笔记':'New note', '搜索笔记':'Search notes', '搜索待办':'Search tasks', '切换列表和宫格':'Toggle list and grid', '切换为宫格':'Switch to grid', '切换为列表':'Switch to list', '分类筛选':'Filter categories', '还没有笔记':'No notes yet', '还没有待办':'No tasks yet', '取消选择':'Cancel selection', '置顶':'Pin', '取消置顶':'Unpin', '移动到':'Move to', '恢复':'Restore', '删除':'Delete', '彻底删除':'Delete permanently', '内容类型':'Content type', '待办':'Tasks', '选择分类':'Select categories', '编辑':'Edit',
  '返回':'Back', '已保存在本机':'Saved on this device', '笔记背景':'Note background', '更多操作':'More actions', '标题':'Title', '内容':'Content', '开始记录…':'Start writing…', '创建思维笔记':'Create mind map', '插入内容':'Insert', '图片':'Image', '录音':'Recording', '绘图':'Drawing', '思维导图':'Mind map', '附件':'Attachment', '文字格式':'Formatting', '一级标题':'Heading 1', '二级标题':'Heading 2', '粗体':'Bold', '斜体':'Italic', '下划线':'Underline', '删除线':'Strikethrough', '无序列表':'Bulleted list', '序号列表':'Numbered list', '引用':'Quote', '分割线':'Divider', '左对齐':'Align left', '居中对齐':'Align center', '右对齐':'Align right', '表格':'Table', '返回插入工具':'Back to insert tools', '选择笔记背景':'Choose note background', '图片操作':'Image actions', '注释':'Caption', '绘画':'Draw', '调整大小':'Resize', '复制':'Copy', '编辑导图':'Edit mind map', '删除图片':'Delete image', '历史版本':'Version history', '移至回收站':'Move to trash', '恢复笔记':'Restore note', '返回编辑':'Back to editor',
  '外观':'Appearance', '毛玻璃效果':'Frosted glass', '语言':'Language', '主题':'Theme', '跟随系统':'System', '浅色':'Light', '深色':'Dark', '回收站':'Trash', '应用更新':'App updates', '当前版本':'Current version', '检查更新':'Check for updates', '打开下载页':'Open download page', '同步':'Sync', '未开启':'Off', '已开启':'On', '服务器地址':'Server address', '访问令牌':'Access token', '同步口令':'Sync passphrase', '连接并同步':'Connect and sync', '关闭同步':'Turn off sync', '分类名称':'Category name', '取消':'Cancel', '保存':'Save', '分类操作':'Category actions', '目标分类':'Destination category', '移动':'Move',
  '添加图片':'Add image', '从相册选择':'Choose from photos', '相册':'Photos', '拍照':'Camera', '编辑待办':'Edit task', '新建待办':'New task', '待办清单':'Task list', '清单标题':'List title', '＋ 添加一项':'＋ Add item', '设置提醒':'Set reminder', '完成':'Done', '设置提醒时间':'Set reminder', '提醒时间':'Reminder time', '重复提醒':'Repeat', '不重复':'Never', '每天':'Daily', '每周':'Weekly', '每月':'Monthly', '每年':'Yearly', '农历':'Lunar calendar', '上个月':'Previous month', '下个月':'Next month', '一':'Mon', '二':'Tue', '三':'Wed', '四':'Thu', '五':'Fri', '六':'Sat', '日':'Sun', '选择提醒日期':'Choose reminder date', '移除提醒':'Remove reminder', '确定':'Confirm', '点击开始录音':'Tap to start recording', '开始':'Start', '结束并保存':'Stop and save', '选择音频':'Choose audio',
  '绘图编辑器':'Drawing editor', '撤销':'Undo', '重做':'Redo', '保存绘图':'Save drawing', '自由绘图画布':'Drawing canvas', '黑色':'Black', '灰色':'Gray', '红色':'Red', '橙色':'Orange', '黄色':'Yellow', '绿色':'Green', '蓝色':'Blue', '紫色':'Purple', '更多颜色':'More colors', '画笔粗细':'Brush size', '绘图工具':'Drawing tools', '颜色':'Color', '铅笔':'Pencil', '毛笔':'Brush', '荧光笔':'Highlighter', '钢笔':'Pen', '橡皮':'Eraser', '粗细':'Size', '清空画布':'Clear canvas', '思维导图编辑器':'Mind map editor', '大纲':'Outline', '切换到思维导图':'Switch to mind map', '切换到大纲':'Switch to outline', '＋ 添加主题':'＋ Add topic', '添加同级主题':'Add sibling topic', '添加子主题':'Add subtopic', '提升一级':'Outdent', '缩进一级':'Indent', '编辑文字':'Edit text', '删除主题':'Delete topic', '还没有历史版本':'No version history yet', '全部':'All', '未分类':'Uncategorized', '空白笔记':'Empty note', '未命名笔记':'Untitled note', '未命名思维笔记':'Untitled mind map', '思维笔记':'Mind map', '新主题':'New topic', '中心主题':'Central topic', '关闭':'Close', '白纸':'Paper', '米色':'Beige', '浅粉':'Pink', '浅绿':'Green', '浅蓝':'Blue', '浅紫':'Purple'
};
const reverse = Object.fromEntries(Object.entries(translations).map(([zh, en]) => [en, zh]));
const attributes = ['title', 'aria-label', 'placeholder', 'data-placeholder'];
let language = localStorage.getItem('surge-language') === 'en' ? 'en' : 'zh-CN';
const originals = new WeakMap();
const protectedContent = '#note-body, #notes, #todos, #folders, #category-list, #category-strip, #note-folder, #move-folder, #mindmap-items, #mindmap-map-nodes, #history-list, #folder-manage-list, [data-user-content]';
export const locale = () => language;
export const t = value => language === 'en' ? (translations[value] || value) : value;
function translateValue(value, original) {
  const trimmed = original.trim();
  let translated = language === 'en' ? translations[trimmed] : trimmed;
  if (!translated && language === 'en') {
    translated = trimmed.replace(/^(\d+) 条笔记$/, (_, n) => `${n} ${n === '1' ? 'note' : 'notes'}`).replace(/^(\d+) 组待办$/, (_, n) => `${n} ${n === '1' ? 'task list' : 'task lists'}`).replace(/^(\d+) 项内容$/, (_, n) => `${n} ${n === '1' ? 'item' : 'items'}`).replace(/^已选 (\d+) 项$/, '$1 selected');
  }
  return translated && trimmed ? original.replace(trimmed, translated) : value;
}
function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (!node.parentElement || node.parentElement.closest(protectedContent) || node.parentElement.closest('script, style')) return;
    let original = originals.get(node);
    if (!original || (node.data !== original.rendered && node.data !== original.source)) original = { source: reverse[node.data.trim()] || node.data };
    const result = translateValue(node.data, original.source);
    original.rendered = result; originals.set(node, original);
    if (node.data !== result) node.data = result;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || node.closest(protectedContent)) return;
  for (const attr of attributes) {
    if (!node.hasAttribute(attr)) continue;
    const value = node.getAttribute(attr);
    const source = reverse[value] || value;
    const result = language === 'en' ? (translations[source] || source) : source;
    if (result !== value) node.setAttribute(attr, result);
  }
  node.childNodes.forEach(translateNode);
}
export function setLanguage(value) {
  language = value === 'en' ? 'en' : 'zh-CN';
  localStorage.setItem('surge-language', language);
  document.documentElement.lang = language;
  document.title = language === 'en' ? 'Surge Notes' : 'Surge 笔记';
  document.getElementById('language-select').value = language;
  translateNode(document.body);
}
export function initializePreferences() {
  setLanguage(language);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') translateNode(record.target);
      else if (record.type === 'attributes') translateNode(record.target);
      else record.addedNodes.forEach(translateNode);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
  setTheme(localStorage.getItem('surge-theme') || 'system');
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}
function applyTheme() {
  const preference = localStorage.getItem('surge-theme') || 'system';
  const dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#17191c' : '#f7f7f7';
}
export function setTheme(value) {
  const theme = ['system', 'light', 'dark'].includes(value) ? value : 'system';
  localStorage.setItem('surge-theme', theme);
  document.getElementById('theme-select').value = theme;
  applyTheme();
}
