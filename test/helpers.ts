import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { runCycle } from "../src/cycle";
import worker from "../src/index";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Wednesday 30 September 2026, 12:00 Europe/Brussels (CEST). */
export const T0 = Date.UTC(2026, 8, 30, 10, 0);

// ---- time ----

/** Fakes only Date, so real timeouts (AbortSignal.timeout) keep working. */
export function useClock(start = T0) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
}

export function setTime(ms: number) {
  vi.setSystemTime(ms);
}

export function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

// ---- fake target sites ----

/** A fake response: a status, a redirect, a network error, a hang, or a handler. */
export type Reply =
  | number
  | { status: number; location: string }
  | Error
  | "hang"
  | ((request: Request) => Response | Promise<Response>);

/**
 * Replaces outbound fetch with fake sites keyed by exact URL. A route given as an
 * array replies with each entry in turn, then keeps repeating the last one.
 */
export function fakeSites(routes: Record<string, Reply | Reply[]>) {
  const queues = new Map(Object.entries(routes).map(([url, r]) => [url, Array.isArray(r) ? [...r] : [r]]));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const queue = queues.get(request.url);
    if (!queue) throw new Error(`Unexpected fetch to ${request.url}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (typeof reply === "function") return reply(request);
    if (reply === "hang") {
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    }
    if (reply instanceof Error) throw reply;
    if (typeof reply === "number") {
      return new Response([204, 205, 304].includes(reply) ? null : "body", { status: reply });
    }
    return new Response(null, { status: reply.status, headers: { Location: reply.location } });
  });
}

// ---- fake notification channels ----

export const NTFY_URL = "https://ntfy.example";

export interface SentEmail {
  to: string[];
  from: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
}

/** Fake Email Service binding. `failures` makes the next N sends throw. */
export function fakeMailer() {
  const mailer = {
    sent: [] as SentEmail[],
    failures: 0,
    send: async (message: SentEmail) => {
      if (mailer.failures > 0) {
        mailer.failures--;
        throw new Error("Email provider unavailable");
      }
      mailer.sent.push(message);
      return { messageId: `m${mailer.sent.length}` };
    },
  };
  return mailer;
}

/** Fake ntfy server that records published messages; `failures` makes the next N publishes fail. */
export function fakeNtfy() {
  const ntfy = {
    published: [] as { body: any; authorization: string | null }[],
    failures: 0,
    handler: async (request: Request) => {
      if (ntfy.failures > 0) {
        ntfy.failures--;
        return new Response("unavailable", { status: 503 });
      }
      ntfy.published.push({ body: await request.json(), authorization: request.headers.get("Authorization") });
      return Response.json({ id: "x" });
    },
  };
  return ntfy;
}

export type Mailer = ReturnType<typeof fakeMailer>;

/** The test Env with notifications configured against a fake mailer. */
export function makeEnv(mailer: Mailer = fakeMailer(), overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    EMAIL: mailer as unknown as SendEmail,
    EMAIL_FROM: "uptime@example.com",
    EMAIL_TO: "ops@example.com, alerts@example.com",
    NTFY_URL,
    NTFY_TOPIC: "uptime",
    NTFY_TOKEN: "tk_test",
    DASHBOARD_URL: "https://uptime.example.com",
    ...overrides,
  };
}

export function cycle(e: Env = makeEnv()) {
  return runCycle(e);
}

// ---- API ----

export function api(path: string, init?: RequestInit, e: Env = env, origin = "http://localhost") {
  const request = new Request(`${origin}${path}`, init) as Request<unknown, IncomingRequestCfProperties>;
  return worker.fetch(request, e);
}

export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export async function addMonitor(body: Record<string, unknown>) {
  const res = await api("/api/monitors", json("POST", body));
  return { status: res.status, body: (await res.json()) as any };
}

export async function getMonitor(id: number) {
  return (await (await api(`/api/monitors/${id}`)).json()) as any;
}

export async function listMonitors() {
  return ((await (await api("/api/monitors")).json()) as any).monitors as any[];
}

export async function setMaintenance(id: number, mode: string) {
  return api(`/api/monitors/${id}/maintenance`, json("PUT", { mode }));
}

export async function bulk(body: Record<string, unknown>) {
  const res = await api("/api/monitors/bulk", json("POST", body));
  return { status: res.status, body: (await res.json()) as any };
}

// ---- database fixtures and inspection ----

export async function insertMonitor(name: string, url: string, createdAt: number): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO monitors (name, url, created_at, observed_since) VALUES (?, ?, ?, ?) RETURNING id`,
  )
    .bind(name, url, createdAt, createdAt)
    .first<{ id: number }>();
  return row!.id;
}

export async function insertIncident(monitorId: number, startedAt: number, endedAt: number | null, reason = "HTTP 500") {
  await env.DB.prepare(`INSERT INTO incidents (monitor_id, started_at, ended_at, failure_reason) VALUES (?, ?, ?, ?)`)
    .bind(monitorId, startedAt, endedAt, reason)
    .run();
}

export async function insertMaintenance(monitorId: number, mode: string, startedAt: number, endedAt: number | null) {
  await env.DB.prepare(`INSERT INTO maintenance_periods (monitor_id, mode, started_at, ended_at) VALUES (?, ?, ?, ?)`)
    .bind(monitorId, mode, startedAt, endedAt)
    .run();
}

export async function incidents(monitorId: number) {
  const { results } = await env.DB.prepare(
    `SELECT started_at, ended_at, failure_reason FROM incidents WHERE monitor_id = ? ORDER BY started_at`,
  )
    .bind(monitorId)
    .all<{ started_at: number; ended_at: number | null; failure_reason: string | null }>();
  return results;
}

export async function notificationRows() {
  const { results } = await env.DB.prepare(
    `SELECT kind, email_status, email_attempts, ntfy_status, ntfy_attempts FROM notifications ORDER BY id`,
  ).all();
  return results;
}

export async function resetDb() {
  await env.DB.batch(
    ["notifications", "incidents", "maintenance_periods", "weekly_reports", "monitors"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
