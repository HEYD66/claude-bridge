// 生成 README 用的截图（docs/screenshots/*.png）
// 全部是演示数据：虚构的服务器、项目和对话；服务器连接、Git 改动、文件列表都是模拟的，不会连接任何服务器。
// 运行：npx electron scripts/screenshots.js
const { app, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const dir = path.join(os.tmpdir(), 'cb-shots-data');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', dir);

const now = Date.now();
const DAY = 864e5;
const id = () => crypto.randomUUID();
const HOME = '/home/dev';

// ---------------- 演示设置 ----------------
fs.writeFileSync(
  path.join(dir, 'settings.json'),
  JSON.stringify({
    ssh: { host: 'vps.example.com', port: 22, username: 'dev', authType: 'key' },
    claude: { workdir: '~/projects/shop-api', permissionMode: '', effort: 'high' },
    mcp: { enabled: true, roots: ['D:\\Projects\\shop-web'], allowCommands: true, browser: true },
    translation: { enabled: true, translateInput: true, translateOutput: true },
    ui: { theme: 'dark', displayName: '小明' },
  }),
);
fs.writeFileSync(
  path.join(dir, 'meta.json'),
  JSON.stringify({ rateLimits: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.36, resetsAt: Math.floor(now / 1000) + 9000 }, seven_day: { utilization: 0.58, resetsAt: Math.floor(now / 1000) + 3 * 86400 } }, at: now - 120e3 } }),
);

// ---------------- 模拟：已连接的服务器、Git 改动、文件列表 ----------------
const sshMod = require('../src/main/ssh-manager');
const OrigSsh = sshMod.SshManager;
sshMod.SshManager = class extends OrigSsh {
  constructor(o) {
    super(o);
    this.forward = { remotePort: 40123, localPort: 0 };
  }
  getStatus() {
    return { ...super.getStatus(), state: 'connected', error: '', tunnelError: '' };
  }
  isConnected() {
    return false; // 不做任何真实的远程操作
  }
};

