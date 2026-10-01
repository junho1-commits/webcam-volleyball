// 게임 소리: 효과음 + 해변 분위기(파도·관중·갈매기) + 배경음악.
// 소리 파일 없이 Web Audio로 직접 만든다. 효과음 이름(sfx.xxx)은 게임 코드와 약속된 것이라 바꾸지 않는다.
let ac = null;
let master = null;
const bus = {};                 // sfx 효과음, amb 분위기, music 배경음악, voice 음성
const LEVEL = { sfx: 1, amb: 0.55, music: 0.3, voice: 1 };
let whiteBuf = null, brownBuf = null;

export function initSound() {
  if (!ac) {
    ac = new AudioContext();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ac.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(ac.destination);
    for (const [name, vol] of Object.entries(LEVEL)) {
      bus[name] = ac.createGain();
      bus[name].gain.value = vol;
      bus[name].connect(master);
    }
    whiteBuf = makeNoise(false);
    brownBuf = makeNoise(true);
    loadVoices();
  }
  if (ac.state === 'suspended') ac.resume();
}

// 브라우저가 소리를 허락했는지 (사용자가 한 번도 누르지 않았으면 false)
export const audioReady = () => ac?.state === 'running';

// 음량 조절: name = 'sfx' | 'amb' | 'music' | 'voice' | 'master', v = 0~1
export function setVolume(name, v) {
  if (name in LEVEL) LEVEL[name] = v;
  if (!ac) return;
  const node = name === 'master' ? master : bus[name];
  node?.gain.setTargetAtTime(v, ac.currentTime, 0.05);
}

// ── 소리 재료
function makeNoise(brown) {
  const len = ac.sampleRate * 2;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}

// a초 동안 커졌다가 d초 동안 작아지는 음량 곡선
function envelope(gain, t0, a, peak, d) {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + a);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
}

// 음 하나. at = 절대 시각(없으면 지금 + t)
function tone({ freq, to = null, type = 'sine', t = 0, at = null, a = 0.005, d = 0.2, vol = 0.3, vibrato = 0, dest = bus.sfx }) {
  if (!ac) return;
  const t0 = at ?? ac.currentTime + t;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + a + d);
  if (vibrato) {
    const lfo = ac.createOscillator(), depth = ac.createGain();
    lfo.frequency.value = 6;
    depth.gain.value = vibrato;
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t0);
    lfo.stop(t0 + a + d + 0.05);
  }
  envelope(g, t0, a, vol, d);
  o.connect(g).connect(dest);
  o.start(t0);
  o.stop(t0 + a + d + 0.05);
}

// 걸러낸 잡음 하나 (공 소리, 파도, 관중 함성의 재료)
function noise({ t = 0, at = null, a = 0.005, d = 0.1, vol = 0.5, type = 'lowpass', freq = 1000, to = null, q = 0.7, brown = false, dest = bus.sfx }) {
  if (!ac) return;
  const t0 = at ?? ac.currentTime + t;
  const s = ac.createBufferSource();
  s.buffer = brown ? brownBuf : whiteBuf;
  s.loop = true;
  const f = ac.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t0);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + a + d);
  const g = ac.createGain();
  envelope(g, t0, a, vol, d);
  s.connect(f).connect(g).connect(dest);
  s.start(t0, Math.random() * 1.5);
  s.stop(t0 + a + d + 0.05);
}

// ── 경기장 소리 조각
function whistle(t = 0, len = 0.4) {
  if (!ac) return;
  const t0 = ac.currentTime + t;
  const g = ac.createGain();
  envelope(g, t0, 0.02, 0.18, len);
  // 호루라기 특유의 떨림: 음량을 빠르게 흔든다
  const trill = ac.createGain();
  trill.gain.value = 0.5;
  const lfo = ac.createOscillator(), depth = ac.createGain();
  lfo.frequency.value = 32;
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(trill.gain);
  for (const f of [2850, 2930]) {
    const o = ac.createOscillator();
    o.frequency.value = f;
    o.connect(trill);
    o.start(t0);
    o.stop(t0 + len + 0.1);
  }
  trill.connect(g).connect(bus.sfx);
  lfo.start(t0);
  lfo.stop(t0 + len + 0.1);
}

