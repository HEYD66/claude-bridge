'use strict';

/**
 * 本机 MCP 服务（Streamable HTTP 传输，无状态 JSON 响应模式）。
 * 仅监听 127.0.0.1，经 SSH 反向隧道暴露给服务器上的 Claude Code，并要求 Bearer Token。
 */

const http = require('http');
const crypto = require('crypto');

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 10 * 1024 * 1024;
const SERVER_NAME = 'local_pc';

const INSTRUCTIONS =
  "Tools for the user's local Windows PC (connected through Claude Bridge). " +
  'Paths are Windows paths. Call list_allowed_roots first to see which folders are shared; anything outside them is denied.';

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

class LocalMcpServer {
  /** @param {{ tools: import('./fs-tools').LocalTools, version?: string, token?: string }} opts */
  constructor({ tools, version = '0.1.0', token = '' }) {
    this.tools = tools;
    this.version = version;
    // 令牌跨重启保持不变，服务器上仍在运行的 claude 才能继续用原来的 MCP 配置
    this.token = /^[0-9a-f]{48}$/.test(token) ? token : crypto.randomBytes(24).toString('hex');
    this.port = 0;
    this.server = null;
  }

  rotateToken() {
    this.token = crypto.randomBytes(24).toString('hex');
    return this.token;
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch((e) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rpcError(null, -32603, e.message)));
          }
        });
      });
      server.requestTimeout = 0; // 工具调用可能要等待用户确认
      server.headersTimeout = 30000;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  _authorized(req) {
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${this.token}`);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  async _handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    // 防 DNS rebinding：只接受回环地址的 Host
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      res.writeHead(403).end();
      return;
    }
    if (!this._authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    if (req.method !== 'POST') {
      // 本服务不提供服务端推送的 SSE 流
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
      return;
    }

    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const m of messages) {
      // 只有带 id 的 request 需要响应；notification / response 直接忽略
      if (m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null) {
        responses.push(await this._dispatch(m));
      }
    }
    if (!responses.length) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
  }

  async _dispatch({ id, method, params }) {
    try {
      switch (method) {
        case 'initialize': {
          const requested = params && params.protocolVersion;
          return rpcResult(id, {
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'claude-bridge-local-pc', title: 'Claude Bridge · Local PC', version: this.version },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: this.tools.list() });
        case 'tools/call': {
          const name = params && params.name;
          if (typeof name !== 'string') return rpcError(id, -32602, 'Missing tool name');
          return rpcResult(id, await this.tools.call(name, (params && params.arguments) || {}));
        }
        case 'resources/list':
          return rpcResult(id, { resources: [] });
        case 'resources/templates/list':
          return rpcResult(id, { resourceTemplates: [] });
        case 'prompts/list':
          return rpcResult(id, { prompts: [] });
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return rpcError(id, -32603, e.message);
    }
  }
}

module.exports = { LocalMcpServer, SERVER_NAME };
