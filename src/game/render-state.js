// 경기 시간은 새 판에서 0으로 돌아가지만 관중 객체는 계속 사용한다.
export function updateCrowd(crowd, t, dt, ball) {
  if (!crowd) return;
  if (t < crowd.time) {
    crowd.events = [];
    crowd.wave = null;
    crowd.clap = null;
    crowd.leanUntil = -1;
  }
  crowd.update(t, dt, ball);
}

// 그림자 패스가 렌더 타깃을 다시 연결할 때도 반쪽 화면을 복원하게 한다.
export function setRenderRegion(renderer, target, x, y, width, height, clipped) {
  if (target) {
    target.viewport.set(x, y, width, height);
    target.scissor.set(x, y, width, height);
    target.scissorTest = clipped;
    renderer.setRenderTarget(target);
  } else {
    const ratio = renderer.getPixelRatio();
    renderer.setViewport(x / ratio, y / ratio, width / ratio, height / ratio);
    renderer.setScissor(x / ratio, y / ratio, width / ratio, height / ratio);
    renderer.setScissorTest(clipped);
  }
}
import { ANIM_SECONDS } from './rules.js';

// 입력을 기다리는 예약 동작은 준비 자세다. 직접 점프한 시간만 한 번 재생한다.
export function waitingPose(anim, running, t) {
  const since = anim?.bodyJumpT0 == null ? -1 : t - anim.bodyJumpT0;
  if (since >= 0 && since < ANIM_SECONDS) return 'jump';
  return running ? 'run' : 'ready';
}
