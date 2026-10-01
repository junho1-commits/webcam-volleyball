// 광안리 배경 (Claude 담당): 광안대교, 마린시티·센텀시티 고층 건물, 해변 건물, 산, 요트, 하늘.
// 사용: const bg = installGwangalli(scene, camera, { quality: 'high' });  매 프레임 bg.update(t)(요트 흔들림, 없어도 됨)
//
// 자작 로우폴리. 게임 화면에서 잘 보이도록 실제 거리는 약 1/5로 줄이고 높이는 1.5배 과장했다.
// 해변에서 바다를 볼 때처럼 배치했다: 앞(+z)에 광안대교가 가로지르고,
// 화면 왼쪽(+x)에 마린시티·센텀시티, 오른쪽(-x)에 남천동과 이기대, 뒤(-z)에 해변 거리와 황령산.
// 먼 풍경이 보이도록 안개(FogExp2), 하늘 돔, 카메라 far를 이 모듈이 바꾼다.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const HAZE = 0xcfe2ea;          // 수평선 안개색 = 하늘 아래쪽 색
const SKY_TOP = 0x3f9fe0;
const SEA = 0x2a8fbd;
const SAND = 0xe4c585;
const BRIDGE = 0xdde3e8;

// 해변 모양(초승달). 가운데가 z=14, 양 끝으로 갈수록 바다 쪽으로 휜다.
const BEACH_X = [-170, 150];
const shoreZ = x => 14 + 0.0016 * x * x;
const backZ = x => -42 + 0.0016 * x * x;          // 모래사장 뒤 끝 = 해변 도로 앞

// 광안대교 경로(x, z). 오른쪽 남천동에서 시작해 바다를 크게 돌아 왼쪽 마린시티 앞에 닿는다.
const BRIDGE_PATH = [[-235, 58], [-205, 120], [-150, 185], [-80, 232], [0, 250], [70, 247], [115, 238], [140, 226]];
const TOWER_H = 30, DECK_H = 11, LANDING_H = 2.2, DECK_W = 5.2;

function hash(a, b, c, d) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 같은 결과가 나오도록 고정 난수
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function installGwangalli(scene, camera, { quality = 'high' } = {}) {
  const bg = createGwangalli({ quality });
  scene.add(bg.group);
  scene.fog = new THREE.FogExp2(HAZE, 0.0016);     // 25m 0.1%, 250m 15%, 500m 47%: 가까운 코트는 그대로, 먼 곳만 뿌옇게
  scene.background = new THREE.Color(HAZE);
  if (camera) { camera.far = Math.max(camera.far, 2600); camera.updateProjectionMatrix(); }
  return bg;
}

export function createGwangalli({ quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'gwangalli';
  const low = quality === 'low';
  const disposables = [];
  const add = (mesh) => { group.add(mesh); disposables.push(mesh.geometry); if (mesh.material) disposables.push(mesh.material); return mesh; };

  add(makeSky());
  add(makeSea());
  add(makeGround());
  const bridge = makeBridge(!low); bridge.forEach(add);
  const city = makeCity(!low); city.forEach(add);
  add(makeHills());
  const yachts = low ? null : makeYachts(); if (yachts) yachts.meshes.forEach(add);

  return {
    group,
    update(t) { yachts?.update(t); },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) { d.map?.dispose(); d.dispose(); }
    },
  };
}

// ── 하늘: 위는 파랑, 수평선은 안개색
function makeSky() {
  const geo = new THREE.SphereGeometry(2200, 32, 16);
  const top = new THREE.Color(SKY_TOP), haze = new THREE.Color(HAZE), mid = new THREE.Color(0x8cc8ee);
  const pos = geo.attributes.position, colors = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 2200;
    if (h <= 0.02) c.copy(haze);
    else if (h < 0.18) c.copy(haze).lerp(mid, (h - 0.02) / 0.16);
    else c.copy(mid).lerp(top, Math.min(1, (h - 0.18) / 0.5));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return mesh;
}

