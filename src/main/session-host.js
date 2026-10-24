'use strict';

/**
 * 服务器端常驻运行宿主。
 *
 * 每个运行（run）对应服务器上的一个目录 ~/.claude-bridge/runs/<runId>/：
 *   in.jsonl   我们追加写入的输入（用户消息、控制请求/响应），由 `tail -F` 喂给 claude 的 stdin
 *   out.jsonl  claude 的 stdout（stream-json），我们按字节偏移量续读
 *   err.log    claude 的 stderr
 *   pid / exit 进程号与退出码
 * run.sh 通过 setsid + nohup 脱离 SSH 会话运行，所以断网、关闭本程序后任务仍会继续；
 * 重新连接后从上次读到的偏移量继续读取即可“接上”。
 * 一轮结束后空闲超过 IDLE 秒（且没有新输入），看门狗关闭输入，claude 正常退出。
 */

const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { shQuote, remotePathExpr, isUuid } = require('./util');

const RUNS_DIR = '"$HOME"/.claude-bridge/runs';

function runDirExpr(runId) {
  if (!isUuid(runId)) throw new Error('invalid run id');
  return `${RUNS_DIR}/${runId}`;
}

/** 把用户配置的命令首段中的 ~/ 展开，并返回需要加入 PATH 的目录（解决 nvm 安装的 node 不在 PATH 的问题） */
function prepareCommand(command) {
  const cmd = String(command || 'claude').trim() || 'claude';
  const m = cmd.match(/^(\S+)(.*)$/);
  let first = m[1];
  const rest = m[2];
  let pathSetup = '';
  if (first.includes('/')) {
    const dir = first.replace(/\/[^/]*$/, '') || '/';
    pathSetup = `export PATH=${remotePathExpr(dir)}:"$PATH"; `;
    if (first.startsWith('~/')) first = `"$HOME"/${shQuote(first.slice(2))}`;
  }
  return { exe: first + rest, pathSetup };
}

function mcpConfigRemotePath(clientId) {
  return `"$HOME"/.claude-bridge/mcp-${clientId}.json`;
}

/**
 * 生成 claude 的命令行参数（stream-json 双向模式）。
 * @returns {string} 已转义、可直接拼进 bash 的参数串
 */
function buildArgs(o) {
  const c = o.settings.claude;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages'];
  if (c.partialMessages) args.push('--include-partial-messages');
  if (c.usePromptTool) args.push('--permission-prompt-tool', 'stdio');
  if (c.promptSuggestions) args.push('--prompt-suggestions');
  if (o.sessionId && isUuid(o.sessionId)) {
    args.push('--resume', o.sessionId);
    if (o.resumeAt && isUuid(o.resumeAt)) args.push('--resume-session-at', o.resumeAt);
    if (o.fork) args.push('--fork-session');
  }
  if (o.worktree) args.push('--worktree', String(o.worktree).replace(/[^\w.-]/g, '').slice(0, 40) || 'bridge');
  if (c.model) args.push('--model', c.model);
  if (c.effort) args.push('--effort', c.effort);
  if (c.permissionMode) args.push('--permission-mode', c.permissionMode);
  if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
  const settingsJson = {};
  if (c.outputStyle) settingsJson.outputStyle = c.outputStyle;
  if (Object.keys(settingsJson).length) args.push('--settings', JSON.stringify(settingsJson));
  let line = args.map(shQuote).join(' ');
  if (o.mcpAvailable) {
    line += ` --mcp-config ${mcpConfigRemotePath(o.settings.clientId)}`;
    // 本机工具由 Claude Bridge 自己做确认，这里直接放行
    line += ` --allowedTools ${shQuote('mcp__local_pc')} ${shQuote('mcp__local_pc__*')}`;
  }
  if (c.extraArgs && c.extraArgs.trim()) line += ` ${c.extraArgs.trim()}`;
  return line;
}

