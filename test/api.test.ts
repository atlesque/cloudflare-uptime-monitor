import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget";
import { runChecks } from "../src/checks";
import {
  addMonitor,
  advance,
  api,
  cycle,
  fakeMailer,
  fakeNtfy,
  fakeSites,
  getMonitor,
  incidents,
  json,
  listMonitors,
  makeEnv,
  MINUTE,
  notificationRows,
  NTFY_URL,
  resetDb,
  useClock,
} from "./helpers";

const SITE = "https://site.example/";
const check = () => runChecks(env, new Budget(100));

beforeEach(async () => {
  await resetDb();
  useClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function failTwice(id: number) {
  fakeSites({ [SITE]: 500 });
  await check();
  advance(MINUTE);
  await check();
  expect((await getMonitor(id)).state).toBe("down");
}

describe("creating and listing monitors", () => {
  it("creates a Pending monitor with a normalized URL and default timeout", async () => {
    const { status, body } = await addMonitor({ name: " Main site ", url: "https://WWW.Example.com#top", group: "Clients" });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      name: "Main site",
      url: "https://www.example.com/",
      group: "Clients",
      timeoutMs: 10_000,
      state: "pending",
      maintenanceMode: "none",
      maintenanceStartedAt: null,
      lastCheck: null,
      currentOutageStartedAt: null,
      incidents: [],
    });
    expect(body.observedSince).toBe(body.createdAt);
  });

  it("lists monitors by name with rolling 30-day metrics", async () => {
    await addMonitor({ name: "beta", url: "https://b.example/" });
    await addMonitor({ name: "Alpha", url: "https://a.example/" });
    advance(MINUTE);
    const monitors = await listMonitors();
    expect(monitors.map((m) => m.name)).toEqual(["Alpha", "beta"]);
    expect(monitors[0].metrics30d).toMatchObject({ uptimePct: 100, downtimeMs: 0, outages: 0, observedMs: MINUTE });
  });

  it("rejects duplicate normalized URLs", async () => {
    await addMonitor({ name: "One", url: "https://example.com/" });
    const { status, body } = await addMonitor({ name: "Two", url: "https://EXAMPLE.com:443" });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already exists/);
  });

  it.each([
    [{ url: "https://example.com/" }, /name/],
    [{ name: "x" }, /url is required/],
    [{ name: "x", url: "http://192.168.0.10/" }, /Private/],
    [{ name: "x", url: "http://localhost:8080/" }, /Internal/],
    [{ name: "x", url: "https://example.com/", timeoutMs: 500 }, /timeoutMs/],
    [{ name: "x", url: "https://example.com/", timeoutMs: 2.5 }, /timeoutMs/],
    [{ name: "x", url: "https://example.com/", group: 7 }, /group/],
    [{ name: "x", url: "https://example.com/", group: ["a", "b"] }, /group/],
  ])("rejects invalid input %j", async (input, message) => {
    const { status, body } = await addMonitor(input);
    expect(status).toBe(400);
    expect(body.error).toMatch(message);
  });

  it("rejects malformed requests", async () => {
    expect((await api("/api/monitors", { method: "POST", body: "nope" })).status).toBe(400);
    expect((await api("/api/monitors", { method: "PUT" })).status).toBe(405);
    expect((await api("/api/unknown")).status).toBe(404);
    expect((await api("/api/monitors/999")).status).toBe(404);
  });
});

