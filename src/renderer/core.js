// 渲染进程公共模块：状态、DOM 工具、格式化、菜单与弹窗
import { icon } from './icons.js';

export const api = window.bridge;
export const $ = (sel) => document.querySelector(sel);

export const state = {
  appInfo: null,
  settings: null,
  status: null,
  convs: [],
  currentId: null,
  current: null,
  meta: {}, // convId → { context, suggestion, run, running }
  running: new Set(),
  showOriginal: new Set(),
  expanded: new Set(),
  collapsed: new Set(),
  activity: [],
  pendingWorkdir: null,
  pendingWorktree: false,
  mode: localStorage.getItem('mode') === 'cowork' ? 'cowork' : 'code',
  search: '',
  searchResults: null,
  stats: null,
  statsTab: 'overview',
  statsRange: 'all',
  branch: null,
  branchFor: null,
  slashCommands: [],
  slashDesc: {},
  claudeInfo: null,
  infoLoading: false,
  rateLimits: null,
  memoryPaths: null,
  attachments: [], // 待发送的图片 [{id, dataUrl?, path?, name}]
  editing: null, // 正在编辑的用户消息 id
};

// 由 app.js 注入，供其它模块回调
export const hooks = {
  rerender: () => {},
  rerenderMessage: () => {},
  openConversation: () => {},
  refreshAll: () => {},
  fillInput: () => {},
  openTerminal: () => {},
};

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(name, size = 16, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size, cls);
  return t.content.firstElementChild;
}

export function errMsg(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function getPath(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = value;
}

export function toggleSet(set, key, on) {
  if (on) set.add(key);
  else set.delete(key);
}

export function toast(text, type = '') {
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, text);
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 2600);
}

export async function copyText(text) {
  await api.copy(text);
  toast('已复制');
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

export function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  const MIN = 60e3;
  const HR = 3600e3;
  const DAY = 864e5;
  if (d < MIN) return '刚刚';
  if (d < HR) return `${Math.floor(d / MIN)} 分钟前`;
  if (d < DAY) return `${Math.floor(d / HR)} 小时前`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} 天前`;
  if (d < 30 * DAY) return `${Math.floor(d / (7 * DAY))} 周前`;
  const t = new Date(ts);
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}

export function fmtHour(hr) {
  if (hr == null) return '—';
  const label = hr < 6 ? '凌晨' : hr < 12 ? '上午' : hr === 12 ? '中午' : hr < 18 ? '下午' : '晚上';
  return `${label} ${hr % 12 || 12} 点`;
}

/** claude-opus-5-5 → Opus 5.5；claude-3-5-sonnet-20241022 → Sonnet 3.5 */
export function modelName(id) {
  if (!id) return '';
  const raw = String(id);
  const s = raw.replace(/\[1m\]$/i, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const parts = s.split('-');
  const fam = parts.find((p) => /^[a-z]+$/i.test(p));
  if (!fam) return raw;
  const nums = parts.filter((p) => /^\d+$/.test(p));
  return `${fam[0].toUpperCase()}${fam.slice(1)}${nums.length ? ` ${nums.join('.')}` : ''}`;
}

export function workdirName(wd) {
  const v = String(wd || '~').trim().replace(/\/+$/, '');
  if (!v || v === '~') return '~';
  return v.split('/').pop() || v;
}

export function translationOn() {
  const t = state.settings.translation;
  return t.enabled && t.translateOutput;
}

export function tryParse(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function connected() {
  return !!(state.status && state.status.ssh.state === 'connected');
}

export function currentWorkdir() {
  return state.current ? state.current.workdir : state.pendingWorkdir || (state.mode === 'cowork' ? '~' : state.settings.claude.workdir || '~');
}

export function currentRunning() {
  return !!state.currentId && state.running.has(state.currentId);
}

export async function patchSettings(fn) {
  const next = structuredClone(state.settings);
  fn(next);
  state.settings = await api.saveSettings(next);
  state.status = await api.getStatus();
  hooks.refreshAll();
}

export function clip(s, n = 6000) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}\n…（共 ${v.length} 字符，已截断显示）` : v;
}

export function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

// ======================= 下拉菜单 =======================

let menuState = null;

export function closeMenu({ restoreFocus = true } = {}) {
  if (!menuState) return;
  const { el, anchor, onDown } = menuState;
  menuState = null;
  el.remove();
  document.removeEventListener('mousedown', onDown, true);
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor.isConnected) anchor.focus();
  }
}

