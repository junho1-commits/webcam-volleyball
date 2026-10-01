// 서브 동작 판정 (Claude 담당)
// 1) 토스: 한 손을 가슴 아래에서 어깨 위로 빠르게 올린다 → 'serveToss'
// 2) 타격: 토스 뒤, **다른 손**을 어깨 위에서 힘껏 내려친다 → 'serveHit'
//    점프 중(또는 착지 직후)에 치면 스파이크 서브, 서서 치면 플로터 서브. 점프 타이밍과 팔 속도를 함께 알려 준다.
// 좌표는 gestures.js와 같다: 몸통 길이 = 1, 기준점 = 어깨 중심, y는 아래로 갈수록 +
// 기준값은 2026-09-26 선생님 웹캠 녹화(서브 10번, 15fps)로 맞췄다. 실제 토스는 코 높이 근처까지만 올라간다.

export const SERVE_TH = {
  tossWindowMs: 450,    // 이 시간 안에
  tossFromY: 0.25,      // 어깨보다 이만큼 아래(가슴·배)에서 출발해
  tossRise: 0.9,        // 몸통 길이의 0.9배 이상 올라가고
  tossTopY: -0.15,      // 어깨보다 이만큼 위(음수)까지 닿으면 토스
  tossOtherRatio: 0.7,  // 다른 손은 토스 손의 70% 미만으로만 올라가야 함 (양팔 블로킹과 구분)
  tossOtherBelow: 0.25, // …또는 토스 손보다 이만큼 낮으면 인정 (치는 팔을 함께 뒤로 당기는 활 자세)
  tossAfterHitMs: 800,  // 서브 직후에는 새 토스를 받지 않음 (팔 내리기를 토스로 착각 방지)
  hitWaitMs: 2500,      // 토스 뒤 이 시간 안에 쳐야 함
  hitMinDelayMs: 150,   // 토스와 동시에 휘두른 것은 무시
  swingWindowMs: 380,
  swingTopY: -0.1,      // 치는 손이 어깨보다 이만큼 위에서 출발해
  swingDrop: 0.6,       // 이만큼 내려치면 타격
  swingEndY: 0.1,       // 어깨 높이쯤까지 내려와야 함
  sameHandOk: false,    // true면 토스한 손으로 쳐도 인정 (어린 학생용 완화)
  // 팔 속도(몸통 길이/초) → 힘 0~1
  speedWeak: 2.5,
  speedStrong: 7,
  // 점프
  // 방에서 하는 점프는 작다: 발목이 조금만 떠도 골반이 크게 올라가면 점프로 본다
  jumpRiseAnkle: 0.08,  // 발목이 이만큼 뜨거나
  jumpRiseHip: 0.15,    // 골반이 이만큼 올라가고(발목이 안 보이면 이것만)
  jumpAnkleMin: 0.03,   // 그때 발목도 이만큼은 떠 있어야 함 (까치발·몸 펴기와 구분)
  jumpEnd: 0.04,
  jumpGraceMs: 350,     // 착지하고 이 시간 안에 친 것도 점프 서브로 인정 (타격은 팔을 다 내린 뒤에 잡히므로)
  jumpPeakMs: 400,      // 최고점에서 이만큼 벗어나 치면 점프 타이밍 점수 0
  contactAt: 0.3,       // 내려치기(위 → 아래) 중 이 비율 지점을 공과 닿은 순간으로 본다
};

const clamp01 = v => Math.max(0, Math.min(1, v));

export class ServeDetector {
  constructor(cal) {
    this.cal = cal;
    this.u = cal.u;
    this.base = { hip: cal.hipY, ankle: cal.ankleY };
    this.reset();
  }

  reset() {
    this.hist = [];
    this.toss = null;              // { hand, t }
    this.jump = null;              // { t0, peakRise, peakT, curRise, rising, landed, landT }
    this.rise = 0;                 // 지금 점프 높이
    this.lastHitT = -1e9;
    this.debug = {};
  }

