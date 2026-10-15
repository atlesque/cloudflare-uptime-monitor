-- Diagnostics for failed checks: the response the monitor got (or the error when there was
-- none), so a block page or an origin error can be told apart. Only the most recent
-- failures per monitor are kept (see checks.ts).
CREATE TABLE check_failures (
  id          INTEGER PRIMARY KEY,
  monitor_id  INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at  INTEGER NOT NULL,                    -- epoch ms
  url         TEXT    NOT NULL,                    -- URL of the last request in the redirect chain
  status      INTEGER,
  error       TEXT,
  duration_ms INTEGER NOT NULL,
  redirects   TEXT    NOT NULL DEFAULT '[]',       -- JSON [{url, status, location}]
  headers     TEXT,                                -- JSON [[name, value]]; NULL when no response arrived
  body        TEXT,                                -- start of the response body
  body_truncated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX check_failures_monitor_checked ON check_failures (monitor_id, checked_at);

-- Set when a site answers 429 or 503 with Retry-After: the monitor is not checked again
-- before this time (epoch ms), capped in probe.ts.
ALTER TABLE monitors ADD COLUMN next_check_after INTEGER;
