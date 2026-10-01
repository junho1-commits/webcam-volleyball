// 녹화된 관절 좌표를 지금 기준값(TH)으로 다시 판정해 인식률을 계산하고, 뼈대를 재생한다.
import { Tracker } from './tracker.js';
import { GESTURES, ORDER, TH } from './gestures.js';
import { LM } from './body.js';
import { unpackPose, downloadRecording } from './recorder.js';
import { SERVE_TH } from './serve-detector.js';
import { videoToRecording } from './video-pose.js';

const $ = id => document.getElementById(id);
const DEFAULT_TH = structuredClone(TH);
const DEFAULT_SERVE_TH = structuredClone(SERVE_TH);
const HIT_GRACE = 150;       // '지금!' 구간이 끝난 직후 이만큼(ms)까지 인정
const PASS = 0.8;            // 1단계 기준: 10번 중 8번

const recs = [];             // { name, data, idle, expected, result }
let sel = -1;
let playT = 0, playing = false, speed = 1, lastTick = 0;

// ── 파일 열기
const isVideo = f => f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(f.name);

async function openFiles(files) {
  for (const f of files) {
    if (isVideo(f)) { await convertVideo(f); continue; }
    try {
      const data = JSON.parse(await f.text());
      if (data.kind !== 'webcam-volleyball-pose-recording') throw new Error('녹화 파일이 아니에요');
      addRecording(f.name, data);
    } catch (e) {
      alert(`${f.name}: ${e.message}`);
    }
  }
}

// ── 영상 → 관절 (한 번에 하나씩)
let converting = null;
async function convertVideo(file) {
  const box = $('v-progress'), bar = $('v-bar'), msg = $('v-msg');
  const serves = $('v-serves').value.trim();
  converting = new AbortController();
  box.hidden = false; bar.style.width = '0%';
  msg.textContent = `${file.name}: 동작 인식 모델을 준비하는 중…`;
  try {
    const data = await videoToRecording(file, {
      model: $('v-model').value, fps: +$('v-fps').value, rotate: +$('v-rotate').value, flip: $('v-flip').checked,
      expectedServes: serves === '' ? null : +serves, signal: converting.signal,
      onProgress: (k, eta) => {
        bar.style.width = (k * 100).toFixed(1) + '%';
        msg.textContent = `${file.name}: ${Math.round(k * 100)}% · 남은 시간 약 ${Math.ceil(eta)}초`;
      },
    });
    const people = data.frames.filter(f => f[2].length).length;
    if (!people) throw new Error('영상에서 사람을 찾지 못했어요');
    addRecording(file.name.replace(/\.[^.]+$/, '') + '_관절.json', data);
    msg.textContent = `${file.name}: 완료 (사람이 보인 프레임 ${Math.round(people / data.frames.length * 100)}%)`;
  } catch (e) {
    msg.textContent = `${file.name}: ${e.name === 'AbortError' ? '취소했어요' : e.message}`;
    if (e.name !== 'AbortError') console.error(e);
  } finally {
    converting = null;
  }
}
$('v-cancel').addEventListener('click', () => converting?.abort());

export function addRecording(name, data) {
  recs.push({ name, data, idle: false, expected: data.meta?.expectedServes ?? null, result: null });
  if (sel < 0) sel = 0;
  analyzeAll();
}

$('file').addEventListener('change', e => openFiles(e.target.files));
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); openFiles(e.dataTransfer.files); });

