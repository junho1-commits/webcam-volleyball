// Three.js 뒤쪽 시점 비치볼리볼. 경기 로직의 x/y/z를 그대로 사용한다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ANIM_SECONDS, COURT } from './rules.js';
import { CONTACT_K, RigPoser } from './rig-poser.js';
import { createVolleyball } from './volleyball-mesh.js';
import { installGwangalli } from './gwangalli-scene.js';
import { CameraDirector } from './camera-director.js';
import { setGhost, occludes } from './ghost.js';
import { Crowd } from './crowd.js';
import { setRenderRegion, updateCrowd } from './render-state.js';
import { createSand } from './sand.js';
import {
  FALLBACK_HEAD_HEIGHT, PLAYER_LABEL_HEAD_GAP, PLAYER_PROMPT_HEAD_GAP,
  guideLayerForActor, modelReadiness, shouldSplitVersusView, versusCameraFollowRate, versusCameraPlan,
} from './versus-view.js';
import { CHARACTER_PROFILES, characterEffects, characterOrder } from './character-profiles.js';

// 콘셉트 그림으로 만든 고품질 모델(Meshy). 있으면 이것을 쓰고, 없으면 도형 GLB를 쓴다.
const HQ_MODELS = {
  ara: 'assets/characters/ara-hq.glb',
  min: 'assets/characters/min-hq.glb',
  sori: 'assets/characters/sori-hq.glb',
  jun: 'assets/characters/jun-hq.glb',
};
const ALL_CHARACTER_NAMES = ['ara', 'min', 'sori', 'jun', 'hana'];
const HIDDEN_CHARACTERS = new Set(['hana']);
const CHARACTER_NAMES = ALL_CHARACTER_NAMES.filter(name => !HIDDEN_CHARACTERS.has(name));
const CLOSE_CAMERA_SHOTS = new Set(['director-punch', 'director-chase', 'director-netLow', 'director-receive', 'director-approach', 'director-serveLow', 'director-serveFollow']);

const ANIM = ANIM_SECONDS;
const SKINS = [0xf2bd8c, 0x9a6045, 0xe2a574, 0x6f432f];
const TEAMS = {
  me: [{ top: 0x29b6f6, bottom: 0x0d47a1 }, { top: 0x62d9cf, bottom: 0x147c8c }],
  ai: [{ top: 0xef5350, bottom: 0x8e1820 }, { top: 0xff8a65, bottom: 0xad2831 }],
};
const mat = color => new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
const limbGeo = new THREE.CapsuleGeometry(0.075, 0.42, 4, 8);
const jointGeo = new THREE.SphereGeometry(0.09, 10, 8);

function mesh(geo, material, parent, y = 0) {
  const m = new THREE.Mesh(geo, material); m.position.y = y; m.castShadow = true; parent.add(m); return m;
}

