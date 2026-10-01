// 카메라 감독 (Claude 담당): Kinect Sports처럼 공과 선수를 따라 다가가고 물러나며 움직이는 랠리·서브 카메라.
// 사용: const director = new CameraDirector();
//       const shot = director.update(match, t, dt);   // 랠리·서브 중 매 프레임
//       shot: { position: Vector3, target: Vector3, fov, flash(0~1), name }  또는 null(감독이 맡지 않는 장면)
//       렌더러는 position/target/fov를 그대로 쓴다(부드럽게 움직이는 것은 감독이 이미 했다). flash가 0보다 크면 흰 번쩍임.
// 참고 영상: Kinect Sports Beach Volleyball (YouTube WurHrvfe6-8) 98~103초, 125~135초 장면을 0.2~0.4초 간격으로 보고 맞췄다.
//
// 좌표: 경기 논리는 x 오른쪽 = +, 렌더러 세계는 x를 뒤집는다(W(p) = (-x, y, z)). 우리 코트는 z < 0, 네트는 z = 0.
//
// 장면 흐름(우리 팀 공격 한 번):
//   receive(받는 선수 뒤로 다가감) → set(올라가며 공을 올려다봄) → approach(공격수 옆 뒤 낮게, 확대)
//   → punch(치는 순간 확 다가감 + 번쩍) → chase(공을 따라 네트를 넘음) → netLow(네트 높이에서 상대 수비를 봄)
//   → 상대가 받으면 behind(우리 뒤로 빠르게 돌아옴)
// 상대 공격(우리 블로킹): 상대가 토스하면 block(네트 앞 블로커 옆 뒤 높이에서 블로커의 손과 상대 공격수를 함께 크게)
// 서브: serveLow(서버 뒤 낮게) → 치면 serveFollow(공을 따라 하늘로 고개를 듦) → 네트를 넘으면 behind

import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const W = (p, y = p.y ?? 0) => V(-p.x, y, p.z);          // 논리 좌표 → 렌더러 세계
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 장면마다 따라가는 속도(시간 상수, 초: 작을수록 빨리 붙는다)와 화각
export const SHOTS = {
  behind:      { tau: 0.35, fov: 58 },
  receive:     { tau: 0.40, fov: 54 },
  set:         { tau: 0.30, fov: 56 },
  approach:    { tau: 0.22, fov: 50 },
  punch:       { tau: 0.05, fov: 44 },
  chase:       { tau: 0.22, fov: 56 },   // 2026-09-27: 0.10·62였을 때 치는 순간 카메라가 휙 움직여 버벅여 보였다
  netLow:      { tau: 0.25, fov: 52 },
  serveLow:    { tau: 0.30, fov: 55 },
  serveFollow: { tau: 0.15, fov: 60 },
  block:       { tau: 0.28, fov: 54 },
};
export const DIRECTOR = {
  promptLead: 0.6,     // 학생 판정 시각 이 시간 전부터는 카메라를 천천히만 움직인다(링과 공이 흔들려 보이지 않게)
  promptTauScale: 3,   // 그때 시간 상수를 이만큼 늘린다
  punchSeconds: 0,     // 치는 순간 확 다가가는 장면(punch). 0 = 쓰지 않음(2026-09-27 선생님: "스파이크 할 때 버벅거린다" —
                       //   0.14초 동안 한 프레임에 0.9m 다가갔다가 chase로 다시 물러나 끊겨 보였다. 번쩍임만 남긴다)
  flashSeconds: 0.14,  // 스파이크 번쩍임 길이
};

export class CameraDirector {
  constructor() {
    this.pos = null;
    this.target = null;
    this.fov = SHOTS.behind.fov;
    this.lastLaunch = null;
    this.touch = null;       // 마지막으로 공을 친 것 { team, who, type, t }
    this.flashUntil = -1;
    this.name = 'behind';
  }

  reset() { this.pos = null; this.touch = null; this.lastLaunch = null; this.lastT = null; }

