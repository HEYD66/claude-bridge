// 右侧停靠区：面板开关与宽度、排列方式、最大化、服务器文件树（含搜索）、Git 改动
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { api, hooks, $, h, svg, errMsg, toast, copyText, fmtSize, currentWorkdir, connected, showMenu, openModal, dialogShell, lightbox } from './core.js';

// ======================= 停靠区 =======================

const PANELS = ['browser', 'term-panel', 'changes', 'files', 'activity'];
const MIN_W = 260;

// 停靠区最宽不超过：窗口宽度 − 侧边栏 − 对话区至少保留的宽度
const MAIN_MIN = 460;

function maxWidth() {
  const side = $('#app').classList.contains('sidebar-collapsed') ? 0 : $('#sidebar').getBoundingClientRect().width;
  return Math.max(MIN_W, Math.min(1100, innerWidth - side - MAIN_MIN));
}

function clampWidth() {
  const dock = $('#dock');
  if (dock.hidden) return;
  const w = dock.getBoundingClientRect().width;
  if (w > maxWidth()) setWidth(w);
}

// 排列方式：col = 上下排列（默认，和官方一致），row = 左右并排。两种方式各自记住宽度
let layout = localStorage.getItem('dockLayout') === 'row' ? 'row' : 'col';
const widthKey = () => (layout === 'row' ? 'dockWidthRow' : 'dockWidth');
const DEFAULT_W = { col: 420, row: 720 };

/** 任一面板显示时显示停靠区，并同步顶栏按钮的按下状态 */
function syncDock() {
  const open = PANELS.filter((id) => !$(`#${id}`).hidden);
  const dock = $('#dock');
  dock.hidden = !open.length;
  $('#app').classList.toggle('dock-open', open.length > 0);
  // 最大化的面板被关掉后，恢复显示其它面板
  const maxed = dock.querySelector('.dock-panel.maxed');
  if (maxed && maxed.hidden) setMaxed(null);
  clampWidth();
  // 只开一个面板时，排列方式和最大化都没有意义
  $('#btn-dock-layout').hidden = open.length < 2;
  for (const b of dock.querySelectorAll('.panel-max')) b.hidden = open.length < 2;
  for (const b of document.querySelectorAll('.dock-toggle')) {
    const on = !$(`#${b.dataset.panel}`).hidden;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function setWidth(w, save = false) {
  const v = Math.round(Math.min(maxWidth(), Math.max(MIN_W, w)));
  $('#dock').style.width = `${v}px`;
  if (save) localStorage.setItem(widthKey(), String(v));
}

function applyLayout() {
  const dock = $('#dock');
  dock.classList.toggle('row', layout === 'row');
  const btn = $('#btn-dock-layout');
  // 按钮显示的是“切换后”的样子
  btn.innerHTML = icon(layout === 'row' ? 'splitCol' : 'splitRow', 15);
  btn.title = layout === 'row' ? '改为上下排列' : '改为左右并排';
  btn.setAttribute('aria-label', btn.title);
  setWidth(Number(localStorage.getItem(widthKey())) || DEFAULT_W[layout]);
}

function setMaxed(panel) {
  const dock = $('#dock');
  for (const p of dock.querySelectorAll('.dock-panel')) {
    const on = p === panel;
    p.classList.toggle('maxed', on);
    const b = p.querySelector('.panel-max');
    if (b) {
      b.innerHTML = icon(on ? 'minimize' : 'maximize', 14);
      b.title = on ? '还原' : '最大化';
      b.setAttribute('aria-label', b.title);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  dock.classList.toggle('has-max', !!panel);
}

export function initDock() {
  // 每个面板标题栏加一个“最大化”按钮（放在关闭按钮前面）
  for (const id of PANELS) {
    const panel = $(`#${id}`);
    const head = panel.querySelector('.panel-head');
    const btn = h('button', { class: 'icon-btn sm panel-max', title: '最大化', 'aria-label': '最大化', 'aria-pressed': 'false', html: icon('maximize', 14), onclick: () => setMaxed(panel.classList.contains('maxed') ? null : panel) });
    head.insertBefore(btn, head.lastElementChild);
  }
  $('#btn-dock-layout').addEventListener('click', () => {
    layout = layout === 'row' ? 'col' : 'row';
    localStorage.setItem('dockLayout', layout);
    applyLayout();
  });
  // 面板的 hidden 属性由各自的代码切换，这里统一监听
  const mo = new MutationObserver(syncDock);
  for (const id of PANELS) mo.observe($(`#${id}`), { attributes: true, attributeFilter: ['hidden'] });
  applyLayout();
  syncDock();
  const rz = $('#dock-resizer');
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('dragging');
    const move = (ev) => setWidth(innerWidth - ev.clientX);
    const up = () => {
      rz.classList.remove('dragging');
      rz.removeEventListener('pointermove', move);
      rz.removeEventListener('pointerup', up);
      setWidth($('#dock').getBoundingClientRect().width, true);
    };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up);
  });
  rz.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth($('#dock').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 20 : -20), true);
  });
  window.addEventListener('resize', clampWidth);
  // 展开侧边栏后可用宽度变小，同样要收窄停靠区
  new MutationObserver(clampWidth).observe($('#app'), { attributes: true, attributeFilter: ['class'] });
}