// ── 바다: 수평선까지 닿는 큰 판. 코트 쪽 기존 바다(y -0.12)보다 살짝 아래
function makeSea() {
  const geo = new THREE.PlaneGeometry(6000, 6000);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: SEA, roughness: 0.32, metalness: 0.05 }));
  mesh.position.y = -0.16;
  mesh.name = 'sea';
  return mesh;
}

// (x, z) 점들로 바닥 판을 만든다
function flatShape(points, y, color) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);            // (x, y) → (x, 0, -y) 이므로 위에서 z를 뒤집어 넣었다
  geo.translate(0, y, 0);
  return paint(geo, color);
}

function paint(geo, color) {
  const c = new THREE.Color(color), n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

// ── 땅: 모래사장, 파도 거품, 해변 도로, 도시 땅(왼쪽 센텀·마린시티, 오른쪽 남천동·이기대)
function makeGround() {
  const [x0, x1] = BEACH_X, steps = 40;
  const xs = Array.from({ length: steps + 1 }, (_, i) => x0 + (x1 - x0) * i / steps);
  const parts = [];

  // 모래사장
  parts.push(flatShape([...xs.map(x => [x, shoreZ(x)]), ...[...xs].reverse().map(x => [x, backZ(x)])], -0.03, SAND));
  // 젖은 모래와 거품 띠
  parts.push(flatShape([...xs.map(x => [x, shoreZ(x) + 1.6]), ...[...xs].reverse().map(x => [x, shoreZ(x) - 2.5])], -0.025, 0xc9ab70));
  parts.push(flatShape([...xs.map(x => [x, shoreZ(x) + 2.6]), ...[...xs].reverse().map(x => [x, shoreZ(x) + 1.2])], -0.02, 0xf4f8f8));
  // 해변 도로(산책로)
  parts.push(flatShape([...xs.map(x => [x, backZ(x)]), ...[...xs].reverse().map(x => [x, backZ(x) - 12])], -0.02, 0x9da3a8));

  // 도시 땅: 해변 도로 뒤 전체 + 양쪽으로 바다를 감싸는 해안
  const land = [
    [x1, shoreZ(x1)], [x1 - 22, 100], [x1 - 30, 165], [x1 - 22, 238], [x1 - 5, 300], [230, 335], [330, 360], [520, 360],
    [520, -700], [-520, -700], [-520, 250], [-400, 250], [-330, 175], [-280, 105], [-238, 62], [x0 - 20, shoreZ(x0) + 2], [x0, shoreZ(x0)],
    ...xs.map(x => [x, backZ(x) - 12]),   // 오른쪽 해변 끝에서 도로 뒤를 따라 왼쪽 해변 끝으로
  ];
  parts.push(flatShape(land, 0.05, 0x98a58f));

  const geo = mergeGeometries(parts.map(g => g.toNonIndexed()));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.receiveShadow = false;
  mesh.name = 'ground';
  return mesh;
}

// ── 광안대교
function makeBridge(detail) {
  const curve = new THREE.CatmullRomCurve3(BRIDGE_PATH.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const N = 420;
  const pts = curve.getSpacedPoints(N);
  const tan = pts.map((_, i) => curve.getTangentAt(i / N));
  const side = tan.map(t => new THREE.Vector3(t.z, 0, -t.x).normalize());

  // 주탑 두 개: x가 -62, +22에 가장 가까운 지점 (주경간 약 90m)
  const nearest = x => pts.reduce((best, p, i) => Math.abs(p.x - x) < Math.abs(pts[best].x - x) ? i : best, 0);
  const t1 = nearest(-62), t2 = nearest(22);
  const span = t2 - t1, a1 = Math.max(2, t1 - Math.round(span * 0.42)), a2 = Math.min(N - 2, t2 + Math.round(span * 0.42));
  const smooth = u => u * u * (3 - 2 * u);
  const deckY = i => {
    if (i >= a1 && i <= a2) return DECK_H + 0.6 * Math.sin(Math.PI * (i - a1) / (a2 - a1));
    const u = i < a1 ? i / a1 : (N - i) / (N - a2);
    return LANDING_H + (DECK_H - LANDING_H) * smooth(Math.min(1, u * 1.15));
  };

  const meshes = [];
  const white = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });

  // 2층 상판: 위층·아래층 사이 어두운 줄이 있는 상자 띠
  const deck = ribbonBox(pts, side, i => deckY(i), i => deckY(i) - 2.6, DECK_W / 2, { top: 0xe9edf0, side: 0xc7ced5, bottom: 0x5b6570 });
  const gap = ribbonBox(pts, side, i => deckY(i) - 0.95, i => deckY(i) - 1.6, DECK_W / 2 + 0.06, { top: 0x46515c, side: 0x46515c, bottom: 0x46515c });
  const parts = [deck, gap];

  // 교각: 주경간·측경간 밖에서 약 14m마다 두 기둥
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  const place = (g, x, y, z, sx, sy, sz, rotY, color) => {
    const b = g.clone(); b.scale(sx, sy, sz); b.rotateY(rotY); b.translate(x, y, z); parts.push(paint(b, color));
  };
  const heading = i => Math.atan2(tan[i].x, tan[i].z);
  for (let i = 6; i < N - 3; i += 8) {
    if (i > a1 - 4 && i < a2 + 4) continue;
    const top = deckY(i) - 2.6;
    for (const s of [-1.7, 1.7]) place(box, pts[i].x + side[i].x * s, -0.3, pts[i].z + side[i].z * s, 0.9, top + 0.3, 0.9, heading(i), 0xcfd5da);
    place(box, pts[i].x, top - 0.7, pts[i].z, DECK_W - 0.6, 0.7, 0.9, heading(i), 0xcfd5da);
  }
  // 앵커(측경간 끝 큰 받침)
  for (const i of [a1, a2]) place(box, pts[i].x, -0.3, pts[i].z, DECK_W + 2.4, deckY(i) - 2.3, 4.5, heading(i), 0xc2c9cf);

  // 주탑: 가늘고 흰 H자. 다리 두 개 + 가로보 세 개
  for (const i of [t1, t2]) {
    const r = heading(i), off = DECK_W / 2 + 0.8;
    for (const s of [-off, off]) place(box, pts[i].x + side[i].x * s, -0.5, pts[i].z + side[i].z * s, 1.2, TOWER_H + 0.5, 1.5, r, 0xf2f5f7);
    for (const [y, h] of [[DECK_H - 3.4, 0.8], [TOWER_H * 0.72, 0.9], [TOWER_H - 1.2, 1.2]]) place(box, pts[i].x, y, pts[i].z, off * 2 + 1.2, h, 1.1, r, 0xf2f5f7);
  }
  const geo = mergeGeometries(parts.map(g => g.index ? g.toNonIndexed() : g));
  geo.computeVertexNormals();
  const solid = new THREE.Mesh(geo, white); solid.name = 'gwangan-bridge';
  meshes.push(solid);

  // 주케이블(양쪽)과 행어
  const cableY = i => {
    const topY = TOWER_H - 0.6, lowY = DECK_H + 1.4;
    if (i <= t1) { const u = (i - a1) / (t1 - a1); return deckY(a1) + (topY - deckY(a1)) * u - 1.6 * 4 * u * (1 - u); }
    if (i >= t2) { const u = (a2 - i) / (a2 - t2); return deckY(a2) + (topY - deckY(a2)) * u - 1.6 * 4 * u * (1 - u); }
    const u = (i - t1) / (t2 - t1); return lowY + (topY - lowY) * (2 * u - 1) ** 2;
  };
  const cablePts = [], hangerPts = [];
  for (const s of [-(DECK_W / 2 + 0.8), DECK_W / 2 + 0.8]) {
    const line = [];
    for (let i = a1; i <= a2; i++) line.push(pts[i].x + side[i].x * s, cableY(i), pts[i].z + side[i].z * s);
    for (let k = 0; k < line.length - 3; k += 3) cablePts.push(line[k], line[k + 1], line[k + 2], line[k + 3], line[k + 4], line[k + 5]);
    if (detail) {
      for (let i = a1 + 1; i < a2; i++) {
        if (i === t1 || i === t2) continue;
        const x = pts[i].x + side[i].x * s, z = pts[i].z + side[i].z * s;
        hangerPts.push(x, cableY(i), z, x, deckY(i), z);
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute([...cablePts, ...hangerPts], 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xeef2f5 }));
  lines.name = 'gwangan-cables';
  meshes.push(lines);
  return meshes;
}

// 곡선을 따라가는 상자 띠(상판). 윗면·옆면·밑면 색이 다르다.
function ribbonBox(pts, side, yTop, yBottom, halfW, colors) {
  const pos = [], col = [];
  const cTop = new THREE.Color(colors.top), cSide = new THREE.Color(colors.side), cBot = new THREE.Color(colors.bottom);
  const corner = (i, s, y) => [pts[i].x + side[i].x * s, y, pts[i].z + side[i].z * s];
  const quad = (a, b, c, d, color) => {
    for (const v of [a, b, c, a, c, d]) { pos.push(...v); col.push(color.r, color.g, color.b); }
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const j = i + 1;
    const tl0 = corner(i, -halfW, yTop(i)), tr0 = corner(i, halfW, yTop(i)), tl1 = corner(j, -halfW, yTop(j)), tr1 = corner(j, halfW, yTop(j));
    const bl0 = corner(i, -halfW, yBottom(i)), br0 = corner(i, halfW, yBottom(i)), bl1 = corner(j, -halfW, yBottom(j)), br1 = corner(j, halfW, yBottom(j));
    quad(tl0, tl1, tr1, tr0, cTop);
    quad(br0, br1, bl1, bl0, cBot);
    quad(bl0, bl1, tl1, tl0, cSide);
    quad(tr0, tr1, br1, br0, cSide);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  return geo;
}

// ── 건물
// 창문 무늬: 한 칸 = 가로 2.5, 세로 3(과장된 높이 기준 약 4개 층)
function windowTexture(glass) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = glass ? '#eaf2f8' : '#fbfaf6'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = glass ? '#a9c4da' : '#b3c3cf';
  for (let r = 0; r < 4; r++) for (let k = 0; k < 2; k++) g.fillRect(4 + k * 32, 3 + r * 16, glass ? 27 : 22, glass ? 11 : 9);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 상자 건물 하나. 옆면 UV를 크기에 맞춰 늘려 창문 크기가 건물마다 같게 한다. 지붕은 창문 없는 곳(0.01)을 쓴다.
function buildingBox(x, z, w, d, h, rot, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry 면 순서: +x, -x, +y, -y, +z, -z (면마다 점 4개)
  const faceSize = [[d, h], [d, h], null, null, [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const k = f * 4 + v, size = faceSize[f];
    if (!size) uv.setXY(k, 0.01, 0.01);
    else uv.setXY(k, uv.getX(k) * Math.max(1, Math.round(size[0] / 2.5)) / 2, uv.getY(k) * Math.max(1, Math.round(size[1] / 3)) / 4);
  }
  g.translate(0, h / 2, 0); g.rotateY(rot); g.translate(x, 0, z);
  return paint(g, color);
}

// 곡선형 초고층(마린시티 위브더제니스 느낌): 타원 단면, 허리가 살짝 들어가고 위로 비틀린다
function curvedTower(x, z, r, h, rot, color, squash = 0.62, twist = 0.55) {
  const g = new THREE.CylinderGeometry(r, r, h, 16, 20);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const f = (p.getY(i) + h / 2) / h;
    const k = 1 - 0.13 * Math.sin(Math.PI * f) - (f > 0.97 ? 0.25 : 0);
    let px = p.getX(i) * k, pz = p.getZ(i) * k * squash;
    const a = twist * f, ca = Math.cos(a), sa = Math.sin(a);
    p.setXYZ(i, px * ca - pz * sa, p.getY(i), px * sa + pz * ca);
    uv.setXY(i, uv.getX(i) * Math.round(2 * Math.PI * r / 2.5) / 2, uv.getY(i) * Math.round(h / 3) / 4);
  }
  g.translate(0, h / 2, 0); g.rotateY(rot); g.translate(x, 0, z);
  return paint(g, color);
}

// 돛 모양 초고층(아이파크 느낌): 윗면이 비스듬히 잘린 상자
function sailTower(x, z, w, d, h, rot, color) {
  const g = buildingBox(0, 0, w, d, h, 0, color);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > h - 0.01) p.setY(i, h - (p.getX(i) + w / 2) / w * h * 0.16);
  g.rotateY(rot); g.translate(x, 0, z);
  return g;
}

function makeCity(detail) {
  const rand = rng(20260926);
  const glass = [], plain = [];
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  // 해변 도로 뒤 건물 줄: 호텔·카페·상가. 해변 곡선을 따라 바다를 바라본다
  for (let row = 0; row < (detail ? 2 : 1); row++) {
    for (let x = BEACH_X[0] + 4; x < BEACH_X[1] - 2; x += 7 + rand() * 6) {
      const w = 6 + rand() * 6, d = 6 + rand() * 5;
      const h = row === 0 ? 5 + rand() * 9 : 12 + rand() * 14;
      const rot = Math.atan(0.0032 * x);
      const z = backZ(x) - 14 - d / 2 - row * 16 - rand() * 3;
      (rand() < 0.35 ? glass : plain).push(buildingBox(x, z, w, d, h, rot, pick([0xffffff, 0xf3e6d4, 0xdfe8ef, 0xf6d9c9, 0xe5efe3, 0xd9dde6])));
      if (row === 0 && rand() < 0.4) plain.push(buildingBox(x, z + d / 2 - 0.4, w * 0.8, 0.4, 1.2, rot, pick([0xff5d8f, 0x3fb6ff, 0xffc93c, 0x8b5cf6]))); // 옥상 간판
    }
  }

  // 오른쪽: 남천동 아파트와 삼익비치 느낌의 긴 동
  for (let k = 0; k < (detail ? 14 : 7); k++) {
    const x = -195 - rand() * 90, z = -15 + rand() * 80;
    plain.push(buildingBox(x, z, 14 + rand() * 8, 5, 10 + rand() * 12, 0.5 + rand() * 0.3, pick([0xf5f5f0, 0xe8e2d6, 0xdbe3ea])));
  }

  // 왼쪽 앞: 센텀시티(유리 고층, 20~55)
  const centum = [[128, 118], [140, 132], [152, 112], [134, 150], [150, 146], [165, 128], [172, 158], [158, 170], [183, 140], [190, 170], [178, 108], [196, 125]];
  centum.forEach(([x, z], i) => {
    const h = 20 + rand() * 30 + (i === 3 ? 12 : 0);
    const w = 7 + rand() * 5;
    (i % 3 ? glass : plain).push(buildingBox(x, z, w, w * (0.7 + rand() * 0.5), h, rand() * 0.6, pick([0xcfe6ff, 0xe8f1f7, 0xbfd8ea, 0xf2f2ee])));
  });

  // 왼쪽 뒤: 마린시티. 곡선 초고층 세 동(가장 높음) + 돛 모양 세 동 + 그 밖의 고층
  const zenith = [[168, 276, 75], [183, 266, 68], [180, 288, 62]];
  zenith.forEach(([x, z, h], i) => glass.push(curvedTower(x, z, 6.2, h, 0.4 + i * 0.7, 0xd4e7f5)));
  const ipark = [[146, 262, 64], [154, 250, 58], [140, 280, 70]];
  ipark.forEach(([x, z, h]) => glass.push(sailTower(x, z, 11, 8, h, -0.35, 0xc7def0)));
  for (let k = 0; k < (detail ? 12 : 6); k++) {
    const x = 160 + rand() * 55, z = 240 + rand() * 60;
    if (Math.hypot(x - 175, z - 277) < 16) continue;
    glass.push(buildingBox(x, z, 8 + rand() * 5, 8 + rand() * 4, 30 + rand() * 25, rand() * 0.8, pick([0xd0e2ef, 0xe6edf2, 0xbcd3e6])));
  }

  const meshes = [];
  for (const [list, isGlass] of [[glass, true], [plain, false]]) {
    const geo = mergeGeometries(list.map(g => g.index ? g.toNonIndexed() : g));
    geo.computeVertexNormals();
    // 해가 육지 쪽(-z)에서 비쳐 바다를 보는 면이 그늘진다. 스스로 조금 빛나게 해서 어느 시점에서도 밝은 도시로 보이게 한다
    const map = windowTexture(isGlass);
    const mat = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.38, vertexColors: true, roughness: isGlass ? 0.4 : 0.85, metalness: isGlass ? 0.15 : 0 });
    const mesh = new THREE.Mesh(geo, mat); mesh.name = isGlass ? 'city-glass' : 'city-plain';
    meshes.push(mesh);
  }
  return meshes;
}