  // m: Match. 감독이 맡는 장면(랠리·서브)이 아니면 null
  update(m, t, dt = 1 / 60) {
    if (!m || m.competitive || m.presentation) return null;
    const phase = m.phase ?? '';
    if (phase !== 'rally' && !phase.startsWith('serve-')) { this.touch = null; return null; }

    this.watchTouches(m, t);
    const shot = phase.startsWith('serve-') ? this.serveShot(m, t) : this.rallyShot(m, t);
    const spec = SHOTS[shot.name];
    let tau = shot.tau ?? spec.tau;
    if (this.humanPromptSoon(m, t)) tau *= DIRECTOR.promptTauScale;

    // 바로 전환(컷): 처음, 다른 장면(점수 클로즈업·리플레이 등)을 보여 주다 돌아왔을 때, 네트를 넘어가는 장면이 바뀔 때.
    // 부드럽게 옮기면 카메라가 코트를 가로지르며 네트를 뚫고 지나간다.
    const resumed = this.lastT == null || t - this.lastT > 0.25 || t < this.lastT;
    const crossesNet = this.pos && Math.sign(this.pos.z) !== Math.sign(shot.position.z) && shot.name !== 'chase';
    if (!this.pos || shot.cut || resumed || crossesNet) { this.pos = shot.position.clone(); this.target = shot.target.clone(); this.fov = shot.fov ?? spec.fov; }
    this.lastT = t;
    const k = 1 - Math.exp(-dt / Math.max(0.01, tau));
    this.pos.lerp(shot.position, k);
    this.target.lerp(shot.target, k);
    this.fov += ((shot.fov ?? spec.fov) - this.fov) * k;
    this.name = shot.name;
    const flash = t < this.flashUntil ? (this.flashUntil - t) / DIRECTOR.flashSeconds : 0;
    return { position: this.pos, target: this.target, fov: this.fov, flash, name: shot.name };
  }

  // 공이 새로 날아가기 시작하면 누가 무엇으로 쳤는지 기록한다
  watchTouches(m, t) {
    const b = m.ball;
    if (!b?.active || b.kind !== 'flight' || b.t0 === this.lastLaunch) return;
    this.lastLaunch = b.t0;
    const all = [...m.players, ...m.ai];
    let best = null;
    all.forEach((a, i) => {
      const d = Math.hypot(a.x - b.p0.x, a.z - b.p0.z);
      if (d < 2.2 && (!best || d < best.d)) best = { i, d, a };
    });
    let type = best?.a.anim?.type ?? 'unknown';
    let who = best?.i ?? (b.p0.z < 0 ? 0 : 2);
    // 블록에 맞고 나간 공: 네트 앞 공격수가 더 가까워도 블로커가 친 것으로 본다(19차 블록 결과)
    const blk = m.blockExp;
    if (blk?.done && Math.abs(b.t0 - blk.tHit) < 0.15 && m.actor(blk.who)?.anim?.type === 'block') { who = blk.who; type = 'block'; }
    this.touch = { who, team: who < 2 ? 'me' : 'ai', type, t: b.t0, from: { ...b.p0 }, to: { ...b.target }, tHit: b.tHit };
    if (this.touch.team === 'me' && type === 'spike') this.flashUntil = t + DIRECTOR.flashSeconds;
  }

  humanPromptSoon(m, t) {
    const e = m.exp;
    if (e && !e.done && m.actor(e.who)?.human && e.tHit - t < DIRECTOR.promptLead && e.tHit - t > -0.2) return true;
    const b = m.blockExp;
    return !!(b && !b.done && m.actor(b.who)?.human && b.tHit - t < DIRECTOR.promptLead);
  }

  humanCenter(m) {
    const humans = m.players.filter(p => p.human);
    const list = humans.length ? humans : m.players;
    return {
      x: list.reduce((s, p) => s + p.x, 0) / list.length,
      z: list.reduce((s, p) => s + p.z, 0) / list.length,
    };
  }

  // 기본: 우리 선수 뒤에서 공을 조금 따라 본다
  behindShot(m, t, tau = null) {
    const h = this.humanCenter(m);
    const ball = m.ball?.pos(t);
    const bx = ball ? -ball.x : -h.x * .3;
    return {
      name: 'behind', tau,
      position: V(-h.x * .6, 2.6, clamp(h.z - 4.2, -13.5, -8.5)),
      target: V(-h.x * .3 * .6 + bx * .4, 1.6 + clamp((ball?.y ?? 1.6) - 1.6, 0, 3) * .15, 4),
    };
  }

