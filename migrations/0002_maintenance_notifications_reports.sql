-- Token written by every applied check and by URL changes. Check results and
-- their side effects only apply while the token they read is still current.
ALTER TABLE monitors ADD COLUMN check_token TEXT;

-- Maintenance history, used for operational vs. inclusive metrics and incident labels.
CREATE TABLE maintenance_periods (
  id         INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  mode       TEXT    NOT NULL CHECK (mode IN ('notify', 'silent')),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX maintenance_periods_monitor ON maintenance_periods (monitor_id, started_at);
CREATE UNIQUE INDEX maintenance_periods_one_open_per_monitor ON maintenance_periods (monitor_id) WHERE ended_at IS NULL;

-- One row per state-transition notification; each channel is delivered and retried independently.
-- Channel status: pending -> sending -> sent | failed (retried) | skipped (channel not configured).
CREATE TABLE notifications (
  id                INTEGER PRIMARY KEY,
  monitor_id        INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  kind              TEXT    NOT NULL CHECK (kind IN ('down', 'up', 'still_down')),
  created_at        INTEGER NOT NULL,
  payload           TEXT    NOT NULL,              -- JSON snapshot of the details at transition time
  email_status      TEXT    NOT NULL DEFAULT 'pending',
  email_attempts    INTEGER NOT NULL DEFAULT 0,
  email_claimed_at  INTEGER,
  email_error       TEXT,
  ntfy_status       TEXT    NOT NULL DEFAULT 'pending',
  ntfy_attempts     INTEGER NOT NULL DEFAULT 0,
  ntfy_claimed_at   INTEGER,
  ntfy_error        TEXT
);
CREATE INDEX notifications_created ON notifications (created_at);

-- One row per completed reporting week (keyed by its Monday 00:00 instant in the configured TIME_ZONE).
CREATE TABLE weekly_reports (
  week_start   INTEGER PRIMARY KEY,
  week_end     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  status       TEXT    NOT NULL,                   -- skipped | pending | sending | sent | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  claimed_at   INTEGER,
  subject      TEXT,
  html         TEXT,
  text         TEXT,
  error        TEXT
);
