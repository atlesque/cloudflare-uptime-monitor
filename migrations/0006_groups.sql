-- Groups as their own rows, so a group can exist before any monitor is in it.
-- monitors.group_name still names the group; the triggers add a group the first time a
-- monitor uses a new name, so the dashboard and API can keep setting it by name.
CREATE TABLE groups (
  name       TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL
);

INSERT INTO groups (name, created_at)
  SELECT group_name, MIN(created_at) FROM monitors WHERE group_name IS NOT NULL GROUP BY group_name;

CREATE TRIGGER monitors_group_insert AFTER INSERT ON monitors
  WHEN NEW.group_name IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO groups (name, created_at) VALUES (NEW.group_name, CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;

CREATE TRIGGER monitors_group_update AFTER UPDATE OF group_name ON monitors
  WHEN NEW.group_name IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO groups (name, created_at) VALUES (NEW.group_name, CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
