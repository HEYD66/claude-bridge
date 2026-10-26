// 生成应用图标 build/icon.png（512×512）：用界面里的放射状标志，画在圆角方块上
// 运行：npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;

function sparkSvg() {
  const rays = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const long = i % 2 === 0;
    const len = long ? 10.5 : 7.5;
    const w = long ? 2.6 : 2.2;
    rays.push(`<rect x="${12 - w / 2}" y="${12 - len}" width="${w}" height="${len}" rx="${w / 2}" transform="rotate(${(360 / n) * i + (i % 3) * 4} 12 12)"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">
  <rect x="0.6" y="0.6" width="22.8" height="22.8" rx="5.2" fill="#1f1f1f"/>
  <g fill="#d97757" transform="translate(12 12) scale(0.72) translate(-12 -12)">${rays.join('')}</g>
</svg>`;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${sparkSvg()}</body></html>`;
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  const png = img.resize({ width: SIZE, height: SIZE }).toPNG();
  fs.writeFileSync(path.join(out, 'icon.png'), png);
  // 检查四角是透明的
  const bmp = img.resize({ width: SIZE, height: SIZE }).toBitmap();
  console.log(`icon.png ${png.length} bytes, corner alpha = ${bmp[3]}, center alpha = ${bmp[(SIZE * (SIZE / 2) + SIZE / 2) * 4 + 3]}`);
  app.exit(0);
});