/** 切换对话 / 工作目录 / 重新连接后，让文件和改动面板跟着当前工作目录走 */
export function syncDockRoot(force = false) {
  const wd = currentWorkdir();
  if (!$('#files').hidden && (force || files.rootFor !== wd)) loadFiles(wd);
  if (!$('#changes').hidden && (force || changes.for !== wd)) loadChanges();
}

function emptyBox(el, title, text) {
  el.textContent = '';
  el.append(h('div', { class: 'panel-empty' }, title ? h('b', {}, title) : null, text ? h('span', {}, text) : null));
}

function loadingBox(el, text = '读取中…') {
  el.textContent = '';
  el.append(h('div', { class: 'conv-empty' }, h('span', { class: 'spinner' }), ` ${text}`));
}

// ======================= 服务器文件（树形） =======================

const files = { root: null, rootFor: null, home: null, nodes: new Map(), open: new Set(), search: null, seq: 0 };

const joinPath = (dir, name) => `${dir === '/' ? '' : dir}/${name}`;

function displayPath(p) {
  if (files.home && (p === files.home || p.startsWith(`${files.home}/`))) return `~${p.slice(files.home.length)}`;
  return p;
}

export function toggleFiles() {
  const panel = $('#files');
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  const wd = currentWorkdir();
  if (!files.root || files.rootFor !== wd) loadFiles(wd);
  else renderFiles();
  $('#files-filter').focus();
}

export async function loadFiles(p) {
  const list = $('#files-list');
  files.rootFor = p;
  files.root = null;
  files.nodes.clear();
  files.open.clear();
  if (!connected()) {
    emptyBox(list, '未连接服务器', '连接服务器后可以浏览文件');
    $('#files-path').textContent = '';
    return;
  }
  loadingBox(list);
  try {
    const r = await api.rfsList(p);
    if (files.rootFor !== p) return;
    files.root = r.path;
    files.home = r.home;
    files.nodes.set(r.path, { entries: r.entries });
    renderFiles();
  } catch (e) {
    if (files.rootFor === p) emptyBox(list, '无法读取目录', errMsg(e));
  }
}

async function toggleDir(dir) {
  if (files.open.has(dir)) {
    files.open.delete(dir);
    renderFiles();
    return;
  }
  files.open.add(dir);
  if (!files.nodes.has(dir) || files.nodes.get(dir).error) {
    files.nodes.set(dir, { loading: true });
    renderFiles();
    try {
      const r = await api.rfsList(dir);
      files.nodes.set(dir, { entries: r.entries });
    } catch (e) {
      files.nodes.set(dir, { error: errMsg(e) });
    }
  }
  renderFiles();
}

function fileMenu(anchor, full, type) {
  showMenu(anchor, [
    { text: '在输入框中引用', icon: 'pencil', onClick: () => hooks.fillInput(`@${full} `, true) },
    { text: '复制路径', icon: 'copy', onClick: () => copyText(full) },
    type === 'dir' ? { text: '在这里浏览', icon: 'folderOpen', onClick: () => loadFiles(full) } : null,
    type === 'dir' ? { text: '设为对话的工作目录', icon: 'server', onClick: () => hooks.setWorkdir(displayPath(full)) } : null,
  ]);
}

