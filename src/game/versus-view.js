// VS 좌우 화면과 입력 방향을 한곳에서 결정한다. Three.js 없이 Node 시험에서도 쓸 수 있다.
export const VS_SPLIT_PHASES = new Set(['serve-me', 'serve-ai', 'serve-toss', 'serve-return', 'rally']);
export const PLAYER_LABEL_HEAD_GAP = .35;
export const PLAYER_PROMPT_HEAD_GAP = .8;
export const FALLBACK_HEAD_HEIGHT = 1.5;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function versusCameraPlan(actor, partner, slot, slowMotion = false) {
  const dir = slot === 0 ? 1 : -1;
  const wx = -actor.x;
  const back = Math.min(actor.z * dir, partner.z * dir);
  const partnerBehind = partner.z * dir < actor.z * dir - .05;
  const sameLane = Math.abs(partner.x - actor.x) < 1;
  let cameraX = wx * .5;
  if (partnerBehind && sameLane) {
    const towardCenter = Math.abs(wx) > .05 ? -Math.sign(wx) : (slot === 0 ? -1 : 1);
    cameraX += towardCenter;
  }
  return {
    dir,
    desired: {
      x: cameraX,
      y: slowMotion ? 3.75 : 3.95,
      z: clamp((back - 5.4) * dir, -18, 18),
    },
    target: {
      x: wx,
      y: slowMotion ? 1.1 : .9,
      z: actor.z + dir * (slowMotion ? 5.2 : 6),
    },
    dodgedPartner: partnerBehind && sameLane,
  };
}

export function versusCameraFollowRate(match, actorIndex) {
  const returningBlocker = match?.pendingBlock?.who === actorIndex
    && match?.exp?.who === actorIndex && match.exp.action === 'set';
  if (returningBlocker) return 12;
  return match?.prompts?.some(prompt => prompt.tHit) ? 7.5 * .35 : 7.5;
}

export function modelReadiness(people = []) {
  const states = people.map((person, actor) => ({
    actor,
    character: person.characterName,
    hq: !!(person.model && person.poser),
  }));
  return { ready: states.length === 4 && states.every(person => person.hq), people: states };
}

export function shouldSplitVersusView(match, enabled = true, replaying = false) {
  return !!(enabled && match?.competitive && !match.presentation && !replaying && VS_SPLIT_PHASES.has(match.phase));
}

export function versusInputSign(actorIndex, splitActive) {
  return splitActive && actorIndex === 2 ? -1 : 1;
}

export function guideLayerForActor(actorIndex, splitActive) {
  if (!splitActive) return 0;
  if (actorIndex === 0 || actorIndex === 1) return 1;
  if (actorIndex === 2 || actorIndex === 3) return 2;
  return 0;
}