// ── 산: 황령산(뒤 오른쪽), 금련산(뒤), 장산(마린시티 뒤), 이기대(오른쪽 바닷가), 동백섬·오륙도
function makeHills() {
  const hills = [
    [-270, -400, 260, 88, 0x6f8d6f], [-20, -460, 280, 70, 0x77927a], [250, -320, 260, 80, 0x6f8d6f],
    [330, 470, 300, 115, 0x6e8b78], [520, 330, 220, 70, 0x78937f],
    [-345, 190, 110, 24, 0x6f9a68], [-420, 280, 120, 30, 0x6c9166],
    [215, 318, 32, 7, 0x5f8f5b],
    [-330, 380, 9, 7, 0x8b8f86], [-345, 392, 7, 9, 0x8b8f86], [-318, 398, 6, 5, 0x8b8f86],
  ];
  const parts = hills.map(([x, z, r, h, color], seed) => {
    const g = new THREE.ConeGeometry(r, h, 10, 3);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < h / 2 - 0.01) {                          // 꼭대기 점은 그대로
        // 같은 자리 점(이음매)은 같은 값이 나오게 위치로 난수를 만든다. 그래야 산에 틈이 안 생긴다
        const n = hash(Math.round(p.getX(i) * 10), Math.round(y * 10), Math.round(p.getZ(i) * 10), seed);
        const k = 0.85 + n * 0.3;
        p.setXYZ(i, p.getX(i) * k, y + (y > -h / 2 + 0.01 ? (hash(seed, Math.round(p.getX(i) * 10), Math.round(p.getZ(i) * 10), 3) - 0.5) * h * 0.25 : 0), p.getZ(i) * k);
      }
    }
    g.translate(x, h / 2 - 0.6, z);
    return paint(g.toNonIndexed(), color);
  });
  const geo = mergeGeometries(parts);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = 'hills';
  return mesh;
}

