'use strict';
// 把 promo.html 渲染成宣传视频：Electron 离屏逐帧截取画面，music.js 合成配乐，ffmpeg 编码成 MP4
//
// 运行（需要 PATH 里有 ffmpeg）：
//   npx electron scripts/promo/render.js                    → dist/claude-bridge-promo.mp4
//   npx electron scripts/promo/render.js --fps 60 --out dist/promo-60fps.mp4
//   npx electron scripts/promo/render.js --stills 3,9,15    → 只导出这几秒的画面到 dist/promo-stills/，用来检查
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { once } = require('events');
const { writeMusic } = require('./music');

// 固定 1:1 像素，不受系统缩放影响
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const W = 1920;
const H = 1080;
const MARK = 4; // 画面下方放帧序号的像素行数

/** 读出帧序号：16 个色块，每块取中间一个像素的绿色通道（BGRA） */
function readSeq(bmp) {
  let v = 0;
  for (let i = 0; i < 16; i++) {
    const x = Math.round((i + 0.5) * (W / 16));
    if (bmp[((H + MARK / 2) * W + x) * 4 + 1] > 127) v |= 1 << i;
  }
  return v;
}
const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const FPS = Number(opt('fps', 30));
const OUT = path.resolve(ROOT, opt('out', 'dist/claude-bridge-promo.mp4'));
const STILLS = opt('stills', '');

app.whenReady().then(main).catch((e) => {
  console.error(e);
  app.exit(1);
});

async function main() {
  const win = new BrowserWindow({
    width: W,
    height: H + MARK,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  const wc = win.webContents;
  wc.setFrameRate(60);

  // 离屏渲染送来的画面会落后几帧，所以每帧在画面下方（视频范围外）用 16 个黑白块编码帧序号，
  // 只收序号对得上的那一张，编码前再把这几行裁掉
  let want = -1;
  let deliver = null;
  wc.on('paint', (_e, _dirty, image) => {
    if (!deliver) return;
    const size = image.getSize();
    if (size.width !== W || size.height !== H + MARK) {
      deliver(new Error(`画面尺寸是 ${size.width}x${size.height}，应为 ${W}x${H + MARK}`));
      return;
    }
    const bmp = image.toBitmap();
    if (readSeq(bmp) !== want) return;
    const done = deliver;
    deliver = null;
    done(bmp.subarray(0, W * H * 4));
  });

  await win.loadFile(path.join(__dirname, 'promo.html'), { hash: 'render' });
  const { duration, cues } = await wc.executeJavaScript('window.promo.ready.then(() => ({ duration: window.promo.duration, cues: window.promo.cues }))');

  let seq = 0;
  async function frameAt(t) {
    seq = (seq + 1) % 65536;
    want = seq;
    const got = new Promise((resolve, reject) => {
      deliver = (v) => (v instanceof Error ? reject(v) : resolve(v));
    });
    await wc.executeJavaScript(`window.promo.seek(${t}, ${seq})`);
    // 画面不再变化时不会有新的 paint，定时催一下
    const kick = setInterval(() => wc.invalidate(), 40);
    wc.invalidate();
    try {
      return await got;
    } finally {
      clearInterval(kick);
    }
  }

  if (STILLS) {
    const dir = path.join(ROOT, 'dist', 'promo-stills');
    fs.mkdirSync(dir, { recursive: true });
    for (const s of STILLS.split(',').map(Number)) {
      const bmp = await frameAt(s);
      const file = path.join(dir, `t${String(s).replace('.', '_')}.png`);
      fs.writeFileSync(file, nativeImage.createFromBitmap(Buffer.from(bmp), { width: W, height: H }).toPNG());
      console.log(`saved ${path.relative(ROOT, file)}`);
    }
    app.exit(0);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const wav = OUT.replace(/\.mp4$/i, '') + '.wav';
  console.log('合成配乐…');
  writeMusic(wav, duration, cues);

  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel', 'error',
      '-f', 'rawvideo',
      '-pix_fmt', 'bgra',
      '-s', `${W}x${H}`,
      '-framerate', String(FPS),
      '-i', '-',
      '-i', wav,
      '-map', '0:v',
      '-map', '1:a',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '18',
      '-profile:v', 'high',
      '-colorspace', 'bt709',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      OUT,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const exited = once(ff, 'exit');

  const total = Math.round(duration * FPS);
  const started = Date.now();
  for (let f = 0; f < total; f++) {
    const bmp = await frameAt(f / FPS);
    if (!ff.stdin.write(bmp)) await once(ff.stdin, 'drain');
    if (f % FPS === 0 || f === total - 1) {
      const sec = (Date.now() - started) / 1000;
      console.log(`帧 ${f + 1}/${total}（${sec.toFixed(0)} 秒）`);
    }
  }
  ff.stdin.end();
  const [code] = await exited;
  fs.rmSync(wav, { force: true });
  if (code !== 0) throw new Error(`ffmpeg 退出码 ${code}`);
  console.log(`完成：${path.relative(ROOT, OUT)}`);
  app.exit(0);
}
