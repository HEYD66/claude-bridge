// 模拟 Anthropic Messages API（SSE 流式），按脚本返回 text / tool_use，用于在本机驱动真实 Claude Code 做协议测试
const http = require('http');

const log = (...a) => process.env.MOCK_LOG && console.error('[mock]', ...a);
let counter = 0;

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i];
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'tool_result' ? `[tool_result:${typeof c.content === 'string' ? c.content : JSON.stringify(c.content)}]` : c.type === 'image' ? '[image]' : '')).join(' ');
}

// 决定回复：根据最近一条用户消息中的指令关键字
function plan(body) {
  const msgs = body.messages || [];
  const u = lastUser(msgs);
  const ut = u ? textOf(u.content) : '';
  const hasToolResult = Array.isArray(u && u.content) && u.content.some((c) => c.type === 'tool_result');
  // 去掉 Claude Code 附加的 <system-reminder>，否则 ECHO 截取的末尾会被它们占满
  const allUserText = msgs
    .filter((m) => m.role === 'user')
    .map((m) => textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''))
    .join('\n');
  const tools = (body.tools || []).map((t) => t.name);
  log('req', { tools: tools.length, last: ut.slice(0, 160), hasToolResult });
  if (hasToolResult) {
    const r = ut;
    return [{ type: 'text', text: `Tool finished. Result was: ${r.slice(0, 300)}` }];
  }
  // --prompt-suggestions 的辅助请求：回一条短建议（长文本会被 Claude Code 丢弃）
  if (ut.includes('[SUGGESTION MODE')) return [{ type: 'text', text: 'run the tests' }];
  const m = ut.match(/CMD:(\w+)(?::(.*))?/);
  const cmd = m ? m[1] : null;
  const arg = m && m[2] ? m[2].trim() : '';
  if (cmd === 'BASH') return [{ type: 'text', text: 'Running a command.' }, { type: 'tool_use', name: 'Bash', input: { command: arg || 'echo hello-from-bash', description: 'Say hello' } }];
  if (cmd === 'SLOWBASH') return [{ type: 'tool_use', name: 'Bash', input: { command: arg || 'sleep 8; echo slow-done', description: 'Slow command' } }];
  if (cmd === 'WRITE') return [{ type: 'tool_use', name: 'Write', input: { file_path: arg, content: 'line one\nline two\n' } }];
  if (cmd === 'EDIT') return [{ type: 'tool_use', name: 'Edit', input: { file_path: arg, old_string: 'line two', new_string: 'line TWO edited' } }];
  if (cmd === 'ASK') return [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which color do you prefer?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] } }];
  if (cmd === 'TODO') {
    if (tools.includes('TodoWrite')) return [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Step one', status: 'completed', activeForm: 'Doing step one' }, { content: 'Step two', status: 'in_progress', activeForm: 'Doing step two' }] } }];
    if (tools.includes('TaskCreate')) return [{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'Step one', description: 'do it' } }];
    // 2.1.29x 的 -p 模式下两种待办工具都不提供
    return [{ type: 'text', text: 'NO_TODO_TOOL' }];
  }
  if (cmd === 'PLAN') return [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: '1. Do A\n2. Do B' } }];
  if (cmd === 'TOOLS') return [{ type: 'text', text: `TOOLS=${tools.join(',')}` }];
  if (cmd === 'AGENT') return [{ type: 'tool_use', name: tools.includes('Agent') ? 'Agent' : 'Task', input: { description: 'Sub task', prompt: 'Please say SUBAGENT-HI', subagent_type: 'general-purpose' } }];
  if (cmd === 'SLOW') return [{ type: 'text', text: 'slow '.repeat(40), slow: true }];
  if (cmd === 'ECHO') return [{ type: 'text', text: `ECHO(${allUserText.replace(/\s+/g, ' ').slice(-400)})` }];
  // CMD:MCP:<工具名> <JSON 参数> → 调用本机 local_pc MCP 工具
  if (cmd === 'MCP') {
    const sp = arg.indexOf(' ');
    const tool = sp > 0 ? arg.slice(0, sp) : arg;
    let input = {};
    // 后面可能还拼着别的内容块，逐个 } 尝试解析出第一个完整的 JSON
    const rest = sp > 0 ? arg.slice(sp + 1).trim() : '';
    for (let end = rest.indexOf('}'); end >= 0; end = rest.indexOf('}', end + 1)) {
      try {
        input = JSON.parse(rest.slice(0, end + 1));
        break;
      } catch {
        /* 继续尝试更长的前缀 */
      }
    }
    return [{ type: 'tool_use', name: `mcp__local_pc__${tool}`, input }];
  }
  return [{ type: 'text', text: `Reply #${++counter} to: ${ut.slice(0, 200)}` }];
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(res, body, blocks) {
  const id = `msg_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${id}` });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 } } });
  let stop = 'end_turn';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      const words = b.text.match(/\S+\s*/g) || [b.text];
      for (const w of words) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: w } });
        if (b.slow) await sleep(150);
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    } else {
      stop = 'tool_use';
      const tid = `toolu_mock_${Date.now()}_${i}`;
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tid, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    }
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function nonStream(res, body, blocks) {
  const content = blocks.map((b, i) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: `toolu_ns_${i}`, name: b.name, input: b.input }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: `msg_ns_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
}

const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (d) => (data += d));
  req.on('end', async () => {
    const url = req.url.split('?')[0];
    log(req.method, url);
    // 模拟 OpenAI 兼容的翻译接口：中→英加 [EN] 前缀，英→中加 【中】 前缀
    if (url.endsWith('/chat/completions') && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse(data);
      } catch {}
      const sys = String((body.messages && body.messages[0] && body.messages[0].content) || '');
      const user = String((body.messages && body.messages[1] && body.messages[1].content) || '');
      const text = user.replace(/^\s*<text>\s*\n?/, '').replace(/\n?\s*<\/text>\s*$/, '');
      const toZh = /into Simplified Chinese/i.test(sys);
      const out = toZh ? `【中】${text}` : `[EN] ${text}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'tr_mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: `<text>\n${out}\n</text>` }, finish_reason: 'stop' }] }));
      return;
    }
    if (url.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1234 }));
      return;
    }
    if (url.endsWith('/v1/messages') && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse(data);
      } catch {}
      // Claude Code 的辅助请求（标题生成等）：直接回短文本
      const sys = JSON.stringify(body.system || '');
      if (!body.tools || !body.tools.length) {
        const blocks = [{ type: 'text', text: /title|topic/i.test(sys) ? '{"title":"Mock title"}' : 'ok' }];
        return body.stream ? stream(res, body, blocks) : nonStream(res, body, blocks);
      }
      const blocks = plan(body);
      return body.stream ? stream(res, body, blocks) : nonStream(res, body, blocks);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
  });
});

const port = Number(process.env.MOCK_PORT || 0);
server.listen(port, '127.0.0.1', () => {
  console.log(`MOCK_PORT=${server.address().port}`);
});
module.exports = server;
