'use strict';

/**
 * 内置浏览器（停靠区里的 <webview>）。
 * - 安全：独立存储分区、无 preload、无 Node、沙箱；只允许 http / https / about:blank。
 * - 让服务器上的 Claude 操作它：打开网址、读页面、截图、点击、输入、查看控制台。
 * - 列出本机正在监听的端口（npm run dev 等启动的服务），方便预览。
 */

const { webContents } = require('electron');
const { execFile } = require('child_process');

const PARTITION = 'persist:bridge-browser';
const MAX_CONSOLE = 200;

function isWebUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** 没写协议时补全：localhost:3000 → http://localhost:3000，example.com → https://example.com */
function normalizeUrl(input) {
  const v = String(input || '').trim();
  if (!v) throw new Error('url is required');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    if (!isWebUrl(v)) throw new Error('Only http:// and https:// URLs can be opened in the built-in browser.');
    return v;
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v) || /^:\d+/.test(v)) return `http://${v.startsWith(':') ? `localhost${v}` : v}`;
  return `https://${v}`;
}

// 注入页面：给可交互元素编号，返回页面摘要（只读 DOM，不改页面行为）
const SNAPSHOT_JS = `(() => {
  const maxChars = __MAX__;
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick]';
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  document.querySelectorAll('[data-bridge-ref]').forEach((el) => el.removeAttribute('data-bridge-ref'));
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || el.disabled) continue;
    if (n >= 300) break;
    n++;
    el.setAttribute('data-bridge-ref', String(n));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('href') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const extra = tag === 'input' || tag === 'textarea' || tag === 'select' ? ' value=' + JSON.stringify(String(el.value || '').slice(0, 60)) : '';
    const checked = type === 'checkbox' || type === 'radio' ? (el.checked ? ' [checked]' : ' [unchecked]') : '';
    items.push('[' + n + '] <' + tag + (type ? ' type=' + type : '') + '> ' + label + extra + checked);
  }
  let text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { title: document.title, url: location.href, text, truncated, items, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
})()`;

// 找到编号对应的元素，滚动到可见并返回中心坐标
const LOCATE_JS = `((ref, selector) => {
  const el = ref ? document.querySelector('[data-bridge-ref="' + ref + '"]') : document.querySelector(selector);
  if (!el) return { error: ref ? 'Element [' + ref + '] not found. Take a new browser_snapshot; refs change when the page updates.' : 'No element matches the selector.' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
})`;

class BrowserHost {
  /**
   * @param {object} o
   * @param {() => Set<Electron.BrowserWindow>} o.windows
   * @param {() => Electron.BrowserWindow|null} o.mainWindow
   */
  constructor({ windows, mainWindow }) {
    this.windows = windows;
    this.mainWindow = mainWindow;
    this.guests = new Map(); // 宿主窗口 webContents.id → 浏览器 webContents
    this.lastUsed = null; // 最近一次使用的宿主窗口 id
    this.console = new Map(); // 浏览器 webContents.id → 控制台消息
    this._waiters = [];
  }

  /** 每个窗口创建时调用：锁定 <webview> 的安全设置并登记 */
  attachWindow(win) {
    const host = win.webContents;
    host.on('will-attach-webview', (event, prefs, params) => {
      // 不允许页面带任何特权：去掉 preload、关闭 Node、开启沙箱和上下文隔离
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      prefs.allowRunningInsecureContent = false;
      params.partition = PARTITION;
      if (params.src && params.src !== 'about:blank' && !isWebUrl(params.src)) event.preventDefault();
    });
    host.on('did-attach-webview', (_e, guest) => this._register(win, guest));
  }

