'use strict';

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { uid, isUuid } = require('./util');

const DEFAULT_SETTINGS = {
  clientId: '',
  ssh: {
    host: '',
    port: 22,
    username: 'root',
    authType: 'password', // password | key | agent
    password: '',
    privateKeyPath: '',
    passphrase: '',
    autoReconnect: true,
  },
  claude: {
    command: 'claude',
    workdir: '~',
    model: '',
    effort: '',
    permissionMode: '', // 空 = 使用服务器默认
    usePromptTool: true, // 权限请求在本机界面中审批（--permission-prompt-tool stdio）
    partialMessages: true,
    appendSystemPrompt: true,
    promptSuggestions: true,
    outputStyle: '',
    idleMinutes: 30, // 一轮结束后空闲多久关闭服务器上的 Claude 进程
    extraArgs: '',
  },
  mcp: {
    enabled: true,
    roots: [],
    readOnly: false,
    confirmWrites: true,
    allowCommands: false,
    confirmCommands: true,
    browser: true, // 允许 Claude 使用内置浏览器（打开本机网址不询问，外部网站先询问）
    desktop: false, // Windows-MCP 桌面控制
    desktopConfirm: 'risky', // all | risky | none
  },
  notify: {
    done: true,
    permission: true,
  },
  translation: {
    enabled: true,
    translateInput: true,
    translateOutput: true,
    provider: 'openai', // openai | deepl | baidu
    openai: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
    deepl: { apiKey: '' },
    baidu: { appId: '', secret: '' },
  },
  ui: {
    theme: 'system', // system | light | dark
    displayName: '', // 左下角和问候语里的称呼；空 = 使用 Windows 用户名
  },
};

// 这些字段在磁盘上使用 Windows DPAPI（safeStorage）加密保存
const SECRET_PATHS = [
  ['ssh', 'password'],
  ['ssh', 'passphrase'],
  ['translation', 'openai', 'apiKey'],
  ['translation', 'deepl', 'apiKey'],
  ['translation', 'baidu', 'secret'],
];

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 以 base 的结构为准合并 override：未知键丢弃，类型不符的值丢弃 */
function mergeKnown(base, override) {
  const out = clone(base);
  if (!isPlainObject(override)) return out;
  for (const key of Object.keys(base)) {
    if (!(key in override)) continue;
    const b = base[key];
    const o = override[key];
    if (isPlainObject(b)) out[key] = mergeKnown(b, o);
    else if (Array.isArray(b)) out[key] = Array.isArray(o) ? clone(o) : clone(b);
    else if (typeof b === typeof o) out[key] = o;
    else if (typeof b === 'number' && typeof o === 'string' && o.trim() && !Number.isNaN(Number(o))) out[key] = Number(o);
  }
  return out;
}

function getPath(obj, p) {
  return p.reduce((o, k) => (o ? o[k] : undefined), obj);
}

