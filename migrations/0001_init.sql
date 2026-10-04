-- Monitors: one public HTTP(S) endpoint each. `url` is stored normalized.
CREATE TABLE monitors (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT    NOT NULL,
  url                   TEXT    NOT NULL UNIQUE,
  group_name            TEXT,
  timeout_ms            INTEGER NOT NULL DEFAULT 10000,
  created_at            INTEGER NOT NULL,          -- epoch ms
  observed_since        INTEGER NOT NULL,          -- epoch ms; reset when the URL changes
  state                 TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'up', 'down')),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_checked_at       INTEGER,
  last_status           INTEGER,
  last_error            TEXT,
  last_duration_ms      INTEGER,
  maintenance_mode      TEXT    NOT NULL DEFAULT 'none' CHECK (maintenance_mode IN ('none', 'notify', 'silent'))
);

-- Incidents: one continuous confirmed Down period.
CREATE TABLE incidents (
  id             INTEGER PRIMARY KEY,
  monitor_id     INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at     INTEGER NOT NULL,                 -- confirmed Down transition, epoch ms
  ended_at       INTEGER,                          -- confirmed Up transition; NULL while ongoing
  failure_reason TEXT
);

CREATE INDEX incidents_monitor_started ON incidents (monitor_id, started_at);
CREATE UNIQUE INDEX incidents_one_open_per_monitor ON incidents (monitor_id) WHERE ended_at IS NULL;
