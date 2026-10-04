import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget";
import { runChecks } from "../src/checks";
import {
  addMonitor,
  advance,
  bulk,
  cycle,
  DAY,
  fakeSites,
  getMonitor,
  incidents,
  listMonitors,
  MINUTE,
  NTFY_URL,
  resetDb,
  setMaintenance,
  useClock,
} from "./helpers";

beforeEach(async () => {
  await resetDb();
  useClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function monitors(...names: string[]) {
  const ids: number[] = [];
  for (const name of names) {
    const { body } = await addMonitor({ name, url: `https://${name.toLowerCase()}.example/` });
    ids.push(body.id);
  }
  return ids;
}

describe("per-monitor maintenance", () => {
  it.each(["notify", "silent"])("starts %s maintenance immediately and shows it on the monitor", async (mode) => {
    const [id] = await monitors("Site");
    const res = await setMaintenance(id, mode);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ maintenanceMode: mode, maintenanceStartedAt: Date.now() });
  });

  it("keeps checking monitors in maintenance", async () => {
    const [id] = await monitors("Site");
    await setMaintenance(id, "silent");
    fakeSites({ "https://site.example/": 200 });
    await runChecks(env, new Budget(10));
    expect((await getMonitor(id)).state).toBe("up");
  });

  it("never expires on its own", async () => {
    const [id] = await monitors("Site");
    await setMaintenance(id, "silent");
    fakeSites({ "https://site.example/": 200, [`${NTFY_URL}/`]: 200 });
    advance(45 * DAY);
    await cycle();
    expect((await getMonitor(id)).maintenanceMode).toBe("silent");
  });

  it("ends only through an explicit action", async () => {
    const [id] = await monitors("Site");
    await setMaintenance(id, "notify");
    advance(MINUTE);
    const m = (await (await setMaintenance(id, "none")).json()) as any;
    expect(m).toMatchObject({ maintenanceMode: "none", maintenanceStartedAt: null });
  });

  it("rejects unknown modes", async () => {
    const [id] = await monitors("Site");
    expect((await setMaintenance(id, "forever")).status).toBe(400);
  });

  it("keeps one continuous incident when silent maintenance starts while down", async () => {
    const [id] = await monitors("Site");
    fakeSites({ "https://site.example/": 503 });
    await runChecks(env, new Budget(10));
    advance(MINUTE);
    await runChecks(env, new Budget(10));
    await setMaintenance(id, "silent");
    for (let i = 0; i < 3; i++) {
      advance(MINUTE);
      await runChecks(env, new Budget(10));
    }
    await setMaintenance(id, "none");
    advance(MINUTE);
    await runChecks(env, new Budget(10));

    expect(await incidents(id)).toHaveLength(1);
    const m = await getMonitor(id);
    expect(m.incidents[0]).toMatchObject({ ongoing: true, durationMs: 4 * MINUTE, silentMaintenanceMs: 3 * MINUTE });
    expect(m.metrics30d).toMatchObject({
      outages: 1,
      outagesInclusive: 1,
      downtimeMs: MINUTE,
      downtimeInclusiveMs: 4 * MINUTE,
    });
  });
});

describe("bulk actions", () => {
  it("applies maintenance to a confirmed selection only", async () => {
    const [a, b, c] = await monitors("A", "B", "C");
    const { status, body } = await bulk({ action: "maintenance", mode: "silent", ids: [a, b], confirm: true });
    expect(status).toBe(200);
    expect(body).toEqual({ action: "maintenance", mode: "silent", selected: 2, changed: 2 });
    const modes = Object.fromEntries((await listMonitors()).map((m) => [m.id, m.maintenanceMode]));
    expect(modes).toEqual({ [a]: "silent", [b]: "silent", [c]: "none" });
  });

  it("requires explicit confirmation for every bulk action", async () => {
    const [a] = await monitors("A");
    for (const action of [{ action: "maintenance", mode: "notify" }, { action: "end-maintenance" }, { action: "delete" }]) {
      const { status, body } = await bulk({ ...action, ids: [a] });
      expect(status).toBe(400);
      expect(body.error).toMatch(/confirm/);
    }
    expect((await getMonitor(a)).maintenanceMode).toBe("none");
  });

  it("has no end-time field: maintenance stays until ended", async () => {
    const [a, b] = await monitors("A", "B");
    await bulk({ action: "maintenance", mode: "notify", ids: [a, b], confirm: true, endsAt: Date.now() + DAY });
    advance(2 * DAY);
    expect((await listMonitors()).every((m) => m.maintenanceMode === "notify")).toBe(true);
  });

  it("ends maintenance for a selection", async () => {
    const [a, b, c] = await monitors("A", "B", "C");
    await bulk({ action: "maintenance", mode: "notify", ids: [a, b, c], confirm: true });
    const { body } = await bulk({ action: "end-maintenance", ids: [a, c], confirm: true });
    expect(body).toEqual({ action: "end-maintenance", selected: 2, changed: 2 });
    const modes = Object.fromEntries((await listMonitors()).map((m) => [m.id, m.maintenanceMode]));
    expect(modes).toEqual({ [a]: "none", [b]: "notify", [c]: "none" });
  });

  it("refuses a selection containing monitors that no longer exist", async () => {
    const [a] = await monitors("A");
    const { status, body } = await bulk({ action: "maintenance", mode: "notify", ids: [a, 9999], confirm: true });
    expect(status).toBe(404);
    expect(body.missing).toEqual([9999]);
    expect((await getMonitor(a)).maintenanceMode).toBe("none");
  });

  it.each([
    [{ action: "maintenance", mode: "notify", ids: [], confirm: true }, /non-empty/],
    [{ action: "maintenance", mode: "notify", ids: [1, 1], confirm: true }, /duplicates/],
    [{ action: "maintenance", mode: "notify", ids: ["1"], confirm: true }, /integers/],
    [{ action: "maintenance", mode: "none", ids: [1], confirm: true }, /mode/],
    [{ action: "pause", ids: [1], confirm: true }, /action/],
  ])("validates %j", async (input, message) => {
    await monitors("A");
    const ids = (await listMonitors()).map((m) => m.id);
    const body = { ...input, ids: (input.ids as unknown[]).map((v) => (v === 1 ? ids[0] : v)) };
    const res = await bulk(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it("permanently deletes a confirmed selection", async () => {
    const [a, b, c] = await monitors("A", "B", "C");
    const { body } = await bulk({ action: "delete", ids: [a, c], confirm: true });
    expect(body).toEqual({ action: "delete", selected: 2, changed: 2 });
    expect((await listMonitors()).map((m) => m.id)).toEqual([b]);
  });
});
