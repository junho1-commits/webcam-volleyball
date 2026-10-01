// 부산 광고판 (Claude 담당): 코트 둘레 LED 광고판에 부산을 대표하는 명소·음식을 띄운다(2026-09-27 선생님).
// 디자인: GPT 완성 시안 art/concept/revised/busan-board-backgrounds-v1.png, 규격 docs/광고판_디자인_v1.md (2026-09-28)
//   → 테두리 없이 칸만 잘라 다시 묶은 assets/ui/busan-boards.webp (2048×724, 2열 × 4행, 한 칸 1024×181)
//   시안의 한 칸은 실제로 약 965×171(5.66:1)이라 광고판도 이 비율(4.0m × 0.71m)로 만든다(그림을 늘리지 않으려고).
//   0 광안대교 1 해운대 2 부산타워 3 오륙도 4 감천문화마을 5 자갈치시장 6 부산 어묵 7 돼지국밥
// 글자는 캔버스로 또렷하게 오른쪽 여백에 그린다(그림 생성 모델은 한글이 깨진다).
// 사용: const boards = createBusanBoards({ quality });  group.add(boards.group);  boards.update(t);
//       crowd.js가 관중석과 함께 만들고 갱신하므로 렌더러는 할 일이 없다.
// 좌표: 렌더러 세계 좌표. 관중석은 x = ±6.0 ~ ±8.4, 상대 코트 뒤 관객은 z ≈ 11 ~ 12.6.

import * as THREE from 'three';

const ATLAS_URL = new URL('../../assets/ui/busan-boards.webp', import.meta.url).href;
export const BUSAN_ADS = [
  { title: '광안대교', sub: '반짝이는 부산의 밤바다' },
  { title: '해운대', sub: '모래사장과 파도가 가득' },
  { title: '부산타워', sub: '부산이 한눈에' },
  { title: '오륙도', sub: '바다 위 다섯 여섯 섬' },
  { title: '감천문화마을', sub: '알록달록 골목 여행' },
  { title: '자갈치시장', sub: '싱싱한 바다 이야기' },
  { title: '부산 어묵', sub: '따끈하고 쫄깃한 한입' },
  { title: '돼지국밥', sub: '든든한 부산 한 그릇' },
];
const PANEL = { w: 1024, h: 181, cols: 2 };      // 광고 한 칸 (그림판 칸과 같음)
const TEXT_X = 0.5;                              // 글자는 칸 가로 50% 지점부터(왼쪽은 그림)
const SWITCH_SECONDS = 6;                        // 광고판마다 이만큼마다 다음 광고로 넘어간다(판마다 시작을 엇갈림)
// 판마다 시작 번호(order). 아래 update 식으로 10분을 돌려 보고 고른 값(2026-09-28):
//   같은 줄 옆 판끼리 같은 광고 0, 코트 양옆 마주 보는 판끼리 0,
//   기본 카메라에 함께 보이는 11장(광고는 8종) 중 같은 광고 평균 3.1장(최소 3). 예전 배치(14장)는 7.6장.
const SIDE_ORDER = [[2, 30, 33, 20], [18, 27, 7, 22]];
const BACK_ORDER = [11, 3, 35];
const FAR_ORDER = [25, 15, 13, 4];

let atlasImage = null;

