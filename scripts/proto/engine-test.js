// 端到端测试 ChatManager + session-host：WSL bash 充当服务器，Windows 版 claude.exe 通过 interop 运行，模拟 API 提供回复
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatManager } = require('../../src/main/chat-manager');

const DISTRO = 'Ubuntu-24.04-Analysis';
const winTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbeng-'));
const toWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
const proj = path.join(winTmp, 'proj');
const cfg = path.join(winTmp, 'cfg');
fs.mkdirSync(proj);
fs.mkdirSync(cfg);
const attachments = path.join(winTmp, 'att');
const log = [];
const L = (s) => {
  log.push(s);
  console.log(s);
};
const check = (n, ok, extra = '') => L(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? `  (${extra})` : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let connected = true;
class FakeSsh extends EventEmitter {
  constructor() {
    super();
    this.connId = 1;
    this.cfg = { username: 'root', host: 'wsl', port: 22 };
    this.channels = new Set();
  }
  isConnected() {
    return connected;
  }
  getStatus() {
    return { tunnelError: '' };
  }
  spawn(cmd) {
    if (!connected) return Promise.reject(new Error('SSH 未连接'));
    const child = spawn('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', cmd], { windowsHide: true });
    const s = new EventEmitter();
    s.stderr = child.stderr;
    child.stdout.on('data', (d) => s.emit('data', d));
    child.on('close', (code) => {
      this.channels.delete(s);
      s.emit('exit', code);
      s.emit('close');
    });
    s.write = (d, cb) => child.stdin.write(d, cb);
    s.end = (d) => child.stdin.end(d);
    s.close = () => child.kill();
    s.child = child;
    this.channels.add(s);
    return Promise.resolve(s);
  }
  async exec(cmd, { stdin = null, timeoutMs = 30000 } = {}) {
    const s = await this.spawn(cmd);
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      const t = setTimeout(() => s.close(), timeoutMs);
      s.on('data', (d) => (out += d));
      s.stderr.on('data', (d) => (err += d));
      s.on('exit', (code) => {
        clearTimeout(t);
        resolve({ code, stdout: out, stderr: err });
      });
      if (stdin != null) s.end(stdin);
      else s.end();
    });
  }
  // 模拟断网：关闭所有通道
  drop() {
    connected = false;
    for (const s of this.channels) s.close();
  }
}

