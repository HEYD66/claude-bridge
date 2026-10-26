'use strict';

/**
 * 暴露给服务器上 Claude 的本机工具（经 MCP 调用）。
 * 所有路径都被限制在用户授权的“共享文件夹”内，写操作可要求用户在本机确认。
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { uid, truncate } = require('./util');

const W = path.win32;
const MAX_OUTPUT_CHARS = 100000;
const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', '.cache', '.idea']);
const MAX_WALK_ENTRIES = 50000;

class ToolError extends Error {
  constructor(message, { denied = false } = {}) {
    super(message);
    this.denied = denied;
  }
}

// ---------------- 工具定义（JSON Schema，面向 Claude，用英文描述） ----------------

const P = (description) => ({ type: 'string', description });

const TOOL_DEFS = {
  list_allowed_roots: {
    description:
      "List the folders on the user's local Windows PC that you are allowed to access. Call this first before using any other local_pc tool.",
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  list_directory: {
    description:
      'List files and folders in a directory on the user\'s local Windows PC. Paths are Windows paths (e.g. D:\\project). Relative paths resolve against the first shared folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: P('Directory path on the local Windows PC'),
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Recursion depth (default 1)' },
        show_hidden: { type: 'boolean', description: 'Include dot-files (default false)' },
      },
      required: ['path'],
    },
    readOnly: true,
  },
  read_file: {
    description:
      'Read a text file (or a png/jpg/gif/webp image) from the user\'s local Windows PC. Text is returned with line numbers like `cat -n`; the line-number prefix is not part of the file content. Use offset/limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: P('File path on the local Windows PC'),
        offset: { type: 'integer', minimum: 1, description: '1-based line number to start reading from' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to read (default 2000)' },
      },
      required: ['path'],
    },
    readOnly: true,
  },
  get_file_info: {
    description: 'Get metadata (type, size, timestamps) of a file or folder on the user\'s local Windows PC.',
    inputSchema: { type: 'object', properties: { path: P('Path on the local Windows PC') }, required: ['path'] },
    readOnly: true,
  },
  find_files: {
    description:
      'Find files by glob pattern (e.g. "**/*.ts", "*.md", "src/**/test_*.py") under a folder on the user\'s local Windows PC. Skips node_modules, .git and similar folders.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: P('Glob pattern. Without "/" it matches file names at any depth.'),
        path: P('Folder to search in (default: first shared folder)'),
        max_results: { type: 'integer', minimum: 1, maximum: 2000, description: 'Default 200' },
      },
      required: ['pattern'],
    },
    readOnly: true,
  },
  search_text: {
    description:
      'Search file contents (like grep) under a folder on the user\'s local Windows PC. Returns matching lines as path:line: text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: P('Text or regular expression to search for'),
        path: P('Folder or file to search in (default: first shared folder)'),
        is_regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression (default false)' },
        case_sensitive: { type: 'boolean', description: 'Default false' },
        glob: P('Only search files matching this glob, e.g. "*.js"'),
        max_results: { type: 'integer', minimum: 1, maximum: 2000, description: 'Default 200' },
      },
      required: ['query'],
    },
    readOnly: true,
  },
  write_file: {
    description:
      'Create or overwrite a UTF-8 text file on the user\'s local Windows PC. Parent folders are created automatically. The user may be asked to approve.',
    inputSchema: {
      type: 'object',
      properties: { path: P('File path on the local Windows PC'), content: P('Full file content') },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    description:
      'Edit a text file on the user\'s local Windows PC by replacing an exact string. old_string must match exactly once unless replace_all is true. Read the file first. Line endings (CRLF/LF) are handled automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: P('File path on the local Windows PC'),
        old_string: P('Exact text to replace'),
        new_string: P('Replacement text'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  create_directory: {
    description: 'Create a folder (and missing parents) on the user\'s local Windows PC.',
    inputSchema: { type: 'object', properties: { path: P('Folder path on the local Windows PC') }, required: ['path'] },
  },
  move_file: {
    description: 'Move or rename a file or folder on the user\'s local Windows PC. The destination must not exist.',
    inputSchema: {
      type: 'object',
      properties: { source: P('Existing path'), destination: P('New path') },
      required: ['source', 'destination'],
    },
  },
  delete_file: {
    description: 'Move a file or folder on the user\'s local Windows PC to the Recycle Bin. The user may be asked to approve.',
    inputSchema: { type: 'object', properties: { path: P('Path on the local Windows PC') }, required: ['path'] },
  },
  run_command: {
    description:
      'Run a PowerShell command on the user\'s local Windows PC and return its output. The working directory must be inside a shared folder. The user may be asked to approve each command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: P('PowerShell command or script'),
        cwd: P('Working directory (default: first shared folder)'),
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 1800, description: 'Default 120' },
      },
      required: ['command'],
    },
    command: true,
  },

  // ---- 本机后台进程（开发服务器等） ----
  start_process: {
    description:
      "Start a long-running PowerShell command in the background on the user's local Windows PC — dev servers (npm run dev, vite, python -m http.server), watchers, etc. Returns right away with a process id plus the first output; local URLs it prints (e.g. http://localhost:5173) are detected. " +
      'Use this instead of run_command for anything that does not exit by itself. Then use read_process_output for logs, browser_navigate to preview, and stop_process when done.',
    inputSchema: {
      type: 'object',
      properties: {
        command: P('PowerShell command, e.g. "npm run dev"'),
        cwd: P('Working directory (must be inside a shared folder; default: first shared folder)'),
        name: P('Short label shown to the user, e.g. "vite dev server"'),
      },
      required: ['command'],
    },
    process: true,
  },
  read_process_output: {
    description: 'Read the latest output (stdout + stderr) of a background process started with start_process.',
    inputSchema: {
      type: 'object',
      properties: { id: P('Process id returned by start_process'), lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Number of last lines (default 80)' } },
      required: ['id'],
    },
    process: true,
    readOnly: true,
  },
  list_processes: {
    description: 'List background processes started with start_process on the user\'s PC, with status and detected URLs.',
    inputSchema: { type: 'object', properties: {} },
    process: true,
    readOnly: true,
  },
  stop_process: {
    description: 'Stop a background process (and its child processes) started with start_process.',
    inputSchema: { type: 'object', properties: { id: P('Process id') }, required: ['id'] },
    process: true,
  },

  // ---- 内置浏览器 ----
  browser_navigate: {
    description:
      "Open a URL in Claude Bridge's built-in browser on the user's PC (shown to the user in a side panel). Use it to preview local apps such as http://localhost:3000 started with start_process. " +
      'Pass url, or action = back / forward / reload. Opening non-local websites may ask the user first.',
    inputSchema: {
      type: 'object',
      properties: { url: P('URL to open; "localhost:3000" is accepted'), action: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'Navigate history instead of opening a URL' } },
    },
    browser: true,
  },
  browser_snapshot: {
    description:
      'Read the page currently shown in the built-in browser: title, URL, visible text and a numbered list of interactive elements like "[3] <button> Sign in". Use the numbers as ref for browser_click / browser_type. Take a new snapshot after the page changes.',
    inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 500, maximum: 50000, description: 'Max characters of page text (default 8000)' } } },
    browser: true,
    readOnly: true,
  },
  browser_click: {
    description: 'Click an element in the built-in browser (real mouse click). Identify it by ref from browser_snapshot, or by a CSS selector.',
    inputSchema: { type: 'object', properties: { ref: { type: 'integer', description: 'Element number from browser_snapshot' }, selector: P('CSS selector (if no ref)') } },
    browser: true,
  },
  browser_type: {
    description: 'Type text into an element of the built-in browser (clicks it first to focus). Optionally clear the field first and press Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'Element number from browser_snapshot' },
        selector: P('CSS selector (if no ref)'),
        text: P('Text to type'),
        clear: { type: 'boolean', description: 'Select all and delete existing text first' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['text'],
    },
    browser: true,
  },
  browser_screenshot: {
    description: 'Take a screenshot of the page in the built-in browser (what the user sees).',
    inputSchema: { type: 'object', properties: {} },
    browser: true,
    readOnly: true,
  },
  browser_console: {
    description: 'Get recent console messages, JavaScript errors and failed page loads from the built-in browser — useful for debugging a local web app.',
    inputSchema: { type: 'object', properties: { clear: { type: 'boolean', description: 'Clear the log after reading' } } },
    browser: true,
    readOnly: true,
  },
};