  rallyShot(m, t) {
    const touch = this.touch, b = m.ball, ball = b?.pos(t);
    if (!touch || !ball) return this.behindShot(m, t);
    const since = t - touch.t;
    const toOurSide = touch.to.z < 0;

    // 우리 블로킹: 상대가 토스한 뒤부터 블록 판정 뒤 0.25초까지(스터프 블록은 공이 꽂혀 튈 때까지). 블로커 옆 뒤(코트 가운데 쪽) 조금 높은 곳에서
    // 네트 위로 뻗은 손과 상대 공격수를 함께 잡는다. 블로커 뒤통수가 공을 가리면 반투명해지므로 옆으로 2.3m 비키고 3.2m 높이에서 내려다본다.
    const blk = this.blockView(m, t);
    if (blk) return blk;

    // 우리 팀이 공격한 직후: 치는 순간 다가감 → 공을 따라 네트를 넘음 → 네트 높이에서 상대 수비
    if (touch.team === 'me' && !toOurSide) {
      const attacker = m.actor(touch.who);
      const inward = attacker.x > 0 ? -1 : 1;                 // 코트 가운데 쪽
      // 서브: 서버 뒤 낮은 곳에서 공을 따라 하늘로 고개를 들며 조금 앞으로 나간다
      if (touch.type.startsWith('serve') && ball.z < .5) {
        return {
          name: 'serveFollow',
          position: V(-touch.from.x - (touch.from.x > 0 ? -1 : 1) * 1.2, 1.5 + clamp(since, 0, 1) * .8, touch.from.z - 2.6 + clamp(since, 0, 1) * 1.5),
          target: W(ball, ball.y + .3),
        };
      }
      // 치는 순간: 공격수 옆 뒤(코트 가운데 쪽)에서 가까이. 뒤통수가 가리지 않게 옆으로 빼고 공과 몸을 함께 잡는다
      if (since < DIRECTOR.punchSeconds && !touch.type.startsWith('serve') && touch.type !== 'unknown') {
        return {
          name: 'punch',
          position: W(attacker, 2.2).add(V(-inward * 1.9, 0, -1.3)),
          target: V(-touch.from.x, touch.from.y - .3, touch.from.z + .6),
        };
      }
      // 공을 따라 네트를 넘는다: 날아가는 시간의 앞 65% 동안
      const flight = Math.max(.1, touch.tHit - touch.t);
      if (since < flight * .65) {
        const dir = V(-(touch.to.x - touch.from.x), 0, touch.to.z - touch.from.z).normalize();
        return {
          name: 'chase',
          position: W(ball, Math.max(1.9, ball.y + 1.1)).addScaledVector(dir, -2.8),
          target: W(ball, ball.y).addScaledVector(dir, 3),
        };
      }
      // 네트 너머 낮은 곳에서 상대 수비를 크게 본다(우리 공격수와 겹치지 않게 네트 건너편에 둔다)
      const receiver = this.nearest(m.ai, touch.to);
      return {
        name: 'netLow',
        // 자리는 공 한 번에 한 번만 고른다(선수가 움직일 때마다 바꾸면 카메라가 튄다)
        position: (this.netSpot?.t === touch.t ? this.netSpot : (this.netSpot = { t: touch.t, p: this.clearSpot(m, [receiver.x * .5, receiver.x * .5 - 1.5, receiver.x * .5 + 1.5, 0], [.9, 1.8, 2.6], 1.15) })).p.clone(),
        target: W(receiver, .9),
      };
    }

    // 상대가 받거나 올린 공(상대 코트 안): 우리 뒤로 빠르게 돌아온다
    if (touch.team === 'ai' && !toOurSide) return this.behindShot(m, t, .25);

    // 우리 코트로 오는 공
    if (touch.team === 'ai' && toOurSide) {
      // 받는 선수 뒤로 다가가 선수를 크게 잡는다
      const who = m.landing?.who ?? this.nearestIndex(m.players, touch.to);
      const r = m.players[who];
      const toward = V(-(touch.to.x), 0, touch.to.z);
      return {
        name: 'receive',
        position: V(-r.x * .7, 2.1, clamp(r.z - 3.4, -12.5, -4.5)),
        target: W(r, 1.0).lerp(toward.setY(1.0), .35).setZ(r.z + 2.5),
      };
    }

    // 우리 팀 안에서 이어지는 공: 리시브 → 토스, 토스 → 공격
    const next = this.nearestIndex(m.players, touch.to);
    const receiver = m.players[next];
    if (['bump', 'dig', 'unknown'].includes(touch.type) || touch.to.y < 1.8) {
      // 토스하러 가는 공: 올라가며 공을 올려다본다
      // 토스하러 가는 공: 두 선수가 다 보이게 조금 물러나 올라가고, 공을 따라 고개를 든다
      const other = m.players[1 - next];
      const mid = { x: (receiver.x + other.x) / 2, z: Math.min(receiver.z, other.z) };
      return {
        name: 'set',
        position: V(-mid.x * .6, 2.9, clamp(mid.z - 4.2, -12, -6)),
        target: V(-(ball.x * .5 + mid.x * .5), 1.2 + clamp(ball.y - 1.2, 0, 3) * .35, receiver.z + 1.8),
      };
    }
    // 공격하러 가는 공(토스): 공격수 옆 뒤에서 낮게, 공과 공격수를 함께 확대
    const inward = receiver.x > 0 ? -1 : 1;
    // 공격수는 화면 아래쪽 1/3에 온몸이, 공은 위쪽에 보이게. 짝꿍이 카메라 앞을 가리지 않게 코트 바깥쪽에서 잡는다
    return {
      name: 'approach',
      position: W(receiver, 1.9).add(V(inward * 1.2, 0, -3.6)),
      target: W(receiver, 1.5).lerp(W(ball, ball.y), .35),
    };
  }

