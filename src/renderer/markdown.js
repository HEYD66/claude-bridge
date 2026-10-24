import { marked } from '/node_modules/marked/lib/marked.esm.js';
import DOMPurify from '/node_modules/dompurify/dist/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: false });

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style'],
};

export function renderMarkdown(text) {
  const html = marked.parse(String(text || ''), { async: false });
  return DOMPurify.sanitize(html, PURIFY);
}

/** 给代码块加上语言标签和复制按钮 */
export function enhanceCode(container, copyIcon) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.parentElement && pre.parentElement.classList.contains('code-block')) continue;
    const code = pre.querySelector('code');
    const lang = code ? (code.className.match(/language-([\w+-]+)/) || [])[1] || '' : '';
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.textContent = lang || 'code';
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.dataset.action = 'copy-code';
    btn.innerHTML = `${copyIcon}<span>复制</span>`;
    head.append(label, btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}
