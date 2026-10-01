// 캐릭터의 보이는 별점과 경기 계산이 같은 값을 쓰도록 한곳에 둔다.
// 별점은 1~5, 0.5단위로만 허용하며 3이 기존 성능(1.0배)이다.
export const CHARACTER_PROFILES = Object.freeze({
  ara: Object.freeze({ name: '아라', number: 1, type: '균형형', height: 1.68,
    stats: Object.freeze({ attack: 3, defense: 3, agility: 3, jump: 3, accuracy: 3 }) }),
  min: Object.freeze({ name: '민', number: 2, type: '공격형', height: 1.82,
    stats: Object.freeze({ attack: 4.5, defense: 2, agility: 2.5, jump: 4, accuracy: 2 }) }),
  sori: Object.freeze({ name: '소리', number: 3, type: '수비형', height: 1.60,
    stats: Object.freeze({ attack: 2, defense: 4.5, agility: 4.5, jump: 2, accuracy: 2 }) }),
  jun: Object.freeze({ name: '준', number: 4, type: '기술형', height: 1.74,
    stats: Object.freeze({ attack: 2.5, defense: 2.5, agility: 2.5, jump: 3, accuracy: 4.5 }) }),
});

export const STAT_LABELS = Object.freeze({ attack: '공격', defense: '수비', agility: '민첩', jump: '점프', accuracy: '정확' });
export const DEFAULT_CHARACTER = 'ara';
export const NEUTRAL_EFFECTS = Object.freeze({
  attack: 1, receiveError: 1, receiveChance: 0, agility: 1, reach: 1,
  accuracyError: 1, jumpHeight: .9, highContactOffset: 0, blockBonus: 0,
});

export function characterProfile(name) {
  return CHARACTER_PROFILES[name] ?? CHARACTER_PROFILES[DEFAULT_CHARACTER];
}

export function validRating(value) {
  return Number.isFinite(value) && value >= 1 && value <= 5 && value * 2 === Math.round(value * 2);
}

export function statMultiplier(value, step) {
  return 1 + (value - 3) * step;
}

export function characterEffects(name) {
  const profile = characterProfile(name), s = profile.stats;
  return {
    attack: statMultiplier(s.attack, .04),
    receiveError: statMultiplier(s.defense, -.08),
    receiveChance: (s.defense - 3) * .03,
    agility: statMultiplier(s.agility, .05),
    reach: statMultiplier(s.agility, .04),
    accuracyError: statMultiplier(s.accuracy, -.08),
    jumpHeight: .9 + (s.jump - 3) * .08,
    highContactOffset: (profile.height - 1.75) * .55 + (s.jump - 3) * .08,
    blockBonus: (s.jump - 3) * .035 + (profile.height - 1.75) * .12,
  };
}

export function characterOrder(choices, competitive = false) {
  const roster = Object.keys(CHARACTER_PROFILES);
  const safe = [choices?.[0], choices?.[1]].map((name, i) => roster.includes(name) ? name : roster[i]);
  if (safe[0] === safe[1]) safe[1] = roster.find(name => name !== safe[0]);
  const picked = new Set(safe), opponents = roster.filter(name => !picked.has(name));
  return competitive
    ? [safe[0], opponents[0], safe[1], opponents[1]]
    : [safe[0], safe[1], opponents[0], opponents[1]];
}
