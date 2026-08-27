/**
 * Data layer for the Workers build: metadata in D1, images in R2.
 *
 * Mirrors the shape of lib/db.js so the routes read the same either side, with
 * one unavoidable difference — every call here is async.
 */

const IMAGE_KEYS = {
  full: (id) => `posters/${id}/full.png`,
  display: (id) => `posters/${id}/display.png`,
  photo: (id) => `posters/${id}/photo.jpg`,
};

// ------------------------------------------------------------------ sessions

/** The wall always has exactly one live session; create one on first boot. */
export async function activeSession(env) {
  const row = await env.DB.prepare(
    `SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  ).first();
  return row ?? (await newSession(env, 'AI CLASS'));
}

export async function newSession(env, title) {
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL`).bind(now),
    env.DB.prepare(`INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)`).bind(
      id,
      (title || 'AI CLASS').slice(0, 60),
      now,
    ),
  ]);
  return env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first();
}

export async function renameSession(env, id, title) {
  await env.DB.prepare(`UPDATE sessions SET title = ? WHERE id = ?`)
    .bind((title || 'AI CLASS').slice(0, 60), id)
    .run();
}

export async function setFeatured(env, sessionId, posterId) {
  await env.DB.prepare(`UPDATE sessions SET featured_id = ? WHERE id = ?`)
    .bind(posterId, sessionId)
    .run();
}

/**
 * Every class ever run, newest first, with its card count.
 *
 * `ended_at IS NULL` marks the one that is live. Exactly one row should hold
 * that at a time — `activateSession` is what enforces it.
 */
export async function listSessions(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.created_at, s.ended_at,
            (SELECT COUNT(*) FROM posters p WHERE p.session_id = s.id AND p.ready = 1) AS cards
       FROM sessions s
      ORDER BY s.created_at DESC`,
  ).all();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    endedAt: row.ended_at ?? null,
    active: row.ended_at === null,
    cards: row.cards,
  }));
}

/**
 * Switches which class is live.
 *
 * Closing everything and reopening one, in a single batch, so there is never a
 * moment with two live sessions — `activeSession` picks the newest live row
 * and would otherwise answer differently depending on when it was asked.
 *
 * Nothing is deleted: the outgoing class keeps its cards, and its room in the
 * Durable Object keeps its characters, ready to be switched back to.
 */
export async function activateSession(env, id) {
  const row = await env.DB.prepare(`SELECT id FROM sessions WHERE id = ?`).bind(id).first();
  if (!row) return null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND id != ?`)
      .bind(Date.now(), id),
    env.DB.prepare(`UPDATE sessions SET ended_at = NULL WHERE id = ?`).bind(id),
  ]);
  return env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first();
}

/** Deletes a class and everything filed under it. Irreversible. */
export async function deleteSession(env, id) {
  const { results } = await env.DB.prepare(`SELECT id FROM posters WHERE session_id = ?`)
    .bind(id)
    .all();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM posters WHERE session_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM questions WHERE session_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM battle_results WHERE session_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM avatar_usage WHERE session_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id),
  ]);
  await dropImages(env, results.map((row) => row.id));
  return results.length;
}

// ------------------------------------------------------------------- posters

export async function addPoster(env, { sessionId, name, studentId, takeaways, actions, job }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO posters (id, session_id, name, student_id, takeaways, actions, job, ready, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      id,
      sessionId,
      name,
      studentId,
      JSON.stringify(takeaways),
      JSON.stringify(actions),
      job ?? null,
      Date.now(),
    )
    .run();
  return id;
}

/**
 * Streams an uploaded image into R2. The body is piped straight through, so a
 * multi-megabyte card costs almost no CPU on the way past.
 *
 * @param {'full'|'display'|'photo'} variant
 */
export async function putPosterImage(env, id, variant, body, contentType) {
  const key = IMAGE_KEYS[variant]?.(id);
  if (!key) return false;

  const exists = await env.DB.prepare(`SELECT 1 FROM posters WHERE id = ?`).bind(id).first();
  if (!exists) return false;

  await env.CARDS.put(key, body, {
    httpMetadata: { contentType: contentType || 'application/octet-stream' },
  });
  return true;
}

export async function getPosterImage(env, id, variant = 'display') {
  const key = IMAGE_KEYS[variant]?.(id);
  return key ? env.CARDS.get(key) : null;
}

/** Publishes a poster once its display image has landed. */
export async function markPosterReady(env, id) {
  const info = await env.DB.prepare(`UPDATE posters SET ready = 1 WHERE id = ? AND ready = 0`)
    .bind(id)
    .run();
  return info.meta.changes > 0 ? getPoster(env, id) : null;
}

export async function listPosters(env, sessionId) {
  const { results } = await env.DB.prepare(
    `SELECT id, session_id, name, student_id, takeaways, actions, job, stats, rank, score, created_at
       FROM posters WHERE session_id = ? AND ready = 1 ORDER BY created_at ASC`,
  )
    .bind(sessionId)
    .all();
  return results.map(hydrate);
}

