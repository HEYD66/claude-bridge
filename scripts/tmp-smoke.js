// 临时冒烟测试：用独立的 userData 写入示例对话，启动应用，模拟操作并截图
const { app, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

const dir = path.join(os.tmpdir(), 'cb-smoke');
const shots = path.join(os.tmpdir(), 'cb-smoke-shots');
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
fs.mkdirSync(shots, { recursive: true });
app.setPath('userData', dir);

const theme = process.env.SMOKE_THEME || 'light';
const now = Date.now();
const id = () => crypto.randomUUID();

// ---- 生成一张示例 PNG ----
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makePng(w, hgt) {
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 217;
      raw[o + 1] = (119 + x) % 256;
      raw[o + 2] = (87 + y * 2) % 256;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const png = makePng(120, 80);
fs.writeFileSync(path.join(dir, 'attachments', 'sample.png'), png);

// ---- 设置 / 额度 ----
fs.writeFileSync(
  path.join(dir, 'settings.json'),
  JSON.stringify({ ssh: { host: 'vps.example.com', port: 22, username: 'dev', authType: 'password' }, mcp: { enabled: true, roots: ['D:\\Docs'] }, ui: { theme } }),
);
fs.writeFileSync(
  path.join(dir, 'meta.json'),
  JSON.stringify({ rateLimits: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: Math.floor(now / 1000) + 7200 }, seven_day: { utilization: 0.78, resetsAt: Math.floor(now / 1000) + 3 * 86400 } }, at: now - 60000 } }),
);

// ---- 示例对话 ----
const text = (key, en, zh) => ({ type: 'text', key, text: en, zh, zhStatus: zh ? 'done' : undefined, final: true });
function save(conv) {
  fs.writeFileSync(path.join(dir, 'conversations', `${conv.id}.json`), JSON.stringify(conv));
  return conv;
}

