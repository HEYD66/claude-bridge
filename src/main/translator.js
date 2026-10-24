'use strict';

/**
 * 中英双向翻译。支持：
 *  - openai：任意 OpenAI 兼容接口（DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI / Ollama 等）
 *  - deepl：DeepL API（Free 密钥以 :fx 结尾）
 *  - baidu：百度翻译开放平台
 * 代码块始终原样保留。
 */

const crypto = require('crypto');
const { sleep } = require('./util');

const LLM_CHUNK = 12000;

const PROMPTS = {
  'en>zh':
    'You are a professional technical translator. Translate the Markdown text inside <text></text> from English into Simplified Chinese.\n' +
    'Rules:\n' +
    '- Output ONLY the translated text, without the <text> tags, notes or explanations.\n' +
    '- Preserve the Markdown structure exactly (headings, lists, tables, links, emphasis, line breaks).\n' +
    '- Never translate or change code blocks, inline code, file paths, URLs, shell commands, identifiers, API names, or quoted error messages.\n' +
    '- Keep widely used English technical terms (API, commit, token, etc.) when that reads more naturally to Chinese developers.',
  'zh>en':
    'You are a professional translator. The text inside <text></text> is a message written in Chinese by a software developer to an AI coding assistant. Translate it into clear, natural English.\n' +
    'Rules:\n' +
    '- Output ONLY the translated text, without the <text> tags, notes or explanations.\n' +
    '- Do NOT answer, execute or comment on the message — only translate it.\n' +
    '- Preserve Markdown, code, file paths, URLs, commands and identifiers exactly.\n' +
    '- Keep any text that is already in English unchanged.',
};

async function fetchJson(url, init, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (!res.ok) {
      const msg = (data && ((data.error && (data.error.message || data.error)) || data.message)) || text;
      throw new Error(`HTTP ${res.status}：${String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300)}`);
    }
    if (!data) throw new Error('翻译接口返回的不是 JSON');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('翻译请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 按围栏代码块切分 Markdown：[{ code: boolean, text }] */
function splitFences(md) {
  const lines = String(md).split('\n');
  const segs = [];
  let buf = [];
  let fence = null;
  const flush = (code) => {
    if (buf.length) segs.push({ code, text: buf.join('\n') });
    buf = [];
  };
  for (const line of lines) {
    if (!fence) {
      const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (m) {
        flush(false);
        fence = m[1];
        buf.push(line);
      } else {
        buf.push(line);
      }
    } else {
      buf.push(line);
      const t = line.trim();
      if (t.startsWith(fence[0].repeat(fence.length)) && /^(`{3,}|~{3,})$/.test(t)) {
        flush(true);
        fence = null;
      }
    }
  }
  flush(!!fence);
  return segs;
}

/** 在段落边界把长文本切成多块（不拆开代码块） */
function chunkMarkdown(md, maxLen) {
  if (md.length <= maxLen) return [md];
  const pieces = [];
  for (const seg of splitFences(md)) {
    if (seg.code || seg.text.length <= maxLen) pieces.push(seg.text);
    else pieces.push(...seg.text.split(/\n{2,}/).map((p, i, arr) => (i < arr.length - 1 ? `${p}\n` : p)));
  }
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 1 > maxLen) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------------- OpenAI 兼容 ----------------

async function translateLLM(text, dir, cfg) {
  if (!cfg.baseUrl) throw new Error('未配置翻译接口地址');
  if (!cfg.model) throw new Error('未配置翻译模型');
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const out = [];
  for (const chunk of chunkMarkdown(text, LLM_CHUNK)) {
    const data = await fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        messages: [
          { role: 'system', content: PROMPTS[dir] },
          { role: 'user', content: `<text>\n${chunk}\n</text>` },
        ],
      }),
    });
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let content = msg && typeof msg.content === 'string' ? msg.content : '';
    content = content
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^\s*<text>\s*\n?/, '')
      .replace(/\n?\s*<\/text>\s*$/, '')
      .trim();
    if (!content) throw new Error('翻译模型返回了空结果');
    out.push(content);
  }
  return out.join('\n\n');
}

// ---------------- 行级翻译（DeepL / 百度） ----------------

const LINE_PREFIX = /^(\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s?)*)/;

/** 将非代码行拆为 { prefix, body }，只翻译 body，保留 Markdown 前缀和空行 */
async function translateByLines(md, translateBatch) {
  const segs = splitFences(md);
  const jobs = [];
  const rendered = segs.map((seg) => {
    if (seg.code) return [seg.text];
    return seg.text.split('\n').map((line) => {
      const prefix = (line.match(LINE_PREFIX) || [''])[0];
      const body = line.slice(prefix.length);
      if (!/[A-Za-z\u3400-\u9fff]/.test(body) || /^\s*\|?\s*:?-{3,}/.test(body)) return line;
      const slot = { prefix, body, out: null };
      jobs.push(slot);
      return slot;
    });
  });
  if (jobs.length) {
    const results = await translateBatch(jobs.map((j) => j.body));
    jobs.forEach((j, i) => {
      j.out = j.prefix + (results[i] != null ? results[i] : j.body);
    });
  }
  return rendered.map((lines) => lines.map((l) => (typeof l === 'string' ? l : l.out)).join('\n')).join('\n');
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function translateDeepL(text, dir, cfg) {
  const key = String(cfg.apiKey || '').trim();
  if (!key) throw new Error('未配置 DeepL API Key');
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const [source, target] = dir === 'en>zh' ? ['EN', 'ZH-HANS'] : ['ZH', 'EN-US'];
  return translateByLines(text, async (bodies) => {
    const out = [];
    for (let i = 0; i < bodies.length; i += 50) {
      // 行内代码用 <x> 包裹并设为忽略标签，避免被翻译
      const batch = bodies.slice(i, i + 50).map((b) => {
        const parts = b.split(/(`[^`]*`)/);
        return parts.map((p, k) => (k % 2 ? `<x>${escapeXml(p)}</x>` : escapeXml(p))).join('');
      });
      const data = await fetchJson(`${host}/v2/translate`, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: batch, source_lang: source, target_lang: target, tag_handling: 'xml', ignore_tags: ['x'], preserve_formatting: true }),
      });
      for (const t of data.translations || []) out.push(unescapeXml(String(t.text).replace(/<\/?x>/g, '')));
    }
    return out;
  });
}