// ── 분석: 실제 게임과 같은 과정(사람 고르기 → 떨림 줄이기 → 판정)을 녹화에 다시 적용
function analyze(rec) {
  const { meta, frames } = rec.data;
  const tr = new Tracker();
  if (meta.cal) tr.useCalibration(meta.cal);
  const events = [], serves = [], out = [];
  for (const [t, label, poses] of frames) {
    const res = tr.process(poses.map(unpackPose), t, meta.aspect || 16 / 9);
    for (const ev of res.events) if (!ev.held) events.push({ t, type: ev.type, jump: !!ev.jump });   // held = 자세 유지 다시 알림
    for (const ev of res.serveEvents ?? []) serves.push({ ...ev, t });
    out.push({ t, label, player: tr.player, others: tr.others, status: res.status,
      debug: tr.detector ? { ...tr.detector.debug } : null,
      serveDebug: tr.serve ? { ...tr.serve.debug } : null });
  }

  // 정답 구간: 같은 동작 이름이 이어진 프레임들
  const windows = [];
  for (const f of out) {
    const w = windows[windows.length - 1];
    if (f.label && w && w.type === f.label && f.t - w.end < 200) w.end = f.t;
    else if (f.label) windows.push({ type: f.label, start: f.t, end: f.t });
  }
  for (const w of windows) {
    w.hit = events.some(e => e.type === w.type && e.t >= w.start && e.t <= w.end + HIT_GRACE);
    // 점프 스파이크·점프 블로킹의 점프는 잘못 인식으로 치지 않는다
    w.wrong = events.filter(e => e.t >= w.start && e.t <= w.end + HIT_GRACE && e.type !== w.type
      && !(e.type === 'jump' && ['spike', 'block', 'serve'].includes(w.type)));
  }
  const inWindow = e => windows.some(w => e.t >= w.start && e.t <= w.end + HIT_GRACE);
  return {
    frames: out, events, serves, windows,
    outside: events.filter(e => !inWindow(e)),
    duration: frames.length ? frames[frames.length - 1][0] : 0,
    calibrated: !!meta.cal,
  };
}

let pending = 0;
function analyzeAll() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    for (const r of recs) r.result = analyze(r);
    renderFiles();
    renderSummary();
    renderServes();
    renderMisses();
    drawAll();
  });
}

// ── 파일 목록
function renderFiles() {
  const box = $('files');
  box.innerHTML = '';
  recs.forEach((r, i) => {
    const res = r.result;
    const el = document.createElement('div');
    el.className = 'file' + (i === sel ? ' sel' : '');
    const tests = res.windows.length ? `테스트 구간 ${res.windows.length}개` : '자유 녹화';
    el.innerHTML = `
      <span class="name"></span>
      <span class="info">${(res.duration / 1000).toFixed(1)}초 · ${tests} · 인식된 동작 ${res.events.length}번
        · ${r.data.meta.source === 'video' ? '영상에서 변환 · 처음 2.5초로 몸 크기 측정' : res.calibrated ? '녹화 때 몸 크기 사용' : '재생하며 몸 크기 측정'}</span>
      <label class="info"><input type="checkbox" class="idle" ${r.idle ? 'checked' : ''}> 동작 없음 녹화(오인식 검사)</label>
      <label class="info">실제 서브 횟수 <input type="number" class="expected" min="0" style="width:60px" value="${r.expected ?? ''}"></label>
      <button class="alt save" style="padding:4px 12px">관절 파일 저장</button>`;
    el.querySelector('.name').textContent = r.name;
    el.addEventListener('click', e => {
      if (['INPUT', 'BUTTON'].includes(e.target.tagName)) return;
      sel = i; playT = 0; renderFiles(); renderMisses(); drawAll();
    });
    el.querySelector('.idle').addEventListener('change', e => { r.idle = e.target.checked; renderSummary(); renderServes(); });
    el.querySelector('.expected').addEventListener('input', e => {
      r.expected = e.target.value === '' ? null : +e.target.value;
      r.data.meta.expectedServes = r.expected;
      renderServes();
    });
    el.querySelector('.save').addEventListener('click', () => downloadRecording(r.data, r.name.endsWith('.json') ? r.name : r.name + '.json'));
    box.appendChild(el);
  });
}

