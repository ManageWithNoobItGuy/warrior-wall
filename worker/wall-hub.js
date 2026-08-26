/**
 * WallHub — the live-update fan-out, and the room's game state.
 *
 * It started as a pure rendezvous point: Workers spreads requests across
 * isolates that share no memory, so the SSE subscriber list had to live
 * somewhere single-homed. The quiz needs the same property for a different
 * reason — "was this student in the fastest quarter of the room" is a question
 * only something that has seen every answer can settle.
 *
 * So the DO now holds both. State lives in memory for the hot path and is
 * written through to the DO's own SQLite storage, which is what makes it
 * survive an eviction mid-class. It is deliberately NOT in D1: fifty phones
 * answering inside two seconds would mean fifty D1 round trips, and the wall
 * would spend its whole CPU budget on network waits.
 */

import { DEFAULT_SETTINGS, addStats, awardStatsForQuestion, normalizeStats, scoreAnswer } from '../lib/rpg/stats.js';
import { rollBirthStats, startingStats, seededRandom, rollTier } from '../lib/rpg/classes.js';
import { buildTimeline, defaultStance, isStance, runBattle } from '../lib/rpg/battle.js';

/** Phases the room moves through. `lobby` is also where it sits between
 *  questions, so a student who joins late always lands somewhere valid. */
const PHASES = ['lobby', 'question', 'reveal', 'stance', 'battle', 'done'];

const EMPTY_GAME = {
  phase: 'lobby',
  sessionId: null,
  seed: null,
  /** index into the question list the instructor loaded, -1 = none open */
  questionIndex: -1,
  questionId: null,
  questionTotal: 0,
  questionText: null,
  questionChoices: null,
  correctIdx: null,
  explanation: null,
  timeLimitMs: 25_000,
  questionStartedAt: null,
  askedCount: 0,
  stanceOpenedAt: null,
  battleStartedAt: null,
  battleTotalMs: 0,
};

