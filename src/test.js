// 동작 인식 테스트 페이지: 웹캠 뼈대 표시 + 동작별 10회 테스트
import { startCamera, createPose, makePoseReader } from './camera.js';
import { Tracker, STATUS_MSG } from './tracker.js';
import { GESTURES, ORDER, TH } from './gestures.js';
import { Tester } from './tester.js';
import { Recorder } from './recorder.js';
import { Renderer } from './render.js';
import { initSound, sfx } from './sound.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MODEL = params.get('model') === 'full' ? 'full' : 'lite';

const video = $('video');
const renderer = new Renderer($('canvas'), video);
const tracker = new Tracker();
const tester = new Tester(sfx);
const recorder = new Recorder();
const MAX_REC_SEC = 600;   // 녹화는 최대 10분

let readPoses = null;
let fps = 0, lastDetT = 0;
let showDebug = params.has('debug');
const counts = Object.fromEntries(ORDER.map(k => [k, 0]));

// ── 하단 동작 카드
const cardEls = {};
for (const type of ORDER) {
  const g = GESTURES[type];
  const el = document.createElement('div');
  el.className = 'card';
  el.style.color = g.color;
  el.innerHTML = `
    <div class="c-key">[${g.key}] 눌러 테스트</div>
    <div class="c-name">${g.name}</div>
    <div class="c-hint" style="color:#fff">${g.hint}</div>
    <div class="c-count">0</div>
    <div class="c-test" style="color:#fff"></div>`;
  el.addEventListener('click', () => startTest(type));
  $('cards').appendChild(el);
  cardEls[type] = el;
}

function startTest(type) {
  if (tracker.state !== 'ready') return;
  tester.start(type, performance.now());
}

function flash(type, ev) {
  const g = GESTURES[type];
  const el = $('flash');
  let label = g.name + '!';
  if ((type === 'spike' || type === 'serve') && ev.jump) label = '점프 ' + label;
  el.textContent = label;
  el.style.color = g.color;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');

  const card = cardEls[type];
  card.querySelector('.c-count').textContent = counts[type];
  card.classList.add('hit');
  setTimeout(() => card.classList.remove('hit'), 180);
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'pill ' + cls;
}

function handle(res) {
  const { status } = res;
  $('center-msg').textContent = STATUS_MSG[status] ?? '';
  $('calib-bar').style.display = status === 'calibrating' ? 'block' : 'none';
  if (status === 'calibrating') $('calib-fill').style.width = (res.progress * 100) + '%';

  if (status === 'none' || status === 'far') setStatus('사람을 찾는 중', 'bad');
  else if (status === 'small') setStatus('위치 맞추는 중', 'warn');
  else if (status === 'calibrating') setStatus('몸 크기 재는 중', 'warn');
  else setStatus('인식 중', 'ok');

  if (res.justCalibrated) sfx.done();
  if (status !== 'ready') tester.stop();

  for (const ev of res.events) {
    if (ev.held) continue;   // 자세 유지 다시 알림은 세지 않는다(게임 판정용)
    counts[ev.type]++;
    flash(ev.type, ev);
    if (tester.active) tester.onGesture(ev);
    else sfx.gesture();
  }
  for (const ev of res.serveEvents ?? []) handleServe(ev);
}

// ── 새 서브 판정 (토스 → 다른 손으로 치기). 게임과 같은 serveEvents를 보여 준다.
const HAND = { l: '왼손', r: '오른손' };
const pct = v => Math.round(v * 100) + '%';
const serveLog = [];
let serveToss = null;

