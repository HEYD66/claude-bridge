'use strict';
// 宣传片配乐：完全用代码合成，不依赖任何音频素材
// 96 BPM，一小节 4 拍 = 2.5 秒，画面转场都落在小节线上
// 和弦进行 IV–V–iii–vi（F – G – Em7 – Am7），结尾落到 Cadd9
// 单独运行：node scripts/promo/music.js out.wav [时长秒]
const fs = require('fs');

const SR = 44100;
const BPM = 96;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const TAU = Math.PI * 2;

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

/** 可复现的伪随机噪声（每次生成的音频完全一样） */
function makeNoise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

const CHORDS = {
  F: [53, 57, 60, 64],
  G: [55, 59, 62, 67],
  Em: [52, 55, 59, 62],
  Am: [57, 60, 64, 67],
  C: [48, 55, 62, 64, 67],
};
const PROG = ['F', 'G', 'Em', 'Am'];
const ROOT = { F: 41, G: 43, Em: 40, Am: 45, C: 36 };

/** 每小节的和弦：[和弦, 起拍, 拍数] */
function barChords(b, bars) {
  if (b === bars - 2) return [['F', 0, 2], ['G', 2, 2]];
  if (b === bars - 1) return [['C', 0, 4]];
  return [[PROG[b % 4], 0, 4]];
}

/** 没有画面提示时的默认音效位置 */
function defaultCues(duration) {
  const cues = [{ t: 0.25, type: 'chime' }];
  for (let t = BAR * 2; t < duration - 1; t += BAR * 3) cues.push({ t, type: 'transition' });
  return cues;
}