function setPath(obj, p, value) {
  let o = obj;
  for (let i = 0; i < p.length - 1; i++) o = o[p[i]];
  o[p[p.length - 1]] = value;
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.convDir = path.join(this.dir, 'conversations');
    fs.mkdirSync(this.convDir, { recursive: true });
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.knownHostsFile = path.join(this.dir, 'known_hosts.json');
    this.pendingDeletesFile = path.join(this.dir, 'pending-remote-deletes.json');
    this.metaFile = path.join(this.dir, 'meta.json');
    this.attachmentsDir = path.join(this.dir, 'attachments');
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    this.meta = this._readJson(this.metaFile) || {};
    this.settings = this._loadSettings();
    this.knownHosts = this._readJson(this.knownHostsFile) || {};
  }

  _readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  _encrypt(v) {
    if (!v) return '';
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(v).toString('base64')}`;
    }
    return `plain:${v}`;
  }

  _decrypt(v) {
    if (!v || typeof v !== 'string') return '';
    if (v.startsWith('enc:')) {
      try {
        return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
      } catch {
        return '';
      }
    }
    if (v.startsWith('plain:')) return v.slice(6);
    return v;
  }

  _loadSettings() {
    const raw = this._readJson(this.settingsFile) || {};
    const s = mergeKnown(DEFAULT_SETTINGS, raw);
    for (const p of SECRET_PATHS) setPath(s, p, this._decrypt(getPath(s, p)));
    if (!isUuid(s.clientId)) {
      s.clientId = uid();
      this._writeSettings(s);
    }
    return s;
  }

  _writeSettings(s) {
    const disk = clone(s);
    for (const p of SECRET_PATHS) setPath(disk, p, this._encrypt(getPath(disk, p)));
    writeJsonAtomic(this.settingsFile, disk);
  }

  getSettings() {
    return clone(this.settings);
  }

  saveSettings(next) {
    const merged = mergeKnown(DEFAULT_SETTINGS, next);
    merged.clientId = this.settings.clientId;
    merged.ssh.port = Math.min(65535, Math.max(1, parseInt(merged.ssh.port, 10) || 22));
    merged.mcp.roots = [...new Set((merged.mcp.roots || []).filter((r) => typeof r === 'string' && r.trim()))];
    merged.ui.displayName = String(merged.ui.displayName || '').trim().slice(0, 40);
    this._writeSettings(merged);
    this.settings = merged;
    return this.getSettings();
  }

  // ---------- 主机指纹（TOFU） ----------
  getKnownHost(hostId) {
    return this.knownHosts[hostId] || null;
  }

  setKnownHost(hostId, fingerprint) {
    this.knownHosts[hostId] = fingerprint;
    writeJsonAtomic(this.knownHostsFile, this.knownHosts);
  }

  // ---------- 杂项元数据（额度等） ----------
  getMeta(key) {
    return this.meta[key] === undefined ? null : clone(this.meta[key]);
  }

  setMeta(key, value) {
    this.meta[key] = value;
    try {
      writeJsonAtomic(this.metaFile, this.meta);
    } catch {
      /* 忽略 */
    }
  }

  /** 加密保存的元数据（如本机 MCP 令牌） */
  getSecretMeta(key) {
    return this._decrypt(this.meta[key]) || null;
  }

  setSecretMeta(key, value) {
    this.setMeta(key, this._encrypt(value));
  }

  // ---------- 待执行的服务器端删除 ----------
  getPendingDeletes() {
    const v = this._readJson(this.pendingDeletesFile);
    return Array.isArray(v) ? v.filter((p) => p && typeof p.server === 'string' && Array.isArray(p.ids)) : [];
  }

  setPendingDeletes(list) {
    if (!list.length) {
      try {
        fs.unlinkSync(this.pendingDeletesFile);
      } catch {
        /* 不存在 */
      }
      return;
    }
    writeJsonAtomic(this.pendingDeletesFile, list);
  }

  // ---------- 对话 ----------
  _convFile(id) {
    if (!isUuid(id)) throw new Error('无效的对话 ID');
    return path.join(this.convDir, `${id}.json`);
  }

  listConversations() {
    const list = [];
    for (const name of fs.readdirSync(this.convDir)) {
      if (!name.endsWith('.json')) continue;
      const conv = this._readJson(path.join(this.convDir, name));
      if (!conv || !isUuid(conv.id)) continue;
      list.push(summarize(conv));
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  loadConversation(id) {
    return this._readJson(this._convFile(id));
  }

  saveConversation(conv) {
    writeJsonAtomic(this._convFile(conv.id), conv);
  }

  deleteConversation(id) {
    try {
      fs.unlinkSync(this._convFile(id));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

function summarize(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    workdir: conv.workdir,
    sessionId: conv.sessionId || null,
    pinned: !!conv.pinned,
    mode: conv.mode === 'cowork' ? 'cowork' : 'code',
    activeRun: !!conv.run,
    imported: !!conv.imported,
    // 服务器上有多少条对应的会话记录（删除时提示用）
    remoteSessions: new Set([...(Array.isArray(conv.sessionIds) ? conv.sessionIds : []), conv.sessionId].filter(Boolean)).size,
  };
}

module.exports = { Store, DEFAULT_SETTINGS, summarize };
