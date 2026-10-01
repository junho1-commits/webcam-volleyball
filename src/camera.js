// 웹캠과 MediaPipe 포즈 인식 모델 준비
// 엔진과 모델은 vendor/ 폴더에 넣어 두어 인터넷 없이도 동작한다 (MediaPipe tasks-vision 0.10.14, pose_landmarker float16 v1)
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

// 페이지 위치와 상관없이 이 파일 기준으로 찾는다
const WASM_URL = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = type => new URL(`../vendor/mediapipe/models/pose_landmarker_${type}.task`, import.meta.url).href;

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  try { await video.play(); }
  catch (error) { stream.getTracks().forEach(track => track.stop()); video.srcObject = null; throw error; }
}

// 새 영상 프레임이 있을 때만 포즈를 인식한다. 새 프레임이 없으면 null
export function makePoseReader(landmarker, video) {
  let lastTime = -1;
  return t => {
    if (video.readyState < 2 || video.currentTime === lastTime) return null;
    lastTime = video.currentTime;
    return landmarker.detectForVideo(video, t).landmarks;
  };
}

// type: 'lite'(빠름) | 'full'(정확), delegate: 'CPU' | 'GPU'
export async function createPose(type = 'lite', delegate = 'CPU') {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = delegate => ({
    baseOptions: { modelAssetPath: MODEL_URL(type), delegate },
    runningMode: 'VIDEO',
    numPoses: 2,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  const requested = delegate.toUpperCase() === 'GPU' ? 'GPU' : 'CPU';
  try { return await PoseLandmarker.createFromOptions(fileset, options(requested)); }
  catch (e) {
    if (requested === 'CPU') throw e;
    console.warn('GPU 포즈 인식을 사용할 수 없어 CPU로 전환합니다.', e);
    return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
}
