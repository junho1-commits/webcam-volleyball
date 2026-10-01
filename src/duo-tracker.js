// 한 카메라에서 최대 두 명을 각각 독립적으로 보정하고 추적한다.
import { Tracker } from './tracker.js';
import { LM } from './body.js';

export class DuoTracker {
  constructor(maxPlayers = 2, { askHand = false, heldRepeat = false } = {}) {
    this.maxPlayers = maxPlayers;
    this.trackers = [new Tracker(), new Tracker()];
    for (const tracker of this.trackers) {
      tracker.askHand = askHand;
      tracker.heldRepeat = heldRepeat;
    }
    this.poseCount = 0;
  }

  recalibrate() {
    for (const tracker of this.trackers) tracker.recalibrate();
  }

  process(poses, t, aspect) {
    let visible = [...poses].slice(0, 2);
    const hip = lm => ({
      x: (lm[LM.lh].x + lm[LM.rh].x) / 2,
      y: (lm[LM.lh].y + lm[LM.rh].y) / 2,
    });
    const dist = (p, q) => p && q ? Math.hypot((p.x - q.x) * aspect, p.y - q.y) : 1e6;
    if (this.maxPlayers === 1) {
      // 혼자 하기에서는 기존 1P를 유지하며 구경하는 사람을 2P로 참가시키지 않는다.
      visible.sort((a, b) => dist(this.trackers[0].prevHip, hip(a)) - dist(this.trackers[0].prevHip, hip(b)));
      visible = visible.slice(0, 1);
    }
    const assigned = [null, null];
    if (visible.length === 2) {
      const h = visible.map(hip), a = this.trackers[0].prevHip, b = this.trackers[1].prevHip;
      if (a || b) {
        const direct = dist(a, h[0]) + dist(b, h[1]);
        const swap = dist(a, h[1]) + dist(b, h[0]);
        if (direct <= swap) [assigned[0], assigned[1]] = visible;
        else [assigned[1], assigned[0]] = visible;
      } else {
        // 첫 프레임만 거울 화면 왼쪽을 1P로 정한다. 이후는 거리로 ID를 유지한다.
        visible.sort((p, q) => (1 - hip(p).x) - (1 - hip(q).x));
        [assigned[0], assigned[1]] = visible;
      }
    } else if (visible.length === 1) {
      const h = hip(visible[0]);
      const d0 = dist(this.trackers[0].prevHip, h), d1 = dist(this.trackers[1].prevHip, h);
      const slot = this.maxPlayers === 1 ? 0 : d0 === d1 ? (this.trackers[0].prevHip ? 0 : (this.trackers[1].prevHip ? 1 : 0)) : (d0 < d1 ? 0 : 1);
      assigned[slot] = visible[0];
    }
    this.poseCount = visible.length;
    const results = this.trackers.map((tracker, i) => tracker.process(assigned[i] ? [assigned[i]] : [], t, aspect));
    const primary = results[0];
    const events = [], serveEvents = [], attackEvents = [];
    results.forEach((result, playerIndex) => {
      if (result.status !== 'ready') return;
      for (const event of result.events) events.push({ ...event, playerIndex });
      for (const event of result.serveEvents ?? []) serveEvents.push({ ...event, playerIndex });
      for (const event of result.attackEvents ?? []) attackEvents.push({ ...event, playerIndex });
    });
    return {
      status: results.some(r => r.status === 'ready')
        ? 'ready'
        : (results.some(r => r.status === 'hand') ? 'hand' : (results.find(r => r.status !== 'none')?.status ?? 'none')),
      progress: results.some(r => r.status === 'ready')
        ? 0
        : (results.find(r => r.status === 'hand')?.progress ?? Math.max(...results.map(r => r.progress ?? 0))),
      justCalibrated: results.some(r => r.justCalibrated),
      handChosen: results.map(r => r.handChosen ?? null),
      handTimeout: results.map(r => !!r.handTimeout),
      handStage: results.map(r => r.status === 'hand' ? { progress: r.progress ?? 0, raised: r.raised ?? null } : null),
      events,
      serveEvents,
      attackEvents,
      readyCount: results.filter(r => r.status === 'ready').length,
    };
  }

  get players() { return this.trackers.map(t => t.player).filter(Boolean); }
  get bodyXs() { return this.trackers.map(t => t.state === 'ready' ? t.bodyX : null); }
  get primary() { return this.trackers[0]; }

  handUp(playerIndex, t) {
    const attack = this.trackers[playerIndex]?.attack;
    const tip = attack?.handUp(t) ?? null;
    return tip ? { ...tip, heldEarly: !!attack.handUp(t - 300, 120) } : null;
  }
}
