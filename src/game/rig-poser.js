// 휴머노이드 GLB(Meshy 등)를 배구 자세로 움직인다.
// 1) 모션 캡처 클립이 있는 동작(대기·환호·실점)은 클립을 재생한다. (assets/anims/meshy/*.json, 네 명이 같은 뼈대라 공유)
// 2) 배구 동작처럼 클립이 없으면 "이 뼈가 이 방향을 가리키게"(aim) 방식으로 자세를 만든다.
// 방향은 캐릭터 기준: x = 몸 바깥쪽(+), y = 위, z = 앞
import * as THREE from 'three';

// 게임 동작 이름 → 클립 파일 이름
const CLIP_FOR = { idle: 'idle', move: 'idle', cheer: 'cheer', sad: 'sad' };
const CLIP_LIBRARY = Promise.all(['idle', 'cheer', 'sad'].map(async name => {
  try {
    const res = await fetch(`assets/anims/meshy/${name}.json`);
    if (!res.ok) return null;
    const json = await res.json();
    return { name, clip: THREE.AnimationClip.parse(json), rest: json.rest, parent: json.parent };
  } catch { return null; }
})).then(list => Object.fromEntries(list.filter(Boolean).map(d => [d.name, d])));

// 리타기팅: 클립을 만든 뼈대와 우리 캐릭터 뼈대는 기준 자세(뼈 방향)가 다르다.
// "기준 자세에서 얼마나 돌았는가"를 모델 공간에서 옮겨 담아, 우리 뼈대의 로컬 회전으로 다시 계산한다.
function retargetClip(data, model, restLocal) {
  // 1) 원본 뼈대를 빈 노드로 다시 만든다
  const root = new THREE.Object3D(), src = {};
  for (const [name, q] of Object.entries(data.rest)) {
    const o = new THREE.Object3D();
    o.name = name;
    o.quaternion.fromArray(q);
    src[name] = o;
  }
  for (const [name, o] of Object.entries(src)) (src[data.parent[name]] ?? root).add(o);
  root.updateMatrixWorld(true);
  const worldQ = o => o.getWorldQuaternion(new THREE.Quaternion());

  const names = data.clip.tracks.map(t => t.name.split('.')[0]).filter(n => src[n] && model.getObjectByName(n));
  const bone = Object.fromEntries(names.map(n => [n, model.getObjectByName(n)]));
  const S0 = Object.fromEntries(names.map(n => [n, worldQ(src[n])]));

  // 2) 우리 뼈대의 기준 자세(모델 공간 회전)
  const saved = new Map();
  for (const [b, q] of restLocal) { saved.set(b, b.quaternion.clone()); b.quaternion.copy(q); }
  model.updateMatrixWorld(true);
  const modelInv = model.getWorldQuaternion(new THREE.Quaternion()).invert();
  const rel = o => modelInv.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
  const T0 = {}, P0 = {};
  for (const n of names) { T0[n] = rel(bone[n]); P0[n] = rel(bone[n].parent); }
  for (const [b, q] of saved) b.quaternion.copy(q);

  // 부모부터 계산
  const depth = o => { let d = 0; while (o.parent) { d++; o = o.parent; } return d; };
  names.sort((a, b) => depth(bone[a]) - depth(bone[b]));

  // 3) 프레임마다 원본 회전 변화량을 우리 뼈대에 적용
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(data.clip).play();
  const fps = 30, count = Math.max(2, Math.round(data.clip.duration * fps) + 1);
  const times = new Float32Array(count);
  const values = Object.fromEntries(names.map(n => [n, new Float32Array(count * 4)]));
  for (let i = 0; i < count; i++) {
    const t = Math.min(data.clip.duration, i / fps);
    times[i] = t;
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    const T = {};
    for (const n of names) {
      const delta = worldQ(src[n]).multiply(S0[n].clone().invert());
      T[n] = delta.multiply(T0[n]);
      const parentT = T[bone[n].parent.name] ?? P0[n];
      parentT.clone().invert().multiply(T[n]).toArray(values[n], i * 4);
    }
  }
  return new THREE.AnimationClip(data.name, data.clip.duration,
    names.map(n => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, values[n])));
}

const BONES = ['Hips', 'Spine02', 'neck', 'Head', 'headfront',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];

const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const ease = k => k * k * (3 - 2 * k);
const span = (k, a, b) => ease(Math.min(1, Math.max(0, (k - a) / (b - a))));   // k가 a→b일 때 0→1
// 자세 열쇠 [[k, [위팔, 아래팔]], ...] 사이를 부드럽게 잇는다
const keyed = (k, frames) => {
  if (k <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [k1, p1] = frames[i], [k0, p0] = frames[i - 1];
    if (k <= k1) { const u = span(k, k0, k1); return [lerp3(p0[0], p1[0], u), lerp3(p0[1], p1[1], u)]; }
  }
  return frames[frames.length - 1][1];
};
const keyedVec = (k, frames) => keyed(k, frames.map(([kk, v]) => [kk, [v, v]]))[0];

// 동작 진행(k, 0~1) 중 공과 닿는 순간. 렌더러·경기 규칙이 이 값으로 동작을 미리 시작해
// "공이 닿는 시각 = 이 k" 가 되게 맞춘다 (동작 길이 0.78초 기준, 예: 스파이크는 닿기 0.39초 전에 시작).
// 점프 동작(spike, block, serveJump)은 k=0.5가 점프 최고점이다.
// underSet: 낮거나 빗나간 공을 두 팔 플랫폼으로 올려 주는 언더 토스. dig: 짧은 공에 몸을 던져 미끄러지며 받는 슬라이딩 디그.
// tip: 팁(비치 규정: 코브라 = 손가락을 붙여 곧게 편 손끝, 포크 = 주먹 마디). 휘두르지 않고 점프 최고점에서 민다.
export const CONTACT_K = { bump: 0.45, underSet: 0.45, set: 0.45, spike: 0.5, tip: 0.5, block: 0.5, serveFloat: 0.35, serveJump: 0.35, serve: 0.35, dig: 0.45, dive: 0.4 };

