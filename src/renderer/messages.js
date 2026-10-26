// 消息渲染：用户消息、Claude 回复、工具卡片、diff、待办、子代理、权限 / 提问 / 计划审批卡片
import { icon, spark } from './icons.js';
import { renderMarkdown, enhanceCode } from './markdown.js';
import { api, state, hooks, h, svg, errMsg, toast, copyText, relTime, fmtTokens, modelName, translationOn, tryParse, toggleSet, clip, confirmDialog, lightbox } from './core.js';

// ======================= 工具描述 =======================

const LOCAL_PREFIX = 'mcp__local_pc__';
const LOCAL_TOOLS = {
  list_allowed_roots: ['查看共享文件夹', 'folder', () => ''],
  list_directory: ['列出目录', 'folder', (a) => a.path],
  read_file: ['读取文件', 'file', (a) => a.path],
  get_file_info: ['文件信息', 'file', (a) => a.path],
  find_files: ['查找文件', 'search', (a) => a.pattern],
  search_text: ['搜索内容', 'search', (a) => a.query],
  write_file: ['写入文件', 'pencil', (a) => a.path],
  edit_file: ['编辑文件', 'pencil', (a) => a.path],
  create_directory: ['新建文件夹', 'folder', (a) => a.path],
  move_file: ['移动文件', 'move', (a) => (a.source ? `${a.source} → ${a.destination || ''}` : '')],
  delete_file: ['删除文件', 'trash', (a) => a.path],
  run_command: ['执行命令', 'terminal', (a) => a.command],
  start_process: ['后台启动', 'terminal', (a) => a.command],
  read_process_output: ['查看进程输出', 'terminal', (a) => a.id],
  list_processes: ['查看后台进程', 'terminal', () => ''],
  stop_process: ['停止进程', 'x', (a) => a.id],
  browser_navigate: ['浏览器打开', 'globe', (a) => a.url || { back: '后退', forward: '前进', reload: '刷新' }[a.action] || ''],
  browser_snapshot: ['读取网页', 'globe', () => ''],
  browser_click: ['点击网页', 'globe', (a) => (a.ref ? `[${a.ref}]` : a.selector)],
  browser_type: ['在网页输入', 'globe', (a) => a.text],
  browser_screenshot: ['网页截图', 'image', () => ''],
  browser_console: ['网页控制台', 'globe', () => ''],
};
const REMOTE_TOOLS = {
  Bash: ['执行命令', 'terminal', (a) => a.command],
  PowerShell: ['执行命令', 'terminal', (a) => a.command],
  Read: ['读取文件', 'file', (a) => a.file_path],
  Write: ['写入文件', 'pencil', (a) => a.file_path],
  Edit: ['编辑文件', 'pencil', (a) => a.file_path],
  MultiEdit: ['编辑文件', 'pencil', (a) => a.file_path],
  NotebookEdit: ['编辑笔记本', 'pencil', (a) => a.notebook_path],
  Glob: ['查找文件', 'search', (a) => a.pattern],
  Grep: ['搜索内容', 'search', (a) => a.pattern],
  LS: ['列出目录', 'folder', (a) => a.path],
  WebSearch: ['网页搜索', 'globe', (a) => a.query],
  WebFetch: ['读取网页', 'globe', (a) => a.url],
  Task: ['子代理', 'layers', (a) => a.description],
  Agent: ['子代理', 'layers', (a) => a.description],
  TodoWrite: ['更新待办', 'clipboard', () => ''],
  TaskCreate: ['创建任务', 'clipboard', (a) => a.subject],
  TaskUpdate: ['更新任务', 'clipboard', (a) => a.subject || a.status],
  TaskList: ['查看任务', 'clipboard', () => ''],
  AskUserQuestion: ['提问', 'help', (a) => (a.questions && a.questions[0] ? a.questions[0].question : '')],
  ExitPlanMode: ['提交计划', 'list', () => ''],
  EnterPlanMode: ['进入计划模式', 'list', () => ''],
  Skill: ['使用技能', 'tool', (a) => a.skill || a.name],
  EnterWorktree: ['进入 worktree', 'branch', (a) => a.name],
  ExitWorktree: ['退出 worktree', 'branch', () => ''],
};

