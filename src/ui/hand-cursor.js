/**
 * hand-cursor.js
 * 
 * 손으로 고르는 메뉴 모듈 (Xbox 키넥트 스포츠 스타일)
 * - handFromPose: 웹캠 랜드마크에서 손 선택 및 조작 상자 정규화 (거울 모드 x = 1 - x)
 * - WaveDetector: 손 흔들기 감지기 (1.5초 내 3회 이상 방향 전환 및 2초 쿨다운)
 * - HandCursor: 원거리 손 커서, One Euro Filter 떨림 보정, 히스테리시스 머물러 선택
 */

// ── One Euro Filter (손떨림 방지 및 즉각적 반응을 위한 저역 통과 필터)
class LowPassFilter {
  constructor(alpha = 0) {
    this.y = 0;
    this.s = 0;
    this.initialized = false;
    this.setAlpha(alpha);
  }

  setAlpha(alpha) {
    this.alpha = Math.max(0, Math.min(1, alpha));
  }

  filter(val) {
    if (!this.initialized) {
      this.s = val;
      this.initialized = true;
      return val;
    }
    this.s = this.alpha * val + (1 - this.alpha) * this.s;
    return this.s;
  }

  reset() {
    this.initialized = false;
  }
}

class OneEuroFilter {
  constructor(freq = 60, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.lastTime = 0;
  }

