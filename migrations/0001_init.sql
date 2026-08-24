-- AI Warrior Wall of Pledging — D1 schema.
--
-- Deliberately different from the local SQLite file in one way: no image
-- columns. Cards live in R2 (D1 caps a single value at 2 MB and a full-
-- resolution card is larger than that), and `ready` gates a row's visibility
-- until its display image has finished uploading.

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  featured_id TEXT
);

CREATE TABLE IF NOT EXISTS posters (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  student_id TEXT NOT NULL,
  takeaways  TEXT NOT NULL,
  actions    TEXT NOT NULL,
  job        TEXT,
  ready      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posters_session
  ON posters (session_id, ready, created_at);

CREATE TABLE IF NOT EXISTS avatar_usage (
  session_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, student_id)
);