function synth(duration, cues = defaultCues(duration)) {
  const N = Math.ceil(duration * SR);
  const bus = () => [new Float32Array(N), new Float32Array(N)];
  const pad = bus();
  const arp = bus();
  const bass = bus();
  const drums = bus();
  const fx = bus();
  const verbIn = bus();
  const echoIn = new Float32Array(N);
  const duck = new Float32Array(N).fill(1);
  const noise = makeNoise(20261024);
  const bars = Math.round(duration / BAR);

  // 等功率声像：pan 0 = 左，1 = 右
  const gains = (pan) => [Math.cos((pan * Math.PI) / 2), Math.sin((pan * Math.PI) / 2)];
  const put = (b, i, v, gl, gr) => {
    b[0][i] += v * gl;
    b[1][i] += v * gr;
  };

  // ---------------- 铺底：两个微失谐的锯齿味音色，6 个谐波 ----------------
  const HARM = [1, 2, 3, 4, 5, 6].map((h) => 1 / h ** 1.7);
  function padNote(m, t0, dur, gain, attack) {
    const rel = 1.8;
    for (const v of [-1, 1]) {
      const f = mtof(m) * 2 ** ((v * 7) / 1200);
      const [gl, gr] = gains(0.5 + v * 0.3);
      const w = (TAU * f) / SR;
      const ph = (m * 0.73 + v * 1.9) % TAU;
      const i0 = Math.round(t0 * SR);
      const i1 = Math.min(N, Math.round((t0 + dur + rel) * SR));
      for (let i = Math.max(0, i0); i < i1; i++) {
        const t = (i - i0) / SR;
        let env = t < attack ? Math.sin(((t / attack) * Math.PI) / 2) ** 2 : 1;
        if (t > dur) env *= Math.cos((clamp((t - dur) / rel) * Math.PI) / 2) ** 2;
        // 用递推算 sin(hx)，每个采样只需一次 sin、一次 cos
        const x = w * (i - i0) + ph;
        const s1 = Math.sin(x);
        const c2 = 2 * Math.cos(x);
        let prev = 0;
        let cur = s1;
        let sum = s1;
        for (let h = 1; h < 6; h++) {
          const next = c2 * cur - prev;
          prev = cur;
          cur = next;
          sum += next * HARM[h];
        }
        const val = sum * env * gain;
        put(pad, i, val, gl, gr);
        verbIn[0][i] += val * gl * 0.5;
        verbIn[1][i] += val * gr * 0.5;
      }
    }
  }

  // ---------------- 拨弦琶音 ----------------
  function pluck(m, t0, gain, pan) {
    const f = mtof(m);
    const [gl, gr] = gains(pan);
    const i0 = Math.round(t0 * SR);
    const n = Math.round(1.3 * SR);
    for (let j = 0; j < n && i0 + j < N; j++) {
      const t = j / SR;
      const x = TAU * f * t;
      const env = Math.min(1, t / 0.003) * Math.exp(-t * 5.2);
      const v = (Math.sin(x) + 0.28 * Math.sin(2 * x) + 0.08 * Math.sin(3 * x) + 0.14 * Math.sin(4 * x) * Math.exp(-t * 18)) * env * gain;
      put(arp, i0 + j, v, gl, gr);
      echoIn[i0 + j] += v * 0.5;
      verbIn[0][i0 + j] += v * gl * 0.45;
      verbIn[1][i0 + j] += v * gr * 0.45;
    }
  }

  // ---------------- 贝斯 ----------------
  function bassNote(m, t0, dur, gain) {
    const f = mtof(m);
    const rel = 0.14;
    const i0 = Math.round(t0 * SR);
    const n = Math.round((dur + rel) * SR);
    const k = Math.tanh(1.4);
    for (let j = 0; j < n && i0 + j < N; j++) {
      const t = j / SR;
      let env = Math.min(1, t / 0.008) * (0.72 + 0.28 * Math.exp(-t * 6));
      if (t > dur) env *= 1 - (t - dur) / rel;
      const x = TAU * f * t;
      const v = Math.tanh(1.4 * (Math.sin(x) + 0.22 * Math.sin(2 * x) + 0.06 * Math.sin(3 * x))) / k;
      put(bass, i0 + j, v * env * gain, 0.707, 0.707);
    }
  }

  // ---------------- 鼓 ----------------
  function kick(t0, gain) {
    const i0 = Math.round(t0 * SR);
    let ph = 0;
    for (let j = 0; j < 0.45 * SR && i0 + j < N; j++) {
      const t = j / SR;
      ph += (TAU * (46 + 120 * Math.exp(-t * 30))) / SR;
      const env = Math.exp(-t * 7.5) * Math.min(1, t / 0.0015);
      const v = (Math.sin(ph) * env + noise() * Math.exp(-t * 250) * 0.12) * gain;
      put(drums, i0 + j, v, 0.707, 0.707);
    }
    // 铺底和琶音跟着底鼓轻轻“让一下”
    for (let j = 0; j < 0.4 * SR && i0 + j < N; j++) {
      const d = 1 - 0.32 * Math.exp(-(j / SR) * 9) * Math.min(1, j / (0.004 * SR));
      duck[i0 + j] = Math.min(duck[i0 + j], d);
    }
  }
  function hat(t0, gain) {
    const i0 = Math.round(t0 * SR);
    const [gl, gr] = gains(0.62);
    let prev = 0;
    for (let j = 0; j < 0.09 * SR && i0 + j < N; j++) {
      const n = noise();
      const v = (n - prev) * Math.exp(-(j / SR) * 60) * gain;
      prev = n;
      put(drums, i0 + j, v, gl, gr);
    }
  }
  function clap(t0, gain) {
    const i0 = Math.round(t0 * SR);
    const [gl, gr] = gains(0.45);
    let lp1 = 0;
    let lp2 = 0;
    for (let j = 0; j < 0.3 * SR && i0 + j < N; j++) {
      const t = j / SR;
      const n = noise();
      lp1 += (n - lp1) * 0.35;
      lp2 += (n - lp2) * 0.08;
      const burst = t < 0.03 ? 0.6 + 0.4 * Math.cos((TAU * t) / 0.01) : 1;
      const v = (lp1 - lp2) * Math.exp(-t * 18) * burst * gain;
      put(drums, i0 + j, v, gl, gr);
      verbIn[0][i0 + j] += v * 0.6;
      verbIn[1][i0 + j] += v * 0.6;
    }
  }

  // ---------------- 音效 ----------------
  function chime(t0, gain) {
    const notes = [84, 88, 91, 96];
    notes.forEach((m, k) => {
      const f = mtof(m);
      const [gl, gr] = gains(0.3 + k * 0.14);
      const i0 = Math.round((t0 + k * 0.09) * SR);
      const parts = [
        [1, 1, 1.8],
        [2.0, 0.35, 2.6],
        [3.01, 0.16, 3.4],
        [4.2, 0.07, 4.5],
      ];
      for (let j = 0; j < 3 * SR && i0 + j < N; j++) {
        const t = j / SR;
        let v = 0;
        for (const [r, a, d] of parts) v += a * Math.sin(TAU * f * r * t) * Math.exp(-t * d);
        v *= Math.min(1, t / 0.002) * gain * (1 - k * 0.12);
        put(fx, i0 + j, v, gl, gr);
        verbIn[0][i0 + j] += v * gl * 0.9;
        verbIn[1][i0 + j] += v * gr * 0.9;
      }
    });
  }
  /** 转场：前 1.6 秒噪声渐强变亮，到点时一声低沉的“咚” */
  function transition(tb, gain) {
    const n = Math.round(1.6 * SR);
    const i0 = Math.round(tb * SR) - n;
    const lp = [0, 0];
    const nz = [makeNoise(Math.round(tb * 1000)), makeNoise(Math.round(tb * 1000) + 7)];
    for (let j = 0; j < n; j++) {
      const i = i0 + j;
      if (i < 0 || i >= N) continue;
      const u = j / n;
      const a = 0.01 + 0.3 * u * u;
      const norm = Math.sqrt(a / (2 - a));
      for (let c = 0; c < 2; c++) {
        lp[c] += (nz[c]() - lp[c]) * a;
        const v = (lp[c] / norm) * u ** 2.6 * gain * 0.08;
        fx[c][i] += v;
        verbIn[c][i] += v * 0.8;
      }
    }
    const ib = Math.round(tb * SR);
    let ph = 0;
    for (let j = 0; j < 1.4 * SR && ib + j < N; j++) {
      const t = j / SR;
      ph += (TAU * (50 + 34 * Math.exp(-t * 12))) / SR;
      const v = Math.sin(ph) * Math.exp(-t * 3.2) * Math.min(1, t / 0.004) * gain * 0.24;
      put(fx, ib + j, v, 0.707, 0.707);
      verbIn[0][ib + j] += v * 0.3;
      verbIn[1][ib + j] += v * 0.3;
    }
  }
  /** 界面里的点击 */
  function click(t0, gain) {
    const i0 = Math.round(t0 * SR);
    for (let j = 0; j < 0.06 * SR && i0 + j < N; j++) {
      const t = j / SR;
      const v = (Math.sin(TAU * 2300 * t) * Math.exp(-t * 380) * 0.7 + Math.sin(TAU * 1150 * t) * Math.exp(-t * 160) * 0.5) * gain;
      put(fx, i0 + j, v, 0.707, 0.707);
      verbIn[0][i0 + j] += v * 0.3;
      verbIn[1][i0 + j] += v * 0.3;
    }
  }

  // ---------------- 编曲 ----------------
  const ARP = [0, 2, 1, 3, 2, 1, 3, 2];
  for (let b = 0; b < bars; b++) {
    const t0 = b * BAR;
    for (const [name, beat, beats] of barChords(b, bars)) {
      const ts = t0 + beat * BEAT;
      const dur = beats * BEAT;
      const notes = CHORDS[name];
      const last = b === bars - 1;
      // 铺底
      const padGain = (b < 2 ? 0.032 : 0.04) / notes.length * 4;
      for (const m of notes) padNote(m, ts, last ? dur + 0.5 : dur, padGain, b === 0 ? 2.2 : 0.5);
      // 贝斯
      const root = ROOT[name];
      if (b >= 4 && !last) {
        if (beats === 4) {
          bassNote(root, ts, BEAT * 1.4, 0.26);
          bassNote(root, ts + BEAT * 1.5, BEAT * 0.4, 0.2);
          bassNote(root, ts + BEAT * 2, BEAT * 1.9, 0.24);
        } else {
          bassNote(root, ts, dur * 0.95, 0.25);
        }
      }
      if (last) bassNote(root, ts, BAR * 0.9, 0.22);
      // 琶音
      if (b >= 2 && !last) {
        const tones = notes.map((m) => m + 12);
        for (let e = 0; e < beats * 2; e++) {
          const step = beat * 2 + e;
          const vel = (b < 4 ? 0.1 : 0.13) * (step % 2 === 0 ? 1 : 0.75);
          pluck(tones[ARP[step % 8] % tones.length], ts + e * (BEAT / 2), vel, step % 2 ? 0.66 : 0.34);
        }
      }
      // 结尾一下扫弦
      if (last) [72, 76, 79, 84, 88].forEach((m, k) => pluck(m, ts + k * 0.045, 0.12, 0.3 + k * 0.1));
    }
    // 鼓：第 5 小节进场，片尾两小节停
    if (b >= 4 && b < bars - 2) {
      kick(t0, 0.55);
      kick(t0 + BEAT * 2, 0.5);
      if (b % 2 === 1) kick(t0 + BEAT * 3.5, 0.32);
      if (b >= 8) {
        clap(t0 + BEAT, 0.14);
        clap(t0 + BEAT * 3, 0.14);
      }
      if (b >= 6) for (let k = 0; k < 4; k++) hat(t0 + BEAT * (k + 0.5), 0.05);
    }
  }
  for (const c of cues) {
    if (c.type === 'chime') chime(c.t, 0.09);
    else if (c.type === 'transition') transition(c.t, 1);
    else if (c.type === 'click') click(c.t, 0.09);
  }

  // ---------------- 效果：乒乓延迟（附点八分）+ 混响 ----------------
  const D = Math.round(BEAT * 0.75 * SR);
  const echo = bus();
  for (let i = D; i < N; i++) {
    echo[0][i] = echoIn[i - D] + 0.38 * echo[1][i - D];
    echo[1][i] = 0.38 * echo[0][i - D];
  }
  for (let i = 0; i < N; i++) {
    verbIn[0][i] += echo[0][i] * 0.3;
    verbIn[1][i] += echo[1][i] * 0.3;
  }
  const wet = [freeverb(verbIn[0], 0), freeverb(verbIn[1], 23)];

  // ---------------- 混音 ----------------
  const out = bus();
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < N; i++) {
      out[c][i] = (pad[c][i] + arp[c][i] * 0.95) * duck[i] + echo[c][i] * 0.3 + bass[c][i] * 0.9 + drums[c][i] + fx[c][i];
    }
  }
  // 混响量按铺底 + 琶音的响度自动定，避免糊成一片
  const rms = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length) || 1e-9;
  const music = new Float32Array(N);
  for (let i = 0; i < N; i++) music[i] = pad[0][i] + arp[0][i];
  const wetGain = (0.55 * rms(music)) / rms(wet[0]);
  // 结尾 2 秒淡出
  const fadeFrom = duration - 2.2;
  let peak = 1e-9;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      const fade = t < fadeFrom ? 1 : Math.cos((clamp((t - fadeFrom) / 2.2) * Math.PI) / 2) ** 1.5;
      const fadeIn = Math.min(1, t / 0.05);
      out[c][i] = (out[c][i] + wet[c][i] * wetGain) * fade * fadeIn;
      peak = Math.max(peak, Math.abs(out[c][i]));
    }
  }
  // 归一化 + 软限幅；0.68 让整体响度落在 -14 LUFS 左右（网络视频的常用标准）
  const drive = 1.6;
  const norm = Math.tanh(drive);
  for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) out[c][i] = (Math.tanh((drive * out[c][i]) / peak) / norm) * 0.68;
  return out;
}

