// Small synthesized sound effects, so there are no audio files to load.

let ctx = null;
let muted = false;
try { muted = localStorage.getItem('stratego3d:muted') === '1'; } catch { /* storage blocked */ }

export const isMuted = () => muted;
export function setMuted(on) {
  muted = on;
  try { localStorage.setItem('stratego3d:muted', on ? '1' : '0'); } catch { /* storage blocked */ }
}

function audio() {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.12, to = null } = {}) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise({ at = 0, dur = 0.2, gain = 0.15, freq = 1200 } = {}) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + at;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(t);
}

export const sfx = {
  select: () => tone(660, { dur: 0.06, type: 'triangle', gain: 0.07 }),
  move: () => { tone(220, { dur: 0.09, type: 'triangle', gain: 0.12, to: 160 }); noise({ dur: 0.06, gain: 0.05, freq: 900 }); },
  swap: () => { tone(440, { dur: 0.05, type: 'triangle', gain: 0.06 }); tone(550, { at: 0.05, dur: 0.05, type: 'triangle', gain: 0.06 }); },
  clash: (delay = 0) => {
    noise({ at: delay, dur: 0.35, gain: 0.25, freq: 2400 });
    tone(140, { at: delay, dur: 0.3, type: 'sawtooth', gain: 0.06, to: 70 });
  },
  turn: () => { tone(784, { dur: 0.12, gain: 0.07 }); tone(1047, { at: 0.1, dur: 0.18, gain: 0.07 }); },
  join: () => [523, 659, 784].forEach((f, i) => tone(f, { at: i * 0.09, dur: 0.2, gain: 0.08 })),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.14, dur: 0.35, type: 'triangle', gain: 0.1 })),
  lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, { at: i * 0.18, dur: 0.4, type: 'triangle', gain: 0.09 })),
  error: () => tone(180, { dur: 0.15, type: 'square', gain: 0.04 }),
};
