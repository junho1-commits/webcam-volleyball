// 배구공 모양 (Claude 담당). 18조각 가죽(6면 × 3줄) + 홈 선 + 가죽 광택.
// 사용: const ball = createVolleyball(THREE); scene.add(ball);
// 실제 공은 지름 21cm인데, 교실 TV에서 잘 보이도록 기본 반지름 0.14m(지름 28cm)로 만든다.

export const BALL_RADIUS = 0.14;

// 6면마다 3줄의 색. 이웃한 면의 줄 방향이 서로 엇갈려 실제 공처럼 띠가 이어져 보인다.
const PALETTE = {
  yellow: [255, 204, 36],
  blue: [22, 86, 196],
  white: [248, 246, 238],
};
const FACE_STRIPS = [
  ['yellow', 'blue', 'white'],   // +X
  ['white', 'blue', 'yellow'],   // -X
  ['blue', 'white', 'yellow'],   // +Y
  ['yellow', 'white', 'blue'],   // -Y
  ['white', 'yellow', 'blue'],   // +Z
  ['blue', 'yellow', 'white'],   // -Z
];

let cachedMaps = null;

function buildMaps(THREE, size = 1024) {
  if (cachedMaps) return cachedMaps;
  const W = size, H = size / 2;
  const color = document.createElement('canvas'); color.width = W; color.height = H;
  const bump = document.createElement('canvas'); bump.width = W; bump.height = H;
  const cctx = color.getContext('2d'), bctx = bump.getContext('2d');
  const cimg = cctx.createImageData(W, H), bimg = bctx.createImageData(W, H);
  const seam = 0.022;       // 홈 선 굵기(면 좌표 기준)
  const soft = 0.018;       // 홈 가장자리 부드럽게

  for (let py = 0; py < H; py++) {
    const theta = (py + 0.5) / H * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let px = 0; px < W; px++) {
      const phi = (px + 0.5) / W * Math.PI * 2;
      // THREE.SphereGeometry와 같은 UV → 방향 변환
      const x = -Math.cos(phi) * st, y = ct, z = Math.sin(phi) * st;
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      let face, a, edge;
      if (ax >= ay && ax >= az) { face = x > 0 ? 0 : 1; a = z / ax; edge = Math.max(ay, az) / ax; }
      else if (ay >= az) { face = y > 0 ? 2 : 3; a = x / ay; edge = Math.max(ax, az) / ay; }
      else { face = z > 0 ? 4 : 5; a = y / az; edge = Math.max(ax, ay) / az; }
      // 면 안의 3줄: a ∈ [-1, 1]을 셋으로 나눈다.
      const strip = Math.min(2, Math.floor((a + 1) / 2 * 3));
      const [r, g, b] = PALETTE[FACE_STRIPS[face][strip]];
      // 줄 경계(±1/3)와 면 경계(edge≈1)까지의 거리
      const dStrip = Math.min(Math.abs(a - 1 / 3), Math.abs(a + 1 / 3));
      const dFace = 1 - edge;
      const d = Math.min(dStrip, dFace * 1.4);
      const groove = d < seam ? 1 : d < seam + soft ? 1 - (d - seam) / soft : 0;
      // 조각 가운데는 살짝 부풀고 가장자리는 들어간다(가죽 패널 느낌).
      const pillow = Math.min(1, d / 0.18);
      const shade = 0.86 + 0.14 * pillow;
      const k = (1 - groove * 0.62) * shade;
      const i = (py * W + px) * 4;
      cimg.data[i] = r * k; cimg.data[i + 1] = g * k; cimg.data[i + 2] = b * k; cimg.data[i + 3] = 255;
      const h = 255 * (0.35 + 0.65 * pillow) * (1 - groove);
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = h; bimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  bctx.putImageData(bimg, 0, 0);

  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bumpMap = new THREE.CanvasTexture(bump);
  cachedMaps = { map, bumpMap };
  return cachedMaps;
}

export function createVolleyball(THREE, { radius = BALL_RADIUS } = {}) {
  const { map, bumpMap } = buildMaps(THREE);
  const material = new THREE.MeshStandardMaterial({
    map, bumpMap, bumpScale: 2.2, roughness: 0.42, metalness: 0,
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
  ball.name = 'Volleyball';
  ball.castShadow = true;
  ball.userData.radius = radius;
  return ball;
}
