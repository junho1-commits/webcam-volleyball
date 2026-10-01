// 뒤쪽 시점 2:2 코트 규칙. x=좌우, y=높이, z=앞뒤(우리 코트는 z<0).
export const G = 9.8;
export const ANIM_SECONDS = 0.78;
export const JUMP_HEIGHT = 0.9;
export const COURT = { halfW: 4, halfL: 8, netH: 2.0 };
export const SPIKE_Z = -1.0;
export const HIT = { bump: 0.9, set: 1.5, spike: 2.45, block: 2.4 };
export const SERVE = {
  gravity: G, apexAboveReach: 1.0, apexTowardNet: 0.3, apexTowardHitHand: 0.15,
  jumpReach: 0.45, timingRange: 0.6, goodWindow: 0.15, lateralMiss: 0.7,
  floatIdealT: 1.55, jumpIdealT: 1.75,
  perfectSeconds: 0.25, goodSeconds: 0.5, earliestHit: 0.8,
  expireSeconds: 2.6, dropHeight: 1.0, returnSeconds: 0.3,
};

export const DIFFICULTY = {
  easy: {
    name: '쉬움', early: 1.0, late: 0.35, perfect: 0.25,
    reach: 2.3, blockZone: 2.6, lenient: true, speed: 0.75,
    aiBase: 0.27, aiDig: 0.50, aiServeReceive: 0.84, aiServeT: 2.3, aiSpikeT: 1.6,
    mateReceive: 0.98, mateServeReceive: 1.0, mateDig: 0.92,
  },
  normal: {
    name: '보통', early: 0.7, late: 0.25, perfect: 0.2,
    reach: 1.7, blockZone: 2.0, lenient: false, speed: 1,
    aiBase: 0.34, aiDig: 0.55, aiServeReceive: 0.90, aiServeT: 1.9, aiSpikeT: 1.2,
    mateReceive: 0.93, mateServeReceive: 0.99, mateDig: 0.90,
  },
  hard: {
    name: '어려움', early: 0.45, late: 0.2, perfect: 0.15,
    reach: 1.3, blockZone: 1.6, lenient: false, speed: 1.25,
    aiBase: 0.70, aiDig: 0.72, aiServeReceive: 0.95, aiServeT: 1.5, aiSpikeT: 0.95,
    mateReceive: 0.85, mateServeReceive: 0.96, mateDig: 0.78,
  },
};
