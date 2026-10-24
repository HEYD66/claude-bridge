// 端到端测试：真实的 Claude Bridge 界面 + 主进程，经测试 SSH 服务器连到 WSL，
// 服务器上运行 Linux 版 Claude Code，API 和翻译接口都由 mock-api.js 模拟。
// 运行：npx electron scripts/e2e/e2e.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const DISTRO = 'Ubuntu-24.04-Analysis';
const CLAUDE_BIN = '/opt/claude-test/package/claude';
const stamp = Date.now();
const H = `/tmp/cbe2e-${stamp}`; // 服务器端 HOME
const PROJ = `${H}/proj`;
const userData = path.join(os.tmpdir(), 'cb-e2e');
const shareDir = path.join(os.tmpdir(), 'cb-e2e-share');
const shots = path.join(os.tmpdir(), 'cb-e2e-shots');
for (const d of [userData, shareDir, shots]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(shareDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(shareDir, 'a.txt'), 'local file a\n');
fs.writeFileSync(path.join(shareDir, 'b.md'), '# local b\n');
app.setPath('userData', userData);

const results = [];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${String(extra).replace(/\s+/g, ' ').slice(0, 220)})` : ''}`);
};
const origError = console.error;
console.error = (...a) => {
  errors.push(`[main] ${a.map((x) => (x && x.stack) || String(x)).join(' ')}`);
  origError(...a);
};

function wsl(script) {
  return execFileSync('wsl.exe', ['-d', DISTRO, '--exec', 'env', `HOME=${H}`, 'bash', '-c', script], { encoding: 'utf8', windowsHide: true });
}
function wslOk(script) {
  try {
    wsl(script);
    return true;
  } catch {
    return false;
  }
}

let mockServer;
let srv;

async function setup() {
  process.env.MOCK_PORT = '0';
  mockServer = require('../proto/mock-api.js');
  await new Promise((r) => (mockServer.listening ? r() : mockServer.once('listening', r)));
  const mockPort = mockServer.address().port;

  // 服务器端：临时 HOME、git 项目、claude 包装脚本
  const wrapper = [
    '#!/bin/bash',
    `export ANTHROPIC_BASE_URL=http://127.0.0.1:${mockPort}`,
    'export ANTHROPIC_API_KEY=sk-ant-api03-mock',
    'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'export DISABLE_AUTOUPDATER=1',
    `exec ${CLAUDE_BIN} "$@"`,
  ].join('\n');
  wsl(
    [
      `mkdir -p ${PROJ} ${H}/bin`,
      `cat > ${H}/bin/claude <<'EOF'\n${wrapper}\nEOF`,
      `chmod +x ${H}/bin/claude`,
      `cd ${PROJ} && printf 'hello world\\nline two\\n' > hello.txt && git init -q -b main . && git add . && git -c user.name=t -c user.email=t@t commit -qm init`,
      // 一个“在服务器终端里直接开的”会话，用来测试导入
      `cd ${PROJ} && ${H}/bin/claude -p 'foreign session CMD:ECHO' --output-format text > ${H}/foreign.out 2>&1 || true`,
    ].join('\n'),
  );

  const { startSshServer } = require('./ssh-wsl-server');
  srv = await startSshServer({ distro: DISTRO, home: H, log: (...a) => process.env.SSHLOG && console.log('[ssh]', ...a) });

  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      ssh: { host: '127.0.0.1', port: srv.port, username: 'root', authType: 'password', password: 'test', autoReconnect: true },
      claude: { command: `${H}/bin/claude`, workdir: PROJ, model: '', effort: '', permissionMode: 'manual', usePromptTool: true, partialMessages: true, appendSystemPrompt: true, promptSuggestions: true, outputStyle: '', idleMinutes: 1, extraArgs: '' },
      mcp: { enabled: true, roots: [shareDir], readOnly: false, confirmWrites: true, allowCommands: false, confirmCommands: true, desktop: false, desktopConfirm: 'risky' },
      notify: { done: false, permission: false },
      translation: { enabled: true, translateInput: true, translateOutput: true, provider: 'openai', openai: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-mock', model: 'mock' } },
      ui: { theme: 'light' },
    }),
  );
}