// ── 동작별 합계
function renderSummary() {
  const rows = ORDER.map(type => {
    let hit = 0, total = 0, outside = 0, idleFalse = 0;
    const wrong = {};
    for (const r of recs) {
      const res = r.result;
      if (r.idle) { idleFalse += res.events.filter(e => e.type === type).length; continue; }
      for (const w of res.windows.filter(w => w.type === type)) {
        total++;
        if (w.hit) hit++;
        for (const e of w.wrong) wrong[e.type] = (wrong[e.type] ?? 0) + 1;
      }
      outside += res.outside.filter(e => e.type === type).length;
    }
    return { type, hit, total, wrong, outside, idleFalse };
  });
  const cell = r => {
    if (!r.total) return '<td class="num">—</td><td></td>';
    const rate = r.hit / r.total;
    return `<td class="num">${r.hit} / ${r.total}</td><td class="${rate >= PASS ? 'pass' : 'fail'}">${Math.round(rate * 100)}%</td>`;
  };
  $('summary').innerHTML = `
    <tr><th>동작</th><th>인식</th><th>비율</th><th>다른 동작으로 잘못 인식</th><th>테스트 구간 밖에서 인식</th><th>동작 없음 녹화에서 잘못 인식</th></tr>
    ${rows.map(r => `<tr>
      <td style="color:${GESTURES[r.type].color};font-weight:bold">${GESTURES[r.type].name}</td>
      ${cell(r)}
      <td>${Object.entries(r.wrong).map(([k, n]) => `${GESTURES[k].name} ${n}`).join(', ') || '—'}</td>
      <td class="num">${r.outside || '—'}</td>
      <td class="num ${r.idleFalse ? 'fail' : ''}">${r.idleFalse || '—'}</td>
    </tr>`).join('')}`;
}

// ── 새 서브 판정 결과 (토스 → 다른 손 타격)
const HAND = { l: '왼손', r: '오른손' };
const SERVE_LOOK = {
  serveToss: { name: '① 토스', color: '#ffd54f' },
  float: { name: '플로터 서브', color: '#4fc3f7' },
  spike: { name: '스파이크 서브', color: '#ff8a65' },
  serveTossExpired: { name: '토스 취소', color: '#ef5350' },
};
const serveLook = e => SERVE_LOOK[e.type === 'serveHit' ? (e.jump ? 'spike' : 'float') : e.type];

function renderServes() {
  const rows = recs.map(r => {
    const s = r.result.serves, hits = s.filter(e => e.type === 'serveHit');
    return {
      name: r.name, idle: r.idle, expected: r.expected,
      toss: s.filter(e => e.type === 'serveToss').length,
      float: hits.filter(e => !e.jump).length, spike: hits.filter(e => e.jump).length,
      expired: s.filter(e => e.type === 'serveTossExpired').length,
      power: hits.length ? hits.reduce((a, e) => a + e.power, 0) / hits.length : null,
    };
  });
  const rate = r => {
    if (r.idle) return (r.toss + r.float + r.spike) ? '<td class="fail">잘못 인식</td>' : '<td class="pass">통과</td>';
    if (!r.expected) return '<td class="note">실제 횟수를 적으면 계산</td>';
    const hit = r.float + r.spike, k = Math.min(hit, r.expected) / r.expected;
    const extra = hit > r.expected ? ` (${hit - r.expected}번 더 인식)` : '';
    return `<td class="${k >= PASS && hit <= r.expected ? 'pass' : 'fail'}">${Math.min(hit, r.expected)} / ${r.expected} · ${Math.round(k * 100)}%${extra}</td>`;
  };
  $('serves').innerHTML = rows.length ? `
    <tr><th>파일</th><th>토스</th><th>플로터</th><th>스파이크 서브</th><th>토스 취소</th><th>평균 힘</th><th>인식률</th></tr>
    ${rows.map(r => `<tr><td></td>
      <td class="num">${r.toss}</td><td class="num">${r.float}</td><td class="num">${r.spike}</td><td class="num">${r.expired}</td>
      <td class="num">${r.power == null ? '—' : Math.round(r.power * 100) + '%'}</td>${rate(r)}</tr>`).join('')}` : '';
  [...$('serves').querySelectorAll('tr')].slice(1).forEach((tr, i) => { tr.firstElementChild.textContent = rows[i].name; });
}

// ── 놓친 구간 목록
function renderMisses() {
  const box = $('misses');
  box.innerHTML = '';
  const res = recs[sel]?.result;
  if (!res) return;
  const misses = res.windows.filter(w => !w.hit);
  if (!misses.length) { box.innerHTML = '<span class="note">놓친 구간이 없어요.</span>'; return; }
  for (const w of misses) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.style.color = GESTURES[w.type].color;
    c.textContent = `${GESTURES[w.type].name} ${(w.start / 1000).toFixed(1)}초`;
    c.onclick = () => { playT = w.start; playing = false; drawAll(); };
    box.appendChild(c);
  }
}

