// The one-minute check cycle: probe every monitor, advance its state machine,
// open/close incidents and record notifications on confirmed transitions.

import type { Budget } from "./budget";
import type { MaintenanceMode, NotificationKind, NotificationPayload } from "./notifications";
import { parseStoredHeaders } from "./headers";
import type { ProbeResult } from "./probe";
import { runProbes } from "./prober";
import { loadCheckSettings } from "./settings";
import { applyCheck, type MonitorState, type Transition } from "./state";

// The scheduler fires every minute but not at exact multiples of a minute, so a monitor
// counts as due slightly early rather than skipping a whole extra run.
const DUE_SLACK_MS = 30_000;

/** Failed-check diagnostics kept per monitor (most recent first). */
export const FAILURES_KEPT = 20;

interface CheckRow {
  id: number;
  name: string;
  url: string;
  group_name: string | null;
  timeout_ms: number;
  state: MonitorState;
  consecutive_failures: number;
  consecutive_successes: number;
  maintenance_mode: MaintenanceMode;
  check_token: string | null;
  request_headers: string | null;
  cache_bust: number;
  outage_started_at: number | null;
  last_checked_at: number | null;
  interval_minutes: number;
  next_check_after: number | null;
}

export interface CheckOutcome {
  monitorId: number;
  result: ProbeResult;
  state: MonitorState;
  transition: Transition;
}

export async function runChecks(env: Env, budget: Budget, now: () => number = Date.now): Promise<CheckOutcome[]> {
  const { defaultIntervalMinutes } = await loadCheckSettings(env);
  // Least recently checked first, so monitors deferred by the budget go first next time.
  const { results: rows } = await env.DB.prepare(
    `SELECT m.id, m.name, m.url, m.group_name, m.timeout_ms, m.state, m.consecutive_failures,
            m.consecutive_successes, m.maintenance_mode, m.check_token, m.request_headers, m.cache_bust, i.started_at AS outage_started_at,
            m.last_checked_at, COALESCE(m.check_interval_minutes, ?) AS interval_minutes, m.next_check_after
       FROM monitors m
       LEFT JOIN incidents i ON i.monitor_id = m.id AND i.ended_at IS NULL
      ORDER BY m.last_checked_at IS NOT NULL, m.last_checked_at, m.id`,
  )
    .bind(defaultIntervalMinutes)
    .all<CheckRow>();
  const startedAt = now();
  const monitors = rows.filter(
    (m) =>
      (m.next_check_after === null || startedAt >= m.next_check_after) &&
      (m.last_checked_at === null || startedAt - m.last_checked_at >= m.interval_minutes * 60_000 - DUE_SLACK_MS),
  );
  if (monitors.length === 0) return [];

  const results = await runProbes(
    env,
    monitors.map((m) => ({
      url: m.url,
      timeoutMs: m.timeout_ms,
      headers: parseStoredHeaders(m.request_headers),
      cacheBust: m.cache_bust === 1,
    })),
    budget,
  );
  const checkedAt = now();

  const outcomes: CheckOutcome[] = [];
  const statements: D1PreparedStatement[] = [];
  monitors.forEach((m, i) => {
    const result = results[i];
    if (result.skipped) {
      console.warn(`Check of monitor ${m.id} deferred: subrequest budget exhausted`);
      return;
    }
    const next = applyCheck(
      { state: m.state, consecutiveFailures: m.consecutive_failures, consecutiveSuccesses: m.consecutive_successes },
      result.ok,
    );
    outcomes.push({ monitorId: m.id, result, state: next.state, transition: next.transition });

    // The update only applies if nobody changed the monitor's check token since we
    // read it (URL change, deletion, overlapping run). Side effects below are tied
    // to the fresh token, so they only happen if this update applied.
    const token = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `UPDATE monitors
            SET state = ?, consecutive_failures = ?, consecutive_successes = ?, check_token = ?,
                last_checked_at = ?, last_status = ?, last_error = ?, last_duration_ms = ?, next_check_after = ?
          WHERE id = ? AND url = ? AND check_token IS ?`,
      ).bind(
        next.state,
        next.consecutiveFailures,
        next.consecutiveSuccesses,
        token,
        checkedAt,
        result.status,
        result.error,
        result.durationMs,
        result.retryAfterMs ? checkedAt + result.retryAfterMs : null,
        m.id,
        m.url,
        m.check_token,
      ),
    );
    if (result.retryAfterMs) {
      console.warn(`Monitor ${m.id} sent Retry-After; next check in ${Math.round(result.retryAfterMs / 1000)} s`);
    }
    if (result.diagnostics) statements.push(...failureInserts(env, m.id, checkedAt, result, token));
    if (next.transition === "down") {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO incidents (monitor_id, started_at, failure_reason)
           SELECT id, ?, ? FROM monitors WHERE id = ? AND check_token = ?`,
        ).bind(checkedAt, result.error, m.id, token),
      );
    } else if (next.transition === "up") {
      statements.push(
        env.DB.prepare(
          `UPDATE incidents SET ended_at = ?
            WHERE monitor_id = ? AND ended_at IS NULL
              AND EXISTS (SELECT 1 FROM monitors WHERE id = ? AND check_token = ?)`,
        ).bind(checkedAt, m.id, m.id, token),
      );
    }
    if (next.transition) {
      const kind: NotificationKind = next.transition;
      const payload: NotificationPayload = {
        monitorId: m.id,
        name: m.name,
        url: m.url,
        group: m.group_name,
        at: checkedAt,
        status: result.status,
        error: result.error,
        durationMs: result.durationMs,
        outageStartedAt: kind === "up" ? m.outage_started_at : null,
        maintenanceMode: m.maintenance_mode,
      };
      statements.push(notificationInsert(env, kind, payload, "check_token = ?", token));
    }
  });

  if (statements.length > 0) await env.DB.batch(statements);
  return outcomes;
}

/** Stores a failed check's diagnostics and drops the oldest beyond FAILURES_KEPT. */
function failureInserts(env: Env, monitorId: number, checkedAt: number, result: ProbeResult, token: string) {
  const d = result.diagnostics!;
  return [
    env.DB.prepare(
      `INSERT INTO check_failures
         (monitor_id, checked_at, url, status, error, duration_ms, redirects, headers, body, body_truncated)
       SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM monitors WHERE id = ? AND check_token = ?`,
    ).bind(
      checkedAt,
      d.url,
      result.status,
      result.error,
      result.durationMs,
      JSON.stringify(d.redirects),
      d.headers ? JSON.stringify(d.headers) : null,
      d.body,
      d.bodyTruncated ? 1 : 0,
      monitorId,
      token,
    ),
    env.DB.prepare(
      `DELETE FROM check_failures WHERE monitor_id = ?1 AND id NOT IN
         (SELECT id FROM check_failures WHERE monitor_id = ?1 ORDER BY checked_at DESC, id DESC LIMIT ?2)`,
    ).bind(monitorId, FAILURES_KEPT),
  ];
}

/**
 * Records a notification unless the monitor is in silent maintenance at write
 * time. `guard` is an extra SQL condition on the monitor row.
 */
export function notificationInsert(
  env: Env,
  kind: NotificationKind,
  payload: NotificationPayload,
  guard: string,
  ...guardParams: unknown[]
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO notifications (monitor_id, kind, created_at, payload)
     SELECT id, ?, ?, ? FROM monitors WHERE id = ? AND maintenance_mode != 'silent' AND ${guard}`,
  ).bind(kind, payload.at, JSON.stringify(payload), payload.monitorId, ...guardParams);
}
