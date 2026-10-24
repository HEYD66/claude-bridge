// 渲染进程入口：侧边栏、首页、输入区、导航，以及主进程事件分发
import { icon, spark, crab } from './icons.js';
import {
  api,
  state,
  hooks,
  $,
  h,
  svg,
  errMsg,
  toast,
  fmtTime,
  fmtTokens,
  fmtHour,
  modelName,
  workdirName,
  translationOn,
  connected,
  currentWorkdir,
  currentRunning,
  patchSettings,
  toggleSet,
  kv,
  clip,
  showMenu,
  closeMenu,
  openModal,
  dialogShell,
  promptDialog,
  lightbox,
} from './core.js';
import { renderMessage, renderTodos, latestTodos } from './messages.js';
import { initTerminal, openTerminalPanel, initFiles, toggleFiles, contextPopover, renderRateLimits, importDialog, openCustomize } from './panels.js';
import { openSettings, EFFORT_OPTIONS, PERM_OPTIONS } from './settings.js';

// 后退 / 前进历史（null 表示首页）
const nav = { stack: [null], idx: 0 };
// 每个对话的输入框草稿（'' 表示首页）
const drafts = new Map();
let todoOpen = false;
let slashSel = 0;
let searchTimer = null;
let searchSeq = 0;
let attSeq = 0;
let dragDepth = 0;

const IMAGE_TYPE_RE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

const PERM_LABELS = { ...Object.fromEntries(PERM_OPTIONS.map(([v, t]) => [v, t])), default: '逐项确认' };
const PERM_CYCLE = ['', 'acceptEdits', 'plan'];
const EFFORT_LABEL = Object.fromEntries(EFFORT_OPTIONS);
// 未连接 / 未读取到服务器信息时的备用模型列表
const FALLBACK_MODELS = [
  { value: 'default', name: '默认模型', description: '使用服务器上的默认设置' },
  { value: 'opus', name: 'Opus', description: '' },
  { value: 'sonnet', name: 'Sonnet', description: '' },
  { value: 'haiku', name: 'Haiku', description: '' },
];

const COWORK_STARTERS = [
  ['folderOpen', '整理文件夹', '把我共享的下载文件夹按文件类型整理到子文件夹里，先列出计划给我确认再动手。'],
  ['monitor', '看看我的屏幕', '截一张我的桌面截图，告诉我现在打开了哪些窗口、分别在做什么。'],
  ['file', '总结最近的文档', '在共享文件夹里找出最近一周修改过的文档，逐个给出简短总结。'],
  ['image', '批量重命名图片', '把共享文件夹里的图片按修改日期重命名为 YYYY-MM-DD_序号 的格式，先给我看改名方案。'],
];

// ======================= 来自主进程的确认请求 =======================

const askQueue = [];
let askActive = null;

function pumpAsk() {
  if (askActive || !askQueue.length) return;
  const req = askQueue.shift();
  let answered = false;
  const respond = (answer) => {
    if (answered) return;
    answered = true;
    api.answer(req.id, answer);
  };
  let modal = null;
  const done = (answer) => {
    respond(answer);
    modal.close('answered');
  };
  const dlg = buildAskDialog(req, done);
  modal = openModal(dlg, {
    top: true,
    dismissible: false,
    onClose: (reason) => {
      if (reason !== 'cancelled') respond({ ok: false });
      askActive = null;
      setTimeout(pumpAsk, 60);
    },
  });
  askActive = { id: req.id, modal };
}

function buildAskDialog(req, done) {
  const p = req.payload || {};
  const always = h('input', { type: 'checkbox' });
  const allowBtn = (text = '允许') => h('button', { class: 'btn primary', onclick: () => done({ ok: true, always: always.checked }) }, text);
  const denyBtn = (text = '拒绝') => h('button', { class: 'btn', onclick: () => done({ ok: false }) }, text);

  if (req.kind === 'hostkey') {
    const changed = !!p.previous;
    return dialogShell({
      title: changed ? '服务器指纹已变化' : '确认服务器身份',
      badge: icon(changed ? 'alert' : 'key', 20),
      body: h(
        'div',
        { class: 'dialog-body' },
        h(
          'p',
          {},
          changed
            ? '该服务器的主机密钥与上次连接时不同。如果你没有重装系统或更换密钥，这可能意味着连接被劫持（中间人攻击），请勿继续。'
            : '首次连接该服务器。请核对下方指纹与服务器上 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 的输出一致后再信任。',
        ),
        kv([['主机', p.host], ['新指纹', p.fingerprint], changed ? ['旧指纹', p.previous] : null]),
      ),
      foot: h('div', { class: 'dialog-foot' }, denyBtn('取消'), h('button', { class: `btn ${changed ? 'danger' : 'primary'}`, onclick: () => done({ ok: true }) }, changed ? '仍然信任' : '信任并连接')),
    });
  }

  if (req.kind === 'confirm') {
    const body = h('div', { class: 'dialog-body' });
    const kind = String(p.kind || '');
    let alwaysText = '本次运行期间自动允许同类操作';
    if (kind === 'write') {
      body.append(kv([['文件', p.path], ['大小', `${(p.preview || '').length} 字符`]]), h('pre', {}, clip(p.preview)));
    } else if (kind === 'edit') {
      body.append(kv([['文件', p.path], ['替换', `${p.count || 1} 处`]]), h('div', { class: 'tool-sec' }, '原内容'), h('pre', { class: 'del' }, clip(p.oldText, 3000)), h('div', { class: 'tool-sec' }, '新内容'), h('pre', { class: 'add' }, clip(p.newText, 3000)));
    } else if (kind === 'move') {
      body.append(kv([['从', p.path], ['到', p.destination]]));
    } else if (kind === 'delete') {
      body.append(kv([['路径', p.path]]), h('p', {}, '文件会被移入回收站，可以从回收站恢复。'));
    } else if (kind === 'command') {
      body.append(kv([['目录', p.cwd]]), h('pre', {}, clip(p.command, 4000)));
    } else if (kind.startsWith('desktop:')) {
      // Windows-MCP 桌面操作
      body.append(h('p', {}, '服务器上的 Claude 想要直接操作这台电脑的桌面。请确认参数无误后再允许。'), kv([['操作', p.desktopTool || kind.slice(8)]]));
      if (p.preview && p.preview !== '{}') body.append(h('pre', {}, clip(p.preview, 4000)));
      alwaysText = `本次运行期间自动允许 ${p.desktopTool || '该操作'}`;
    }
    return dialogShell({
      title: p.title || 'Claude 请求操作本机',
      badge: icon('monitor', 20),
      body,
      foot: h('div', { class: 'dialog-foot' }, h('label', { class: 'check-line' }, always, alwaysText), h('span', { class: 'spacer' }), denyBtn(), allowBtn()),
    });
  }

  return dialogShell({ title: '未知请求', body: h('div', { class: 'dialog-body' }, h('pre', {}, JSON.stringify(req, null, 2))), foot: h('div', { class: 'dialog-foot' }, denyBtn('关闭')) });
}

// ======================= 侧边栏 =======================

function convsForMode() {
  return state.convs.filter((c) => (c.mode || 'code') === state.mode);
}

function renderModeSeg() {
  for (const b of document.querySelectorAll('.mode-seg button')) {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('#app').classList.toggle('mode-cowork', state.mode === 'cowork');
}

function renderSidebar() {
  $('#btn-new-chat').classList.toggle('active', !state.currentId);
  const box = $('#conv-groups');
  box.textContent = '';
  const q = state.search.trim();
  if (q) {
    renderSearchResults(box, q);
    return;
  }
  const list = convsForMode();
  if (!list.length) {
    box.append(h('div', { class: 'conv-empty' }, state.mode === 'cowork' ? '还没有 Cowork 任务' : '还没有对话'));
    return;
  }
  const pinned = list.filter((c) => c.pinned);
  const rest = list.filter((c) => !c.pinned);
  if (pinned.length) box.append(groupEl({ name: '已置顶', pin: true }, pinned));
  if (state.mode === 'cowork') {
    if (rest.length) box.append(groupEl({ name: '最近', onNew: () => newChat() }, rest));
    return;
  }
  // Code 模式按服务器工作目录分组（相当于 Claude 客户端里的项目）
  const groups = new Map();
  for (const c of rest) {
    const wd = c.workdir || '~';
    if (!groups.has(wd)) groups.set(wd, []);
    groups.get(wd).push(c);
  }
  const curWd = state.current ? state.current.workdir : null;
  for (const [wd, items] of groups) {
    box.append(groupEl({ name: workdirName(wd), title: `服务器目录：${wd}`, current: wd === curWd, onNew: () => newChat(wd), newTitle: `在 ${wd} 中新建对话` }, items));
  }
}

function groupEl(g, items) {
  const group = h(
    'div',
    { class: `group${g.current ? ' current' : ''}`, role: 'group', 'aria-label': g.name },
    h(
      'div',
      { class: 'group-head', title: g.title || g.name },
      g.pin ? h('span', { class: 'pin-ic', html: icon('pin', 13) }) : null,
      h('span', { class: 'group-name' }, g.name),
      g.onNew ? h('button', { class: 'icon-btn', title: g.newTitle || '新对话', 'aria-label': g.newTitle || '新对话', html: icon('plus', 15), onclick: g.onNew }) : null,
      h('button', { class: 'icon-btn', title: '搜索对话 (Ctrl+K)', 'aria-label': '搜索对话', html: icon('search', 14), onclick: () => toggleSearch(true) }),
    ),
  );
  for (const c of items) group.append(convItem(c));
  return group;
}

function convItem(c) {
  const running = state.running.has(c.id);
  const item = h(
    'div',
    { class: `conv-item${c.id === state.currentId ? ' active' : ''}`, role: 'button', tabindex: '0', title: c.title, 'aria-current': c.id === state.currentId ? 'page' : null },
    running ? h('span', { class: 'conv-bullet running', title: '运行中' }) : h('span', { class: 'conv-bullet', html: icon('circle', 11) }),
    h('span', { class: 'conv-title' }, c.title || '新对话'),
    h('button', {
      class: 'icon-btn conv-more',
      title: '更多操作',
      'aria-label': '更多操作',
      'aria-haspopup': 'menu',
      html: icon('more', 15),
      onclick: (e) => {
        e.stopPropagation();
        convMenu(c, e.currentTarget);
      },
    }),
  );
  item.addEventListener('click', () => go(c.id));
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === item) go(c.id);
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    convMenu(c, item.querySelector('.conv-more'));
  });
  return item;
}