// ── 요트: 다리 안쪽 바다에 떠서 천천히 흔들린다
function makeYachts() {
  const spots = [[-60, 95], [30, 120], [85, 80], [-120, 140], [60, 170], [-20, 185], [110, 140]];
  const hullGeo = new THREE.BoxGeometry(2.6, 0.5, 0.9);
  const sailGeo = new THREE.BufferGeometry();
  sailGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.3, 0, 0, 4.2, 0, 1.3, 0.3, 0, 0, 0.3, 0, 1.3, 0.3, 0, 0, 4.2, 0], 3));
  sailGeo.computeVertexNormals();
  const hull = new THREE.InstancedMesh(hullGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), spots.length);
  const sail = new THREE.InstancedMesh(sailGeo, new THREE.MeshLambertMaterial({ color: 0xfbfbf6, side: THREE.DoubleSide }), spots.length);
  hull.name = 'yacht-hulls'; sail.name = 'yacht-sails';
  const m = new THREE.Object3D();
  const update = t => {
    spots.forEach(([x, z], i) => {
      m.position.set(x + Math.sin(t * 0.05 + i) * 3, 0.1 + Math.sin(t * 1.3 + i * 2) * 0.12, z);
      m.rotation.set(Math.sin(t * 1.1 + i) * 0.06, i * 0.9, Math.sin(t * 0.9 + i * 3) * 0.05);
      m.updateMatrix();
      hull.setMatrixAt(i, m.matrix); sail.setMatrixAt(i, m.matrix);
    });
    hull.instanceMatrix.needsUpdate = true; sail.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { meshes: [hull, sail], update };
}