function fileRow(e, full, depth) {
  const isDir = e.type === 'dir';
  const open = isDir && files.open.has(full);
  const item = h(
    'button',
    {
      class: `file-item ${e.type}${open ? ' open' : ''}`,
      role: 'treeitem',
      'aria-expanded': isDir ? String(open) : null,
      title: full,
      style: `padding-left:${6 + depth * 14}px`,
      onclick: () => (isDir ? toggleDir(full) : previewFile(full)),
    },
    h('span', { class: 'chev' }, isDir ? svg('chevronRight', 13) : null),
    svg(isDir ? (open ? 'folderOpen' : 'folder') : 'file', 15),
    h('span', { class: 'fname' }, e.name),
    !isDir ? h('span', { class: 'fmeta' }, fmtSize(e.size)) : null,
  );
  item.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    fileMenu(item, full, e.type);
  });
  return item;
}

function appendRows(list, dir, depth) {
  const node = files.nodes.get(dir);
  const pad = `padding-left:${26 + depth * 14}px`;
  if (!node || node.loading) {
    list.append(h('div', { class: 'file-note', style: pad }, h('span', { class: 'spinner' }), ' 读取中…'));
    return;
  }
  if (node.error) {
    list.append(h('div', { class: 'file-note error', style: pad }, node.error));
    return;
  }
  const showHidden = $('#files-hidden').checked;
  const entries = node.entries.filter((e) => showHidden || !e.name.startsWith('.'));
  if (!entries.length && depth > 0) list.append(h('div', { class: 'file-note', style: pad }, '空文件夹'));
  for (const e of entries) {
    const full = joinPath(dir, e.name);
    list.append(fileRow(e, full, depth));
    if (e.type === 'dir' && files.open.has(full)) appendRows(list, full, depth + 1);
  }
}

function renderFiles() {
  const list = $('#files-list');
  if (!files.root) return;
  // LRM：容器用 rtl 实现左侧省略号，避免开头的 / 被挪到末尾
  $('#files-path').textContent = `\u200E${displayPath(files.root)}\u200E`;
  $('#files-path').title = files.root;
  list.textContent = '';
  if (files.search) {
    renderSearch(list);
    return;
  }
  if (files.root !== '/') {
    const parent = files.root.replace(/\/[^/]*$/, '') || '/';
    list.append(h('button', { class: 'file-item dir', title: parent, onclick: () => loadFiles(parent) }, h('span', { class: 'chev' }), svg('arrowUpDir', 15), h('span', { class: 'fname' }, '..')));
  }
  appendRows(list, files.root, 0);
}

function renderSearch(list) {
  const s = files.search;
  if (s.loading) {
    loadingBox(list, s.content ? '正在搜索内容…' : '正在查找…');
    return;
  }
  if (s.error) {
    emptyBox(list, '搜索失败', s.error);
    return;
  }
  if (!s.results.length) {
    emptyBox(list, null, s.content ? '没有文件包含这段内容' : '没有匹配的文件');
    return;
  }
  for (const r of s.results) {
    const full = joinPath(files.root, r.path);
    const name = r.path.split('/').pop();
    const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '';
    const item = h(
      'button',
      { class: `file-item search ${r.type}`, title: full, onclick: () => (r.type === 'dir' ? loadFiles(full) : previewFile(full)) },
      svg(r.type === 'dir' ? 'folder' : 'file', 15),
      h('span', { class: 'fname' }, h('span', {}, name), dir ? h('span', { class: 'fdir' }, dir) : null, r.text ? h('span', { class: 'fhit' }, `${r.line}: ${r.text}`) : null),
    );
    item.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      fileMenu(item, full, r.type);
    });
    list.append(item);
  }
  if (s.results.length >= (s.content ? 100 : 200)) list.append(h('div', { class: 'file-note' }, '结果较多，只显示前一部分，请输入更具体的关键词'));
}

let filterTimer = null;

function onFilter(value) {
  clearTimeout(filterTimer);
  const v = value.trim();
  const seq = ++files.seq;
  if (!v || v === '?') {
    files.search = null;
    renderFiles();
    return;
  }
  const content = v.startsWith('?');
  const q = content ? v.slice(1).trim() : v;
  files.search = { loading: true, content, results: [] };
  filterTimer = setTimeout(async () => {
    if (!files.root) return;
    renderFiles();
    try {
      const r = content ? await api.rfsGrep(files.root, q) : await api.rfsFind(files.root, q);
      if (seq !== files.seq) return;
      files.search = { content, results: r.results };
    } catch (e) {
      if (seq !== files.seq) return;
      files.search = { content, results: [], error: errMsg(e) };
    }
    renderFiles();
  }, 300);
}

