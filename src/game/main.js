// 웹캠 배구 게임: 시작 화면, 입력(웹캠·키보드), 경기 반복
import { startCamera, createPose, makePoseReader } from '../camera.js';
import { STATUS_MSG } from '../tracker.js';
import { DuoTracker } from '../duo-tracker.js';
import { GESTURES, ORDER } from '../gestures.js';
import { Renderer } from '../render.js';
import { initSound, say, setVolume, sfx, startAmbience, startMusic, stopAmbience, stopMusic } from '../sound.js';
import { Match } from './match.js?v=20261002a';
import { GameRenderer3D } from './draw3d.js?v=20261002a';
import { HandCursor, WaveDetector, handFromPose } from '../ui/hand-cursor.js';
import { actionForCode, keyName, loadBindings } from './controls.js';
import { Recorder } from '../recorder.js';
import { HighlightReel, loadHighlightSetting, saveHighlightSetting } from '../highlight-reel.js';
import { ANIM_SECONDS } from './rules.js';
import { shouldSplitVersusView, versusInputSign } from './versus-view.js';
import { CHARACTER_PROFILES, STAT_LABELS } from './character-profiles.js';

const $ = id => document.getElementById(id);
const video = $('video');
const court = new GameRenderer3D($('court'));
const reel = new HighlightReel({ video });
const params = new URLSearchParams(location.search);
const poseParts = (params.get('pose') ?? 'gpu-full').toLowerCase().split('-');
const poseConfig = {
  delegate: poseParts.includes('gpu') ? 'GPU' : 'CPU',
  model: poseParts.includes('full') ? 'full' : 'lite',
};

const MENU_STORAGE_KEY = 'beach-volleyball-menu-v1';
function loadMenuSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MENU_STORAGE_KEY) || 'null');
    return {
      difficulty: ['easy', 'normal', 'hard'].includes(saved?.difficulty) ? saved.difficulty : 'normal',
      target: [7, 11, 15].includes(saved?.target) ? saved.target : 7,
      replay: saved?.replay !== false,
      vsSplit: saved?.vsSplit !== false,
    };
  } catch { return { difficulty: 'normal', target: 7, replay: true, vsSplit: true }; }
}
let options = loadMenuSettings();
function saveMenuSettings() {
  try { localStorage.setItem(MENU_STORAGE_KEY, JSON.stringify(options)); } catch { /* 메모리 값으로 계속 */ }
}
let mode = null;              // 'webcam' | 'keyboard' | 'keyboard-duo'
let cameraMode = 'solo', activeCameraMode = 'solo', startRequest = 0;
const MENU_SCREEN_IDS = ['start-screen', 'mode-screen', 'character-screen', 'ready-screen', 'teacher-settings'];
const ROSTER = CHARACTER_PROFILES;
const rosterNames = Object.keys(ROSTER);
let selectedCharacters = loadCharacterChoices();
let characterPick = 0;
let match = null;
let running = false;
let paused = false;
let gameTime = 0, lastFrameT = 0;
let playerX = [-1.35, 1.35];
const keysDown = new Set();
let bindings = loadBindings();

function loadCharacterChoices() {
  try {
    const saved = JSON.parse(localStorage.getItem('beach-volleyball-characters-v1') || 'null');
    if (Array.isArray(saved) && rosterNames.includes(saved[0]) && rosterNames.includes(saved[1]) && saved[0] !== saved[1]) return saved;
  } catch { /* 기본 선수 사용 */ }
  return ['ara', 'min'];
}
function saveCharacterChoices() {
  try { localStorage.setItem('beach-volleyball-characters-v1', JSON.stringify(selectedCharacters)); } catch { /* 메모리 값으로 계속 */ }
}

const HAND_STORAGE_KEY = 'beach-volleyball-handedness-v1';
function loadHandedness() {
  try {
    const saved = JSON.parse(localStorage.getItem(HAND_STORAGE_KEY) || 'null');
    return [saved?.[0] === 'left' ? 'left' : 'right', saved?.[1] === 'left' ? 'left' : 'right'];
  } catch { return ['right', 'right']; }
}
function saveHandedness() {
  try { localStorage.setItem(HAND_STORAGE_KEY, JSON.stringify(handedness)); } catch { /* 메모리 값으로 계속 */ }
}
let handedness = loadHandedness();

// 웹캠 관련
let tracker = null, readPoses = null, pip = null, camReady = false;
let lastCamResult = { readyCount: 0 };
let poseFrames = 0, poseWindowT = performance.now(), poseFps = 0;
let lastWebcamStatus = null, lastReadyCount = 0;
let activePromptKeys = new Set(), arrowCueKey = '', consecutivePerfect = 0;
let lastStats = { perfect: 0, good: 0, miss: 0 };
const helpLastAt = new Map();
let voiceSession = 0;
let voiceCueAfter = 0, pendingMatchPoint = false;
let cameraBoot = null, startHandEnabled = false, previousHand = null;
let trackingTime = 0, lastTrackingT = 0;
let lastServeGuide = '', serveReminderAt = 0;
let highlightOn = loadHighlightSetting();
let ceremonyTimer = null, victoryGestureTimer = null, ceremonyFinish = null, practice = false, practiceStep = 0, practiceComplete = false;
let debugContactFrozen = false;
let debugPointScene = null;
let hypeHoldSince = 0, hypeCooldownUntil = 0;
let handSelectionLocked = [false, false], handStageAnnounced = [false, false];
let handConfirmTimer = null;
const PRACTICE_STEPS = [
  { action: 'serve', icon: '🏐', label: '서브', text: '치는 손을 들면 캐릭터도 그 손으로 쳐요\n공을 올리고, 떨어질 때 치세요', voice: 'do_serve' },
  { action: 'bump', icon: '🤲', label: '리시브', text: '분홍 링으로 가서 받아요', voice: 'do_bump' },
  { action: 'spike', icon: '💥', label: '스파이크', text: '점프해 한 손으로 쳐요 · 손목 방향으로 가고, 손만 대면 팁!', voice: 'do_spike' },
  { action: 'block', icon: '🙌', label: '블로킹', text: '두 손을 들고 점프해요', voice: 'do_block' },
];

const handCursor = new HandCursor({ onHover: () => sfx.tick(), onSelect: () => sfx.ok() });
// 마우스는 일반 클릭, 손만 머무르기 선택을 사용한다.
handCursor.enableMouse(false);
const waveDetector = new WaveDetector({ onWave: () => skipPresentation() || match?.skipReplay() });

function sayWhenLoaded(name, options = {}, token = voiceSession, tries = 24) {
  if (token !== voiceSession || say(name, options) || tries <= 0) return;
  setTimeout(() => sayWhenLoaded(name, options, token, tries - 1), 250);
}

const perfEl = $('perf');
perfEl.hidden = !params.has('perf');
if (!/NVIDIA/i.test(court.gpuName)) {
  $('gpu-warning').hidden = false;
  $('gpu-warning').textContent = `⚠ 그래픽 GPU가 NVIDIA가 아닙니다: ${court.gpuName}`;
}