// 관중 환호: 여러 대역의 잡음 + 박수 + "우~" 소리
function cheer(t = 0, len = 1.8, power = 1) {
  for (const [freq, vol] of [[550, 0.35], [1100, 0.3], [2400, 0.18]]) {
    noise({ t, a: 0.18, d: len, vol: vol * power, type: 'bandpass', freq, q: 0.9, dest: bus.amb });
  }
  const claps = Math.round(18 * len * power);
  for (let i = 0; i < claps; i++) {
    noise({ t: t + Math.random() * len * 0.9, a: 0.002, d: 0.035, vol: 0.12 + Math.random() * 0.15,
      type: 'highpass', freq: 1400 + Math.random() * 1200, dest: bus.amb });
  }
  for (let i = 0; i < 4; i++) {
    const f = 380 + Math.random() * 200;
    tone({ freq: f, to: f * 1.6, type: 'triangle', t: t + 0.05 + Math.random() * 0.3,
      a: 0.25, d: 0.7, vol: 0.035 * power, vibrato: 12, dest: bus.amb });
  }
}

// 관중 "아~" 아쉬운 소리: 여러 목소리가 낮아지며 끝난다
function aww(t = 0) {
  if (!ac) return;
  const t0 = ac.currentTime + t;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 750;
  f.Q.value = 1.2;
  const g = ac.createGain();
  envelope(g, t0, 0.12, 0.22, 1.0);
  f.connect(g).connect(bus.amb);
  for (let i = 0; i < 6; i++) {
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    const start = 300 + Math.random() * 80;
    o.frequency.setValueAtTime(start, t0);
    o.frequency.exponentialRampToValueAtTime(start * 0.68, t0 + 1.0);
    o.connect(f);
    o.start(t0);
    o.stop(t0 + 1.2);
  }
  noise({ t, a: 0.1, d: 0.9, vol: 0.12, type: 'bandpass', freq: 600, to: 400, dest: bus.amb });
}

// ── 해변 분위기 (파도, 관중 웅성거림, 가끔 갈매기)
let amb = null;

export function startAmbience() {
  if (!ac || amb) return;
  amb = { timers: [] };
  const later = (fn, ms) => amb.timers.push(setTimeout(fn, ms));

  // 파도: 5~8초마다 한 번씩 밀려왔다 빠진다 (앞 파도와 겹치게)
  const wave = () => {
    if (!amb) return;
    const big = 0.7 + Math.random() * 0.5;
    noise({ a: 2.2 + Math.random(), d: 4 + Math.random() * 1.5, vol: 0.3 * big, brown: true,
      type: 'lowpass', freq: 380, to: 900, dest: bus.amb });
    noise({ t: 1.5, a: 1.2, d: 2.5, vol: 0.05 * big, type: 'highpass', freq: 3500, dest: bus.amb });
    later(wave, 5000 + Math.random() * 3000);
  };
  wave();

  // 관중 웅성거림: 계속 이어지는 잡음, 크기가 천천히 오르내린다
  const src = ac.createBufferSource();
  src.buffer = whiteBuf;
  src.loop = true;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 900;
  f.Q.value = 0.8;
  const g = ac.createGain();
  g.gain.value = 0.0001;
  g.gain.setTargetAtTime(0.05, ac.currentTime, 1.5);
  src.connect(f).connect(g).connect(bus.amb);
  src.start();
  amb.crowd = { src, g };
  const murmur = () => {
    if (!amb) return;
    g.gain.setTargetAtTime(0.03 + Math.random() * 0.04, ac.currentTime, 0.8);
    later(murmur, 2000);
  };
  murmur();

  // 갈매기: 15~30초마다
  const gull = () => {
    if (!amb) return;
    const base = 1300 + Math.random() * 400;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
      tone({ freq: base, to: base * 0.72, type: 'triangle', t: i * 0.32, a: 0.03, d: 0.24, vol: 0.035, vibrato: 25, dest: bus.amb });
    }
    later(gull, 15000 + Math.random() * 15000);
  };
  later(gull, 6000);
}

export function stopAmbience() {
  if (!amb) return;
  amb.timers.forEach(clearTimeout);
  amb.crowd.g.gain.setTargetAtTime(0.0001, ac.currentTime, 0.3);
  amb.crowd.src.stop(ac.currentTime + 1.5);
  amb = null;
}