// 渲染进程里的辅助函数
const HELPERS = `
window.__t = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text)); },
  click(sel, text) {
    const el = text ? this.byText(sel, text) : document.querySelector(sel);
    if (!el) throw new Error('not found: ' + sel + ' / ' + (text || ''));
    el.click();
    return true;
  },
  idle() {
    return document.querySelector('#btn-stop').hidden && !document.querySelector('#messages .msg.assistant .running') && !document.querySelector('#messages .text-block.translating') && !document.querySelector('#messages .msg.user .tr-note .spinner');
  },
  sig() {
    const m = [...document.querySelectorAll('#messages .msg')];
    const last = m[m.length - 1];
    return m.length + '|' + (last ? last.textContent.slice(-300) : '');
  },
  lastAssistant() { const a = [...document.querySelectorAll('#messages .msg.assistant')]; return a[a.length - 1] || null; },
  lastUser() { const a = [...document.querySelectorAll('#messages .msg.user')]; return a[a.length - 1] || null; },
  lastText() { const a = this.lastAssistant(); return a ? [...a.querySelectorAll('.text-block .md')].map((x) => x.textContent).join('\\n') : ''; },
  send(text, ctrl) {
    const i = document.querySelector('#input');
    i.focus();
    i.value = text;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
    return true;
  },
  closeMenus() { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; },
};
true;
`;

let w;
const js = (code) => w.webContents.executeJavaScript(`(async () => { const T = window.__t; ${code} })()`, true);
async function until(cond, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await js(`return !!(${cond});`)) return true;
    } catch {
      /* 页面还没准备好 */
    }
    await sleep(250);
  }
  return false;
}
/** 等待一轮结束：消息列表有变化、空闲且稳定 1.2 秒 */
async function waitTurn(before, ms = 120000) {
  const t0 = Date.now();
  let stable = 0;
  let lastSig = null;
  while (Date.now() - t0 < ms) {
    const [sig, idle] = await js('return [T.sig(), T.idle()]');
    if (sig !== before && idle && sig === lastSig) {
      if (!stable) stable = Date.now();
      else if (Date.now() - stable > 1200) return true;
    } else stable = 0;
    lastSig = sig;
    await sleep(250);
  }
  return false;
}
async function turn(text, opts = {}) {
  const before = await js('return T.sig()');
  await js(`return T.send(${JSON.stringify(text)}, ${!!opts.ctrl})`);
  return waitTurn(before, opts.ms);
}
async function shot(name) {
  await sleep(300);
  const img = await w.capturePage();
  fs.writeFileSync(path.join(shots, `${name}.png`), img.toPNG());
}
function convFileByTitle(title) {
  const dir = path.join(userData, 'conversations');
  for (const f of fs.readdirSync(dir)) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (c.title === title) return c;
  }
  return null;
}

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, e.message);
    await shot(`fail-${name.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}`).catch(() => {});
  }
}