/** items: { text, desc, icon, checked, disabled, danger, onClick } | '-' | { heading } */
export function showMenu(anchor, items, { above = false } = {}) {
  if (menuState && menuState.anchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu({ restoreFocus: false });
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      el.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.heading) {
      el.append(h('div', { class: 'menu-label' }, it.heading));
      continue;
    }
    const radio = it.checked !== undefined;
    const btn = h(
      'button',
      { type: 'button', class: `menu-item${it.danger ? ' danger' : ''}`, role: radio ? 'menuitemradio' : 'menuitem', 'aria-checked': radio ? String(!!it.checked) : null, disabled: it.disabled || null },
      radio ? h('span', { class: 'mi-check', html: it.checked ? icon('check', 15) : '' }) : it.icon ? svg(it.icon, 15) : null,
      h('span', { class: 'mi-text' }, h('span', {}, it.text), it.desc ? h('span', { class: 'mi-desc' }, it.desc) : null),
    );
    btn.addEventListener('click', () => {
      closeMenu({ restoreFocus: false });
      if (it.onClick) Promise.resolve(it.onClick()).catch((e) => toast(errMsg(e), 'error'));
    });
    el.append(btn);
  }
  $('#menu-root').append(el);
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = r.left;
  if (left + mw > innerWidth - 8) left = Math.max(8, r.right - mw);
  let top = above || r.bottom + mh + 6 > innerHeight - 8 ? r.top - mh - 6 : r.bottom + 6;
  if (top < 8) top = 8;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const onDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu({ restoreFocus: false });
  };
  document.addEventListener('mousedown', onDown, true);
  el.addEventListener('keydown', (e) => {
    const list = [...el.querySelectorAll('.menu-item:not(:disabled)')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Tab') {
      closeMenu({ restoreFocus: false });
    }
  });
  menuState = { el, anchor, onDown };
  (el.querySelector('.menu-item[aria-checked="true"]') || el.querySelector('.menu-item:not(:disabled)'))?.focus();
}

/** 锚定在元素旁的弹出面板（上下文用量等） */
export function showPopover(anchor, content, { above = true } = {}) {
  closeMenu({ restoreFocus: false });
  const el = h('div', { class: 'menu popover', role: 'dialog' }, content);
  $('#menu-root').append(el);
  const r = anchor.getBoundingClientRect();
  let left = Math.min(r.left, innerWidth - el.offsetWidth - 8);
  left = Math.max(8, left);
  let top = above ? r.top - el.offsetHeight - 6 : r.bottom + 6;
  if (top < 8) top = r.bottom + 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const onDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu({ restoreFocus: false });
  };
  document.addEventListener('mousedown', onDown, true);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
    }
  });
  menuState = { el, anchor, onDown };
  return el;
}

// ======================= 弹窗 =======================

export function openModal(dialog, { top = false, dismissible = true, onClose } = {}) {
  closeMenu({ restoreFocus: false });
  const overlay = h('div', { class: `overlay${top ? ' top' : ''}` }, dialog);
  const prevFocus = document.activeElement;
  let closed = false;
  const close = (reason) => {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus();
    if (onClose) onClose(reason);
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && dismissible) close('dismiss');
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close('dismiss');
    } else if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  $('#modal-root').append(overlay);
  setTimeout(() => {
    const f = dialog.querySelector('[autofocus]') || dialog.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea') || dialog.querySelector('button.primary');
    if (f) f.focus();
  }, 0);
  return { close, overlay };
}

let dialogSeq = 0;
export function dialogShell({ title, badge, body, foot, wide = false, cls = '' }) {
  const id = `dlg-${++dialogSeq}`;
  return h(
    'div',
    { class: `dialog${wide ? ' wide' : ''}${cls ? ` ${cls}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
    h('div', { class: 'dialog-head' }, badge ? h('span', { class: 'badge', html: badge }) : null, h('h2', { id }, title)),
    body,
    foot,
  );
}

export function confirmDialog({ title, message, okText = '确定', danger = false, body }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, autofocus: true }, okText);
    const cancel = h('button', { class: 'btn' }, '取消');
    const dlg = dialogShell({ title, body: h('div', { class: 'dialog-body' }, message ? h('p', {}, message) : null, body || null), foot: h('div', { class: 'dialog-foot' }, cancel, ok) });
    const m = openModal(dlg, { onClose: () => resolve(result) });
    ok.onclick = () => {
      result = true;
      m.close();
    };
    cancel.onclick = () => m.close();
  });
}

export function promptDialog({ title, label = '', value = '', hint = '', placeholder = '', multiline = false }) {
  return new Promise((resolve) => {
    let result = null;
    const input = multiline ? h('textarea', { rows: '6', placeholder, spellcheck: 'false', 'aria-label': label || title }) : h('input', { type: 'text', placeholder, spellcheck: 'false', 'aria-label': label || title });
    input.value = value;
    const ok = h('button', { class: 'btn primary' }, '确定');
    const cancel = h('button', { class: 'btn' }, '取消');
    const dlg = dialogShell({
      title,
      body: h('div', { class: 'dialog-body' }, h('div', { class: 'field' }, label ? h('label', {}, label) : null, input, hint ? h('div', { class: 'hint' }, hint) : null)),
      foot: h('div', { class: 'dialog-foot' }, cancel, ok),
    });
    const m = openModal(dlg, { onClose: () => resolve(result) });
    const submit = () => {
      result = input.value;
      m.close();
    };
    ok.onclick = submit;
    cancel.onclick = () => m.close();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (!multiline || e.ctrlKey)) submit();
    });
    setTimeout(() => input.select && input.select(), 0);
  });
}

export function lightbox(src, alt = '') {
  const img = h('img', { src, alt, class: 'lightbox-img' });
  const dlg = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': alt || '图片' }, img);
  const m = openModal(dlg);
  dlg.addEventListener('click', () => m.close());
}
