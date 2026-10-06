// 2:2 경기 진행. x=좌우, y=높이, z=앞뒤(네트 z=0).
import { Ball } from './ball.js?v=20261006b';
import { ANIM_SECONDS, COURT, HIT, SPIKE_Z, DIFFICULTY, SERVE } from './rules.js?v=20261006c';
import { characterEffects, characterOrder, NEUTRAL_EFFECTS } from './character-profiles.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// rig-poser.js의 공개 접촉 프레임과 같은 값. 경기 로직의 Node 시험이 Three.js에 의존하지 않게 둔다.
const APPROACH_SPEED = 4.6;   // 공 쪽으로 달려가는 평균 속도(m/s). 부드러운 출발·정지로 가장 빠를 때 약 7m/s
const CONTACT_K = { bump: .45, underSet: .45, set: .45, dig: .45, spike: .5, tip: .5, block: .5, serveFloat: .35, serveJump: .35, serve: .35, dive: .4 };
const CONTACT_HEIGHT = { ...HIT, underSet: .9, dig: .55, tip: HIT.spike };
const SOLO_CELEBRATIONS = ['fistPump', 'skyKiss', 'itsMe', 'flex', 'pointSky'];
const SHARED_CELEBRATIONS = ['highFive', 'chestBump'];
const SAD_STYLES = ['handsOnHead', 'kneesHands', 'shrug', 'hipsHead'];

