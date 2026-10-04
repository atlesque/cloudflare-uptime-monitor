// Manual maintenance modes. Maintenance starts immediately and only ends when
// an administrator ends it; there is no scheduling or automatic expiry.

import { notificationInsert } from "./checks";
import type { MaintenanceMode, NotificationPayload } from "./notifications";

interface MaintenanceRow {
  id: number;
  name: string;
  url: string;
  group_name: string | null;
  state: string;
  maintenance_mode: MaintenanceMode;
  last_status: number | null;
  last_error: string | null;
  last_duration_ms: number | null;
  outage_started_at: number | null;
}

/** Sets the maintenance mode of the given monitors. Returns the ids that were changed. */
export async function setMaintenance(env: Env, ids: number[], mode: MaintenanceMode, now: number): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.name, m.url, m.group_name, m.state, m.maintenance_mode,
            m.last_status, m.last_error, m.last_duration_ms, i.started_at AS outage_started_at
       FROM monitors m
       LEFT JOIN incidents i ON i.monitor_id = m.id AND i.ended_at IS NULL
      WHERE m.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<MaintenanceRow>();

  const changed: number[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const m of results) {
    if (m.maintenance_mode === mode) continue;
    changed.push(m.id);
    statements.push(
      env.DB.prepare(`UPDATE maintenance_periods SET ended_at = ? WHERE monitor_id = ? AND ended_at IS NULL`).bind(
        now,
        m.id,
      ),
    );
    if (mode !== "none") {
      statements.push(
        env.DB.prepare(`INSERT INTO maintenance_periods (monitor_id, mode, started_at) VALUES (?, ?, ?)`).bind(
          m.id,
          mode,
          now,
        ),
      );
    }
    statements.push(
      env.DB.prepare(`UPDATE monitors SET maintenance_mode = ? WHERE id = ?`).bind(mode, m.id),
    );
    // Leaving silent maintenance while still Down: the outage alert was suppressed,
    // so send one "still down" reminder now that notifications apply again.
    if (m.maintenance_mode === "silent" && m.state === "down") {
      const payload: NotificationPayload = {
        monitorId: m.id,
        name: m.name,
        url: m.url,
        group: m.group_name,
        at: now,
        status: m.last_status,
        error: m.last_error,
        durationMs: m.last_duration_ms,
        outageStartedAt: m.outage_started_at,
        maintenanceMode: mode,
      };
      statements.push(notificationInsert(env, "still_down", payload, "state = 'down'"));
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return changed;
}
