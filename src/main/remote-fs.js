'use strict';

/**
 * 服务器文件访问（SFTP）：文件浏览器、自定义页（CLAUDE.md、技能、子代理、设置文件）使用。
 * 路径支持 ~ 开头（相对服务器用户主目录）。
 */

const path = require('path').posix;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function cb(fn) {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
}

class RemoteFs {
  constructor(ssh) {
    this.ssh = ssh;
    this._home = null;
    this._homeConn = 0;
  }

  async _s() {
    return this.ssh.sftp();
  }

  async home() {
    if (this._home && this._homeConn === this.ssh.connId) return this._home;
    const s = await this._s();
    this._home = await cb((done) => s.realpath('.', done));
    this._homeConn = this.ssh.connId;
    return this._home;
  }

  async resolve(p) {
    let v = String(p || '~').trim() || '~';
    if (v === '~' || v.startsWith('~/')) v = path.join(await this.home(), v.slice(1));
    if (!v.startsWith('/')) v = path.join(await this.home(), v);
    return path.normalize(v);
  }

  async list(p) {
    const dir = await this.resolve(p);
    const s = await this._s();
    const items = await cb((done) => s.readdir(dir, done));
    const entries = items.map((it) => {
      const mode = it.attrs.mode || 0;
      const type = (mode & S_IFMT) === S_IFDIR ? 'dir' : (mode & S_IFMT) === S_IFLNK ? 'link' : 'file';
      return { name: it.filename, type, size: it.attrs.size || 0, mtime: (it.attrs.mtime || 0) * 1000 };
    });
    entries.sort((a, b) => (b.type === 'dir' ? 1 : 0) - (a.type === 'dir' ? 1 : 0) || a.name.localeCompare(b.name));
    return { path: dir, home: await this.home(), entries };
  }

  async stat(p) {
    const f = await this.resolve(p);
    const s = await this._s();
    const st = await cb((done) => s.stat(f, done));
    return { path: f, size: st.size, mtime: st.mtime * 1000, isDir: st.isDirectory() };
  }

  async exists(p) {
    try {
      await this.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /** 读取文件：文本返回 utf8，图片返回 base64 data URL；超过 maxBytes 截断 */
  async read(p, { maxBytes = 2 * 1024 * 1024 } = {}) {
    const f = await this.resolve(p);
    const s = await this._s();
    const st = await cb((done) => s.stat(f, done));
    if (st.isDirectory()) throw new Error('这是一个目录');
    const size = st.size;
    const len = Math.min(size, maxBytes);
    const handle = await cb((done) => s.open(f, 'r', done));
    const buf = Buffer.alloc(len);
    let off = 0;
    try {
      while (off < len) {
        const n = await new Promise((resolve, reject) => s.read(handle, buf, off, Math.min(65536, len - off), off, (err, bytes) => (err ? reject(err) : resolve(bytes))));
        if (!n) break;
        off += n;
      }
    } finally {
      await cb((done) => s.close(handle, done)).catch(() => {});
    }
    const data = buf.subarray(0, off);
    const ext = path.extname(f).toLowerCase();
    if (IMAGE_EXT[ext] && size <= maxBytes) return { path: f, size, image: `data:${IMAGE_EXT[ext]};base64,${data.toString('base64')}` };
    const n = Math.min(data.length, 8192);
    for (let i = 0; i < n; i++) if (data[i] === 0) return { path: f, size, binary: true };
    return { path: f, size, content: data.toString('utf8'), truncated: size > maxBytes };
  }

  async readText(p) {
    try {
      const r = await this.read(p, { maxBytes: 4 * 1024 * 1024 });
      return r.content == null ? null : r.content;
    } catch (e) {
      if (e && (e.code === 2 || /No such file/i.test(e.message))) return null;
      throw e;
    }
  }

  async mkdirp(dir) {
    const s = await this._s();
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      try {
        await cb((done) => s.stat(cur, done));
      } catch {
        await cb((done) => s.mkdir(cur, done)).catch(() => {});
      }
    }
  }

  async write(p, content) {
    const f = await this.resolve(p);
    await this.mkdirp(path.dirname(f));
    const s = await this._s();
    // 先写临时文件再改名，避免写一半时被 Claude 读到
    const tmp = `${f}.cb-${Date.now()}.tmp`;
    await cb((done) => s.writeFile(tmp, Buffer.from(String(content), 'utf8'), done));
    await cb((done) => s.unlink(f, done)).catch(() => {});
    await cb((done) => s.rename(tmp, f, done));
    return { path: f };
  }

  async remove(p) {
    const f = await this.resolve(p);
    const home = await this.home();
    if (f === '/' || f === home) throw new Error('不能删除这个目录');
    // 目录用 rm -rf（SFTP 不能递归删除）
    const st = await this.stat(f);
    if (st.isDir) {
      const { shQuote } = require('./util');
      const r = await this.ssh.exec(`rm -rf -- ${shQuote(f)}`, { timeoutMs: 30000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || '删除失败');
    } else {
      const s = await this._s();
      await cb((done) => s.unlink(f, done));
    }
    return true;
  }
}

module.exports = { RemoteFs };
