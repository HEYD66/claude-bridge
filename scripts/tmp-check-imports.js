// 临时脚本：检查渲染进程模块之间的 import / export 是否匹配
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'renderer');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const exportsOf = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  exportsOf[f] = names;
}
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.]+)'/g)) {
    const target = m[2];
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    for (const n of names) {
      if (!exportsOf[target] || !exportsOf[target].has(n)) {
        console.log(`${f}: '${n}' 不是 ${target} 的导出`);
        bad++;
      }
    }
  }
}
console.log(bad ? `共 ${bad} 处问题` : 'imports OK');