export async function getPoster(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, session_id, name, student_id, takeaways, actions, job, stats, rank, score, created_at
       FROM posters WHERE id = ?`,
  )
    .bind(id)
    .first();
  return row ? hydrate(row) : null;
}

export async function countPosters(env, sessionId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM posters WHERE session_id = ? AND ready = 1`,
  )
    .bind(sessionId)
    .first();
  return row?.n ?? 0;
}

export async function deletePoster(env, id) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET featured_id = NULL WHERE featured_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM posters WHERE id = ?`).bind(id),
  ]);
  await dropImages(env, [id]);
}

/** Wipes every poster in a session but keeps the session itself open. */
export async function clearSession(env, id) {
  const { results } = await env.DB.prepare(`SELECT id FROM posters WHERE session_id = ?`)
    .bind(id)
    .all();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM posters WHERE session_id = ?`).bind(id),
    env.DB.prepare(`UPDATE sessions SET featured_id = NULL WHERE id = ?`).bind(id),
  ]);
  await dropImages(env, results.map((row) => row.id));
}

/** Rows whose upload never finished — swept when the next student submits. */
export async function deleteIncomplete(env, sessionId, olderThanMs = 10 * 60 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  const { results } = await env.DB.prepare(
    `SELECT id FROM posters WHERE session_id = ? AND ready = 0 AND created_at < ?`,
  )
    .bind(sessionId, cutoff)
    .all();
  if (!results.length) return;
  await env.DB.prepare(
    `DELETE FROM posters WHERE session_id = ? AND ready = 0 AND created_at < ?`,
  )
    .bind(sessionId, cutoff)
    .run();
  await dropImages(env, results.map((row) => row.id));
}

async function dropImages(env, ids) {
  if (!ids.length) return;
  const keys = ids.flatMap((id) => Object.values(IMAGE_KEYS).map((key) => key(id)));
  // R2 deletes in batches of up to 1000 keys.
  for (let i = 0; i < keys.length; i += 1000) {
    await env.CARDS.delete(keys.slice(i, i + 1000));
  }
}

// -------------------------------------------------------------- avatar quota

export async function avatarUsage(env, sessionId, studentId) {
  const row = await env.DB.prepare(
    `SELECT used FROM avatar_usage WHERE session_id = ? AND student_id = ?`,
  )
    .bind(sessionId, studentId)
    .first();
  return row?.used ?? 0;
}

/** Total summons burned in a session — the ceiling that protects the API key. */
export async function sessionAvatarUsage(env, sessionId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(used), 0) AS n FROM avatar_usage WHERE session_id = ?`,
  )
    .bind(sessionId)
    .first();
  return row?.n ?? 0;
}

export async function bumpAvatarUsage(env, sessionId, studentId) {
  await env.DB.prepare(
    `INSERT INTO avatar_usage (session_id, student_id, used, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(session_id, student_id)
     DO UPDATE SET used = used + 1, updated_at = excluded.updated_at`,
  )
    .bind(sessionId, studentId, Date.now())
    .run();
  return avatarUsage(env, sessionId, studentId);
}

function hydrate(row) {
  return {
    id: row.id,
    // Carried so a broadcast about this card reaches the room that owns it,
    // which is not necessarily the room that is active right now.
    sessionId: row.session_id,
    name: row.name,
    studentId: row.student_id,
    takeaways: JSON.parse(row.takeaways),
    actions: JSON.parse(row.actions),
    job: row.job ?? null,
    // Null for every card built before the battle existed, which is what the
    // card renderer checks to decide whether to draw a stat block at all.
    stats: row.stats ? JSON.parse(row.stats) : null,
    rank: row.rank ?? null,
    score: row.score ?? null,
    createdAt: row.created_at,
  };
}

// ----------------------------------------------------------------- questions

/** The instructor's bank for one class session, in asking order. */
export async function listQuestions(env, sessionId) {
  const { results } = await env.DB.prepare(
    `SELECT id, ord, text, choices, correct_idx, time_limit_sec, explanation
       FROM questions WHERE session_id = ? ORDER BY ord ASC`,
  )
    .bind(sessionId)
    .all();
  return results.map(hydrateQuestion);
}

export async function getQuestion(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, ord, text, choices, correct_idx, time_limit_sec, explanation
       FROM questions WHERE id = ?`,
  )
    .bind(id)
    .first();
  return row ? hydrateQuestion(row) : null;
}

/**
 * Replaces the whole bank in one transaction.
 *
 * The editor on the wall page sends the full list every save rather than
 * diffing rows. Reordering and deleting questions mid-class is common enough
 * that a diff would be more code and more ways to end up with a gap in `ord`.
 */
