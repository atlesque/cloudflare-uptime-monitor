import { describe, expect, it } from "vitest";
import { computeMetrics, maintenanceOverlap } from "../src/metrics";

const H = 3_600_000;
const window = { from: 0, to: 100 * H, observedSince: 0 };

describe("uptime metrics", () => {
  it("computes downtime and uptime over the window", () => {
    const m = computeMetrics({ ...window, incidents: [{ startedAt: 10 * H, endedAt: 11 * H }], maintenance: [] });
    expect(m).toEqual({
      observedMs: 100 * H,
      outages: 1,
      outagesInclusive: 1,
      downtimeMs: H,
      downtimeInclusiveMs: H,
      uptimePct: 99,
      uptimeInclusivePct: 99,
    });
  });

  it("clips incidents crossing either window boundary", () => {
    const m = computeMetrics({
      ...window,
      incidents: [
        { startedAt: -5 * H, endedAt: 2 * H },
        { startedAt: 99 * H, endedAt: 150 * H },
        { startedAt: 200 * H, endedAt: 201 * H }, // after the window
        { startedAt: -9 * H, endedAt: -8 * H }, // before the window
      ],
      maintenance: [],
    });
    expect(m).toMatchObject({ outages: 2, downtimeMs: 3 * H });
  });

  it("counts an ongoing incident through the end of the window", () => {
    const m = computeMetrics({ ...window, incidents: [{ startedAt: 90 * H, endedAt: null }], maintenance: [] });
    expect(m).toMatchObject({ outages: 1, downtimeMs: 10 * H, uptimePct: 90 });
  });

  it("only observes a monitor from its creation (or URL change)", () => {
    const m = computeMetrics({
      ...window,
      observedSince: 50 * H,
      incidents: [{ startedAt: 60 * H, endedAt: 65 * H }],
      maintenance: [],
    });
    expect(m).toMatchObject({ observedMs: 50 * H, downtimeMs: 5 * H, uptimePct: 90 });
  });

  it("reports nothing for a monitor created after the window", () => {
    const m = computeMetrics({ ...window, observedSince: 120 * H, incidents: [], maintenance: [] });
    expect(m).toMatchObject({ observedMs: 0, outages: 0, uptimePct: null, uptimeInclusivePct: null });
  });

  it("excludes silent maintenance from operational metrics but not inclusive ones", () => {
    const m = computeMetrics({
      ...window,
      incidents: [{ startedAt: 10 * H, endedAt: 20 * H }],
      maintenance: [{ mode: "silent", startedAt: 0, endedAt: 15 * H }],
    });
    // Operational: 85h observed (100 - 15 silent), 5h down.
    expect(m.downtimeMs).toBe(5 * H);
    expect(m.uptimePct).toBeCloseTo((100 * 80) / 85, 10);
    expect(m.downtimeInclusiveMs).toBe(10 * H);
    expect(m.uptimeInclusivePct).toBe(90);
    expect(m.outages).toBe(1);
  });

  it("does not count an outage entirely inside silent maintenance as operational", () => {
    const m = computeMetrics({
      ...window,
      incidents: [{ startedAt: 10 * H, endedAt: 12 * H }],
      maintenance: [{ mode: "silent", startedAt: 9 * H, endedAt: null }],
    });
    expect(m).toMatchObject({ outages: 0, outagesInclusive: 1, downtimeMs: 0, downtimeInclusiveMs: 2 * H });
  });

  it("keeps maintenance with notifications as operational downtime", () => {
    const m = computeMetrics({
      ...window,
      incidents: [{ startedAt: 10 * H, endedAt: 12 * H }],
      maintenance: [{ mode: "notify", startedAt: 0, endedAt: null }],
    });
    expect(m).toMatchObject({ outages: 1, downtimeMs: 2 * H, uptimePct: 98, uptimeInclusivePct: 98 });
  });

  it("has no operational uptime when the whole window was silent maintenance", () => {
    const m = computeMetrics({ ...window, incidents: [], maintenance: [{ mode: "silent", startedAt: -H, endedAt: null }] });
    expect(m.uptimePct).toBeNull();
    expect(m.uptimeInclusivePct).toBe(100);
  });

  it("measures how much of an incident fell in each maintenance mode", () => {
    expect(
      maintenanceOverlap(
        { startedAt: 10 * H, endedAt: null },
        [
          { mode: "notify", startedAt: 0, endedAt: 12 * H },
          { mode: "silent", startedAt: 12 * H, endedAt: null },
        ],
        20 * H,
      ),
    ).toEqual({ notifyMs: 2 * H, silentMs: 8 * H });
  });
});
