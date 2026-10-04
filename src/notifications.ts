// Outage, recovery and still-down notifications over email and ntfy.
//
// Each transition is stored once; email and ntfy are delivered and retried
// independently, so one channel's failure never re-sends the other.

import type { Budget } from "./budget";
import { formatDuration, formatTimestamp, MINUTE } from "./time";

export type NotificationKind = "down" | "up" | "still_down";
export type MaintenanceMode = "none" | "notify" | "silent";

export interface NotificationPayload {
  monitorId: number;
  name: string;
  url: string;
  group: string | null;
  /** When the transition was confirmed (or when silent maintenance ended, for still_down). */
  at: number;
  status: number | null;
  error: string | null;
  durationMs: number | null;
  outageStartedAt: number | null;
  maintenanceMode: MaintenanceMode;
}

type Channel = "email" | "ntfy";
const CHANNELS: Channel[] = ["email", "ntfy"];

/** One initial delivery plus up to two retries on later scheduler runs. */
export const MAX_ATTEMPTS = 3;
/** A claim older than this is assumed to belong to a run that died mid-send. */
const STALE_CLAIM_MS = 5 * MINUTE;
const BATCH_LIMIT = 25;

// ---- configuration ----

export function emailRecipients(env: Env): string[] {
  return (env.EMAIL_TO ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL && env.EMAIL_FROM && emailRecipients(env).length > 0);
}

function ntfyConfigured(env: Env): boolean {
  return Boolean(env.NTFY_URL && env.NTFY_TOPIC);
}

export async function sendEmail(env: Env, message: { subject: string; html: string; text: string }) {
  await env.EMAIL.send({
    to: emailRecipients(env),
    from: { email: env.EMAIL_FROM, name: "Uptime Monitor" },
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}

// ---- content ----

function headline(kind: NotificationKind, p: NotificationPayload): string {
  switch (kind) {
    case "down":
      return `${p.name} is DOWN`;
    case "up":
      return p.outageStartedAt === null
        ? `${p.name} is back UP`
        : `${p.name} is back UP after ${formatDuration(p.at - p.outageStartedAt)}`;
    case "still_down":
      return `${p.name} is STILL DOWN after maintenance ended`;
  }
}

const TRANSITIONS: Record<NotificationKind, string> = {
  down: "Up → Down (2 consecutive failed checks)",
  up: "Down → Up (2 consecutive successful checks)",
  still_down: "Silent maintenance ended while the monitor is Down",
};

const MAINTENANCE_LABELS: Record<MaintenanceMode, string> = {
  none: "None",
  notify: "Maintenance with notifications",
  silent: "Maintenance without notifications",
};

function resultText(p: NotificationPayload): string {
  return p.error ?? (p.status === null ? "—" : `HTTP ${p.status}`);
}

function detailRows(kind: NotificationKind, p: NotificationPayload, env: Env): [string, string][] {
  const rows: [string, string][] = [
    ["Monitor", p.name],
    ["URL", p.url],
    ["Group", p.group ?? "—"],
    ["Transition", TRANSITIONS[kind]],
    ["Time", formatTimestamp(p.at)],
    [kind === "up" ? "Latest result" : "Failure", resultText(p)],
    ["Response time", p.durationMs === null ? "—" : `${p.durationMs} ms`],
  ];
  if (p.outageStartedAt !== null) {
    rows.push(["Outage started", formatTimestamp(p.outageStartedAt)]);
    rows.push([kind === "up" ? "Downtime" : "Down for", formatDuration(p.at - p.outageStartedAt)]);
  }
  if (p.maintenanceMode !== "none") rows.push(["Maintenance", MAINTENANCE_LABELS[p.maintenanceMode]]);
  if (env.DASHBOARD_URL) rows.push(["Dashboard", env.DASHBOARD_URL]);
  return rows;
}

export function buildEmail(kind: NotificationKind, p: NotificationPayload, env: Env) {
  const tag = { down: "DOWN", up: "UP", still_down: "STILL DOWN" }[kind];
  const title = headline(kind, p);
  const rows = detailRows(kind, p, env);
  const color = kind === "up" ? "#1a7f37" : "#cf222e";
  const width = Math.max(...rows.map(([k]) => k.length)) + 2;

  const text = [title, "", ...rows.map(([k, v]) => `${(k + ":").padEnd(width)} ${v}`)].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:8px">
<tr><td style="padding:16px 20px;border-bottom:1px solid #d0d7de"><h1 style="margin:0;font-size:18px;color:${color}">${escapeHtml(title)}</h1></td></tr>
<tr><td style="padding:12px 20px"><table role="presentation" cellpadding="6" cellspacing="0" style="font-size:14px;border-collapse:collapse">
${rows
  .map(([k, v]) => {
    const value = k === "URL" || k === "Dashboard" ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v);
    return `<tr><td style="color:#59636e;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td>${value}</td></tr>`;
  })
  .join("\n")}
</table></td></tr></table></body></html>`;
  return { subject: `[${tag}] ${title}`, html, text };
}

export function buildNtfy(kind: NotificationKind, p: NotificationPayload, env: Env) {
  const lines = [p.url];
  if (kind === "up") {
    if (p.outageStartedAt !== null) lines.push(`Down for ${formatDuration(p.at - p.outageStartedAt)}`);
  } else {
    lines.push(resultText(p));
    if (kind === "still_down" && p.outageStartedAt !== null) {
      lines.push(`Down since ${formatTimestamp(p.outageStartedAt)}`);
    }
  }
  lines.push(formatTimestamp(p.at));
  return {
    topic: env.NTFY_TOPIC,
    title: headline(kind, p),
    message: lines.join("\n"),
    priority: kind === "up" ? 3 : 5,
    tags: [kind === "up" ? "white_check_mark" : kind === "down" ? "rotating_light" : "warning"],
    ...(env.DASHBOARD_URL ? { click: `${env.DASHBOARD_URL.replace(/\/$/, "")}/#monitor-${p.monitorId}` } : {}),
  };
}

