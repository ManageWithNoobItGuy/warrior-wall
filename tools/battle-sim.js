/**
 * Balance check for the arena.
 *
 * Runs a lot of tournaments and asks one question: does answering the quiz
 * well actually decide who wins, or is it a coin toss with extra steps?
 *
 * The target is roughly 70:30 skill to luck. Below about 60 and the quiz is
 * decoration; above about 85 and the weakest student in the room knows they
 * cannot win before the first punch is thrown, which is worse.
 *
 *   node tools/battle-sim.js [rooms] [studentsPerRoom]
 */

import { runBattle, defaultStance, makeRng, STANCE_IDS } from '../lib/rpg/battle.js';
import { rollBirthStats, startingStats, seededRandom, CLASS_MODIFIERS } from '../lib/rpg/classes.js';
import { addStats, awardStatsForQuestion, normalizeStats, DEFAULT_SETTINGS } from '../lib/rpg/stats.js';

const ROOMS = Number(process.argv[2]) || 400;
const CLASS_SIZE = Number(process.argv[3]) || 24;
const QUESTIONS = 10;
const JOBS = Object.keys(CLASS_MODIFIERS);

/** One student, with a fixed ability that decides how often they answer well. */
function makeRoom(roomSeed) {
  const rng = makeRng(roomSeed);
  return [...Array(CLASS_SIZE)].map((_, i) => {
    const id = `p${i}`;
    const roll = rollBirthStats(seededRandom(`${roomSeed}:${id}`));
    return {
      playerId: id,
      // Ability spread across the class: 0 = never knows it, 1 = always does.
      ability: 0.15 + rng() * 0.8,
      job: JOBS[Math.floor(rng() * JOBS.length)],
      stats: startingStats(JOBS[Math.floor(rng() * JOBS.length)], roll),
      correct: 0,
    };
  });
}

/** Plays the quiz, awarding stats exactly as the room does. */
function runQuiz(room, rng) {
  const streaks = new Map();
  for (let q = 0; q < QUESTIONS; q++) {
    const answers = room.map((p) => {
      const correct = rng() < p.ability;
      // Students who know the answer tend to answer sooner.
      const elapsedMs = Math.round((correct ? 0.15 + rng() * 0.5 : 0.4 + rng() * 0.6) * 25_000);
      return { playerId: p.playerId, choiceIdx: correct ? 0 : 1, elapsedMs, correct };
    });

    for (const a of answers) {
      streaks.set(a.playerId, a.correct ? (streaks.get(a.playerId) ?? 0) + 1 : 0);
    }
    const awards = awardStatsForQuestion(answers, streaks, DEFAULT_SETTINGS);
    for (const award of awards) {
      const p = room.find((x) => x.playerId === award.playerId);
      p.stats = addStats(p.stats, award.gained);
      if (answers.find((a) => a.playerId === p.playerId).correct) p.correct++;
    }
  }
}

let topHalfWins = 0;
let strongestWins = 0;
const spearman = [];

for (let r = 0; r < ROOMS; r++) {
  const seed = `sim-${r}`;
  const room = makeRoom(seed);
  runQuiz(room, makeRng(`${seed}:quiz`));

  const fighters = room.map((p) => ({
    playerId: p.playerId,
    name: p.playerId,
    classId: p.job,
    avatarUrl: null,
    stats: normalizeStats(p.stats, QUESTIONS),
    // Stances are a real coin toss in practice: most of a room picks without
    // knowing what anyone else picked.
    stance: STANCE_IDS[Math.floor(makeRng(`${seed}:${p.playerId}:s`)() * 3)] ?? defaultStance(seed, p.playerId),
  }));

  const result = runBattle(fighters, `${seed}:battle`);
  const byQuiz = [...room].sort((a, b) => b.correct - a.correct);
  const champion = result.championId;

  if (byQuiz.slice(0, Math.ceil(CLASS_SIZE / 2)).some((p) => p.playerId === champion)) topHalfWins++;
  if (byQuiz[0].playerId === champion) strongestWins++;

  // Rank correlation between how well they answered and where they finished.
  const quizRank = new Map(byQuiz.map((p, i) => [p.playerId, i + 1]));
  const n = result.ranking.length;
  const d2 = result.ranking.reduce(
    (sum, e) => sum + (quizRank.get(e.playerId) - e.rank) ** 2,
    0,
  );
  spearman.push(1 - (6 * d2) / (n * (n * n - 1)));
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (n) => `${((n / ROOMS) * 100).toFixed(1)}%`;

console.log(`\n${ROOMS} rooms × ${CLASS_SIZE} students × ${QUESTIONS} questions\n`);
console.log(`  champion came from the better-answering half   ${pct(topHalfWins)}   (chance: 50%)`);
console.log(`  champion was the single best answerer          ${pct(strongestWins)}   (chance: ${(100 / CLASS_SIZE).toFixed(1)}%)`);
console.log(`  quiz rank vs finishing rank (Spearman)         ${mean(spearman).toFixed(3)}`);
console.log(
  `\n  Reading: 1.0 would mean the quiz decides everything and the arena is\n` +
    `  theatre; 0.0 would mean the quiz never mattered. Somewhere around 0.3-0.5\n` +
    `  is the intended feel — answering well is a real edge, not a guarantee.\n`,
);
