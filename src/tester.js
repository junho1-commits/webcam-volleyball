// 동작 하나를 10번 시켜 보고 몇 번 인식됐는지 센다 (1단계 완료 기준: 10번 중 8번)
import { GESTURES } from './gestures.js';

const READY_MS = 1500;
const GO_MS = 3000;
const RESULT_MS = 900;

export class Tester {
  constructor(sfx) {
    this.sfx = sfx;
    this.results = {};   // type → { ok, total, wrong: { type: n } }
    this.run = null;
  }

  get active() { return !!this.run; }

  start(type, t, trials = 10) {
    this.results[type] = { ok: 0, total: 0, wrong: {} };
    this.run = { type, trials, trial: 1, phase: 'ready', phaseT: t, marks: [] };
  }

  stop() { this.run = null; }

  onGesture(ev) {
    const r = this.run;
    if (!r || r.phase !== 'go') return;
    const res = this.results[r.type];
    if (ev.type === r.type) {
      res.ok++; res.total++;
      r.marks.push(true);
      r.phase = 'result'; r.phaseT = ev.t; r.last = true;
      this.sfx.ok();
    } else {
      res.wrong[ev.type] = (res.wrong[ev.type] ?? 0) + 1;
    }
  }

  // 매 프레임 호출. 화면에 그릴 상태를 돌려준다
  tick(t) {
    const r = this.run;
    if (!r) return null;
    const el = t - r.phaseT;
    if (r.phase === 'ready' && el >= READY_MS) {
      r.phase = 'go'; r.phaseT = t; this.sfx.tick();
    } else if (r.phase === 'go' && el >= GO_MS) {
      this.results[r.type].total++;
      r.marks.push(false);
      r.phase = 'result'; r.phaseT = t; r.last = false;
      this.sfx.fail();
    } else if (r.phase === 'result' && el >= RESULT_MS) {
      if (r.trial >= r.trials) { r.phase = 'summary'; r.phaseT = t; }
      else { r.trial++; r.phase = 'ready'; r.phaseT = t; }
    } else if (r.phase === 'summary' && el >= 4000) {
      this.run = null;
      return null;
    }
    return {
      ...r,
      g: GESTURES[r.type],
      goLeft: r.phase === 'go' ? 1 - (t - r.phaseT) / GO_MS : 0,
      result: this.results[r.type],
    };
  }
}