function makeTextSprite(text, color = '#fff', background = 'rgba(7,15,32,.78)', size = 48) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = `900 ${size}px "Malgun Gothic", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const width = Math.min(490, Math.max(150, ctx.measureText(text).width + 64));
  ctx.fillStyle = background; ctx.beginPath(); ctx.roundRect((512 - width) / 2, 12, width, 104, 34); ctx.fill();
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(text, 256, 64);
  ctx.fillStyle = color; ctx.fillText(text, 256, 64);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(3.2, 0.8, 1); sprite.userData.text = text; return sprite;
}

function attachBackNumber(model, wrapper, number) {
  const spine = model.getObjectByName('Spine02');
  if (!spine) return false;
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const spineWorld = spine.getWorldPosition(new THREE.Vector3());
  let layout;
  if (!layout) {
    // 판 높이는 머리카락/바운딩 박스가 아니라 몸통 뼈를 기준으로 통일한다.
    const y = spineWorld.y;
    const raycaster = new THREE.Raycaster();
    const hits = [];
    // 이 높이에서 뒤(-Z)에서 몸 쪽(+Z)으로 여러 번 쏴 실제 몸통 윤곽을 찾는다.
    for (let i = 0; i <= 16; i++) {
      const x = box.min.x + size.x * (.2 + i / 16 * .6);
      raycaster.set(new THREE.Vector3(x, y, box.min.z - .5), new THREE.Vector3(0, 0, 1));
      raycaster.far = size.z + 1;
      const first = raycaster.intersectObject(model, true).find(hit => hit.object.isMesh);
      if (first) hits.push(first.point.clone());
    }
    if (hits.length >= 3) {
      const minX = Math.min(...hits.map(p => p.x)), maxX = Math.max(...hits.map(p => p.x));
      const torsoWidth = maxX - minX;
      // 중심과 좌우 15% 지점의 첫 표면 중 +Z가 가장 큰 것 = 머리카락보다 몸에 가까운 등 표면.
      const midX = (minX + maxX) / 2;
      const central = hits.filter(p => Math.abs(p.x - midX) <= Math.max(.02, torsoWidth * .2));
      let surfaceZ = Math.max(...(central.length ? central : hits).map(p => p.z));
      const surfaceDepth = spineWorld.z - surfaceZ;
      // 포니테일처럼 몸통보다 훨씬 뒤에 있는 표면은 버리고 실제 등 깊이를 사용한다.
      // 판을 표면에서 1cm 바깥에 두므로 표면 깊이는 7~15cm만 허용한다.
      if (surfaceDepth < .07 || surfaceDepth > .15) surfaceZ = spineWorld.z - .11;
      const width = THREE.MathUtils.clamp(torsoWidth * .6, .24, .42);
      layout = { x: midX, y, z: surfaceZ - .01, width, height: width * 1.22 };
    } else {
      layout = { x: center.x, y, z: box.min.z - .01, width: .32, height: .39 };
      console.warn('등 표면 레이캐스트가 실패해 경계 상자를 사용합니다.', number);
    }
  }
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 320;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#103b79'; ctx.beginPath(); ctx.roundRect(20, 18, 216, 284, 42); ctx.fill();
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
  ctx.font = '900 220px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 18; ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.strokeText(String(number), 128, 166);
  ctx.fillStyle = '#fff'; ctx.fillText(String(number), 128, 166);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(layout.width, layout.height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: .04, side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: -4 })
  );
  plate.name = 'CleanBackNumber';
  wrapper.add(plate);
  plate.position.copy(wrapper.worldToLocal(new THREE.Vector3(layout.x, layout.y, layout.z)));
  plate.rotation.y = Math.PI;
  plate.userData.backSurfaceZ = layout.z + .01;
  wrapper.updateMatrixWorld(true);
  spine.attach(plate); // 월드 위치를 유지한 채 등뼈에 붙여 자세를 따라가게 한다.
  return true;
}

function arm(parent, skin, side) {
  const shoulder = new THREE.Group(); shoulder.position.set(side * 0.25, 1.55, 0); parent.add(shoulder);
  mesh(jointGeo, skin, shoulder); mesh(limbGeo, skin, shoulder, -0.28);
  const elbow = new THREE.Group(); elbow.position.y = -0.56; shoulder.add(elbow);
  mesh(jointGeo, skin, elbow); mesh(limbGeo, skin, elbow, -0.28); mesh(new THREE.SphereGeometry(0.11, 10, 8), skin, elbow, -0.57);
  return { shoulder, elbow };
}

function leg(parent, skin, shorts, side) {
  const hip = new THREE.Group(); hip.position.set(side * 0.13, 0.83, 0); parent.add(hip);
  mesh(new THREE.CapsuleGeometry(0.1, 0.42, 4, 8), shorts, hip, -0.28);
  const knee = new THREE.Group(); knee.position.y = -0.58; hip.add(knee);
  mesh(jointGeo, skin, knee); mesh(new THREE.CapsuleGeometry(0.085, 0.43, 4, 8), skin, knee, -0.29);
  const foot = mesh(new THREE.BoxGeometry(0.18, 0.1, 0.34), skin, knee, -0.58); foot.position.z = 0.09;
  return { hip, knee };
}

class Athlete {
  constructor(scene, colors, skinColor, label, number) {
    this.root = new THREE.Group(); scene.add(this.root);
    const skin = mat(skinColor), shirt = mat(colors.top), shorts = mat(colors.bottom);
    mesh(new THREE.CapsuleGeometry(0.24, 0.48, 5, 10), shirt, this.root, 1.28);
    mesh(new THREE.BoxGeometry(0.42, 0.27, 0.28), shorts, this.root, 0.87);
    mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 8), skin, this.root, 1.7);
    mesh(new THREE.SphereGeometry(0.2, 14, 10), skin, this.root, 1.91);
    const hair = mesh(new THREE.SphereGeometry(0.207, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.64), mat(0x38251d), this.root, 1.98); hair.position.z = -0.025;
    const back = makeTextSprite(String(number), '#fff', 'rgba(0,0,0,0)', 70); back.position.set(0, 1.35, -0.255); back.scale.set(0.48, 0.34, 1); this.root.add(back);
    this.leftArm = arm(this.root, skin, -1); this.rightArm = arm(this.root, skin, 1);
    this.leftLeg = leg(this.root, skin, shorts, -1); this.rightLeg = leg(this.root, skin, shorts, 1);
    this.fallbackParts = [...this.root.children];
    this.tag = makeTextSprite(label, '#fff', 'rgba(0,0,0,.65)', 52); this.tag.position.y = 1.85; this.tag.scale.set(1.55, 0.48, 1); this.root.add(this.tag);
    this.speech = null; this.label = label; this.model = null; this.mixer = null; this.models = new Map();
    this.clips = new Map(); this.currentAction = null; this.lastAnimSignature = ''; this.lastMixerT = 0;
    this.handedness = 'right';
    this.characterName = 'fallback'; this.serveReachCache = new Map();
    this.effects = characterEffects('ara');
    this.opacity = 1; this.opacityTarget = 1; this.opacityFrom = 1; this.opacityStartedAt = 0;
    this.opacityRequest = 1; this.opacityRequestSince = 0;
    this.opacitySwitches = 0; this.opacityActivations = 0; this.yawOver20 = 0;
  }

  setOpacity(value) {
    if (Math.abs(this.opacity - value) < .0001) return;
    this.opacity = value;
    setGhost(this.root, value);
  }

  fadeOpacity(requested, now) {
    // 한 경기에서 반복적으로 반투명해지는 시각적 산만함은 두 번까지만 허용한다.
    if (requested < 1 && this.opacityActivations >= 2 && this.opacityTarget === 1) requested = 1;
    if (requested !== this.opacityRequest) {
      this.opacityRequest = requested; this.opacityRequestSince = now;
    }
    const hold = requested < 1 ? .12 : .30;
    if (requested !== this.opacityTarget && now - this.opacityRequestSince >= hold) {
      this.opacityFrom = this.opacity; this.opacityTarget = requested; this.opacityStartedAt = now;
      this.opacitySwitches++;
      if (requested < 1) this.opacityActivations++;
    }
    const target = this.opacityTarget;
    const k = THREE.MathUtils.clamp((now - this.opacityStartedAt) / .25, 0, 1);
    const smooth = k * k * (3 - 2 * k);
    const value = k >= 1 ? target : THREE.MathUtils.lerp(this.opacityFrom, target, smooth);
    this.setOpacity(value);
  }

  setLabel(text) {
    if (text === this.label) return;
    this.root.remove(this.tag); this.tag.material.map.dispose(); this.tag.material.dispose();
    this.tag = makeTextSprite(text, '#fff', 'rgba(0,0,0,.65)', 52); this.tag.position.y = 1.85; this.tag.scale.set(1.55, 0.48, 1); this.root.add(this.tag); this.label = text;
  }

  setPrompt(text, color) {
    if ((this.speech?.userData.text ?? '') === (text ?? '')) return;
    if (this.speech) { this.root.remove(this.speech); this.speech.material.map.dispose(); this.speech.material.dispose(); this.speech = null; }
    if (text) {
      this.speech = makeTextSprite(text, color, 'rgba(0,0,0,.82)', 50);
      this.speech.position.y = 2.30; this.root.add(this.speech);
      this.updateGuideHeights();
    }
  }

  updateGuideHeights() {
    // 이름표는 각 모델의 실제 머리를 따라간다. 머리 뼈가 없는 도형 캐릭터는 지시서 기준 높이를 쓴다.
    this.root.updateMatrixWorld(true);
    const headBone = this.model?.getObjectByName('head_end') ?? this.model?.getObjectByName('Head');
    const headWorld = headBone
      ? headBone.getWorldPosition(new THREE.Vector3())
      : this.root.localToWorld(new THREE.Vector3(0, FALLBACK_HEAD_HEIGHT, 0));
    const tagLocal = this.root.worldToLocal(headWorld.clone().add(new THREE.Vector3(0, PLAYER_LABEL_HEAD_GAP, 0)));
    this.tag.position.copy(tagLocal);
    if (this.speech) {
      const speechLocal = this.root.worldToLocal(headWorld.clone().add(new THREE.Vector3(0, PLAYER_PROMPT_HEAD_GAP, 0)));
      this.speech.position.copy(speechLocal);
    }
  }

  getHandWorldPosition(side = 'right') {
    if (side === this.handedness && this.poser?.hitHandBone()) {
      return this.poser.hitHandBone().getWorldPosition(new THREE.Vector3());
    }
    if (this.model) {
      const names = side === 'right'
        ? ['RightHand', 'mixamorigRightHand', 'right_hand', 'hand_r']
        : ['LeftHand', 'mixamorigLeftHand', 'left_hand', 'hand_l'];
      for (const name of names) {
        const hand = this.model.getObjectByName(name);
        if (hand) return hand.getWorldPosition(new THREE.Vector3());
      }
    }
    const arm = side === 'right' ? this.rightArm : this.leftArm;
    return arm.elbow.localToWorld(new THREE.Vector3(0, -.57, 0));
  }

  getTossHandWorldPosition() {
    const bone = this.poser?.tossHandBone?.();
    if (bone) return bone.getWorldPosition(new THREE.Vector3());
    return this.getHandWorldPosition(this.handedness === 'left' ? 'right' : 'left');
  }

  getContactHandWorldPosition(type) {
    if (!this.poser || !this.model) return this.getHandWorldPosition(this.handedness);
    const local = this.poser.contactHand(type);
    const world = this.model.localToWorld(local.clone());
    const jump = type === 'serveJump' ? this.effects.jumpHeight * Math.sin(Math.PI * CONTACT_K.serveJump) : 0;
    world.y += jump - this.root.position.y;
    return world;
  }

  measureServeReach() {
    const key = `${this.characterName}:${this.handedness}`;
    if (this.serveReachCache.has(key)) return this.serveReachCache.get(key);
    let reach = 2.25;
    if (this.poser) reach = this.poser.measureContactHand().y + .1;
    reach = THREE.MathUtils.clamp(reach, 1.8, 2.8);
    this.serveReachCache.set(key, reach);
    return reach;
  }

  setHandedness(hand) {
    this.handedness = hand === 'left' ? 'left' : 'right';
    for (const state of this.models.values()) state.poser?.setHandedness(this.handedness);
    this.poser?.setHandedness(this.handedness);
    if (this.characterName) this.measureContactGeometry();
  }

  installModel(name, gltf, hq = false) {
    // 뼈대가 있는 모델은 SkeletonUtils로 복제해야 사람마다 뼈대가 따로 생긴다
    let model = SkeletonUtils.clone(gltf.scene);
    model.traverse(obj => {
      if (!obj.isMesh) return;
      obj.castShadow = true; obj.receiveShadow = true; obj.frustumCulled = false;
      obj.material = obj.material.clone();
    });
    // 모델의 발바닥은 y=0으로 맞추되 키는 캐릭터 프로필을 따른다.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true), size = box.getSize(new THREE.Vector3());
    const s = (CHARACTER_PROFILES[name]?.height ?? 1.75) / size.y;
    model.scale.setScalar(s);
    model.position.set(-(box.min.x + size.x / 2) * s, -box.min.y * s, -(box.min.z + size.z / 2) * s);
    // 번호는 경기 중 선수 위치·회전의 영향을 받지 않는 모델 좌표에서 붙인다.
    const wrap = new THREE.Group(); wrap.add(model); wrap.updateMatrixWorld(true);
    let poser = null;
    if (hq) {
      attachBackNumber(model, wrap, { ara: 1, min: 2, sori: 3, jun: 4 }[name] ?? 1);
      if (RigPoser.canPose(model)) poser = new RigPoser(model);
    }
    poser?.setHandedness(this.handedness);
    // 첫 반투명 프레임에서 깊이 복제를 만들며 끊기지 않도록 로딩 중 미리 준비한다.
    setGhost(wrap, .998); setGhost(wrap, 1);
    this.root.remove(wrap);
    wrap.visible = false; this.root.add(wrap);
    this.models.set(name, { model: wrap, poser, mixer: new THREE.AnimationMixer(wrap), clips: new Map(gltf.animations.map(clip => [clip.name, clip])) });
  }

  setCharacter(name) {
    for (const state of this.models.values()) state.model.visible = false;
    const state = name === 'fallback' ? null : this.models.get(name);
    this.model = state?.model ?? null; this.mixer = state?.mixer ?? null; this.clips = state?.clips ?? new Map();
    this.poser = state?.poser ?? null;
    this.poser?.setHandedness(this.handedness);
    this.currentAction = null; this.lastAnimSignature = '';
    this.useModel = !!state;
    for (const part of this.fallbackParts) part.visible = !this.useModel;
    if (this.model) this.model.visible = this.useModel;
    this.characterName = name;
    this.effects = characterEffects(name);
    this.measureContactGeometry();
  }

  measureContactGeometry() {
    this.contactGeometry = {};
    if (this.poser) {
      for (const type of ['bump', 'dig', 'set', 'underSet', 'spike', 'tip', 'block']) {
        const point = this.poser.contactHand(type);
        this.contactGeometry[type] = { x: point.x, y: point.y, z: point.z };
      }
    }
  }

  updateModel(type, anim, t, mirrorPose, facing = 1) {
    if (!this.useModel) return;
    if (this.poser) {
      // 동작 클립이 없는 고품질 모델: 뼈대를 직접 배구 자세로
      let k = anim ? Math.min(1, Math.max(0, (t - anim.t0) / ANIM)) : 1;
      // 뼈대의 35ms 자세 보간 지연을 선행 보상한다. 손은 접촉 자세에서 대기한다.
      if (anim?.contact && anim.planned && t <= anim.contactUntil) k = Math.min(k + .08 / ANIM, CONTACT_K[type] ?? .5);
      // 자동 접근은 표준 접촉 자세를 기준으로 계산한다. 공격 방향은 공 궤적에 반영한다.
      const poseAim = anim?.contact ? 0 : facing > 0 ? (anim?.aim ?? 0) : -(anim?.aim ?? 0);
      this.poser.pose(type, k, t, { aim: poseAim, style: anim?.style, phase: anim?.phase,
        since: anim ? Math.max(0, t - anim.t0) : 0 });
      return;
    }
    if (!this.mixer) return;
    const signature = `${type}:${anim?.t0 ?? 0}`;
    if (signature !== this.lastAnimSignature) {
      const clip = this.clips.get(type) ?? this.clips.get('idle');
      if (clip) {
        const looping = ['idle', 'ready', 'move', 'run'].includes(type);
        const next = this.mixer.clipAction(clip);
        next.reset().setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, looping ? Infinity : 1);
        next.clampWhenFinished = !looping;
        const contact = { bump: .35, underSet: .45, set: .4, dig: .45, spike: .7, block: .45, serve: .75, dive: .3 }[type];
        if (contact != null) next.time = Math.min(contact, clip.duration * .8);
        if (this.currentAction && this.currentAction !== next) this.currentAction.fadeOut(.15);
        next.fadeIn(.15).play(); this.currentAction = next;
      }
      this.lastAnimSignature = signature;
    }
    const dt = this.lastMixerT ? Math.max(0, Math.min(.08, t - this.lastMixerT)) : 0;
    this.lastMixerT = t; this.mixer.update(dt);
    if (type === 'idle' && mirrorPose) this.applyMirror(mirrorPose);
  }

  applyMirror(lm) {
    const bone = name => this.model?.getObjectByName(name);
    if (!lm || !bone('mixamorigLeftArm')) return;
    const angle = (a, b) => Math.atan2(-(b.y - a.y), (1 - b.x) - (1 - a.x));
    const pairs = [
      ['mixamorigLeftArm', 11, 13], ['mixamorigRightArm', 12, 14],
      ['mixamorigLeftForeArm', 13, 15], ['mixamorigRightForeArm', 14, 16],
    ];
    for (const [name, a, b] of pairs) {
      const joint = bone(name), target = angle(lm[a], lm[b]);
      if (joint) joint.rotation.z += (target - joint.rotation.z) * .28;
    }
  }

  update(player, facing, t, mirrorPose = null) {
    // 카메라가 +z를 보면 월드 +x가 화면 왼쪽이다. 렌더러에서만 뒤집어 논리 +x=화면 오른쪽을 유지한다.
    this.root.position.x = -player.x; this.root.position.z = player.z;
    this.setLabel(player.label);
    const anim = player.anim;
    let k = anim ? Math.min(1, Math.max(0, (t - anim.t0) / ANIM)) : 1;
    if (anim?.contact && anim.planned && t <= anim.contactUntil) k = Math.min(k, CONTACT_K[anim.type] ?? .5);
    const persistent = anim && (anim.hold || (['celebrate', 'sad'].includes(anim.type) && t - anim.t0 < 5.9));
    let type = k < 1 || persistent ? anim.type : 'idle';
    const approaching = anim?.contact && t < anim.t0;
    if (approaching) type = player.running ? 'run' : 'ready';
    if (type === 'serve') type = anim?.jump ? 'serveJump' : 'serveFloat';
    const priority = !approaching && anim && (k < 1 || persistent) && (anim.contact || anim.planned || ['dive', 'dig', 'celebrate', 'sad'].includes(anim.type));
    if (!priority && player.running) type = 'run';
    else if (!priority && (player.atSetPosition || player.movePreparing)) type = 'ready';
    const defaultYaw = facing > 0 ? 0 : Math.PI;
    const activeFace = anim && (k < 1 || persistent || anim.planned) ? anim.face : null;
    const faceYaw = activeFace
      ? Math.atan2(-(activeFace.x - player.x), activeFace.z - player.z)
      : defaultYaw;
    const desiredYaw = type === 'run' && Number.isFinite(player.runYaw) ? player.runYaw : faceYaw;
    if (!Number.isFinite(this.visualYaw)) this.visualYaw = desiredYaw;
    const yawDt = this.lastYawT == null ? .2 : Math.max(0, Math.min(.2, t - this.lastYawT));
    const yawDelta = Math.atan2(Math.sin(desiredYaw - this.visualYaw), Math.cos(desiredYaw - this.visualYaw));
    const yawLimit = Math.min(9.4 * yawDt, THREE.MathUtils.degToRad(19.9));
    const yawStep = THREE.MathUtils.clamp(yawDelta * (1 - Math.exp(-yawDt / .16)), -yawLimit, yawLimit);
    if (Math.abs(yawStep) > THREE.MathUtils.degToRad(20)) this.yawOver20++;
    this.visualYaw += yawStep; this.lastYawT = t;
    this.root.rotation.y = this.visualYaw;
    const bodyJumpK = anim?.bodyJumpT0 == null ? k : Math.min(1, Math.max(0, (t - anim.bodyJumpT0) / ANIM));
    const bodyJumping = anim?.bodyJumpT0 != null && t - anim.bodyJumpT0 < ANIM;
    const pulse = Math.sin(Math.PI * bodyJumpK);
    const gestureSince = anim ? t - anim.t0 : -1;
    const gestureJump = type === 'celebrate' && ['highFive', 'chestBump'].includes(anim?.style)
      && gestureSince >= .35 && gestureSince <= .85;
    const gesturePulse = gestureJump ? Math.sin(Math.PI * (gestureSince - .35) / .5) : 0;
    this.root.position.y = gestureJump
      ? this.effects.jumpHeight * gesturePulse
      : (bodyJumping || ['jump', 'block', 'serveJump', 'tip'].includes(type) || (type === 'spike' && anim?.jump) ? this.effects.jumpHeight * pulse : 0);
    this.pose(type, k, t);
    // 도형 캐릭터용 몸통 기울기를 뼈대 모델에 중복 적용하지 않는다.
    if (this.poser) this.root.rotation.z = 0;
    this.updateModel(type, anim, t, mirrorPose, facing);
    this.updateGuideHeights();
  }

  pose(type, k, t) {
    const la = this.leftArm, ra = this.rightArm, ll = this.leftLeg, rl = this.rightLeg;
    const set = (j, z, x = 0) => { j.rotation.z = z; j.rotation.x = x; };
    set(la.shoulder, 0.16); set(ra.shoulder, -0.16); set(la.elbow, -0.08); set(ra.elbow, 0.08);
    set(ll.hip, 0.04); set(rl.hip, -0.04); set(ll.knee, 0); set(rl.knee, 0); this.root.rotation.z = 0;
    if (type === 'bump') {
      set(la.shoulder, 1.0, -0.35); set(ra.shoulder, -1.0, -0.35); set(la.elbow, -0.7); set(ra.elbow, 0.7);
    } else if (type === 'underSet') {
      const lift = Math.max(0, Math.min(1, (k - .28) / .38));
      set(la.shoulder, 1.12 + lift * .35, -.42); set(ra.shoulder, -1.12 - lift * .35, -.42);
      set(la.elbow, -.45); set(ra.elbow, .45); set(ll.knee, -.48 + lift * .25); set(rl.knee, -.48 + lift * .25);
    } else if (type === 'set') {
      set(la.shoulder, 2.7, -0.15); set(ra.shoulder, -2.7, -0.15); set(la.elbow, -0.55); set(ra.elbow, 0.55);
    } else if (type === 'block' || type === 'jump') {
      set(la.shoulder, 3.05); set(ra.shoulder, -3.05); set(la.elbow, 0); set(ra.elbow, 0); set(ll.knee, -0.45); set(rl.knee, -0.45);
    } else if (type === 'serveReady') {
      const hit = this.handedness === 'left' ? la : ra, other = this.handedness === 'left' ? ra : la;
      set(hit.shoulder, this.handedness === 'left' ? 1.0 : -1.0, -.35); set(hit.elbow, this.handedness === 'left' ? -.72 : .72);
      set(other.shoulder, this.handedness === 'left' ? -.18 : .18); set(ll.knee, -.28); set(rl.knee, -.28);
    } else if (type === 'serveToss') {
      const hit = this.handedness === 'left' ? la : ra;
      set(hit.shoulder, this.handedness === 'left' ? 2.75 : -2.75, -.18); set(hit.elbow, 0);
      set(ll.knee, -.24); set(rl.knee, -.24);
    } else if (type === 'spike' || type === 'serveFloat' || type === 'serveJump') {
      const swing = Math.min(1, k / 0.48);
      if (this.handedness === 'left') {
        set(la.shoulder, 2.75 - swing * 4.0, -0.15); set(la.elbow, -0.6 + swing * 0.4); set(ra.shoulder, -0.8);
        this.root.rotation.z = 0.12 * Math.sin(Math.PI * swing);
      } else {
        set(ra.shoulder, -2.75 + swing * 4.0, -0.15); set(ra.elbow, 0.6 - swing * 0.4); set(la.shoulder, 0.8);
        this.root.rotation.z = -0.12 * Math.sin(Math.PI * swing);
      }
    } else if (type === 'tip') {
      const hit = this.handedness === 'left' ? la : ra, other = this.handedness === 'left' ? ra : la;
      set(hit.shoulder, this.handedness === 'left' ? 2.9 : -2.9, -.12); set(hit.elbow, 0);
      set(other.shoulder, this.handedness === 'left' ? -.45 : .45, -.2);
    } else if (type === 'dig') {
      set(la.shoulder, 1.18, -.48); set(ra.shoulder, -1.18, -.48); set(la.elbow, -.5); set(ra.elbow, .5);
      set(ll.hip, -.58); set(rl.hip, .34); set(ll.knee, .42); set(rl.knee, -.62);
    } else if (type === 'run') {
      const swing = Math.sin(t * 12) * .62;
      set(la.shoulder, .22 + swing, -.18); set(ra.shoulder, -.22 + swing, -.18);
      set(ll.hip, swing * .55); set(rl.hip, -swing * .55); set(ll.knee, Math.max(0, -swing) * .55); set(rl.knee, Math.max(0, swing) * .55);
    } else if (type === 'dive') {
      this.root.rotation.z = -1.15 * Math.min(1, k * 3); set(la.shoulder, 1.15); set(ra.shoulder, -1.15);
    } else if (type === 'celebrate') {
      const wave = Math.sin(t * 10) * 0.2; set(la.shoulder, 2.75 + wave); set(ra.shoulder, -2.75 - wave);
    } else if (type === 'sad') {
      this.root.rotation.z = 0.05; set(la.shoulder, -0.25); set(ra.shoulder, 0.25); this.root.position.y -= 0.08;
    }
  }
}

export class GameRenderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = .94;
    const gl = this.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x76c8ee); this.scene.fog = new THREE.Fog(0xa5ddf2, 24, 45);
    this.qualityOrder = ['low', 'medium', 'high'];
    const requestedQuality = new URLSearchParams(location.search).get('quality');
    this.quality = this.qualityOrder.includes(requestedQuality) ? requestedQuality : 'high';
    this.debug = new URLSearchParams(location.search).has('debug');
    this.classicCamera = new URLSearchParams(location.search).get('cam') === 'classic';
    this.camera = new THREE.PerspectiveCamera(this.classicCamera ? 50 : 58, 1, 0.1, 100); this.camera.position.set(0, 4.3, -13.5); this.camera.lookAt(0, 0.5, 3);
    this.versusCameras = [0, 1].map(() => new THREE.PerspectiveCamera(55, 1, .1, 100));
    this.versusTargets = [new THREE.Vector3(), new THREE.Vector3()];
    this.versusCameraReady = [false, false];
    this.versusPartnerGhosts = [0, 1].map(() => ({
      opacity: 1, target: 1, request: 1, requestSince: 0, from: 1, startedAt: 0, occluding: false,
    }));
    this.splitEnabled = true; this.splitActive = false; this.lastSplitActive = false; this.lastSplitT = null;
    this.versusCameras[0].layers.enable(1); this.versusCameras[1].layers.enable(2);
    this.buildWorld();
    this.people = [
      new Athlete(this.scene, TEAMS.me[0], SKINS[0], '1P', 1), new Athlete(this.scene, TEAMS.me[1], SKINS[1], '짝꿍', 2),
      new Athlete(this.scene, TEAMS.ai[0], SKINS[2], '상대 1', 3), new Athlete(this.scene, TEAMS.ai[1], SKINS[3], '상대 2', 4),
    ];
    this.roleLabels = this.people.map(() => {
      const label = makeTextSprite('언더 토스', '#ffe36e', 'rgba(42,38,10,.72)', 38);
      label.scale.set(1.65, .42, 1); label.visible = false; this.scene.add(label); return label;
    });
    if (this.debug) window.court = this;   // 자동 검사용
    this.mirrorEnabled = new URLSearchParams(location.search).get('mirror') === '1';
    this.mirrorPoses = [null, null]; this.characterChoices = ['ara', 'min'];
    this.playerHandedness = ['right', 'right']; this.promptKeyLabels = ['', ''];
    this.defaultCamera = new THREE.Vector3(0, 4.3, -13.5);
    this.cameraTarget = new THREE.Vector3(0, .5, 3);
    this.director = new CameraDirector();
    this.replayHistory = []; this.replay = null; this.lastPhase = null;
    this.effects = []; this.lastBallActive = false; this.shakeUntil = 0;
    this.transitionFlashUntil = -1; this.directorFlash = 0;
    this.presentation = null;
    this.previewNames = ['idle','ready','move','run','bump','underSet','set','dig','spike','tip','block','serve','dive','celebrate','sad']; this.previewIndex = -1;
    this.setupPost();
    this.frameCounter = 0; this.fpsWindowT = performance.now();
    this.autoFrames = 0; this.autoWindowT = performance.now() + 5000; this.lastDrawT = performance.now();
    this.performanceInfo = { fps: 0, frameMs: 0, calls: 0, triangles: 0, qualityLabel: '높음', resolutionScale: 1, gpu: this.gpuName };
    this.setQuality(this.quality);
    document.addEventListener('visibilitychange', () => {
      // 백그라운드 탭의 rAF 제한을 실제 GPU 성능 저하로 오인하지 않는다.
      this.autoFrames = 0; this.autoWindowT = performance.now() + 5000;
    });
    const loader = new GLTFLoader();
    this.modelsLoadStartedAt = performance.now();
    const coldToken = new URLSearchParams(location.search).get('cold');
    const loadOne = (name, url, hq) => new Promise((resolve, reject) => {
      const requestUrl = coldToken ? `${url}?cold=${encodeURIComponent(coldToken)}` : url;
      loader.load(requestUrl, gltf => { this.people.forEach(person => person.installModel(name, gltf, hq)); resolve(name); }, undefined, reject);
    });
    this.ready = Promise.allSettled(CHARACTER_NAMES.map(name => HQ_MODELS[name]
      ? loadOne(name, HQ_MODELS[name], true).catch(e => {
        console.warn(`${name} 고품질 모델을 불러오지 못해 기본 GLB를 씁니다.`, e);
        return loadOne(name, `assets/characters/${name}.glb`, false);
      })
      : loadOne(name, `assets/characters/${name}.glb`, false))).then(results => {
      results.forEach((result, i) => {
        if (result.status === 'rejected') console.warn(`${CHARACTER_NAMES[i]} GLB를 불러오지 못해 해당 선택은 도형 캐릭터를 사용합니다.`, result.reason);
      });
      this.setCharacterChoices(this.characterChoices);
      this.modelsReadyMs = performance.now() - this.modelsLoadStartedAt;
      this.performanceInfo.modelsReadyMs = this.modelsReadyMs;
      return results;
    });
    this.resize(); addEventListener('resize', () => this.resize());
  }

  setupPost() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.renderTarget1.samples = 4; this.composer.renderTarget2.samples = 4;
    this.renderPass = new RenderPass(this.scene, this.camera); this.composer.addPass(this.renderPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), .16, .24, .82); this.composer.addPass(this.bloomPass);
    this.vignettePass = new ShaderPass(VignetteShader); this.vignettePass.uniforms.offset.value = 1.08; this.vignettePass.uniforms.darkness.value = 1.18; this.composer.addPass(this.vignettePass);
    this.composer.addPass(new OutputPass());
  }

  setQuality(name, automatic = false) {
    const q = {
      high:   { label: '높음', scale: 1, shadow: 2048, bloom: .16, samples: 4, vignette: true, target: 60 },
      medium: { label: '보통', scale: .85, shadow: 1024, bloom: .09, samples: 2, vignette: false, target: 60 },
      low:    { label: '낮음', scale: .70, shadow: 512, bloom: 0, samples: 0, vignette: false, target: 30 },
    }[name];
    if (!q) return;
    this.quality = name; this.qualityConfig = q;
    this.bloomPass.enabled = q.bloom > 0; this.bloomPass.strength = q.bloom;
    this.composer.renderTarget1.samples = q.samples; this.composer.renderTarget2.samples = q.samples;
    this.vignettePass.enabled = q.vignette;
    if (this.sun) {
      this.sun.shadow.mapSize.set(q.shadow, q.shadow);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
    }
    this.resize();
    // 화질 변경 직후의 셰이더/그림자 재구성 비용은 자동 판정에서 제외한다.
    this.autoFrames = 0;
    this.autoWindowT = performance.now() + 5000;
  }

  raiseQuality() {
    const i = this.qualityOrder.indexOf(this.quality);
    this.setQuality(this.qualityOrder[Math.min(this.qualityOrder.length - 1, i + 1)]);
  }

  lowerQuality() {
    const i = this.qualityOrder.indexOf(this.quality);
    if (i > 0) this.setQuality(this.qualityOrder[i - 1], true);
  }

  setCharacterChoices(choices) {
    this.characterChoices = choices;
    const order = characterOrder(choices, this.competitive);
    order.forEach((name, i) => this.people[i].setCharacter(name));
    this.crowdView?.setTeams(
      this.people.slice(0, 2).map(person => person.characterName),
      this.people.slice(2, 4).map(person => person.characterName),
    );
    this.setPlayerHandedness(this.playerHandedness);
  }

  setCompetitive(value) { this.competitive = value; }

  setVersusSplit(value) { this.splitEnabled = value !== false; }

  getModelReadiness() {
    return modelReadiness(this.people);
  }

  setPlayerHandedness(hands) {
    this.playerHandedness = [hands?.[0] === 'left' ? 'left' : 'right', hands?.[1] === 'left' ? 'left' : 'right'];
    this.people[0].setHandedness(this.playerHandedness[0]);
    this.people[1].setHandedness(this.competitive ? 'right' : this.playerHandedness[1]);
    this.people[2].setHandedness(this.competitive ? this.playerHandedness[1] : 'right');
    this.people[3].setHandedness('right');
  }

  setPromptKeyLabels(labels) { this.promptKeyLabels = labels ?? ['', '']; }

  syncServeAnchor(match) {
    if (!match || !['serve-me', 'serve-ai', 'serve-toss', 'serve-return'].includes(match.phase)) return;
    const personIndex = match.servingActorIndex;
    const athlete = this.people[personIndex];
    // 득점 직후 이동한 서버의 이전 프레임 뼈 위치를 공 위치로 쓰지 않는다.
    const actor = match.actor(personIndex);
    if (athlete && actor) {
      athlete.root.position.set(-actor.x, athlete.root.position.y, actor.z);
      athlete.root.rotation.y = personIndex < 2 ? 0 : Math.PI;
      athlete.root.updateMatrixWorld(true);
    }
    const toss = athlete?.getTossHandWorldPosition();
    const hitFloat = athlete?.getContactHandWorldPosition('serveFloat');
    const hitJump = athlete?.getContactHandWorldPosition('serveJump');
    if (toss && hitFloat && hitJump) match.setServeGeometry({
      toss: { x: -toss.x, y: toss.y, z: toss.z },
      hitFloat: { x: -hitFloat.x, y: hitFloat.y, z: hitFloat.z },
      hitJump: { x: -hitJump.x, y: hitJump.y, z: hitJump.z },
      standReach: athlete.measureServeReach(),
    });
  }

  measureBackNumberDepths() {
    const depths = {};
    for (const name of CHARACTER_NAMES) {
      const state = this.people[0].models.get(name);
      const plate = state?.model.getObjectByName('CleanBackNumber');
      const spine = state?.model.getObjectByName('Spine02');
      if (!state || !plate || !spine) continue;
      state.model.updateMatrixWorld(true);
      const plateWorld = plate.getWorldPosition(new THREE.Vector3());
      const spineWorld = spine.getWorldPosition(new THREE.Vector3());
      const outward = plate.getWorldDirection(new THREE.Vector3()).normalize();
      depths[name] = Math.abs(plateWorld.sub(spineWorld).dot(outward));
    }
    return depths;
  }

  setMirrorPoses(poses) { if (this.mirrorEnabled) this.mirrorPoses = this.competitive ? [poses[0], null, poses[1], null] : poses; }

  previewNextAnimation() {
    this.previewIndex = (this.previewIndex + 1) % this.previewNames.length;
    this.previewType = this.previewNames[this.previewIndex];
    this.previewUntil = performance.now() + 1900; this.previewStartedAt = null;
    return this.previewType;
  }

  buildWorld() {
    this.scene.add(new THREE.HemisphereLight(0xfff3d4, 0x3e7185, 1.35));
    const sun = new THREE.DirectionalLight(0xffefbd, 2.25); sun.position.set(-7, 13, -5); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -10; sun.shadow.camera.right = 10; sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -4; this.scene.add(sun); this.sun = sun;
    this.sand = createSand({ width: 22, length: 27, z: 1.5, quality: this.quality });
    this.scene.add(this.sand.mesh);
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(60, 18), new THREE.MeshStandardMaterial({ color: 0x279cc4, roughness: 0.28 })); ocean.rotation.x = -Math.PI / 2; ocean.position.set(0, -0.12, 19); this.scene.add(ocean);
    const lineMat = mat(0xffffff);
    for (const x of [-COURT.halfW, COURT.halfW]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.035, COURT.halfL * 2), lineMat); l.position.set(x, 0.025, 0); this.scene.add(l); }
    for (const z of [-COURT.halfL, COURT.halfL]) { const l = new THREE.Mesh(new THREE.BoxGeometry(COURT.halfW * 2, 0.035, 0.06), lineMat); l.position.set(0, 0.025, z); this.scene.add(l); }
    const postMat = mat(0x5d4037);
    const postH = COURT.netH + .28;
    for (const x of [-4.3, 4.3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, postH, 10), postMat); post.position.set(x, postH / 2, 0); this.scene.add(post); }
    const netH = Math.max(.8, COURT.netH - .95);
    const net = new THREE.Mesh(new THREE.PlaneGeometry(8.55, netH, 17, 5), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.62, side: THREE.DoubleSide })); net.position.set(0, COURT.netH - netH / 2, 0); this.scene.add(net);
    const tape = new THREE.Mesh(new THREE.BoxGeometry(8.65, 0.075, 0.06), lineMat); tape.position.set(0, COURT.netH, 0); this.scene.add(tape);
    this.ball = createVolleyball(THREE); this.scene.add(this.ball);
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.88, 40), new THREE.MeshBasicMaterial({ color: 0xf44f9b, transparent: true, opacity: 0.82, side: THREE.DoubleSide })); this.marker.rotation.x = -Math.PI / 2; this.marker.position.y = 0.045; this.scene.add(this.marker);
    this.setMarker = new THREE.Mesh(new THREE.RingGeometry(.27, .39, 36), new THREE.MeshBasicMaterial({ color: 0xffdf54, transparent: true, opacity: .48, side: THREE.DoubleSide, depthTest: false }));
    this.setMarker.rotation.x = -Math.PI / 2; this.setMarker.position.y = .05; this.setMarker.visible = false; this.scene.add(this.setMarker);
    this.setSpotLabel = makeTextSprite('토스 자리', '#ffe36e', 'rgba(45,39,8,.62)', 34); this.setSpotLabel.scale.set(1.45, .36, 1); this.setSpotLabel.visible = false; this.scene.add(this.setSpotLabel);
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.65, 12), new THREE.MeshBasicMaterial({ color: 0xff8a31 })); this.arrow.rotation.z = Math.PI; this.scene.add(this.arrow);
    this.blockBand = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.025, 1.05), new THREE.MeshBasicMaterial({ color: 0xb86cff, transparent: true, opacity: 0.58 })); this.blockBand.position.y = 0.055; this.scene.add(this.blockBand);
    this.blockIcon = makeTextSprite('🙌', '#fff', 'rgba(132,61,194,.92)', 62); this.blockIcon.scale.set(1.0, .72, 1); this.scene.add(this.blockIcon);
    this.serverLabel = makeTextSprite('서브', '#fff', 'rgba(255,126,35,.9)', 46); this.serverLabel.scale.set(1.2, .46, 1); this.scene.add(this.serverLabel);
    this.timings = [0, 1].map(i => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.30, 0.36, 40), new THREE.MeshBasicMaterial({ color: i ? 0x9dffb0 : 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
      this.scene.add(ring); return ring;
    });
    this.serveTiming = new THREE.Mesh(new THREE.RingGeometry(.22, .34, 40), new THREE.MeshBasicMaterial({ color: 0xffff8a, transparent: true, opacity: .95, side: THREE.DoubleSide, depthTest: false }));
    this.scene.add(this.serveTiming);
    this.popupSprites = [];
    this.buildScenery();
    if (new URLSearchParams(location.search).get('bg') !== 'classic') {
      this.backdrop = installGwangalli(this.scene, this.camera, { quality: this.quality });
    }
  }

  buildScenery() {
    // 자작 로우폴리 아트: 야자수, 파라솔, 관중석과 떠 있는 구름.
    const trunkMat = mat(0x9b6335), leafMat = mat(0x2b9b61);
    for (const x of [-8.5, 8.5, -10.5, 10.5]) {
      const z = x > 0 ? 5 + (x % 3) : 7 + (-x % 3);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.14, .25, 3.8, 9), trunkMat); trunk.position.set(x, 1.9, z); trunk.rotation.z = x > 0 ? -.08 : .08; trunk.castShadow = true; this.scene.add(trunk);
      for (let i=0;i<7;i++) {
        const a = i/7*Math.PI*2;
        const leaf = new THREE.Mesh(new THREE.CapsuleGeometry(.16, 1.55, 3, 6), leafMat);
        const direction = new THREE.Vector3(Math.cos(a), -.22, Math.sin(a)).normalize();
        leaf.position.set(x + Math.cos(a)*.82, 3.92 - (i%2)*.06, z + Math.sin(a)*.82);
        leaf.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), direction); leaf.scale.z = .42; this.scene.add(leaf);
      }
    }
    this.crowdView = new Crowd({ quality: this.quality });
    this.scene.add(this.crowdView.group);
    for (const [x,z,color] of [[-6.4,-1.5,0x3d8ee6],[6.4,1.0,0xff635f]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,2.0,7),mat(0xffffff)); pole.position.set(x,1,z); this.scene.add(pole);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(1.05,.42,18),mat(color)); shade.position.set(x,2,z); this.scene.add(shade);
    }
    for (const [x,y,z,s] of [[-7,8,18,1.4],[5,9,22,1.8],[0,10,27,1.2]]) {
      const cloud = new THREE.Group(); cloud.position.set(x,y,z); cloud.scale.setScalar(s);
      for (const [dx,dy,sc] of [[0,0,1],[-.7,-.05,.7],[.75,-.08,.8]]) { const puff=new THREE.Mesh(new THREE.SphereGeometry(.75,12,8),new THREE.MeshBasicMaterial({color:0xffffff})); puff.position.set(dx,dy,0); puff.scale.setScalar(sc); cloud.add(puff); }
      this.scene.add(cloud);
    }
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    const scale = this.qualityConfig?.scale ?? 1;
    const dpr = Math.min(devicePixelRatio || 1, 2) * scale;
    this.renderer.setPixelRatio(dpr); this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(dpr); this.composer?.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const halfAspect = Math.max(1, w / 2) / Math.max(1, h);
    this.versusCameras?.forEach(camera => { camera.aspect = halfAspect; camera.updateProjectionMatrix(); });
  }

  triggerEffect(type) {
    const origin = type === 'block'
      ? new THREE.Vector3(this.blockBand.position.x, 2.25, 0)
      : this.ball.position.clone();
    const colors = type === 'score' ? [0xffd54f, 0xff5f78, 0x4fc3f7, 0x81c784] : [0xf4d58a, 0xffd54f, 0xffffff];
    const count = type === 'score' ? 28 : 12;
    for (let i = 0; i < count; i++) {
      const particle = new THREE.Mesh(
        type === 'score' ? new THREE.BoxGeometry(.05, .1, .03) : new THREE.SphereGeometry(.045, 5, 4),
        new THREE.MeshBasicMaterial({ color: colors[i % colors.length], transparent: true })
      );
      particle.position.copy(origin);
      particle.userData.velocity = new THREE.Vector3((Math.random() - .5) * 3, 1.2 + Math.random() * 2.4, (Math.random() - .5) * 2.4);
      particle.userData.life = type === 'score' ? 1.8 : .8;
      this.scene.add(particle); this.effects.push(particle);
    }
    if (type === 'score') this.shakeUntil = performance.now() + 420;
    if (type === 'serve-power') this.shakeUntil = performance.now() + 240;
  }

  triggerDigSand(player) {
    const origin = new THREE.Vector3(-player.x, .08, player.z);
    const count = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const particle = new THREE.Mesh(
        new THREE.SphereGeometry(.035 + Math.random() * .025, 5, 4),
        new THREE.MeshBasicMaterial({ color: i % 3 ? 0xe3be72 : 0xffe3a2, transparent: true })
      );
      particle.position.copy(origin);
      particle.userData.velocity = new THREE.Vector3((Math.random() - .5) * 2.3, .7 + Math.random() * 1.25, (Math.random() - .5) * 1.7);
      particle.userData.life = .45 + Math.random() * .25;
      this.scene.add(particle); this.effects.push(particle);
    }
  }

  triggerCelebration() {
    const count = { high: 300, medium: 150, low: 60 }[this.quality] ?? 150;
    const colors = [0xffd54f, 0xff5f78, 0x4fc3f7, 0x81c784, 0xba68c8];
    for (let i = 0; i < count; i++) {
      const particle = new THREE.Mesh(new THREE.BoxGeometry(.06, .13, .025), new THREE.MeshBasicMaterial({ color: colors[i % colors.length], transparent: true }));
      particle.position.set((Math.random() - .5) * 8, 4 + Math.random() * 4, (Math.random() - .5) * 15);
      particle.userData.velocity = new THREE.Vector3((Math.random() - .5) * .8, -.15 - Math.random() * .8, (Math.random() - .5) * .6);
      particle.userData.life = 3.1;
      this.scene.add(particle); this.effects.push(particle);
    }
  }

  updateEffects(dt, t) {
    this.effects = this.effects.filter(p => {
      p.userData.life -= dt;
      if (p.userData.life <= 0) { this.scene.remove(p); p.geometry.dispose(); p.material.dispose(); return false; }
      p.userData.velocity.y -= 4.8 * dt;
      p.position.addScaledVector(p.userData.velocity, dt);
      p.rotation.x += dt * 5; p.rotation.z += dt * 7;
      p.material.opacity = Math.min(1, p.userData.life * 2);
      return true;
    });
  }

  reactCrowd(type, data = {}) { this.crowdView?.react(type, data); }

  flash(amount = 0) {
    const overlay = document.getElementById('flash');
    if (!overlay) return;
    const transition = performance.now() < this.transitionFlashUntil
      ? (this.transitionFlashUntil - performance.now()) / 200
      : 0;
    overlay.classList.toggle('transition', transition > 0);
    overlay.style.opacity = String(transition > 0 ? transition : Math.min(.35, Math.max(0, amount) * .35));
  }

  updateCamera(m, t, replaying, replayFrame = null) {
    const cameraDt = this.lastCameraT == null ? 1 / 60 : Math.max(0, Math.min(.1, t - this.lastCameraT));
    this.lastCameraT = t;
    const directed = !this.splitActive && !this.classicCamera && !replaying && m.phase !== 'point' ? this.director.update(m, t, cameraDt) : null;
    if (directed) {
      this.camera.position.copy(directed.position); this.cameraTarget.copy(directed.target);
      if (Math.abs(this.camera.fov - directed.fov) > .01) {
        this.camera.fov = directed.fov; this.camera.updateProjectionMatrix();
      }
      this.cameraShot = `director-${directed.name}`;
      this.directorFlash = directed.flash;
      if (performance.now() < this.shakeUntil) {
        this.camera.position.x += (Math.random() - .5) * .08;
        this.camera.position.y += (Math.random() - .5) * .05;
      }
      this.camera.lookAt(this.cameraTarget); this.flash(directed.flash);
      return;
    }
    const desired = this.defaultCamera.clone(), target = new THREE.Vector3(0, .5, 3);
    const presentation = m.presentation;
    const pointElapsed = m.phase === 'point' ? t - m.phaseT : -1;
    const pointView = m.pointPresentation;
    const winnerCloseup = pointElapsed >= 0 && pointElapsed < (pointView?.winnerEnd ?? 2.8);
    const loserCloseup = pointElapsed >= (pointView?.winnerEnd ?? 2.8) && pointElapsed < (pointView?.loserEnd ?? 3.6);
    const placeTeamCloseup = (teamKey, team, extraDistance = 0, orbitElapsed = 0) => {
      const cx = -(team[0].x + team[1].x) / 2, cz = (team[0].z + team[1].z) / 2;
      const dx = -(team[1].x - team[0].x), dz = team[1].z - team[0].z;
      const separation = Math.hypot(dx, dz);
      const distance = Math.max(2.6, separation * 1.1 + 1.6) + extraDistance;
      let nx = separation > .01 ? dz / separation : 0, nz = separation > .01 ? -dx / separation : (teamKey === 'me' ? 1 : -1);
      const wantedZ = teamKey === 'me' ? 1 : -1;
      if (nz * wantedZ < 0) { nx *= -1; nz *= -1; }
      const angle = THREE.MathUtils.degToRad(6 * orbitElapsed);
      const rx = nx * Math.cos(angle) - nz * Math.sin(angle);
      const rz = nx * Math.sin(angle) + nz * Math.cos(angle);
      const approach = 1 - .15 * THREE.MathUtils.clamp(orbitElapsed / Math.max(.01, pointView?.winnerEnd ?? 2.8), 0, 1);
      let cameraX = cx + rx * distance * approach, cameraZ = cz + rz * distance * approach;
      const limit = teamKey === 'me' ? -.4 : .4;
      const crossesNet = teamKey === 'me' ? cameraZ > limit : cameraZ < limit;
      if (crossesNet) {
        cameraZ = limit;
        const forward = Math.abs(cameraZ - cz);
        const side = Math.sqrt(Math.max(distance * distance - forward * forward, distance * distance * .49));
        cameraX = cx + (rx < 0 ? -1 : 1) * side;
      }
      desired.set(cameraX, 1.4, cameraZ); target.set(cx, 1.28, cz);
    };
    let shot = 'default';
    if (presentation?.type === 'intro') {
      shot = 'intro';
      desired.set(10.5, 7.2, -2); target.set(0, .8, 0);
    } else if (presentation?.type === 'victory') {
      shot = `victory-${presentation.winner}`;
      const team = presentation.winner === 'me' ? m.players : m.ai;
      placeTeamCloseup(presentation.winner, team);
    } else if (winnerCloseup) {
      shot = `point-winner-${m.lastPoint}`;
      const team = m.lastPoint === 'me' ? m.players : m.ai;
      placeTeamCloseup(m.lastPoint, team, 0, pointElapsed);
    } else if (loserCloseup) {
      const loser = m.lastPoint === 'me' ? 'ai' : 'me';
      shot = `point-loser-${loser}`;
      placeTeamCloseup(loser, loser === 'me' ? m.players : m.ai, .8, 0);
    } else if (replaying) {
      shot = 'replay';
      const actor = replayFrame?.all?.[m.pointReplayActor] ?? replayFrame?.all?.find(Boolean);
      const ball = replayFrame?.ball;
      if (actor) {
        const towardNet = m.pointReplayActor < 2 ? 1 : -1;
        const towardCenter = actor.x === 0 ? 0 : -Math.sign(actor.x) * 1.5;
        desired.set(-(actor.x + towardCenter), 1.8, actor.z - towardNet * 3);
        target.set(-(ball?.x ?? actor.x), Math.max(1, ball?.y ?? 1.4), ball?.z ?? (actor.z + towardNet * 2));
      } else {
        desired.set(5.2, 2.2, -7.5); target.set(0, 1.2, 0);
      }
    } else if (m.competitive) {
      shot = 'competitive';
      // 두 사람이 같은 화면을 보므로 대결에서는 시점을 뒤집지 않는다.
      desired.set(0, 7.5, -18); target.set(0, .8, 0);
    } else if (m.phase?.startsWith('serve-')) {
      shot = `serve-${m.servingActorIndex}`;
      const server = m.actor(m.servingActorIndex), away = m.servingActorIndex >= 2;
      desired.set(-server.x * .18, 3.8, away ? 14.5 : -14.5);
      target.set(-server.x, 1.15, server.z + (away ? -2 : 2));
    } else if (m.slowMotion && m.exp) {
      shot = 'slow-motion';
      desired.set(-m.actor(m.exp.who).x * .35, 3.7, -11.4); target.set(-m.actor(m.exp.who).x, 1.4, 0);
    } else if (!this.classicCamera && m.phase === 'rally') {
      shot = 'follow';
      const humans = m.players.filter(p => p.human);
      if (humans.length) {
        const humanX = humans.reduce((sum, p) => sum + p.x, 0) / humans.length;
        const humanZ = humans.reduce((sum, p) => sum + p.z, 0) / humans.length;
        desired.set(-humanX * .6, 2.6, THREE.MathUtils.clamp(humanZ - 4.2, -13.5, -8.5));
        target.set(-humanX * .3, 1.6, 4);
      }
    }
    const fallbackFov = this.classicCamera ? 50 : 58;
    if (Math.abs(this.camera.fov - fallbackFov) > .01) {
      this.camera.fov = fallbackFov; this.camera.updateProjectionMatrix();
    }
    // 동작 판정 프롬프트가 열려 있을 때는 카메라 이동량을 더 작게 제한한다.
    const alpha = m.prompts?.some(p => p.tHit) ? .018 : .055;
    const cut = shot.startsWith('point-') || shot.startsWith('victory-') || shot === 'replay'
      || this.cameraShot?.startsWith('point-') || this.cameraShot?.startsWith('victory-');
    if (shot !== this.cameraShot && cut) {
      this.camera.position.copy(desired); this.cameraTarget.copy(target);
    } else {
      this.camera.position.lerp(desired, alpha); this.cameraTarget.lerp(target, alpha);
    }
    this.cameraShot = shot;
    if (performance.now() < this.shakeUntil) {
      this.camera.position.x += (Math.random() - .5) * .08;
      this.camera.position.y += (Math.random() - .5) * .05;
    }
    this.camera.lookAt(this.cameraTarget);
    this.directorFlash = 0; this.flash(0);
  }

  updateVersusCameras(m, t) {
    if (!this.splitActive) { this.lastSplitT = null; return; }
    const dt = this.lastSplitT == null ? 1 / 60 : Math.max(0, Math.min(.1, t - this.lastSplitT));
    this.lastSplitT = t;
    [0, 2].forEach((actorIndex, slot) => {
      const actor = m.actor(actorIndex), partner = m.actor(actorIndex + 1);
      if (!actor) return;
      const plan = versusCameraPlan(actor, partner ?? actor, slot, m.slowMotion && m.exp?.who === actorIndex);
      const desired = new THREE.Vector3(plan.desired.x, plan.desired.y, plan.desired.z);
      const target = new THREE.Vector3(plan.target.x, plan.target.y, plan.target.z);
      const camera = this.versusCameras[slot];
      const alpha = 1 - Math.exp(-dt * versusCameraFollowRate(m, actorIndex));
      if (!this.versusCameraReady[slot]) {
        camera.position.copy(desired); this.versusTargets[slot].copy(target); this.versusCameraReady[slot] = true;
      } else {
        camera.position.lerp(desired, alpha); this.versusTargets[slot].lerp(target, alpha);
      }
      camera.fov = 66; camera.lookAt(this.versusTargets[slot]); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    });
  }

  updateVersusPartnerGhosts(now) {
    if (!this.splitActive) {
      this.versusPartnerGhosts.forEach(state => { state.opacity = 1; state.target = 1; state.request = 1; state.occluding = false; });
      return;
    }
    this.scene.updateMatrixWorld(true);
    [0, 2].forEach((actorIndex, slot) => {
      const camera = this.versusCameras[slot];
      const self = this.people[actorIndex], partner = this.people[actorIndex + 1];
      const selfRoot = self.root.getWorldPosition(new THREE.Vector3());
      const headBone = self.model?.getObjectByName('head_end') ?? self.model?.getObjectByName('Head');
      const head = headBone ? headBone.getWorldPosition(new THREE.Vector3()) : selfRoot.clone().add(new THREE.Vector3(0, 1.75, 0));
      const torso = selfRoot.clone().add(new THREE.Vector3(0, .9, 0));
      const partnerRoot = partner.model ?? partner.root;
      const partnerDistance = camera.position.distanceTo(partner.root.position);
      const selfDistance = camera.position.distanceTo(self.root.position);
      // 큰 머리 캐릭터 가장자리에서 반투명이 빠르게 켜졌다 꺼지지 않도록 약간의 여유를 둔다.
      const occluding = partnerDistance + .5 < selfDistance && occludes(camera, partnerRoot, [selfRoot, torso, head], .08);
      const state = this.versusPartnerGhosts[slot];
      const request = occluding ? .35 : 1;
      state.occluding = occluding;
      if (request !== state.request) { state.request = request; state.requestSince = now; }
      const hold = request < 1 ? .12 : .30;
      if (request !== state.target && now - state.requestSince >= hold) {
        state.from = state.opacity; state.target = request; state.startedAt = now;
      }
      const k = THREE.MathUtils.clamp((now - state.startedAt) / .25, 0, 1);
      const smooth = k * k * (3 - 2 * k);
      state.opacity = k >= 1 ? state.target : THREE.MathUtils.lerp(state.from, state.target, smooth);
      state.obstructing = occluding && state.opacity > .5;
      const selfHeadView = head.clone().project(camera);
      const selfFootView = selfRoot.clone().project(camera);
      const partnerFootView = partner.root.getWorldPosition(new THREE.Vector3()).project(camera);
      state.partnerDistance = partnerDistance;
      state.partnerFootCut = partnerDistance < 6 && partnerFootView.y < -1;
      state.selfCenterOutside = selfHeadView.x < -.6 || selfHeadView.x > .6;
      state.selfInside = [selfHeadView, selfFootView].every(point => point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1);
    });
  }

  setGuideLayer(object, actorIndex) {
    object?.layers.set(guideLayerForActor(actorIndex, this.splitActive));
  }

  orientGuides(camera) {
    this.people.forEach(person => { person.tag?.lookAt(camera.position); person.speech?.lookAt(camera.position); });
    this.roleLabels.forEach(label => label.lookAt(camera.position));
    this.popupSprites.forEach(sprite => sprite.lookAt(camera.position));
    this.setSpotLabel?.lookAt(camera.position); this.blockIcon?.lookAt(camera.position); this.serverLabel?.lookAt(camera.position);
    this.timings.forEach(ring => ring.lookAt(camera.position)); this.serveTiming?.lookAt(camera.position);
  }

  renderSplit() {
    const renderer = this.renderer;
    const post = this.quality !== 'low';
    const target = post ? this.composer.readBuffer : null;
    const size = target ? { x: target.width, y: target.height } : renderer.getDrawingBufferSize(new THREE.Vector2());
    const half = Math.floor(size.x / 2), widths = [half, size.x - half];
    const oldAutoClear = renderer.autoClear, oldShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.setRenderTarget(target);
    setRenderRegion(renderer, target, 0, 0, size.x, size.y, false);
    renderer.clear(true, true, true); renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = true;
    let x = 0;
    this.versusCameras.forEach((camera, slot) => {
      const partner = this.people[slot === 0 ? 1 : 3];
      const normalOpacity = partner.opacity;
      const normalTagVisible = partner.tag.visible;
      setGhost(partner.root, Math.min(normalOpacity, this.versusPartnerGhosts[slot].opacity));
      if (this.versusPartnerGhosts[slot].opacity < .999) partner.tag.visible = false;
      setRenderRegion(renderer, target, x, 0, widths[slot], size.y, true);
      this.crowdView?.faceCamera(camera); this.orientGuides(camera);
      renderer.render(this.scene, camera);
      partner.tag.visible = normalTagVisible;
      setGhost(partner.root, normalOpacity);
      renderer.shadowMap.needsUpdate = false; x += widths[slot];
    });
    setRenderRegion(renderer, target, 0, 0, size.x, size.y, false);
    renderer.setRenderTarget(null); renderer.setScissorTest(false);
    renderer.autoClear = oldAutoClear; renderer.shadowMap.autoUpdate = oldShadowAuto;
    if (post) {
      this.renderPass.enabled = false;
      this.composer.render();
      this.renderPass.enabled = true;
    }
  }

  draw(m, t) {
    const frameStart = performance.now();
    if (m.autoMove) this.people.forEach((person, index) => {
      m.actor(index).contactGeometry = person.contactGeometry;
    });
    if (this.lastMatch !== m) {
      this.lastMatch = m; this.replayHistory = []; this.replay = null; this.lastPhase = null; this.lastTrailT = null; this.wasReplaying = false;
      this.lastCameraT = null; this.director.reset(); this.transitionFlashUntil = -1; this.flash(0);
      this.sand?.clearMarks(); this.lastStepMarks = []; this.lastLandKeys = []; this.stepFeet = [];
      this.debugMotionPrevious = null; this.debugVisibleTeleports = 0; this.debugProbeTeleports = 0; this.debugProbeServeTeleports = 0;
      this.debugVsFrames = null;
      this.people.forEach(person => { person.opacitySwitches = 0; person.opacityActivations = 0; person.yawOver20 = 0; });
    }
    const sourceAll = [...m.players, ...m.ai];
    if (m.phase === 'rally') {
      const ball = m.ball.pos(t);
      this.replayHistory.push({ t, all: sourceAll.map(p => ({ ...p, anim: p.anim ? { ...p.anim } : null })), ball: ball ? { ...ball } : null });
      this.replayHistory = this.replayHistory.filter(frame => t - frame.t <= 2.05);
    }
    if (m.phase === 'point' && this.lastPhase !== 'point') {
      this.transitionFlashUntil = performance.now() + 200;
      this.triggerEffect('sand');
      this.triggerEffect('score');
      if (m.pointReplay && this.replayHistory.length) {
        const endT = this.replayHistory[this.replayHistory.length - 1].t;
        this.replay = { frames: this.replayHistory.filter(frame => frame.t >= endT - 1.9), pointT: m.phaseT };
      }
    }
    if (this.lastPhase === 'point' && m.phase !== 'point') this.transitionFlashUntil = performance.now() + 200;
    if (this.debug) {
      const visiblePlay = m.phase !== 'point' && performance.now() >= (this.transitionFlashUntil ?? -1);
      if (visiblePlay && this.debugMotionPrevious) {
        sourceAll.forEach((player, i) => {
          const previous = this.debugMotionPrevious[i];
          if (previous && Math.hypot(player.x - previous.x, player.z - previous.z) > 1) {
            // 접촉 측정기는 사람 입력 x를 의도적으로 목표점으로 순간 이동시킨다. 실제 캐릭터 이동과 분리해 기록한다.
            if (player.human) this.debugProbeTeleports++;
            else if (this.lastPhase === 'serve-me' && m.phase === 'serve-ai') this.debugProbeServeTeleports++;
            else this.debugVisibleTeleports++;
          }
        });
      }
      this.debugMotionPrevious = sourceAll.map(player => ({ x: player.x, z: player.z }));
    }
    if (m.phase !== 'point') this.replay = null;
    const replayStart = m.pointPresentation?.replayStart ?? 3.6;
    const replayWall = this.replay ? t - this.replay.pointT - replayStart : -1;
    // 2.5초짜리 하이라이트의 마지막 1.2초는 절반 속도로 재생한다.
    const replayElapsed = replayWall < 1.3 ? replayWall : 1.3 + (replayWall - 1.3) * .5;
    const replayFrame = this.replay?.frames.reduce((best, frame) =>
      Math.abs(frame.t - (this.replay.frames[0].t + replayElapsed)) < Math.abs(best.t - (this.replay.frames[0].t + replayElapsed)) ? frame : best,
      this.replay.frames[0]);
    const replaying = !!(replayFrame && replayWall >= 0 && replayWall < 2.5);
    if (replaying !== this.wasReplaying) this.transitionFlashUntil = performance.now() + 200;
    this.wasReplaying = replaying;
    const replayLabel = document.getElementById('replay-label');
    if (replayLabel) replayLabel.hidden = !replaying;
    const all = replaying ? replayFrame.all : sourceAll;
    const closeup = m.presentation?.type === 'victory' || (m.phase === 'point' && t - m.phaseT < (m.pointPresentation?.loserEnd ?? 3.6));
    this.splitActive = shouldSplitVersusView(m, this.splitEnabled, replaying);
    if (this.splitActive !== this.lastSplitActive) {
      this.transitionFlashUntil = performance.now() + 200;
      this.lastSplitActive = this.splitActive;
      if (this.splitActive) this.versusCameraReady = [false, false];
    }
    document.body.classList.toggle('vs-split', this.splitActive);
    this.updateCamera(m, t, replaying, replayFrame);
    this.updateVersusCameras(m, t);
    const currentBall = replaying ? replayFrame.ball : m.ball.pos(t);
    const groundBall = !replaying && currentBall?.y <= .12 ? m.ball.groundContact() : null;
    const b = groundBall ?? currentBall;
    const occlusionPoints = [];
    if (b) occlusionPoints.push(new THREE.Vector3(-b.x, Math.max(b.y, this.ball.userData.radius ?? .14), b.z));
    if (m.landing) occlusionPoints.push(new THREE.Vector3(-m.landing.x, .045, m.landing.z));
    const opacityNow = performance.now() / 1000;
    all.forEach((p, i) => {
      let shown = p;
      if (!replaying) {
        const serveIndex = m.phase === 'serve-ai' ? 2 + m.aiServerIndex : (m.phase === 'serve-me' ? m.serverIndex
          : (m.phase === 'serve-return' ? (m.serveReturn.team === 'ai' ? 2 + m.serveReturn.index : m.serveReturn.index) : null));
        const tossIndex = m.phase === 'serve-toss' ? (m.serveToss.team === 'ai' ? 2 + m.serveToss.index : m.serveToss.index) : null;
        if (i === serveIndex) shown = { ...p, anim: { type: 'serveReady', t0: t, hold: true } };
        else if (i === tossIndex && !(p.anim?.planned && t >= p.anim.t0)) {
          const bodyJumpT0 = p.anim?.type === 'jump' && t - p.anim.t0 < ANIM ? p.anim.t0 : null;
          shown = { ...p, anim: { type: 'serveToss', t0: m.serveToss.t0, jump: m.serveToss.jump, bodyJumpT0, hold: true } };
        }
      }
      if (!replaying && shown.anim?.delayed && t < shown.anim.t0) shown = { ...shown, anim: { type: 'idle', t0: t } };
      if (!replaying && shown.anim?.faceCamera) {
        shown = { ...shown, anim: { ...shown.anim, face: { x: -this.camera.position.x, z: this.camera.position.z } } };
      }
      if (performance.now() < (this.previewUntil ?? 0)) {
        if (this.previewStartedAt == null) this.previewStartedAt = t;
        shown = { ...p, anim: { type: this.previewType, t0: this.previewStartedAt, jump: ['spike','block','serve'].includes(this.previewType) } };
      }
      if (m.presentation?.type === 'intro') {
        const elapsed = (performance.now() - m.presentation.startedAt) / 1000;
        const side = i < 2 ? -1 : 1;
        const startX = side * (5.5 + (i % 2) * .6);
        const k = Math.min(1, elapsed / Math.max(.01, m.presentation.walkDuration ?? 2));
        shown = { ...shown, x: shown.x + (startX - shown.x) * (1 - k), anim: { type: k < 1 ? 'move' : 'idle', t0: t } };
      }
      const digK = shown.anim?.type === 'dig' ? (t - shown.anim.t0) / ANIM : -1;
      const digKey = `${i}:${shown.anim?.t0}`;
      if (!replaying && digK >= .2 && digK <= .45 && this.lastDigEffectKeys?.[i] !== digKey) {
        (this.lastDigEffectKeys ??= [])[i] = digKey;
        this.triggerDigSand(shown);
        this.sand?.addMark(-shown.x, shown.z, 'dive');
      }
      const landType = ['spike', 'block', 'serveJump', 'tip'].includes(shown.anim?.type) && (shown.anim?.jump !== false);
      const landK = landType ? (t - shown.anim.t0) / ANIM : -1;
      const landKey = `${i}:${shown.anim?.type}:${shown.anim?.t0}`;
      if (!replaying && landK >= .88 && this.lastLandKeys?.[i] !== landKey) {
        (this.lastLandKeys ??= [])[i] = landKey;
        this.sand?.addMark(-shown.x - .13, shown.z, 'land'); this.sand?.addMark(-shown.x + .13, shown.z, 'land');
      }
      if (!replaying && shown.running && t - (this.lastStepMarks?.[i] ?? -1e9) >= .28) {
        (this.lastStepMarks ??= [])[i] = t;
        const foot = ((this.stepFeet ??= [])[i] = !this.stepFeet[i]) ? -.11 : .11;
        this.sand?.addMark(-shown.x + foot, shown.z, 'step');
      }
      this.people[i].update(shown, i < 2 ? 1 : -1, replaying ? replayFrame.t : t, this.mirrorPoses[i]); this.people[i].setPrompt(null);
      const canGhost = !replaying && !closeup && m.phase === 'rally' && !m.presentation && p.human;
      const visualRoot = this.people[i].model ?? this.people[i].root;
      const viewCamera = this.splitActive ? this.versusCameras[i < 2 ? 0 : 1] : this.camera;
      const attacking = ['spike', 'tip', 'serve', 'serveJump', 'serveFloat'].includes(shown.anim?.type);
      const targetOpacity = canGhost && !attacking && occludes(viewCamera, visualRoot, occlusionPoints) ? .8 : 1;
      this.people[i].fadeOpacity(targetOpacity, opacityNow);
      this.setGuideLayer(this.people[i].tag, i);
      this.people[i].tag.visible = !closeup && !CLOSE_CAMERA_SHOTS.has(this.cameraShot);
      const role = this.roleLabels[i]; role.visible = !replaying && !m.presentation && !!p.roleLabel;
      this.setGuideLayer(role, i);
      if (role.visible) {
        role.position.copy(this.people[i].root.position).add(new THREE.Vector3(0, 2.65, 0));
        role.lookAt(this.camera.position);
        const scale = THREE.MathUtils.clamp(this.camera.position.distanceTo(role.position) / 10, .45, 1.5);
        role.scale.set(1.65 * scale, .42 * scale, 1);
      }
    });
    this.updateVersusPartnerGhosts(t);
    const prompts = m.presentation ? [] : m.prompts;
    const fixedCues = document.querySelectorAll('#action-cues .action-cue');
    const cueTexts = [[], []];
    const cueColors = [];
    for (const prompt of prompts) {
      const names = { bump: '리시브!', set: '토스!', spike: '스파이크!', block: '블로킹!', serveToss: '① 토스!', serveHit: '② 치기!' };
      const colors = { bump: '#4fc3f7', set: '#81c784', spike: '#ff8a65', block: '#d48cff', serveToss: '#ffd54f', serveHit: '#ff8a65' };
      const key = this.promptKeyLabels[prompt.who]?.[prompt.action] ?? '';
      const slot = this.splitActive ? (prompt.who < 2 ? 0 : 1) : 0;
      const cue = fixedCues[slot];
      if (cue && m.actor(prompt.who)?.human) {
        const text = `${m.actor(prompt.who).label} · ${names[prompt.action]}${key ? ` (${key})` : ''}`;
        cueTexts[slot].push(text);
        cueColors[slot] = colors[prompt.action];
        continue;
      }
      this.people[prompt.who].setPrompt(`${names[prompt.action]}${key ? ` (${key})` : ''}`, colors[prompt.action]);
      this.setGuideLayer(this.people[prompt.who].speech, prompt.who);
    }
    fixedCues.forEach((cue, slot) => {
      const text = cueTexts[slot].join('\n');
      cue.hidden = !text;
      if (cue.textContent !== text) cue.textContent = text;
      cue.style.color = cueTexts[slot].length > 1 ? '#fff' : cueColors[slot] ?? '#fff';
    });
    this.people.forEach(person => {
      if (!person.speech) return;
      const world = person.speech.getWorldPosition(new THREE.Vector3());
      const owner = this.people.indexOf(person), viewCamera = this.splitActive ? this.versusCameras[owner < 2 ? 0 : 1] : this.camera;
      const scale = THREE.MathUtils.clamp(viewCamera.position.distanceTo(world) / 10, .4, 1.6);
      person.speech.scale.set((this.splitActive ? 1.65 : 3.2) * scale, (this.splitActive ? .48 : .8) * scale, 1);
    });
    // 득점 세리머니에서는 종료된 공을 숨기고, 리플레이의 공은 다시 보여 준다.
    this.ball.visible = !!b && (replaying || (m.phase !== 'point' && m.phase !== 'over'));
    if (b) {
      this.ball.position.set(-b.x, Math.max(b.y, this.ball.userData.radius ?? .14), b.z);
      if (m.debugBallAtServeHand) {
        const server = this.people[m.servingActorIndex];
        const hand = server?.getContactHandWorldPosition('serveJump');
        if (hand) this.ball.position.copy(hand).add(new THREE.Vector3(0, .08, -.18));
      }
      if (m.ball.flightStyle === 'float') { this.ball.rotation.z = Math.sin(t * 2) * .05; this.ball.rotation.x = Math.sin(t * 1.7) * .04; }
      else { this.ball.rotation.z = t * 5; this.ball.rotation.x = t * (m.ball.flightStyle === 'spike' ? 11 : 3); }
    }
    if ((m.slowMotion || m.ball.flightStyle === 'spike') && this.ball.visible && (!this.lastTrailT || t - this.lastTrailT > .07)) {
      this.lastTrailT = t;
      const trail = new THREE.Mesh(new THREE.SphereGeometry((this.ball.userData.radius ?? .14) * .65, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: .5 }));
      trail.position.copy(this.ball.position); trail.userData.velocity = new THREE.Vector3(); trail.userData.life = .35; this.scene.add(trail); this.effects.push(trail);
    }
    const receivePrompt = prompts.find(p => p.who === m.landing?.who && p.action !== 'block');
    this.marker.visible = !!m.landing;
    this.arrow.visible = !!(m.landing?.human && receivePrompt && receivePrompt.inReach === false);
    this.setGuideLayer(this.marker, m.landing?.who); this.setGuideLayer(this.arrow, m.landing?.who);
    if (m.landing) {
      this.marker.position.set(-m.landing.x, 0.045, m.landing.z);
      this.marker.material.color.set(receivePrompt?.inReach === true ? 0x58d16f : (receivePrompt?.inReach === false ? 0xff862e : 0xf44f9b));
      this.marker.material.opacity = m.landing.human ? 0.86 : 0.30;
      this.marker.scale.setScalar(m.landing.human ? 1 : 0.82 + Math.sin(t * 8) * 0.08);
      if (this.arrow.visible) this.arrow.position.set(-m.landing.x, 1.25 + Math.sin(t * 7) * 0.16, m.landing.z);
    }
    const showSetSpot = !replaying && !m.presentation && !!m.setPosition?.human && m.phase === 'rally';
    this.setMarker.visible = showSetSpot; this.setSpotLabel.visible = showSetSpot;
    this.setGuideLayer(this.setMarker, m.setPosition?.who); this.setGuideLayer(this.setSpotLabel, m.setPosition?.who);
    if (showSetSpot) {
      this.setMarker.position.set(-m.setPosition.x, .05, m.setPosition.z);
      this.setMarker.scale.setScalar(.92 + Math.sin(t * 6) * .06);
      this.setSpotLabel.position.set(-m.setPosition.x, .42, m.setPosition.z);
      this.setSpotLabel.lookAt(this.camera.position);
    }
    const effectNow = performance.now();
    const effectDt = this.lastEffectT ? Math.min(.05, (effectNow - this.lastEffectT) / 1000) : 0;
    this.lastEffectT = effectNow; this.updateEffects(effectDt, t); this.sand?.update(effectDt); this.lastPhase = m.phase;
    updateCrowd(this.crowdView, t, effectDt, this.ball.visible ? this.ball.position : null);
    this.blockBand.visible = !!m.blockZone;
    this.setGuideLayer(this.blockBand, m.blockZone?.who);
    if (m.blockZone) this.blockBand.position.set(-m.blockZone.x, 0.055, m.blockZone.z ?? -0.55);
    this.blockIcon.visible = !!(m.blockExp && !m.blockExp.done && b);
    this.setGuideLayer(this.blockIcon, m.blockExp?.who);
    if (this.blockIcon.visible) { this.blockIcon.position.copy(this.ball.position).add(new THREE.Vector3(0, .72, 0)); this.blockIcon.lookAt(this.camera.position); }
    const serveIndex = ['serve-me','serve-ai','serve-toss','serve-return'].includes(m.phase) ? m.servingActorIndex : null;
    this.serverLabel.visible = serveIndex != null && serveIndex >= 2 && !m.actor(serveIndex)?.human && !replaying && !m.presentation;
    this.setGuideLayer(this.serverLabel, serveIndex);
    if (this.serverLabel.visible) { this.serverLabel.position.copy(this.people[serveIndex].root.position).add(new THREE.Vector3(0, 3.25, 0)); this.serverLabel.lookAt(this.camera.position); }
    this.timings.forEach((ring, i) => {
      const prompt = prompts.filter(p => p.tHit)[i];
      ring.visible = !!(b && prompt);
      this.setGuideLayer(ring, prompt?.who);
      if (!ring.visible) return;
      ring.position.copy(this.ball.position); ring.lookAt(this.camera.position);
      const total = Math.max(0.2, prompt.tHit - (prompt.t0 ?? (prompt.tHit - 1)));
      const left = clamp01((prompt.tHit - t) / total); ring.scale.setScalar(0.75 + left * 2.1);
    });
    const serveIdeal = m.phase === 'serve-toss' && m.serveToss
      ? ((m.serveToss.jump || t - m.lastJumpT[m.servingActorIndex] < .7) ? m.serveToss.jumpIdeal : m.serveToss.floatIdeal)
      : null;
    this.serveTiming.visible = !!(b && serveIdeal != null && Math.abs(t - m.serveToss.t0 - serveIdeal) <= .15);
    this.setGuideLayer(this.serveTiming, m.servingActorIndex);
    if (this.serveTiming.visible) {
      this.serveTiming.position.copy(this.ball.position); this.serveTiming.lookAt(this.camera.position);
      this.serveTiming.scale.setScalar(1 + Math.sin(t * 22) * .18);
    }
    this.drawPopups(m.popups, m);
    this.backdrop?.update(t);
    if (this.debug) {
      this.canvas.dataset.cameraShot = this.cameraShot ?? '';
      this.canvas.dataset.cameraFov = this.camera.fov.toFixed(1);
      this.canvas.dataset.actorFaces = JSON.stringify(sourceAll.map(p => p.anim?.face ?? null));
      this.canvas.dataset.actorYaws = JSON.stringify(sourceAll.map((p, i) => ({
        x: p.x, z: p.z, type: p.anim?.type ?? null,
        k: p.anim ? (t - p.anim.t0) / ANIM : null, t0: p.anim?.t0 ?? null,
        face: p.anim?.face ?? null, yaw: this.people[i].visualYaw,
      })));
      this.canvas.dataset.ghostOpacities = JSON.stringify(this.people.map(person => Number(person.opacity.toFixed(3))));
      this.canvas.dataset.ghostPassCounts = JSON.stringify(this.people.map(person => {
        let count = 0; person.root.traverse(obj => { if (obj.userData.ghostDepth && obj.visible) count++; }); return count;
      }));
      this.canvas.dataset.smoothnessMetrics = JSON.stringify({
        fadeTransitions: this.people.reduce((sum, person) => sum + person.opacitySwitches, 0),
        yawJumpsOver20: this.people.reduce((sum, person) => sum + person.yawOver20, 0),
        visibleTeleportsOver1m: this.debugVisibleTeleports,
        probeDrivenHumanTeleports: this.debugProbeTeleports,
        probeDrivenServeTeleports: this.debugProbeServeTeleports,
      });
      this.canvas.dataset.cameraPosition = JSON.stringify(this.camera.position.toArray().map(v => Number(v.toFixed(3))));
      this.canvas.dataset.vsSplit = String(this.splitActive);
      this.canvas.dataset.modelReadiness = JSON.stringify(this.getModelReadiness());
      if (this.splitActive) {
        this.scene.updateMatrixWorld(true);
        const labelGaps = [];
        const points = [0, 2].flatMap((actorIndex, slot) => {
          const person = this.people[actorIndex], root = person.root.position, camera = this.versusCameras[slot];
          const headBone = person.model?.getObjectByName('head_end') ?? person.model?.getObjectByName('Head');
          const head = headBone ? headBone.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(root.x, root.y + 1.75, root.z);
          const headView = head.clone().project(camera);
          const tagBottom = person.tag.localToWorld(new THREE.Vector3(0, -.5, 0)).project(camera);
          labelGaps.push({
            actor: actorIndex,
            pixels: Number(((tagBottom.y - headView.y) * this.canvas.height / 2).toFixed(1)),
          });
          return [{ part: 'foot', world: root.clone() }, { part: 'head', world: head }].map(({ part, world }) => {
            const v = world.project(camera); return { actor: actorIndex, part, gameX: sourceAll[actorIndex]?.x, x: (v.x + 1) / 2, y: (1 - v.y) / 2 };
          });
        });
        const allInside = points.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
        this.debugVsFrames ??= {
          total: 0, inside: 0, occlusion: [0, 0], partnerFootCut: [0, 0],
          selfCenterOutside: [0, 0], selfInside: [0, 0],
        };
        this.debugVsFrames.total++; if (allInside) this.debugVsFrames.inside++;
        this.versusPartnerGhosts.forEach((state, slot) => {
          if (state.obstructing) this.debugVsFrames.occlusion[slot]++;
          if (state.partnerFootCut) this.debugVsFrames.partnerFootCut[slot]++;
          if (state.selfCenterOutside) this.debugVsFrames.selfCenterOutside[slot]++;
          if (state.selfInside) this.debugVsFrames.selfInside[slot]++;
        });
        const rates = key => this.debugVsFrames[key].map(count => count / this.debugVsFrames.total);
        this.canvas.dataset.vsPlayerFrame = JSON.stringify({ points, labelGaps, allInside,
          insideRatio: this.debugVsFrames.inside / this.debugVsFrames.total, samples: this.debugVsFrames.total,
          obstructionRates: rates('occlusion'), partnerFootCutRates: rates('partnerFootCut'),
          selfCenterOutsideRates: rates('selfCenterOutside'), selfInsideRates: rates('selfInside'),
          partnerGhostOpacity: this.versusPartnerGhosts.map(state => Number(state.opacity.toFixed(3))),
        });
      } else delete this.canvas.dataset.vsPlayerFrame;
      this.canvas.dataset.popupMetrics = JSON.stringify(this.popupSprites.filter(s => s.visible).map(s => ({
        distance: Number(this.camera.position.distanceTo(s.position).toFixed(3)),
        scale: Number(s.scale.x.toFixed(3)), text: s.userData.text,
      })));
      this.canvas.dataset.popupSourceCount = String(m.popups.length);
      if (m.phase === 'point' && m.pointPresentation) {
        this.camera.updateMatrixWorld(); this.scene.updateMatrixWorld(true);
        const elapsed = t - m.phaseT;
        const showingWinner = elapsed < m.pointPresentation.winnerEnd;
        const teamKey = showingWinner ? m.lastPoint : (m.lastPoint === 'me' ? 'ai' : 'me');
        const indices = teamKey === 'me' ? [0, 1] : [2, 3];
        const points = indices.flatMap(index => {
          const person = this.people[index], root = person.root.position;
          const headBone = person.model?.getObjectByName('head_end') ?? person.model?.getObjectByName('Head');
          const head = headBone ? headBone.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(root.x, root.y + 1.45, root.z);
          return [
            { part: 'foot', world: new THREE.Vector3(root.x, root.y, root.z) },
            { part: 'head', world: head },
          ].map(({ part, world }) => {
            const v = world.project(this.camera);
            return { actor: index, part, x: (v.x + 1) / 2, y: (1 - v.y) / 2 };
          });
        });
        const a = sourceAll[indices[0]], b2 = sourceAll[indices[1]];
        this.canvas.dataset.pointFrame = JSON.stringify({
          elapsed: Number(elapsed.toFixed(3)), shot: this.cameraShot, team: teamKey, points,
          allInside: points.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1),
          torsoDistance: Number(Math.hypot(a.x - b2.x, a.z - b2.z).toFixed(3)),
        });
      } else delete this.canvas.dataset.pointFrame;
    }
    this.renderer.info.reset();
    if (this.splitActive) this.renderSplit();
    else {
      this.crowdView?.faceCamera(this.camera); this.orientGuides(this.camera);
      if (this.quality === 'low') this.renderer.render(this.scene, this.camera);
      else this.composer.render();
    }
    const now = performance.now(); this.frameCounter++;
    // 탭 전환·개발자 도구 캡처처럼 렌더 루프 자체가 멈춘 시간은 GPU 부하가 아니다.
    if (now - this.lastDrawT > 200) {
      this.autoFrames = 0; this.autoWindowT = now + 5000;
    }
    this.lastDrawT = now;
    if (now - this.fpsWindowT >= 1000) {
      this.performanceInfo.fps = this.frameCounter * 1000 / (now - this.fpsWindowT);
      this.frameCounter = 0; this.fpsWindowT = now;
    }
    this.performanceInfo.frameMs = now - frameStart;
    this.performanceInfo.calls = this.renderer.info.render.calls;
    this.performanceInfo.triangles = this.renderer.info.render.triangles;
    this.performanceInfo.qualityLabel = this.qualityConfig.label;
    this.performanceInfo.resolutionScale = this.qualityConfig.scale;
    if (now >= this.autoWindowT) {
      this.autoFrames++;
      const elapsed = now - this.autoWindowT;
      if (elapsed >= 3000) {
        const averageFps = this.autoFrames * 1000 / elapsed;
        if (averageFps < this.qualityConfig.target * .9) this.lowerQuality();
        else { this.autoFrames = 0; this.autoWindowT = now; }
      }
    }
  }

  drawPopups(popups, match = null) {
    while (this.popupSprites.length < popups.length) { const s = makeTextSprite('', '#fff'); this.scene.add(s); this.popupSprites.push(s); }
    this.popupSprites.forEach((s, i) => {
      const p = popups[i]; s.visible = !!p; if (!p) return;
      if (s.userData.text !== p.text || s.userData.color !== p.color) {
        this.scene.remove(s); s.material.map.dispose(); s.material.dispose();
        const n = makeTextSprite(p.text, p.color); this.scene.add(n); this.popupSprites[i] = n; s = n; s.userData.color = p.color;
      }
      s.position.set(-p.x, p.y, p.z); s.material.opacity = 1;
      let owner;
      if (this.splitActive && match) {
        owner = [0, 2].reduce((best, actorIndex) => {
          const actor = match.actor(actorIndex), distance = actor ? Math.hypot(actor.x - p.x, actor.z - p.z) : Infinity;
          return distance < best.distance ? { actorIndex, distance } : best;
        }, { actorIndex: null, distance: Infinity }).actorIndex;
      }
      this.setGuideLayer(s, owner);
      const popupCamera = this.splitActive && owner != null ? this.versusCameras[owner < 2 ? 0 : 1] : this.camera;
      const distance = popupCamera.position.distanceTo(s.position);
      s.visible = distance >= 2.5;
      const scale = THREE.MathUtils.clamp(distance / 10, .4, 1.6);
      s.scale.set((this.splitActive ? 1.55 : 3.2) * scale, (this.splitActive ? .46 : .8) * scale, 1);
    });
  }
}

const clamp01 = v => Math.max(0, Math.min(1, v));
