// 临时脚本：找出原生 Element.append(...) 调用里顶层参数可能为 null / false 的地方
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'renderer');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const re = /\.append\(/g;
  let m;
  while ((m = re.exec(src))) {
    // 取出整个调用的参数文本
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    let inStr = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === inStr) inStr = null;
      } else if (c === "'" || c === '"' || c === '`') inStr = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      i++;
    }
    const args = src.slice(start, i - 1);
    // 只看顶层（不在嵌套括号里）的内容
    let top = '';
    let d = 0;
    inStr = null;
    for (let k = 0; k < args.length; k++) {
      const c = args[k];
      if (inStr) {
        if (c === '\\') k++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        inStr = c;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (d === 0) top += c;
    }
    if (/:\s*null\b|\|\|\s*null\b|&&|\bnull\s*:/.test(top) || /^\s*\.\.\./.test(args) === false && /\?\s*$/.test(top)) {
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`${f}:${line}: ${top.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    }
  }
}