  _register(win, guest) {
    const hostId = win.webContents.id;
    this.guests.set(hostId, guest);
    this.lastUsed = hostId;
    const logs = [];
    this.console.set(guest.id, logs);
    const push = (entry) => {
      logs.push({ ts: Date.now(), ...entry });
      if (logs.length > MAX_CONSOLE) logs.splice(0, logs.length - MAX_CONSOLE);
    };
    guest.on('console-message', (e) => {
      const level = e && e.level !== undefined ? e.level : 'info';
      const text = String((e && e.message) || '');
      // 开发模式下 Electron 自己的安全提示，与网页无关
      if (text.startsWith('Electron Security Warning')) return;
      push({ level: String(level), text, source: e && e.sourceId ? `${e.sourceId}:${e.lineNumber || 0}` : '' });
    });
    guest.on('did-fail-load', (_ev, code, desc, url, isMain) => {
      if (isMain && code !== -3) push({ level: 'error', text: `Failed to load ${url}: ${desc} (${code})` });
    });
    guest.on('render-process-gone', (_ev, d) => push({ level: 'error', text: `Page crashed: ${d.reason}` }));
    // 新窗口在当前页面打开；非网页协议一律拒绝
    guest.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) guest.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    guest.on('will-navigate', (e, url) => {
      if (!isWebUrl(url) && url !== 'about:blank') e.preventDefault();
    });
    guest.once('destroyed', () => {
      if (this.guests.get(hostId) === guest) this.guests.delete(hostId);
      this.console.delete(guest.id);
    });
    const waiters = this._waiters.splice(0);
    for (const w of waiters) w(guest);
  }

  /** 当前可用的浏览器；没有打开时让主窗口打开浏览器面板并等待 */
  async ensure() {
    const alive = (id) => {
      const g = this.guests.get(id);
      return g && !g.isDestroyed() ? g : null;
    };
    // 已有浏览器：确保面板是打开的，让用户看得到 Claude 在做什么
    const reveal = (hostId) => {
      const host = webContents.fromId(hostId);
      if (host && !host.isDestroyed()) host.send('browser:show');
      return alive(hostId);
    };
    if (this.lastUsed && alive(this.lastUsed)) return reveal(this.lastUsed);
    for (const id of this.guests.keys()) if (alive(id)) return reveal(id);
    const win = this.mainWindow();
    if (!win) throw new Error('Claude Bridge has no open window.');
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The built-in browser did not open in time.')), 15000);
      this._waiters.push((g) => {
        clearTimeout(t);
        resolve(g);
      });
    });
    win.webContents.send('browser:show');
    return p;
  }

  /** 打开网址并等待加载完成（最多 20 秒） */
  async navigate(guest, url) {
    const done = new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 20000);
      const finish = (r) => {
        clearTimeout(t);
        guest.removeListener('did-finish-load', ok);
        guest.removeListener('did-fail-load', fail);
        resolve(r);
      };
      // 刚打开的浏览器会先加载 about:blank，它的完成事件不算
      const ok = () => {
        if (guest.getURL() !== 'about:blank') finish('ok');
      };
      const fail = (_e, code, desc, _u, isMain) => {
        if (isMain && code !== -3) finish(`${desc} (${code})`);
      };
      guest.on('did-finish-load', ok);
      guest.on('did-fail-load', fail);
    });
    guest.loadURL(url).catch(() => {});
    return done;
  }

  async snapshot(guest, maxChars = 8000) {
    const n = Math.max(500, Math.min(50000, Number(maxChars) || 8000));
    return guest.executeJavaScript(SNAPSHOT_JS.replace('__MAX__', String(n)), true);
  }

  async locate(guest, ref, selector) {
    return guest.executeJavaScript(`${LOCATE_JS}(${JSON.stringify(ref ? String(ref) : '')}, ${JSON.stringify(selector || '')})`, true);
  }

  /** 用真实的鼠标事件点击（React 等框架也能正常响应） */
  async click(guest, x, y) {
    guest.focus();
    guest.sendInputEvent({ type: 'mouseMove', x, y });
    guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  async type(guest, text, { clear = false, submit = false } = {}) {
    guest.focus();
    if (clear) {
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    }
    if (text) await guest.insertText(String(text));
    if (submit) {
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      guest.sendInputEvent({ type: 'char', keyCode: '\r' });
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    }
  }

  async screenshot(guest) {
    let img = await guest.capturePage();
    const size = img.getSize();
    if (size.width > 1280) img = img.resize({ width: 1280 });
    return img.toPNG().toString('base64');
  }

  consoleOf(guest, { clear = false } = {}) {
    const logs = this.console.get(guest.id) || [];
    const out = logs.slice();
    if (clear) logs.length = 0;
    return out;
  }
}

/** 本机正在监听的 TCP 端口（排除系统服务和临时端口），用于“预览本机应用” */
function listLocalServices() {
  const run = (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
  return Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('tasklist', ['/FO', 'CSV', '/NH'])]).then(([ns, tl]) => {
    const names = new Map();
    for (const line of tl.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) names.set(Number(m[2]), m[1]);
    }
    const SYSTEM = /^(system|svchost|lsass|wininit|services|spoolsv|smss|csrss|winlogon|searchindexer|mdnsresponder|jhi_service|ipoverusbsvc)\.?/i;
    const seen = new Map();
    for (const line of ns.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (!m) continue;
      const [, addr, portS, pidS] = m;
      const port = Number(portS);
      const pid = Number(pidS);
      if (port < 1024 || port >= 49152) continue;
      if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])$/.test(addr)) continue;
      const proc = names.get(pid) || '';
      if (!proc || SYSTEM.test(proc)) continue;
      if (!seen.has(port)) seen.set(port, { port, pid, process: proc, url: `http://localhost:${port}` });
    }
    return [...seen.values()].sort((a, b) => a.port - b.port);
  });
}

module.exports = { BrowserHost, listLocalServices, normalizeUrl, isLocalUrl, isWebUrl, PARTITION };
