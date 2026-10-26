'use strict';

/**
 * 对话引擎。
 *
 * 每个对话在服务器上对应一个常驻的 Claude Code 进程（stream-json 双向协议，见 session-host.js）：
 *  - 运行中可以继续发消息（排队 / 立即发送），可以打断；
 *  - 权限请求、Claude 的提问、计划审批通过控制协议（can_use_tool）在界面内联处理；
 *  - 断网或关闭本程序后任务继续运行，重连后从偏移量续读；
 *  - 支持编辑重发 / 重新生成（会话分叉 + 版本切换）、文件检查点回退、上下文用量、提示建议等。
 * 渲染进程只负责展示，所有状态都在这里维护并持久化。
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { uid, hasCJK, needsZhTranslation, truncate, shQuote, remotePathExpr, isUuid, sleep } = require('./util');
const { RemoteRun, cleanupOldRuns, oneShotControl, normalizeInfo, mcpConfigRemotePath, DETECT_SCRIPT } = require('./session-host');
const { summarize } = require('./store');
const { SERVER_NAME } = require('./mcp-server');

const TOOL_RESULT_MAX = 8000;
const SUB_MAX = 80;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeTitle(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 28 ? `${t.slice(0, 28)}…` : t || '新对话';
}

function stringifyToolResult(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c || typeof c !== 'object') return String(c);
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return '[图片]';
        return JSON.stringify(c);
      })
      .join('\n');
  }
  return JSON.stringify(content, null, 2);
}

/** 只保留渲染 diff 需要的结构化结果，避免把整份文件存进对话记录 */
function trimStructured(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  if (typeof r.type === 'string') out.type = r.type;
  if (typeof r.filePath === 'string') out.filePath = r.filePath;
  if (Array.isArray(r.structuredPatch)) {
    let lines = 0;
    out.structuredPatch = [];
    for (const h of r.structuredPatch) {
      if (!h || !Array.isArray(h.lines)) continue;
      if (lines > 1500) break;
      out.structuredPatch.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines.slice(0, 600) });
      lines += h.lines.length;
    }
  }
  if (typeof r.content === 'string' && (r.type === 'create' || r.type === 'update')) out.content = truncate(r.content, 20000);
  if (r.answers && typeof r.answers === 'object') out.answers = r.answers;
  return Object.keys(out).length ? out : null;
}

function buildSystemPrompt(settings, mcpAvailable, mode, desktop) {
  const parts = [
    'You are being operated remotely through "Claude Bridge" by a user sitting at a Windows PC.',
    "Your built-in tools (Bash, Read, Edit, Write, Glob, Grep, ...) act on THIS remote Linux server, not on the user's PC.",
  ];
  if (settings.translation.enabled) {
    parts.push(
      'The user writes in Chinese; their messages are machine-translated into English, and your replies are machine-translated back into Chinese. ' +
        'Write clear, plain English, and put code, paths and commands in Markdown code formatting so they survive translation.',
    );
  }
  if (mcpAvailable) {
    parts.push(
      `The user's local Windows PC is reachable ONLY through the MCP tools named mcp__${SERVER_NAME}__* (paths are Windows paths such as D:\\project\\app.js). ` +
        `When the user mentions "my computer", "local", "本机" or Windows paths, use those tools. Call mcp__${SERVER_NAME}__list_allowed_roots first to learn which local folders are shared.`,
    );
    // 用户的项目在本机：安装、构建、启动服务都在本机做，并用内置浏览器预览
    parts.push(
      "When the user's project is on their PC, install dependencies, build, run and serve it ON THE PC — never copy it to or run it on this server unless the user asks. " +
        `Use mcp__${SERVER_NAME}__run_command for commands that finish, and mcp__${SERVER_NAME}__start_process for dev servers and other long-running commands (then read_process_output / stop_process). ` +
        `Preview and test local web apps (http://localhost:...) in the built-in browser with mcp__${SERVER_NAME}__browser_navigate, browser_snapshot, browser_click, browser_type, browser_screenshot and browser_console. ` +
        'If these tools are missing, the user has turned off command execution or the browser in Claude Bridge settings — tell them instead of falling back to the server.',
    );
    if (desktop) {
      parts.push(`Tools named mcp__${SERVER_NAME}__desktop_* control the user's Windows desktop (screenshots, mouse, keyboard, windows, apps). Take a screenshot or snapshot first to see the screen state before acting.`);
    }
  }
  if (mode === 'cowork') {
    parts.push("This is a Cowork session: the user wants you to get things done on their local Windows PC. Prefer the local PC tools over the server's tools unless the task is clearly about the server.");
  }
  return parts.join('\n');
}

class ChatManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./store').Store} o.store
   * @param {import('./ssh-manager').SshManager} o.ssh
   * @param {{ translate: Function }} o.translator
   * @param {() => { remotePort: number|null, token: string }} o.getMcpInfo
   * @param {string} o.attachmentsDir
   */
  constructor({ store, ssh, translator, getMcpInfo, attachmentsDir }) {
    super();
    this.store = store;
    this.ssh = ssh;
    this.translator = translator;
    this.getMcpInfo = getMcpInfo;
    this.attachmentsDir = attachmentsDir;
    this.cache = new Map();
    this.live = new Map();
    this._emitTimers = new Map();
    this._saveTimers = new Map();
    this._answering = new Set(); // 正在提交的权限回答（convId:requestId）
    this._mcpConfigKey = null;
    this.slashCommands = [];
    this.claudeInfo = null;
    this.memoryPaths = null;
    this.rateLimits = store.getMeta('rateLimits');
    this._probe = null;
    if (attachmentsDir) fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  // ======================= 对话 CRUD =======================

  list() {
    return this.store.listConversations();
  }

  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const conv = this.store.loadConversation(id);
    if (!conv) throw new Error('对话不存在');
    if (!conv.run) {
      // 上次异常退出时遗留的“运行中”状态
      for (const m of conv.messages || []) {
        if (m.role === 'assistant' && m.status === 'running') m.status = 'stopped';
        if (m.role === 'user' && ['pending', 'translating', 'queued'].includes(m.status)) m.status = 'error';
        for (const b of m.blocks || []) {
          if (b.zhStatus === 'pending') b.zhStatus = 'error';
          if (b.type === 'permission' && b.status === 'pending') b.status = 'cancelled';
        }
      }
    }
    this.cache.set(id, conv);
    return conv;
  }

  create({ workdir, mode, worktree } = {}) {
    const settings = this.store.getSettings();
    const now = Date.now();
    const conv = {
      id: uid(),
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      sessionId: null,
      sessionIds: [],
      mode: mode === 'cowork' ? 'cowork' : 'code',
      workdir: (workdir && String(workdir).trim()) || (mode === 'cowork' ? '~' : settings.claude.workdir || '~'),
      worktree: !!worktree,
      messages: [],
    };
    this.cache.set(conv.id, conv);
    this.store.saveConversation(conv);
    this._emitConv(conv);
    return conv;
  }

  rename(id, title) {
    const conv = this.get(id);
    conv.title = String(title || '').trim().slice(0, 100) || conv.title;
    this._saveNow(conv);
    this._emitConv(conv);
    // 同步给服务器上的 Claude 会话（失败无所谓）
    const live = this.live.get(id);
    if (live && live.run && !live.run.exited) this.control(id, { subtype: 'rename_session', title: conv.title, source: 'host' }, { ensure: false }).catch(() => {});
    return summarize(conv);
  }

  setPinned(id, pinned) {
    const conv = this.get(id);
    conv.pinned = !!pinned;
    this._saveNow(conv);
    this._emitConv(conv);
    return summarize(conv);
  }

  async setWorkdir(id, workdir) {
    const conv = this.get(id);
    const dir = String(workdir || '').trim();
    if (!dir) throw new Error('目录不能为空');
    if (this.isRunning(conv)) throw new Error('Claude 正在运行，请先停止再切换目录');
    if (dir !== conv.workdir) {
      await this._closeRun(this._live(conv));
      conv.workdir = dir;
      // Claude Code 的会话按工作目录存储，换目录后无法 --resume，只能开新会话
      conv.sessionId = null;
      conv.pendingFork = null;
      this._pushNotice(conv, `服务器工作目录已切换为 ${dir}，将开始新的 Claude 会话`);
      this._saveNow(conv);
      this._emitConv(conv);
    }
    return summarize(conv);
  }

  _pushNotice(conv, text) {
    const m = { id: uid(), role: 'notice', text, ts: Date.now() };
    conv.messages.push(m);
    this._emitMsg(conv, m);
    return m;
  }

  // ======================= 搜索 =======================

  search(query, limit = 60) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const snippet = (text, i) => {
      const s = Math.max(0, i - 30);
      return `${s > 0 ? '…' : ''}${text.slice(s, i + q.length + 50).replace(/\s+/g, ' ')}`;
    };
    for (const sum of this.store.listConversations()) {
      let conv;
      try {
        conv = this.cache.get(sum.id) || this.store.loadConversation(sum.id);
      } catch {
        continue;
      }
      if (!conv) continue;
      const title = String(conv.title || '');
      if (title.toLowerCase().includes(q)) out.push({ convId: conv.id, title, snippet: title, msgId: null, updatedAt: conv.updatedAt });
      for (const m of conv.messages || []) {
        const texts = m.role === 'user' ? [m.text, m.en] : (m.blocks || []).filter((b) => b.type === 'text').flatMap((b) => [b.zh, b.text]);
        for (const t of texts) {
          if (!t) continue;
          const i = t.toLowerCase().indexOf(q);
          if (i >= 0) {
            out.push({ convId: conv.id, title, snippet: snippet(t, i), msgId: m.id, updatedAt: conv.updatedAt });
            break;
          }
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  // ======================= 事件 =======================

  _emitConv(conv) {
    this.emit('event', { type: 'conversation', conv: summarize(conv) });
  }

  _emitMeta(conv) {
    const live = this.live.get(conv.id);
    this.emit('event', {
      type: 'conv-meta',
      convId: conv.id,
      meta: {
        context: conv.context || null,
        suggestion: conv.suggestion || null,
        sessionId: conv.sessionId || null,
        run: conv.run ? { id: conv.run.id, attached: !!(live && live.run && live.run.attached) } : null,
        running: this.isRunning(conv),
      },
    });
  }

  _emitMsg(conv, msg) {
    clearTimeout(this._emitTimers.get(msg.id));
    this._emitTimers.delete(msg.id);
    this.emit('event', { type: 'message', convId: conv.id, message: msg });
  }

  /** 流式增量较频繁，合并后再发给界面 */
  _emitMsgThrottled(conv, msg) {
    if (this._emitTimers.has(msg.id)) return;
    this._emitTimers.set(
      msg.id,
      setTimeout(() => {
        this._emitTimers.delete(msg.id);
        this.emit('event', { type: 'message', convId: conv.id, message: msg });
      }, 70),
    );
  }

  _emitReload(conv) {
    this.emit('event', { type: 'conversation-reload', convId: conv.id });
  }

  _updateRunState(conv) {
    const running = this.isRunning(conv);
    const live = this._live(conv);
    if (live.lastRunning !== running) {
      live.lastRunning = running;
      this.emit('event', { type: 'run-state', convId: conv.id, running });
    }
  }

  _touch(conv, bump = true) {
    if (bump) conv.updatedAt = Date.now();
    this._scheduleSave(conv);
  }

  _scheduleSave(conv) {
    if (this._saveTimers.has(conv.id)) return;
    this._saveTimers.set(conv.id, setTimeout(() => this._saveNow(conv), 600));
  }

  _saveNow(conv) {
    clearTimeout(this._saveTimers.get(conv.id));
    this._saveTimers.delete(conv.id);
    if (!this.cache.has(conv.id)) return; // 已删除
    try {
      this.store.saveConversation(conv);
    } catch (e) {
      console.error('保存对话失败', e);
    }
  }

  flushAll() {
    for (const conv of this.cache.values()) this._saveNow(conv);
  }

  runningIds() {
    const ids = [];
    for (const [id, live] of this.live) if (this.isRunning(live.conv)) ids.push(id);
    return ids;
  }

  // ======================= 运行状态 =======================

  _live(conv) {
    let live = this.live.get(conv.id);
    if (!live) {
      live = { conv, run: null, current: null, streamBlocks: {}, curMsgId: null, ctl: new Map(), ctlSeq: 0, sendChain: Promise.resolve(), starting: null, lastContext: null, lastRunning: false };
      if (conv.run && conv.run.currentMsgId) live.current = conv.messages.find((m) => m.id === conv.run.currentMsgId) || null;
      this.live.set(conv.id, live);
    }
    live.conv = conv;
    return live;
  }

  isRunning(conv) {
    const live = this.live.get(conv.id);
    if (live && live.current && live.current.status === 'running') return true;
    return (conv.messages || []).some((m) => m.role === 'user' && ['pending', 'translating', 'queued'].includes(m.status));
  }

  _setCurrent(live, msg) {
    live.current = msg;
    live.streamBlocks = {};
    if (live.conv.run) live.conv.run.currentMsgId = msg ? msg.id : null;
  }

  _newAssistant(live, forUser, index) {
    const msg = { id: uid(), role: 'assistant', blocks: [], status: 'running', ts: Date.now(), meta: null, error: null, notices: [], forUser: forUser || null };
    const msgs = live.conv.messages;
    if (index == null || index < 0 || index > msgs.length) msgs.push(msg);
    else msgs.splice(index, 0, msg);
    this._setCurrent(live, msg);
    return msg;
  }

  /** 当前没有进行中的回复时（例如重连后读到中途的事件）补一个 */
  _ensureAssistant(live) {
    if (live.current) return live.current;
    const msg = this._newAssistant(live, null);
    this._emitMsg(live.conv, msg);
    return msg;
  }

  /** 去掉一个没有任何内容的占位回复 */
  _dropAssistant(live, msg) {
    const i = live.conv.messages.indexOf(msg);
    if (i >= 0) live.conv.messages.splice(i, 1);
    if (live.current === msg) this._setCurrent(live, null);
    this._emitReload(live.conv);
  }

  _finishAssistant(live, status, msg = live.current) {
    const a = msg;
    if (!a) return;
    for (const b of a.blocks) if (b.type !== 'permission') b.final = true;
    if (a.status === 'running') a.status = status || (a.error ? 'error' : 'done');
    delete a.retry;
    delete a.statusText;
    if (live.current === a) this._setCurrent(live, null);
    this._emitMsg(live.conv, a);
  }

  // ======================= 服务器端运行 =======================

  async _ensureRemoteMcpConfig(settings) {
    if (!settings.mcp.enabled) return false;
    const info = this.getMcpInfo();
    if (!info.remotePort) return false;
    const key = `${this.ssh.connId}:${info.remotePort}:${info.token}`;
    if (this._mcpConfigKey === key) return true;
    const config = {
      mcpServers: {
        [SERVER_NAME]: {
          type: 'http',
          url: `http://127.0.0.1:${info.remotePort}/mcp`,
          headers: { Authorization: `Bearer ${info.token}` },
        },
      },
    };
    const file = mcpConfigRemotePath(settings.clientId);
    const script = `umask 077; mkdir -p "$HOME/.claude-bridge" && cat > ${file}`;
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { stdin: JSON.stringify(config, null, 2), timeoutMs: 20000 });
    if (r.code !== 0) throw new Error(`写入服务器 MCP 配置失败：${r.stderr.trim() || `exit ${r.code}`}`);
    this._mcpConfigKey = key;
    return true;
  }

  /** 当前隧道地址 + 令牌的指纹（不含令牌本身，可以存进对话记录） */
  _mcpFingerprint() {
    const info = this.getMcpInfo();
    if (!info.remotePort) return null;
    return `${info.remotePort}:${crypto.createHash('sha256').update(info.token).digest('hex').slice(0, 12)}`;
  }

  /**
   * claude 只在启动时读取 MCP 配置。重连后隧道端口或令牌变了，已在运行的 claude 就连不上本机：
   * 空闲的运行直接结束（下一条消息会用新配置续接同一会话），忙碌的运行提示用户。
   */
  async _checkStaleMcp(live) {
    const conv = live.conv;
    const run = live.run;
    if (!run || run.exited || !conv.run || !conv.run.mcp) return;
    const now = this._mcpFingerprint();
    if (!now || now === conv.run.mcp) return;
    if (!live.starting && !this.isRunning(conv)) {
      await this._closeRun(live);
      return;
    }
    if (!conv.run.mcpWarned) {
      conv.run.mcpWarned = true;
      this._pushNotice(conv, '本机连接地址已变化，这一轮暂时无法访问本机；这一轮结束后 Claude 会用新地址重新启动');
    }
  }

  /** 服务器登录用户是否为 root（每个 SSH 连接只查询一次；查询失败按非 root 处理） */
  async _serverIsRoot() {
    const connId = this.ssh.connId;
    if (this._rootCheck && this._rootCheck.connId === connId) return this._rootCheck.promise;
    const promise = this.ssh
      .exec('id -u', { timeoutMs: 10000 })
      .then((r) => r.code === 0 && r.stdout.trim() === '0')
      .catch(() => false);
    this._rootCheck = { connId, promise };
    return promise;
  }

  async _isGitRepo(workdir) {
    const script = `cd ${remotePathExpr(workdir)} 2>/dev/null && git rev-parse --is-inside-work-tree 2>/dev/null`;
    const r = await this.ssh.exec(`bash -lc ${shQuote(script)}`, { timeoutMs: 15000 }).catch(() => null);
    return !!(r && r.code === 0 && r.stdout.trim() === 'true');
  }

  _wireRun(live, run) {
    run.on('line', (obj, offset) => {
      try {
        this._onLine(live, run, obj, offset);
      } catch (e) {
        console.error('处理 Claude 事件失败', e);
      }
    });
    run.on('detached', () => {
      if (live.run !== run) return;
      this._emitMeta(live.conv);
    });
    run.on('gone', () => {
      if (live.run !== run) return;
      this._onRunExit(live, run, { code: -1, gone: true });
    });
  }

  async _ensureRun(live) {
    if (live.run && !live.run.exited) {
      if (!live.run.attached) await live.run.attach(live.conv.run ? live.conv.run.offset : 0);
      if (!live.run.exited) return live.run;
    }
    if (live.starting) return live.starting;
    if (!this.ssh.isConnected()) throw new Error('尚未连接服务器：请先点击左下角的连接。');
    live.starting = (async () => {
      const conv = live.conv;
      // 本程序重启后：先尝试接回服务器上仍在运行的进程
      if (!live.run && conv.run) {
        const old = new RemoteRun(this.ssh, conv.run.id);
        live.run = old;
        this._wireRun(live, old);
        const ok = await old.attach(conv.run.offset || 0);
        if (ok && !old.exited) return old;
      }
      const settings = this.store.getSettings();
      let mcpAvailable = false;
      try {
        mcpAvailable = await this._ensureRemoteMcpConfig(settings);
      } catch (e) {
        this._pushNotice(conv, `本机访问不可用：${e.message}`);
      }
      if (settings.mcp.enabled && !mcpAvailable && !conv._mcpWarned) {
        conv._mcpWarned = true;
        const st = this.ssh.getStatus();
        if (st.tunnelError) this._pushNotice(conv, `本机访问不可用：${st.tunnelError}`);
      }
      // root 用户下 Claude Code 拒绝 bypassPermissions（直接以 code 1 退出），改用服务器默认模式
      if (settings.claude.permissionMode === 'bypassPermissions' && (await this._serverIsRoot())) {
        settings.claude.permissionMode = '';
        if (!conv._bypassWarned) {
          conv._bypassWarned = true;
          this._pushNotice(conv, '服务器以 root 用户运行，Claude Code 不允许“跳过权限确认”，本次改用默认权限模式');
        }
      }
      const fork = conv.pendingFork || null;
      const sessionId = fork && fork.fresh ? null : conv.sessionId;
      let worktree = !sessionId && conv.worktree ? `cb-${conv.id.slice(0, 8)}` : null;
      // 工作目录不是 git 仓库时 --worktree 会让 claude 直接退出
      if (worktree && !(await this._isGitRepo(conv.workdir))) {
        worktree = null;
        this._pushNotice(conv, '工作目录不是 git 仓库，无法使用 worktree，已直接在工作目录中运行');
      }
      const runId = uid();
      const run = await RemoteRun.launch(this.ssh, {
        runId,
        settings,
        workdir: conv.workdir,
        sessionId,
        resumeAt: fork ? fork.resumeAt : null,
        fork: !!(fork && sessionId),
        worktree,
        mcpAvailable,
        systemPrompt: settings.claude.appendSystemPrompt ? buildSystemPrompt(settings, mcpAvailable, conv.mode, settings.mcp.desktop) : '',
      });
      conv.pendingFork = null;
      conv.run = { id: runId, offset: 0, pending: {}, startedAt: Date.now(), currentMsgId: live.current ? live.current.id : null, resumed: !!sessionId, mcp: mcpAvailable ? this._mcpFingerprint() : null };
      live.run = run;
      this._wireRun(live, run);
      await run.attach(0);
      this._saveNow(conv);
      this._emitMeta(conv);
      return run;
    })();
    try {
      return await live.starting;
    } finally {
      live.starting = null;
    }
  }

  /** 正常关闭当前运行（关闭输入，让 claude 自然退出） */
  async _closeRun(live) {
    const run = live.run;
    if (!run || run.exited) return;
    await run.closeInput();
    for (let i = 0; i < 50 && !run.exited && run.attached; i++) await sleep(200);
    if (!run.exited) {
      await run.kill();
      run.detach();
      await run.remove();
      if (live.run === run) {
        live.run = null;
        live.conv.run = null;
      }
    }
  }

  /** 连上服务器后，接回所有仍在运行的任务 */
  async reattachAll() {
    cleanupOldRuns(this.ssh).catch(() => {});
    for (const sum of this.store.listConversations()) {
      if (!sum.activeRun) continue;
      let conv;
      try {
        conv = this.get(sum.id);
      } catch {
        continue;
      }
      if (!conv.run) continue;
      const live = this._live(conv);
      if (live.run && live.run.attached) continue;
      if (!live.run || live.run.runId !== conv.run.id) {
        live.run = new RemoteRun(this.ssh, conv.run.id);
        this._wireRun(live, live.run);
      }
      try {
        await live.run.attach(conv.run.offset || 0);
      } catch (e) {
        console.error('重新接入运行失败', e);
      }
      this._emitMeta(conv);
      this._updateRunState(conv);
    }
    // 已接上（或本来就接着）的运行：检查隧道地址是否变了
    await sleep(1500);
    for (const live of this.live.values()) await this._checkStaleMcp(live).catch(() => {});
  }

  _onRunExit(live, run, { code, gone }) {
    if (live.run !== run) return;
    const conv = live.conv;
    // 同步部分：清理属于这个运行的状态（之后可能马上启动新的运行）
    live.run = null;
    if (conv.run && conv.run.id === run.runId) conv.run = null;
    for (const w of live.ctl.values()) w.reject(new Error('Claude 进程已退出'));
    live.ctl.clear();
    for (const m of conv.messages) {
      for (const b of m.blocks || []) {
        if (b.type === 'permission' && b.status === 'pending') {
          b.status = 'cancelled';
          this._emitMsg(conv, m);
        }
      }
    }
    const current = live.current && live.current.status === 'running' ? live.current : null;
    if (current) this._setCurrent(live, null);
    const unprocessed = conv.messages.filter((m) => m.role === 'user' && m.status === 'queued');
    run.detach();
    const finish = async () => {
      // 先读 stderr 再删除运行目录，否则真正的出错原因会丢失
      const stderr = gone ? '' : await run.stderrTail(30);
      run.remove().catch(() => {});
      const lostSession = /no conversation found|session.*not found/i.test(stderr);
      if (lostSession && conv.sessionId) {
        conv.sessionId = null;
        this._pushNotice(conv, '服务器上找不到原会话记录，已开始新会话（之前的上下文不会保留）');
      }
      // 空闲退出与写入恰好同时发生、或会话失效：用新的运行重新发送还没被处理的消息
      const resend = unprocessed.length && (code === 0 || lostSession);
      if (current) {
        if (!current.blocks.length && resend && unprocessed.some((m) => m.id === current.forUser)) {
          const idx = conv.messages.indexOf(current);
          if (idx >= 0) conv.messages.splice(idx, 1);
          this._emitReload(conv);
        } else {
          if (code !== 0 && !current.error) {
            const tail = stderr.split('\n').slice(-12).join('\n');
            current.error = `Claude 进程已退出（code ${code}）${tail ? `\n\n${tail}` : ''}`;
            if (/command not found|No such file or directory/i.test(stderr)) current.error += '\n\n服务器上找不到 Claude 命令或工作目录，请在 设置 → Claude 中点击“自动检测”或填写完整路径。';
          }
          this._finishAssistant(live, code === 0 ? 'done' : current.stopRequested ? 'stopped' : 'error', current);
        }
      }
      if (resend) {
        for (const m of unprocessed) m.status = 'pending';
        for (const m of unprocessed) live.sendChain = live.sendChain.then(() => this._deliver(live, m, null)).catch(() => {});
      } else {
        for (const m of unprocessed) {
          m.status = 'error';
          m.error = 'Claude 进程已退出，这条消息没有被处理';
          this._emitMsg(conv, m);
        }
      }
      this._touch(conv);
      this._emitMeta(conv);
      this._updateRunState(conv);
    };
    finish().catch((e) => console.error(e));
  }

  // ======================= 发送消息 =======================

  _saveImage(img) {
    let buf;
    let mediaType;
    let name = img.name || '';
    if (img.dataUrl) {
      const m = String(img.dataUrl).match(/^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/);
      if (!m) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
      mediaType = m[1];
      buf = Buffer.from(m[3], 'base64');
    } else if (img.path) {
      const ext = path.extname(img.path).slice(1).toLowerCase();
      mediaType = IMAGE_TYPES[ext];
      if (!mediaType) throw new Error(`不支持的图片格式：${img.path}`);
      buf = fs.readFileSync(img.path);
      name = name || path.basename(img.path);
    } else if (img.file) {
      return img; // 已保存（重新生成时复用）
    } else {
      throw new Error('无效的图片');
    }
    if (buf.length > 5 * 1024 * 1024) throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)} MB，最大 5 MB）`);
    const file = `${uid()}.${mediaType.split('/')[1].replace('jpeg', 'jpg')}`;
    fs.writeFileSync(path.join(this.attachmentsDir, file), buf);
    return { file, mediaType, name, size: buf.length };
  }

  _imageBlock(img) {
    const data = fs.readFileSync(path.join(this.attachmentsDir, path.basename(img.file))).toString('base64');
    return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data } };
  }

  /**
   * 发送消息。运行中也可以发送：默认排队，priority='now' 会打断当前回复立即处理。
   */
  async send(convId, text, { images = [], priority, slotId } = {}) {
    const content = String(text || '').trim();
    if (!content && !images.length) throw new Error('消息不能为空');
    const conv = this.get(convId);
    const live = this._live(conv);
    const saved = images.map((img) => this._saveImage(img));
    const busy = this.isRunning(conv);
    const userMsg = { id: uid(), role: 'user', text: content, images: saved, en: null, status: 'pending', ts: Date.now() };
    userMsg.wire = userMsg.id;
    if (slotId) userMsg.slotId = slotId;
    if (!conv.messages.some((m) => m.role === 'user')) conv.title = makeTitle(content || '图片');
    conv.messages.push(userMsg);
    conv.suggestion = null;
    if (!busy) {
      const a = this._newAssistant(live, userMsg.id);
      this._emitMsg(conv, userMsg);
      this._emitMsg(conv, a);
    } else {
      this._emitMsg(conv, userMsg);
    }
    this._touch(conv);
    this._emitConv(conv);
    this._emitMeta(conv);
    this._updateRunState(conv);
    live.sendChain = live.sendChain
      .then(() => this._deliver(live, userMsg, priority))
      .catch((e) => {
        userMsg.status = 'error';
        userMsg.error = e.message;
        this._emitMsg(conv, userMsg);
        if (live.current && live.current.forUser === userMsg.id) {
          live.current.error = e.message;
          this._finishAssistant(live, 'error');
        }
        this._updateRunState(conv);
      });
    return { convId: conv.id, msgId: userMsg.id };
  }

  async _deliver(live, userMsg, priority) {
    const conv = live.conv;
    if (userMsg.status === 'cancelled') return;
    const settings = this.store.getSettings();
    const tr = settings.translation;
    let prompt = userMsg.text;
    // 斜杠命令（/compact、/review 等）原样发送，不翻译
    if (userMsg.en) prompt = userMsg.en;
    else if (tr.enabled && tr.translateInput && hasCJK(prompt) && !prompt.startsWith('/')) {
      userMsg.status = 'translating';
      this._emitMsg(conv, userMsg);
      try {
        userMsg.en = await this.translator.translate(prompt, 'zh', 'en', tr);
        prompt = userMsg.en;
      } catch (e) {
        userMsg.translateError = e.message;
      }
    }
    if (userMsg.status === 'cancelled') return;
    const run = await this._ensureRun(live);
    const content = [];
    if (prompt) content.push({ type: 'text', text: prompt });
    for (const img of userMsg.images || []) content.push(this._imageBlock(img));
    const line = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid: userMsg.wire };
    if (priority) line.priority = priority;
    userMsg.status = 'queued';
    await run.write(line);
    this._emitMsg(conv, userMsg);
    this._touch(conv);
  }

  /** 停止：打断当前回复，并取消尚未开始处理的排队消息 */
  async stop(convId) {
    const conv = this.get(convId);
    const live = this._live(conv);
    const queued = conv.messages.filter((m) => m.role === 'user' && ['pending', 'translating', 'queued'].includes(m.status));
    for (const m of queued) {
      if (m.status === 'queued' && live.run && !live.run.exited) {
        this.control(convId, { subtype: 'cancel_async_message', message_uuid: m.wire }, { ensure: false }).catch(() => {});
      }
      // 正在处理的那一条不算排队
      if (live.current && live.current.forUser === m.id && m.status === 'queued' && live.current.blocks.length) continue;
      m.status = 'cancelled';
      this._emitMsg(conv, m);
    }
    if (live.current && live.current.status === 'running') {
      live.current.stopRequested = true;
      if (live.run && !live.run.exited) {
        await this.control(convId, { subtype: 'interrupt', reason: 'interrupt' }, { ensure: false, timeoutMs: 10000 }).catch(() => {});
      }
      // 还没开始（翻译中 / 未连接）就直接结束
      if (live.current && live.current.status === 'running' && !(live.run && !live.run.exited)) this._finishAssistant(live, 'stopped');
    }
    this._touch(conv);
    this._updateRunState(conv);
  }

  async cancelQueued(convId, msgId) {
    const conv = this.get(convId);
    const live = this._live(conv);
    const m = conv.messages.find((x) => x.id === msgId && x.role === 'user');
    if (!m || !['pending', 'translating', 'queued'].includes(m.status)) return;
    if (m.status === 'queued' && live.run && !live.run.exited) await this.control(convId, { subtype: 'cancel_async_message', message_uuid: m.wire }, { ensure: false }).catch(() => {});
    m.status = 'cancelled';
    this._emitMsg(conv, m);
    this._touch(conv);
    this._updateRunState(conv);
  }

  /** 把一条排队中的消息改为立即发送（打断当前回复） */
  async sendNow(convId, msgId) {
    const conv = this.get(convId);
    const live = this._live(conv);
    const m = conv.messages.find((x) => x.id === msgId && x.role === 'user');
    if (!m || m.status !== 'queued') return;
    if (live.run && !live.run.exited) await this.control(convId, { subtype: 'cancel_async_message', message_uuid: m.wire }, { ensure: false }).catch(() => {});
    // 换一个 uuid 重新发送，避免被当作重复消息
    m.wire = uid();
    m.status = 'pending';
    // 移到当前回复之后，界面顺序与实际处理顺序一致
    const i = conv.messages.indexOf(m);
    conv.messages.splice(i, 1);
    const ci = live.current ? conv.messages.indexOf(live.current) : -1;
    conv.messages.splice(ci >= 0 ? ci + 1 : conv.messages.length, 0, m);
    this._emitReload(conv);
    live.sendChain = live.sendChain.then(() => this._deliver(live, m, 'now')).catch(() => {});
  }

  // ======================= 控制请求 =======================

  async control(convId, request, { ensure = true, timeoutMs = 30000 } = {}) {
    const conv = this.get(convId);
    const live = this._live(conv);
    const run = ensure ? await this._ensureRun(live) : live.run;
    if (!run || run.exited) throw new Error('Claude 当前没有在服务器上运行');
    const id = `cb_${++live.ctlSeq}_${Date.now().toString(36)}`;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        live.ctl.delete(id);
        reject(new Error('Claude 没有响应（超时）'));
      }, timeoutMs);
      live.ctl.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    await run.write({ type: 'control_request', request_id: id, request });
    return p;
  }

  /** 设置变化时，对正在运行的会话即时生效（模型、权限模式、思考强度） */
  applyLiveSettings(prev, next) {
    const changes = [];
    if (prev.claude.model !== next.claude.model) changes.push({ subtype: 'set_model', model: next.claude.model || 'default' });
    if (prev.claude.permissionMode !== next.claude.permissionMode && next.claude.permissionMode) changes.push({ subtype: 'set_permission_mode', mode: next.claude.permissionMode });
    if (prev.claude.effort !== next.claude.effort) changes.push({ subtype: 'apply_flag_settings', settings: { effortLevel: next.claude.effort || null } });
    if (!changes.length) return;
    for (const [id, live] of this.live) {
      if (!live.run || live.run.exited) continue;
      for (const req of changes) this.control(id, req, { ensure: false }).catch(() => {});
    }
  }

  async contextUsage(convId) {
    const conv = this.get(convId);
    const r = await this.control(convId, { subtype: 'get_context_usage', detail: 'summary' }, { ensure: false });
    conv.context = {
      totalTokens: r.totalTokens || 0,
      maxTokens: r.maxTokens || r.rawMaxTokens || 0,
      percentage: r.percentage || 0,
      categories: (r.categories || []).map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
      at: Date.now(),
    };
    this._touch(conv, false);
    this._emitMeta(conv);
    return conv.context;
  }

  // ======================= 解析 stream-json =======================

  _onLine(live, run, ev, offset) {
    if (live.run !== run) return;
    const conv = live.conv;
    if (conv.run) conv.run.offset = offset;
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'bridge_exit':
        this._onRunExit(live, run, { code: ev.code });
        return;
      case 'control_response': {
        const r = ev.response || {};
        const w = live.ctl.get(r.request_id);
        if (w) {
          live.ctl.delete(r.request_id);
          if (r.subtype === 'error') w.reject(new Error(r.error || 'Claude 返回错误'));
          else w.resolve(r.response || {});
        }
        return;
      }
      case 'control_request':
        if (ev.request && ev.request.subtype === 'can_use_tool') this._onPermissionRequest(live, ev);
        else if (ev.request_id) {
          // 不支持的请求（如对话框）：明确回复错误，避免 Claude 一直等待
          run.write({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: 'unsupported by Claude Bridge' } }).catch(() => {});
        }
        break;
      case 'control_cancel_request':
        this._onPermissionCancel(live, ev.request_id);
        break;
      case 'system':
        this._onSystem(live, ev);
        break;
      case 'stream_event':
        if (!ev.parent_tool_use_id) this._handleStreamEvent(live, ev.event);
        break;
      case 'assistant':
        this._handleAssistant(live, ev);
        break;
      case 'user':
        if (ev.isReplay) this._onReplay(live, ev);
        else this._handleUser(live, ev);
        break;
      case 'result':
        this._handleResult(live, ev);
        // 稍等片刻：接回时会一次性读到积压的多行，等它们处理完再判断是否空闲
        if (conv.run && conv.run.mcpWarned) setTimeout(() => this._checkStaleMcp(live).catch(() => {}), 1500);
        break;
      case 'prompt_suggestion':
        this._onSuggestion(conv, ev.suggestion);
        break;
      case 'command_lifecycle':
        this._onLifecycle(live, ev);
        break;
      case 'rate_limit_event':
        if (ev.rate_limit_info) {
          this.rateLimits = { ...ev.rate_limit_info, at: Date.now() };
          this.store.setMeta('rateLimits', this.rateLimits);
          this.emit('event', { type: 'rate-limits', info: this.rateLimits });
        }
        break;
      default:
        break;
    }
    this._touch(conv, false);
    this._updateRunState(conv);
  }

  _onSystem(live, ev) {
    const conv = live.conv;
    if (ev.parent_tool_use_id) return;
    switch (ev.subtype) {
      case 'init': {
        if (ev.session_id) {
          conv.sessionId = ev.session_id;
          this._rememberSession(conv, ev.session_id);
        }
        if (ev.cwd) conv.actualCwd = ev.cwd;
        if (ev.memory_paths) this.memoryPaths = ev.memory_paths;
        if (Array.isArray(ev.slash_commands)) {
          this.slashCommands = ev.slash_commands.filter((c) => typeof c === 'string');
          this.emit('event', { type: 'slash-commands', commands: this.slashCommands });
        }
        const a = live.current;
        if (a) {
          a.model = ev.model || a.model || null;
          const srv = (ev.mcp_servers || []).find((s) => s.name === SERVER_NAME);
          if (srv) a.mcpStatus = srv.status;
          if (srv && srv.status !== 'connected' && srv.status !== 'pending' && !a._mcpNoticed) {
            a._mcpNoticed = true;
            a.notices.push(`服务器上的 Claude 未能连接本机工具（状态：${srv.status}）`);
          }
          this._emitMsg(conv, a);
        }
        this._emitConv(conv);
        break;
      }
      case 'compact_boundary': {
        const md = ev.compact_metadata || {};
        const a = live.current || null;
        const text = `上下文已${md.trigger === 'auto' ? '自动' : ''}压缩${md.pre_tokens ? `（${Math.round(md.pre_tokens / 1000)}k → ${md.post_tokens ? `${Math.round(md.post_tokens / 1000)}k` : '?'} tokens）` : ''}`;
        if (a) {
          a.notices.push(text);
          this._emitMsg(conv, a);
        } else this._pushNotice(conv, text);
        break;
      }
      case 'api_retry':
        if (live.current) {
          live.current.retry = { attempt: ev.attempt, max: ev.max_retries, delayMs: ev.retry_delay_ms, status: ev.error_status };
          this._emitMsg(conv, live.current);
        }
        break;
      case 'status':
        if (live.current) {
          live.current.statusText = ev.status === 'compacting' ? '正在压缩上下文…' : null;
          this._emitMsgThrottled(conv, live.current);
        }
        break;
      case 'notification':
      case 'informational':
        if (live.current && (ev.text || ev.content)) {
          live.current.notices.push(String(ev.text || ev.content).slice(0, 400));
          this._emitMsg(conv, live.current);
        }
        break;
      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        this._onTaskEvent(live, ev);
        break;
      default:
        break;
    }
  }

  _findToolBlock(conv, pred) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role !== 'assistant') continue;
      const b = (m.blocks || []).find((x) => x.type === 'tool_use' && pred(x));
      if (b) return { msg: m, block: b };
    }
    return null;
  }

  _onTaskEvent(live, ev) {
    const conv = live.conv;
    const found = ev.tool_use_id ? this._findToolBlock(conv, (b) => b.id === ev.tool_use_id) : this._findToolBlock(conv, (b) => b.task && b.task.id === ev.task_id);
    if (!found) return;
    const t = found.block.task || { id: ev.task_id };
    if (ev.subtype === 'task_started') Object.assign(t, { status: 'running', description: ev.description, subagentType: ev.subagent_type, background: !!ev.is_backgrounded });
    else if (ev.subtype === 'task_progress') Object.assign(t, { summary: ev.summary || t.summary, lastTool: ev.last_tool_name, usage: ev.usage });
    else if (ev.subtype === 'task_updated' && ev.patch) Object.assign(t, { status: ev.patch.status || t.status, error: ev.patch.error || t.error });
    else if (ev.subtype === 'task_notification') Object.assign(t, { status: ev.status, summary: ev.summary || t.summary });
    found.block.task = t;
    this._emitMsgThrottled(conv, found.msg);
  }

  _onReplay(live, ev) {
    const conv = live.conv;
    const msg = conv.messages.find((m) => m.role === 'user' && (m.wire === ev.uuid || m.id === ev.uuid));
    if (!msg) {
      // 本地命令（/model 等）的输出
      const c = ev.message && ev.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      const m = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (m && m[1].trim()) {
        if (live.current) {
          live.current.notices.push(m[1].trim().slice(0, 500));
          this._emitMsg(conv, live.current);
        } else this._pushNotice(conv, m[1].trim().slice(0, 500));
      }
      return;
    }
    msg.status = 'sent';
    this._emitMsg(conv, msg);
    if (live.current && live.current.forUser === msg.id) return; // 已有占位回复
    // 新的一轮开始：上一轮被“立即发送”打断。已有内容的标记为停止；还没有内容的占位直接去掉
    // （Claude Code 会把被打断的消息并入新一轮一起回答，留着只是一个空的“已停止”）
    if (live.current && live.current.status === 'running') {
      const cur = live.current;
      if (!cur.blocks.length && !cur.error && !cur.notices.length) this._dropAssistant(live, cur);
      else this._finishAssistant(live, 'stopped');
    }
    const idx = conv.messages.indexOf(msg);
    // 去掉还没有内容的旧占位（例如重试）
    const a = this._newAssistant(live, msg.id, idx + 1);
    this._emitReload(conv);
    return a;
  }

  /**
   * 排队消息的生命周期。消息刚发出就被“立即发送”插队时，Claude Code 不回显它，
   * 而是标记为 cancelled 并把它并入下一轮一起回答：这时把它当作已发送，否则会一直显示“排队中”
   */
  _onLifecycle(live, ev) {
    if (ev.state !== 'cancelled' || !ev.command_uuid) return;
    const conv = live.conv;
    const msg = conv.messages.find((m) => m.role === 'user' && m.wire === ev.command_uuid);
    if (!msg || !['pending', 'queued'].includes(msg.status)) return;
    msg.status = 'sent';
    this._emitMsg(conv, msg);
    this._touch(conv, false);
    this._updateRunState(conv);
  }

  _handleStreamEvent(live, e) {
    if (!e || typeof e !== 'object') return;
    const conv = live.conv;
    if (e.type === 'message_start') {
      live.curMsgId = (e.message && e.message.id) || uid();
      live.streamBlocks = {};
      return;
    }
    const assistant = this._ensureAssistant(live);
    if (e.type === 'content_block_start') {
      const cb = e.content_block || {};
      let block = null;
      if (cb.type === 'text') block = { key: uid(), type: 'text', text: cb.text || '', final: false, apiMsgId: live.curMsgId };
      else if (cb.type === 'thinking') block = { key: uid(), type: 'thinking', text: cb.thinking || '', final: false, apiMsgId: live.curMsgId };
      else if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
        block = { key: uid(), type: 'tool_use', id: cb.id, name: cb.name, input: null, partialJson: '', final: false };
      }
      if (!block) return;
      delete assistant.retry;
      live.streamBlocks[e.index] = block;
      assistant.blocks.push(block);
      this._emitMsgThrottled(conv, assistant);
      return;
    }
    if (e.type === 'content_block_delta') {
      const b = live.streamBlocks[e.index];
      const d = e.delta || {};
      if (!b || b.final) return;
      if (d.type === 'text_delta') b.text += d.text || '';
      else if (d.type === 'thinking_delta') b.text += d.thinking || '';
      else if (d.type === 'input_json_delta') b.partialJson = (b.partialJson || '') + (d.partial_json || '');
      else return;
      this._emitMsgThrottled(conv, assistant);
    }
  }

  _findOpenBlock(assistant, type, apiMsgId) {
    const open = assistant.blocks.filter((b) => b.type === type && !b.final);
    return open.find((b) => b.apiMsgId === apiMsgId) || open[0] || null;
  }

  _appendSub(conv, ev) {
    const found = this._findToolBlock(conv, (b) => b.id === ev.parent_tool_use_id);
    if (!found) return;
    const sub = found.block.sub || (found.block.sub = []);
    const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const c of content) {
      if (sub.length >= SUB_MAX) break;
      if (ev.type === 'assistant' && c.type === 'text' && c.text) sub.push({ type: 'text', text: truncate(c.text, 2000) });
      else if (ev.type === 'assistant' && c.type === 'tool_use') sub.push({ type: 'tool', id: c.id, name: c.name, input: c.input });
      else if (ev.type === 'user' && c.type === 'tool_result') {
        const t = sub.find((s) => s.type === 'tool' && s.id === c.tool_use_id);
        if (t) {
          t.done = true;
          t.isError = !!c.is_error;
        }
      }
    }
    this._emitMsgThrottled(conv, found.msg);
  }

  _handleAssistant(live, ev) {
    const conv = live.conv;
    if (ev.parent_tool_use_id) {
      this._appendSub(conv, ev);
      return;
    }
    const m = ev.message || {};
    const content = Array.isArray(m.content) ? m.content : [];
    const assistant = this._ensureAssistant(live);
    if (ev.is_api_error_message || ev.error) {
      // 例如“未登录”“额度不足”，result 事件会带上同样的错误
      live.apiError = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || String(ev.error);
      return;
    }
    if (ev.uuid) assistant.lastUuid = ev.uuid;
    if (m.model && m.model !== '<synthetic>') assistant.model = m.model;
    // 每次 API 调用的输入量 ≈ 当前上下文大小
    if (m.usage && m.model !== '<synthetic>') {
      const u = m.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > 0) live.lastContext = ctx;
    }
    delete assistant.retry;
    for (const c of content) {
      if (c.type === 'text') {
        let b = this._findOpenBlock(assistant, 'text', m.id);
        if (!b) {
          b = { key: uid(), type: 'text', apiMsgId: m.id };
          assistant.blocks.push(b);
        }
        b.text = c.text || '';
        b.final = true;
        this._queueTranslate(conv, assistant, b);
      } else if (c.type === 'thinking' || c.type === 'redacted_thinking') {
        let b = this._findOpenBlock(assistant, 'thinking', m.id);
        if (!b) {
          b = { key: uid(), type: 'thinking', apiMsgId: m.id };
          assistant.blocks.push(b);
        }
        b.text = c.thinking || (c.type === 'redacted_thinking' ? '（已隐藏）' : '');
        b.final = true;
      } else if (c.type === 'tool_use' || c.type === 'server_tool_use' || c.type === 'mcp_tool_use') {
        let b = assistant.blocks.find((x) => x.type === 'tool_use' && x.id === c.id);
        if (!b) {
          b = { key: uid(), type: 'tool_use', id: c.id };
          assistant.blocks.push(b);
        }
        b.name = c.name;
        b.input = c.input || {};
        b.final = true;
        delete b.partialJson;
      } else if (typeof c.type === 'string' && c.type.endsWith('_tool_result') && c.tool_use_id) {
        const b = assistant.blocks.find((x) => x.type === 'tool_use' && x.id === c.tool_use_id);
        if (b) {
          b.result = truncate(stringifyToolResult(c.content), TOOL_RESULT_MAX);
          b.done = true;
        }
      }
    }
    this._emitMsg(conv, assistant);
  }

  _handleUser(live, ev) {
    const conv = live.conv;
    if (ev.parent_tool_use_id) {
      this._appendSub(conv, ev);
      return;
    }
    const content = ev.message && ev.message.content;
    if (!Array.isArray(content)) return;
    const assistant = live.current;
    if (assistant && ev.uuid) assistant.lastUuid = ev.uuid;
    for (const c of content) {
      if (!c || c.type !== 'tool_result') continue;
      const found = assistant ? { msg: assistant, block: assistant.blocks.find((x) => x.type === 'tool_use' && x.id === c.tool_use_id) } : this._findToolBlock(conv, (x) => x.id === c.tool_use_id);
      if (!found || !found.block) continue;
      const b = found.block;
      b.result = truncate(stringifyToolResult(c.content), TOOL_RESULT_MAX);
      b.isError = !!c.is_error;
      b.done = true;
      const s = trimStructured(ev.tool_use_result);
      if (s) b.structured = s;
      this._emitMsg(conv, found.msg);
    }
  }

  _handleResult(live, ev) {
    const conv = live.conv;
    if (ev.session_id) {
      conv.sessionId = ev.session_id;
      this._rememberSession(conv, ev.session_id);
    }
    const assistant = live.current;
    if (!assistant) return; // 本地命令等
    const aborted = ev.terminal_reason === 'aborted_streaming';
    const empty = !assistant.blocks.length && !assistant.error && !String(ev.result || '').trim();
    if (empty && !assistant.stopRequested && (aborted || ev.subtype === 'error_during_execution')) {
      // 占位回复对应的消息还没开始处理：这个结果属于之前被停止 / 打断的那一轮，忽略
      const forMsg = assistant.forUser && conv.messages.find((m) => m.id === assistant.forUser);
      if (forMsg && ['pending', 'translating', 'queued'].includes(forMsg.status)) return;
      // 刚开始就被“立即发送”打断、没有任何内容的一轮：去掉占位，新一轮会一起回答
      if (aborted) {
        this._dropAssistant(live, assistant);
        this._touch(conv);
        return;
      }
    }
    const u = ev.usage || {};
    const models = {};
    const modelsIO = {}; // 每个模型的输入（含缓存）/ 输出 token，首页“模型”统计用
    let contextWindow = null;
    for (const [name, mu] of Object.entries(ev.modelUsage || {})) {
      if (!mu || typeof mu !== 'object') continue;
      const input = (mu.inputTokens || 0) + (mu.cacheReadInputTokens || 0) + (mu.cacheCreationInputTokens || 0);
      models[name] = input + (mu.outputTokens || 0);
      modelsIO[name] = { in: input, out: mu.outputTokens || 0 };
      if (mu.contextWindow && (name === assistant.model || !contextWindow)) contextWindow = mu.contextWindow;
    }
    assistant.meta = {
      costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
      durationMs: ev.duration_ms || null,
      turns: ev.num_turns || null,
      denials: Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0,
      tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      models,
      modelsIO,
      contextTokens: live.lastContext || null,
      contextWindow,
    };
    // 被停止或被“立即发送”打断（此时 subtype 仍为 success）
    const interrupted = aborted || (ev.subtype === 'error_during_execution' && (assistant.stopRequested || !ev.result));
    if (interrupted || assistant.stopRequested) {
      assistant.status = 'stopped';
    } else if (ev.is_error) {
      assistant.error = String(ev.result || live.apiError || ev.subtype || 'Claude 返回错误');
      if (/not logged in|\/login/i.test(assistant.error)) {
        assistant.error += '\n\n服务器上的 Claude Code 尚未登录：点击左下角账号菜单里的“登录服务器上的 Claude”，在终端中完成登录。';
      }
    } else if (ev.result && !assistant.blocks.some((b) => b.type === 'text')) {
      const b = { key: uid(), type: 'text', text: String(ev.result), final: true };
      assistant.blocks.push(b);
      this._queueTranslate(conv, assistant, b);
    }
    if (assistant.meta.denials && !assistant.stopRequested) assistant.notices.push(`有 ${assistant.meta.denials} 次工具调用因权限被拒绝`);
    live.apiError = null;
    this._finishAssistant(live);
    this._touch(conv);
    this._emitConv(conv);
    this.emit('notify', { kind: 'done', convId: conv.id, title: conv.title, body: assistant.error ? 'Claude 运行出错' : 'Claude 已完成回复' });
    // 刷新上下文占用
    setTimeout(() => this.contextUsage(conv.id).catch(() => {}), 300);
  }

  _onSuggestion(conv, text) {
    if (!text || typeof text !== 'string') return;
    conv.suggestion = { text, zh: null };
    this._emitMeta(conv);
    const tr = this.store.getSettings().translation;
    if (tr.enabled && tr.translateOutput && needsZhTranslation(text)) {
      this.translator
        .translate(text, 'en', 'zh', tr)
        .then((zh) => {
          if (conv.suggestion && conv.suggestion.text === text) {
            conv.suggestion.zh = zh;
            this._emitMeta(conv);
          }
        })
        .catch(() => {});
    }
  }

  // ======================= 权限 / 提问 / 计划审批 =======================

  _onPermissionRequest(live, ev) {
    const conv = live.conv;
    const req = ev.request || {};
    const msg = this._ensureAssistant(live);
    if (msg.blocks.some((b) => b.type === 'permission' && b.requestId === ev.request_id)) return;
    const kind = req.tool_name === 'AskUserQuestion' ? 'question' : req.tool_name === 'ExitPlanMode' ? 'plan' : 'tool';
    const block = {
      key: uid(),
      type: 'permission',
      kind,
      requestId: ev.request_id,
      toolName: req.tool_name,
      displayName: req.display_name || req.tool_name,
      input: req.input || {},
      description: req.description || '',
      suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [],
      blockedPath: req.blocked_path || null,
      decisionReason: req.decision_reason ? String(req.decision_reason).replace(/\x1b\[[0-9;]*m/g, '') : null,
      toolUseId: req.tool_use_id || null,
      status: 'pending',
      ts: Date.now(),
    };
    msg.blocks.push(block);
    if (conv.run) conv.run.pending[ev.request_id] = { msgId: msg.id, blockKey: block.key };
    this._emitMsg(conv, msg);
    this._touch(conv, false);
    this.emit('notify', { kind: 'permission', convId: conv.id, title: conv.title, body: kind === 'question' ? 'Claude 有问题想问你' : kind === 'plan' ? 'Claude 的计划等待你批准' : `Claude 请求使用 ${block.displayName}` });
    const tr = this.store.getSettings().translation;
    const translateOn = tr.enabled && tr.translateOutput;
    if (kind === 'plan') {
      const fill = (plan) => {
        if (plan && !block.plan) block.plan = plan;
        if (block.plan && translateOn && needsZhTranslation(block.plan)) {
          this.translator.translate(block.plan, 'en', 'zh', tr).then((zh) => {
            block.planZh = zh;
            this._emitMsg(conv, msg);
          }).catch(() => {});
        }
        this._emitMsg(conv, msg);
      };
      if (typeof block.input.plan === 'string' && block.input.plan) fill(block.input.plan);
      else this.control(conv.id, { subtype: 'get_plan' }, { ensure: false }).then((r) => fill(r && (r.plan || r.content || r.text))).catch(() => {});
    } else if (kind === 'question' && translateOn) {
      const qs = Array.isArray(block.input.questions) ? block.input.questions : [];
      const parts = [];
      qs.forEach((q, i) => {
        parts.push(`[q${i}] ${q.question || ''}`);
        (q.options || []).forEach((o, j) => parts.push(`[q${i}o${j}] ${o.label || ''} — ${o.description || ''}`));
      });
      if (parts.length) {
        this.translator.translate(parts.join('\n'), 'en', 'zh', tr).then((zh) => {
          const map = {};
          for (const line of zh.split('\n')) {
            const mm = line.match(/^\s*\[(q\d+(?:o\d+)?)\]\s*(.+)$/);
            if (mm) map[mm[1]] = mm[2].trim();
          }
          block.zh = map;
          this._emitMsg(conv, msg);
        }).catch(() => {});
      }
    } else if (kind === 'tool' && translateOn && block.description && needsZhTranslation(block.description)) {
      this.translator.translate(block.description, 'en', 'zh', tr).then((zh) => {
        block.descriptionZh = zh;
        this._emitMsg(conv, msg);
      }).catch(() => {});
    }
    // 权限提示（如“命令里的引号内容无法预先检查”）也翻译成中文
    if (kind === 'tool' && translateOn && block.decisionReason && needsZhTranslation(block.decisionReason)) {
      this.translator.translate(block.decisionReason, 'en', 'zh', tr).then((zh) => {
        block.decisionReasonZh = zh;
        this._emitMsg(conv, msg);
      }).catch(() => {});
    }
  }

  _locatePermission(conv, requestId) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      const b = (m.blocks || []).find((x) => x.type === 'permission' && x.requestId === requestId);
      if (b) return { msg: m, block: b };
    }
    return null;
  }

  _onPermissionCancel(live, requestId) {
    const conv = live.conv;
    const found = this._locatePermission(conv, requestId);
    if (conv.run) delete conv.run.pending[requestId];
    if (found && found.block.status === 'pending') {
      found.block.status = 'cancelled';
      this._emitMsg(conv, found.msg);
    }
  }

  /**
   * 回答权限请求 / 提问 / 计划审批。
   * answer: { behavior:'allow'|'deny', always?, message?, answers?, otherText?, setMode? }
   */
  async answerPermission(convId, requestId, answer) {
    const conv = this.get(convId);
    const live = this._live(conv);
    const found = this._locatePermission(conv, requestId);
    if (!found) throw new Error('权限请求不存在');
    const { msg, block } = found;
    if (block.status !== 'pending') throw new Error('这个请求已经处理过了');
    // 翻译期间重复点击（或多个窗口同时回答）只处理第一次
    const lockKey = `${convId}:${requestId}`;
    if (this._answering.has(lockKey)) throw new Error('正在提交，请稍候');
    this._answering.add(lockKey);
    try {
      const tr = this.store.getSettings().translation;
      const toEn = async (t) => (t && tr.enabled && tr.translateInput && hasCJK(t) ? this.translator.translate(t, 'zh', 'en', tr).catch(() => t) : t);
      let response;
      let sentEn = null; // 经过翻译时实际发出的英文，界面上可以查看
      if (answer.behavior === 'allow') {
        let updatedInput = block.input;
        if (block.kind === 'question') {
          const answers = {};
          const changed = [];
          for (const [q, v] of Object.entries(answer.answers || {})) {
            answers[q] = await toEn(String(v));
            if (answers[q] !== String(v)) changed.push(answers[q]);
          }
          updatedInput = { ...block.input, answers };
          if (changed.length) sentEn = changed.join('; ');
        }
        response = { behavior: 'allow', updatedInput };
        // “始终允许”只记住规则和目录；Claude Code 附带的 setMode（如整个会话改为 acceptEdits）不跟着生效，
        // 否则界面上显示的权限模式和实际不一致，用户也不会预期点一次就放开所有编辑
        const always = answer.always ? block.suggestions.filter((s) => s && s.type !== 'setMode') : [];
        if (always.length) response.updatedPermissions = always;
      } else {
        const translated = await toEn(answer.message);
        if (translated && translated !== answer.message) sentEn = translated;
        const message = translated || (block.kind === 'plan' ? 'The user wants to keep planning. Revise the plan.' : 'The user denied this action.');
        response = { behavior: 'deny', message };
      }
      // 翻译期间请求可能已被 Claude 取消
      if (block.status !== 'pending') throw new Error('这个请求已经失效');
      if (!live.run || live.run.exited) await this._ensureRun(live).catch(() => null);
      if (!live.run || live.run.exited) throw new Error('Claude 已不在运行，无法回复这个请求');
      await live.run.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
      if (block.kind === 'question' && answer.behavior === 'allow') block.answers = answer.answers;
      if (answer.behavior !== 'allow' && answer.message) block.denyMessage = answer.message;
      if (sentEn) block.sentEn = sentEn;
      block.status = answer.behavior === 'allow' ? (answer.always ? 'always' : 'allowed') : 'denied';
      if (conv.run) delete conv.run.pending[requestId];
      this._emitMsg(conv, msg);
      this._touch(conv, false);
      if (answer.setMode) this.control(convId, { subtype: 'set_permission_mode', mode: answer.setMode }, { ensure: false }).catch(() => {});
      return true;
    } finally {
      this._answering.delete(lockKey);
    }
  }

  // ======================= 翻译 =======================

  _queueTranslate(conv, msg, block, force = false) {
    const tr = this.store.getSettings().translation;
    if (!force && (!tr.enabled || !tr.translateOutput)) return;
    if (!block.text || !block.text.trim() || (!force && !needsZhTranslation(block.text))) return;
    block.zhStatus = 'pending';
    block.zhError = null;
    const source = block.text;
    this.translator
      .translate(source, 'en', 'zh', tr)
      .then((zh) => {
        if (block.text !== source) return;
        block.zh = zh;
        block.zhStatus = 'done';
      })
      .catch((e) => {
        block.zhStatus = 'error';
        block.zhError = e.message;
      })
      .finally(() => {
        this._emitMsg(conv, msg);
        this._touch(conv, false);
      });
  }

  retranslate(convId, msgId, blockKey) {
    const conv = this.get(convId);
    const msg = conv.messages.find((m) => m.id === msgId);
    if (!msg || !msg.blocks) throw new Error('消息不存在');
    const targets = msg.blocks.filter((b) => b.type === 'text' && (!blockKey || b.key === blockKey));
    for (const b of targets) this._queueTranslate(conv, msg, b, true);
    this._emitMsg(conv, msg);
  }

  // ======================= 编辑重发 / 重新生成 / 版本 / 回退 =======================

  /** 第 idx 条消息之前最近一条回复的会话链位置（用于 --resume-session-at） */
  _chainUuidBefore(conv, idx) {
    for (let i = idx - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role === 'assistant' && m.lastUuid) return m.lastUuid;
      if (m.role === 'assistant') return null;
    }
    return null;
  }

  async _waitIdle(conv, ms = 15000) {
    const t = Date.now();
    while (this.isRunning(conv) && Date.now() - t < ms) await sleep(200);
  }

  /** 把从 idx 开始的消息存为一个“版本”，返回版本组 ID */
  _archiveTail(conv, idx) {
    const first = conv.messages[idx];
    const slotId = (first && first.slotId) || uid();
    if (first) first.slotId = slotId;
    conv.slots = conv.slots || {};
    const slot = conv.slots[slotId] || { versions: [null], current: 0 };
    const tail = conv.messages.splice(idx);
    slot.versions[slot.current] = { messages: tail, sessionId: conv.sessionId, ts: Date.now() };
    slot.versions.push(null);
    slot.current = slot.versions.length - 1;
    conv.slots[slotId] = slot;
    return slotId;
  }

  async _prepareFork(conv, idx) {
    const live = this._live(conv);
    if (this.isRunning(conv)) {
      await this.stop(conv.id);
      await this._waitIdle(conv);
    }
    const resumeAt = idx > 0 ? this._chainUuidBefore(conv, idx) : null;
    if (idx > 0 && conv.sessionId && !resumeAt) throw new Error('这条消息之前的回复缺少会话位置记录（旧版本的对话），无法从这里分叉');
    await this._closeRun(live);
    const slotId = this._archiveTail(conv, idx);
    conv.pendingFork = idx === 0 || !conv.sessionId ? { fresh: true } : { resumeAt };
    if (conv.pendingFork.fresh) conv.sessionId = null;
    return slotId;
  }

  async editMessage(convId, msgId, text) {
    const conv = this.get(convId);
    const idx = conv.messages.findIndex((m) => m.id === msgId && m.role === 'user');
    if (idx < 0) throw new Error('消息不存在');
    const images = conv.messages[idx].images || [];
    const slotId = await this._prepareFork(conv, idx);
    this._saveNow(conv);
    this._emitReload(conv);
    return this.send(convId, text, { images, slotId });
  }

  async regenerate(convId, assistantMsgId) {
    const conv = this.get(convId);
    const ai = conv.messages.findIndex((m) => m.id === assistantMsgId);
    let ui = ai - 1;
    while (ui >= 0 && conv.messages[ui].role !== 'user') ui--;
    if (ui < 0) throw new Error('找不到对应的提问');
    const u = conv.messages[ui];
    return this.editMessage(convId, u.id, u.text);
  }

  switchVariant(convId, slotId, k) {
    const conv = this.get(convId);
    if (this.isRunning(conv)) throw new Error('Claude 正在运行，请先停止');
    const slot = conv.slots && conv.slots[slotId];
    if (!slot || !slot.versions[k] || k === slot.current) return;
    const idx = conv.messages.findIndex((m) => m.slotId === slotId);
    if (idx < 0) throw new Error('版本不存在');
    const live = this._live(conv);
    this._closeRun(live).catch(() => {});
    const tail = conv.messages.splice(idx);
    slot.versions[slot.current] = { messages: tail, sessionId: conv.sessionId, ts: Date.now() };
    const v = slot.versions[k];
    conv.messages.push(...v.messages);
    conv.sessionId = v.sessionId;
    conv.pendingFork = null;
    slot.versions[k] = null;
    slot.current = k;
    this._saveNow(conv);
    this._emitReload(conv);
  }

  /**
   * 回退到某条用户消息之前：code=恢复 Claude 改过的文件，conversation=从这里分叉对话。
   * dryRun 只返回会改动哪些文件。
   */
  async rewind(convId, msgId, { code = true, conversation = true, dryRun = false } = {}) {
    const conv = this.get(convId);
    const idx = conv.messages.findIndex((m) => m.id === msgId && m.role === 'user');
    if (idx < 0) throw new Error('消息不存在');
    const msg = conv.messages[idx];
    let files = null;
    if (code) {
      if (this.isRunning(conv)) {
        await this.stop(convId);
        await this._waitIdle(conv);
      }
      if (!conv.sessionId) throw new Error('这个对话在服务器上还没有会话记录');
      const r = await this.control(convId, { subtype: 'rewind_files', user_message_id: msg.wire || msg.id, dry_run: dryRun }, { timeoutMs: 60000 });
      if (r && r.canRewind === false) throw new Error(r.error || '这条消息没有可恢复的文件检查点（旧版本的对话或没有改动文件）');
      files = r;
      if (dryRun) return { files };
    }
    if (conversation) {
      await this._prepareFork(conv, idx);
      this._pushNotice(conv, '已回退到这里，之前的内容保存在历史版本中');
      this._saveNow(conv);
      this._emitReload(conv);
    }
    return { files, text: msg.text, images: msg.images || [] };
  }

  // ======================= 删除 =======================

  _sessionIdsOf(conv) {
    if (!conv) return [];
    const ids = [...(conv.sessionIds || []), conv.sessionId];
    for (const slot of Object.values(conv.slots || {})) for (const v of slot.versions || []) if (v && v.sessionId) ids.push(v.sessionId);
    return [...new Set(ids.filter(isUuid))];
  }

  _rememberSession(conv, sid) {
    if (!isUuid(sid)) return;
    if (!Array.isArray(conv.sessionIds)) conv.sessionIds = [];
    if (!conv.sessionIds.includes(sid)) conv.sessionIds.push(sid);
  }

  /**
   * 删除对话。remote=true 时同时删除服务器上 ~/.claude 中对应的会话记录；
   * 未连接时登记到待删除队列，下次连上同一台服务器时执行。
   */
  async delete(id, { remote = false } = {}) {
    let conv = null;
    try {
      conv = this.get(id);
    } catch {
      /* 本地文件已不存在 */
    }
    const ids = this._sessionIdsOf(conv);
    const live = this.live.get(id);
    if (live) {
      // 先取出来：kill 之后退出处理会把 live.run 置空
      const run = live.run;
      if (run && !run.exited) {
        await run.kill().catch(() => {});
        await run.remove().catch(() => {});
      }
      this.live.delete(id);
    }
    // 删除附件
    for (const m of (conv && conv.messages) || []) for (const img of m.images || []) fs.rm(path.join(this.attachmentsDir, path.basename(img.file)), { force: true }, () => {});
    this.cache.delete(id);
    this.store.deleteConversation(id);
    this.emit('event', { type: 'conversation-deleted', convId: id });
    if (!remote || !ids.length) return { remote: 'skipped' };
    if (!this.ssh.isConnected()) {
      this._queueRemoteDelete(ids);
      return { remote: 'queued', count: ids.length };
    }
    try {
      await this.deleteRemoteSessions(ids);
      return { remote: 'done', count: ids.length };
    } catch (e) {
      this._queueRemoteDelete(ids);
      return { remote: 'failed', count: ids.length, error: e.message };
    }
  }

  _serverKey() {
    const c = this.ssh.cfg || this.store.getSettings().ssh;
    return `${String(c.username || '').trim()}@${String(c.host || '').trim()}:${Number(c.port) || 22}`;
  }

  _queueRemoteDelete(ids) {
    const list = this.store.getPendingDeletes();
    list.push({ server: this._serverKey(), ids, attempts: 0, createdAt: Date.now() });
    this.store.setPendingDeletes(list);
  }

  async processPendingRemoteDeletes() {
    const list = this.store.getPendingDeletes();
    const key = this._serverKey();
    const mine = list.filter((p) => p.server === key);
    if (!mine.length || !this.ssh.isConnected()) return;
    let rest = list.filter((p) => p.server !== key);
    try {
      await this.deleteRemoteSessions(mine.flatMap((p) => p.ids));
    } catch {
      rest = rest.concat(mine.map((p) => ({ ...p, attempts: (p.attempts || 0) + 1 })).filter((p) => p.attempts < 3));
    }
    this.store.setPendingDeletes(rest);
  }

  /** 删除服务器上指定会话的记录文件。ID 已校验为 UUID，不会被当作通配符或命令解释 */
  async deleteRemoteSessions(ids) {
    const valid = [...new Set(ids)].filter(isUuid);
    if (!valid.length) return 0;
    const script = [
      'C="$HOME/.claude"',
      `for id in ${valid.join(' ')}; do`,
      '  [ -d "$C/projects" ] && find "$C/projects" -mindepth 2 -maxdepth 2 \\( -name "$id.jsonl" -o -name "$id" \\) -exec rm -rf {} + 2>/dev/null',
      '  rm -rf "$C/file-history/$id" "$C/session-env/$id" 2>/dev/null',
      '  rm -f "$C/todos/$id"-*.json 2>/dev/null',
      'done',
      'echo CB_DELETE_OK',
    ].join('\n');
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 30000 });
    if (!r.stdout.includes('CB_DELETE_OK')) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    return valid.length;
  }

  // ======================= 服务器上的已有会话 =======================

  async listServerSessions() {
    if (!this.ssh.isConnected()) throw new Error('请先连接服务器');
    const script = [
      'cd "$HOME/.claude/projects" 2>/dev/null || exit 0',
      // 项目目录名常以 - 开头，统一加 ./ 前缀，避免被当成命令选项
      'ls -t ./*/*.jsonl 2>/dev/null | head -n 150 | while IFS= read -r f; do',
      '  echo "@@FILE|${f#./}|$(wc -c < "$f")|$(stat -c %Y "$f")"',
      '  head -n 25 "$f" | cut -c1-4000',
      'done',
    ].join('\n');
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 60000 });
    const known = new Set();
    for (const sum of this.store.listConversations()) {
      try {
        const c = this.cache.get(sum.id) || this.store.loadConversation(sum.id);
        for (const s of this._sessionIdsOf(c)) known.add(s);
      } catch {
        /* 忽略 */
      }
    }
    const out = [];
    let cur = null;
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('@@FILE|')) {
        const [, file, size, mtime] = line.split('|');
        const sid = path.posix.basename(file, '.jsonl');
        if (!isUuid(sid)) {
          cur = null;
          continue;
        }
        cur = { file, sessionId: sid, size: Number(size), mtime: Number(mtime) * 1000, cwd: null, title: null, imported: known.has(sid) };
        out.push(cur);
        continue;
      }
      if (!cur || line[0] !== '{') continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cur.cwd && e.cwd) cur.cwd = e.cwd;
      if (e.type === 'summary' && e.summary && !cur.summary) cur.summary = String(e.summary);
      if (!cur.title && e.type === 'user' && !e.isMeta && !e.isSidechain) {
        const c = e.message && e.message.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
        if (t && !/^\s*<(command|local-command|system-reminder)/.test(t) && !t.startsWith('Caveat:')) cur.title = t.replace(/\s+/g, ' ').slice(0, 80);
      }
    }
    return out.map((s) => ({ ...s, title: s.summary || s.title || '（无标题）' }));
  }

  async importServerSession(file) {
    if (!/^[^/\s][^/]*\/[0-9a-f-]{36}\.jsonl$/i.test(file) || file.includes('..')) throw new Error('无效的会话文件');
    const sid = path.posix.basename(file, '.jsonl');
    for (const sum of this.store.listConversations()) {
      try {
        const c = this.cache.get(sum.id) || this.store.loadConversation(sum.id);
        if (this._sessionIdsOf(c).includes(sid)) return summarize(c);
      } catch {
        /* 忽略 */
      }
    }
    const r = await this.ssh.exec(`sh -c ${shQuote(`head -c 40000000 -- "$HOME/.claude/projects/"${shQuote(file)}`)}`, { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || '读取会话文件失败');
    const messages = [];
    let cwd = null;
    let title = null;
    let first = null;
    let last = null;
    let assistant = null;
    const toolIndex = new Map();
    for (const line of r.stdout.split('\n')) {
      if (line[0] !== '{') continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === 'summary' && e.summary) title = title || String(e.summary);
      if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue;
      const ts = e.timestamp ? Date.parse(e.timestamp) : Date.now();
      first = first || ts;
      last = ts;
      if (!cwd && e.cwd) cwd = e.cwd;
      const c = e.message && e.message.content;
      if (e.type === 'user') {
        if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) {
          for (const x of c) {
            if (x.type !== 'tool_result') continue;
            const b = toolIndex.get(x.tool_use_id);
            if (b) {
              b.result = truncate(stringifyToolResult(x.content), TOOL_RESULT_MAX);
              b.isError = !!x.is_error;
              b.done = true;
            }
          }
          if (assistant && e.uuid) assistant.lastUuid = e.uuid;
          continue;
        }
        if (e.isMeta) continue;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
        if (!text || /^\s*<(local-command|system-reminder)/.test(text) || text.startsWith('Caveat:')) continue;
        const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
        const shown = cmd ? cmd[1] : text;
        title = title || shown.replace(/\s+/g, ' ').slice(0, 40);
        messages.push({ id: uid(), wire: e.uuid || uid(), role: 'user', text: shown, en: null, images: [], status: 'sent', ts });
        assistant = null;
      } else {
        if (!assistant) {
          assistant = { id: uid(), role: 'assistant', blocks: [], status: 'done', ts, meta: null, error: null, notices: [], model: null };
          messages.push(assistant);
        }
        if (e.uuid) assistant.lastUuid = e.uuid;
        if (e.message && e.message.model && e.message.model !== '<synthetic>') assistant.model = e.message.model;
        for (const x of Array.isArray(c) ? c : []) {
          if (x.type === 'text' && x.text) assistant.blocks.push({ key: uid(), type: 'text', text: x.text, final: true });
          else if (x.type === 'thinking' && x.thinking) assistant.blocks.push({ key: uid(), type: 'thinking', text: x.thinking, final: true });
          else if (x.type === 'tool_use') {
            const b = { key: uid(), type: 'tool_use', id: x.id, name: x.name, input: x.input || {}, final: true };
            toolIndex.set(x.id, b);
            assistant.blocks.push(b);
          }
        }
      }
    }
    if (!messages.length) throw new Error('这个会话里没有可导入的对话内容');
    const conv = {
      id: uid(),
      title: makeTitle(title || '导入的会话'),
      createdAt: first || Date.now(),
      updatedAt: last || Date.now(),
      sessionId: sid,
      sessionIds: [sid],
      mode: 'code',
      workdir: cwd || '~',
      messages,
      imported: true,
    };
    this.cache.set(conv.id, conv);
    this.store.saveConversation(conv);
    this._emitConv(conv);
    return summarize(conv);
  }

  // ======================= 统计 / 导出 =======================

  stats(range = 'all') {
    const now = Date.now();
    const since = range === '7d' ? now - 7 * 864e5 : range === '30d' ? now - 30 * 864e5 : 0;
    let sessions = 0;
    let messages = 0;
    let tokens = 0;
    const days = new Set();
    const hours = new Array(24).fill(0);
    const models = new Map();
    const dayCounts = new Map();
    const daily = new Map(); // 日期 → { date, total, models: { 模型: token } }
    for (const sum of this.store.listConversations()) {
      let conv;
      try {
        conv = this.cache.get(sum.id) || this.store.loadConversation(sum.id);
      } catch {
        continue;
      }
      if (!conv) continue;
      let active = false;
      for (const m of conv.messages || []) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const ts = m.ts || conv.createdAt || now;
        const dk = dayKey(ts);
        dayCounts.set(dk, (dayCounts.get(dk) || 0) + 1);
        if (ts < since) continue;
        active = true;
        messages++;
        days.add(dk);
        hours[new Date(ts).getHours()]++;
        if (m.role === 'assistant') {
          const t = (m.meta && m.meta.tokens) || 0;
          tokens += t;
          const per = m.meta && m.meta.models && Object.keys(m.meta.models).length ? m.meta.models : m.model ? { [m.model]: t } : {};
          const io = (m.meta && m.meta.modelsIO) || {};
          let day = daily.get(dk);
          if (!day && Object.values(per).some((v) => v > 0)) daily.set(dk, (day = { date: dk, total: 0, models: {} }));
          for (const [name, v] of Object.entries(per)) {
            const e = models.get(name) || { model: name, tokens: 0, messages: 0, input: 0, output: 0, ioKnown: false };
            e.tokens += v;
            e.messages++;
            if (io[name]) {
              e.input += io[name].in || 0;
              e.output += io[name].out || 0;
              e.ioKnown = true;
            }
            models.set(name, e);
            if (day && v > 0) {
              day.total += v;
              day.models[name] = (day.models[name] || 0) + v;
            }
          }
        }
      }
      if (active) sessions++;
    }
    const modelList = [...models.values()].sort((a, b) => b.tokens - a.tokens || b.messages - a.messages);
    const peak = messages ? hours.indexOf(Math.max(...hours)) : null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (25 * 7 + today.getDay()));
    const heatmap = [];
    for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d.getTime());
      heatmap.push({ date: k, count: dayCounts.get(k) || 0 });
    }
    // 有用量的日期（最近 14 天有数据的），首页“模型”柱状图用
    const dailyList = [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-14);
    return { range, sessions, messages, tokens, activeDays: days.size, peakHour: peak, favoriteModel: modelList[0] ? modelList[0].model : null, models: modelList, daily: dailyList, heatmap, rateLimits: this.rateLimits || null };
  }

  toMarkdown(conv) {
    const lines = [`# ${conv.title}`, '', `> 服务器工作目录：\`${conv.workdir}\`　导出时间：${new Date().toLocaleString()}`, ''];
    for (const m of conv.messages) {
      if (m.role === 'user') {
        lines.push('## 你', '', m.text, '');
        if (m.en) lines.push('<details><summary>英文（实际发送）</summary>', '', m.en, '', '</details>', '');
      } else if (m.role === 'assistant') {
        lines.push('## Claude', '');
        for (const b of m.blocks || []) {
          if (b.type === 'text') lines.push(b.zhStatus === 'done' && b.zh ? b.zh : b.text, '');
          else if (b.type === 'tool_use') lines.push(`> 工具 \`${b.name}\`：\`${JSON.stringify(b.input || {}).slice(0, 300)}\``, '');
        }
        if (m.error) lines.push(`> 错误：${m.error}`, '');
      } else if (m.text) {
        lines.push(`*${m.text}*`, '');
      }
    }
    return lines.join('\n');
  }

  // ======================= 服务器上 Claude 的信息 =======================

  async _translateModelDescriptions(info) {
    const tr = this.store.getSettings().translation;
    const models = info.models.filter((m) => m.description);
    if (!tr.enabled || !tr.translateOutput || !models.length) return;
    const src = models.map((m, i) => `[${i}] ${m.description}`).join('\n');
    const out = await this.translator.translate(src, 'en', 'zh', tr);
    const map = new Map();
    for (const line of out.split('\n')) {
      const mm = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
      if (mm) map.set(Number(mm[1]), mm[2].trim());
    }
    if (map.size !== models.length || this.claudeInfo !== info) return;
    models.forEach((m, i) => {
      m.descriptionZh = map.get(i);
    });
    this.emit('event', { type: 'claude-info', info });
  }

  /** 读取服务器上 Claude Code 的可选模型、思考强度、斜杠命令、额度等（并发调用会合并） */
  refreshClaudeInfo() {
    if (this._probe) return this._probe;
    if (!this.ssh.isConnected()) return Promise.reject(new Error('请先连接服务器'));
    const command = this.store.getSettings().claude.command;
    this._probe = Promise.all([oneShotControl(this.ssh, command, [{ subtype: 'initialize' }, { subtype: 'get_usage', skip_behaviors: true }]), this._serverIsRoot()])
      .then(([res, isRoot]) => {
        if (res.q0 && res.q0.error) throw new Error(res.q0.error);
        const info = normalizeInfo(res.q0 || {});
        info.isRoot = isRoot;
        const usage = res.q1 && !res.q1.error ? res.q1 : null;
        if (usage && usage.rate_limits) {
          this.rateLimits = { ...usage.rate_limits, at: Date.now() };
          this.store.setMeta('rateLimits', this.rateLimits);
          this.emit('event', { type: 'rate-limits', info: this.rateLimits });
        }
        info.rateLimitsAvailable = usage ? !!usage.rate_limits_available : null;
        this.claudeInfo = info;
        if (info.commands.length) this.slashCommands = info.commands.map((c) => c.name);
        this.emit('event', { type: 'claude-info', info });
        this._translateModelDescriptions(info).catch(() => {});
        return info;
      })
      .catch((e) => {
        this.claudeInfo = { ...(this.claudeInfo || {}), error: e.message, fetchedAt: Date.now() };
        this.emit('event', { type: 'claude-info', info: this.claudeInfo });
        throw e;
      })
      .finally(() => {
        this._probe = null;
      });
    return this._probe;
  }

  async gitBranch(workdir) {
    if (!this.ssh.isConnected()) return null;
    const script = `cd ${remotePathExpr(workdir || '~')} 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null`;
    try {
      const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 10000 });
      const b = r.stdout.trim().split('\n')[0];
      return r.code === 0 && b ? b : null;
    } catch {
      return null;
    }
  }

  async detectClaude() {
    if (!this.ssh.isConnected()) throw new Error('请先连接服务器');
    const r = await this.ssh.exec(`bash -lc ${shQuote(DETECT_SCRIPT)}`, { timeoutMs: 90000 });
    const found = [];
    let info = null;
    for (const line of r.stdout.split('\n')) {
      const parts = line.trim().split('|');
      if (parts[0] === 'FOUND' && parts[1] && !found.some((f) => f.path === parts[1])) {
        found.push({ path: parts[1], version: parts.slice(2).join('|') });
      } else if (parts[0] === 'INFO') {
        info = { user: parts[1], system: parts[2], home: parts[3] };
      }
    }
    return { found, info };
  }
}

module.exports = { ChatManager, buildSystemPrompt };