function convMenu(c, anchor) {
  const sum = state.convs.find((x) => x.id === c.id) || c;
  showMenu(anchor, [
    { text: '重命名', icon: 'pencil', onClick: () => renameConv(sum) },
    { text: sum.pinned ? '取消置顶' : '置顶', icon: 'pin', onClick: () => api.pinConversation(sum.id, !sum.pinned) },
    (sum.mode || 'code') === 'code' ? { text: '修改服务器目录', icon: 'server', onClick: () => editWorkdir(sum.id) } : null,
    { text: '在新窗口中打开', icon: 'external', onClick: () => api.openInWindow(sum.id) },
    { text: '导出为 Markdown', icon: 'download', onClick: () => exportConv(sum.id) },
    '-',
    { text: '删除', icon: 'trash', danger: true, onClick: () => deleteConv(sum) },
  ]);
}

// ---- 全文搜索 ----

function toggleSearch(open) {
  const box = $('#side-search');
  const show = open === undefined ? box.hidden : open;
  box.hidden = !show;
  if (show) {
    $('#search-input').focus();
    $('#search-input').select();
  } else {
    state.search = '';
    state.searchResults = null;
    $('#search-input').value = '';
    renderSidebar();
  }
}

function onSearchInput(value) {
  state.search = value;
  clearTimeout(searchTimer);
  const q = value.trim();
  const seq = ++searchSeq;
  if (!q) {
    state.searchResults = null;
    renderSidebar();
    return;
  }
  renderSidebar();
  searchTimer = setTimeout(async () => {
    let result;
    try {
      result = { q, hits: await api.search(q) };
    } catch (e) {
      result = { q, hits: [], error: errMsg(e) };
    }
    if (seq !== searchSeq) return;
    state.searchResults = result;
    renderSidebar();
  }, 180);
}