const aId = id();
const a2 = id();
const convA = save({
  id: aId,
  title: '修复登录接口的空指针',
  createdAt: now - 3600e3,
  updatedAt: now - 60e3,
  sessionId: id(),
  sessionIds: [],
  mode: 'code',
  workdir: '~/projects/demo',
  messages: [
    { id: id(), role: 'user', text: '登录接口偶尔报空指针，帮我查一下', en: 'The login API occasionally throws a null pointer, please take a look', status: 'sent', slotId: 's1', ts: now - 3500e3 },
    {
      id: id(),
      role: 'assistant',
      status: 'done',
      ts: now - 3400e3,
      model: 'claude-opus-4-5-20251101',
      meta: { tokens: 15234, contextTokens: 42000, contextWindow: 200000, durationMs: 12300, costUsd: 0.0123, turns: 3 },
      notices: [],
      blocks: [
        { type: 'thinking', key: 'a1-0', text: 'Let me look at auth.js first.', final: true },
        text('a1-1', 'I found the issue in `auth.js`.', '我在 `auth.js` 中找到了问题。'),
        { type: 'tool_use', key: 'a1-2', name: 'Bash', input: { command: 'grep -n "user.id" src/auth.js', description: 'Find usages' }, done: true, result: '12:  const id = user.id;' },
        {
          type: 'tool_use',
          key: 'a1-3',
          name: 'Edit',
          input: { file_path: '/home/dev/projects/demo/src/auth.js', old_string: '  const id = user.id;', new_string: '  if (!user) return null;\n  const id = user.id;' },
          done: true,
          result: 'ok',
          structured: { type: 'update', filePath: '/home/dev/projects/demo/src/auth.js', structuredPatch: [{ oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, lines: [' function login(user) {', '-  const id = user.id;', '+  if (!user) return null;', '+  const id = user.id;', '   return id;', ' }'] }] },
        },
        {
          type: 'tool_use',
          key: 'a1-4',
          name: 'TodoWrite',
          input: { todos: [{ content: '定位空指针', status: 'completed', activeForm: '正在定位空指针' }, { content: '修复 auth.js', status: 'in_progress', activeForm: '正在修复 auth.js' }, { content: '运行测试', status: 'pending', activeForm: '正在运行测试' }] },
          done: true,
          result: '',
        },
        {
          type: 'tool_use',
          key: 'a1-5',
          name: 'Agent',
          input: { description: '检查其它接口', prompt: 'Check other endpoints for the same bug', subagent_type: 'general-purpose' },
          done: true,
          result: 'No other issues',
          sub: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'user.id' }, done: true }, { type: 'text', text: 'Only auth.js is affected.' }],
          task: { status: 'completed', summary: '只有 auth.js 受影响', subagentType: 'general-purpose' },
        },
        text('a1-6', 'Fixed. Shall I run the tests?', '已修复。要我运行测试吗？'),
      ],
    },
    { id: id(), role: 'user', text: '运行测试', en: 'Run the tests', status: 'sent', slotId: 's2', ts: now - 120e3 },
    {
      id: a2,
      role: 'assistant',
      status: 'running',
      ts: now - 100e3,
      notices: [],
      blocks: [
        text('a2-0', 'I will run the test suite.', '我来运行测试套件。'),
        {
          type: 'permission',
          key: 'a2-1',
          kind: 'tool',
          requestId: 'r1',
          toolName: 'Bash',
          displayName: 'Bash',
          input: { command: 'npm test', description: 'Run the test suite' },
          description: 'Run the test suite',
          descriptionZh: '运行测试套件',
          suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
          status: 'pending',
        },
      ],
    },
    { id: id(), role: 'user', text: '顺便更新一下 README', status: 'queued', ts: now - 30e3 },
  ],
  slots: { s2: { versions: [{ messages: [], sessionId: null }, null], current: 1 } },
  run: { id: 'run1', offset: 0, pending: [], currentMsgId: a2 },
  context: {
    totalTokens: 52000,
    maxTokens: 200000,
    percentage: 26,
    categories: [
      { name: 'System prompt', tokens: 3000 },
      { name: 'System tools', tokens: 12000 },
      { name: 'Messages', tokens: 37000 },
      { name: 'Free space', tokens: 148000, kind: 'free' },
    ],
    at: now - 90e3,
  },
});

save({
  id: id(),
  title: '选择数据库方案',
  createdAt: now - 7200e3,
  updatedAt: now - 1800e3,
  sessionId: id(),
  mode: 'code',
  workdir: '~/projects/demo',
  run: { id: 'run2', offset: 0, pending: [] },
  messages: [
    { id: id(), role: 'user', text: '帮我设计数据存储', status: 'sent', ts: now - 1900e3 },
    {
      id: id(),
      role: 'assistant',
      status: 'running',
      ts: now - 1850e3,
      notices: [],
      blocks: [
        {
          type: 'permission',
          key: 'b1',
          kind: 'question',
          requestId: 'r2',
          toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'Which database should we use?', header: 'Database', multiSelect: false, options: [{ label: 'PostgreSQL', description: 'Relational database' }, { label: 'SQLite', description: 'Embedded database' }] }] },
          zh: { q0: '我们应该使用哪个数据库？', q0o0: '关系型数据库', q0o1: '嵌入式数据库' },
          status: 'pending',
        },
      ],
    },
  ],
});

save({
  id: id(),
  title: '重构用户模块',
  createdAt: now - 86400e3,
  updatedAt: now - 5400e3,
  sessionId: id(),
  mode: 'code',
  pinned: true,
  workdir: '~/work/api',
  run: { id: 'run3', offset: 0, pending: [] },
  messages: [
    { id: id(), role: 'user', text: '重构用户模块，先给计划', status: 'sent', ts: now - 5500e3 },
    {
      id: id(),
      role: 'assistant',
      status: 'running',
      ts: now - 5450e3,
      notices: [],
      blocks: [
        {
          type: 'permission',
          key: 'c1',
          kind: 'plan',
          requestId: 'r3',
          toolName: 'ExitPlanMode',
          input: { plan: '## Plan\n1. Split user.js\n2. Add unit tests' },
          plan: '## Plan\n1. Split user.js\n2. Add unit tests',
          planZh: '## 计划\n1. 拆分 `user.js` 为 service 与 controller\n2. 为新模块补充单元测试\n3. 运行全部测试',
          status: 'pending',
        },
      ],
    },
  ],
});