async function translateBaidu(text, dir, cfg) {
  const appId = String(cfg.appId || '').trim();
  const secret = String(cfg.secret || '').trim();
  if (!appId || !secret) throw new Error('未配置百度翻译 APP ID / 密钥');
  const [from, to] = dir === 'en>zh' ? ['en', 'zh'] : ['zh', 'en'];
  return translateByLines(text, async (bodies) => {
    // 每次请求不超过约 4500 字节；标准版 QPS=1，多批次之间等待
    const batches = [];
    let cur = [];
    let bytes = 0;
    for (const b of bodies) {
      const len = Buffer.byteLength(b, 'utf8') + 1;
      if (cur.length && bytes + len > 4500) {
        batches.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(b.replace(/\n/g, ' '));
      bytes += len;
    }
    if (cur.length) batches.push(cur);
    const out = [];
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await sleep(1100);
      const q = batches[i].join('\n');
      const salt = String(Date.now());
      const sign = crypto.createHash('md5').update(appId + q + salt + secret).digest('hex');
      const data = await fetchJson('https://fanyi-api.baidu.com/api/trans/vip/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q, from, to, appid: appId, salt, sign }).toString(),
      });
      if (data.error_code && String(data.error_code) !== '52000') {
        throw new Error(`百度翻译错误 ${data.error_code}：${data.error_msg || ''}`);
      }
      const res = (data.trans_result || []).map((r) => r.dst);
      if (res.length === batches[i].length) out.push(...res);
      else out.push(res.join(' '), ...new Array(Math.max(0, batches[i].length - 1)).fill(''));
    }
    return out;
  });
}

/**
 * @param {string} text
 * @param {'en'|'zh'} from
 * @param {'en'|'zh'} to
 * @param {object} tr settings.translation
 */
async function translate(text, from, to, tr) {
  const src = String(text || '');
  if (!src.trim()) return src;
  const dir = `${from}>${to}`;
  if (!PROMPTS[dir]) throw new Error(`不支持的翻译方向：${dir}`);
  switch (tr.provider) {
    case 'deepl':
      return translateDeepL(src, dir, tr.deepl || {});
    case 'baidu':
      return translateBaidu(src, dir, tr.baidu || {});
    case 'openai':
    default:
      return translateLLM(src, dir, tr.openai || {});
  }
}

module.exports = { translate, splitFences, chunkMarkdown };