// 자동 테스트용 (주소 뒤에 ?debug)
if (new URLSearchParams(location.search).has('debug')) {
  window.game = { get match() { return match; }, setX: x => { playerX[0] = x; } };
  const slowMotionProbe = () => {
    debugContactFrozen = true; hideCeremonies(); $('message').hidden = true;
    const results = [];
    for (let spike = 1; spike <= 5; spike++) {
      match.presentation = null; match.phase = 'rally'; match.clearPlans(); match._timeScale = 1;
      const actor = match.players[0];
      actor.x = actor.tx = 0; actor.z = actor.tz = -1.6; actor.anim = null;
      let t = gameTime + spike * 2, hit = false;
      const from = { x: -.35 + spike * .12, y: 1.15, z: -4.4 };
      const contact = { x: 0, y: 2.65, z: -1.35 };
      match.time = t;
      match.ball.launch(from, contact, 1.1, t);
      match.expect('spike', ['spike'], 0, () => {
        const p = match.ball.pos(match.time);
        match.ball.launch(p, { x: .35, y: .9, z: 5.2 }, .9, match.time, 'spike');
      });
      const hitT = match.exp.tHit, samples = [{ scale: 1, point: null, shot: '' }];
      court.camera.position.copy(court.defaultCamera); court.cameraTarget.set(0, .5, 3);
      court.lastCameraT = null; court.director.reset();
      while (t <= hitT + .31) {
        match.updateTimeScale(1 / 60);
        t += match.timeScale / 60;
        match.time = t;
        if (!hit && t >= hitT) {
          match.onGesture('spike', { jump: true, aim: 0 }, 0);
          hit = true;
        }
        match.update(t, actor.x, null);
        court.draw(match, t);
        court.camera.updateMatrixWorld();
        const projected = court.ball.position.clone().project(court.camera);
        samples.push({
          t, scale: match.timeScale, shot: court.cameraShot,
          point: { x: (projected.x + 1) * court.canvas.clientWidth / 2, y: (1 - projected.y) * court.canvas.clientHeight / 2 },
        });
      }
      let maxScaleDelta = 0, maxBallPixels = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        maxScaleDelta = Math.max(maxScaleDelta, Math.abs(b.scale - a.scale));
        if (a.point && b.point && a.shot === b.shot && Math.abs(a.t - hitT) <= .3 && Math.abs(b.t - hitT) <= .3) {
          maxBallPixels = Math.max(maxBallPixels, Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y));
        }
      }
      results.push({ spike, minScale: Math.min(...samples.map(s => s.scale)), maxScale: Math.max(...samples.map(s => s.scale)),
        maxScaleDelta: Number(maxScaleDelta.toFixed(4)), maxBallPixels: Number(maxBallPixels.toFixed(1)) });
    }
    gameTime = match.time;
    const actor = match.players[0];
    match._timeScale = 1; match.exp = { action: 'spike', accepts: ['spike'], who: 0, tHit: gameTime, t0: gameTime - 1.1, done: false };
    actor.anim = { type: 'spike', t0: gameTime - .5 * ANIM_SECONDS, jump: true, planned: true, hold: true };
    match.ball.stopAt({ x: 0, y: 2.65, z: -1.35 });
    court.draw(match, gameTime); document.body.classList.toggle('slow-motion', match.slowMotion);
    $('court').dataset.slowMotionProbe = JSON.stringify(results);
    return results;
  };
  window.fakeServe = ({ jump = false, power = .7, delay, hand } = {}) => {
    if (hand && match?.phase === 'serve-me') matchServeHand(match.serverIndex, hand);   // hand: 토스한 손 'l' | 'r'
    if (!match?.onServeToss({ playerIndex: match.serverIndex, source: 'webcam', hand })) return false;
    const toss = match.serveToss;
    const hitDelay = delay ?? (jump ? toss.jumpIdeal : toss.floatIdeal);
    const scheduledMatch = match, server = match.serverIndex, due = match.time + hitDelay;
    const hitWhenDue = () => {
      if (match !== scheduledMatch || match.phase !== 'serve-toss' || match.serveToss !== toss) return;
      if (match.time < due) { requestAnimationFrame(hitWhenDue); return; }
      match.onServeHit({ playerIndex: server, source: 'webcam', jump, power, jumpPeak: jump ? .9 : 0 });
    };
    requestAnimationFrame(hitWhenDue);
    return true;
  };
  async function awaitAutoMoveProbe() {
    await court.ready;
    debugContactFrozen = true; hideCeremonies(); match.presentation = null;
    const rows = [];
    court.draw(match, gameTime);
    for (const handSide of ['left', 'right']) for (const who of [3, 2, 1, 0]) {
      match.clearPlans(); match.phase = 'rally';
      const actor = match.actor(who), person = court.people[who], side = who < 2 ? -1 : 1;
      person.setHandedness(handSide); actor.contactGeometry = person.contactGeometry;
      actor.x = -2.8; actor.z = side * 6; actor.tx = 2.2; actor.tz = side * 1.4;
      const start = match.time;
      const contact = match.contactPoint(who, 'spike', start + 1.7);
      match.ball.launch({ x: 0, y: 1.5, z: side * 3 }, contact, 1.7, start);
      match.expect('spike', ['spike'], who, () => {});
      for (let step = 1; step <= 102; step++) {
        const t = start + step / 60;
        match.update(t, 0, 0);
        person.update(actor, who < 2 ? 1 : -1, t);
      }
      person.root.updateMatrixWorld(true);
      const hand = person.getHandWorldPosition(), ball = match.ball.pos(match.time);
      rows.push({ name: actor.characterName, hand: handSide, gap: Math.hypot(hand.x + ball.x, hand.y - ball.y, hand.z - ball.z) });
    }
    gameTime = match.time; court.draw(match, gameTime);
    $('court').dataset.autoMoveProbe = JSON.stringify(rows);
  }
  addEventListener('volleyball-debug', event => {
    const data = event.detail ?? {};
    if (!match) return;
    if (data.command === 'hand-stage') {
      $('gpu-warning').hidden = true;
      hideCeremonies(); match.presentation = null;
      const hand = data.hand === 'right' ? 'right' : 'left';
      const progress = Math.min(1, Math.max(0, Number(data.progress ?? .58)));
      $('cam-overlay').style.display = 'flex'; $('cam-msg').textContent = STATUS_MSG.hand;
      $('cam-bar').style.display = 'block'; $('cam-fill').style.width = `${progress * 100}%`;
      $('hand-choice').innerHTML = `<span class="hand-choice-tag" style="left:${hand === 'left' ? 62 : 38}%">${hand === 'left' ? '✋ 왼손' : '오른손 ✋'}</span>`;
    } else if (data.command === 'hand-choice') {
      $('gpu-warning').hidden = true;
      hideCeremonies(); match.presentation = null; $('cam-overlay').style.display = 'none'; $('hand-choice').replaceChildren();
      chooseRaisedHand(Number(data.slot ?? 0), data.hand === 'right' ? 'right' : 'left');
    } else if (data.command === 'held-receive-demo') {
      $('gpu-warning').hidden = true; hideCeremonies(); match.presentation = null; debugContactFrozen = true;
      match.phase = 'rally'; match.phaseT = gameTime; match.clearPlans();
      const actor = match.players[0]; actor.x = actor.tx = -.5; actor.z = actor.tz = -3.7;
      actor.anim = { type: 'bump', t0: gameTime - .45 * ANIM_SECONDS, planned: true, hold: true };
      match.players[1].x = match.players[1].tx = 1.5; match.players[1].z = match.players[1].tz = -4.8;
      match.ball.stopAt({ x: actor.x, y: .9, z: actor.z + .15 });
      $('message').hidden = false; $('message').classList.remove('serve-guide');
      $('msg-text').textContent = 'GOOD!'; $('msg-sub').textContent = '미리 준비한 리시브 성공!';
    } else if (data.command === 'point') {
      match.debugBallAtServeHand = false;
      match.phase = 'rally'; match.pointTo(data.team === 'ai' ? 'ai' : 'me');
    } else if (data.command === 'point-scene') {
      match.debugBallAtServeHand = false;
      $('gpu-warning').hidden = true; hideCeremonies(); match.presentation = null; debugContactFrozen = true;
      const winner = data.team === 'ai' ? 'ai' : 'me';
      const elapsed = Math.max(0, Number(data.elapsed ?? .8));
      const sceneKey = `${winner}:${Number(data.point ?? 1)}:${!!data.shared}`;
      const currentElapsed = debugPointScene?.key === sceneKey ? match.time - debugPointScene.startedAt : Infinity;
      if (debugPointScene?.key !== sceneKey || match.phase !== 'point' || elapsed < currentElapsed) {
        match.target = 99; match.winner = null; match.phase = 'rally'; match.time = gameTime; match.clearPlans(); match.resetHomes();
        match.score = { me: Number(data.meScore ?? 0), ai: Number(data.aiScore ?? 0) };
        [...match.players, ...match.ai].forEach((p, i) => {
          const drift = ((Number(data.point ?? 1) + i) % 3 - 1) * .35;
          p.x = p.tx = p.homeX + drift; p.z = p.tz = p.homeZ; p.vx = 0; p.vz = 0;
        });
        match.pointCelebrationCount = data.shared ? Math.max(2, Number(data.point ?? 3) - 1) : 0;
        match.rallyHighlight = { serveTeam: winner === 'me' ? 'ai' : 'me', receiveCount: 2, dig: false,
          netCrossings: 2, lastAttack: { type: 'tip', team: winner, actor: winner === 'me' ? 0 : 2 }, stuff: null };
        match.pointTo(winner);
        debugPointScene = { key: sceneKey, startedAt: match.phaseT };
      }
      const targetTime = debugPointScene.startedAt + elapsed;
      while (match.time + 1 / 60 < targetTime) match.update(match.time + 1 / 60, null, null);
      match.update(targetTime, null, null); gameTime = targetTime;
      $('message').hidden = elapsed > .3;
      court.transitionFlashUntil = elapsed < .3 ? performance.now() + (1 - elapsed / .3) * 200 : -1;
      court.draw(match, gameTime);
    } else if (data.command === 'hype') court.reactCrowd('hype');
    else if (data.command === 'gesture') {
      debugContactFrozen = true;
      court.people.forEach(person => { person.root.visible = true; }); $('message').hidden = true;
      match.phase = 'point'; match.phaseT = gameTime;
      const winner = data.team === 'ai' ? 'ai' : 'me';
      match.lastPoint = winner; match.presentation = null;
      match.pointCelebrationCount++;
      match.applyTeamGestures(winner, { forceShared: !!data.shared, victoryStage: data.stage ?? 0 });
      const winning = winner === 'me' ? match.players : match.ai;
      const losing = winner === 'me' ? match.ai : match.players;
      winning.forEach((p, i) => { p.x = p.tx = i ? .45 : -.45; p.z = p.tz = winner === 'me' ? -2.4 : 2.4; p.anim.t0 = gameTime - .5 * ANIM_SECONDS; });
      if (data.shared) winning.forEach((p, i) => { p.anim.face = { x: winning[1 - i].x, z: winning[1 - i].z }; });
      losing.forEach((p, i) => { p.x = p.tx = i ? 1.3 : -1.3; p.z = p.tz = winner === 'me' ? 3.8 : -3.8; p.anim.t0 = gameTime - .5 * ANIM_SECONDS; });
      if (Array.isArray(data.styles)) {
        const squad = winner === 'me' ? match.players : match.ai;
        squad.forEach((p, i) => { if (data.styles[i]) p.anim.style = data.styles[i]; });
      }
    } else if (data.command === 'attack-pose') {
      debugContactFrozen = true;
      court.people.forEach(person => { person.root.visible = true; }); court.people[1].root.visible = false; $('message').hidden = true;
      match.phase = 'point'; match.phaseT = gameTime - 2; match.lastPoint = 'me'; match.presentation = null;
      const actor = match.players[0]; actor.x = actor.tx = Number(data.x ?? 0); actor.z = actor.tz = -2.4;
      actor.anim = { type: data.type === 'tip' ? 'tip' : 'spike', style: data.style, aim: Number(data.aim ?? 0), jump: data.jump !== false,
        planned: true, hold: true, t0: gameTime - (Number(data.k ?? .5) * ANIM_SECONDS) };
      match.players[1].x = match.players[1].tx = actor.x; match.players[1].z = match.players[1].tz = actor.z; match.players[1].anim = null;
      match.ai.forEach((p, i) => { p.x = p.tx = p.homeX; p.z = p.tz = p.homeZ + i * .5; p.anim = null; });
      match.ball.stopAt({ x: actor.x + Number(data.aim ?? 0) * .12, y: 2.45, z: actor.z + .15 });
    } else if (data.command === 'serve-demo') {
      debugContactFrozen = true; $('message').hidden = true; match.presentation = null;
      match.startServe('me');
      const server = match.players[match.serverIndex];
      server.x = server.tx = 0; server.z = server.tz = -7.2;
      match.setServeGeometry({
        toss: { x: server.x - .3, y: 1.35, z: server.z }, hit: { x: server.x + .3, y: 2.3, z: server.z },
        hitFloat: { x: server.x + .3, y: 2.3, z: server.z }, hitJump: { x: server.x + .3, y: 2.75, z: server.z }, standReach: 2.3,
      });
      match.beginServeToss('me', match.serverIndex, { source: 'webcam' });
      match.serveToss.jump = true;
      match.serveToss.t0 = gameTime - match.serveToss.jumpIdeal;
      match.ball.stopAt({ x: server.x + .3, y: match.serveToss.jumpReach, z: server.z + .3 });
      match.debugBallAtServeHand = true;
      server.anim = { type: 'serveJump', t0: gameTime - .35 * ANIM_SECONDS, jump: true, planned: true, hold: true };
    } else if (data.command === 'block-defense-demo') {
      debugContactFrozen = true; $('message').hidden = true; match.presentation = null; match.phase = 'rally'; match.phaseT = gameTime;
      match.debugBallAtServeHand = false;
      match.clearPlans();
      const blocker = match.players[0], defender = match.players[1], attacker = match.ai[0];
      blocker.x = blocker.tx = 2.2; blocker.z = blocker.tz = -.45;
      blocker.anim = { type: 'block', t0: gameTime - .28 * ANIM_SECONDS, jump: true, planned: true, hold: true };
      defender.x = defender.tx = -1.2; defender.z = defender.tz = -5.3;
      defender.anim = { type: 'ready', t0: gameTime, face: { x: -2.4, z: -5.8 }, hold: true };
      attacker.x = attacker.tx = 2.2; attacker.z = attacker.tz = 1; attacker.anim = { type: 'spike', t0: gameTime - .4 * ANIM_SECONDS, jump: true, planned: true, hold: true };
      match.ai[1].x = match.ai[1].tx = -1.4; match.ai[1].z = match.ai[1].tz = 4.6; match.ai[1].anim = null;
      match.blockExp = { who: 0, x: 2.2, tHit: gameTime + .35, shadowBonus: .15, done: false, buffered: null };
      match.blockZone = { who: 0, x: 2.2, z: -.55 };
      match.ball.stopAt({ x: 2.2, y: 2.55, z: .35 });
    } else if (data.command === 'spike-defense-demo') {
      debugContactFrozen = true; $('message').hidden = true; match.presentation = null; match.phase = 'rally'; match.phaseT = gameTime;
      match.clearPlans();
      const attacker = match.players[0], defender = match.ai[0];
      attacker.x = attacker.tx = -1.2; attacker.z = attacker.tz = -1.1;
      attacker.anim = { type: 'spike', t0: gameTime - .58 * ANIM_SECONDS, jump: true, planned: true, hold: true, aim: 1 };
      match.players[1].x = match.players[1].tx = 1.2; match.players[1].z = match.players[1].tz = -4.5; match.players[1].anim = { type: 'ready', t0: gameTime, hold: true };
      defender.x = defender.tx = 2.65; defender.z = defender.tz = 4.65;
      defender.anim = { type: 'dig', t0: gameTime - .45 * ANIM_SECONDS, planned: true, hold: true, face: { x: 2.9, z: 5.2 } };
      match.ai[1].x = match.ai[1].tx = -.8; match.ai[1].z = match.ai[1].tz = 3.1; match.ai[1].anim = { type: 'underSet', t0: gameTime, planned: true, hold: true };
      match.ball.stopAt({ x: 2.9, y: .58, z: 5.15 });
      match.popup('슬라이딩 디그!', '#ffd54f', defender.x, 2.1, defender.z);
    } else if (data.command === 'attack-timing-demo') {
      debugContactFrozen = true; hideCeremonies(); $('message').hidden = true;
      match.clearPlans(); match.presentation = null; match.phase = 'rally';
      match._timeScale = 1;
      match.debugBallAtServeHand = false;
      const who = data.who === 2 ? 2 : 0, actor = match.actor(who), side = who < 2 ? 1 : -1;
      actor.x = actor.tx = 0; actor.z = actor.tz = -side;
      actor.anim = { type: 'spike', t0: gameTime - .5 * ANIM_SECONDS, jump: true };
      match.lastTouch = null; match.time = gameTime;
      match.ball.stopAt({ x: 0, y: 2.45, z: -side });
      const error = Number(data.timingError) || 0;
      const quality = Math.abs(error) <= match.D.perfect ? 'perfect' : 'good';
      const attack = { aim: .8, timingError: error, quality };
      if (who === 0) match.ourSpike(who, quality, false, attack);
      else {
        match.pendingBlock = { who: 1, digger: 0, x: 0 };
        match.aiSpike(actor, false, attack);
      }
      const ground = match.ball.groundContact();
      $('court').dataset.attackLandingDemo = JSON.stringify({ who, error, ground });
      gameTime = ground.time - .03; match.time = gameTime;
      court.versusCameraReady = [false, false];
      if (data.landed) {
        gameTime = ground.time; match.time = gameTime; match.ballDown(ground);
        $('message').hidden = false; $('message').classList.remove('serve-guide');
        document.body.classList.remove('slow-motion');
      }
    } else if (data.command === 'spike-trajectory-demo') {
      $('gpu-warning').hidden = true; debugContactFrozen = true; $('message').hidden = true; match.presentation = null; match.phase = 'rally'; match.phaseT = gameTime;
      match.clearPlans();
      const attacker = match.players[0], blocker = match.ai[0], defender = match.ai[1];
      attacker.x = attacker.tx = -1.6; attacker.z = attacker.tz = -1;
      attacker.anim = { type: 'spike', t0: gameTime - .5 * ANIM_SECONDS, jump: true, planned: true, hold: true, aim: 1 };
      match.players[1].x = match.players[1].tx = 1.4; match.players[1].z = match.players[1].tz = -4.8; match.players[1].anim = { type: 'ready', t0: gameTime, hold: true };
      blocker.x = blocker.tx = -1.6; blocker.z = blocker.tz = .45; blocker.anim = { type: 'block', t0: gameTime - .35 * ANIM_SECONDS, jump: true, planned: true, hold: true };
      defender.x = defender.tx = 2.4; defender.z = defender.tz = 5.2; defender.anim = { type: 'ready', t0: gameTime, hold: true };
      const from = { x: -1.6, y: 2.45, z: -.85 }, to = { x: 2.8, y: .9, z: 6.2 };
      match.ball.launch(from, to, 1.05, gameTime, 'spike');
      match.ball.stopAt(match.ball.pos(gameTime + 1.05 * Number(data.progress ?? .4)));
      match.popup('즉시 하강 스파이크', '#ffb74d', attacker.x, 3.25, attacker.z);
    } else if (data.command === 'reading-demo') {
      $('gpu-warning').hidden = true; debugContactFrozen = true; $('message').hidden = true; match.presentation = null; match.phase = 'rally'; match.phaseT = gameTime;
      match.clearPlans();
      const attacker = match.players[0], blocker = match.ai[0], defender = match.ai[1];
      attacker.x = attacker.tx = -2.5; attacker.z = attacker.tz = -1;
      attacker.anim = { type: 'spike', t0: gameTime - .3 * ANIM_SECONDS, jump: true, planned: true, hold: true, aim: -1 };
      match.players[1].x = match.players[1].tx = 1.2; match.players[1].z = match.players[1].tz = -4.8; match.players[1].anim = { type: 'ready', t0: gameTime, hold: true };
      blocker.x = blocker.tx = -2.5; blocker.z = blocker.tz = .45; blocker.anim = { type: 'block', t0: gameTime - .2 * ANIM_SECONDS, jump: true, planned: true, hold: true };
      defender.x = defender.tx = 2.7; defender.z = defender.tz = 5.2;
      defender.anim = { type: 'ready', t0: gameTime, hold: true, face: { x: attacker.x, z: attacker.z } };
      defender.readingReady = true;
      match.defenseRead = { attackingTeam: 'me', who: 3, defenderIndex: 1, predicted: { x: 2.7, z: 5.2 }, start: { x: 1.4, z: 5.8 }, ratio: .55, attackAt: gameTime + .2, ready: true };
      match.ball.stopAt({ x: attacker.x, y: 2.45, z: -.85 });
      match.popup('리딩 준비!', '#4fc3f7', defender.x, 3.0, defender.z);
    } else if (data.command === 'block-demo') {
      debugContactFrozen = false; $('message').hidden = true; match.presentation = null; match.phase = 'rally'; match.phaseT = gameTime;
      match.clearPlans();
      const blocker = match.players[0], attacker = match.ai[0];
      blocker.x = blocker.tx = 0; blocker.z = blocker.tz = -.45;
      blocker.anim = { type: 'block', t0: gameTime - .5 * ANIM_SECONDS, jump: true, planned: true };
      match.players[1].x = match.players[1].tx = 1.8; match.players[1].z = match.players[1].tz = -4.2; match.players[1].anim = null;
      attacker.x = attacker.tx = 0; attacker.z = attacker.tz = 1; attacker.anim = { type: 'spike', t0: gameTime - .5 * ANIM_SECONDS, jump: true };
      match.ai[1].x = match.ai[1].tx = -1.8; match.ai[1].z = match.ai[1].tz = 4.4; match.ai[1].anim = null;
      match.blockExp = { who: 0, x: 0, tHit: gameTime, done: false, buffered: null };
      match.blockZone = { who: 0, x: 0, z: -.55 };
      match.ball.stopAt({ x: 0, y: 2.4, z: .25 });
      match.resolveBlock({ playerIndex: 0, t: gameTime, type: 'block', jump: true }, data.outcome ?? 'stuff');
    } else if (data.command === 'sand-demo') {
      debugContactFrozen = true; $('message').hidden = true; match.presentation = null; match.phase = 'rally'; match.phaseT = gameTime;
      const actor = match.players[0]; actor.x = actor.tx = -.3; actor.z = actor.tz = -3.2;
      actor.anim = { type: 'dig', t0: gameTime - .35 * ANIM_SECONDS, planned: false };
      for (let i = 0; i < 7; i++) court.sand?.addMark(.3, -3.2, 'dive');
      for (let i = 0; i < 4; i++) court.sand?.addMark(-.6, -2.7, 'land');
      for (let i = 0; i < 7; i++) court.sand?.addMark(-1.1 + i * .35, -4 + i * .25, 'step');
    } else if (data.command === 'resume') {
      debugContactFrozen = false;
    } else if (data.command === 'slow-demo') {
      debugContactFrozen = true; hideCeremonies(); $('message').hidden = true;
      match.presentation = null; match.phase = 'rally'; match.phaseT = gameTime; match.clearPlans(); match._timeScale = .5;
      const actor = match.players[0]; actor.x = actor.tx = -.7; actor.z = actor.tz = -1.5;
      actor.anim = { type: 'spike', t0: gameTime - .5 * ANIM_SECONDS, jump: true, planned: true, hold: true };
      match.exp = { action: 'spike', accepts: ['spike'], who: 0, tHit: gameTime, t0: gameTime - 1.1, done: false };
      match.ball.stopAt({ x: actor.x, y: 2.65, z: actor.z + .15 }); document.body.classList.add('slow-motion');
    } else if (data.command === 'slow-motion-probe') {
      slowMotionProbe();
    } else if (data.command === 'auto-move-probe') {
      awaitAutoMoveProbe();
    } else if (data.command === 'contact-probe') {
      debugContactFrozen = false; match.presentation = null; $('message').hidden = false;
      import('/tools/contact-probe.js').then(module => module.runContactProbe({ seconds: Number(data.seconds ?? 60) }))
        .then(result => { $('court').dataset.contactProbe = JSON.stringify(result); })
        .catch(error => { $('court').dataset.contactProbe = JSON.stringify({ error: error.message }); });
    }
    $('court').dataset.debugState = JSON.stringify({ phase: match.phase, score: match.score, log: match.celebrationLog,
      anims: [...match.players, ...match.ai].map(p => p.anim && ({ type: p.anim.type, style: p.anim.style, aim: p.anim.aim, t0: p.anim.t0,
        jump: p.anim.jump, awaitingInput: !!p.anim.awaitingInput })),
      quality: court.quality, calls: court.renderer.info.render.calls, crowd: !!court.crowdView });
  });
  new MutationObserver(() => {
    const raw = $('court').dataset.debugCommand;
    if (!raw) return;
    delete $('court').dataset.debugCommand;
    try { dispatchEvent(new CustomEvent('volleyball-debug', { detail: JSON.parse(raw) })); }
    catch (error) { $('court').dataset.debugState = JSON.stringify({ error: error.message }); }
  }).observe($('court'), { attributes: true, attributeFilter: ['data-debug-command'] });
  const debugBridge = document.createElement('input');
  debugBridge.id = 'debug-bridge'; debugBridge.setAttribute('aria-label', 'debug bridge');
  debugBridge.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.01;z-index:-1';
  debugBridge.addEventListener('input', () => {
    try { dispatchEvent(new CustomEvent('volleyball-debug', { detail: JSON.parse(debugBridge.value) })); }
    catch (error) { $('court').dataset.debugState = JSON.stringify({ error: error.message }); }
  });
  document.body.appendChild(debugBridge);
}

