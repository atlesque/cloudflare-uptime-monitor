import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget";
import { runChecks } from "../src/checks";
import { Prober, proberStub } from "../src/prober";
import { addMonitor, advance, api, fakeSites, getMonitor, json, MINUTE, resetDb, useClock } from "./helpers";

const SITE = "https://site.example/";
const SECRET = [{ name: "X-Uptime-Token", value: "s3cret" }];

beforeEach(async () => {
  await resetDb();
  useClock();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function newMonitor(extra: Record<string, unknown> = {}) {
  const { status, body } = await addMonitor({ name: "Site", url: SITE, ...extra });
  expect(status).toBe(201);
  return body.id as number;
}

describe("check location", () => {
  it("runs checks in the Prober for CHECK_LOCATION and shares its subrequest budget", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: 200 });
    const probeAll = vi.spyOn(Prober.prototype, "probeAll");
    const budget = new Budget(10);

    await runChecks(env, budget);

    expect(probeAll).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(9);
    expect((await getMonitor(id)).state).toBe("up");
  });

  it("checks from the Worker when CHECK_LOCATION is empty", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: 200 });
    const probeAll = vi.spyOn(Prober.prototype, "probeAll");

    await runChecks({ ...env, CHECK_LOCATION: "" }, new Budget(10));

    expect(probeAll).not.toHaveBeenCalled();
    expect((await getMonitor(id)).state).toBe("up");
  });

  it("falls back to checking from the Worker when the Prober fails", async () => {
    const id = await newMonitor();
    fakeSites({ [SITE]: 200 });
    vi.spyOn(Prober.prototype, "probeAll").mockImplementation(async () => {
      throw new Error("overloaded");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runChecks(env, new Budget(10));

    expect((await getMonitor(id)).state).toBe("up");
  });

  it("accepts location hints and ignores unknown locations", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(proberStub({ ...env, CHECK_LOCATION: "weur" })).not.toBeNull();
    expect(proberStub({ ...env, CHECK_LOCATION: " WEUR " })).not.toBeNull();
    expect(proberStub({ ...env, CHECK_LOCATION: "eu" })).toBeNull();
    expect(proberStub({ ...env, CHECK_LOCATION: "mars" })).toBeNull();
    expect(proberStub({ ...env, CHECK_LOCATION: "" })).toBeNull();
  });
});

describe("request headers", () => {
  it("are saved, returned and sent with each check", async () => {
    const id = await newMonitor({ requestHeaders: SECRET });
    expect((await getMonitor(id)).requestHeaders).toEqual(SECRET);
    const seen: (string | null)[] = [];
    fakeSites({
      [SITE]: (r) => {
        seen.push(r.headers.get("X-Uptime-Token"));
        return new Response("ok");
      },
    });

    await runChecks(env, new Budget(10));
    await api(`/api/monitors/${id}/check`, { method: "POST" });

    expect(seen).toEqual(["s3cret", "s3cret"]);
  });

  it("follow redirects on the same host but are not sent to another host or over plain HTTP", async () => {
    const id = await newMonitor({ requestHeaders: SECRET });
    const seen: Record<string, string | null> = {};
    const record = (status: number, location?: string) => (r: Request) => {
      seen[r.url] = r.headers.get("X-Uptime-Token");
      return new Response(null, { status, headers: location ? { Location: location } : {} });
    };
    fakeSites({
      [SITE]: record(301, "/home"),
      "https://site.example/home": record(302, "http://site.example/plain"),
      "http://site.example/plain": record(302, "https://other.example/"),
      "https://other.example/": record(200),
    });

    await runChecks(env, new Budget(10));

    expect(seen).toEqual({
      [SITE]: "s3cret",
      "https://site.example/home": "s3cret",
      "http://site.example/plain": null,
      "https://other.example/": null,
    });
    expect((await getMonitor(id)).state).toBe("up");
  });

  it("can replace the default User-Agent", async () => {
    await newMonitor({ requestHeaders: [{ name: "User-Agent", value: "VO-Monitor/1.0" }] });
    let ua: string | null = null;
    fakeSites({
      [SITE]: (r) => {
        ua = r.headers.get("User-Agent");
        return new Response("ok");
      },
    });
    await runChecks(env, new Budget(10));
    expect(ua).toBe("VO-Monitor/1.0");
  });

  it("can be changed and cleared without resetting history", async () => {
    const id = await newMonitor({ requestHeaders: SECRET });
    fakeSites({ [SITE]: 200 });
    await runChecks(env, new Budget(10));

    let res = await api(`/api/monitors/${id}`, json("PATCH", { requestHeaders: [{ name: "X-Other", value: " v " }] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).requestHeaders).toEqual([{ name: "X-Other", value: "v" }]);

    res = await api(`/api/monitors/${id}`, json("PATCH", { requestHeaders: [] }));
    const m = (await res.json()) as any;
    expect(m.requestHeaders).toEqual([]);
    expect(m.state).toBe("up");
  });

  it.each([
    ["not an array", "X-A: b", "requestHeaders must be an array"],
    ["a missing value", [{ name: "X-A" }], "requestHeaders must be an array"],
    ["an invalid name", [{ name: "X A", value: "b" }], 'Invalid header name "X A"'],
    ["Host", [{ name: "Host", value: "b" }], "The Host header can't be set"],
    ["a cf- header", [{ name: "CF-Worker", value: "b" }], "The CF-Worker header can't be set"],
    ["a duplicate", [{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }], "The x-a header is listed twice"],
    ["a line break", [{ name: "X-A", value: "b\r\nX-B: c" }], "The value of X-A must be one line"],
    ["too many", Array.from({ length: 11 }, (_, i) => ({ name: `X-${i}`, value: "v" })), "At most 10 request headers"],
  ])("are rejected with %s", async (_, requestHeaders, error) => {
    const { status, body } = await addMonitor({ name: "Site", url: SITE, requestHeaders });
    expect(status).toBe(400);
    expect(body.error).toContain(error);
  });
});

it("checks again after a minute with the same headers", async () => {
  await newMonitor({ requestHeaders: SECRET });
  const fetch = fakeSites({ [SITE]: 200 });
  await runChecks(env, new Budget(10));
  advance(MINUTE);
  await runChecks(env, new Budget(10));
  expect(fetch).toHaveBeenCalledTimes(2);
});
