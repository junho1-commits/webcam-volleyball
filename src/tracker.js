// 웹캠 포즈 → 플레이어 선택 → 몸 크기 측정 → 동작 판정 (테스트 페이지와 게임이 함께 사용)
import { pickPlayer, Smoother, buildFrame } from './body.js';
import { Calibrator } from './calibration.js';
import { GestureDetector } from './gestures.js';
import { ServeDetector } from './serve-detector.js';
import { AttackDetector } from './attack-detector.js';

// 치는 손 고르기(2026-09-27 선생님: "차렷 다음에 자기가 쓰는 손을 들게 하면 어떨까"):
// 한 손만 머리 위로(손목이 코보다 몸통 길이의 0.15배 넘게 위) 0.7초 들고 있으면 그 손으로 정한다. 8초 안에 안 들면 원래 설정대로.
export const HAND_PICK = { aboveNose: 0.15, holdMs: 700, timeoutMs: 8000 };

export class Tracker {
  constructor() {
    this.smoother = new Smoother(0.6);
    this.calibrator = new Calibrator();
    this.detector = null;
    this.state = 'position';   // position → calibrating → (hand) → ready
    this.askHand = false;
    this.heldRepeat = false;   // true면 리시브·토스·블로킹 자세를 유지하는 동안 held 알림도 준다(gestures.js TH.heldRepeatMs, 게임이 켠다)      // true면 차렷 측정 뒤 '치는 손 들기' 단계를 거친다(게임이 켠다. 시험·녹화 재생은 끔)
    this.handPick = null;
    this.lastSeenT = 0;
    this.prevHip = null;
    this.player = null;        // 화면에 그릴 관절 (MediaPipe 원본 좌표)
    this.others = [];
    this.frame = null;
    this.aspect = 16 / 9;
  }

  recalibrate() {
    this.calibrator.reset();
    this.detector = null;
    this.serve = null;
    this.attack = null;
    this.handPick = null;
    this.state = 'position';
  }

  // 이미 잰 몸 크기로 바로 판정을 시작한다 (녹화 재생용)
  useCalibration(cal) {
    this.detector = new GestureDetector(cal, { heldRepeat: this.heldRepeat });
    this.serve = new ServeDetector(cal);
    this.attack = new AttackDetector(cal);
    this.state = 'ready';
  }

  // status: 'none' 사람 없음 | 'far' 어깨·허리 안 보임 | 'small' 너무 멀리 있음 | 'calibrating' | 'hand'(치는 손 들기) | 'ready'
  // 손을 고르면 그 프레임에 { status: 'ready', justCalibrated: true, handChosen: 'left' | 'right' } (사람 기준 손).
  // 시간이 지나 못 고르면 handChosen 없이 { status: 'ready', justCalibrated: true, handTimeout: true }.
  // 'hand' 동안: { status: 'hand', progress: 0~1(들고 있는 시간), raised: 'left' | 'right' | null }
  process(poses, t, aspect) {
    this.aspect = aspect;
    const pick = poses.length ? pickPlayer(poses, this.prevHip, aspect) : null;
    this.others = poses.filter(p => p !== pick?.lm);

    if (!pick || pick.coreVis < 0.5) {
      this.player = pick ? this.smoother.apply(pick.lm) : null;
      this.frame = null;
      // 오래 안 보이면 다른 사람이 설 수 있으니 다시 측정
      if (t - this.lastSeenT > 2000 && this.state !== 'position') {
        this.smoother.reset();
        this.prevHip = null;
        this.recalibrate();
      }
      this.detector?.reset();
      this.serve?.reset();
      this.attack?.reset();
      if (this.state === 'calibrating') { this.calibrator.reset(); this.state = 'position'; }
      return { status: pick ? 'far' : 'none', events: [] };
    }

    this.lastSeenT = t;
    this.prevHip = pick.hip;
    this.player = this.smoother.apply(pick.lm);
    const f = this.frame = buildFrame(this.player, t, aspect);

    if (this.state === 'hand') return this.pickHand(f, t);

    if (this.state !== 'ready') {
      if (pick.torso < 0.12) {
        this.state = 'position';
        this.calibrator.reset();
        return { status: 'small', events: [] };
      }
      this.state = 'calibrating';
      const r = this.calibrator.feed(f);
      if (r.done) {
        this.detector = new GestureDetector(r.result, { heldRepeat: this.heldRepeat });
        this.serve = new ServeDetector(r.result);
        this.attack = new AttackDetector(r.result);
        if (this.askHand) {
          this.state = 'hand';
          this.handPick = { t0: t, side: null, since: t };
          return { status: 'hand', progress: 0, raised: null, events: [] };
        }
        this.state = 'ready';
        return { status: 'ready', justCalibrated: true, events: [] };
      }
      return { status: 'calibrating', progress: r.progress, events: [] };
    }

    // 서브(토스 → 다른 손 타격)는 따로 판정해 serveEvents로 준다: serveToss, serveHit, serveTossExpired
    // 공격(스파이크 방향)은 attackEvents로 준다. 팁은 this.attack.handUp(시각)으로 묻는다 (attack-detector.js)
    return { status: 'ready', events: this.detector.update(f), serveEvents: this.serve.update(f), attackEvents: this.attack.update(f) };
  }

  pickHand(f, t) {
    const hp = this.handPick;
    const up = side => {
      const w = f.p[side === 'left' ? 'lw' : 'rw'];
      return w.v > 0.5 && f.p.nose.y - w.y > HAND_PICK.aboveNose * f.torso;
    };
    const l = up('left'), r = up('right');
    const raised = l !== r ? (l ? 'left' : 'right') : null;   // 두 손을 다 들면 고르지 않는다
    if (raised !== hp.side) { hp.side = raised; hp.since = t; }
    const held = raised ? t - hp.since : 0;
    if (raised && held >= HAND_PICK.holdMs) {
      this.state = 'ready'; this.handPick = null;
      this.serve?.reset(); this.attack?.reset(); this.detector?.reset();   // 손 든 동작이 토스·팁으로 읽히지 않게
      return { status: 'ready', justCalibrated: true, handChosen: raised, events: [] };
    }
    if (t - hp.t0 >= HAND_PICK.timeoutMs) {
      this.state = 'ready'; this.handPick = null;
      return { status: 'ready', justCalibrated: true, handTimeout: true, events: [] };
    }
    return { status: 'hand', progress: Math.min(1, held / HAND_PICK.holdMs), raised, events: [] };
  }

  get holding() { return this.detector?.holding ?? null; }

  // 화면에서 몸이 있는 좌우 위치 (0 = 왼쪽, 1 = 오른쪽, 거울 기준)
  get bodyX() { return this.frame ? this.frame.hm.x / this.aspect : null; }
}

export const STATUS_MSG = {
  none: '화면 앞에 서 주세요',
  far: '한 걸음 뒤로 가 주세요\n(어깨와 허리가 보여야 해요)',
  small: '조금 앞으로 와 주세요',
  calibrating: '차렷 자세로 가만히 서 있으세요',
  hand: '공을 치는 손을 번쩍 들어요 ✋',
};