// ── 시작 메뉴
const difficultyLabels = { easy: '쉬움', normal: '보통', hard: '어려움' };
function showMenu(id, backwards = false) {
  handCursor.hide();
  for (const screenId of MENU_SCREEN_IDS) {
    const screen = $(screenId);
    screen.hidden = screenId !== id;
    screen.classList.remove('menu-enter', 'menu-enter-back');
  }
  const next = $(id);
  next.classList.add(backwards ? 'menu-enter-back' : 'menu-enter');
  setTimeout(() => next.classList.remove('menu-enter', 'menu-enter-back'), 560);
}

function refreshReplayButtons() {
  document.querySelectorAll('[data-replay]').forEach(btn => btn.classList.toggle('on', (btn.dataset.replay === 'on') === options.replay));
}
document.querySelectorAll('[data-replay]').forEach(btn => btn.addEventListener('click', () => {
  options.replay = btn.dataset.replay === 'on'; saveMenuSettings(); refreshReplayButtons();
}));
refreshReplayButtons();

function refreshVsSplitButtons() {
  document.querySelectorAll('[data-vs-split]').forEach(btn => btn.classList.toggle('on', (btn.dataset.vsSplit === 'split') === options.vsSplit));
}
document.querySelectorAll('[data-vs-split]').forEach(btn => btn.addEventListener('click', () => {
  options.vsSplit = btn.dataset.vsSplit === 'split'; saveMenuSettings(); refreshVsSplitButtons(); court.setVersusSplit(options.vsSplit);
}));
refreshVsSplitButtons();