async function previewFile(p) {
  let r;
  try {
    r = await api.rfsRead(p);
  } catch (e) {
    toast(errMsg(e), 'error');
    return;
  }
  if (r.image) {
    lightbox(r.image, p);
    return;
  }
  const body = h('div', { class: 'dialog-body file-preview' });
  if (r.binary) body.append(h('p', {}, `二进制文件（${fmtSize(r.size)}），无法预览。`));
  else {
    if (r.truncated) body.append(h('p', { class: 'hint-text' }, `文件较大（${fmtSize(r.size)}），只显示前 2 MB。`));
    if (/\.md$/i.test(p)) {
      const md = h('div', { class: 'md' });
      md.innerHTML = renderMarkdown(r.content);
      body.append(md);
    } else body.append(h('pre', { class: 'code-view' }, r.content));
  }
  const dlg = dialogShell({
    title: displayPath(p),
    wide: true,
    cls: 'viewer',
    body,
    foot: h(
      'div',
      { class: 'dialog-foot' },
      h('button', { class: 'btn', onclick: () => copyText(p) }, '复制路径'),
      h('button', { class: 'btn', onclick: () => (m.close(), hooks.fillInput(`@${p} `, true)) }, '在输入框中引用'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => m.close() }, '关闭'),
    ),
  });
  const m = openModal(dlg);
}

export function initFiles() {
  $('#btn-files-close').addEventListener('click', () => ($('#files').hidden = true));
  $('#btn-files-home').addEventListener('click', () => {
    $('#files-filter').value = '';
    files.search = null;
    loadFiles(currentWorkdir());
  });
  $('#btn-files-refresh').addEventListener('click', () => {
    if (files.search) onFilter($('#files-filter').value);
    else loadFiles(files.root || currentWorkdir());
  });
  $('#files-hidden').addEventListener('change', () => files.root && renderFiles());
  const input = $('#files-filter');
  input.addEventListener('input', () => onFilter(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      onFilter('');
    }
  });
}

// ======================= Git 改动 =======================

const changes = { data: null, for: null, seq: 0 };

const STATUS = {
  modified: ['M', '已修改'],
  added: ['A', '新增'],
  untracked: ['U', '未跟踪的新文件'],
  deleted: ['D', '已删除'],
  renamed: ['R', '重命名'],
  conflict: ['!', '有冲突'],
};

export function toggleChanges() {
  const panel = $('#changes');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) loadChanges();
}

/** Claude 完成一轮后刷新（面板打开时） */
export function refreshChanges() {
  if (!$('#changes').hidden) loadChanges();
}

export async function loadChanges() {
  const list = $('#changes-list');
  const wd = currentWorkdir();
  const seq = ++changes.seq;
  changes.for = wd;
  if (!connected()) {
    $('#changes-title').textContent = '改动';
    emptyBox(list, '未连接服务器', '连接服务器后显示工作目录里的改动');
    return;
  }
  if (!changes.data) loadingBox(list);
  try {
    const r = await api.gitStatus(wd);
    if (seq !== changes.seq) return;
    changes.data = r;
    renderChanges();
  } catch (e) {
    if (seq === changes.seq) emptyBox(list, '读取失败', errMsg(e));
  }
}