describe("editing monitors", () => {
  it("edits name, group and timeout without resetting state or history", async () => {
    const { body } = await addMonitor({ name: "Site", url: SITE, group: "Old" });
    await failTwice(body.id);

    const res = await api(`/api/monitors/${body.id}`, json("PATCH", { name: "Renamed", group: "New", timeoutMs: 5000 }));
    expect(res.status).toBe(200);
    const m = (await res.json()) as any;
    expect(m).toMatchObject({ name: "Renamed", group: "New", timeoutMs: 5000, state: "down", observedSince: body.observedSince });
    expect(m.incidents).toHaveLength(1);
  });

  it("clears the group with null, keeping at most one group", async () => {
    const { body } = await addMonitor({ name: "Site", url: SITE, group: "Old" });
    const m = (await (await api(`/api/monitors/${body.id}`, json("PATCH", { group: null }))).json()) as any;
    expect(m.group).toBeNull();
  });

  it("requires confirmation to change the URL", async () => {
    const { body } = await addMonitor({ name: "Site", url: SITE });
    const res = await api(`/api/monitors/${body.id}`, json("PATCH", { url: "https://other.example/" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ requiresConfirmation: true });
    expect((await getMonitor(body.id)).url).toBe(SITE);
  });

  it("starts a new observation period when a URL change is confirmed", async () => {
    const { body } = await addMonitor({ name: "Site", url: SITE });
    await failTwice(body.id);
    advance(10 * MINUTE);

    const res = await api(
      `/api/monitors/${body.id}`,
      json("PATCH", { url: "https://other.example", confirmUrlChange: true, name: "Other" }),
    );
    const m = (await res.json()) as any;
    expect(m).toMatchObject({
      name: "Other",
      url: "https://other.example/",
      state: "pending",
      lastCheck: null,
      currentOutageStartedAt: null,
      observedSince: Date.now(),
      incidents: [],
    });
    expect(m.createdAt).toBe(body.createdAt);
    expect(m.metrics30d.observedMs).toBe(0);
    expect(await incidents(body.id)).toHaveLength(0);
  });

  it("treats an equivalent URL as unchanged", async () => {
    const { body } = await addMonitor({ name: "Site", url: SITE });
    const res = await api(`/api/monitors/${body.id}`, json("PATCH", { url: "https://SITE.example" }));
    expect(res.status).toBe(200);
  });

  it("rejects a URL change that collides with another monitor", async () => {
    await addMonitor({ name: "Taken", url: "https://taken.example/" });
    const { body } = await addMonitor({ name: "Site", url: SITE });
    const res = await api(
      `/api/monitors/${body.id}`,
      json("PATCH", { url: "https://taken.example/", confirmUrlChange: true }),
    );
    expect(res.status).toBe(409);
  });
});

describe("Check now", () => {
  it("returns a diagnostic result without changing state, incidents, metrics or notifications", async () => {
    const { body } = await addMonitor({ name: "Site", url: SITE });
    const before = await getMonitor(body.id);
    fakeSites({ [SITE]: 503 });

    for (let i = 0; i < 3; i++) {
      const res = await api(`/api/monitors/${body.id}/check`, { method: "POST" });
      expect(await res.json()).toMatchObject({ ok: false, status: 503, error: "HTTP 503" });
    }

    expect(await getMonitor(body.id)).toEqual(before);
    expect(await incidents(body.id)).toHaveLength(0);
    expect(await notificationRows()).toHaveLength(0);
  });
});

describe("monitor details", () => {
  it("shows 30-day incidents with duration, reason and maintenance status", async () => {
    const mailer = fakeMailer();
    const ntfy = fakeNtfy();
    const { body } = await addMonitor({ name: "Site", url: SITE });
    fakeSites({ [SITE]: [500, 500, 500, 200, 200], [NTFY_URL + "/"]: ntfy.handler });
    const e = makeEnv(mailer);
    await cycle(e); // fail 1
    advance(MINUTE);
    await cycle(e); // fail 2: Down
    await api(`/api/monitors/${body.id}/maintenance`, json("PUT", { mode: "silent" }));
    advance(MINUTE);
    await cycle(e); // still down
    advance(MINUTE);
    await cycle(e); // success 1
    advance(MINUTE);
    await cycle(e); // success 2: Up

    const m = await getMonitor(body.id);
    expect(m.incidents).toEqual([
      {
        id: expect.any(Number),
        startedAt: Date.now() - 3 * MINUTE,
        endedAt: Date.now(),
        ongoing: false,
        durationMs: 3 * MINUTE,
        failureReason: "HTTP 500",
        silentMaintenanceMs: 3 * MINUTE,
        notifyMaintenanceMs: 0,
      },
    ]);
    expect(m.maintenanceMode).toBe("silent");
    expect(m.metrics30d).toMatchObject({ outages: 0, outagesInclusive: 1, downtimeMs: 0, downtimeInclusiveMs: 3 * MINUTE });
  });
});

describe("deleting monitors", () => {
  it("requires explicit confirmation, then removes the monitor and its incident history", async () => {
    const { body } = await addMonitor({ name: "Doomed", url: SITE });
    await failTwice(body.id);
    expect(await incidents(body.id)).toHaveLength(1);

    expect((await api(`/api/monitors/${body.id}`, { method: "DELETE" })).status).toBe(400);
    expect((await api(`/api/monitors/${body.id}?confirm=true`, { method: "DELETE" })).status).toBe(204);
    expect((await api(`/api/monitors/${body.id}`)).status).toBe(404);
    expect(await incidents(body.id)).toHaveLength(0);
    expect(await notificationRows()).toHaveLength(0);
  });
});

describe("dashboard", () => {
  it("serves the dashboard page", async () => {
    const res = await api("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("reports which notification channels are configured", async () => {
    const res = await api("/api/me", undefined, makeEnv(fakeMailer(), { NTFY_URL: "" }));
    expect(await res.json()).toEqual({ timeZone: "Europe/Brussels", notifications: { email: true, ntfy: false } });
  });
});
