// 배구 동작 판정
// 좌표 단위: 몸통 길이 = 1, 기준점 = 어깨 중심, y는 아래로 갈수록 +

export const GESTURES = {
  bump:  { name: '리시브',   hint: '두 손을 모아 허리 앞으로',       color: '#4fc3f7', key: '1' },
  set:   { name: '토스',     hint: '두 손을 이마 위로',              color: '#81c784', key: '2' },
  spike: { name: '스파이크', hint: '한 손을 머리 위에서 힘껏 내려치기', color: '#ff8a65', key: '3' },
  block: { name: '블로킹',   hint: '두 팔을 머리 위로 쭉 뻗기',       color: '#ba68c8', key: '4' },
  serve: { name: '서브',     hint: '한 손 들고 1초 기다린 뒤 내려치기', color: '#ffd54f', key: '5' },
  jump:  { name: '점프',     hint: '제자리에서 점프',                color: '#f06292', key: '6' },
};
export const ORDER = ['bump', 'set', 'spike', 'block', 'serve', 'jump'];

// 기준값 — 학생 테스트 후 여기 숫자만 조정하면 된다
export const TH = {
  bumpHandsDist: 0.5,   // 두 손목 사이 거리
  bumpMinY: 0.45,       // 손목이 어깨보다 이만큼 아래
  bumpMaxY: 1.9,
  bumpMaxX: 0.9,        // 몸 가운데에서 벗어난 정도
  setHandsDist: 1.1,
  blockArmRatio: 0.75,  // 팔 길이의 75% 이상 위로 뻗으면 블로킹
  holdMs: { bump: 120, set: 150, block: 150 },
  releaseMs: 120,
  swingWindowMs: 350,   // 이 시간 안에
  swingDrop: 0.8,       // 이만큼 내려치면 스윙
  swingEndY: 0.0,       // 어깨 높이 아래까지 내려와야 함
  swingOtherRatio: 0.5, // 다른 손은 절반 미만으로만 움직여야 함 (양팔 내리기와 구분)
  serveHoldMs: 600,     // 스윙 전에 손을 이만큼 들고 있으면 서브
  // 점프: 방에서 하는 작은 점프도 잡는다 (2026-09-26 선생님 녹화: 발목 5~11%, 골반 17~23%)
  jumpRiseAnkle: 0.08,  // 발목이 이만큼 뜨거나
  jumpRiseHip: 0.15,    // 골반이 이만큼 올라가고(발목이 안 보이면 이것만)
  jumpAnkleMin: 0.03,   // 그때 발목도 이만큼은 떠 있어야 함 (까치발·몸 펴기와 구분)
  jumpEnd: 0.04,
  jumpWithSwingMs: 700, // 스윙 직전 이 시간 안에 점프했으면 점프 스파이크
  cooldownMs: 600,
  // 자세 유지 다시 알림(2026-09-27 선생님: "리시브·토스를 했는데 안 되는 경우가 많다"):
  // 리시브·토스·블로킹은 자세에 들어가는 순간 한 번만 알렸다. 학생이 공이 오기 전에 미리 팔을 모으고 기다리면
  // 그 알림이 게임 판정 창(도착 0.7초 전부터)보다 먼저 나가 버려졌다. 자세를 유지하는 동안 이 간격으로
  // { type, held: true }를 다시 보낸다. 게임은 held 알림으로 캐릭터 동작을 새로 시작하지 말고 판정에만 쓴다.
  heldRepeatMs: 250,
};

export class GestureDetector {
  constructor(cal, { heldRepeat = false } = {}) {
    this.heldRepeat = heldRepeat;   // true면 자세 유지 중 held 알림(TH.heldRepeatMs). 게임이 켠다
    this.setCalibration(cal);
  }

  setCalibration(cal) {
    this.cal = cal;
    this.u = cal.u;
    this.base = { hip: cal.hipY, ankle: cal.ankleY };
    this.reset();
  }

  // 사람을 잠깐 놓쳤을 때 호출
  reset() {
    this.hist = [];
    this.zone = 'none';
    this.cand = 'none';
    this.candSince = 0;
    this.zoneFired = true;
    this.heldT = -1e9;
    this.upSince = { l: null, r: null };
    this.lastFire = {};
    this.lastSwingT = -1e9;
    this.jumping = false;
    this.jumpT = -1e9;
    this.debug = {};
  }