const DESKTOP_PREFIX = 'desktop_';

// ---------------- 路径与工具函数 ----------------

function isWithin(root, target) {
  const rel = W.relative(root.toLowerCase(), target.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !W.isAbsolute(rel));
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(d) {
  const t = new Date(d);
  const pad = (x) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** glob → RegExp，支持 ** * ? {a,b} */
function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const parts = g.slice(i + 1, end).split(',').map((p) => globToRegExp(p).source.slice(1, -1));
        re += `(?:${parts.join('|')})`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function decodeText(buf) {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
  } catch {
    // 中文 Windows 上常见 GBK 编码文件
    try {
      return { text: new TextDecoder('gbk').decode(b), encoding: 'gbk' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(b), encoding: 'utf-8' };
    }
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  if (n >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// ---------------- 工具实现 ----------------

class LocalTools extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => object} opts.getSettings
   * @param {(req: object) => Promise<boolean>} opts.confirm  请求用户确认写操作
   * @param {(req: {toolName: string, input: object}) => Promise<{allow: boolean, message?: string}>} opts.permissionPrompt
   */
  /**
   * @param {object} opts
   * @param {() => object} opts.getSettings
   * @param {(req: object) => Promise<boolean>} opts.confirm  请求用户确认写操作
   * @param {import('./desktop-mcp').DesktopMcp} [opts.desktop] Windows 桌面控制
   */
  constructor({ getSettings, confirm, desktop, procs, browser }) {
    super();
    this.getSettings = getSettings;
    this.confirm = confirm;
    this.desktop = desktop || null;
    this.procs = procs || null; // 本机后台进程（local-procs.js）
    this.browser = browser || null; // 内置浏览器（browser-host.js）
  }

  _mcp() {
    return this.getSettings().mcp;
  }

  _desktopOn() {
    const s = this._mcp();
    return !!(s.desktop && !s.readOnly && this.desktop && this.desktop.state === 'ready');
  }

  /** 当前可用的工具列表（MCP tools/list 格式） */
  list() {
    const s = this._mcp();
    const tools = Object.entries(TOOL_DEFS)
      .filter(([, d]) => {
        // 后台进程和执行命令同一个开关
        if (d.command || d.process) return s.allowCommands && !s.readOnly && (!d.process || !!this.procs);
        if (d.browser) return s.browser !== false && !!this.browser;
        return d.readOnly || !s.readOnly;
      })
      .map(([name, d]) => ({
        name,
        description: d.description,
        inputSchema: d.inputSchema,
        annotations: { readOnlyHint: !!d.readOnly, destructiveHint: !d.readOnly },
      }));
    if (this._desktopOn()) {
      for (const t of this.desktop.tools) {
        tools.push({
          name: DESKTOP_PREFIX + t.name,
          description: `[User's Windows desktop] ${t.description || t.name}`,
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          annotations: { ...(t.annotations || {}), destructiveHint: this.desktop.isRisky(t.name) },
        });
      }
    }
    return tools;
  }

  /** 执行工具，返回 MCP tools/call 结果 */
  async call(name, args) {
    const enabled = this.list().some((t) => t.name === name);
    if (!enabled) {
      return { content: [{ type: 'text', text: `Error: tool "${name}" is unknown or disabled by the user.` }], isError: true };
    }
    const act = { id: uid(), ts: Date.now(), tool: name, summary: summarize(name, args || {}), status: 'running' };
    this.emit('activity', { ...act });
    try {
      const result = name.startsWith(DESKTOP_PREFIX) ? await this._desktop(name.slice(DESKTOP_PREFIX.length), args || {}) : await this[`_${name}`](args || {});
      act.status = result && result.isError ? 'error' : 'ok';
      if (typeof result === 'string') return { content: [{ type: 'text', text: truncate(result, MAX_OUTPUT_CHARS) }] };
      return result;
    } catch (e) {
      act.status = e.denied ? 'denied' : 'error';
      act.error = e.message;
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    } finally {
      this.emit('activity', { ...act, endTs: Date.now() });
    }
  }

  async _desktop(tool, args) {
    const mode = this._mcp().desktopConfirm || 'risky';
    if (mode === 'all' || (mode === 'risky' && this.desktop.isRisky(tool))) {
      await this._confirmOrThrow({ kind: `desktop:${tool}`, title: `Claude 想要操作你的桌面：${tool}`, desktopTool: tool, preview: JSON.stringify(args, null, 2) });
    }
    const r = await this.desktop.call(tool, args);
    return { content: Array.isArray(r.content) ? r.content : [{ type: 'text', text: JSON.stringify(r) }], isError: !!r.isError };
  }

  _roots() {
    return (this._mcp().roots || []).map((r) => W.resolve(r));
  }

  /** 把 Claude 传来的路径解析为本机绝对路径，并做共享目录校验（含符号链接/联接点） */
  async _resolve(p, { mustExist = true, allowDefault = false } = {}) {
    const roots = this._roots();
    if (!roots.length) {
      throw new ToolError('The user has not shared any local folders yet. Ask the user to add a folder in Claude Bridge → Settings → 本机访问.');
    }
    let s = typeof p === 'string' ? p.trim() : '';
    if (!s) {
      if (allowDefault) return roots[0];
      throw new ToolError('path is required');
    }
    s = s.replace(/^["']+|["']+$/g, '');
    // /d/foo 或 /mnt/d/foo → D:\foo
    const m = s.match(/^\/(?:mnt\/)?([a-zA-Z])(?:\/(.*))?$/);
    if (m) s = `${m[1]}:\\${m[2] || ''}`;
    s = s.replace(/\//g, '\\');
    const abs = /^[a-zA-Z]:/.test(s) ? W.resolve(s) : W.resolve(roots[0], s);
    if (!roots.some((r) => isWithin(r, abs))) {
      throw new ToolError(`Access denied: "${abs}" is outside the shared folders (${roots.join(', ')}).`);
    }
    let real;
    try {
      real = await fsp.realpath(abs);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (mustExist) throw new ToolError(`Not found: ${abs}`);
      real = await realpathOfNearest(abs);
    }
    const realRoots = await Promise.all(roots.map((r) => fsp.realpath(r).catch(() => r)));
    if (!realRoots.some((r) => isWithin(r, real))) {
      throw new ToolError(`Access denied: "${abs}" resolves (via a link) to a location outside the shared folders.`);
    }
    return abs;
  }

  async _confirmOrThrow(req) {
    const ok = await this.confirm(req);
    if (!ok) throw new ToolError('The user denied this operation on their PC.', { denied: true });
  }

  _needConfirmWrite() {
    return this._mcp().confirmWrites;
  }

  // ---- 只读工具 ----

  async _list_allowed_roots() {
    const roots = this._roots();
    const s = this._mcp();
    if (!roots.length) return 'No folders are shared. Ask the user to add one in Claude Bridge → Settings → 本机访问.';
    const lines = ["Shared folders on the user's Windows PC:"];
    for (const r of roots) lines.push(`- ${r}`);
    lines.push('');
    lines.push(`Mode: ${s.readOnly ? 'read-only' : 'read-write'}${s.confirmWrites && !s.readOnly ? ' (writes require user approval)' : ''}`);
    lines.push(`PowerShell commands: ${s.allowCommands && !s.readOnly ? 'allowed' : 'disabled'}`);
    return lines.join('\n');
  }

  async _list_directory({ path: p, depth, show_hidden }) {
    const dir = await this._resolve(p, { allowDefault: true });
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new ToolError(`Not a directory: ${dir}`);
    const maxDepth = Math.min(5, Math.max(1, parseInt(depth, 10) || 1));
    const lines = [`${dir}\\`];
    let count = 0;
    let truncated = false;
    const walk = async (d, level, indent) => {
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch (e) {
        lines.push(`${indent}[unreadable: ${e.code || e.message}]`);
        return;
      }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (!show_hidden && ent.name.startsWith('.')) continue;
        if (count >= 2000) {
          truncated = true;
          return;
        }
        count++;
        const full = W.join(d, ent.name);
        if (ent.isDirectory()) {
          const skipped = level < maxDepth && SKIP_DIRS.has(ent.name);
          lines.push(`${indent}[DIR]  ${ent.name}\\${skipped ? '  (not expanded)' : ''}`);
          if (level < maxDepth && !skipped) await walk(full, level + 1, `${indent}  `);
        } else {
          let info = '';
          try {
            const s = await fsp.stat(full);
            info = `  (${formatSize(s.size)}, ${formatTime(s.mtime)})`;
          } catch {
            /* 忽略 */
          }
          lines.push(`${indent}[FILE] ${ent.name}${info}`);
        }
      }
    };
    await walk(dir, 1, '  ');
    if (count === 0) lines.push('  (empty)');
    if (truncated) lines.push('  … (truncated at 2000 entries; list a subfolder for more)');
    return lines.join('\n');
  }

  async _read_file({ path: p, offset, limit }) {
    const file = await this._resolve(p);
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new ToolError(`Is a directory: ${file}. Use list_directory instead.`);
    const ext = W.extname(file).toLowerCase();
    if (IMAGE_TYPES[ext]) {
      if (st.size > MAX_IMAGE_BYTES) throw new ToolError(`Image is too large (${formatSize(st.size)}, max 5 MB).`);
      const data = await fsp.readFile(file);
      return {
        content: [
          { type: 'text', text: `Image: ${file} (${formatSize(st.size)})` },
          { type: 'image', data: data.toString('base64'), mimeType: IMAGE_TYPES[ext] },
        ],
      };
    }
    if (st.size > MAX_READ_BYTES) throw new ToolError(`File is too large to read (${formatSize(st.size)}, max 20 MB).`);
    const buf = await fsp.readFile(file);
    if (looksBinary(buf)) throw new ToolError(`Binary file, cannot display as text: ${file} (${formatSize(st.size)})`);
    const { text, encoding } = decodeText(buf);
    const allLines = text.split(/\r?\n/);
    const start = Math.max(1, parseInt(offset, 10) || 1);
    const count = Math.max(1, parseInt(limit, 10) || 2000);
    const slice = allLines.slice(start - 1, start - 1 + count);
    let out = '';
    let shown = 0;
    for (let i = 0; i < slice.length; i++) {
      let line = slice[i];
      if (line.length > 2000) line = `${line.slice(0, 2000)}… [line truncated]`;
      const row = `${String(start + i).padStart(6)}\t${line}\n`;
      if (out.length + row.length > MAX_OUTPUT_CHARS) break;
      out += row;
      shown++;
    }
    const end = start + shown - 1;
    const header = `File: ${file} (${allLines.length} lines, ${encoding}${/\r\n/.test(text) ? ', CRLF' : ''})`;
    const more = end < allLines.length ? `\n… showing lines ${start}-${end} of ${allLines.length}. Use offset=${end + 1} to read more.` : '';
    return `${header}\n${out}${more}`;
  }

  async _get_file_info({ path: p }) {
    const target = await this._resolve(p);
    const st = await fsp.lstat(target);
    const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file';
    return [
      `Path: ${target}`,
      `Type: ${type}`,
      `Size: ${formatSize(st.size)} (${st.size} bytes)`,
      `Created: ${formatTime(st.birthtime)}`,
      `Modified: ${formatTime(st.mtime)}`,
      `Accessed: ${formatTime(st.atime)}`,
    ].join('\n');
  }

  async _walkFiles(base, onFile) {
    let visited = 0;
    const walk = async (d) => {
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return true;
      }
      for (const ent of entries) {
        if (++visited > MAX_WALK_ENTRIES) return false;
        const full = W.join(d, ent.name);
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          if ((await walk(full)) === false) return false;
        } else if (ent.isFile()) {
          if ((await onFile(full)) === false) return false;
        }
      }
      return true;
    };
    await walk(base);
  }

  async _find_files({ pattern, path: p, max_results }) {
    if (!pattern || typeof pattern !== 'string') throw new ToolError('pattern is required');
    const base = await this._resolve(p, { allowDefault: true });
    const max = Math.min(2000, Math.max(1, parseInt(max_results, 10) || 200));
    const byName = !pattern.includes('/') && !pattern.includes('\\');
    const re = globToRegExp(pattern);
    const found = [];
    await this._walkFiles(base, (full) => {
      const subject = byName ? W.basename(full) : W.relative(base, full).replace(/\\/g, '/');
      if (re.test(subject)) found.push(full);
      return found.length < max;
    });
    if (!found.length) return `No files matching "${pattern}" under ${base}`;
    return `${found.length}${found.length >= max ? '+' : ''} file(s) matching "${pattern}" under ${base}:\n${found.join('\n')}`;
  }

  async _search_text({ query, path: p, is_regex, case_sensitive, glob, max_results }) {
    if (!query || typeof query !== 'string') throw new ToolError('query is required');
    const base = await this._resolve(p, { allowDefault: true });
    const max = Math.min(2000, Math.max(1, parseInt(max_results, 10) || 200));
    let re;
    try {
      re = new RegExp(is_regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), case_sensitive ? '' : 'i');
    } catch (e) {
      throw new ToolError(`Invalid regular expression: ${e.message}`);
    }
    const globRe = glob ? globToRegExp(glob) : null;
    const results = [];
    const searchFile = async (full) => {
      if (globRe && !globRe.test(W.basename(full))) return true;
      let buf;
      try {
        const st = await fsp.stat(full);
        if (st.size > 2 * 1024 * 1024) return true;
        buf = await fsp.readFile(full);
      } catch {
        return true;
      }
      if (looksBinary(buf)) return true;
      const lines = decodeText(buf).text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          if (results.length >= max) return false;
        }
      }
      return true;
    };
    const st = await fsp.stat(base);
    if (st.isFile()) await searchFile(base);
    else await this._walkFiles(base, searchFile);
    if (!results.length) return `No matches for "${query}" under ${base}`;
    return `${results.length}${results.length >= max ? '+' : ''} match(es):\n${results.join('\n')}`;
  }

  // ---- 写工具 ----

  async _write_file({ path: p, content }) {
    if (typeof content !== 'string') throw new ToolError('content must be a string');
    const file = await this._resolve(p, { mustExist: false });
    let existed = false;
    try {
      const st = await fsp.stat(file);
      if (st.isDirectory()) throw new ToolError(`Is a directory: ${file}`);
      existed = true;
    } catch (e) {
      if (e instanceof ToolError) throw e;
    }
    if (this._needConfirmWrite()) {
      await this._confirmOrThrow({
        kind: 'write',
        title: existed ? 'Claude 想要覆盖本机文件' : 'Claude 想要创建本机文件',
        path: file,
        preview: content,
      });
    }
    await fsp.mkdir(W.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    return `${existed ? 'Overwrote' : 'Created'} ${file} (${Buffer.byteLength(content, 'utf8')} bytes)`;
  }

  async _edit_file({ path: p, old_string, new_string, replace_all }) {
    if (typeof old_string !== 'string' || typeof new_string !== 'string') throw new ToolError('old_string and new_string must be strings');
    if (!old_string) throw new ToolError('old_string must not be empty');
    if (old_string === new_string) throw new ToolError('old_string and new_string are identical');
    const file = await this._resolve(p);
    const buf = await fsp.readFile(file);
    if (looksBinary(buf)) throw new ToolError('Cannot edit a binary file');
    const { text, encoding } = decodeText(buf);
    if (encoding !== 'utf-8') {
      throw new ToolError(`File is ${encoding}-encoded; edit_file only supports UTF-8. Use write_file to rewrite it as UTF-8 if that is acceptable to the user.`);
    }
    const hadBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    let oldS = old_string;
    let newS = new_string;
    let n = countOccurrences(text, oldS);
    if (n === 0 && text.includes('\r\n')) {
      // 文件为 CRLF，而 Claude 给出的字符串通常是 LF
      oldS = old_string.replace(/\r?\n/g, '\r\n');
      newS = new_string.replace(/\r?\n/g, '\r\n');
      n = countOccurrences(text, oldS);
    }
    if (n === 0) throw new ToolError('old_string was not found in the file. Read the file again and copy the exact text.');
    if (n > 1 && !replace_all) throw new ToolError(`old_string matches ${n} times. Add more surrounding context to make it unique, or set replace_all=true.`);
    if (this._needConfirmWrite()) {
      await this._confirmOrThrow({ kind: 'edit', title: 'Claude 想要修改本机文件', path: file, oldText: old_string, newText: new_string, count: replace_all ? n : 1 });
    }
    const updated = replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    await fsp.writeFile(file, (hadBom ? '\ufeff' : '') + updated, 'utf8');
    return `Edited ${file}: replaced ${replace_all ? n : 1} occurrence(s).`;
  }

  async _create_directory({ path: p }) {
    const dir = await this._resolve(p, { mustExist: false });
    await fsp.mkdir(dir, { recursive: true });
    return `Created directory ${dir}`;
  }

  async _move_file({ source, destination }) {
    const src = await this._resolve(source);
    const dst = await this._resolve(destination, { mustExist: false });
    if (this._roots().some((r) => r.toLowerCase() === src.toLowerCase())) throw new ToolError('Cannot move a shared root folder');
    try {
      await fsp.access(dst);
      throw new ToolError(`Destination already exists: ${dst}`);
    } catch (e) {
      if (e instanceof ToolError) throw e;
    }
    if (this._needConfirmWrite()) {
      await this._confirmOrThrow({ kind: 'move', title: 'Claude 想要移动/重命名本机文件', path: src, destination: dst });
    }
    await fsp.mkdir(W.dirname(dst), { recursive: true });
    try {
      await fsp.rename(src, dst);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.cp(src, dst, { recursive: true, errorOnExist: true });
      await fsp.rm(src, { recursive: true, force: true });
    }
    return `Moved ${src} → ${dst}`;
  }

  async _delete_file({ path: p }) {
    const target = await this._resolve(p);
    if (this._roots().some((r) => r.toLowerCase() === target.toLowerCase())) throw new ToolError('Cannot delete a shared root folder');
    if (this._needConfirmWrite()) {
      await this._confirmOrThrow({ kind: 'delete', title: 'Claude 想要删除本机文件（移入回收站）', path: target });
    }
    // 延迟加载 electron，方便在纯 Node 环境下测试其它工具
    const { shell } = require('electron');
    await shell.trashItem(target);
    return `Moved to Recycle Bin: ${target}`;
  }

  async _run_command({ command, cwd, timeout_seconds }) {
    if (!command || typeof command !== 'string') throw new ToolError('command is required');
    const dir = await this._resolve(cwd, { allowDefault: true });
    if (this._mcp().confirmCommands) {
      await this._confirmOrThrow({ kind: 'command', title: 'Claude 想要在本机执行 PowerShell 命令', command, cwd: dir });
    }
    const timeoutMs = Math.min(1800, Math.max(1, parseInt(timeout_seconds, 10) || 120)) * 1000;
    const script =
      "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;\n" +
      command;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        cwd: dir,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const cap = (s, d) => (s.length < MAX_OUTPUT_CHARS ? s + d.toString('utf8') : s);
      child.stdout.on('data', (d) => {
        stdout = cap(stdout, d);
      });
      child.stderr.on('data', (d) => {
        stderr = cap(stderr, d);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve(`Failed to start PowerShell: ${e.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const parts = [`Exit code: ${code}${timedOut ? ` (killed after ${timeoutMs / 1000}s timeout)` : ''}`, `Working directory: ${dir}`];
        if (stdout.trim()) parts.push(`--- stdout ---\n${stdout.trimEnd()}`);
        if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.trimEnd()}`);
        resolve(parts.join('\n'));
      });
    });
  }

  // ---- 本机后台进程 ----

  _procInfo(p) {
    const status = p.status === 'running' ? 'running' : `${p.status}${p.exitCode != null ? ` (exit code ${p.exitCode})` : ''}`;
    return [`Process ${p.id} "${p.name}" — ${status}, PID ${p.pid || '?'}`, `Working directory: ${p.cwd}`, p.urls.length ? `Detected URLs: ${p.urls.join(', ')}` : null].filter(Boolean).join('\n');
  }

  async _start_process({ command, cwd, name }) {
    if (!command || typeof command !== 'string') throw new ToolError('command is required');
    const dir = await this._resolve(cwd, { allowDefault: true });
    if (this._mcp().confirmCommands) {
      await this._confirmOrThrow({ kind: 'command', title: 'Claude 想要在本机后台启动进程', command, cwd: dir });
    }
    const p = this.procs.start({ command, cwd: dir, name });
    // 等一会儿，拿到启动时的输出（以及开发服务器打印的网址）
    for (let i = 0; i < 16 && p.status === 'running' && !p.urls.length; i++) await new Promise((r) => setTimeout(r, 250));
    if (p.urls.length) await new Promise((r) => setTimeout(r, 300));
    const { text } = this.procs.tail(p.id, 40);
    const tip = p.status === 'running' ? 'It keeps running in the background. Use read_process_output for more logs and stop_process to stop it.' : 'The process has already exited — check the output above.';
    return `${this._procInfo(p)}\n${tip}\n--- output so far ---\n${text.trim() || '(no output yet)'}`;
  }

  async _read_process_output({ id, lines }) {
    const { proc, text, truncated } = this.procs.tail(id, parseInt(lines, 10) || 80);
    return `${this._procInfo(proc)}\n--- last output${truncated ? ' (truncated)' : ''} ---\n${text.trim() || '(no output)'}`;
  }

  async _list_processes() {
    const list = this.procs.list();
    if (!list.length) return 'No background processes have been started.';
    return list.map((p) => `${p.id}  ${p.status}${p.exitCode != null ? `(${p.exitCode})` : ''}  ${p.name}${p.urls.length ? `  ${p.urls.join(' ')}` : ''}`).join('\n');
  }

  async _stop_process({ id }) {
    const p = this.procs.stop(id);
    return `Stopped process ${p.id} "${p.name}".`;
  }

  // ---- 内置浏览器 ----

  async _browser_navigate({ url, action }) {
    const { normalizeUrl, isLocalUrl } = require('./browser-host');
    const g = await this.browser.ensure();
    const nav = g.navigationHistory;
    if (action === 'back' || action === 'forward' || action === 'reload') {
      const done = new Promise((r) => {
        const t = setTimeout(r, 15000);
        g.once('did-stop-loading', () => {
          clearTimeout(t);
          r();
        });
      });
      if (action === 'reload') g.reload();
      else if (action === 'back') {
        if (!(nav ? nav.canGoBack() : g.canGoBack())) return 'There is no previous page.';
        nav ? nav.goBack() : g.goBack();
      } else {
        if (!(nav ? nav.canGoForward() : g.canGoForward())) return 'There is no next page.';
        nav ? nav.goForward() : g.goForward();
      }
      await done;
      return `Now at: ${g.getTitle() || '(no title)'} — ${g.getURL()}`;
    }
    let target;
    try {
      target = normalizeUrl(url);
    } catch (e) {
      throw new ToolError(e.message);
    }
    // 本机地址直接打开；外部网站先问用户（可选“本次运行期间自动允许”）
    if (!isLocalUrl(target)) await this._confirmOrThrow({ kind: 'browser', title: 'Claude 想在内置浏览器中打开网站', url: target });
    const r = await this.browser.navigate(g, target);
    if (r === 'ok') return `Loaded: ${g.getTitle() || '(no title)'} — ${g.getURL()}\nUse browser_snapshot to read the page or browser_screenshot to see it.`;
    if (r === 'timeout') return `Still loading after 20s: ${g.getURL()}. Try browser_snapshot or browser_console.`;
    throw new ToolError(`Failed to load ${target}: ${r}. If this is a local dev server, check it is running (list_processes / read_process_output).`);
  }

  async _browser_snapshot({ max_chars }) {
    const g = await this.browser.ensure();
    const s = await this.browser.snapshot(g, max_chars);
    const parts = [`Title: ${s.title || '(no title)'}`, `URL: ${s.url}`, `Scroll: ${s.scroll.y} / ${s.scroll.height} (viewport ${s.scroll.viewport})`, '', `Interactive elements (${s.items.length}):`, s.items.join('\n') || '(none)', '', `Page text${s.truncated ? ' (truncated)' : ''}:`, s.text || '(empty)'];
    return parts.join('\n');
  }

  async _locate(g, ref, selector) {
    if (!ref && !selector) throw new ToolError('ref or selector is required');
    const loc = await this.browser.locate(g, ref, selector);
    if (loc.error) throw new ToolError(loc.error);
    return loc;
  }

  async _browser_click({ ref, selector }) {
    const g = await this.browser.ensure();
    const loc = await this._locate(g, ref, selector);
    await this.browser.click(g, loc.x, loc.y);
    await new Promise((r) => setTimeout(r, 600));
    return `Clicked ${ref ? `[${ref}]` : selector} <${loc.tag}>. Current URL: ${g.getURL()}\nTake a new browser_snapshot to see the result.`;
  }

  async _browser_type({ ref, selector, text, clear, submit }) {
    if (typeof text !== 'string') throw new ToolError('text is required');
    const g = await this.browser.ensure();
    if (ref || selector) {
      const loc = await this._locate(g, ref, selector);
      await this.browser.click(g, loc.x, loc.y);
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.browser.type(g, text, { clear: !!clear, submit: !!submit });
    await new Promise((r) => setTimeout(r, submit ? 600 : 200));
    return `Typed ${text.length} characters${submit ? ' and pressed Enter' : ''}. Current URL: ${g.getURL()}`;
  }

  async _browser_screenshot() {
    const g = await this.browser.ensure();
    const data = await this.browser.screenshot(g);
    return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: `Screenshot of ${g.getURL()}` }] };
  }

  async _browser_console({ clear }) {
    const g = await this.browser.ensure();
    const logs = this.browser.consoleOf(g, { clear: !!clear });
    if (!logs.length) return `No console messages for ${g.getURL()}.`;
    return logs.map((l) => `[${l.level}] ${l.text}${l.source ? `  (${l.source})` : ''}`).join('\n');
  }
}

