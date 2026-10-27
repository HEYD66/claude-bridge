'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, nativeTheme, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { remotePathExpr, uid } = require('./util');
const { Store } = require('./store');
const { SshManager } = require('./ssh-manager');
const { LocalTools } = require('./fs-tools');
const { LocalMcpServer } = require('./mcp-server');
const { ChatManager } = require('./chat-manager');
const { RemoteFs } = require('./remote-fs');
const { Customize } = require('./customize');
const { ServerProbe } = require('./server-probe');
const { DesktopMcp } = require('./desktop-mcp');
const { LocalProcesses } = require('./local-procs');
const { BrowserHost, listLocalServices } = require('./browser-host');
const translator = require('./translator');

const APP_ROOT = path.join(__dirname, '..', '..');
const APP_ORIGIN = 'app://bundle';
const ASK_TIMEOUT = 10 * 60 * 1000;

// 渲染进程通过自定义协议加载，只开放这几个目录
const SERVED_DIRS = [
  path.join(APP_ROOT, 'src', 'renderer'),
  path.join(APP_ROOT, 'node_modules', 'marked', 'lib'),
  path.join(APP_ROOT, 'node_modules', 'dompurify', 'dist'),
  path.join(APP_ROOT, 'node_modules', '@xterm', 'xterm', 'lib'),
  path.join(APP_ROOT, 'node_modules', '@xterm', 'xterm', 'css'),
  path.join(APP_ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib'),
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const APP_SCHEME = { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } };
// 只能在 ready 之前调用；端到端测试在 ready 之后才加载本文件，由测试脚本提前注册
if (!app.isReady()) protocol.registerSchemesAsPrivileged([APP_SCHEME]);

const windows = new Set();
let store;
let ssh;
let tools;
let mcpServer;
let chat;
let rfs;
let customize;
let probe; // 服务器环境检测（origin-probe）
let desktop;
let procs; // Claude 在本机启动的后台进程
let browserHost; // 内置浏览器
const pendingAsks = new Map();
const autoApprove = new Set(); // 本次运行中“始终允许”的本机操作类型
const activity = [];
const terminals = new Map();

// ---------------- 窗口通信 ----------------

function broadcast(channel, payload) {
  for (const w of windows) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function mainWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused)) return focused;
  return [...windows][0] || null;
}

function ask(kind, payload, timeoutMs = ASK_TIMEOUT) {
  return new Promise((resolve) => {
    if (!windows.size) {
      resolve(null);
      return;
    }
    const id = uid();
    const finish = (answer) => {
      clearTimeout(timer);
      pendingAsks.delete(id);
      broadcast('ask:cancel', id);
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    pendingAsks.set(id, finish);
    // 所有窗口都显示，任意一个回答即可
    broadcast('ask', { id, kind, payload });
    const w = mainWindow();
    if (w && !w.isFocused()) w.flashFrame(true);
  });
}

async function verifyHostKey(hostId, fingerprint) {
  const known = store.getKnownHost(hostId);
  if (known === fingerprint) return true;
  const answer = await ask('hostkey', { host: hostId, fingerprint, previous: known }, 5 * 60 * 1000);
  if (answer && answer.ok) {
    store.setKnownHost(hostId, fingerprint);
    return true;
  }
  return false;
}

async function confirmLocalOperation(req) {
  if (autoApprove.has(`op:${req.kind}`)) return true;
  notify('permission', null, 'Claude 请求操作本机', req.title || '');
  const answer = await ask('confirm', req);
  if (answer && answer.ok && answer.always) autoApprove.add(`op:${req.kind}`);
  return !!(answer && answer.ok);
}

// ---------------- 通知 ----------------

function anyFocused() {
  return [...windows].some((w) => !w.isDestroyed() && w.isFocused());
}

function notify(kind, convId, title, body) {
  const s = store.getSettings().notify || {};
  if (!s[kind] || anyFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title: title ? `Claude Bridge · ${title}` : 'Claude Bridge', body: body || '', silent: kind === 'done' });
  n.on('click', () => {
    const w = mainWindow();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
    if (convId) w.webContents.send('open-conv', convId);
  });
  n.show();
  const w = mainWindow();
  if (w && kind === 'permission') w.flashFrame(true);
}