  update(f) {
    const t = f.t, events = [];
    this.u += (f.torso - this.u) * 0.15;
    const u = this.u, sm = f.sm;
    const rel = p => ({ x: (p.x - sm.x) / u, y: (p.y - sm.y) / u });
    const w = { l: rel(f.p.lw), r: rel(f.p.rw) };
    this.updateJump(f, t, u);
    this.hist.push({ t, l: w.l, r: w.r, rise: this.rise });
    while (t - this.hist[0].t > 1500) this.hist.shift();

    // ── 1) 토스
    if (this.toss && t - this.toss.t > SERVE_TH.hitWaitMs) {
      events.push({ type: 'serveTossExpired', t, hand: this.toss.hand });
      this.toss = null;
    }
    if (!this.toss && t - this.lastHitT > SERVE_TH.tossAfterHitMs) {
      for (const side of ['l', 'r']) {
        const other = side === 'l' ? 'r' : 'l';
        const cur = w[side];
        if (cur.y >= SERVE_TH.tossTopY) continue;
        let low = null;
        for (const h of this.hist) {
          if (t - h.t > SERVE_TH.tossWindowMs) continue;
          if (!low || h[side].y > low.y) low = { y: h[side].y, t: h.t, oy: h[other].y };
        }
        if (!low || low.y < SERVE_TH.tossFromY) continue;
        const rise = low.y - cur.y;
        const otherRise = low.oy - w[other].y;
        // 두 팔이 함께 올라가도 토스 손이 확실히 더 높으면 토스(블로킹은 두 손 높이가 비슷하다)
        const otherLow = otherRise < rise * SERVE_TH.tossOtherRatio || w[other].y - cur.y >= SERVE_TH.tossOtherBelow;
        if (rise >= SERVE_TH.tossRise && otherLow) {
          this.toss = { hand: side, t };
          events.push({ type: 'serveToss', t, hand: side, speed: rise / Math.max(0.03, (t - low.t) / 1000) });
          break;
        }
      }
    }

    // ── 2) 타격 (토스한 뒤에만)
    if (this.toss && t - this.toss.t >= SERVE_TH.hitMinDelayMs && t - this.lastHitT > 600) {
      const sides = SERVE_TH.sameHandOk ? ['l', 'r'] : [this.toss.hand === 'l' ? 'r' : 'l'];
      for (const side of sides) {
        const cur = w[side];
        if (cur.y <= SERVE_TH.swingEndY) continue;
        let top = null;
        for (const h of this.hist) {
          if (t - h.t > SERVE_TH.swingWindowMs || h.t < this.toss.t - 200) continue;
          // 머리 위에서 잠깐 멈춘 경우 멈춤이 끝난 순간부터 잰다(<=)
          if (!top || h[side].y <= top.y + 0.02) top = { y: Math.min(h[side].y, top?.y ?? Infinity), t: h.t };
        }
        if (!top || top.y >= SERVE_TH.swingTopY) continue;
        const drop = cur.y - top.y;
        if (drop < SERVE_TH.swingDrop) continue;
        const speed = drop / Math.max(0.03, (t - top.t) / 1000);
        // 공과 닿는 순간 ≈ 내려치기 앞부분. 그때 공중에 있었는지(착지 직후 포함), 최고점에 얼마나 가까웠는지 본다
        const contactT = top.t + (t - top.t) * SERVE_TH.contactAt;
        const j = this.jump;
        const airborne = !!j && (!j.landed || contactT - j.landT <= SERVE_TH.jumpGraceMs);
        events.push({
          type: 'serveHit', t, hand: side, tossHand: this.toss.hand,
          sinceToss: t - this.toss.t,             // 토스 뒤 몇 ms에 쳤나 (공 높이 판정용)
          speed,                                   // 팔 내려치는 속도 (몸통 길이/초)
          power: clamp01((speed - SERVE_TH.speedWeak) / (SERVE_TH.speedStrong - SERVE_TH.speedWeak)),
          jump: airborne,                          // true = 스파이크 서브, false = 플로터 서브
          jumpDt: airborne ? contactT - j.t0 : null, // 점프 시작 뒤 몇 ms에 쳤나
          jumpPeak: airborne ? clamp01(1 - Math.abs(contactT - j.peakT) / SERVE_TH.jumpPeakMs) : 0, // 1 = 가장 높은 순간에 침
          jumpRising: airborne ? contactT <= j.peakT : false,
        });
        this.lastHitT = t;
        this.toss = null;
        break;
      }
    }

    this.debug = {
      toss: this.toss ? `${this.toss.hand} ${Math.round(t - this.toss.t)}ms` : '-',
      jump: this.jump && !this.jump.landed ? `${Math.round(t - this.jump.t0)}ms` : '-',
    };
    return events;
  }

  // gestures.js와 같은 기준으로 점프를 재되, 가장 높은 순간과 착지 시각을 기억한다
  updateJump(f, t, u) {
    const useAnkle = this.base.ankle != null && f.anklesVis > 0.5;
    const hipRise = (this.base.hip - f.hm.y) / u;
    const ankleRise = useAnkle ? (this.base.ankle - (f.p.la.y + f.p.ra.y) / 2) / u : 0;
    // 높이는 골반으로 잰다(발목보다 덜 흔들림). 시작 판정은 발목·골반을 함께 본다
    const rise = hipRise;
    const start = useAnkle
      ? (ankleRise > SERVE_TH.jumpRiseAnkle && hipRise > 0.03) || (hipRise > SERVE_TH.jumpRiseHip && ankleRise > SERVE_TH.jumpAnkleMin)
      : hipRise > SERVE_TH.jumpRiseHip;
    this.rise = Math.max(0, rise);
    const j = this.jump;
    if (!j || j.landed) {
      if (start) this.jump = { t0: t, peakRise: rise, peakT: t, curRise: rise, rising: true, landed: false, landT: null };
      else {
        this.base.hip += (f.hm.y - this.base.hip) * 0.05;
        if (useAnkle) this.base.ankle += ((f.p.la.y + f.p.ra.y) / 2 - this.base.ankle) * 0.05;
      }
    } else {
      j.rising = rise >= j.curRise;
      j.curRise = rise;
      if (rise > j.peakRise) { j.peakRise = rise; j.peakT = t; }
      if (rise < SERVE_TH.jumpEnd || t - j.t0 > 1500) { j.landed = true; j.landT = t; }
    }
  }
}