const cmMod = require('../src/main/chat-manager');
const OrigCm = cmMod.ChatManager;
cmMod.ChatManager = class extends OrigCm {
  constructor(o) {
    super(o);
    this.claudeInfo = {
      version: '2.1.296',
      account: { email: 'dev@example.com', subscriptionType: 'max' },
      models: [
        { value: 'default', name: 'Default', description: 'Use the default model (currently Opus 4.5)', descriptionZh: '使用默认模型（当前为 Opus 4.5）', resolved: 'claude-opus-4-5', supportsEffort: true, effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 4.5 for everyday tasks', descriptionZh: 'Sonnet 4.5，适合日常任务', resolved: 'claude-sonnet-4-5', supportsEffort: true, effort: ['low', 'medium', 'high'] },
        { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5, fastest', descriptionZh: 'Haiku 4.5，速度最快', resolved: 'claude-haiku-4-5', supportsEffort: false },
      ],
      commands: ['compact', 'context', 'review', 'init', 'cost', 'memory'].map((name) => ({ name, description: '' })),
    };
  }
  async gitBranch() {
    return 'main';
  }
};

const rfsMod = require('../src/main/remote-fs');
const TREE = {
  [`${HOME}/projects/shop-api`]: [
    ['src', 'dir'],
    ['tests', 'dir'],
    ['.env.example', 'file', 312],
    ['package.json', 'file', 1180],
    ['README.md', 'file', 2410],
  ],
  [`${HOME}/projects/shop-api/src`]: [
    ['routes', 'dir'],
    ['db.js', 'file', 1630],
    ['server.js', 'file', 980],
  ],
  [`${HOME}/projects/shop-api/src/routes`]: [
    ['orders.js', 'file', 3260],
    ['users.js', 'file', 2140],
  ],
};
Object.assign(rfsMod.RemoteFs.prototype, {
  async home() {
    return HOME;
  },
  async resolve(p) {
    const v = String(p || '~');
    return v === '~' ? HOME : v.startsWith('~/') ? `${HOME}${v.slice(1)}` : v;
  },
  async list(p) {
    const dirPath = await this.resolve(p);
    const entries = (TREE[dirPath] || []).map(([name, type, size]) => ({ name, type, size: size || 0, mtime: now - 3600e3 }));
    return { path: dirPath, home: HOME, entries };
  },
  async gitStatus() {
    return {
      repo: true,
      root: `${HOME}/projects/shop-api`,
      branch: 'main',
      files: [
        { path: 'src/routes/orders.js', status: 'modified', adds: 18, dels: 4 },
        { path: 'src/db.js', status: 'modified', adds: 6, dels: 1 },
        { path: 'tests/orders.test.js', status: 'added', adds: 42, dels: 0 },
      ],
    };
  },
});

// ---------------- 演示对话 ----------------
const text = (zh, en) => ({ type: 'text', key: id(), text: en, zh, zhStatus: 'done', final: true });
const tool = (name, input, result, extra = {}) => ({ type: 'tool_use', key: id(), name, input, done: true, result, ...extra });
const meta = (tokens, model = 'claude-opus-4-5') => ({ tokens, models: { [model]: tokens }, modelsIO: { [model]: { in: Math.round(tokens * 0.93), out: Math.round(tokens * 0.07) } }, contextTokens: 61000, contextWindow: 200000, durationMs: 48200, turns: 6 });
function save(conv) {
  fs.writeFileSync(path.join(dir, 'conversations', `${conv.id}.json`), JSON.stringify({ sessionIds: [], ...conv }));
  return conv;
}

const ORDERS_PATCH = [
  {
    oldStart: 8,
    oldLines: 7,
    newStart: 8,
    newLines: 13,
    lines: [
      " router.get('/orders', async (req, res) => {",
      '-  const orders = await db.orders.findAll();',
      '-  res.json(orders);',
      '+  const page = Math.max(1, parseInt(req.query.page, 10) || 1);',
      '+  const pageSize = Math.min(100, parseInt(req.query.pageSize, 10) || 20);',
      '+  const [items, total] = await Promise.all([',
      '+    db.orders.findAll({ offset: (page - 1) * pageSize, limit: pageSize }),',
      '+    db.orders.count(),',
      '+  ]);',
      '+  res.json({ items, total, page, pageSize });',
      ' });',
      ' ',
      ' module.exports = router;',
    ],
  },
];

const mainId = id();
save({
  id: mainId,
  title: '给订单接口加上分页',
  run: { id: 'demo-run', offset: 0, pending: {} }, // 有运行记录时，载入不会把等待中的卡片标成已失效
  createdAt: now - 3 * 3600e3,
  updatedAt: now - 60e3,
  sessionId: id(),
  mode: 'code',
  workdir: '~/projects/shop-api',
  context: { totalTokens: 61000, maxTokens: 200000, percentage: 30.5, categories: [{ name: 'System prompt', tokens: 3100 }, { name: 'System tools', tokens: 14200 }, { name: 'MCP tools', tokens: 2600 }, { name: 'Messages', tokens: 41100 }, { name: 'Free space', tokens: 139000, kind: 'free' }], at: now - 60e3 },
  messages: [
    { id: id(), role: 'user', text: '给 /orders 接口加上分页，默认每页 20 条', en: 'Add pagination to the /orders endpoint, with 20 items per page by default.', status: 'sent', ts: now - 3 * 3600e3 },
    {
      id: id(),
      role: 'assistant',
      status: 'done',
      ts: now - 3 * 3600e3 + 60e3,
      model: 'claude-opus-4-5',
      meta: meta(186000),
      notices: [],
      blocks: [
        { type: 'thinking', key: id(), text: 'Look at the orders route first.', final: true },
        text('我先看一下现有的订单路由和数据库封装。', 'Let me look at the existing orders route and the DB helper first.'),
        tool('Grep', { pattern: 'router.get\\(.\\/orders', path: 'src' }, 'src/routes/orders.js:8'),
        tool('Read', { file_path: `${HOME}/projects/shop-api/src/routes/orders.js` }, '(32 lines)'),
        tool('Edit', { file_path: `${HOME}/projects/shop-api/src/routes/orders.js`, old_string: '', new_string: '' }, 'ok', { structured: { type: 'update', filePath: `${HOME}/projects/shop-api/src/routes/orders.js`, structuredPatch: ORDERS_PATCH } }),
        tool('Bash', { command: 'npm test', description: 'Run the test suite' }, 'Test Suites: 6 passed, 6 total\nTests:       24 passed, 24 total'),
        text(
          '分页已经加好了：\n\n- `GET /orders?page=2&pageSize=20`\n- 返回 `items`、`total`、`page`、`pageSize`\n- `pageSize` 最大 100，防止一次拉取太多\n\n测试全部通过（24 个）。',
          'Pagination is in place:\n\n- `GET /orders?page=2&pageSize=20`\n- Returns `items`, `total`, `page`, `pageSize`\n- `pageSize` is capped at 100\n\nAll 24 tests pass.',
        ),
      ],
    },
    { id: id(), role: 'user', text: '前端订单列表也改成分页，然后在我电脑上跑起来看看效果', en: 'Also paginate the order list in the frontend, then run it on my PC so I can see how it looks.', status: 'sent', ts: now - 20 * 60e3 },
    {
      id: id(),
      role: 'assistant',
      status: 'running',
      ts: now - 19 * 60e3,
      model: 'claude-opus-4-5',
      notices: [],
      blocks: [
        tool('TodoWrite', {
          todos: [
            { content: '修改前端订单列表', status: 'completed', activeForm: '正在修改前端订单列表' },
            { content: '在本机启动开发服务器并预览', status: 'completed', activeForm: '正在本机启动开发服务器' },
            { content: '提交改动', status: 'in_progress', activeForm: '正在提交改动' },
          ],
        }, ''),
        tool('mcp__local_pc__edit_file', { path: 'D:\\Projects\\shop-web\\src\\OrderList.vue' }, 'Edited D:\\Projects\\shop-web\\src\\OrderList.vue'),
        tool('mcp__local_pc__start_process', { command: 'npm run dev', cwd: 'D:\\Projects\\shop-web', name: 'vite dev server' }, 'Detected URLs: http://localhost:5173/'),
        tool('mcp__local_pc__browser_navigate', { url: 'http://localhost:5173/orders' }, 'Loaded: 订单管理'),
        text('前端分页已经在你的电脑上跑起来了，右侧浏览器里能看到效果。接下来把两个项目的改动提交。', 'The paginated order list is running on your PC — see the browser on the right. Next I will commit the changes.'),
        {
          type: 'permission',
          key: id(),
          kind: 'tool',
          requestId: 'demo-1',
          toolName: 'Bash',
          displayName: 'Bash',
          input: { command: 'git add -A && git commit -m "feat: paginate /orders"', description: 'Commit the changes' },
          description: 'Commit the changes',
          descriptionZh: '提交改动',
          suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git commit:*' }], behavior: 'allow', destination: 'localSettings' }],
          status: 'pending',
        },
      ],
    },
  ],
});

save({
  id: id(),
  title: '数据库迁移方案',
  run: { id: 'demo-run', offset: 0, pending: {} }, // 有运行记录时，载入不会把等待中的卡片标成已失效
  createdAt: now - 2 * DAY,
  updatedAt: now - 2 * DAY + 3600e3,
  sessionId: id(),
  mode: 'code',
  workdir: '~/projects/shop-api',
  messages: [
    { id: id(), role: 'user', text: '订单表要拆分，先给我一个迁移计划', en: 'We need to split the orders table. Give me a migration plan first.', status: 'sent', ts: now - 2 * DAY },
    {
      id: id(),
      role: 'assistant',
      status: 'running',
      ts: now - 2 * DAY + 60e3,
      notices: [],
      blocks: [
        {
          type: 'permission',
          key: id(),
          kind: 'plan',
          requestId: 'demo-2',
          toolName: 'ExitPlanMode',
          input: {},
          plan: '## Plan',
          planZh: '## 订单表拆分计划\n\n1. 新建 `order_items` 表，把明细从 `orders.items` JSON 列迁出\n2. 写一次性迁移脚本，分批（每批 1000 条）复制数据\n3. 接口同时读新旧两处，灰度一周\n4. 确认无误后删除旧列\n\n**风险**：迁移期间写入会双写，需要先给 `orders` 加更新时间索引。',
          status: 'pending',
        },
      ],
    },
  ],
});

save({
  id: id(),
  title: '博客首页加载慢',
  run: { id: 'demo-run', offset: 0, pending: {} }, // 有运行记录时，载入不会把等待中的卡片标成已失效
  createdAt: now - 4 * DAY,
  updatedAt: now - 4 * DAY + 5400e3,
  sessionId: id(),
  mode: 'code',
  workdir: '~/projects/blog',
  messages: [
    { id: id(), role: 'user', text: '博客首页打开要 4 秒，帮我查一下原因', en: 'The blog homepage takes 4 seconds to load. Please find out why.', status: 'sent', ts: now - 4 * DAY },
    {
      id: id(),
      role: 'assistant',
      status: 'running',
      ts: now - 4 * DAY + 60e3,
      notices: [],
      blocks: [
        text('我找到两个可能的原因，想先确认一下你的部署方式。', 'I found two likely causes. Let me check how you deploy first.'),
        {
          type: 'permission',
          key: id(),
          kind: 'question',
          requestId: 'demo-3',
          toolName: 'AskUserQuestion',
          input: { questions: [{ question: 'How is the blog deployed?', header: '部署', multiSelect: false, options: [{ label: 'Nginx + 静态文件', description: 'Static files' }, { label: 'Node 服务端渲染', description: 'SSR' }, { label: 'Docker', description: 'Container' }] }] },
          zh: { q0: '博客现在是怎么部署的？', q0o0: '直接用 Nginx 提供构建后的文件', q0o1: '每次请求由 Node 渲染页面', q0o2: '运行在 Docker 容器里' },
          status: 'pending',
        },
      ],
    },
  ],
});

save({ id: id(), title: '部署脚本整理', createdAt: now - 9 * DAY, updatedAt: now - 5 * DAY, sessionId: id(), mode: 'code', pinned: true, workdir: '~/ops', messages: [] });
save({ id: id(), title: '整理下载文件夹', createdAt: now - DAY, updatedAt: now - DAY, sessionId: id(), mode: 'cowork', workdir: '~', messages: [] });

// 统计用的历史消息（让首页的热力图和模型统计有内容）
const history = [];
for (let d = 1; d < 120; d++) {
  if ((d * 7) % 5 === 0 || d % 11 === 0) continue;
  const n = 1 + ((d * 13) % 6);
  for (let k = 0; k < n; k++) {
    // 白天的工作时间（上午 10 点起），首页“高峰时段”才像样
    const day = new Date(now - d * DAY);
    day.setHours(10, 0, 0, 0);
    const ts = day.getTime() + k * 40 * 60e3;
    const model = k % 4 === 3 ? 'claude-sonnet-4-5' : k % 7 === 6 ? 'claude-haiku-4-5' : 'claude-opus-4-5';
    history.push({ id: id(), role: 'user', text: '…', status: 'sent', ts }, { id: id(), role: 'assistant', status: 'done', ts: ts + 30e3, model, meta: meta(40000 + ((d * k * 7919) % 160000), model), blocks: [], notices: [] });
  }
}
save({ id: id(), title: '以前的对话', createdAt: now - 120 * DAY, updatedAt: now - 30 * DAY, mode: 'code', workdir: '~/archive', messages: history });

// ---------------- 演示网页（内置浏览器里显示） ----------------
const DEMO_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单管理</title><style>
body{font:14px/1.5 'Segoe UI','Microsoft YaHei UI',sans-serif;margin:0;background:#f6f7f9;color:#1f2328}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:14px 24px;font-weight:600;font-size:16px}
main{padding:20px 24px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #f0f1f3}th{background:#fafbfc;color:#6b7280;font-weight:500}
.st{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px}.paid{background:#e7f6ec;color:#1a7f37}.ship{background:#e8f0fe;color:#1d4ed8}.wait{background:#fff4e5;color:#b54708}
.pager{display:flex;gap:6px;justify-content:flex-end;margin-top:14px}.pager button{border:1px solid #d0d7de;background:#fff;border-radius:6px;padding:4px 10px}.pager .on{background:#1f2328;color:#fff;border-color:#1f2328}
.sum{color:#6b7280;margin-bottom:10px}</style></head><body><header>订单管理</header><main><div class="sum">共 1,284 条订单 · 第 2 页 / 65</div><table><tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th></tr>
${['20481|陈晓|¥ 268.00|paid|已支付', '20480|王敏|¥ 1,099.00|ship|已发货', '20479|李雷|¥ 59.90|wait|待支付', '20478|赵琳|¥ 432.50|paid|已支付', '20477|周杰|¥ 88.00|ship|已发货', '20476|孙悦|¥ 1,520.00|paid|已支付', '20475|吴昊|¥ 36.00|wait|待支付', '20474|郑爽|¥ 245.00|ship|已发货']
  .map((r) => r.split('|'))
  .map(([no, name, amt, cls, st]) => `<tr><td>#${no}</td><td>${name}</td><td>${amt}</td><td><span class="st ${cls}">${st}</span></td></tr>`)
  .join('')}</table><div class="pager"><button>上一页</button><button>1</button><button class="on">2</button><button>3</button><button>…</button><button>65</button><button>下一页</button></div></main></body></html>`;
const web = http.createServer((_q, s) => {
  s.setHeader('content-type', 'text/html; charset=utf-8');
  s.end(DEMO_PAGE);
});

// ---------------- 启动并截图 ----------------
require('../src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, w) => {
  if (started) return;
  started = true;
  w.setSize(1480, 920);
  w.webContents.setBackgroundThrottling(false);
  w.webContents.once('did-finish-load', () =>
    run(w)
      .catch((e) => console.log(`ERROR ${e.stack}`))
      .finally(() => {
        web.close();
        setTimeout(() => app.exit(0), 300);
      }),
  );
});

async function run(w) {
  await new Promise((r) => web.listen(5173, '127.0.0.1', r).on('error', () => web.listen(0, '127.0.0.1', r)));
  const port = web.address().port;
  const js = (code) => w.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const shot = async (name, wait = 600) => {
    await sleep(wait);
    const img = await w.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log(`saved ${name}.png ${img.getSize().width}x${img.getSize().height}`);
  };
  const openConv = (title) => js(`[...document.querySelectorAll('.conv-item')].find((x) => x.title === ${JSON.stringify(title)}).click()`);
  const closeDock = () => js(`document.querySelectorAll('.dock-panel:not([hidden]) [id$="-close"], #btn-term-close').forEach((b) => b.offsetParent && b.click())`);

  await sleep(1800);
  // 关掉首次启动可能出现的设置窗口
  await js(`document.querySelectorAll('#modal-root .overlay').forEach((o) => o.remove())`);

  // 1. 首页
  await shot('home', 800);

  // 2. 对话：工具卡片、diff、待办、权限卡片
  await openConv('给订单接口加上分页');
  await sleep(500);
  await js(`const h = [...document.querySelectorAll('.tool .tool-head')].find((x) => x.textContent.includes('编辑文件')); if (h) h.click(); await new Promise((r) => setTimeout(r, 150)); document.querySelector('#chat').scrollTop = 0;`);
  await shot('chat');

  // 3. 右侧停靠区：内置浏览器预览本机应用 + Git 改动
  await js(`document.querySelector('#btn-browser').click()`);
  await sleep(400);
  await js(`const i = document.querySelector('#br-url'); i.value = 'localhost:${port}/orders'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await js(`document.querySelector('#btn-changes').click()`);
  await sleep(1500);
  await js(`document.querySelector('#chat').scrollTop = 99999;`);
  await shot('dock', 800);
  await closeDock();

  // 4. 计划审批
  await openConv('数据库迁移方案');
  await shot('plan');

  // 5. 首页「模型」统计 + 浅色主题下的提问卡片
  nativeTheme.themeSource = 'light';
  await openConv('博客首页加载慢');
  await shot('question-light', 900);
  await js(`document.querySelector('#btn-new-chat').click()`);
  await sleep(400);
  await js(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === '模型').click()`);
  await shot('models-light', 700);
  nativeTheme.themeSource = 'dark';
}