function flashText(text, color) {
  const el = $('flash');
  el.textContent = text;
  el.style.color = color;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function handleServe(ev) {
  if (ev.type === 'serveToss') {
    serveToss = ev;
    flashText('① 토스!', '#ffd54f');
    sfx.gesture();
    return;
  }
  serveToss = null;
  let line;
  if (ev.type === 'serveHit') {
    const kind = ev.jump ? '스파이크 서브' : '플로터 서브';
    flashText(kind + '!', ev.jump ? '#ff8a65' : '#4fc3f7');
    sfx.gesture();
    line = `<b style="color:${ev.jump ? '#ff8a65' : '#4fc3f7'}">${kind}</b> ${HAND[ev.tossHand]} 토스 → ${HAND[ev.hand]} 치기`
      + ` · 힘 ${pct(ev.power)} · 토스 뒤 ${(ev.sinceToss / 1000).toFixed(2)}초`
      + (ev.jump ? ` · 점프 높이 ${pct(ev.jumpPeak)}${ev.jumpRising ? '(올라가는 중)' : ''}` : '');
  } else {
    line = `<span style="color:#ef5350">토스 취소</span> ${HAND[ev.hand]} 토스 뒤 2.5초 안에 다른 손으로 치지 않음`;
  }
  serveLog.unshift(line);
  serveLog.length = Math.min(serveLog.length, 5);
}

function drawServe(t) {
  const el = $('serve-panel');
  if (tracker.state !== 'ready') { el.hidden = true; return; }
  el.hidden = false;
  const left = serveToss ? Math.max(0, 1 - (t - serveToss.t) / 2500) : 0;
  el.innerHTML = `
    <div class="s-title">새 서브 판정</div>
    <div class="s-step">${serveToss
      ? `② ${HAND[serveToss.hand === 'l' ? 'r' : 'l']}으로 내려치세요 <span class="s-note">(점프하면 스파이크 서브)</span>`
      : '① 한 손을 가슴에서 머리 위로 빠르게 올려 토스'}</div>
    <div class="s-time"><div style="width:${left * 100}%"></div></div>
    ${serveLog.map(l => `<div class="s-log">${l}</div>`).join('')}`;
}

// ── 테스트 모드 화면
function drawTester(t) {
  const s = tester.tick(t);
  const el = $('tester');
  for (const type of ORDER) {
    const res = tester.results[type];
    cardEls[type].querySelector('.c-test').textContent = res ? `테스트 ${res.ok}/${res.total}` : '';
  }
  if (!s) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  el.className = s.phase === 'go' ? 'go' : s.phase === 'result' ? (s.last ? 'ok' : 'fail') : '';
  const dots = s.marks.map(m => (m ? '⭕' : '❌')).join('') + '·'.repeat(s.trials - s.marks.length);

  if (s.phase === 'summary') {
    const wrong = Object.entries(s.result.wrong)
      .map(([k, n]) => `${GESTURES[k].name} ${n}번`).join(', ');
    const pass = s.result.ok >= Math.ceil(s.trials * 0.8);
    el.innerHTML = `
      <div class="t-title">${s.g.name} 테스트 결과</div>
      <div class="t-name" style="color:${pass ? '#66bb6a' : '#ef5350'}">${s.result.ok} / ${s.trials}</div>
      <div class="t-hint">${pass ? '통과! 🎉' : '기준(8번) 미달 — 기준값 조정 필요'}</div>
      <div class="t-hint">${wrong ? '다른 동작으로 인식: ' + wrong : ''}</div>`;
    return;
  }

  const title = s.phase === 'ready' ? '준비…' : s.phase === 'go' ? '지금!' : s.last ? '성공!' : '놓쳤어요';
  el.innerHTML = `
    <div class="t-title">${s.trial} / ${s.trials}번째 · ${title}</div>
    <div class="t-name" style="color:${s.g.color}">${s.g.name}</div>
    <div class="t-hint">${s.g.hint}</div>
    <div class="t-time"><div style="width:${s.goLeft * 100}%"></div></div>
    <div class="t-dots">${dots}</div>`;
}

// ── 메인 반복
function loop() {
  requestAnimationFrame(loop);
  const t = performance.now();

  const poses = readPoses(t);
  if (poses) {
    if (lastDetT) fps += (1000 / (t - lastDetT) - fps) * 0.1;
    lastDetT = t;
    // 녹화: 테스트의 '지금!' 구간이면 그 동작 이름을 정답으로 함께 기록
    // 공격 표시 키(7~0)를 눌렀으면 그 이름을 우선 기록한다 (공격 방향 기준값을 맞출 때 쓴다)
    recorder.frame(t, poses, attackLabel || (tester.run?.phase === 'go' ? tester.run.type : 0));
    const res = tracker.process(poses, t, (video.videoWidth || 16) / (video.videoHeight || 9));
    handle(res);
    showAttack(res, t);
    $('fps').textContent = `${fps.toFixed(0)} fps · ${MODEL}`;
    $('fps').className = 'pill ' + (fps >= 20 ? 'ok' : fps >= 12 ? 'warn' : 'bad');
  }

  const holding = tracker.holding;
  renderer.draw({
    player: tracker.player, others: tracker.others,
    holding, color: holding ? GESTURES[holding].color : null,
  });
  for (const type of ORDER) cardEls[type].classList.toggle('holding', holding === type);
  drawTester(t);
  drawServe(t);

  const rec = $('rec');
  rec.hidden = !recorder.active;
  if (recorder.active) {
    const s = Math.floor(recorder.seconds);
    rec.textContent = `● 녹화 중 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${attackLabelName ? ` · ${attackLabelName}` : ''}`;
    if (s >= MAX_REC_SEC) toggleRecording();
  }

  const dbg = $('debug');
  dbg.style.display = showDebug ? 'block' : 'none';
  if (showDebug && tracker.detector) {
    const serveDbg = tracker.serve?.debug ?? {};
    dbg.textContent = Object.entries({ ...tracker.detector.debug,
      armLen: tracker.detector.cal.armLen.toFixed(2),
      'serve토스': serveDbg.toss ?? '-', 'serve점프': serveDbg.jump ?? '-' })
      .map(([k, v]) => `${k.padEnd(9)} ${v}`).join('\n');
  }
}

// ── 공격(스파이크·팁) 표시: 7 스트레이트 · 8 크로스 · 9 라인 · 0 팁 · - 표시 끄기
// 녹화 중 동작마다 키를 먼저 누르고 동작하면, 파일에 그 이름이 정답으로 남는다.
const ATTACK_LABELS = { '7': ['straight', '스트레이트'], '8': ['cross', '크로스'], '9': ['line', '라인'], '0': ['tip', '팁'] };
let attackLabel = 0, attackLabelName = '';
function setAttackLabel(key) {
  [attackLabel, attackLabelName] = ATTACK_LABELS[key] ?? [0, ''];
  flashText(attackLabel ? `지금 할 동작: ${attackLabelName}` : '공격 표시 끔', '#ffd54f');
}
const aimText = aim => aim === 0 ? '가운데' : `${aim < 0 ? '← 왼쪽' : '오른쪽 →'} ${Math.abs(aim).toFixed(2)}`;
let lastTipCheck = 0;
function showAttack(res, t) {
  for (const e of res.attackEvents ?? []) flashText(`스파이크 (${e.hand === 'l' ? '왼손' : '오른손'}) ${aimText(e.aim)}`, '#ff8a65');
  // 팁은 게임에서는 공이 닿는 시각에 묻는다. 여기서는 0.5초마다 물어 손을 대고 있으면 보여 준다
  if (t - lastTipCheck > 500 && tracker.attack) {
    lastTipCheck = t;
    const tip = tracker.attack.handUp(t - 200);
    if (tip) flashText(`팁 (${tip.hand === 'l' ? '왼손' : '오른손'}) ${aimText(tip.aim)}`, '#ba68c8');
  }
}
// ── 녹화 (관절 좌표만, 영상은 저장하지 않음)
function toggleRecording() {
  if (!readPoses) return;
  const el = $('flash');
  if (recorder.active) {
    const name = recorder.stop();
    el.textContent = '녹화 저장됨 (다운로드 폴더)';
    console.info('녹화 파일:', name);
  } else {
    recorder.start({
      aspect: (video.videoWidth || 16) / (video.videoHeight || 9),
      model: MODEL,
      cal: tracker.detector?.cal ?? null,   // 이미 잰 몸 크기 (없으면 재생할 때 다시 잼)
      th: structuredClone(TH),
    });
    el.textContent = '● 녹화 시작';
  }
  el.style.color = '#ff5252';
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

// ── 키보드
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  const byKey = ORDER.find(type => GESTURES[type].key === k);
  if (byKey) startTest(byKey);
  else if (k === 'v') toggleRecording();
  else if (ATTACK_LABELS[k] || k === '-') setAttackLabel(k);
  else if (k === 'escape') tester.stop();
  else if (k === 'c') { tracker.recalibrate(); tester.stop(); }
  else if (k === 'd') showDebug = !showDebug;
  else if (k === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  } else if (k === 'r') {
    for (const type of ORDER) { counts[type] = 0; cardEls[type].querySelector('.c-count').textContent = 0; }
    tester.results = {};
    serveLog.length = 0; serveToss = null;
  }
});

// ── 시작
$('start-btn').addEventListener('click', async () => {
  const btn = $('start-btn'), info = $('start-info');
  btn.disabled = true;
  initSound();
  try {
    info.textContent = '카메라를 켜는 중…';
    await startCamera(video);
    info.textContent = '동작 인식 모델을 불러오는 중… (처음에는 조금 걸려요)';
    readPoses = makePoseReader(await createPose(MODEL), video);
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    info.textContent = e.name === 'NotAllowedError'
      ? '카메라 권한이 거부되었어요. 주소창 옆 카메라 아이콘에서 허용해 주세요.'
      : e.name === 'NotReadableError' || e.name === 'AbortError'
        ? '카메라를 다른 창이 쓰고 있어요. 게임 창이나 줌·카메라 앱을 닫고 다시 눌러 주세요.'
        : e.name === 'NotFoundError'
          ? '카메라를 찾지 못했어요. 웹캠 연결을 확인해 주세요.'
          : '시작하지 못했어요: ' + e.message;
    return;
  }
  $('start-screen').style.display = 'none';
  document.documentElement.requestFullscreen?.().catch(() => {});
  loop();
});
