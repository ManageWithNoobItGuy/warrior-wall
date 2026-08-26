/**
 * Class stat modifiers and the birth roll.
 *
 * The five class ids match `JOBS` in lib/gemini.js exactly — that file owns
 * how a class *looks* (card palette, avatar prompt), this one owns how it
 * *fights*. Splitting them keeps the image prompts out of the battle code and
 * lets the balance simulator import this file on its own.
 *
 * The numbers come from RPG-Seminar's six-class table, mapped onto these five:
 * knight takes guardian's line, healer takes scholar's. Total weight is close
 * enough across all five that no class is the obvious pick.
 */

import { BASE_STATS, STAT_KEYS, DEFAULT_SETTINGS } from './stats.js';

export const CLASS_MODIFIERS = {
  warrior: { hp: 10, atk: 4, def: 2, spd: -2 },
  knight: { hp: 20, atk: -2, def: 6, spd: -2 },
  thief: { hp: -5, atk: 2, def: -3, spd: 6, luk: 2 },
  mage: { hp: -10, atk: 6, def: -2, spd: 1, luk: 3 },
  healer: { atk: 1, def: 1, spd: 1, luk: 5 },
};

/** One point of fate buys four HP, because HP is counted in bigger units than
 *  the other four stats and a flat point would be invisible. */
const HP_MULTIPLIER = 4;

/**
 * Rolls the points a character is born with.
 *
 * @param random 0..1 source — crypto on the server, a seeded PRNG in the
 *               balance simulator so a run can be replayed.
 */
export function rollBirthStats(random, settings = DEFAULT_SETTINGS) {
  const { min, max } = settings.birthRoll;
  const span = Math.max(1, max - min + 1);
  const points = min + Math.floor(random() * span);

  const gained = {};
  for (let i = 0; i < points; i++) {
    const key = STAT_KEYS[Math.floor(random() * STAT_KEYS.length)];
    const amount = key === 'hp' ? HP_MULTIPLIER : 1;
    gained[key] = (gained[key] ?? 0) + amount;
  }
  return { points, gained };
}

/** Starting line = base + class + fate. */
export function startingStats(classId, roll) {
  const mod = CLASS_MODIFIERS[classId] ?? {};
  const sum = (k) => BASE_STATS[k] + (mod[k] ?? 0) + (roll?.gained?.[k] ?? 0);
  return { hp: sum('hp'), atk: sum('atk'), def: sum('def'), spd: sum('spd'), luk: sum('luk') };
}

/** A label for the roll, so opening your character feels like opening
 *  something rather than reading a table. */
export function rollTier(points) {
  if (points >= 11) return { label: 'BLESSED BY FATE', tone: 'great' };
  if (points >= 9) return { label: 'FORTUNE FAVOURS YOU', tone: 'good' };
  return { label: 'AN ORDINARY FATE', tone: 'normal' };
}

/** A deterministic 0..1 source keyed off a string, so a character rebuilt from
 *  the same student id and session comes out identical. Without this, a
 *  student who reloads mid-class would reroll into a different character. */
export function seededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < String(seed).length; i++) {
    h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
