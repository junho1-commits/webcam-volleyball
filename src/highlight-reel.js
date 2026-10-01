// 경기 중 웹캠 하이라이트 사진 모음 (Kinect Sports의 "Show Off & Share" 같은 것)
// - 웹캠 화면을 작게(320×180) 초당 12장씩 메모리에만 담아 두고, mark()가 불리면 그 앞뒤 순간을 짧은 움직이는 사진으로 남긴다.
// - 파일로 저장하거나 서버로 보내지 않는다. clear()나 새 경기에서 모두 지운다.
// - 결과 화면에서 showMontage()로 움직이는 사진첩을 보여 준다. "사진 숨기기"로 바로 가릴 수 있다.

const W = 320, H = 180;

export class HighlightReel {
  constructor({ video, fps = 12, maxClips = 8, mirror = true, bufferSeconds = 1.2 } = {}) {
    this.video = video;
    this.fps = fps;
    this.maxClips = maxClips;
    this.mirror = mirror;
    this.ring = [];             // { t, bmp } 최근 프레임
    this.ringSize = Math.ceil(bufferSeconds * fps);
    this.clips = [];            // { label, priority, t, frames: ImageBitmap[] }
    this.pending = [];          // 뒷부분 프레임을 기다리는 클립
    this.kept = new Set();      // 클립이 쓰는 비트맵(링에서 밀려나도 닫지 않음)
    this.scratch = Object.assign(document.createElement('canvas'), { width: W, height: H });
    this.sctx = this.scratch.getContext('2d');
    this.running = false;
    this.timer = null;
    this.montage = null;
  }

  get count() { return this.clips.length; }

  start() {
    if (this.running) return;
    this.running = true;
    const step = () => {
      if (!this.running) return;
      this.grab();
      this.timer = setTimeout(step, 1000 / this.fps);
    };
    step();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    // 뒷부분을 다 못 채운 클립도 있는 만큼 남긴다
    const waiting = this.pending;
    this.pending = [];
    waiting.forEach(p => this.finish(p));
  }

  // label: 사진 밑에 쓸 말. before/after: 이 순간 앞뒤로 몇 초를 담을지. priority가 높을수록 자리가 꽉 찼을 때 남는다.
  mark(label, { priority = 1, before = 0.5, after = 0.3 } = {}) {
    if (!this.running) return false;
    const now = performance.now();
    const frames = this.ring.filter(f => f.t >= now - before * 1000).map(f => f.bmp);
    frames.forEach(b => this.kept.add(b));
    this.pending.push({ label, priority, t: now, until: now + after * 1000, frames });
    return true;
  }