function firstString(obj) {
  for (const v of Object.values(obj || {})) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

export function describeTool(name = '', input) {
  const a = input || {};
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  if (name.startsWith(LOCAL_PREFIX)) {
    const short = name.slice(LOCAL_PREFIX.length);
    if (short.startsWith('desktop_')) return { local: true, label: `桌面 · ${short.slice(8)}`, icon: 'monitor', detail: oneLine(firstString(a)) };
    const t = LOCAL_TOOLS[short];
    return t ? { local: true, label: t[0], icon: t[1], detail: oneLine(t[2](a)) } : { local: true, label: short, icon: 'tool', detail: oneLine(firstString(a)) };
  }
  const t = REMOTE_TOOLS[name];
  if (t) return { local: false, label: t[0], icon: t[1], detail: oneLine(t[2](a)) };
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return { local: false, label: `${server} · ${tool}`, icon: 'plug', detail: oneLine(firstString(a)) };
  }
  return { local: false, label: name || '工具', icon: 'tool', detail: oneLine(firstString(a)) };
}

// ======================= diff / 待办 =======================

function diffLine(cls, sign, text, oldNo, newNo) {
  return h('div', { class: `dl ${cls}` }, h('span', { class: 'ln' }, oldNo ?? ''), h('span', { class: 'ln' }, newNo ?? ''), h('span', { class: 'sg' }, sign), h('span', { class: 'tx' }, text));
}

/** 根据结构化补丁或工具输入渲染 diff；返回 null 表示不适用 */
export function renderDiff(name, input, structured) {
  const short = String(name || '').replace(LOCAL_PREFIX, '');
  const isEdit = ['Edit', 'MultiEdit', 'edit_file'].includes(short);
  const isWrite = ['Write', 'write_file'].includes(short);
  if (!isEdit && !isWrite) return null;
  const box = h('div', { class: 'diff' });
  const file = (input && (input.file_path || input.path)) || (structured && structured.filePath) || '';
  let adds = 0;
  let dels = 0;
  const body = h('div', { class: 'diff-body' });
  const patch = structured && Array.isArray(structured.structuredPatch) ? structured.structuredPatch : null;
  if (patch && patch.length) {
    for (const hunk of patch) {
      body.append(h('div', { class: 'dl hunk' }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
      let o = hunk.oldStart;
      let n = hunk.newStart;
      for (const raw of hunk.lines || []) {
        const sign = raw[0];
        const text = raw.slice(1);
        if (sign === '+') {
          adds++;
          body.append(diffLine('add', '+', text, null, n++));
        } else if (sign === '-') {
          dels++;
          body.append(diffLine('del', '-', text, o++, null));
        } else body.append(diffLine('ctx', ' ', text, o++, n++));
      }
    }
  } else if (isEdit) {
    const edits = short === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    edits.forEach((e, i) => {
      if (i) body.append(h('div', { class: 'dl hunk' }, '⋯'));
      for (const l of String(e.old_string ?? '').split('\n')) {
        dels++;
        body.append(diffLine('del', '-', l));
      }
      for (const l of String(e.new_string ?? '').split('\n')) {
        adds++;
        body.append(diffLine('add', '+', l));
      }
    });
  } else {
    const content = String((structured && structured.content) ?? (input && input.content) ?? '');
    const lines = content.split('\n');
    lines.slice(0, 400).forEach((l, i) => {
      adds++;
      body.append(diffLine('add', '+', l, null, i + 1));
    });
    if (lines.length > 400) body.append(h('div', { class: 'dl hunk' }, `… 还有 ${lines.length - 400} 行`));
  }
  box.append(h('div', { class: 'diff-head' }, svg('file', 13), h('span', { class: 'diff-file', title: file }, `\u200E${file}\u200E`), h('span', { class: 'diff-stat' }, h('span', { class: 'add' }, `+${adds}`), ' ', h('span', { class: 'del' }, `-${dels}`))), body);
  return box;
}

export function renderTodos(todos) {
  const list = h('ul', { class: 'todos' });
  for (const t of todos || []) {
    const st = t.status || 'pending';
    list.append(
      h(
        'li',
        { class: `todo ${st}` },
        svg(st === 'completed' ? 'checkCircle' : st === 'in_progress' ? 'circleDot' : 'circle', 15),
        h('span', {}, st === 'in_progress' && t.activeForm ? t.activeForm : t.content || t.subject || ''),
      ),
    );
  }
  return list;
}

/** 对话中最近一次的待办列表 */
export function latestTodos(conv) {
  const msgs = (conv && conv.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const blocks = msgs[i].blocks || [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) return b.input.todos;
    }
  }
  return null;
}

// ======================= 用户消息 =======================

const USER_STATUS = {
  pending: ['等待发送…', 'spinner'],
  translating: ['正在翻译为英文…', 'spinner'],
  queued: ['已排队，Claude 完成当前任务后处理', 'clock'],
  cancelled: ['已取消', null],
  error: ['发送失败', null],
};

function versionSwitcher(m) {
  const conv = state.current;
  const slot = m.slotId && conv && conv.slots && conv.slots[m.slotId];
  if (!slot || slot.versions.length < 2) return null;
  const n = slot.versions.length;
  const go = (k) => api.switchVariant(state.currentId, m.slotId, k).catch((e) => toast(errMsg(e), 'error'));
  return h(
    'span',
    { class: 'variants', role: 'group', 'aria-label': '版本切换' },
    h('button', { class: 'icon-btn sm', title: '上一个版本', 'aria-label': '上一个版本', disabled: slot.current <= 0 || null, html: icon('chevronRight', 14, 'flip'), onclick: () => go(slot.current - 1) }),
    h('span', {}, `${slot.current + 1} / ${n}`),
    h('button', { class: 'icon-btn sm', title: '下一个版本', 'aria-label': '下一个版本', disabled: slot.current >= n - 1 || null, html: icon('chevronRight', 14), onclick: () => go(slot.current + 1) }),
  );
}

function renderEditor(m) {
  const ta = h('textarea', { class: 'edit-area', rows: '3', 'aria-label': '编辑消息' });
  ta.value = m.text;
  const cancel = () => {
    state.editing = null;
    hooks.rerenderMessage(m);
  };
  const save = async () => {
    const text = ta.value.trim();
    if (!text) return;
    state.editing = null;
    try {
      await api.editMessage(state.currentId, m.id, text);
    } catch (e) {
      toast(errMsg(e), 'error');
      hooks.rerenderMessage(m);
    }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
    }
  });
  setTimeout(() => {
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }, 0);
  return h(
    'div',
    { class: 'edit-box' },
    ta,
    h('div', { class: 'edit-foot' }, h('span', { class: 'hint-text' }, '保存后从这里开始新的分支，原来的内容保存在历史版本中'), h('button', { class: 'btn sm', onclick: cancel }, '取消'), h('button', { class: 'btn sm primary', onclick: save }, '保存并发送')),
  );
}

