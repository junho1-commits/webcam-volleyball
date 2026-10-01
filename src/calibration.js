// 차렷 자세로 잠깐 서 있는 동안 몸 크기를 잰다.
// 이후 모든 기준값은 몸통 길이(어깨 중심~골반 중심)를 1로 둔 상대값으로 쓴다.

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export class Calibrator {
  constructor(durationMs = 2500) {
    this.durationMs = durationMs;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.startT = null;
    this.anchor = null;
  }

  // 반환: { progress: 0~1, done, result }
  feed(f) {
    // 움직이면 처음부터 다시
    if (this.anchor) {
      const moved = Math.hypot(f.hm.x - this.anchor.x, f.hm.y - this.anchor.y) / f.torso;
      if (moved > 0.12) this.reset();
    }
    if (!this.anchor) { this.anchor = { ...f.hm }; this.startT = f.t; }
    this.frames.push(f);

    const progress = Math.min(1, (f.t - this.startT) / this.durationMs);
    if (progress < 1) return { progress, done: false };
    return { progress, done: true, result: this.compute() };
  }

  compute() {
    const F = this.frames;
    const u = median(F.map(f => f.torso));
    const noseRel = median(F.map(f => (f.p.nose.y - f.sm.y) / f.torso));
    // 팔을 내리고 있을 때만 팔 길이를 잰다
    const arms = F.flatMap(f => [[f.p.ls, f.p.lw], [f.p.rs, f.p.rw]])
      .filter(([s, w]) => w.y > s.y && w.v > 0.5)
      .map(([s, w]) => Math.hypot(w.x - s.x, w.y - s.y));
    let armLen = median(arms) / u;
    if (!(armLen > 0.8 && armLen < 1.6)) armLen = 1.15;

    const last = F[F.length - 1];
    return {
      u,
      noseRel: Number.isFinite(noseRel) ? noseRel : -0.45,
      armLen,
      hipY: median(F.map(f => f.hm.y)),
      ankleY: last.anklesVis > 0.5 ? median(F.map(f => (f.p.la.y + f.p.ra.y) / 2)) : null,
    };
  }
}