  grab() {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const ctx = this.sctx, vw = v.videoWidth, vh = v.videoHeight;
    // 16:9로 가운데를 잘라 그린다
    const scale = Math.max(W / vw, H / vh), dw = vw * scale, dh = vh * scale;
    ctx.save();
    if (this.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    const t = performance.now();
    createImageBitmap(this.scratch).then(bmp => {
      if (!this.running && !this.pending.length) { bmp.close(); return; }
      this.ring.push({ t, bmp });
      while (this.ring.length > this.ringSize) {
        const old = this.ring.shift();
        if (!this.kept.has(old.bmp)) old.bmp.close();
      }
      for (const p of this.pending) if (t <= p.until) { p.frames.push(bmp); this.kept.add(bmp); }
      const done = this.pending.filter(p => t >= p.until);
      this.pending = this.pending.filter(p => t < p.until);
      done.forEach(p => this.finish(p));
    }).catch(() => {});
  }

  finish(p) {
    if (!p.frames.length) return;
    // 1초 안에 찍힌 사진이 이미 있으면(예: 스파이크 직후 득점) 우선순위가 높은 쪽 하나만 남긴다
    const near = this.clips.find(c => Math.abs(c.t - p.t) < 1000);
    if (near) {
      if (near.priority >= p.priority) { this.release({ frames: p.frames }); return; }
      this.clips.splice(this.clips.indexOf(near), 1);
      this.release(near);
    }
    this.clips.push({ label: p.label, priority: p.priority, t: p.t, frames: p.frames });
    while (this.clips.length > this.maxClips) {
      // 우선순위가 가장 낮은 것 중 가장 오래된 것을 뺀다
      let drop = 0;
      this.clips.forEach((c, i) => { if (c.priority < this.clips[drop].priority) drop = i; });
      this.release(this.clips.splice(drop, 1)[0]);
    }
  }

  release(clip) {
    const inRing = new Set(this.ring.map(f => f.bmp));
    const stillUsed = new Set(this.clips.flatMap(c => c.frames).concat(this.pending.flatMap(p => p.frames)));
    for (const b of clip.frames) {
      if (stillUsed.has(b)) continue;
      this.kept.delete(b);
      if (!inRing.has(b)) b.close();
    }
  }

  // 모든 사진을 지운다(새 경기, 처음 화면으로 갈 때)
  clear() {
    this.hideMontage();
    this.stop();
    const all = new Set([...this.ring.map(f => f.bmp), ...this.clips.flatMap(c => c.frames)]);
    all.forEach(b => b.close());
    this.ring = []; this.clips = []; this.pending = []; this.kept.clear();
  }

  // container 안에 사진첩을 만든다. 사진이 없으면 아무것도 만들지 않고 false.
  showMontage(container, { title = '오늘의 명장면', hidden = false } = {}) {
    this.hideMontage();
    this.stop(); // 결과 화면에서는 더 찍지 않는다. 뒷부분을 기다리던 사진도 여기서 마무리
    if (!this.clips.length || !container) return false;
    const clips = [...this.clips].sort((a, b) => a.t - b.t);
    const root = document.createElement('div');
    root.className = 'hl-reel';
    root.innerHTML = `
      <div class="hl-head"><b>📸 ${title}</b><small>사진은 이 화면에서만 보이고 저장되지 않아요</small></div>
      <div class="hl-stage"><canvas width="${W}" height="${H}"></canvas><span class="hl-label"></span><span class="hl-count"></span></div>
      <div class="hl-hidden-note" hidden>사진을 숨겼어요</div>
      <div class="hl-thumbs"></div>
      <button class="hl-toggle" data-hand-target></button>`;
    const stage = root.querySelector('.hl-stage'), canvas = stage.querySelector('canvas'), ctx = canvas.getContext('2d');
    const label = root.querySelector('.hl-label'), count = root.querySelector('.hl-count');
    const thumbs = root.querySelector('.hl-thumbs'), toggle = root.querySelector('.hl-toggle');
    const note = root.querySelector('.hl-hidden-note');
    const thumbEls = clips.map((clip, i) => {
      const c = Object.assign(document.createElement('canvas'), { width: W / 2, height: H / 2 });
      const mid = clip.frames[Math.floor(clip.frames.length * 0.6)] ?? clip.frames[0];
      c.getContext('2d').drawImage(mid, 0, 0, W / 2, H / 2);
      const b = document.createElement('button');
      b.className = 'hl-thumb'; b.setAttribute('data-hand-target', ''); b.title = clip.label;
      b.append(c);
      b.addEventListener('click', () => { idx = i; frame = 0; hold = 0; });
      thumbs.append(b);
      return b;
    });
    let idx = 0, frame = 0, hold = 0, isHidden = hidden, timer = null;
    const setHidden = h => {
      isHidden = h;
      root.classList.toggle('is-hidden', h);
      stage.hidden = h; thumbs.hidden = h; note.hidden = !h;
      toggle.textContent = h ? '🙂 사진 보기' : '🙈 사진 숨기기';
    };
    toggle.addEventListener('click', () => setHidden(!isHidden));
    setHidden(hidden);
    const tick = () => {
      const clip = clips[idx];
      if (!isHidden) {
        ctx.drawImage(clip.frames[Math.min(frame, clip.frames.length - 1)], 0, 0, W, H);
        label.textContent = clip.label;
        count.textContent = `${idx + 1} / ${clips.length}`;
        thumbEls.forEach((el, i) => el.classList.toggle('on', i === idx));
      }
      if (frame < clip.frames.length - 1) frame++;
      else if (++hold > this.fps * 0.8) { idx = (idx + 1) % clips.length; frame = 0; hold = 0; stage.classList.remove('flip'); void stage.offsetWidth; stage.classList.add('flip'); }
      timer = setTimeout(tick, 1000 / this.fps);
    };
    tick();
    container.append(root);
    this.montage = { root, stop: () => clearTimeout(timer), setHidden };
    return true;
  }

  hideMontage() {
    if (!this.montage) return;
    this.montage.stop();
    this.montage.root.remove();
    this.montage = null;
  }
}

// 설정 저장값: 기본은 켜짐
const KEY = 'volleyball.highlightPhotos';
export function loadHighlightSetting() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
export function saveHighlightSetting(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* 메모리 값으로 계속 */ }
}
