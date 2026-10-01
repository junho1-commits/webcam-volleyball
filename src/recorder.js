// 동작 녹화: 웹캠 영상이 아니라 관절 좌표만 저장한다. (replay.html에서 다시 분석)
// 프레임 형식: [시각(ms), 정답 표시(동작 이름 또는 0), 사람별 관절 [x,y,z,visibility × 33]]

const r4 = v => Math.round(v * 1e4) / 1e4;

// 사람별 MediaPipe 관절 → 저장용 숫자 배열 (영상 변환기와 함께 쓴다)
export const packPoses = poses => poses.map(lm => lm.flatMap(p => [r4(p.x), r4(p.y), r4(p.z ?? 0), r4(p.visibility ?? 1)]));

export class Recorder {
  constructor() {
    this.active = false;
    this.frames = [];
  }

  start(meta) {
    this.active = true;
    this.t0 = performance.now();
    this.frames = [];
    this.meta = { ...meta, startedAt: new Date().toISOString() };
  }

  // label: 테스트 중 "지금 해야 할 동작" (없으면 0)
  frame(t, poses, label = 0) {
    if (!this.active) return;
    this.frames.push([Math.round(t - this.t0), label || 0, packPoses(poses)]);
  }

  get seconds() { return this.active ? (performance.now() - this.t0) / 1000 : 0; }

  // 녹화를 끝내고 파일로 내려받는다. 파일 이름을 돌려준다
  stop() {
    this.active = false;
    const data = { kind: 'webcam-volleyball-pose-recording', version: 1, meta: this.meta, frames: this.frames };
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const name = `동작녹화_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
    downloadRecording(data, name);
    this.frames = [];
    return name;
  }
}

// 녹화 데이터를 JSON 파일로 내려받는다
export function downloadRecording(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// 저장된 한 사람의 관절 배열 → MediaPipe 형식 [{x, y, z, visibility}]
export function unpackPose(flat) {
  const lm = [];
  for (let i = 0; i < flat.length; i += 4) lm.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2], visibility: flat[i + 3] });
  return lm;
}
