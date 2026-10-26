// 临时测试：本机后台进程 + 内置浏览器工具（直接调用 LocalTools，走真实窗口和 webview）
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = path.join(os.tmpdir(), 'cb-browser-test');
const share = path.join(os.tmpdir(), 'cb-browser-share');
const shots = path.join(os.tmpdir(), 'cb-browser-shots');
for (const d of [dir, share, shots]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
fs.mkdirSync(share, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
app.setPath('userData', dir);
fs.writeFileSync(
  path.join(dir, 'settings.json'),
  JSON.stringify({ ssh: { host: 'vps.example.com', username: 'dev' }, mcp: { enabled: true, roots: [share], allowCommands: true, confirmCommands: false, browser: true }, ui: { theme: 'dark' } }),
);
// 一个小网页：输入名字、点按钮后标题变化，并往控制台写一条错误
fs.writeFileSync(
  path.join(share, 'server.js'),
  `require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html; charset=utf-8'); s.end('<!doctype html><title>Test App</title><h1>Hello</h1><input id="q" placeholder="Name"><button onclick="document.querySelector(\\'h1\\').textContent = \\'Hi \\' + document.getElementById(\\'q\\').value; console.error(\\'clicked-ok\\')">Greet</button>'); }).listen(4789, () => console.log('ready at http://localhost:4789/'));\n`,
);

// 拿到主进程创建的 LocalTools 实例
const ft = require('../src/main/fs-tools');
const Orig = ft.LocalTools;
let tools = null;
ft.LocalTools = class extends Orig {
  constructor(o) {
    super(o);
    tools = this;
  }
};

require('../src/main/main.js');

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${String(extra).replace(/\s+/g, ' ').slice(0, 200)})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

let started = false;
app.on('browser-window-created', (_e, w) => {
  if (started) return;
  started = true;
  w.webContents.setBackgroundThrottling(false);
  w.webContents.once('did-finish-load', () => run(w).catch((e) => console.log(`ERROR ${e.stack}`)).finally(() => setTimeout(() => app.exit(results.every(Boolean) ? 0 : 1), 500)));
});

async function run(w) {
  await sleep(1500);
  const js = (code) => w.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const names = tools.list().map((t) => t.name);
  check('工具列表包含后台进程和浏览器工具', ['start_process', 'stop_process', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_console'].every((n) => names.includes(n)));

  let r = await tools.call('start_process', { command: 'node server.js', cwd: share, name: 'test server' });
  const id = (text(r).match(/Process (\w+)/) || [])[1];
  check('start_process 启动并识别网址', id && /Detected URLs: http:\/\/localhost:4789/.test(text(r)), text(r));

  r = await tools.call('browser_navigate', { url: 'localhost:4789' });
  check('browser_navigate 打开本机网址（不询问）', /Loaded: Test App/.test(text(r)), text(r));
  await sleep(300);
  const panel = await js(`return { shown: !document.querySelector('#browser').hidden, url: document.querySelector('#br-url').value, home: document.querySelector('#br-home').hidden }`);
  check('浏览器面板自动打开并显示网址', panel.shown && panel.url.includes('localhost:4789') && panel.home, JSON.stringify(panel));

  r = await tools.call('browser_snapshot', {});
  const snap = text(r);
  const inputRef = (snap.match(/\[(\d+)\] <input/) || [])[1];
  const btnRef = (snap.match(/\[(\d+)\] <button> Greet/) || [])[1];
  check('browser_snapshot 列出可交互元素', inputRef && btnRef && snap.includes('Hello'), snap.slice(0, 200));

  r = await tools.call('browser_type', { ref: Number(inputRef), text: 'Bob' });
  r = await tools.call('browser_click', { ref: Number(btnRef) });
  r = await tools.call('browser_snapshot', {});
  check('browser_type + browser_click 生效', text(r).includes('Hi Bob'), text(r).slice(-120));

  r = await tools.call('browser_console', {});
  check('browser_console 读到控制台输出（不含 Electron 自身的提示）', text(r).includes('clicked-ok') && !text(r).includes('Electron Security Warning'), text(r));

  r = await tools.call('browser_screenshot', {});
  const img = (r.content || []).find((c) => c.type === 'image');
  check('browser_screenshot 返回图片', img && img.mimeType === 'image/png' && img.data.length > 1000);

  r = await tools.call('browser_navigate', { url: 'file:///C:/Windows/win.ini' });
  check('拒绝非 http(s) 网址', r.isError && /Only http/.test(text(r)), text(r));

  const svc = await js(`return window.bridge.browserServices()`);
  check('界面能列出 Claude 启动的进程', svc.procs.some((p) => p.id === id && p.urls.includes('http://localhost:4789/')), JSON.stringify(svc.procs.map((p) => p.name)));

  r = await tools.call('read_process_output', { id });
  check('read_process_output', text(r).includes('ready at'), text(r));

  await js(`document.querySelector('#btn-br-home').click()`);
  // 端口检测（netstat）需要几秒
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await js(`return !document.querySelector('#br-home .spinner')`)) break;
  }
  const home = await js(`return { home: !document.querySelector('#br-home').hidden, items: [...document.querySelectorAll('#br-home .br-proc, #br-home .br-svc')].map((x) => x.textContent) }`);
  check('浏览器首页列出本机应用', home.home && home.items.some((t) => t.includes('test server')), JSON.stringify(home.items).slice(0, 200));
  const img2 = await w.capturePage();
  fs.writeFileSync(path.join(shots, 'browser-home.png'), img2.toPNG());

  await tools.call('browser_navigate', { url: 'http://localhost:4789/' });
  await sleep(500);
  const img3 = await w.capturePage();
  fs.writeFileSync(path.join(shots, 'browser-page.png'), img3.toPNG());

  r = await tools.call('stop_process', { id });
  await sleep(1500);
  r = await tools.call('list_processes', {});
  check('stop_process 结束进程', /stopped/.test(text(r)), text(r));
  let refused = false;
  try {
    await new Promise((resolve, reject) => require('http').get('http://127.0.0.1:4789/', resolve).on('error', reject));
  } catch {
    refused = true;
  }
  check('进程停止后端口已关闭', refused);

  console.log(results.every(Boolean) ? `ALL PASS (${results.length})` : `FAILED ${results.filter((x) => !x).length} / ${results.length}`);
  console.log(`shots: ${shots}`);
}