async function rewindTo(m) {
  let preview = null;
  try {
    preview = await api.rewind(state.currentId, m.id, { code: true, conversation: false, dryRun: true });
  } catch (e) {
    preview = { error: errMsg(e) };
  }
  const files = (preview && preview.files && preview.files.filesChanged) || [];
  const body = h('div', {});
  if (preview && preview.error) body.append(h('p', { class: 'hint-text' }, `无法恢复代码：${preview.error}`));
  else if (files.length) body.append(h('p', {}, `将恢复 ${files.length} 个文件（+${preview.files.insertions || 0} / -${preview.files.deletions || 0}）：`), h('pre', {}, files.join('\n')));
  else body.append(h('p', { class: 'hint-text' }, '这条消息之后 Claude 没有修改过文件。'));
  const codeBox = h('input', { type: 'checkbox' });
  codeBox.checked = files.length > 0;
  codeBox.disabled = !files.length;
  const convBox = h('input', { type: 'checkbox' });
  convBox.checked = true;
  body.append(h('label', { class: 'check-line' }, codeBox, '恢复代码（撤销 Claude 对服务器文件的修改）'), h('label', { class: 'check-line' }, convBox, '恢复对话（从这条消息之前重新开始，之后的内容保存为历史版本）'));
  const ok = await confirmDialog({ title: '回退到这条消息之前', body, okText: '回退' });
  if (!ok || (!codeBox.checked && !convBox.checked)) return;
  try {
    const r = await api.rewind(state.currentId, m.id, { code: codeBox.checked, conversation: convBox.checked });
    if (convBox.checked && r && r.text) hooks.fillInput(r.text);
    toast(codeBox.checked ? '已恢复代码' : '已回退对话');
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

export function renderUser(m) {
  if (state.editing === m.id) return h('div', { class: 'msg user editing', 'data-id': m.id }, renderEditor(m));
  const cls = ['msg', 'user'];
  if (m.status === 'cancelled') cls.push('cancelled');
  const bubble = h('div', { class: 'bubble' });
  if (m.images && m.images.length) {
    bubble.append(
      h(
        'div',
        { class: 'msg-images' },
        m.images.map((img) => {
          const src = `app://bundle/attachments/${encodeURIComponent(img.file)}`;
          return h('button', { class: 'thumb', title: img.name || '图片', onclick: () => lightbox(src, img.name) }, h('img', { src, alt: img.name || '图片' }));
        }),
      ),
    );
  }
  if (m.text) bubble.append(h('div', { class: 'bubble-text' }, m.text));
  const el = h('div', { class: cls.join(' '), 'data-id': m.id }, bubble);
  const st = USER_STATUS[m.status];
  if (st) {
    const note = h('div', { class: `tr-note${m.status === 'error' ? ' error' : ''}` }, st[1] === 'spinner' ? h('span', { class: 'spinner' }) : null, m.status === 'error' && m.error ? `${st[0]}：${m.error}` : st[0]);
    if (m.status === 'queued' || m.status === 'pending') {
      note.append(
        h('button', { class: 'link-btn', onclick: () => api.sendNow(state.currentId, m.id).catch((e) => toast(errMsg(e), 'error')) }, '立即发送'),
        h('button', { class: 'link-btn', onclick: () => api.cancelQueued(state.currentId, m.id).catch((e) => toast(errMsg(e), 'error')) }, '取消'),
      );
    }
    el.append(note);
  }
  if (m.en) {
    const key = `en:${m.id}`;
    const det = h('details', { class: 'tr-detail', open: state.expanded.has(key) }, h('summary', { html: `${icon('languages', 13)}<span>已翻译为英文发送</span>` }), h('div', { class: 'en' }, m.en));
    det.addEventListener('toggle', () => toggleSet(state.expanded, key, det.open));
    el.append(det);
  } else if (m.translateError) {
    el.append(h('div', { class: 'tr-note error' }, `翻译失败，已发送中文原文：${m.translateError}`));
  }
  const done = m.status === 'sent' || !m.status;
  el.append(
    h(
      'div',
      { class: 'msg-actions' },
      versionSwitcher(m),
      h('button', { class: 'icon-btn', title: '复制', 'aria-label': '复制', html: icon('copy', 15), onclick: () => copyText(m.text) }),
      done
        ? h('button', {
            class: 'icon-btn',
            title: '编辑',
            'aria-label': '编辑',
            html: icon('pencil', 15),
            onclick: () => {
              state.editing = m.id;
              hooks.rerenderMessage(m);
            },
          })
        : null,
      done ? h('button', { class: 'icon-btn', title: '回退到这里之前', 'aria-label': '回退到这里之前', html: icon('rewind', 15), onclick: () => rewindTo(m) }) : null,
      h('span', { class: 'msg-time', title: new Date(m.ts).toLocaleString() }, relTime(m.ts)),
    ),
  );
  return el;
}

// ======================= Claude 回复 =======================

function renderText(m, b, showOrig) {
  const hasZh = b.zhStatus === 'done' && !!b.zh;
  const cls = ['block', 'text-block'];
  if (!b.final) cls.push('streaming');
  if (b.zhStatus === 'pending') cls.push('translating');
  const wrap = h('div', { class: cls.join(' ') });
  if (b.zhStatus === 'pending') wrap.append(h('div', { class: 'block-tag' }, h('span', { class: 'spinner' }), '正在翻译为中文…'));
  else if (b.zhStatus === 'error') wrap.append(h('div', { class: 'block-tag error' }, `翻译失败：${b.zhError || '未知错误'}`, h('button', { onclick: () => api.retranslate(state.currentId, m.id, b.key) }, '重试')));
  else if (!b.final && translationOn()) wrap.append(h('div', { class: 'block-tag' }, '英文原文 · 生成完成后自动翻译'));
  else if (showOrig && hasZh) wrap.append(h('div', { class: 'block-tag' }, '原文'));
  const md = h('div', { class: 'md' });
  md.innerHTML = renderMarkdown(hasZh && !showOrig ? b.zh : b.text);
  enhanceCode(md, icon('copy', 13));
  wrap.append(md);
  return wrap;
}

function collapsible(cardClass, key, headChildren, bodyBuilder, defaultOpen = false) {
  const open = state.expanded.has(key) || (defaultOpen && !state.collapsed.has(key));
  const card = h('div', { class: `${cardClass}${open ? ' open' : ''}` });
  const head = h('button', { class: 'tool-head', type: 'button', 'aria-expanded': String(open) }, headChildren, svg('chevronRight', 14, 'tool-chevron'));
  let body = null;
  const setOpen = (on) => {
    card.classList.toggle('open', on);
    head.setAttribute('aria-expanded', String(on));
    toggleSet(state.expanded, key, on);
    toggleSet(state.collapsed, key, !on);
    if (on && !body) {
      body = bodyBuilder();
      card.append(body);
    }
    if (body) body.hidden = !on;
  };
  head.addEventListener('click', () => setOpen(!card.classList.contains('open')));
  card.append(head);
  if (open) setOpen(true);
  return card;
}

function renderSub(b) {
  const t = b.task || {};
  const box = h('div', { class: 'subagent' });
  const meta = [t.subagentType || (b.input && b.input.subagent_type), t.background ? '后台运行' : null, t.status ? { running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止', killed: '已终止' }[t.status] || t.status : null].filter(Boolean);
  if (meta.length) box.append(h('div', { class: 'tool-sec' }, meta.join(' · ')));
  if (b.input && b.input.prompt) box.append(h('div', { class: 'tool-sec' }, '任务说明'), h('pre', {}, clip(b.input.prompt, 3000)));
  for (const s of b.sub || []) {
    if (s.type === 'text') box.append(h('div', { class: 'sub-text' }, clip(s.text, 600)));
    else {
      const d = describeTool(s.name, s.input);
      box.append(h('div', { class: 'sub-tool' }, svg(d.icon, 13), h('span', { class: 'tool-label' }, d.label), h('span', { class: 'tool-detail' }, d.detail), s.done ? svg(s.isError ? 'x' : 'check', 13, s.isError ? 'err' : 'ok') : h('span', { class: 'spinner' })));
    }
  }
  if (t.summary) box.append(h('div', { class: 'tool-sec' }, '结果摘要'), h('div', { class: 'sub-text' }, t.summary));
  return box;
}

function renderTool(m, b) {
  const input = b.input || tryParse(b.partialJson) || {};
  const d = describeTool(b.name, input);
  let stateEl = null;
  const running = m.status === 'running';
  if (b.done) stateEl = h('span', { class: `tool-state ${b.isError ? 'err' : 'ok'}` }, svg(b.isError ? 'x' : 'check', 14));
  else if (b.task && b.task.status && b.task.status !== 'running') stateEl = h('span', { class: 'tool-state ok' }, svg('check', 14));
  else if (running || (b.task && b.task.status === 'running')) stateEl = h('span', { class: 'tool-state' }, h('span', { class: 'spinner' }));
  const head = [svg(d.icon, 15), h('span', { class: 'tool-label' }, d.label), h('span', { class: `tool-side ${d.local ? 'local' : 'remote'}` }, d.local ? '本机' : '服务器'), h('span', { class: 'tool-detail', title: d.detail }, d.detail), stateEl];
  const short = String(b.name || '').replace(LOCAL_PREFIX, '');
  if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
    const doneN = input.todos.filter((t) => t.status === 'completed').length;
    head.splice(3, 1, h('span', { class: 'tool-detail' }, `${doneN} / ${input.todos.length} 已完成`));
    return collapsible('tool', b.key, head, () => h('div', { class: 'tool-body' }, renderTodos(input.todos)), true);
  }
  const diffable = ['Edit', 'MultiEdit', 'Write', 'edit_file', 'write_file'].includes(short);
  return collapsible(
    'tool',
    b.key,
    head,
    () => {
      const body = h('div', { class: 'tool-body' });
      if (b.name === 'Agent' || b.name === 'Task') body.append(renderSub(b));
      else if (diffable && b.input) {
        const diff = renderDiff(b.name, b.input, b.structured);
        if (diff) body.append(diff);
      } else if (input.command) {
        body.append(h('pre', { class: 'cmd' }, `$ ${input.command}`));
        if (input.description) body.append(h('div', { class: 'tool-sec' }, input.description));
      } else {
        body.append(h('div', { class: 'tool-sec' }, `输入 · ${b.name || ''}`), h('pre', {}, b.input ? JSON.stringify(b.input, null, 2) : b.partialJson || ''));
      }
      if (b.done && !(diffable && !b.isError)) body.append(h('div', { class: 'tool-sec' }, b.isError ? '错误' : '结果'), h('pre', { class: b.isError ? 'err' : '' }, b.result || '（无输出）'));
      return body;
    },
    diffable && b.done && !b.isError && !state.collapsed.has(b.key) && false,
  );
}

function renderThinking(b) {
  return collapsible('thinking', b.key, [svg('brain', 15), h('span', { class: 'tool-label' }, b.final ? '思考过程' : '正在思考…')], () => h('div', { class: 'thinking-body' }, b.text || ''));
}

// ---- 权限 / 提问 / 计划 ----

function suggestionLabel(sugs) {
  const parts = [];
  for (const s of sugs || []) {
    // setMode 不随“始终允许”生效（见 chat-manager answerPermission），这里也不列出
    if (s.type === 'addRules') for (const r of s.rules || []) parts.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    else if (s.type === 'addDirectories') parts.push(`允许访问 ${(s.directories || []).join(', ')}`);
  }
  return parts.join('；');
}

const resolvedLabel = { allowed: '已允许', always: '已始终允许', denied: '已拒绝', cancelled: '已失效' };

function permissionPreview(b) {
  const input = b.input || {};
  const box = h('div', { class: 'perm-preview' });
  const diff = renderDiff(b.toolName, input, null);
  if (diff) box.append(diff);
  else if (input.command) box.append(h('pre', { class: 'cmd' }, `$ ${input.command}`));
  else if (input.url) box.append(h('pre', {}, input.url));
  else if (Object.keys(input).length) box.append(h('pre', {}, clip(JSON.stringify(input, null, 2), 3000)));
  return box;
}

// 正在提交的请求：提交（含翻译）期间卡片禁用，防止重复点击
const answering = new Set();

function setCardBusy(requestId, busy) {
  const card = document.querySelector(`.perm-card[data-req="${CSS.escape(requestId)}"]`);
  if (!card) return;
  card.classList.toggle('busy', busy);
  card.setAttribute('aria-busy', String(busy));
  card.querySelectorAll('button, input, textarea').forEach((x) => (x.disabled = busy));
}

async function answer(b, ans) {
  if (answering.has(b.requestId)) return;
  answering.add(b.requestId);
  setCardBusy(b.requestId, true);
  try {
    await api.answerPermission(state.currentId, b.requestId, ans);
  } catch (e) {
    toast(errMsg(e), 'error');
    setCardBusy(b.requestId, false);
  } finally {
    answering.delete(b.requestId);
  }
}

function renderToolPermission(b) {
  const d = describeTool(b.toolName, b.input);
  const desc = b.descriptionZh || b.description;
  // 用 h() 包一层：原生 append 会把 null 当成文字 "null" 插入
  const card = h(
    'div',
    { class: 'perm-card', role: 'group', 'aria-label': '权限请求', 'data-req': b.requestId },
    h('div', { class: 'perm-title' }, svg('shield', 16), h('span', {}, `Claude 想要${d.local ? '在本机' : '在服务器上'}${d.label}`), h('code', {}, b.displayName || b.toolName)),
    desc && desc !== d.detail ? h('div', { class: 'perm-desc' }, desc) : null,
    permissionPreview(b),
    b.decisionReason ? h('div', { class: 'perm-reason', title: b.decisionReasonZh ? b.decisionReason : null }, svg('alert', 13), b.decisionReasonZh || b.decisionReason) : null,
    b.blockedPath ? h('div', { class: 'perm-reason' }, svg('folder', 13), `涉及工作目录之外的路径：${b.blockedPath}`) : null,
  );
  const msg = h('input', { type: 'text', class: 'perm-msg', placeholder: '拒绝时告诉 Claude 应该怎么做（可选）', 'aria-label': '拒绝理由' });
  const sl = suggestionLabel(b.suggestions);
  card.append(
    h(
      'div',
      { class: 'perm-actions' },
      h('button', { class: 'btn sm primary', autofocus: true, onclick: () => answer(b, { behavior: 'allow' }) }, '允许'),
      sl ? h('button', { class: 'btn sm', title: sl, onclick: () => answer(b, { behavior: 'allow', always: true }) }, '始终允许') : null,
      msg,
      h('button', { class: 'btn sm', onclick: () => answer(b, { behavior: 'deny', message: msg.value.trim() }) }, '拒绝'),
    ),
  );
  if (sl) card.append(h('div', { class: 'perm-hint' }, `“始终允许”会记住：${sl}`));
  msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) answer(b, { behavior: 'deny', message: msg.value.trim() });
  });
  return card;
}

