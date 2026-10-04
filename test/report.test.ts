import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { REPORT_CRON, runWeeklyReport } from "../src/report";
import {
  addMonitor,
  api,
  cycle,
  DAY,
  fakeMailer,
  fakeSites,
  HOUR,
  insertIncident,
  insertMaintenance,
  insertMonitor,
  makeEnv,
  MINUTE,
  NTFY_URL,
  resetDb,
  setTime,
  useClock,
  type Mailer,
} from "./helpers";

// Reporting week: Monday 21 September 00:00 CEST to Monday 28 September 00:00 CEST.
const WEEK_START = Date.UTC(2026, 8, 20, 22);
const WEEK_END = Date.UTC(2026, 8, 27, 22);
// Monday 28 September 08:00 CEST.
const REPORT_AT = Date.UTC(2026, 8, 28, 6);
const LONG_AGO = WEEK_START - 60 * DAY;

let mailer: Mailer;
let e: Env;

beforeEach(async () => {
  await resetDb();
  useClock(REPORT_AT);
  mailer = fakeMailer();
  e = makeEnv(mailer);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function reportStatus() {
  return env.DB.prepare(`SELECT status, attempts, error FROM weekly_reports WHERE week_start = ?`)
    .bind(WEEK_START)
    .first();
}

/** Tuesday 22 September, the given hour in local time (CEST). */
const tuesday = (hour: number) => WEEK_START + DAY + hour * HOUR;

describe("weekly report schedule", () => {
  it("is emailed once, from Monday 08:00 Europe/Brussels, when the week had an outage", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertIncident(a, tuesday(10), tuesday(11));

    setTime(REPORT_AT - MINUTE);
    await runWeeklyReport(e, Date.now());
    expect(mailer.sent).toHaveLength(0);

    setTime(REPORT_AT);
    await runWeeklyReport(e, Date.now());
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toEqual(["ops@example.com", "alerts@example.com"]);
    expect(mailer.sent[0].subject).toBe(
      "Weekly uptime report: Monday, 21 September 2026 – Sunday, 27 September 2026 (1 outage)",
    );

    for (const later of [REPORT_AT + MINUTE, REPORT_AT + DAY]) {
      setTime(later);
      await runWeeklyReport(e, Date.now());
    }
    expect(mailer.sent).toHaveLength(1);
    expect(await reportStatus()).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("runs from its own Monday cron, not from the every-minute schedule", async () => {
    const { body } = await addMonitor({ name: "Alpha", url: "https://alpha.example/" });
    await env.DB.prepare(`UPDATE monitors SET created_at = ?, observed_since = ? WHERE id = ?`)
      .bind(LONG_AGO, LONG_AGO, body.id)
      .run();
    await insertIncident(body.id, tuesday(10), tuesday(11));
    fakeSites({ "https://alpha.example/": 200, [`${NTFY_URL}/`]: 200 });

    await cycle(e);
    expect(mailer.sent).toHaveLength(0);

    await worker.scheduled(createScheduledController({ cron: REPORT_CRON }), e);
    expect(mailer.sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^Weekly uptime report/)]);
  });

  it("does nothing when the report cron fires before 08:00 local time", async () => {
    // 07:00 CET on Monday 2 November 2026: the cron's 06:00 UTC firing in winter.
    setTime(Date.UTC(2026, 10, 2, 6));
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertIncident(a, Date.UTC(2026, 9, 27, 10), Date.UTC(2026, 9, 27, 11));
    await worker.scheduled(createScheduledController({ cron: REPORT_CRON }), e);
    expect(mailer.sent).toHaveLength(0);

    setTime(Date.UTC(2026, 10, 2, 7));
    await worker.scheduled(createScheduledController({ cron: REPORT_CRON }), e);
    expect(mailer.sent).toHaveLength(1);
  });

  it("is not sent for a week without operational outages", async () => {
    await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await runWeeklyReport(e, Date.now());
    expect(mailer.sent).toHaveLength(0);
    expect(await reportStatus()).toMatchObject({ status: "skipped", error: "No operational outage in this week" });
  });

  it("is not sent when the only outages happened in silent maintenance", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertMaintenance(a, "silent", tuesday(9), tuesday(12));
    await insertIncident(a, tuesday(10), tuesday(11));
    await runWeeklyReport(e, Date.now());
    expect(mailer.sent).toHaveLength(0);
  });

  it("is sent when an outage happened in maintenance with notifications", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertMaintenance(a, "notify", tuesday(9), tuesday(12));
    await insertIncident(a, tuesday(10), tuesday(11));
    await runWeeklyReport(e, Date.now());
    expect(mailer.sent).toHaveLength(1);
  });

  it("retries a failed delivery on later runs, at most twice", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertIncident(a, tuesday(10), tuesday(11));
    mailer.failures = 10;
    // Later firings of the report cron, 5 minutes apart.
    for (let i = 0; i < 6; i++) {
      setTime(REPORT_AT + i * 5 * MINUTE);
      await runWeeklyReport(e, Date.now());
    }
    expect(await reportStatus()).toMatchObject({ status: "failed", attempts: 3, error: "Email provider unavailable" });
    expect(mailer.failures).toBe(7);
  });

  it("recovers from a transient delivery failure", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertIncident(a, tuesday(10), tuesday(11));
    mailer.failures = 1;
    await runWeeklyReport(e, Date.now());
    setTime(REPORT_AT + 5 * MINUTE);
    await runWeeklyReport(e, Date.now());
    expect(mailer.sent).toHaveLength(1);
    expect(await reportStatus()).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("is skipped when email is not configured", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertIncident(a, tuesday(10), tuesday(11));
    await runWeeklyReport(makeEnv(mailer, { EMAIL_TO: "" }), Date.now());
    expect(mailer.sent).toHaveLength(0);
    expect(await reportStatus()).toMatchObject({ status: "skipped", error: "Email is not configured" });
  });
});

