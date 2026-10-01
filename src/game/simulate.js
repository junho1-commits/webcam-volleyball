// 실제 조작에 가깝게 이동 속도를 제한하고 1P의 일에만 반응하는 빠른 경기 검증.
// 실행: node src/game/simulate.js
import { Match } from './match.js';

const LEVELS = { beginner: 0.3, medium: 0.6, expert: 0.9 };
const DT = 0.025;
const PLAYER_SPEED = 5;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let seed = 0x5eed1234;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);

function play(difficulty, skill, maxSeconds = 600) {
  const m = new Match({ difficulty, target: 7, autoMove: process.argv.includes('--auto-move') });
  if (m.autoMove) m.setCharacterChoices(['ara', 'min']);
  let t = 0, x = -1.35, plan = null, lastServePhase = '', servePlan = null;
  let hiddenHumanPrompts = 0;
  while (t < maxSeconds && m.phase !== 'over') {
    t += DT;
    m.update(t, x, null);

    if (m.phase === 'serve-me' && m.players[m.serverIndex].human && lastServePhase !== `${m.phase}:${m.phaseT}:${m.score.me}:${m.score.ai}`) {
      lastServePhase = `${m.phase}:${m.phaseT}:${m.score.me}:${m.score.ai}`;
      m.setServeGeometry({
        toss: { x: x - .3, y: 1.35, z: -7.2 }, hit: { x: x + .3, y: 2.3, z: -7.2 },
        hitFloat: { x: x + .3, y: 2.3, z: -7.2 }, hitJump: { x: x + .3, y: 2.75, z: -7.2 }, standReach: 2.3,
      });
      m.onServeToss({ playerIndex: 0, source: 'keyboard' });
      const jump = Math.random() < skill;
      const toss = m.serveToss;
      const ideal = toss.t0 + (jump ? toss.jumpIdeal : toss.floatIdeal);
      const error = (Math.random() * 2 - 1) * (1 - skill) * .32;
      servePlan = { jump, hitAt: ideal + error, jumpAt: ideal - .3, jumped: false, hit: false };
    }
    if (m.phase === 'serve-toss' && m.serveToss?.team === 'me' && servePlan) {
      if (servePlan.jump && !servePlan.jumped && t >= servePlan.jumpAt) { m.onGesture('jump', {}, 0); servePlan.jumped = true; }
      if (!servePlan.hit && t >= servePlan.hitAt) {
        m.onServeHit({ playerIndex: 0, source: 'keyboard' }); servePlan.hit = true;
      }
    }

    // 컴퓨터 짝꿍의 블로킹은 조작하지 않고, 1P(who=0)의 할 일만 반응한다.
    const source = m.blockExp && !m.blockExp.done && m.blockExp.who === 0
      ? m.blockExp
      : (m.exp && !m.exp.done && m.exp.who === 0 ? m.exp : null);

    if (m.blockExp && !m.blockExp.done && m.blockExp.who === 1
      && m.exp && !m.exp.done && m.exp.who === 0
      && !m.prompts.some(p => p.who === 0 && p.action === m.exp.action)) hiddenHumanPrompts++;

    if (source && plan?.source !== source) {
      const action = source === m.blockExp ? 'block' : source.action;
      const timingError = -m.D.early * 0.35 + Math.random() * (m.D.early * 0.35 + m.D.late * 0.75);
      plan = {
        source, action, targetX: source.x ?? source.hitX ?? x,
        when: source.tHit + timingError,
        act: Math.random() < skill,
        done: false,
      };
    }
    if (source && plan?.source === source) {
      const step = PLAYER_SPEED * DT;
      x += clamp(plan.targetX - x, -step, step);
      x = clamp(x, -3.75, 3.75);
      if (plan.act && !plan.done && t >= plan.when && !source.done) {
        m.onGesture(plan.action, { jump: plan.action === 'spike' || plan.action === 'block' });
        plan.done = true;
      }
    }
    if (m.phase !== 'serve-toss' && m.phase !== 'serve-me') servePlan = null;
  }
  return { finished: m.phase === 'over', winner: m.winner, seconds: t, score: m.score, hiddenHumanPrompts };
}

for (const difficulty of ['easy', 'normal', 'hard']) {
  for (const [level, skill] of Object.entries(LEVELS)) {
    const games = Array.from({ length: 40 }, () => play(difficulty, skill));
    const wins = games.filter(g => g.winner === 'me').length;
    const stalls = games.filter(g => !g.finished).length;
    const hidden = games.reduce((sum, g) => sum + g.hiddenHumanPrompts, 0);
    console.log(`${difficulty.padEnd(6)} ${level.padEnd(8)} wins=${String(wins).padStart(2)}/40 stalls=${stalls} hiddenPrompts=${hidden}`);
    if (stalls || hidden) process.exitCode = 1;
  }
}
