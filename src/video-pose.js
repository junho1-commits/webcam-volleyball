// 영상 파일 → 관절 녹화: 웹캠 대신 영상의 프레임마다 MediaPipe로 관절을 찾아, V 녹화와 같은 형식으로 만든다.
// 영상은 이 컴퓨터 안에서만 처리하고 어디에도 보내거나 저장하지 않는다. 결과에는 관절 좌표만 남는다.
import { createPose } from './camera.js';
import { packPoses, unpackPose } from './recorder.js';
import { TH } from './gestures.js';
import { pickPlayer, Smoother, buildFrame } from './body.js';
import { Calibrator } from './calibration.js';

const MAX_SIDE = 1280;   // 긴 쪽을 이 크기로 줄여 인식 (웹캠 1280×720과 비슷하게)
const CAL_MS = 2500;     // 사람이 처음 보인 뒤 이 시간 동안의 자세로 몸 크기를 잰다

// 영상은 "가만히 설 때까지 기다리기"가 안 되므로, 처음 2.5초의 중앙값으로 몸 크기를 잰다(흔들림에 강함)
export function calibrateFromStart(frames, aspect) {
  const smoother = new Smoother(0.6), cal = new Calibrator();
  let prevHip = null, startT = null;
  for (const [t, , poses] of frames) {
    if (!poses.length) continue;
    const pick = pickPlayer(poses.map(unpackPose), prevHip, aspect);
    if (!pick || pick.coreVis < 0.5) continue;
    startT ??= t;
    if (t - startT > CAL_MS) break;
    prevHip = pick.hip;
    cal.frames.push(buildFrame(smoother.apply(pick.lm), t, aspect));
  }
  return cal.frames.length >= 10 ? cal.compute() : null;
}

const once = (el, ev) => new Promise((ok, fail) => {
  el.addEventListener(ev, ok, { once: true });
  el.addEventListener('error', () => fail(new Error('영상을 읽지 못했어요 (지원하지 않는 형식일 수 있어요. mp4나 webm을 써 주세요)')), { once: true });
});

// options: { model: 'full'|'lite', fps, rotate: 0|90|180|270, flip, expectedServes, onProgress(k, eta초), signal }
export async function videoToRecording(file, options = {}) {
  const { model = 'full', fps = 30, rotate = 0, flip = false, expectedServes = null, onProgress, signal } = options;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
  let landmarker = null;
  try {
    await once(video, 'loadedmetadata');
    if (!video.videoWidth || !Number.isFinite(video.duration)) throw new Error('영상 길이나 크기를 알 수 없어요');

    // 회전을 반영한 캔버스에 그린 뒤 인식한다 (휴대폰을 옆으로 눕혀 찍은 영상 대응)
    const side = rotate === 90 || rotate === 270;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const vw = Math.round(video.videoWidth * scale), vh = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = side ? vh : vw; canvas.height = side ? vw : vh;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });

    landmarker = await createPose(model, 'GPU');
    const frames = [];
    const n = Math.max(1, Math.floor(video.duration * fps));
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new DOMException('취소했어요', 'AbortError');
      const t = i / fps;
      video.currentTime = t;
      await once(video, 'seeked');
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rotate * Math.PI / 180);
      ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
      ctx.restore();
      const ms = Math.round(t * 1000);
      let poses = landmarker.detectForVideo(canvas, ms).landmarks;
      if (flip) poses = poses.map(lm => lm.map(p => ({ ...p, x: 1 - p.x })));
      frames.push([ms, 0, packPoses(poses)]);
      if (onProgress && (i % 5 === 0 || i === n - 1)) {
        const k = (i + 1) / n, spent = (performance.now() - started) / 1000;
        onProgress(k, spent / k - spent);
      }
    }
    const aspect = canvas.width / canvas.height;
    return {
      kind: 'webcam-volleyball-pose-recording', version: 1,
      meta: {
        source: 'video', videoName: file.name, aspect,
        model, fps, rotate, flip, expectedServes,
        cal: calibrateFromStart(frames, aspect),   // 영상 처음 2.5초(차렷)로 잰 몸 크기
        th: structuredClone(TH), startedAt: new Date().toISOString(),
      },
      frames,
    };
  } finally {
    landmarker?.close?.();
    video.removeAttribute('src'); video.load();
    URL.revokeObjectURL(url);
  }
}