save({
  id: id(),
  title: '看一下这个截图里的报错',
  createdAt: now - 2 * 86400e3,
  updatedAt: now - 2 * 86000e3,
  sessionId: id(),
  mode: 'code',
  workdir: '~/work/api',
  suggestion: { text: 'Run the failing test again', zh: '再运行一次失败的测试' },
  messages: [
    { id: id(), role: 'user', text: '看一下这个截图里的报错', images: [{ file: 'sample.png', mediaType: 'image/png', name: 'error.png', size: png.length }], status: 'sent', ts: now - 2 * 86100e3 },
    {
      id: id(),
      role: 'assistant',
      status: 'done',
      ts: now - 2 * 86050e3,
      model: 'claude-sonnet-4-5',
      meta: { tokens: 3200, contextTokens: 9000, contextWindow: 200000, durationMs: 4100 },
      notices: [],
      blocks: [text('d1', 'The screenshot shows a **TypeError**.', '截图显示的是一个 **TypeError**。')],
    },
  ],
});

save({
  id: id(),
  title: '整理桌面文件',
  createdAt: now - 4000e3,
  updatedAt: now - 3000e3,
  sessionId: id(),
  mode: 'cowork',
  workdir: '~',
  messages: [
    { id: id(), role: 'user', text: '帮我看看桌面上有什么', status: 'sent', ts: now - 3100e3 },
    {
      id: id(),
      role: 'assistant',
      status: 'done',
      ts: now - 3050e3,
      model: 'claude-sonnet-4-5',
      notices: [],
      blocks: [
        { type: 'tool_use', key: 'e0', name: 'mcp__local_pc__desktop_Snapshot', input: { use_vision: false }, done: true, result: 'Desktop: 12 icons' },
        { type: 'tool_use', key: 'e1', name: 'mcp__local_pc__list_directory', input: { path: 'D:\\Docs' }, done: true, result: 'a.txt\nb.docx' },
        text('e2', 'Your desktop has 12 icons.', '你的桌面上有 12 个图标。'),
      ],
    },
  ],
});

// ---- 启动应用 ----
require('../src/main/main.js');

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let winCount = 0;
let secondWindow = null;
app.on('browser-window-created', (_e, w) => {
  const n = ++winCount;
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') errors.push(`[win${n} console ${e.level}] ${e.message}`);
  });
  w.webContents.on('did-fail-load', (_ev, code, desc, url) => errors.push(`[load fail] ${code} ${desc} ${url}`));
  w.webContents.on('render-process-gone', (_ev, d) => errors.push(`[crash] ${JSON.stringify(d)}`));
  if (n === 1) {
    w.webContents.once('did-finish-load', () =>
      run(w).catch((err) => {
        errors.push(`[smoke] ${err.stack || err}`);
        finish();
      }),
    );
  } else {
    secondWindow = new Promise((resolve) => w.webContents.once('did-finish-load', () => resolve(w)));
  }
});

function finish() {
  console.log('==== SMOKE ERRORS ====');
  console.log(errors.length ? errors.join('\n') : '(none)');
  console.log(`shots: ${shots}`);
  setTimeout(() => app.exit(0), 300);
}