// 자세표: [위팔, 아래팔] 방향. 다리는 legs: [허벅지, 종아리]
const ARMS = {
  idle:  [[0.30, -1, 0.06], [0.20, -1, 0.22]],
  // 모래 위 준비 자세: 어깨를 세우고 팔은 몸 앞, 무릎은 낮게 둔다.
  ready: [[0.25, -0.62, 0.74], [0.04, -0.30, 1]],
  // 머리가 크고 팔이 짧은 캐릭터라, 뒤 카메라에서도 보이게 팔을 몸 바깥쪽으로 벌리고 크게 과장한다.
  // 비치 리시브: 깊게 앉아 두 팔을 모아 허리 앞 아래에 플랫폼을 만든다(위팔은 벌리고 아래팔은 안으로 모음).
  bump:  [[0.35, -0.62, 0.70], [-0.45, -0.50, 0.74]],
  bumpUp: [[0.32, -0.30, 0.90], [-0.45, -0.20, 0.87]],   // 공을 칠 때 살짝 밀어 올림
  // 오버토스: 팔꿈치를 양옆으로 벌려 이마 위에 손으로 삼각형을 만든다.
  set:   [[0.80, 0.45, 0.40], [-0.55, 0.70, 0.45]],
  setPush: [[0.45, 0.85, 0.28], [-0.10, 0.97, 0.20]],   // 공을 밀어 올리며 팔을 편다
  // 블로킹: 두 팔을 곧게 위로(살짝 앞). 머리가 큰 캐릭터라 뒤에서 손이 머리에 가리지 않게 머리 양옆 위로 조금 벌린다.
  block: [[0.62, 0.74, 0.26], [0.30, 0.94, 0.20]],
  blockLoad: [[0.42, -0.05, 0.9], [-0.05, 0.95, 0.3]],   // 뛰기 전: 팔꿈치를 굽혀 두 손을 얼굴 앞에(손바닥 앞)
  blockPress: [[0.56, 0.68, 0.46], [0.26, 0.80, 0.54]],     // 최고점: 네트 너머로 손을 밀어 넣어 덮음
  // 점프: 두 팔을 앞 위로 흔들어 올린다.
  jump:  [[0.35, 0.60, 0.72], [0.25, 0.75, 0.62]],
  cheer: [[0.55, 0.82, 0.05], [0.3, 0.95, 0]],
  sad:   [[0.08, -1, 0.18], [0.02, -1, 0.35]],
  dive:  [[0.15, -0.1, 1], [0.05, -0.2, 1]],
  // 언더 토스: 리시브보다 팔을 앞으로 더 들고, 공을 받으면 가슴 높이까지 부드럽게 들어 올린다
  underSet:   [[0.30, -0.45, 0.84], [-0.45, -0.30, 0.84]],
  underSetUp: [[0.28, 0.05, 0.96], [-0.42, 0.20, 0.88]],
  // 슬라이딩 디그: 두 팔을 모아 발 앞 모래 가까이 쭉 뻗는다
  dig:   [[0.30, -0.72, 0.62], [-0.42, -0.62, 0.66]],
};
const LEGS = {
  stand: [[0.06, -1, 0.02], [0.04, -1, 0]],
  bent:  [[0.06, -0.88, 0.48], [0.04, -0.90, -0.42]],
  jump:  [[0.06, -0.82, 0.58], [0.04, -0.82, -0.62]],
  low:   [[0.30, -0.62, 0.72], [0.10, -0.78, -0.62]],   // 리시브: 다리를 벌리고 깊게 앉음
  tuck:  [[0.10, -0.45, 0.89], [0.04, -0.95, -0.30]],   // 점프 중 무릎을 앞으로 끌어올림
  load:  [[0.08, -0.62, 0.78], [0.04, -0.90, -0.44]],   // 도약 직전 깊게 굽힘
  kick:  [[0.08, -0.96, 0.22], [0.04, -0.40, -0.92]],   // 공중에서 발뒤꿈치를 뒤로 차올림
  // 슬라이딩: 앞다리는 크게 내딛어 무릎을 굽히고, 뒷다리는 뒤로 쭉 뻗어 모래에 끈다
  lungeFront: [[0.22, -0.08, 0.97], [0.05, -0.99, -0.12]],
  lungeBack:  [[0.14, -0.22, -0.97], [0.05, -0.08, -1]],
};
// 득점·실점 제스처 자세(gesture()). 한 번 하는 길이 GESTURE_PERIOD초(오래 이어지면 반복)
export const GESTURE_PERIOD = 3.2;
const GESTURE = {
  vUp: [[0.62, 0.74, 0.2], [0.3, 0.94, 0.12]],                 // 두 팔 번쩍(머리 양옆 위 V자)
  fist: {
    wind: [[0.5, 0.75, 0.3], [0.2, 0.95, 0.2]],                 // 주먹을 높이
    pull: [[0.35, -0.8, 0.2], [0.1, 0.6, 0.8]],                 // 팔꿈치를 옆구리로 당기고 주먹은 가슴 앞
    other: [[0.35, -0.85, 0.25], [0.2, -0.2, 0.95]],            // 다른 주먹은 배 앞
  },
  mouth: [[0.25, -0.1, 0.95], [-0.55, 0.6, -0.55]],             // 손끝을 입에
  thumbs: [[0.6, -0.35, 0.72], [-0.9, 0.2, -0.38]],             // 두 엄지로 가슴
  open: [[0.95, 0.25, 0.15], [0.95, 0.35, 0.1]],                // 두 팔 활짝
  flex: {
    arm: [[1, 0, 0.12], [0.05, 1, 0.05]],                        // 위팔은 옆으로 수평, 아래팔은 똑바로 세움(주먹이 머리에 붙으면 '머리 감싸기'로 보인다)
    crunch: [[0.7, -0.35, 0.6], [-0.8, -0.1, 0.6]],             // 두 주먹을 배 앞에 모으고 온몸에 힘(보디빌더 '모스트 머스큘러')
    point: [[0.25, -0.1, 0.96], [-0.95, 0.25, 0.15]],           // 다른 손으로 알통을 가리킴(몸 앞을 가로질러)
  },
  point: [[0.45, 0.88, 0.15], [0.25, 0.96, 0.1]],               // 하늘로 쭉(머리 옆으로 벌려야 앞에서 팔이 보인다)
  hip: [[0.7, -0.6, -0.3], [-0.5, -0.7, -0.1]],                 // 손등을 허리에(팔꿈치는 옆 뒤, 몸 앞을 가리지 않게)
  highFive: {
    prep: [[0.45, 0.6, 0.55], [0.25, 0.9, 0.3]],
    hit: [[0.15, 0.85, 0.5], [0.05, 0.8, 0.6]],                 // 짝꿍 쪽(앞) 높이
    other: [[0.4, -0.6, 0.3], [0.2, -0.3, 0.9]],
  },
  chest: {
    wind: [[0.55, -0.3, -0.78], [0.3, -0.5, -0.8]],             // 팔을 뒤로 당김
    throw: [[0.8, 0.2, -0.55], [0.6, 0.5, -0.6]],               // 팔을 뒤·옆으로 젖히고 가슴을 내밂
  },
};
// 몸통 기울기(엉덩이 → 목 방향). 앞으로 숙이면 z가 커진다
const SPINE = {
  up: [0, 1, 0.05], lean: [0, 0.55, 0.84], slide: [0, 0.22, 0.98], run: [0, 0.94, 0.33],
  arch: [0, 0.87, -0.49],    // 스파이크 활 자세: 몸을 뒤로 크게 젖힘
  crunch: [0, 0.58, 0.81],   // 내려치며 몸을 앞으로 깊게 접음
};
// 스파이크·서브: 휘두르는 팔(오른팔)은 뒤로 들었다가 앞으로 내려친다
const SWING = {
  windup: [[0.55, 0.70, -0.45], [0.30, 0.88, -0.36]],   // 뒤에서도 보이게 바깥쪽으로 크게 당김
  contact: [[0.10, 0.97, 0.22], [0.05, 0.96, 0.28]],     // 공과 닿는 순간: 치는 팔을 머리 앞 위로 끝까지 뻗음(손이 가장 높다)
  hit:    [[0.12, 0.12, 1], [0.06, -0.34, 0.94]],
  other:  [[0.40, 0.84, 0.36], [0.20, 0.94, 0.28]],
  otherDown: [[0.3, -0.9, 0.3], [0.2, -0.9, 0.35]],
  follow: [[-0.25, -0.70, 0.67], [-0.35, -0.75, 0.56]],  // 내려친 뒤 몸 앞 아래로 휘두름
  tuck:   [[0.15, -0.75, 0.62], [-0.45, -0.35, 0.82]],   // 반대 팔(리드 암)을 몸 앞으로 끌어내려 접음
};
// 스파이크 구간 자세(치는 팔 기준; 반대 팔도 back·raise까지는 같이 움직인다)
const SPIKE = {
  ready: [[0.25, -0.62, 0.74], [0.04, -0.30, 1]],
  back:  [[0.22, -0.45, -0.86], [0.12, -0.55, -0.83]],   // 두 팔을 엉덩이 뒤로 크게 뺌
  raise: [[0.22, 0.80, 0.56], [0.10, 0.92, 0.38]],       // 도약하며 앞 위로 휘두름
  bow:   [[0.72, 0.55, -0.43], [-0.30, 0.55, -0.78]],    // 치는 팔: 팔꿈치 높이·뒤로, 손은 머리 뒤(활 쏘기)
  point: [[0.18, 0.82, 0.55], [0.06, 0.86, 0.50]],       // 반대 팔: 공을 가리킴
};
// 팁: 닿은 뒤 손을 앞 위로 살짝 민다(휘두르지 않음)
const TIP = { push: [[0.10, 0.80, 0.60], [0.05, 0.70, 0.72]] };
// 서브: 토스하는 손(치는 손의 반대)으로 공을 띄우고, 치는 손으로 친다
const SERVE = {
  holdBall:  [[0.65, -0.45, 0.6], [0.3, 0.2, 1]],    // 가슴 앞 약간 바깥에서 공을 받친 손(뒤 카메라에서도 공이 보이게)
  hitRest:   [[0.3, -0.9, -0.15], [0.2, -0.8, 0.15]], // 치는 손: 편하게 옆에
  tossUp:    [[0.1, 1, 0.35], [0.05, 1, 0.3]],        // 토스한 손: 앞쪽 위로 쭉
  contact:   [[0.12, 0.96, 0.25], [0.06, 0.98, 0.2]], // 공과 닿는 순간: 치는 팔을 머리 앞 위로 쭉
  floatHit:  [[0.15, 0.55, 1], [0.1, 0.5, 1]],        // 플로터: 앞 위에서 손바닥으로 밀고 멈춤
};

