// Monitor management API.

import { HttpError, readJsonObject } from "./http";
import { setMaintenance } from "./maintenance";
import { diagnose } from "./diagnosis";
import { computeMetrics, maintenanceOverlap, type IncidentSpan, type MaintenanceSpan } from "./metrics";
import type { MaintenanceMode } from "./notifications";
import { parseRequestHeaders, parseStoredHeaders, toApiHeaders } from "./headers";
import { isCheckLocation, runProbes } from "./prober";
import { parseInterval } from "./settings";
import { DAY } from "./time";
import { hourlyUptime } from "./uptime";
import { normalizeMonitorUrl } from "./url";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30_000;
export const ROLLING_WINDOW_MS = 30 * DAY;
const MAX_BULK = 500;

interface MonitorRow {
  id: number;
  name: string;
  url: string;
  group_name: string | null;
  timeout_ms: number;
  check_interval_minutes: number | null;
  created_at: number;
  observed_since: number;
  state: string;
  last_checked_at: number | null;
  last_status: number | null;
  last_error: string | null;
  last_duration_ms: number | null;
  maintenance_mode: MaintenanceMode;
  outage_started_at: number | null;
  maintenance_started_at: number | null;
  next_check_after: number | null;
  request_headers: string | null;
  check_location: string | null;
  cache_bust: number;
}

interface FailureRow {
  id: number;
  checked_at: number;
  url: string;
  status: number | null;
  error: string | null;
  duration_ms: number;
  redirects: string;
  headers: string | null;
  body: string | null;
  body_truncated: number;
}

interface IncidentRow {
  id: number;
  monitor_id: number;
  started_at: number;
  ended_at: number | null;
  failure_reason: string | null;
}

interface MaintenanceRow {
  monitor_id: number;
  mode: "notify" | "silent";
  started_at: number;
  ended_at: number | null;
}

const SELECT_MONITORS = `
  SELECT m.id, m.name, m.url, m.group_name, m.timeout_ms, m.check_interval_minutes, m.created_at, m.observed_since, m.state,
         m.last_checked_at, m.last_status, m.last_error, m.last_duration_ms, m.maintenance_mode,
         m.next_check_after, m.request_headers, m.check_location, m.cache_bust, i.started_at AS outage_started_at, p.started_at AS maintenance_started_at
    FROM monitors m
    LEFT JOIN incidents i ON i.monitor_id = m.id AND i.ended_at IS NULL
    LEFT JOIN maintenance_periods p ON p.monitor_id = m.id AND p.ended_at IS NULL`;

// ---- reads ----

/** Incidents and maintenance periods that overlap [from, now], grouped by monitor. */
export async function loadHistory(env: Env, from: number, monitorId?: number) {
  const filter = monitorId === undefined ? "" : "AND monitor_id = ?2";
  const bind = (s: D1PreparedStatement) => (monitorId === undefined ? s.bind(from) : s.bind(from, monitorId));
  const [incidents, maintenance] = await env.DB.batch<IncidentRow | MaintenanceRow>([
    bind(
      env.DB.prepare(
        `SELECT id, monitor_id, started_at, ended_at, failure_reason FROM incidents
          WHERE (ended_at IS NULL OR ended_at > ?1) ${filter} ORDER BY started_at DESC`,
      ),
    ),
    bind(
      env.DB.prepare(
        `SELECT monitor_id, mode, started_at, ended_at FROM maintenance_periods
          WHERE (ended_at IS NULL OR ended_at > ?1) ${filter}`,
      ),
    ),
  ]);
  const byMonitor = new Map<number, { incidents: IncidentRow[]; maintenance: MaintenanceRow[] }>();
  const entry = (id: number) => {
    let e = byMonitor.get(id);
    if (!e) byMonitor.set(id, (e = { incidents: [], maintenance: [] }));
    return e;
  };
  for (const r of incidents.results as IncidentRow[]) entry(r.monitor_id).incidents.push(r);
  for (const r of maintenance.results as MaintenanceRow[]) entry(r.monitor_id).maintenance.push(r);
  return (id: number) => byMonitor.get(id) ?? { incidents: [], maintenance: [] };
}

export const toIncidentSpans = (rows: IncidentRow[]): IncidentSpan[] =>
  rows.map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at }));
export const toMaintenanceSpans = (rows: MaintenanceRow[]): MaintenanceSpan[] =>
  rows.map((r) => ({ mode: r.mode, startedAt: r.started_at, endedAt: r.ended_at }));

