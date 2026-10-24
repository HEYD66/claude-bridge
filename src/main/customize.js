'use strict';

/**
 * “自定义”页面的服务器端操作：CLAUDE.md、记忆、技能、子代理、权限规则、Hooks、插件、MCP 连接器。
 */

const path = require('path').posix;
const { shQuote, remotePathExpr } = require('./util');
const { prepareCommand } = require('./session-host');

function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

function buildFrontmatter(meta, body) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/\r?\n/g, ' ')}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body || '').trim()}\n`;
}

function safeName(name) {
  const n = String(name || '').trim();
  if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(n)) throw new Error('名称只能包含字母、数字、点、下划线和短横线');
  return n;
}

class Customize {
  /**
   * @param {import('./remote-fs').RemoteFs} rfs
   * @param {import('./ssh-manager').SshManager} ssh
   * @param {() => object} getSettings
   */
  constructor(rfs, ssh, getSettings) {
    this.rfs = rfs;
    this.ssh = ssh;
    this.getSettings = getSettings;
  }

  async _listMd(dir) {
    try {
      const r = await this.rfs.list(dir);
      return r.entries.filter((e) => e.type !== 'dir' && e.name.endsWith('.md')).map((e) => ({ name: e.name, path: path.join(r.path, e.name), size: e.size, mtime: e.mtime }));
    } catch {
      return [];
    }
  }

  async overview(workdir) {
    if (!this.ssh.isConnected()) throw new Error('请先连接服务器');
    const home = await this.rfs.home();
    const proj = await this.rfs.resolve(workdir || '~');
    const files = {
      globalClaudeMd: path.join(home, '.claude', 'CLAUDE.md'),
      projectClaudeMd: path.join(proj, 'CLAUDE.md'),
      userSettings: path.join(home, '.claude', 'settings.json'),
      projectSettings: path.join(proj, '.claude', 'settings.json'),
      localSettings: path.join(proj, '.claude', 'settings.local.json'),
    };
    // 技能：~/.claude/skills/<name>/SKILL.md 与项目 .claude/skills
    const skills = [];
    for (const [scope, dir] of [['user', path.join(home, '.claude', 'skills')], ['project', path.join(proj, '.claude', 'skills')]]) {
      let entries = [];
      try {
        entries = (await this.rfs.list(dir)).entries.filter((e) => e.type === 'dir');
      } catch {
        continue;
      }
      for (const e of entries.slice(0, 200)) {
        const p = path.join(dir, e.name, 'SKILL.md');
        const text = await this.rfs.readText(p).catch(() => null);
        if (text == null) continue;
        const { meta } = parseFrontmatter(text);
        skills.push({ scope, name: meta.name || e.name, description: meta.description || '', path: p, dir: path.join(dir, e.name) });
      }
    }
    const agents = [];
    for (const [scope, dir] of [['user', path.join(home, '.claude', 'agents')], ['project', path.join(proj, '.claude', 'agents')]]) {
      for (const f of await this._listMd(dir)) {
        const text = await this.rfs.readText(f.path).catch(() => '');
        const { meta } = parseFrontmatter(text);
        agents.push({ scope, name: meta.name || f.name.replace(/\.md$/, ''), description: meta.description || '', tools: meta.tools || '', model: meta.model || '', path: f.path });
      }
    }
    const styles = [];
    for (const [scope, dir] of [['user', path.join(home, '.claude', 'output-styles')], ['project', path.join(proj, '.claude', 'output-styles')]]) {
      for (const f of await this._listMd(dir)) styles.push({ scope, name: f.name.replace(/\.md$/, ''), path: f.path });
    }
    const exists = {};
    for (const [k, p] of Object.entries(files)) exists[k] = await this.rfs.exists(p);
    return { home, project: proj, files, exists, skills, agents, styles };
  }

  async readFile(p) {
    return this.rfs.readText(p);
  }

  async writeFile(p, content) {
    return this.rfs.write(p, content);
  }

  async removeFile(p) {
    return this.rfs.remove(p);
  }

  async readJson(p) {
    const text = await this.rfs.readText(p);
    if (text == null || !text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${p} 不是有效的 JSON：${e.message}`);
    }
  }

  /** 修改 settings.json 中的某个顶层字段（保留其它字段） */
  async patchSettings(p, key, value) {
    const obj = await this.readJson(p);
    if (value === undefined || value === null) delete obj[key];
    else obj[key] = value;
    await this.rfs.write(p, `${JSON.stringify(obj, null, 2)}\n`);
    return obj;
  }

  async saveSkill({ scope, name, description, body, workdir }) {
    const n = safeName(name);
    const base = scope === 'project' ? path.join(await this.rfs.resolve(workdir || '~'), '.claude', 'skills') : path.join(await this.rfs.home(), '.claude', 'skills');
    const p = path.join(base, n, 'SKILL.md');
    await this.rfs.write(p, buildFrontmatter({ name: n, description }, body));
    return p;
  }

  async saveAgent({ scope, name, description, tools, model, body, workdir }) {
    const n = safeName(name);
    const base = scope === 'project' ? path.join(await this.rfs.resolve(workdir || '~'), '.claude', 'agents') : path.join(await this.rfs.home(), '.claude', 'agents');
    const p = path.join(base, `${n}.md`);
    await this.rfs.write(p, buildFrontmatter({ name: n, description, tools, model }, body));
    return p;
  }

  /**
   * 运行受限的 claude 子命令（plugin / mcp / auth status / update 检查）
   */
  async cli(args, { timeoutMs = 120000 } = {}) {
    if (!this.ssh.isConnected()) throw new Error('请先连接服务器');
    if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string' || /[\r\n\0]/.test(a))) throw new Error('无效的参数');
    const allowed = ['plugin', 'plugins', 'mcp', 'auth', '--version'];
    if (!allowed.includes(args[0])) throw new Error(`不支持的命令：${args[0]}`);
    if (args[0] === 'auth' && args[1] !== 'status') throw new Error('登录请在内置终端中进行');
    const { exe, pathSetup } = prepareCommand(this.getSettings().claude.command);
    const script = `${pathSetup}cd "$HOME"; ${exe} ${args.map(shQuote).join(' ')} </dev/null 2>&1`;
    const r = await this.ssh.exec(`bash -lc ${shQuote(script)}`, { timeoutMs });
    return { code: r.code, output: (r.stdout + r.stderr).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
  }

  /** 内置终端里要执行的 claude 命令行（登录、更新等） */
  terminalCommand(kind, workdir) {
    const { exe, pathSetup } = prepareCommand(this.getSettings().claude.command);
    const cd = `cd ${remotePathExpr(workdir || '~')} 2>/dev/null; `;
    if (kind === 'login') return `${pathSetup}${cd}${exe} auth login`;
    if (kind === 'update') return `${pathSetup}${cd}${exe} update`;
    if (kind === 'claude') return `${pathSetup}${cd}${exe}`;
    return `${cd}`;
  }
}

module.exports = { Customize, parseFrontmatter, buildFrontmatter };