/** 简化版 Freeverb：8 个带阻尼的梳状滤波器 + 4 个全通滤波器 */
function freeverb(input, spread) {
  const N = input.length;
  const out = new Float32Array(N);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => ({ buf: new Float32Array(d + spread), idx: 0, store: 0 }));
  const alls = [556, 441, 341, 225].map((d) => ({ buf: new Float32Array(d + spread), idx: 0 }));
  const fb = 0.84;
  const damp = 0.25;
  for (let i = 0; i < N; i++) {
    const x = input[i] * 0.015;
    let acc = 0;
    for (const c of combs) {
      const y = c.buf[c.idx];
      c.store = y * (1 - damp) + c.store * damp;
      c.buf[c.idx] = x + c.store * fb;
      c.idx = (c.idx + 1) % c.buf.length;
      acc += y;
    }
    for (const a of alls) {
      const b = a.buf[a.idx];
      a.buf[a.idx] = acc + b * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      acc = b - acc;
    }
    out[i] = acc;
  }
  return out;
}

/** 写 16 位立体声 WAV（带少量 TPDF 抖动） */
function writeWav(file, [L, R]) {
  const N = L.length;
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + N * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(N * 4, 40);
  const dither = makeNoise(7);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 2; c++) {
      const v = (c ? R : L)[i] * 32767 + (dither() + dither()) * 0.5;
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), 44 + i * 4 + c * 2);
    }
  }
  fs.writeFileSync(file, buf);
}

function writeMusic(file, duration, cues) {
  writeWav(file, synth(duration, cues));
}

module.exports = { writeMusic, BAR, BEAT };

if (require.main === module) {
  const file = process.argv[2] || 'music.wav';
  const duration = Number(process.argv[3]) || BAR * 20;
  writeMusic(file, duration);
  console.log(`saved ${file} (${duration}s)`);
}
