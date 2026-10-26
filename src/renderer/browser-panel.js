// 内置浏览器面板：在本机打开网页（预览 localhost 上的应用），Claude 也能通过本机工具操作它
import { api, $, h, svg, errMsg, toast, relTime, openModal, dialogShell, copyText } from './core.js';

const PARTITION = 'persist:bridge-browser';
let view = null; // <webview>
let ready = false; // webview 的 dom-ready 之前不能调用 getURL / loadURL 等方法
let procs = [];

function curUrl() {
  if (!view) return '';
  if (!ready) return view.getAttribute('src') || '';
  try {
    return view.getURL();
  } catch {
    return view.getAttribute('src') || '';
  }
}

function load(url) {
  if (ready) view.loadURL(url).catch(() => {});
  else view.setAttribute('src', url);
}

/** localhost:3000 → http://localhost:3000；example.com → https://example.com；只允许 http / https */
function normalize(input) {
  const v = String(input || '').trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return /^https?:\/\//i.test(v) ? v : null;
  if (/^:\d+/.test(v)) return `http://localhost${v}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v)) return `http://${v}`;
  return `https://${v}`;
}

function isBlank(u) {
  return !u || u === 'about:blank';
}

function updateNav() {
  const url = curUrl();
  const blank = isBlank(url);
  $('#br-home').hidden = !blank;
  if (document.activeElement !== $('#br-url')) $('#br-url').value = blank ? '' : url;
  $('#btn-br-back').disabled = !ready || !view.canGoBack();
  $('#btn-br-forward').disabled = !ready || !view.canGoForward();
  $('#btn-br-external').disabled = blank;
}

function ensureView() {
  if (view) return view;
  view = document.createElement('webview');
  // 安全设置（无 preload、无 Node、沙箱、独立存储）由主进程在 will-attach-webview 时强制
  view.setAttribute('partition', PARTITION);
  view.setAttribute('src', 'about:blank');
  view.className = 'br-view';
  view.addEventListener('dom-ready', () => {
    ready = true;
    updateNav();
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading']) view.addEventListener(ev, () => ready && updateNav());
  view.addEventListener('did-start-loading', () => $('#btn-br-reload').classList.add('loading'));
  view.addEventListener('did-stop-loading', () => $('#btn-br-reload').classList.remove('loading'));
  view.addEventListener('page-title-updated', (e) => ($('#br-url').title = e.title || ''));
  view.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame && e.errorCode !== -3) toast(`打不开 ${e.validatedURL}：${e.errorDescription}`, 'error');
  });
  $('#br-body').append(view);
  return view;
}

export function openBrowser(url) {
  const panel = $('#browser');
  panel.hidden = false;
  ensureView();
  if (url) go(url);
  else if (isBlank(curUrl())) renderHome();
}

function go(input) {
  const url = normalize(input);
  if (!url) {
    toast('只能打开 http:// 或 https:// 网址', 'error');
    return;
  }
  ensureView();
  load(url);
  $('#br-home').hidden = true;
  $('#br-url').value = url;
}

export function toggleBrowser() {
  const panel = $('#browser');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  openBrowser();
  $('#br-url').focus();
}

function showOutput(p) {
  const pre = h('pre', { class: 'code-view' }, '读取中…');
  const dlg = dialogShell({
    title: `进程输出 · ${p.name}`,
    wide: true,
    cls: 'viewer',
    body: h('div', { class: 'dialog-body' }, h('p', { class: 'hint-text' }, `${p.command}　·　${p.cwd}`), pre),
    foot: h('div', { class: 'dialog-foot' }, h('button', { class: 'btn', onclick: () => copyText(pre.textContent) }, '复制'), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => m.close() }, '关闭')),
  });
  const m = openModal(dlg);
  api.procsOutput(p.id).then(
    (t) => {
      pre.textContent = t || '（没有输出）';
      pre.scrollTop = pre.scrollHeight;
    },
    (e) => (pre.textContent = errMsg(e)),
  );
}

const STATUS = { running: '运行中', exited: '已退出', stopped: '已停止' };
// 常见的开发服务器进程（npm run dev、python -m http.server、Spring、ASP.NET、PHP 等）
const DEV_PROC = /^(node|nodemon|bun|deno|python\d*|pythonw|py|uvicorn|java|javaw|dotnet|php|php-cgi|ruby|go|air|hugo|nginx|httpd|caddy|code|cursor|esbuild)(\.exe)?$/i;

