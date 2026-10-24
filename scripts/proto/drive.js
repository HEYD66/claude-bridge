// 用模拟 API 驱动真实 Claude Code（stream-json 双向 + stdio 权限），记录协议细节
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const work = process.env.WORK || fs.mkdtempSync(path.join(os.tmpdir(), 'cb-drive-'));
const cfg = path.join(work, 'config');
const proj = path.join(work, 'proj');
fs.mkdirSync(cfg, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const logFile = path.join(__dirname, `drive-${process.argv[2] || 'basic'}.log`);
fs.writeFileSync(logFile, '');
const L = (s) => fs.appendFileSync(logFile, `${s}\n`);

async function main() {
  process.env.MOCK_PORT = '0';
  const server = require('./mock-api.js');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  const extra = (process.env.EXTRA || '').split(' ').filter(Boolean);
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--model', 'sonnet', ...extra];
  const child = spawn(exe, args, {
    cwd: proj,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: 'sk-ant-api03-mock-key-for-local-protocol-testing',
      CLAUDE_CONFIG_DIR: cfg,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
    },
  });
  const events = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        L(`RAW ${line}`);
        continue;
      }
      events.push(ev);
      const short = ev.type === 'stream_event' ? `stream_event ${ev.event.type}${ev.event.delta ? ` ${ev.event.delta.type}` : ''}` : line.length > 1500 ? `${line.slice(0, 1500)}…` : line;
      L(`<< ${short}`);
      for (const w of [...waiters]) if (w.pred(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
    }
  });
  child.stderr.on('data', (d) => L(`ERR ${d}`));
  child.on('close', (code) => L(`EXIT ${code}`));
  const send = (o) => {
    L(`>> ${JSON.stringify(o)}`);
    child.stdin.write(`${JSON.stringify(o)}\n`);
  };
  const wait = (pred, ms = 30000) =>
    new Promise((resolve, reject) => {
      const found = events.find(pred);
      if (found && !found.__used) {
        found.__used = true;
        return resolve(found);
      }
      const w = { pred: (e) => !e.__used && pred(e) && (e.__used = true), resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timeout waiting: ${pred}`)), ms);
    });
  const user = (text, extraFields = {}) => send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '', ...extraFields });
  const respond = (req, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response } });
  let rid = 0;
  const control = async (request) => {
    const id = `drv_${++rid}`;
    send({ type: 'control_request', request_id: id, request });
    const r = await wait((e) => e.type === 'control_response' && e.response && e.response.request_id === id);
    return r.response;
  };
  const ctx = { send, wait, user, respond, control, proj, cfg, events, L, child };
  try {
    const init = await control({ subtype: 'initialize' });
    L(`INIT ok keys=${Object.keys(init.response || {}).join(',')}`);
    await require(`./scenario-${process.argv[2] || 'basic'}.js`)(ctx);
  } catch (e) {
    L(`FAIL ${e.stack}`);
  }
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1500));
  child.kill();
  server.close();
  console.log('log:', logFile, 'work:', work);
}
main();