export class RigPoser {
  static canPose(model) {
    return ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand']
      .every(n => model.getObjectByName(n));
  }

  constructor(model) {
    this.model = model;
    this.b = Object.fromEntries(BONES.map(n => [n, model.getObjectByName(n)]));
    this.rest = new Map();
    model.traverse(o => { if (o.isBone) this.rest.set(o, o.quaternion.clone()); });
    this.prev = new Map();
    this.handedness = 'right'; // 'right' | 'left': 스파이크·서브를 치는 손

    // 모델 좌표에서 왼팔이 +x인지, 얼굴이 +z인지 알아낸다
    model.updateMatrixWorld(true);
    const inv = model.matrixWorld.clone().invert();
    const local = o => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    this.leftSign = Math.sign(local(this.b.LeftArm).x - local(this.b.RightArm).x) || 1;
    this.frontSign = this.b.headfront && this.b.Head
      ? Math.sign(local(this.b.headfront).z - local(this.b.Head).z) || 1 : 1;

    // 발 붙이기: 기준 자세에서 발끝 높이를 기억해 두고, 매 프레임 발이 뜨거나 묻히지 않게 몸 높이를 맞춘다
    this.feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map(n => model.getObjectByName(n)).filter(Boolean);
    this.baseY = model.position.y;
    this.restFootY = this.footY();

    // 클립: 이 모델에 있는 뼈의 트랙만 남겨서 재생
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    this.current = null;
    this.lastT = null;
    CLIP_LIBRARY.then(lib => {
      for (const [name, data] of Object.entries(lib)) {
        const clip = retargetClip(data, model, this.rest);
        if (!clip.tracks.length) continue;
        const action = this.mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        this.actions[name] = action;
      }
    });
  }

  // 왼손잡이면 왼팔로 스파이크·서브를 친다
  setHandedness(hand) { this.handedness = hand === 'left' ? 'left' : 'right'; }

  // 공을 치는 손 뼈 (서브 대기 때 공을 드는 손)
  hitHandBone() { return this.handedness === 'left' ? this.b.LeftHand : this.b.RightHand; }

  // 서브 대기 때 공을 드는 손 (치는 손의 반대)
  tossHandBone() { return this.handedness === 'left' ? this.b.RightHand : this.b.LeftHand; }

  // 서브가 공과 닿는 순간(serveFloat k=0.35) 치는 손의 월드 위치.
  // pose()는 이전 프레임과 섞으므로 섞기 없이 재고, 뼈·몸 높이·섞기 상태를 모두 되돌린다.
  measureContactHand() {
    const saved = [...this.rest.keys()].map(b => [b, b.quaternion.clone()]);
    const prev = this.prev, lastT = this.lastT, y = this.model.position.y, current = this.current;
    const blend = { lastPoseKey: this.lastPoseKey, lastPoseT: this.lastPoseT, fadeFrom: this.fadeFrom, fadeT0: this.fadeT0, gestureKey: this.gestureKey, gestureT0: this.gestureT0 };
    this.prev = new Map();
    this.current = null;
    this.pose('serveFloat', 0.35, 0);
    this.model.parent?.updateMatrixWorld(true);
    const pos = this.hitHandBone().getWorldPosition(new THREE.Vector3());
    for (const [b, q] of saved) b.quaternion.copy(q);
    Object.assign(this, { prev, lastT, current }, blend);
    this.model.position.y = y;
    return pos;
  }

  // 동작의 공 닿는 순간(CONTACT_K) 손 위치를 캐릭터 발밑 기준으로 잰다(점프 높이는 빼고).
  // 두 손 중 더 높은 손(리시브는 두 손 가운데). x는 캐릭터 기준 +가 왼쪽, z는 +가 앞.
  contactHand(type) {
    const saved = [...this.rest.keys()].map(b => [b, b.quaternion.clone()]);
    const prev = this.prev, lastT = this.lastT, y = this.model.position.y, current = this.current;
    const blend = { lastPoseKey: this.lastPoseKey, lastPoseT: this.lastPoseT, fadeFrom: this.fadeFrom, fadeT0: this.fadeT0, gestureKey: this.gestureKey, gestureT0: this.gestureT0 };
    // 발 붙이기(ground)는 한 번에 절반씩 따라가므로 기준 높이에서 시작해 여러 번 자세를 잡아 수렴시킨다
    this.model.position.y = this.baseY;
    for (let i = 0; i < 12; i++) {
      this.prev = new Map();
      this.current = null;
      this.pose(type, CONTACT_K[type] ?? 0.5, 0);
    }
    const holder = this.model.parent;
    holder?.updateMatrixWorld(true);
    const local = b => holder ? holder.worldToLocal(b.getWorldPosition(new THREE.Vector3())) : b.getWorldPosition(new THREE.Vector3());
    const l = local(this.b.LeftHand), r = local(this.b.RightHand);
    const pos = ['bump', 'set', 'underSet', 'dig'].includes(type) ? l.clone().add(r).multiplyScalar(0.5) : (l.y > r.y ? l : r);
    for (const [b, q] of saved) b.quaternion.copy(q);
    Object.assign(this, { prev, lastT, current }, blend);
    this.model.position.y = y;
    return pos;
  }

