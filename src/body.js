// 여러 사람 중 플레이어 고르기, 떨림 줄이기, 게임용 좌표 만들기

// MediaPipe Pose 랜드마크 번호
export const LM = {
  nose: 0, ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16,
  lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28,
};
// 손 끝 관절(공격 방향·팁 판정용, attack-detector.js). LM과 따로 두어 기존 판정·시험 코드는 그대로 둔다.
export const HAND_LM = {
  l: { pinky: 17, index: 19, thumb: 21 },
  r: { pinky: 18, index: 20, thumb: 22 },
};
const CORE = [LM.ls, LM.rs, LM.lh, LM.rh];

const vis = p => p.visibility ?? 1;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// 화면 가운데에 가깝고, 크게 보이고, 직전 플레이어와 가까운 사람을 고른다
export function pickPlayer(poses, prevHip, aspect) {
  let best = null, bestScore = -Infinity;
  for (const lm of poses) {
    const coreVis = Math.min(...CORE.map(i => vis(lm[i])));
    const hip = mid(lm[LM.lh], lm[LM.rh]);
    const sh = mid(lm[LM.ls], lm[LM.rs]);
    const torso = Math.hypot((sh.x - hip.x) * aspect, sh.y - hip.y);
    let score = torso * 3 - Math.abs(hip.x - 0.5) + coreVis;
    if (prevHip) score -= Math.hypot((hip.x - prevHip.x) * aspect, hip.y - prevHip.y) * 4;
    if (score > bestScore) { bestScore = score; best = { lm, coreVis, hip, torso }; }
  }
  return best;
}

// 지수 평균으로 관절 떨림을 줄인다 (값이 클수록 반응이 빠름)
export class Smoother {
  constructor(alpha = 0.6) { this.alpha = alpha; this.prev = null; }
  reset() { this.prev = null; }
  apply(lm) {
    if (!this.prev) { this.prev = lm.map(p => ({ ...p })); return this.prev; }
    const a = this.alpha;
    this.prev = lm.map((p, i) => {
      const q = this.prev[i];
      return { x: q.x + (p.x - q.x) * a, y: q.y + (p.y - q.y) * a, z: p.z, visibility: vis(p) };
    });
    return this.prev;
  }
}

// 게임용 좌표: 좌우 반전(거울), x에 화면비를 곱해 x·y 단위를 맞춘다. y는 아래로 갈수록 커진다.
export function buildFrame(lm, t, aspect) {
  const p = {};
  for (const [name, i] of Object.entries(LM)) {
    p[name] = { x: (1 - lm[i].x) * aspect, y: lm[i].y, v: vis(lm[i]) };
  }
  const sm = mid(p.ls, p.rs);
  const hm = mid(p.lh, p.rh);
  // 손 끝 관절: x·y는 p와 같은 좌표, z는 MediaPipe 깊이(카메라 쪽이 -)에 화면비를 곱해 x와 단위를 맞춘다
  const hands = {};
  for (const [side, idx] of Object.entries(HAND_LM)) {
    if (!lm[idx.index]) continue;
    const q = i => ({ x: (1 - lm[i].x) * aspect, y: lm[i].y, z: (lm[i].z ?? 0) * aspect, v: vis(lm[i]) });
    const w = side === 'l' ? LM.lw : LM.rw;
    hands[side] = { wrist: q(w), pinky: q(idx.pinky), index: q(idx.index), thumb: q(idx.thumb) };
  }
  return {
    t, p, sm, hm, hands,
    torso: Math.hypot(sm.x - hm.x, sm.y - hm.y),
    coreVis: Math.min(p.ls.v, p.rs.v, p.lh.v, p.rh.v),
    anklesVis: Math.min(p.la.v, p.ra.v),
  };
}
