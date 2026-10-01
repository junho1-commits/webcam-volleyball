// 인트로: 오프닝 영상 → 타이틀(로고·배경) → 손 흔들기/키/클릭으로 시작
// 그림·영상 파일이 없어도 동작한다 (없으면 경기장 콘셉트 그림과 CSS 연출로 대신함).
// 나중에 게임 페이지 안에 붙일 수 있게 mountIntro({ onStart })만 밖으로 연다.
import { initSound, audioReady, startMusic, stopMusic, startAmbience, say, sfx } from '../sound.js';
import { startCamera, createPose, makePoseReader } from '../camera.js';
import { Renderer } from '../render.js';
import { WaveStarter } from './wave.js';

const ASSETS = {
  opening: 'assets/intro/opening.mp4',     // 오프닝 영상 (끝 장면 = 타이틀 그림)
  loop: 'assets/intro/title-loop.mp4',     // 타이틀 배경 반복 영상
  still: 'assets/intro/title.jpg',         // 타이틀 그림
  fallback: 'art/concept/beach-arena-concept.png',
};
const OPENING_MAX_MS = 15000;    // 영상이 멈춰도 이 시간이 지나면 타이틀로

const exists = async url => {
  try { return (await fetch(url, { method: 'HEAD', cache: 'no-cache' })).ok; } catch { return false; }
};

