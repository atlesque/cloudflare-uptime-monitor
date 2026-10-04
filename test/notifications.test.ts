import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/budget";
import { runChecks } from "../src/checks";
import { dispatchNotifications } from "../src/notifications";
import {
  addMonitor,
  advance,
  cycle,
  fakeMailer,
  fakeNtfy,
  fakeSites,
  getMonitor,
  makeEnv,
  MINUTE,
  notificationRows,
  NTFY_URL,
  resetDb,
  setMaintenance,
  useClock,
  type Mailer,
} from "./helpers";

const SITE = "https://shop.example/";

let mailer: Mailer;
let ntfy: ReturnType<typeof fakeNtfy>;
let e: Env;

beforeEach(async () => {
  await resetDb();
  useClock(); // Wednesday 30 September 2026, 12:00 CEST
  mailer = fakeMailer();
  ntfy = fakeNtfy();
  e = makeEnv(mailer);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Runs one scheduler cycle per reply, a minute apart, against a site replying with each in turn. */
async function runSite(replies: number[]) {
  fakeSites({ [SITE]: replies, [`${NTFY_URL}/`]: ntfy.handler });
  for (let i = 0; i < replies.length; i++) {
    await cycle(e);
    advance(MINUTE);
  }
}

/** Records a Down transition without delivering it. */
async function recordDownTransition() {
  fakeSites({ [SITE]: 503, [`${NTFY_URL}/`]: ntfy.handler });
  await runChecks(e, new Budget(10));
  advance(MINUTE);
  await runChecks(e, new Budget(10));
  expect(await notificationRows()).toHaveLength(1);
}

async function newMonitor() {
  const { body } = await addMonitor({ name: "Shop", url: SITE, group: "Clients" });
  return body.id as number;
}

describe("transition notifications", () => {
  it("sends one detailed email and one concise ntfy message when a monitor goes down", async () => {
    const id = await newMonitor();
    await runSite([200, 503, 503, 503, 503]);

    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0];
    expect(email.to).toEqual(["ops@example.com", "alerts@example.com"]);
    expect(email.from).toEqual({ email: "uptime@example.com", name: "Uptime Monitor" });
    expect(email.subject).toBe("[DOWN] Shop is DOWN");
    // Confirmed on the third cycle: 12:02 local time.
    for (const expected of [
      "Monitor:        Shop",
      "URL:            https://shop.example/",
      "Group:          Clients",
      "Transition:     Up → Down (2 consecutive failed checks)",
      "Time:           Wed, 30 Sept 2026, 12:02:00 CEST",
      "Failure:        HTTP 503",
      "Response time:  0 ms",
      "Dashboard:      https://uptime.example.com",
    ]) {
      expect(email.text).toContain(expected);
    }
    expect(email.html).toContain("Shop is DOWN");
    expect(email.html).toContain('<a href="https://shop.example/">');

    expect(ntfy.published).toHaveLength(1);
    expect(ntfy.published[0].authorization).toBe("Bearer tk_test");
    expect(ntfy.published[0].body).toEqual({
      topic: "uptime",
      title: "Shop is DOWN",
      message: "https://shop.example/\nHTTP 503\nWed, 30 Sept 2026, 12:02:00 CEST",
      priority: 5,
      tags: ["rotating_light"],
      click: `https://uptime.example.com/#monitor-${id}`,
    });
  });

  it("sends one recovery notification with the outage duration", async () => {
    await newMonitor();
    await runSite([503, 503, 503, 503, 200, 200, 200]);

    expect(mailer.sent.map((m) => m.subject)).toEqual(["[DOWN] Shop is DOWN", "[UP] Shop is back UP after 4m"]);
    const recovery = mailer.sent[1].text;
    expect(recovery).toContain("Transition:      Down → Up (2 consecutive successful checks)");
    expect(recovery).toContain("Outage started:  Wed, 30 Sept 2026, 12:01:00 CEST");
    expect(recovery).toContain("Downtime:        4m");
    expect(ntfy.published.map((p) => p.body.title)).toEqual(["Shop is DOWN", "Shop is back UP after 4m"]);
    expect(ntfy.published[1].body).toMatchObject({ message: expect.stringContaining("Down for 4m"), priority: 3 });
  });

  it("does not notify when a new monitor comes up, or for isolated failures", async () => {
    await newMonitor();
    await runSite([200, 503, 200, 503, 200]);
    expect(mailer.sent).toHaveLength(0);
    expect(ntfy.published).toHaveLength(0);
  });

  it("notifies when a new monitor's first two checks fail", async () => {
    await newMonitor();
    await runSite([503, 503]);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[DOWN] Shop is DOWN"]);
  });

  it("delivers to every channel independently and retries a failed channel at most twice", async () => {
    await newMonitor();
    ntfy.failures = 10;
    await runSite([503, 503, 503, 503, 503, 503, 503]);

    expect(mailer.sent).toHaveLength(1); // email succeeded once and is never re-sent
    expect(ntfy.published).toHaveLength(0);
    expect(await notificationRows()).toEqual([
      { kind: "down", email_status: "sent", email_attempts: 1, ntfy_status: "failed", ntfy_attempts: 3 },
    ]);
    // 1 initial attempt + 2 retries, then delivery stops.
    expect(ntfy.failures).toBe(10 - 3);
  });

  it("retries a failed email on a later run without re-sending ntfy", async () => {
    await newMonitor();
    mailer.failures = 1;
    await runSite([503, 503, 503]);

    expect(mailer.sent).toHaveLength(1);
    expect(ntfy.published).toHaveLength(1);
    expect(await notificationRows()).toEqual([
      { kind: "down", email_status: "sent", email_attempts: 2, ntfy_status: "sent", ntfy_attempts: 1 },
    ]);
  });

  it("skips channels that are not configured", async () => {
    e = makeEnv(mailer, { NTFY_URL: "", EMAIL_TO: "" });
    await newMonitor();
    await runSite([503, 503, 503]);
    expect(mailer.sent).toHaveLength(0);
    expect(await notificationRows()).toEqual([
      { kind: "down", email_status: "skipped", email_attempts: 0, ntfy_status: "skipped", ntfy_attempts: 0 },
    ]);
  });

  it("never delivers a channel twice when deliveries overlap", async () => {
    await newMonitor();
    await recordDownTransition();
    await Promise.all([
      dispatchNotifications(e, Date.now(), new Budget(5)),
      dispatchNotifications(e, Date.now(), new Budget(5)),
    ]);
    expect(mailer.sent).toHaveLength(1);
    expect(ntfy.published).toHaveLength(1);
  });

  it("defers ntfy delivery when no subrequest budget is left", async () => {
    await newMonitor();
    await recordDownTransition();

    await dispatchNotifications(e, Date.now(), new Budget(0));
    expect(mailer.sent).toHaveLength(1);
    expect(ntfy.published).toHaveLength(0);
    expect(await notificationRows()).toMatchObject([{ ntfy_status: "pending", ntfy_attempts: 0 }]);

    await dispatchNotifications(e, Date.now(), new Budget(1));
    expect(ntfy.published).toHaveLength(1);
  });
});

describe("notifications during maintenance", () => {
  it("still notifies during maintenance with notifications", async () => {
    const id = await newMonitor();
    await setMaintenance(id, "notify");
    await runSite([503, 503, 200, 200]);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[DOWN] Shop is DOWN", "[UP] Shop is back UP after 2m"]);
    expect(mailer.sent[0].text).toContain("Maintenance:    Maintenance with notifications");
  });

  it("suppresses outage and recovery notifications during silent maintenance", async () => {
    const id = await newMonitor();
    await setMaintenance(id, "silent");
    await runSite([503, 503, 503, 200, 200]);

    expect((await getMonitor(id)).incidents).toHaveLength(1);
    expect(mailer.sent).toHaveLength(0);
    expect(ntfy.published).toHaveLength(0);
  });

  it("sends one still-down notification when silent maintenance ends while down", async () => {
    const id = await newMonitor();
    await setMaintenance(id, "silent");
    await runSite([503, 503, 503]);
    expect(mailer.sent).toHaveLength(0);

    advance(5 * MINUTE);
    await setMaintenance(id, "none");
    advance(MINUTE);
    await runSite([503, 503]);

    expect(mailer.sent.map((m) => m.subject)).toEqual(["[STILL DOWN] Shop is STILL DOWN after maintenance ended"]);
    expect(mailer.sent[0].text).toContain("Down for:        7m");
    expect(ntfy.published).toHaveLength(1);
    expect(ntfy.published[0].body.tags).toEqual(["warning"]);

    // Recovery after maintenance notifies normally.
    await runSite([200, 200]);
    expect(mailer.sent.map((m) => m.subject)).toContain("[UP] Shop is back UP after 11m");
  });

  it("does not send still-down when maintenance ends after recovery", async () => {
    const id = await newMonitor();
    await setMaintenance(id, "silent");
    await runSite([503, 503, 200, 200]);
    await setMaintenance(id, "none");
    await runSite([200, 200]);
    expect(mailer.sent).toHaveLength(0);
  });

  it("sends still-down when switching from silent to maintenance with notifications", async () => {
    const id = await newMonitor();
    await setMaintenance(id, "silent");
    await runSite([503, 503]);
    await setMaintenance(id, "notify");
    await runSite([503]);
    expect(mailer.sent.map((m) => m.subject)).toEqual(["[STILL DOWN] Shop is STILL DOWN after maintenance ended"]);
  });
});

it("keeps notification credentials out of monitor records", async () => {
  const id = await newMonitor();
  const body = JSON.stringify(await getMonitor(id));
  expect(body).not.toContain("tk_test");
  expect(body).not.toContain("ntfy");
});