  // 뼈를 월드 축 axis 둘레로 angle만큼 더 돌린다
  rotateWorld(bone, axis, angle) {
    if (!bone || !angle) return;
    bone.parent.updateWorldMatrix(true, false);
    const world = new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world));
  }

  forearmAxis() {
    const side = this.handedness === 'left' ? 'Left' : 'Right';
    const fore = this.b[side + 'ForeArm'], hand = this.b[side + 'Hand'];
    if (!fore || !hand) return null;
    fore.updateWorldMatrix(true, false); hand.updateWorldMatrix(true, false);
    return hand.getWorldPosition(new THREE.Vector3()).sub(fore.getWorldPosition(new THREE.Vector3())).normalize();
  }

  // 득점·실점 제스처. style: fistPump · skyKiss · itsMe · flex · pointSky · highFive · chestBump
  //                        sad-handsOnHead · sad-kneesHands · sad-shrug · sad-hipsHead
  gesture(style, t, since = null) {
    // 2026-09-27 선생님: "득점하고 화이팅하는 장면이 어색하다" → 득점 순간부터 "준비 → 크게 한 번 → 잠깐 멈춤 → 풀기"를 한 번 한다.
    // since = 제스처를 시작한 뒤 흐른 시간(초). 오래 이어지면(우승 장면) GESTURE_PERIOD마다 다시 한다.
    // 머리가 큰 캐릭터라 팔을 머리 위로 들 때는 팔을 늘려(armScale) 손이 머리에 묻히지 않게 한다.
    const s = (since ?? t) % GESTURE_PERIOD;
    const bounce = Math.abs(Math.sin(t * 5));
    const R = ARMS.idle, V = GESTURE.vUp;
    const armScale = frames => { const k = keyedVec(s, frames.map(([kk, v]) => [kk, [v, 0, 0]]))[0]; for (const a of [this.b.LeftArm, this.b.RightArm]) a?.scale.setScalar(k); };
    const end = GESTURE_PERIOD - 0.35;   // 끝에서 천천히 풀어 다음 반복과 이어지게
    switch (style) {
      case 'fistPump': {        // 주먹 불끈 "예스!": 주먹을 높이 들었다가 옆구리로 힘껏 두 번 당기고, 두 팔 번쩍
        const G = GESTURE.fist;
        this.hitArms(keyed(s, [[0, R], [0.22, G.wind], [0.4, G.pull], [0.62, G.wind], [0.8, G.pull], [1.45, G.pull], [1.75, V], [end, V], [GESTURE_PERIOD, R]]),
          keyed(s, [[0, R], [0.3, G.other], [1.45, G.other], [1.75, V], [end, V], [GESTURE_PERIOD, R]]));
        this.spine(keyedVec(s, [[0, SPINE.up], [0.4, [0, 0.8, 0.6]], [0.62, SPINE.up], [0.8, [0, 0.75, 0.66]], [1.45, [0, 0.8, 0.6]], [1.75, [0, 0.95, -0.3]], [end, SPINE.up]]));
        this.legs(keyed(s, [[0, LEGS.stand], [0.4, LEGS.bent], [0.62, LEGS.stand], [0.8, LEGS.load], [1.45, LEGS.bent], [1.75, LEGS.stand]]));
        armScale([[0, 1], [0.22, 1.12], [0.4, 1], [0.62, 1.12], [0.8, 1], [1.45, 1], [1.75, 1.15], [end, 1.15], [GESTURE_PERIOD, 1]]);
        break;
      }
      case 'skyKiss': {         // 하늘에 키스: 손을 입에 댔다가 두 팔을 하늘로 활짝, 몸을 젖힘
        this.hitArms(keyed(s, [[0, R], [0.35, GESTURE.mouth], [0.75, GESTURE.mouth], [1.0, V], [end, V], [GESTURE_PERIOD, R]]),
          keyed(s, [[0, R], [0.75, R], [1.0, V], [end, V], [GESTURE_PERIOD, R]]));
        this.spine(keyedVec(s, [[0, SPINE.up], [0.6, [0, 0.97, 0.25]], [1.0, [0, 0.9, -0.43]], [end, [0, 0.95, -0.3]], [GESTURE_PERIOD, SPINE.up]]));
        this.legs(keyed(s, [[0, LEGS.stand], [0.75, LEGS.bent], [1.0, LEGS.stand]]));
        armScale([[0, 1], [0.75, 1], [1.0, 1.18], [end, 1.18], [GESTURE_PERIOD, 1]]);
        break;
      }
      case 'itsMe': {           // 나야 나: 두 엄지로 가슴을 콕콕 가리키며 가슴을 폈다가, 두 팔을 활짝
        const T = GESTURE.thumbs, O = GESTURE.open;
        this.arms(keyed(s, [[0, R], [0.3, T], [1.0, T], [1.3, O], [end, O], [GESTURE_PERIOD, R]]));
        this.spine(keyedVec(s, [[0, SPINE.up], [0.3, [0, 0.96, -0.2]], [0.45, [0, 0.9, -0.42]], [0.6, [0, 0.96, -0.2]], [0.75, [0, 0.9, -0.42]], [1.0, [0, 0.96, -0.2]], [1.3, [0, 0.92, -0.38]], [end, [0, 0.95, -0.3]], [GESTURE_PERIOD, SPINE.up]]));
        this.legs(keyed(s, [[0, LEGS.stand], [1.0, LEGS.stand], [1.15, LEGS.bent], [1.3, LEGS.stand]]));
        break;
      }
      case 'flex': {            // 알통 자랑: 한 팔 알통 + 다른 손으로 알통 가리키기 → 두 주먹을 배 앞에 모아 온몸에 힘
        const F = GESTURE.flex;
        this.hitArms(keyed(s, [[0, R], [0.35, F.arm], [1.3, F.arm], [1.6, F.crunch], [end, F.crunch], [GESTURE_PERIOD, R]]),
          keyed(s, [[0, R], [0.35, F.point], [1.3, F.point], [1.6, F.crunch], [end, F.crunch], [GESTURE_PERIOD, R]]));
        this.spine(keyedVec(s, [[0, SPINE.up], [0.35, [0, 0.95, 0.3]], [0.7, [0, 0.9, 0.42]], [1.0, [0, 0.95, 0.3]], [1.6, [0, 0.85, 0.52]], [end, [0, 0.9, 0.42]], [GESTURE_PERIOD, SPINE.up]]));
        this.legs(keyed(s, [[0, LEGS.stand], [0.35, LEGS.bent], [0.7, LEGS.load], [1.0, LEGS.bent], [1.6, LEGS.load], [end, LEGS.bent], [GESTURE_PERIOD, LEGS.stand]]));
        break;
      }
      case 'pointSky': {        // 하늘 가리키기: 한 팔을 하늘로 쭉 뻗어 콕콕, 다른 손은 허리에
        const up = GESTURE.point, poke = [[up[0][0], up[0][1], up[0][2] + 0.12 * Math.max(0, Math.sin(s * 9))], up[1]];
        this.hitArms(keyed(s, [[0, R], [0.3, poke], [end, poke], [GESTURE_PERIOD, R]]),
          keyed(s, [[0, R], [0.3, GESTURE.hip], [end, GESTURE.hip], [GESTURE_PERIOD, R]]));
        this.spine(keyedVec(s, [[0, SPINE.up], [0.3, [0, 0.93, -0.36]], [end, [0, 0.93, -0.36]], [GESTURE_PERIOD, SPINE.up]]));
        this.legs(LEGS.stand);
        armScale([[0, 1], [0.3, 1.2], [end, 1.2], [GESTURE_PERIOD, 1]]);
        break;
      }
      case 'highFive': {        // 하이파이브(짝꿍을 마주 보고): 무릎을 굽혔다 뛰며 0.6초에 손바닥을 마주침 → 두 팔 번쩍
        const H = GESTURE.highFive;
        this.hitArms(keyed(s, [[0, R], [0.35, H.prep], [0.6, H.hit], [0.8, H.hit], [1.2, V], [end, V], [GESTURE_PERIOD, R]]),
          keyed(s, [[0, R], [0.6, H.other], [0.9, H.other], [1.2, V], [end, V], [GESTURE_PERIOD, R]]));
        this.spine(keyedVec(s, [[0, SPINE.up], [0.35, [0, 0.95, 0.3]], [0.6, [0, 0.98, -0.2]], [1.2, SPINE.up]]));
        this.legs(keyed(s, [[0, LEGS.stand], [0.35, LEGS.load], [0.6, LEGS.stand], [0.8, LEGS.tuck], [1.0, LEGS.bent], [1.2, LEGS.stand]]));
        armScale([[0, 1], [0.35, 1.1], [0.6, 1.15], [end, 1.15], [GESTURE_PERIOD, 1]]);
        break;
      }
      case 'chestBump': {       // 가슴 부딪치기(짝꿍을 마주 보고): 팔을 뒤로 당겨 웅크렸다가 뛰며 0.6초에 가슴을 쾅 → 두 팔 번쩍
        const C = GESTURE.chest;
        this.arms(keyed(s, [[0, R], [0.3, C.wind], [0.6, C.throw], [0.85, C.throw], [1.2, V], [end, V], [GESTURE_PERIOD, R]]));
        this.spine(keyedVec(s, [[0, SPINE.up], [0.3, [0, 0.88, 0.47]], [0.6, SPINE.arch], [0.85, SPINE.arch], [1.2, SPINE.up]]));
        this.legs(keyed(s, [[0, LEGS.stand], [0.3, LEGS.load], [0.6, LEGS.stand], [0.8, LEGS.tuck], [1.0, LEGS.bent], [1.2, LEGS.stand]]));
        armScale([[0, 1], [0.85, 1], [1.2, 1.15], [end, 1.15], [GESTURE_PERIOD, 1]]);
        break;
      }
      case 'sad-handsOnHead': { // 머리 감싸기
        this.arms([[0.65, 0.62, 0.3], [-0.72, 0.6, -0.15]]);
        this.spine(lerp3(SPINE.up, SPINE.lean, 0.2));
        this.legs(LEGS.stand);
        break;
      }
      case 'sad-kneesHands': {  // 무릎 짚고 숨 고르기
        this.spine(lerp3(SPINE.lean, SPINE.slide, 0.2 + 0.1 * Math.sin(t * 3)));
        this.arms([[0.2, -0.75, 0.62], [0.05, -0.85, 0.5]]);
        this.legs(LEGS.load);
        break;
      }
      case 'sad-shrug': {       // 어깨 으쓱, 손바닥을 위로
        const up = Math.max(0, Math.sin(t * 2.5));
        this.arms([[0.5, -0.55 + 0.15 * up, 0.35], [0.45, 0.35, 0.8]]);
        this.spine(SPINE.up);
        this.legs(LEGS.stand);
        break;
      }
      default: {                // sad-hipsHead: 허리에 손, 고개를 떨굼
        this.arms([[0.65, -0.55, -0.2], [-0.75, -0.2, 0.6]]);
        this.spine(lerp3(SPINE.up, SPINE.lean, 0.35));
        this.legs(LEGS.stand);
      }
    }
  }

  // 몸통을 세로축으로 돌린다. +면 치는 쪽 어깨가 뒤로 간다(오른손잡이는 위에서 볼 때 시계 방향)
  twistTorso(amount) {
    if (!amount || !this.b.Spine02) return;
    this.rotateWorld(this.b.Spine02, new THREE.Vector3(0, 1, 0), (this.handedness === 'left' ? 1 : -1) * amount);
  }

  // 손목 회전(손바닥 방향): +면 캐릭터의 오른쪽으로 손바닥을 돌린다
  twistHitHand(amount) {
    const axis = this.forearmAxis();
    if (!axis || !amount) return;
    // 팔이 위를 볼 때 +y축 둘레 회전이 "오른쪽으로 돌리기"가 되도록 부호를 맞춘다(캐릭터는 +z 앞, 왼팔 +x면 오른쪽은 -x)
    this.rotateWorld(this.hitHandBone(), axis, -amount * this.leftSign * this.frontSign);
  }

  // 손목 꺾기(포크): 음수면 손끝을 뒤로 젖혀 주먹 마디(손등)가 앞을 본다
  flexHitHand(angle) {
    const axis = this.forearmAxis();
    if (!axis || !angle) return;
    const fwd = new THREE.Vector3(0, 0, this.frontSign).applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion()));
    const side = new THREE.Vector3().crossVectors(axis, fwd).normalize();
    this.rotateWorld(this.hitHandBone(), side, angle);
  }

  // 치는 팔·토스 팔 자세를 손잡이에 맞게 왼쪽/오른쪽에 넣는다
  hitArms(hitArm, tossArm) {
    if (this.handedness === 'left') this.arms(hitArm, tossArm);
    else this.arms(tossArm, hitArm);
  }

  // 가장 낮은 발 부분의 높이 (모델을 감싼 부모 기준)
  footY() {
    const parent = this.model.parent;
    if (!parent || !this.feet.length) return 0;
    this.model.updateMatrixWorld(true);
    return Math.min(...this.feet.map(f => parent.worldToLocal(f.getWorldPosition(new THREE.Vector3())).y));
  }

  ground() {
    if (!this.feet.length || this.restFootY == null) return;
    const offset = this.model.position.y - this.baseY;
    const target = offset + (this.restFootY - this.footY());
    this.model.position.y = this.baseY + offset + (target - offset) * 0.5;
  }

  // 클립이 있으면 재생하고 true를 돌려준다
  playClip(type, t) {
    const dt = this.lastT == null ? 0 : Math.max(0, Math.min(0.1, t - this.lastT));
    this.lastT = t;
    const action = this.actions[CLIP_FOR[type]];
    if (!action) {
      if (this.current) { this.current.stop(); this.current = null; }
      return false;
    }
    if (this.current !== action) {
      this.current?.stop();
      // 대기 동작은 사람마다 시작 지점을 달리해 똑같이 움직이지 않게
      action.reset().play();
      if (type === 'idle' || type === 'move') action.time = Math.random() * action.getClip().duration;
      this.current = action;
    }
    // three.js 믹서는 "지난번과 값이 같으면" 뼈에 다시 쓰지 않는다. 그런데 pose()는 매번 뼈를 기본 자세로 되돌리므로
    // 시간이 그대로인 프레임(dt=0)이나 값이 안 변하는 트랙은 기본 자세(T자)로 남아 한 프레임씩 번쩍였다.
    // 비교용 칸(accu0·accu1)을 NaN으로 비워 두어 매번 다시 쓰게 한다.
    for (const pm of this.mixer._bindings ?? []) pm.buffer?.fill(NaN, pm.valueSize, pm.valueSize * 3);
    this.mixer.update(dt);
    return true;
  }

  // bone → child 방향이 dir(캐릭터 좌표)을 향하도록 bone을 돌린다
  aim(bone, child, dir, outward) {
    if (!bone || !child) return;
    bone.parent.updateWorldMatrix(true, false);
    bone.updateWorldMatrix(false, true);
    const from = child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3()));
    if (from.lengthSq() < 1e-10) return;
    from.normalize();
    const to = new THREE.Vector3(dir[0] * outward, dir[1], dir[2] * this.frontSign)
      .normalize().applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion()));
    const delta = new THREE.Quaternion().setFromUnitVectors(from, to);
    const world = delta.multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    const parentInv = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    bone.quaternion.copy(parentInv.multiply(world));
  }

  limb(side, upperBone, lowerBone, endBone, [upper, lower]) {
    const out = (side === 'Left' ? 1 : -1) * this.leftSign;
    this.aim(this.b[side + upperBone], this.b[side + lowerBone], upper, out);
    this.aim(this.b[side + lowerBone], this.b[side + endBone], lower, out);
  }

  arms(pose, right = pose) {
    this.limb('Left', 'Arm', 'ForeArm', 'Hand', pose);
    this.limb('Right', 'Arm', 'ForeArm', 'Hand', right);
  }

  legs(pose, right = pose) {
    this.limb('Left', 'UpLeg', 'Leg', 'Foot', pose);
    this.limb('Right', 'UpLeg', 'Leg', 'Foot', right);
  }

  // 몸통을 앞으로 숙인다(dir = 엉덩이에서 목으로 가는 방향)
  spine(dir) {
    if (this.b.Spine02 && this.b.neck) this.aim(this.b.Spine02, this.b.neck, dir, 1);
  }

  // type: 게임 동작 이름, k: 동작 진행(0~1), t: 시간(초)
  // opts.aim: 공격 방향 -1(캐릭터의 왼쪽) ~ +1(오른쪽). opts.style: 팁 손 모양 'cobra' | 'poke'
  pose(type, k, t, opts = {}) {
    const aim = Math.max(-1, Math.min(1, opts.aim ?? 0));
    // 치는 팔 기준 옆 방향: 팔 방향표의 x는 "몸 바깥쪽"이라, 오른손잡이는 +x가 캐릭터의 오른쪽, 왼손잡이는 왼쪽
    const lat = aim * (this.handedness === 'left' ? -1 : 1);
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    for (const h of [this.b.LeftHand, this.b.RightHand, this.b.LeftArm, this.b.RightArm]) h?.scale.setScalar(1);
    const breathe = Math.sin(t * 2.2) * 0.03;

    if (type === 'celebrate' || (type === 'sad' && opts.style)) {
      // 득점·승리 제스처(시간으로 반복, 선수마다 다른 style). 모션 캡처 춤 대신 쓴다.
      // 제스처 시작 시각: 게임이 opts.since를 주면 그것을, 아니면 이 제스처가 처음 들어온 시각부터 잰다(두 짝꿍이 같은 프레임에 시작하면 맞춰진다)
      const gkey = type + ':' + (opts.style ?? '');
      if (this.gestureKey !== gkey || t < this.gestureT0) { this.gestureKey = gkey; this.gestureT0 = t; }
      this.gesture(type === 'sad' ? `sad-${opts.style}` : (opts.style ?? 'fistPump'), t + (opts.phase ?? 0), opts.since ?? t - this.gestureT0);
    } else if ((this.gestureKey = null) || this.playClip(type, t)) {   // 제스처가 아니면 시작 시각을 잊는다
      // 모션 캡처 클립이 자세를 정했다
    } else if (type === 'serveReady') {
      // 토스 손으로 공을 가슴 앞에 받치고, 치는 손은 옆에 편하게 둔다.
      this.hitArms(SERVE.hitRest, SERVE.holdBall);
      this.legs(LEGS.bent);
    } else if (type === 'serveToss') {
      // 토스 손은 공을 밀어 올리며 위로 쭉 뻗고, 조금 늦게 치는 손을 뒤로 당긴다(활 쏘는 자세).
      const toss = ease(Math.min(1, Math.max(0, k / 0.5)));
      const load = ease(Math.min(1, Math.max(0, (k - 0.25) / 0.55)));
      const tossArm = [lerp3(SERVE.holdBall[0], SERVE.tossUp[0], toss), lerp3(SERVE.holdBall[1], SERVE.tossUp[1], toss)];
      const hitArm = [lerp3(SERVE.hitRest[0], SWING.windup[0], load), lerp3(SERVE.hitRest[1], SWING.windup[1], load)];
      this.hitArms(hitArm, tossArm);
      this.legs(LEGS.bent);
    } else if (type === 'serveFloat' || type === 'serveJump') {
      // k 0→1(약 0.5초), k≈0.35에 공과 닿는다
      // 플로터: 서서 앞 위에서 짧게 밀고 멈춤 / 스파이크 서브: 점프해서 끝까지 내려친다
      // 0~0.35: 뒤로 당긴 팔을 머리 앞 위(contact)로 올려 공을 맞힌다, 0.35~0.7: 밀고 멈춤 / 끝까지 내려침
      const reach = ease(Math.min(1, Math.max(0, k / 0.35)));
      const swing = ease(Math.min(1, Math.max(0, (k - 0.35) / 0.35)));
      const end = type === 'serveFloat' ? SERVE.floatHit : SWING.hit;
      const follow = type === 'serveJump' ? ease(Math.min(1, Math.max(0, (k - 0.35) / 0.4))) : 0;
      const hitArm = [0, 1].map(i => lerp3(lerp3(SWING.windup[i], SERVE.contact[i], reach), end[i], swing))
        .map((dir, i) => lerp3(dir, SWING.otherDown[i], follow * 0.5));
      const tossArm = [lerp3(SERVE.tossUp[0], SWING.otherDown[0], reach), lerp3(SERVE.tossUp[1], SWING.otherDown[1], reach)];
      this.hitArms(hitArm, tossArm);
      this.legs(type === 'serveJump' ? (k < 0.8 ? LEGS.jump : LEGS.bent) : LEGS.stand);
    } else if (type === 'spike' || type === 'serve') {
      // 실제 스파이크 순서(k=0.5가 점프 최고점이자 공과 닿는 순간):
      //  0~0.18 도움닫기 마지막 걸음: 두 팔을 엉덩이 뒤로 크게 빼고 무릎을 깊게 굽혀 몸을 숙임
      //  0.18~0.32 도약: 두 팔을 앞 위로 힘껏 휘두르며 뜀
      //  0.32~0.45 활 자세: 반대 팔(리드 암)은 공을 가리키고, 치는 팔은 팔꿈치를 높이 뒤로 당겨 손이 머리 뒤. 몸을 뒤로 젖히고 발뒤꿈치를 뒤로 차올림
      //  0.45~0.5 채찍처럼 팔을 뻗어 머리 앞 위 가장 높은 곳에서 닿음
      //  0.5~0.62 끝까지 내려치며 몸을 앞으로 접음(리드 암은 가슴으로 끌어내림) → 0.62~0.85 몸 앞을 가로질러 휘두르고 착지
      const toward = (dir, amount) => [dir[0] + lat * amount, dir[1], dir[2]];
      const hitArm = keyed(k, [
        [0.00, SPIKE.ready],
        [0.18, SPIKE.back],
        [0.32, SPIKE.raise],
        [0.45, SPIKE.bow],
        [0.50, [toward(SWING.contact[0], 0.12), toward(SWING.contact[1], 0.25)]],
        [0.60, [toward(SWING.hit[0], 0.35), toward(SWING.hit[1], 0.45)]],
        [0.82, [toward(SWING.follow[0], 0.5), toward(SWING.follow[1], 0.55)]],
      ]);
      const other = keyed(k, [
        [0.00, SPIKE.ready],
        [0.18, SPIKE.back],
        [0.32, SPIKE.raise],
        [0.44, SPIKE.point],
        [0.56, SWING.tuck],
        [0.85, SWING.otherDown],
      ]);
      this.spine(keyedVec(k, [[0, SPINE.up], [0.16, SPINE.lean], [0.3, SPINE.up], [0.44, SPINE.arch], [0.5, SPINE.up], [0.6, SPINE.crunch], [0.9, SPINE.up]]));
      // 몸통 회전: 활 자세 때 치는 쪽 어깨를 뒤로 크게 돌렸다가(0.55rad), 치면서 반대로 비튼다(-0.45rad)
      this.twistTorso(keyedVec(k, [[0, [0]], [0.3, [0.15]], [0.44, [0.55]], [0.5, [0.1]], [0.62, [-0.45]], [0.9, [0]]])[0]);
      this.hitArms(hitArm, other);
      this.legs(keyed(k, [[0, LEGS.bent], [0.16, LEGS.load], [0.3, LEGS.stand], [0.42, LEGS.kick], [0.6, LEGS.tuck], [0.85, LEGS.bent]]));
      // 손목 회전: 공격 방향으로 손바닥을 돌린다(닿기 직전부터)
      this.twistHitHand(aim * 0.9 * span(k, 0.4, 0.5));
    } else if (type === 'tip') {
      // 팁: 휘두르지 않는다. 0~0.3 두 팔을 들며 점프 → 0.3~0.5 치는 손을 머리 앞 위로 곧게 뻗음(k=0.5 점프 최고점에 닿음)
      // → 0.5~0.62 손끝(또는 주먹 마디)으로 앞으로 살짝 밀기 → 내려옴. 반대 팔은 스파이크처럼 미리 내린다.
      const rise = span(k, 0, 0.3), reach = span(k, 0.3, 0.5), push = span(k, 0.5, 0.62), down = span(k, 0.7, 0.95);
      const toward = (dir, amount) => [dir[0] + lat * amount, dir[1], dir[2]];
      const contact = [toward(SWING.contact[0], 0.12), toward(SWING.contact[1], 0.2)];
      const hitArm = [0, 1].map(i => lerp3(lerp3(lerp3(lerp3(SWING.otherDown[i], SWING.other[i], rise), contact[i], reach), TIP.push[i], push), SWING.otherDown[i], down));
      const other = [0, 1].map(i => lerp3(lerp3(SWING.otherDown[i], SWING.other[i], rise), SWING.tuck[i], span(k, 0.28, 0.42)));
      this.hitArms(hitArm, other);
      this.legs(k < 0.15 ? LEGS.bent : k < 0.8 ? LEGS.tuck : LEGS.bent);
      this.twistHitHand(aim * 0.7 * reach);
      // 손 모양: 코브라는 손을 팔과 일직선으로 곧게, 포크는 손목을 꺾어 주먹 마디(손등 쪽)가 앞으로
      if (opts.style === 'poke') this.flexHitHand(-1.3 * reach * (1 - down));
    } else if (type === 'bump') {
      const push = Math.sin(Math.PI * Math.min(1, Math.max(0, (k - 0.25) / 0.4)));  // k=0.45(닿는 순간)에 가장 높이 밀어 올림
      this.arms([lerp3(ARMS.bump[0], ARMS.bumpUp[0], push), lerp3(ARMS.bump[1], ARMS.bumpUp[1], push)]);
      this.legs(LEGS.low);
    } else if (type === 'run') {
      // 달리기: k는 쓰지 않고 시간으로 다리·팔을 번갈아 흔든다(초당 약 3걸음). 몸은 살짝 앞으로 숙인다
      const ph = t * 10;
      const leg = a => [[0.06, -Math.cos(a), Math.sin(a)], [0.04, -Math.cos(a) * 0.9, Math.sin(a) - (a < 0 ? 0.6 : 0.1)]];
      const arm = a => [[0.22, -Math.cos(a), Math.sin(a)], [0.12, -0.15, 1]];
      const swing = 0.6 * Math.sin(ph);
      this.spine(SPINE.run);
      this.arms(arm(-swing), arm(swing));
      this.legs(leg(swing), leg(-swing));
    } else if (type === 'underSet') {
      // 0~0.3 무릎을 굽혀 팔을 앞에 모음 → k=0.45 공을 받음 → 0.75까지 가슴 높이로 부드럽게 들어 올리며 일어남
      // 배구 언더 토스: 공 밑으로 깊게 앉아(0~0.3) 팔 플랫폼을 고정하고 기다림 → 닿는 순간(0.45)부터 팔은 거의 그대로,
      // **다리를 펴는 힘으로** 공을 들어 올림(0.45~0.72) → 끝에 몸이 쭉 펴지고 팔은 어깨 높이에서 멈춤
      this.spine(keyedVec(k, [[0, SPINE.up], [0.3, SPINE.lean], [0.45, SPINE.lean], [0.72, SPINE.up]]));
      this.arms(keyed(k, [[0, ARMS.ready], [0.3, ARMS.underSet], [0.45, ARMS.underSet], [0.72, ARMS.underSetUp]]));
      this.legs(keyed(k, [[0, LEGS.bent], [0.3, LEGS.low], [0.45, LEGS.low], [0.72, LEGS.stand], [0.9, LEGS.stand]]));
    } else if (type === 'dig') {
      // 0~0.3 공 쪽으로 크게 내딛음 → 0.3~0.45 몸을 낮춰 미끄러지며 k=0.45에 발 앞 낮은 곳에서 받음 → 0.75~1 일어남
      // (몸이 공 쪽으로 미끄러져 가는 이동은 렌더러·경기 규칙이 한다)
      const step = span(k, 0, 0.3), low = span(k, 0.2, 0.45), up = span(k, 0.75, 1);
      const arms = [0, 1].map(i => lerp3(lerp3(ARMS.ready[i], ARMS.dig[i], step), ARMS.ready[i], up));
      this.spine(lerp3(lerp3(SPINE.up, SPINE.slide, low), SPINE.up, up));
      this.arms(arms);
      const front = [0, 1].map(i => lerp3(lerp3(LEGS.bent[i], LEGS.lungeFront[i], low), LEGS.bent[i], up));
      const back = [0, 1].map(i => lerp3(lerp3(LEGS.bent[i], LEGS.lungeBack[i], low), LEGS.bent[i], up));
      // 치는 손잡이 쪽 다리를 앞으로 내딛는다
      if (this.handedness === 'left') this.legs(front, back); else this.legs(back, front);
    } else if (type === 'set') {
      // 0~0.2 이마 위로 손을 올려 삼각형을 만들고 기다림 → 0.45에 공을 받아 → 0.7까지 위로 쭉 밀기
      // 배구 오버 토스: 공 밑에 들어가 무릎을 깊게 굽히고(0.22) 이마 위에 손 삼각형 → 공이 오면 살짝 받쳐 내려오며(0.45)
      // **다리를 펴면서 팔도 함께** 목표 쪽으로 쭉 밀어 올림(0.45~0.65) → 끝에 온몸이 펴지고 손은 목표 쪽 위로(팔로스루)
      this.spine(keyedVec(k, [[0, SPINE.up], [0.22, [0, 0.96, 0.28]], [0.45, [0, 0.98, 0.18]], [0.65, [0, 1, -0.06]], [0.9, SPINE.up]]));
      this.arms(keyed(k, [[0, ARMS.ready], [0.2, ARMS.set], [0.45, ARMS.set], [0.65, ARMS.setPush], [0.9, ARMS.setPush]]));
      this.legs(keyed(k, [[0, LEGS.bent], [0.22, LEGS.load], [0.45, LEGS.bent], [0.65, LEGS.stand], [0.9, LEGS.stand]]));
    } else if (type === 'jump') {
      this.arms(ARMS.jump);
      this.legs(k < 0.1 || k > 0.85 ? LEGS.bent : LEGS.tuck);
    } else if (type === 'cheer') {
      const wave = Math.sin(t * 9) * 0.25;
      this.arms([[ARMS.cheer[0][0] + wave, ARMS.cheer[0][1], 0.05], ARMS.cheer[1]]);
      this.legs(LEGS.stand);
    } else if (type === 'block') {
      // 배구 블로킹(2026-09-27 선생님: "블로킹하는 사람 손이 잘 안 보인다"):
      // 0~0.18 무릎을 굽히며 두 손을 얼굴 앞 어깨 높이로(손바닥 앞) → 0.18~0.4 다리를 펴며 뛰어 두 팔을 머리 양옆 위로 V자로 곧게(머리가 큰 캐릭터라 뒤에서도 손이 보이게)
      // → 0.4~0.6 최고점에서 손을 네트 너머 앞으로 밀어 넣어 덮음(k=0.5에 공) → 0.75~1 팔을 거두며 무릎으로 착지
      this.spine(keyedVec(k, [[0, SPINE.up], [0.18, [0, 0.97, 0.22]], [0.4, [0, 1, 0.04]], [0.55, [0, 0.98, 0.2]], [0.8, SPINE.up]]));
      this.arms(keyed(k, [[0, ARMS.ready], [0.18, ARMS.blockLoad], [0.4, ARMS.block], [0.55, ARMS.blockPress], [0.72, ARMS.block], [0.92, ARMS.blockLoad]]));
      this.legs(keyed(k, [[0, LEGS.bent], [0.18, LEGS.load], [0.34, LEGS.stand], [0.5, LEGS.jump], [0.78, LEGS.stand], [0.9, LEGS.load], [1, LEGS.bent]]));
      // 머리가 크고 팔이 짧아 팔을 다 뻗어도 손이 머리 높이(1.43m, 머리 뼈 1.25m)에 파묻혔다.
      // 뛰는 동안 팔을 1.2배 늘리고 손을 조금 키워 손이 머리 위·옆으로 보이게 한다(키넥트식 과장)
      const up = span(k, 0.25, 0.42) * (1 - span(k, 0.7, 0.85));
      for (const a of [this.b.LeftArm, this.b.RightArm]) a?.scale.setScalar(1 + 0.2 * up);
      for (const h of [this.b.LeftHand, this.b.RightHand]) h?.scale.setScalar(1 + 0.15 * up);
    } else if (ARMS[type]) {
      this.arms(ARMS[type]);
      this.legs(['bump', 'ready', 'dive'].includes(type) ? LEGS.bent : LEGS.stand);
    } else {
      const idle = [[ARMS.idle[0][0], ARMS.idle[0][1], ARMS.idle[0][2] + breathe], ARMS.idle[1]];
      this.arms(idle);
      this.legs(LEGS.stand);
    }

    // 부드럽게 잇기(2026-09-27 선생님: "캐릭터가 번쩍번쩍"):
    // ① 동작이 바뀌면 0.22초 동안 직전 모습에서 새 동작으로 서서히 넘어간다(대기·실망 클립 시작, 다이브 등에서 손이 한 프레임에 26~71cm 튀던 것)
    // ② 같은 동작 안에서는 시간 기준으로 아주 짧게(0.035초)만 따라가 스파이크 같은 빠른 동작은 그대로 살린다
    // 측정 함수(contactHand 등)는 prev를 비우고 부르므로 섞지 않는다. 리플레이처럼 시간이 뒤로 가거나 크게 뛰면 섞지 않는다.
    const fresh = this.prev.size === 0;
    const dtp = this.lastPoseT == null ? 1 / 60 : t - this.lastPoseT;
    const jumpInTime = dtp <= 0 || dtp > 0.2;
    const key = type + ':' + (opts.style ?? '');
    if (!fresh && !jumpInTime && key !== this.lastPoseKey) {
      this.fadeFrom = new Map([...this.prev].map(([b, q]) => [b, q.clone()]));
      this.fadeT0 = t;
    }
    if (fresh || jumpInTime) this.fadeFrom = null;
    this.lastPoseKey = key; this.lastPoseT = t;
    const fadeU = this.fadeFrom ? span(t, this.fadeT0, this.fadeT0 + 0.22) : 1;
    const follow = fresh || jumpInTime ? 1 : 1 - Math.exp(-dtp / 0.035);
    const tmp = new THREE.Quaternion();
    for (const bone of this.rest.keys()) {
      tmp.copy(bone.quaternion);
      const from = this.fadeFrom?.get(bone);
      if (from && fadeU < 1) tmp.copy(from).slerp(bone.quaternion, fadeU);
      const p = this.prev.get(bone);
      if (p && follow < 1) tmp.copy(p.clone().slerp(tmp, follow));
      bone.quaternion.copy(tmp);
      this.prev.set(bone, tmp.clone());
    }
    if (fadeU >= 1) this.fadeFrom = null;
    this.ground();
  }
}
