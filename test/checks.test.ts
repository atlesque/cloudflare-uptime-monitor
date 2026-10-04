import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget";
import { runChecks } from "../src/checks";
import worker from "../src/index";
import { addMonitor, advance, api, fakeSites, getMonitor, incidents, json, MINUTE, resetDb, useClock } from "./helpers";

const SITE = "https://site.example/";
const run = () => runChecks(env, new Budget(100));

beforeEach(async () => {
  await resetDb();
  useClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function newMonitor(extra: Record<string, unknown> = {}) {
  const { body } = await addMonitor({ name: "Site", url: SITE, ...extra });
  return body.id as number;
}

async function runEachMinute(times: number) {
  for (let i = 0; i < times; i++) {
    advance(MINUTE);
    await run();
  }
}

describe("scheduled checks", () => {
  it("runs from the every-minute cron and moves a healthy new monitor from Pending to Up", async () => {
    const id = await newMonitor();
    expect((await getMonitor(id)).state).toBe("pending");
    fakeSites({ [SITE]: 200 });

    await worker.scheduled(createScheduledController({ cron: "* * * * *" }), env);

    const m = await getMonitor(id);
    expect(m.state).toBe("up");
    expect(m.lastCheck).toMatchObject({ status: 200, error: null, at: Date.now() });
    expect(m.lastCheck.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("opens one incident after two consecutive failures and closes it after two successes", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: [200, 503, 200, 503, 503, 503, 200, 503, 200, 200, 200] });

    const states: string[] = [];
    for (let i = 0; i < 11; i++) {
      advance(MINUTE);
      await run();
      states.push((await getMonitor(id)).state);
    }
    expect(states).toEqual(["up", "up", "up", "up", "down", "down", "down", "down", "down", "up", "up"]);

    const [incident, ...rest] = await incidents(id);
    expect(rest).toHaveLength(0);
    expect(incident.failure_reason).toBe("HTTP 503");
    // Measured from the confirmed Down check to the confirmed Up check.
    expect(incident.ended_at! - incident.started_at).toBe(5 * MINUTE);
  });

  it("reports the ongoing outage start on the monitor", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: 500 });
    await runEachMinute(2);

    const m = await getMonitor(id);
    expect(m.state).toBe("down");
    expect(m.currentOutageStartedAt).toBe(Date.now());
    expect((await incidents(id))[0].ended_at).toBeNull();
  });

  it("follows redirects, including HTTP to HTTPS, and judges the final response", async () => {
    const id = await newMonitor({ url: "http://site.example/" });
    fakeSites({
      "http://site.example/": { status: 301, location: "https://site.example/" },
      [SITE]: { status: 302, location: "/home" },
      "https://site.example/home": 200,
    });
    const [outcome] = await run();
    expect(outcome.result).toMatchObject({ ok: true, status: 200 });
    expect((await getMonitor(id)).state).toBe("up");
  });

  it("judges a redirect chain by its final failing response", async () => {
    await newMonitor();
    fakeSites({ [SITE]: { status: 302, location: "/gone" }, "https://site.example/gone": 404 });
    const [outcome] = await run();
    expect(outcome.result).toMatchObject({ ok: false, status: 404, error: "HTTP 404" });
  });

  it("treats a 3xx without Location as healthy", async () => {
    await newMonitor();
    fakeSites({ [SITE]: 304 });
    const [outcome] = await run();
    expect(outcome.result.ok).toBe(true);
  });

  it("fails redirects to internal targets without fetching them", async () => {
    await newMonitor();
    const fetch = fakeSites({ [SITE]: { status: 302, location: "http://169.254.169.254/" } });
    const [outcome] = await run();
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toMatch(/disallowed target/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails redirect loops after a bounded number of hops", async () => {
    await newMonitor();
    fakeSites({ [SITE]: { status: 302, location: SITE } });
    const [outcome] = await run();
    expect(outcome.result.error).toMatch(/Too many redirects/);
  });

  it("fails on network errors and timeouts", async () => {
    await newMonitor();
    await newMonitor({ name: "Slow", url: "https://slow.example/", timeoutMs: 1000 });
    fakeSites({ [SITE]: new TypeError("Network connection lost"), "https://slow.example/": "hang" });

    const outcomes = await run();
    expect(outcomes.map((o) => o.result.error).sort()).toEqual(["Network connection lost", "Timeout after 1000 ms"]);
  });

  it("defers checks that do not fit the subrequest budget and runs them first next time", async () => {
    const a = await newMonitor({ name: "A", url: "https://a.example/" });
    const b = await newMonitor({ name: "B", url: "https://b.example/" });
    fakeSites({ "https://a.example/": 200, "https://b.example/": 200 });

    // Budget for one request: one monitor is checked, the other is deferred untouched.
    const first = await runChecks(env, new Budget(1));
    expect(first.map((o) => o.monitorId)).toEqual([a]);
    expect((await getMonitor(b)).state).toBe("pending");
    expect((await getMonitor(b)).lastCheck).toBeNull();

    advance(MINUTE);
    const second = await runChecks(env, new Budget(1));
    expect(second.map((o) => o.monitorId)).toEqual([b]);
    expect((await getMonitor(b)).state).toBe("up");
  });

  it("drops a result when the monitor was deleted mid-run", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: 500 });
    await run();
    // Second failing run races with deletion: the probe is in flight when the row disappears.
    const pending = run();
    await env.DB.prepare(`DELETE FROM monitors WHERE id = ?`).bind(id).run();
    await pending;
    expect(await incidents(id)).toHaveLength(0);
  });

  it("drops a result when the URL changed mid-run", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: 500, "https://new.example/": 200 });
    await run();
    const pending = run();
    await api(`/api/monitors/${id}`, json("PATCH", { url: "https://new.example/", confirmUrlChange: true }));
    await pending;

    const m = await getMonitor(id);
    expect(m.state).toBe("pending");
    expect(m.lastCheck).toBeNull();
    expect(await incidents(id)).toHaveLength(0);
  });
});