function refreshHighlightButtons() {
  document.querySelectorAll('[data-highlight]').forEach(btn => btn.classList.toggle('on', (btn.dataset.highlight === 'on') === highlightOn));
}
document.querySelectorAll('[data-highlight]').forEach(btn => btn.addEventListener('click', () => {
  highlightOn = btn.dataset.highlight === 'on'; saveHighlightSetting(highlightOn); refreshHighlightButtons();
}));
refreshHighlightButtons();
try { $('tutorial-done').textContent = localStorage.getItem('volleyball.tutorialComplete') === 'yes' ? ' ✅' : ''; } catch { /* 표시만 생략 */ }

function teamLineups() {
  const [first, second] = selectedCharacters;
  const remaining = rosterNames.filter(name => name !== first && name !== second);
  return cameraMode === 'versus'
    ? [[first, remaining[0]], [second, remaining[1]]]
    : [[first, second], remaining];
}

function teamCardHtml() {
  const [ours, theirs] = teamLineups();
  const side = (names, cls) => `<div class="team-side">${names.map(value => {
    const player = ROSTER[value];
    return `<div class="team-player ${cls}"><img src="assets/ui/menu/char-${value}.webp" alt="${player.name}"><span>${player.name}<small>${player.number}번 · ${player.height.toFixed(2)}m · ${player.type}</small></span></div>`;
  }).join('')}</div>`;
  return `${side(ours, 'me')}<div class="team-vs">VS</div>${side(theirs, 'ai')}<div class="team-meta">${options.target}점 먼저 · ${difficultyLabels[options.difficulty]}</div>`;
}

function resultCardHtml(data) {
  const card = teamCardHtml().replace('<div class="team-vs">VS</div>', `<div class="team-vs score">${data.score.me} : ${data.score.ai}</div>`).replace(/<div class="team-meta">.*?<\/div>/, '');
  return `<b>오늘의 결과</b><div class="result-teams">${card}</div>`;
}

function hideCeremonies() {
  for (const id of ['team-intro', 'victory-show', 'tutorial-complete']) $(id).hidden = true;
  clearTimeout(ceremonyTimer); clearTimeout(victoryGestureTimer); ceremonyTimer = null; victoryGestureTimer = null; ceremonyFinish = null;
  if (match) match.presentation = null;
}

function startIntro(short = false) {
  const duration = short ? 1000 : 3000;
  $('team-card').innerHTML = teamCardHtml(); $('team-intro').hidden = false;
  match.presentation = { type: 'intro', startedAt: performance.now(), walkDuration: short ? 0 : 2 };
  ceremonyFinish = finishIntro;
  ceremonyTimer = setTimeout(finishIntro, duration);
}

function finishIntro() {
  if (!$('team-intro').hidden) $('team-intro').hidden = true;
  clearTimeout(ceremonyTimer); ceremonyTimer = null; ceremonyFinish = null;
  if (match) match.presentation = null;
  sayWhenLoaded('match_start', {}, voiceSession);
}

function skipPresentation() {
  if (!ceremonyFinish) return false;
  const finish = ceremonyFinish; ceremonyFinish = null; clearTimeout(ceremonyTimer); finish(); return true;
}

$('team-intro').addEventListener('pointerdown', skipPresentation);

function renderPractice() {
  $('tutorial-hud').hidden = false;
  $('tutorial-prompt').textContent = PRACTICE_STEPS[practiceStep]?.text ?? '';
  $('tutorial-cards').innerHTML = PRACTICE_STEPS.map((step, i) => `<div class="tutorial-card ${i < practiceStep ? 'done' : i === practiceStep ? 'active' : ''}">${i < practiceStep ? '✅' : step.icon}<br>${'①②③④'[i]} ${step.label}</div>`).join('');
}

function advancePractice(data) {
  const step = PRACTICE_STEPS[practiceStep];
  if (!practice || practiceComplete || !step || data.team !== 'me' || data.action !== step.action || !match?.actor(data.playerIndex)?.human) return;
  practiceStep++;
  if (match) match.practiceStage = practiceStep;
  if (practiceStep < PRACTICE_STEPS.length) {
    renderPractice(); say(PRACTICE_STEPS[practiceStep].voice, { priority: 3 });
    return;
  }
  practiceComplete = true; $('tutorial-hud').hidden = true; $('tutorial-complete').hidden = false;
  try { localStorage.setItem('volleyball.tutorialComplete', 'yes'); } catch { /* 다음 표시만 생략 */ }
  $('tutorial-done').textContent = ' ✅'; say('help_ready', { priority: 3 });
}

function refreshHandButtons() {
  for (const group of document.querySelectorAll('.hand-choice')) {
    const player = Number(group.dataset.player);
    group.querySelectorAll('[data-hand]').forEach(btn => btn.classList.toggle('on', btn.dataset.hand === handedness[player]));
  }
}
for (const group of document.querySelectorAll('.hand-choice')) {
  const player = Number(group.dataset.player);
  group.querySelectorAll('[data-hand]').forEach(btn => btn.addEventListener('click', () => {
    handedness[player] = btn.dataset.hand === 'left' ? 'left' : 'right';
    saveHandedness(); refreshHandButtons(); court.setPlayerHandedness(handedness);
  }));
}
refreshHandButtons();
court.setPlayerHandedness(handedness);

// 웹캠 토스한 손을 보고 캐릭터 손잡이를 맞춘다. hand는 사람 기준('r' = 오른손으로 토스 → 왼손으로 침)
function matchServeHand(player, tossHand) {
  if (tossHand !== 'l' && tossHand !== 'r') return;
  const want = tossHand === 'r' ? 'left' : 'right';
  const slot = player === 2 ? 1 : player;
  if (handSelectionLocked[slot]) return;
  if (handedness[slot] === want) return;
  handedness[slot] = want;
  saveHandedness(); refreshHandButtons(); court.setPlayerHandedness(handedness);
  // 이번 토스부터 새 손 기준: 몸을 중심으로 공 드는 손·치는 손 위치를 좌우로 뒤집는다(다음 프레임에 실제 뼈 위치로 다시 맞춰짐)
  const p = match.actor(player);
  for (const anchor of [match.serveAnchor, match.serveHitAnchor]) if (anchor && p) anchor.x = 2 * p.x - anchor.x;
  if (p) match.popup(want === 'left' ? '왼손잡이로 바꿨어요' : '오른손잡이로 바꿨어요', '#ffd54f', p.x, 3.8, p.z);
}

function chooseRaisedHand(slot, hand) {
  if ((hand !== 'left' && hand !== 'right') || slot < 0 || slot > 1) return;
  handedness[slot] = hand;
  handSelectionLocked[slot] = true;
  saveHandedness(); refreshHandButtons(); court.setPlayerHandedness(handedness);
  const actorIndex = match?.competitive && slot === 1 ? 2 : slot;
  const player = match?.actor(actorIndex);
  const message = hand === 'left' ? '왼손잡이 선수!' : '오른손잡이 선수!';
  if (player) match.popup(message, '#fff176', player.x, 3.8, player.z);
  clearTimeout(handConfirmTimer); $('hand-confirm').textContent = message; $('hand-confirm').hidden = false;
  handConfirmTimer = setTimeout(() => { $('hand-confirm').hidden = true; }, 1800);
  say(hand === 'left' ? 'hand_left' : 'hand_right', { priority: 2 });
}

function updateControlText() {
  $('keys-help').textContent = mode === 'webcam'
    ? (activeCameraMode === 'solo' ? '가운데 서세요 · 캐릭터는 자동 이동 · 팔로 수비하고 공격해요' : '나란히 서세요 · 캐릭터는 자동 이동 · 팔로 수비하고 공격해요')
    : '캐릭터 자동 이동 · 타이밍에 맞춰 수비·공격 키를 누르세요';
}

// 브라우저 자동 재생 정책상 첫 사용자 입력 뒤에 시작 화면 음악을 켠다.
$('start-screen').addEventListener('pointerdown', () => { initSound(); startMusic(); });
async function ensureCamera() {
  if (readPoses) return;
  if (cameraBoot) return cameraBoot;
  cameraBoot = (async () => {
    try {
      await startCamera(video);
      readPoses = makePoseReader(await createPose(poseConfig.model, poseConfig.delegate), video);
      tracker = new DuoTracker();
      pip = new Renderer($('pip'), video);
      startHandEnabled = true;
    } catch (error) {
      video.srcObject?.getTracks().forEach(track => track.stop()); video.srcObject = null;
      throw error;
    }
  })();
  try { await cameraBoot; } finally { cameraBoot = null; }
}

async function withCamera(next) {
  const request = ++startRequest;
  const info = $('start-info');
  $('play-game').disabled = true; $('start-tutorial').disabled = true;
  initSound();
  try {
    if (!readPoses) {
      info.textContent = '카메라 준비 중…';
      await ensureCamera();
    }
  } catch (e) {
    console.error(e);
    info.textContent = e.name === 'NotAllowedError'
      ? '카메라 권한이 거부되었어요. 주소창 옆 카메라 아이콘에서 허용해 주세요.'
      : '웹캠을 시작하지 못했어요: ' + e.message;
    $('play-game').disabled = false; $('start-tutorial').disabled = false;
    return;
  }
  $('play-game').disabled = false; $('start-tutorial').disabled = false;
  info.textContent = '손을 들어 버튼을 골라요';
  if (request === startRequest && !match && !$('start-screen').hidden) next();
}

function refreshCharacterCards() {
  $('character-title').textContent = `${characterPick + 1}P 선수를 골라요`;
  document.querySelectorAll('[data-character]').forEach(btn => {
    const value = btn.dataset.character;
    const player = ROSTER[value];
    let info = btn.querySelector('.character-stats');
    if (!info) {
      info = document.createElement('span'); info.className = 'character-stats'; btn.append(info);
    }
    info.innerHTML = `<strong>${player.type} · ${player.height.toFixed(2)}m</strong>${Object.entries(player.stats).map(([key, rating]) =>
      `<span><em>${STAT_LABELS[key]}</em><i class="stars" style="--rating:${rating}" aria-label="${rating}점">★★★★★</i><small>${rating.toFixed(1)}</small></span>`).join('')}`;
    btn.disabled = characterPick === 1 && value === selectedCharacters[0];
    btn.classList.toggle('remembered', characterPick === 0 && value === selectedCharacters[0]);
    btn.classList.toggle('picked', value === selectedCharacters[0] && characterPick === 1);
  });
}