// ---------------- 状态 ----------------

function buildStatus() {
  const s = store.getSettings();
  return {
    ssh: ssh.getStatus(),
    mcp: {
      enabled: s.mcp.enabled,
      localPort: mcpServer.port,
      remotePort: ssh.forward ? ssh.forward.remotePort : null,
      roots: s.mcp.roots.length,
      readOnly: s.mcp.readOnly,
    },
    desktop: desktop.status(),
    running: chat.runningIds(),
  };
}

function pushStatus() {
  broadcast('status', buildStatus());
}

function syncDesktop() {
  const s = store.getSettings().mcp;
  if (s.desktop && desktop.state === 'off') desktop.start().catch(() => {});
  else if (!s.desktop && desktop.state !== 'off') desktop.stop();
}

// ---------------- 窗口 ----------------

function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  // 与 styles.css 中的 --bg 保持一致
  return dark ? { color: '#1f1f1f', symbolColor: '#c7c7c7', height: 40 } : { color: '#faf9f5', symbolColor: '#3d3d3a', height: 40 };
}

function windowsUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** 在新的控制台窗口里用系统自带的 OpenSSH 登录服务器，并进入工作目录 */
function openSshTerminal(workdir) {
  const s = store.getSettings().ssh;
  const host = String(s.host || '').trim();
  const user = String(s.username || '').trim();
  if (!host || !user) throw new Error('请先在设置中填写服务器地址和用户名');
  if (/^-/.test(host) || /^-/.test(user) || /[\s@]/.test(host)) throw new Error('服务器地址或用户名格式不正确');
  const sysSsh = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const exe = fs.existsSync(sysSsh) ? sysSsh : 'ssh.exe';
  const args = ['-t', '-p', String(s.port || 22)];
  if (s.authType === 'key' && s.privateKeyPath) args.push('-i', s.privateKeyPath);
  args.push(`${user}@${host}`, `cd ${remotePathExpr(workdir || '~')} 2>/dev/null; exec "$SHELL" -l`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (e) => reject(new Error(`无法启动 ssh：${e.message}（请在“可选功能”中安装 OpenSSH 客户端）`)));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function createWindow(convId) {
  const colors = overlayColors();
  const w = new BrowserWindow({
    width: windows.size ? 1000 : 1240,
    height: windows.size ? 760 : 840,
    minWidth: 780,
    minHeight: 540,
    title: 'Claude Bridge',
    backgroundColor: colors.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: colors,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true, // 内置浏览器面板；安全设置在 BrowserHost.attachWindow 中强制
    },
  });
  windows.add(w);
  if (browserHost) browserHost.attachWindow(w);
  w.loadURL(`${APP_ORIGIN}/src/renderer/index.html${convId ? `#conv=${encodeURIComponent(convId)}` : ''}`);
  w.once('ready-to-show', () => w.show());
  w.on('focus', () => w.flashFrame(false));
  w.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) e.preventDefault();
  });
  const wcId = w.webContents.id;
  w.on('closed', () => {
    windows.delete(w);
    // 关闭该窗口打开的终端
    for (const [id, t] of terminals) {
      if (t.owner === wcId) {
        try {
          t.stream.close();
        } catch {
          /* 忽略 */
        }
        terminals.delete(id);
      }
    }
  });
  return w;
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.toString());
  } catch {
    /* 忽略无效链接 */
  }
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'bundle') return new Response('Not found', { status: 404 });
    const pathname = decodeURIComponent(url.pathname);
    let filePath;
    if (pathname.startsWith('/attachments/')) {
      // 用户发送过的图片附件
      filePath = path.join(store.attachmentsDir, path.basename(pathname));
    } else {
      filePath = path.normalize(path.join(APP_ROOT, pathname));
      if (!SERVED_DIRS.some((d) => filePath.startsWith(d + path.sep))) return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------- 内置终端 ----------------

async function openTerminal(owner, { cols, rows, command }) {
  const stream = await ssh.shell({ cols, rows });
  const id = uid();
  terminals.set(id, { stream, owner });
  const sendTo = (channel, payload) => {
    for (const w of windows) if (!w.isDestroyed() && w.webContents.id === owner) w.webContents.send(channel, payload);
  };
  stream.on('data', (d) => sendTo('term:data', { id, data: d.toString('utf8') }));
  stream.stderr.on('data', (d) => sendTo('term:data', { id, data: d.toString('utf8') }));
  stream.on('close', () => {
    terminals.delete(id);
    sendTo('term:exit', { id });
  });
  if (command) stream.write(`${command}\n`);
  return id;
}

// ---------------- IPC ----------------

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const frameUrl = event.senderFrame ? event.senderFrame.url : '';
    if (!frameUrl.startsWith(`${APP_ORIGIN}/`)) throw new Error('Forbidden');
    return fn(...args, event);
  });
}