export class WallHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Set<WritableStreamDefaultWriter>} */
    this.subscribers = new Set();
    this.encoder = new TextEncoder();

    /** @type {Map<string, object>} studentId -> player */
    this.players = new Map();
    /** @type {Map<string, Map<string, object>>} questionId -> studentId -> answer */
    this.answers = new Map();
    this.game = { ...EMPTY_GAME };
    this.battle = null;

    // Loading before the first request is served is what lets every handler
    // below treat the in-memory copy as authoritative.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get(['game', 'battle']);
      this.game = { ...EMPTY_GAME, ...(stored.get('game') ?? {}) };
      this.battle = stored.get('battle') ?? null;

      const rows = await this.state.storage.list({ prefix: 'p:' });
      for (const [, player] of rows) this.players.set(player.studentId, player);

      const answerRows = await this.state.storage.list({ prefix: 'a:' });
      for (const [key, answer] of answerRows) {
        // key shape: a:<questionId>:<studentId>
        const questionId = key.slice(2, key.lastIndexOf(':'));
        if (!this.answers.has(questionId)) this.answers.set(questionId, new Map());
        this.answers.get(questionId).set(answer.playerId, answer);
      }
    });
  }

  // ------------------------------------------------------------------ router

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    switch (path) {
      case '/subscribe':
        return this.subscribe();
      case '/publish':
        this.broadcast(body.event, body.payload);
        return noContent();

      // ---- player
      case '/join':
        return json(await this.join(body));
      case '/me':
        return json(this.me(url.searchParams.get('studentId'), url.searchParams.get('token')));
      case '/answer':
        return json(await this.answer(body));
      case '/stance':
        return json(await this.setStance(body));
      case '/portrait':
        return json(await this.markPortrait(body));

      // ---- read models
      case '/game':
        return json(this.publicGame());
      case '/roster':
        return json({ players: this.roster(), count: this.players.size });
      case '/battle':
        return json(this.battlePayload());

      // ---- instructor
      case '/admin/open':
        return json(await this.openQuestion(body));
      case '/admin/close':
        return json(await this.closeQuestion());
      case '/admin/stance':
        return json(await this.openStance());
      case '/admin/battle':
        return json(await this.startBattle(body));
      case '/admin/lobby':
        return json(await this.backToLobby());
      case '/admin/reset':
        return json(await this.reset(body));
      default:
        return new Response('not found', { status: 404 });
    }
  }

  // ------------------------------------------------------------------ SSE

  subscribe() {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    this.subscribers.add(writer);

    writer.write(this.encoder.encode('retry: 3000\n\n')).catch(() => this.drop(writer));

    // Proxies and phones both drop a stream that goes quiet; a comment line
    // every 25s keeps it open without waking any page code.
    const ping = setInterval(() => {
      writer.write(this.encoder.encode(': ping\n\n')).catch(() => {
        clearInterval(ping);
        this.drop(writer);
      });
    }, 25_000);

    writer.closed.catch(() => {}).finally(() => {
      clearInterval(ping);
      this.drop(writer);
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  broadcast(event, payload = {}) {
    if (!event) return;
    const frame = this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const writer of this.subscribers) {
      writer.write(frame).catch(() => this.drop(writer));
    }
  }

  drop(writer) {
    this.subscribers.delete(writer);
    try {
      writer.close();
    } catch {
      /* already gone */
    }
  }

  // ------------------------------------------------------------- persistence

  async saveGame() {
    await this.state.storage.put('game', this.game);
  }

  async savePlayer(player) {
    this.players.set(player.studentId, player);
    await this.state.storage.put(`p:${player.studentId}`, player);
  }

  /** Writes many players at once. Storage caps a single put() at 128 keys, so
   *  a class larger than that is chunked rather than silently truncated. */
  async savePlayers(list) {
    for (let i = 0; i < list.length; i += 100) {
      const batch = {};
      for (const p of list.slice(i, i + 100)) {
        this.players.set(p.studentId, p);
        batch[`p:${p.studentId}`] = p;
      }
      await this.state.storage.put(batch);
    }
  }

  // ------------------------------------------------------------------ player

  /**
   * Creates the character, or hands back the one this student already has.
   *
   * The birth roll is seeded from session + student id rather than drawn from
   * crypto, so a phone that reloads — or a student who retypes their id on a
   * borrowed handset — lands on the same character instead of rerolling into a
   * better one. The token is what stops someone else answering in their name.
   */
  async join({ sessionId, studentId, name, job, token }) {
    const id = String(studentId ?? '').trim().slice(0, 24);
    if (!id) return { error: 'studentId required' };

    // A new class session wipes the room. Checked here rather than in the
    // route so a stale phone posting an old session id cannot resurrect it.
    if (sessionId && this.game.sessionId && this.game.sessionId !== sessionId) {
      await this.reset({ sessionId });
    }
    if (!this.game.sessionId && sessionId) {
      this.game.sessionId = sessionId;
      this.game.seed = `${sessionId}:${Date.now()}`;
      await this.saveGame();
    }

    const existing = this.players.get(id);
    if (existing) {
      // Whoever types the id gets the character, on any device, at any point in
      // the lesson. The token is still carried so a phone can restore itself
      // silently on reload, but it is not a credential: a student whose battery
      // died has to be able to walk back in on a borrowed handset, and the
      // scores here decide nothing more than who is on screen. Anyone willing
      // to type a classmate's id can answer as them — an accepted trade.
      existing.token = token || existing.token;
      // Class is still changeable right up until the first question opens —
      // after that the stats already earned were earned as that class.
      if (job && job !== existing.job && this.game.askedCount === 0) {
        existing.job = job;
        const roll = { points: existing.rollPoints, gained: existing.rollGained };
        existing.stats = addStats(startingStats(job, roll), existing.earned);
        await this.savePlayer(existing);
        this.broadcast('roster', { count: this.players.size });
      }
      return { player: publicPlayer(existing), roll: rollTier(existing.rollPoints) };
    }

    const roll = rollBirthStats(seededRandom(`${this.game.sessionId ?? 'wall'}:${id}`));
    const player = {
      studentId: id,
      name: String(name ?? '').trim().slice(0, 40) || id,
      job: job ?? null,
      token: token || crypto.randomUUID(),
      rollPoints: roll.points,
      rollGained: roll.gained,
      /** what the quiz added on top of the starting line, kept apart so a class
       *  swap in the lobby recomputes the base without losing earned stats */
      earned: withZeroBase({}),
      stats: startingStats(job, roll),
      score: 0,
      streak: 0,
      bestStreak: 0,
      answered: 0,
      correct: 0,
      stance: null,
      rank: null,
      damage: 0,
      hasPortrait: false,
      portraitAt: 0,
      joinedAt: Date.now(),
    };
    await this.savePlayer(player);
    this.broadcast('roster', { count: this.players.size });
    return { player: publicPlayer(player), roll: rollTier(player.rollPoints) };
  }

  me(studentId, token) {
    const player = this.players.get(String(studentId ?? ''));
    if (!player) return { player: null, game: this.publicGame() };
    const lastAnswer = this.game.questionId
      ? (this.answers.get(this.game.questionId)?.get(player.studentId) ?? null)
      : null;
    return {
      player: publicPlayer(player),
      roll: rollTier(player.rollPoints),
      answered: Boolean(lastAnswer),
      choiceIdx: lastAnswer?.choiceIdx ?? null,
      lastGain: player.lastGain ?? null,
      game: this.publicGame(),
      total: this.players.size,
    };
  }

  /** The Worker streams the image into R2 itself; all the room needs to know
   *  is that a face exists, so the arena can ask for it. */
  async markPortrait({ studentId }) {
    const player = this.players.get(String(studentId ?? ''));
    if (!player) return { ok: false };
    player.hasPortrait = true;
    // The URL never changes, so without a version the browser keeps showing
    // the portrait it already cached — which is how a student who resummoned
    // an avatar still went into the arena wearing their old face.
    player.portraitAt = Date.now();
    await this.savePlayer(player);
    // The upload finishes after the sheet has already been drawn. Nothing else
    // would tell that page to look again.
    this.broadcast('portrait', { studentId: player.studentId, portraitAt: player.portraitAt });
    return { ok: true };
  }

  roster() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
      .map(publicPlayer);
  }

  // ------------------------------------------------------------------- quiz

  /** Opens a question. The text and choices are passed in by the Worker, which
   *  read them from D1 — the DO never talks to D1 itself. */
  async openQuestion({ question, index, total }) {
    if (!question?.id) return { error: 'question required' };

    this.game = {
      ...this.game,
      phase: 'question',
      questionIndex: Number(index ?? 0),
      questionTotal: Number(total ?? 0),
      questionId: question.id,
      questionText: question.text,
      questionChoices: question.choices,
      correctIdx: question.correctIdx,
      explanation: question.explanation ?? null,
      timeLimitMs: Math.max(5, Number(question.timeLimitSec) || 25) * 1000,
      questionStartedAt: Date.now(),
    };
    this.answers.set(question.id, new Map());
    await this.saveGame();

    // The correct index is withheld from the broadcast on purpose — anyone can
    // open devtools on a student phone and read whatever the stream carries.
    this.broadcast('question', {
      index: this.game.questionIndex,
      total: this.game.questionTotal,
      id: question.id,
      text: question.text,
      choices: question.choices,
      startedAt: this.game.questionStartedAt,
      timeLimitMs: this.game.timeLimitMs,
    });
    return { ok: true, game: this.publicGame() };
  }

  /**
   * Records one answer.
   *
   * `elapsedMs` is measured against the server's own start time, never a value
   * the phone sends — a client-supplied timer is a speed bonus anyone can
   * award themselves.
   */
  async answer({ studentId, token, choiceIdx }) {
    if (this.game.phase !== 'question') return { error: 'no question open', code: 'CLOSED' };
    const player = this.players.get(String(studentId ?? ''));
    if (!player) return { error: 'join first', code: 'NO_PLAYER' };

    const bucket = this.answers.get(this.game.questionId) ?? new Map();
    if (bucket.has(player.studentId)) return { error: 'already answered', code: 'DUPLICATE' };

    const idx = Number(choiceIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (this.game.questionChoices?.length ?? 0)) {
      return { error: 'bad choice', code: 'BAD_CHOICE' };
    }

    const elapsedMs = Math.max(0, Date.now() - this.game.questionStartedAt);
    // Late by more than a second and a half of grace is not an answer. The
    // grace covers the round trip from a phone on classroom wifi.
    if (elapsedMs > this.game.timeLimitMs + 1500) return { error: 'too late', code: 'LATE' };

    const record = {
      playerId: player.studentId,
      choiceIdx: idx,
      elapsedMs,
      correct: idx === this.game.correctIdx,
    };
    bucket.set(player.studentId, record);
    this.answers.set(this.game.questionId, bucket);
    await this.state.storage.put(`a:${this.game.questionId}:${player.studentId}`, record);

    this.broadcast('answered', { count: bucket.size, total: this.players.size });
    return { ok: true, answered: bucket.size, total: this.players.size };
  }

  /**
   * Closes the question and pays everyone out.
   *
   * Stat awards happen here, not as answers land, because two of the criteria
   * — "fastest quarter of the room" and "a question most people got wrong" —
   * cannot be judged until the last answer is in.
   */
  async closeQuestion() {
    if (!this.game.questionId) return { error: 'nothing open' };
    const bucket = this.answers.get(this.game.questionId) ?? new Map();
    const records = [...bucket.values()];

    // Streaks have to be updated before the awards are computed, since the
    // DEF award reads the streak that includes this very question.
    const streaks = new Map();
    for (const record of records) {
      const player = this.players.get(record.playerId);
      if (!player) continue;
      player.streak = record.correct ? player.streak + 1 : 0;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
      streaks.set(record.playerId, player.streak);
    }

    const awards = awardStatsForQuestion(records, streaks, DEFAULT_SETTINGS);
    const distribution = new Array(this.game.questionChoices?.length ?? 4).fill(0);

    for (const record of records) {
      distribution[record.choiceIdx] = (distribution[record.choiceIdx] ?? 0) + 1;
      const player = this.players.get(record.playerId);
      if (!player) continue;
      const award = awards.find((a) => a.playerId === record.playerId);
      const gained = award?.gained ?? {};
      // `earned` is a running delta, kept apart from `stats` so a class swap
      // back in the lobby can rebuild the starting line without losing it.
      player.earned = addStats(withZeroBase(player.earned), gained);
      player.stats = addStats(player.stats, gained);
      player.score += scoreAnswer(record.correct, record.elapsedMs, this.game.timeLimitMs);
      player.answered += 1;
      if (record.correct) player.correct += 1;
      player.lastGain = {
        gained: award?.gained ?? {},
        reasons: award?.reasons ?? [],
        correct: record.correct,
        correctIdx: this.game.correctIdx,
      };
    }

    // Everyone who sat this one out loses their streak too, otherwise putting
    // the phone down is a way to protect a streak.
    for (const player of this.players.values()) {
      if (!bucket.has(player.studentId)) {
        player.streak = 0;
        player.lastGain = null;
      }
    }

    this.game.phase = 'reveal';
    this.game.askedCount += 1;
    this.game.questionStartedAt = null;
    await this.savePlayers([...this.players.values()]);
    await this.saveGame();

    const payload = {
      id: this.game.questionId,
      correctIdx: this.game.correctIdx,
      explanation: this.game.explanation,
      distribution,
      answered: records.length,
      correct: records.filter((r) => r.correct).length,
      total: this.players.size,
      leaderboard: this.roster().slice(0, 8),
    };
    this.broadcast('reveal', payload);
    return { ok: true, ...payload };
  }

  async backToLobby() {
    this.game = {
      ...this.game,
      phase: 'lobby',
      questionId: null,
      questionText: null,
      questionChoices: null,
      correctIdx: null,
      explanation: null,
      questionStartedAt: null,
    };
    await this.saveGame();
    this.broadcast('phase', { phase: 'lobby' });
    return { ok: true };
  }

  // ------------------------------------------------------------------ battle

  async openStance() {
    this.game.phase = 'stance';
    this.game.stanceOpenedAt = Date.now();
    await this.saveGame();
    this.broadcast('stance', { openedAt: this.game.stanceOpenedAt });
    return { ok: true };
  }

  async setStance({ studentId, stance }) {
    const player = this.players.get(String(studentId ?? ''));
    if (!player) return { error: 'join first', code: 'NO_PLAYER' };
    if (!isStance(stance)) return { error: 'bad stance', code: 'BAD_STANCE' };
    // Locked once the tournament has been computed; changing it afterwards
    // would not change the result, and letting someone try is worse than
    // saying no.
    if (this.game.phase === 'battle' || this.game.phase === 'done') {
      return { error: 'battle already started', code: 'LOCKED' };
    }
    player.stance = stance;
    await this.savePlayer(player);
    this.broadcast('stanceCount', { picked: this.countStances(), total: this.players.size });
    return { ok: true, stance };
  }

  countStances() {
    let n = 0;
    for (const p of this.players.values()) if (p.stance) n++;
    return n;
  }

  /**
   * Computes the whole tournament, then starts the clock.
   *
   * The result exists in full before the first frame is drawn. The projector
   * is replaying a timeline, not waiting on the server, which is why a screen
   * that reconnects halfway through resumes at the right moment.
   */
  async startBattle() {
    const roster = [...this.players.values()];
    if (roster.length < 2) return { error: 'need at least 2 warriors', code: 'TOO_FEW' };

    const seed = `${this.game.seed ?? 'wall'}:${Date.now()}`;
    /**
     * Normalising to a ten-question baseline is what keeps a five-question
     * class and a twenty-question class producing comparable characters.
     *
     * The count that matters is how many questions were actually put to the
     * room, not how many are sitting in the bank. An instructor who writes ten
     * and gets through four has run a four-question class: scaling as though
     * all ten had been asked would squash everyone's earned stats back toward
     * the base and hand the battle to luck. And a class that asked none has
     * nothing to normalise at all — those characters are pure birth roll, and
     * that is exactly what should fight.
     */
    const asked = this.game.askedCount || 0;

    const fighters = roster.map((p) => ({
      playerId: p.studentId,
      name: p.name,
      classId: p.job ?? 'healer',
      avatarUrl: p.hasPortrait ? `/av/${p.studentId}.jpg?v=${p.portraitAt ?? 0}` : null,
      stats: asked > 0 ? normalizeStats(p.stats, asked) : p.stats,
      stance: p.stance ?? defaultStance(seed, p.studentId),
    }));

    const result = runBattle(fighters, seed);
    const { items, totalMs } = buildTimeline(result);

    for (const entry of result.ranking) {
      const player = this.players.get(entry.playerId);
      if (!player) continue;
      player.rank = entry.rank;
      player.damage = entry.damageDealt;
      if (!player.stance) player.stance = fighters.find((f) => f.playerId === entry.playerId).stance;
    }

    this.battle = { seed, fighters, result, timeline: items, totalMs, startedAt: Date.now() };
    this.game.phase = 'battle';
    this.game.battleStartedAt = this.battle.startedAt;
    this.game.battleTotalMs = totalMs;
    await this.savePlayers([...this.players.values()]);
    await this.state.storage.put('battle', this.battle);
    await this.saveGame();

    this.broadcast('battle', { startedAt: this.battle.startedAt, totalMs, count: fighters.length });
    return { ok: true, startedAt: this.battle.startedAt, totalMs, count: fighters.length };
  }

  battlePayload() {
    if (!this.battle) return { battle: null };
    return {
      battle: {
        fighters: this.battle.fighters,
        result: this.battle.result,
        timeline: this.battle.timeline,
        totalMs: this.battle.totalMs,
        startedAt: this.battle.startedAt,
      },
    };
  }

  // ------------------------------------------------------------------- reset

  /** Wipes the room. Called when the instructor opens a new class session, and
   *  from the wall's own reset button. */
  async reset({ sessionId } = {}) {
    await this.state.storage.deleteAll();
    this.players.clear();
    this.answers.clear();
    this.battle = null;
    this.game = {
      ...EMPTY_GAME,
      sessionId: sessionId ?? null,
      seed: `${sessionId ?? 'wall'}:${Date.now()}`,
    };
    await this.saveGame();
    this.broadcast('gameReset', {});
    return { ok: true };
  }

  publicGame() {
    const g = this.game;
    return {
      phase: g.phase,
      sessionId: g.sessionId,
      questionIndex: g.questionIndex,
      questionTotal: g.questionTotal,
      questionId: g.questionId,
      // Withheld while the question is live; the reveal event carries it.
      text: g.phase === 'question' || g.phase === 'reveal' ? g.questionText : null,
      choices: g.phase === 'question' || g.phase === 'reveal' ? g.questionChoices : null,
      correctIdx: g.phase === 'reveal' ? g.correctIdx : null,
      explanation: g.phase === 'reveal' ? g.explanation : null,
      startedAt: g.questionStartedAt,
      timeLimitMs: g.timeLimitMs,
      askedCount: g.askedCount,
      answered: g.questionId ? (this.answers.get(g.questionId)?.size ?? 0) : 0,
      stancePicked: this.countStances(),
      battleStartedAt: g.battleStartedAt,
      battleTotalMs: g.battleTotalMs,
      players: this.players.size,
    };
  }
}