async function sendNtfy(env: Env, body: object) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  // JSON publishing goes to the server root, with the topic in the body.
  const res = await fetch(env.NTFY_URL.replace(/\/$/, "") + "/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ntfy responded ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  await res.body?.cancel();
}

// ---- delivery ----

interface NotificationRow {
  id: number;
  kind: NotificationKind;
  payload: string;
  email_status: string;
  email_attempts: number;
  email_claimed_at: number | null;
  ntfy_status: string;
  ntfy_attempts: number;
  ntfy_claimed_at: number | null;
}

function isDue(status: string, attempts: number, claimedAt: number | null, now: number): boolean {
  if (attempts >= MAX_ATTEMPTS) return false;
  if (status === "pending" || status === "failed") return true;
  return status === "sending" && claimedAt !== null && claimedAt < now - STALE_CLAIM_MS;
}

export async function dispatchNotifications(env: Env, now: number, budget: Budget): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, payload, email_status, email_attempts, email_claimed_at, ntfy_status, ntfy_attempts, ntfy_claimed_at
       FROM notifications
      WHERE (email_status IN ('pending', 'failed', 'sending') AND email_attempts < ?1)
         OR (ntfy_status IN ('pending', 'failed', 'sending') AND ntfy_attempts < ?1)
      ORDER BY id
      LIMIT ?2`,
  )
    .bind(MAX_ATTEMPTS, BATCH_LIMIT)
    .all<NotificationRow>();

  for (const row of results) {
    const payload = JSON.parse(row.payload) as NotificationPayload;
    for (const channel of CHANNELS) {
      const status = row[`${channel}_status`];
      const attempts = row[`${channel}_attempts`];
      if (!isDue(status, attempts, row[`${channel}_claimed_at`], now)) continue;

      const configured = channel === "email" ? emailConfigured(env) : ntfyConfigured(env);
      if (!configured) {
        await env.DB.prepare(
          `UPDATE notifications SET ${channel}_status = 'skipped', ${channel}_error = 'Channel not configured'
            WHERE id = ? AND ${channel}_status = ?`,
        )
          .bind(row.id, status)
          .run();
        continue;
      }
      if (channel === "ntfy" && !budget.take()) continue; // stays due; next run picks it up

      // Claim the channel so an overlapping run cannot deliver it twice.
      const claim = await env.DB.prepare(
        `UPDATE notifications
            SET ${channel}_status = 'sending', ${channel}_claimed_at = ?, ${channel}_attempts = ${channel}_attempts + 1
          WHERE id = ? AND ${channel}_status = ? AND ${channel}_attempts = ?`,
      )
        .bind(now, row.id, status, attempts)
        .run();
      if (claim.meta.changes !== 1) continue;

      try {
        if (channel === "email") await sendEmail(env, buildEmail(row.kind, payload, env));
        else await sendNtfy(env, buildNtfy(row.kind, payload, env));
        await env.DB.prepare(
          `UPDATE notifications SET ${channel}_status = 'sent', ${channel}_error = NULL WHERE id = ?`,
        )
          .bind(row.id)
          .run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Notification ${row.id} via ${channel} failed (attempt ${attempts + 1}): ${message}`);
        await env.DB.prepare(`UPDATE notifications SET ${channel}_status = 'failed', ${channel}_error = ? WHERE id = ?`)
          .bind(message.slice(0, 500), row.id)
          .run();
      }
    }
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
