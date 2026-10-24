'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
  return (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('bridge', {
  // 设置 / 状态
  getSettings: () => invoke('settings:get'),
  saveSettings: (s) => invoke('settings:save', s),
  getStatus: () => invoke('status:get'),
  appInfo: () => invoke('app:info'),
  connect: () => invoke('ssh:connect'),
  disconnect: () => invoke('ssh:disconnect'),
  detectClaude: () => invoke('claude:detect'),
  refreshClaudeInfo: () => invoke('claude:refreshInfo'),
  testTranslation: (tr) => invoke('translate:test', tr),
  translate: (text, from, to) => invoke('translate:text', text, from, to),
  getStats: (range) => invoke('stats:get', range),
  gitBranch: (workdir) => invoke('remote:gitBranch', workdir),
  openTerminal: (workdir) => invoke('ssh:openTerminal', workdir),

  // 对话
  listConversations: () => invoke('conv:list'),
  getConversation: (id) => invoke('conv:get', id),
  createConversation: (opts) => invoke('conv:create', opts),
  renameConversation: (id, title) => invoke('conv:rename', id, title),
  pinConversation: (id, pinned) => invoke('conv:pin', id, pinned),
  deleteConversation: (id, opts) => invoke('conv:delete', id, opts),
  setWorkdir: (id, dir) => invoke('conv:setWorkdir', id, dir),
  search: (q) => invoke('conv:search', q),
  serverSessions: () => invoke('conv:serverSessions'),
  importSession: (file) => invoke('conv:import', file),
  exportConversation: (id) => invoke('conv:export', id),
  openInWindow: (id) => invoke('conv:openWindow', id),
  newWindow: () => invoke('window:new'),

  // 聊天
  send: (id, text, opts) => invoke('chat:send', id, text, opts),
  stop: (id) => invoke('chat:stop', id),
  cancelQueued: (id, msgId) => invoke('chat:cancelQueued', id, msgId),
  sendNow: (id, msgId) => invoke('chat:sendNow', id, msgId),
  answerPermission: (id, reqId, answer) => invoke('chat:answer', id, reqId, answer),
  editMessage: (id, msgId, text) => invoke('chat:edit', id, msgId, text),
  regenerate: (id, msgId) => invoke('chat:regenerate', id, msgId),
  switchVariant: (id, slotId, k) => invoke('chat:switchVariant', id, slotId, k),
  rewind: (id, msgId, opts) => invoke('chat:rewind', id, msgId, opts),
  contextUsage: (id) => invoke('chat:context', id),
  retranslate: (id, msgId, blockKey) => invoke('chat:retranslate', id, msgId, blockKey),

  // 本机确认 / 操作记录
  answer: (id, answer) => invoke('ask:answer', id, answer),
  listActivity: () => invoke('activity:list'),
  clearActivity: () => invoke('activity:clear'),

  // 服务器文件 / 自定义
  rfsList: (p) => invoke('rfs:list', p),
  rfsRead: (p) => invoke('rfs:read', p),
  rfsHome: () => invoke('rfs:home'),
  customOverview: (workdir) => invoke('custom:overview', workdir),
  customRead: (p) => invoke('custom:read', p),
  customWrite: (p, content) => invoke('custom:write', p, content),
  customRemove: (p) => invoke('custom:remove', p),
  customReadJson: (p) => invoke('custom:readJson', p),
  customPatchSettings: (p, key, value) => invoke('custom:patchSettings', p, key, value),
  customSaveSkill: (o) => invoke('custom:saveSkill', o),
  customSaveAgent: (o) => invoke('custom:saveAgent', o),
  customCli: (args) => invoke('custom:cli', args),

  // 内置终端
  termOpen: (opts) => invoke('term:open', opts),
  termWrite: (id, data) => invoke('term:write', id, data),
  termResize: (id, cols, rows) => invoke('term:resize', id, cols, rows),
  termClose: (id) => invoke('term:close', id),

  // 桌面控制
  desktopStatus: () => invoke('desktop:status'),
  desktopRestart: () => invoke('desktop:restart'),

  // 系统
  pickFolders: () => invoke('dialog:pickFolders'),
  pickFiles: () => invoke('dialog:pickFiles'),
  pickImages: () => invoke('dialog:pickImages'),
  pickFile: () => invoke('dialog:pickFile'),
  openExternal: (url) => invoke('shell:openExternal', url),
  openPath: (p) => invoke('shell:openPath', p),
  copy: (text) => invoke('clipboard:write', text),
  refreshOverlay: () => invoke('window:refreshOverlay'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  onStatus: subscribe('status'),
  onSettings: subscribe('settings'),
  onChatEvent: subscribe('chat:event'),
  onAsk: subscribe('ask'),
  onAskCancel: subscribe('ask:cancel'),
  onActivity: subscribe('activity'),
  onOpenConv: subscribe('open-conv'),
  onTermData: subscribe('term:data'),
  onTermExit: subscribe('term:exit'),
});
