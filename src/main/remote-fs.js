'use strict';

/**
 * 服务器文件访问（SFTP）：文件浏览器、自定义页（CLAUDE.md、技能、子代理、设置文件）使用。
 * 路径支持 ~ 开头（相对服务器用户主目录）。
 */

const path = require('path').posix;
const { shQuote, remotePathExpr } = require('./util');

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
      const r = await this.ssh.exec(`rm -rf -- ${shQuote(f)}`, { timeoutMs: 30000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || '删除失败');
    } else {
      const s = await this._s();
      await cb((done) => s.unlink(f, done));
    }
    return true;
  }

  // ======================= 文件搜索 =======================

  /** 按文件名查找（不区分大小写，跳过 node_modules / .git 等），最多 200 条 */
  async find(root, query) {
    const dir = await this.resolve(root);
    const q = String(query || '').trim();
    if (!q || /[\0\n]/.test(q)) return { root: dir, results: [] };
    const pattern = `*${q.replace(/[[\]*?\\]/g, '\\$&')}*`;
    const script = [
      `cd ${shQuote(dir)} || exit 3`,
      `find . -maxdepth 8 \\( -name node_modules -o -name .git -o -name .venv -o -name __pycache__ -o -name dist -o -name build \\) -prune -o -iname ${shQuote(pattern)} -printf '%y %p\\n' 2>/dev/null | head -n 200`,
    ].join('\n');
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 30000 });
    if (r.code === 3) throw new Error(`目录不存在：${dir}`);
    const results = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(\S) \.\/(.+)$/);
      if (m) results.push({ path: m[2], type: m[1] === 'd' ? 'dir' : 'file' });
    }
    return { root: dir, results };
  }

  /** 按内容搜索（grep），返回匹配的文件和第一处匹配行，最多 100 个文件 */
  async grep(root, query) {
    const dir = await this.resolve(root);
    const q = String(query || '');
    if (!q.trim() || /[\0\n]/.test(q)) return { root: dir, results: [] };
    const script = [
      `cd ${shQuote(dir)} || exit 3`,
      `grep -rIn -m 1 -F -i --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv --exclude-dir=dist --exclude-dir=build -e ${shQuote(q)} . 2>/dev/null | head -n 100 | cut -c 1-400`,
    ].join('\n');
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 30000 });
    if (r.code === 3) throw new Error(`目录不存在：${dir}`);
    const results = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\.\/(.+?):(\d+):(.*)$/);
      if (m) results.push({ path: m[1], type: 'file', line: Number(m[2]), text: m[3].trim() });
    }
    return { root: dir, results };
  }

  // ======================= Git 改动 =======================

  /** 工作目录所在 git 仓库的改动列表；不是仓库时返回 { repo: false } */
  async gitStatus(workdir) {
    const script = [
      `cd ${remotePathExpr(workdir || '~')} 2>/dev/null || exit 3`,
      'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4',
      'echo "##ROOT $(git rev-parse --show-toplevel)"',
      'echo "##BRANCH $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
      'echo "##STATUS"',
      'git -c core.quotepath=off status --porcelain=v1 -uall 2>/dev/null | head -n 1000',
      'echo "##NUMSTAT"',
      // 新仓库还没有 HEAD 时，退回到暂存区和工作区的改动
      '{ git -c core.quotepath=off diff HEAD --numstat 2>/dev/null || git -c core.quotepath=off diff --cached --numstat 2>/dev/null; } | head -n 1000',
    ].join('\n');
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 30000 });
    if (r.code === 3 || r.code === 4) return { repo: false };
    const out = r.stdout;
    const root = ((out.match(/^##ROOT (.*)$/m) || [])[1] || '').trim();
    const branch = ((out.match(/^##BRANCH (.*)$/m) || [])[1] || '').trim();
    // 按标记行切分；某一段为空时不能把下一个标记行（如 ##NUMSTAT）当成文件
    // （porcelain 的状态行和 numstat 行都不会以 ## 开头）
    const lines = out.split('\n');
    const section = (name) => {
      const i = lines.indexOf(`##${name}`);
      if (i < 0) return [];
      const res = [];
      for (let k = i + 1; k < lines.length && !lines[k].startsWith('##'); k++) if (lines[k]) res.push(lines[k]);
      return res;
    };
    const unquote = (p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p);
    const stats = new Map();
    for (const line of section('NUMSTAT')) {
      const [a, d, ...rest] = line.split('\t');
      let p = rest.join('\t');
      // 重命名：old => new 或 dir/{old => new}
      if (p.includes(' => ')) p = p.replace(/\{[^{}]* => ([^{}]*)\}/, '$1').replace(/^.* => /, '');
      stats.set(unquote(p), { adds: a === '-' ? null : Number(a), dels: d === '-' ? null : Number(d) });
    }
    const files = [];
    for (const line of section('STATUS')) {
      const code = line.slice(0, 2);
      let p = line.slice(3);
      let from = null;
      if (p.includes(' -> ')) [from, p] = p.split(' -> ');
      p = unquote(p);
      const st = stats.get(p) || {};
      let status = 'modified';
      if (code === '??') status = 'untracked';
      else if (code.includes('A')) status = 'added';
      else if (code.includes('D')) status = 'deleted';
      else if (code.includes('R')) status = 'renamed';
      else if (code.includes('U')) status = 'conflict';
      files.push({ path: p, from: from ? unquote(from) : null, status, adds: st.adds ?? null, dels: st.dels ?? null, binary: st.adds === null && stats.has(p) });
    }
    return { repo: true, root, branch, files };
  }

  /** 单个文件相对 HEAD 的 diff（未跟踪文件显示为全部新增） */
  async gitDiff(repoRoot, file, { untracked = false } = {}) {
    const f = String(file || '');
    if (!f || /[\0\n]/.test(f) || f.startsWith('/') || f.split('/').includes('..')) throw new Error('无效的文件路径');
    const diff = untracked ? `git diff --no-index -- /dev/null ${shQuote(f)}` : `{ git diff HEAD -- ${shQuote(f)} 2>/dev/null || git diff --cached -- ${shQuote(f)}; }`;
    const script = `cd ${shQuote(repoRoot)} || exit 3\n${diff} | head -c 600000`;
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 30000 });
    if (r.code === 3) throw new Error('无法进入仓库目录');
    return { diff: r.stdout, truncated: r.stdout.length >= 600000 };
  }
}

module.exports = { RemoteFs };