async function realpathOfNearest(abs) {
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await fsp.realpath(cur);
      return rest.length ? W.join(real, ...rest.reverse()) : real;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = W.dirname(cur);
      if (parent === cur) return abs;
      rest.push(W.basename(cur));
      cur = parent;
    }
  }
}

const SUMMARY = {
  list_allowed_roots: () => '查看共享文件夹',
  list_directory: (a) => `列出目录 ${a.path || ''}`,
  read_file: (a) => `读取 ${a.path || ''}`,
  get_file_info: (a) => `查看信息 ${a.path || ''}`,
  find_files: (a) => `查找文件 ${a.pattern || ''}${a.path ? ` @ ${a.path}` : ''}`,
  search_text: (a) => `搜索内容 “${a.query || ''}”${a.path ? ` @ ${a.path}` : ''}`,
  write_file: (a) => `写入 ${a.path || ''}`,
  edit_file: (a) => `编辑 ${a.path || ''}`,
  create_directory: (a) => `创建目录 ${a.path || ''}`,
  move_file: (a) => `移动 ${a.source || ''} → ${a.destination || ''}`,
  delete_file: (a) => `删除 ${a.path || ''}`,
  run_command: (a) => `执行命令 ${String(a.command || '').slice(0, 120)}`,
  start_process: (a) => `后台启动 ${a.name ? `${a.name}：` : ''}${String(a.command || '').slice(0, 100)}`,
  read_process_output: (a) => `查看进程输出 ${a.id || ''}`,
  list_processes: () => '查看后台进程',
  stop_process: (a) => `停止进程 ${a.id || ''}`,
  browser_navigate: (a) => (a.action ? `浏览器 ${{ back: '后退', forward: '前进', reload: '刷新' }[a.action] || a.action}` : `浏览器打开 ${a.url || ''}`),
  browser_snapshot: () => '浏览器 读取页面',
  browser_click: (a) => `浏览器 点击 ${a.ref ? `[${a.ref}]` : a.selector || ''}`,
  browser_type: (a) => `浏览器 输入 ${String(a.text || '').slice(0, 40)}`,
  browser_screenshot: () => '浏览器 截图',
  browser_console: () => '浏览器 查看控制台',
};

function summarize(name, args) {
  if (name.startsWith(DESKTOP_PREFIX)) return `桌面操作 ${name.slice(DESKTOP_PREFIX.length)} ${JSON.stringify(args).slice(0, 100)}`;
  const f = SUMMARY[name];
  return f ? f(args) : name;
}

module.exports = { LocalTools, globToRegExp, isWithin };
