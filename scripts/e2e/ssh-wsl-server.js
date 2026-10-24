// 测试用 SSH 服务器：用 ssh2 的 Server 在本机监听，把 exec / shell / sftp / 反向端口转发映射到 WSL。
// 只用于端到端测试（本机和 WSL 都没有 sshd）。HOME 指向一个临时目录，避免碰到 WSL 里真实的 ~/.claude。
const { Server, utils } = require('ssh2');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const { STATUS_CODE } = utils.sftp;

function startSshServer({ distro, home, user = 'root', password = 'test', log = () => {} }) {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const clients = new Set();
  const children = new Set();
  const unc = (p) => `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
  const env = [`HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`, 'SHELL=/bin/bash', 'LANG=C.UTF-8'];

  function wsl(args) {
    const child = spawn('wsl.exe', ['-d', distro, '--cd', home, '--exec', 'env', ...env, ...args], { windowsHide: true });
    children.add(child);
    child.on('close', () => children.delete(child));
    child.stdin.on('error', () => {});
    return child;
  }

  /** 把 SSH 通道和子进程的 stdio 接起来 */
  function pipeChannel(ch, child) {
    child.stdout.on('data', (d) => ch.write(d));
    child.stderr.on('data', (d) => (ch.stderr ? ch.stderr.write(d) : ch.write(d)));
    ch.on('data', (d) => child.stdin.write(d));
    ch.on('end', () => child.stdin.end());
    ch.on('close', () => {
      if (child.exitCode == null) child.kill();
    });
    child.on('close', (code) => {
      try {
        ch.exit(code == null ? 255 : code);
        ch.end();
      } catch {
        /* 通道已关闭 */
      }
    });
  }

  const normPath = (p) => {
    let v = String(p || '.');
    if (v === '.' || v === '') v = home;
    else if (!v.startsWith('/')) v = path.posix.join(home, v);
    return path.posix.normalize(v);
  };

  const toAttrs = (st) => ({
    mode: st.isDirectory() ? 0o40755 : st.isSymbolicLink() ? 0o120777 : 0o100644,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  });

  function serveSftp(sftp) {
    const handles = new Map();
    let seq = 0;
    const newHandle = (obj) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(++seq);
      handles.set(seq, obj);
      return b;
    };
    const getHandle = (b) => (b && b.length === 4 ? handles.get(b.readUInt32BE(0)) : null);
    const fail = (id, e) => {
      const code = e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : e && (e.code === 'EACCES' || e.code === 'EPERM') ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
      sftp.status(id, code, e ? e.message : '');
    };
    const guard = (fn) => (id, ...args) => {
      try {
        fn(id, ...args);
      } catch (e) {
        fail(id, e);
      }
    };
    sftp.on('REALPATH', guard((id, p) => {
      const r = normPath(p);
      sftp.name(id, [{ filename: r, longname: r, attrs: {} }]);
    }));
    sftp.on('STAT', guard((id, p) => sftp.attrs(id, toAttrs(fs.statSync(unc(normPath(p)))))));
    sftp.on('LSTAT', guard((id, p) => sftp.attrs(id, toAttrs(fs.lstatSync(unc(normPath(p)))))));
    sftp.on('OPENDIR', guard((id, p) => {
      const dir = normPath(p);
      const names = fs.readdirSync(unc(dir));
      sftp.handle(id, newHandle({ type: 'dir', dir, names, done: false }));
    }));
    sftp.on('READDIR', guard((id, hb) => {
      const h = getHandle(hb);
      if (!h || h.type !== 'dir') return sftp.status(id, STATUS_CODE.FAILURE, 'bad handle');
      if (h.done) return sftp.status(id, STATUS_CODE.EOF);
      h.done = true;
      const list = [];
      for (const n of h.names) {
        try {
          list.push({ filename: n, longname: n, attrs: toAttrs(fs.lstatSync(unc(path.posix.join(h.dir, n)))) });
        } catch {
          /* 读不到属性的条目跳过 */
        }
      }
      if (!list.length) return sftp.status(id, STATUS_CODE.EOF);
      return sftp.name(id, list);
    }));
    sftp.on('OPEN', guard((id, p, flags) => {
      const fd = fs.openSync(unc(normPath(p)), utils.sftp.flagsToString(flags) || 'r');
      sftp.handle(id, newHandle({ type: 'file', fd }));
    }));
    sftp.on('READ', guard((id, hb, offset, len) => {
      const h = getHandle(hb);
      if (!h || h.type !== 'file') return sftp.status(id, STATUS_CODE.FAILURE, 'bad handle');
      const buf = Buffer.alloc(len);
      const n = fs.readSync(h.fd, buf, 0, len, offset);
      if (!n) return sftp.status(id, STATUS_CODE.EOF);
      return sftp.data(id, buf.subarray(0, n));
    }));
    sftp.on('WRITE', guard((id, hb, offset, data) => {
      const h = getHandle(hb);
      if (!h || h.type !== 'file') return sftp.status(id, STATUS_CODE.FAILURE, 'bad handle');
      fs.writeSync(h.fd, data, 0, data.length, offset);
      sftp.status(id, STATUS_CODE.OK);
    }));
    sftp.on('FSTAT', guard((id, hb) => {
      const h = getHandle(hb);
      if (!h || h.type !== 'file') return sftp.status(id, STATUS_CODE.FAILURE, 'bad handle');
      sftp.attrs(id, toAttrs(fs.fstatSync(h.fd)));
    }));
    sftp.on('CLOSE', guard((id, hb) => {
      const h = getHandle(hb);
      if (h && h.type === 'file') fs.closeSync(h.fd);
      if (hb && hb.length === 4) handles.delete(hb.readUInt32BE(0));
      sftp.status(id, STATUS_CODE.OK);
    }));
    sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
    sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
    sftp.on('MKDIR', guard((id, p) => {
      fs.mkdirSync(unc(normPath(p)));
      sftp.status(id, STATUS_CODE.OK);
    }));
    sftp.on('RMDIR', guard((id, p) => {
      fs.rmdirSync(unc(normPath(p)));
      sftp.status(id, STATUS_CODE.OK);
    }));
    sftp.on('REMOVE', guard((id, p) => {
      fs.unlinkSync(unc(normPath(p)));
      sftp.status(id, STATUS_CODE.OK);
    }));
    sftp.on('RENAME', guard((id, a, b) => {
      fs.renameSync(unc(normPath(a)), unc(normPath(b)));
      sftp.status(id, STATUS_CODE.OK);
    }));
    sftp.on('READLINK', (id) => sftp.status(id, STATUS_CODE.OP_UNSUPPORTED));
    sftp.on('SYMLINK', (id) => sftp.status(id, STATUS_CODE.OP_UNSUPPORTED));
    sftp.on('close', () => {
      for (const h of handles.values()) {
        if (h.type === 'file') {
          try {
            fs.closeSync(h.fd);
          } catch {
            /* 忽略 */
          }
        }
      }
      handles.clear();
    });
  }

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    const forwards = new Map();
    clients.add(client);
    client.on('error', (e) => log('client error', e.message));
    client.on('close', () => {
      clients.delete(client);
      for (const s of forwards.values()) s.close();
      forwards.clear();
    });
    client.on('authentication', (ctx) => {
      if (ctx.username === user && ctx.method === 'password' && ctx.password === password) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const srv = net.createServer((sock) => {
            sock.on('error', () => {});
            client.forwardOut(info.bindAddr, srv.address().port, sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, (err, ch) => {
              if (err) {
                sock.destroy();
                return;
              }
              ch.on('error', () => sock.destroy());
              ch.on('close', () => sock.destroy());
              sock.on('close', () => ch.close());
              sock.pipe(ch).pipe(sock);
            });
          });
          srv.on('error', () => reject && reject());
          srv.listen(info.bindPort || 0, '127.0.0.1', () => {
            forwards.set(srv.address().port, srv);
            log('forward', srv.address().port);
            if (accept) accept(srv.address().port);
          });
        } else if (name === 'cancel-tcpip-forward') {
          const s = forwards.get(info.bindPort);
          if (s) s.close();
          forwards.delete(info.bindPort);
          if (accept) accept();
        } else if (reject) reject();
      });
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let pty = null;
        session.on('env', (accept) => accept && accept());
        session.on('pty', (accept, _reject, info) => {
          pty = info;
          if (accept) accept();
        });
        session.on('window-change', (accept) => accept && accept());
        session.on('exec', (accept, _reject, info) => {
          log('exec', info.command.slice(0, 120).replace(/\s+/g, ' '));
          pipeChannel(accept(), wsl(['bash', '-c', info.command]));
        });
        session.on('shell', (accept) => {
          const cols = (pty && pty.cols) || 100;
          const rows = (pty && pty.rows) || 30;
          // script 在 WSL 里分配一个真正的 pty
          pipeChannel(accept(), wsl(['env', 'TERM=xterm-256color', 'script', '-qfc', `stty cols ${cols} rows ${rows}; exec bash -l`, '/dev/null']));
        });
        session.on('sftp', (accept) => serveSftp(accept()));
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        /** 模拟断网：断开所有客户端 */
        dropAll() {
          for (const c of clients) c.end();
        },
        clientCount: () => clients.size,
        close() {
          for (const c of clients) c.end();
          for (const ch of children) ch.kill();
          server.close();
        },
      });
    });
  });
}

module.exports = { startSshServer };