function renderQuestion(b) {
  const qs = Array.isArray(b.input.questions) ? b.input.questions : [];
  const zh = b.zh || {};
  const card = h('div', { class: 'perm-card question', role: 'group', 'aria-label': 'Claude 的提问', 'data-req': b.requestId });
  card.append(h('div', { class: 'perm-title' }, svg('help', 16), h('span', {}, 'Claude 有问题想问你')));
  const pickers = [];
  qs.forEach((q, i) => {
    const sec = h('fieldset', { class: 'q-sec' }, h('legend', {}, q.header ? h('span', { class: 'q-header' }, q.header) : null, zh[`q${i}`] || q.question));
    if (zh[`q${i}`]) sec.append(h('div', { class: 'q-orig' }, q.question));
    const name = `q-${b.requestId}-${i}`;
    const inputs = [];
    (q.options || []).forEach((o, j) => {
      const inp = h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name, value: o.label });
      inputs.push(inp);
      const t = zh[`q${i}o${j}`];
      sec.append(h('label', { class: 'q-opt' }, inp, h('span', { class: 'q-opt-text' }, h('b', {}, o.label), t ? h('span', { class: 'q-opt-desc' }, t) : o.description ? h('span', { class: 'q-opt-desc' }, o.description) : null)));
    });
    const other = h('input', { type: 'text', class: 'q-other', placeholder: '其他（自己填写）', 'aria-label': '其他答案' });
    sec.append(other);
    pickers.push({ q, inputs, other });
    card.append(sec);
  });
  const submit = () => {
    const answers = {};
    for (const p of pickers) {
      const picked = p.inputs.filter((x) => x.checked).map((x) => x.value);
      const extra = p.other.value.trim();
      if (extra) picked.push(extra);
      if (!picked.length) {
        toast('请先回答所有问题', 'error');
        return;
      }
      answers[p.q.question] = picked.join(', ');
    }
    answer(b, { behavior: 'allow', answers });
  };
  card.append(h('div', { class: 'perm-actions' }, h('button', { class: 'btn sm primary', onclick: submit }, '提交回答'), h('button', { class: 'btn sm', onclick: () => answer(b, { behavior: 'deny', message: 'The user chose not to answer. Decide reasonably on your own.' }) }, '跳过')));
  return card;
}

