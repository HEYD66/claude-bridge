// 面板：内置终端、服务器文件浏览器、自定义页面、导入服务器会话、上下文用量、额度
import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '/node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { api, state, hooks, $, h, svg, errMsg, toast, copyText, relTime, fmtTokens, fmtSize, currentWorkdir, connected, patchSettings, showPopover, showMenu, closeMenu, openModal, dialogShell, confirmDialog, promptDialog, lightbox, workdirName } from './core.js';

// ======================= 内置终端 =======================

const term = { xterm: null, fit: null, id: null, ro: null };

function termTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? { background: '#171717', foreground: '#e6e6e6', cursor: '#d97757', selectionBackground: '#454545' }
    : { background: '#fbfaf7', foreground: '#2b2a27', cursor: '#d97757', selectionBackground: '#d9d5c9' };
}

export function initTerminal() {
  api.onTermData(({ id, data }) => {
    if (id === term.id && term.xterm) term.xterm.write(data);
  });
  api.onTermExit(({ id }) => {
    if (id === term.id && term.xterm) {
      term.xterm.write('\r\n\x1b[90m[会话已结束]\x1b[0m\r\n');
      term.id = null;
      $('#term-title').textContent = '终端（已断开）';
    }
  });
  $('#btn-term-close').addEventListener('click', closeTerminal);
  $('#btn-term-restart').addEventListener('click', () => openTerminalPanel({}));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (term.xterm) term.xterm.options.theme = termTheme();
  });
}

/** 打开内置终端；kind: login / update / claude（打开后自动执行对应命令） */
export async function openTerminalPanel({ kind } = {}) {
  if (!connected()) {
    toast('请先连接服务器', 'error');
    return;
  }
  const panel = $('#term-panel');
  panel.hidden = false;
  if (!term.xterm) {
    term.xterm = new Terminal({ fontFamily: "'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace", fontSize: 13, cursorBlink: true, theme: termTheme(), scrollback: 5000, allowProposedApi: false });
    term.fit = new FitAddon();
    term.xterm.loadAddon(term.fit);
    term.xterm.open($('#term-host'));
    term.xterm.onData((d) => {
      if (term.id) api.termWrite(term.id, d);
    });
    term.xterm.onResize(({ cols, rows }) => {
      if (term.id) api.termResize(term.id, cols, rows);
    });
    term.ro = new ResizeObserver(() => {
      try {
        term.fit.fit();
      } catch {
        /* 面板隐藏时忽略 */
      }
    });
    term.ro.observe($('#term-host'));
  }
  await new Promise((r) => requestAnimationFrame(r));
  term.fit.fit();
  if (term.id && !kind) {
    term.xterm.focus();
    return;
  }
  if (term.id) await api.termClose(term.id);
  term.xterm.reset();
  const s = state.settings.ssh;
  $('#term-title').textContent = `终端 · ${s.username}@${s.host}`;
  try {
    term.id = await api.termOpen({ cols: term.xterm.cols, rows: term.xterm.rows, kind: kind || 'cd', workdir: currentWorkdir() });
  } catch (e) {
    term.xterm.write(`\x1b[31m${errMsg(e)}\x1b[0m\r\n`);
  }
  term.xterm.focus();
}

export function closeTerminal() {
  if (term.id) api.termClose(term.id);
  term.id = null;
  $('#term-panel').hidden = true;
}

// ======================= 上下文用量 / 额度 =======================