  alpha(rate, cutoff) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    const te = 1.0 / rate;
    return 1.0 / (1.0 + tau / te);
  }

  filter(val, timestamp = performance.now()) {
    if (this.lastTime === 0) {
      this.lastTime = timestamp;
      return this.xFilter.filter(val);
    }
    const dt = Math.max(1e-3, (timestamp - this.lastTime) / 1000);
    this.lastTime = timestamp;
    const rate = 1.0 / dt;

    const prevX = this.xFilter.initialized ? this.xFilter.s : val;
    const dx = (val - prevX) * rate;
    const edx = this.dxFilter.filter(dx, this.alpha(rate, this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    this.xFilter.setAlpha(this.alpha(rate, cutoff));
    return this.xFilter.filter(val);
  }

  reset() {
    this.lastTime = 0;
    this.xFilter.reset();
    this.dxFilter.reset();
  }
}

// ── 관절 인덱스 (MediaPipe Pose)
const LM = {
  ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16,
  lh: 23, rh: 24,
};

/**
 * 랜드마크에서 사용할 손을 결정하고 화면 기준(0~1) 정규화 좌표 반환
 * @param {Array|Array[]} landmarks - 33개 랜드마크 객체 배열 또는 여러 사람의 배열
 * @param {Object} [prevHand] - 직전 프레임의 손 정보 { x, y, visible, side }
 * @returns {{ x: number, y: number, visible: boolean, side: string|null, torso: number }}
 */
export function handFromPose(landmarks, prevHand = null) {
  if (!landmarks || landmarks.length === 0) {
    return { x: prevHand?.x ?? 0.5, y: prevHand?.y ?? 0.5, visible: false, side: null, torso: 0.2 };
  }

  // 복수 인원일 경우 처리: 이미 손을 들고 있던 사람 우선, 아니면 먼저 손을 든 사람
  let lm = landmarks;
  if (Array.isArray(landmarks[0])) {
    let chosen = null;
    for (const personLm of landmarks) {
      const candidate = evalHandSingle(personLm, prevHand);
      if (candidate.visible) {
        chosen = candidate;
        // 이전 추적 손과 같은 쪽을 유지하고 있다면 즉시 유지
        if (prevHand?.visible && prevHand?.side === candidate.side) {
          break;
        }
      }
    }
    return chosen || { x: prevHand?.x ?? 0.5, y: prevHand?.y ?? 0.5, visible: false, side: null, torso: 0.2 };
  }

  return evalHandSingle(lm, prevHand);
}

function evalHandSingle(lm, prevHand) {
  if (!lm || lm.length < 25) {
    return { x: prevHand?.x ?? 0.5, y: prevHand?.y ?? 0.5, visible: false, side: null, torso: 0.2 };
  }

  const ls = lm[LM.ls], rs = lm[LM.rs];
  const le = lm[LM.le], re = lm[LM.re];
  const lw = lm[LM.lw], rw = lm[LM.rw];
  const lh = lm[LM.lh], rh = lm[LM.rh];

  if (!ls || !rs || !le || !re || !lw || !rw || !lh || !rh) {
    return { x: prevHand?.x ?? 0.5, y: prevHand?.y ?? 0.5, visible: false, side: null, torso: 0.2 };
  }

  // 어깨 중심 및 골반 중심
  const shCenter = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipCenter = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const torso = Math.max(0.08, Math.hypot(shCenter.x - hipCenter.x, shCenter.y - hipCenter.y));

  // 손 들기 조건:
  // 1. 손목이 팔꿈치보다 위에 있음 (y값이 작음)
  // 2. 골반보다 높이 든 손 (손목 y < 골반 중심 y)
  const leftUp = (lw.y < le.y) && (lw.y < hipCenter.y);
  const rightUp = (rw.y < re.y) && (rw.y < hipCenter.y);

  // 어느 손을 쓸까:
  // 한 번 정한 손은 내리기 전까지 유지
  let side = null;
  if (prevHand && prevHand.visible && prevHand.side) {
    if (prevHand.side === 'left' && leftUp) side = 'left';
    else if (prevHand.side === 'right' && rightUp) side = 'right';
  }

  if (!side) {
    if (leftUp && rightUp) {
      // 둘 다 들었으면 더 높은 손 (y가 더 작은 손)
      side = lw.y < rw.y ? 'left' : 'right';
    } else if (leftUp) {
      side = 'left';
    } else if (rightUp) {
      side = 'right';
    }
  }

  if (!side) {
    return { x: prevHand?.x ?? 0.5, y: prevHand?.y ?? 0.5, visible: false, side: null, torso };
  }

  // 화면은 거울 모드이므로 화면 x = 1 - 랜드마크 x
  const wrist = side === 'left' ? lw : rw;
  const shoulder = side === 'left' ? ls : rs;

  const screenWristX = 1 - wrist.x;
  const screenWristY = wrist.y;
  const screenShoulderX = 1 - shoulder.x;
  const screenShoulderY = shoulder.y;

  // 움직이기 편한 상자: 든 손 쪽 어깨를 중심으로 가로 1.6 × 세로 1.2 몸통 길이
  const boxW = 1.6 * torso;
  const boxH = 1.2 * torso;

  // 상자 안의 손목 움직임을 화면 0~1 전체에 대응
  const normX = (screenWristX - (screenShoulderX - boxW / 2)) / boxW;
  const normY = (screenWristY - (screenShoulderY - boxH / 2)) / boxH;

  const clampedX = Math.max(0, Math.min(1, normX));
  const clampedY = Math.max(0, Math.min(1, normY));

  return {
    x: clampedX,
    y: clampedY,
    visible: true,
    side,
    torso,
  };
}

/**
 * 손 흔들기 감지기 (WaveDetector)
 * - 손목이 팔꿈치보다 위에 있는 상태
 * - 1.5초 안에 좌우 방향 전환 3회 이상 & 폭이 몸통 길이의 0.25배 이상
 * - 감지 뒤 2초 쿨다운
 */
export class WaveDetector {
  constructor({ onWave } = {}) {
    this.onWave = onWave;
    this.history = [];      // { t, x, side, torso }
    this.lastWaveTime = -Infinity;
    this.cooldownMs = 2000;
    this.windowMs = 1500;
  }

  update(landmarks, tMs = performance.now()) {
    if (tMs - this.lastWaveTime < this.cooldownMs) return false;
    if (!landmarks) return false;

    // 복수 인원일 경우 한 명 추출
    const lm = Array.isArray(landmarks[0]) ? landmarks[0] : landmarks;
    if (!lm || lm.length < 25) return false;

    const ls = lm[LM.ls], rs = lm[LM.rs];
    const le = lm[LM.le], re = lm[LM.re];
    const lw = lm[LM.lw], rw = lm[LM.rw];
    const lh = lm[LM.lh], rh = lm[LM.rh];
    if (!ls || !rs || !le || !re || !lw || !rw || !lh || !rh) return false;

    const torso = Math.max(0.08, Math.hypot((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2, (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2));

    // 팔꿈치보다 위에 있는 손목 검사
    const leftActive = lw.y < le.y;
    const rightActive = rw.y < re.y;

    if (!leftActive && !rightActive) {
      this.history = [];
      return false;
    }

    // 더 높은 손 사용
    const activeSide = (leftActive && rightActive)
      ? (lw.y < rw.y ? 'left' : 'right')
      : (leftActive ? 'left' : 'right');

    const wrist = activeSide === 'left' ? lw : rw;
    const screenWristX = 1 - wrist.x;

    // 이전 손과 달라졌으면 히스토리 초기화
    if (this.history.length > 0 && this.history[this.history.length - 1].side !== activeSide) {
      this.history = [];
    }

    // 윈도우(1.5초) 이전 데이터 제거
    this.history.push({ t: tMs, x: screenWristX, side: activeSide, torso });
    const cutoff = tMs - this.windowMs;
    this.history = this.history.filter(p => p.t >= cutoff);

    if (this.history.length < 6) return false;

    // 좌우 극점(변곡점) 감지
    // smoothed differences to identify turns
    const minAmp = torso * 0.25; // 몸통 길이의 0.25배 이상 폭
    const extrema = []; // { x, type: 'min' | 'max' }

    let dir = 0; // 1: 증가 중, -1: 감소 중
    let lastTurnX = this.history[0].x;

    for (let i = 1; i < this.history.length; i++) {
      const dx = this.history[i].x - this.history[i - 1].x;
      if (Math.abs(dx) < 0.003) continue; // 미세 노이즈 무시

      const currentDir = dx > 0 ? 1 : -1;
      if (dir === 0) {
        dir = currentDir;
      } else if (currentDir !== dir) {
        // 방향 전환 감지
        const turnX = this.history[i - 1].x;
        const amp = Math.abs(turnX - lastTurnX);
        if (amp >= minAmp) {
          extrema.push({ x: turnX, type: dir > 0 ? 'max' : 'min' });
          lastTurnX = turnX;
          dir = currentDir;
        }
      }
    }

    // 유효한 방향 전환이 3회 이상이면 손 흔들기 인정
    if (extrema.length >= 3) {
      this.lastWaveTime = tMs;
      this.history = [];
      if (this.onWave) this.onWave();
      return true;
    }

    return false;
  }
}

/**
 * 손 커서 및 머물러 선택 관리자 (HandCursor)
 */
export class HandCursor {
  constructor({
    root = document.body,
    dwellMs = 1500,
    onHover = null,
    onSelect = null,
  } = {}) {
    this.root = root;
    this.dwellMs = dwellMs;
    this.onHover = onHover;
    this.onSelect = onSelect;

    this.mouseEnabled = false;
    this.lastHandTime = 0;
    this.currentTarget = null;
    this.dwellStartTime = 0;
    this.cooldownUntil = 0;
    this.currentPos = { x: 0.5, y: 0.5 };

    // 떨림 보정용 One Euro Filter (x, y 각각)
    this.filterX = new OneEuroFilter(60, 1.2, 0.008, 1.0);
    this.filterY = new OneEuroFilter(60, 1.2, 0.008, 1.0);

    this._boundOnMouseMove = this._onMouseMove.bind(this);
    this._buildDOM();
  }

  _buildDOM() {
    this.wrapEl = document.createElement('div');
    this.wrapEl.className = 'hand-cursor-wrap';

    // SVG 진행 원 (circumference = 2 * PI * 42 ~= 263.89)
    this.wrapEl.innerHTML = `
      <svg class="hand-cursor-svg" viewBox="0 0 100 100">
        <circle class="hand-cursor-ring-bg" cx="50" cy="50" r="42" />
        <circle class="hand-cursor-ring-progress" cx="50" cy="50" r="42" />
      </svg>
      <div class="hand-cursor-icon">
        <svg viewBox="0 0 24 24">
          <path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74a4.5 4.5 0 0 0-9 0c0 1.56.79 2.93 2 3.74zm9.84 4.63-4.54-2.26A1.98 1.98 0 0 0 13.4 13.5H13v-6a1 1 0 0 0-2 0v8.75l-3.38-.71a1.23 1.23 0 0 0-1.28.48l-.84.99 4.8 5.76c.45.54 1.12.86 1.83.86h6.18a2.5 2.5 0 0 0 2.47-2.12l.62-4.32a2.5 2.5 0 0 0-.56-2.31z"/>
        </svg>
      </div>
    `;

    this.progressCircle = this.wrapEl.querySelector('.hand-cursor-ring-progress');
    this.root.appendChild(this.wrapEl);
    this._setProgress(0);
  }

  _setProgress(ratio) {
    const total = 263.89;
    const clamped = Math.max(0, Math.min(1, ratio));
    this.progressCircle.style.strokeDashoffset = (total * (1 - clamped)).toString();
  }

  /**
   * 커서 위치 및 상태 갱신
   * @param {{ x: number, y: number, visible: boolean }|null} hand 
   */
  update(hand) {
    if (!hand || !hand.visible) {
      this.hide();
      return;
    }

    this.lastHandTime = performance.now();

    // One Euro Filter 적용으로 가만히 있을 때는 흔들림 없고, 빠를 땐 딜레이 없이 추종
    const rawX = hand.x;
    const rawY = hand.y;
    const fx = this.filterX.filter(rawX, this.lastHandTime);
    const fy = this.filterY.filter(rawY, this.lastHandTime);

    this.currentPos = { x: fx, y: fy };

    // 화면 픽셀 좌표 계산
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const px = fx * screenWidth;
    const py = fy * screenHeight;

    this.wrapEl.style.transform = `translate3d(${px}px, ${py}px, 0)`;
    this.wrapEl.classList.add('visible');

    this._checkDwell(px, py);
  }

  _checkDwell(px, py) {
    const now = performance.now();

    // 쿨다운(선택 후 1초) 중에는 진행하지 않음
    if (now < this.cooldownUntil) {
      this._setProgress(0);
      return;
    }

    // 히스테리시스: 현재 타겟이 있으면 나갈 때 판정을 조금 너그럽게(margin: 24px) 판정
    let target = this.currentTarget;
    if (target) {
      const rect = target.getBoundingClientRect();
      const margin = 24;
      const insideWithMargin = (
        !target.disabled && rect.width > 0 && rect.height > 0 && !target.closest('[hidden]') &&
        px >= rect.left - margin &&
        px <= rect.right + margin &&
        py >= rect.top - margin &&
        py <= rect.bottom + margin
      );

      if (!insideWithMargin) {
        // 타겟 이탈
        target.classList.remove('hand-hover');
        this.wrapEl.classList.remove('hovering');
        this.currentTarget = null;
        this.selectedTarget = null;
        target = null;
        this.dwellStartTime = 0;
        this._setProgress(0);
      }
    }

    // 현재 타겟이 없으면 새로운 타겟 탐색
    if (!target) {
      const targets = this.root.querySelectorAll('[data-hand-target]');
      for (const el of targets) {
        const rect = el.getBoundingClientRect();
        if (el.disabled || rect.width <= 0 || rect.height <= 0 || el.closest('[hidden]')) continue;
        const top = document.elementFromPoint(px, py);
        if (top && top !== el && !el.contains(top)) continue;
        if (px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom) {
          target = el;
          this.currentTarget = el;
          this.dwellStartTime = now;
          el.classList.add('hand-hover');
          this.wrapEl.classList.add('hovering');
          if (this.onHover) this.onHover(el);
          break;
        }
      }
    }

    // 타겟 위에 머무르는 중 처리
    if (this.currentTarget) {
      if (this.selectedTarget === this.currentTarget) { this._setProgress(0); return; }
      const elapsed = now - this.dwellStartTime;
      const progress = Math.min(1, elapsed / this.dwellMs);
      this._setProgress(progress);

      if (progress >= 1) {
        // 선택 완료!
        const selectedEl = this.currentTarget;
        this.selectedTarget = selectedEl;
        this.cooldownUntil = now + 1000; // 선택 뒤 1초 동안 재선택 방지
        this._setProgress(0);

        // 시각 효과
        selectedEl.classList.add('hand-selected');
        this.wrapEl.classList.add('selected');
        setTimeout(() => selectedEl.classList.remove('hand-selected'), 300);
        setTimeout(() => this.wrapEl.classList.remove('selected'), 400);

        if (this.onSelect) this.onSelect(selectedEl);
        selectedEl.click(); // 기본 동작으로 click() 호출
      }
    } else {
      this._setProgress(0);
    }
  }

  hide() {
    this.wrapEl.classList.remove('visible', 'hovering');
    if (this.currentTarget) {
      this.currentTarget.classList.remove('hand-hover');
      this.currentTarget = null;
    }
    this.dwellStartTime = 0;
    this.selectedTarget = null;
    this._setProgress(0);
    this.filterX.reset();
    this.filterY.reset();
  }

  enableMouse(enable = true) {
    this.mouseEnabled = !!enable;
    if (this.mouseEnabled) {
      window.addEventListener('mousemove', this._boundOnMouseMove);
    } else {
      window.removeEventListener('mousemove', this._boundOnMouseMove);
    }
  }

  _onMouseMove(e) {
    // 최근 500ms 안에 실제 손 인식이 들어오고 있다면 마우스 입력 무시
    if (performance.now() - this.lastHandTime < 500) return;

    const normX = e.clientX / window.innerWidth;
    const normY = e.clientY / window.innerHeight;
    this.update({ x: normX, y: normY, visible: true });
  }

  destroy() {
    this.enableMouse(false);
    if (this.wrapEl && this.wrapEl.parentNode) {
      this.wrapEl.parentNode.removeChild(this.wrapEl);
    }
  }
}