export async function replaceQuestions(env, sessionId, questions) {
  const now = Date.now();
  const statements = [
    env.DB.prepare(`DELETE FROM questions WHERE session_id = ?`).bind(sessionId),
    ...questions.map((q, i) =>
      env.DB.prepare(
        `INSERT INTO questions
           (id, session_id, ord, text, choices, correct_idx, time_limit_sec, explanation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        q.id || crypto.randomUUID(),
        sessionId,
        i,
        q.text,
        JSON.stringify(q.choices),
        q.correctIdx,
        q.timeLimitSec,
        q.explanation ?? null,
        now,
      ),
    ),
  ];
  await env.DB.batch(statements);
  return listQuestions(env, sessionId);
}

function hydrateQuestion(row) {
  return {
    id: row.id,
    ord: row.ord,
    text: row.text,
    choices: JSON.parse(row.choices),
    correctIdx: row.correct_idx,
    timeLimitSec: row.time_limit_sec,
    explanation: row.explanation ?? null,
  };
}

/**
 * The last card this student built, in any session.
 *
 * Used to offer a returning student their previous portrait and class instead
 * of making them shoot a photo and choose again. `job` is the tell for what
 * the stored photo actually is: before this version it was written only when
 * the student summoned an AI avatar, so a row with a job carries a painted
 * portrait and a row without one carries a plain photo.
 */
export async function findPreviousPoster(env, studentId) {
  const row = await env.DB.prepare(
    `SELECT id, name, job, session_id, created_at
       FROM posters WHERE student_id = ? AND ready = 1
       ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(studentId)
    .first();
  if (!row) return null;
  return {
    posterId: row.id,
    name: row.name,
    job: row.job ?? null,
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}

// ------------------------------------------------------------ battle results

/**
 * Snapshots the finished tournament into D1.
 *
 * The Durable Object already holds this, but it holds it only while the room
 * is warm. Once the class is over and the DO is evicted, this table is what
 * the wall, the ZIP export and next week's comparison read from.
 */
export async function saveBattleResults(env, sessionId, players) {
  if (!players.length) return;
  const now = Date.now();
  const rows = players.map((p) =>
    env.DB.prepare(
      `INSERT INTO battle_results
         (session_id, student_id, name, job, stats, score, rank, stance, answered, correct, damage, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, student_id) DO UPDATE SET
         name = excluded.name, job = excluded.job, stats = excluded.stats,
         score = excluded.score, rank = excluded.rank, stance = excluded.stance,
         answered = excluded.answered, correct = excluded.correct, damage = excluded.damage`,
    ).bind(
      sessionId,
      p.studentId,
      p.name,
      p.job ?? null,
      JSON.stringify(p.stats),
      p.score ?? 0,
      p.rank ?? null,
      p.stance ?? null,
      p.answered ?? 0,
      p.correct ?? 0,
      p.damage ?? 0,
      now,
    ),
  );
  // D1 caps a batch; 50 students is one batch, a lecture hall is a few.
  for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50));
}

export async function listBattleResults(env, sessionId) {
  const { results } = await env.DB.prepare(
    `SELECT student_id, name, job, stats, score, rank, stance, answered, correct, damage
       FROM battle_results WHERE session_id = ? ORDER BY rank ASC`,
  )
    .bind(sessionId)
    .all();
  return results.map((row) => ({
    studentId: row.student_id,
    name: row.name,
    job: row.job,
    stats: JSON.parse(row.stats),
    score: row.score,
    rank: row.rank,
    stance: row.stance,
    answered: row.answered,
    correct: row.correct,
    damage: row.damage,
  }));
}

// ------------------------------------------------------- character portraits

/**
 * The face that fights in the arena.
 *
 * Separate from the poster images because it exists earlier in the lesson —
 * the battle happens before anyone has written a pledge — and because it is
 * deliberately tiny. The student's device downsizes it to 256px before upload,
 * so fifty of them on a projector cost about as much as one card.
 */
const portraitKey = (sessionId, studentId) => `players/${sessionId}/${studentId}.jpg`;

export async function putPortrait(env, sessionId, studentId, body, contentType) {
  await env.CARDS.put(portraitKey(sessionId, studentId), body, {
    httpMetadata: { contentType: contentType || 'image/jpeg' },
  });
  return true;
}

export async function getPortrait(env, sessionId, studentId) {
  return env.CARDS.get(portraitKey(sessionId, studentId));
}

export async function deletePortrait(env, sessionId, studentId) {
  await env.CARDS.delete(portraitKey(sessionId, studentId));
}

/** The cards a student has in one class — normally none or one. */
export async function postersByStudent(env, sessionId, studentId) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM posters WHERE session_id = ? AND student_id = ?`,
  )
    .bind(sessionId, String(studentId))
    .all();
  return results.map((row) => row.id);
}

/** Adds the character to a poster row once the card is built. */
export async function attachCharacter(env, posterId, { stats, rank, score }) {
  await env.DB.prepare(`UPDATE posters SET stats = ?, rank = ?, score = ? WHERE id = ?`)
    .bind(stats ? JSON.stringify(stats) : null, rank ?? null, score ?? null, posterId)
    .run();
}