function renderPlan(b) {
  const card = h('div', { class: 'perm-card plan', role: 'group', 'aria-label': '计划审批', 'data-req': b.requestId });
  card.append(h('div', { class: 'perm-title' }, svg('list', 16), h('span', {}, 'Claude 制定了计划，等待你批准')));
  const text = b.planZh || b.plan;
  if (text) {
    const md = h('div', { class: 'md plan-md' });
    md.innerHTML = renderMarkdown(text);
    card.append(md);
  } else card.append(h('div', { class: 'perm-desc' }, h('span', { class: 'spinner' }), ' 正在读取计划…'));
  const fb = h('textarea', { class: 'perm-msg', rows: '2', placeholder: '想调整什么？写下来让 Claude 继续规划', 'aria-label': '修改意见' });
  card.append(
    fb,
    h(
      'div',
      { class: 'perm-actions' },
      h('button', { class: 'btn sm primary', onclick: () => answer(b, { behavior: 'allow' }) }, '批准并执行'),
      h('button', { class: 'btn sm', onclick: () => answer(b, { behavior: 'allow', setMode: 'acceptEdits' }) }, '批准，并自动接受编辑'),
      h('button', { class: 'btn sm', onclick: () => answer(b, { behavior: 'deny', message: fb.value.trim() }) }, '继续规划'),
    ),
  );
  return card;
}