function renderChanges() {
  const list = $('#changes-list');
  const r = changes.data;
  list.textContent = '';
  if (!r.repo) {
    $('#changes-title').textContent = '改动';
    emptyBox(list, '需要 Git 仓库', '这个对话的工作目录不是 Git 仓库，或者无法访问。');
    return;
  }
  $('#changes-title').textContent = r.branch ? `改动 · ${r.branch}` : '改动';
  if (!r.files.length) {
    emptyBox(list, '没有改动', '工作区和最近一次提交一致');
    return;
  }
  const adds = r.files.reduce((s, f) => s + (f.adds || 0), 0);
  const dels = r.files.reduce((s, f) => s + (f.dels || 0), 0);
  list.append(h('div', { class: 'chg-sum' }, `${r.files.length} 个文件`, h('span', { class: 'add' }, ` +${adds}`), h('span', { class: 'del' }, ` −${dels}`)));
  for (const f of r.files) {
    const [letter, label] = STATUS[f.status] || ['?', f.status];
    const name = f.path.split('/').pop();
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const item = h(
      'button',
      { class: 'chg-item', title: `${label}：${f.from ? `${f.from} → ` : ''}${f.path}`, onclick: () => openDiff(r, f) },
      h('span', { class: `chg-st ${f.status}`, 'aria-label': label }, letter),
      h('span', { class: 'chg-name' }, name, dir ? h('span', { class: 'chg-dir' }, dir) : null),
      f.binary ? h('span', { class: 'chg-num' }, '二进制') : f.adds != null || f.dels != null ? h('span', { class: 'chg-num' }, h('span', { class: 'add' }, `+${f.adds || 0}`), ' ', h('span', { class: 'del' }, `−${f.dels || 0}`)) : null,
    );
    item.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const full = `${r.root}/${f.path}`;
      showMenu(item, [
        { text: '在输入框中引用', icon: 'pencil', onClick: () => hooks.fillInput(`@${full} `, true) },
        { text: '复制路径', icon: 'copy', onClick: () => copyText(full) },
      ]);
    });
    list.append(item);
  }
}

function diffLine(cls, sign, text, oldNo, newNo) {
  return h('div', { class: `dl ${cls}` }, h('span', { class: 'ln' }, oldNo ?? ''), h('span', { class: 'ln' }, newNo ?? ''), h('span', { class: 'sg' }, sign), h('span', { class: 'tx' }, text));
}

/** 把 git diff 的统一格式输出渲染成和工具卡片一样的 diff */
function renderUnified(text, file) {
  const box = h('div', { class: 'diff' });
  const body = h('div', { class: 'diff-body' });
  let adds = 0;
  let dels = 0;
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      inHunk = true;
      body.append(h('div', { class: 'dl hunk' }, raw));
      continue;
    }
    if (!inHunk) {
      if (/^Binary files/.test(raw)) body.append(h('div', { class: 'dl hunk' }, '二进制文件，无法显示差异'));
      continue;
    }
    if (raw.startsWith('+')) {
      adds++;
      body.append(diffLine('add', '+', raw.slice(1), null, n++));
    } else if (raw.startsWith('-')) {
      dels++;
      body.append(diffLine('del', '-', raw.slice(1), o++, null));
    } else if (raw.startsWith(' ')) body.append(diffLine('ctx', ' ', raw.slice(1), o++, n++));
    else if (raw.startsWith('\\')) body.append(h('div', { class: 'dl hunk' }, raw));
    else if (raw.startsWith('diff --git')) inHunk = false;
  }
  if (!body.children.length) body.append(h('div', { class: 'dl hunk' }, '没有可显示的差异'));
  box.append(h('div', { class: 'diff-head' }, svg('file', 13), h('span', { class: 'diff-file', title: file }, `\u200E${file}\u200E`), h('span', { class: 'diff-stat' }, h('span', { class: 'add' }, `+${adds}`), ' ', h('span', { class: 'del' }, `-${dels}`))), body);
  return box;
}

async function openDiff(repo, f) {
  const full = `${repo.root}/${f.path}`;
  const body = h('div', { class: 'dialog-body' });
  loadingBox(body, '正在读取差异…');
  const dlg = dialogShell({
    title: f.path,
    wide: true,
    cls: 'viewer',
    body,
    foot: h(
      'div',
      { class: 'dialog-foot' },
      h('button', { class: 'btn', onclick: () => copyText(full) }, '复制路径'),
      h('button', { class: 'btn', onclick: () => (m.close(), hooks.fillInput(`@${full} `, true)) }, '在输入框中引用'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => m.close() }, '关闭'),
    ),
  });
  const m = openModal(dlg);
  try {
    const r = await api.gitDiff(repo.root, f.path, { untracked: f.status === 'untracked' });
    body.textContent = '';
    if (r.truncated) body.append(h('p', { class: 'hint-text' }, '差异较大，只显示前一部分。'));
    body.append(renderUnified(r.diff, f.path));
  } catch (e) {
    body.textContent = '';
    body.append(h('div', { class: 'status-box error' }, errMsg(e)));
  }
}

export function initChanges() {
  $('#btn-changes-close').addEventListener('click', () => ($('#changes').hidden = true));
  $('#btn-changes-refresh').addEventListener('click', () => loadChanges());
}