async function run(w) {
  const js = (code) => w.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const shot = async (name, wait = 500) => {
    await sleep(wait);
    const img = await w.capturePage();
    fs.writeFileSync(path.join(shots, `${theme}-${name}.png`), img.toPNG());
  };
  const clickConv = (title) => js(`const el = [...document.querySelectorAll('.conv-item')].find((x) => x.title === ${JSON.stringify(title)}); if (!el) throw new Error('conv not found: ' + ${JSON.stringify(title)}); el.click();`);
  const report = async (label, code) => {
    const v = await js(code);
    console.log(`[check] ${label}: ${JSON.stringify(v)}`);
  };

  // 预置斜杠命令缓存后重新加载一次
  await js(`localStorage.setItem('slashCommands', JSON.stringify(['compact', 'context', 'config', 'review'])); location.reload();`).catch(() => {});
  await sleep(1800);
  await shot('01-home');
  await report('sidebar groups', `return [...document.querySelectorAll('.group-head .group-name')].map((x) => x.textContent)`);

  await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === '额度').click()`);
  await shot('02-home-limits');

  await clickConv('修复登录接口的空指针');
  await sleep(600);
  await report('conv A', `return { msgs: document.querySelectorAll('#messages .msg').length, perm: document.querySelectorAll('.perm-card').length, todo: !document.querySelector('#todo-bar').hidden, todoText: document.querySelector('#todo-bar').textContent, variants: document.querySelector('.variants')?.textContent, queued: [...document.querySelectorAll('.tr-note')].map((x) => x.textContent), ring: document.querySelector('#ctx-ring').title, stopHidden: document.querySelector('#btn-stop').hidden }`);
  await shot('03-conv-a-bottom');
  await js(`document.querySelectorAll('.tool .tool-head').forEach((b) => { if (!b.closest('.tool').classList.contains('open')) b.click(); }); document.querySelector('#todo-bar .tb-head')?.click(); document.querySelector('#chat').scrollTop = 0;`);
  await shot('04-conv-a-top-expanded');
  await js(`document.querySelector('#chat').scrollTop = 900;`);
  await shot('05-conv-a-middle');

  await js(`document.querySelector('#ctx-ring').click()`);
  await shot('06-ctx-popover');
  await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

  // ↑ 编辑上一条用户消息
  await js(`const i = document.querySelector('#input'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));`);
  await sleep(200);
  await report('edit mode', `return { editing: !!document.querySelector('.msg.user.editing textarea') }`);
  await js(`document.querySelector('.msg.user.editing .edit-foot .btn')?.click()`);

  // 粘贴图片
  await js(`
    const b64 = ${JSON.stringify(png.toString('base64'))};
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], 'paste.png', { type: 'image/png' }));
    const i = document.querySelector('#input');
    i.focus();
    i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  `);
  await sleep(300);
  await js(`const i = document.querySelector('#input'); i.value = '/com'; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await sleep(200);
  await report('attachments + slash', `return { attach: document.querySelectorAll('#attach-row .attach').length, sendDisabled: document.querySelector('#btn-send').disabled, slash: !document.querySelector('#slash-pop').hidden }`);
  await shot('07-attach-slash');
  await js(`const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#attach-row .rm')?.click();`);

  await clickConv('选择数据库方案');
  await shot('08-question');
  await js(`document.querySelector('.q-opt input').click(); document.querySelector('.q-other').value = '也可以考虑 MySQL';`);

  await clickConv('重构用户模块');
  await shot('09-plan');

  await clickConv('看一下这个截图里的报错');
  await sleep(300);
  await report('conv D', `return { suggest: document.querySelector('#suggest').hidden ? null : document.querySelector('#suggest').textContent, img: document.querySelector('.msg-images img')?.naturalWidth, head: document.querySelector('#conv-head').textContent }`);
  await shot('10-image-suggest');
  // Tab 填入建议，↑ 编辑上一条，Shift+Tab 切换权限模式
  await js(`const i = document.querySelector('#input'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));`);
  await report('tab suggestion', `return document.querySelector('#input').value`);
  await js(`const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));`);
  await sleep(200);
  await report('edit mode', `return { editing: !!document.querySelector('.msg.user.editing textarea'), value: document.querySelector('.msg.user.editing textarea')?.value }`);
  await shot('10b-edit');
  await js(`document.querySelector('.msg.user.editing .edit-foot .btn').click()`);
  await js(`const i = document.querySelector('#input'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));`);
  await sleep(500);
  await report('shift+tab perm', `return document.querySelector('#btn-perm').textContent`);
  await js(`const i = document.querySelector('#input'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));`);
  await sleep(600);
  await report('perm cycled back', `return document.querySelector('#btn-perm').textContent`);
  await js(`const i = document.querySelector('#input'); i.value = '/co'; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  await sleep(200);
  await report('slash', `return [...document.querySelectorAll('#slash-pop .slash-name')].map((x) => x.textContent)`);
  await shot('10c-slash');
  await js(`const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#slash-pop').hidden = true;`);

  // 侧边栏全文搜索
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); const s = document.querySelector('#search-input'); s.value = 'TypeError'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await sleep(700);
  await report('search', `return [...document.querySelectorAll('.search-hit')].map((x) => x.textContent)`);
  await shot('11-search');
  await js(`const s = document.querySelector('#search-input'); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);

  // 对话菜单
  await js(`document.querySelector('.conv-item .conv-more').click()`);
  await shot('12-conv-menu');
  await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

  // 权限菜单
  await js(`document.querySelector('#btn-perm').click()`);
  await shot('13-perm-menu');
  await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

  // Cowork 模式
  await js(`document.querySelector('#mode-cowork').click()`);
  await sleep(400);
  await report('cowork home', `return { groups: [...document.querySelectorAll('.group-head .group-name')].map((x) => x.textContent), starters: document.querySelectorAll('.starter').length, greet: document.querySelector('#greet-text').textContent, chips: [...document.querySelectorAll('#chips .chip')].map((x) => x.textContent) }`);
  await shot('14-cowork-home');
  await clickConv('整理桌面文件');
  await shot('15-cowork-conv');

  // 账号菜单
  await js(`document.querySelector('#account').click()`);
  await shot('16-account-menu');
  await js(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

  // 设置
  await js(`document.querySelector('#mode-code').click()`);
  await sleep(300);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
  await shot('17-settings');
  await js(`document.querySelector('.overlay .dialog-foot .btn').click()`);

  // 后退
  await js(`document.querySelector('#btn-back').click()`);
  await sleep(400);
  await report('after back', `return document.querySelector('#conv-head .t')?.textContent || '(home)'`);

  // 在新窗口中打开对话
  await js(`document.querySelector('#mode-code').click()`);
  await sleep(300);
  await js(`const el = [...document.querySelectorAll('.conv-item')].find((x) => x.title === '选择数据库方案'); el.querySelector('.conv-more').click(); await new Promise((r) => setTimeout(r, 100)); [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('新窗口')).click();`);
  await sleep(500);
  const w2 = await Promise.race([secondWindow || Promise.resolve(null), sleep(8000).then(() => null)]);
  if (!w2) errors.push('[smoke] 新窗口没有打开');
  else {
    await sleep(1200);
    const head = await w2.webContents.executeJavaScript(`document.querySelector('#conv-head .t')?.textContent || '(home)'`);
    console.log(`[check] second window: ${JSON.stringify(head)}`);
    const img = await w2.capturePage();
    fs.writeFileSync(path.join(shots, `${theme}-19-second-window.png`), img.toPNG());
    w2.close();
  }

  if (theme === 'light') {
    nativeTheme.themeSource = 'dark';
    await clickConv('修复登录接口的空指针');
    await js(`document.querySelectorAll('.tool .tool-head').forEach((b) => { if (!b.closest('.tool').classList.contains('open')) b.click(); }); document.querySelector('#chat').scrollTop = 0;`);
    await shot('18-dark-conv-a', 800);
    await js(`document.querySelector('#chat').scrollTop = 99999;`);
    await shot('18b-dark-conv-a-bottom');
    await js(`document.querySelector('#mode-cowork').click()`);
    await shot('18c-dark-cowork-home', 700);
  }
  finish();
}
