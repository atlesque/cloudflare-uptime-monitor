// Weekly report: emailed on Monday at REPORT_HOUR (default 08:00) in the TIME_ZONE
// time zone for the completed Monday-to-Sunday week, only when that week contains
// an operational outage.
//
// It has its own cron, REPORT_CRON, firing every 5 minutes. Cron times are UTC, so
// the handler decides what "Monday morning" means: it only acts in the two hours
// starting at REPORT_HOUR on local Mondays (see reportWindowOpen), which also covers
// daylight-saving shifts. The first run at or after REPORT_HOUR generates the report
// (once, keyed by week start); later runs in the window retry a failed delivery, up to
// MAX_ATTEMPTS in total.

import { computeMetrics, type Metrics } from "./metrics";
import { loadHistory, toIncidentSpans, toMaintenanceSpans } from "./monitors";
import { emailConfigured, escapeHtml, MAX_ATTEMPTS, sendEmail } from "./notifications";
import { addLocalDays, formatDate, formatDuration, MINUTE, weekStartContaining, zonedParts } from "./time";

export const REPORT_CRON = "*/5 * * * *";
export const DEFAULT_REPORT_HOUR = 8;
/** How long after REPORT_HOUR on Monday the report may still be generated or retried. */
const REPORT_WINDOW_HOURS = 2;

/** REPORT_HOUR as an integer 0-21 (so the window stays within Monday); anything else means the default. */
export function reportHour(env: Env): number {
  const raw = env.REPORT_HOUR?.trim();
  const n = raw ? Number(raw) : DEFAULT_REPORT_HOUR;
  return Number.isInteger(n) && n >= 0 && n <= 24 - REPORT_WINDOW_HOURS - 1 ? n : DEFAULT_REPORT_HOUR;
}

/** True during the REPORT_WINDOW_HOURS after REPORT_HOUR on a local Monday. */
export function reportWindowOpen(now: number, hour: number): boolean {
  const p = zonedParts(now);
  return p.weekday === 0 && p.hour >= hour && p.hour < hour + REPORT_WINDOW_HOURS;
}
/** Shorter than the 5-minute cron spacing, so the next run can retry a send that died mid-flight. */
const STALE_CLAIM_MS = 2 * MINUTE;

export interface ReportRow {
  name: string;
  url: string;
  metrics: Metrics;
}

export interface WeeklyReport {
  weekStart: number;
  weekEnd: number;
  rows: ReportRow[];
  qualifies: boolean;
  subject: string;
  html: string;
  text: string;
}

/** The completed week to report on at `now`, or null before this week's Monday at `hour`. */
export function dueReportWeek(now: number, hour = DEFAULT_REPORT_HOUR): { weekStart: number; weekEnd: number } | null {
  const thisWeekStart = weekStartContaining(now);
  if (now < addLocalDays(thisWeekStart, 0, hour)) return null;
  return { weekStart: addLocalDays(thisWeekStart, -7), weekEnd: thisWeekStart };
}

export async function buildWeeklyReport(env: Env, weekStart: number, weekEnd: number): Promise<WeeklyReport> {
  const [{ results: monitors }, history] = await Promise.all([
    env.DB.prepare(`SELECT id, name, url, observed_since FROM monitors ORDER BY name COLLATE NOCASE, id`).all<{
      id: number;
      name: string;
      url: string;
      observed_since: number;
    }>(),
    loadHistory(env, weekStart),
  ]);
  const rows = monitors.map((m) => {
    const h = history(m.id);
    return {
      name: m.name,
      url: m.url,
      metrics: computeMetrics({
        from: weekStart,
        to: weekEnd,
        observedSince: m.observed_since,
        incidents: toIncidentSpans(h.incidents),
        maintenance: toMaintenanceSpans(h.maintenance),
      }),
    };
  });
  const qualifies = rows.some((r) => r.metrics.outages > 0);
  return { weekStart, weekEnd, rows, qualifies, ...renderReport(rows, weekStart, weekEnd) };
}

export async function runWeeklyReport(env: Env, now: number): Promise<void> {
  const due = dueReportWeek(now, reportHour(env));
  if (due) {
    const exists = await env.DB.prepare(`SELECT 1 FROM weekly_reports WHERE week_start = ?`).bind(due.weekStart).first();
    if (!exists) {
      const report = await buildWeeklyReport(env, due.weekStart, due.weekEnd);
      const [status, error] = !report.qualifies
        ? ["skipped", "No operational outage in this week"]
        : !emailConfigured(env)
          ? ["skipped", "Email is not configured"]
          : ["pending", null];
      await env.DB.prepare(
        `INSERT OR IGNORE INTO weekly_reports (week_start, week_end, created_at, status, subject, html, text, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(due.weekStart, due.weekEnd, now, status, report.subject, report.html, report.text, error)
        .run();
    }
  }
  await deliverReports(env, now);
}

async function deliverReports(env: Env, now: number) {
  const { results } = await env.DB.prepare(
    `SELECT week_start, status, attempts, subject, html, text FROM weekly_reports
      WHERE attempts < ? AND (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at < ?))`,
  )
    .bind(MAX_ATTEMPTS, now - STALE_CLAIM_MS)
    .all<{ week_start: number; status: string; attempts: number; subject: string; html: string; text: string }>();

  for (const r of results) {
    const claim = await env.DB.prepare(
      `UPDATE weekly_reports SET status = 'sending', claimed_at = ?, attempts = attempts + 1
        WHERE week_start = ? AND status = ? AND attempts = ?`,
    )
      .bind(now, r.week_start, r.status, r.attempts)
      .run();
    if (claim.meta.changes !== 1) continue;
    try {
      await sendEmail(env, r);
      await env.DB.prepare(`UPDATE weekly_reports SET status = 'sent', error = NULL WHERE week_start = ?`)
        .bind(r.week_start)
        .run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Weekly report ${r.week_start} failed (attempt ${r.attempts + 1}): ${message}`);
      await env.DB.prepare(`UPDATE weekly_reports SET status = 'failed', error = ? WHERE week_start = ?`)
        .bind(message.slice(0, 500), r.week_start)
        .run();
    }
  }
}

