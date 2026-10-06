const STORAGE_KEY = 'beach-volleyball-key-bindings-v1';
const RESERVED_KEYS = new Set(['KeyP', 'Backspace', 'Escape', 'F2', 'F3', 'F4', 'F8', 'Tab']);
export const isBindableCode = code => typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Arrow(Left|Right|Up|Down)|Space|Enter|Shift(Left|Right))$/.test(code) && !RESERVED_KEYS.has(code);

export const DEFAULT_BINDINGS = Object.freeze({
  solo: Object.freeze({
    left: 'ArrowLeft', right: 'ArrowRight', bump: 'KeyZ', set: 'KeyX', hit: 'KeyC', block: 'KeyV', jump: 'Space',
  }),
  p1: Object.freeze({
    left: 'KeyA', right: 'KeyD', bump: 'KeyQ', set: 'KeyW', hit: 'KeyE', block: 'KeyR', jump: 'KeyS',
  }),
  p2: Object.freeze({
    left: 'ArrowLeft', right: 'ArrowRight', bump: 'Numpad1', set: 'Numpad2', hit: 'Numpad3', block: 'Numpad4', jump: 'Numpad0',
  }),
});

export const ACTION_LABELS = Object.freeze({
  left: '왼쪽 이동', right: '오른쪽 이동', bump: '리시브', set: '토스', hit: '스파이크·서브', block: '블로킹', jump: '점프',
});

const cloneDefaults = () => Object.fromEntries(
  Object.entries(DEFAULT_BINDINGS).map(([profile, values]) => [profile, { ...values }]),
);

export function loadBindings() {
  const defaults = cloneDefaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    for (const [profile, values] of Object.entries(defaults)) {
      for (const action of Object.keys(values)) {
        const code = saved?.[profile]?.[action];
        if (isBindableCode(code)) {
          const groups = profile === 'solo' ? ['solo'] : ['p1', 'p2'];
          const old = values[action];
          for (const otherProfile of groups) for (const otherAction of Object.keys(defaults[otherProfile])) {
            if ((otherProfile !== profile || otherAction !== action) && defaults[otherProfile][otherAction] === code) defaults[otherProfile][otherAction] = old;
          }
          values[action] = code;
        }
      }
    }
  } catch { /* 저장소를 쓸 수 없거나 값이 깨졌으면 기본값 */ }
  return defaults;
}

export function saveBindings(bindings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings)); } catch { /* 기본값/메모리 설정으로 계속 */ }
}

export function resetBindings() { return cloneDefaults(); }

export function assignBinding(bindings, profile, action, code) {
  const group = bindings[profile];
  if (!group || !(action in group) || !isBindableCode(code)) return false;
  const profiles = profile === 'solo' ? ['solo'] : ['p1', 'p2'];
  const old = group[action];
  for (const otherProfile of profiles) for (const otherAction of Object.keys(bindings[otherProfile])) {
    if ((otherProfile !== profile || otherAction !== action) && bindings[otherProfile][otherAction] === code) bindings[otherProfile][otherAction] = old;
  }
  group[action] = code;
  saveBindings(bindings);
  return true;
}

export function keyName(code) {
  const exact = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: '스페이스',
    Enter: '엔터', Escape: 'Esc', Numpad0: '숫자패드 0', Numpad1: '숫자패드 1',
    Numpad2: '숫자패드 2', Numpad3: '숫자패드 3', Numpad4: '숫자패드 4',
  };
  if (exact[code]) return exact[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `숫자패드 ${code.slice(6)}`;
  return code.replace(/^Key|^Digit/, '');
}

export function actionForCode(profile, code) {
  return Object.keys(profile).find(action => profile[action] === code) ?? null;
}

export function compactHelp(profile, movementAliases = '') {
  const movement = `${keyName(profile.left)} ${keyName(profile.right)} 이동${movementAliases}`;
  return `${movement} · ${keyName(profile.bump)} 리시브 · ${keyName(profile.set)} 토스 · ${keyName(profile.hit)} 스파이크/서브 · ${keyName(profile.block)} 블로킹 · ${keyName(profile.jump)} 점프`;
}
