-- Agent Analytics Core Schema
-- Works with Cloudflare D1 (SQLite-compatible)

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,              -- ULID: time-sortable, no autoincrement contention
  project_id TEXT NOT NULL,
  event TEXT NOT NULL,
  properties TEXT,                  -- JSON blob for flexible data
  user_id TEXT,
  session_id TEXT,                  -- first-class: agents think in sessions
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL                -- denormalized YYYY-MM-DD for fast date partitioning
);

CREATE INDEX IF NOT EXISTS idx_events_project_date ON events(project_id, date);
CREATE INDEX IF NOT EXISTS idx_events_project_event ON events(project_id, event, date);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(project_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(project_id, user_id) WHERE user_id IS NOT NULL;