async function main() {
  process.env.MOCK_PORT = '0';
  const server = require('./mock-api.js');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  // claude 包装脚本：Linux 版 claude（/opt/claude-test），指向模拟 API
  const wrapper = `${toWsl(winTmp)}/claude-wrap.sh`;
  fs.writeFileSync(
    path.join(winTmp, 'claude-wrap.sh'),
    `#!/bin/bash\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\nexport ANTHROPIC_API_KEY=sk-ant-api03-mock\nexport CLAUDE_CONFIG_DIR=${toWsl(cfg)}\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\nexec /opt/claude-test/package/claude "$@"\n`.replace(/\r/g, ''),
  );
  const settings = {
    clientId: '12345678-1234-4234-8234-123456789abc',
    claude: { command: wrapper, workdir: toWsl(proj), model: 'sonnet', effort: '', permissionMode: 'manual', usePromptTool: true, partialMessages: true, appendSystemPrompt: false, promptSuggestions: false, outputStyle: '', idleMinutes: 0.5, extraArgs: '' },
    mcp: { enabled: false, roots: [] },
    translation: { enabled: false, translateInput: false, translateOutput: false },
  };
  const convs = {};
  const meta = {};
  const store = {
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    saveConversation: (c) => (convs[c.id] = JSON.parse(JSON.stringify(c))),
    loadConversation: (id) => convs[id] && JSON.parse(JSON.stringify(convs[id])),
    listConversations: () => Object.values(convs).map((c) => ({ id: c.id, updatedAt: c.updatedAt, activeRun: !!c.run })),
    deleteConversation: (id) => delete convs[id],
    getPendingDeletes: () => [],
    setPendingDeletes: () => {},
    getMeta: (k) => meta[k] || null,
    setMeta: (k, v) => (meta[k] = v),
  };
  const ssh = new FakeSsh();
  const chat = new ChatManager({ store, ssh, translator: { translate: async (t) => t }, getMcpInfo: () => ({}), attachmentsDir: attachments });
  const events = [];
  chat.on('event', (e) => events.push(e));
  const conv = chat.create({ workdir: toWsl(proj) });
  const C = () => chat.get(conv.id);
  const lastAssistant = () => [...C().messages].reverse().find((m) => m.role === 'assistant');
  const waitFor = async (pred, ms = 60000, label = '') => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      try {
        if (pred()) return true;
      } catch {}
      await sleep(200);
    }
    L(`  timeout waiting ${label}`);
    return false;
  };
  const idle = () => !chat.isRunning(C());
  const textOf = (m) => (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');

  try {
    // 1 基本对话
    await chat.send(conv.id, 'hello engine');
    await waitFor(idle, 60000, 'reply1');
    const a1 = lastAssistant();
    check('基本回复', a1 && a1.status === 'done' && /Reply #\d+ to/.test(textOf(a1)), `${a1 && a1.status} ${textOf(a1).slice(0, 60)}`);
    check('记录会话 ID', !!C().sessionId);
    check('lastUuid 已记录', !!a1.lastUuid);
    await waitFor(() => C().context, 15000, 'context');
    check('上下文用量', C().context && C().context.maxTokens > 0, JSON.stringify(C().context && { t: C().context.totalTokens, m: C().context.maxTokens }));

    // 2 运行中排队
    await chat.send(conv.id, 'CMD:SLOW one');
    await sleep(1500);
    await chat.send(conv.id, 'CMD:ECHO queued-two');
    const qmsg = C().messages[C().messages.length - 1];
    await waitFor(() => C().messages.find((m) => m.id === qmsg.id).status === 'queued', 10000, 'queued');
    check('第二条处于排队状态', C().messages.find((m) => m.id === qmsg.id).status === 'queued');
    await waitFor(idle, 60000, 'queue drain');
    const ms = C().messages;
    const qi = ms.findIndex((m) => m.id === qmsg.id);
    check('排队消息之后生成了单独的回复', ms[qi + 1] && ms[qi + 1].role === 'assistant' && /ECHO/.test(textOf(ms[qi + 1])), textOf(ms[qi + 1] || {}).slice(0, 80));
    check('排队前的慢回复完整', /slow slow/.test(textOf(ms[qi - 1])) && ms[qi - 1].status === 'done');

    // 3 权限（始终允许）
    await chat.send(conv.id, 'CMD:BASH:mkdir -p sub && touch sub/x.txt');
    await waitFor(() => lastAssistant().blocks.some((b) => b.type === 'permission' && b.status === 'pending'), 30000, 'perm');
    const pb = lastAssistant().blocks.find((b) => b.type === 'permission');
    check('收到权限请求', pb && pb.kind === 'tool' && pb.toolName === 'Bash' && pb.suggestions.length > 0);
    await chat.answerPermission(conv.id, pb.requestId, { behavior: 'allow', always: true });
    await waitFor(idle, 30000, 'perm done');
    check('允许后命令执行', fs.existsSync(path.join(proj, 'sub', 'x.txt')));
    const rules = await chat.control(conv.id, { subtype: 'list_permission_rules' });
    check('始终允许写入了规则', JSON.stringify(rules).includes('Bash('), JSON.stringify(rules).slice(0, 120));

    // 4 提问
    await chat.send(conv.id, 'CMD:ASK');
    await waitFor(() => lastAssistant().blocks.some((b) => b.type === 'permission' && b.kind === 'question' && b.status === 'pending'), 30000, 'ask');
    const qb = lastAssistant().blocks.find((b) => b.kind === 'question');
    await chat.answerPermission(conv.id, qb.requestId, { behavior: 'allow', answers: { [qb.input.questions[0].question]: 'Blue' } });
    await waitFor(idle, 30000, 'ask done');
    check('提问的回答传给了 Claude', /Blue/.test(textOf(lastAssistant())), textOf(lastAssistant()).slice(0, 120));

    // 5 打断
    await chat.send(conv.id, 'CMD:SLOW to-stop');
    await sleep(2000);
    await chat.stop(conv.id);
    await waitFor(idle, 20000, 'stop');
    check('停止后状态为 stopped', lastAssistant().status === 'stopped', lastAssistant().status);

    // 6 断线续跑
    await chat.send(conv.id, 'CMD:SLOW offline-run');
    await sleep(1500);
    ssh.drop();
    L('  -- 已断开，等待 7 秒（服务器上继续运行）');
    await sleep(7000);
    connected = true;
    ssh.connId++;
    await chat.reattachAll();
    await waitFor(idle, 30000, 'reattach');
    const ar = lastAssistant();
    check('重连后补齐了断线期间的完整回复', ar.status === 'done' && (textOf(ar).match(/slow/g) || []).length >= 40, `${ar.status} words=${(textOf(ar).match(/slow/g) || []).length}`);

    // 7 文件检查点回退
    const f = `${toWsl(proj)}/ck.txt`;
    const handle = async () => {
      for (;;) {
        await waitFor(() => idle() || lastAssistant().blocks.some((b) => b.type === 'permission' && b.status === 'pending'), 30000, 'perm/idle');
        const p = lastAssistant().blocks.find((b) => b.type === 'permission' && b.status === 'pending');
        if (!p) return;
        await chat.answerPermission(conv.id, p.requestId, { behavior: 'allow' });
      }
    };
    await chat.send(conv.id, `CMD:WRITE:${f}`);
    await handle();
    const { msgId: editMsg } = await chat.send(conv.id, `CMD:EDIT:${f}`);
    await handle();
    const winF = path.join(proj, 'ck.txt');
    check('编辑已生效', fs.existsSync(winF) && fs.readFileSync(winF, 'utf8').includes('TWO edited'));
    const dry = await chat.rewind(conv.id, editMsg, { code: true, conversation: false, dryRun: true });
    check('回退预览列出文件', dry.files && (dry.files.filesChanged || []).length === 1, JSON.stringify(dry.files).slice(0, 120));
    await chat.rewind(conv.id, editMsg, { code: true, conversation: false });
    check('回退后文件恢复', fs.readFileSync(winF, 'utf8') === 'line one\nline two\n', JSON.stringify(fs.readFileSync(winF, 'utf8')));
    const editBlock = C().messages.flatMap((m) => m.blocks || []).find((b) => b.type === 'tool_use' && b.name === 'Edit');
    check('Edit 结果带结构化补丁', editBlock && editBlock.structured && Array.isArray(editBlock.structured.structuredPatch), JSON.stringify(editBlock && editBlock.structured).slice(0, 120));

    // 8 编辑重发（分叉）
    const firstUser = C().messages.find((m) => m.role === 'user');
    const secondUser = C().messages.filter((m) => m.role === 'user')[1];
    const oldSid = C().sessionId;
    await chat.editMessage(conv.id, secondUser.id, 'CMD:ECHO edited-second');
    await waitFor(idle, 60000, 'fork');
    const fa = lastAssistant();
    const ftext = textOf(fa);
    check('分叉后上下文只到被编辑消息之前', /hello engine/.test(ftext) && /edited-second/.test(ftext) && !/queued-two/.test(ftext) && !/offline-run/.test(ftext), ftext.slice(-160));
    check('分叉产生了新会话', C().sessionId && C().sessionId !== oldSid);
    const slotId = C().messages.find((m) => m.slotId).slotId;
    const slot = C().slots[slotId];
    check('旧内容保存为历史版本', slot && slot.versions.length === 2 && slot.current === 1);
    chat.switchVariant(conv.id, slotId, 0);
    check('切回旧版本', C().messages.some((m) => m.role === 'user' && /queued-two/.test(m.text)) && C().sessionId === oldSid);
    chat.switchVariant(conv.id, slotId, 1);
    check('再切回新版本', C().messages.some((m) => m.role === 'user' && /edited-second/.test(m.text)) && !C().messages.some((m) => /queued-two/.test(m.text || '')));
    check('第一条消息未变', C().messages[0].id === firstUser.id);

    // 9 图片
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await chat.send(conv.id, 'CMD:ECHO with image', { images: [{ dataUrl: png, name: 'a.png' }] });
    await waitFor(idle, 60000, 'image');
    const um = [...C().messages].reverse().find((m) => m.role === 'user');
    check('图片已保存并发送', um.images.length === 1 && fs.existsSync(path.join(attachments, um.images[0].file)) && lastAssistant().status === 'done');

    // 10 空闲退出
    L('  -- 等待空闲看门狗（约 30~50 秒）');
    await waitFor(() => !C().run, 90000, 'idle exit');
    check('空闲后服务器进程自动退出', !C().run);
    await chat.send(conv.id, 'CMD:ECHO after-idle');
    await waitFor(idle, 60000, 'after idle');
    check('空闲退出后再发消息会自动恢复会话', /after-idle/.test(textOf(lastAssistant())) && /edited-second/.test(textOf(lastAssistant())), textOf(lastAssistant()).slice(-120));
    const runsLeft = await ssh.exec(`sh -c 'ls "$HOME/.claude-bridge/runs" 2>/dev/null | wc -l'`);
    L(`  runs dirs now: ${runsLeft.stdout.trim()}`);
  } catch (e) {
    L(`FAIL exception ${e.stack}`);
  }
  // 收尾
  const live = chat.live.get(conv.id);
  const lr = live && live.run;
  if (lr) {
    await lr.kill();
    await lr.remove();
  }
  server.close();
  fs.writeFileSync(path.join(__dirname, 'engine-test.log'), log.join('\n'));
  setTimeout(() => process.exit(0), 500);
}
main();