function renderSearchResults(box, q) {
  const res = state.searchResults;
  if (!res || res.q !== q) {
    box.append(h('div', { class: 'conv-empty' }, h('span', { class: 'spinner' }), ' 搜索中…'));
    return;
  }
  if (res.error) {
    box.append(h('div', { class: 'conv-empty error' }, res.error));
    return;
  }
  if (!res.hits.length) {
    box.append(h('div', { class: 'conv-empty' }, '没有匹配的对话'));
    return;
  }
  const group = h('div', { class: 'group', role: 'list', 'aria-label': '搜索结果' }, h('div', { class: 'group-head' }, h('span', { class: 'group-name' }, `${res.hits.length} 条结果`)));
  for (const r of res.hits) {
    // 摘要里去掉常见的 Markdown 标记
    const snippet = String(r.snippet || '').replace(/\*\*|__|`/g, '');
    group.append(h('button', { class: 'search-hit', role: 'listitem', title: snippet, onclick: () => openHit(r) }, h('span', { class: 't' }, r.title || '新对话'), r.msgId ? h('span', { class: 's' }, snippet) : null));
  }
  box.append(group);
}

async function openHit(r) {
  await go(r.convId);
  if (r.msgId) flashMessage(r.msgId);
}

function flashMessage(id) {
  const el = document.querySelector(`#messages .msg[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1800);
}

// ---- 账号 / 菜单 ----

const SSH_LABELS = { disconnected: '未连接', connecting: '连接中…', connected: '已连接', reconnecting: '重连中…', error: '连接失败' };

function connStatusText() {
  const st = (state.status && state.status.ssh) || { state: 'disconnected' };
  let text = SSH_LABELS[st.state] || st.state;
  if (st.state === 'connected' && state.settings.mcp.enabled) text += state.status.mcp.remotePort ? ' · 本机隧道已建立' : ' · 本机隧道未建立';
  if ((st.state === 'error' || st.state === 'reconnecting') && st.error) text = st.error;
  if (st.state === 'connected' && st.tunnelError) text = st.tunnelError;
  return text;
}

function renderAccount() {
  const st = (state.status && state.status.ssh) || { state: 'disconnected' };
  const s = state.settings.ssh;
  const el = $('#account');
  el.textContent = '';
  const name = (state.appInfo && state.appInfo.username) || s.username || '我';
  const sub = s.host ? `${s.username}@${s.host}` : '未配置服务器';
  el.title = connStatusText();
  el.setAttribute('aria-label', `${name}，${sub}，${connStatusText()}`);
  el.append(h('span', { html: spark(18) }), h('span', { class: 'account-text' }, name, h('span', { class: 'sub' }, ` · ${sub}`)), h('span', { class: `dot ${st.state}` }), h('span', { class: 'chev', html: icon('chevronDown', 15) }));
}

function accountMenu(anchor) {
  const st = (state.status && state.status.ssh) || { state: 'disconnected' };
  const configured = !!state.settings.ssh.host;
  const busy = ['connected', 'connecting', 'reconnecting'].includes(st.state);
  const on = st.state === 'connected';
  const info = state.claudeInfo;
  const account = info && info.account;
  showMenu(
    anchor,
    [
      { heading: connStatusText() },
      account && account.email ? { text: account.email, desc: account.subscriptionType ? `Claude ${account.subscriptionType}` : '服务器上登录的 Claude 账号', disabled: true } : null,
      configured && !busy ? { text: '连接服务器', icon: 'plug', onClick: connect } : null,
      busy ? { text: on ? '断开连接' : '取消连接', icon: 'logout', onClick: disconnect } : null,
      '-',
      on ? { text: '终端', icon: 'terminal', desc: 'Ctrl+`', onClick: () => openTerminalPanel({}) } : null,
      configured ? { text: '在外部终端中打开', icon: 'external', onClick: openExternalTerminal } : null,
      on ? { text: '登录服务器上的 Claude…', icon: 'key', onClick: () => openTerminalPanel({ kind: 'login' }) } : null,
      on ? { text: '更新 Claude Code…', icon: 'download', onClick: () => openTerminalPanel({ kind: 'update' }) } : null,
      { text: '用量额度', icon: 'gauge', onClick: showLimits },
      '-',
      { text: '服务器设置', icon: 'server', onClick: () => openSettings('ssh') },
      { text: 'Claude 设置', icon: 'tool', onClick: () => openSettings('claude') },
    ],
    { above: true },
  );
}

function appMenu(anchor) {
  const theme = state.settings.ui.theme;
  const setTheme = (t) => patchSettings((s) => (s.ui.theme = t));
  showMenu(anchor, [
    { text: '新对话', icon: 'plus', desc: 'Ctrl+N', onClick: () => newChat() },
    { text: '新窗口', icon: 'external', desc: 'Ctrl+Shift+N', onClick: () => api.newWindow() },
    '-',
    { text: '设置', icon: 'settings', desc: 'Ctrl+,', onClick: () => openSettings('ssh') },
    { text: '自定义', icon: 'briefcase', onClick: () => customize() },
    { text: '导入服务器上的会话', icon: 'download', onClick: importDialog },
    { text: '服务器文件', icon: 'folderOpen', onClick: openFiles },
    { text: '本机操作记录', icon: 'list', onClick: toggleActivity },
    '-',
    { heading: '主题' },
    { text: '跟随系统', checked: theme === 'system', onClick: () => setTheme('system') },
    { text: '浅色', checked: theme === 'light', onClick: () => setTheme('light') },
    { text: '深色', checked: theme === 'dark', onClick: () => setTheme('dark') },
    '-',
    { text: `Claude Bridge ${state.appInfo ? state.appInfo.version : ''}`, disabled: true },
  ]);
}

function showLimits() {
  const box = h('div', { class: 'dialog-body' });
  renderRateLimits(box, state.rateLimits);
  const dlg = dialogShell({
    title: '用量额度',
    badge: icon('gauge', 20),
    body: box,
    foot: h('div', { class: 'dialog-foot' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => m.close() }, '关闭')),
  });
  const m = openModal(dlg);
}

async function connect() {
  try {
    state.status = await api.connect();
    renderAll();
    refreshBranch();
  } catch (e) {
    toast(`连接失败：${errMsg(e)}`, 'error');
  }
}

async function disconnect() {
  state.status = await api.disconnect();
  state.branch = null;
  state.branchFor = null;
  renderAll();
}

async function openExternalTerminal() {
  try {
    await api.openTerminal(currentWorkdir());
    toast('已在新窗口中打开 SSH 终端');
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

function toggleTerminal() {
  const panel = $('#term-panel');
  if (!panel.hidden) {
    // 只隐藏面板，终端会话保留，再次打开时继续使用
    panel.hidden = true;
    $('#input').focus();
    return;
  }
  openTerminalPanel({});
}

async function customize(tab) {
  try {
    const info = await api.appInfo();
    if (info.memoryPaths) state.memoryPaths = info.memoryPaths;
  } catch {
    /* 忽略 */
  }
  openCustomize(tab);
}

// ======================= 首页 =======================

function renderHome() {
  const cowork = state.mode === 'cowork';
  $('#greet-logo').innerHTML = cowork ? icon('cowork', 26, 'spark') : spark(26);
  const name = state.appInfo && state.appInfo.username;
  $('#greet-text').textContent = cowork ? (name ? `${name}，今天想让我帮你做什么？` : '今天想让我帮你做什么？') : name ? `接下来做什么，${name}？` : '接下来做什么？';
  renderStarters();
  loadStats();
}

function renderStarters() {
  const box = $('#starters');
  box.textContent = '';
  box.hidden = state.mode !== 'cowork';
  if (box.hidden) return;
  box.append(
    ...COWORK_STARTERS.map(([ic, title, prompt]) =>
      h('button', { class: 'starter', title: prompt, onclick: () => hooks.fillInput(prompt) }, svg(ic, 16), h('span', { class: 'st-t' }, title), h('span', { class: 'st-d' }, prompt)),
    ),
  );
}

async function loadStats() {
  try {
    state.stats = await api.getStats(state.statsRange);
    if (!state.rateLimits && state.stats.rateLimits) state.rateLimits = state.stats.rateLimits;
  } catch {
    state.stats = null;
  }
  renderStats();
}

function seg(options, current, onPick, label) {
  return h(
    'div',
    { class: 'seg', role: 'tablist', 'aria-label': label },
    options.map(([v, t]) => h('button', { class: v === current ? 'on' : '', role: 'tab', 'aria-selected': String(v === current), onclick: () => onPick(v) }, t)),
  );
}

function renderStats() {
  const box = $('#stats');
  box.textContent = '';
  const s = state.stats;
  if (!s) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const tabs = seg([['overview', '概览'], ['models', '模型'], ['limits', '额度']], state.statsTab, (v) => {
    state.statsTab = v;
    renderStats();
  }, '统计视图');
  const range =
    state.statsTab === 'limits'
      ? null
      : seg([['all', '全部'], ['30d', '30 天'], ['7d', '7 天']], state.statsRange, (v) => {
          state.statsRange = v;
          loadStats();
        }, '时间范围');
  box.append(h('div', { class: 'stats-head' }, tabs, range));

  if (state.statsTab === 'limits') {
    renderRateLimits(box, state.rateLimits || s.rateLimits);
    return;
  }
  if (state.statsTab === 'models') {
    if (!s.models.length) {
      box.append(h('div', { class: 'stats-foot' }, '还没有模型使用记录。'));
      return;
    }
    const max = Math.max(...s.models.map((m) => m.tokens), 1);
    for (const m of s.models) {
      box.append(
        h(
          'div',
          { class: 'model-row' },
          h('span', { class: 'name', title: m.model }, modelName(m.model)),
          h('span', { class: 'num' }, `${fmtTokens(m.tokens)} tokens · ${m.messages} 条`),
          h('div', { class: 'bar' }, h('span', { style: `width:${Math.max(2, Math.round((m.tokens / max) * 100))}%` })),
        ),
      );
    }
    return;
  }
  const tiles = [
    ['会话', s.sessions],
    ['消息', s.messages.toLocaleString()],
    ['总 Token', fmtTokens(s.tokens)],
    ['活跃天数', s.activeDays],
    ['高峰时段', fmtHour(s.peakHour)],
    ['常用模型', modelName(s.favoriteModel) || '—'],
  ];
  box.append(h('div', { class: 'tiles' }, tiles.map(([k, v]) => h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v', title: String(v) }, v)))));
  const max = Math.max(...s.heatmap.map((d) => d.count), 0);
  box.append(
    h(
      'div',
      { class: 'heatmap', role: 'img', 'aria-label': '最近 26 周的活跃度' },
      s.heatmap.map((d) => {
        const lv = d.count && max ? Math.min(4, Math.ceil((d.count / max) * 4)) : 0;
        return h('span', { class: `cell${lv ? ` l${lv}` : ''}`, title: `${d.date}：${d.count} 条消息` });
      }),
    ),
  );
  const books = Math.round(s.tokens / 22000);
  box.append(h('div', { class: 'stats-foot' }, books >= 1 ? `你用掉的 token 大约相当于 ${books.toLocaleString()} 本《小王子》。` : '统计数据来自本机保存的对话记录。'));
}

// ======================= 顶栏 / 输入区 =======================

function renderHeader() {
  const head = $('#conv-head');
  head.textContent = '';
  $('#main').classList.toggle('is-home', !state.current);
  if (!state.current) return;
  const c = state.current;
  const cowork = c.mode === 'cowork';
  // 原生 append 会把 null 当成文字插入，先过滤
  const items = [
    h('button', { class: 'title-btn', 'aria-haspopup': 'menu', title: c.title, onclick: (e) => convMenu(c, e.currentTarget) }, svg(cowork ? 'cowork' : 'server', 15), h('span', { class: 't' }, c.title), svg('chevronDown', 14)),
    cowork ? null : h('button', { class: 'proj-tag', title: `服务器工作目录：${c.workdir}（点击修改）`, onclick: () => editWorkdir(c.id) }, workdirName(c.workdir)),
    c.worktree ? h('span', { class: 'proj-tag', title: 'Claude 在独立的 git worktree 中工作' }, 'worktree') : null,
  ];
  head.append(...items.filter(Boolean));
}

function desktopLabel() {
  if (!state.settings.mcp.desktop) return '桌面控制已关闭';
  const ds = state.status && state.status.desktop;
  if (!ds) return '桌面控制';
  return { ready: '桌面控制已就绪', starting: '桌面控制启动中…', error: '桌面控制启动失败', off: '桌面控制未启动' }[ds.state] || '桌面控制';
}

function renderChips() {
  const box = $('#chips');
  box.textContent = '';
  const st = (state.status && state.status.ssh) || { state: 'disconnected' };
  const s = state.settings;
  const wd = currentWorkdir();
  const cowork = state.mode === 'cowork';
  const ds = state.status && state.status.desktop;
  const chips = [
    h('button', { class: 'chip', title: `服务器：${connStatusText()}`, 'aria-haspopup': 'menu', onclick: (e) => accountMenu(e.currentTarget) }, svg('server', 14), h('span', {}, s.ssh.host || '未配置服务器'), h('span', { class: `dot ${st.state}` })),
    cowork ? null : h('button', { class: 'chip', title: `服务器工作目录：${wd}（点击修改）`, onclick: () => editWorkdir() }, svg('folder', 14), h('span', {}, workdirName(wd))),
    !cowork && state.branch ? h('span', { class: 'chip', title: `Git 分支：${state.branch}`, role: 'note' }, svg('branch', 14), h('span', {}, state.branch)) : null,
    !cowork && state.branch && !state.current
      ? h('button', {
          class: `chip${state.pendingWorktree ? ' on' : ''}`,
          'aria-pressed': String(!!state.pendingWorktree),
          title: '开启后 Claude 会在独立的 git worktree 中工作，不影响当前分支的文件',
          onclick: () => {
            state.pendingWorktree = !state.pendingWorktree;
            renderChips();
          },
        }, svg('layers', 14), h('span', {}, 'worktree'))
      : null,
    h('button', {
      class: `chip${s.mcp.enabled && s.mcp.roots.length ? ' on' : ''}`,
      title: s.mcp.enabled ? '服务器上的 Claude 可以访问的本机文件夹' : '本机访问已关闭',
      onclick: () => openSettings('mcp'),
    }, svg('monitor', 14), h('span', {}, !s.mcp.enabled ? '本机访问已关闭' : s.mcp.roots.length ? `本机 · ${s.mcp.roots.length} 个文件夹` : '本机 · 未共享')),
    cowork ? h('button', { class: `chip${s.mcp.desktop && ds && ds.state === 'ready' ? ' on' : ''}`, title: ds && ds.error ? ds.error : '让 Claude 截图、点击、输入来操作这台电脑', onclick: () => openSettings('mcp') }, svg('laptop', 14), h('span', {}, desktopLabel())) : null,
    h('button', { class: 'chip icon-only', title: '共享本机文件夹给 Claude', 'aria-label': '共享本机文件夹', html: icon('folderPlus', 15), onclick: addSharedFolders }),
  ];
  box.append(...chips.filter(Boolean));
}

function serverModels() {
  const info = state.claudeInfo;
  return info && Array.isArray(info.models) && info.models.length ? info.models : null;
}

/** 设置里的 model：'' 表示不传 --model，对应服务器列表里的 default */
function selectedModelEntry() {
  const v = state.settings.claude.model || 'default';
  return (serverModels() || []).find((m) => m.value === v) || null;
}

function modelDisplayName(m) {
  if (!m) return '';
  if (m.value === 'default') return '默认（推荐）';
  return m.name || m.value;
}

function modelDescription(m) {
  if (!m) return '';
  const d = m.descriptionZh || m.description || '';
  return d.replace(/^Use the default model \(currently ([^)]+)\)/, '使用默认模型（当前为 $1）');
}

function lastAssistantMeta() {
  const msgs = (state.current && state.current.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant' && msgs[i].meta && msgs[i].meta.contextTokens) return msgs[i].meta;
  return null;
}

function lastModel() {
  const msgs = (state.current && state.current.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].model) return msgs[i].model;
  return localStorage.getItem('lastModel') || '';
}

function renderMeta() {
  const c = state.settings.claude;
  const tr = state.settings.translation;
  const perm = $('#btn-perm');
  const mode = pendingPerm !== null ? pendingPerm : c.permissionMode;
  perm.innerHTML = `${icon('plus', 15)}<span>${PERM_LABELS[mode] || mode}</span>`;
  perm.title = '添加图片、本机文件 / 权限模式（Shift+Tab 切换）';
  const trBtn = $('#btn-translate');
  trBtn.innerHTML = `${icon('languages', 15)}<span>${tr.enabled ? '中英翻译' : '翻译已关闭'}</span>`;
  trBtn.classList.toggle('on', tr.enabled);
  trBtn.classList.toggle('off', !tr.enabled);
  trBtn.setAttribute('aria-pressed', String(tr.enabled));
  trBtn.title = tr.enabled ? '中文输入自动翻译成英文，英文回复翻译成中文（点击关闭）' : '点击开启中英双向翻译';

  const meta = lastAssistantMeta();
  const entry = selectedModelEntry();
  // 优先显示服务器解析出的真实模型（如 opus → Opus 5.5）
  const name = (entry && modelName(entry.resolved)) || modelName(c.model) || modelName(lastModel()) || '默认模型';
  const ctx = state.currentId && state.meta[state.currentId] && state.meta[state.currentId].context;
  const big = (ctx && ctx.maxTokens >= 1e6) || (meta && meta.contextWindow >= 1e6) || /\[1m\]$/i.test(c.model) ? ' 1M' : '';
  const mb = $('#btn-model');
  mb.textContent = name + big;
  mb.title = entry ? `模型：${modelDisplayName(entry)}${entry.resolved ? `（${entry.resolved}）` : ''}` : '选择模型';
  const eb = $('#btn-effort');
  const noEffort = entry && entry.supportsEffort === false;
  eb.textContent = noEffort ? '不支持思考强度' : c.effort ? EFFORT_LABEL[c.effort] || c.effort : '默认强度';
  eb.title = '思考强度';
  eb.disabled = !!noEffort;
  renderRing();
}

/** 上下文占用：优先用 get_context_usage 的精确结果，否则用最后一次回复的 token 数估算 */
function ctxInfo() {
  const meta = state.currentId && state.meta[state.currentId];
  const c = meta && meta.context;
  if (c && c.maxTokens) return { used: c.totalTokens || 0, win: c.maxTokens, pct: (c.totalTokens || 0) / c.maxTokens };
  if (c && typeof c.percentage === 'number') return { used: c.totalTokens || 0, win: c.maxTokens || 0, pct: c.percentage / 100 };
  const m = lastAssistantMeta();
  if (m) {
    const win = m.contextWindow || 200000;
    return { used: m.contextTokens, win, pct: m.contextTokens / win };
  }
  return null;
}

function renderRing() {
  const el = $('#ctx-ring');
  const info = state.current ? ctxInfo() : null;
  const pct = info ? Math.min(1, Math.max(0, info.pct || 0)) : 0;
  const r = 8;
  const len = 2 * Math.PI * r;
  el.className = `ctx-ring${pct > 0.9 ? ' full' : pct > 0.7 ? ' warn' : ''}`;
  el.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle class="track" cx="10" cy="10" r="${r}"/>${pct > 0 ? `<circle class="val" cx="10" cy="10" r="${r}" stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - pct)}"/>` : ''}</svg>`;
  el.title = info ? `上下文已用 ${Math.round(pct * 100)}%（${fmtTokens(info.used)} / ${fmtTokens(info.win)}），点击查看详情` : '上下文用量';
  el.setAttribute('aria-label', el.title);
}

function composerPlaceholder() {
  if (currentRunning()) return 'Claude 正在工作…继续输入会排队发送，Ctrl+Enter 立即插话';
  if (state.current) return '回复 Claude，输入 / 使用命令';
  return state.mode === 'cowork' ? '让 Claude 帮你处理本机文件、操作桌面…' : '描述任务或提出问题';
}

function renderComposer() {
  const running = currentRunning();
  const input = $('#input');
  const hasContent = !!input.value.trim() || state.attachments.length > 0;
  const btn = $('#btn-send');
  btn.innerHTML = icon('enter', 17);
  btn.classList.toggle('ready', hasContent);
  btn.disabled = !hasContent;
  btn.title = running ? '加入队列 (Enter)；Ctrl+Enter 立即插话' : '发送 (Enter)';
  btn.setAttribute('aria-label', running ? '加入队列' : '发送');
  const stop = $('#btn-stop');
  stop.hidden = !running;
  if (!stop.firstChild) stop.innerHTML = icon('stop', 16);
  input.placeholder = composerPlaceholder();
  renderSuggest();
}

function suggestionText() {
  const meta = state.currentId && state.meta[state.currentId];
  const sug = meta && meta.suggestion;
  if (!sug) return '';
  return translationOn() && sug.zh ? sug.zh : sug.text || '';
}

function renderSuggest() {
  const box = $('#suggest');
  const text = suggestionText();
  box.textContent = '';
  if (!text || currentRunning() || $('#input').value.trim()) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.append(h('button', { type: 'button', title: `${text}（Tab 填入）`, onclick: () => hooks.fillInput(text) }, svg('enter', 13), h('span', {}, text)));
}

function renderTodoBar() {
  const bar = $('#todo-bar');
  const todos = state.current ? latestTodos(state.current) : null;
  bar.textContent = '';
  if (!todos || !todos.length || todos.every((t) => t.status === 'completed')) {
    bar.hidden = true;
    return;
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  const cur = todos.find((t) => t.status === 'in_progress');
  bar.hidden = false;
  bar.append(
    h(
      'button',
      {
        type: 'button',
        class: 'tb-head',
        'aria-expanded': String(todoOpen),
        onclick: () => {
          todoOpen = !todoOpen;
          renderTodoBar();
        },
      },
      svg('clipboard', 14),
      h('span', { class: 't' }, cur ? cur.activeForm || cur.content : '待办事项'),
      h('span', { class: 'n' }, `${done} / ${todos.length}`),
      svg(todoOpen ? 'chevronDown' : 'chevronRight', 14),
    ),
  );
  if (todoOpen) bar.append(renderTodos(todos));
}

function renderAttachments() {
  const row = $('#attach-row');
  row.textContent = '';
  row.hidden = !state.attachments.length;
  for (const a of state.attachments) {
    const rm = h('button', {
      type: 'button',
      class: 'rm',
      title: '移除',
      'aria-label': `移除 ${a.name}`,
      html: icon('x', 12),
      onclick: () => {
        state.attachments = state.attachments.filter((x) => x.id !== a.id);
        renderAttachments();
        renderComposer();
        $('#input').focus();
      },
    });
    const preview = a.dataUrl ? h('img', { src: a.dataUrl, alt: a.name, onclick: () => lightbox(a.dataUrl, a.name) }) : h('span', { class: 'ph' }, svg('image', 20));
    row.append(h('div', { class: 'attach', title: a.path || a.name }, preview, rm));
  }
}

// ---- 菜单：权限 / 模型 / 思考强度 ----

function permMenu(anchor) {
  const c = state.settings.claude;
  showMenu(
    anchor,
    [
      { text: '添加图片…', icon: 'image', onClick: pickImages },
      { text: '插入本机文件路径…', icon: 'paperclip', onClick: insertLocalFiles },
      { text: '共享本机文件夹…', icon: 'folderPlus', onClick: addSharedFolders },
      connected() ? { text: '浏览服务器文件', icon: 'folderOpen', onClick: openFiles } : null,
      '-',
      { heading: '权限模式（Shift+Tab 切换）' },
      ...PERM_OPTIONS.map(([v, t, d]) => {
        // root 用户下 Claude Code 不接受 bypassPermissions，选了会导致进程直接退出
        const blocked = v === 'bypassPermissions' && !!(state.claudeInfo && state.claudeInfo.isRoot) && c.permissionMode !== v;
        return { text: t, desc: blocked ? '服务器以 root 用户运行，Claude Code 不允许此模式' : d, checked: c.permissionMode === v, disabled: blocked, onClick: () => patchSettings((s) => (s.claude.permissionMode = v)) };
      }),
      '-',
      { text: '在界面中审批权限请求', desc: '关闭后需要确认的操作会被自动拒绝', checked: !!c.usePromptTool, onClick: () => patchSettings((s) => (s.claude.usePromptTool = !s.claude.usePromptTool)) },
    ],
    { above: true },
  );
}

// 连续按 Shift+Tab 时，上一次保存可能还没完成，以最后一次切换的目标为准
let pendingPerm = null;

function cyclePermMode() {
  const cur = pendingPerm !== null ? pendingPerm : state.settings.claude.permissionMode;
  const next = PERM_CYCLE[(PERM_CYCLE.indexOf(cur) + 1) % PERM_CYCLE.length];
  pendingPerm = next;
  renderMeta();
  patchSettings((s) => (s.claude.permissionMode = next))
    .then(() => {
      if (pendingPerm === next) {
        pendingPerm = null;
        toast(`权限模式：${PERM_LABELS[next]}`);
      }
    })
    .catch((e) => {
      pendingPerm = null;
      renderMeta();
      toast(errMsg(e), 'error');
    });
}

async function refreshClaudeInfo({ silent = false } = {}) {
  if (state.infoLoading) return;
  state.infoLoading = true;
  try {
    await api.refreshClaudeInfo();
    if (!silent) toast(`已读取服务器上的 ${serverModels() ? serverModels().length : 0} 个可选模型`);
  } catch (e) {
    if (!silent) toast(`读取服务器模型失败：${errMsg(e)}`, 'error');
  } finally {
    state.infoLoading = false;
  }
}

function modelMenu(anchor) {
  const cur = state.settings.claude.model;
  const curValue = cur || 'default';
  const list = serverModels();
  const info = state.claudeInfo;
  const models = list || FALLBACK_MODELS;
  const known = models.some((m) => m.value === curValue);
  let heading = '模型';
  if (list) heading = `服务器上的可选模型${info.version ? ` · Claude Code ${info.version}` : ''}`;
  else if (info && info.error) heading = `未能读取服务器模型：${info.error}`;
  else if (!connected()) heading = '连接服务器后会读取服务器上的可选模型';
  showMenu(
    anchor,
    [
      { heading },
      ...models.map((m) => ({
        text: list ? modelDisplayName(m) : m.name,
        desc: list ? modelDescription(m) : m.description,
        checked: curValue === m.value,
        onClick: () =>
          patchSettings((s) => {
            s.claude.model = m.value === 'default' ? '' : m.value;
            // 新模型不支持当前思考强度时改回默认
            if (s.claude.effort && Array.isArray(m.effort) && m.effort.length && !m.effort.includes(s.claude.effort)) s.claude.effort = '';
          }),
      })),
      !known ? { text: modelName(cur) || cur, desc: `自定义：${cur}`, checked: true } : null,
      '-',
      {
        text: '自定义模型…',
        icon: 'pencil',
        onClick: async () => {
          const v = await promptDialog({ title: '自定义模型', label: '模型别名或完整名称', value: cur, placeholder: '例如 claude-opus-5-5 或 sonnet[1m]' });
          if (v != null) await patchSettings((s) => (s.claude.model = v.trim()));
        },
      },
      connected() ? { text: state.infoLoading ? '正在读取…' : '刷新模型列表', icon: 'refresh', disabled: state.infoLoading, onClick: () => refreshClaudeInfo() } : null,
    ],
    { above: true },
  );
}

function effortMenu(anchor) {
  const cur = state.settings.claude.effort;
  const entry = selectedModelEntry();
  // 只列出当前模型支持的思考强度
  const levels = entry && entry.effort && entry.effort.length ? entry.effort : EFFORT_OPTIONS.slice(1).map(([v]) => v);
  showMenu(
    anchor,
    [
      { heading: entry ? `思考强度 · ${modelDisplayName(entry)}` : '思考强度' },
      { text: '默认', desc: '使用默认设置', checked: !cur, onClick: () => patchSettings((s) => (s.claude.effort = '')) },
      ...levels.map((v) => ({ text: EFFORT_LABEL[v] || v, desc: v, checked: cur === v, onClick: () => patchSettings((s) => (s.claude.effort = v)) })),
    ],
    { above: true },
  );
}

// ---- 输入框辅助 ----

async function addSharedFolders() {
  const picked = await api.pickFolders();
  if (!picked.length) return;
  await patchSettings((s) => {
    for (const p of picked) if (!s.mcp.roots.includes(p)) s.mcp.roots.push(p);
    s.mcp.enabled = true;
  });
  toast(`已共享 ${picked.length} 个文件夹给服务器上的 Claude`);
}

function insertAtCursor(text) {
  const input = $('#input');
  const start = input.selectionStart;
  const before = input.value.slice(0, start);
  const sep = before && !/\s$/.test(before) ? ' ' : '';
  input.value = before + sep + text + input.value.slice(input.selectionEnd);
  input.focus();
  input.selectionStart = input.selectionEnd = start + sep.length + text.length;
  autosize();
  renderComposer();
}

function fillInput(text, append = false) {
  const input = $('#input');
  if (append) {
    insertAtCursor(text);
    return;
  }
  input.value = text;
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  autosize();
  renderComposer();
}

function warnOutsideRoots(paths) {
  const roots = state.settings.mcp.roots.map((r) => r.toLowerCase().replace(/\\+$/, ''));
  const outside = paths.filter((p) => !roots.some((r) => p.toLowerCase() === r || p.toLowerCase().startsWith(`${r}\\`)));
  if (outside.length) toast('提示：部分路径不在共享文件夹内，Claude 无法访问。可点击输入框上方的文件夹按钮共享。');
}

async function insertLocalFiles() {
  const files = await api.pickFiles();
  if (!files.length) return;
  insertAtCursor(files.join(' '));
  warnOutsideRoots(files);
}

function autosize() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 260)}px`;
}

function addImageFile(file) {
  if (state.attachments.length >= MAX_ATTACHMENTS) {
    toast(`一次最多附加 ${MAX_ATTACHMENTS} 张图片`, 'error');
    return;
  }
  if (!IMAGE_TYPE_RE.test(file.type)) {
    toast(`只支持 PNG / JPEG / GIF / WebP 图片：${file.name || ''}`, 'error');
    return;
  }
  if (file.size > MAX_IMAGE) {
    toast(`图片过大：${file.name || ''}（最大 5 MB）`, 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.attachments.push({ id: ++attSeq, dataUrl: String(reader.result), name: file.name || 'image.png' });
    renderAttachments();
    renderComposer();
  };
  reader.onerror = () => toast(`读取图片失败：${file.name || ''}`, 'error');
  reader.readAsDataURL(file);
}

function addImagePaths(paths) {
  for (const p of paths) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`一次最多附加 ${MAX_ATTACHMENTS} 张图片`, 'error');
      break;
    }
    state.attachments.push({ id: ++attSeq, path: p, name: p.split(/[\\/]/).pop() });
  }
  renderAttachments();
  renderComposer();
}

async function pickImages() {
  const paths = await api.pickImages();
  if (paths.length) addImagePaths(paths);
  $('#input').focus();
}

async function refreshBranch() {
  const wd = currentWorkdir();
  if (!connected() || state.mode === 'cowork') {
    if (state.branch || state.branchFor) {
      state.branch = null;
      state.branchFor = null;
      renderChips();
    }
    return;
  }
  if (state.branchFor === wd) return;
  state.branchFor = wd;
  state.branch = await api.gitBranch(wd).catch(() => null);
  if (state.branchFor === wd) renderChips();
}

// ---- 斜杠命令 ----

function slashMatches() {
  const v = $('#input').value;
  if (!v.startsWith('/') || /\s/.test(v)) return [];
  const q = v.slice(1).toLowerCase();
  return state.slashCommands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 60);
}

function renderSlash() {
  const pop = $('#slash-pop');
  const items = slashMatches();
  if (!items.length) {
    pop.hidden = true;
    return;
  }
  slashSel = Math.min(slashSel, items.length - 1);
  pop.textContent = '';
  items.forEach((c, i) => {
    const desc = state.slashDesc[c] || '';
    const el = h(
      'div',
      { class: `slash-item${i === slashSel ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === slashSel), title: desc },
      h('span', { class: 'slash-name' }, `/${c}`),
      desc ? h('span', { class: 'slash-desc' }, desc.replace(/\s+/g, ' ')) : null,
    );
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickSlash(c);
    });
    pop.append(el);
  });
  pop.hidden = false;
  pop.children[slashSel]?.scrollIntoView({ block: 'nearest' });
}

function pickSlash(cmd) {
  const input = $('#input');
  input.value = `/${cmd} `;
  input.selectionStart = input.selectionEnd = input.value.length;
  $('#slash-pop').hidden = true;
  autosize();
  renderComposer();
  input.focus();
}

// ======================= 消息列表 =======================

function isNearBottom() {
  const c = $('#chat');
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}

function scrollToBottom() {
  const c = $('#chat');
  c.scrollTop = c.scrollHeight;
}

function markLast() {
  const box = $('#messages');
  box.querySelectorAll('.msg.last').forEach((x) => x.classList.remove('last'));
  const all = box.querySelectorAll('.msg');
  const last = all[all.length - 1];
  if (last && last.classList.contains('assistant')) last.classList.add('last');
  // 只有最后一条回复下面显示 Claude 标志
  box.querySelectorAll('.end-spark').forEach((x) => (x.hidden = !x.closest('.msg.last')));
}

function renderMessages(scroll = true) {
  const box = $('#messages');
  box.textContent = '';
  for (const m of (state.current && state.current.messages) || []) box.append(renderMessage(m));
  markLast();
  if (scroll) scrollToBottom();
}

/** 重新渲染时保留确认卡片里已经填写 / 勾选的内容 */
function carryFormState(oldEl, newEl) {
  const olds = [...oldEl.querySelectorAll('.perm-card input, .perm-card textarea')];
  if (!olds.length) return -1;
  const news = [...newEl.querySelectorAll('.perm-card input, .perm-card textarea')];
  if (olds.length !== news.length) return -1;
  olds.forEach((o, i) => {
    const n = news[i];
    if (n.type !== o.type) return;
    if (o.type === 'checkbox' || o.type === 'radio') n.checked = o.checked;
    else n.value = o.value;
  });
  const active = olds.indexOf(document.activeElement);
  return active >= 0 ? active : -1;
}

function upsertMessage(msg) {
  const conv = state.current;
  if (!conv) return;
  const i = conv.messages.findIndex((m) => m.id === msg.id);
  if (i >= 0) conv.messages[i] = msg;
  else conv.messages.push(msg);
  const box = $('#messages');
  const existing = box.querySelector(`.msg[data-id="${CSS.escape(msg.id)}"]`);
  // 正在编辑这条消息时不打断输入
  if (existing && state.editing === msg.id && existing.classList.contains('editing')) return;
  const near = isNearBottom();
  const el = renderMessage(msg);
  if (existing) {
    const focusIdx = carryFormState(existing, el);
    existing.replaceWith(el);
    if (focusIdx >= 0) el.querySelectorAll('.perm-card input, .perm-card textarea')[focusIdx]?.focus();
  } else box.append(el);
  markLast();
  if (near) scrollToBottom();
  if (msg.role === 'assistant') {
    renderTodoBar();
    if (msg.model || msg.meta) renderMeta();
  }
}

function rerenderRunning() {
  for (const m of (state.current && state.current.messages) || []) if (m.role === 'assistant' && m.status === 'running') upsertMessage(m);
}

async function reloadCurrent() {
  const id = state.currentId;
  if (!id) return;
  let conv;
  try {
    conv = await api.getConversation(id);
  } catch (e) {
    toast(errMsg(e), 'error');
    return;
  }
  if (state.currentId !== id) return;
  const c = $('#chat');
  const near = isNearBottom();
  const top = c.scrollTop;
  state.current = conv;
  if (state.editing && !conv.messages.some((m) => m.id === state.editing)) state.editing = null;
  renderMessages(false);
  if (near) scrollToBottom();
  else c.scrollTop = top;
  renderHeader();
  renderTodoBar();
  renderMeta();
  renderComposer();
}

function editLastUser() {
  if (currentRunning()) return false;
  const msgs = (state.current && state.current.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    if (m.status && m.status !== 'sent') return false;
    state.editing = m.id;
    upsertMessage(m);
    document.querySelector(`#messages .msg[data-id="${CSS.escape(m.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  return false;
}

// ======================= 操作记录 =======================

function renderActivity() {
  const list = $('#activity-list');
  list.textContent = '';
  if (!state.activity.length) {
    list.append(h('div', { class: 'conv-empty' }, '服务器上的 Claude 还没有操作过本机'));
    return;
  }
  for (const a of [...state.activity].reverse()) {
    const st = a.status;
    const statusEl = st === 'running' ? h('span', { class: 'spinner' }) : svg(st === 'ok' ? 'check' : st === 'denied' ? 'shield' : 'x', 14);
    list.append(
      h(
        'div',
        { class: 'act-item' },
        h('span', { class: `act-status ${st}` }, statusEl),
        h(
          'div',
          { class: 'act-main' },
          h('div', { class: 'act-summary' }, a.summary),
          h('div', { class: 'act-time' }, fmtTime(a.ts) + (a.endTs ? ` · ${((a.endTs - a.ts) / 1000).toFixed(1)} 秒` : '') + (st === 'denied' ? ' · 已拒绝' : '')),
          a.error && st !== 'denied' ? h('div', { class: 'act-err' }, a.error) : null,
        ),
      ),
    );
  }
}

function toggleActivity() {
  const panel = $('#activity');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $('#files').hidden = true;
    renderActivity();
  }
}

function openFiles() {
  $('#activity').hidden = true;
  toggleFiles();
}

function renderAll() {
  renderModeSeg();
  renderSidebar();
  renderAccount();
  renderHeader();
  renderChips();
  renderMeta();
  renderComposer();
  renderTodoBar();
  renderAttachments();
}

// ======================= 导航 / 对话操作 =======================

function summaryOf(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    workdir: conv.workdir,
    sessionId: conv.sessionId || null,
    pinned: !!conv.pinned,
    mode: conv.mode === 'cowork' ? 'cowork' : 'code',
    activeRun: !!conv.run,
    imported: !!conv.imported,
    remoteSessions: 0,
  };
}

function upsertSummary(sum) {
  const i = state.convs.findIndex((c) => c.id === sum.id);
  if (i >= 0) state.convs[i] = sum;
  else state.convs.push(sum);
  state.convs.sort((a, b) => b.updatedAt - a.updatedAt);
}

function updateNavButtons() {
  $('#btn-back').disabled = nav.idx <= 0;
  $('#btn-forward').disabled = nav.idx >= nav.stack.length - 1;
}

function setModeState(mode) {
  state.mode = mode === 'cowork' ? 'cowork' : 'code';
  localStorage.setItem('mode', state.mode);
}

async function show(id) {
  const conv = id ? await api.getConversation(id) : null;
  drafts.set(state.currentId || '', $('#input').value);
  if (conv) {
    state.currentId = id;
    state.current = conv;
    if ((conv.mode || 'code') !== state.mode) setModeState(conv.mode);
    const prev = state.meta[id] || {};
    state.meta[id] = { ...prev, context: conv.context || prev.context || null, suggestion: conv.suggestion || null };
  } else {
    state.currentId = null;
    state.current = null;
  }
  state.editing = null;
  todoOpen = false;
  $('#input').value = drafts.get(state.currentId || '') || '';
  autosize();
  $('#slash-pop').hidden = true;
  renderAll();
  if (state.current) renderMessages();
  else renderHome();
  refreshBranch();
  $('#input').focus();
}

async function go(id, { push = true } = {}) {
  try {
    await show(id);
  } catch (e) {
    toast(errMsg(e), 'error');
    return;
  }
  if (push && nav.stack[nav.idx] !== id) {
    nav.stack = nav.stack.slice(0, nav.idx + 1);
    nav.stack.push(id);
    nav.idx = nav.stack.length - 1;
  }
  updateNavButtons();
}

async function goBy(delta) {
  let i = nav.idx + delta;
  // 跳过已删除的对话
  while (i >= 0 && i < nav.stack.length && nav.stack[i] && !state.convs.some((c) => c.id === nav.stack[i])) i += delta;
  if (i < 0 || i >= nav.stack.length) return;
  nav.idx = i;
  await go(nav.stack[i], { push: false });
}

function newChat(workdir) {
  state.pendingWorkdir = workdir || null;
  state.pendingWorktree = false;
  state.branchFor = null;
  go(null);
}

function setMode(mode) {
  if (mode === state.mode) return;
  setModeState(mode);
  state.branchFor = null;
  if (state.current && (state.current.mode || 'code') !== state.mode) {
    newChat();
    return;
  }
  renderAll();
  if (!state.current) renderHome();
  refreshBranch();
}

/** 首页发送第一条消息时才真正创建对话 */
async function ensureConversation() {
  if (state.currentId) return state.currentId;
  const conv = await api.createConversation({ workdir: state.pendingWorkdir, mode: state.mode, worktree: state.mode === 'code' && !!state.pendingWorktree });
  state.pendingWorkdir = null;
  state.pendingWorktree = false;
  drafts.delete('');
  upsertSummary(summaryOf(conv));
  state.currentId = conv.id;
  state.current = conv;
  state.meta[conv.id] = state.meta[conv.id] || {};
  nav.stack = nav.stack.slice(0, nav.idx + 1);
  if (nav.stack[nav.idx] === null) nav.stack[nav.idx] = conv.id;
  else {
    nav.stack.push(conv.id);
    nav.idx = nav.stack.length - 1;
  }
  updateNavButtons();
  renderAll();
  renderMessages();
  return conv.id;
}

async function submit({ priority } = {}) {
  const input = $('#input');
  const text = input.value.trim();
  const atts = state.attachments.slice();
  if (!text && !atts.length) return;
  input.value = '';
  state.attachments = [];
  $('#slash-pop').hidden = true;
  autosize();
  renderAttachments();
  renderComposer();
  try {
    const id = await ensureConversation();
    const images = atts.map((a) => (a.dataUrl ? { dataUrl: a.dataUrl, name: a.name } : { path: a.path, name: a.name }));
    await api.send(id, text, { images, priority });
  } catch (e) {
    toast(errMsg(e), 'error');
    if (!input.value) {
      input.value = text;
      autosize();
    }
    if (!state.attachments.length) {
      state.attachments = atts;
      renderAttachments();
    }
    renderComposer();
  }
}

async function sendRaw(text) {
  if (!state.currentId) return;
  try {
    await api.send(state.currentId, text, {});
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

function stopCurrent() {
  if (!state.currentId) return;
  api.stop(state.currentId).catch((e) => toast(errMsg(e), 'error'));
}

async function renameConv(c) {
  const v = await promptDialog({ title: '重命名对话', value: c.title });
  if (v && v.trim()) {
    try {
      await api.renameConversation(c.id, v.trim());
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }
}

function deleteDialog(c) {
  return new Promise((resolve) => {
    let result = null;
    const n = c.remoteSessions || (c.sessionId ? 1 : 0);
    const remember = localStorage.getItem('deleteRemote') !== '0';
    const box = h('input', { type: 'checkbox' });
    box.checked = remember;
    const body = h('div', { class: 'dialog-body' }, h('p', {}, `确定删除“${c.title}”吗？此操作不可撤销。`));
    if (n) {
      body.append(
        h('label', { class: 'check-line' }, box, `同时删除服务器上的 Claude 会话记录（${n} 条）`),
        h(
          'p',
          { class: 'hint-text' },
          connected()
            ? '会删除服务器 ~/.claude 中这些会话的对话记录和文件快照，之后在服务器上也无法再用 claude --resume 恢复。'
            : '当前未连接服务器，会在下次连接这台服务器时自动删除。',
        ),
      );
    } else {
      body.append(h('p', {}, '这个对话还没有在服务器上产生会话记录。'));
    }
    const ok = h('button', { class: 'btn danger', autofocus: true }, '删除');
    const cancel = h('button', { class: 'btn' }, '取消');
    const dlg = dialogShell({ title: '删除对话', badge: icon('trash', 20), body, foot: h('div', { class: 'dialog-foot' }, cancel, ok) });
    const m = openModal(dlg, { onClose: () => resolve(result) });
    ok.onclick = () => {
      if (n) localStorage.setItem('deleteRemote', box.checked ? '1' : '0');
      result = { remote: !!n && box.checked };
      m.close();
    };
    cancel.onclick = () => m.close();
  });
}

async function deleteConv(c) {
  const choice = await deleteDialog(c);
  if (!choice) return;
  try {
    const r = await api.deleteConversation(c.id, choice);
    if (!r || r.remote === 'skipped') toast('对话已删除');
    else if (r.remote === 'done') toast(`对话已删除，服务器上的 ${r.count} 条会话记录也已删除`);
    else if (r.remote === 'queued') toast('本地对话已删除，服务器上的记录会在下次连接时删除');
    else if (r.remote === 'failed') toast(`本地对话已删除，但服务器端删除失败（${r.error}），会在下次连接时重试`, 'error');
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

async function exportConv(id) {
  try {
    const file = await api.exportConversation(id);
    if (file) toast(`已导出到 ${file}`);
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

async function setWorkdirFor(convId, dir) {
  const v = String(dir || '').trim();
  if (!v) return;
  if (convId) {
    try {
      await api.setWorkdir(convId, v);
      toast(`工作目录已切换为 ${v}`);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  } else {
    state.pendingWorkdir = v;
    state.branchFor = null;
    renderChips();
    refreshBranch();
    toast(`新对话将在 ${v} 中开始`);
  }
}

async function editWorkdir(convId) {
  const target = convId ? state.convs.find((c) => c.id === convId) || state.current : null;
  const cur = target ? target.workdir : state.pendingWorkdir || state.settings.claude.workdir || '~';
  const hasSession = !!(target && target.sessionId);
  const v = await promptDialog({
    title: '服务器工作目录',
    label: 'Claude 在服务器上运行时所在的目录（项目目录）',
    value: cur,
    hint: hasSession ? '修改后会开始新的 Claude 会话，之前的上下文不会带过去。' : '例如 ~/projects/my-app',
  });
  if (v == null || !v.trim() || v.trim() === cur) return;
  await setWorkdirFor(target ? target.id : null, v);
}

function setSidebarCollapsed(on) {
  $('#app').classList.toggle('sidebar-collapsed', on);
  localStorage.setItem('sidebarCollapsed', on ? '1' : '0');
}

// ======================= 服务器信息 =======================

function infoCacheKey() {
  return `claudeInfo:${state.settings.ssh.username}@${state.settings.ssh.host}`;
}

/** 收到服务器上的 Claude 信息：模型列表、斜杠命令（含说明）、账号 */
function applyClaudeInfo(info) {
  if (!info) return;
  // 读取失败时保留之前成功读到的列表
  if (info.error && !(info.models && info.models.length) && state.claudeInfo && state.claudeInfo.models) {
    state.claudeInfo = { ...state.claudeInfo, error: info.error };
  } else {
    state.claudeInfo = info;
  }
  if (info.commands && info.commands.length) {
    state.slashCommands = info.commands.map((c) => c.name);
    state.slashDesc = Object.fromEntries(info.commands.map((c) => [c.name, c.description || '']));
    localStorage.setItem('slashCommands', JSON.stringify(state.slashCommands));
  }
  if (info.models && info.models.length) localStorage.setItem(infoCacheKey(), JSON.stringify({ ...info, commands: [] }));
  renderMeta();
}

// ======================= 主进程事件 =======================

function onChatEvent(ev) {
  switch (ev.type) {
    case 'conversation': {
      upsertSummary(ev.conv);
      if (state.current && state.current.id === ev.conv.id) {
        const workdirChanged = state.current.workdir !== ev.conv.workdir;
        Object.assign(state.current, { title: ev.conv.title, workdir: ev.conv.workdir, sessionId: ev.conv.sessionId, pinned: ev.conv.pinned });
        renderHeader();
        if (workdirChanged) {
          state.branchFor = null;
          refreshBranch();
        }
      }
      renderSidebar();
      break;
    }
    case 'conv-meta': {
      const prev = state.meta[ev.convId];
      state.meta[ev.convId] = ev.meta;
      toggleSet(state.running, ev.convId, !!ev.meta.running);
      if (ev.convId === state.currentId) {
        renderMeta();
        renderComposer();
        const was = prev && prev.run ? prev.run.attached : null;
        const now = ev.meta.run ? ev.meta.run.attached : null;
        if (was !== now) rerenderRunning();
      }
      break;
    }
    case 'message':
      if (ev.convId === state.currentId) upsertMessage(ev.message);
      if (ev.message.model) localStorage.setItem('lastModel', ev.message.model);
      break;
    case 'conversation-reload':
      if (ev.convId === state.currentId) reloadCurrent();
      break;
    case 'run-state':
      toggleSet(state.running, ev.convId, ev.running);
      renderSidebar();
      if (ev.convId === state.currentId) {
        renderComposer();
        renderRing();
      }
      if (!ev.running && !state.current) loadStats();
      break;
    case 'conversation-deleted':
      state.convs = state.convs.filter((c) => c.id !== ev.convId);
      delete state.meta[ev.convId];
      drafts.delete(ev.convId);
      if (state.currentId === ev.convId) newChat();
      else {
        renderSidebar();
        if (!state.current) loadStats();
      }
      break;
    case 'slash-commands':
      state.slashCommands = ev.commands || [];
      localStorage.setItem('slashCommands', JSON.stringify(state.slashCommands));
      break;
    case 'claude-info':
      applyClaudeInfo(ev.info);
      break;
    case 'rate-limits':
      state.rateLimits = ev.info;
      if (!state.current && state.statsTab === 'limits') renderStats();
      break;
    default:
      break;
  }
}

function onStatus(st) {
  const prev = state.status;
  const wasConnected = !!(prev && prev.ssh.state === 'connected');
  const prevDesktop = prev && prev.desktop ? prev.desktop.state : null;
  state.status = st;
  state.running = new Set(st.running);
  const isConnected = st.ssh.state === 'connected';
  renderAccount();
  renderChips();
  renderComposer();
  renderSidebar();
  if (wasConnected !== isConnected) rerenderRunning();
  if (isConnected && !wasConnected) {
    state.branchFor = null;
    refreshBranch();
  } else if (!isConnected && state.branch) {
    state.branch = null;
    state.branchFor = null;
    renderChips();
  }
  if (st.desktop && st.desktop.state !== prevDesktop && st.desktop.state === 'error') toast(`桌面控制启动失败：${st.desktop.error || '未知错误'}`, 'error');
}

// ======================= 事件绑定 =======================

function hasFiles(e) {
  return !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
}

function bindEvents() {
  const input = $('#input');
  input.addEventListener('input', () => {
    autosize();
    renderComposer();
    slashSel = 0;
    renderSlash();
  });
  input.addEventListener('blur', () => setTimeout(() => ($('#slash-pop').hidden = true), 120));
  input.addEventListener('keydown', (e) => {
    // 输入法组字过程中的按键交给输入法
    if (e.isComposing || e.keyCode === 229) return;
    const pop = $('#slash-pop');
    if (!pop.hidden) {
      const items = slashMatches();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        renderSlash();
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && items[slashSel]) {
        e.preventDefault();
        pickSlash(items[slashSel]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        pop.hidden = true;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit({ priority: e.ctrlKey && currentRunning() ? 'now' : undefined });
    } else if (e.key === 'Escape') {
      if (currentRunning()) {
        e.preventDefault();
        stopCurrent();
      }
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      cyclePermMode();
    } else if (e.key === 'Tab' && !input.value) {
      const s = suggestionText();
      if (s && !currentRunning()) {
        e.preventDefault();
        fillInput(s);
      }
    } else if (e.key === 'ArrowUp' && !input.value && !state.attachments.length) {
      if (editLastUser()) e.preventDefault();
    }
  });
  input.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const images = [...cd.files].filter((f) => f.type.startsWith('image/'));
    // 同时带文字（如从 Office 复制）时按文字粘贴
    if (!images.length || cd.getData('text/plain')) return;
    e.preventDefault();
    images.forEach(addImageFile);
  });
  $('#btn-send').addEventListener('click', () => submit());
  $('#btn-stop').addEventListener('click', stopCurrent);

  $('#btn-menu').addEventListener('click', (e) => appMenu(e.currentTarget));
  $('#btn-collapse').addEventListener('click', () => setSidebarCollapsed(true));
  $('#btn-expand').addEventListener('click', () => setSidebarCollapsed(false));
  $('#btn-back').addEventListener('click', () => goBy(-1));
  $('#btn-forward').addEventListener('click', () => goBy(1));
  $('#btn-new-chat').addEventListener('click', () => newChat());
  $('#btn-customize').addEventListener('click', () => customize());
  for (const b of document.querySelectorAll('.mode-seg button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('#btn-more').addEventListener('click', (e) => {
    const list = $('#more-list');
    list.hidden = !list.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!list.hidden));
    e.currentTarget.classList.toggle('open', !list.hidden);
  });
  $('#btn-more-import').addEventListener('click', importDialog);
  $('#btn-more-files').addEventListener('click', openFiles);
  $('#btn-more-activity').addEventListener('click', toggleActivity);
  $('#btn-more-folders').addEventListener('click', () => openSettings('mcp'));
  $('#btn-more-window').addEventListener('click', () => api.newWindow());
  $('#search-input').addEventListener('input', (e) => onSearchInput(e.target.value));
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      toggleSearch(false);
    } else if (e.key === 'Enter' && state.searchResults && state.searchResults.hits.length) {
      openHit(state.searchResults.hits[0]);
    }
  });
  $('#account').addEventListener('click', (e) => accountMenu(e.currentTarget));

  $('#btn-terminal').addEventListener('click', toggleTerminal);
  $('#btn-export').addEventListener('click', () => state.currentId && exportConv(state.currentId));
  $('#btn-activity').addEventListener('click', toggleActivity);
  $('#btn-files').addEventListener('click', openFiles);

  $('#btn-perm').addEventListener('click', (e) => permMenu(e.currentTarget));
  $('#btn-translate').addEventListener('click', () =>
    patchSettings((s) => (s.translation.enabled = !s.translation.enabled))
      .then(() => toast(state.settings.translation.enabled ? '已开启中英双向翻译' : '已关闭翻译，消息将原样发送'))
      .catch((e) => toast(errMsg(e), 'error')),
  );
  $('#btn-model').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('#btn-effort').addEventListener('click', (e) => effortMenu(e.currentTarget));
  $('#ctx-ring').addEventListener('click', (e) => contextPopover(e.currentTarget));

  $('#btn-activity-close').addEventListener('click', () => ($('#activity').hidden = true));
  $('#btn-activity-clear').addEventListener('click', async () => {
    await api.clearActivity();
    state.activity = [];
    renderActivity();
  });

  // 外部链接用系统浏览器打开；代码块复制
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-action="copy-code"]');
    if (copyBtn) {
      api.copy(copyBtn.closest('.code-block').querySelector('pre').innerText).then(() => toast('已复制'));
      return;
    }
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      api.openExternal(a.href);
    }
  });

  // 拖入图片 → 附件；拖入其它本机文件 / 文件夹 → 插入路径
  const composer = $('#composer');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    composer.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) composer.classList.remove('dragging');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    composer.classList.remove('dragging');
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    if (!files.length) return;
    const paths = [];
    for (const f of files) {
      if (IMAGE_TYPE_RE.test(f.type) && f.size <= MAX_IMAGE) addImageFile(f);
      else {
        const p = api.pathForFile(f);
        if (p) paths.push(p);
      }
    }
    if (paths.length) {
      insertAtCursor(paths.join(' '));
      warnOutsideRoots(paths);
    }
  });

  window.addEventListener('resize', () => closeMenu({ restoreFocus: false }));
  window.addEventListener('blur', () => closeMenu({ restoreFocus: false }));

  document.addEventListener('keydown', (e) => {
    if ($('#modal-root').children.length) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const t = e.target;
      if (t === input || document.querySelector('#menu-root .menu')) return;
      if (t && t.closest && t.closest('.term-host, .edit-box, .perm-card, .side-search')) return;
      if (currentRunning()) stopCurrent();
      return;
    }
    if (e.altKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      goBy(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (!e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Backquote') {
      e.preventDefault();
      toggleTerminal();
    } else if (k === 'n' && e.shiftKey) {
      e.preventDefault();
      api.newWindow();
    } else if (k === 'n') {
      e.preventDefault();
      newChat();
    } else if (k === 'b') {
      e.preventDefault();
      setSidebarCollapsed(!$('#app').classList.contains('sidebar-collapsed'));
    } else if (k === 'k') {
      e.preventDefault();
      if ($('#app').classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
      toggleSearch(true);
    } else if (e.key === ',') {
      e.preventDefault();
      openSettings('ssh');
    }
  });

  // 主进程推送
  api.onStatus(onStatus);
  api.onSettings((s) => {
    state.settings = s;
    renderAll();
  });
  api.onChatEvent(onChatEvent);
  api.onOpenConv((id) => go(id));
  api.onAsk((req) => {
    askQueue.push(req);
    pumpAsk();
  });
  api.onAskCancel((id) => {
    const i = askQueue.findIndex((a) => a.id === id);
    if (i >= 0) askQueue.splice(i, 1);
    if (askActive && askActive.id === id) askActive.modal.close('cancelled');
  });
  api.onActivity((act) => {
    const i = state.activity.findIndex((a) => a.id === act.id);
    if (i >= 0) state.activity[i] = act;
    else state.activity.push(act);
    if (state.activity.length > 300) state.activity.shift();
    if (!$('#activity').hidden) renderActivity();
  });
}

// ======================= 启动 =======================

Object.assign(hooks, {
  rerender: renderAll,
  rerenderMessage: (m) => upsertMessage(m),
  openConversation: (id) => go(id),
  refreshAll: renderAll,
  fillInput,
  openTerminal: (kind) => openTerminalPanel({ kind }),
  setWorkdir: (dir) => setWorkdirFor(state.currentId, dir),
  sendRaw,
  connect,
});

async function init() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, el.classList.contains('icon-btn') ? 17 : 16);
  });
  $('#crab').innerHTML = crab(34);
  if (localStorage.getItem('sidebarCollapsed') === '1') $('#app').classList.add('sidebar-collapsed');
  try {
    state.slashCommands = JSON.parse(localStorage.getItem('slashCommands') || '[]');
  } catch {
    state.slashCommands = [];
  }

  [state.appInfo, state.settings, state.status, state.convs, state.activity] = await Promise.all([api.appInfo(), api.getSettings(), api.getStatus(), api.listConversations(), api.listActivity()]);
  state.rateLimits = state.appInfo.rateLimits || null;
  state.memoryPaths = state.appInfo.memoryPaths || null;
  if (state.appInfo.slashCommands && state.appInfo.slashCommands.length) state.slashCommands = state.appInfo.slashCommands;
  // 先用上次读到的缓存，连接后再刷新
  if (state.appInfo.claudeInfo) applyClaudeInfo(state.appInfo.claudeInfo);
  else {
    try {
      const cached = JSON.parse(localStorage.getItem(infoCacheKey()) || 'null');
      if (cached) state.claudeInfo = cached;
    } catch {
      /* 忽略 */
    }
  }
  state.running = new Set(state.status.running);
  initTerminal();
  initFiles();
  bindEvents();
  renderAll();
  renderHome();
  updateNavButtons();
  // 新窗口打开指定对话：#conv=<id>
  const m = location.hash.match(/conv=([^&]+)/);
  if (m) await go(decodeURIComponent(m[1]));
  $('#input').focus();
  if (!state.settings.ssh.host) openSettings('ssh');
}

init().catch((e) => {
  console.error(e);
  toast(`初始化失败：${errMsg(e)}`, 'error');
});
