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

const AKAMAI_DENIED = `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;site&#46;example&#47;" on this server.<P>
Reference&#32;&#35;18&#46;5b6a1002&#46;1792080000&#46;3c4d5e6f
<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;5b6a1002&#46;1792080000&#46;3c4d5e6f</P>
</BODY></HTML>`;

describe("failed-check diagnostics", () => {
  it("records the response headers and body of a failed check and spots an Akamai block", async () => {
    const id = await newMonitor();
    fakeSites({
      [SITE]: () =>
        new Response(AKAMAI_DENIED, {
          status: 403,
          headers: { "Content-Type": "text/html", Server: "AkamaiGHost", "Set-Cookie": "ak_bmsc=abc; Path=/" },
        }),
    });
    await run();

    const m = await getMonitor(id);
    expect(m.failures).toHaveLength(1);
    expect(m.failures[0]).toMatchObject({
      status: 403,
      error: "HTTP 403",
      source: "Akamai",
      blocked: true,
      reference: "18.5b6a1002.1792080000.3c4d5e6f",
    });

    const res = await api(`/api/monitors/${id}/failures/${m.failures[0].id}`);
    const f = (await res.json()) as any;
    expect(f.diagnostics.body).toBe(AKAMAI_DENIED);
    expect(f.diagnostics.bodyTruncated).toBe(false);
    expect(f.diagnostics.headers).toContainEqual(["server", "AkamaiGHost"]);
    expect(f.diagnosis.signals.join("\n")).toMatch(/ak_bmsc/);
  });

  it("finds an Akamai reference a site wrapped in its own words, even behind Cloudflare", async () => {
    const page = `<html><head><title>Access Denied</title></head><body><div id="error"><h1>Access Denied</h1><div><hr>
      <p>Contacteer de servicedesk van Digitaal Vlaanderen met de volgende referentie: <b style="color: #FB2C00">#0.103ad417.1792462692.15193b11</b></p>
    </div></div></body></html>`;
    const id = await newMonitor();
    fakeSites({
      [SITE]: () =>
        new Response(page, {
          status: 403,
          headers: { "Content-Type": "text/html", Server: "cloudflare", "CF-Ray": "a4d487d33b81b626-WAW" },
        }),
    });
    await run();

    const m = await getMonitor(id);
    expect(m.failures[0]).toMatchObject({ source: "Akamai", blocked: true, reference: "0.103ad417.1792462692.15193b11" });
    const f = (await (await api(`/api/monitors/${id}/failures/${m.failures[0].id}`)).json()) as any;
    expect(f.diagnosis.references).toEqual([
      {
        label: "Akamai reference",
        value: "0.103ad417.1792462692.15193b11",
        meaning: "WAF or Bot Manager block: the request was taken for an attack or a bot",
      },
      { label: "Cloudflare Ray ID", value: "a4d487d33b81b626-WAW" },
    ]);
    expect(f.diagnosis.signals.join("\n")).toMatch(/passed through Cloudflare/);
  });

  it("does not take a CSS color or other hashes for an Akamai reference", async () => {
    const id = await newMonitor();
    fakeSites({
      [SITE]: () =>
        new Response(`<p style="color: #FB2C00">Error #1.2.3 at v#12.ab.34.cd</p>`, {
          status: 403,
          headers: { Server: "cloudflare", "CF-Ray": "abc-AMS" },
        }),
    });
    await run();
    expect((await getMonitor(id)).failures[0]).toMatchObject({ source: "Cloudflare", reference: "abc-AMS" });
  });

  it("tells an origin error passed through the CDN apart from a block", async () => {
    const id = await newMonitor();
    fakeSites({
      [SITE]: () =>
        new Response("upstream connect error or disconnect/reset before headers. reset reason: connection failure", {
          status: 503,
          headers: { "x-envoy-upstream-service-time": "3" },
        }),
    });
    await run();
    expect((await getMonitor(id)).failures[0]).toMatchObject({ source: "Origin (Envoy proxy)", blocked: false });
  });

  it("keeps the redirect chain, caps the body and records timeouts without a response", async () => {
    const id = await newMonitor({ url: "http://site.example/", timeoutMs: 1000 });
    fakeSites({
      "http://site.example/": [{ status: 301, location: SITE }, "hang"],
      [SITE]: () => new Response("x".repeat(100_000), { status: 500 }),
    });
    await run();
    advance(MINUTE);
    await run();

    const { failures } = await getMonitor(id);
    expect(failures.map((f: any) => f.error)).toEqual(["Timeout after 1000 ms", "HTTP 500"]);
    const [timeout, error] = await Promise.all(
      failures.map(async (f: any) => (await api(`/api/monitors/${id}/failures/${f.id}`)).json() as Promise<any>),
    );
    expect(error.diagnostics.redirects).toEqual([{ url: "http://site.example/", status: 301, location: SITE }]);
    expect(error.diagnostics.url).toBe(SITE);
    expect(error.diagnostics.body).toHaveLength(16 * 1024);
    expect(error.diagnostics.bodyTruncated).toBe(true);
    expect(timeout.diagnostics.headers).toBeNull();
  });

  it("keeps only the most recent failures and none for healthy checks", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: [200, ...Array(25).fill(500)] });
    await runEachMinute(26);
    const { failures } = await getMonitor(id);
    expect(failures).toHaveLength(20);
    expect(failures[0].checkedAt).toBe(Date.now());
  });

  it("returns diagnostics from Check now", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: () => new Response("busy", { status: 503, headers: { "cf-ray": "abc123-AMS" } }) });
    const res = await api(`/api/monitors/${id}/check`, { method: "POST" });
    const body = (await res.json()) as any;
    expect(body.diagnostics.body).toBe("busy");
    expect(body.diagnosis).toMatchObject({ source: "Cloudflare", reference: "abc123-AMS" });
  });
});

describe("Retry-After", () => {
  it("holds off checks for as long as a 503 asks, then resumes", async () => {
    const id = await newMonitor();
    const fetch = fakeSites({
      [SITE]: [() => new Response("", { status: 503, headers: { "Retry-After": "300" } }), 200],
    });
    await run();
    expect((await getMonitor(id)).nextCheckAfter).toBe(Date.now() + 300_000);

    await runEachMinute(4);
    expect(fetch).toHaveBeenCalledTimes(1);
    await runEachMinute(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await getMonitor(id)).nextCheckAfter).toBeNull();
  });

  it("caps long Retry-After values at 30 minutes and ignores it on other statuses", async () => {
    const id = await newMonitor();
    fakeSites({
      [SITE]: [
        () => new Response("", { status: 429, headers: { "Retry-After": "86400" } }),
        () => new Response("", { status: 500, headers: { "Retry-After": "600" } }),
      ],
    });
    await run();
    expect((await getMonitor(id)).nextCheckAfter).toBe(Date.now() + 30 * MINUTE);
    advance(30 * MINUTE);
    await run();
    expect((await getMonitor(id)).nextCheckAfter).toBeNull();
  });
});
