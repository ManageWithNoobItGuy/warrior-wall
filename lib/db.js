import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'wall.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    featured_id TEXT
  );

  CREATE TABLE IF NOT EXISTS posters (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    student_id TEXT NOT NULL,
    takeaways  TEXT NOT NULL,
    actions    TEXT NOT NULL,
    photo      BLOB,
    poster     BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posters_session ON posters(session_id, created_at);

  CREATE TABLE IF NOT EXISTS avatar_usage (
    session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, student_id)
  );
`);

// Databases created before classes existed are missing this column.
const posterColumns = new Set(db.prepare(`PRAGMA table_info(posters)`).all().map((c) => c.name));
if (!posterColumns.has('job')) {
  db.exec(`ALTER TABLE posters ADD COLUMN job TEXT`);
}
// Cards used to be stored at a single size; `poster` is now the full-resolution
// download and `poster_small` the copy the wall and projector load.
if (!posterColumns.has('poster_small')) {
  db.exec(`ALTER TABLE posters ADD COLUMN poster_small BLOB`);
}
// Images are uploaded as raw binary after the metadata row is created, so a row
// is invisible until its display image lands. Rows written before this shipped
// were complete on insert, hence the default of 1.
if (!posterColumns.has('ready')) {
  db.exec(`ALTER TABLE posters ADD COLUMN ready INTEGER NOT NULL DEFAULT 1`);
}

/** The wall always has exactly one live session; create a default one on first boot. */
export function activeSession() {
  const row = db
    .prepare(`SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .get();
  if (row) return row;
  return newSession('AI CLASS');
}

export function newSession(title) {
  const now = Date.now();
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL`).run(now);
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)`).run(
    id,
    (title || 'AI CLASS').slice(0, 60),
    now,
  );
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
}

export function renameSession(id, title) {
  db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run((title || 'AI CLASS').slice(0, 60), id);
}

/** Wipes every poster in a session but keeps the session itself open. */
export function clearSession(id) {
  db.prepare(`DELETE FROM posters WHERE session_id = ?`).run(id);
  db.prepare(`UPDATE sessions SET featured_id = NULL WHERE id = ?`).run(id);
}

export function setFeatured(sessionId, posterId) {
  db.prepare(`UPDATE sessions SET featured_id = ? WHERE id = ?`).run(posterId, sessionId);
}

export function addPoster({ sessionId, name, studentId, takeaways, actions, job }) {
  const id = randomUUID();
  // `poster` is NOT NULL from the original schema and SQLite cannot drop that,
  // so the row starts with an empty blob and `ready = 0` keeps it hidden until
  // the real bytes are uploaded.
  db.prepare(
    `INSERT INTO posters (id, session_id, name, student_id, takeaways, actions, poster, job, ready, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    sessionId,
    name,
    studentId,
    JSON.stringify(takeaways),
    JSON.stringify(actions),
    new Uint8Array(0),
    job ?? null,
    Date.now(),
  );
  return id;
}

const IMAGE_COLUMNS = { full: 'poster', display: 'poster_small', photo: 'photo' };

/**
 * Stores one uploaded image. Kept as its own call so the Cloudflare port can
 * swap the body for an R2 put without touching the routes.
 *
 * @param {'full'|'display'|'photo'} variant
 * @returns {boolean} false when the poster row does not exist
 */
export function putPosterImage(id, variant, bytes) {
  const column = IMAGE_COLUMNS[variant];
  if (!column) return false;
  const info = db.prepare(`UPDATE posters SET ${column} = ? WHERE id = ?`).run(bytes, id);
  return info.changes > 0;
}

/** Publishes a poster once its display image has arrived. */
export function markPosterReady(id) {
  const info = db.prepare(`UPDATE posters SET ready = 1 WHERE id = ? AND ready = 0`).run(id);
  return info.changes > 0 ? getPoster(id) : null;
}

/** Rows whose upload never finished — swept when a session is cleared. */
export function deleteIncomplete(sessionId, olderThanMs = 10 * 60 * 1000) {
  db.prepare(`DELETE FROM posters WHERE session_id = ? AND ready = 0 AND created_at < ?`).run(
    sessionId,
    Date.now() - olderThanMs,
  );
}

// ------------------------------------------------------------ avatar quota

/** Quota is per student per session, so a fresh class starts everyone at zero. */
export function avatarUsage(sessionId, studentId) {
  const row = db
    .prepare(`SELECT used FROM avatar_usage WHERE session_id = ? AND student_id = ?`)
    .get(sessionId, studentId);
  return row?.used ?? 0;
}

export function bumpAvatarUsage(sessionId, studentId) {
  db.prepare(
    `INSERT INTO avatar_usage (session_id, student_id, used, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(session_id, student_id)
     DO UPDATE SET used = used + 1, updated_at = excluded.updated_at`,
  ).run(sessionId, studentId, Date.now());
  return avatarUsage(sessionId, studentId);
}

/** Metadata only — the BLOB columns are far too heavy for list responses. */
export function listPosters(sessionId) {
  return db
    .prepare(
      `SELECT id, name, student_id, takeaways, actions, job, created_at
       FROM posters WHERE session_id = ? AND ready = 1 ORDER BY created_at ASC`,
    )
    .all(sessionId)
    .map(hydrate);
}

export function getPoster(id) {
  const row = db
    .prepare(
      `SELECT id, session_id, name, student_id, takeaways, actions, job, created_at
       FROM posters WHERE id = ?`,
    )
    .get(id);
  return row ? hydrate(row) : null;
}

/** @param {'display'|'full'} variant */
export function getPosterImage(id, variant = 'display') {
  const row = db.prepare(`SELECT poster, poster_small FROM posters WHERE id = ?`).get(id);
  if (!row) return null;
  // Rows written before the two-size split only have the one image.
  const buf = variant === 'full' ? row.poster : (row.poster_small ?? row.poster);
  return buf && buf.byteLength ? buf : null;
}

export function allPosterImages(sessionId) {
  return db
    .prepare(
      `SELECT id, name, student_id, poster, created_at
       FROM posters WHERE session_id = ? AND ready = 1 ORDER BY created_at ASC`,
    )
    .all(sessionId);
}

export function deletePoster(id) {
  db.prepare(`UPDATE sessions SET featured_id = NULL WHERE featured_id = ?`).run(id);
  db.prepare(`DELETE FROM posters WHERE id = ?`).run(id);
}

export function countPosters(sessionId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM posters WHERE session_id = ? AND ready = 1`).get(
    sessionId,
  ).n;
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

export default db;
