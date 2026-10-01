// 3차원 포물선 공. 출발점·도착점·비행 시간으로 궤적을 정한다.
import { G } from './rules.js';

export class Ball {
  constructor() { this.active = false; this.rest = null; this.kind = 'rest'; this.flightStyle = null; this.gravity = G; }

  launch(from, to, T, t, style = null) {
    this.contactHoldUntil = null;
    this.active = true;
    this.rest = null;
    this.kind = 'flight';
    this.flightStyle = style;
    this.p0 = { ...from };
    this.target = { ...to };
    this.t0 = t;
    this.tHit = t + T;
    this.gravity = G;
    this.spikeCurveExp = 1.35;
    if (style === 'spike' && from.y > to.y && from.z * to.z < 0) {
      const uNet = Math.abs(from.z) / Math.abs(to.z - from.z);
      const maxProgress = (from.y - 2.15) / (from.y - to.y);
      if (uNet > 0 && uNet < 1 && maxProgress > 0 && maxProgress < 1) {
        // z와 총 비행시간은 그대로 두되, 네트에서는 최소 2.15m를 확보한다.
        this.spikeCurveExp = Math.max(this.spikeCurveExp, Math.log(maxProgress) / Math.log(uNet) + .03);
      }
    }
    this.v = {
      x: (to.x - from.x) / T,
      y: (to.y - from.y + 0.5 * G * T * T) / T,
      z: (to.z - from.z) / T,
    };
  }

  toss(from, apex, t, gravity = G, floorY = null, floorUntil = 0) {
    const rise = Math.max(0.15, apex.y - from.y);
    const vy = Math.sqrt(2 * gravity * rise);
    const tApex = vy / gravity;
    this.active = true; this.rest = null; this.kind = 'toss'; this.flightStyle = null;
    this.gravity = gravity;
    this.tossFloorY = floorY; this.tossFloorUntil = floorUntil;
    this.p0 = { ...from }; this.target = { ...apex }; this.t0 = t; this.tHit = t + tApex;
    this.v = { x: (apex.x - from.x) / tApex, y: vy, z: (apex.z - from.z) / tApex };
    return tApex;
  }

  returnTo(from, to, T, t) {
    this.active = true; this.rest = null; this.kind = 'return'; this.flightStyle = null;
    this.p0 = { ...from }; this.target = { ...to }; this.t0 = t; this.tHit = t + T;
    this.v = { x: 0, y: 0, z: 0 };
  }

  pos(t) {
    if (!this.active) return this.rest;
    if (this.contactHoldUntil && t >= this.tHit && t <= this.contactHoldUntil) return { ...this.target };
    const d = t - this.t0;
    if (this.kind === 'return') {
      const u = Math.max(0, Math.min(1, d / Math.max(1e-6, this.tHit - this.t0)));
      const s = u * u * (3 - 2 * u);
      return {
        x: this.p0.x + (this.target.x - this.p0.x) * s,
        y: this.p0.y + (this.target.y - this.p0.y) * s,
        z: this.p0.z + (this.target.z - this.p0.z) * s,
      };
    }
    let x = this.p0.x + this.v.x * d;
    if (this.kind === 'flight' && this.flightStyle === 'float') {
      const u = Math.max(0, Math.min(1, d / Math.max(1e-6, this.tHit - this.t0)));
      // 플로터: 가운데에서만 살짝(최대 ±7cm) 흔들리고 시작·끝은 0 (착지 지점은 그대로)
      x += 0.07 * Math.sin(u * Math.PI) * Math.sin(u * Math.PI * 3);
    }
    let y;
    if (this.kind === 'flight' && this.flightStyle === 'spike') {
      // 도착 뒤에도 같은 하강곡선을 연장해야 지면 판정이 정상적으로 이어진다.
      const u = Math.max(0, d / Math.max(1e-6, this.tHit - this.t0));
      // 스파이크는 접촉 직후부터 단조 하강한다. 긴 반응시간이어도 위로 뜨지 않는다.
      y = this.p0.y + (this.target.y - this.p0.y) * Math.pow(u, this.spikeCurveExp ?? 1.35);
    } else y = this.p0.y + this.v.y * d - 0.5 * this.gravity * d * d;
    if (this.kind === 'toss' && this.tossFloorY != null) {
      const g = this.gravity, tA = this.v.y / g;
      const apexY = this.p0.y + this.v.y * tA - 0.5 * g * tA * tA;
      const tFloor = tA + Math.sqrt(2 * Math.max(0, apexY - this.tossFloorY) / g);
      if (d > tFloor) {
        const r = Math.max(0, d - Math.max(tFloor, this.tossFloorUntil));
        y = this.tossFloorY - 0.5 * g * r * r;
      }
    }
    return {
      x,
      y,
      z: this.p0.z + this.v.z * d,
    };
  }

  timeAtZ(z) {
    if (!this.active || Math.abs(this.v.z) < 1e-6) return Infinity;
    return this.t0 + (z - this.p0.z) / this.v.z;
  }

  stopAt(p) { this.active = false; this.rest = { ...p }; this.kind = 'rest'; this.flightStyle = null; }
}