$('play-game').addEventListener('click', () => params.has('debug') ? showMenu('mode-screen') : withCamera(() => showMenu('mode-screen')));
$('start-tutorial').addEventListener('click', () => withCamera(() => {
  cameraMode = 'solo'; begin('webcam', { tutorial: true });
}));
$('open-teacher-settings').addEventListener('click', () => showMenu('teacher-settings'));
$('close-teacher-settings').addEventListener('click', () => showMenu('start-screen', true));
$('listen-help').addEventListener('click', () => {
  initSound(); startMusic(); sayWhenLoaded('help_how_to_play', { priority: 2 });
  $('start-info').textContent = '스파이크는 한 손으로! 손목을 돌린 쪽으로 공이 가고, 휘두르지 않고 손만 대면 팁이 됩니다.';
});

for (const btn of document.querySelectorAll('[data-camera-mode]')) btn.addEventListener('click', () => {
  cameraMode = btn.dataset.cameraMode;
  characterPick = 0; refreshCharacterCards(); showMenu('character-screen');
});
for (const btn of document.querySelectorAll('[data-character]')) btn.addEventListener('click', () => {
  const value = btn.dataset.character;
  if (characterPick === 1 && value === selectedCharacters[0]) return;
  selectedCharacters[characterPick] = value;
  if (cameraMode === 'solo') {
    selectedCharacters[1] = rosterNames.find(name => name !== value);
    saveCharacterChoices(); $('ready-team-card').innerHTML = teamCardHtml(); showMenu('ready-screen');
  } else if (characterPick === 0) {
    characterPick = 1; refreshCharacterCards();
  } else {
    saveCharacterChoices(); $('ready-team-card').innerHTML = teamCardHtml(); showMenu('ready-screen');
  }
});

for (const btn of document.querySelectorAll('[data-back]')) btn.addEventListener('click', () => {
  if (btn.dataset.back === 'character-screen') { characterPick = 0; refreshCharacterCards(); }
  showMenu(btn.dataset.back, true);
});

$('difficulty-chip').addEventListener('click', () => {
  const values = ['easy', 'normal', 'hard'];
  options.difficulty = values[(values.indexOf(options.difficulty) + 1) % values.length];
  $('difficulty-chip').textContent = difficultyLabels[options.difficulty]; saveMenuSettings();
  $('ready-team-card').innerHTML = teamCardHtml();
});
$('target-chip').addEventListener('click', () => {
  const values = [7, 11, 15];
  options.target = values[(values.indexOf(options.target) + 1) % values.length];
  $('target-chip').textContent = `${options.target}점`; saveMenuSettings();
  $('ready-team-card').innerHTML = teamCardHtml();
});
$('start-match').addEventListener('click', () => begin(params.has('debug') ? (cameraMode === 'solo' ? 'keyboard' : 'keyboard-duo') : 'webcam'));

if (params.has('debug')) {
  $('debug-keyboard').hidden = false;
  $('debug-keyboard').addEventListener('click', () => {
    const debugVersus = params.get('versus') === '1'; cameraMode = debugVersus ? 'versus' : 'solo'; begin(debugVersus ? 'keyboard-duo' : 'keyboard');
  });
  const shot = params.get('shot');
  if (shot === 'hand-stage' || shot === 'hand-choice') setTimeout(() => {
    cameraMode = 'solo'; begin('keyboard');
    dispatchEvent(new CustomEvent('volleyball-debug', { detail: shot === 'hand-stage'
      ? { command: 'hand-stage', hand: 'left', progress: .58 }
      : { command: 'hand-choice', hand: 'left', slot: 0 } }));
  }, 120);
}
$('difficulty-chip').textContent = difficultyLabels[options.difficulty];
$('target-chip').textContent = `${options.target}점`;
refreshCharacterCards();
if (params.get('from') === 'intro') requestAnimationFrame(() => $('play-game').focus());
if (params.has('debug') && ['serve', 'rally', 'slow', 'trajectory', 'reading'].includes(params.get('capture'))) {
  requestAnimationFrame(async () => {
    cameraMode = 'versus'; begin('keyboard-duo', { shortIntro: true });
    await court.ready;
    const readiness = court.getModelReadiness();
    document.body.dataset.captureModelReadiness = JSON.stringify(readiness);
    if (!readiness.ready) {
      console.error('확인 사진 중단: 고품질 캐릭터 4개가 모두 준비되지 않았습니다.', readiness);
      return;
    }
    setTimeout(() => {
      if (!match) return;
      match.presentation = null; hideCeremonies();
      const command = { serve: 'serve-demo', rally: 'spike-defense-demo', slow: 'slow-demo', trajectory: 'spike-trajectory-demo', reading: 'reading-demo' }[params.get('capture')];
      dispatchEvent(new CustomEvent('volleyball-debug', { detail: { command } }));
      // 자동 캡처는 선수를 장면 위치로 즉시 옮기므로, 이전 위치를 향하던 카메라도 함께 다시 맞춘다.
      court.versusCameraReady = [false, false];
      court.debugVsFrames = null;
    }, 300);
  });
}

$('again').addEventListener('click', () => begin(mode, { shortIntro: true }));
$('home').addEventListener('click', goHome);
$('tutorial-play').addEventListener('click', () => begin(mode === 'webcam' ? 'webcam' : 'keyboard', { shortIntro: true }));
$('tutorial-home').addEventListener('click', goHome);
$('resume').addEventListener('click', () => setPaused(false));
$('pause-home').addEventListener('click', goHome);

function setPaused(value) {
  paused = value;
  keysDown.clear(); handCursor.hide();
  $('pause').hidden = !paused;
  setVolume('amb', paused ? 0.15 : 0.55);
}

function begin(m, { shortIntro = false, tutorial = false } = {}) {
  ++startRequest;
  reel.clear(); hideCeremonies();
  initSound();
  const audioToken = ++voiceSession;
  stopMusic(); startAmbience();
  setVolume('amb', 0.55);
  mode = m;
  activeCameraMode = cameraMode;
  keysDown.clear(); handCursor.hide();
  playerX = [-1.35, 1.35];
  gameTime = 0;
  debugContactFrozen = false; $('debug-contact-frozen')?.remove();
  clearTimeout(handConfirmTimer); $('hand-confirm').hidden = true;
  lastFrameT = performance.now();
  paused = false;
  activePromptKeys = new Set(); arrowCueKey = ''; consecutivePerfect = 0;
  lastStats = { perfect: 0, good: 0, miss: 0 };
  voiceCueAfter = performance.now() + 2200; pendingMatchPoint = false;
  lastServeGuide = ''; serveReminderAt = 0;
  handSelectionLocked = [false, false]; handStageAnnounced = [false, false];
  practice = tutorial; practiceStep = 0; practiceComplete = false;
  if (m === 'webcam') {
    tracker = new DuoTracker(activeCameraMode === 'solo' ? 1 : 2, { askHand: true, heldRepeat: true });
    lastWebcamStatus = null; lastReadyCount = 0; camReady = false;
    lastCamResult = { readyCount: 0 }; trackingTime = 0; lastTrackingT = 0;
  }
  const competitive = activeCameraMode === 'versus';
  const matchOptions = practice ? { ...options, difficulty: 'easy', target: 99, replay: false } : options;
  match = new Match({ ...matchOptions, autoMove: true, onEvent, competitive: practice ? false : competitive, humanCount: !competitive && (m === 'keyboard-duo' || (m === 'webcam' && activeCameraMode === 'coop')) ? 2 : 1 });
  match.setCharacterChoices(selectedCharacters);
  if (practice) {
    match.D = { ...match.D, speed: match.D.speed * .6, aiSpikeT: match.D.aiSpikeT / .6 };
    match.practiceMode = true; match.practiceStage = 0;
  }
  if (params.has('debug') && /^\d+-\d+$/.test(params.get('score') ?? '')) {
    const [me, ai] = params.get('score').split('-').map(Number); match.score = { me, ai };
  }
  court.setCompetitive(match.competitive);
  court.setVersusSplit(options.vsSplit);
  court.setPlayerHandedness(handedness);
  court.setCharacterChoices(selectedCharacters);
  const profiles = m === 'keyboard-duo' ? [bindings.p1, bindings.p2] : [bindings.solo, bindings.solo];
  const promptLabels = m === 'webcam' ? [{}, {}] : profiles.map(profile => ({
    bump: keyName(profile.bump), set: keyName(profile.set), spike: keyName(profile.hit), serveToss: keyName(profile.set), serveHit: keyName(profile.hit), block: keyName(profile.block),
  }));
  court.setPromptKeyLabels(competitive ? [promptLabels[0], {}, promptLabels[1], {}] : promptLabels);
  $('score-me').textContent = match.score.me;
  $('score-ai').textContent = match.score.ai;
  $('score-me-box').querySelector('span').textContent = competitive ? '1P 팀' : '우리 팀';
  $('score-ai-box').querySelector('span').textContent = competitive ? '2P 팀' : '상대 팀';
  $('goal').textContent = practice ? '연습' : `${options.target}점 먼저 · ${{ easy: '쉬움', normal: '보통', hard: '어려움' }[options.difficulty]}`;
  for (const id of MENU_SCREEN_IDS) $(id).hidden = true;
  $('over-screen').hidden = true;
  $('over-reel').replaceChildren();
  $('pause').hidden = true;
  $('cam-overlay').style.display = 'none';
  document.activeElement?.blur();
  $('pip-wrap').style.display = m === 'webcam' ? 'block' : 'none';
  document.body.classList.toggle('practice-mode', practice);
  updateControlText();
  if (!params.has('debug')) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!practice && m === 'webcam' && highlightOn) reel.start();
  if (practice) { renderPractice(); say(PRACTICE_STEPS[0].voice, { priority: 3 }); }
  else { $('tutorial-hud').hidden = true; startIntro(shortIntro); }
  if (!running) { running = true; requestAnimationFrame(loop); }
}

function goHome() {
  document.querySelectorAll('.action-cue').forEach(cue => { cue.hidden = true; });
  ++startRequest;
  reel.clear(); hideCeremonies(); practice = false; practiceComplete = false; $('tutorial-hud').hidden = true;
  document.body.classList.remove('practice-mode');
  if (gameRecorder.active) toggleGameRecording();
  match = null;
  paused = false; keysDown.clear(); handCursor.hide();
  $('pause').hidden = true; $('pip-wrap').style.display = 'none';
  document.body.classList.remove('slow-motion');
  $('message').classList.remove('serve-guide');
  $('message').classList.remove('point-focus');
  $('msg-text').textContent = ''; $('msg-sub').textContent = ''; lastServeGuide = '';
  voiceSession++;
  stopAmbience(); startMusic();
  $('over-screen').hidden = true;
  showMenu('start-screen', true);
  $('start-info').textContent = readPoses ? '손을 들어 버튼을 골라요' : '경기하기를 누르면 카메라가 켜져요';
  $('cam-overlay').style.display = 'none';
}

