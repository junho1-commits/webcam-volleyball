// 공격(스파이크·팁) 판정과 공격 방향 (Claude 담당)
// - 스파이크: 한 손을 머리 위에서 빠르게 내려친다 → { type: 'attack', kind: 'spike', hand, aim, speed }
// - 팁: 휘두르지 않고 손을 머리 위로 뻗어 대고만 있다 → handUp(t)이 { kind: 'tip', hand, aim } 을 돌려준다.
//   게임은 스파이크 판정 창이 끝날 때까지 스파이크가 없고, 닿는 시각에 손이 올라가 있었으면 팁으로 본다.
// - 공격 방향 aim: -1(학생의 왼쪽) ~ +1(학생의 오른쪽). 학생이 화면을 보고 서고 캐릭터도 네트를 보므로
//   학생의 왼쪽 = 캐릭터의 왼쪽 = 화면 왼쪽이다. 세 가지를 섞는다.
//   1) 손목 회전: 손바닥이 향하는 쪽(엄지·검지·새끼 관절과 깊이 z로 잰다)
//   2) 손끝 기울기: 손목에서 손끝이 기운 쪽 (팁에서만. 스파이크는 손바닥이 옆을 봐서 믿을 수 없다)
//   3) 팔 궤적: 내려치는 동안 손목이 옆으로 간 거리(몸 앞을 가로질러 휘두르면 반대쪽)
// 좌표는 gestures.js·serve-detector.js와 같다: 몸통 길이 = 1, 기준점 = 어깨 중심, y는 아래로 갈수록 +.
// 좌우는 화면 좌표가 아니라 어깨 방향(왼 어깨 → 오른 어깨)으로 잰다. 거울 반전과 상관없다.
// ※ 기준값은 합성 동작으로만 맞췄다. 선생님 녹화(스트레이트 5·크로스 5·팁 5)로 다시 맞출 것.

