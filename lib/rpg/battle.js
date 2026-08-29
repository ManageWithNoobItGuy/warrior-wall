/**
 * Battle royale — single-elimination, everyone in one arena.
 *
 * Ported from RPG-Seminar (src/shared/battle.ts). Pure functions only: the
 * whole tournament is computed the instant the instructor presses START, and
 * the animation on the projector is a retelling of a timeline that already
 * exists. That is what lets a projector which reconnects halfway through pick
 * up at exactly the right moment instead of replaying from the beginning.
 */

/** @typedef {'attack'|'defend'|'magic'} Stance */

export const STANCES = [
  { id: 'attack', name: 'STRIKE', blurb: 'ATK ×1.5, DEF ×0.7', icon: '⚔️' },
  { id: 'defend', name: 'GUARD', blurb: 'DEF ×1.5, ATK ×0.7', icon: '🛡️' },
  { id: 'magic', name: 'CAST', blurb: 'Triple crit, wild damage', icon: '✨' },
];

export const STANCE_IDS = STANCES.map((s) => s.id);

export function isStance(v) {
  return typeof v === 'string' && STANCE_IDS.includes(v);
}

export function stanceIcon(id) {
  return STANCES.find((s) => s.id === id)?.icon ?? '⚔️';
}

/** Strike beats Cast · Cast beats Guard · Guard beats Strike. */
const BEATS = { attack: 'magic', magic: 'defend', defend: 'attack' };

const STANCE_MOD = {
  attack: { atk: 1.5, def: 0.7, crit: 1, swing: 0 },
  defend: { atk: 0.7, def: 1.5, crit: 1, swing: 0 },
  magic: { atk: 1.0, def: 1.0, crit: 3, swing: 0.3 },
};

/** Counter bonuses are deliberately loud. The original 1.2/0.85 was quiet
 *  enough that players felt their choice of stance made no difference. */
const RPS_WIN = 1.45;
const RPS_LOSE = 0.72;
const MAX_ROUNDS = 12;

// ─── reproducible randomness ────────────────────────────────────────────────

/** mulberry32 — small, fast, and identical for a given seed, so a battle can
 *  be recomputed later and come out the same way. */
export function makeRng(seed) {
  const s = String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
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

/**
 * The stance assigned to someone who never picked one — drawn from the seed
 * rather than fixed. A constant would put everyone who was slow, offline, or
 * away from their phone on the same stance, which is an edge worth exploiting.
 */
export function defaultStance(seed, playerId) {
  const r = makeRng(`${seed}:${playerId}:stance`)();
  return STANCES[Math.floor(r * STANCES.length)].id;
}

// ─── one duel ───────────────────────────────────────────────────────────────

function rpsFactor(mine, theirs) {
  if (mine === theirs) return 1;
  return BEATS[mine] === theirs ? RPS_WIN : RPS_LOSE;
}

function runMatch(a, b, rng) {
  const mods = { [a.playerId]: STANCE_MOD[a.stance], [b.playerId]: STANCE_MOD[b.stance] };
  const rps = {
    [a.playerId]: rpsFactor(a.stance, b.stance),
    [b.playerId]: rpsFactor(b.stance, a.stance),
  };

  const hp = { [a.playerId]: a.stats.hp, [b.playerId]: b.stats.hp };
  const damage = { [a.playerId]: 0, [b.playerId]: 0 };
  const log = [];
  let exchanges = 0;
  let crits = 0;

  // Higher SPD swings first; ties break on LUK, then on id so the result is
  // reproducible rather than dependent on argument order.
  const first =
    a.stats.spd !== b.stats.spd
      ? a.stats.spd > b.stats.spd
        ? a
        : b
      : a.stats.luk !== b.stats.luk
        ? a.stats.luk > b.stats.luk
          ? a
          : b
        : a.playerId < b.playerId
          ? a
          : b;
  const second = first === a ? b : a;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (const [atk, def] of [
      [first, second],
      [second, first],
    ]) {
      if (hp[atk.playerId] <= 0 || hp[def.playerId] <= 0) continue;

      const m = mods[atk.playerId];
      const critChance = Math.min(0.75, (atk.stats.luk / 200) * m.crit);
      const isCrit = rng() < critChance;
      if (isCrit) crits++;

      const effAtk = atk.stats.atk * m.atk * rps[atk.playerId];
      const effDef = def.stats.def * mods[def.playerId].def;
      // Casting swings ±30%. Wider than that and the duel becomes a coin toss.
      const swing = m.swing ? 1 + (rng() * 2 - 1) * m.swing : 1;

      const dmg = Math.max(1, Math.round((effAtk * (1 + (isCrit ? 1 : 0)) - effDef * 0.5) * swing));
      hp[def.playerId] -= dmg;
      damage[atk.playerId] += dmg;
      log.push({ a: atk.playerId === a.playerId ? 0 : 1, d: dmg, c: isCrit ? 1 : 0 });
      exchanges++;
    }
    if (hp[a.playerId] <= 0 || hp[b.playerId] <= 0) break;
  }

  // Both still standing after the round cap: highest remaining %HP takes it.
  const ratio = (f) => hp[f.playerId] / Math.max(1, f.stats.hp);
  let winner;
  if (hp[a.playerId] <= 0 && hp[b.playerId] <= 0) winner = ratio(a) >= ratio(b) ? a : b;
  else if (hp[a.playerId] <= 0) winner = b;
  else if (hp[b.playerId] <= 0) winner = a;
  else winner = ratio(a) >= ratio(b) ? a : b;

  const loser = winner === a ? b : a;
  const edgeFactor = rps[winner.playerId];

  return {
    winner,
    loser,
    damage,
    result: {
      aId: a.playerId,
      bId: b.playerId,
      winnerId: winner.playerId,
      loserId: loser.playerId,
      winnerHpLeft: Math.max(0, hp[winner.playerId]),
      winnerHpMax: winner.stats.hp,
      exchanges,
      crits,
      hpA: a.stats.hp,
      hpB: b.stats.hp,
      log,
      stanceEdge: edgeFactor > 1 ? 'win' : edgeFactor < 1 ? 'lose' : 'even',
    },
  };
}

