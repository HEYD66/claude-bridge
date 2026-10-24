// 单独验证测试 SSH 服务器：exec、sftp、shell、反向端口转发
const { Client } = require('ssh2');
const net = require('net');
const { execFileSync } = require('child_process');
const { startSshServer } = require('./ssh-wsl-server');

const DISTRO = 'Ubuntu-24.04-Analysis';
const home = `/tmp/cbe2e-check-${Date.now()}`;
execFileSync('wsl.exe', ['-d', DISTRO, '--exec', 'mkdir', '-p', home]);

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

(async () => {
  const srv = await startSshServer({ distro: DISTRO, home, log: (...a) => process.env.LOG && console.log('[srv]', ...a) });
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject);
    conn.connect({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'test', hostVerifier: () => true });
  });
  check('连接 + 密码认证', true);

  const exec = (cmd, stdin) =>
    new Promise((resolve, reject) => {
      conn.exec(cmd, (err, s) => {
        if (err) return reject(err);
        let out = '';
        let code = null;
        s.on('data', (d) => (out += d));
        s.stderr.on('data', (d) => (out += d));
        s.on('exit', (c) => (code = c));
        s.on('close', () => resolve({ out, code }));
        if (stdin != null) s.end(stdin);
        else s.end();
      });
    });
  const r1 = await exec('echo "$HOME"; pwd; echo "multi\nline" | wc -l; exit 3');
  check('exec 输出/HOME/退出码', r1.out.includes(home) && r1.code === 3, JSON.stringify(r1));
  const r2 = await exec('cat > f.txt && cat f.txt', 'hello stdin\n');
  check('exec stdin', r2.out.includes('hello stdin'), JSON.stringify(r2.out));

  const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
  const cb = (fn) => new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v))));
  const rp = await cb((d) => sftp.realpath('.', d));
  check('sftp realpath', rp === home, rp);
  await cb((d) => sftp.writeFile(`${home}/s.txt`, Buffer.from('sftp 写入 ✓'), d));
  const rd = await cb((d) => sftp.readFile(`${home}/s.txt`, d));
  check('sftp 写入/读取', rd.toString() === 'sftp 写入 ✓', rd.toString());
  const list = await cb((d) => sftp.readdir(home, d));
  check('sftp readdir', list.some((x) => x.filename === 's.txt') && list.some((x) => x.filename === 'f.txt'), list.map((x) => x.filename).join(','));
  await cb((d) => sftp.mkdir(`${home}/sub`, d));
  const st = await cb((d) => sftp.stat(`${home}/sub`, d));
  check('sftp mkdir/stat 目录', st.isDirectory());
  await cb((d) => sftp.rename(`${home}/s.txt`, `${home}/sub/t.txt`, d));
  await cb((d) => sftp.unlink(`${home}/sub/t.txt`, d));
  const gone = await cb((d) => sftp.stat(`${home}/sub/t.txt`, d)).then(() => false, (e) => e.code === 2);
  check('sftp rename/unlink + NO_SUCH_FILE', gone);

  // shell + pty
  const shellOut = await new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', cols: 120, rows: 40 }, (err, s) => {
      if (err) return reject(err);
      let out = '';
      s.on('data', (d) => (out += d));
      setTimeout(() => s.write('stty size; echo SHELL_$((6*7)); exit\n'), 1500);
      s.on('close', () => resolve(out));
      setTimeout(() => resolve(out), 8000);
    });
  });
  check('shell + pty', /SHELL_42/.test(shellOut) && /40 120/.test(shellOut), JSON.stringify(shellOut.slice(-160)));

  // 反向端口转发：WSL 里连接服务器端口 → 本机的 echo 服务
  const echo = net.createServer((s) => s.on('data', (d) => s.write(`ECHO:${d}`)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  conn.on('tcp connection', (_info, accept) => {
    const ch = accept();
    const sock = net.connect(echo.address().port, '127.0.0.1');
    ch.pipe(sock).pipe(ch);
  });
  const port = await new Promise((res, rej) => conn.forwardIn('127.0.0.1', 0, (e, p) => (e ? rej(e) : res(p))));
  const r3 = await exec(`exec 3<>/dev/tcp/127.0.0.1/${port}; printf ping >&3; timeout 3 head -c 9 <&3`);
  check('反向端口转发（WSL → 本机）', r3.out.includes('ECHO:ping'), JSON.stringify(r3));

  // 断开
  let closed = false;
  conn.on('close', () => (closed = true));
  srv.dropAll();
  await new Promise((r) => setTimeout(r, 800));
  check('dropAll 断开客户端', closed);

  echo.close();
  srv.close();
  execFileSync('wsl.exe', ['-d', DISTRO, '--exec', 'rm', '-rf', home]);
  console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