  // 한 프레임을 넣으면 이번에 인식된 동작 목록을 돌려준다
  update(f) {
    const t = f.t;
    const events = [];
    const fire = (type, extra = {}) => {
      if (t - (this.lastFire[type] ?? -1e9) < TH.cooldownMs) return;
      this.lastFire[type] = t;
      events.push({ type, t, ...extra });
    };

    this.u += (f.torso - this.u) * 0.15;
    const u = this.u, sm = f.sm;
    const rel = p => ({ x: (p.x - sm.x) / u, y: (p.y - sm.y) / u });
    const lw = rel(f.p.lw), rw = rel(f.p.rw);
    const noseY = this.cal.noseRel;
    const armUpY = -this.cal.armLen * TH.blockArmRatio;

    this.hist.push({ t, lw, rw });
    while (t - this.hist[0].t > 1500) this.hist.shift();

    // ── 1) 자세를 잠깐 유지하는 동작: 리시브 / 토스 / 블로킹
    const handsDist = Math.hypot(lw.x - rw.x, lw.y - rw.y);
    let zone = 'none';
    if (lw.y < armUpY && rw.y < armUpY) zone = 'block';
    else if (lw.y < noseY && rw.y < noseY && handsDist < TH.setHandsDist) zone = 'set';
    else if (handsDist < TH.bumpHandsDist
      && Math.min(lw.y, rw.y) > TH.bumpMinY && Math.max(lw.y, rw.y) < TH.bumpMaxY
      && Math.abs((lw.x + rw.x) / 2) < TH.bumpMaxX) zone = 'bump';

    if (zone !== this.zone) {
      if (zone !== this.cand) { this.cand = zone; this.candSince = t; }
      const need = zone === 'none' ? TH.releaseMs : TH.holdMs[zone];
      if (t - this.candSince >= need) {
        this.zone = zone;
        this.zoneFired = zone === 'none';
      }
    } else {
      this.cand = zone;
    }
    if (!this.zoneFired) {
      this.zoneFired = true;
      fire(this.zone);
      this.heldT = t;
    } else if (this.heldRepeat && this.zone !== 'none' && this.cand === this.zone && t - this.heldT >= TH.heldRepeatMs) {
      this.heldT = t;
      events.push({ type: this.zone, t, held: true });
    }

    // ── 2) 내려치기: 스파이크 / 서브
    for (const side of ['l', 'r']) {
      const key = side + 'w', otherKey = side === 'l' ? 'rw' : 'lw';
      const cur = side === 'l' ? lw : rw;
      const other = side === 'l' ? rw : lw;

      if (cur.y > TH.swingEndY && t - this.lastSwingT > TH.cooldownMs) {
        let top = null;
        for (const h of this.hist) {
          if (t - h.t > TH.swingWindowMs) continue;
          if (!top || h[key].y < top.y) top = { y: h[key].y, t: h.t, oy: h[otherKey].y };
        }
        const drop = top ? cur.y - top.y : 0;
        if (top && top.y < noseY && drop > TH.swingDrop && other.y - top.oy < drop * TH.swingOtherRatio) {
          const held = this.upSince[side] != null ? top.t - this.upSince[side] : 0;
          const type = held >= TH.serveHoldMs ? 'serve' : 'spike';
          this.lastSwingT = t;
          fire(type, {
            hand: side,
            jump: t - this.jumpT < TH.jumpWithSwingMs,
            speed: drop / Math.max(0.03, (t - top.t) / 1000),
          });
        }
      }
      // 손을 머리 위로 든 시간 (스윙 판정 뒤에 갱신해야 서브 판정이 된다)
      if (cur.y < noseY) { if (this.upSince[side] == null) this.upSince[side] = t; }
      else if (cur.y > 0.2) this.upSince[side] = null;
    }

    // ── 3) 점프: 발목과 골반을 함께 본다. 높이는 덜 흔들리는 골반으로 잰다 (serve-detector.js와 같은 규칙)
    const useAnkle = this.base.ankle != null && f.anklesVis > 0.5;
    const hipRise = (this.base.hip - f.hm.y) / u;
    const ankleRise = useAnkle ? (this.base.ankle - (f.p.la.y + f.p.ra.y) / 2) / u : 0;
    const rise = hipRise;
    const start = useAnkle
      ? (ankleRise > TH.jumpRiseAnkle && hipRise > 0.03) || (hipRise > TH.jumpRiseHip && ankleRise > TH.jumpAnkleMin)
      : hipRise > TH.jumpRiseHip;

    if (!this.jumping) {
      if (start) {
        this.jumping = true;
        this.jumpT = t;
        fire('jump', { height: rise });
      } else {
        // 앞뒤로 조금씩 움직이는 것은 기준을 따라 옮긴다
        this.base.hip += (f.hm.y - this.base.hip) * 0.05;
        if (useAnkle) this.base.ankle += ((f.p.la.y + f.p.ra.y) / 2 - this.base.ankle) * 0.05;
      }
    } else if (rise < TH.jumpEnd || t - this.jumpT > 1500) {
      this.jumping = false;
    }

    this.debug = {
      u: u.toFixed(3), noseY: noseY.toFixed(2), armUpY: armUpY.toFixed(2),
      lw: `${lw.x.toFixed(2)}, ${lw.y.toFixed(2)}`, rw: `${rw.x.toFixed(2)}, ${rw.y.toFixed(2)}`,
      handsDist: handsDist.toFixed(2), zone: this.zone, cand: this.cand,
      jumpBy: useAnkle ? '발목' : '골반', rise: rise.toFixed(2),
      upL: this.upSince.l ? Math.round(t - this.upSince.l) + 'ms' : '-',
      upR: this.upSince.r ? Math.round(t - this.upSince.r) + 'ms' : '-',
    };
    return events;
  }

  // 지금 유지 중인 자세 (카드 테두리 표시용)
  get holding() {
    return this.cand !== 'none' ? this.cand : null;
  }
}