function renderPermission(b) {
  if (b.status !== 'pending') {
    const d = describeTool(b.toolName, b.input);
    let extra = '';
    if (b.kind === 'question' && b.answers) extra = `：${Object.values(b.answers).join('；')}`;
    if (b.status === 'denied' && b.denyMessage) extra = `：${b.denyMessage}`;
    let label;
    if (b.status === 'cancelled') label = b.kind === 'plan' ? '计划审批已失效' : b.kind === 'question' ? 'Claude 的提问已失效' : `已失效 · ${d.label}`;
    else if (b.kind === 'plan') label = b.status === 'denied' ? '计划：继续规划' : '计划已批准';
    else if (b.kind === 'question') label = b.status === 'denied' ? '跳过了 Claude 的问题' : `回答了 Claude 的问题${extra}`;
    else label = `${resolvedLabel[b.status] || b.status} · ${d.label}${extra}`;
    const done = h('div', { class: `perm-done ${b.status}` }, svg(b.status === 'denied' ? 'x' : b.status === 'cancelled' ? 'alert' : 'check', 13), label);
    if (!b.sentEn) return done;
    // 理由 / 答案经过翻译：可以展开查看实际发给 Claude 的英文
    const key = `sent:${b.key}`;
    const det = h('details', { class: 'tr-detail perm-sent', open: state.expanded.has(key) }, h('summary', { html: `${icon('languages', 13)}<span>已翻译为英文发送</span>` }), h('div', { class: 'en' }, b.sentEn));
    det.addEventListener('toggle', () => toggleSet(state.expanded, key, det.open));
    return h('div', { class: 'perm-done-wrap' }, done, det);
  }
  let card;
  if (b.kind === 'question') card = renderQuestion(b);
  else if (b.kind === 'plan') card = renderPlan(b);
  else card = renderToolPermission(b);
  // 提交过程中消息被重新渲染时，保持禁用状态
  if (answering.has(b.requestId)) {
    card.classList.add('busy');
    card.setAttribute('aria-busy', 'true');
    card.querySelectorAll('button, input, textarea').forEach((x) => (x.disabled = true));
  }
  return card;
}