function drawPanels(canvas, atlas) {
  const g = canvas.getContext('2d');
  BUSAN_ADS.forEach((ad, i) => {
    const x = (i % PANEL.cols) * PANEL.w, y = Math.floor(i / PANEL.cols) * PANEL.h, w = PANEL.w, h = PANEL.h;
    if (atlas) g.drawImage(atlas, x, y, w, h, x, y, w, h);
    else { g.fillStyle = '#14213d'; g.fillRect(x, y, w, h); }
    // 문구: 위 작은 "BUSAN · 부산"(노랑), 가운데 큰 제목(흰색·그림자), 아래 한 줄 설명(흰색 90%)
    // 규격(칸 높이 256 기준 30/88/38px)을 이 칸 높이 181에 맞춰 줄였다.
    const k = h / 256;
    const tx = x + w * TEXT_X, tw = w * (0.96 - TEXT_X);
    const font = size => `900 ${size}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
    const fit = (text, size, max) => { g.font = font(size); const m = g.measureText(text).width; return m > max ? size * max / m : size; };
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.save();
    g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 8 * k; g.shadowOffsetY = 3 * k;
    g.fillStyle = '#ffd54f'; g.font = font(Math.round(30 * k)); g.fillText('BUSAN · 부산', tx, y + 44 * k);
    g.fillStyle = '#fff'; g.font = font(fit(ad.title, Math.round(88 * k), tw));
    g.lineWidth = 9 * k; g.strokeStyle = 'rgba(0,0,0,.35)'; g.strokeText(ad.title, tx, y + 126 * k); g.fillText(ad.title, tx, y + 126 * k);
    g.fillStyle = 'rgba(255,255,255,.9)'; g.font = font(fit(ad.sub, Math.round(38 * k), tw)); g.fillText(ad.sub, tx, y + 206 * k);
    g.restore();
  });
}

export function createBusanBoards({ quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'busan-boards';
  const canvas = document.createElement('canvas');
  canvas.width = PANEL.w * PANEL.cols; canvas.height = PANEL.h * Math.ceil(BUSAN_ADS.length / PANEL.cols);
  drawPanels(canvas, null);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = quality === 'low' ? 2 : 8;
  const boards = [];
  // 그림을 다 불러오면 다시 그리고, 판마다 복제한 텍스처도 새로 올린다
  const redraw = img => { drawPanels(canvas, img); texture.needsUpdate = true; for (const b of boards) b.faceTex.needsUpdate = true; };

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x14213d, roughness: .6 });
  const W = 4.0, H = W * PANEL.h / PANEL.w, D = 0.12;   // 그림 칸과 같은 비율(약 5.66:1)
  // 판 하나: 짙은 틀 + 앞면(광고). 앞면 uv를 광고 칸으로 옮겨 바꾼다
  const addBoard = (x, z, rotY, order) => {
    const holder = new THREE.Group();
    holder.position.set(x, 0, z); holder.rotation.y = rotY;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(W + .1, H + .1, D), frameMat);
    frame.position.y = H / 2 + .05; frame.castShadow = quality !== 'low'; frame.receiveShadow = true;
    const faceTex = texture.clone(); faceTex.needsUpdate = true;
    faceTex.repeat.set(1 / PANEL.cols, 1 / Math.ceil(BUSAN_ADS.length / PANEL.cols));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: faceTex, toneMapped: false }));
    face.position.set(0, H / 2 + .05, D / 2 + .005);
    holder.add(frame, face);
    group.add(holder);
    boards.push({ faceTex, order, shown: -1 });
  };
  // 양옆(관중석 앞, 코트 쪽을 봄): z -8 ~ 8에 4장씩. 오른쪽(x<0)은 +x를, 왼쪽(x>0)은 -x를 본다
  for (const side of [1, -1]) {
    for (let k = 0; k < 4; k++) addBoard(side * 5.7, -6 + k * W, side > 0 ? -Math.PI / 2 : Math.PI / 2, SIDE_ORDER[side > 0 ? 0 : 1][k]);
  }
  // 상대 코트 뒤(기본 카메라 정면): 3장, 우리 쪽(-z)을 본다
  for (let k = 0; k < 3; k++) addBoard(-4 + k * W, 10.4, Math.PI, BACK_ORDER[k]);
  // 우리 코트 먼 뒤: VS 나눈 화면에서 2P 카메라(+z 쪽)가 볼 때 코트 끝이 비어 보이지 않게. 4장, +z를 본다.
  // 1P 쪽 카메라는 모두 z > -18.5(서브 -14.5, VS 고정 -18)라 앞을 가리지 않는다.
  for (let k = 0; k < 4; k++) addBoard(-6 + k * W, -19.5, 0, FAR_ORDER[k]);

  if (atlasImage) redraw(atlasImage);
  else { const img = new Image(); img.onload = () => { atlasImage = img; redraw(img); }; img.src = ATLAS_URL; }

  const rows = Math.ceil(BUSAN_ADS.length / PANEL.cols);
  return {
    group,
    // 판마다 SWITCH_SECONDS마다 다음 광고로(서로 엇갈려서 한꺼번에 바뀌지 않게)
    update(t) {
      for (const b of boards) {
        const i = (Math.floor(t / SWITCH_SECONDS + b.order * 0.37) + b.order) % BUSAN_ADS.length;
        if (i === b.shown) continue;
        b.shown = i;
        // 캔버스 텍스처는 flipY라 v=1이 캔버스 맨 위
        b.faceTex.offset.set((i % PANEL.cols) / PANEL.cols, 1 - (Math.floor(i / PANEL.cols) + 1) / rows);
      }
    },
    dispose() {
      group.removeFromParent();
      group.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
      texture.dispose();
    },
  };
}