async function run() {
  await js(HELPERS.replace(/^\s*window/, 'window'));
  await sleep(800);

  await step('SSH 连接 + 指纹确认', async () => {
    await js(`T.click('#account'); await new Promise((r) => setTimeout(r, 200)); T.click('.menu-item', '连接服务器');`);
    const asked = await until(`T.byText('#modal-root .dialog h2', '确认服务器身份')`, 20000);
    await shot('01-hostkey');
    await js(`T.click('#modal-root .dialog .btn', '信任并连接')`);
    const ok = await until(`T.q('#account .dot.connected')`, 30000);
    check('SSH 连接 + 指纹确认', asked && ok);
    const title = await js(`return T.q('#account').title`);
    check('反向隧道建立', title.includes('本机隧道已建立'), title);
  });

  await step('读取服务器模型列表', async () => {
    const ok = await until(`(T.click('#btn-model'), (T.q('.menu .menu-label') || {}).textContent || '').includes('服务器上的可选模型') || (T.closeMenus(), false)`, 60000);
    const items = await js(`const n = T.qa('.menu .menu-item').length; T.closeMenus(); return n;`);
    check('读取服务器模型列表', ok && items > 1, `${items} 项`);
  });

  await step('Git 分支', async () => {
    const ok = await until(`T.byText('#chips .chip', 'main')`, 20000);
    check('Git 分支显示', ok);
    await shot('02-home-connected');
  });

  await step('首轮对话 + 双向翻译', async () => {
    const ok = await turn('你好，CMD:ECHO');
    const en = await js(`const d = T.lastUser().querySelector('.tr-detail .en'); return d ? d.textContent : ''`);
    const text = await js('return T.lastText()');
    check('首轮对话完成', ok, text.slice(0, 80));
    check('中文输入翻译成英文发送', en.startsWith('[EN]'), en);
    check('英文回复翻译成中文显示', text.includes('【中】') && text.includes('ECHO('), text.slice(0, 60));
    const ring = await until(`T.q('#ctx-ring').title.includes('上下文已用')`, 20000);
    check('上下文用量', ring, await js(`return T.q('#ctx-ring').title`));
    await shot('03-first-turn');
  });

  await step('下一步建议', async () => {
    const ok = await until(`!T.q('#suggest').hidden`, 15000);
    check('下一步建议显示', ok, await js(`return T.q('#suggest').textContent`));
  });

  await step('权限：允许', async () => {
    const before = await js('return T.sig()');
    await js(`return T.send('CMD:BASH:echo BASH_OK > e2e-bash.txt; cat e2e-bash.txt')`);
    const card = await until(`T.q('#messages .perm-card:not(.question):not(.plan)')`, 60000);
    await shot('04-permission');
    check('权限卡片出现', card);
    await js(`T.click('#messages .perm-card .btn.primary', '允许')`);
    const ok = await waitTurn(before);
    const res = await js(`const t = T.lastAssistant().querySelector('.tool .tool-head'); if (t) t.click(); await new Promise((r) => setTimeout(r, 150)); return T.lastAssistant().textContent`);
    check('允许后命令在服务器执行', ok && res.includes('BASH_OK') && wslOk(`test -f ${PROJ}/e2e-bash.txt`), res.slice(-120));
  });

  await step('权限：始终允许', async () => {
    const before = await js('return T.sig()');
    await js(`return T.send('CMD:BASH:echo ALWAYS_OK')`);
    await until(`T.q('#messages .perm-card:not(.question):not(.plan)')`, 60000);
    const hasAlways = await js(`return !!T.byText('#messages .perm-card .btn', '始终允许')`);
    if (hasAlways) await js(`T.click('#messages .perm-card .btn', '始终允许')`);
    else await js(`T.click('#messages .perm-card .btn.primary', '允许')`);
    await waitTurn(before);
    let rules = '';
    try {
      rules = wsl(`cat ${PROJ}/.claude/settings.local.json 2>/dev/null || true`);
    } catch {
      /* 忽略 */
    }
    check('始终允许写入权限规则', hasAlways && rules.includes('Bash'), rules.replace(/\s+/g, ' ').slice(0, 160));
    // 同一命令再执行一次不应再询问
    const b2 = await js('return T.sig()');
    await js(`return T.send('CMD:BASH:echo ALWAYS_OK')`);
    const asked = await until(`T.q('#messages .perm-card:not(.question):not(.plan)')`, 8000);
    if (asked) await js(`T.click('#messages .perm-card .btn.primary', '允许')`);
    await waitTurn(b2);
    check('始终允许的规则生效（不再询问）', !asked);
  });

  await step('提问卡片', async () => {
    const before = await js('return T.sig()');
    await js(`return T.send('CMD:ASK')`);
    const card = await until(`T.q('#messages .perm-card.question')`, 60000);
    await shot('05-question');
    await js(`const opt = [...T.qa('#messages .perm-card.question .q-opt')].find((x) => x.textContent.includes('Blue')); opt.querySelector('input').click(); T.click('#messages .perm-card.question .btn.primary', '提交回答');`);
    const ok = await waitTurn(before);
    const text = await js('return T.lastText()');
    check('回答提问后 Claude 收到答案', card && ok && text.includes('Blue'), text.slice(0, 120));
  });

  await step('待办', async () => {
    const ok = await turn('CMD:TODO');
    const bar = await until(`!T.q('#todo-bar').hidden && T.q('#todo-bar').textContent.includes('Doing step two')`, 10000);
    check('待办条', ok && bar, await js(`return T.q('#todo-bar').textContent`));
  });

  await step('本机文件（MCP）', async () => {
    const ok = await turn(`CMD:MCP:list_directory ${JSON.stringify({ path: shareDir })}`);
    const t = await js(`const a = T.lastAssistant(); const h = a.querySelector('.tool .tool-head'); if (h && !h.closest('.tool').classList.contains('open')) h.click(); await new Promise((r) => setTimeout(r, 150)); return a.textContent`);
    check('服务器上的 Claude 列出本机文件夹', ok && t.includes('本机') && t.includes('a.txt'), t.slice(0, 200));
    const target = path.join(shareDir, 'from-claude.txt');
    const before = await js('return T.sig()');
    await js(`return T.send(${JSON.stringify(`CMD:MCP:write_file ${JSON.stringify({ path: target, content: 'written by claude' })}`)})`);
    const asked = await until(`T.byText('#modal-root .dialog h2', 'Claude 想要')`, 60000);
    await shot('06-local-confirm');
    if (asked) await js(`T.click('#modal-root .dialog .btn.primary', '允许')`);
    await waitTurn(before);
    const written = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'written by claude';
    check('写本机文件前弹窗确认，确认后写入', asked && written);
    const act = await js(`T.click('#btn-activity'); await new Promise((r) => setTimeout(r, 300)); const n = T.qa('#activity-list .act-item').length; T.click('#btn-activity-close'); return n;`);
    check('本机操作记录', act >= 2, `${act} 条`);
  });

  await step('写文件 diff + 回退代码', async () => {
    const before = await js('return T.sig()');
    await js(`return T.send(${JSON.stringify(`CMD:WRITE:${PROJ}/e2e-write.txt`)})`);
    await until(`T.q('#messages .perm-card:not(.question):not(.plan)')`, 60000);
    await js(`T.click('#messages .perm-card .btn.primary', '允许')`);
    await waitTurn(before);
    const diff = await js(`const a = T.lastAssistant(); const h = [...a.querySelectorAll('.tool .tool-head')].find((x) => x.textContent.includes('写入')); if (h && !h.closest('.tool').classList.contains('open')) h.click(); await new Promise((r) => setTimeout(r, 200)); return !!a.querySelector('.diff .dl.add')`);
    const exists = wslOk(`test -f ${PROJ}/e2e-write.txt`);
    check('Write 结果显示 diff', diff && exists);
    await shot('07-diff');
    // 回退到这条消息之前
    await js(`const u = T.lastUser(); u.querySelector('button[title="回退到这里之前"]').click();`);
    const dlg = await until(`T.byText('#modal-root .dialog h2', '回退到这条消息之前') && T.q('#modal-root .dialog pre')`, 30000);
    const listed = await js(`return (T.q('#modal-root .dialog pre') || {}).textContent || ''`);
    await shot('08-rewind');
    await js(`T.click('#modal-root .dialog .btn.primary', '回退')`);
    const gone = await (async () => {
      for (let i = 0; i < 40; i++) {
        if (!wslOk(`test -f ${PROJ}/e2e-write.txt`)) return true;
        await sleep(500);
      }
      return false;
    })();
    check('回退预览列出将恢复的文件', dlg && listed.includes('e2e-write.txt'), listed);
    check('回退后服务器文件已恢复', gone);
    const filled = await js(`return T.q('#input').value`);
    check('回退对话后原消息回到输入框', filled.includes('CMD:WRITE'), filled);
    await js(`const i = T.q('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));`);
  });

  await step('编辑消息 + 版本切换', async () => {
    await until('T.idle()', 30000);
    const before = await js('return T.sig()');
    await js(`T.lastUser().querySelector('button[title="编辑"]').click(); await new Promise((r) => setTimeout(r, 200)); const ta = T.q('.msg.user.editing .edit-area'); ta.value = 'edited CMD:ECHO'; T.click('.msg.user.editing .btn.primary', '保存并发送');`);
    const ok = await waitTurn(before);
    const v = await until(`(T.lastUser().querySelector('.variants') || {}).textContent === '2 / 2'`, 15000);
    const text = await js('return T.lastText()');
    check('编辑后生成新回复', ok && text.includes('edited'), text.slice(0, 100));
    check('编辑后出现版本切换 2 / 2', v);
    await js(`T.lastUser().querySelector('.variants button[title="上一个版本"]').click()`);
    const back = await until(`(T.lastUser().querySelector('.variants') || {}).textContent === '1 / 2'`, 15000);
    const oldText = await js('return T.lastUser().querySelector(".bubble").textContent');
    check('切回旧版本', back && !oldText.includes('edited'), oldText);
    await js(`T.lastUser().querySelector('.variants button[title="下一个版本"]').click()`);
    await until(`(T.lastUser().querySelector('.variants') || {}).textContent === '2 / 2'`, 15000);
    await shot('09-variants');
  });

  await step('重新生成', async () => {
    await until('T.idle()', 30000);
    const before = await js('return T.sig()');
    await js(`T.lastAssistant().querySelector('button[title="重新生成"]').click()`);
    const ok = await waitTurn(before);
    const v = await js(`return (T.lastUser().querySelector('.variants') || {}).textContent || ''`);
    check('重新生成', ok && /^3 \/ 3$/.test(v), v);
  });

  await step('计划模式', async () => {
    await js(`T.click('#btn-perm'); await new Promise((r) => setTimeout(r, 150)); T.click('.menu-item', '计划模式');`);
    await until(`T.q('#btn-perm').textContent.includes('计划模式')`, 10000);
    const before = await js('return T.sig()');
    await js(`return T.send('CMD:PLAN')`);
    const card = await until(`T.q('#messages .perm-card.plan')`, 60000);
    await shot('10-plan');
    if (card) await js(`T.click('#messages .perm-card.plan .btn.primary', '批准并执行')`);
    const ok = await waitTurn(before);
    const done = await js(`return !!T.byText('#messages .perm-done', '计划已批准')`);
    check('计划审批卡片 → 批准', card && ok && done);
    await js(`T.click('#btn-perm'); await new Promise((r) => setTimeout(r, 150)); T.click('.menu-item', '逐项确认');`);
    await until(`T.q('#btn-perm').textContent.includes('逐项确认')`, 10000);
  });

  await step('排队 + 停止', async () => {
    await until('T.idle()', 30000);
    await js(`return T.send('CMD:SLOW')`);
    const running = await until(`!T.q('#btn-stop').hidden`, 30000);
    await until(`T.lastText().includes('slow')`, 30000);
    await js(`return T.send('queued one CMD:ECHO')`);
    const queued = await until(`T.lastUser().textContent.includes('已排队')`, 15000);
    await shot('11-queued');
    await js(`T.click('#btn-stop')`);
    const idle = await until('T.idle()', 30000);
    const cancelled = await js(`return T.lastUser().textContent.includes('已取消')`);
    const stopped = await js(`const a = T.lastAssistant(); return (a.querySelector('.msg-time') || {}).title || ''`);
    check('运行中发送 → 排队', running && queued);
    check('停止：回复中断、排队消息取消', idle && cancelled && stopped.includes('已停止'), stopped);
  });

  await step('Ctrl+Enter 插话', async () => {
    await until('T.idle()', 30000);
    await js(`return T.send('CMD:SLOW')`);
    await until(`T.lastText().includes('slow')`, 30000);
    const before = await js('return T.sig()');
    await js(`return T.send('interject CMD:ECHO', true)`);
    const ok = await waitTurn(before, 60000);
    const text = await js('return T.lastText()');
    check('Ctrl+Enter 立即插话', ok && text.includes('interject'), text.slice(0, 100));
  });

  await step('断线后任务继续并自动接回', async () => {
    await until('T.idle()', 30000);
    await js(`return T.send('CMD:SLOW')`);
    await until(`T.lastText().includes('slow')`, 30000);
    srv.dropAll();
    const dropped = await until(`!T.q('#account .dot.connected')`, 10000);
    await shot('12-disconnected');
    const back = await until(`T.q('#account .dot.connected')`, 60000);
    const done = await until(`T.idle() && T.lastAssistant() && !T.lastAssistant().querySelector('.running')`, 90000);
    await sleep(1500);
    const text = await js('return T.lastText()');
    const n = (text.match(/slow/g) || []).length;
    check('断线 → 自动重连', dropped && back);
    check('断线期间任务在服务器继续，重连后内容完整', done && n >= 40, `${n} 个 slow`);
  });

  await step('内置终端', async () => {
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', code: 'Backquote', ctrlKey: true, bubbles: true }))`);
    const open = await until(`!T.q('#term-panel').hidden && T.q('#term-host .xterm')`, 15000);
    await until(`(T.q('#term-host .xterm-rows') || {}).textContent && T.q('#term-host .xterm-rows').textContent.includes('#')`, 20000);
    await sleep(500);
    w.webContents.focus();
    w.webContents.insertText('echo TERM_$((40+2))');
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    const out = await until(`T.q('#term-host .xterm-rows').textContent.includes('TERM_42')`, 15000);
    await shot('13-terminal');
    check('内置终端（PTY）', open && out, await js(`return T.q('#term-host .xterm-rows').textContent.trim().slice(-120)`));
    await js(`T.click('#btn-term-close')`);
  });

  await step('服务器文件', async () => {
    await js(`T.click('#btn-files')`);
    const listed = await until(`T.byText('#files-list .file-item', 'hello.txt')`, 20000);
    await js(`T.byText('#files-list .file-item', 'hello.txt').click()`);
    const preview = await until(`(T.q('#modal-root .dialog.viewer .code-view') || {}).textContent && T.q('#modal-root .dialog.viewer .code-view').textContent.includes('hello world')`, 20000);
    await shot('14-files');
    await js(`T.click('#modal-root .dialog .btn.primary', '关闭'); T.click('#btn-files-close');`);
    check('服务器文件浏览 + 预览（SFTP）', listed && preview);
  });

  await step('自定义页', async () => {
    await js(`T.click('#btn-customize')`);
    const loaded = await until(`T.q('#modal-root .settings-pane .code-edit') && !T.byText('#modal-root .editor-foot .hint-text', '读取中')`, 30000);
    await js(`const ta = T.q('#modal-root .settings-pane .code-edit'); ta.value = 'E2E 全局指令'; ta.dispatchEvent(new Event('input', { bubbles: true })); T.q('#modal-root .editor-foot .btn.primary').click();`);
    const saved = await until(`T.byText('#modal-root .editor-foot .hint-text', '已保存')`, 20000);
    let content = '';
    try {
      content = wsl(`cat ${H}/.claude/CLAUDE.md`);
    } catch {
      /* 忽略 */
    }
    check('自定义 › 指令写入服务器（SFTP）', loaded && saved && content.trim() === 'E2E 全局指令', content);
    await js(`T.click('#modal-root .settings-nav button', '连接器')`);
    const cli = await until(`(T.q('#modal-root .cli-out') || {}).textContent && !T.q('#modal-root .cli-out').textContent.includes('运行中')`, 60000);
    const out = await js(`return (T.q('#modal-root .cli-out') || {}).textContent || ''`);
    await shot('15-customize');
    check('自定义 › 连接器（claude mcp list）', cli && !/不支持|错误|Error:/i.test(out), out);
    await js(`T.click('#modal-root .dialog .btn.primary', '完成')`);
  });

  await step('导入服务器会话', async () => {
    await js(`T.click('#btn-more'); T.click('#btn-more-import')`);
    const listed = await until(`T.byText('#modal-root .session-item', 'foreign session')`, 30000);
    await shot('16-import');
    await js(`T.byText('#modal-root .session-item', 'foreign session').querySelector('.btn').click()`);
    const opened = await until(`!T.q('#modal-root .overlay') && T.q('#messages .msg.user') && T.q('#messages').textContent.includes('foreign session')`, 30000);
    check('导入服务器会话', listed && opened);
    const ok = await turn('continue CMD:ECHO');
    const text = await js('return T.lastText()');
    check('导入后继续对话（--resume 上下文）', ok && text.includes('foreign session') && text.includes('continue'), text.slice(0, 160));
  });

  await step('删除对话（同步删除服务器会话）', async () => {
    const title = await js(`return T.q('#conv-head .t').textContent`);
    const conv = convFileByTitle(title);
    const ids = [...new Set([...(conv.sessionIds || []), conv.sessionId].filter(Boolean))];
    const existed = ids.length && ids.every((id) => wslOk(`ls ${H}/.claude/projects/*/${id}.jsonl`));
    await js(`T.click('#conv-head .title-btn'); await new Promise((r) => setTimeout(r, 150)); T.click('.menu-item', '删除');`);
    await until(`T.byText('#modal-root .dialog h2', '删除对话')`, 10000);
    const boxChecked = await js(`const b = T.q('#modal-root .dialog .check-line input'); return !!(b && b.checked)`);
    await js(`T.click('#modal-root .dialog .btn.danger', '删除')`);
    const toast = await until(`T.byText('#toast-root .toast', '服务器上的')`, 20000);
    await sleep(500);
    const removed = ids.every((id) => !wslOk(`ls ${H}/.claude/projects/*/${id}.jsonl`));
    check('删除对话并同步删除服务器会话记录', existed && boxChecked && toast && removed, `${ids.length} 个会话`);
  });

  console.log('\n==== 汇总 ====');
  const failed = results.filter((r) => !r.ok);
  console.log(`PASS ${results.length - failed.length} / ${results.length}`);
  for (const f of failed) console.log(`  FAIL ${f.name}`);
  console.log('==== 错误日志 ====');
  console.log(errors.length ? errors.join('\n') : '(none)');
  console.log(`截图：${shots}`);
}

function cleanup() {
  try {
    if (srv) srv.close();
  } catch {
    /* 忽略 */
  }
  try {
    wsl(`pkill -f ${H} 2>/dev/null; sleep 1; rm -rf ${H}`);
  } catch {
    /* 忽略 */
  }
}

setup()
  .then(() => {
    require('../../src/main/main.js');
    app.on('browser-window-created', (_e, win) => {
      if (w) return;
      w = win;
      win.webContents.on('console-message', (e) => {
        if (e.level === 'error' || e.level === 'warning') errors.push(`[renderer ${e.level}] ${e.message}`);
      });
      win.webContents.on('render-process-gone', (_ev, d) => errors.push(`[crash] ${JSON.stringify(d)}`));
      win.webContents.once('did-finish-load', () =>
        run()
          .catch((e) => errors.push(`[e2e] ${e.stack || e}`))
          .finally(() => {
            cleanup();
            setTimeout(() => app.exit(results.every((r) => r.ok) && !errors.length ? 0 : 1), 500);
          }),
      );
    });
  })
  .catch((e) => {
    console.log(`setup 失败：${e.stack || e}`);
    cleanup();
    app.exit(1);
  });