export function contextPopover(anchor) {
  const ctx = state.meta[state.currentId] && state.meta[state.currentId].context;
  const box = h('div', { class: 'ctx-pop' });
  box.append(h('div', { class: 'menu-label' }, '上下文用量'));
  if (!ctx) box.append(h('div', { class: 'ctx-empty' }, state.currentId ? '还没有数据，Claude 回复一次后会显示' : '开始对话后显示'));
  else {
    const pct = ctx.maxTokens ? Math.min(100, (ctx.totalTokens / ctx.maxTokens) * 100) : ctx.percentage || 0;
    box.append(h('div', { class: 'ctx-total' }, h('b', {}, `${pct.toFixed(0)}%`), ` · ${fmtTokens(ctx.totalTokens)} / ${fmtTokens(ctx.maxTokens)} tokens`), h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` })));
    const NAMES = { 'System prompt': '系统提示', 'System tools': '系统工具', 'MCP tools': 'MCP 工具', 'Memory files': '记忆文件', Skills: '技能', Messages: '对话消息', 'Custom agents': '自定义子代理', 'Autocompact buffer': '自动压缩预留', 'Free space': '剩余空间' };
    for (const c of ctx.categories || []) {
      if (!c.tokens) continue;
      box.append(h('div', { class: `ctx-row ${c.kind || ''}` }, h('span', {}, NAMES[c.name] || c.name), h('span', { class: 'num' }, fmtTokens(c.tokens))));
    }
    box.append(h('div', { class: 'hint-text' }, `更新于 ${relTime(ctx.at)}`));
  }
  const busy = state.currentId && state.running.has(state.currentId);
  box.append(
    h(
      'div',
      { class: 'ctx-actions' },
      h('button', { class: 'btn sm', disabled: !state.currentId || busy || null, onclick: () => (closeMenu(), hooks.sendRaw('/compact')) }, '压缩上下文'),
      h('button', {
        class: 'btn sm',
        disabled: !state.currentId || busy || null,
        onclick: async () => {
          closeMenu();
          try {
            await api.contextUsage(state.currentId);
          } catch (e) {
            toast(errMsg(e), 'error');
          }
        },
      }, '刷新'),
    ),
  );
  showPopover(anchor, box);
}

export function rateLimitRows(info) {
  if (!info) return [];
  const rows = [];
  const win = info.unifiedWindows || {};
  const names = { five_hour: '5 小时额度', seven_day: '本周额度', seven_day_overage_included: '本周（含超额）' };
  for (const [k, v] of Object.entries(win)) {
    if (!v || typeof v.utilization !== 'number') continue;
    rows.push({ name: names[k] || k, pct: Math.round(v.utilization * 100), resetsAt: v.resetsAt ? v.resetsAt * 1000 : null });
  }
  if (!rows.length && typeof info.utilization === 'number') rows.push({ name: names[info.rateLimitType] || info.rateLimitType || '当前额度', pct: Math.round(info.utilization * 100), resetsAt: info.resetsAt ? info.resetsAt * 1000 : null });
  return rows;
}

export function fmtReset(ts) {
  if (!ts) return '';
  const d = ts - Date.now();
  if (d <= 0) return '已重置';
  // 先取整到分钟再拆分，避免出现“1 小时 60 分钟”
  const total = Math.max(1, Math.round(d / 60e3));
  const hr = Math.floor(total / 60);
  const min = total % 60;
  if (hr >= 24) return `${Math.floor(hr / 24)} 天${hr % 24 ? ` ${hr % 24} 小时` : ''}后重置`;
  return hr ? `${hr} 小时${min ? ` ${min} 分钟` : ''}后重置` : `${min} 分钟后重置`;
}

export function renderRateLimits(box, info) {
  const rows = rateLimitRows(info);
  if (!rows.length) {
    box.append(h('div', { class: 'stats-foot' }, info && info.status === 'rejected' ? '额度已用尽' : '暂无额度数据：使用订阅账号登录、并完成一次对话后才会显示（API Key 方式没有额度窗口）。'));
    return;
  }
  for (const r of rows) {
    box.append(
      h('div', { class: 'model-row' }, h('span', { class: 'name' }, r.name), h('span', { class: 'num' }, `${r.pct}% · ${fmtReset(r.resetsAt)}`), h('div', { class: `bar${r.pct >= 90 ? ' full' : r.pct >= 70 ? ' warn' : ''}` }, h('span', { style: `width:${Math.min(100, r.pct)}%` }))),
    );
  }
  if (info.at) box.append(h('div', { class: 'stats-foot' }, `数据来自 ${relTime(info.at)} 的一次请求`));
}

// ======================= 导入服务器会话 =======================

export async function importDialog() {
  if (!connected()) {
    toast('请先连接服务器', 'error');
    return;
  }
  const list = h('div', { class: 'session-list' }, h('div', { class: 'conv-empty' }, h('span', { class: 'spinner' }), ' 正在读取服务器上的会话…'));
  const dlg = dialogShell({
    title: '服务器上的 Claude 会话',
    badge: icon('server', 20),
    wide: true,
    body: h('div', { class: 'dialog-body' }, h('p', { class: 'hint-text' }, '这里列出服务器 ~/.claude/projects 中的会话（包括在服务器终端里直接用 claude 开的会话）。导入后可以在这里继续对话。'), list),
    foot: h('div', { class: 'dialog-foot' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => m.close() }, '关闭')),
  });
  const m = openModal(dlg);
  let sessions;
  try {
    sessions = await api.serverSessions();
  } catch (e) {
    list.textContent = '';
    list.append(h('div', { class: 'conv-empty error' }, errMsg(e)));
    return;
  }
  list.textContent = '';
  if (!sessions.length) list.append(h('div', { class: 'conv-empty' }, '服务器上还没有 Claude 会话'));
  for (const s of sessions) {
    const btn = h('button', { class: 'btn sm', disabled: s.imported || null }, s.imported ? '已导入' : '导入');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '导入中…';
      try {
        const sum = await api.importSession(s.file);
        m.close();
        hooks.openConversation(sum.id);
        toast('已导入，可以继续对话');
      } catch (e) {
        toast(errMsg(e), 'error');
        btn.disabled = false;
        btn.textContent = '导入';
      }
    });
    list.append(h('div', { class: 'session-item' }, h('div', { class: 'si-main' }, h('div', { class: 'si-title' }, s.title), h('div', { class: 'si-meta' }, `${s.cwd || '?'} · ${relTime(s.mtime)} · ${fmtSize(s.size)}`)), btn));
  }
}

// ======================= 自定义 =======================

const CUSTOM_TABS = [
  ['instructions', '指令', 'file'],
  ['memory', '记忆', 'brain'],
  ['skills', '技能', 'tool'],
  ['agents', '子代理', 'layers'],
  ['styles', '输出风格', 'pencil'],
  ['permissions', '权限规则', 'shield'],
  ['hooks', 'Hooks', 'code'],
  ['mcp', '连接器', 'plug'],
  ['plugins', '插件', 'briefcase'],
];

function fileEditor(title, path, { hint, placeholder, onSaved } = {}) {
  const ta = h('textarea', { class: 'code-edit', rows: '14', spellcheck: 'false', placeholder: placeholder || '', 'aria-label': title });
  const status = h('span', { class: 'hint-text' }, '读取中…');
  const save = h('button', { class: 'btn sm primary', disabled: true }, '保存');
  api.customRead(path).then(
    (text) => {
      ta.value = text || '';
      status.textContent = text == null ? '文件不存在，保存后创建' : '';
      save.disabled = false;
    },
    (e) => (status.textContent = errMsg(e)),
  );
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api.customWrite(path, ta.value);
      status.textContent = '已保存';
      if (onSaved) onSaved();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      save.disabled = false;
    }
  });
  return h('div', { class: 'field' }, h('div', { class: 'label' }, title), h('div', { class: 'hint' }, h('code', {}, path), hint ? ` · ${hint}` : ''), ta, h('div', { class: 'editor-foot' }, status, save));
}

function itemRow(title, desc, actions) {
  return h('div', { class: 'cust-item' }, h('div', { class: 'ci-main' }, h('div', { class: 'ci-title' }, title), desc ? h('div', { class: 'ci-desc' }, desc) : null), h('div', { class: 'ci-actions' }, actions));
}

async function editRemoteFile(path, title, after) {
  const content = await api.customRead(path).catch(() => '');
  const v = await promptDialog({ title, label: path, value: content || '', multiline: true, hint: 'Ctrl+Enter 保存' });
  if (v == null) return;
  await api.customWrite(path, v);
  toast('已保存');
  if (after) after();
}

function cliOutput(args) {
  const out = h('pre', { class: 'cli-out' }, '运行中…');
  api.customCli(args).then(
    (r) => (out.textContent = r.output.trim() || `（无输出，exit ${r.code}）`),
    (e) => (out.textContent = errMsg(e)),
  );
  return out;
}

const PANES = {
  async instructions(ov) {
    return [
      fileEditor('全局指令（所有项目）', ov.files.globalClaudeMd, { hint: '对服务器上所有 Claude 会话生效', placeholder: '例如：回复时先给结论；修改代码后运行测试……' }),
      fileEditor(`项目指令（${workdirName(ov.project)}）`, ov.files.projectClaudeMd, { hint: '只对这个项目目录生效，通常提交到代码仓库' }),
    ];
  },

  async memory(ov, rerender) {
    const dir = state.memoryPaths && state.memoryPaths.auto;
    if (!dir) return [h('p', { class: 'hint-text' }, 'Claude 的自动记忆目录会在第一次对话后显示。')];
    let entries = [];
    try {
      entries = (await api.rfsList(dir)).entries.filter((e) => e.type !== 'dir');
    } catch {
      return [h('p', { class: 'hint-text' }, `记忆目录：${dir}（还没有记忆）`)];
    }
    const out = [h('p', { class: 'hint-text' }, `Claude 会把需要长期记住的信息写在这里：${dir}`)];
    if (!entries.length) out.push(h('div', { class: 'conv-empty' }, '还没有记忆'));
    for (const e of entries) {
      const p = `${dir.replace(/\/$/, '')}/${e.name}`;
      out.push(
        itemRow(e.name, `${fmtSize(e.size)} · ${relTime(e.mtime)}`, [
          h('button', { class: 'btn sm', onclick: () => editRemoteFile(p, '编辑记忆', rerender) }, '编辑'),
          h('button', {
            class: 'btn sm danger',
            onclick: async () => {
              if (await confirmDialog({ title: '删除记忆', message: `删除 ${e.name}？`, danger: true, okText: '删除' })) {
                await api.customRemove(p);
                rerender();
              }
            },
          }, '删除'),
        ]),
      );
    }
    return out;
  },

  async skills(ov, rerender) {
    const out = [h('div', { class: 'pane-actions' }, h('button', { class: 'btn sm primary', onclick: () => skillDialog(null, rerender) }, svg('plus', 14), '新建技能'))];
    if (!ov.skills.length) out.push(h('div', { class: 'conv-empty' }, '还没有自定义技能'));
    for (const s of ov.skills) {
      out.push(
        itemRow(`${s.name}${s.scope === 'project' ? '（项目）' : ''}`, s.description, [
          h('button', { class: 'btn sm', onclick: () => editRemoteFile(s.path, `编辑技能 ${s.name}`, rerender) }, '编辑'),
          h('button', {
            class: 'btn sm danger',
            onclick: async () => {
              if (await confirmDialog({ title: '删除技能', message: `删除技能 ${s.name}（整个目录）？`, danger: true, okText: '删除' })) {
                await api.customRemove(s.dir);
                rerender();
              }
            },
          }, '删除'),
        ]),
      );
    }
    const builtin = ((state.claudeInfo && state.claudeInfo.commands) || []).filter((c) => !ov.skills.some((s) => s.name === c.name));
    if (builtin.length) {
      out.push(h('h3', {}, '内置 / 插件提供的技能与命令'));
      for (const c of builtin.slice(0, 80)) out.push(itemRow(`/${c.name}`, c.description.slice(0, 160), []));
    }
    return out;
  },

  async agents(ov, rerender) {
    const out = [h('div', { class: 'pane-actions' }, h('button', { class: 'btn sm primary', onclick: () => agentDialog(rerender) }, svg('plus', 14), '新建子代理'))];
    if (!ov.agents.length) out.push(h('div', { class: 'conv-empty' }, '还没有自定义子代理'));
    for (const a of ov.agents) {
      out.push(
        itemRow(`${a.name}${a.scope === 'project' ? '（项目）' : ''}`, [a.description, a.model ? `模型 ${a.model}` : '', a.tools ? `工具 ${a.tools}` : ''].filter(Boolean).join(' · '), [
          h('button', { class: 'btn sm', onclick: () => editRemoteFile(a.path, `编辑子代理 ${a.name}`, rerender) }, '编辑'),
          h('button', {
            class: 'btn sm danger',
            onclick: async () => {
              if (await confirmDialog({ title: '删除子代理', message: `删除 ${a.name}？`, danger: true, okText: '删除' })) {
                await api.customRemove(a.path);
                rerender();
              }
            },
          }, '删除'),
        ]),
      );
    }
    const builtin = ((state.claudeInfo && state.claudeInfo.agents) || []).filter((x) => !ov.agents.some((a) => a.name === x.name));
    if (builtin.length) out.push(h('h3', {}, '内置子代理'), ...builtin.map((x) => itemRow(x.name, x.description || '', [])));
    return out;
  },

  async styles(ov, rerender) {
    const cur = state.settings.claude.outputStyle || '';
    const names = new Set(['', ...((state.claudeInfo && state.claudeInfo.outputStyles) || []), ...ov.styles.map((s) => s.name)]);
    const out = [h('p', { class: 'hint-text' }, '输出风格会改变 Claude 回复的方式（例如更多解释、教学模式）。新会话生效。')];
    for (const n of names) {
      const custom = ov.styles.find((s) => s.name === n);
      const radio = h('input', { type: 'radio', name: 'ostyle', value: n });
      radio.checked = n === cur;
      radio.addEventListener('change', () => patchSettings((s) => (s.claude.outputStyle = n)).then(() => toast('已切换输出风格，新会话生效')));
      out.push(h('label', { class: 'cust-item radio' }, radio, h('div', { class: 'ci-main' }, h('div', { class: 'ci-title' }, n || '默认（服务器设置）'), custom ? h('div', { class: 'ci-desc' }, custom.path) : null), custom ? h('button', { class: 'btn sm', onclick: (e) => (e.preventDefault(), editRemoteFile(custom.path, `编辑输出风格 ${n}`, rerender)) }, '编辑') : null));
    }
    out.push(
      h('div', { class: 'pane-actions' }, h('button', {
        class: 'btn sm',
        onclick: async () => {
          const name = await promptDialog({ title: '新建输出风格', label: '名称（字母、数字、短横线）' });
          if (!name) return;
          const p = `${ov.home}/.claude/output-styles/${name.trim()}.md`;
          await api.customWrite(p, `---\nname: ${name.trim()}\ndescription: \n---\n\n在这里描述 Claude 应该如何回复。\n`);
          await editRemoteFile(p, `编辑输出风格 ${name}`, rerender);
        },
      }, svg('plus', 14), '新建输出风格')),
    );
    return out;
  },

  async permissions(ov, rerender) {
    const out = [h('p', { class: 'hint-text' }, '规则格式例如 Bash(npm run *)、Edit(src/**)、WebFetch(domain:github.com)。权限请求里点“始终允许”的规则会写入项目的 settings.local.json。')];
    for (const [title, path] of [['用户（所有项目）', ov.files.userSettings], [`项目本地（${workdirName(ov.project)}）`, ov.files.localSettings]]) {
      let json = {};
      try {
        json = await api.customReadJson(path);
      } catch (e) {
        out.push(h('div', { class: 'status-box error' }, errMsg(e)));
        continue;
      }
      const perms = json.permissions || {};
      const sec = h('div', { class: 'perm-sec' }, h('h3', {}, title), h('div', { class: 'hint' }, h('code', {}, path)));
      for (const [key, label] of [['allow', '允许'], ['ask', '询问'], ['deny', '拒绝']]) {
        const rules = Array.isArray(perms[key]) ? perms[key] : [];
        const save = async (next) => {
          const p = { ...perms, [key]: next };
          if (!next.length) delete p[key];
          await api.customPatchSettings(path, 'permissions', Object.keys(p).length ? p : null);
          rerender();
        };
        const input = h('input', { type: 'text', placeholder: '添加规则，例如 Bash(git status)', 'aria-label': `添加${label}规则` });
        const add = () => {
          const v = input.value.trim();
          if (v && !rules.includes(v)) save([...rules, v]);
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) add();
        });
        sec.append(
          h(
            'div',
            { class: `rule-group ${key}` },
            h('div', { class: 'label' }, label),
            h('div', { class: 'rules' }, rules.length ? rules.map((r) => h('span', { class: 'rule' }, h('code', {}, r), h('button', { class: 'icon-btn sm', title: '移除', 'aria-label': `移除 ${r}`, html: icon('x', 12), onclick: () => save(rules.filter((x) => x !== r)) }))) : h('span', { class: 'hint-text' }, '无')),
            h('div', { class: 'input-row' }, input, h('button', { class: 'btn sm', onclick: add }, '添加')),
          ),
        );
      }
      out.push(sec);
    }
    return out;
  },

  async hooks(ov) {
    let json = {};
    try {
      json = await api.customReadJson(ov.files.userSettings);
    } catch (e) {
      return [h('div', { class: 'status-box error' }, errMsg(e))];
    }
    const ta = h('textarea', { class: 'code-edit', rows: '16', spellcheck: 'false', 'aria-label': 'Hooks 配置' });
    ta.value = JSON.stringify(json.hooks || {}, null, 2);
    const status = h('span', { class: 'hint-text' });
    const save = h('button', { class: 'btn sm primary' }, '保存');
    save.addEventListener('click', async () => {
      let v;
      try {
        v = JSON.parse(ta.value || '{}');
      } catch (e) {
        status.textContent = `JSON 格式错误：${e.message}`;
        return;
      }
      await api.customPatchSettings(ov.files.userSettings, 'hooks', Object.keys(v).length ? v : null);
      status.textContent = '已保存，新会话生效';
    });
    return [
      h('p', { class: 'hint-text' }, 'Hooks 让 Claude Code 在特定事件（如工具调用前后、会话结束）自动运行命令。格式参见 Claude Code 文档的 hooks 部分。'),
      h('div', { class: 'field' }, h('div', { class: 'hint' }, h('code', {}, ov.files.userSettings), ' → hooks'), ta, h('div', { class: 'editor-foot' }, status, save)),
    ];
  },

  async mcp(ov, rerender) {
    const name = h('input', { type: 'text', placeholder: '名称，例如 github' });
    const type = h('select', {}, h('option', { value: 'http' }, 'HTTP'), h('option', { value: 'sse' }, 'SSE'), h('option', { value: 'stdio' }, '本地命令（stdio）'));
    const target = h('input', { type: 'text', placeholder: 'URL，或命令及参数（如 npx -y @modelcontextprotocol/server-github）' });
    const extra = h('input', { type: 'text', placeholder: '请求头（Key: Value；多个用 ; 分隔）或环境变量（KEY=value；多个用 ; 分隔）' });
    const scope = h('select', {}, h('option', { value: 'user' }, '所有项目（user）'), h('option', { value: 'local' }, '仅这个项目（local）'), h('option', { value: 'project' }, '项目共享（project，写入 .mcp.json）'));
    const add = h('button', { class: 'btn sm primary' }, '添加连接器');
    add.addEventListener('click', async () => {
      const n = name.value.trim();
      const t = target.value.trim();
      if (!/^[\w.-]+$/.test(n) || !t) {
        toast('请填写名称（字母、数字、短横线）和 URL / 命令', 'error');
        return;
      }
      const pairs = extra.value.split(';').map((x) => x.trim()).filter(Boolean);
      let cfg;
      if (type.value === 'stdio') {
        const parts = t.match(/(?:[^\s"]+|"[^"]*")+/g).map((x) => x.replace(/^"|"$/g, ''));
        cfg = { type: 'stdio', command: parts[0], args: parts.slice(1) };
        if (pairs.length) cfg.env = Object.fromEntries(pairs.map((p) => [p.split('=')[0].trim(), p.slice(p.indexOf('=') + 1).trim()]));
      } else {
        cfg = { type: type.value, url: t };
        if (pairs.length) cfg.headers = Object.fromEntries(pairs.map((p) => [p.split(':')[0].trim(), p.slice(p.indexOf(':') + 1).trim()]));
      }
      add.disabled = true;
      try {
        const r = await api.customCli(['mcp', 'add-json', '--scope', scope.value, n, JSON.stringify(cfg)]);
        toast(r.code === 0 ? '已添加，新会话生效' : r.output.slice(0, 300), r.code === 0 ? '' : 'error');
        rerender();
      } catch (e) {
        toast(errMsg(e), 'error');
      } finally {
        add.disabled = false;
      }
    });
    const del = h('button', {
      class: 'btn sm danger',
      onclick: async () => {
        const n = await promptDialog({ title: '移除连接器', label: '要移除的连接器名称' });
        if (!n || !n.trim()) return;
        const r = await api.customCli(['mcp', 'remove', n.trim()]);
        toast(r.code === 0 ? '已移除' : r.output.slice(0, 300), r.code === 0 ? '' : 'error');
        rerender();
      },
    }, '移除连接器…');
    return [
      h('p', { class: 'hint-text' }, '这些是服务器上 Claude Code 自己的 MCP 连接器（与“本机访问”无关）。'),
      h('h3', {}, '已配置'),
      cliOutput(['mcp', 'list']),
      h('h3', {}, '添加'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, '名称'), name), h('div', { class: 'field' }, h('label', {}, '类型'), type), h('div', { class: 'field' }, h('label', {}, '范围'), scope)),
      h('div', { class: 'field' }, h('label', {}, 'URL / 命令'), target),
      h('div', { class: 'field' }, h('label', {}, '请求头 / 环境变量（可选）'), extra),
      h('div', { class: 'pane-actions' }, add, del),
    ];
  },

  async plugins(ov, rerender) {
    const run = async (args, msg) => {
      const r = await api.customCli(args);
      toast(r.code === 0 ? msg : r.output.slice(0, 300), r.code === 0 ? '' : 'error');
      rerender();
    };
    const ask = async (title, label) => {
      const v = await promptDialog({ title, label });
      return v && v.trim();
    };
    return [
      h('p', { class: 'hint-text' }, '插件可以一次性提供技能、子代理、命令和 Hooks。安装来源一般是插件市场，例如 plugin@marketplace。'),
      h(
        'div',
        { class: 'pane-actions' },
        h('button', { class: 'btn sm primary', onclick: async () => { const v = await ask('安装插件', '插件名（如 name@marketplace）'); if (v) run(['plugin', 'install', v], '已安装，新会话生效'); } }, '安装…'),
        h('button', { class: 'btn sm', onclick: async () => { const v = await ask('卸载插件', '插件名'); if (v) run(['plugin', 'uninstall', v], '已卸载'); } }, '卸载…'),
        h('button', { class: 'btn sm', onclick: async () => { const v = await ask('启用插件', '插件名'); if (v) run(['plugin', 'enable', v], '已启用'); } }, '启用…'),
        h('button', { class: 'btn sm', onclick: async () => { const v = await ask('停用插件', '插件名'); if (v) run(['plugin', 'disable', v], '已停用'); } }, '停用…'),
        h('button', { class: 'btn sm', onclick: async () => { const v = await ask('添加插件市场', '市场地址（GitHub 仓库或 URL）'); if (v) run(['plugin', 'marketplace', 'add', v], '已添加市场'); } }, '添加市场…'),
      ),
      h('h3', {}, '已安装'),
      cliOutput(['plugin', 'list']),
    ];
  },
};

async function skillDialog(_skill, after) {
  const name = h('input', { type: 'text', placeholder: '例如 code-review' });
  const desc = h('input', { type: 'text', placeholder: '什么时候使用这个技能（Claude 据此判断是否调用）' });
  const scope = h('select', {}, h('option', { value: 'user' }, '所有项目'), h('option', { value: 'project' }, '仅当前项目'));
  const body = h('textarea', { class: 'code-edit', rows: '10', placeholder: '技能的具体步骤和要求（Markdown）' });
  const ok = await confirmDialog({
    title: '新建技能',
    okText: '创建',
    body: h('div', {}, h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, '名称'), name), h('div', { class: 'field' }, h('label', {}, '范围'), scope)), h('div', { class: 'field' }, h('label', {}, '说明'), desc), h('div', { class: 'field' }, h('label', {}, '内容'), body)),
  });
  if (!ok) return;
  try {
    await api.customSaveSkill({ scope: scope.value, name: name.value, description: desc.value, body: body.value, workdir: currentWorkdir() });
    toast('技能已创建');
    after();
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

async function agentDialog(after) {
  const name = h('input', { type: 'text', placeholder: '例如 test-runner' });
  const desc = h('input', { type: 'text', placeholder: '什么时候把任务交给这个子代理' });
  const tools = h('input', { type: 'text', placeholder: '可用工具（逗号分隔，留空表示全部），如 Read, Grep, Bash' });
  const model = h('input', { type: 'text', placeholder: '模型（留空继承），如 sonnet' });
  const scope = h('select', {}, h('option', { value: 'user' }, '所有项目'), h('option', { value: 'project' }, '仅当前项目'));
  const body = h('textarea', { class: 'code-edit', rows: '8', placeholder: '子代理的系统提示词' });
  const ok = await confirmDialog({
    title: '新建子代理',
    okText: '创建',
    body: h(
      'div',
      {},
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, '名称'), name), h('div', { class: 'field' }, h('label', {}, '范围'), scope)),
      h('div', { class: 'field' }, h('label', {}, '说明'), desc),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, '工具'), tools), h('div', { class: 'field' }, h('label', {}, '模型'), model)),
      h('div', { class: 'field' }, h('label', {}, '提示词'), body),
    ),
  });
  if (!ok) return;
  try {
    await api.customSaveAgent({ scope: scope.value, name: name.value, description: desc.value, tools: tools.value, model: model.value, body: body.value, workdir: currentWorkdir() });
    toast('子代理已创建');
    after();
  } catch (e) {
    toast(errMsg(e), 'error');
  }
}

export function openCustomize(tab = 'instructions') {
  if (!connected()) {
    toast('自定义需要先连接服务器（内容保存在服务器上）', 'error');
    return;
  }
  let current = tab;
  let ov = null;
  const nav = h('nav', { class: 'settings-nav', 'aria-label': '自定义分类' });
  const pane = h('div', { class: 'settings-pane' });
  const render = async (reload = false) => {
    nav.textContent = '';
    for (const [key, label, ic] of CUSTOM_TABS) {
      nav.append(h('button', { class: key === current ? 'active' : '', 'aria-current': key === current ? 'page' : null, onclick: () => ((current = key), render()) }, svg(ic, 16), label));
    }
    pane.textContent = '';
    pane.append(h('div', { class: 'conv-empty' }, h('span', { class: 'spinner' }), ' 读取中…'));
    try {
      if (!ov || reload) ov = await api.customOverview(currentWorkdir());
      const items = await PANES[current](ov, () => render(true));
      pane.textContent = '';
      pane.append(...items.flat().filter(Boolean));
    } catch (e) {
      pane.textContent = '';
      pane.append(h('div', { class: 'status-box error' }, errMsg(e)));
    }
  };
  const dlg = dialogShell({
    title: `自定义 · ${state.settings.ssh.host}`,
    wide: true,
    body: h('div', { class: 'settings' }, nav, pane),
    foot: h('div', { class: 'dialog-foot' }, h('span', { class: 'hint-text' }, `项目：${currentWorkdir()}`), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => m.close() }, '完成')),
  });
  const m = openModal(dlg, { dismissible: false });
  render();
}