export const ambienceOn = () => !!amb;

// ── 배경음악: 밝은 해변풍 (마림바 + 베이스 + 셰이커), 112 BPM
let music = null;
const CHORDS = [   // C - Am - F - G (마디마다 한 화음)
  [261.63, 329.63, 392.0, 523.25],
  [220.0, 261.63, 329.63, 440.0],
  [174.61, 220.0, 261.63, 349.23],
  [196.0, 246.94, 293.66, 392.0],
];
const ARP = [0, 2, 1, 2, 3, 2, 1, 2];

export function startMusic() {
  if (!ac || music) return;
  const eighth = 60 / 112 / 2;
  music = { step: 0, next: ac.currentTime + 0.1 };
  const schedule = () => {
    while (music && music.next < ac.currentTime + 0.15) {
      const at = music.next, s = music.step;
      const chord = CHORDS[Math.floor(s / 8) % 4];
      const n = s % 8;
      // 마림바: 기본음 + 4배음을 짧게
      const f = chord[ARP[n]] * 2;
      tone({ freq: f, at, a: 0.004, d: 0.28, vol: 0.14, dest: bus.music });
      tone({ freq: f * 4, at, a: 0.002, d: 0.06, vol: 0.03, dest: bus.music });
      // 베이스
      if (n === 0 || n === 3 || n === 4 || n === 6) {
        tone({ freq: chord[0] / 2, type: 'triangle', at, a: 0.01, d: eighth * 1.6, vol: 0.2, dest: bus.music });
      }
      // 킥과 셰이커
      if (n === 0 || n === 4) tone({ freq: 120, to: 45, at, a: 0.003, d: 0.14, vol: 0.28, dest: bus.music });
      noise({ at, a: 0.003, d: 0.045, vol: n % 2 ? 0.1 : 0.05, type: 'highpass', freq: 6500, dest: bus.music });
      music.step++;
      music.next += eighth;
    }
  };
  music.timer = setInterval(schedule, 25);
  schedule();
}

export function stopMusic() {
  if (!music) return;
  clearInterval(music.timer);
  music = null;
}

export const musicOn = () => !!music;

// ── 한국어 음성 (Typecast로 미리 만든 assets/voice/*.mp3, tools/typecast_voices.py 참고)
// 파일이 아직 없으면 조용히 넘어간다.
const voices = {};             // id → { buf, offset(앞쪽 무음을 건너뛸 초) }
let speaking = null;           // { src, priority }

