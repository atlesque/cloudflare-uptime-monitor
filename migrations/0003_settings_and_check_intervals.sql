-- Settings changed from the dashboard. One row per key; values are JSON.
CREATE TABLE settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-monitor check interval in minutes. NULL follows the global default (settings key "checks").
ALTER TABLE monitors ADD COLUMN check_interval_minutes INTEGER;
