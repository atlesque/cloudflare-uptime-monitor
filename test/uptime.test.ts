import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  DAY,
  getMonitor,
  HOUR,
  insertIncident,
  insertMaintenance,
  insertMonitor,
  MINUTE,
  resetDb,
  setTime,
  T0,
  useClock,
} from "./helpers";

/** 30 September 2026, 00:00 Europe/Brussels: the start of "today" at T0. */
const TODAY = Date.UTC(2026, 8, 29, 22, 0);

beforeEach(async () => {
  await resetDb();
  useClock();
});
afterEach(() => vi.useRealTimers());

async function uptime() {
  const res = await api("/api/uptime");
  expect(res.status).toBe(200);
  return (await res.json()) as { days: any[]; now: number };
}

describe("daily uptime", () => {
  it("returns 90 local days ending with today, which runs until now", async () => {
    const { days } = await uptime();
    expect(days).toHaveLength(90);
    expect(days.at(-1)).toMatchObject({ start: TODAY, end: T0 });
    expect(days.at(-2)).toMatchObject({ start: TODAY - DAY, end: TODAY });
    expect(days[0].start).toBe(TODAY - 89 * DAY);
  });

  it("counts each monitor only from its observation start", async () => {
    await insertMonitor("New", "https://new.example/", TODAY - DAY + 18 * HOUR);
    const { days } = await uptime();
    expect(days.at(-3).observedMs).toBe(0);
    expect(days.at(-2).observedMs).toBe(6 * HOUR);
    expect(days.at(-1).observedMs).toBe(T0 - TODAY);
  });

  it("splits incidents across days and lists the monitors that were down", async () => {
    const a = await insertMonitor("Alpha", "https://a.example/", TODAY - 10 * DAY);
    const b = await insertMonitor("Beta", "https://b.example/", TODAY - 10 * DAY);
    await insertIncident(a, TODAY - HOUR, TODAY + 30 * MINUTE);
    await insertIncident(b, TODAY + HOUR, null);

    const { days } = await uptime();
    expect(days.at(-2)).toMatchObject({
      observedMs: 2 * DAY,
      downtimeMs: HOUR,
      outages: 1,
      down: [{ id: a, name: "Alpha", downtimeMs: HOUR, outages: 1 }],
    });
    expect(days.at(-1)).toMatchObject({
      downtimeMs: 30 * MINUTE + (T0 - TODAY - HOUR),
      outages: 2,
      down: [
        { id: b, downtimeMs: T0 - TODAY - HOUR },
        { id: a, downtimeMs: 30 * MINUTE },
      ],
    });
    expect(days.at(-3)).toMatchObject({ downtimeMs: 0, down: [] });
  });

  it("leaves silent maintenance out of observed time and downtime", async () => {
    const a = await insertMonitor("Alpha", "https://a.example/", TODAY - 10 * DAY);
    await insertMaintenance(a, "silent", TODAY - DAY, TODAY - DAY + 2 * HOUR);
    await insertIncident(a, TODAY - DAY, TODAY - DAY + HOUR);

    const { days } = await uptime();
    expect(days.at(-2)).toMatchObject({ observedMs: 22 * HOUR, downtimeMs: 0, outages: 0, down: [] });
  });
});

describe("hourly uptime of one monitor", () => {
  /** 10:20 UTC: the current hour started 20 minutes ago. */
  const NOW = T0 + 20 * MINUTE;
  beforeEach(() => setTime(NOW));

  it("returns 24 clock hours ending with the current one, which runs until now", async () => {
    const id = await insertMonitor("Alpha", "https://a.example/", T0 - 10 * DAY);
    const { last24h } = await getMonitor(id);
    expect(last24h).toHaveLength(24);
    expect(last24h.at(-1)).toMatchObject({ start: T0, end: NOW, observedMs: 20 * MINUTE, downtimeMs: 0 });
    expect(last24h[0]).toMatchObject({ start: T0 - 23 * HOUR, end: T0 - 22 * HOUR, observedMs: HOUR });
  });

  it("splits an outage across hours and names its incident in each", async () => {
    const id = await insertMonitor("Alpha", "https://a.example/", T0 - 10 * DAY);
    await insertIncident(id, T0 - 2 * HOUR + 40 * MINUTE, T0 + 5 * MINUTE);
    await insertIncident(id, T0 - 5 * HOUR + 10 * MINUTE, T0 - 5 * HOUR + 13 * MINUTE);
    const { last24h, incidents } = await getMonitor(id);
    const [recent, older] = incidents.map((i: { id: number }) => i.id);
    expect(last24h.slice(-3)).toMatchObject([
      { downtimeMs: 20 * MINUTE, incidentIds: [recent] },
      { downtimeMs: HOUR, incidentIds: [recent] },
      { downtimeMs: 5 * MINUTE, incidentIds: [recent] },
    ]);
    expect(last24h.at(-6)).toMatchObject({ downtimeMs: 3 * MINUTE, incidentIds: [older] });
    expect(last24h.at(-4)).toMatchObject({ downtimeMs: 0, incidentIds: [] });
  });

  it("leaves silent maintenance and time before observation out", async () => {
    const id = await insertMonitor("New", "https://new.example/", T0 - 3 * HOUR + 30 * MINUTE);
    await insertMaintenance(id, "silent", T0 - 2 * HOUR, T0 - 2 * HOUR + 15 * MINUTE);
    await insertIncident(id, T0 - 2 * HOUR, T0 - 2 * HOUR + 10 * MINUTE);
    const { last24h } = await getMonitor(id);
    expect(last24h.at(-5)).toMatchObject({ observedMs: 0 });
    expect(last24h.at(-4)).toMatchObject({ observedMs: 30 * MINUTE });
    expect(last24h.at(-3)).toMatchObject({ observedMs: 45 * MINUTE, maintenanceMs: 15 * MINUTE, downtimeMs: 0, incidentIds: [] });
  });
});