function registerIpc() {
  handle('settings:get', () => store.getSettings());
  handle('settings:save', async (next) => {
    const before = store.getSettings();
    const saved = store.saveSettings(next);
    nativeTheme.themeSource = saved.ui.theme;
    if (before.mcp.enabled !== saved.mcp.enabled) await ssh.setTunnelEnabled(saved.mcp.enabled, mcpServer.port);
    if (before.claude.command !== saved.claude.command && ssh.isConnected()) chat.refreshClaudeInfo().catch(() => {});
    chat.applyLiveSettings(before, saved);
    syncDesktop();
    pushStatus();
    broadcast('settings', saved);
    return saved;
  });

  handle('status:get', () => buildStatus());
  handle('app:info', () => ({ username: windowsUsername(), version: app.getVersion(), slashCommands: chat.slashCommands, claudeInfo: chat.claudeInfo, rateLimits: chat.rateLimits, memoryPaths: chat.memoryPaths }));
  handle('claude:refreshInfo', () => chat.refreshClaudeInfo());
  handle('stats:get', (range) => chat.stats(['all', '30d', '7d'].includes(range) ? range : 'all'));
  handle('ssh:openTerminal', (workdir) => openSshTerminal(workdir));
  handle('remote:gitBranch', (workdir) => chat.gitBranch(workdir));
  handle('conv:export', async (id, event) => {
    const conv = chat.get(id);
    const safe = String(conv.title || 'conversation').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80);
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), { title: '导出对话', defaultPath: `${safe}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, chat.toMarkdown(conv), 'utf8');
    return r.filePath;
  });
  handle('ssh:connect', async () => {
    const s = store.getSettings();
    await ssh.connect(s.ssh, { localMcpPort: s.mcp.enabled ? mcpServer.port : 0 });
    return buildStatus();
  });
  handle('ssh:disconnect', () => {
    ssh.disconnect();
    return buildStatus();
  });
  handle('claude:detect', () => chat.detectClaude());
  // 版本、下载地址和校验值都固定在主进程，渲染进程只能选是否联网
  handle('probe:info', () => probe.info());
  handle('probe:run', (opts) => probe.run({ offline: !(opts && opts.offline === false) }));

  handle('translate:test', async (tr) => {
    const sample = 'The build finished successfully. Run `npm test` to verify the changes.';
    const zh = await translator.translate(sample, 'en', 'zh', tr);
    const en = await translator.translate('请帮我检查这个函数为什么会报错。', 'zh', 'en', tr);
    return { zh, en };
  });
  handle('translate:text', (text, from, to) => translator.translate(String(text || ''), from === 'en' ? 'en' : 'zh', to === 'zh' ? 'zh' : 'en', store.getSettings().translation));

  // 对话
  handle('conv:list', () => chat.list());
  handle('conv:get', (id) => chat.get(id));
  handle('conv:create', (opts) => chat.create(opts || {}));
  handle('conv:rename', (id, title) => chat.rename(id, title));
  handle('conv:pin', (id, pinned) => chat.setPinned(id, pinned));
  handle('conv:delete', (id, opts) => chat.delete(id, { remote: !!(opts && opts.remote) }));
  handle('conv:setWorkdir', (id, dir) => chat.setWorkdir(id, dir));
  handle('conv:search', (q) => chat.search(q));
  handle('conv:serverSessions', () => chat.listServerSessions());
  handle('conv:import', (file) => chat.importServerSession(file));
  handle('conv:openWindow', (id) => {
    createWindow(id);
  });

  // 聊天
  handle('chat:send', (id, text, opts) => chat.send(id, text, opts || {}));
  handle('chat:stop', (id) => chat.stop(id));
  handle('chat:cancelQueued', (id, msgId) => chat.cancelQueued(id, msgId));
  handle('chat:sendNow', (id, msgId) => chat.sendNow(id, msgId));
  handle('chat:answer', (id, reqId, answer) => chat.answerPermission(id, reqId, answer || {}));
  handle('chat:edit', (id, msgId, text) => chat.editMessage(id, msgId, text));
  handle('chat:regenerate', (id, msgId) => chat.regenerate(id, msgId));
  handle('chat:switchVariant', (id, slotId, k) => chat.switchVariant(id, slotId, k));
  handle('chat:rewind', (id, msgId, opts) => chat.rewind(id, msgId, opts || {}));
  handle('chat:context', (id) => chat.contextUsage(id));
  handle('chat:retranslate', (id, msgId, blockKey) => chat.retranslate(id, msgId, blockKey));

  handle('ask:answer', (id, answer) => {
    const fn = pendingAsks.get(id);
    if (fn) fn(answer);
  });

  handle('activity:list', () => activity.slice());
  handle('activity:clear', () => {
    activity.length = 0;
  });

  // 服务器文件
  handle('rfs:list', (p) => rfs.list(p));
  handle('rfs:read', (p) => rfs.read(p));
  handle('rfs:home', () => rfs.home());
  handle('rfs:find', (root, q) => rfs.find(root, q));
  handle('rfs:grep', (root, q) => rfs.grep(root, q));
  handle('remote:gitStatus', (workdir) => rfs.gitStatus(workdir));
  handle('remote:gitDiff', (root, file, opts) => rfs.gitDiff(String(root || ''), file, { untracked: !!(opts && opts.untracked) }));

  // 自定义
  handle('custom:overview', (workdir) => customize.overview(workdir));
  handle('custom:read', (p) => customize.readFile(p));
  handle('custom:write', (p, content) => customize.writeFile(p, content));
  handle('custom:remove', (p) => customize.removeFile(p));
  handle('custom:readJson', (p) => customize.readJson(p));
  handle('custom:patchSettings', (p, key, value) => customize.patchSettings(p, key, value));
  handle('custom:saveSkill', (o) => customize.saveSkill(o));
  handle('custom:saveAgent', (o) => customize.saveAgent(o));
  handle('custom:cli', (args) => customize.cli(args));

  // 内置终端
  handle('term:open', (opts, event) => openTerminal(event.sender.id, { cols: opts.cols, rows: opts.rows, command: opts.kind ? customize.terminalCommand(opts.kind, opts.workdir) : null }));
  handle('term:write', (id, data) => {
    const t = terminals.get(id);
    if (t) t.stream.write(data);
  });
  handle('term:resize', (id, cols, rows) => {
    const t = terminals.get(id);
    if (t && cols > 0 && rows > 0) t.stream.setWindow(rows, cols, 0, 0);
  });
  handle('term:close', (id) => {
    const t = terminals.get(id);
    if (t) t.stream.close();
    terminals.delete(id);
  });

  // 内置浏览器 / 本机后台进程
  handle('browser:services', async () => ({ services: await listLocalServices(), procs: procs.list() }));
  handle('procs:list', () => procs.list());
  handle('procs:stop', (id) => {
    procs.stop(id);
    return procs.list();
  });
  handle('procs:output', (id) => procs.tail(id, 400).text);

  // 桌面控制
  handle('desktop:status', () => desktop.status());
  handle('desktop:restart', async () => {
    desktop.stop();
    syncDesktop();
    return desktop.status();
  });

  handle('dialog:pickFolders', async (event) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择要共享给 Claude 的文件夹', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:pickFiles', async (event) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择要让 Claude 处理的本机文件', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:pickImages', async (event) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('dialog:pickFile', async (event) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: '选择 SSH 私钥', properties: ['openFile', 'showHiddenFiles'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:openExternal', (url) => openExternal(url));
  handle('shell:openPath', (p) => {
    const roots = store.getSettings().mcp.roots;
    if (roots.includes(p)) shell.openPath(p);
  });
  handle('clipboard:write', (text) => clipboard.writeText(String(text || '')));
  handle('window:refreshOverlay', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.setTitleBarOverlay(overlayColors());
  });
  handle('window:new', () => {
    createWindow();
  });
}

// ---------------- 启动 ----------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindow();
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('local.claude-bridge');
    registerAppProtocol();
    store = new Store();
    nativeTheme.themeSource = store.getSettings().ui.theme;

    desktop = new DesktopMcp();
    desktop.on('state', pushStatus);
    procs = new LocalProcesses();
    procs.on('changed', (list) => broadcast('procs', list));
    browserHost = new BrowserHost({ windows: () => windows, mainWindow });
    tools = new LocalTools({ getSettings: () => store.getSettings(), confirm: confirmLocalOperation, desktop, procs, browser: browserHost });
    tools.on('activity', (act) => {
      const i = activity.findIndex((a) => a.id === act.id);
      if (i >= 0) activity[i] = act;
      else activity.push(act);
      if (activity.length > 300) activity.splice(0, activity.length - 300);
      broadcast('activity', act);
    });

    mcpServer = new LocalMcpServer({ tools, version: app.getVersion(), token: store.getSecretMeta('mcpToken') || '' });
    store.setSecretMeta('mcpToken', mcpServer.token);
    await mcpServer.start();

    // 隧道端口和令牌跨重连、重启保持不变，服务器上仍在运行的 claude 才不会连到失效的地址
    ssh = new SshManager({ verifyHostKey, getPreferredTunnelPort: (hostId) => (store.getMeta('tunnelPorts') || {})[hostId] || 0 });
    ssh.on('tunnel', ({ hostId, remotePort, reused }) => {
      // 没能复用旧端口：旧端口在断开期间可能被服务器上的其他程序占用并收到过令牌，换一个新令牌
      if (!reused) store.setSecretMeta('mcpToken', mcpServer.rotateToken());
      store.setMeta('tunnelPorts', { ...(store.getMeta('tunnelPorts') || {}), [hostId]: remotePort });
    });
    rfs = new RemoteFs(ssh);
    customize = new Customize(rfs, ssh, () => store.getSettings());
    probe = new ServerProbe(ssh);
    ssh.on('state', pushStatus);

    chat = new ChatManager({
      store,
      ssh,
      translator,
      attachmentsDir: store.attachmentsDir,
      getMcpInfo: () => ({ remotePort: ssh.forward ? ssh.forward.remotePort : null, token: mcpServer.token }),
    });
    chat.on('event', (ev) => {
      broadcast('chat:event', ev);
      if (ev.type === 'run-state') pushStatus();
    });
    chat.on('notify', ({ kind, convId, title, body }) => notify(kind, convId, title, body));

    // 连上服务器后：读取模型列表、执行排队的删除、接回仍在服务器上运行的任务
    ssh.on('ready', () => {
      chat.refreshClaudeInfo().catch(() => {});
      chat.processPendingRemoteDeletes().catch(() => {});
      chat.reattachAll().catch((e) => console.error(e));
    });

    nativeTheme.on('updated', () => {
      for (const w of windows) if (!w.isDestroyed()) w.setTitleBarOverlay(overlayColors());
    });

    registerIpc();
    syncDesktop();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    // 不停止服务器上的任务：它们会继续运行，下次打开后自动接上
    if (chat) chat.flushAll();
    if (desktop) desktop.stop();
    // Claude 在本机启动的开发服务器等随程序一起结束
    if (procs) procs.stopAll();
    if (ssh) ssh.disconnect();
    if (mcpServer) mcpServer.stop();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
