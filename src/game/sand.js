// 모래 경기장 바닥 (Claude 담당): 평평한 판 대신 알갱이 질감·물결 무늬·울퉁불퉁한 높낮이·발자국이 있는 모래.
// 사용:
//   const sand = createSand({ width: 22, length: 27, z: 1.5, quality });   scene.add(sand.mesh);   // 지금의 sand 판 대신
//   sand.addMark(worldX, worldZ, 'dive' | 'land' | 'step');   // 다이빙·슬라이딩 디그·점프 착지·발자국 자리에 자국
//   sand.update(dt);                                          // 자국이 천천히 옅어진다(없어도 됨)
//   sandGrainTexture()                                        // 다른 모래(해변)에 같은 알갱이 질감을 쓸 때
// 코트 안(가로 ±4.3, 세로 ±8.3)은 높낮이를 ±1.5cm만 둔다. 선수 발은 y=0에 붙어 있어서 크게 하면 발이 묻히거나 뜬다.

import * as THREE from 'three';

const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

// 값 잡음(부드러운 격자 잡음)
function makeNoise(seed) {
  const rand = rng(seed), N = 256, perm = new Uint8Array(N * 2), val = new Float32Array(N);
  for (let i = 0; i < N; i++) { perm[i] = i; val[i] = rand(); }
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const s = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const h = (a, b) => val[perm[(perm[a & 255] + b) & 255]];
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    const u = s(xf), v = s(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

let grainTex = null, normalTex = null;
// 모래 알갱이(회색 밝기 무늬, 곱해 쓰는 용도)와 물결·알갱이 노멀맵. 512 타일, 반복해서 쓴다
function buildTextures() {
  const S = 512, noise = makeNoise(11), rand = rng(5);
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // 타일이 이어지도록 주기 잡음: 네 모서리를 섞는다
    const tile = (fx, fy, sc) => {
      const u = x / S, v = y / S;
      const n = (a, b) => noise(a * sc, b * sc);
      return n(u, v) * (1 - u) * (1 - v) + n(u - 1, v) * u * (1 - v) + n(u, v - 1) * (1 - u) * v + n(u - 1, v - 1) * u * v;
    };
    const ripple = Math.sin((y / S) * Math.PI * 2 * 9 + tile(0, 0, 3) * 5) * .35;   // 바람이 만든 잔물결
    height[y * S + x] = ripple * .6 + tile(0, 0, 8) * .8 + tile(0, 0, 32) * .35 + (rand() - .5) * .35;
  }
  const grain = document.createElement('canvas'); grain.width = grain.height = S;
  const g = grain.getContext('2d'), img = g.createImageData(S, S);
  const norm = document.createElement('canvas'); norm.width = norm.height = S;
  const ng = norm.getContext('2d'), nimg = ng.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, h = height[i];
    // 밝기: 0.82~1.05 사이, 가끔 밝은 조개껍질 조각·어두운 알갱이
    let l = .92 + (h - .5) * .2 + (rand() - .5) * .1;
    const r = rand();
    if (r < .004) l = 1.12; else if (r < .01) l = .72;
    const v = Math.max(0, Math.min(255, l * 225));
    img.data.set([v, v, v, 255], i * 4);
    const hx = height[y * S + (x + 1) % S] - height[y * S + (x - 1 + S) % S];
    const hy = height[((y + 1) % S) * S + x] - height[((y - 1 + S) % S) * S + x];
    const nx = -hx * 2.2, ny = -hy * 2.2, nz = 1, len = Math.hypot(nx, ny, nz);
    nimg.data.set([(nx / len * .5 + .5) * 255, (ny / len * .5 + .5) * 255, (nz / len * .5 + .5) * 255, 255], i * 4);
  }
  g.putImageData(img, 0, 0); ng.putImageData(nimg, 0, 0);
  grainTex = new THREE.CanvasTexture(grain);
  grainTex.colorSpace = THREE.SRGBColorSpace;
  normalTex = new THREE.CanvasTexture(norm);
  for (const t of [grainTex, normalTex]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
}

export function sandGrainTexture() { if (!grainTex) buildTextures(); return grainTex; }

export function createSand({ width = 22, length = 27, z = 1.5, quality = 'high', color = 0xeacb86 } = {}) {
  if (!grainTex) buildTextures();
  const seg = quality === 'low' ? 60 : quality === 'medium' ? 110 : 160;
  const geo = new THREE.PlaneGeometry(width, length, seg, Math.round(seg * length / width));
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, z);
  // 높낮이: 코트 안은 아주 살짝, 밖으로 갈수록 모래 둔덕
  const noise = makeNoise(3), pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), zz = pos.getZ(i);
    const out = Math.max(0, Math.max(Math.abs(x) - 4.6, Math.abs(zz) - 8.6));      // 코트 경계 밖으로 얼마나
    const w = Math.min(1, out / 2.5);
    const small = (noise(x * 1.3, zz * 1.3) - .5) * .03;                            // 코트 안 ±1.5cm
    const dune = (noise(x * .35 + 7, zz * .35 + 3) - .5) * .5 + (noise(x * 1.1, zz * 1.1) - .5) * .12;
    const edge = Math.min(1, Math.min(width / 2 - Math.abs(x), length / 2 - Math.abs(zz - z)) / 1.5);   // 판 가장자리 1.5m는 평평하게(해변 모래와 이어지게)
    pos.setY(i, small + w * edge * Math.max(-.04, dune));
  }
  geo.computeVertexNormals();
  // 발자국·패인 자국 캔버스(코트 전체를 덮음). 흰색 = 자국 없음, 어두울수록 파임
  const MW = 512, MH = Math.round(512 * length / width);
  const marks = document.createElement('canvas'); marks.width = MW; marks.height = MH;
  const mg = marks.getContext('2d'); mg.fillStyle = '#fff'; mg.fillRect(0, 0, MW, MH);
  const marksTex = new THREE.CanvasTexture(marks);
  marksTex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({
    color, map: grainTex, normalMap: normalTex, normalScale: new THREE.Vector2(1.6, 1.6), roughness: .96, metalness: 0,
  });
  // 알갱이 질감은 1m마다 반복, 자국은 판 전체에 한 번(uv2 대신 셰이더에서 원래 uv로 읽는다)
  grainTex.repeat.set(width / 1.2, length / 1.2); normalTex.repeat.copy(grainTex.repeat);
  mat.onBeforeCompile = shader => {
    shader.uniforms.marksMap = { value: marksTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPlaneUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPlaneUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D marksMap;\nvarying vec2 vPlaneUv;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= mix(0.62, 1.0, texture2D(marksMap, vPlaneUv).r);');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sand';
  mesh.receiveShadow = true;
  let fadeClock = 0;

  // 판을 눕히면 uv의 v=1(캔버스 위쪽)이 z가 작은 쪽(우리 코트 뒤)이 된다
  const toCanvas = (wx, wz) => [(wx + width / 2) / width * MW, (wz - (z - length / 2)) / length * MH];
  return {
    mesh,
    addMark(wx, wz, kind = 'step') {
      const [cx, cy] = toCanvas(wx, wz), px = MW / width;   // 1m당 픽셀
      mg.save();
      if (kind === 'dive') {                                // 슬라이딩·다이빙: 길게 쓸린 자국
        mg.translate(cx, cy); mg.rotate(Math.random() * Math.PI);
        const grad = mg.createRadialGradient(0, 0, 0, 0, 0, px * 1.1);
        grad.addColorStop(0, 'rgba(80,60,30,.8)'); grad.addColorStop(1, 'rgba(90,70,40,0)');
        mg.scale(1.8, .6); mg.fillStyle = grad; mg.beginPath(); mg.arc(0, 0, px * 1.1, 0, Math.PI * 2); mg.fill();
      } else {
        const r = kind === 'land' ? px * .45 : px * .16;    // 착지: 두 발 둥근 자국, 걸음: 작은 발자국
        const grad = mg.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, kind === 'land' ? 'rgba(80,60,30,.65)' : 'rgba(80,60,30,.45)'); grad.addColorStop(1, 'rgba(90,70,40,0)');
        mg.fillStyle = grad; mg.beginPath(); mg.arc(cx, cy, r, 0, Math.PI * 2); mg.fill();
      }
      mg.restore();
      marksTex.needsUpdate = true;
    },
    update(dt = 1 / 60) {
      // 3초마다 아주 조금씩 흰색을 덮어 자국이 서서히 사라진다(약 1분)
      fadeClock += dt;
      if (fadeClock > 3) { fadeClock = 0; mg.fillStyle = 'rgba(255,255,255,.06)'; mg.fillRect(0, 0, MW, MH); marksTex.needsUpdate = true; }
    },
    clearMarks() { mg.fillStyle = '#fff'; mg.fillRect(0, 0, MW, MH); marksTex.needsUpdate = true; },
  };
}
