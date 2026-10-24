'use strict';

/**
 * Windows 桌面控制（Cowork）：在本机以子进程运行 Windows-MCP（uvx windows-mcp==0.8.8，stdio），
 * 作为 MCP 客户端连接它，再把它的工具以 desktop_* 的名字并入本机 MCP 服务，提供给服务器上的 Claude。
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const RELEASE = { package: 'windows-mcp', version: '0.8.8', python: '3.14' };
// 这些工具能修改系统或执行任意操作，默认需要确认
const RISKY = new Set(['PowerShell', 'Process', 'Registry', 'FileSystem', 'App', 'Shortcut', 'Clipboard', 'MultiEdit']);

class DesktopMcp extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.state = 'off'; // off | starting | ready | error
    this.error = '';
    this.tools = [];
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
  }

  status() {
    return { state: this.state, error: this.error, tools: this.tools.map((t) => t.name), release: RELEASE };
  }

  _set(state, error = '') {
    this.state = state;
    this.error = error;
    this.emit('state', this.status());
  }

  start() {
    if (this.state === 'starting' || this.state === 'ready') return this._starting || Promise.resolve();
    this._set('starting');
    this.stderr = '';
    const args = ['--python', RELEASE.python, '--from', `${RELEASE.package}==${RELEASE.version}`, 'windows-mcp', 'serve'];
    let child;
    try {
      child = spawn('uvx', args, { windowsHide: true, env: { ...process.env, ANONYMIZED_TELEMETRY: 'false', PYTHONIOENCODING: 'utf-8' } });
    } catch (e) {
      this._set('error', `无法启动 uvx：${e.message}`);
      return Promise.reject(e);
    }
    this.child = child;
    child.stdout.on('data', (d) => this._onData(d));
    child.stderr.on('data', (d) => {
      if (this.stderr.length < 20000) this.stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      this._fail(/ENOENT/.test(e.message) ? '找不到 uvx：请先安装 uv（https://docs.astral.sh/uv/）' : e.message);
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) p.reject(new Error('Windows-MCP 已退出'));
      this.pending.clear();
      if (this.state !== 'off') this._set('error', `Windows-MCP 已退出（code ${code}）${this.stderr ? `：${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
    });
    this._starting = (async () => {
      // 首次运行 uv 可能需要下载 Python 和依赖，给足时间
      await this._request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-bridge', version: '0.1.0' } }, 300000);
      this._notify('notifications/initialized', {});
      const tools = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const r = await this._request('tools/list', cursor ? { cursor } : {}, 60000);
        tools.push(...(r.tools || []));
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      this.tools = tools;
      this._set('ready');
    })().catch((e) => {
      this._fail(e.message);
      throw e;
    });
    return this._starting;
  }

  _fail(msg) {
    this._set('error', msg);
    this.stop(true);
  }

  stop(keepState = false) {
    const c = this.child;
    this.child = null;
    if (c) {
      try {
        c.kill();
      } catch {
        /* 忽略 */
      }
    }
    for (const p of this.pending.values()) p.reject(new Error('Windows-MCP 已停止'));
    this.pending.clear();
    this.tools = [];
    if (!keepState) this._set('off');
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'Windows-MCP 返回错误'));
        else p.resolve(msg.result || {});
      } else if (msg.method && msg.id !== undefined) {
        // 服务器发来的请求（如 roots/list）：返回空结果
        this._write({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [] } : {} });
      }
    }
  }

  _write(obj) {
    if (!this.child) throw new Error('Windows-MCP 未运行');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  _notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  _request(method, params, timeoutMs = 120000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows-MCP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async call(name, args) {
    if (this.state !== 'ready') throw new Error('Windows 桌面控制尚未就绪');
    return this._request('tools/call', { name, arguments: args || {} }, 180000);
  }

  isRisky(name) {
    return RISKY.has(name);
  }
}

module.exports = { DesktopMcp, RISKY };
