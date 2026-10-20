// Settings changed from the dashboard, stored in D1: the ntfy channel, the default check
// interval and the Akamai troubleshooter link. ntfy falls back to the Wrangler secrets until it is saved from the dashboard.

import { HttpError, readJsonObject } from "./http";
import { normalizeMonitorUrl } from "./url";

export const DEFAULT_NTFY_URL = "https://ntfy.sh";

/** Check intervals offered in the dashboard, in minutes. The scheduler runs every minute. */
export const CHECK_INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60] as const;
export const DEFAULT_CHECK_INTERVAL = 1;

interface StoredNtfy {
  url: string;
  topic: string;
  token: string | null;
}

interface StoredChecks {
  defaultIntervalMinutes: number;
}

interface StoredDiagnostics {
  akamaiTroubleshooterUrl: string | null;
}

async function readSetting<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

function writeSetting(env: Env, key: string, value: unknown, now: number) {
  return env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
  )
    .bind(key, JSON.stringify(value), now)
    .run();
}

// ---- ntfy ----

export type NtfySource = "dashboard" | "secrets";

/** The ntfy settings notifications are sent with. `topic` empty means ntfy is off. */
export interface NtfyConfig {
  source: NtfySource;
  url: string;
  topic: string;
  token: string | null;
}

const trimUrl = (url: string) => url.replace(/\/$/, "");

/** Dashboard settings win once saved; until then the Wrangler secrets apply. */
export async function loadNtfyConfig(env: Env): Promise<NtfyConfig> {
  const stored = await readSetting<StoredNtfy>(env, "ntfy");
  if (stored) return { source: "dashboard", url: trimUrl(stored.url), topic: stored.topic, token: stored.token };
  return {
    source: "secrets",
    url: trimUrl(env.NTFY_URL || DEFAULT_NTFY_URL),
    topic: env.NTFY_TOPIC ?? "",
    token: env.NTFY_TOKEN || null,
  };
}

function parseNtfyUrl(v: unknown): string {
  if (v === undefined || v === null || v === "") return DEFAULT_NTFY_URL;
  if (typeof v !== "string") throw new HttpError(400, "url must be a string");
  const url = normalizeMonitorUrl(v);
  if (!url.ok) throw new HttpError(400, `url: ${url.error}`);
  return trimUrl(url.url);
}

function parseTopic(v: unknown): string {
  const topic = typeof v === "string" ? v.trim() : "";
  if (topic && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    throw new HttpError(400, "topic may only contain letters, digits, - and _ (at most 64)");
  }
  return topic;
}

function parseToken(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  if (v.trim().length > 200) throw new HttpError(400, "token is too long");
  return v.trim();
}

/**
 * Body: { url, topic, token?, clearToken? }. An omitted or empty token keeps the saved one
 * (or the secret's, when switching from secrets), so it never has to leave the server.
 */
export async function saveNtfySettings(env: Env, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const current = await loadNtfyConfig(env);
  const token = body.clearToken === true ? null : (parseToken(body.token) ?? current.token);
  const stored: StoredNtfy = { url: parseNtfyUrl(body.url), topic: parseTopic(body.topic), token };
  await writeSetting(env, "ntfy", stored, now);
  return getSettings(env);
}

/** Forgets the dashboard's ntfy settings, so the Wrangler secrets apply again. */
export async function resetNtfySettings(env: Env) {
  await env.DB.prepare(`DELETE FROM settings WHERE key = 'ntfy'`).run();
  return getSettings(env);
}

/**
 * Sends a test message. With a body it tests those (unsaved) values; an empty token there
 * means the saved one. Without a body it tests the settings in use.
 */
export async function sendNtfyTest(env: Env, request: Request, send: (config: NtfyConfig, body: object) => Promise<void>) {
  const text = await request.text();
  let config = await loadNtfyConfig(env);
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Body must be JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpError(400, "Body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    config = {
      source: "dashboard",
      url: parseNtfyUrl(b.url),
      topic: parseTopic(b.topic),
      token: b.clearToken === true ? null : (parseToken(b.token) ?? config.token),
    };
  }
  if (!config.topic) throw new HttpError(400, "Set a topic to send a test notification");
  const sentAt = Date.now();
  try {
    await send(config, {
      topic: config.topic,
      title: "Uptime Monitor test notification",
      message: "ntfy is set up correctly. Outage and recovery alerts will arrive like this.",
      priority: 3,
      tags: ["white_check_mark"],
      ...(env.DASHBOARD_URL ? { click: env.DASHBOARD_URL } : {}),
    });
  } catch (err) {
    throw new HttpError(502, `Test notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { sent: true, sentAt };
}

// ---- checks ----

export async function loadCheckSettings(env: Env): Promise<StoredChecks> {
  const stored = await readSetting<StoredChecks>(env, "checks");
  return { defaultIntervalMinutes: stored?.defaultIntervalMinutes ?? DEFAULT_CHECK_INTERVAL };
}

export function parseInterval(v: unknown, name: string): number {
  if (typeof v !== "number" || !(CHECK_INTERVALS as readonly number[]).includes(v)) {
    throw new HttpError(400, `${name} must be one of ${CHECK_INTERVALS.join(", ")} (minutes)`);
  }
  return v;
}

export async function saveCheckSettings(env: Env, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const stored: StoredChecks = { defaultIntervalMinutes: parseInterval(body.defaultIntervalMinutes, "defaultIntervalMinutes") };
  await writeSetting(env, "checks", stored, now);
  return getSettings(env);
}

// ---- diagnostics ----

export async function loadDiagnosticsSettings(env: Env): Promise<StoredDiagnostics> {
  const stored = await readSetting<StoredDiagnostics>(env, "diagnostics");
  return { akamaiTroubleshooterUrl: stored?.akamaiTroubleshooterUrl ?? null };
}

function parseTroubleshooterUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, "akamaiTroubleshooterUrl must be a string");
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    throw new HttpError(400, "akamaiTroubleshooterUrl must be a full URL, e.g. https://example.com/troubleshoot");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "akamaiTroubleshooterUrl must start with https:// or http://");
  }
  return url.toString();
}

/** Body: { akamaiTroubleshooterUrl }. Empty turns the link off. */
export async function saveDiagnosticsSettings(env: Env, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const stored: StoredDiagnostics = { akamaiTroubleshooterUrl: parseTroubleshooterUrl(body.akamaiTroubleshooterUrl) };
  await writeSetting(env, "diagnostics", stored, now);
  return getSettings(env);
}

// ---- read ----

/** Everything the settings page shows. Tokens and secret values never leave the server. */
export async function getSettings(env: Env) {
  const [ntfy, checks, diagnostics] = await Promise.all([
    loadNtfyConfig(env),
    loadCheckSettings(env),
    loadDiagnosticsSettings(env),
  ]);
  return {
    ntfy: {
      source: ntfy.source,
      enabled: ntfy.topic !== "",
      // Values from secrets are not shown; the dashboard only says whether they are set.
      url: ntfy.source === "dashboard" ? ntfy.url : null,
      topic: ntfy.source === "dashboard" ? ntfy.topic : null,
      tokenSet: ntfy.token !== null,
      secrets: { url: Boolean(env.NTFY_URL), topic: Boolean(env.NTFY_TOPIC), token: Boolean(env.NTFY_TOKEN) },
    },
    checks: { ...checks, intervals: CHECK_INTERVALS },
    diagnostics,
  };
}