function toApi(row: MonitorRow, history: { incidents: IncidentRow[]; maintenance: MaintenanceRow[] }, now: number) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    group: row.group_name,
    timeoutMs: row.timeout_ms,
    /** null follows the default interval from the settings. */
    checkIntervalMinutes: row.check_interval_minutes,
    /** Extra headers sent with each check, only to the monitor URL's host. */
    requestHeaders: toApiHeaders(row.request_headers),
    /** Location hint the checks run from; null follows CHECK_LOCATION. */
    checkLocation: row.check_location,
    /** Each check adds a unique `_uptime` query parameter so a CDN can't answer from cache. */
    cacheBust: row.cache_bust === 1,
    createdAt: row.created_at,
    observedSince: row.observed_since,
    state: row.state,
    maintenanceMode: row.maintenance_mode,
    maintenanceStartedAt: row.maintenance_started_at,
    currentOutageStartedAt: row.outage_started_at,
    /** Set while the site's Retry-After holds off the next check. */
    nextCheckAfter: row.next_check_after !== null && row.next_check_after > now ? row.next_check_after : null,
    lastCheck:
      row.last_checked_at === null
        ? null
        : { at: row.last_checked_at, status: row.last_status, error: row.last_error, durationMs: row.last_duration_ms },
    metrics30d: computeMetrics({
      from: now - ROLLING_WINDOW_MS,
      to: now,
      observedSince: row.observed_since,
      incidents: toIncidentSpans(history.incidents),
      maintenance: toMaintenanceSpans(history.maintenance),
    }),
  };
}

export async function listMonitors(env: Env, now = Date.now()) {
  const [{ results }, history] = await Promise.all([
    env.DB.prepare(`${SELECT_MONITORS} ORDER BY m.name COLLATE NOCASE, m.id`).all<MonitorRow>(),
    loadHistory(env, now - ROLLING_WINDOW_MS),
  ]);
  return { monitors: results.map((row) => toApi(row, history(row.id), now)), now };
}

export async function getMonitor(env: Env, id: number, now = Date.now()) {
  const [row, history, failures] = await Promise.all([
    env.DB.prepare(`${SELECT_MONITORS} WHERE m.id = ?`).bind(id).first<MonitorRow>(),
    loadHistory(env, now - ROLLING_WINDOW_MS, id),
    env.DB.prepare(`SELECT * FROM check_failures WHERE monitor_id = ? ORDER BY checked_at DESC, id DESC`)
      .bind(id)
      .all<FailureRow>(),
  ]);
  if (!row) throw new HttpError(404, "Monitor not found");
  const h = history(id);
  const maintenance = toMaintenanceSpans(h.maintenance);
  return {
    ...toApi(row, h, now),
    last24h: hourlyUptime(
      {
        observedSince: row.observed_since,
        incidents: h.incidents.map((i) => ({ id: i.id, startedAt: i.started_at, endedAt: i.ended_at })),
        maintenance,
      },
      now,
    ),
    incidents: h.incidents.map((i) => {
      const overlap = maintenanceOverlap({ startedAt: i.started_at, endedAt: i.ended_at }, maintenance, now);
      return {
        id: i.id,
        startedAt: i.started_at,
        endedAt: i.ended_at,
        ongoing: i.ended_at === null,
        durationMs: (i.ended_at ?? now) - i.started_at,
        failureReason: i.failure_reason,
        silentMaintenanceMs: overlap.silentMs,
        notifyMaintenanceMs: overlap.notifyMs,
      };
    }),
    failures: failures.results.map(({ id, checked_at, status, error, headers, body }) => {
      const d = diagnose(status, headers ? JSON.parse(headers) : null, body);
      return { id, checkedAt: checked_at, status, error, source: d.source, blocked: d.blocked, reference: d.reference };
    }),
  };
}

/** One failed check with the full response that was recorded. */
export async function getFailure(env: Env, monitorId: number, failureId: number) {
  const row = await env.DB.prepare(`SELECT * FROM check_failures WHERE id = ? AND monitor_id = ?`)
    .bind(failureId, monitorId)
    .first<FailureRow>();
  if (!row) throw new HttpError(404, "Failed check not found");
  const headers: [string, string][] | null = row.headers ? JSON.parse(row.headers) : null;
  return {
    id: row.id,
    checkedAt: row.checked_at,
    status: row.status,
    error: row.error,
    durationMs: row.duration_ms,
    diagnostics: {
      url: row.url,
      redirects: JSON.parse(row.redirects),
      headers,
      body: row.body,
      bodyTruncated: row.body_truncated === 1,
    },
    diagnosis: diagnose(row.status, headers, row.body),
  };
}