function showResults(data) {
  hideCeremonies();
  const win = data.winner === 'me';
  $('over-title').textContent = match?.competitive ? `🏆 ${win ? '1P' : '2P'} 팀 승리!` : win ? '🏆 우리 팀 승리!' : '아쉬워요! 다시 도전!';
  $('result-card').innerHTML = resultCardHtml(data);
  const s = data.stats;
  $('over-stats').innerHTML = `PERFECT ${s.perfect} · GOOD ${s.good} · 놓침 ${s.miss}<br>스파이크 ${s.spikes} · 팁 ${s.tips ?? 0} · 블로킹 ${s.blocks} · 스터프 ${s.stuffBlocks ?? 0} · 디그 ${s.digs ?? 0}`;
  $('over-screen').hidden = false;
  if (mode === 'webcam' && highlightOn) reel.showMontage($('over-reel'));
}

function startVictory(data) {
  const win = data.winner === 'me';
  match.presentation = { type: 'victory', winner: data.winner, startedAt: performance.now() };
  match.setVictoryGestures(data.winner, 0);
  victoryGestureTimer = setTimeout(() => match?.presentation?.type === 'victory' && match.setVictoryGestures(data.winner, 1), 1500);
  $('victory-title').textContent = match.competitive || win ? '🏆 우승!' : '아쉬워요!';
  $('victory-show').classList.toggle('lose', !match.competitive && !win);
  $('victory-show').hidden = false;
  if (match.competitive || win) court.triggerCelebration();
  if (mode === 'webcam' && highlightOn) reel.mark(match.competitive || win ? '우승!' : '끝까지 최선!', { priority: match.competitive || win ? 3 : 2, before: 0, after: 1.2 });
  ceremonyFinish = () => showResults(data);
  ceremonyTimer = setTimeout(ceremonyFinish, 3000);
}

// ── 경기에서 오는 알림
function onEvent(type, data) {
  if (type === 'sound') {
    sfx[data]?.();
    if (data === 'block') court.triggerEffect('block');
    if (data === 'block') court.reactCrowd('dig');
    if (data === 'spike') court.reactCrowd('spike');
    if (pendingMatchPoint && (data === 'point' || data === 'lose')) {
      say('match_point', { priority: 2, delay: 1.2 });
      pendingMatchPoint = false;
    }
  }
  else if (type === 'score') {
    if (practice) {
      match.score.me = 0; match.score.ai = 0; $('score-me').textContent = '0'; $('score-ai').textContent = '0';
    } else { $('score-me').textContent = data.me; $('score-ai').textContent = data.ai; }
    const wasMatchPoint = pendingMatchPoint;
    pendingMatchPoint = Math.max(data.me, data.ai) >= options.target - 1 && Math.abs(data.me - data.ai) >= 1;
    if (pendingMatchPoint && !wasMatchPoint) court.reactCrowd('matchPoint');
  } else if (type === 'message') {
    placeMessageFor(data?.playerIndex ?? data?.who ?? match?.exp?.who ?? null);
    const hiddenPracticePoint = practice && match?.phase === 'point';
    $('msg-text').textContent = hiddenPracticePoint ? '' : (data?.text ?? '');
    $('msg-sub').textContent = hiddenPracticePoint ? '' : (data?.sub ?? '');
    const el = $('message');
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  } else if (type === 'over') {
    const win = data.winner === 'me';
    if (win) sfx.win();
    else say('defeat', { priority: 2 });
    court.reactCrowd('win', { team: data.winner }); startVictory(data);
  } else if (type === 'practice-action') {
    advancePractice(data);
  } else if (type === 'player-action') {
    if (mode === 'webcam' && highlightOn && (data.team === 'me' || match?.competitive) && match?.actor(data.playerIndex)?.human) {
      if (data.action === 'bump' && data.quality === 'perfect') reel.mark('나이스 리시브!', { priority: 1, before: .5, after: .3 });
      if (data.action === 'spike') reel.mark('스파이크!', { priority: 2, before: .5, after: .3 });
      if (data.action === 'block') reel.mark('블로킹!', { priority: 3, before: .5, after: .4 });
    }
  } else if (type === 'point-scored') {
    court.reactCrowd('point', { team: data.team });
    if (practice && practiceStep > 0) match.lastPoint = 'ai';
    if (!practice && mode === 'webcam' && highlightOn && (data.team === 'me' || match?.competitive)) reel.mark('득점!', { priority: 1, before: 1, after: .2 });
  } else if (type === 'strong-spike') {
    court.triggerEffect('spike');
    if (data.power >= 2) say('spike');
  } else if (type === 'block-result') {
    if (data.outcome === 'stuff') { court.triggerEffect('spike'); court.reactCrowd('spike', { team: data.team }); }
  } else if (type === 'serve-timing') {
    if (options.difficulty === 'easy' && data.team === 'me') say('do_serve_hit', { priority: 3 });
  } else if (type === 'serve-float') {
    say('serve_float');
    if (mode === 'webcam' && highlightOn && match?.actor(data.playerIndex)?.human) reel.mark('플로터 서브', { priority: 1, before: .6, after: .3 });
  } else if (type === 'serve-spike') {
    say('serve_spike');
    if (mode === 'webcam' && highlightOn && match?.actor(data.playerIndex)?.human) reel.mark('스파이크 서브!', { priority: 2, before: .6, after: .3 });
  } else if (type === 'serve-power') {
    say('serve_power', { priority: 2 }); court.triggerEffect('serve-power');
  } else if (type === 'serve-retry') {
    if (data.team === 'me') say('serve_retry', { priority: 2 });
  } else if (type === 'serve-fault') {
    if (data.team === 'me') say('serve_fault', { priority: 2 });
  } else if (type === 'serve-toss-start') {
    court.reactCrowd('serve', { team: data.team });
  } else if (type === 'dig-success') {
    court.reactCrowd('dig', { team: data.team });
  }
}

// ── 키보드
const KEY_GESTURE = Object.fromEntries(ORDER.map(type => ['Digit' + GESTURES[type].key, type]));
const P2_FALLBACK = { KeyJ: 'bump', KeyK: 'set', KeyL: 'hit', KeyI: 'block', ArrowDown: 'jump' };
function controlAction(profileName, code) {
  return actionForCode(bindings[profileName], code)
    ?? (profileName === 'p2' && !actionForCode(bindings.p1, code) ? P2_FALLBACK[code] : null);
}
function moveAction(profileName, code) {
  const assigned = controlAction(profileName, code);
  if (assigned === 'left' || assigned === 'right') return assigned;
  if (profileName === 'solo' && !assigned) {
    if (code === 'KeyA') return 'left';
    if (code === 'KeyD') return 'right';
  }
  return null;
}
function gestureForAction(action, playerIndex) {
  if (action === 'hit') return match.phase === 'serve-me' && match.serverIndex === playerIndex ? 'serve' : 'spike';
  return action;
}
function keyboardAttackAim() { return keysDown.has('ArrowLeft') ? -1 : (keysDown.has('ArrowRight') ? 1 : 0); }
function splitPlayActive() { return shouldSplitVersusView(match, options.vsSplit, false); }
function actorInputSign(actorIndex) { return versusInputSign(actorIndex, splitPlayActive()); }
function eventForActor(event, actorIndex) {
  return event && Number.isFinite(event.aim) ? { ...event, aim: event.aim * actorInputSign(actorIndex) } : event;
}
function placeMessageFor(actorIndex = null) {
  const message = $('message');
  if (!splitPlayActive() || actorIndex == null) delete message.dataset.side;
  else message.dataset.side = actorIndex >= 2 ? 'p2' : 'p1';
}
function handleKeyboardAction(profileName, playerIndex, code) {
  let action = controlAction(profileName, code);
  if (!action && mode === 'keyboard') action = KEY_GESTURE[code];
  if (!action || action === 'left' || action === 'right') return false;
  if (['serve-me', 'serve-ai'].includes(match.phase) && playerIndex === match.servingActorIndex) {
    if (action === 'set') match.onServeToss({ playerIndex, source: 'keyboard' });
    return ['set', 'hit', 'spike', 'serve', 'jump'].includes(action);
  }
  if (match.phase === 'serve-toss' && playerIndex === match.servingActorIndex) {
    if (action === 'jump') match.onGesture('jump', {}, playerIndex);
    else if (['hit', 'spike', 'serve'].includes(action)) match.onServeHit({ playerIndex, source: 'keyboard' });
    return ['jump', 'hit', 'spike', 'serve', 'set'].includes(action);
  }
  const type = gestureForAction(action, playerIndex);
  if (type !== 'jump') {
    const accepted = (type === 'block' && match.blockExp?.who === playerIndex && !match.blockExp.done)
      || (type === 'block' && practice && practiceStep === 3)
      || (['spike', 'serve'].includes(type) && practice && practiceStep === 2)
      || (type === 'tip' && match.exp?.action === 'spike' && match.exp?.who === playerIndex && !match.exp.done)
      || (match.exp?.who === playerIndex && !match.exp.done && match.exp.accepts.includes(type));
    if (!accepted) return false;
  }
  match.onGesture(type, { aim: keyboardAttackAim() * actorInputSign(playerIndex), kind: type === 'tip' ? 'tip' : undefined }, playerIndex);
  return true;
}
addEventListener('keydown', e => {
  keysDown.add(e.code);
  if (e.repeat) return;
  if (ceremonyFinish && (e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); skipPresentation(); return; }
  if (match?.phase === 'point' && !paused) match.skipReplay();
  if (e.code === 'F2') { e.preventDefault(); perfEl.hidden = !perfEl.hidden; return; }
  if (e.code === 'F3') { e.preventDefault(); court.raiseQuality(); return; }
  if (e.code === 'F4') { e.preventDefault(); court.previewNextAnimation(); return; }
  if (e.code === 'F8') { e.preventDefault(); toggleGameRecording(); return; }
  if (params.has('debug') && mode === 'webcam' && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    const slot = tracker?.trackers.findIndex(item => item.state === 'hand') ?? -1;
    if (slot >= 0) {
      const hand = e.code === 'BracketLeft' ? 'left' : 'right';
      chooseRaisedHand(slot, hand);
      tracker.trackers[slot].state = 'ready'; tracker.trackers[slot].handPick = null;
      e.preventDefault(); return;
    }
  }
  if (!$('over-screen').hidden) {
    if (e.code === 'Enter') begin(mode);
    else if (e.code === 'Escape') goHome();
    return;
  }
  if (!match) return;
  if (params.has('debug') && e.code === 'KeyH') {
    court.reactCrowd('hype'); sfx.point?.(); say('crowd_cheer'); e.preventDefault(); return;
  }
  if (params.has('debug') && e.code === 'KeyT' && match.exp?.action === 'spike') {
    match.onGesture('tip', { aim: keyboardAttackAim() * actorInputSign(match.exp.who), kind: 'tip' }, match.exp.who); e.preventDefault(); return;
  }
  if (e.code === 'Escape') { goHome(); return; }
  if (e.code === 'KeyP') {
    setPaused(!paused);
    return;
  }
  if (e.code === 'KeyC' && tracker && mode === 'webcam') { tracker.recalibrate(); return; }
  if (paused || mode === 'webcam' || match.presentation || practiceComplete) return;
  // 짧게 눌러도 움직임이 보이고, 누르고 있으면 프레임 루프가 계속 이동시킨다.
  const controls = mode === 'keyboard-duo' ? [['p1', 0], ['p2', 1]] : [['solo', 0]];
  if (!e.repeat) for (const [profile, player] of controls) {
    const move = moveAction(profile, e.code);
    if (move) {
      const actorIndex = match.competitive && player === 1 ? 2 : player;
      playerX[player] = Math.min(3.75, Math.max(-3.75, playerX[player] + (move === 'right' ? .28 : -.28) * actorInputSign(actorIndex)));
    }
  }
  for (const [profile, player] of controls) {
    if (controlAction(profile, e.code) || moveAction(profile, e.code) || (mode === 'keyboard' && KEY_GESTURE[e.code])) e.preventDefault();
    handleKeyboardAction(profile, match.competitive && player === 1 ? 2 : player, e.code);
  }
});
addEventListener('keyup', e => keysDown.delete(e.code));
addEventListener('blur', () => keysDown.clear());