// ---- rendering ----

/** Operational value, with the inclusive value in parentheses when it differs. */
function pair(operational: string, inclusive: string): string {
  return operational === inclusive ? operational : `${operational} (${inclusive})`;
}

export function formatUptime(pct: number | null): string {
  if (pct === null) return "—";
  if (pct >= 100) return "100%";
  // Truncate so a real outage never displays as 100.00%.
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

function formatDowntime(ms: number): string {
  return ms === 0 ? "0m" : formatDuration(ms);
}

function uptimeColor(pct: number | null): string {
  if (pct === null) return "#59636e";
  if (pct >= 99.9) return "#1a7f37";
  if (pct >= 99) return "#bf8700";
  return "#cf222e";
}

export function renderReport(rows: ReportRow[], weekStart: number, weekEnd: number) {
  // weekEnd is the next Monday 00:00; the last reported day is the Sunday before it.
  const lastDay = weekEnd - 1;
  const range = `${formatDate(weekStart)} – ${formatDate(lastDay)}`;

  const cells = rows.map((r) => {
    const m = r.metrics;
    return {
      name: r.name,
      url: r.url,
      outages: pair(String(m.outages), String(m.outagesInclusive)),
      downtime: pair(formatDowntime(m.downtimeMs), formatDowntime(m.downtimeInclusiveMs)),
      uptime: pair(formatUptime(m.uptimePct), formatUptime(m.uptimeInclusivePct)),
      uptimeColor: uptimeColor(m.uptimePct),
    };
  });
  const totalOutages = rows.reduce((s, r) => s + r.metrics.outages, 0);
  const totalOutagesInclusive = rows.reduce((s, r) => s + r.metrics.outagesInclusive, 0);
  const minutes = (ms: number) => Math.round(ms / MINUTE);
  const totalMinutes = minutes(rows.reduce((s, r) => s + r.metrics.downtimeMs, 0));
  const totalMinutesInclusive = minutes(rows.reduce((s, r) => s + r.metrics.downtimeInclusiveMs, 0));
  const totals = {
    outages: pair(String(totalOutages), String(totalOutagesInclusive)),
    minutes: pair(String(totalMinutes), String(totalMinutesInclusive)),
  };
  const note =
    "Values in parentheses include time spent in maintenance without notifications. " +
    "The main values exclude that planned downtime.";

  const subject = `Weekly uptime report: ${range} (${totalOutages} outage${totalOutages === 1 ? "" : "s"})`;

  const th = (label: string, align = "center") =>
    `<th style="padding:10px 12px;border-bottom:2px solid #d0d7de;text-align:${align};font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#59636e">${label}</th>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:720px;width:100%;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:8px">
<tr><td style="padding:24px 24px 8px;text-align:center">
<h1 style="margin:0 0 6px;font-size:22px">Weekly Uptime Report</h1>
<p style="margin:0;color:#59636e;font-size:14px">${escapeHtml(range)}</p>
</td></tr>
<tr><td style="padding:16px 24px">
<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">
<thead><tr>${th("Monitor", "left")}${th("Outages")}${th("Downtime")}${th("Uptime")}</tr></thead>
<tbody>
${cells
  .map(
    (c) => `<tr>
<td style="padding:10px 12px;border-bottom:1px solid #eaeef2"><div style="font-weight:600">${escapeHtml(c.name)}</div><div style="font-size:12px;color:#59636e">${escapeHtml(c.url)}</div></td>
<td style="padding:10px 12px;border-bottom:1px solid #eaeef2;text-align:center">${escapeHtml(c.outages)}</td>
<td style="padding:10px 12px;border-bottom:1px solid #eaeef2;text-align:center">${escapeHtml(c.downtime)}</td>
<td style="padding:10px 12px;border-bottom:1px solid #eaeef2;text-align:center;font-weight:600;color:${c.uptimeColor}">${escapeHtml(c.uptime)}</td>
</tr>`,
  )
  .join("\n")}
</tbody></table>
</td></tr>
<tr><td style="padding:0 24px 8px;text-align:center;font-size:14px">
<strong>Total outages:</strong> ${escapeHtml(totals.outages)} &nbsp;·&nbsp; <strong>Total downtime:</strong> ${escapeHtml(totals.minutes)} minutes
</td></tr>
<tr><td style="padding:8px 24px 24px;text-align:center;font-size:12px;color:#59636e">${escapeHtml(note)}</td></tr>
</table></body></html>`;

  const widths = {
    name: Math.max(7, ...cells.map((c) => c.name.length)),
    outages: Math.max(7, ...cells.map((c) => c.outages.length)),
    downtime: Math.max(8, ...cells.map((c) => c.downtime.length)),
  };
  const line = (a: string, b: string, c: string, d: string) =>
    `${a.padEnd(widths.name)}  ${b.padEnd(widths.outages)}  ${c.padEnd(widths.downtime)}  ${d}`;
  const text = [
    "Weekly Uptime Report",
    range,
    "",
    line("Monitor", "Outages", "Downtime", "Uptime"),
    ...cells.map((c) => line(c.name, c.outages, c.downtime, c.uptime)),
    "",
    `Total outages: ${totals.outages}`,
    `Total downtime: ${totals.minutes} minutes`,
    "",
    note,
  ].join("\n");

  return { subject, html, text };
}