/** 生成 run.sh 的内容 */
function buildRunScript(o) {
  const { exe, pathSetup } = prepareCommand(o.settings.claude.command);
  const idle = Math.max(30, Math.round((Number(o.settings.claude.idleMinutes) || 30) * 60));
  return [
    '#!/bin/bash',
    `D=${runDirExpr(o.runId)}`,
    'cd "$D" || exit 1',
    'echo $$ > pid',
    `IDLE=${idle}`,
    'export CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1',
    // tail -F 让 stdin 永不 EOF；我们追加写入 in.jsonl 即可发送消息
    'exec 3< <(exec tail -n +1 -F in.jsonl 2>/dev/null)',
    'TAILPID=$!',
    'echo $TAILPID > tailpid',
    // 空闲看门狗：最后一条 result 晚于最后一条已开始处理的用户消息（本轮已结束），
    // 且 IDLE 秒内没有新的输入输出 → 关闭输入，claude 自行退出
    '( while sleep 15; do',
    '    [ -f exit ] && break',
    '    now=$(date +%s); mi=$(stat -c %Y in.jsonl 2>/dev/null || echo $now); mo=$(stat -c %Y out.jsonl 2>/dev/null || echo $now)',
    '    [ $((now-mi)) -ge $IDLE ] && [ $((now-mo)) -ge $IDLE ] || continue',
    '    lr=$(grep -n \'"type":"result"\' out.jsonl | tail -n 1 | cut -d: -f1)',
    '    lu=$(grep -n \'"isReplay":true\' out.jsonl | grep -v local-command | tail -n 1 | cut -d: -f1)',
    '    if [ -n "$lr" ] && [ "$lr" -ge "${lu:-0}" ]; then kill $TAILPID 2>/dev/null; break; fi',
    '  done ) &',
    'WD=$!',
    `${pathSetup}cd ${remotePathExpr(o.workdir)} 2>> "$D/err.log" && exec ${exe} ${buildArgs(o)} <&3 >> "$D/out.jsonl" 2>> "$D/err.log" &`,
    'CPID=$!',
    'echo $CPID > cpid',
    'wait $CPID',
    'code=$?',
    'echo "{\\"type\\":\\"bridge_exit\\",\\"code\\":$code}" >> "$D/out.jsonl"',
    'echo $code > "$D/exit"',
    'kill $TAILPID $WD 2>/dev/null',
    '',
  ].join('\n');
}

/** 一个服务器端运行 */
class RemoteRun extends EventEmitter {
  constructor(ssh, runId) {
    super();
    this.ssh = ssh;
    this.runId = runId;
    this.dir = runDirExpr(runId);
    this.reader = null;
    this.writer = null;
    this.writeChain = Promise.resolve();
    this.exited = false;
    this.attached = false;
  }

  /** 在服务器上创建并启动一个新运行 */
  static async launch(ssh, opts) {
    const run = new RemoteRun(ssh, opts.runId);
    const script = buildRunScript(opts);
    const prep = `umask 077; mkdir -p ${run.dir} && cd ${run.dir} && : > in.jsonl && : > out.jsonl && cat > run.sh && chmod 700 run.sh && echo OK`;
    const r1 = await ssh.exec(`sh -c ${shQuote(prep)}`, { stdin: script, timeoutMs: 20000 });
    if (!r1.stdout.includes('OK')) throw new Error(`无法在服务器上创建运行目录：${r1.stderr.trim() || `exit ${r1.code}`}`);
    // 预先写入首批输入（控制请求、首条消息），保证先于 claude 启动可读
    if (opts.initialLines && opts.initialLines.length) {
      await ssh.exec(`sh -c ${shQuote(`cat >> ${run.dir}/in.jsonl`)}`, { stdin: opts.initialLines.map((l) => `${JSON.stringify(l)}\n`).join(''), timeoutMs: 20000 });
    }
    // 后台启动后等待 pid 文件出现，确认宿主进程已经跑起来
    const start = [
      `cd ${run.dir} || exit 1`,
      'if command -v setsid >/dev/null 2>&1; then setsid nohup bash -l ./run.sh >/dev/null 2>&1 </dev/null & else nohup bash -l ./run.sh >/dev/null 2>&1 </dev/null & fi',
      'i=0; while [ ! -f pid ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done',
      '[ -f pid ] && echo STARTED || echo NOPID',
    ].join('\n');
    const r2 = await ssh.exec(`sh -c ${shQuote(start)}`, { timeoutMs: 30000 });
    if (!r2.stdout.includes('STARTED')) throw new Error(`启动 Claude 失败：${r2.stderr.trim() || r2.stdout.trim() || `exit ${r2.code}`}`);
    return run;
  }