// ---- 整条回复 ----

function runningLabel(m) {
  if (m.statusText) return m.statusText;
  if (m.retry) return `API 请求失败，正在重试（${m.retry.attempt}/${m.retry.max}）…`;
  const blocks = m.blocks || [];
  const last = blocks[blocks.length - 1];
  if (!last) return '思考中…';
  if (last.type === 'permission' && last.status === 'pending') return '等待你的确认…';
  if (last.type === 'tool_use' && !last.done) return '正在执行工具…';
  return '正在生成…';
}

export function collectText(m, preferZh) {
  return (m.blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => (preferZh && b.zhStatus === 'done' && b.zh ? b.zh : b.text))
    .join('\n\n');
}

function metaText(m) {
  const parts = [];
  if (m.model) parts.push(modelName(m.model));
  if (m.meta) {
    if (m.meta.durationMs) parts.push(`${(m.meta.durationMs / 1000).toFixed(1)} 秒`);
    if (m.meta.tokens) parts.push(`${fmtTokens(m.meta.tokens)} tokens`);
    if (typeof m.meta.costUsd === 'number' && m.meta.costUsd > 0) parts.push(`$${m.meta.costUsd.toFixed(4)}`);
    if (m.meta.turns) parts.push(`${m.meta.turns} 轮`);
  }
  if (m.status === 'stopped') parts.push('已停止');
  return parts.join(' · ');
}