export async function mountIntro({ root = document.body, onStart = () => {}, opening = true } = {}) {
  const el = document.createElement('div');
  el.className = 'intro';
  el.innerHTML = `
    <div class="intro-bg"></div>
    <div class="intro-shade"></div>
    <div class="intro-sun"></div>
    <div class="intro-logo" hidden>
      <div class="logo-small">웹캠</div>
      <div class="logo-big">${[...'비치발리볼'].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
      <svg class="logo-ball" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="46" fill="#fffdf2" stroke="#1b2a4a" stroke-width="5"/>
        <path d="M50 4 C30 30 30 70 50 96" fill="none" stroke="#1e88e5" stroke-width="7"/>
        <path d="M8 36 C36 44 70 40 94 26" fill="none" stroke="#fdd835" stroke-width="7"/>
        <path d="M14 76 C40 60 70 62 90 76" fill="none" stroke="#1e88e5" stroke-width="7"/>
      </svg>
    </div>
    <div class="intro-start" hidden>
      <div class="start-main"><span class="start-hand">👋</span> 손을 흔들어 시작하세요</div>
      <div class="start-sub">또는 한 손을 머리 위로 들고 기다리기 · 키보드 아무 키 · 화면 클릭</div>
      <div class="start-hold"><div></div></div>
    </div>
    <div class="intro-sound" hidden>🔊 소리를 켜려면 아무 키나 한 번 누르세요</div>
    <div class="intro-skip" hidden>건너뛰기: 아무 키 · 클릭 · 손 흔들기</div>
    <div class="intro-pip" hidden><canvas></canvas><span>손을 흔들어 보세요</span></div>
    <div class="intro-flash"></div>
    <video class="intro-cam" playsinline muted></video>`;
  root.appendChild(el);
  const $ = s => el.querySelector(s);

  let phase = 'loading';     // opening → title → leaving
  let phaseT = performance.now();
  let started = false;
  let camStream = null, readPoses = null, pip = null, raf = 0;
  const wave = new WaveStarter();

  const [hasOpening, hasLoop, hasStill] = await Promise.all([ASSETS.opening, ASSETS.loop, ASSETS.still].map(exists));

  // ── 배경: 반복 영상 > 타이틀 그림 > 콘셉트 그림(천천히 확대)
  const bg = $('.intro-bg');
  if (hasLoop) {
    bg.innerHTML = `<video src="${ASSETS.loop}" muted loop playsinline autoplay></video>`;
  } else {
    bg.innerHTML = `<img src="${hasStill ? ASSETS.still : ASSETS.fallback}" alt="">`;
    if (!hasStill) bg.classList.add('kenburns');   // 타이틀 그림은 구도를 지키려고 확대하지 않음
  }
  if (!hasStill && !hasLoop) el.classList.add('placeholder');   // 임시 배경일 때는 해와 빛 효과로 채움

  // ── 입력: 키보드·클릭 (소리가 막혀 있으면 첫 입력은 소리만 켬)
  const onInput = e => {
    if (e.type === 'keydown' && (e.repeat || ['F5', 'F11', 'F12'].includes(e.key))) return;
    initSound();
    if (phase === 'opening') { toTitle(); return; }
    if (phase !== 'title') return;
    if (!$('.intro-sound').hidden) {
      $('.intro-sound').hidden = true;
      say('title_call', { priority: 2 });
      return;
    }
    if (performance.now() - phaseT > 600) start();
  };
  addEventListener('keydown', onInput);
  el.addEventListener('pointerdown', onInput);

  // ── 오프닝
  function playOpening() {
    phase = 'opening';
    phaseT = performance.now();
    const v = document.createElement('video');
    v.className = 'intro-opening';
    v.src = ASSETS.opening;
    v.muted = true;
    v.playsInline = true;
    el.insertBefore(v, $('.intro-shade'));
    $('.intro-skip').hidden = false;
    v.addEventListener('ended', toTitle);
    v.addEventListener('error', toTitle);
    v.play().catch(toTitle);
    setTimeout(() => { if (phase === 'opening') toTitle(); }, OPENING_MAX_MS);
  }

  // ── 타이틀
  function toTitle() {
    if (phase === 'title' || phase === 'leaving') return;
    phase = 'title';
    phaseT = performance.now();
    $('.intro-skip').hidden = true;
    const v = $('.intro-opening');
    if (v) { v.classList.add('fade'); setTimeout(() => v.remove(), 700); }
    $('.intro-logo').hidden = false;
    setTimeout(() => { if (phase === 'title') $('.intro-start').hidden = false; }, 1400);

    initSound();
    startMusic();
    startAmbience();
    // 브라우저가 소리를 막았으면 안내, 아니면 바로 해설 음성
    setTimeout(() => {
      if (audioReady()) say('title_call', { priority: 2 });
      else $('.intro-sound').hidden = false;
    }, 700);
    setTimeout(() => { if (phase === 'title') say('help_wave_start', { priority: 2 }); }, 3200);
    startWebcam();
  }

  // ── 웹캠 (없거나 거부되면 키보드·클릭만으로 진행)
  async function startWebcam() {
    try {
      const video = $('.intro-cam');
      await startCamera(video);
      camStream = video.srcObject;
      readPoses = makePoseReader(await createPose('lite', 'CPU'), video);
      pip = new Renderer($('.intro-pip canvas'), video);
      $('.intro-pip').hidden = false;
      pip.resize();
      raf = requestAnimationFrame(loop);
    } catch (e) {
      console.info('인트로: 웹캠 없이 진행합니다.', e.name);
    }
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    const poses = readPoses?.(t);
    if (!poses) return;
    const r = wave.update(poses, t, (camStream?.getVideoTracks()[0]?.getSettings().aspectRatio) || 16 / 9);
    const holdBar = $('.start-hold');
    holdBar.classList.toggle('on', r.handUp);
    holdBar.firstElementChild.style.width = `${r.hold * 100}%`;
    $('.intro-pip').classList.toggle('active', r.handUp);
    pip.draw({ player: poses[0] ?? null, others: poses.slice(1), holding: r.handUp, color: '#ffd54f' });
    if (phase === 'opening' && r.waved) toTitle();
    else if (phase === 'title' && performance.now() - phaseT > 1500 && (r.waved || r.hold >= 1)) start();
  }

  // ── 시작: 번쩍 → onStart
  function start() {
    if (started) return;
    started = true;
    phase = 'leaving';
    sfx.spike();
    say('help_ready', { priority: 3 });
    el.classList.add('leaving');
    setTimeout(() => {
      stopMusic();
      cancelAnimationFrame(raf);
      camStream?.getTracks().forEach(tr => tr.stop());
      removeEventListener('keydown', onInput);
      onStart();
    }, 900);
  }

  if (opening && hasOpening) playOpening();
  else toTitle();

  return { start, element: el };
}