export class Match {
  constructor({ difficulty = 'normal', target = 7, replay = true, onEvent = () => {}, humanCount = 1, competitive = false, autoMove = false } = {}) {
    this.autoMove = autoMove;
    this.competitive = competitive;
    this.D = DIFFICULTY[difficulty];
    this.difficulty = difficulty;
    this.target = target;
    this.replayEnabled = replay;
    this.emit = onEvent;
    this.time = 0;
    this._timeScale = 1;
    this.score = { me: 0, ai: 0 };
    this.stats = { perfect: 0, good: 0, miss: 0, assist: 0, spikes: 0, tips: 0, blocks: 0, stuffBlocks: 0, digs: 0 };
    this.ball = new Ball();
    this.players = [
      { x: -1.35, z: -5.6, tx: -1.35, tz: -5.6, homeX: -1.35, homeZ: -5.6, anim: null, human: humanCount > 0, label: '1P' },
      { x: 1.35, z: -4.2, tx: 1.35, tz: -4.2, homeX: 1.35, homeZ: -4.2, anim: null, human: humanCount > 1, label: competitive ? '1P 짝꿍' : (humanCount > 1 ? '2P' : '짝꿍') },
    ];
    this.me = this.players[0];
    this.mate = this.players[1];
    this.ai = [
      { x: -1.4, z: 4.2, tx: -1.4, tz: 4.2, homeX: -1.4, homeZ: 4.2, anim: null, label: '상대 1' },
      { x: 1.4, z: 5.8, tx: 1.4, tz: 5.8, homeX: 1.4, homeZ: 5.8, anim: null, label: '상대 2' },
    ];
    this.ai[0].human = competitive;
    this.ai[0].label = competitive ? '2P' : '상대 1';
    if (competitive) this.ai[1].label = '2P 짝꿍';
    // 단독 시험·시뮬레이션은 기존 균형값을 유지한다.
    // 실제 게임은 main.js에서 선택한 명단을 바로 설정한다.
    [...this.players, ...this.ai].forEach(actor => {
      actor.characterName = null; actor.effects = NEUTRAL_EFFECTS;
    });
    this.aiServerIndex = competitive ? 0 : 1;
    this.popups = [];
    this.jobs = [];
    this.serverTurn = -1;
    this.servingTeam = null;
    this.lastJumpT = [-1e9, -1e9, -1e9, -1e9];
    this.winner = null;
    this.landing = null;
    this.blockZone = null;
    this.chain = null;
    this.serveAnchor = null;
    this.serveHitAnchor = null;
    this.serveHitFloatAnchor = null;
    this.serveHitJumpAnchor = null;
    this.serveStandReach = 2.35;
    this.serveToss = null;
    this.serveTimingHistory = Array.from({ length: 4 }, () => ({ float: [], spike: [] }));
    this.serveRetriesUsed = 0;
    this.serveFaultOwner = null;
    this.receivePlan = null;
    this.setPosition = null;
    this.passSequence = 0;
    this.pointCelebrationCount = 0;
    this.lastCelebrationStyles = [null, null, null, null];
    this.celebrationLog = [];
    this.pointPresentation = null;
    this.pointReplay = false;
    this.pointReplayKind = null;
    this.pointReplayActor = null;
    this.rallyHighlight = null;
    this.lastAttackAt = [-1e9, -1e9, -1e9, -1e9];
    this.tipProbe = null;
    this.touchLog = [];
    this.touchViolations = [];
    this.lastTouch = null;
    this.teamHitCount = 0;
    this.rallyId = 0;
    this.attackAimHistory = [];
    this.defenseRead = null;
    this.readingLog = [];
    this.deceptionPending = false;
    this.readingSequence = 0;
    this.shortChanceBoost = typeof location !== 'undefined' && new URLSearchParams(location.search).get('short') === '1';
    this.debugTipRate = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('tipRate') ?? 0) : 0;
    this.startServe('me');
  }

  actor(who) { return who < 2 ? this.players[who] : this.ai[who - 2]; }

  setCharacterChoices(choices) {
    characterOrder(choices, this.competitive).forEach((name, index) => {
      const actor = this.actor(index);
      actor.characterName = name;
      actor.effects = characterEffects(name);
    });
  }

  actualContactPoint(who, type) {
    const actor = this.actor(who), offset = this.contactOffset(type, who);
    if (this.autoMove && actor.anim?.contact && actor.anim.type === type) return { ...actor.anim.contact,
      y: type === 'spike' ? this.contactHeight(who, type) : actor.anim.contact.y };
    const high = ['spike', 'tip', 'block', 'serve', 'serveFloat', 'serveJump'].includes(type);
    const height = this.contactHeight(who, type);
    return { x: actor.x + offset.x, y: height, z: actor.z + offset.z };
  }

  recordTouch(who, action, ballPos = this.ball.pos(this.time)) {
    const actor = this.actor(who), previous = this.lastTouch;
    const entry = {
      time: this.time, rally: this.rallyId, who, action,
      ball: ballPos ? { ...ballPos } : null,
      actor: actor ? { x: actor.x, z: actor.z } : null,
    };
    if (previous?.who === who && previous.action !== 'block') {
      this.touchViolations.push(entry);
      this.popup('연속 터치!', '#ef5350', actor?.x ?? 0, 3, actor?.z ?? 0);
      this.pointTo(who < 2 ? 'ai' : 'me');
      return false;
    }
    const sameTeam = previous && (previous.who < 2) === (who < 2);
    const hits = sameTeam ? this.teamHitCount + 1 : 1;
    if (hits > 3) {
      this.popup('4회 터치!', '#ef5350', actor?.x ?? 0, 3, actor?.z ?? 0);
      this.pointTo(who < 2 ? 'ai' : 'me', '4회 터치!');
      return false;
    }
    this.teamHitCount = hits;
    entry.teamHits = hits;
    this.touchLog.push(entry);
    this.lastTouch = entry;
    return true;
  }

  serveIdeal(who, jump) {
    const key = jump ? 'spike' : 'float';
    const values = this.serveTimingHistory[who]?.[key] ?? [];
    if (!values.length) return jump ? SERVE.jumpIdealT : SERVE.floatIdealT;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  rememberServeTiming(who, jump, elapsed) {
    const key = jump ? 'spike' : 'float';
    const values = this.serveTimingHistory[who][key];
    values.push(clamp(elapsed, 1.1, 2.2));
    if (values.length > 3) values.shift();
  }

  actorIndex(actor) {
    const player = this.players.indexOf(actor);
    return player >= 0 ? player : 2 + this.ai.indexOf(actor);
  }

  chooseSoloStyle(actorIndex, blocked = new Set()) {
    const choices = SOLO_CELEBRATIONS.filter(style => style !== this.lastCelebrationStyles[actorIndex] && !blocked.has(style));
    const style = choices[Math.floor(Math.random() * choices.length)] ?? 'fistPump';
    this.lastCelebrationStyles[actorIndex] = style;
    return style;
  }

  applyTeamGestures(winner, { forceShared = null, victoryStage = null } = {}) {
    const winning = winner === 'me' ? this.players : this.ai;
    const losing = winner === 'me' ? this.ai : this.players;
    const base = winner === 'me' ? 0 : 2;
    const shared = forceShared ?? (this.pointCelebrationCount % 3 === 0);
    const styles = [];
    if (shared) {
      const style = SHARED_CELEBRATIONS[(Math.floor(this.pointCelebrationCount / 3) + (victoryStage ?? 0)) % SHARED_CELEBRATIONS.length];
      const midX = (winning[0].x + winning[1].x) / 2;
      const midZ = (winning[0].z + winning[1].z) / 2;
      winning.forEach((p, i) => {
        p.tx = midX + (i ? .6 : -.6); p.tz = midZ;
        p.anim = { type: 'idle', t0: this.time, face: { x: midX + (i ? -.6 : .6), z: midZ } };
        this.lastCelebrationStyles[base + i] = style;
      });
      styles.push(style, style);
    } else {
      const used = new Set();
      winning.forEach((p, i) => {
        const style = this.chooseSoloStyle(base + i, used); used.add(style); styles.push(style);
        p.anim = { type: 'celebrate', style, phase: Math.random(), t0: this.time, faceCamera: true };
      });
    }
    const loserT0 = this.time + (victoryStage == null ? (shared ? 3.4 : 2.8) : 0);
    losing.forEach((p, i) => p.anim = { type: 'sad', style: SAD_STYLES[(this.pointCelebrationCount + i + (victoryStage ?? 0)) % SAD_STYLES.length], phase: Math.random(), t0: loserT0, delayed: loserT0 > this.time });
    return { shared, styles };
  }

  beginPointPresentation(winner, gesture) {
    const winning = winner === 'me' ? this.players : this.ai;
    const winnerEnd = gesture.shared ? 3.4 : 2.8;
    const loserEnd = winnerEnd + .8;
    const replayStart = loserEnd;
    const replayEnd = replayStart + 2.5;
    this.pointPresentation = {
      winner, shared: gesture.shared, styles: gesture.styles, startedAt: this.time,
      winnerEnd, loserEnd, replayStart, replayEnd,
      duration: this.pointReplay ? replayEnd : Math.max(3.6, loserEnd),
      starts: winning.map(p => ({ x: p.x, z: p.z })),
      targets: winning.map(p => ({ x: p.tx, z: p.tz })),
      celebrationAt: gesture.shared ? this.time + .6 : this.time,
      celebrationStarted: !gesture.shared,
    };
  }

  updatePointPresentation(t) {
    const view = this.pointPresentation;
    if (!view || this.phase !== 'point') return;
    const winning = view.winner === 'me' ? this.players : this.ai;
    const elapsed = t - view.startedAt;
    if (view.shared && !view.celebrationStarted) {
      const moveK = clamp((elapsed - .3) / .3, 0, 1);
      winning.forEach((p, i) => {
        const start = view.starts[i], target = view.targets[i];
        p.x = start.x + (target.x - start.x) * moveK;
        p.z = start.z + (target.z - start.z) * moveK;
        p.running = moveK > 0 && moveK < 1;
        p.anim = moveK > 0 && moveK < 1
          ? { type: 'run', t0: t, face: { ...target } }
          : p.anim;
      });
      if (t >= view.celebrationAt) {
        winning.forEach((p, i) => {
          p.x = p.tx = view.targets[i].x; p.z = p.tz = view.targets[i].z;
          p.anim = { type: 'celebrate', style: view.styles[i], phase: 0, t0: view.celebrationAt,
            face: { x: view.targets[1 - i].x, z: view.targets[1 - i].z } };
        });
        view.celebrationStarted = true;
      }
    }
    winning.forEach(p => {
      if (p.anim?.type === 'celebrate' && t - p.anim.t0 > 3.2) p.anim = { type: 'idle', t0: t };
    });
  }

  beginRallyHighlights(team, actorIndex = null) {
    this.rallyHighlight = {
      serveTeam: team, serveActor: actorIndex, receiveCount: 0, dig: false, digTeam: null,
      netCrossings: 1, lastAttack: { type: 'serve', team, actor: actorIndex }, stuff: null,
    };
  }

  markReceive(receiveType, team = null) {
    if (!this.rallyHighlight) return;
    this.rallyHighlight.receiveCount++;
    if (receiveType === 'dig') {
      this.rallyHighlight.dig = true;
      this.rallyHighlight.digTeam = team;
    }
  }

  markAttack(type, team, actor) {
    if (!this.rallyHighlight) return;
    this.rallyHighlight.lastAttack = { type, team, actor };
    if (type === 'spike' || type === 'tip' || type === 'free') this.rallyHighlight.netCrossings++;
  }

  choosePointReplay(winner) {
    const h = this.rallyHighlight;
    if (!this.replayEnabled || !h) return { enabled: false, kind: null, actor: null };
    if (h.stuff?.team === winner) return { enabled: true, kind: 'stuff-block', actor: h.stuff.actor };
    if (h.lastAttack?.type === 'spike' && h.lastAttack.team === winner) return { enabled: true, kind: 'spike-kill', actor: h.lastAttack.actor };
    if (h.lastAttack?.type === 'serve' && h.serveTeam === winner && h.receiveCount === 0 && !this.serveFaultOwner) {
      return { enabled: true, kind: 'serve-ace', actor: h.serveActor };
    }
    if (h.dig && h.digTeam === winner) return { enabled: true, kind: 'sliding-dig', actor: h.lastAttack?.actor ?? h.serveActor };
    if (h.netCrossings >= 4) return { enabled: true, kind: 'long-rally', actor: h.lastAttack?.actor ?? h.serveActor };
    return { enabled: false, kind: null, actor: null };
  }

  setVictoryGestures(winner, stage = 0) {
    return this.applyTeamGestures(winner, { forceShared: stage === 0, victoryStage: stage });
  }

  actionFace(who, type) {
    const actor = this.actor(who), team = who < 2 ? 'me' : 'ai', local = who < 2 ? who : who - 2;
    if (['bump', 'dig'].includes(type)) {
      const plan = this.receivePlan;
      if (plan?.team === team && plan.receiverIndex === local) return { ...plan.spot };
    }
    if (['set', 'underSet'].includes(type)) {
      const chain = team === 'me' ? this.chain : this.aiChain;
      if (chain?.attackTarget) return { ...chain.attackTarget };
    }
    if (['spike', 'tip', 'block', 'serve', 'serveFloat', 'serveJump'].includes(type)) {
      return { x: actor.x, z: actor.z + (team === 'me' ? 5 : -5) };
    }
    return null;
  }

  contactOffset(type, who, face = this.actionFace(who, type)) {
    const player = this.actor(who), measured = this.autoMove && player.contactGeometry?.[type];
    if (measured) {
      const forward = ['spike', 'tip', 'block'].includes(type);
      const dx = !forward && face ? face.x - player.tx : 0;
      const dz = !forward && face ? face.z - player.tz : (who < 2 ? 1 : -1);
      const length = Math.hypot(dx, dz) || 1, fx = dx / length, fz = dz / length;
      return { x: -measured.x * fz + measured.z * fx, z: measured.x * fx + measured.z * fz };
    }
    const front = { bump: .4, underSet: .6, dig: .56, set: .22, spike: .15, block: .12 }[type] ?? .15;
    const actor = this.actor(who);
    if (face && actor) {
      const dx = face.x - actor.tx, dz = face.z - actor.tz, length = Math.hypot(dx, dz);
      if (length > .001) return { x: dx / length * front, z: dz / length * front };
    }
    return { x: 0, z: (who < 2 ? 1 : -1) * front };
  }

  fitComputerTarget(actor, type, tHit) {
    if (this.autoMove) return;
    if (actor.human || type === 'dig') return;
    const lead = (CONTACT_K[type] ?? .5) * ANIM_SECONDS;
    const travel = Math.max(0, tHit - lead - this.time);
    actor.tx = actor.x + clamp(actor.tx - actor.x, -5.5 * travel, 5.5 * travel);
    actor.tz = actor.z + clamp(actor.tz - actor.z, -7 * travel, 7 * travel);
  }

  contactPoint(who, type, tHit = this.ball.tHit) {
    const actor = this.actor(who);
    this.fitComputerTarget(actor, type, tHit);
    const offset = this.contactOffset(type, who);
    const high = ['spike', 'tip', 'block', 'serve', 'serveFloat', 'serveJump'].includes(type);
    const height = this.contactHeight(who, type);
    return { x: actor.tx + offset.x, y: height, z: actor.tz + offset.z };
  }

  contactHeight(who, type) {
    const actor = this.actor(who), measured = this.autoMove && (type === 'spike' && actor.human && !actor.anim?.jump
      ? actor.contactGeometry?.serveFloat ?? actor.contactGeometry?.spike : actor.contactGeometry?.[type]);
    if (measured) {
      const jump = ['tip', 'block', 'serveJump'].includes(type) || (type === 'spike' && (!actor.human || actor.anim?.jump))
        ? actor.effects.jumpHeight * Math.sin(Math.PI * (CONTACT_K[type] ?? .5)) : 0;
      return measured.y + jump;
    }
    return (CONTACT_HEIGHT[type] ?? HIT.bump) + (['spike', 'tip', 'block'].includes(type) ? actor.effects.highContactOffset : 0);
  }

  planAnim(actor, type, tHit, jump = false, contact = null) {
    const t0 = tHit - (CONTACT_K[type] ?? .5) * ANIM_SECONDS;
    const who = this.actorIndex(actor);
    let face = this.actionFace(who, type);
    if (face && ['set', 'underSet'].includes(type)) {
      // 짧은 토스 중 세터가 자리로 이동해도 어깨 방향이 흔들리지 않도록 같은 공격 방향을 멀리 투영한다.
      const dx = face.x - actor.tx, dz = face.z - actor.tz, length = Math.hypot(dx, dz);
      if (length > .001) face = { x: actor.tx + dx / length * 20, z: actor.tz + dz / length * 20 };
    }
    actor.anim = { type, t0, jump, planned: true, face };
    if (actor.human && type === 'block') {
      actor.anim.jump = false;
      actor.anim.awaitingInput = true;
    }
    if (this.autoMove && contact) {
      const offset = this.contactOffset(type, who, face);
      actor.tx = contact.x - offset.x; actor.tz = contact.z - offset.z;
      if (['spike', 'tip', 'block'].includes(type)) actor.anim.face = { x: actor.tx, z: actor.tz + (who < 2 ? 1000 : -1000) };
      // 공을 보면 곧바로 달려가 일찍 도착해 자세를 잡고 기다린다(2026-10-05 선생님: "수비할 때 걷기만 하지 말고 빠르게 뛰어").
      // 예전에는 공이 도착하는 시각까지 이동을 늘려 1.2~1.7초 내내 걷는 속도(중앙값 2.5m/s)였다.
      // 평균 APPROACH_SPEED, 부드럽게 출발·정지하므로 가장 빠를 때는 평균의 1.5배(약 7m/s).
      const arriveBy = Math.max(this.time + .01, tHit - .06);
      const dashEnd = this.time + Math.max(.3, Math.hypot(actor.tx - actor.x, actor.tz - actor.z) / APPROACH_SPEED);
      actor.approach = { x: actor.x, z: actor.z, tx: actor.tx, tz: actor.tz,
        start: this.time, end: Math.min(arriveBy, dashEnd), hold: tHit + this.D.late + .08 };
      actor.anim.contact = { ...contact };
      actor.anim.contactUntil = actor.human ? tHit + this.D.late : tHit;
      delete actor.magnet; delete actor.slide;
      return;
    }
    if (type === 'dig' && contact) {
      const offset = this.contactOffset(type, who, face);
      actor.slide = {
        targetX: contact.x - offset.x, targetZ: contact.z - offset.z,
        t0, start: t0 + .2 * ANIM_SECONDS, end: t0 + .45 * ANIM_SECONDS,
        holdUntil: t0 + .75 * ANIM_SECONDS, fromX: actor.x, fromZ: actor.z,
      };
      return;
    }
    if (!actor.human || !contact) return;
    const offset = this.contactOffset(type, who, face);
    const target = { x: contact.x - offset.x, z: contact.z - offset.z };
    if (Math.abs(actor.x - target.x) <= this.D.reach) actor.magnet = { ...target, t0, tHit };
  }

  retargetIncomingBall(who, type) {
    const contact = this.contactPoint(who, type, this.ball.tHit);
    const from = this.ball.pos(this.time), remaining = Math.max(.05, this.ball.tHit - this.time);
    const style = this.ball.flightStyle;
    this.ball.launch(from, contact, remaining, this.time, style);
    this.ball.keepGroundInCourt();
    return contact;
  }

  applyMagnet(actor, inputX = actor.x) {
    const magnet = actor.magnet;
    if (!magnet) return;
    const smooth = v => { const k = clamp(v, 0, 1); return k * k * (3 - 2 * k); };
    let weight;
    if (this.time <= magnet.tHit) weight = smooth((this.time - magnet.t0) / Math.max(.01, magnet.tHit - magnet.t0));
    else weight = 1 - smooth((this.time - magnet.tHit) / .3);
    actor.x = inputX + (magnet.x - inputX) * weight;
    actor.z += (magnet.z - actor.z) * weight;
    if (this.time >= magnet.tHit + .3) delete actor.magnet;
  }

  applySlide(actor) {
    const slide = actor.slide;
    if (!slide) return;
    if (this.time < slide.start) {
      slide.fromX = actor.x; slide.fromZ = actor.z;
      return;
    }
    const k = clamp((this.time - slide.start) / Math.max(.01, slide.end - slide.start), 0, 1);
    const s = k * k * (3 - 2 * k);
    actor.x = slide.fromX + (slide.targetX - slide.fromX) * s;
    actor.z = slide.fromZ + (slide.targetZ - slide.fromZ) * s;
    if (this.time >= slide.holdUntil) delete actor.slide;
  }

  setterSpot(team, landingX) {
    return { x: clamp(-.35 * landingX, -2, 2), z: team === 'me' ? -2.5 : 2.5 };
  }

  prepareSetter(team, receiverIndex, landingX, kind = 'receive') {
    const squad = team === 'me' ? this.players : this.ai;
    const setterIndex = 1 - receiverIndex, setter = squad[setterIndex];
    const spot = this.setterSpot(team, landingX);
    const move = Math.hypot(setter.x - spot.x, setter.z - spot.z);
    setter.readyWaiting = true;
    setter.tx = spot.x; setter.tz = spot.z;
    this.setPosition = { ...spot, who: setterIndex + (team === 'ai' ? 2 : 0), human: !!setter.human, team };
    this.receivePlan = { team, receiverIndex, setterIndex, spot, move, kind };
    return this.receivePlan;
  }

  passTarget(plan, quality, receiveType) {
    const baseSpot = plan?.spot ?? this.setterSpot(plan?.team ?? 'me', this.ball.pos(this.time).x);
    const serveReceive = plan?.kind === 'receive';
    const minMiss = quality === 'perfect' ? 0 : (serveReceive ? .3 : ({ easy: .3, normal: .75, hard: .85 }[this.difficulty] ?? .3));
    const maxMiss = quality === 'perfect' ? .3 : (serveReceive ? .8 : 1.2);
    // 패스 오차가 수비 성공 확률의 난수 순서를 바꾸지 않도록 별도 수열을 쓴다.
    const wave = Math.sin((++this.passSequence) * 12.9898 + this.time * 78.233) * 43758.5453;
    const signedSample = (wave - Math.floor(wave)) * 2 - 1;
    let miss = minMiss + Math.abs(signedSample) * (maxMiss - minMiss);
    const receiver = plan ? (plan.team === 'me' ? this.players[plan.receiverIndex] : this.ai[plan.receiverIndex]) : null;
    miss *= receiver?.effects?.receiveError ?? 1;
    if (plan?.kind === 'dig') miss += .3;
    if (receiveType === 'dig') miss += .6;
    const x = clamp(baseSpot.x + (signedSample < 0 ? -miss : miss), -2.8, 2.8);
    return { x, z: baseSpot.z, miss: Math.abs(x - baseSpot.x) };
  }

  receiveMode(actor, who, target, tHit) {
    const offset = this.contactOffset('bump', who);
    const bodyTarget = { x: target.x - offset.x, z: target.z - offset.z };
    if (actor.human) {
      const lateral = Math.abs(actor.x - bodyTarget.x);
      if (lateral <= this.D.reach) return 'bump';
      // 짝꿍이 블로킹해 혼자 뒤를 맡은 때에는 현재 위치만 보고 먼 스트레이트를
      // 즉시 MISS로 만들지 않고, 공의 남은 비행시간만큼 이동 기회를 준다.
      const coveringBehindBlock = who < 2 && this.pendingBlock?.digger === who;
      const moveAllowance = coveringBehindBlock
        ? Math.min(3.6, Math.max(0, tHit - this.time) * 4)
        : 1.2;
      return lateral <= this.D.reach + moveAllowance ? 'dig' : 'miss';
    }
    const t0 = tHit - CONTACT_K.bump * ANIM_SECONDS;
    const distance = Math.hypot(actor.x - bodyTarget.x, actor.z - bodyTarget.z);
    const remaining = Math.max(0, distance - 5.5 * Math.max(0, t0 - this.time));
    if (remaining <= .08) return 'bump';
    return remaining <= 2.2 ? 'dig' : 'miss';
  }

  shortChance() {
    if (this.shortChanceBoost) return 1;
    return { easy: .10, normal: .20, hard: .30 }[this.difficulty] ?? .20;
  }

  beginDefenseRead(attackingTeam, attacker, attackAt, blockerWho = null) {
    const defenders = attackingTeam === 'me' ? this.ai : this.players;
    const base = attackingTeam === 'me' ? 2 : 0;
    const candidates = defenders
      .map((actor, index) => ({ actor, index, who: base + index }))
      .filter(item => !item.actor.human && item.who !== blockerWho);
    if (!candidates.length) { this.defenseRead = null; return null; }
    const history = this.attackAimHistory.slice(-5);
    const historyAim = history.length ? history.reduce((sum, value) => sum + value, 0) / history.length : null;
    const positionAim = clamp(attacker.x / 3, -1, 1);
    let predictedAim = historyAim == null ? positionAim : .7 * historyAim + .3 * positionAim;
    const wave = Math.sin((++this.readingSequence) * 91.173 + this.rallyId * 17.719) * 43758.5453;
    const readSample = wave - Math.floor(wave);
    if (this.difficulty === 'easy' && readSample < .25) predictedAim = -predictedAim || (readSample < .125 ? -1 : 1);
    const predicted = { x: clamp(predictedAim * 3, -3, 3), z: attackingTeam === 'me' ? 5.2 : -5.2 };
    const chosen = candidates.reduce((best, item) => {
      const distance = Math.hypot(item.actor.x - predicted.x, item.actor.z - predicted.z);
      const bestDistance = Math.hypot(best.actor.x - predicted.x, best.actor.z - predicted.z);
      return distance < bestDistance ? item : best;
    });
    const ratio = { easy: .35, normal: .55, hard: .75 }[this.difficulty] ?? .55;
    const start = { x: chosen.actor.x, z: chosen.actor.z };
    chosen.actor.tx = start.x + (predicted.x - start.x) * ratio;
    chosen.actor.tz = start.z + (predicted.z - start.z) * ratio;
    chosen.actor.readingReady = false;
    this.defenseRead = { attackingTeam, defenderIndex: chosen.index, who: chosen.who, predicted, start, ratio, attackAt, ready: false };
    return this.defenseRead;
  }

  updateDefenseRead(t) {
    const read = this.defenseRead;
    if (!read || t >= read.attackAt || read.ready || t < read.attackAt - .3) return;
    const defender = this.actor(read.who);
    if (!defender || defender.human) return;
    read.ready = true; defender.readingReady = true; defender.readyWaiting = true;
  }

  readingChanceAdjustment(target) {
    const read = this.defenseRead;
    if (!read || read.attackingTeam !== 'me') return 0;
    const distance = Math.hypot(target.x - read.predicted.x, target.z - read.predicted.z);
    return distance > 2.5 ? -.25 : distance <= 1 ? .15 : 0;
  }

  get servingActorIndex() {
    if (this.phase === 'serve-toss') return this.serveToss.index + (this.serveToss.team === 'ai' ? 2 : 0);
    if (this.phase === 'serve-return') return this.serveReturn.index + (this.serveReturn.team === 'ai' ? 2 : 0);
    return this.phase === 'serve-ai' ? this.aiServerIndex + 2 : this.serverIndex;
  }

  placeServer(team, index) {
    const actor = team === 'me' ? this.players[index] : this.ai[index];
    actor.z = actor.tz = (team === 'me' ? -1 : 1) * (COURT.halfL + 1);
    this.serveAnchor = null; this.serveHitAnchor = null;
    this.serveHitFloatAnchor = null; this.serveHitJumpAnchor = null;
  }

  update(t, p0x = this.players[0].x, p1x = null) {
    const dt = Math.min(0.1, Math.max(0, t - this.time));
    this.time = t;
    const actors = [...this.players, ...this.ai];
    const previous = actors.map(p => ({ x: p.x, z: p.z }));
    const lockHumanPositions = this.phase === 'point' || this.presentation?.type === 'victory';
    this.players[0].human = p0x != null;
    this.players[0].label = p0x != null ? '1P' : '짝꿍';
    const p0Input = p0x == null ? this.players[0].x : clamp(p0x, -3.75, 3.75);
    if (p0x != null && !lockHumanPositions && !this.autoMove) this.players[0].x = p0Input;
    const second = this.competitive ? this.ai[0] : this.players[1];
    second.human = p1x != null;
    second.label = p1x != null ? '2P' : (this.competitive ? '2P 짝꿍' : '짝꿍');
    const p1Input = p1x == null ? second.x : clamp(p1x, -3.75, 3.75);
    if (p1x != null && !lockHumanPositions && !this.autoMove) second.x = p1Input;

    this.updateDefenseRead(t);

    for (const p of actors) {
      if (this.autoMove && p.approach && !lockHumanPositions) {
        const a = p.approach;
        if (t <= a.hold) {
          const u = clamp((t - a.start) / (a.end - a.start), 0, 1);
          const k = u * u * (3 - 2 * u);
          p.x = a.x + (a.tx - a.x) * k; p.z = a.z + (a.tz - a.z) * k;
          p.moveRemaining = Math.hypot(a.tx - p.x, a.tz - p.z);
          p.vx = 0; p.vz = 0;
          continue;
        }
        delete p.approach;
      }
      const targetChanged = !Number.isFinite(p.motionTargetX)
        || Math.hypot(p.tx - p.motionTargetX, p.tz - p.motionTargetZ) > .08;
      if (targetChanged) {
        p.motionTargetX = p.tx; p.motionTargetZ = p.tz;
        p.motionReadyUntil = t + .08;
      }
      const dx = p.tx - p.x, dz = p.tz - p.z, distance = Math.hypot(dx, dz);
      p.moveRemaining = distance;
      p.movePreparing = distance > .05 && t < (p.motionReadyUntil ?? 0);
      const maxSpeed = 7 * (p.effects?.agility ?? 1);
      // 우리 팀(학생·짝꿍)은 가속·감속을 8 → 15·12m/s²로 올려 1~2m짜리 짧은 이동도 걷지 않고 바로 달려 나간다(2026-10-05).
      // 상대 컴퓨터는 예전 값 그대로 둔다: 같이 올리면 상대 수비가 좋아져 중급 학생 승수가 더 떨어진다(시뮬레이션 측정).
      const mine = this.players.includes(p);
      const desiredSpeed = p.movePreparing ? 0 : Math.min(maxSpeed, Math.sqrt(2 * (mine ? 12 : 8) * distance));
      const desiredVx = distance > .001 && (!p.human || this.autoMove) ? dx / distance * desiredSpeed : 0;
      const desiredVz = distance > .001 ? dz / distance * desiredSpeed : 0;
      p.vx ??= 0; p.vz ??= 0;
      const steer = 1 - Math.exp(-dt / (mine ? .07 : .12));
      let changeX = (desiredVx - p.vx) * steer, changeZ = (desiredVz - p.vz) * steer;
      const change = Math.hypot(changeX, changeZ), maxChange = (mine ? 15 : 8) * dt;
      if (change > maxChange && change > 0) { changeX *= maxChange / change; changeZ *= maxChange / change; }
      p.vx += changeX; p.vz += changeZ;
      if (p.human && !this.autoMove) p.vx = 0;
      if (!p.human || this.autoMove) {
        const stepX = p.vx * dt;
        p.x = Math.abs(stepX) >= Math.abs(dx) ? p.tx : p.x + stepX;
      }
      const stepZ = p.vz * dt;
      p.z = Math.abs(stepZ) >= Math.abs(dz) ? p.tz : p.z + stepZ;
      if (distance < .015) { if (!p.human) p.x = p.tx; p.z = p.tz; p.vx = 0; p.vz = 0; }
    }
    if (!this.autoMove && this.players[0].human && !lockHumanPositions) this.applyMagnet(this.players[0], p0Input);
    if (!this.autoMove && second.human && !lockHumanPositions) this.applyMagnet(second, p1Input);
    actors.forEach((p, i) => {
      this.applySlide(p);
      const dx = p.x - previous[i].x, dz = p.z - previous[i].z;
      p.moveSpeed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
      p.running = p.moveSpeed > .8;
      if (p.running && p.moveRemaining >= .3) p.runYaw = Math.atan2(-dx, dz);
      if (p.readyWaiting && Math.hypot(p.x - p.tx, p.z - p.tz) < .12) p.atSetPosition = true;
      else if (p.readyWaiting) p.atSetPosition = false;
    });
    if (this.phase === 'point') this.updatePointPresentation(t);
    this.popups = this.popups.filter(p => t - p.t0 < 1.35);

    if (this.phase === 'serve-me') {
      const s = this.players[this.serverIndex];
      this.ball.stopAt(this.serveAnchor ?? { x: s.x + 0.34, y: 1.25, z: s.z + 0.08 });
      if (!s.human && t - this.phaseT > 1.25) this.beginServeToss('me', this.serverIndex, { source: 'ai', jump: false, power: .6 });
    } else if (this.phase === 'serve-ai') {
      const s = this.ai[this.aiServerIndex];
      this.ball.stopAt(this.serveAnchor ?? { x: s.x - 0.34, y: 1.25, z: s.z - 0.08 });
      if (!s.human && t - this.phaseT > 1.25) this.aiServe();
    } else if (this.phase === 'serve-toss') {
      this.updateServeToss(t);
    } else if (this.phase === 'serve-return') {
      if (t >= this.ball.tHit) {
        const retry = this.serveReturn;
        this.phase = `serve-${retry.team}`; this.phaseT = t; this.serveToss = null;
        this.ball.stopAt(retry.target); this.emit('serve-retry', { team: retry.team });
      }
    } else if (this.phase === 'rally') {
      this.updateRally(t);
    } else if (this.phase === 'point' && t - this.phaseT > (this.pointPresentation?.duration ?? 3.6)) {
      if (this.winner) {
        this.phase = 'over';
        this.emit('over', { winner: this.winner, score: this.score, stats: this.stats });
      } else this.startServe(this.practiceMode && this.practiceStage > 0 ? 'ai' : this.lastPoint);
    }
  }

  updateRally(t) {
    if (this.exp && !this.exp.done) {
      if (this.exp.buffered && t >= this.exp.tHit) this.resolvePlayer(this.exp.buffered);
      else if (t > this.exp.tHit + this.D.late) {
        const actor = this.actor(this.exp.who), landing = this.landing;
        const easyServeHelp = !this.autoMove && this.difficulty === 'easy' && this.exp.action === 'bump'
          && landing?.kind === 'receive' && landing.who === this.exp.who
          && Math.hypot(actor.x - landing.x, actor.z - landing.z) <= .95;
        // 도와주기(2026-10-05): 리시브·토스를 놓쳐도 난이도별 확률(D.assist)로 대신 약하게 받아 준다.
        // 자동 이동이 들어오며 위의 쉬움 도움이 꺼져서 중급 학생 승수가 쉬움 14/40까지 떨어졌다(목표 30~36).
        // 스파이크는 '의도한 내려치기만'(10월 2일 규칙)이라 돕지 않는다. 연습 모드는 동작을 익히는 곳이라 돕지 않는다.
        const assist = !easyServeHelp && !this.practiceMode && ['bump', 'set'].includes(this.exp.action)
          && Math.random() < (this.D.assist ?? 0);
        if (easyServeHelp) this.resolvePlayer({
          type: 'bump', playerIndex: this.exp.who, t: this.exp.tHit + this.D.perfect + .01,
        });
        else if (assist) this.resolvePlayer({
          type: this.exp.accepts[0], playerIndex: this.exp.who, t: this.exp.tHit + this.D.perfect + .01,
          quality: 'good', assisted: true,
        });
        else this.playerMiss(this.exp.who, 'MISS');
      }
    }
    if (this.blockExp && !this.blockExp.done) {
      if (this.blockExp.buffered && t >= this.blockExp.tHit) this.resolveBlock(this.blockExp.buffered);
      else if (t > this.blockExp.tHit + this.D.late) {
        this.blockExp.done = true;
        const blocker = this.actor(this.blockExp.who);
        if (blocker?.human) blocker.anim = { type: 'dive', t0: this.time };
      }
    }
    const due = this.jobs.filter(j => j.t <= t);
    this.jobs = this.jobs.filter(j => j.t > t);
    for (const job of due) if (this.phase === 'rally') job.run();
    if (this.phase === 'rally' && this.ball.active) {
      const p = this.ball.pos(t);
      // 느은 판정 창이나 컴퓨터의 예약 타격이 남아 있는 동안은 땅 판정을 미룬다.
      const waitingForContact = (this.exp && !this.exp.done)
        || this.jobs.some(j => j.t <= this.ball.tHit + this.D.late);
      const ground = this.ball.groundContact();
      if (p.y <= 0.12 && t > this.ball.t0 + 0.12 && !waitingForContact) this.ballDown(ground ?? p);
    }
  }

  schedule(t, run) { this.jobs.push({ t, run }); }

  // 사람의 블로킹 예약은 입력을 받은 뒤에만 점프 동작을 시작한다.
  startBlockMotion(who) {
    const anim = this.actor(who)?.anim;
    if (anim?.type === 'block' && anim.awaitingInput) {
      anim.awaitingInput = false;
      anim.jump = true;
      anim.t0 = this.time;
    }
  }

  // 자세 유지 알림은 판정 창에서만 소비한다. 블로킹 외의 자세는 준비 동작을 새로 만들지 않는다.
  onHeldGesture(type, who) {
    if (this.phase !== 'rally') return;
    const b = this.blockExp;
    if (type === 'block' && b && !b.done && who === b.who
      && this.time >= b.tHit - this.D.early && this.time <= b.tHit + this.D.late) {
      const g = { type, t: Math.max(this.time, b.tHit - this.D.perfect), jump: true, playerIndex: who, held: true };
      this.startBlockMotion(who);
      if (this.time > b.tHit) this.resolveBlock(g);
      else if (!b.buffered || b.buffered.type !== type) b.buffered = g;
      return;
    }
    const e = this.exp;
    if (e?.action === 'spike' && !e.push) return;
    if (!e || e.done || who !== e.who || !e.accepts.includes(type)
      || this.time < e.tHit - this.D.early || this.time > e.tHit + this.D.late) return;
    const overhandReceive = this.difficulty === 'normal' && e.action === 'bump' && type === 'set';
    const g = {
      type, t: Math.max(this.time, e.tHit - this.D.perfect), jump: false,
      playerIndex: who, aim: 0, kind: undefined, hand: undefined, held: true,
      quality: overhandReceive ? 'good' : undefined,
    };
    if (this.time > e.tHit) this.resolvePlayer(g);
    else if (!e.buffered || (e.buffered.type !== type && e.accepts.indexOf(type) <= e.accepts.indexOf(e.buffered.type))) e.buffered = g;
  }

  onGesture(type, extra = {}, playerIndex = extra.playerIndex ?? null) {
    if (this.phase === 'point' || this.phase === 'over') return;
    let who = playerIndex;
    if (who == null) {
      // 키보드는 현재 할 일이 있는 '사람' 선수에게만 적용한다.
      if (this.phase === 'serve-me' && this.players[this.serverIndex]?.human) who = this.serverIndex;
      else if (type === 'block' && this.blockExp && !this.blockExp.done && this.actor(this.blockExp.who).human) who = this.blockExp.who;
      else if (this.exp && !this.exp.done && this.actor(this.exp.who).human && this.exp.accepts.includes(type)) who = this.exp.who;
      else return;
    }
    const actor = this.actor(who);
    if (!actor?.human) return;
    if (extra.held) { this.onHeldGesture(type, who); return; }
    if (type === 'spike' && !extra.attackSource && this.exp?.action === 'spike' && Math.random() < this.debugTipRate) {
      type = 'tip'; extra = { ...extra, kind: 'tip' };
    }
    if (type === 'spike' && !extra.attackSource && this.time - this.lastAttackAt[who] <= .15) return;
    if (type === 'spike' && extra.attackSource) this.lastAttackAt[who] = this.time;
    if (type === 'jump') {
      this.lastJumpT[who] = this.time;
      if (actor.anim?.planned && this.time < actor.anim.t0 + ANIM_SECONDS) {
        actor.anim.jump = true;
        actor.anim.bodyJumpT0 = this.time;
      }
      else actor.anim = { type: 'jump', t0: this.time };
      return;
    }
    const jump = !!extra.jump || this.time - this.lastJumpT[who] < 0.7;
    const plannedActive = actor.anim?.planned && this.time < actor.anim.t0 + ANIM_SECONDS;
    if (!plannedActive) actor.anim = { type, t0: this.time, jump };
    else if (jump) actor.anim.jump = true;
    if (this.practiceMode && this.practiceStage >= 3 && type === 'block') {
      this.practiceBlockBuffered = { type: 'block', t: this.time, jump: true, playerIndex: who };
      if (this.blockExp && !this.blockExp.done && this.blockExp.who === who) {
        this.blockExp.buffered = { ...this.practiceBlockBuffered, t: this.blockExp.tHit };
        this.practiceBlockBuffered = null;
      }
      return;
    }
    if (this.practiceMode && this.practiceStage === 2 && ['spike', 'serve'].includes(type)) {
      this.practiceSpikeBuffered = { type: 'spike', t: this.time, jump, playerIndex: who };
      if (this.exp && !this.exp.done && this.exp.action === 'spike' && this.exp.who === who) {
        this.exp.buffered = { ...this.practiceSpikeBuffered, t: this.exp.tHit };
        this.practiceSpikeBuffered = null;
      }
      return;
    }
    if (this.phase === 'serve-me' || this.phase === 'serve-toss') return;
    if (this.phase !== 'rally') return;
    const g = { type, t: this.time, jump, playerIndex: who, aim: extra.aim ?? 0, kind: extra.kind, hand: extra.hand };
    const b = this.blockExp;
    if (type === 'block' && b && !b.done && who === b.who && this.time >= b.tHit - this.D.early) {
      this.startBlockMotion(who);
      if (this.time <= b.tHit) b.buffered = g; else this.resolveBlock(g);
      return;
    }
    const e = this.exp;
    if (e && !e.done && who === e.who && !e.accepts.includes(type)
      && this.time >= e.tHit - this.D.early && this.time <= e.tHit + this.D.late && !e.poseWarned) {
      const text = e.action === 'bump' ? '두 손을 모아 허리 앞으로!'
        : (e.action === 'set' ? '두 손을 이마 위로!' : null);
      if (text) { e.poseWarned = true; this.popup(text, '#ffb74d', actor.x, 3.2, actor.z); }
    }
    if (type === 'tip' && e && !e.done && (e.action === 'spike' || e.secondAttack) && who === e.who && this.time >= e.tHit - this.D.early) {
      const tip = { ...g, kind: 'tip', quality: Math.abs(this.time - e.tHit) <= this.D.perfect ? 'perfect' : 'good' };
      if (this.time > e.tHit) this.resolvePlayer(tip); else e.buffered = tip;
      return;
    }
    if (e && !e.done && who === e.who && e.accepts.includes(type) && this.time >= e.tHit - this.D.early) {
      const accepted = this.difficulty === 'normal' && e.action === 'bump' && type === 'set' ? { ...g, quality: 'good' } : g;
      if (this.time > e.tHit) this.resolvePlayer(accepted);
      else if (!e.buffered || e.accepts.indexOf(type) <= e.accepts.indexOf(e.buffered.type)) e.buffered = accepted;
    }
  }

  onAttack(event, playerIndex = event.playerIndex) {
    if (event?.kind !== 'spike') return false;
    const e = this.exp;
    if (!e || e.done || !(e.action === 'spike' || e.secondAttack) || e.who !== playerIndex) return false;
    this.onGesture('spike', { ...event, attackSource: true }, playerIndex);
    return true;
  }

  startServe(who) {
    const previousServer = this.servingTeam;
    this.servingTeam = who;
    this.lastTouch = null;
    this.teamHitCount = 0;
    this.rallyId++;
    this.rallyHighlight = null;
    this.pointReplay = false; this.pointReplayKind = null; this.pointReplayActor = null;
    this.pointPresentation = null;
    this.phase = `serve-${who}`;
    this.phaseT = this.time;
    this.serveAnchor = null;
    this.serveHitAnchor = null;
    this.serveHitFloatAnchor = null;
    this.serveHitJumpAnchor = null;
    this.serveToss = null;
    this.serveRetriesUsed = 0;
    this.serveFaultOwner = null;
    this.clearPlans();
    this.resetHomes();
    for (const actor of [...this.players, ...this.ai]) actor.anim = { type: 'idle', t0: this.time };
    // 점수 화면과 전환 플래시가 덮는 동안 AI 리시버를 기본 수비 위치에 세운다.
    // 서브 직전에 앞쪽 공격 자리에서 출발해 리시브를 놓치는 일을 막는다.
    const receivers = who === 'me' ? this.ai : this.players;
    for (const p of receivers) if (!p.human) {
      p.x = p.tx = p.homeX; p.z = p.tz = p.homeZ; p.vx = 0; p.vz = 0;
      p.motionTargetX = p.homeX; p.motionTargetZ = p.homeZ; p.motionReadyUntil = this.time;
    }
    if (who === 'me') {
      // 교실 게임의 사용자 지정 순서: 다음 우리 팀 서브는 나 → 파트너 → 나.
      if (this.practiceMode) this.serverIndex = this.players.findIndex(p => p.human);
      else { this.serverTurn = (this.serverTurn + 1) % 2; this.serverIndex = this.serverTurn; }
      const s = this.players[this.serverIndex];
      this.placeServer('me', this.serverIndex);
      this.emit('message', null);
    } else {
      if (previousServer !== 'ai' && !this.competitive) this.aiServerIndex = 1 - this.aiServerIndex;
      this.placeServer('ai', this.aiServerIndex);
      this.emit('message', { text: '상대 서브', sub: '분홍색 원을 보고 리시브 준비!' });
    }
  }

  aiServe() {
    const jumpChance = { easy: .10, normal: .35, hard: .60 }[this.difficulty];
    const range = { easy: [.2, .5], normal: [.35, .75], hard: [.55, .95] }[this.difficulty];
    const jump = Math.random() < jumpChance, power = rand(range[0], range[1]);
    this.beginServeToss('ai', this.aiServerIndex, { source: 'ai', jump, power });
  }

  setServeGeometry({ toss, hit, hitFloat, hitJump, standReach } = {}) {
    if (!['serve-me', 'serve-ai', 'serve-toss', 'serve-return'].includes(this.phase)) return;
    if (toss) this.serveAnchor = { ...toss };
    if (hit) this.serveHitAnchor = { ...hit };
    if (hitFloat) this.serveHitFloatAnchor = { ...hitFloat };
    if (hitJump) this.serveHitJumpAnchor = { ...hitJump };
    if (Number.isFinite(standReach)) this.serveStandReach = standReach;
  }

  onServeToss({ playerIndex = this.serverIndex, source = 'keyboard', hand = null, speed = 0 } = {}) {
    if (this.phase === 'serve-ai' && playerIndex === this.aiServerIndex + 2 && this.actor(playerIndex)?.human) {
      return this.beginServeToss('ai', this.aiServerIndex, { source, hand, speed });
    }
    if (this.phase !== 'serve-me' || playerIndex !== this.serverIndex || !this.players[playerIndex]?.human) return false;
    return this.beginServeToss('me', playerIndex, { source, hand, speed });
  }

  beginServeToss(team, index, data = {}) {
    if (this.phase === 'serve-toss') return;
    const actor = team === 'me' ? this.players[index] : this.ai[index];
    const contactAnchor = data.jump ? this.serveHitJumpAnchor : this.serveHitFloatAnchor;
    if (contactAnchor) this.serveHitAnchor = { ...contactAnchor };
    const start = { ...(this.serveAnchor ?? { x: actor.x, y: 1.25, z: actor.z }) };
    const direction = team === 'me' ? 1 : -1;
    const globalIndex = index + (team === 'ai' ? 2 : 0);
    const floatIdeal = this.serveIdeal(globalIndex, false);
    const jumpIdeal = this.serveIdeal(globalIndex, true);
    const trajectoryIdeal = (floatIdeal + jumpIdeal) / 2;
    const standReach = Math.max(1.8, this.serveStandReach || 2.35);
    const jumpReach = standReach + SERVE.jumpReach;
    const hitSide = Math.sign((this.serveHitAnchor?.x ?? actor.x) - start.x) || (team === 'me' ? 1 : -1);
    const estimatedApexT = Math.max(.8, Math.min(floatIdeal, jumpIdeal) - .4);
    const apexY = (standReach + jumpReach) / 2 + .2;
    const tossGravity = 2 * Math.max(.15, apexY - start.y) / (estimatedApexT * estimatedApexT);
    const estimatedTarget = data.jump ? jumpReach : standReach;
    const contactT = trajectoryIdeal;
    const hit = contactAnchor ?? {
      x: start.x + hitSide * SERVE.apexTowardHitHand,
      y: estimatedTarget,
      z: start.z + direction * SERVE.apexTowardNet,
    };
    // 토스가 내려오는 순간 공 중심이 실제 타격 손의 x/z에 오도록 수평 속도를 맞춘다.
    const apex = {
      x: start.x + (hit.x - start.x) * estimatedApexT / contactT,
      y: apexY,
      z: start.z + (hit.z - start.z) * estimatedApexT / contactT,
    };
    this.phase = 'serve-toss';
    this.phaseT = this.time;
    // 늦은 실제 스파이크 서브도 손에서 0.4m 이상 멀어지지 않도록 타격 구간의 느린 낙하를 유지한다.
    const tossFloorY = jumpReach - .4;
    const tossFloorUntil = Math.min(2.2, Math.max(floatIdeal, jumpIdeal) + .5);
    const tApex = this.ball.toss(start, apex, this.time, tossGravity, tossFloorY, tossFloorUntil);
    this.serveToss = { team, index, source: data.source, t0: this.time, start, apex, tApex,
      standReach, jumpReach, floatIdeal, jumpIdeal, trajectoryIdeal,
      tossGravity, signaled: false, jump: !!data.jump, power: data.power };
    this.emit('serve-toss-start', { team, playerIndex: index + (team === 'ai' ? 2 : 0) });
    if (data.source === 'ai') {
      this.serveToss.autoHitAt = this.time + (data.jump ? jumpIdeal : floatIdeal);
      const serveType = data.jump ? 'serveJump' : 'serveFloat';
      this.serveToss.plannedAnim = {
        type: serveType, jump: !!data.jump,
        t0: this.serveToss.autoHitAt - (CONTACT_K[serveType] ?? CONTACT_K.serve) * ANIM_SECONDS,
      };
    } else {
      actor.anim = { type: 'serveToss', t0: this.time };
    }
    this.emit('sound', 'tick'); this.emit('message', null);
    return true;
  }

  updateServeToss(t) {
    const toss = this.serveToss;
    if (!toss) return;
    if (toss.plannedAnim && !toss.animStarted && t >= toss.plannedAnim.t0) {
      const actor = toss.team === 'me' ? this.players[toss.index] : this.ai[toss.index];
      actor.anim = { ...toss.plannedAnim, planned: true };
      toss.animStarted = true;
    }
    const p = this.ball.pos(t);
    const keyboardJump = t - this.lastJumpT[toss.index + (toss.team === 'ai' ? 2 : 0)] < .7;
    const idealT = (toss.jump || keyboardJump) ? toss.jumpIdeal : toss.floatIdeal;
    if (!toss.signaled && Math.abs(t - toss.t0 - idealT) <= .08) {
      toss.signaled = true; this.emit('serve-timing', { team: toss.team, index: toss.index });
    }
    if (toss.autoHitAt && t >= toss.autoHitAt) {
      this.onServeHit({ playerIndex: toss.index, source: toss.source, jump: toss.jump, power: toss.power, forcedTiming: .9 });
      return;
    }
    if (t - toss.t0 >= SERVE.expireSeconds || (t - toss.t0 > toss.tApex && p.y < SERVE.dropHeight)) this.serveDropped();
  }

  onServeHit({ playerIndex = this.serverIndex, source = 'keyboard', power = null, jump = null, jumpPeak = 0, forcedTiming = null } = {}) {
    const toss = this.serveToss;
    const globalIndex = toss && toss.index + (toss.team === 'ai' ? 2 : 0);
    const expectedIndex = source === 'ai' ? toss?.index : globalIndex;
    if (this.phase !== 'serve-toss' || !toss || playerIndex !== expectedIndex || (source !== 'ai' && !this.actor(globalIndex)?.human)) return false;
    const actor = toss.team === 'me' ? this.players[toss.index] : this.ai[toss.index];
    const p = this.ball.pos(this.time);
    const jumpDt = Math.max(0, this.time - this.lastJumpT[globalIndex]);
    const didJump = jump ?? (jumpDt < .7);
    const serveType = didJump ? 'serveJump' : 'serveFloat';
    const serveT0 = this.time - (CONTACT_K[serveType] ?? CONTACT_K.serve) * ANIM_SECONDS;
    const elapsed = this.time - toss.t0;
    if (elapsed < SERVE.earliestHit || elapsed > SERVE.expireSeconds) {
      actor.anim = { type: serveType, t0: serveT0, jump: didJump };
      this.popup('헛스윙!', '#ff8a65', actor.x, 3.1, actor.z); this.emit('sound', 'miss');
      return false;
    }
    const idealT = didJump ? toss.jumpIdeal : toss.floatIdeal;
    let timingError = Math.abs(elapsed - idealT);
    // 공이 칠 높이 근처(손 높이보다 reachBand 아래까지)에 떠 있을 때 친 서브는 시간이 이상과 달라도 최소 '좋음'이다.
    // 스파이크 서브는 시간만 보면 이른 타이밍(1.1초 전)·늦은 타이밍(2.3초 뒤)에 절반이 네트·아웃으로 실패했다(2026-10-05 측정).
    const handReach = didJump ? toss.jumpReach : toss.standReach;
    if (p && p.y >= handReach - SERVE.reachBand) timingError = Math.min(timingError, SERVE.goodSeconds - .01);
    const timing = forcedTiming ?? (timingError <= SERVE.perfectSeconds ? 1 : timingError <= SERVE.goodSeconds ? .6 : .25);
    if (source === 'webcam' && this.serveHitAnchor) {
      const lateral = Math.abs(p.x - this.serveHitAnchor.x);
      if (lateral > SERVE.lateralMiss) {
        actor.anim = { type: serveType, t0: serveT0, jump: didJump };
        this.popup('헛스윙!', '#ff8a65', actor.x, 3.1, actor.z); this.emit('sound', 'miss');
        return false;
      }
    }
    let jumpScore = 1;
    if (didJump) {
      if (source === 'webcam') jumpScore = .5 + .5 * clamp(jumpPeak, 0, 1);
      else {
        const off = jumpDt < .2 ? .2 - jumpDt : Math.max(0, jumpDt - .4);
        jumpScore = 1 - Math.min(.5, off / .6);
      }
    }
    const hitPower = source === 'keyboard' ? timing : clamp(power ?? timing, 0, 1);
    const strength = clamp((.6 * hitPower + .4 * timing) * (didJump ? jumpScore : 1), 0, 1);
    this.rememberServeTiming(globalIndex, didJump, elapsed);
    if (!(actor.anim?.planned && actor.anim.type === serveType)) actor.anim = { type: serveType, t0: serveT0, jump: didJump };
    const grade = timing >= .75 ? '완벽!' : timing >= .45 ? '좋아!' : '아쉬워';
    this.popup(grade, timing >= .75 ? '#ffd54f' : timing >= .45 ? '#81c784' : '#ff8a65', actor.x, 3.4, actor.z);
    const hand = didJump ? this.serveHitJumpAnchor : this.serveHitFloatAnchor;
    const from = timing >= .45 ? { ...(hand ?? this.serveHitAnchor ?? p) } : p;
    this.launchServe(toss, from, didJump, strength, timing);
    return true;
  }

  launchServe(toss, from, jump, strength, timing) {
    const team = toss.team, actor = team === 'me' ? this.players[toss.index] : this.ai[toss.index];
    const attackWeight = actor.effects?.attack ?? 1;
    const effectiveStrength = clamp(strength * attackWeight, 0, 1);
    const bad = timing < .3 && this.difficulty !== 'easy';
    const badChance = jump ? .5 : .3;
    this.phase = 'rally'; this.serveToss = null; this.serveFaultOwner = null;
    this.beginRallyHighlights(team, toss.index + (team === 'ai' ? 2 : 0));
    actor.tz = actor.homeZ;
    this.emit('sound', 'spike');
    if (bad && Math.random() < badChance) {
      this.serveFaultOwner = team;
      const net = Math.random() < .6, direction = team === 'me' ? 1 : -1;
      const target = net
        ? { x: from.x * .55, y: .55, z: direction * .15 }
        : { x: (Math.random() < .5 ? -1 : 1) * 5.2, y: .12, z: direction * 8.6 };
      this.ball.launch(from, target, net ? .65 : 1.25, this.time, jump ? 'spike' : 'float');
      this.popup(net ? '네트!' : '아웃!', '#ef5350', actor.x, 3.0, actor.z);
      return;
    }
    const direction = team === 'me' ? 1 : -1;
    const depth = 3.7 + 3.0 * effectiveStrength;
    const targetX = this.practiceMode && team === 'ai'
      ? clamp((this.players.find(p => p.human)?.x ?? 0) + rand(-1.1, 1.1), -3.25, 3.25)
      : rand(-3.25, 3.25);
    const to = { x: targetX, y: HIT.bump, z: direction * depth };
    let flight = jump ? 1.5 + (.95 - 1.5) * effectiveStrength : 2.0 + (1.45 - 2.0) * effectiveStrength;
    if (this.practiceMode) flight /= .6;
    this.ball.launch(from, to, flight, this.time, jump ? 'spike' : 'float');
    this.ball.keepGroundInCourt();
    this.popup(jump ? '스파이크 서브!' : '플로터 서브', jump ? '#ff8a65' : '#4fc3f7', actor.x, 3.0, actor.z);
    this.emit(jump ? 'serve-spike' : 'serve-float', { strength: effectiveStrength, team, playerIndex: toss.index + (team === 'ai' ? 2 : 0) });
    this.emit('practice-action', { action: 'serve', team, playerIndex: toss.index + (team === 'ai' ? 2 : 0), quality: timing >= .75 ? 'perfect' : 'good' });
    if (effectiveStrength >= .85) this.emit('serve-power', { strength: effectiveStrength });
    if (team === 'me') {
      this.aiReceive(this.D.aiServeReceive - (jump ? .14 : .06) * effectiveStrength, null, false, 'serve');
    }
    else { actor.tz = actor.homeZ; this.prepareOurReceive('receive'); }
  }

  onServeExpired({ playerIndex = this.serverIndex } = {}) {
    if (this.phase === 'serve-toss' && this.servingActorIndex === playerIndex) this.serveDropped();
  }

  serveDropped() {
    const toss = this.serveToss;
    if (!toss) return;
    const canRetry = this.difficulty === 'easy' || (this.difficulty === 'normal' && this.serveRetriesUsed < 1);
    if (!canRetry) {
      this.serveToss = null; this.phase = 'rally'; this.emit('serve-fault', { team: toss.team });
      this.pointTo(toss.team === 'me' ? 'ai' : 'me');
      return;
    }
    this.serveRetriesUsed++;
    const from = this.ball.pos(this.time), target = { ...toss.start };
    this.phase = 'serve-return'; this.serveReturn = { team: toss.team, index: toss.index, target };
    this.serveToss = null; this.ball.returnTo(from, target, SERVE.returnSeconds, this.time);
  }

  legacyEasyServe(playerIndex = this.serverIndex) {
    if (this.difficulty !== 'easy' || !this.onServeToss({ playerIndex, source: 'legacy' })) return false;
    const toss = this.serveToss;
    toss.autoHitAt = this.time + toss.floatIdeal;
    toss.power = .8; toss.source = 'legacy'; return true;
  }

  prepareOurReceive(kind = 'receive', forcedWho = null) {
    const incoming = { ...this.ball.target };
    const tx = incoming.x;
    let who = forcedWho;
    if (who == null) {
      const soloBonus = this.players[1].human || Math.abs(this.players[0].x - tx) > this.D.reach ? 0 : 0.8;
      const costs = this.players.map((p, i) => Math.abs(p.x - tx) - (i === 0 ? soloBonus : 0));
      who = costs[1] < costs[0] ? 1 : 0;
    }
    const p = this.players[who];
    const plan = this.prepareSetter('me', who, incoming.x, kind);
    const receiveType = kind === 'tip' ? 'dig' : this.receiveMode(p, who, incoming, this.ball.tHit);
    plan.receiveType = receiveType;
    const offset = this.contactOffset(receiveType === 'dig' ? 'dig' : 'bump', who);
    p.tx = tx - offset.x; p.tz = incoming.z - offset.z;
    this.landing = { x: incoming.x, z: incoming.z, who, human: p.human, kind, receiveType };
    const done = q => this.ourBump(who, q, receiveType);
    if (receiveType === 'miss' && !p.human) {
      this.schedule(this.ball.tHit, () => { p.anim = { type: 'dive', t0: this.time, face: { x: incoming.x, z: incoming.z } }; });
      return;
    }
    this.retargetIncomingBall(who, receiveType);
    if (p.human) this.expect('bump', this.difficulty === 'hard' ? ['bump'] : ['bump', 'set'], who, done, receiveType);
    else {
      const chance = kind === 'free' ? 1 : (kind === 'receive'
        ? (receiveType === 'bump' ? this.D.mateServeReceive : this.D.mateDig - .15)
        : this.D.mateDig - (receiveType === 'dig' ? .15 : 0));
      this.computerHit(receiveType, who, chance, done);
    }
  }

  ourBump(who, quality, receiveType = 'bump') {
    this.markReceive(receiveType, 'me');
    const receiver = this.players[who], setterIndex = 1 - who, setter = this.players[setterIndex];
    const p = this.actualContactPoint(who, receiveType === 'dig' ? 'dig' : 'bump');
    if (!this.recordTouch(who, receiveType, p)) return;
    this.landing = null;
    if (receiveType === 'dig') {
      this.stats.digs++;
      this.popup('슬라이딩 디그!', '#ffd54f', receiver.x, 2.1, receiver.z);
      this.emit('dig-success', { team: 'me', playerIndex: who });
    }
    if (this.teamHitCount === 2) {
      // 블록이 첫 터치였다면 이 수비는 두 번째다. 짝꿍에게 바로 올려 세 번째 공격으로 끝낸다.
      this.chain = { bump: quality, set: quality, setType: 'underSet', attacker: setterIndex,
        attackTarget: { x: setter.x, z: SPIKE_Z } };
      this.ourSet(who, setterIndex, quality, p);
      return;
    }
    const plan = this.receivePlan?.team === 'me' ? this.receivePlan : null;
    const pass = this.passTarget(plan, quality, receiveType);
    const highReceive = plan?.kind === 'receive';
    const underMiss = this.difficulty === 'hard' ? 1.12 : 1.0;
    const useUnder = !highReceive && (receiveType === 'dig' || pass.miss > underMiss);
    const setType = useUnder ? 'underSet' : 'set';
    const attackTarget = { x: receiver.x, z: SPIKE_Z };
    this.chain = { bump: quality, attacker: who, setter: setterIndex, setType, receiveType, attackTarget,
      freeBall: plan?.kind === 'free' };
    this.emit('sound', 'hit');
    receiver.tz = -4.8;
    setter.tx = pass.x; setter.tz = pass.z;
    if (plan) plan.passMiss = pass.miss;
    this.setPosition = { x: setter.tx, z: setter.tz, who: setterIndex, human: !!setter.human, team: 'me' };
    setter.roleLabel = useUnder ? '언더 토스' : null;
    const setT = highReceive ? 1.7 : (useUnder ? (receiveType === 'dig' ? rand(.58, .70) : .72) : 1.35 / this.D.speed);
    const setTarget = this.contactPoint(setterIndex, setType, this.time + setT);
    this.ball.launch(p, setTarget, setT, this.time);
    const done = q => this.ourSet(setterIndex, who, q);
    if (setter.human) {
      // 토스 차례: 두 손 토스 → 짝꿍이 공격. 내려치거나 팁을 하면 **이단 공격**(두 번째 터치로 바로 상대에게 넘기기).
      // 2026-10-05 선생님: "우리편이 수비한 뒤 내가 상대에게 이단으로 넘기는 게 되도록"
      this.expect('set', ['set', 'bump', 'spike', 'tip'], setterIndex,
        (q, soft, g = {}) => (g.type === 'spike' || g.type === 'tip' || g.kind === 'tip') ? this.secondTouchAttack(setterIndex, q, g) : done(q),
        setType, { secondAttack: true });
      if (this.difficulty !== 'hard') this.hintOnce('second:' + setterIndex, '내려치면 이단 공격!', setter);
    }
    else this.computerHit(setType, setterIndex, this.practiceMode ? 1 : 0.98, done);
  }

  // 처음 한 번만 뜨는 안내(선수별). 연습 모드에서는 띄우지 않는다
  hintOnce(key, text, actor) {
    this.shownHints ??= new Set();
    if (this.practiceMode || this.shownHints.has(key)) return;
    this.shownHints.add(key);
    this.popup(text, '#ffb74d', actor.x, 3.3, actor.z);
  }

  // 이단 공격: 짝꿍이 받은 공(첫 터치)을 사람 세터가 두 번째 터치로 바로 상대 코트에 넘긴다(비치발리볼의 투터치 공격).
  // 우리 팀(who 0·1)과 대결 모드의 2P 팀(who 2·3) 모두 쓴다(2026-10-05: 처음엔 1P 쪽만 있어 2P가 내려치면 MISS였다).
  // 공은 토스를 기다리던 그 자리에서 출발하므로 위치가 튀지 않는다. 느린 포물선이라 상대가 받을 수 있다.
  secondTouchAttack(who, quality, attack = {}) {
    const a = this.actor(who), mine = who < 2, side = mine ? 1 : -1;
    const p = { ...(this.ball.pos(this.time) ?? this.ball.target) };
    if (!this.recordTouch(who, 'spike', p)) return;
    const tip = attack.type === 'tip' || attack.kind === 'tip';
    const aim = clamp(Number.isFinite(attack.aim) ? attack.aim : 0, -1, 1);
    this.markAttack(tip ? 'tip' : 'spike', mine ? 'me' : 'ai', who);
    if (mine) { if (tip) this.stats.tips++; else this.stats.spikes++; }
    this.emit('sound', tip ? 'hit' : 'spike');
    this.setPosition = null;
    if (mine) this.chain = null; else this.aiChain = null;
    a.roleLabel = null; a.readyWaiting = false; a.atSetPosition = false;
    const spread = (quality === 'perfect' ? .35 : .8) * (a.effects?.accuracyError ?? 1);
    const tz = side * (tip ? rand(1.4, 3.0) : rand(3.2, 6.2));
    const tx = clamp(aim * 2.6 + rand(-spread, spread), -3.0, 3.0);
    const T = tip ? rand(1.4, 1.8) : (quality === 'perfect' ? rand(1.25, 1.4) : rand(1.45, 1.7));
    if (a.anim) Object.assign(a.anim, { type: tip ? 'tip' : 'spike', aim, style: tip ? (tz < 2.2 ? 'poke' : 'cobra') : undefined, planned: false });
    this.popup(tip ? '팁!' : '이단 공격!', '#ffb74d', a.x, 3.2, a.z);
    this.ball.launch(p, { x: tx, y: HIT.bump, z: tz }, T, this.time, null);
    this.ball.keepGroundInCourt();
    this.rivalBlock = null; this.defenseRead = null; this.pendingBlock = null; this.blockZone = null;
    if (!mine) { this.prepareOurReceive(tip ? 'tip' : 'dig'); return; }
    const receiver = Math.abs(this.ai[0].x - tx) <= Math.abs(this.ai[1].x - tx) ? 0 : 1;
    // 느린 공이라 강타보다 받기 쉽다. 정확하게(PERFECT) 치면 받기 어렵다.
    const chance = clamp(this.D.aiDig + .08 - (quality === 'perfect' ? .12 : 0), .25, .85);
    this.aiReceive(tip ? .94 : chance, receiver, tip, 'attack');
  }

  ourSet(setterIndex, attackerIndex, quality, passContact = null) {
    const setter = this.players[setterIndex], attacker = this.players[attackerIndex];
    const p = passContact ?? this.actualContactPoint(setterIndex, this.chain?.setType ?? 'set');
    if (!passContact && !this.recordTouch(setterIndex, this.chain?.setType ?? 'set', p)) return;
    if (this.chain) this.chain.set = quality;
    const under = this.chain?.setType === 'underSet';
    setter.roleLabel = null; setter.readyWaiting = false; setter.atSetPosition = false; this.setPosition = null;
    this.emit('sound', 'hit'); attacker.tz = SPIKE_Z;
    const plannedAttackX = this.chain?.attackTarget?.x ?? (attacker.human ? attacker.x : p.x);
    attacker.tx = clamp(plannedAttackX + (under ? rand(-.3, .3) : 0), -3, 3);
    const spikeT = 1.2 / this.D.speed;
    const spikeTarget = this.contactPoint(attackerIndex, 'spike', this.time + spikeT);
    this.ball.launch(p, spikeTarget, spikeT, this.time);
    if (!this.practiceMode) {
      const index = Math.abs(this.ai[0].x - attacker.x) <= Math.abs(this.ai[1].x - attacker.x) ? 0 : 1;
      this.rivalBlock = { index, x: attacker.x };
      this.ai[index].tx = attacker.x; this.ai[index].tz = .45;
    }
    this.beginDefenseRead('me', attacker, this.ball.tHit, this.rivalBlock ? this.rivalBlock.index + 2 : null);
    const done = (q, soft = false, attack = {}) => this.ourSpike(attackerIndex, q, soft, attack);
    if (attacker.human) {
      // 블록(첫 터치) → 짝꿍 수비(두 번째) 뒤에는 내가 세 번째 터치라 공격만 가능하다(passContact가 있는 경우).
      // 이때 토스(두 손 올리기)·리시브 동작을 해도 실패 대신 팁으로 넘겨 준다(2026-10-05 선생님: "내가 블로킹, 우리편이 수비했을 때 토스가 잘 안 된다").
      // 평소 세 번째 터치는 의도한 내려치기만 인정한다(10월 2일 규칙 유지).
      const push = !!passContact;
      this.expect('spike', push ? ['spike', 'set', 'bump'] : ['spike'], attackerIndex, done, 'spike', { push });
      if (push) this.hintOnce('push:' + attackerIndex, '세 번째 터치! 넘기세요', attacker);
      if (this.practiceMode && this.practiceSpikeBuffered?.playerIndex === attackerIndex) {
        this.exp.buffered = { ...this.practiceSpikeBuffered, t: this.exp.tHit };
        this.practiceSpikeBuffered = null;
      }
    }
    else this.computerHit('spike', attackerIndex, 0.92, done);
  }

  ourSpike(who, quality, soft, attack = {}) {
    const a = this.players[who], p = this.actualContactPoint(who, attack.kind === 'tip' ? 'tip' : 'spike');
    if (!this.recordTouch(who, attack.kind === 'tip' ? 'tip' : 'spike', p)) return;
    const isTip = attack.kind === 'tip';
    const aim = clamp(Number.isFinite(attack.aim) ? attack.aim : (a.human ? 0 : this.chooseAttackAim(this.ai)), -1, 1);
    const jump = a.anim?.jump ?? true;
    const chainPerfect = this.chain?.setType === 'set' && this.chain?.bump === 'perfect' && this.chain?.set === 'perfect';
    const power = (jump ? 1 : 0) + (quality === 'perfect' ? 1 : 0) + (chainPerfect ? 1 : 0);
    if (!isTip && power >= 2) this.emit('strong-spike', { power });
    if (!a.human && !soft && Math.random() < this.shortChance()) soft = true;
    const tip = isTip || soft;
    this.markAttack(tip ? 'tip' : 'spike', 'me', who);
    if (tip) this.stats.tips++; else this.stats.spikes++;
    this.emit('sound', tip ? 'hit' : 'spike');
    let tz = tip ? rand(1.2, 3.2) : rand(3.4, quality === 'perfect' ? 5.2 : 5.7);
    const spread = (quality === 'perfect' ? .3 : .7) * (a.effects?.accuracyError ?? 1);
    let tx = clamp(aim * (tip ? 2.5 : 2.4) + rand(-spread, spread), -2.8, 2.8);
    const timingMiss = !tip && a.human && this.applyAttackTiming(attack, quality, 1);
    if (timingMiss) { tx = timingMiss.x ?? tx; tz = timingMiss.z ?? tz; }
    else if (!tip) tx = this.safeSpikeX(p, tx);
    const readAdjustment = tip ? 0 : this.readingChanceAdjustment({ x: tx, z: tz });
    if (!tip && this.defenseRead?.attackingTeam === 'me') {
      const read = this.defenseRead, defender = this.actor(read.who);
      const actualDistance = Math.hypot(tx - read.predicted.x, tz - read.predicted.z);
      const preMove = defender ? Math.hypot(defender.x - read.start.x, defender.z - read.start.z) : 0;
      Object.assign(read, { actual: { x: tx, z: tz }, actualDistance, preMove, adjustment: readAdjustment });
      this.readingLog.push({ ...read, predicted: { ...read.predicted }, start: { ...read.start }, actual: { ...read.actual } });
      if (actualDistance > 2.5 && a.human) this.deceptionPending = true;
    }
    this.attackAimHistory.push(aim);
    if (this.attackAimHistory.length > 5) this.attackAimHistory.shift();
    const nearestDefenderGap = Math.min(...this.ai.map(defender => Math.abs(defender.x - tx)));
    const openCourtPenalty = nearestDefenderGap > 1.5 ? .10 : 0;
    const style = tz < 2.2 ? 'poke' : 'cobra';
    if (a.anim) Object.assign(a.anim, { type: tip ? 'tip' : 'spike', aim, style: tip ? style : undefined, planned: false });
    if (tip) this.popup('팁!', '#ffd54f', a.x, 3.2, a.z);
    else if (Math.abs(aim) >= .5) this.popup(Math.sign(aim) === Math.sign(a.x || aim) ? '스트레이트!' : '크로스!', '#ffb74d', a.x, 3.2, a.z);
    const attackWeight = a.effects?.attack ?? 1;
    this.ball.launch(p, { x: tx, y: HIT.bump, z: tz }, tip ? rand(1.4, 1.8) : Math.max(0.72, (1.15 - 0.12 * power) / attackWeight), this.time, tip ? 'tip' : 'spike');
    if (timingMiss) { this.rivalBlock = null; this.defenseRead = null; return; }
    this.ball.keepGroundInCourt();
    let receiver = null;
    if (!tip && this.rivalBlock) {
      const { index, x } = this.rivalBlock, who = index + 2;
      receiver = 1 - index;
      const tHit = Math.max(this.time, this.ball.timeAtZ(0) + .05);
      this.blockExp = { who, x, tHit, done: false, buffered: null };
      this.planAnim(this.actor(who), 'block', tHit, true, { x, y: HIT.block, z: .55 });
      if (this.practiceMode && this.practiceBlockBuffered?.playerIndex === who) {
        this.blockExp.buffered = { ...this.practiceBlockBuffered, t: tHit };
        this.practiceBlockBuffered = null;
      }
      this.blockZone = { x, who, z: .55 };
      if (!this.actor(who).human) this.schedule(tHit, () => this.autoBlock(who));
    }
    this.rivalBlock = null;
    if (receiver == null) receiver = this.defenseRead?.attackingTeam === 'me'
      ? this.defenseRead.defenderIndex
      : (Math.abs(this.ai[0].x - tx) <= Math.abs(this.ai[1].x - tx) ? 0 : 1);
    // 강타의 이점을 유지하면서 준비된 상대가 디그 후 반격할 여지를 준다.
    const freeBallAttackBonus = this.chain?.freeBall ? .10 : 0;
    // 읽기가 맞았을 때의 +0.15는 기존 난이도의 기본 수비율을 올리지 않고,
    // 방향을 읽어 움직인 보상으로만 작동하게 상쇄한다.
    const balance = this.defenseRead?.attackingTeam === 'me' ? .15 : 0;
    const defenseChance = this.D.aiDig - balance - .06 * Math.max(0, power - 1) - (attackWeight - 1) * .35 - openCourtPenalty - freeBallAttackBonus + readAdjustment;
    this.aiReceive(tip ? .94 : defenseChance, receiver, tip, tip ? 'tip' : 'spike');
  }

  applyAttackTiming(attack, quality, side) {
    const error = Number.isFinite(attack.timingError) ? attack.timingError : 0;
    const window = error < 0 ? this.D.early : this.D.late;
    const outThreshold = this.D.perfect + .8 * Math.max(0, window - this.D.perfect);
    if (Math.abs(error) <= outThreshold) return null;
    // 너무 일찍 치면 길게, 늦게 치면 옆으로 빗나간다. 수비가 아웃 공을 안쪽으로 보정하지 않는다.
    const miss = error < 0 ? { z: side * (COURT.halfL + 1.2) }
      : { x: (attack.aim < 0 ? -1 : 1) * (COURT.halfW + 1.2) };
    this.popup(error < 0 ? '너무 빨라요!' : '늦었어요!', '#ff8a65', 0, 3.4, side < 0 ? 1 : -1);
    return miss;
  }

  safeSpikeX(from, targetX) {
    // 수비 높이(.9m)를 지난 뒤 지면까지 이어지는 궤적도 라인 안에 들어오게 한다.
    const extension = Math.pow((from.y - .12) / (from.y - HIT.bump), 1 / 1.35);
    if (!Number.isFinite(extension) || extension < 1) return targetX;
    const margin = COURT.halfW - .35;
    return clamp(targetX, from.x + (-margin - from.x) / extension, from.x + (margin - from.x) / extension);
  }

  chooseAttackAim(defenders) {
    if (Math.random() >= .6) return rand(-1, 1);
    const options = [-1, 0, 1];
    return options.reduce((best, aim) => {
      const x = aim * 3;
      const gap = Math.min(...defenders.map(p => Math.abs(p.x - x)));
      const bestGap = Math.min(...defenders.map(p => Math.abs(p.x - best * 3)));
      return gap > bestGap ? aim : best;
    }, 0);
  }

  // options: { secondAttack } 토스 차례에 내려치면 이단 공격 · { push } 세 번째 터치에 토스 동작을 해도 넘긴다
  expect(action, accepts, who, next, animType = action, options = {}) {
    if (this.autoMove) this.ball.contactHoldUntil = this.ball.tHit + this.D.late;
    this.exp = { action, animType, accepts, who, next, tHit: this.ball.tHit, t0: this.ball.t0, hitX: this.ball.target.x, hitZ: this.ball.target.z, done: false, buffered: null, ...options };
    this.planAnim(this.actor(who), animType, this.exp.tHit, false, this.ball.target);
    if (action === 'spike') this.actor(who).anim.awaitingInput = true;
  }

  computerHit(action, who, probability, next) {
    const tHit = this.ball.tHit;
    this.planAnim(this.players[who], action, tHit, action === 'spike', this.ball.target);
    this.schedule(tHit, () => {
      const actor = this.players[who];
      if (Math.random() > probability) { actor.anim = { type: 'dive', t0: this.time }; return; }
      const perfectChance = this.difficulty === 'hard' ? .15 : .55;
      next(action === 'bump' && Math.random() < perfectChance ? 'perfect' : 'good');
    });
  }

  resolvePlayer(g) {
    const e = this.exp;
    if (!e || e.done) return;
    e.done = true;
    const actor = this.actor(e.who), p = this.ball.pos(this.time);
    const allowedReach = (e.animType === 'dig' ? this.D.reach + 1.2 : this.D.reach) * (actor.effects?.reach ?? 1);
    // 학생 입력은 좌우(x)만 직접 조작하고 앞뒤(z)는 캐릭터가 자동 이동한다.
    if (Math.abs(actor.x - e.hitX) > allowedReach) {
      this.playerMiss(e.who, actor.x < e.hitX ? '더 오른쪽으로! →' : '← 더 왼쪽으로!');
      return;
    }
    const q = g.quality ?? (Math.abs(g.t - e.tHit) <= this.D.perfect ? 'perfect' : 'good');
    if (g.assisted) {
      // 학생이 놓친 공을 게임이 도와 받은 것: 결과의 PERFECT·GOOD 횟수에 넣지 않고, 놓쳤다는 것을 알 수 있게 표시한다
      this.stats.assist = (this.stats.assist ?? 0) + 1;
      this.popup('아슬아슬!', '#b0bec5', actor.x, 3.0, actor.z);
    } else {
      this.stats[q]++;
      this.popup(q === 'perfect' ? 'PERFECT!' : 'GOOD', q === 'perfect' ? '#ffd54f' : '#81c784', actor.x, 3.0, actor.z);
    }
    const secondAttackHit = !!e.secondAttack && ['spike', 'tip'].includes(g.type);   // 토스 차례에 내려치기 = 이단 공격
    if (actor.anim) {
      if (e.action === 'spike' || secondAttackHit) {
        actor.anim.type = g.kind === 'tip' || g.type === 'tip' ? 'tip' : 'spike';
        actor.anim.jump = !!g.jump;
        actor.anim.awaitingInput = false;
      }
      if (this.autoMove) actor.anim.t0 = this.time - (CONTACT_K[actor.anim.type] ?? .5) * ANIM_SECONDS;
      actor.anim.planned = false;
      if (this.autoMove && actor.approach) actor.approach.hold = this.time + .04;
    }
    if (!g.assisted) {
      this.emit('practice-action', { action: e.action, team: e.who < 2 ? 'me' : 'ai', playerIndex: e.who, quality: q });
      this.emit('player-action', { action: e.action, team: e.who < 2 ? 'me' : 'ai', playerIndex: e.who, quality: q });
    }
    if (e.action === 'spike') {
      g = { ...g, timingError: g.t - e.tHit };
      if (g.kind === 'tip' || g.type === 'tip') e.next(q, true, { ...g, kind: 'tip' });
      else if (!['spike', 'serve'].includes(g.type)) e.next(q, true, g);
      else e.next(q, false, g);
    } else e.next(q, false, g);   // 3번째 인자: 어떤 동작이었는지(토스 차례의 이단 공격 구분용)
  }

  playerMiss(who, text) {
    if (this.exp) this.exp.done = true;
    this.stats.miss++;
    const p = this.actor(who) ?? this.players[0];
    p.anim = { type: 'dive', t0: this.time };
    this.popup(text, '#ef5350', p.x, 3.0, p.z); this.emit('sound', 'miss');
  }

  aiReceive(probability, forcedWho = null, forceDig = false, kind = 'attack') {
    if (this.practiceMode && this.practiceStage >= 3) probability = 1;
    if (this.competitive) probability = forcedWho == null ? this.D.mateReceive : this.D.mateDig;
    const incoming = { ...this.ball.target }, tx = incoming.x;
    const index = forcedWho ?? (Math.abs(this.ai[0].x - tx) - (this.competitive ? .8 : 0) <= Math.abs(this.ai[1].x - tx) ? 0 : 1);
    const r = this.ai[index];
    probability += r.effects?.receiveChance ?? 0;
    let success = Math.random() < clamp(probability, 0.04, 0.97);
    const setter = this.ai.find(a => a !== r);
    const plan = this.prepareSetter('ai', index, incoming.x, kind === 'serve' ? 'receive' : 'dig');
    const who = index + 2;
    let receiveType = forceDig ? 'dig' : this.receiveMode(r, who, incoming, this.ball.tHit);
    if (!forceDig && kind === 'spike' && receiveType !== 'miss' && !r.human) {
      const offset = this.contactOffset('bump', who);
      const move = Math.hypot(r.x - (incoming.x - offset.x), r.z - (incoming.z - offset.z));
      if (move > .8) receiveType = 'dig';
    }
    // 서브는 충분히 예측하고 출발하므로 먼 공도 슬라이딩 리시브를 시도한다.
    // 스파이크 수비의 거리 판정은 그대로 둔다.
    if (kind === 'serve' && receiveType === 'miss') {
      const reachAssist = { easy: 1, normal: .65, hard: .80 }[this.difficulty] ?? .8;
      if (Math.random() < reachAssist) receiveType = 'dig';
    }
    plan.receiveType = receiveType;
    if (receiveType === 'miss') success = false;
    const offset = this.contactOffset(receiveType === 'dig' ? 'dig' : 'bump', who);
    r.tx = (success ? tx : clamp(tx + rand(-1.7, 1.7), -3.6, 3.6)) - offset.x;
    r.tz = incoming.z - offset.z;
    const quality = Math.random() < clamp(probability * .65, .25, .8) ? 'perfect' : 'good';
    if (r.human) {
      this.retargetIncomingBall(who, receiveType);
      this.landing = { x: incoming.x, z: incoming.z, who, human: true, kind: plan.kind, receiveType };
      this.expect('bump', this.difficulty === 'hard' ? ['bump'] : ['bump', 'set'], who, q => this.aiBump(r, setter, q, receiveType), receiveType);
      return;
    }
    if (success) this.retargetIncomingBall(who, receiveType);
    if (this.competitive) this.landing = { x: incoming.x, z: incoming.z, who, human: false, kind: plan.kind, receiveType };
    if (success) this.planAnim(r, receiveType, this.ball.tHit, false, this.ball.target);
    this.schedule(this.ball.tHit, () => {
      if (success) this.aiBump(r, setter, quality, receiveType);
      else r.anim = { type: 'dive', t0: this.time };
    });
  }

  aiBump(r, setter, quality = 'good', receiveType = 'bump') {
    this.markReceive(receiveType, 'ai');
    this.landing = null;
    const receiverWho = 2 + this.ai.indexOf(r);
    const p = this.actualContactPoint(receiverWho, receiveType === 'dig' ? 'dig' : 'bump');
    if (!this.recordTouch(receiverWho, receiveType, p)) return;
    if (receiveType === 'dig') this.emit('dig-success', { team: 'ai', playerIndex: receiverWho });
    if (this.teamHitCount === 2) {
      this.aiChain = { setType: 'underSet', quality, receiveType,
        attacker: this.ai.indexOf(setter), weakAttackChance: .35 };
      this.aiSet(r, setter, p);
      return;
    }
    this.emit('sound', 'hit');
    const plan = this.receivePlan?.team === 'ai' ? this.receivePlan : null;
    const pass = this.passTarget(plan, quality, receiveType);
    const highReceive = plan?.kind === 'receive';
    const underMiss = this.difficulty === 'hard' ? 1.12 : 1.0;
    const useUnder = !highReceive && (receiveType === 'dig' || pass.miss > underMiss);
    const setType = useUnder ? 'underSet' : 'set';
    setter.tx = pass.x; setter.tz = pass.z; setter.roleLabel = useUnder ? '언더 토스' : null;
    if (plan) plan.passMiss = pass.miss;
    const who = 2 + this.ai.indexOf(setter), setT = highReceive ? 1.7 : (useUnder ? (receiveType === 'dig' ? rand(.58, .70) : .72) : 1.25 / this.D.speed);
    this.setPosition = { x: setter.tx, z: setter.tz, who, human: !!setter.human, team: 'ai' };
    const recoveryWeakChance = { easy: .90, normal: .75, hard: .40 }[this.difficulty] ?? .75;
    this.aiChain = {
      setType, quality, receiveType, attacker: this.ai.indexOf(r),
      attackTarget: { x: r.x, z: -SPIKE_Z },
      weakAttackChance: plan?.kind === 'dig'
        ? Math.min(1, recoveryWeakChance + (receiveType === 'dig' ? .20 : 0))
        : null,
    };
    const setTarget = this.contactPoint(who, setType, this.time + setT);
    this.ball.launch(p, setTarget, setT, this.time);
    if (setter.human) {
      // 대결 모드 2P 세터도 내려치면 이단 공격(1P와 같은 규칙)
      this.expect('set', ['set', 'bump', 'spike', 'tip'], who,
        (q, soft, g = {}) => (g.type === 'spike' || g.type === 'tip' || g.kind === 'tip') ? this.secondTouchAttack(who, q, g) : this.aiSet(setter, r),
        setType, { secondAttack: true });
      if (this.difficulty !== 'hard') this.hintOnce('second:' + who, '내려치면 이단 공격!', setter);
    }
    else { this.planAnim(setter, setType, this.ball.tHit, false, this.ball.target); this.schedule(this.ball.tHit, () => this.aiSet(setter, r)); }
  }

  aiSet(setter, spiker, passContact = null) {
    const setterWho = 2 + this.ai.indexOf(setter);
    const p = passContact ?? this.actualContactPoint(setterWho, this.aiChain?.setType ?? 'set');
    if (!passContact && !this.recordTouch(setterWho, this.aiChain?.setType ?? 'set', p)) return;
    const under = this.aiChain?.setType === 'underSet';
    setter.roleLabel = null; setter.readyWaiting = false; setter.atSetPosition = false; this.setPosition = null;
    this.emit('sound', 'hit');
    const spikeX = clamp(spiker.x + (under ? rand(-.3, .3) : 0), -3.1, 3.1);
    spiker.tx = spikeX; spiker.tz = 1.0;
    const who = 2 + this.ai.indexOf(spiker), spikeT = 1.05 / this.D.speed;
    const spikeTarget = this.contactPoint(who, 'spike', this.time + spikeT);
    this.ball.launch(p, spikeTarget, spikeT, this.time);
    const weakChance = Number.isFinite(this.aiChain?.weakAttackChance) ? this.aiChain.weakAttackChance : this.shortChance();
    const weakRoll = !spiker.human && !(this.practiceMode && this.practiceStage >= 3) ? Math.random() : 1;
    const soft = weakRoll < weakChance;
    const attackKind = soft && Number.isFinite(this.aiChain?.weakAttackChance) ? 'free' : (soft ? 'tip' : 'spike');
    if (!soft) this.prepareBlock(spikeX);
    this.beginDefenseRead('ai', spiker, this.ball.tHit, this.pendingBlock?.who ?? null);
    // 네트 앞 블로커는 깊은 공 수비수로 세지 않고, 뒤의 크로스 수비 위치만 보고 공격 방향을 고른다.
    const deepDefenders = !soft && this.pendingBlock ? [this.players[this.pendingBlock.digger]] : this.players;
    const aim = this.chooseAttackAim(deepDefenders);
    if (spiker.human) {
      const push = !!passContact;   // 블록(1)+수비(2) 뒤의 세 번째 터치: 토스·리시브 동작도 팁으로 넘긴다(1P와 같은 규칙)
      this.expect('spike', push ? ['spike', 'set', 'bump'] : ['spike'], who, (q, softHit, attack = {}) => this.aiSpike(spiker, !!softHit, { ...attack, quality: q }), 'spike', { push });
      if (push) this.hintOnce('push:' + who, '세 번째 터치! 넘기세요', spiker);
    }
    else {
      this.planAnim(spiker, 'spike', this.ball.tHit, true, this.ball.target);
      if (spiker.anim) spiker.anim.aim = aim;
      this.schedule(this.ball.tHit, () => this.aiSpike(spiker, soft, { aim, kind: attackKind }));
    }
  }

  prepareBlock(x) {
    const practiceHuman = this.practiceMode && this.practiceStage >= 3 ? this.players.findIndex(p => p.human) : -1;
    const who = practiceHuman >= 0 ? practiceHuman : (Math.abs(this.players[0].x - x) <= Math.abs(this.players[1].x - x) ? 0 : 1);
    const digger = 1 - who, blocker = this.players[who], defender = this.players[digger];
    const crossX = Math.abs(x) < .35 ? 0 : clamp(-Math.sign(x) * 1.2, -2.2, 2.2);
    blocker.tx = x; blocker.tz = -0.45;
    defender.tx = crossX; defender.tz = -5.3; defender.readyWaiting = true; defender.atSetPosition = false;
    this.blockZone = { x, who };
    this.pendingBlock = { who, digger, x };
  }

  aiSpike(spiker, soft, attack = {}) {
    const spikerWho = 2 + this.ai.indexOf(spiker);
    const p = this.actualContactPoint(spikerWho, attack.kind === 'tip' ? 'tip' : 'spike');
    if (!this.recordTouch(spikerWho, attack.kind === 'tip' ? 'tip' : 'spike', p)) return;
    const free = attack.kind === 'free';
    const tip = !free && (soft || attack.kind === 'tip');
    this.markAttack(free ? 'free' : (tip ? 'tip' : 'spike'), 'ai', 2 + this.ai.indexOf(spiker));
    const aim = clamp(Number.isFinite(attack.aim) ? attack.aim : this.chooseAttackAim(this.players), -1, 1);
    this.emit('sound', tip || free ? 'hit' : 'spike');
    const digger = this.pendingBlock?.digger;
    const accuracyWeight = spiker.effects?.accuracyError ?? 1;
    const attackWeight = spiker.effects?.attack ?? 1;
    let targetX = free ? clamp(this.players[1].x + rand(-.45, .45) * accuracyWeight, -3.1, 3.1)
      : clamp(aim * (tip ? 2.5 : 2.4) + rand(-.5, .5) * accuracyWeight, -2.8, 2.8);
    let targetZ = free ? rand(-5.2, -3.8) : (tip ? rand(-3.2, -1.2) : rand(-5.2, -3.6));
    const timingMiss = !free && !tip && spiker.human && this.applyAttackTiming(attack, attack.quality, -1);
    if (timingMiss) { targetX = timingMiss.x ?? targetX; targetZ = timingMiss.z ?? targetZ; }
    else if (!free && !tip) targetX = this.safeSpikeX(p, targetX);
    const style = Math.abs(targetZ) < 2.2 ? 'poke' : 'cobra';
    if (spiker.anim) Object.assign(spiker.anim, { type: tip || free ? 'tip' : 'spike', aim, style: tip || free ? style : undefined, planned: false });
    if (tip) this.popup('팁!', '#ffd54f', spiker.x, 3.2, spiker.z);
    const spikeTime = spiker.human && attack.quality === 'perfect' ? .85 : this.D.aiSpikeT;
    this.ball.launch(p, { x: targetX, y: HIT.bump, z: targetZ }, free ? rand(2.0, 2.3) : (tip ? rand(1.4, 1.8) : spikeTime / attackWeight), this.time, free ? 'free' : (tip ? 'tip' : 'spike'));
    if (timingMiss) { this.pendingBlock = null; this.blockZone = null; this.defenseRead = null; spiker.tz = spiker.homeZ; return; }
    this.ball.keepGroundInCourt();
    if (free) {
      this.blockZone = null; this.pendingBlock = null; this.prepareOurReceive('free', 1);
    } else if (tip) {
      this.blockZone = null; this.pendingBlock = null; this.prepareOurReceive('tip');
    } else {
      const { who, digger, x } = this.pendingBlock;
      const tHit = Math.max(this.time, this.ball.timeAtZ(0) + 0.05);
      const shadowBonus = Math.abs(targetX - x) <= .8 ? .15 : 0;
      this.blockExp = { who, x, tHit, shadowBonus, done: false, buffered: null };
      this.planAnim(this.actor(who), 'block', tHit, true, { x, y: HIT.block, z: -.55 });
      if (this.practiceMode && this.practiceBlockBuffered?.playerIndex === who) {
        this.blockExp.buffered = { ...this.practiceBlockBuffered, t: tHit };
        this.practiceBlockBuffered = null;
      }
      if (this.practiceMode && this.blockExp.buffered) {
        this.resolveBlock(this.blockExp.buffered);
        spiker.tz = spiker.homeZ;
        return;
      }
      if (!this.players[who].human) this.schedule(tHit, () => this.autoBlock(who));
      this.prepareOurReceive('dig', digger);
    }
    spiker.tz = spiker.homeZ;
  }

  autoBlock(who) {
    if (!this.blockExp || this.blockExp.done) return;
    const chance = who >= 2 && !this.competitive
      ? { easy: .15, normal: .30, hard: .55 }[this.difficulty]
      : this.D.mateDig * .75;
    if (Math.random() < chance) this.resolveBlock({ playerIndex: who, t: this.blockExp.tHit, type: 'block', jump: true });
    else this.blockExp.done = true;
  }

  resolveBlock(g, forcedOutcome = null) {
    const b = this.blockExp;
    if (!b || b.done) return;
    b.done = true;
    const actor = this.actor(b.who);
    this.startBlockMotion(b.who);
    if (actor.anim) actor.anim.planned = false;
    if (!this.practiceMode && Math.abs(actor.x - b.x) > this.D.reach * 0.8) { this.popup('좌우를 맞추세요!', '#ff8a65', actor.x, 3.2, actor.z); return; }
    const q = Math.abs(g.t - b.tHit) <= this.D.perfect ? 'perfect' : 'good';
    const blockChance = Math.min(.95, (q === 'perfect' ? .65 : .35) + (b.shadowBonus ?? 0) + (actor.effects?.blockBonus ?? 0));
    if (!forcedOutcome && !this.practiceMode && Math.random() > blockChance) { this.popup('블로킹 실패', '#ef5350', actor.x, 3.2, actor.z); return; }
    const blockHeight = HIT.block + (actor.effects?.highContactOffset ?? 0);
    this.recordTouch(b.who, 'block', { x: b.x, y: blockHeight, z: b.who < 2 ? -.25 : .25 });
    this.stats.blocks++; this.emit('sound', 'block');
    this.emit('practice-action', { action: 'block', team: b.who < 2 ? 'me' : 'ai', playerIndex: b.who, quality: q });
    this.emit('player-action', { action: 'block', team: b.who < 2 ? 'me' : 'ai', playerIndex: b.who, quality: q });
    // 기존 공격 궤적에 잡혀 있던 리시브 예약을 지우고 블록 이후 공으로 새 랠리를 만든다.
    this.exp = null; this.jobs = []; this.landing = null; this.receivePlan = null; this.setPosition = null;
    this.blockZone = null; this.pendingBlock = null; this.rivalBlock = null;
    for (const p of [...this.players, ...this.ai]) { p.readyWaiting = false; p.atSetPosition = false; p.roleLabel = null; }
    const blockTeam = b.who < 2 ? 'me' : 'ai';
    const attackTeam = blockTeam === 'me' ? 'ai' : 'me';
    const localBlocker = b.who < 2 ? b.who : b.who - 2;
    const attackSign = blockTeam === 'me' ? 1 : -1;
    const stuffChance = q === 'perfect' ? .55 : .25;
    const softChance = q === 'perfect' ? .35 : .50;
    const contact = { x: b.x, y: blockHeight, z: attackSign * .25 };
    const roll = forcedOutcome === 'stuff' ? 0 : forcedOutcome === 'soft' ? stuffChance : forcedOutcome === 'out' ? 1 : Math.random();
    if (roll < stuffChance) {
      this.stats.stuffBlocks++;
      if (this.rallyHighlight) {
        this.rallyHighlight.stuff = { team: blockTeam, actor: b.who };
        this.rallyHighlight.lastAttack = { type: 'stuff-block', team: blockTeam, actor: b.who };
        this.rallyHighlight.netCrossings++;
      }
      const target = { x: clamp(b.x + rand(-.7, .7), -3.5, 3.5), y: .1, z: attackSign * rand(.8, 2.5) };
      this.ball.launch(contact, target, rand(.35, .50), this.time, 'spike');
      this.popup('빠방! 블로킹!', '#ba68c8', actor.x, 3.4, actor.z);
      this.emit('block-result', { outcome: 'stuff', team: blockTeam, quality: q });
      return;
    }
    if (roll < stuffChance + softChance) {
      const returnsToBlocker = Math.random() < .60;
      const landingTeam = returnsToBlocker ? blockTeam : attackTeam;
      const side = landingTeam === 'me' ? -1 : 1;
      const target = { x: clamp(b.x + rand(-1.8, 1.8), -3.25, 3.25), y: HIT.bump, z: side * rand(1.5, 4) };
      this.ball.launch(contact, target, rand(1.30, 1.40), this.time, 'block-touch');
      this.popup('블로킹 터치!', '#ba68c8', actor.x, 3.4, actor.z);
      this.emit('block-result', { outcome: 'soft', team: blockTeam, quality: q, landingTeam });
      if (landingTeam === 'me') {
        const forced = blockTeam === 'me' ? 1 - localBlocker : null;
        this.prepareOurReceive('dig', forced);
      } else {
        const forced = blockTeam === 'ai'
          ? 1 - localBlocker
          : (Math.abs(this.ai[0].x - target.x) <= Math.abs(this.ai[1].x - target.x) ? 0 : 1);
        this.aiReceive(.90, forced);
      }
      return;
    }
    const outX = (Math.random() < .5 ? -1 : 1) * rand(4.8, 6);
    this.ball.launch(contact, { x: outX, y: .1, z: (blockTeam === 'me' ? -1 : 1) * rand(.4, 1.5) }, rand(.45, .65), this.time, 'block-out');
    this.blockOutWinner = attackTeam;
    this.popup('블록 아웃!', '#ff8a65', actor.x, 3.4, actor.z);
    this.emit('block-result', { outcome: 'out', team: blockTeam, quality: q });
  }

  ballDown(p) {
    this.ball.stopAt({ x: p.x, y: 0.12, z: p.z });
    if (this.blockOutWinner) {
      const winner = this.blockOutWinner; this.blockOutWinner = null;
      this.pointTo(winner); return;
    }
    if (this.serveFaultOwner) {
      const loser = this.serveFaultOwner; this.serveFaultOwner = null;
      this.pointTo(loser === 'me' ? 'ai' : 'me'); return;
    }
    if (Math.abs(p.x) > COURT.halfW || Math.abs(p.z) > COURT.halfL) {
      const lastTeam = this.lastTouch ? (this.lastTouch.who < 2 ? 'me' : 'ai')
        : (this.ball.p0?.z < 0 ? 'me' : 'ai');
      this.pointTo(lastTeam === 'me' ? 'ai' : 'me', '아웃!');
      return;
    }
    this.pointTo(p.z < 0 ? 'ai' : 'me');
  }

  pointTo(who, reason = null) {
    if (this.phase !== 'rally') return;
    this.score[who]++;
    if (who === 'me' && this.deceptionPending) this.popup('속였다!', '#ffd54f', 0, 3.4, 0);
    this.deceptionPending = false;
    this.phase = 'point'; this.phaseT = this.time; this.lastPoint = who;
    const replay = this.choosePointReplay(who);
    this.pointReplay = replay.enabled; this.pointReplayKind = replay.kind; this.pointReplayActor = replay.actor;
    this.clearPlans();
    this.pointCelebrationCount++;
    const gesture = this.applyTeamGestures(who);
    this.beginPointPresentation(who, gesture);
    this.celebrationLog.push({ point: this.pointCelebrationCount, team: who, shared: gesture.shared, styles: gesture.styles });
    const { me, ai } = this.score;
    if (Math.max(me, ai) >= this.target && Math.abs(me - ai) >= 2) this.winner = me > ai ? 'me' : 'ai';
    this.emit('score', this.score); this.emit('point-scored', { team: who, playerIndex: null }); this.emit('sound', who === 'me' ? 'point' : 'lose');
    this.emit('message', this.winner
      ? { text: this.winner === 'me' ? '경기 승리!' : '경기 종료', sub: `${me} : ${ai}` }
      : { text: reason ?? (who === 'me' ? '득점!' : '실점'), sub: `${me} : ${ai}` });
  }

  skipReplay() {
    if (this.phase === 'point') {
      const duration = this.pointPresentation?.duration ?? 3.6;
      this.phaseT = this.time - duration;
      if (this.pointPresentation) this.pointPresentation.startedAt = this.phaseT;
    }
  }

  clearPlans() {
    this.exp = null; this.blockExp = null; this.pendingBlock = null;
    this.jobs = []; this.landing = null; this.blockZone = null; this.chain = null; this.aiChain = null; this.rivalBlock = null;
    this.receivePlan = null; this.setPosition = null;
    this.defenseRead = null;
    this.blockOutWinner = null;
    this.practiceBlockBuffered = null; this.practiceSpikeBuffered = null;
    for (const actor of [...this.players, ...this.ai]) {
      delete actor.magnet; delete actor.slide; delete actor.approach; actor.roleLabel = null;
      actor.readyWaiting = false; actor.atSetPosition = false;
      actor.readingReady = false;
    }
  }

  resetHomes() {
    for (const p of [...this.players, ...this.ai]) { p.tx = p.homeX; p.tz = p.homeZ; }
  }

  popup(text, color, x, y, z = 0) { this.popups.push({ text, color, x, y, z, t0: this.time }); }

  get slowMotionRequested() {
    return !!(this.practiceMode && this.phase === 'rally' && this.exp && !this.exp.done
      && this.exp.action === 'spike' && this.time >= this.exp.tHit - .20 && this.time <= this.exp.tHit + .05);
  }

  updateTimeScale(realDt) {
    const target = this.slowMotionRequested ? .85 : 1;
    const maxStep = .15 * Math.max(0, realDt) / .08;
    if (this._timeScale < target) this._timeScale = Math.min(target, this._timeScale + maxStep);
    else if (this._timeScale > target) this._timeScale = Math.max(target, this._timeScale - maxStep);
    if (Math.abs(this._timeScale - target) < 1e-12) this._timeScale = target;
    return this._timeScale;
  }

  get slowMotion() { return this.slowMotionRequested || this._timeScale < .999; }
  get timeScale() { return this._timeScale; }

  get prompts() {
    const result = [];
    if (this.phase === 'serve-ai' && this.ai[this.aiServerIndex].human) {
      return [{ action: 'serveToss', who: this.aiServerIndex + 2 }];
    }
    if (this.phase === 'serve-me' && this.players[this.serverIndex]?.human) {
      result.push({ action: 'serveToss', who: this.serverIndex });
      return result;
    }
    if (this.phase === 'serve-toss' && this.actor(this.servingActorIndex)?.human) {
      result.push({ action: 'serveHit', who: this.servingActorIndex });
      return result;
    }
    if (this.phase !== 'rally') return result;
    if (this.blockExp && !this.blockExp.done && this.actor(this.blockExp.who).human) {
      result.push({ action: 'block', who: this.blockExp.who, tHit: this.blockExp.tHit });
    }
    if (this.exp && !this.exp.done && this.actor(this.exp.who).human) {
      result.push({
        action: this.exp.action, who: this.exp.who, tHit: this.exp.tHit, t0: this.exp.t0,
        hitX: this.exp.hitX, hitZ: this.exp.hitZ,
        inReach: Math.abs(this.actor(this.exp.who).x - this.exp.hitX) <= this.D.reach + (this.exp.animType === 'dig' ? 1.2 : 0),
      });
    }
    return result;
  }

  get prompt() { return this.prompts[0] ?? null; }
}
