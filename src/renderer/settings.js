// 设置弹窗
import { icon } from './icons.js';
import { api, state, hooks, h, svg, errMsg, toast, getPath, setPath, openModal, dialogShell } from './core.js';

export const EFFORT_OPTIONS = [
  ['', '默认'],
  ['low', '低'],
  ['medium', '中等'],
  ['high', '高'],
  ['xhigh', '很高'],
  ['max', '最高'],
];

export const PERM_OPTIONS = [
  ['', '默认权限', '使用服务器上 Claude Code 的默认设置'],
  ['auto', 'Auto', '由 Claude Code 自动判断风险（新版）'],
  ['acceptEdits', '自动接受编辑', '修改服务器文件不再询问'],
  ['manual', '逐项确认', '每次都询问（新版）'],
  ['default', '逐项确认（旧版）', '旧版 Claude Code 使用 default'],
  ['plan', '计划模式', '只做规划，不执行修改；计划需要你批准'],
  ['dontAsk', '不询问', '未授权的操作直接拒绝'],
  ['bypassPermissions', '跳过权限确认', '危险：所有操作不经确认；root 用户不可用'],
];

let fieldSeq = 0;

function textField(d, path, label, { type = 'text', placeholder = '', hint = '', narrow = false, list = null } = {}) {
  const id = `f${++fieldSeq}`;
  const input = h('input', { id, type, placeholder, autocomplete: 'off', spellcheck: 'false', list });
  input.value = getPath(d, path) ?? '';
  input.addEventListener('input', () => setPath(d, path, type === 'number' ? Number(input.value) : input.value));
  return h('div', { class: `field${narrow ? ' narrow' : ''}` }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint', html: hint }) : null);
}

function selectField(d, path, label, options, { hint = '', onChange } = {}) {
  const id = `f${++fieldSeq}`;
  const sel = h('select', { id }, options.map(([v, t]) => h('option', { value: v }, t)));
  sel.value = getPath(d, path) ?? '';
  sel.addEventListener('change', () => {
    setPath(d, path, sel.value);
    if (onChange) onChange();
  });
  return h('div', { class: 'field' }, h('label', { for: id }, label), sel, hint ? h('div', { class: 'hint', html: hint }) : null);
}

function switchLine(d, path, title, desc, { onChange } = {}) {
  const id = `f${++fieldSeq}`;
  const input = h('input', { type: 'checkbox', id, role: 'switch' });
  input.checked = !!getPath(d, path);
  input.addEventListener('change', () => {
    setPath(d, path, input.checked);
    if (onChange) onChange();
  });
  return h('div', { class: 'switch-line' }, h('label', { class: 'switch-text', for: id }, h('span', { class: 't' }, title), desc ? h('span', { class: 'd' }, desc) : null), h('span', { class: 'switch' }, input, h('span', { class: 'track' })));
}

const LLM_PRESETS = [
  ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
  ['通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
  ['Kimi', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k'],
  ['智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash'],
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
  ['Ollama 本地', 'http://127.0.0.1:11434/v1', 'qwen2.5:7b'],
];

const SETTINGS_TABS = [
  ['ssh', '服务器', 'server'],
  ['claude', 'Claude', 'tool'],
  ['mcp', '本机访问', 'monitor'],
  ['translation', '翻译', 'languages'],
  ['notify', '通知', 'bell'],
  ['ui', '外观', 'eye'],
];

function serverModels() {
  const info = state.claudeInfo;
  return info && Array.isArray(info.models) && info.models.length ? info.models : null;
}

const PANES = {
  ssh(d, rerender) {
    const keyInput = h('input', { type: 'text', placeholder: '例如 C:\\Users\\me\\.ssh\\id_ed25519', spellcheck: 'false' });
    keyInput.value = d.ssh.privateKeyPath || '';
    keyInput.addEventListener('input', () => (d.ssh.privateKeyPath = keyInput.value));
    const pick = h('button', {
      class: 'btn',
      onclick: async () => {
        const f = await api.pickFile();
        if (f) {
          d.ssh.privateKeyPath = f;
          keyInput.value = f;
        }
      },
    }, '浏览…');
    return [
      h('h3', {}, 'SSH 连接'),
      h('div', { class: 'row' }, textField(d, ['ssh', 'host'], '服务器地址', { placeholder: '例如 203.0.113.10 或 vps.example.com' }), textField(d, ['ssh', 'port'], '端口', { type: 'number', narrow: true })),
      textField(d, ['ssh', 'username'], '用户名'),
      selectField(d, ['ssh', 'authType'], '认证方式', [['password', '密码'], ['key', '私钥文件'], ['agent', 'SSH Agent（Windows OpenSSH Agent）']], { onChange: rerender }),
      d.ssh.authType === 'password' ? textField(d, ['ssh', 'password'], '密码', { type: 'password' }) : null,
      d.ssh.authType === 'key' ? h('div', { class: 'field' }, h('div', { class: 'label' }, '私钥文件'), h('div', { class: 'input-row' }, keyInput, pick)) : null,
      d.ssh.authType === 'key' ? textField(d, ['ssh', 'passphrase'], '私钥口令（没有可留空）', { type: 'password' }) : null,
      switchLine(d, ['ssh', 'autoReconnect'], '断线自动重连', '网络波动导致连接断开时自动尝试重新连接；断开期间服务器上的任务会继续运行'),
      h('p', { class: 'hint-text' }, '首次连接会要求确认服务器指纹。密码、口令和 API Key 使用 Windows DPAPI 加密保存在本机。'),
    ];
  },

  claude(d) {
    const cmdInput = h('input', { type: 'text', spellcheck: 'false', placeholder: 'claude' });
    cmdInput.value = d.claude.command || '';
    cmdInput.addEventListener('input', () => (d.claude.command = cmdInput.value));
    const result = h('div');
    const detect = h('button', {
      class: 'btn',
      onclick: async () => {
        detect.disabled = true;
        result.textContent = '';
        result.append(h('div', { class: 'status-box' }, '正在服务器上查找 claude…'));
        try {
          const r = await api.detectClaude();
          result.textContent = '';
          const box = h('div', { class: 'status-box' });
          if (r.info) box.append(h('div', {}, `用户：${r.info.user}　系统：${r.info.system}　主目录：${r.info.home}`));
          if (!r.found.length) box.append(h('div', {}, '未找到 claude。请先在服务器上安装：curl -fsSL https://claude.ai/install.sh | bash，然后点下方的“登录”。'));
          for (const f of r.found) {
            box.append(
              h('div', { class: 'found-item' }, h('span', {}, `${f.path}${f.version ? `  (${f.version})` : ''}`), h('button', {
                class: 'btn sm',
                onclick: () => {
                  d.claude.command = f.path;
                  cmdInput.value = f.path;
                },
              }, '使用')),
            );
          }
          if (r.info && r.info.user === 'root') box.append(h('div', {}, '提示：当前为 root 用户，Claude Code 不允许 bypassPermissions 模式。'));
          result.append(box);
        } catch (e) {
          result.textContent = '';
          result.append(h('div', { class: 'status-box error' }, errMsg(e)));
        } finally {
          detect.disabled = false;
        }
      },
    }, '自动检测');
    const values = serverModels() ? serverModels().filter((m) => m.value !== 'default').map((m) => m.value) : ['sonnet', 'opus', 'haiku'];
    const models = h('datalist', { id: 'model-list' }, values.map((m) => h('option', { value: m })));
    const info = state.claudeInfo;
    const term = (kind) => () => {
      modalRef.close('terminal');
      hooks.openTerminal(kind);
    };
    return [
      h('h3', {}, '服务器上的 Claude Code'),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Claude 命令'), h('div', { class: 'input-row' }, cmdInput, detect), h('div', { class: 'hint', html: '一般填 <code>claude</code> 即可；若提示找不到命令，连接后点“自动检测”或填写完整路径。' }), result),
      h('div', { class: 'status-box' }, info && info.version ? `版本：${info.version}${info.account && info.account.email ? `　账号：${info.account.email}` : ''}${info.account && info.account.subscriptionType ? `（${info.account.subscriptionType}）` : ''}` : '连接服务器后显示版本与登录状态'),
      h('div', { class: 'pane-actions' }, h('button', { class: 'btn sm', onclick: term('login') }, '登录服务器上的 Claude…'), h('button', { class: 'btn sm', onclick: term('update') }, '更新 Claude Code…'), h('button', { class: 'btn sm', onclick: term('claude') }, '在终端中运行 claude')),
      textField(d, ['claude', 'workdir'], '默认工作目录', { hint: '新对话在服务器上的启动目录，可在顶栏为每个对话单独修改。支持 <code>~</code>。' }),
      h('div', { class: 'row' }, textField(d, ['claude', 'model'], '模型', { placeholder: '留空使用默认，如 sonnet / opus', list: 'model-list' }), selectField(d, ['claude', 'effort'], '思考强度', EFFORT_OPTIONS.map(([v, t]) => [v, v ? `${t}（${v}）` : t]))),
      models,
      h('h3', {}, '权限'),
      selectField(d, ['claude', 'permissionMode'], '权限模式', PERM_OPTIONS.map(([v, t]) => [v, v ? `${t}（${v}）` : t]), { hint: '不同版本的 Claude Code 支持的模式不同；以 root 运行时不能使用 bypassPermissions。' }),
      switchLine(d, ['claude', 'usePromptTool'], '在界面中审批', 'Claude 需要权限、向你提问或提交计划时，在对话里显示确认卡片。关闭后这些请求会被自动拒绝。'),
      h('h3', {}, '运行'),
      textField(d, ['claude', 'idleMinutes'], '空闲多久后关闭服务器上的 Claude 进程（分钟）', { type: 'number', hint: '进程常驻时追问更快；关闭后再发消息会自动恢复会话。断网或关闭本程序不会中断正在进行的任务。' }),
      switchLine(d, ['claude', 'promptSuggestions'], '下一步建议', '每轮结束后显示 Claude 预测的下一条消息，点击即可使用'),
      switchLine(d, ['claude', 'partialMessages'], '流式显示', '边生成边显示英文原文，每段完成后再替换为译文'),
      switchLine(d, ['claude', 'appendSystemPrompt'], '附加桥接说明', '告诉 Claude 它运行在服务器上、本机文件需通过 local_pc 工具访问、消息经过机器翻译'),
      textField(d, ['claude', 'extraArgs'], '额外命令行参数', { placeholder: '例如 --add-dir /data', hint: '原样追加到 claude 命令末尾。' }),
      h('p', { class: 'hint-text' }, 'Fast 模式：Claude Code 在 SDK（本程序使用的）模式下不提供 Fast 模式。'),
    ];
  },

  mcp(d, rerender) {
    const roots = h('div', { class: 'roots' });
    if (!d.mcp.roots.length) roots.append(h('div', { class: 'roots-empty' }, '还没有共享任何文件夹，服务器上的 Claude 无法访问本机文件。'));
    d.mcp.roots.forEach((r, i) => {
      roots.append(
        h('div', { class: 'root-item' }, svg('folder', 15), h('span', {}, r), h('button', {
          class: 'icon-btn sm',
          title: '移除',
          'aria-label': `移除 ${r}`,
          html: icon('x', 14),
          onclick: () => {
            d.mcp.roots.splice(i, 1);
            rerender();
          },
        })),
      );
    });
    const add = h('button', {
      class: 'btn',
      onclick: async () => {
        const picked = await api.pickFolders();
        for (const p of picked) if (!d.mcp.roots.includes(p)) d.mcp.roots.push(p);
        rerender();
      },
    }, svg('plus', 14), '添加文件夹');
    const st = state.status;
    const tunnelText = st && st.ssh.state === 'connected'
      ? st.mcp.remotePort
        ? `本机 MCP 服务：127.0.0.1:${st.mcp.localPort}\n服务器隧道端口：127.0.0.1:${st.mcp.remotePort}（仅服务器本机可访问，并需要随机令牌）`
        : `本机 MCP 服务：127.0.0.1:${st.mcp.localPort}\n隧道未建立：${st.ssh.tunnelError || '本机访问未启用'}`
      : `本机 MCP 服务：127.0.0.1:${st ? st.mcp.localPort : '?'}\n连接服务器后自动建立反向隧道。`;
    const ds = st && st.desktop;
    const dsText = !ds ? '' : ds.state === 'ready' ? `Windows-MCP ${ds.release.version} 已就绪，${ds.tools.length} 个桌面工具` : ds.state === 'starting' ? '正在启动 Windows-MCP（首次需要下载 Python 和依赖，可能要几分钟）…' : ds.state === 'error' ? `启动失败：${ds.error}` : '未开启';
    return [
      h('h3', {}, '让服务器上的 Claude 操作本机'),
      switchLine(d, ['mcp', 'enabled'], '启用本机访问', '通过 SSH 反向隧道把本机的文件工具（MCP）提供给服务器上的 Claude'),
      h('div', { class: 'status-box' }, tunnelText),
      h('h3', {}, '共享文件夹'),
      roots,
      add,
      h('h3', {}, '安全'),
      switchLine(d, ['mcp', 'readOnly'], '只读模式', 'Claude 只能浏览、读取和搜索，不能写入、移动或删除'),
      switchLine(d, ['mcp', 'confirmWrites'], '写入前确认', '创建、修改、移动、删除文件前弹窗确认（删除的文件进回收站）'),
      switchLine(d, ['mcp', 'allowCommands'], '允许执行 PowerShell 命令', '允许 Claude 在共享文件夹中运行命令，风险较高，默认关闭'),
      switchLine(d, ['mcp', 'confirmCommands'], '执行命令前确认', '每条命令（包括后台启动开发服务器）都需要你批准'),
      h('h3', {}, '内置浏览器'),
      switchLine(d, ['mcp', 'browser'], '允许 Claude 使用内置浏览器', '打开、读取、点击、截图本机网页（如 localhost:3000），用来预览和测试 Claude 在本机启动的应用。打开外部网站前会先问你。'),
      h('h3', {}, '桌面控制（Cowork）'),
      switchLine(d, ['mcp', 'desktop'], '允许 Claude 操控本机桌面', '通过 Windows-MCP 截图、点击、输入、打开应用。需要本机安装 uv；首次启动会自动下载 Python 3.14 与依赖。'),
      selectField(d, ['mcp', 'desktopConfirm'], '桌面操作确认', [['risky', '仅高风险操作（PowerShell、进程、注册表、文件、启动应用）'], ['all', '每一步都确认'], ['none', '不确认（不推荐）']]),
      dsText ? h('div', { class: `status-box${ds && ds.state === 'error' ? ' error' : ''}` }, dsText) : null,
      ds && ds.state === 'error' ? h('button', { class: 'btn sm', onclick: () => api.desktopRestart().then(() => toast('正在重新启动 Windows-MCP')) }, '重试') : null,
    ];
  },

  translation(d, rerender) {
    const t = d.translation;
    const testResult = h('div');
    const test = h('button', {
      class: 'btn',
      onclick: async () => {
        test.disabled = true;
        testResult.textContent = '';
        testResult.append(h('div', { class: 'status-box' }, '正在测试…'));
        try {
          const r = await api.testTranslation(t);
          testResult.textContent = '';
          testResult.append(h('div', { class: 'status-box' }, `英→中：${r.zh}\n中→英：${r.en}`));
        } catch (e) {
          testResult.textContent = '';
          testResult.append(h('div', { class: 'status-box error' }, errMsg(e)));
        } finally {
          test.disabled = false;
        }
      },
    }, '测试翻译');
    const provider = [];
    if (t.provider === 'openai') {
      provider.push(
        h('div', { class: 'field' }, h('div', { class: 'label' }, '快速填充'), h('div', { class: 'preset-row' }, LLM_PRESETS.map(([name, url, model]) => h('button', {
          class: 'btn sm',
          onclick: () => {
            t.openai.baseUrl = url;
            t.openai.model = model;
            rerender();
          },
        }, name)))),
        textField(d, ['translation', 'openai', 'baseUrl'], '接口地址（Base URL）', { placeholder: 'https://api.deepseek.com/v1', hint: '任何兼容 OpenAI <code>/chat/completions</code> 的接口都可以。' }),
        textField(d, ['translation', 'openai', 'apiKey'], 'API Key', { type: 'password' }),
        textField(d, ['translation', 'openai', 'model'], '模型', { hint: '模型名请以服务商的最新文档为准，翻译用小而快的模型即可。' }),
      );
    } else if (t.provider === 'deepl') {
      provider.push(textField(d, ['translation', 'deepl', 'apiKey'], 'DeepL API Key', { type: 'password', hint: 'Free 版密钥以 <code>:fx</code> 结尾，会自动使用免费接口。' }));
    } else if (t.provider === 'baidu') {
      provider.push(textField(d, ['translation', 'baidu', 'appId'], 'APP ID'), textField(d, ['translation', 'baidu', 'secret'], '密钥', { type: 'password', hint: '在百度翻译开放平台开通“通用文本翻译”后获取。' }));
    }
    return [
      h('h3', {}, '中英双向翻译'),
      switchLine(d, ['translation', 'enabled'], '启用翻译', '关闭后消息原样发送和显示'),
      switchLine(d, ['translation', 'translateInput'], '发送前：中文 → 英文', '你输入的中文会先翻译成英文再发给 Claude（/ 开头的命令不翻译）'),
      switchLine(d, ['translation', 'translateOutput'], '回复后：英文 → 中文', 'Claude 的英文回复、提问、计划、建议会翻译成中文显示，可随时切换查看原文'),
      h('h3', {}, '翻译服务'),
      selectField(d, ['translation', 'provider'], '服务商', [['openai', '大模型（OpenAI 兼容接口，推荐）'], ['deepl', 'DeepL'], ['baidu', '百度翻译']], { onChange: rerender }),
      provider,
      h('div', { class: 'field' }, h('div', {}, test), testResult),
    ];
  },

  notify(d) {
    return [
      h('h3', {}, '桌面通知'),
      switchLine(d, ['notify', 'done'], 'Claude 完成回复时通知', '窗口不在前台时，在系统通知中提醒'),
      switchLine(d, ['notify', 'permission'], '需要你确认时通知', 'Claude 请求权限、提问、提交计划或要操作本机时提醒'),
    ];
  },

  ui(d) {
    return [
      h('h3', {}, '外观'),
      selectField(d, ['ui', 'theme'], '主题', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]),
      textField(d, ['ui', 'displayName'], '显示名称', {
        placeholder: `留空使用 Windows 用户名${state.appInfo && state.appInfo.username ? `（${state.appInfo.username}）` : ''}`,
        hint: '显示在左下角和首页问候语里，只保存在本机。',
      }),
      h('h3', {}, '快捷键'),
      h('div', { class: 'status-box' }, 'Enter 发送（Claude 运行中会排队）　Ctrl+Enter 运行中立即插话　Shift+Enter 换行\n/ 斜杠命令　Tab 填入建议　Shift+Tab 切换权限模式\nEsc 停止 Claude　↑ 编辑上一条消息　粘贴 / 拖入图片作为附件\nCtrl+N 新对话　Ctrl+Shift+N 新窗口　Ctrl+B 侧边栏　Ctrl+, 设置\nCtrl+` 终端　Ctrl+K 搜索　Alt+← / Alt+→ 后退 / 前进'),
    ];
  },
};

let modalRef = null;

export function openSettings(tab = 'ssh') {
  const draft = structuredClone(state.settings);
  let current = tab;
  const nav = h('nav', { class: 'settings-nav', 'aria-label': '设置分类' });
  const pane = h('div', { class: 'settings-pane' });
  const connectBtn = h('button', { class: 'btn', onclick: () => save(true) }, '保存并连接');
  const render = () => {
    const scroll = pane.scrollTop;
    pane.textContent = '';
    pane.append(...PANES[current](draft, render).flat().filter(Boolean));
    pane.scrollTop = scroll;
    nav.textContent = '';
    for (const [key, label, ic] of SETTINGS_TABS) {
      nav.append(h('button', { class: key === current ? 'active' : '', 'aria-current': key === current ? 'page' : null, onclick: () => ((current = key), (pane.scrollTop = 0), render()) }, svg(ic, 16), label));
    }
    connectBtn.hidden = current !== 'ssh';
  };
  async function save(thenConnect) {
    try {
      state.settings = await api.saveSettings(draft);
      state.status = await api.getStatus();
      modalRef.close('saved');
      hooks.refreshAll();
      if (thenConnect) hooks.connect();
      else toast('设置已保存');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }
  const dlg = dialogShell({
    title: '设置',
    wide: true,
    body: h('div', { class: 'settings' }, nav, pane),
    foot: h('div', { class: 'dialog-foot' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => modalRef.close() }, '取消'), connectBtn, h('button', { class: 'btn primary', onclick: () => save(false) }, '保存')),
  });
  modalRef = openModal(dlg, { dismissible: false });
  render();
}