// ── 게임 중 관절 녹화 (F8 시작/저장). 영상은 저장하지 않고, 관절 좌표와 게임이 받은 서브 판정만 남긴다.
// 파일은 replay.html이나 tools/analyze_recording.mjs로 분석한다.
const gameRecorder = new Recorder();
let recBadge = null;
function toggleGameRecording() {
  if (!readPoses) return;
  if (gameRecorder.active) {
    gameRecorder.meta.cal = tracker?.primary?.detector?.cal ?? null;   // 게임이 잰 몸 크기(1P)
    gameRecorder.meta.poseFps = poseFps;
    gameRecorder.meta.difficulty = options.difficulty;
    gameRecorder.meta.handedness = [...handedness];
    console.info('게임 녹화 저장:', gameRecorder.stop());
    recBadge?.remove(); recBadge = null;
    return;
  }
  gameRecorder.start({
    source: 'game', aspect: (video.videoWidth || 16) / (video.videoHeight || 9),
    model: poseConfig.model, delegate: poseConfig.delegate, cal: null, gameEvents: [],
  });
  recBadge = document.createElement('div');
  recBadge.textContent = '● 녹화 중 (F8 저장)';
  recBadge.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:50;padding:6px 14px;border-radius:999px;background:rgba(0,0,0,.65);color:#ff5252;font:700 16px "Malgun Gothic",sans-serif;pointer-events:none';
  document.body.appendChild(recBadge);
}

// ── 웹캠 처리. 사람이 준비되지 않았으면 false (게임 멈춤)
function updateCrowdHype(now) {
  const offRally = match && ['serve-me', 'serve-ai', 'serve-toss', 'point'].includes(match.phase) && !match.presentation;
  const held = offRally && tracker?.trackers.some(t => t.state === 'ready' && t.holding === 'block');
  if (!held) { hypeHoldSince = 0; return; }
  if (!hypeHoldSince) hypeHoldSince = now;
  if (now - hypeHoldSince < 800 || now < hypeCooldownUntil) return;
  hypeCooldownUntil = now + 6000; hypeHoldSince = 0;
  court.reactCrowd('hype'); sfx.point?.(); say('crowd_cheer');
}

function updateWebcam(now) {
  const currentMatch = match;
  if (lastTrackingT && !paused) trackingTime += Math.min(100, now - lastTrackingT);
  lastTrackingT = now;
  const poses = readPoses(now);
  if (poses) {
    gameRecorder.frame(now, poses);
    waveDetector.update(poses, now);
    if (paused || !$('over-screen').hidden) {
      previousHand = handFromPose(poses, previousHand);
      handCursor.update(previousHand);
      if (match !== currentMatch) return false;
    }
    poseFrames++;
    if (now - poseWindowT >= 1000) {
      poseFps = poseFrames * 1000 / (now - poseWindowT);
      poseFrames = 0; poseWindowT = now;
    }
    if (paused) return camReady;
    const res = tracker.process(poses, trackingTime, (video.videoWidth || 16) / (video.videoHeight || 9));
    lastCamResult = res;
    res.handChosen?.forEach((hand, slot) => { if (hand) chooseRaisedHand(slot, hand); });
    updateCrowdHype(now);
    // 1P가 잠시 나가더라도 준비된 사람이 하나라도 있으면 경기를 계속한다.
    const required = activeCameraMode === 'solo' ? 1 : 2;
    camReady = res.readyCount >= required;
    const handStages = res.handStage ?? [];
    const handSlots = handStages.map((stage, slot) => stage ? slot : -1).filter(slot => slot >= 0);
    const activeHand = handSlots.length ? handStages[handSlots[0]] : null;
    $('cam-msg').textContent = activeHand
      ? (handSlots[0] === 1 ? '2P 치는 손을 번쩍 들어요 ✋' : STATUS_MSG.hand)
      : (res.readyCount > 0 && !camReady
        ? '2인 모드입니다. 두 명 모두 화면 안에서 차렷 자세로 준비해 주세요.' : STATUS_MSG[res.status] ?? '');
    const showProgress = !!activeHand || res.status === 'calibrating';
    $('cam-bar').style.display = showProgress ? 'block' : 'none';
    if (showProgress) $('cam-fill').style.width = ((activeHand?.progress ?? res.progress ?? 0) * 100) + '%';
    $('hand-choice').innerHTML = handSlots.map(slot => {
      const raised = handStages[slot].raised;
      if (!raised) return '';
      const center = activeCameraMode === 'solo' ? 50 : (slot === 0 ? 25 : 75);
      const x = center + (raised === 'left' ? 12 : -12); // 거울 화면에서는 사람의 왼손이 화면 오른쪽에 보인다.
      const label = raised === 'left' ? '✋ 왼손' : '오른손 ✋';
      return `<span class="hand-choice-tag" style="left:${x}%">${label}</span>`;
    }).join('');
    tracker.trackers.forEach((item, slot) => {
      if (item.state !== 'hand' && item.state !== 'ready') handStageAnnounced[slot] = false;
      if (item.state === 'hand' && !handStageAnnounced[slot]) {
        say('help_raise_hand', { priority: 2 }); handStageAnnounced[slot] = true;
      }
    });
    if (res.status !== lastWebcamStatus) {
      const help = { none: 'help_stand', far: 'help_step_back', small: 'help_come_closer', calibrating: 'help_calibrate' }[res.status];
      const previous = helpLastAt.get(help) ?? -Infinity;
      if (help && now - previous >= 5000) { say(help, { priority: 2 }); helpLastAt.set(help, now); }
      lastWebcamStatus = res.status;
    }
    if (res.readyCount > lastReadyCount) {
      if (lastReadyCount === 0) say('help_ready', { priority: 2 });
      if (res.readyCount >= 2) {
        if (lastReadyCount === 0) setTimeout(() => { if (mode === 'webcam') say('help_p2_join', { priority: 2 }); }, 1800);
        else say('help_p2_join', { priority: 2 });
      }
    }
    lastReadyCount = res.readyCount;
    if (camReady && !paused && !match.presentation && !practiceComplete) {
      match.update(gameTime, playerX[0], required === 2 ? playerX[1] : null);
      const serving = ['serve-me', 'serve-ai', 'serve-toss'].includes(match.phase) && match.actor(match.servingActorIndex)?.human;
      if (serving) {
        const server = match.servingActorIndex;
        for (const ev of res.serveEvents ?? []) {
          if (gameRecorder.active) gameRecorder.meta.gameEvents.push({
            t: Math.round(now - gameRecorder.t0), type: ev.type, player: ev.playerIndex, server, phase: match.phase,
            hand: ev.hand, jump: ev.jump, power: ev.power, jumpPeak: ev.jumpPeak, sinceToss: ev.sinceToss,
          });
          const actorIndex = match.competitive && ev.playerIndex === 1 ? 2 : ev.playerIndex;
          if (actorIndex !== server) continue;
          const event = { ...ev, playerIndex: actorIndex, source: 'webcam' };
          if (ev.type === 'serveToss') {
            if (match.phase !== 'serve-toss') matchServeHand(server, ev.hand);
            match.onServeToss(event);
          }
          else if (ev.type === 'serveHit') match.onServeHit(event);
          else if (ev.type === 'serveTossExpired') match.onServeExpired(event);
        }
        if (options.difficulty === 'easy' && match.phase === 'serve-me') {
          const legacy = res.events.find(ev => ev.playerIndex === server && ev.type === 'serve');
          if (legacy) match.legacyEasyServe(server);
        }
      } else {
        // 같은 프레임의 점프를 먼저 반영한 뒤, 전용 내려치기 감지로만 스파이크를 친다.
        for (const ev of res.events.filter(ev => ev.type === 'jump')) {
          const actorIndex = match.competitive && ev.playerIndex === 1 ? 2 : ev.playerIndex;
          match.onGesture('jump', eventForActor(ev, actorIndex), actorIndex);
        }
        for (const ev of res.attackEvents ?? []) {
          const actorIndex = match.competitive && ev.playerIndex === 1 ? 2 : ev.playerIndex;
          match.onAttack(eventForActor(ev, actorIndex), actorIndex);
        }
        for (const ev of res.events) {
          if (['jump', 'spike', 'serve'].includes(ev.type)) continue;
          const actorIndex = match.competitive && ev.playerIndex === 1 ? 2 : ev.playerIndex;
          match.onGesture(ev.type, eventForActor(ev, actorIndex), actorIndex);
        }
      }
    }
  }
  $('cam-overlay').style.display = camReady || match.phase === 'over' ? 'none' : 'flex';
  $('pip-wrap').className = camReady ? 'ok' : 'bad';
  $('goal').textContent = practice ? '연습' : `${options.target}점 먼저 · ${{ solo: '1인', coop: '2인 협동', versus: '1P 대 2P' }[activeCameraMode]} · ${lastCamResult.readyCount || 0}명 준비`;
  const primary = tracker.primary;
  const holding = primary.holding;
  pip.draw({
    player: primary.player, others: tracker.players.slice(1), holding,
    color: holding ? GESTURES[holding].color : null,
    players: tracker.trackers.map(t => t.player),
  });
  const second = tracker.trackers[1];
  $('pip-join').textContent = tracker.poseCount > 1 && second.state === 'hand'
    ? '2P 치는 손을 들어요!'
    : (tracker.poseCount > 1 && second.state !== 'ready' ? '2P 차렷 자세로!' : '');

  // 몸의 좌우 위치 → 코트 위치 (화면 가로 20%~80% 범위를 우리 코트 전체로)
  tracker.bodyXs.forEach((bx, i) => {
    if (!camReady || bx == null) return;
    const twoPlayers = activeCameraMode !== 'solo';
    const start = twoPlayers ? (i === 0 ? .06 : .54) : .12;
    const width = twoPlayers ? .4 : .76;
    const k = Math.min(1, Math.max(0, (bx - start) / width));
    const actorIndex = match?.competitive && i === 1 ? 2 : i;
    const mapped = (-3.6 + k * 7.2) * actorInputSign(actorIndex);
    playerX[i] += (mapped - playerX[i]) * 0.35;
  });
  court.setMirrorPoses(tracker.trackers.map(t => t.player));
  return camReady;
}

