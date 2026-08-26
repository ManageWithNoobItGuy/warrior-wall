-- Quiz + battle. Additive only: every statement here either creates something
-- new or adds a nullable column, so the posters and sessions already sitting in
-- production from the first class survive untouched.
--
-- Live game state (who is on which question, answers in flight, the running
-- stat totals) deliberately does NOT live here. Fifty phones answering the same
-- question inside two seconds is the one hot path in this app, and routing it
-- through D1 would put a network round trip on every keypress. That state lives
-- in the WallHub Durable Object's own SQLite storage instead. D1 keeps only
-- what has to outlive the room: the questions the instructor wrote, and the
-- result attached to a card.

-- The instructor's question bank. Sessions get their own set, and a session
-- can copy an earlier one rather than retyping it.
CREATE TABLE IF NOT EXISTS questions (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  ord            INTEGER NOT NULL,
  text           TEXT NOT NULL,
  choices        TEXT NOT NULL,          -- JSON array, 2-4 entries
  correct_idx    INTEGER NOT NULL,
  time_limit_sec INTEGER NOT NULL DEFAULT 25,
  explanation    TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_session ON questions (session_id, ord);

-- The end-of-battle snapshot, written once when the tournament finishes.
-- Kept separately from the Durable Object so the wall, the ZIP export and any
-- after-class reporting still work once the room has gone quiet and the DO has
-- been evicted.
CREATE TABLE IF NOT EXISTS battle_results (
  session_id  TEXT NOT NULL,
  student_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  job         TEXT,
  stats       TEXT NOT NULL,             -- JSON, normalised to the battle baseline
  score       INTEGER NOT NULL DEFAULT 0,
  rank        INTEGER,
  stance      TEXT,
  answered    INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  damage      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_battle_results_rank ON battle_results (session_id, rank);

-- Cards built after a battle carry the character on them. Nullable so the
-- cards from the first class, which have no character behind them, keep
-- rendering exactly as they did.
ALTER TABLE posters ADD COLUMN stats TEXT;
ALTER TABLE posters ADD COLUMN rank INTEGER;
ALTER TABLE posters ADD COLUMN score INTEGER;