async function loadVoices() {
  try {
    const res = await fetch('assets/voice/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const { files } = await res.json();
    await Promise.all(Object.entries(files).map(async ([id, info]) => {
      const buf = await (await fetch('assets/voice/' + info.file)).arrayBuffer();
      const audio = await ac.decodeAudioData(buf);
      // 말이 시작되기 전 무음(최대 0.5초)은 건너뛰어 안내가 늦지 않게 한다
      const d = audio.getChannelData(0);
      let first = 0;
      while (first < d.length && Math.abs(d[first]) < 0.02) first++;
      voices[id] = { buf: audio, offset: Math.max(0, Math.min(0.5, first / audio.sampleRate - 0.03)) };
    }));
  } catch (e) {
    console.warn('음성 파일을 불러오지 못했어요.', e);
  }
}

export const voiceReady = () => Object.keys(voices).length > 0;

// id 하나('do_bump') 또는 묶음 이름('point' → point_1, point_2 … 중 무작위)을 말한다.
// priority가 높은 말이 나오는 중이면 낮은 말은 건너뛴다. (동작 안내 3 > 도움말 2 > 해설 1)
export function say(name, { priority = 1, delay = 0 } = {}) {
  if (!ac) return false;
  const pool = voices[name] ? [name] : Object.keys(voices).filter(id => id.startsWith(name + '_'));
  if (!pool.length) return false;
  if (speaking && priority < speaking.priority) return false;
  speaking?.src.stop();
  const v = voices[pool[Math.floor(Math.random() * pool.length)]];
  const src = ac.createBufferSource();
  src.buffer = v.buf;
  src.connect(bus.voice);
  const me = { src, priority };
  src.onended = () => { if (speaking === me) speaking = null; };
  const start = ac.currentTime + delay, end = start + v.buf.duration - v.offset;
  src.start(start, v.offset);
  speaking = me;
  // 말하는 동안 배경음악과 분위기 소리를 줄인다
  for (const name of ['music', 'amb']) {
    const g = bus[name].gain;
    g.cancelScheduledValues(ac.currentTime);
    g.setTargetAtTime(LEVEL[name] * 0.45, start, 0.08);
    g.setTargetAtTime(LEVEL[name], end, 0.3);
  }
  return true;
}

// ── 효과음 (이름은 게임·테스트 페이지와 약속된 것)
// 경기 효과음이 처음 나올 때 해변 분위기도 함께 켠다 (동작 테스트 페이지에서는 켜지지 않음)
const game = fn => () => { startAmbience(); fn(); };

function beep(freq, dur, type = 'sine', vol = 0.25, delay = 0) {
  tone({ freq, type, t: delay, a: 0.004, d: dur, vol });
}

export const sfx = {
  // 경기
  hit: game(() => {                        // 리시브·토스: 퍽
    noise({ a: 0.002, d: 0.09, vol: 0.9, type: 'lowpass', freq: 1300 });
    noise({ a: 0.001, d: 0.025, vol: 0.35, type: 'highpass', freq: 2500 });
    tone({ freq: 190, to: 95, a: 0.003, d: 0.12, vol: 0.45 });
  }),
  spike: game(() => {                      // 스파이크·서브: 딱! + 쿵
    noise({ a: 0.001, d: 0.05, vol: 1.0, type: 'highpass', freq: 1800 });
    noise({ a: 0.003, d: 0.25, vol: 0.8, type: 'lowpass', freq: 500, to: 150 });
    tone({ freq: 130, to: 45, a: 0.003, d: 0.28, vol: 0.55 });
    noise({ t: 0.05, a: 0.15, d: 0.5, vol: 0.12, type: 'bandpass', freq: 1000, dest: bus.amb });   // 관중 "오~"
  }),
  block: game(() => {                      // 블로킹: 탁탁
    for (const t of [0, 0.055]) noise({ t, a: 0.001, d: 0.05, vol: 0.9, type: 'bandpass', freq: 1600, q: 1.5 });
    tone({ freq: 240, to: 120, a: 0.002, d: 0.12, vol: 0.3, type: 'square' });
    cheer(0.15, 1.0, 0.7);
    say('block', { delay: 0.3 });
  }),
  miss: game(() => {                       // 놓침: 모래에 툭
    noise({ a: 0.004, d: 0.22, vol: 0.55, type: 'lowpass', freq: 350, brown: true });
    tone({ freq: 95, to: 60, a: 0.005, d: 0.18, vol: 0.3 });
  }),
  point: game(() => {                      // 득점: 호루라기 + 환호
    whistle(0, 0.35);
    cheer(0.25, 1.8, 1);
    beep(784, 0.12, 'triangle', 0.18, 0.3);
    beep(1047, 0.25, 'triangle', 0.18, 0.42);
    say('point', { delay: 0.6 });
  }),
  lose: game(() => {                       // 실점: 호루라기 + "아~"
    whistle(0, 0.35);
    aww(0.3);
    say('lose', { delay: 0.9 });
  }),
  win: game(() => {                        // 승리: 팡파르 + 큰 환호
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => {
      tone({ freq: f, type: 'triangle', t: i * 0.13, a: 0.005, d: i === 5 ? 0.7 : 0.18, vol: 0.22 });
      tone({ freq: f / 2, type: 'square', t: i * 0.13, a: 0.005, d: i === 5 ? 0.7 : 0.18, vol: 0.05 });
    });
    cheer(0.2, 3.5, 1.3);
    say('win', { priority: 2, delay: 0.9 });
  }),

  // 동작 인식 테스트 페이지
  gesture: () => beep(880, 0.12, 'triangle'),
  ok: () => { beep(660, 0.1); beep(990, 0.18, 'sine', 0.25, 0.09); },
  fail: () => beep(200, 0.3, 'square', 0.08),
  tick: () => beep(520, 0.08, 'triangle'),
  done: () => { beep(523, 0.12); beep(659, 0.12, 'sine', 0.25, 0.12); beep(784, 0.25, 'sine', 0.25, 0.24); },
};
