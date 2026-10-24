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
  // claude 包装脚本：通过 WSLENV 把环境变量传给 Windows 进程
  const exe = toWsl(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  const wrapper = `${toWsl(winTmp)}/claude-wrap.sh`;
  fs.writeFileSync(
    path.join(winTmp, 'claude-wrap.sh'),
    `#!/bin/bash\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:${port}\nexport ANTHROPIC_API_KEY=sk-ant-api03-mock\nexport CLAUDE_CONFIG_DIR=${toWsl(cfg)}\nexport CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\nexport WSLENV=ANTHROPIC_BASE_URL:ANTHROPIC_API_KEY:CLAUDE_CONFIG_DIR/p:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING\nexec "${exe}" "$@"\n`.replace(/\r/g, ''),
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
    console.log('[debug] conv', JSON.stringify(C().messages, null, 1).slice(0, 2500));
  } catch (e) {
    L(`FAIL exception ${e.stack}`);
  }
  // 收尾
  const live = chat.live.get(conv.id);
  if (live && live.run) {
    await live.run.kill();
    await live.run.remove();
  }
  server.close();
  fs.writeFileSync(path.join(__dirname, 'engine-test.log'), log.join('\n'));
  setTimeout(() => process.exit(0), 500);
}
main();

