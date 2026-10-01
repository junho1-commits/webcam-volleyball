// 응원 관객 (Claude 담당): 메뉴 그림과 같은 화풍의 그림 관객(그림판)을 관중석에 세우고, 경기 흐름에 반응시킨다.
// 그림: assets/ui/crowd-atlas.webp — Gemini로 그린 관객 8명 × (평소: 피켓을 가슴 앞에 / 환호: 피켓을 머리 위로) 2자세, 칸 256×320.
//       0 파란 옷 소녀 1 파란 모자 아빠 2 빨간 머리띠 소년 3 밀짚모자 할머니
//       4 파란 옷 소년 5 빨간 선캡 누나 6 빨간 치어리더 7 하와이안 셔츠 삼촌
//       원본 art/crowd/fans-a-sign3.png, fans-b-sign.png → tools/build_crowd_atlas.py (흰 피켓 위치 SIGN_RECTS도 그 도구가 잰다)
// 흰 피켓 위에는 이번 경기 선수의 응원 피켓(얼굴 + "아라 화이팅!")을 덧씌운다(2026-09-27 선생님: "선수들 응원 피켓으로").
// 사용:
//   const crowd = new Crowd({ quality });  scene.add(crowd.group);
//   crowd.setTeams(['ara', 'min'], ['sori', 'jun']);   // 경기 시작 때 우리 팀·상대 팀 캐릭터(없으면 이 기본값)
//   crowd.update(t, dt, ballWorldPos);      // 매 프레임
//   crowd.react(type, { team });            // serve · spike · dig · point · win · hype · matchPoint
// 그림판은 그리기 직전(onBeforeRender)에 스스로 카메라 쪽으로 돌아선다(세로축만). 렌더러는 할 일이 없다.
// 좌표: 렌더러 세계 좌표 그대로(우리 코트 z<0). 왼쪽 관중석(x>0, 화면 왼쪽)은 우리 팀 응원이 많다.

import * as THREE from 'three';
import { createBusanBoards } from './busan-boards.js';

const ATLAS_URL = new URL('../../assets/ui/crowd-atlas.webp', import.meta.url).href;
const COLS = 8;
const FAN_TEAM = ['me', 'me', 'ai', 'ai', 'me', 'ai', 'ai', 'any'];
const FAN_HEIGHT = [1.35, 1.75, 1.3, 1.55, 1.25, 1.65, 1.6, 1.75];   // 그림 칸 높이(m). 아이는 작게, 어른은 크게

// 흰 피켓 위치: [평소, 환호] 칸 안 (u0, v0, u1, v1), 왼쪽 아래 0 ~ 오른쪽 위 1 (tools/build_crowd_atlas.py 출력)
const SIGN_RECTS = [[[0.222, 0.302, 0.77, 0.532], [0.045, 0.791, 0.951, 0.972]], [[0.248, 0.308, 0.749, 0.515], [0.037, 0.768, 0.956, 0.888]], [[0.226, 0.276, 0.773, 0.504], [0.041, 0.802, 0.951, 0.972]], [[0.249, 0.264, 0.748, 0.471], [0.037, 0.737, 0.959, 0.891]], [[0.237, 0.289, 0.765, 0.513], [0.045, 0.791, 0.948, 0.972]], [[0.258, 0.355, 0.741, 0.559], [0.04, 0.768, 0.956, 0.923]], [[0.233, 0.357, 0.762, 0.579], [0.049, 0.804, 0.946, 0.972]], [[0.255, 0.335, 0.742, 0.54], [0.037, 0.771, 0.959, 0.926]]];
const CHARACTER = {
  ara: { name: '아라', number: 1 }, min: { name: '민', number: 2 }, sori: { name: '소리', number: 3 }, jun: { name: '준', number: 4 }, hana: { name: '하나', number: 5 },
};
const TEAM_COLOR = { me: ['#1565c0', '#42a5f5'], ai: ['#c62828', '#ef5350'] };
const CHEERS = ['화이팅!', '최고!', '사랑해!', '힘내!'];
const BUSAN_SIGNS = ['부산 화이팅!', '광안리 최고!'];   // 몇 명은 부산 응원 피켓
const PORTRAIT = id => new URL(`../../assets/ui/menu/char-${id}.webp`, import.meta.url).href;
// 피켓 그림판: 모양 두 가지(가슴 앞 2:1, 머리 위 4:1) × 칸 8개(0~3 선수 피켓, 4~5 부산 피켓)
const PICK = { w: 1024, h: 2048, aw: 512, ah: 256, bw: 512, bh: 128, slots: 6 };

