'use strict';

/**
 * 服务器上的 Claude 在本机启动的后台进程（npm run dev 这类不会自己结束的命令）。
 * 保存最近的输出，识别输出里的本机网址（http://localhost:3000 等），程序退出时全部结束。
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { uid } = require('./util');

const MAX_BUFFER = 256 * 1024; // 每个进程保留的输出（字符）
const MAX_PROCS = 12;
// 输出里出现的本机网址
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/gi;
// 去掉终端颜色代码，方便识别网址和阅读
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function normalizeUrl(u) {
  return u.replace('0.0.0.0', 'localhost').replace(/\[::1?\]/, 'localhost').replace(/[.,;:]+$/, '');
}

class LocalProcesses extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map();
  }

  /** 启动后台进程（PowerShell），返回进程信息 */
  start({ command, cwd, name }) {
    const running = [...this.procs.values()].filter((p) => p.status === 'running');
    if (running.length >= MAX_PROCS) throw new Error(`Too many background processes are running (${running.length}). Stop some with stop_process first.`);
    const script =
      "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;\n" +
      command;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      cwd,
      windowsHide: true,
      // 让 npm / vite 等认为不是交互终端，但保留彩色以外的正常输出
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
    });
    const p = {
      id: uid().slice(0, 8),
      name: String(name || '').trim().slice(0, 60) || String(command).split(/\r?\n/)[0].slice(0, 60),
      command: String(command),
      cwd,
      pid: child.pid,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      urls: [],
      output: '',
      dropped: 0, // 因超出缓冲被丢弃的字符数
      child,
    };
    const onData = (d) => {
      const text = d.toString('utf8').replace(ANSI_RE, '');
      p.output += text;
      if (p.output.length > MAX_BUFFER) {
        const cut = p.output.length - MAX_BUFFER;
        p.output = p.output.slice(cut);
        p.dropped += cut;
      }
      let changed = false;
      for (const m of text.matchAll(URL_RE)) {
        const u = normalizeUrl(m[0]);
        if (!p.urls.includes(u)) {
          p.urls.push(u);
          changed = true;
        }
      }
      if (changed) this._changed();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      p.output += `\n[无法启动 PowerShell：${e.message}]\n`;
      p.status = 'exited';
      p.endedAt = Date.now();
      this._changed();
    });
    child.on('close', (code) => {
      if (p.status === 'running') p.status = 'exited';
      p.exitCode = code;
      p.endedAt = Date.now();
      delete p.child;
      this._changed();
    });
    this.procs.set(p.id, p);
    // 只保留最近 30 个已结束的记录
    const ended = [...this.procs.values()].filter((x) => x.status !== 'running');
    for (const x of ended.slice(0, Math.max(0, ended.length - 30))) this.procs.delete(x.id);
    this._changed();
    return p;
  }

  get(id) {
    const p = this.procs.get(String(id || ''));
    if (!p) throw new Error(`No background process with id "${id}". Use list_processes to see them.`);
    return p;
  }

  /** 输出的最后 n 行 */
  tail(id, lines = 80) {
    const p = this.get(id);
    const all = p.output.split(/\r?\n/);
    const n = Math.max(1, Math.min(2000, lines));
    return { proc: p, text: all.slice(-n).join('\n'), truncated: all.length > n || p.dropped > 0 };
  }

  stop(id) {
    const p = this.get(id);
    if (p.status === 'running' && p.pid) {
      p.status = 'stopped';
      // /T 连同子进程（node、vite……）一起结束
      spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    }
    this._changed();
    return p;
  }

  stopAll() {
    for (const p of this.procs.values()) {
      if (p.status === 'running' && p.pid) {
        try {
          require('child_process').spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        } catch {
          /* 忽略 */
        }
        p.status = 'stopped';
      }
    }
  }

  /** 给界面用的摘要（不含输出和子进程对象） */
  list() {
    return [...this.procs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((p) => ({ id: p.id, name: p.name, command: p.command, cwd: p.cwd, pid: p.pid, status: p.status, exitCode: p.exitCode, startedAt: p.startedAt, endedAt: p.endedAt, urls: p.urls.slice() }));
  }

  _changed() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.emit('changed', this.list()), 50);
  }
}

module.exports = { LocalProcesses };