// ---- validation ----

function parseName(v: unknown): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (name.length < 1 || name.length > 100) throw new HttpError(400, "name must be 1-100 characters");
  return name;
}

function parseUrl(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "url is required");
  const url = normalizeMonitorUrl(v);
  if (!url.ok) throw new HttpError(400, `url: ${url.error}`);
  return url.url;
}

export function parseGroup(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim().length > 50) {
    throw new HttpError(400, "group must be a string of at most 50 characters");
  }
  return v.trim() || null;
}

function parseTimeout(v: unknown): number {
  const t = v ?? DEFAULT_TIMEOUT_MS;
  if (typeof t !== "number" || !Number.isInteger(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) {
    throw new HttpError(400, `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return t;
}

function parseMonitorInterval(v: unknown): number | null {
  return v === undefined || v === null ? null : parseInterval(v, "checkIntervalMinutes");
}

function parseCheckLocation(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !isCheckLocation(v)) {
    throw new HttpError(400, "checkLocation must be a Durable Object location hint such as weur, or null");
  }
  return v;
}

function parseCacheBust(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "boolean") throw new HttpError(400, "cacheBust must be true or false");
  return v ? 1 : 0;
}

function parseIds(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, "ids must be a non-empty array");
  if (v.length > MAX_BULK) throw new HttpError(400, `At most ${MAX_BULK} monitors per action`);
  if (!v.every((id) => Number.isInteger(id) && id > 0)) throw new HttpError(400, "ids must be positive integers");
  if (new Set(v).size !== v.length) throw new HttpError(400, "ids must not contain duplicates");
  return v as number[];
}

function parseMode(v: unknown, allowNone: boolean): MaintenanceMode {
  const modes = allowNone ? ["notify", "silent", "none"] : ["notify", "silent"];
  if (typeof v !== "string" || !modes.includes(v)) throw new HttpError(400, `mode must be one of ${modes.join(", ")}`);
  return v as MaintenanceMode;
}

function isUniqueViolation(err: unknown) {
  return String(err).includes("UNIQUE constraint failed");
}

// ---- writes ----

export async function createMonitor(env: Env, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const name = parseName(body.name);
  const url = parseUrl(body.url);
  const group = parseGroup(body.group);
  const timeoutMs = parseTimeout(body.timeoutMs);
  const interval = parseMonitorInterval(body.checkIntervalMinutes);
  const headers = parseRequestHeaders(body.requestHeaders);
  const location = parseCheckLocation(body.checkLocation);
  const cacheBust = parseCacheBust(body.cacheBust);
  try {
    const row = await env.DB.prepare(
      `INSERT INTO monitors
         (name, url, group_name, timeout_ms, check_interval_minutes, request_headers, check_location,
          cache_bust, created_at, observed_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(name, url, group, timeoutMs, interval, headers, location, cacheBust, now, now)
      .first<{ id: number }>();
    return getMonitor(env, row!.id, now);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "A monitor with this URL already exists");
    throw err;
  }
}

/**
 * Edits name, group, timeout, interval, request headers, check location and cache busting without
 * touching history. A URL change must be
 * confirmed and starts a new observation period: state, incidents and
 * maintenance history are reset so old data is never attributed to the new URL.
 */
export async function updateMonitor(env: Env, id: number, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const current = await env.DB.prepare(`SELECT url FROM monitors WHERE id = ?`).bind(id).first<{ url: string }>();
  if (!current) throw new HttpError(404, "Monitor not found");

  const sets: string[] = [];
  const params: unknown[] = [];
  if ("name" in body) sets.push("name = ?"), params.push(parseName(body.name));
  if ("group" in body) sets.push("group_name = ?"), params.push(parseGroup(body.group));
  if ("timeoutMs" in body) sets.push("timeout_ms = ?"), params.push(parseTimeout(body.timeoutMs));
  if ("checkIntervalMinutes" in body) {
    sets.push("check_interval_minutes = ?"), params.push(parseMonitorInterval(body.checkIntervalMinutes));
  }
  if ("requestHeaders" in body) sets.push("request_headers = ?"), params.push(parseRequestHeaders(body.requestHeaders));
  if ("checkLocation" in body) sets.push("check_location = ?"), params.push(parseCheckLocation(body.checkLocation));
  if ("cacheBust" in body) sets.push("cache_bust = ?"), params.push(parseCacheBust(body.cacheBust));

  const statements: D1PreparedStatement[] = [];
  const newUrl = "url" in body ? parseUrl(body.url) : current.url;
  if (newUrl !== current.url) {
    if (body.confirmUrlChange !== true) {
      throw new HttpError(409, "Changing the URL resets this monitor's state and history; resend with confirmUrlChange: true", {
        requiresConfirmation: true,
      });
    }
    sets.push(
      "url = ?",
      "state = 'pending'",
      "consecutive_failures = 0",
      "consecutive_successes = 0",
      "check_token = ?",
      "observed_since = ?",
      "last_checked_at = NULL",
      "last_status = NULL",
      "last_error = NULL",
      "last_duration_ms = NULL",
      "next_check_after = NULL",
    );
    params.push(newUrl, crypto.randomUUID(), now);
    statements.push(
      env.DB.prepare(`DELETE FROM incidents WHERE monitor_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM check_failures WHERE monitor_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM maintenance_periods WHERE monitor_id = ? AND ended_at IS NOT NULL`).bind(id),
      env.DB.prepare(`UPDATE maintenance_periods SET started_at = ? WHERE monitor_id = ? AND ended_at IS NULL`).bind(
        now,
        id,
      ),
    );
  }
  if (sets.length > 0) {
    statements.unshift(env.DB.prepare(`UPDATE monitors SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id));
    try {
      await env.DB.batch(statements);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "A monitor with this URL already exists");
      throw err;
    }
  }
  return getMonitor(env, id, now);
}

/** Diagnostics-only probe: reports the result without recording anything. */
export async function checkNow(env: Env, id: number) {
  const m = await env.DB.prepare(
    `SELECT url, timeout_ms, request_headers, check_location, cache_bust FROM monitors WHERE id = ?`,
  )
    .bind(id)
    .first<{
      url: string;
      timeout_ms: number;
      request_headers: string | null;
      check_location: string | null;
      cache_bust: number;
    }>();
  if (!m) throw new HttpError(404, "Monitor not found");
  const checkedAt = Date.now();
  const [result] = await runProbes(env, [
    {
      url: m.url,
      timeoutMs: m.timeout_ms,
      headers: parseStoredHeaders(m.request_headers),
      location: m.check_location,
      cacheBust: m.cache_bust === 1,
    },
  ]);
  const d = result.diagnostics;
  return { checkedAt, ...result, diagnosis: d ? diagnose(result.status, d.headers, d.body) : null };
}

export async function setMonitorMaintenance(env: Env, id: number, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const mode = parseMode(body.mode, true);
  await requireExisting(env, [id]);
  await setMaintenance(env, [id], mode, now);
  return getMonitor(env, id, now);
}

export async function deleteMonitor(env: Env, id: number, url: URL) {
  // Permanent deletion of the monitor and its incident history must be explicit.
  if (url.searchParams.get("confirm") !== "true") {
    throw new HttpError(400, "Deletion is permanent; repeat the request with ?confirm=true");
  }
  const result = await env.DB.prepare(`DELETE FROM monitors WHERE id = ?`).bind(id).run();
  if (result.meta.changes === 0) throw new HttpError(404, "Monitor not found");
}

/**
 * Group actions on an explicit selection. Every bulk action requires
 * `confirm: true`; the selection must be exactly the ids the UI showed.
 */
export async function bulkAction(env: Env, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const ids = parseIds(body.ids);
  if (body.confirm !== true) throw new HttpError(400, "Bulk actions require confirm: true");
  await requireExisting(env, ids);

  switch (body.action) {
    case "maintenance": {
      const mode = parseMode(body.mode, false);
      const changed = await setMaintenance(env, ids, mode, now);
      return { action: "maintenance", mode, selected: ids.length, changed: changed.length };
    }
    case "end-maintenance": {
      const changed = await setMaintenance(env, ids, "none", now);
      return { action: "end-maintenance", selected: ids.length, changed: changed.length };
    }
    case "delete": {
      const result = await env.DB.prepare(`DELETE FROM monitors WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(ids))
        .run();
      return { action: "delete", selected: ids.length, changed: result.meta.changes };
    }
    default:
      throw new HttpError(400, "action must be one of maintenance, end-maintenance, delete");
  }
}

async function requireExisting(env: Env, ids: number[]) {
  const { results } = await env.DB.prepare(`SELECT id FROM monitors WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<{ id: number }>();
  if (results.length !== ids.length) {
    const found = new Set(results.map((r) => r.id));
    throw new HttpError(404, "Some monitors no longer exist; refresh and review the selection", {
      missing: ids.filter((id) => !found.has(id)),
    });
  }
}
