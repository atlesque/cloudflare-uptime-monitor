import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMonitor,
  advance,
  api,
  cycle,
  fakeMailer,
  fakeNtfy,
  fakeSites,
  getMonitor,
  json,
  listMonitors,
  makeEnv,
  MINUTE,
  NTFY_URL,
  resetDb,
  useClock,
} from "./helpers";

const SITE = "https://shop.example/";
const OTHER_NTFY = "https://push.example";

beforeEach(async () => {
  await resetDb();
  useClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(path: string, init?: RequestInit, e: Env = makeEnv()) {
  const res = await api(path, init, e);
  return { status: res.status, body: (await res.json()) as any };
}

/** Takes a monitor down (two failed checks) so a notification is delivered. */
async function goDown(e: Env, ntfyUrl: string, ntfy: ReturnType<typeof fakeNtfy>) {
  fakeSites({ [SITE]: 503, [`${ntfyUrl}/`]: ntfy.handler });
  await addMonitor({ name: "Shop", url: SITE });
  await cycle(e);
  advance(MINUTE);
  await cycle(e);
}

describe("ntfy settings", () => {
  it("uses the Wrangler secrets until settings are saved, without revealing them", async () => {
    const { body } = await call("/api/settings");
    expect(body.ntfy).toEqual({
      source: "secrets",
      enabled: true,
      url: null,
      topic: null,
      tokenSet: true,
      secrets: { url: true, topic: true, token: true },
    });
    expect(JSON.stringify(body)).not.toContain("tk_test");
  });

  it("sends with the dashboard's settings once saved, keeping the secret token when none is given", async () => {
    const e = makeEnv();
    const saved = await call("/api/settings/ntfy", json("PUT", { url: `${OTHER_NTFY}/`, topic: "ops-alerts" }), e);
    expect(saved.status).toBe(200);
    expect(saved.body.ntfy).toMatchObject({ source: "dashboard", url: OTHER_NTFY, topic: "ops-alerts", tokenSet: true });

    const ntfy = fakeNtfy();
    await goDown(e, OTHER_NTFY, ntfy);
    expect(ntfy.published).toHaveLength(1);
    expect(ntfy.published[0].body.topic).toBe("ops-alerts");
    expect(ntfy.published[0].authorization).toBe("Bearer tk_test");
  });

  it("replaces or clears the token, and never returns it", async () => {
    const e = makeEnv();
    let res = await call("/api/settings/ntfy", json("PUT", { topic: "t", token: "tk_new" }), e);
    expect(res.body.ntfy).toMatchObject({ url: "https://ntfy.sh", tokenSet: true });
    expect(JSON.stringify(res.body)).not.toContain("tk_new");

    res = await call("/api/settings/ntfy", json("PUT", { topic: "t", clearToken: true }), e);
    expect(res.body.ntfy.tokenSet).toBe(false);
  });

  it("turns ntfy off with an empty topic, and back to the secrets on reset", async () => {
    const e = makeEnv(fakeMailer());
    await call("/api/settings/ntfy", json("PUT", { topic: "" }), e);
    expect((await call("/api/me", undefined, e)).body.notifications.ntfy).toBe(false);

    const reset = await call("/api/settings/ntfy", { method: "DELETE" }, e);
    expect(reset.body.ntfy.source).toBe("secrets");
    expect((await call("/api/me", undefined, e)).body.notifications.ntfy).toBe(true);
  });

  it("rejects invalid topics and private ntfy URLs", async () => {
    expect((await call("/api/settings/ntfy", json("PUT", { topic: "a b" }))).status).toBe(400);
    expect((await call("/api/settings/ntfy", json("PUT", { topic: "t", url: "http://127.0.0.1" }))).status).toBe(400);
  });

  it("sends a test notification with unsaved values, falling back to the saved token", async () => {
    const ntfy = fakeNtfy();
    fakeSites({ [`${OTHER_NTFY}/`]: ntfy.handler });
    const res = await call("/api/settings/ntfy/test", json("POST", { url: OTHER_NTFY, topic: "trial" }));
    expect(res.status).toBe(200);
    expect(ntfy.published).toHaveLength(1);
    expect(ntfy.published[0].body).toMatchObject({ topic: "trial", title: "Uptime Monitor test notification" });
    expect(ntfy.published[0].authorization).toBe("Bearer tk_test");
    // Nothing was saved.
    expect((await call("/api/settings")).body.ntfy.source).toBe("secrets");
  });

  it("sends a test notification with the settings in use, and reports failures", async () => {
    const ntfy = fakeNtfy();
    ntfy.failures = 1;
    fakeSites({ [`${NTFY_URL}/`]: ntfy.handler });
    const failed = await call("/api/settings/ntfy/test", { method: "POST" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("ntfy responded 503");

    const ok = await call("/api/settings/ntfy/test", { method: "POST" });
    expect(ok.status).toBe(200);
    expect(ntfy.published[0].body.topic).toBe("uptime");
  });

  it("refuses a test without a topic", async () => {
    const res = await call("/api/settings/ntfy/test", { method: "POST" }, makeEnv(fakeMailer(), { NTFY_TOPIC: "" }));
    expect(res.status).toBe(400);
  });
});

describe("check intervals", () => {
  it("defaults to every minute and accepts only the offered intervals", async () => {
    expect((await call("/api/settings")).body.checks).toMatchObject({ defaultIntervalMinutes: 1 });
    expect((await call("/api/settings/checks", json("PUT", { defaultIntervalMinutes: 7 }))).status).toBe(400);
    const res = await call("/api/settings/checks", json("PUT", { defaultIntervalMinutes: 5 }));
    expect(res.body.checks.defaultIntervalMinutes).toBe(5);
  });

  it("checks a monitor only once its interval has passed", async () => {
    const probes = fakeSites({ [SITE]: 200 });
    await call("/api/settings/checks", json("PUT", { defaultIntervalMinutes: 5 }));
    await addMonitor({ name: "Shop", url: SITE });
    for (let i = 0; i < 10; i++) {
      await cycle();
      advance(MINUTE);
    }
    expect(probes).toHaveBeenCalledTimes(2);
  });

  it("lets a monitor override the default", async () => {
    const probes = fakeSites({ [SITE]: 200 });
    await call("/api/settings/checks", json("PUT", { defaultIntervalMinutes: 30 }));
    const { body } = await addMonitor({ name: "Shop", url: SITE, checkIntervalMinutes: 2 });
    expect(body.checkIntervalMinutes).toBe(2);
    for (let i = 0; i < 6; i++) {
      await cycle();
      advance(MINUTE);
    }
    expect(probes).toHaveBeenCalledTimes(3);

    const res = await api(`/api/monitors/${body.id}`, json("PATCH", { checkIntervalMinutes: null }));
    expect(((await res.json()) as any).checkIntervalMinutes).toBeNull();
    expect((await api(`/api/monitors/${body.id}`, json("PATCH", { checkIntervalMinutes: 4 }))).status).toBe(400);
  });
});

describe("groups", () => {
  beforeEach(async () => {
    await addMonitor({ name: "A", url: "https://a.example/", group: "Clients" });
    await addMonitor({ name: "B", url: "https://b.example/", group: "Clients" });
    await addMonitor({ name: "C", url: "https://c.example/", group: "Internal" });
    await addMonitor({ name: "D", url: "https://d.example/" });
  });

  it("lists groups with their monitor counts", async () => {
    expect((await call("/api/groups")).body.groups).toEqual([
      { name: "Clients", monitors: 2 },
      { name: "Internal", monitors: 1 },
    ]);
  });

  it("renames a group, merging into an existing one", async () => {
    let res = await call("/api/groups/rename", json("POST", { from: "Clients", to: "Customers" }));
    expect(res.body).toMatchObject({ changed: 2 });
    res = await call("/api/groups/rename", json("POST", { from: "Internal", to: "Customers" }));
    expect(res.body.groups).toEqual([{ name: "Customers", monitors: 3 }]);
    expect((await call("/api/groups/rename", json("POST", { from: "Nope", to: "X" }))).status).toBe(404);
  });

  it("removes a group only when confirmed, keeping its monitors", async () => {
    expect((await call("/api/groups/remove", json("POST", { name: "Clients" }))).status).toBe(400);
    const res = await call("/api/groups/remove", json("POST", { name: "Clients", confirm: true }));
    expect(res.body.groups).toEqual([{ name: "Internal", monitors: 1 }]);
    const monitors = await listMonitors();
    expect(monitors).toHaveLength(4);
    expect(monitors.filter((m) => m.group === null)).toHaveLength(3);
    expect((await getMonitor(monitors[0].id)).group).toBeNull();
  });

  it("adds an empty group, which stays listed until removed", async () => {
    let res = await call("/api/groups", json("POST", { name: " Staging " }));
    expect(res.status).toBe(201);
    expect(res.body.groups).toContainEqual({ name: "Staging", monitors: 0 });
    expect((await call("/api/groups", json("POST", { name: "Staging" }))).status).toBe(409);
    expect((await call("/api/groups", json("POST", { name: "  " }))).status).toBe(400);
    res = await call("/api/groups/remove", json("POST", { name: "Staging", confirm: true }));
    expect(res.body.groups.map((g: any) => g.name)).toEqual(["Clients", "Internal"]);
  });

  it("adds a group with monitors, moving them from their old group", async () => {
    const [a, , c] = await listMonitors();
    const res = await call("/api/groups", json("POST", { name: "Mixed", monitorIds: [a.id, c.id] }));
    expect(res.body.groups).toEqual([
      { name: "Clients", monitors: 1 },
      { name: "Internal", monitors: 0 },
      { name: "Mixed", monitors: 2 },
    ]);
    expect((await getMonitor(c.id)).group).toBe("Mixed");
  });

  it("keeps a group after its last monitor leaves it", async () => {
    const c = (await listMonitors()).find((m) => m.name === "C")!;
    await api(`/api/monitors/${c.id}`, json("PATCH", { group: null }));
    expect((await call("/api/groups")).body.groups).toContainEqual({ name: "Internal", monitors: 0 });
  });

  it("adds a group when a monitor is saved with a new group name", async () => {
    await addMonitor({ name: "E", url: "https://e.example/", group: "Partners" });
    expect((await call("/api/groups")).body.groups).toContainEqual({ name: "Partners", monitors: 1 });
  });

  it("edits a group's monitors and name in one request", async () => {
    const byName = Object.fromEntries((await listMonitors()).map((m) => [m.name, m]));
    const res = await call(
      "/api/groups/edit",
      json("POST", { name: "Clients", to: "Customers", monitorIds: [byName.B.id, byName.D.id] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([
      { name: "Customers", monitors: 2 },
      { name: "Internal", monitors: 1 },
    ]);
    expect((await getMonitor(byName.A.id)).group).toBeNull();
    expect((await getMonitor(byName.D.id)).group).toBe("Customers");
  });

  it("merges when an edit renames onto an existing group", async () => {
    const res = await call("/api/groups/edit", json("POST", { name: "Internal", to: "Clients" }));
    expect(res.body.groups).toEqual([{ name: "Clients", monitors: 3 }]);
  });

  it("rejects edits to missing groups or monitors", async () => {
    expect((await call("/api/groups/edit", json("POST", { name: "Nope", to: "X" }))).status).toBe(404);
    expect((await call("/api/groups/edit", json("POST", { name: "Clients", monitorIds: [999] }))).status).toBe(404);
    expect((await call("/api/groups/edit", json("POST", { name: "Clients", monitorIds: ["1"] }))).status).toBe(400);
    expect((await call("/api/groups/edit", json("POST", { name: "Clients", to: "" }))).status).toBe(400);
    expect((await call("/api/groups")).body.groups).toEqual([
      { name: "Clients", monitors: 2 },
      { name: "Internal", monitors: 1 },
    ]);
  });
});

describe("diagnostics settings", () => {
  it("saves the Akamai troubleshooter link and shares it with the dashboard", async () => {
    expect((await call("/api/settings")).body.diagnostics).toEqual({ akamaiTroubleshooterUrl: null });
    expect((await call("/api/settings/diagnostics", json("PUT", { akamaiTroubleshooterUrl: "not a url" }))).status).toBe(400);
    expect((await call("/api/settings/diagnostics", json("PUT", { akamaiTroubleshooterUrl: "javascript:alert(1)" }))).status).toBe(400);

    const saved = await call("/api/settings/diagnostics", json("PUT", { akamaiTroubleshooterUrl: " https://diagnostic.example/vo " }));
    expect(saved.body.diagnostics).toEqual({ akamaiTroubleshooterUrl: "https://diagnostic.example/vo" });
    expect((await call("/api/me")).body.akamaiTroubleshooterUrl).toBe("https://diagnostic.example/vo");

    await call("/api/settings/diagnostics", json("PUT", { akamaiTroubleshooterUrl: "" }));
    expect((await call("/api/me")).body.akamaiTroubleshooterUrl).toBeNull();
  });
});
