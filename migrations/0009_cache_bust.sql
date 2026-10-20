-- Whether each check adds a unique `_uptime` query parameter to the monitor URL, so a CDN
-- (for example Akamai serving a stale 200 while the origin is down) can't answer from cache.
ALTER TABLE monitors ADD COLUMN cache_bust INTEGER NOT NULL DEFAULT 0;
