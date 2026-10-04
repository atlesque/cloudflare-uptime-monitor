// The one-minute check cycle: probe every monitor, advance its state machine,
// open/close incidents and record notifications on confirmed transitions.

import type { Budget } from "./budget";
import type { MaintenanceMode, NotificationKind, NotificationPayload } from "./notifications";
import { probe, type ProbeResult } from "./probe";
import { applyCheck, type MonitorState, type Transition } from "./state";

// Workers allow 6 simultaneous outbound connections; further fetches queue
// inside the runtime while their timeout is already running. Limiting here
// keeps each probe's timeout measuring only its own request.
const PROBE_CONCURRENCY = 6;

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
  outage_started_at: number | null;
}

export interface CheckOutcome {
  monitorId: number;
  result: ProbeResult;
  state: MonitorState;
  transition: Transition;
}

export async function runChecks(env: Env, budget: Budget, now: () => number = Date.now): Promise<CheckOutcome[]> {
  // Least recently checked first, so monitors deferred by the budget go first next time.
  const { results: monitors } = await env.DB.prepare(
    `SELECT m.id, m.name, m.url, m.group_name, m.timeout_ms, m.state, m.consecutive_failures,
            m.consecutive_successes, m.maintenance_mode, m.check_token, i.started_at AS outage_started_at
       FROM monitors m
       LEFT JOIN incidents i ON i.monitor_id = m.id AND i.ended_at IS NULL
      ORDER BY m.last_checked_at IS NOT NULL, m.last_checked_at, m.id`,
  ).all<CheckRow>();
  if (monitors.length === 0) return [];

  const results = await mapWithConcurrency(monitors, PROBE_CONCURRENCY, (m) => probe(m.url, m.timeout_ms, budget));
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
                last_checked_at = ?, last_status = ?, last_error = ?, last_duration_ms = ?
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
        m.id,
        m.url,
        m.check_token,
      ),
    );
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

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