// ── 재생 화면
const BONES = [
  [LM.ls, LM.rs], [LM.ls, LM.le], [LM.le, LM.lw], [LM.rs, LM.re], [LM.re, LM.rw],
  [LM.ls, LM.lh], [LM.rs, LM.rh], [LM.lh, LM.rh],
  [LM.lh, LM.lk], [LM.lk, LM.la], [LM.rh, LM.rk], [LM.rk, LM.ra],
];

function frameAt(res, t) {
  const f = res.frames;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f[mid].t <= t) lo = mid; else hi = mid - 1; }
  return f[lo];
}

function fitCanvas(c) {
  const dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
}

function drawSkeleton(ctx, lm, W, H, color, width) {
  const P = i => ({ x: (1 - lm[i].x) * W, y: lm[i].y * H });   // 거울 모드
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of BONES) { const p = P(a), q = P(b); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
  ctx.stroke();
  ctx.fillStyle = color;
  const n = P(LM.nose);
  ctx.beginPath(); ctx.arc(n.x, n.y, width * 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd54f';
  for (const i of [LM.lw, LM.rw]) { const w = P(i); ctx.beginPath(); ctx.arc(w.x, w.y, width * 2, 0, Math.PI * 2); ctx.fill(); }
}

function drawAll() {
  const res = recs[sel]?.result;
  const view = $('view'), tl = $('timeline');
  fitCanvas(view); fitCanvas(tl);
  const vc = view.getContext('2d'), tc = tl.getContext('2d');
  vc.clearRect(0, 0, view.width, view.height);
  tc.clearRect(0, 0, tl.width, tl.height);
  if (!res || !res.frames.length) return;

  const f = frameAt(res, playT);
  const W = view.width, H = view.height;
  for (const o of f.others) drawSkeleton(vc, o, W, H, 'rgba(255,255,255,.25)', H * 0.006);
  const hold = f.debug?.cand && f.debug.cand !== 'none' ? GESTURES[f.debug.cand]?.color : null;
  if (f.player) drawSkeleton(vc, f.player, W, H, hold ?? '#ffffff', H * 0.01);

  // 지금 보고 있는 순간 전후 0.6초 안에 인식된 동작
  const recent = res.events.filter(e => e.t <= playT && playT - e.t < 600);
  vc.font = `900 ${H * 0.09}px "Malgun Gothic", sans-serif`;
  vc.textAlign = 'center';
  recent.forEach((e, i) => {
    vc.fillStyle = GESTURES[e.type].color;
    vc.fillText(GESTURES[e.type].name + (e.jump ? ' (점프)' : '') + '!', W / 2, H * (0.16 + i * 0.1));
  });
  const recentServe = res.serves.filter(e => e.t <= playT && playT - e.t < 900);
  // 새 서브는 뼈대·예전 동작 글자와 겹치지 않게 왼쪽 아래에, 최근 것이 아래로
  vc.font = `900 ${H * 0.055}px "Malgun Gothic", sans-serif`;
  vc.textAlign = 'left';
  recentServe.reverse().forEach((e, i) => {
    const look = serveLook(e);
    vc.fillStyle = look.color;
    const detail = e.type === 'serveHit' ? ` 힘 ${Math.round(e.power * 100)}%` : e.type === 'serveToss' ? ` (${HAND[e.hand]})` : '';
    vc.fillText(look.name + detail, W * 0.03, H * (0.95 - i * 0.07));
  });
  vc.textAlign = 'center';
  if (f.label) {
    vc.font = `bold ${H * 0.05}px "Malgun Gothic", sans-serif`;
    vc.fillStyle = '#ffd54f';
    vc.fillText(`정답: ${GESTURES[f.label].name} (지금! 구간)`, W / 2, H * 0.94);
  }

  // 타임라인: 정답 구간(띠), 인식된 동작(세로선), 재생 위치(흰 선)
  const TW = tl.width, TH_ = tl.height, dur = Math.max(1, res.duration);
  const X = t => (t / dur) * TW;
  for (const w of res.windows) {
    tc.fillStyle = GESTURES[w.type].color + (w.hit ? '55' : 'aa');
    tc.fillRect(X(w.start), 0, Math.max(2, X(w.end + HIT_GRACE) - X(w.start)), TH_ * 0.5);
    if (!w.hit) { tc.fillStyle = '#ef5350'; tc.fillRect(X(w.start), TH_ * 0.5 - 4, Math.max(2, X(w.end) - X(w.start)), 4); }
  }
  for (const e of res.events) {
    tc.fillStyle = GESTURES[e.type].color;
    tc.fillRect(X(e.t) - 1, TH_ * 0.55, 3, TH_ * 0.2);
  }
  // 새 서브: 아래 줄 (토스 노랑, 플로터 파랑, 스파이크 서브 주황, 취소 빨강)
  for (const e of res.serves) {
    tc.fillStyle = serveLook(e).color;
    tc.fillRect(X(e.t) - 2, TH_ * 0.78, 5, TH_ * 0.22);
  }
  tc.fillStyle = '#fff';
  tc.fillRect(X(playT) - 1, 0, 2, TH_);

  $('time').textContent = `${(playT / 1000).toFixed(1)} / ${(dur / 1000).toFixed(1)}초`;
  const d = f.debug
    ? Object.entries(f.debug).map(([k, v]) => `${k.padEnd(10)} ${v}`).join('\n')
    : '(몸 크기를 재는 중이거나 사람이 안 보임)';
  const sd = f.serveDebug ? `\n\n서브토스   ${f.serveDebug.toss}\n서브점프   ${f.serveDebug.jump}` : '';
  $('pose-dbg').textContent = `상태       ${f.status}\n정답       ${f.label ? GESTURES[f.label].name : '-'}\n\n${d}${sd}`;
}

$('timeline').addEventListener('click', e => {
  const res = recs[sel]?.result;
  if (!res) return;
  const r = e.currentTarget.getBoundingClientRect();
  playT = ((e.clientX - r.left) / r.width) * res.duration;
  drawAll();
});
$('play').addEventListener('click', () => {
  playing = !playing;
  $('play').textContent = playing ? '⏸ 멈춤' : '▶ 재생';
  lastTick = performance.now();
  if (playing) requestAnimationFrame(tick);
});
for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => { speed = +b.dataset.speed; });
addEventListener('resize', drawAll);

