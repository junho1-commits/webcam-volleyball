// 캔버스에 거울 모드 카메라 영상과 관절 뼈대를 그린다
import { LM } from './body.js';

const BONES = [
  [LM.ls, LM.rs], [LM.ls, LM.le], [LM.le, LM.lw], [LM.rs, LM.re], [LM.re, LM.rw],
  [LM.ls, LM.lh], [LM.rs, LM.rh], [LM.lh, LM.rh],
  [LM.lh, LM.lk], [LM.lk, LM.la], [LM.rh, LM.rk], [LM.rk, LM.ra],
];

export class Renderer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext('2d');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
  }

  // 화면을 꽉 채우도록(cover) 맞춘 영상 영역
  coverRect() {
    const cw = this.canvas.width, ch = this.canvas.height;
    const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
    const s = Math.max(cw / vw, ch / vh);
    const w = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  // MediaPipe 원본 좌표(0~1) → 거울 화면 좌표
  toScreen(p, r) {
    return { x: r.x + (1 - p.x) * r.w, y: r.y + p.y * r.h };
  }

  draw({ player, others = [], holding, color, players = null }) {
    const { ctx, canvas } = this;
    // 숨겨진 상태(크기 0)에서 만들어졌거나 크기가 바뀌었으면 다시 잰다.
    // (게임은 페이지를 열 때 카메라를 미리 켜므로, 작은 화면이 보이기 전에 Renderer가 만들어져 0×0이 되어 검은 화면이 나왔다)
    const dpr = devicePixelRatio || 1;
    if (canvas.clientWidth && (canvas.width !== Math.round(canvas.clientWidth * dpr) || canvas.height !== Math.round(canvas.clientHeight * dpr))) this.resize();
    const r = this.coverRect();

    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, canvas.width - r.x - r.w, r.y, r.w, r.h);
    ctx.restore();
    ctx.fillStyle = 'rgba(8, 14, 30, 0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (players) {
      const colors = ['#42a5f5', '#55e09b'];
      players.forEach((lm, i) => { if (lm) this.skeleton(lm, r, colors[i], 1); });
    } else {
      for (const lm of others) this.skeleton(lm, r, 'rgba(255,255,255,0.25)', 0.5);
      if (player) this.skeleton(player, r, holding ? color : '#ffffff', 1);
    }
  }

  skeleton(lm, r, color, scale) {
    const { ctx } = this;
    const lw = Math.max(4, r.h * 0.008) * scale;
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const [a, b] of BONES) {
      const p = this.toScreen(lm[a], r), q = this.toScreen(lm[b], r);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();

    if (scale < 1) return;
    // 머리
    const n = this.toScreen(lm[LM.nose], r);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(n.x, n.y, lw * 2.5, 0, Math.PI * 2); ctx.fill();
    // 손목은 크게 (공을 칠 부분)
    for (const i of [LM.lw, LM.rw]) {
      const w = this.toScreen(lm[i], r);
      ctx.fillStyle = '#ffd54f';
      ctx.beginPath(); ctx.arc(w.x, w.y, lw * 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}
