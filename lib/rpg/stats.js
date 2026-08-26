/**
 * Character stats and the rules that grow them.
 *
 * Ported from the RPG-Seminar build (src/shared/game.ts) with the types
 * stripped. Everything here is a pure function with no I/O, so the balance
 * simulator in tools/ can run it under plain `node` without a Worker.
 */

/** Where everyone starts. Answer nothing all class and you can still fight. */
export const BASE_STATS = { hp: 100, atk: 10, def: 10, spd: 10, luk: 5 };

export const STAT_KEYS = ['hp', 'atk', 'def', 'spd', 'luk'];

/** Question count the battle normalises to, so a 5-question class and a
 *  20-question class produce characters of comparable power. */
export const BASELINE_QUESTION_COUNT = 10;

export const DEFAULT_SETTINGS = {
  defaultTimeLimitSec: 25,
  scoring: { correct: 100, speedBonusMax: 50, wrong: 10 },
  statAward: { correctHp: 8, fastSpd: 4, hardAtk: 5, streakDef: 4, participationLuk: 1 },
  criteria: { fastPercentile: 0.25, hardWrongRatio: 0.5, streakThreshold: 3 },
  birthRoll: { min: 6, max: 12 },
};

/**
 * Points for one answer: a flat amount for being right, plus a speed bonus
 * that decays with the clock. Wrong still pays a little — a student who is
 * already behind at question two has no reason to keep playing otherwise.
 */
export function scoreAnswer(correct, elapsedMs, limitMs, settings = DEFAULT_SETTINGS) {
  const { correct: base, speedBonusMax, wrong } = settings.scoring;
  if (!correct) return wrong;
  const remaining = Math.max(0, limitMs - elapsedMs);
  const bonus = Math.round(speedBonusMax * (remaining / Math.max(1, limitMs)));
  return base + bonus;
}

/**
 * Hands out stats after a question closes — not as each answer arrives.
 *
 * Two of the criteria ("fastest quarter of the room", "a question most people
 * got wrong") cannot be judged until every answer is in, so the whole award
 * step has to wait for the question to close.
 *
 * @param answers        every answer to this question
 * @param streakByPlayer correct-in-a-row per player, this question included
 */
export function awardStatsForQuestion(answers, streakByPlayer, settings = DEFAULT_SETTINGS) {
  const award = settings.statAward;
  const crit = settings.criteria;

  const correctAnswers = answers
    .filter((a) => a.correct)
    .sort((a, b) => a.elapsedMs - b.elapsedMs);

  const isHardQuestion =
    answers.length > 0 &&
    (answers.length - correctAnswers.length) / answers.length > crit.hardWrongRatio;

  // Fastest quarter of those who got it right — always at least one person.
  const fastCutoff =
    correctAnswers.length > 0 ? Math.ceil(correctAnswers.length * crit.fastPercentile) : 0;
  const fastPlayers = new Set(correctAnswers.slice(0, fastCutoff).map((a) => a.playerId));

  return answers.map((a) => {
    const gained = {};
    const reasons = [];

    // Everyone who pressed anything gets LUK, wrong answers included.
    gained.luk = award.participationLuk;

    if (a.correct) {
      gained.hp = award.correctHp;
      reasons.push('Correct');

      if (fastPlayers.has(a.playerId)) {
        gained.spd = award.fastSpd;
        reasons.push('Among the fastest');
      }
      if (isHardQuestion) {
        gained.atk = award.hardAtk;
        reasons.push('Right where most were wrong');
      }
      const streak = streakByPlayer.get(a.playerId) ?? 0;
      if (streak >= crit.streakThreshold) {
        gained.def = award.streakDef;
        reasons.push(`${streak} in a row`);
      }
    }

    return { playerId: a.playerId, gained, reasons };
  });
}

export function addStats(base, gained) {
  return {
    hp: base.hp + (gained.hp ?? 0),
    atk: base.atk + (gained.atk ?? 0),
    def: base.def + (gained.def ?? 0),
    spd: base.spd + (gained.spd ?? 0),
    luk: base.luk + (gained.luk ?? 0),
  };
}

/**
 * Rescale a character as though the class had asked exactly
 * BASELINE_QUESTION_COUNT questions.
 *
 * Used only when a battle is computed, never for the numbers on screen during
 * the quiz — watching the raw totals climb is the whole feeling of levelling
 * up, and normalising them live would flatten it.
 */
export function normalizeStats(raw, questionCount) {
  if (questionCount <= 0) return { ...BASE_STATS };
  const k = BASELINE_QUESTION_COUNT / questionCount;
  const scale = (v, base) => Math.round(base + (v - base) * k);
  return {
    hp: Math.max(1, scale(raw.hp, BASE_STATS.hp)),
    atk: Math.max(1, scale(raw.atk, BASE_STATS.atk)),
    def: Math.max(0, scale(raw.def, BASE_STATS.def)),
    spd: Math.max(1, scale(raw.spd, BASE_STATS.spd)),
    luk: Math.max(0, scale(raw.luk, BASE_STATS.luk)),
  };
}

/** Clamps instructor-supplied settings into the range the balance was measured
 *  in. Values are squeezed rather than rejected: mid-class is the worst
 *  possible time to be hunting for which field failed validation. */
export function sanitizeSettings(input) {
  const raw = input ?? {};
  const d = DEFAULT_SETTINGS;
  const s = raw.scoring ?? {};
  const a = raw.statAward ?? {};
  const c = raw.criteria ?? {};
  const b = raw.birthRoll ?? {};

  const clamp = (v, lo, hi, fallback) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
  };
  const min = clamp(b.min, 0, 60, d.birthRoll.min);

  return {
    defaultTimeLimitSec: clamp(raw.defaultTimeLimitSec, 5, 300, d.defaultTimeLimitSec),
    scoring: {
      correct: clamp(s.correct, 0, 1000, d.scoring.correct),
      speedBonusMax: clamp(s.speedBonusMax, 0, 1000, d.scoring.speedBonusMax),
      wrong: clamp(s.wrong, 0, 1000, d.scoring.wrong),
    },
    statAward: {
      correctHp: clamp(a.correctHp, 0, 100, d.statAward.correctHp),
      fastSpd: clamp(a.fastSpd, 0, 100, d.statAward.fastSpd),
      hardAtk: clamp(a.hardAtk, 0, 100, d.statAward.hardAtk),
      streakDef: clamp(a.streakDef, 0, 100, d.statAward.streakDef),
      participationLuk: clamp(a.participationLuk, 0, 100, d.statAward.participationLuk),
    },
    criteria: {
      fastPercentile: clamp(c.fastPercentile, 0.01, 1, d.criteria.fastPercentile),
      hardWrongRatio: clamp(c.hardWrongRatio, 0.01, 1, d.criteria.hardWrongRatio),
      streakThreshold: clamp(c.streakThreshold, 1, 20, d.criteria.streakThreshold),
    },
    // max below min would make the roll span negative and every roll NaN.
    birthRoll: { min, max: clamp(b.max, min, 60, Math.max(min, d.birthRoll.max)) },
  };
}