async function renderHome() {
  const box = $('#br-home');
  box.textContent = '';
  box.append(
    h('div', { class: 'br-hero' }, svg('globe', 28), h('b', {}, '用 Claude 浏览'), h('span', {}, '输入网址，或者让 Claude 打开网站。Claude 可以读取页面、点击和输入，用来检查它在本机做出来的网页。')),
  );
  const list = h('div', { class: 'br-services' });
  const scanning = h('div', { class: 'conv-empty' }, h('span', { class: 'spinner' }), ' 正在检测本机端口…');
  box.append(h('div', { class: 'br-sec-head' }, h('span', {}, '预览本机的应用'), h('button', { class: 'icon-btn sm', title: '重新检测', 'aria-label': '重新检测本机服务', onclick: renderHome }, svg('refresh', 13))), list, scanning);
  const seq = ++homeSeq;
  // 先显示 Claude 启动的进程（很快），端口检测（netstat）较慢，完成后再补上
  try {
    procs = await api.procsList();
  } catch {
    procs = [];
  }
  if (seq !== homeSeq) return;
  const shownPorts = new Set();
  renderProcs(list, shownPorts);
  let r;
  try {
    r = await api.browserServices();
  } catch (e) {
    if (seq !== homeSeq) return;
    scanning.textContent = errMsg(e);
    return;
  }
  if (seq !== homeSeq) return;
  scanning.remove();
  // 本机正在监听的其它端口：常见开发环境直接列出，其它程序（聊天软件、代理等）折叠起来
  const svcBtn = (s) => h('button', { class: 'br-svc', title: `${s.process}（PID ${s.pid}）`, onclick: () => go(s.url) }, svg('server', 14), h('span', { class: 'bs-url' }, `localhost:${s.port}`), h('span', { class: 'bs-proc' }, s.process));
  const rest = r.services.filter((s) => !shownPorts.has(s.port));
  const dev = rest.filter((s) => DEV_PROC.test(s.process));
  const other = rest.filter((s) => !DEV_PROC.test(s.process));
  for (const s of dev) list.append(svcBtn(s));
  if (other.length) {
    const key = 'brOtherPorts';
    const det = h('details', { class: 'br-other', open: sessionStorage.getItem(key) === '1' }, h('summary', {}, `其它程序监听的端口（${other.length}）`), other.map(svcBtn));
    det.addEventListener('toggle', () => sessionStorage.setItem(key, det.open ? '1' : '0'));
    list.append(det);
  }
  // 没有 Claude 启动的进程、也没有开发服务器时，提示可以让 Claude 启动（放在折叠的端口列表前面）
  if (!list.querySelector('.br-proc') && !dev.length) {
    list.prepend(h('div', { class: 'conv-empty' }, '没有检测到本机正在运行的开发服务。可以让 Claude 帮你启动，例如：“在本机运行 npm run dev，然后用浏览器打开看看”。'));
  }
}

let homeSeq = 0;

function renderProcs(list, shownPorts) {
  // Claude 启动的后台进程（带检测到的网址）
  for (const p of procs.slice(0, 10)) {
    for (const u of p.urls) {
      const m = u.match(/:(\d+)/);
      if (m) shownPorts.add(Number(m[1]));
    }
    list.append(
      h(
        'div',
        { class: `br-proc ${p.status}` },
        h(
          'div',
          { class: 'bp-main' },
          h('div', { class: 'bp-title' }, h('span', { class: `bp-dot ${p.status}` }), p.name, h('span', { class: 'bp-meta' }, `${STATUS[p.status] || p.status} · ${relTime(p.startedAt)}`)),
          p.urls.length ? h('div', { class: 'bp-urls' }, p.urls.map((u) => h('button', { class: 'link-btn', onclick: () => go(u) }, u))) : null,
        ),
        h('button', { class: 'btn sm', onclick: () => showOutput(p) }, '输出'),
        p.status === 'running' ? h('button', { class: 'btn sm', onclick: () => api.procsStop(p.id).then(renderHome, (e) => toast(errMsg(e), 'error')) }, '停止') : null,
      ),
    );
  }
}

export function initBrowser() {
  const input = $('#br-url');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      go(input.value);
      input.blur();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      updateNav();
      input.blur();
    }
  });
  input.addEventListener('focus', () => input.select());
  $('#btn-br-back').addEventListener('click', () => ready && view.canGoBack() && view.goBack());
  $('#btn-br-forward').addEventListener('click', () => ready && view.canGoForward() && view.goForward());
  $('#btn-br-reload').addEventListener('click', () => {
    if (!ready || isBlank(curUrl())) renderHome();
    else view.reload();
  });
  $('#btn-br-home').addEventListener('click', () => {
    ensureView();
    load('about:blank');
    $('#br-home').hidden = false;
    renderHome();
  });
  $('#btn-br-external').addEventListener('click', () => !isBlank(curUrl()) && api.openExternal(curUrl()));
  $('#btn-browser-close').addEventListener('click', () => ($('#browser').hidden = true));
  // Claude 调用浏览器工具时，主进程要求打开面板
  api.onBrowserShow(() => openBrowser());
  api.onProcs((list) => {
    procs = list;
    if (!$('#browser').hidden && !$('#br-home').hidden) renderHome();
  });
}
