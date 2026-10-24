'use strict';

const { EventEmitter } = require('events');
const { Client } = require('ssh2');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000];
const WIN_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

function friendlyError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (err && err.level === 'client-authentication') return '认证失败：用户名、密码或私钥不正确';
  if (/ECONNREFUSED/.test(msg)) return '连接被拒绝：请检查主机地址和端口';
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(msg)) return '连接超时：请检查网络或防火墙';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return '无法解析主机名';
  if (/ECONNRESET/.test(msg)) return '连接被重置';
  if (/host key|Host denied/i.test(msg)) return '服务器指纹未被信任，已取消连接';
  return msg;
}

/**
 * 管理到 VPS 的 SSH 连接：
 *  - 执行远程命令（运行 Claude Code）
 *  - 建立反向隧道（服务器 127.0.0.1:随机端口 → 本机 MCP 服务）
 */
class SshManager extends EventEmitter {
  /**
   * @param {{ verifyHostKey: (hostId: string, fingerprint: string) => Promise<boolean>, getPreferredTunnelPort?: (hostId: string) => number }} opts
   */
  constructor({ verifyHostKey, getPreferredTunnelPort = () => 0 }) {
    super();
    this.verifyHostKey = verifyHostKey;
    this.getPreferredTunnelPort = getPreferredTunnelPort;
    this.conn = null;
    this.connId = 0;
    this.state = 'disconnected'; // disconnected | connecting | connected | reconnecting | error
    this.error = '';
    this.tunnelError = '';
    this.forward = null; // { remotePort, localPort }
    this.cfg = null;
    this.localMcpPort = 0;
    this._manualClose = false;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
  }

  getStatus() {
    return {
      state: this.state,
      error: this.error,
      host: this.cfg ? this.cfg.host : '',
      port: this.cfg ? this.cfg.port : 22,
      username: this.cfg ? this.cfg.username : '',
      tunnel: this.forward ? { ...this.forward } : null,
      tunnelError: this.tunnelError,
    };
  }

  _setState(state, error = '') {
    this.state = state;
    this.error = error;
    this.emit('state', this.getStatus());
  }

  isConnected() {
    return this.state === 'connected' && !!this.conn;
  }

  async connect(cfg, { localMcpPort = 0 } = {}) {
    if (!cfg || !String(cfg.host || '').trim()) throw new Error('请先在设置中填写服务器地址');
    if (!String(cfg.username || '').trim()) throw new Error('请先在设置中填写用户名');
    this._teardown();
    this._manualClose = false;
    this._reconnectAttempt = 0;
    this.cfg = { ...cfg, host: String(cfg.host).trim(), port: Number(cfg.port) || 22 };
    this.localMcpPort = localMcpPort;
    return this._connect('connecting');
  }

  _buildOptions(cfg) {
    const opts = {
      host: cfg.host,
      port: cfg.port,
      username: String(cfg.username).trim(),
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
    };
    if (cfg.authType === 'key') {
      if (!cfg.privateKeyPath) throw new Error('请选择私钥文件');
      try {
        opts.privateKey = fs.readFileSync(cfg.privateKeyPath);
      } catch (e) {
        throw new Error(`无法读取私钥文件：${e.message}`);
      }
      if (cfg.passphrase) opts.passphrase = cfg.passphrase;
    } else if (cfg.authType === 'agent') {
      opts.agent = process.platform === 'win32' ? WIN_AGENT_PIPE : process.env.SSH_AUTH_SOCK;
    } else {
      opts.password = cfg.password || '';
      opts.tryKeyboard = true;
    }
    const hostId = `${cfg.host}:${cfg.port}`;
    // 返回 undefined 表示异步校验，稍后调用 verify(true/false)
    opts.hostVerifier = (key, verify) => {
      const fp = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
      Promise.resolve(this.verifyHostKey(hostId, fp))
        .then((ok) => verify(!!ok))
        .catch(() => verify(false));
    };
    return opts;
  }