function tick(now) {
  if (!playing) return;
  const res = recs[sel]?.result;
  playT += (now - lastTick) * speed;
  lastTick = now;
  if (!res || playT >= res.duration) {
    playing = false;
    $('play').textContent = '▶ 재생';
    if (res) playT = res.duration;
  }
  drawAll();
  if (playing) requestAnimationFrame(tick);
}

// ── 기준값 편집
const TH_LABEL = {
  bumpHandsDist: '리시브: 두 손목 사이 최대 거리',
  bumpMinY: '리시브: 손목이 어깨보다 아래 (최소)',
  bumpMaxY: '리시브: 손목이 어깨보다 아래 (최대)',
  bumpMaxX: '리시브: 몸 가운데에서 벗어남 최대',
  setHandsDist: '토스: 두 손 사이 최대 거리',
  blockArmRatio: '블로킹: 팔을 올린 정도 (팔 길이 비율)',
  'holdMs.bump': '리시브: 자세 유지 시간(ms)',
  'holdMs.set': '토스: 자세 유지 시간(ms)',
  'holdMs.block': '블로킹: 자세 유지 시간(ms)',
  releaseMs: '자세 풀림 인정 시간(ms)',
  swingWindowMs: '스윙: 내려치는 시간 창(ms)',
  swingDrop: '스윙: 내려친 거리 (최소)',
  swingEndY: '스윙: 끝나는 높이 (어깨 기준)',
  swingOtherRatio: '스윙: 다른 손 움직임 비율 (최대)',
  serveHoldMs: '서브: 손 들고 기다리는 시간(ms)',
  jumpRiseAnkle: '점프: 발목 상승 (발목 보일 때)',
  jumpRiseHip: '점프: 골반 상승 (최소)',
  jumpAnkleMin: '점프: 골반으로 볼 때 발목 상승 (최소)',
  jumpEnd: '점프: 끝 판정 높이',
  jumpWithSwingMs: '점프 스파이크 인정 시간(ms)',
  cooldownMs: '같은 동작 재인식 간격(ms)',
};
const SERVE_TH_LABEL = {
  tossWindowMs: '토스: 손을 올리는 시간 창(ms)',
  tossFromY: '토스: 출발 높이 (어깨보다 아래)',
  tossRise: '토스: 올라간 거리 (최소)',
  tossOtherRatio: '토스: 다른 손 올라간 비율 (최대)',
  tossOtherBelow: '토스: 다른 손이 이만큼 낮으면 인정',
  hitWaitMs: '타격: 토스 뒤 기다리는 시간(ms)',
  hitMinDelayMs: '타격: 토스 직후 무시 시간(ms)',
  swingWindowMs: '타격: 내려치는 시간 창(ms)',
  swingDrop: '타격: 내려친 거리 (최소)',
  swingEndY: '타격: 끝나는 높이 (어깨 기준)',
  speedWeak: '힘: 0%가 되는 팔 속도',
  speedStrong: '힘: 100%가 되는 팔 속도',
  jumpRiseAnkle: '점프: 발목 상승 (발목 보일 때)',
  jumpRiseHip: '점프: 골반 상승 (최소)',
  jumpAnkleMin: '점프: 골반으로 볼 때 발목 상승 (최소)',
  jumpEnd: '점프: 끝 판정 높이',
  jumpGraceMs: '점프: 착지 뒤 이 시간 안에 친 것도 점프(ms)',
  jumpPeakMs: '점프: 최고점에서 이만큼 벗어나면 점수 0(ms)',
};
// 기준값 묶음: 동작 판정(gestures.js)과 새 서브 판정(serve-detector.js)
const TH_SETS = [
  { file: 'gestures.js TH', obj: TH, def: DEFAULT_TH, labels: TH_LABEL, grid: 'th' },
  { file: 'serve-detector.js SERVE_TH', obj: SERVE_TH, def: DEFAULT_SERVE_TH, labels: SERVE_TH_LABEL, grid: 'serve-th' },
];
const getTH = (obj, key) => key.split('.').reduce((o, k) => o[k], obj);
const setTH = (obj, key, v) => { const ks = key.split('.'); ks.slice(0, -1).reduce((o, k) => o[k], obj)[ks.at(-1)] = v; };