export function renderAssistant(m) {
  const el = h('div', { class: 'msg assistant', 'data-id': m.id });
  const showOrig = state.showOriginal.has(m.id);
  for (const b of m.blocks || []) {
    if (b.type === 'text') el.append(renderText(m, b, showOrig));
    else if (b.type === 'thinking') el.append(renderThinking(b));
    else if (b.type === 'tool_use') el.append(renderTool(m, b));
    else if (b.type === 'permission') el.append(renderPermission(b));
  }
  for (const n of m.notices || []) el.append(h('div', { class: 'msg-notice' }, svg('alert', 13), n));
  if (m.error) el.append(h('div', { class: 'msg-error', role: 'alert' }, svg('alert', 16), h('div', {}, m.error)));
  if (m.status === 'running') {
    const detached = state.meta[state.currentId] && state.meta[state.currentId].run && !state.meta[state.currentId].run.attached && !(state.status && state.status.ssh.state === 'connected');
    el.append(h('div', { class: 'running', html: spark(20, 'spin') }, h('span', { class: 'label' }, detached ? '连接已断开 · 任务仍在服务器上运行，重新连接后会自动同步' : runningLabel(m))));
    return el;
  }
  const hasText = (m.blocks || []).some((b) => b.type === 'text');
  const hasZh = (m.blocks || []).some((b) => b.type === 'text' && b.zhStatus === 'done');
  const meta = metaText(m);
  el.append(
    h(
      'div',
      { class: 'msg-actions' },
      hasText ? h('button', { class: 'icon-btn', title: '复制', 'aria-label': '复制', html: icon('copy', 15), onclick: () => copyText(collectText(m, !showOrig)) }) : null,
      hasZh
        ? h('button', {
            class: `icon-btn${showOrig ? ' on' : ''}`,
            title: showOrig ? '显示译文' : '显示英文原文',
            'aria-label': showOrig ? '显示译文' : '显示英文原文',
            'aria-pressed': String(showOrig),
            html: icon('languages', 15),
            onclick: () => {
              toggleSet(state.showOriginal, m.id, !showOrig);
              hooks.rerenderMessage(m);
            },
          })
        : null,
      hasText && state.settings.translation.enabled
        ? h('button', { class: 'icon-btn', title: '重新翻译', 'aria-label': '重新翻译', html: icon('refresh', 15), onclick: () => api.retranslate(state.currentId, m.id).catch((e) => toast(errMsg(e), 'error')) })
        : null,
      m.forUser || hasText ? h('button', { class: 'icon-btn', title: '重新生成', 'aria-label': '重新生成', html: icon('regen', 15), onclick: () => api.regenerate(state.currentId, m.id).catch((e) => toast(errMsg(e), 'error')) }) : null,
      h('span', { class: 'msg-time', title: meta || new Date(m.ts).toLocaleString() }, relTime(m.ts)),
    ),
    h('div', { class: 'end-spark', html: spark(22) }),
  );
  return el;
}

export function renderMessage(m) {
  if (m.role === 'user') return renderUser(m);
  if (m.role === 'assistant') return renderAssistant(m);
  return h('div', { class: 'msg notice', 'data-id': m.id }, m.text);
}