  blockView(m, t) {
    const b = m.blockExp, pend = m.pendingBlock;
    // 스터프 블록("빠방"): 블록에 맞은 공이 상대 코트에 꽂혀 튈 때까지 같은 자리에서 공을 따라 내려다본다
    const tc = this.touch;
    if (tc?.type === 'block' && tc.who < 2 && tc.to.z > 0 && t - tc.t < (tc.tHit - tc.t) + 0.6) {
      const blocker = m.players[tc.who], inward = blocker.x > 0 ? -1 : 1, ball = m.ball?.pos(t) ?? tc.to;
      return {
        name: 'block',
        position: V(-(blocker.x + inward * 2.3), 3.2, clamp(blocker.z - 3.4, -5, -3.2)),
        target: V(-ball.x, Math.max(.3, ball.y * .6), Math.max(1.2, ball.z)),
      };
    }
    const info = b && b.who < 2 && (!b.done || t - b.tHit < .25) ? { who: b.who, x: b.x } : (pend && pend.who < 2 ? { who: pend.who, x: pend.x } : null);
    if (!info) return null;
    const blocker = m.players[info.who];
    if (!blocker) return null;
    // 블로커가 학생일 때만. 짝꿍(AI)이 블로킹하고 학생이 뒤에서 수비해야 하면 네트를 잡으면 공이 안 보인다(2026-09-27 선생님).
    // 두 학생이 한 팀이면 수비하는 학생이 공을 봐야 하므로 역시 쓰지 않는다(평소 받는 장면으로).
    if (!blocker.human || m.players[1 - info.who]?.human) return null;
    const inward = blocker.x > 0 ? -1 : 1;
    const bx = (blocker.x + info.x) / 2;
    return {
      name: 'block',
      position: V(-(bx + inward * 2.3), 3.2, clamp(blocker.z - 3.4, -5, -3.2)),
      target: V(-(info.x * .7 - inward * .3), 1.9, 2.0),
    };
  }

  serveShot(m, t) {
    const server = m.actor(m.servingActorIndex);
    const ours = m.servingActorIndex < 2;
    const ball = m.ball?.pos(t);
    if (!ours) {
      // 상대 서브: 우리 코트 뒤에서 상대 서버를 멀리 본다
      const h = this.humanCenter(m);
      return { name: 'behind', position: V(-h.x * .5, 2.8, -12.5), target: V(-server.x * .7, 1.4, server.z) };
    }
    // 서버를 화면 한쪽에 두고 코트가 보이게: 서버에서 코트 가운데 쪽으로 1.2m 비껴, 뒤 2.6m, 낮게
    const inward = server.x > 0 ? -1 : 1;
    const base = W(server, 1.25).add(V(-inward * 1.2, 0, -2.6));
    // 토스한 공이 올라가면 공을 따라 고개를 든다
    const look = ball ? W(ball, ball.y) : W(server, 1.6).add(V(0, 0, 2));
    const up = ball ? clamp((ball.y - 1.4) / 2, 0, 1) : 0;
    return {
      name: 'serveLow',
      position: base.add(V(0, up * .4, 0)),
      target: W(server, 1.6).add(V(0, 0, 3)).lerp(look, .55 + up * .3),
    };
  }

  // 서브가 맞은 뒤(랠리로 넘어간 직후)에는 rallyShot의 chase가 이어받는다.

  // 후보 자리(논리 x × z) 중 모든 선수와 가장 멀리 떨어진 곳. 1.6m 넘게 떨어진 첫 자리를 고른다(앞 후보가 우선).
  // 네트 앞에 블로킹하러 선 선수 코앞에 카메라가 붙지 않게 한다(2026-09-27 GPT 캡처).
  clearSpot(m, xs, zs, y) {
    const all = [...m.players, ...m.ai];
    let best = null;
    for (const z of zs) for (const x of xs) {
      const gap = Math.min(...all.map(a => Math.hypot(a.x - x, a.z - z)));
      if (gap >= 1.6) return V(-x, y, z);
      if (!best || gap > best.gap) best = { gap, x, z };
    }
    return V(-best.x, y, best.z);
  }

  nearest(list, p) { return list[this.nearestIndex(list, p)]; }
  nearestIndex(list, p) {
    let best = 0;
    list.forEach((a, i) => { if (Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(list[best].x - p.x, list[best].z - p.z)) best = i; });
    return best;
  }
}