function renderTH() {
  for (const set of TH_SETS) {
    const grid = $(set.grid);
    grid.innerHTML = '';
    for (const [key, label] of Object.entries(set.labels)) {
      const row = document.createElement('div');
      row.className = 'th-row';
      const isMs = key.includes('Ms') || key.startsWith('holdMs');
      row.innerHTML = `<label></label><input type="number" step="${isMs ? 10 : 0.05}" value="${getTH(set.obj, key)}">`;
      row.querySelector('label').textContent = label;
      const input = row.querySelector('input');
      const mark = () => row.classList.toggle('changed', getTH(set.obj, key) !== getTH(set.def, key));
      input.addEventListener('input', () => {
        if (input.value === '' || isNaN(+input.value)) return;
        setTH(set.obj, key, +input.value);
        mark();
        updateSnippet();
        analyzeAll();
      });
      mark();
      grid.appendChild(row);
    }
  }
}

function updateSnippet() {
  const parts = TH_SETS.map(set => {
    const c = Object.keys(set.labels).filter(k => getTH(set.obj, k) !== getTH(set.def, k))
      .map(k => `${k}: ${getTH(set.def, k)} → ${getTH(set.obj, k)}`);
    return c.length ? `// ${set.file} 변경 제안\n${c.join('\n')}` : '';
  }).filter(Boolean);
  $('snippet').value = parts.join('\n\n');
}

$('reset').addEventListener('click', () => {
  for (const set of TH_SETS) for (const k of Object.keys(set.labels)) setTH(set.obj, k, getTH(set.def, k));
  renderTH(); updateSnippet(); analyzeAll();
});
$('copy').addEventListener('click', async () => {
  updateSnippet();
  try { await navigator.clipboard.writeText($('snippet').value); $('copy').textContent = '복사됨!'; }
  catch { $('snippet').select(); }
  setTimeout(() => { $('copy').textContent = '바뀐 값 복사'; }, 1500);
});

renderTH();
drawAll();

// 자동 검사용
window.replay = { addRecording, recs, TH, SERVE_TH };
