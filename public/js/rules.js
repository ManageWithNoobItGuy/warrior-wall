/**
 * The presentation half of the battle rules, fetched from the server.
 *
 * Move names, stance icons and the wave timings all exist in lib/rpg on the
 * server. Copying them into the page would work right up until someone renames
 * a move or retunes a beat and changes only one of the two — so the page asks
 * for them instead, once, at load.
 *
 * The wave timings matter most: the projector interpolates positions against
 * exactly the numbers the server used to build the timeline. A local copy that
 * drifted by 200ms would show health bars finishing before the fighters do.
 */

const FALLBACK = {
  stances: [
    { id: 'attack', name: 'STRIKE', blurb: 'ATK ×1.5, DEF ×0.7', icon: '⚔️' },
    { id: 'defend', name: 'GUARD', blurb: 'DEF ×1.5, ATK ×0.7', icon: '🛡️' },
    { id: 'magic', name: 'CAST', blurb: 'Triple crit, wild damage', icon: '✨' },
  ],
  skills: {},
  modifiers: {},
  wave: { enterMs: 1400, clashMs: 3400, settleMs: 1200 },
};

let loaded = FALLBACK;
try {
  const res = await fetch('/api/game/rules');
  if (res.ok) loaded = { ...FALLBACK, ...(await res.json()) };
} catch {
  // Offline or mid-deploy. The fallback keeps the arena drawing; only the
  // flavour names are lost.
}

export const STANCES = loaded.stances;
export const SKILLS = loaded.skills;
export const CLASS_MODIFIERS = loaded.modifiers;
export const WAVE = loaded.wave;
export const WAVE_TOTAL_MS = WAVE.enterMs + WAVE.clashMs + WAVE.settleMs;

export function stanceById(id) {
  return STANCES.find((s) => s.id === id) ?? STANCES[0];
}

export function stanceIcon(id) {
  return STANCES.find((s) => s.id === id)?.icon ?? '⚔️';
}

export function skillOf(classId, stance) {
  const table = SKILLS[classId] ?? SKILLS.healer;
  return table?.[stance] ?? { name: stanceById(stance).name, icon: stanceIcon(stance), flavor: '' };
}

/** Who is still in the field at the start of `round`. */
export function aliveAtRound(result, round) {
  return result.ranking
    .filter((r) => r.eliminatedRound === 0 || r.eliminatedRound >= round)
    .map((r) => r.playerId);
}

export const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'luk'];
export const STAT_LABELS = { hp: 'HP', atk: 'ATK', def: 'DEF', spd: 'SPD', luk: 'LUK' };
/** Bar ceilings, picked so a typical end-of-class character fills most of the
 *  bar without anyone ever pinning it. */
export const STAT_MAX = { hp: 260, atk: 45, def: 40, spd: 45, luk: 30 };
