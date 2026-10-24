'use strict';

const crypto = require('crypto');

/** 生成随机 UUID */
function uid() {
  return crypto.randomUUID();
}

/** POSIX shell 单引号转义：任何字符串都能安全地作为一个参数 */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 把远程路径转为 bash 表达式：支持以 ~ 开头的路径（单引号内 ~ 不会展开）。
 */
function remotePathExpr(p) {
  const v = String(p || '').trim();
  if (!v || v === '~') return '"$HOME"';
  if (v.startsWith('~/')) return `"$HOME"/${shQuote(v.slice(2))}`;
  return shQuote(v);
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RE_G = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_RE_G = /[A-Za-z]/g;

function hasCJK(s) {
  return CJK_RE.test(String(s || ''));
}

/** 去掉代码块和行内代码后，判断文本是否主要是英文，需要翻译成中文 */
function needsZhTranslation(s) {
  const prose = String(s || '')
    .replace(/(```|~~~)[\s\S]*?\1/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const latin = (prose.match(LATIN_RE_G) || []).length;
  const cjk = (prose.match(CJK_RE_G) || []).length;
  if (latin < 2) return false;
  return cjk < latin / 3;
}

function truncate(s, n) {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}\n…（已截断，共 ${v.length} 字符）` : v;
}

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  uid,
  shQuote,
  remotePathExpr,
  hasCJK,
  needsZhTranslation,
  truncate,
  isUuid,
  sleep,
};