// ---------------------------------------------------------------- helpers

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status: body?.error ? 400 : status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const noContent = () => new Response(null, { status: 204 });

/** Strips the token — it is the one field a student's own device may hold but
 *  no other page may ever see. */
function publicPlayer(p) {
  return {
    studentId: p.studentId,
    name: p.name,
    job: p.job,
    stats: p.stats,
    score: p.score,
    streak: p.streak,
    bestStreak: p.bestStreak,
    answered: p.answered,
    correct: p.correct,
    stance: p.stance,
    rank: p.rank,
    damage: p.damage,
    rollPoints: p.rollPoints,
    hasPortrait: p.hasPortrait,
    portraitAt: p.portraitAt ?? 0,
  };
}

/** Fills a partial delta out to a full stat object of zeroes, so addStats can
 *  treat it like any other. */
function withZeroBase(delta) {
  return {
    hp: delta?.hp ?? 0,
    atk: delta?.atk ?? 0,
    def: delta?.def ?? 0,
    spd: delta?.spd ?? 0,
    luk: delta?.luk ?? 0,
  };
}

/**
 * One room per class session.
 *
 * The room used to be a single instance named 'global', which was fine while
 * only one class could exist. Now that sessions can be switched between, that
 * would mean every switch destroyed the characters of the class you switched
 * away from — so the session id names the room, and each class keeps its own
 * players, questions in flight and battle result for as long as it exists.
 *
 * The 'global' fallback covers the moment before any session exists.
 */
export function hub(env, sessionId) {
  return env.WALL_HUB.get(env.WALL_HUB.idFromName(sessionId || 'global'));
}

export async function publish(env, sessionId, event, payload) {
  await hub(env, sessionId).fetch('https://hub/publish', {
    method: 'POST',
    body: JSON.stringify({ event, payload }),
  });
}

/** Calls a hub route and unwraps the JSON, so route handlers in index.js read
 *  as ordinary async calls rather than fetch plumbing. */
export async function callHub(env, sessionId, path, { method = 'POST', body } = {}) {
  const res = await hub(env, sessionId).fetch(`https://hub${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}