const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let atlasTexture = null;
function atlas() {
  if (!atlasTexture) {
    atlasTexture = new THREE.TextureLoader().load(ATLAS_URL);
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
    atlasTexture.anisotropy = 4;
  }
  return atlasTexture;
}

export class Crowd {
  constructor({ quality = 'high', seed = 7 } = {}) {
    const rand = rng(seed);
    this.teams = { me: ['ara', 'min'], ai: ['sori', 'jun'] };
    this.group = new THREE.Group();
    this.group.name = 'crowd';
    this.people = [];
    const perSide = quality === 'low' ? 24 : quality === 'medium' ? 36 : 48;

    // 관중석(계단식 3단, 양옆 전체 길이)
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x3a6fa8, roughness: .8 });
    for (const side of [1, -1]) {
      for (let tier = 0; tier < 3; tier++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(.8, .35 + tier * .45, 17), benchMat);
        step.position.set(side * (6.4 + tier * .8), (.35 + tier * .45) / 2, 0);
        step.receiveShadow = true;
        this.group.add(step);
      }
      for (let i = 0; i < perSide; i++) {
        const tier = i % 3;
        const z = -8 + (Math.floor(i / 3) + rand() * .6) * (16 / Math.ceil(perSide / 3));
        const want = rand() < .7 ? (side > 0 ? 'me' : 'ai') : (side > 0 ? 'ai' : 'me');
        this.addPerson(rand, side * (6.4 + tier * .8) + (rand() - .5) * .2, .35 + tier * .45, z, want);
      }
    }
    // 반대편 끝줄(상대 코트 뒤, 기본 카메라에 잘 보인다): 서서 응원
    const backCount = quality === 'low' ? 10 : 18;
    for (let i = 0; i < backCount; i++) {
      this.addPerson(rand, -6.5 + 13 * (i + rand() * .6) / backCount, 0, 11.2 + rand() * 1.4, rand() < .5 ? 'me' : 'ai');
    }

    this.buildMesh();
    // 코트 둘레 부산 광고판(busan-boards.js)도 관중석과 함께 세운다
    this.boards = createBusanBoards({ quality });
    this.group.add(this.boards.group);
    this.events = [];
    this.wave = null;
    this.clap = null;
    this.leanUntil = -1;
    this.time = 0;
  }

  addPerson(rand, x, y, z, want) {
    // 응원 팀에 맞는 그림을 고른다. 북 치는 삼촌(어느 쪽이든)은 10%만 — 많으면 한 사람만 눈에 띈다
    const pool = FAN_TEAM.map((team, i) => i).filter(i => FAN_TEAM[i] === want);
    const fan = rand() < .1 ? FAN_TEAM.indexOf('any') : pool[Math.floor(rand() * pool.length)];
    this.people.push({
      x, y, z, fan,
      team: FAN_TEAM[fan] === 'any' ? want : FAN_TEAM[fan],
      height: FAN_HEIGHT[fan] * (.92 + rand() * .16),
      phase: rand() * Math.PI * 2,
      energy: .6 + rand() * .6,
      mood: rand(),                 // 평소에도 가끔 혼자 환호하는 정도
      flip: rand() < .5 ? -1 : 1,   // 좌우 뒤집어 같은 그림도 달라 보이게
      // 피켓: 응원 팀 선수 0·1번 또는 부산 응원(15%). 슬롯 0·1 = 우리 팀 선수, 2·3 = 상대 팀 선수, 4·5 = 부산
      sign: rand() < .15 ? 4 + Math.floor(rand() * 2) : (FAN_TEAM[fan] === 'any' ? want : FAN_TEAM[fan]) === 'me' ? Math.floor(rand() * 2) : 2 + Math.floor(rand() * 2),
      cheerWord: Math.floor(rand() * CHEERS.length),
    });
  }

  buildMesh() {
    const n = this.people.length;
    const geo = new THREE.PlaneGeometry(1, 1.25);
    geo.translate(0, .625, 0);                    // 발끝이 원점
    const cell = new Float32Array(n * 2);
    geo.setAttribute('instUv', new THREE.InstancedBufferAttribute(cell, 2));
    const mat = new THREE.MeshBasicMaterial({ map: atlas(), alphaTest: .45, side: THREE.DoubleSide, toneMapped: false });
    mat.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 instUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * vec2(1.0 / 8.0, 0.5) + instUv;\n#endif');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.name = 'crowd-fans';
    this.mesh.frustumCulled = false;
    this.cell = geo.getAttribute('instUv');
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < n; i++) this.mesh.setColorAt(i, white);
    // 그리기 직전에 카메라를 기억해 두고, 다음 update에서 그 카메라를 향하게 행렬을 만든다
    // (onBeforeRender 때는 이미 행렬이 GPU로 올라간 뒤라 여기서 바꾸면 한 프레임 늦는다)
    this.mesh.onBeforeRender = (renderer, scene, camera) => { this.cameraPos = camera.position; };
    this.group.add(this.mesh);
    this.buildPickets(n);
    this.state = this.people.map(p => ({ y: p.y, cheer: false, dim: 1, squash: 1 }));
    this.writeMatrices({ x: 0, z: -13 });
  }

  // 흰 피켓 위에 덧씌우는 응원 피켓(선수 얼굴 + 이름). 관객 그림판과 같은 자리·같은 방향, 좌우는 뒤집지 않는다(글자가 거꾸로 보이지 않게)
  buildPickets(n) {
    const canvas = document.createElement('canvas');
    canvas.width = PICK.w; canvas.height = PICK.h;
    this.pickCanvas = canvas;
    this.pickTexture = new THREE.CanvasTexture(canvas);
    this.pickTexture.colorSpace = THREE.SRGBColorSpace;
    this.pickTexture.anisotropy = 4;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('pickUv', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    const mat = new THREE.MeshBasicMaterial({ map: this.pickTexture, side: THREE.DoubleSide, toneMapped: false });
    mat.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 pickUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = pickUv.xy + vMapUv * pickUv.zw;\n#endif');
    };
    this.pickMesh = new THREE.InstancedMesh(geo, mat, n);
    this.pickMesh.name = 'crowd-pickets';
    this.pickMesh.frustumCulled = false;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < n; i++) this.pickMesh.setColorAt(i, white);
    this.pickUv = geo.getAttribute('pickUv');
    this.group.add(this.pickMesh);
    this.portraits = {};
    this.drawPickets();
  }

  // 경기 시작 때 부른다: 우리 팀·상대 팀 캐릭터 이름('ara', 'min', 'sori', 'jun')
  setTeams(me = this.teams.me, ai = this.teams.ai) {
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (same(me, this.teams.me) && same(ai, this.teams.ai)) return;
    this.teams = { me: [...me], ai: [...ai] };
    this.drawPickets();
  }

  drawPickets() {
    const g = this.pickCanvas.getContext('2d');
    g.clearRect(0, 0, PICK.w, PICK.h);
    const slots = [
      ...this.teams.me.slice(0, 2).map(id => ({ id, team: 'me' })),
      ...this.teams.ai.slice(0, 2).map(id => ({ id, team: 'ai' })),
      { busan: BUSAN_SIGNS[0] }, { busan: BUSAN_SIGNS[1] },
    ];
    while (slots.length < PICK.slots) slots.splice(slots.length - 2, 0, { busan: '부산 화이팅!' });
    slots.forEach((slot, i) => {
      for (const wide of [false, true]) {
        const r = this.slotRect(i, wide);
        this.drawSign(g, slot, r.x, r.y, r.w, r.h, wide);
      }
      if (slot.id && !this.portraits[slot.id]) {
        const img = new Image();
        img.onload = () => { this.portraits[slot.id] = img; this.drawPickets(); };
        img.src = PORTRAIT(slot.id);
        this.portraits[slot.id] = 'loading';
      }
    });
    this.pickTexture.needsUpdate = true;
  }

  // 그림판 안 칸 위치(캔버스 픽셀). 가슴 앞(2:1)은 위쪽 3줄, 머리 위(4:1)는 그 아래
  slotRect(i, wide) {
    const col = i % 2, row = Math.floor(i / 2);
    return wide
      ? { x: col * PICK.bw, y: 3 * PICK.ah + row * PICK.bh, w: PICK.bw, h: PICK.bh }
      : { x: col * PICK.aw, y: row * PICK.ah, w: PICK.aw, h: PICK.ah };
  }

  drawSign(g, slot, x, y, w, h, wide) {
    const pad = Math.round(h * (wide ? 0.08 : 0.06));
    const colors = slot.busan ? ['#00897b', '#ffca28'] : TEAM_COLOR[slot.team];
    g.save();
    g.fillStyle = '#fffdf5'; g.fillRect(x, y, w, h);
    g.lineWidth = pad; g.strokeStyle = colors[0]; g.strokeRect(x + pad / 2, y + pad / 2, w - pad, h - pad);
    const face = slot.id && this.portraits[slot.id] instanceof Image ? this.portraits[slot.id] : null;
    const d = h - pad * 3;                               // 얼굴 동그라미 지름
    let left = x + pad * 2, right = x + w - pad * 2;     // 글자 들어갈 자리
    if (face) {
      const cx = x + pad * 1.6 + d / 2, cy = y + h / 2;
      g.save(); g.beginPath(); g.arc(cx, cy, d / 2, 0, Math.PI * 2); g.clip();
      g.fillStyle = colors[1]; g.fillRect(cx - d / 2, cy - d / 2, d, d);
      const fs = face.width * 0.5;   // 대표 그림(char-*.webp) 위쪽 가운데의 얼굴만 정사각형으로
      g.drawImage(face, (face.width - fs) / 2, face.height * 0.04, fs, fs, cx - d / 2, cy - d / 2, d, d);
      g.restore();
      g.lineWidth = pad * 0.7; g.strokeStyle = colors[0]; g.beginPath(); g.arc(cx, cy, d / 2, 0, Math.PI * 2); g.stroke();
      left = cx + d / 2 + pad;
    }
    const tx = (left + right) / 2, maxW = right - left;
    const name = slot.busan ?? CHARACTER[slot.id]?.name ?? slot.id;
    const cheer = slot.busan ? null : '화이팅!';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = colors[0];
    const font = size => `900 ${size}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
    const fit = (text, size) => { g.font = font(size); const m = g.measureText(text).width; return m > maxW ? size * maxW / m : size; };
    if (wide || !cheer) {
      const text = cheer ? `${name} ${cheer}` : name;
      g.font = font(fit(text, h * 0.55)); g.fillText(text, tx, y + h / 2 + h * 0.03);
    } else {
      g.font = font(fit(name, h * 0.42)); g.fillText(name, tx, y + h * 0.38);
      g.fillStyle = colors[1]; g.font = font(fit(cheer, h * 0.3)); g.fillText(cheer, tx, y + h * 0.72);
    }
    g.restore();
  }

  react(type, data = {}) {
    const t = this.time;
    if (type === 'serve') { this.leanUntil = t + 1.6; return; }
    if (type === 'hype' || type === 'win') this.wave = { t0: t, laps: type === 'win' ? 2 : 1 };
    if (type === 'matchPoint') this.clap = { t0: t, until: t + 3 };
    this.events.push({ type, team: data.team ?? null, t0: t });
    this.events = this.events.filter(e => t - e.t0 < 4);
  }

  // 한 사람의 지금 모습: 뜀 높이, 환호 그림인지, 어둡기(실망), 찌그러짐(박수 들썩)
  poseOf(p, t) {
    let jump = 0, cheer = false, dim = 1, squash = 1;
    // 평소: 살짝 들썩이고, 흥이 많은 사람은 가끔 혼자 환호
    jump = Math.max(0, .03 * Math.sin(t * 3 + p.phase));
    if (p.mood > .85 && Math.sin(t * .7 + p.phase * 3) > .93) { cheer = true; jump = .08 * Math.abs(Math.sin(t * 8 + p.phase)); }
    if (t < this.leanUntil) { squash = .96; jump = 0; cheer = false; }   // 서브 직전: 숨죽임
    for (const e of this.events) {
      const a = t - e.t0;
      if (e.type === 'spike' && a < .9) { const k = Math.sin(Math.PI * Math.min(1, a / .9)); jump = Math.max(jump, .18 * k * p.energy); if (k > .3) cheer = true; }
      if (e.type === 'dig' && a < 1.4) squash = Math.min(squash, 1 - .05 * Math.abs(Math.sin(t * 14 + p.phase)));
      if ((e.type === 'point' || e.type === 'win') && a < 3) {
        const fade = a < 2.4 ? 1 : 1 - (a - 2.4) / .6;
        if (!e.team || e.team === p.team) {
          cheer = fade > .2;
          jump = Math.max(jump, fade * .32 * p.energy * Math.abs(Math.sin(t * 7 + p.phase)));
        } else {
          dim = Math.min(dim, 1 - .28 * fade);                 // 상대 득점: 어깨가 처지고 어두워짐
          squash = Math.min(squash, 1 - .08 * fade);
        }
      }
    }
    if (this.clap && t < this.clap.until) squash = Math.min(squash, 1 - .06 * Math.abs(Math.sin(t * 9 + p.phase)));
    // 파도타기: 관객 둘레를 따라 일어나 환호하는 물결
    if (this.wave) {
      const a = t - this.wave.t0;
      if (a > this.wave.laps * 3.2) this.wave = null;
      else {
        const u = this.ringPos(p), front = (a / 3.2) % 1;
        const d = Math.min(Math.abs(u - front), 1 - Math.abs(u - front));
        if (d < .06) { const k = 1 - d / .06; jump = Math.max(jump, .4 * k); if (k > .3) cheer = true; }
      }
    }
    return { y: p.y + jump, cheer, dim, squash };
  }

  ringPos(p) {
    // 오른쪽 관중석(x<0) 앞→뒤, 끝줄, 왼쪽 관중석(x>0) 뒤→앞 순서로 한 바퀴
    if (p.z > 10.5) return .4 + (p.x + 6.5) / 13 * .2;
    if (p.x < 0) return (p.z + 8) / 17 * .4;
    return .6 + (1 - (p.z + 8) / 17) * .4;
  }

  // update: 자세·그림 칸·밝기를 정한다(행렬은 그리기 직전에 카메라를 보고 만든다)
  update(t, dt = 1 / 60, ball = null) {
    this.time = t;
    this.boards?.update(t);
    const c = new THREE.Color();
    this.people.forEach((p, i) => {
      const s = this.poseOf(p, t);
      this.state[i] = s;
      this.cell.setXY(i, p.fan / COLS, s.cheer ? 0 : .5);      // 위 줄(v 0.5~1) = 평소, 아래 줄 = 환호
      this.mesh.setColorAt(i, c.setScalar(s.dim));
      this.pickMesh?.setColorAt(i, c);
    });
    if (this.pickMesh?.instanceColor) this.pickMesh.instanceColor.needsUpdate = true;
    this.cell.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.writeMatrices(this.cameraPos ?? { x: 0, z: -13 });
  }

  // 화면 나누기(VS)처럼 한 프레임에 카메라를 여러 대 쓸 때: 각 화면을 그리기 **직전에** 불러
  // 관중·피켓이 그 카메라를 보게 한다. camera는 THREE.Camera 또는 {x, z}.
  faceCamera(camera) {
    const pos = camera?.position ?? camera;
    if (!pos) return;
    this.cameraPos = pos;
    this.writeMatrices(pos);
  }

  writeMatrices(camera) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3(), fwd = new THREE.Vector3();
    const cx = camera.x, cz = camera.z;
    this.people.forEach((p, i) => {
      const st = this.state[i] ?? { y: p.y, squash: 1 };
      const yaw = Math.atan2(cx - p.x, cz - p.z);
      q.setFromAxisAngle(up, yaw);                                // 세로축으로만 카메라를 본다
      const h = p.height;
      s.set(h * .8 * p.flip, h * st.squash, 1);                  // 칸 비율 256:320 = 0.8
      m.compose(pos.set(p.x, st.y, p.z), q, s);
      this.mesh.setMatrixAt(i, m);
      if (!this.pickMesh) return;
      // 피켓: 그림 속 흰 판 자리에 같은 방향으로, 카메라 쪽으로 1cm 앞
      const [u0, v0, u1, v1] = SIGN_RECTS[p.fan][st.cheer ? 1 : 0];
      side.set(Math.cos(yaw), 0, -Math.sin(yaw)); fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      const lx = ((u0 + u1) / 2 - 0.5) * h * .8 * p.flip, ly = (v0 + v1) / 2 * 1.25 * h * st.squash;
      pos.set(p.x, st.y + ly, p.z).addScaledVector(side, lx).addScaledVector(fwd, 0.01);
      s.set((u1 - u0) * h * .8, (v1 - v0) * 1.25 * h * st.squash, 1);
      m.compose(pos, q, s);
      this.pickMesh.setMatrixAt(i, m);
      const r = this.slotRect(p.sign, !!st.cheer);
      this.pickUv.setXYZW(i, r.x / PICK.w, 1 - (r.y + r.h) / PICK.h, r.w / PICK.w, r.h / PICK.h);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.pickMesh) { this.pickMesh.instanceMatrix.needsUpdate = true; this.pickUv.needsUpdate = true; }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(o => { o.geometry?.dispose(); if (o.material && o.material.map !== atlasTexture) o.material.dispose?.(); });
    this.pickTexture?.dispose();
    this.boards?.dispose();
  }
}