  /** 查询运行状态：exists / alive / exitCode / size */
  async status() {
    const script = [
      `D=${this.dir}`,
      '[ -d "$D" ] || { echo MISSING; exit 0; }',
      'cd "$D"',
      'if [ -f exit ]; then echo "EXIT $(cat exit)"; ',
      'elif [ -f pid ] && kill -0 "$(cat pid)" 2>/dev/null; then echo ALIVE; ',
      'else echo DEAD; fi',
      'echo "SIZE $(wc -c < out.jsonl 2>/dev/null || echo 0)"',
    ].join('\n');
    const r = await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 15000 });
    const out = r.stdout;
    if (out.includes('MISSING')) return { exists: false };
    const m = out.match(/EXIT (-?\d+)/);
    const size = Number((out.match(/SIZE (\d+)/) || [])[1] || 0);
    return { exists: true, alive: out.includes('ALIVE'), exitCode: m ? Number(m[1]) : null, dead: out.includes('DEAD'), size };
  }

  /** 从 offset 开始读取 out.jsonl（持续跟随）。每行触发 'line'(obj, endOffset) */
  async attach(offset = 0) {
    this.detach();
    const st = await this.status();
    if (!st.exists) {
      this.exited = true;
      this.emit('gone');
      return false;
    }
    // 宿主异常消失（服务器重启等）且没写退出行：补一行，让读取端能正常收尾
    if (st.dead && st.exitCode == null) {
      await this.ssh.exec(`sh -c ${shQuote(`echo '{"type":"bridge_exit","code":-1,"lost":true}' >> ${this.dir}/out.jsonl`)}`, { timeoutMs: 10000 }).catch(() => {});
    }
    const stream = await this.ssh.spawn(`sh -c ${shQuote(`exec tail -c +${Math.max(0, offset) + 1} -F ${this.dir}/out.jsonl 2>/dev/null`)}`);
    this.reader = stream;
    this.attached = true;
    let pos = offset;
    let pending = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let idx;
      while ((idx = pending.indexOf(0x0a)) >= 0) {
        const lineBuf = pending.subarray(0, idx);
        pending = pending.subarray(idx + 1);
        pos += idx + 1;
        const text = lineBuf.toString('utf8').trim();
        if (!text || text[0] !== '{') continue;
        let obj;
        try {
          obj = JSON.parse(text);
        } catch {
          continue;
        }
        if (obj.type === 'bridge_exit') {
          this.exited = true;
          this.emit('line', obj, pos);
          this.detach();
          return;
        }
        this.emit('line', obj, pos);
      }
    });
    stream.on('close', () => {
      if (this.reader !== stream) return;
      this.reader = null;
      this.attached = false;
      if (!this.exited) this.emit('detached');
    });
    return true;
  }

  detach() {
    const r = this.reader;
    this.reader = null;
    this.attached = false;
    if (r) {
      try {
        r.close();
      } catch {
        /* 忽略 */
      }
    }
    const w = this.writer;
    this.writer = null;
    if (w) {
      try {
        w.end();
      } catch {
        /* 忽略 */
      }
    }
  }

  async _openWriter() {
    const stream = await this.ssh.spawn(`sh -c ${shQuote(`exec cat >> ${this.dir}/in.jsonl`)}`);
    stream.on('close', () => {
      if (this.writer === stream) this.writer = null;
    });
    stream.on('error', () => {});
    stream.stderr.on('data', () => {});
    this.writer = stream;
    return stream;
  }

  /** 追加一行输入（按调用顺序串行写入） */
  write(obj) {
    const line = `${JSON.stringify(obj)}\n`;
    const job = this.writeChain.then(async () => {
      if (this.exited) throw new Error('Claude 进程已结束');
      const w = this.writer || (await this._openWriter());
      await new Promise((resolve, reject) => {
        w.write(line, (err) => (err ? reject(err) : resolve()));
      });
    });
    this.writeChain = job.catch(() => {});
    return job;
  }

  /** 关闭输入：claude 处理完已排队的内容后正常退出 */
  async closeInput() {
    const script = `D=${this.dir}; [ -f "$D/tailpid" ] && kill "$(cat "$D/tailpid")" 2>/dev/null; true`;
    await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 10000 }).catch(() => {});
  }

  /** 强制结束 */
  async kill() {
    const script = `D=${this.dir}; for f in cpid tailpid; do [ -f "$D/$f" ] && kill -TERM "$(cat "$D/$f")" 2>/dev/null; done; true`;
    await this.ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 10000 }).catch(() => {});
  }

  async stderrTail(lines = 20) {
    const r = await this.ssh.exec(`sh -c ${shQuote(`tail -n ${lines} ${this.dir}/err.log 2>/dev/null`)}`, { timeoutMs: 10000 }).catch(() => null);
    return r ? r.stdout.trim() : '';
  }

  async remove() {
    this.detach();
    await this.ssh.exec(`sh -c ${shQuote(`rm -rf ${this.dir}`)}`, { timeoutMs: 15000 }).catch(() => {});
  }
}

