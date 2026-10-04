// One run of the every-minute schedule: checks, notification delivery, retention.
// The weekly report has its own schedule (see report.ts).

import { Budget, externalLimit, NOTIFICATION_RESERVE } from "./budget";
import { runChecks } from "./checks";
import { dispatchNotifications } from "./notifications";
import { DAY } from "./time";

export const CHECK_CRON = "* * * * *";

/** Incidents and maintenance are kept for the rolling 30-day window, plus a day of slack. */
const HISTORY_RETENTION_MS = 31 * DAY;
const REPORT_RETENTION_MS = 90 * DAY;

export async function runCycle(env: Env, clock: () => number = Date.now): Promise<void> {
  const limit = externalLimit(env);
  const checkBudget = new Budget(Math.max(0, limit - NOTIFICATION_RESERVE));
  const errors: unknown[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`Scheduler step "${name}" failed:`, err);
      errors.push(err);
    }
  };

  await step("checks", () => runChecks(env, checkBudget, clock));
  // Notifications get the reserve plus whatever the checks did not use.
  const notifyBudget = new Budget(Math.min(limit, NOTIFICATION_RESERVE + checkBudget.remaining));
  await step("notifications", () => dispatchNotifications(env, clock(), notifyBudget));
  await step("retention", () => pruneHistory(env, clock()));

  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} scheduler step(s) failed`);
}

export async function pruneHistory(env: Env, now: number): Promise<void> {
  const cutoff = now - HISTORY_RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM maintenance_periods WHERE ended_at IS NOT NULL AND ended_at < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM notifications WHERE created_at < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM weekly_reports WHERE created_at < ?`).bind(now - REPORT_RETENTION_MS),
  ]);
}