// ─── the whole bracket ──────────────────────────────────────────────────────

/**
 * Single elimination. An odd number of survivors means someone gets a bye that
 * wave; pairings are redrawn from the seed every wave rather than fixed at the
 * start, so the later rounds are not already decided before the first punch.
 */
export function runBattle(fighters, seed) {
  const rng = makeRng(seed);
  const matches = [];
  const damageTotal = {};
  const eliminatedRound = {};

  if (fighters.length === 0) return { seed, matches, ranking: [], championId: null };
  if (fighters.length === 1) {
    return {
      seed,
      matches,
      ranking: [{ playerId: fighters[0].playerId, rank: 1, eliminatedRound: 0, damageDealt: 0 }],
      championId: fighters[0].playerId,
    };
  }

  // Sort by id first so the shuffle below starts from the same place every
  // time, whatever order the players arrived in.
  let alive = [...fighters].sort((a, b) => (a.playerId < b.playerId ? -1 : 1));
  alive = alive
    .map((f) => ({ f, k: rng() }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.f);

  let round = 1;
  while (alive.length > 1) {
    alive = alive
      .map((f) => ({ f, k: rng() }))
      .sort((x, y) => x.k - y.k)
      .map((x) => x.f);

    const next = [];
    const bye = alive.length % 2 === 1 ? alive.pop() : null;

    for (let i = 0; i < alive.length; i += 2) {
      const out = runMatch(alive[i], alive[i + 1], rng);
      matches.push({ round, ...out.result });
      for (const [id, d] of Object.entries(out.damage)) {
        damageTotal[id] = (damageTotal[id] ?? 0) + d;
      }
      eliminatedRound[out.loser.playerId] = round;
      next.push(out.winner);
    }

    if (bye) next.push(bye);
    alive = next;
    round++;
  }

  const champion = alive[0];
  eliminatedRound[champion.playerId] = 0;

  // Surviving longer ranks higher; ties break on total damage dealt.
  const ranking = fighters
    .map((f) => ({
      playerId: f.playerId,
      rank: 0,
      eliminatedRound: eliminatedRound[f.playerId] ?? 0,
      damageDealt: damageTotal[f.playerId] ?? 0,
    }))
    .sort((a, b) => {
      if (a.eliminatedRound === 0) return -1;
      if (b.eliminatedRound === 0) return 1;
      if (a.eliminatedRound !== b.eliminatedRound) return b.eliminatedRound - a.eliminatedRound;
      return b.damageDealt - a.damageDealt;
    })
    .map((e, i) => ({ ...e, rank: i + 1 }));

  return { seed, matches, ranking, championId: champion.playerId };
}

// ─── the timeline the projector plays ───────────────────────────────────────

/** Beats of one wave. */
export const WAVE = {
  /** Walk into position and announce the move. */
  enterMs: 1400,
  /** The exchange itself — health bars tick down across this whole span. */
  clashMs: 3400,
  /** Losers drop, winners reset. */
  settleMs: 1200,
};
export const WAVE_TOTAL_MS = WAVE.enterMs + WAVE.clashMs + WAVE.settleMs;

/** The final duel runs slower than the rest — it is the beat the room holds
 *  its breath through. */
const FINAL_EXTRA_MS = 3000;

const RANK_FAST_MS = 320;
/** The last five places slow down one after another. */
const TOP5_MS = [1200, 1300, 1500, 1800, 2400];
/** Only the top ten are read out. Reading fifty places to a room loses it long
 *  before it reaches anyone interesting; everyone else sees their own place on
 *  their phone. */
export const RANKS_ON_SCREEN = 10;

export function buildTimeline(result) {
  const items = [];
  let t = 1600; // title card and the walk-on

  const rounds = [...new Set(result.matches.map((m) => m.round))].sort((a, b) => a - b);
  rounds.forEach((round, i) => {
    const isFinal = i === rounds.length - 1;
    items.push({ at: t, kind: 'wave', round });
    t += WAVE_TOTAL_MS + (isFinal ? FINAL_EXTRA_MS : 0);
    items.push({ at: t, kind: 'waveEnd', round });
    t += 500;
  });

  t += 1200; // let the champion stand alone before the places are read

  const shown = Math.min(RANKS_ON_SCREEN, result.ranking.length);
  for (let rank = shown; rank >= 1; rank--) {
    const fromTop = rank - 1;
    items.push({ at: t, kind: 'rank', rank });
    t += fromTop < TOP5_MS.length ? TOP5_MS[fromTop] : RANK_FAST_MS;
  }

  items.push({ at: t, kind: 'champion' });
  // The champion card holds for this long before the show is over. The board
  // that follows repeats the standings, so there is no need to dwell here.
  return { items, totalMs: t + 2500 };
}

/** Who is still in the arena at the start of `round`. */
export function aliveAtRound(result, round) {
  return result.ranking
    .filter((r) => r.eliminatedRound === 0 || r.eliminatedRound >= round)
    .map((r) => r.playerId);
}