/** 清理服务器上 7 天前、已结束的运行目录 */
async function cleanupOldRuns(ssh) {
  const script = [
    `R=${RUNS_DIR}`,
    '[ -d "$R" ] || exit 0',
    'find "$R" -mindepth 1 -maxdepth 1 -type d -mtime +7 | while read d; do',
    '  if [ -f "$d/exit" ] || ! { [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; }; then rm -rf "$d"; fi',
    'done',
  ].join('\n');
  await ssh.exec(`sh -c ${shQuote(script)}`, { timeoutMs: 30000 }).catch(() => {});
}

/**
 * 一次性启动 claude，发送若干控制请求并收集响应（不会调用模型）：
 * 用于读取模型列表、用量额度等。
 */
async function oneShotControl(ssh, command, requests, { timeoutMs = 30000, cwd = '~' } = {}) {
  const { exe, pathSetup } = prepareCommand(command);
  const script = `${pathSetup}cd ${remotePathExpr(cwd)} 2>/dev/null || cd "$HOME"; exec ${exe} -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config`;
  const stream = await ssh.spawn(`bash -lc ${shQuote(script)}`);
  return new Promise((resolve, reject) => {
    const dec = new StringDecoder('utf8');
    let buf = '';
    let stderr = '';
    const results = {};
    let left = requests.length;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        stream.end();
      } catch {
        /* 忽略 */
      }
      setTimeout(() => {
        try {
          stream.close();
        } catch {
          /* 忽略 */
        }
      }, 3000);
      if (err) reject(err);
      else resolve(results);
    };
    const timer = setTimeout(() => (left < requests.length ? finish() : finish(new Error('读取服务器 Claude 信息超时（旧版 Claude Code 可能不支持）'))), timeoutMs);
    stream.on('data', (chunk) => {
      buf += dec.write(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line[0] !== '{') continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type !== 'control_response' || !ev.response) continue;
        const id = ev.response.request_id;
        if (!(id in results)) {
          results[id] = ev.response.subtype === 'error' ? { error: ev.response.error || 'error' } : ev.response.response || {};
          if (--left <= 0) finish();
        }
      }
    });
    stream.stderr.on('data', (d) => {
      if (stderr.length < 8000) stderr += d.toString('utf8');
    });
    stream.on('close', () => {
      if (left < requests.length) finish();
      else finish(new Error(stderr.trim().split('\n').slice(-3).join('\n') || 'Claude 进程已退出，未返回信息'));
    });
    stream.write(requests.map((r, i) => `${JSON.stringify({ type: 'control_request', request_id: `q${i}`, request: r })}\n`).join(''));
  });
}

/** 在服务器上查找 claude 可执行文件 */
const DETECT_SCRIPT = [
  'for c in "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /usr/local/bin/claude /usr/bin/claude "$HOME/.npm-global/bin/claude" "$HOME"/.nvm/versions/node/*/bin/claude "$HOME/.bun/bin/claude"; do',
  '  if [ -n "$c" ] && [ -x "$c" ]; then',
  '    v=$(PATH="$(dirname "$c"):$PATH" timeout 20 "$c" --version 2>/dev/null | head -n1)',
  '    echo "FOUND|$c|$v"',
  '  fi',
  'done',
  'echo "INFO|$(whoami)|$(uname -sm)|$HOME"',
].join('\n');

function normalizeInfo(r) {
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    version: str(r.claude_code_version) || null,
    permissionMode: str(r.current_permission_mode) || null,
    account: r.account && typeof r.account === 'object' ? r.account : null,
    outputStyle: str(r.output_style) || null,
    outputStyles: Array.isArray(r.available_output_styles) ? r.available_output_styles.filter((s) => typeof s === 'string') : [],
    agents: Array.isArray(r.agents) ? r.agents.map((a) => (typeof a === 'string' ? { name: a } : { name: str(a && a.name), description: str(a && a.description) })).filter((a) => a.name) : [],
    models: (Array.isArray(r.models) ? r.models : [])
      .filter((m) => m && typeof m.value === 'string')
      .map((m) => ({
        value: m.value,
        resolved: str(m.resolvedModel) || null,
        name: str(m.displayName) || m.value,
        description: str(m.description),
        supportsEffort: m.supportsEffort !== false,
        effort: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => typeof e === 'string') : [],
      })),
    commands: (Array.isArray(r.commands) ? r.commands : [])
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => ({ name: c.name, description: str(c.description), hint: str(c.argumentHint) })),
    fetchedAt: Date.now(),
  };
}

module.exports = { RemoteRun, buildArgs, buildRunScript, prepareCommand, mcpConfigRemotePath, cleanupOldRuns, oneShotControl, normalizeInfo, DETECT_SCRIPT, RUNS_DIR };