function updateVoiceCues() {
  const prompts = performance.now() >= voiceCueAfter ? match.prompts : [];
  const nextKeys = new Set();
  for (const prompt of prompts) {
    const key = `${prompt.action}:${prompt.who}:${prompt.tHit ?? match.phaseT}`;
    nextKeys.add(key);
    if (!activePromptKeys.has(key)) say(prompt.action === 'serveToss' ? 'do_serve' : prompt.action === 'serveHit' ? 'do_serve_hit' : 'do_' + prompt.action, { priority: 3 });
    if (prompt.inReach === false && match.landing?.human) {
      const ballKey = `${match.ball.t0}:${prompt.who}`;
      if (arrowCueKey !== ballKey) {
        const direction = match.actor(prompt.who).x < prompt.hitX ? 'move_right' : 'move_left';
        arrowCueKey = ballKey;
        setTimeout(() => { if (match && arrowCueKey === ballKey) say(direction, { priority: 2 }); }, 850);
      }
    }
  }
  activePromptKeys = nextKeys;

  const stats = match.stats;
  if (stats.good > lastStats.good || stats.miss > lastStats.miss) consecutivePerfect = 0;
  if (stats.perfect > lastStats.perfect) {
    consecutivePerfect += stats.perfect - lastStats.perfect;
    if (consecutivePerfect === 2) say('perfect_1');
  }
  lastStats = { perfect: stats.perfect, good: stats.good, miss: stats.miss };
}

function updateServeGuide(now) {
  if (!match) return;
  if (practice && practiceStep > 0) {
    $('message').classList.remove('serve-guide');
    if (lastServeGuide) { $('msg-text').textContent = ''; $('msg-sub').textContent = ''; lastServeGuide = ''; }
    return;
  }
  let key = '', text = '', sub = '';
  const server = match.servingActorIndex;
  if (['serve-me', 'serve-ai'].includes(match.phase) && match.actor(server)?.human) {
    key = `ready:${server}:${mode}`;
    if (mode === 'webcam') {
      text = `${match.actor(server).label} · ① 한 손으로 공을 위로 던지기`; sub = '② 떨어질 때 다른 손으로 치기 · 점프하면 스파이크 서브';
    } else {
      const profile = mode === 'keyboard-duo' ? (server ? bindings.p2 : bindings.p1) : bindings.solo;
      text = `${keyName(profile.set)} 토스 → ${keyName(profile.hit)} 치기`;
      sub = `${keyName(profile.jump)} 누르고 치면 스파이크 서브`;
    }
  } else if (match.phase === 'serve-toss' && match.actor(server)?.human) {
    key = `toss:${match.serveToss.index}:${mode}`; text = '공이 좋은 높이에 왔을 때 치세요!';
    sub = mode === 'webcam' ? '토스한 손과 다른 손으로 타격' : '점프 후 치면 강한 스파이크 서브';
  }
  $('message').classList.toggle('serve-guide', !!key);
  if (key) placeMessageFor(server); else placeMessageFor(null);
  if (key && key !== lastServeGuide) {
    $('msg-text').textContent = text; $('msg-sub').textContent = sub;
    const el = $('message'); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    lastServeGuide = key; serveReminderAt = now + 8000;
  } else if (!key && lastServeGuide) {
    if (match.phase !== 'point' && match.phase !== 'over') { $('msg-text').textContent = ''; $('msg-sub').textContent = ''; }
    lastServeGuide = '';
  }
  if (mode === 'webcam' && key.startsWith('ready:') && now >= serveReminderAt) {
    say('do_serve', { priority: 3 }); serveReminderAt = now + 8000;
  }
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastFrameT) / 1000);
  lastFrameT = now;
  if (!match) return;

  const ready = mode === 'webcam' ? updateWebcam(now) : true;
  if (!match) return;
  if (!paused && (mode === 'keyboard' || mode === 'keyboard-duo')) {
    const profiles = mode === 'keyboard-duo' ? [['p1', 0], ['p2', 1]] : [['solo', 0]];
    for (const [profile, player] of profiles) {
      let dir = 0;
      for (const code of keysDown) {
        const action = moveAction(profile, code);
        if (action === 'right') dir += 1;
        else if (action === 'left') dir -= 1;
      }
      const actorIndex = match.competitive && player === 1 ? 2 : player;
      playerX[player] = Math.min(3.75, Math.max(-3.75, playerX[player] + Math.sign(dir) * 5 * dt * actorInputSign(actorIndex)));
    }
  }
  const acceptingPlay = ready && !paused && !match.presentation && !practiceComplete && match.phase !== 'over';
  match.updateTimeScale(acceptingPlay && !debugContactFrozen ? dt : 0);
  const freezeAction = params.has('debug') ? params.get('freezeContact') : null;
  const freezeExp = freezeAction === 'block' ? match.blockExp : match.exp;
  const freezeActors = params.get('freezeTeam') === 'me' ? match.players
    : (params.get('freezeTeam') === 'ai' ? match.ai : [...match.players, ...match.ai]);
  const freezeActor = freezeAction ? freezeActors.find(actor => actor.anim?.planned && actor.anim.type === freezeAction) : null;
  const freezeAnimHit = freezeActor ? freezeActor.anim.t0 + ({ underSet: .45, dig: .45 }[freezeAction] ?? .5) * ANIM_SECONDS : null;
  const expCrossing = freezeExp && !freezeExp.done && (freezeExp.action === freezeAction || freezeExp.animType === freezeAction)
    && gameTime < freezeExp.tHit && gameTime + dt * match.timeScale >= freezeExp.tHit;
  const animCrossing = freezeAnimHit != null && gameTime < freezeAnimHit && gameTime + dt * match.timeScale >= freezeAnimHit;
  const setRunner = freezeAction === 'position' && match.setPosition?.team === 'me' ? match.actor(match.setPosition.who) : null;
  const positionCrossing = !!(setRunner?.running && match.ball.tHit - gameTime > .2);
  const crossingContact = expCrossing || animCrossing || positionCrossing;
  if (crossingContact) {
    if (expCrossing) gameTime = freezeExp.tHit;
    else if (animCrossing) gameTime = freezeAnimHit;
    debugContactFrozen = true;
    let badge = $('debug-contact-frozen');
    if (!badge) {
      badge = document.createElement('div'); badge.id = 'debug-contact-frozen'; document.body.appendChild(badge);
      badge.style.cssText = 'position:fixed;z-index:101;left:50%;bottom:12px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:#ffd54f;color:#222;font:900 18px "Malgun Gothic",sans-serif';
    }
    badge.textContent = freezeAction === 'position'
      ? `리시브 전 토스 자리 이동 · ${gameTime.toFixed(2)}초`
      : `${freezeAction} 접촉 순간 · ${gameTime.toFixed(2)}초`;
  } else if (acceptingPlay && !debugContactFrozen) gameTime += dt * match.timeScale;
  const firstX = mode === 'webcam' && tracker.bodyXs[0] == null ? null : playerX[0];
  const secondX = mode === 'keyboard-duo' ? playerX[1] : (mode === 'webcam' && tracker.bodyXs[1] != null ? playerX[1] : null);
  court.syncServeAnchor(match);
  if (acceptingPlay && !debugContactFrozen) match.update(gameTime, firstX, secondX);
  if (acceptingPlay && !debugContactFrozen) { updateServeGuide(now); updateVoiceCues(); }
  court.draw(match, gameTime);
  if (debugContactFrozen) court.flash(0);
  document.body.dataset.actionSide = match?.exp?.who >= 2 ? 'p2' : 'p1';
  const pointCloseup = !practice && match.phase === 'point'
    && gameTime - match.phaseT < (match.pointPresentation?.loserEnd ?? 3.6);
  $('message').classList.toggle('point-focus', pointCloseup);
  document.body.classList.toggle('slow-motion', match.slowMotion);
  if (!perfEl.hidden) {
    const p = court.performanceInfo;
    perfEl.textContent = [
      `화면  ${p.fps.toFixed(1)} fps  |  프레임 ${p.frameMs.toFixed(2)} ms`,
      `동작  ${mode === 'webcam' ? poseFps.toFixed(1) : '--'} fps  |  ${poseConfig.delegate}-${poseConfig.model}`,
      `그리기 ${p.calls} calls  |  ${p.triangles.toLocaleString()} triangles`,
      `로딩  ${p.modelsReadyMs ? (p.modelsReadyMs / 1000).toFixed(2) + ' s' : '진행 중'}`,
      `화질  ${p.qualityLabel}  |  해상도 ${p.resolutionScale.toFixed(2)}x`,
      `GPU   ${p.gpu}`,
    ].join('\n');
  }
}

// 인트로에서 카메라 권한을 이미 허용한 경우에만 시작 화면 손 메뉴를 자동으로 켠다.
const cameraPermission = navigator.permissions?.query?.({ name: 'camera' });
cameraPermission?.then(async permission => {
  if (permission.state !== 'granted') return;
  try { await ensureCamera(); startHandEnabled = true; } catch { return; }
}).catch(() => {});
const menuLoop = now => {
    const menuVisible = MENU_SCREEN_IDS.some(id => !$(id).hidden);
    if (startHandEnabled && menuVisible && readPoses) {
      const poses = readPoses(now);
      if (poses) {
        previousHand = handFromPose(poses, previousHand);
        handCursor.update(previousHand);
      }
    }
    requestAnimationFrame(menuLoop);
  };
requestAnimationFrame(menuLoop);

// 로컬 자동 검증 전용: 일반 주소에서는 동작하지 않는다.
if (params.has('debug')) {
  if (params.get('versus') === '1') cameraMode = 'versus';
  if (rosterNames.includes(params.get('char1'))) selectedCharacters[0] = params.get('char1');
  if (rosterNames.includes(params.get('char2')) && params.get('char2') !== selectedCharacters[0]) selectedCharacters[1] = params.get('char2');
  if (selectedCharacters[0] === selectedCharacters[1]) selectedCharacters[1] = rosterNames.find(name => name !== selectedCharacters[0]);
}
if (params.has('debug') && params.has('autostart')) requestAnimationFrame(() => begin(
  params.get('autostart') === 'duo' ? 'keyboard-duo' : 'keyboard',
  { tutorial: params.has('tutorial') },
));
if (params.has('debug') && params.has('probe')) {
  const report = document.createElement('pre');
  report.id = 'contact-probe-report'; report.textContent = '공–손 접촉 측정 준비 중…';
  report.style.cssText = 'position:fixed;z-index:100;right:8px;bottom:8px;max-width:48vw;max-height:42vh;overflow:auto;padding:10px;border-radius:10px;background:rgba(0,0,0,.82);color:#bfffe2;font:700 13px/1.4 Consolas,monospace;white-space:pre-wrap';
  document.body.appendChild(report);
  requestAnimationFrame(async () => {
    try {
      await court.ready;
      const { runContactProbe } = await import('../../tools/contact-probe.js');
      const seconds = Math.max(10, Math.min(90, Number(params.get('probe')) || 60));
      report.textContent = `공–손 접촉 측정 중… ${seconds}초`;
      const result = await runContactProbe({ seconds, aiServes: !params.has('humanServe') });
      report.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      report.textContent = `측정 실패: ${error.message}`;
      console.error(error);
    }
  });
}
if (params.has('debug') && params.has('measure')) {
  const report = document.createElement('pre'); report.id = 'debug-measure'; report.textContent = '측정 중…'; document.body.appendChild(report);
  court.ready.then(() => {
    const depths = court.measureBackNumberDepths();
    report.textContent = JSON.stringify({ modelsReadyMs: court.modelsReadyMs, backNumberDepths: depths });
  });
}




