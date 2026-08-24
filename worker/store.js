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
    `SELECT id, name, student_id, takeaways, actions, job, created_at
       FROM posters WHERE session_id = ? AND ready = 1 ORDER BY created_at ASC`,
  )
    .bind(sessionId)
    .all();
  return results.map(hydrate);
}

export async function getPoster(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, session_id, name, student_id, takeaways, actions, job, created_at
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
    name: row.name,
    studentId: row.student_id,
    takeaways: JSON.parse(row.takeaways),
    actions: JSON.parse(row.actions),
    job: row.job ?? null,
    createdAt: row.created_at,
  };
}