  _connect(initialState) {
    return new Promise((resolve, reject) => {
      let opts;
      try {
        opts = this._buildOptions(this.cfg);
      } catch (e) {
        this._setState('error', e.message);
        reject(e);
        return;
      }
      const conn = new Client();
      const myId = ++this.connId;
      this.conn = conn;
      this.forward = null;
      this.tunnelError = '';
      this._setState(initialState);
      let settled = false;
      let wasReady = false;
      // 用户在连接过程中点“取消/断开”时，让挂起的 connect() 结束
      this._abortPending = () => {
        if (!settled) {
          settled = true;
          reject(new Error('已取消连接'));
        }
      };

      conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => this.cfg.password || ''));
      });

      conn.on('tcp connection', (info, accept, rejectConn) => this._onTunnelConnection(info, accept, rejectConn));

      conn.on('ready', async () => {
        if (this.conn !== conn) return;
        wasReady = true;
        this._reconnectAttempt = 0;
        if (this.localMcpPort) {
          try {
            await this._openTunnel(conn);
          } catch (e) {
            this.tunnelError = e.message;
          }
        }
        settled = true;
        this._setState('connected');
        this.emit('ready', myId);
        resolve(this.getStatus());
      });

      conn.on('error', (err) => {
        const msg = friendlyError(err);
        if (!settled) {
          settled = true;
          this._setState('error', msg);
          reject(new Error(msg));
        } else {
          this.error = msg;
        }
      });

      conn.on('close', () => {
        if (this.conn !== conn) return;
        this.conn = null;
        this.forward = null;
        if (this._manualClose) {
          this._setState('disconnected');
          return;
        }
        if (!settled) {
          settled = true;
          this._setState('error', '连接已关闭');
          reject(new Error('连接已关闭'));
          return;
        }
        // 已建立的连接意外断开 → 自动重连（握手阶段的失败由 connect 的调用方处理）
        if (wasReady) this._scheduleReconnect();
      });

      conn.connect(opts);
    });
  }

  _scheduleReconnect() {
    if (this._manualClose) return;
    if (!this.cfg || !this.cfg.autoReconnect || this._reconnectAttempt >= RECONNECT_DELAYS.length) {
      this._setState('error', '连接已断开');
      return;
    }
    const delay = RECONNECT_DELAYS[this._reconnectAttempt++];
    this._setState('reconnecting', `连接断开，${Math.round(delay / 1000)} 秒后重连（第 ${this._reconnectAttempt} 次）`);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this._manualClose) return;
      this._connect('reconnecting').catch(() => this._scheduleReconnect());
    }, delay);
  }

  _forwardIn(conn, port) {
    return new Promise((resolve, reject) => {
      try {
        conn.forwardIn('127.0.0.1', port, (err, bound) => (err ? reject(err) : resolve(bound || port)));
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 优先复用上次的服务器端口：服务器上仍在运行的 claude 的 MCP 配置里写的是旧端口，
   * 端口变了它就再也连不上本机。旧端口暂时被占用（断线后 sshd 还没释放）时重试几次，
   * 仍不行再由服务器分配新端口（端口 0）。
   */
  async _openTunnel(conn) {
    const hostId = `${this.cfg.host}:${this.cfg.port}`;
    const preferred = Number(this.getPreferredTunnelPort(hostId)) || 0;
    let port = 0;
    if (preferred > 0 && preferred < 65536) {
      for (let i = 0; i < 3 && !port; i++) {
        if (i) await new Promise((r) => setTimeout(r, 2000));
        if (this.conn !== conn) throw new Error('连接已关闭');
        port = await this._forwardIn(conn, preferred).catch(() => 0);
      }
    }
    const reused = !!port;
    if (!port) {
      try {
        port = await this._forwardIn(conn, 0);
      } catch (err) {
        throw new Error(`反向隧道建立失败：${err.message}（请确认服务器 sshd_config 中 AllowTcpForwarding 未被禁用）`);
      }
    }
    this.forward = { remotePort: port, localPort: this.localMcpPort };
    this.tunnelError = '';
    // 同步触发：监听方需要在任何新运行写入 MCP 配置之前更新令牌
    this.emit('tunnel', { hostId, remotePort: port, reused, previousPort: preferred || null });
    return port;
  }

  /** 设置变更后动态开启/关闭隧道 */
  async setTunnelEnabled(enabled, localMcpPort) {
    this.localMcpPort = enabled ? localMcpPort : 0;
    if (!this.isConnected()) return;
    if (enabled && !this.forward) {
      try {
        await this._openTunnel(this.conn);
      } catch (e) {
        this.tunnelError = e.message;
      }
      this.emit('state', this.getStatus());
    } else if (!enabled && this.forward) {
      const { remotePort } = this.forward;
      this.forward = null;
      try {
        this.conn.unforwardIn('127.0.0.1', remotePort, () => {});
      } catch {
        /* 忽略 */
      }
      this.emit('state', this.getStatus());
    }
  }

  _onTunnelConnection(_info, accept, rejectConn) {
    if (!this.forward) {
      rejectConn();
      return;
    }
    const sock = net.connect(this.forward.localPort, '127.0.0.1');
    let channel = null;
    sock.once('connect', () => {
      channel = accept();
      channel.on('error', () => sock.destroy());
      channel.on('close', () => sock.destroy());
      channel.pipe(sock).pipe(channel);
    });
    sock.on('error', () => {
      if (channel) channel.close();
      else rejectConn();
    });
    sock.on('close', () => {
      if (channel) channel.end();
    });
  }

  /** 打开交互式终端（PTY） */
  shell({ cols = 100, rows = 30 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('SSH 未连接'));
        return;
      }
      this.conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) reject(new Error(`打开终端失败：${err.message}`));
        else resolve(stream);
      });
    });
  }

  /** SFTP 会话（每个连接复用一个） */
  sftp() {
    if (!this.isConnected()) return Promise.reject(new Error('SSH 未连接'));
    if (this._sftp && this._sftpConn === this.connId) return this._sftp;
    const connId = this.connId;
    this._sftpConn = connId;
    this._sftp = new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) {
          this._sftp = null;
          reject(new Error(`打开 SFTP 失败：${err.message}`));
          return;
        }
        sftp.on('close', () => {
          if (this._sftpConn === connId) this._sftp = null;
        });
        resolve(sftp);
      });
    });
    return this._sftp;
  }

  /** 打开一个远程命令通道（调用方自行处理 stdin/stdout） */
  spawn(command) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('SSH 未连接'));
        return;
      }
      this.conn.exec(command, (err, stream) => {
        if (err) reject(new Error(`远程执行失败：${err.message}`));
        else resolve(stream);
      });
    });
  }

  /** 执行远程命令并收集输出 */
  async exec(command, { stdin = null, timeoutMs = 30000 } = {}) {
    const stream = await this.spawn(command);
    return new Promise((resolve, reject) => {
      const outDec = new StringDecoder('utf8');
      const errDec = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let code = null;
      const timer = setTimeout(() => {
        try {
          stream.close();
        } catch {
          /* 忽略 */
        }
        reject(new Error('远程命令执行超时'));
      }, timeoutMs);
      stream.on('data', (d) => {
        stdout += outDec.write(d);
      });
      stream.stderr.on('data', (d) => {
        stderr += errDec.write(d);
      });
      stream.on('exit', (c) => {
        code = c;
      });
      stream.on('close', () => {
        clearTimeout(timer);
        resolve({ code, stdout: stdout + outDec.end(), stderr: stderr + errDec.end() });
      });
      if (stdin != null) stream.end(stdin);
      else stream.end();
    });
  }

  _teardown() {
    clearTimeout(this._reconnectTimer);
    if (this._abortPending) {
      this._abortPending();
      this._abortPending = null;
    }
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      this.forward = null;
      try {
        c.end();
      } catch {
        /* 忽略 */
      }
    }
  }

  disconnect() {
    this._manualClose = true;
    this._teardown();
    this._setState('disconnected');
  }
}

module.exports = { SshManager };
