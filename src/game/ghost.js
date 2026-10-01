// 반투명 캐릭터를 깨끗하게 그리기 (Claude 담당)
// 문제: 재질을 그냥 반투명(depthWrite=false)으로 바꾸면 캐릭터 자신의 뒷면(뒤통수 머리카락, 몸 안쪽, 반대쪽 팔)이
//       앞면 위에 겹쳐 그려져 얼굴에 머리카락 뒷면이 비치는 등 깨져 보인다. (2026-09-27 선생님 캡처)
// 해결: 두 번 그린다. ① 깊이만 기록하는 복제(색은 안 씀) → ② 반투명 색. ②는 가장 앞면만 통과하므로 깨끗한 유리 실루엣이 된다.
//       두 번 모두 "투명 그리기 순서"에서 그려서, 불투명한 코트·선수 뒤에 구멍이 나지 않는다.
//
// 사용:
//   import { setGhost, occludes } from './ghost.js';
//   setGhost(person.root, 0.45);   // 반투명(깔끔하게)
//   setGhost(person.root, 1);      // 원래대로(재질의 원래 transparent·depthWrite·renderOrder로 되돌림)
//   occludes(camera, person.root, [ballWorldPos, ringWorldPos]) → 선수가 그 점들 중 하나를 화면에서 가리면 true

import * as THREE from 'three';

const GHOST_ORDER = 20;   // 다른 투명한 것(링·궤적) 다음에 그린다

export function setGhost(root, opacity) {
  const ghost = opacity < 0.999;
  if (root.userData.ghostOpacity === opacity) return;
  root.userData.ghostOpacity = opacity;
  const meshes = [];
  root.traverse(obj => { if ((obj.isMesh || obj.isSkinnedMesh) && !obj.userData.ghostDepth && obj.material) meshes.push(obj); });
  for (const obj of meshes) {
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    // 처음 한 번 원래 값을 기억한다
    if (!obj.userData.ghostOrig) {
      obj.userData.ghostOrig = {
        renderOrder: obj.renderOrder,
        mats: mats.map(m => ({ transparent: m.transparent, depthWrite: m.depthWrite, opacity: m.opacity })),
      };
    }
    const orig = obj.userData.ghostOrig;
    let depth = obj.userData.ghostPass;
    if (ghost && !depth) {
      const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, opacity: 0 });
      depth = obj.isSkinnedMesh ? new THREE.SkinnedMesh(obj.geometry, mat) : new THREE.Mesh(obj.geometry, mat);
      if (obj.isSkinnedMesh) depth.bind(obj.skeleton, obj.bindMatrix);
      depth.userData.ghostDepth = true;
      depth.frustumCulled = false;
      depth.castShadow = false; depth.receiveShadow = false;
      depth.renderOrder = GHOST_ORDER;
      obj.add(depth);                 // 자식이라 같은 위치·크기(스키닝도 같은 뼈대)
      obj.userData.ghostPass = depth;
    }
    if (depth) depth.visible = ghost;
    obj.renderOrder = ghost ? GHOST_ORDER + 1 : orig.renderOrder;
    mats.forEach((m, i) => {
      const o = orig.mats[i];
      m.transparent = ghost ? true : o.transparent;
      m.depthWrite = ghost ? false : o.depthWrite;
      m.opacity = ghost ? o.opacity * opacity : o.opacity;
      m.needsUpdate = true;
    });
  }
}

// 선수(root)가 화면에서 points(세계 좌표) 중 하나를 가리는가: 선수 상자를 화면에 투영해 그 안에 점이 있고, 선수가 더 가까우면 true
const box = new THREE.Box3(), corner = new THREE.Vector3(), tmp = new THREE.Vector3();
export function occludes(camera, root, points, margin = 0.04) {
  box.setFromObject(root);
  if (box.isEmpty()) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, near = Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    near = Math.min(near, corner.distanceTo(camera.position));
    corner.project(camera);
    minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
  }
  return points.some(p => {
    if (!p) return false;
    const dist = tmp.copy(p).distanceTo(camera.position);
    if (dist < near) return false;                  // 점이 선수보다 앞에 있으면 가리지 않는다
    tmp.copy(p).project(camera);
    return tmp.x > minX - margin && tmp.x < maxX + margin && tmp.y > minY - margin && tmp.y < maxY + margin;
  });
}