export const ATTACK_TH = {
  swingWindowMs: 320,   // 이 시간 안에 (gestures.js 스파이크 350ms·0.8과 비슷하게)
  swingTopY: -0.2,      // 어깨보다 이만큼 위에서 출발해
  swingDrop: 0.8,       // 몸통 길이의 이만큼 내려치면 스파이크 (팔을 보통 속도로 내리는 것과 구분)
  swingEndY: 0.05,      // 어깨 높이쯤까지 내려와야 함
  swingOtherRatio: 0.5, // 다른 손은 절반 미만으로만 움직여야 함 (두 팔 내리기와 구분)
  contactAt: 0.3,       // 내려치기 중 이 비율 지점을 공과 닿은 순간으로 본다
  cooldownMs: 500,
  cockedY: -0.1,        // 한 손을 내릴 때 반대 손이 이보다 높으면(어깨 위) 리드 암일 수 있어 기다린다
  leadWaitMs: 600,      // 이 시간 안에 반대 손이 치면 그것이 진짜 스파이크
  // 팁: 손이 이 높이보다 위(코 위)에 있고, 빠르게 움직이지 않을 때
  upY: -0.45,
  tipMaxSpeed: 3.0,     // 몸통 길이/초
  // 방향 섞기
  rollRange: 0.9,       // 손바닥이 이 각도(라디안, 약 50°) 돌면 끝까지
  tiltRange: 0.6,       // 손끝이 이 각도(약 35°) 기울면 끝까지
  pathRange: 0.45,      // 옆으로 간 거리 / 내려친 거리 가 이만큼이면 끝까지
  wRoll: 0.5, wTilt: 0.2, wPath: 0.45,
  deadzone: 0.1,        // 이보다 작으면 가운데(0)
  // 자연스러운 치우침(가운데로 볼 기준). 사람은 그냥 내려쳐도 손바닥이 몸 안쪽으로 돌고 팔이 몸 앞을 가로지른다.
  // 2026-09-26 선생님 서브 녹화(왼손 타격 8번) 중앙값: 손바닥 약 1.3rad(75°), 손끝 약 0.3rad, 궤적 약 0.35 (모두 몸 안쪽)
  naturalRoll: 1.3,
  naturalTilt: 0.3,
  naturalPath: 0.35,
  handMinVis: 0.3,      // 손 관절이 이만큼은 보여야 손목 회전을 쓴다
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp1 = v => clamp(v, -1, 1);

export class AttackDetector {
  constructor(cal) {
    this.u = cal.u;
    this.reset();
  }

  reset() {
    this.hist = [];
    this.lastSwingT = -1e9;
    this.pending = null;
    this.debug = {};
  }

  update(f) {
    const t = f.t, events = [];
    this.u += (f.torso - this.u) * 0.15;
    const u = this.u, sm = f.sm;
    // 학생의 오른쪽 방향(단위 벡터, 화면 좌표)
    const rx = f.p.rs.x - f.p.ls.x, ry = f.p.rs.y - f.p.ls.y, rl = Math.hypot(rx, ry) || 1;
    const right = { x: rx / rl, y: ry / rl };
    const rel = p => ({ x: (p.x - sm.x) / u, y: (p.y - sm.y) / u });
    const entry = { t, right };
    for (const side of ['l', 'r']) {
      const w = rel(f.p[side + 'w']);
      entry[side] = { ...w, side: w.x * right.x + w.y * right.y, ...this.handShape(f.hands?.[side], side, right, u) };
    }
    const noseY = rel(f.p.nose).y;
    entry.noseY = noseY;
    this.hist.push(entry);
    while (t - this.hist[0].t > 1200) this.hist.shift();

    // 스파이크: 머리 위에서 빠르게 내려치기
    if (t - this.lastSwingT > ATTACK_TH.cooldownMs) {
      for (const side of ['l', 'r']) {
        const other = side === 'l' ? 'r' : 'l';
        const cur = entry[side];
        if (this.pending?.event.hand === side) continue;   // 기다리는 동안 같은 손(리드 암)은 다시 보지 않는다
        if (cur.y <= ATTACK_TH.swingEndY) continue;
        let top = null;
        for (const h of this.hist) {
          if (t - h.t > ATTACK_TH.swingWindowMs) continue;
          if (!top || h[side].y < top[side].y) top = h;
        }
        if (!top || top[side].y > ATTACK_TH.swingTopY) continue;
        const drop = cur.y - top[side].y;
        const otherMove = Math.abs(entry[other].y - top[other].y);
        if (drop < ATTACK_TH.swingDrop || otherMove > drop * ATTACK_TH.swingOtherRatio) continue;
        const swing = this.hist.filter(h => h.t >= top.t);
        const contactY = top[side].y + drop * ATTACK_TH.contactAt;
        const contact = swing.find(h => h[side].y >= contactY) ?? entry;
        const aim = this.aimFrom(side, swing.filter(h => h.t <= contact.t), top, entry, drop);
        this.lastSwingT = t;
        const event = {
          type: 'attack', kind: 'spike', t, hand: side, aim: aim.value,
          speed: drop / Math.max(0.03, (t - top.t) / 1000),
          contactT: contact.t, parts: aim.parts,
        };
        // 리드 암일 수 있다: 반대 손이 어깨 위에 준비된 채면(치려고 당겨 둠) 바로 내지 않고 기다린다.
        // 그 사이 반대 손이 치면 그것만 스파이크, 안 치면 기다린 것을 낸다. (2026-09-26 선생님 녹화: 리드 암 내리기 4번이 잘못 잡혔음)
        if (!this.pending && entry[other].y < ATTACK_TH.cockedY) {
          this.pending = { event, other, until: t + ATTACK_TH.leadWaitMs };
          this.lastSwingT = -1e9;          // 반대 손 스윙은 바로 받아야 한다
          continue;
        }
        if (this.pending && this.pending.other === side) this.pending = null;   // 기다리던 것은 리드 암이었다
        events.push(event);
      }
    }
    if (this.pending && t >= this.pending.until) {
      events.push({ ...this.pending.event, late: true });
      this.pending = null;
    }
    return events;
  }

  // 손 관절로 손목 회전(roll)과 손끝 기울기(tilt)를 잰다. 둘 다 +가 학생의 오른쪽.
  handShape(hand, side, right, u) {
    if (!hand || Math.min(hand.index.v, hand.pinky.v) < ATTACK_TH.handMinVis) return { roll: null, tilt: null };
    // 손바닥이 앞(카메라)을 볼 때: 오른손은 새끼가 바깥(오른쪽), 왼손은 새끼가 바깥(왼쪽).
    // 손바닥이 안쪽으로 돌면 새끼 관절이 카메라 쪽(앞)으로 나온다. 앞 = z가 작아지는 쪽.
    const vx = hand.pinky.x - hand.index.x, vy = hand.pinky.y - hand.index.y, vz = hand.pinky.z - hand.index.z;
    const along = vx * right.x + vy * right.y;       // 새끼 → 검지 방향이 오른쪽으로 얼마나
    const fwd = -vz;                                  // 앞으로 얼마나
    const roll = side === 'r'
      ? -Math.atan2(fwd, along)                       // 오른손: 손바닥이 왼쪽을 보면 음수
      : Math.atan2(fwd, -along);                      // 왼손: 손바닥이 오른쪽을 보면 양수
    // 손끝 기울기: 손목 → 손끝(검지·새끼 가운데)이 위(-y)에서 오른쪽으로 기운 각도
    const mx = (hand.index.x + hand.pinky.x) / 2 - hand.wrist.x, my = (hand.index.y + hand.pinky.y) / 2 - hand.wrist.y;
    const tilt = -my > 0.02 ? Math.atan2(mx * right.x + my * right.y, -my) : null;   // 손끝이 아래를 보면(내려친 뒤) 쓰지 않는다
    return { roll, tilt };
  }

  aimFrom(side, frames, top, end, drop) {
    // 손 관절은 가끔 크게 튀므로 평균 대신 중앙값
    const median = key => {
      const vals = frames.map(h => h[side][key]).filter(v => v != null).sort((a, b) => a - b);
      return vals.length ? vals[vals.length >> 1] : null;
    };
    // 손끝 기울기는 쓰지 않는다: 내려칠 때 손바닥이 옆을 보므로(평소 약 75°) 화면에서 손끝이 짧게 보여 값이 거꾸로 흔들린다.
    // 손바닥을 앞으로 내미는 팁에서만 쓴다.
    const roll = median('roll');
    const path = drop > 0 ? (end[side].side - top[side].side) / drop : 0;
    return this.combine(this.fromNatural(side, { roll, tilt: null, path }));
  }

  // 몸 안쪽 = 왼손이면 오른쪽(+), 오른손이면 왼쪽(-). 자연스러운 치우침을 빼서 "그냥 친 것"이 가운데가 되게 한다
  fromNatural(side, { roll, tilt, path }) {
    const inward = side === 'l' ? 1 : -1, TH = ATTACK_TH;
    return {
      roll: roll == null ? null : roll - inward * TH.naturalRoll,
      tilt: tilt == null ? null : tilt - inward * TH.naturalTilt,
      path: path == null ? null : path - inward * TH.naturalPath,
    };
  }

  combine({ roll, tilt, path }) {
    const TH = ATTACK_TH;
    const parts = {
      roll: roll == null ? null : clamp1(roll / TH.rollRange),
      tilt: tilt == null ? null : clamp1(tilt / TH.tiltRange),
      path: path == null ? null : clamp1(path / TH.pathRange),
    };
    let sum = 0, weight = 0;
    for (const [key, w] of [['roll', TH.wRoll], ['tilt', TH.wTilt], ['path', TH.wPath]]) {
      if (parts[key] == null) continue;
      sum += parts[key] * w; weight += w;
    }
    let value = weight ? clamp1(sum / weight * 1.4) : 0;
    if (Math.abs(value) < TH.deadzone) value = 0;
    for (const k of Object.keys(parts)) if (parts[k] != null) parts[k] = +parts[k].toFixed(2);
    return { value: +value.toFixed(2), parts };
  }

  // t 전후(±windowMs)에 머리 위로 뻗어 가만히 댄 손이 있으면 팁. 없으면 null.
  handUp(t, windowMs = 180) {
    const frames = this.hist.filter(h => Math.abs(h.t - t) <= windowMs);
    if (frames.length < 2) return null;
    let best = null;
    for (const side of ['l', 'r']) {
      const up = frames.filter(h => h[side].y < Math.min(ATTACK_TH.upY, h.noseY));
      if (up.length < Math.ceil(frames.length * 0.6)) continue;
      const a = up[0], b = up[up.length - 1];
      const speed = Math.hypot(b[side].x - a[side].x, b[side].y - a[side].y) / Math.max(0.03, (b.t - a.t) / 1000);
      if (speed > ATTACK_TH.tipMaxSpeed) continue;
      const height = -up.reduce((s, h) => s + h[side].y, 0) / up.length;
      // 팁 방향: 손목 회전·손끝 기울기 + 손을 머리 옆으로 얼마나 뺐는지(몸통 길이 0.5면 끝까지)
      const avg = key => {
        const vals = up.map(h => h[side][key]).filter(v => v != null);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };
      const offset = up.reduce((s, h) => s + h[side].side, 0) / up.length - (side === 'r' ? 0.35 : -0.35);
      const aim = this.combine({ roll: avg('roll'), tilt: avg('tilt'), path: offset / 0.5 * ATTACK_TH.pathRange });
      if (!best || height > best.height) best = { kind: 'tip', hand: side, aim: aim.value, height, parts: aim.parts };
    }
    return best;
  }
}