describe("weekly report content", () => {
  async function sendReport() {
    await runWeeklyReport(e, Date.now());
    expect(mailer.sent).toHaveLength(1);
    return mailer.sent[0];
  }

  it("shows a summary of every current monitor", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertMonitor("Beta", "https://beta.example/", LONG_AGO);
    await insertIncident(a, tuesday(10), tuesday(11));

    const email = await sendReport();
    const { html, text } = email;
    expect(html).toContain("Weekly Uptime Report");
    expect(html).toContain("Monday, 21 September 2026 – Sunday, 27 September 2026");
    expect(html).toMatch(/text-align:center[^>]*>\s*<h1/);
    for (const header of ["Monitor", "Outages", "Downtime", "Uptime"]) expect(html).toContain(`>${header}</th>`);
    expect(html).toContain("Total outages:</strong> 1");
    expect(html).toContain("Total downtime:</strong> 60 minutes");
    expect(html).toContain("Values in parentheses include time spent in maintenance without notifications.");
    expect(html).not.toMatch(/fleet|overall uptime/i);
    // Healthy uptime is green.
    expect(html).toMatch(/color:#1a7f37">100%</);

    expect(text.split("\n")).toEqual([
      "Weekly Uptime Report",
      "Monday, 21 September 2026 – Sunday, 27 September 2026",
      "",
      "Monitor  Outages  Downtime  Uptime",
      "Alpha    1        1h 00m    99.40%",
      "Beta     0        0m        100%",
      "",
      "Total outages: 1",
      "Total downtime: 60 minutes",
      "",
      "Values in parentheses include time spent in maintenance without notifications. The main values exclude that planned downtime.",
    ]);
  });

  it("puts inclusive maintenance values in parentheses", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    const b = await insertMonitor("Beta", "https://beta.example/", LONG_AGO);
    await insertIncident(a, tuesday(10), tuesday(11));
    await insertMaintenance(b, "silent", tuesday(9), tuesday(12));
    await insertIncident(b, tuesday(10), tuesday(12));

    const { text } = await sendReport();
    expect(text).toContain("Beta     0 (1)    0m (2h 00m)  100% (98.80%)");
    expect(text).toContain("Total outages: 1 (2)");
    expect(text).toContain("Total downtime: 60 (180) minutes");
  });

  it("clips incidents to the week and counts ongoing incidents through its end", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    const b = await insertMonitor("Beta", "https://beta.example/", LONG_AGO);
    // Sunday 20 Sep 23:00 to Monday 21 Sep 00:30 local: 30 minutes fall in the week.
    await insertIncident(a, WEEK_START - HOUR, WEEK_START + 30 * MINUTE);
    // Sunday 27 Sep 23:00 to Monday 28 Sep 01:00 local: 1 hour falls in the week.
    await insertIncident(a, WEEK_END - HOUR, WEEK_END + HOUR);
    // Ongoing since Sunday 27 Sep 22:00 local: 2 hours fall in the week.
    await insertIncident(b, WEEK_END - 2 * HOUR, null);

    const { text } = await sendReport();
    expect(text).toContain("Alpha    2        1h 30m");
    expect(text).toContain("Beta     1        2h 00m");
    expect(text).toContain("Total downtime: 210 minutes");
  });

  it("measures new monitors from creation and leaves out deleted monitors", async () => {
    const a = await insertMonitor("Alpha", "https://alpha.example/", LONG_AGO);
    await insertIncident(a, tuesday(10), tuesday(11));
    // Created Thursday 24 Sep 00:00 local: observed for 4 days, 1 hour down.
    const n = await insertMonitor("Newcomer", "https://new.example/", WEEK_START + 3 * DAY);
    await insertIncident(n, WEEK_START + 3 * DAY + HOUR, WEEK_START + 3 * DAY + 2 * HOUR);
    // Created after the week ended: nothing observed.
    await insertMonitor("Latecomer", "https://late.example/", WEEK_END + HOUR);
    const gone = await insertMonitor("Gone", "https://gone.example/", LONG_AGO);
    await insertIncident(gone, tuesday(10), tuesday(14));
    await api(`/api/monitors/${gone}?confirm=true`, { method: "DELETE" });

    const { text } = await sendReport();
    expect(text).toContain("Newcomer   1        1h 00m    98.95%");
    expect(text).toContain("Latecomer  0        0m        —");
    expect(text).not.toContain("Gone");
    expect(text).toContain("Total outages: 2");
  });
});
