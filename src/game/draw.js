// 옆에서 본 해변 배구 코트 그리기 (2D, 3단계에서 3D로 바꿀 예정)
import { COURT } from './rules.js';
import { GESTURES } from '../gestures.js';

const ANIM = 0.6;          // 동작 모션 길이(초)
const BALL_R = 0.25;
const TEAM = {
  me: { shirt: '#29b6f6', shorts: '#0d47a1' },
  ai: { shirt: '#ef5350', shorts: '#7f1010' },
};
const SKIN = '#f1c27d';

// 동작별 손 위치 (발 기준, 네트 쪽이 +x)
const HANDS = {
  idle:  [[0.12, 0.95], [-0.08, 0.97]],
  bump:  [[0.5, 1.0], [0.46, 1.03]],
  set:   [[0.18, 2.05], [0.06, 2.08]],
  block: [[0.14, 2.4], [0.04, 2.42]],
  jump:  [[0.35, 2.0], [-0.25, 2.0]],
  windup: [[-0.15, 2.3], [0.3, 1.9]],
  swing: [[0.6, 1.35], [0.2, 1.15]],
};

export class GameRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = devicePixelRatio || 1;
    const c = this.canvas;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    this.s = Math.min(c.width / 21, c.height / 8.5);   // 1m가 몇 픽셀인지
    this.cx = c.width / 2;
    this.gy = c.height * 0.8;
  }

  X(x) { return this.cx + x * this.s; }
  Y(y) { return this.gy - y * this.s; }

  draw(m, t) {
    this.background();
    this.courtLines();
    const prompt = m.prompt;
    if (prompt?.hitX != null) this.landingZone(prompt.hitX, prompt.inReach, m.D.reach);

    const ball = m.ball.pos(t);
    if (ball) this.shadow(ball.x, 0.5 * Math.max(0.3, 1 - ball.y / 8));
    this.shadow(m.me.x, 0.6);
    for (const a of m.ai) this.shadow(a.x, 0.6);

    this.net();
    for (const a of m.ai) this.person(a.x, -1, TEAM.ai, a.anim, t);
    this.person(m.me.x, 1, TEAM.me, m.me.anim, t);

    if (ball) this.ball(ball, t);
    if (prompt?.tHit != null && ball) this.approachRing(ball, prompt, t, m.D);
    if (prompt) this.bubble(m, prompt, t);
    if (m.blockChance && m.me.x < -m.D.blockZone) {
      this.text('네트 앞으로 가면 블로킹!', this.X(-2.2), this.Y(4.3), 0.4, '#ba68c8');
    }
    for (const p of m.popups) {
      const k = (t - p.t0) / 1.2;
      this.text(p.text, this.X(p.x), this.Y(p.y + k * 0.8), 0.55, p.color, 1 - k * k);
    }
  }

  background() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height, horizon = this.Y(2.4);
    let g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#4aa8e8');
    g.addColorStop(1, '#bfe6fb');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizon);

    ctx.fillStyle = '#fff3b0';
    ctx.beginPath(); ctx.arc(W * 0.85, H * 0.13, H * 0.06, 0, Math.PI * 2); ctx.fill();

    g = ctx.createLinearGradient(0, horizon, 0, this.Y(0.7));
    g.addColorStop(0, '#1f7fb8');
    g.addColorStop(1, '#4fc0dc');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, W, this.Y(0.7) - horizon);

    g = ctx.createLinearGradient(0, this.Y(0.7), 0, H);
    g.addColorStop(0, '#f5e2b0');
    g.addColorStop(1, '#e2bd78');
    ctx.fillStyle = g;
    ctx.fillRect(0, this.Y(0.7), W, H - this.Y(0.7));
  }

  courtLines() {
    const { ctx, s } = this;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 0.06 * s;
    ctx.beginPath();
    ctx.moveTo(this.X(-COURT.half), this.Y(0));
    ctx.lineTo(this.X(COURT.half), this.Y(0));
    ctx.stroke();
    // 코트 끝 깃발
    for (const x of [-COURT.half, COURT.half]) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(this.X(x) - 0.03 * s, this.Y(1.0), 0.06 * s, 1.0 * s);
      ctx.fillStyle = '#ff7043';
      ctx.beginPath();
      ctx.moveTo(this.X(x), this.Y(1.0));
      ctx.lineTo(this.X(x) + (x < 0 ? -1 : 1) * 0.4 * s, this.Y(0.88));
      ctx.lineTo(this.X(x), this.Y(0.76));
      ctx.fill();
    }
  }

  landingZone(x, inReach, reach) {
    const { ctx, s } = this;
    ctx.fillStyle = inReach ? 'rgba(102,187,106,0.35)' : 'rgba(255,152,0,0.35)';
    ctx.strokeStyle = inReach ? '#66bb6a' : '#ff9800';
    ctx.lineWidth = 0.05 * s;
    ctx.beginPath();
    ctx.ellipse(this.X(x), this.Y(0), reach * s, 0.18 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  shadow(x, size) {
    const { ctx, s } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(this.X(x), this.Y(0), size * s, 0.1 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  net() {
    const { ctx, s } = this;
    const top = COURT.netH;
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(this.X(0) - 0.07 * s, this.Y(top + 0.25), 0.14 * s, (top + 0.25) * s);
    // 그물
    ctx.fillStyle = 'rgba(30,30,30,0.35)';
    ctx.fillRect(this.X(-0.15), this.Y(top), 0.3 * s, 1.0 * s);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.02 * s;
    ctx.beginPath();
    for (let y = top - 1.0; y <= top; y += 0.1) {
      ctx.moveTo(this.X(-0.15), this.Y(y));
      ctx.lineTo(this.X(0.15), this.Y(y));
    }
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(this.X(-0.15), this.Y(top), 0.3 * s, 0.08 * s);
  }

  // 사람: 발 위치 x, facing(+1 오른쪽), 팀 색, 모션
  person(x, facing, team, anim, t) {
    const { ctx, s } = this;
    const k = anim ? (t - anim.t0) / ANIM : 1;
    let type = k < 1 ? anim.type : 'idle';
    const jumps = type === 'block' || type === 'jump' || (type === 'spike' && anim.jump) || (type === 'serve' && anim.jump);
    const lift = jumps ? 0.55 * Math.sin(Math.PI * k) : 0;

    ctx.save();
    ctx.translate(this.X(x), this.Y(lift));
    ctx.scale(facing * s, -s);   // 이제 단위는 m, 위쪽이 +
    if (type === 'dive') {
      ctx.rotate(-1.2 * Math.min(1, k * 4));
      type = 'bump';
    }
    let hands = HANDS[type] ?? HANDS.idle;
    if (type === 'spike' || type === 'serve') hands = k < 0.35 ? HANDS.windup : HANDS.swing;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const knee = jumps ? 0.2 : 0.06;
    // 다리
    ctx.strokeStyle = SKIN;
    ctx.lineWidth = 0.13;
    ctx.beginPath();
    for (const sx of [-1, 1]) {
      ctx.moveTo(sx * 0.07, 0.95);
      ctx.lineTo(sx * 0.1 + knee, 0.5);
      ctx.lineTo(sx * 0.16, 0.02);
    }
    ctx.stroke();
    // 반바지
    ctx.fillStyle = team.shorts;
    ctx.fillRect(-0.17, 0.72, 0.34, 0.28);
    // 몸통
    ctx.strokeStyle = team.shirt;
    ctx.lineWidth = 0.34;
    ctx.beginPath();
    ctx.moveTo(0, 0.98);
    ctx.lineTo(0, 1.4);
    ctx.stroke();
    // 팔
    ctx.strokeStyle = SKIN;
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    for (const [hx, hy] of hands) {
      const ex = hx / 2, ey = (1.42 + hy) / 2 - 0.06;
      ctx.moveTo(0, 1.42);
      ctx.lineTo(ex, ey);
      ctx.lineTo(hx, hy);
    }
    ctx.stroke();
    // 머리
    ctx.fillStyle = SKIN;
    ctx.beginPath(); ctx.arc(0.03, 1.68, 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3e2723';
    ctx.beginPath(); ctx.arc(0.0, 1.74, 0.17, 0, Math.PI); ctx.fill();
    ctx.restore();
  }

  ball(p, t) {
    const { ctx, s } = this;
    const x = this.X(p.x), y = this.Y(p.y), r = BALL_R * s;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 6);
    ctx.fillStyle = '#fffdf2';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = r * 0.28;
    ctx.strokeStyle = '#1e88e5';
    ctx.beginPath(); ctx.arc(-r * 0.9, 0, r * 0.95, -0.9, 0.9); ctx.stroke();
    ctx.strokeStyle = '#fdd835';
    ctx.beginPath(); ctx.arc(r * 0.9, 0, r * 0.95, Math.PI - 0.9, Math.PI + 0.9); ctx.stroke();
    ctx.lineWidth = r * 0.08;
    ctx.strokeStyle = '#555';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // 공 주위로 줄어드는 원: 원이 공에 닿을 때가 치는 순간
  approachRing(ball, prompt, t, D) {
    const { ctx, s } = this;
    const lead = D.early + 0.6;
    const remain = prompt.tHit - t;
    if (remain > lead || remain < -D.late) return;
    const g = GESTURES[prompt.action];
    const k = Math.max(0, remain) / lead;
    const open = remain <= D.early;
    ctx.strokeStyle = open ? g.color : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = (open ? 0.12 : 0.06) * s;
    ctx.beginPath();
    ctx.arc(this.X(ball.x), this.Y(ball.y), BALL_R * s * (1.3 + 5 * k), 0, Math.PI * 2);
    ctx.stroke();
  }

  // 플레이어 머리 위 말풍선: 지금 해야 할 동작
  bubble(m, prompt, t) {
    const { ctx, s } = this;
    const g = GESTURES[prompt.action];
    const x = this.X(m.me.x), y = this.Y(3.1);
    ctx.font = `900 ${0.55 * s}px "Malgun Gothic", sans-serif`;
    const label = g.name + '!';
    const w = ctx.measureText(label).width + 0.6 * s, h = 0.85 * s;
    ctx.fillStyle = g.color;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.moveTo(x - 0.2 * s, y + h / 2);
    ctx.lineTo(x, y + h / 2 + 0.25 * s);
    ctx.lineTo(x + 0.2 * s, y + h / 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.03 * s);

    // 공이 떨어질 곳이 멀면 화살표
    if (prompt.hitX != null && !prompt.inReach) {
      const dir = prompt.hitX > m.me.x ? 1 : -1;
      const bob = Math.sin(t * 10) * 0.12;
      this.text(dir > 0 ? '→' : '←', x + dir * (w / 2 + (0.5 + bob) * s), y, 0.8, '#ff9800');
    }
  }

  text(str, x, y, size, color, alpha = 1) {
    const { ctx, s } = this;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `900 ${size * s}px "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * s * 0.18;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
    ctx.restore();
  }
}
