// 인트로용 "손 흔들어 시작" 감지. 손을 흔들거나, 한 손을 머리 위로 1.5초 들고 있으면 시작.
// (제미나이의 src/ui/hand-cursor.js WaveDetector가 완성되면 바꿔 끼울 수 있게 같은 형태로 둔다)
import { LM } from '../body.js';

const WINDOW_MS = 1500;   // 이 시간 안에
const TURNS = 3;          // 좌우 방향이 이만큼 바뀌고
const AMPLITUDE = 0.25;   // 흔든 폭이 몸통 길이의 이만큼 이상이면 손 흔들기
const STEP = 0.08;        // 이보다 작은 움직임은 떨림으로 보고 무시
const HOLD_MS = 1500;     // 손을 들고 이만큼 있으면 시작

export class WaveStarter {
  constructor() { this.reset(); }

  reset() {
    this.hist = [];
    this.upSince = null;
  }

  // poses: MediaPipe 결과(여러 명). 반환: { handUp, waved, hold(0~1) }
  update(poses, t, aspect = 16 / 9) {
    const lm = biggest(poses, aspect);
    if (!lm) { this.reset(); return { handUp: false, waved: false, hold: 0 }; }

    const P = i => ({ x: (1 - lm[i].x) * aspect, y: lm[i].y });   // 거울 모드, x·y 같은 단위
    const ls = P(LM.ls), rs = P(LM.rs), lh = P(LM.lh), rh = P(LM.rh);
    const torso = Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2, (ls.y + rs.y - lh.y - rh.y) / 2) || 1;
    const shoulderY = (ls.y + rs.y) / 2;

    // 더 높이 든 손 (손목이 어깨보다 위)
    const hands = [[P(LM.lw), P(LM.le)], [P(LM.rw), P(LM.re)]]
      .filter(([w, e]) => w.y < shoulderY && w.y < e.y)
      .sort((a, b) => a[0].y - b[0].y);
    if (!hands.length) { this.reset(); return { handUp: false, waved: false, hold: 0 }; }

    const w = hands[0][0];
    this.upSince ??= t;
    this.hist.push({ t, x: w.x / torso });
    while (t - this.hist[0].t > WINDOW_MS) this.hist.shift();

    // 좌우 방향이 바뀐 횟수 (작은 떨림은 무시)
    let turns = 0, dir = 0, anchor = this.hist[0].x, min = anchor, max = anchor;
    for (const h of this.hist) {
      min = Math.min(min, h.x); max = Math.max(max, h.x);
      const d = h.x - anchor;
      if (Math.abs(d) < STEP) continue;
      const s = Math.sign(d);
      if (dir && s !== dir) turns++;
      dir = s;
      anchor = h.x;
    }
    const waved = turns >= TURNS && max - min >= AMPLITUDE;
    const hold = Math.min(1, (t - this.upSince) / HOLD_MS);
    if (waved) this.reset();
    return { handUp: true, waved, hold };
  }
}

// 화면에서 가장 크게 보이는(가장 가까운) 사람
function biggest(poses, aspect) {
  let best = null, size = 0;
  for (const lm of poses ?? []) {
    const s = Math.hypot(((lm[LM.ls].x + lm[LM.rs].x) - (lm[LM.lh].x + lm[LM.rh].x)) / 2 * aspect,
      ((lm[LM.ls].y + lm[LM.rs].y) - (lm[LM.lh].y + lm[LM.rh].y)) / 2);
    if (s > size) { size = s; best = lm; }
  }
  return best;
}
