# Cloudflare Uptime Monitor

A small, self-hosted uptime monitor that runs entirely on your own Cloudflare account and fits
the **Free plan**: one Worker (API, dashboard and scheduler) and one D1 database. It checks your
public websites every minute, tells you by **email** and/or **[ntfy](https://ntfy.sh)** when one
goes down or recovers, and shows the last 30 days on a private dashboard protected by
**Cloudflare Access**. It is designed for roughly 20 sites; see [Free-plan limits](#free-plan-limits).

There is no shared service and no telemetry: you deploy your own copy, and everything specific to
you (domain, addresses, time zone) is configuration, never code. See [spec.md](spec.md) for the
full design.

## Quick start

You need:

- A **Cloudflare account** (the Free plan works) with a **domain** whose DNS is managed by
  Cloudflare. The dashboard is served on a hostname of that domain, e.g. `uptime.example.com`.
- [Node.js](https://nodejs.org) (a current LTS release) and [pnpm](https://pnpm.io) (`npm install -g pnpm`).
- Cloudflare [Zero Trust](https://one.dash.cloudflare.com) enabled (the Free plan covers up to 50 users).
  This is what keeps the dashboard private.

### 1. Get the code and create your config

```bash
git clone https://github.com/atlesque/cloudflare-uptime-monitor.git
cd cloudflare-uptime-monitor
pnpm install
pnpm setup                       # creates wrangler.jsonc and .dev.vars from the templates
pnpm exec wrangler login         # log in to your Cloudflare account
```

`wrangler.jsonc` and `.dev.vars` are git-ignored: they hold *your* settings. Every value you need to
change is marked `CHANGE ME` in `wrangler.jsonc`. All settings are listed in
[Configuration](#configuration).

### 2. Create the database

```bash
pnpm exec wrangler d1 create uptime
```

Copy the `database_id` it prints into `wrangler.jsonc` (`d1_databases[0].database_id`). Then
create the tables:

```bash
pnpm db:migrate:remote
```

### 3. Choose your hostname

In `wrangler.jsonc`, set `routes[0].pattern` to the hostname you want (for example
`uptime.example.com`) and `DASHBOARD_URL` to the same host with `https://` in front. The domain
must be on your Cloudflare account. The hostname's DNS record and certificate are created for you
on deploy.

### 4. Protect it with Cloudflare Access

The Worker refuses every request that doesn't carry a valid Access assertion, so do this *before*
you rely on the dashboard.

1. In [Zero Trust](https://one.dash.cloudflare.com) go to **Access → Applications → Add an
   application → Self-hosted**.
2. Set the application domain to your hostname (e.g. `uptime.example.com`).
3. Add a policy that **Allows** only the people who should be admins (e.g. *Emails* is
   `you@example.com`, or *Emails ending in* `@yourcompany.com`).
4. Save, then open the application and copy its **Application Audience (AUD) Tag** (Additional
   settings, or the application overview).
5. In `wrangler.jsonc` set:
   - `ACCESS_AUD` to that AUD tag.
   - `ACCESS_TEAM_DOMAIN` to `https://<your-team-name>.cloudflareaccess.com`. Your team name is
     under **Zero Trust → Settings → Custom pages** (or the first part of your Zero Trust login URL).

Until both are set, the Worker answers every request with an error. That is on purpose.

### 5. Choose how to be notified (both are optional)

**Email** (Cloudflare Email Service): set `EMAIL_FROM` and `EMAIL_TO` in `wrangler.jsonc`. On the Free
plan, `EMAIL_FROM` must be an address on a domain with [Email
Routing](https://developers.cloudflare.com/email-routing/) enabled, and every address in `EMAIL_TO`
(comma-separated) must be a *verified destination address* in Email Routing. Verify new recipients
there before adding them. Leave both empty to turn email off.

**ntfy**: set `NTFY_URL` (`https://ntfy.sh` or your self-hosted server) and `NTFY_TOPIC`. Pick a hard
to guess topic name if you use the public ntfy.sh server, or protect the topic with an access
token and store that token as a secret after the first deploy (step 7). Clear `NTFY_TOPIC` to turn ntfy off.

### 6. Set your time zone

Set `TIME_ZONE` to an [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
such as `Europe/Brussels` or `America/New_York` (default `UTC`). It decides when a week starts
and ends for the weekly report, and which zone is used for times in alerts and the dashboard.
`REPORT_HOUR` (default `8`) is the local hour the weekly report goes out on Mondays.

### 7. Deploy

```bash
pnpm deploy
```

If you use an ntfy access token, store it now. Wrangler prompts for the value, so it never lands in
your shell history:

```bash
pnpm exec wrangler secret put NTFY_TOKEN
```

Open your hostname. You should see the Cloudflare Access login, and then the dashboard. Add your
first monitor with **Add monitor**.

### Deployment checklist

- [ ] Your hostname shows the Access login, and an allowed admin reaches the dashboard.
- [ ] A request without Access (e.g. `curl https://uptime.example.com/api/monitors`) is refused.
- [ ] The dashboard footer says email and/or ntfy are **configured**.
- [ ] `pnpm exec wrangler tail` shows a scheduled run every minute, and *Last check* updates.
- [ ] Add a monitor for a URL that fails (e.g. a path that returns 404). Within about 2 minutes you
      get an alert on each configured channel. Delete the monitor again.
- [ ] `pnpm exec wrangler d1 migrations list DB --remote` shows no pending migrations.

## Configuration

Plain settings live under `vars` in `wrangler.jsonc`. Secrets are set with
`pnpm exec wrangler secret put <NAME>`. For local development they go in `.dev.vars`.

| Name | Required | Where | Description |
| --- | --- | --- | --- |
| `routes[0].pattern` | yes | `wrangler.jsonc` | Dashboard hostname, on a domain in your Cloudflare account |
| `d1_databases[0].database_id` | yes | `wrangler.jsonc` | Id printed by `wrangler d1 create uptime` |
| `DASHBOARD_URL` | yes | var | Public dashboard URL, used for links in alerts |
| `ACCESS_TEAM_DOMAIN` | yes | var | `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | yes | var | Audience (AUD) tag of your Access application |
| `EMAIL_FROM` | no | var | Sender address (a domain with Email Routing). Empty disables email |
| `EMAIL_TO` | no | var | Comma-separated verified recipient addresses |
| `NTFY_URL` | no | var | ntfy server, default `https://ntfy.sh` |
| `NTFY_TOPIC` | no | var | ntfy topic. Empty disables ntfy |
| `NTFY_TOKEN` | no | **secret** | ntfy access token, if your topic requires one |
| `TIME_ZONE` | no | var | IANA time zone for the report and displayed times, default `UTC` |
| `REPORT_HOUR` | no | var | Local hour (0–21) for the Monday report, default `8` |
| `EXTERNAL_SUBREQUEST_LIMIT` | no | var | External requests per run, default `50` (Free plan). Raise on a paid plan |
| `DEV_DISABLE_AUTH` | no | `.dev.vars` only | Skips Access for local development. Ignored when the Access settings are set |

## Updating

```bash
git pull
pnpm install
pnpm db:migrate:remote           # applies any new migrations
pnpm deploy
```

Your `wrangler.jsonc` and `.dev.vars` aren't tracked, so pulling never overwrites them. If a new
release adds a setting, compare your file with `wrangler.example.jsonc`.

## Troubleshooting

- **Every request returns "Cloudflare Access is not configured"**: `ACCESS_TEAM_DOMAIN` or
  `ACCESS_AUD` is empty in `wrangler.jsonc`. Set both and redeploy.
- **"Missing Cloudflare Access assertion"**: you reached the Worker without going through Access.
  Use the hostname you protected with the Access application, and check the application covers it.
- **"Invalid Cloudflare Access assertion"**: the AUD tag or team domain doesn't match the Access
  application.
- **No emails arrive**: the dashboard footer shows whether email is configured. On the Free plan,
  the sender domain needs Email Routing and each recipient must be a verified destination address.
  `pnpm exec wrangler tail` shows delivery errors.
- **Deploy fails on the route**: the hostname's domain must be a zone in the same Cloudflare account.
- **Wrangler can't find `wrangler.jsonc`**: run `pnpm setup`.

## What it does

- **Checks every minute.** Each monitor gets a `GET` request. Up to 5 redirects are followed,
  including HTTP→HTTPS, and every hop is re-checked against the public-target rules. The final
  response counts: `2xx`/`3xx` within the timeout (default 10 s) is healthy.
- **State machine.** `Pending` → `Up` on the first success. Two consecutive failures → `Down`.
  Two consecutive successes → `Up`.
- **Incidents** run from the confirmed `Down` check to the confirmed `Up` check. They are kept
  for the rolling 30-day window; ongoing incidents are kept until they end.
- **Notifications** go out once per confirmed transition, by email (Cloudflare Email Service)
  and ntfy. Each channel is tracked separately and retried up to 2 times on later runs
  (3 attempts in total).
- **Maintenance**, either *with notifications* or *without notifications* (silent). It starts
  immediately and only ends manually. When silent maintenance ends while a monitor is still
  down, one "still down" alert is sent.
- **Metrics.** Rolling 30-day uptime and downtime. Operational values exclude silent
  maintenance; inclusive values (shown in parentheses) include it.
- **Weekly report.** Emailed on Mondays at `REPORT_HOUR` (default 08:00) in your `TIME_ZONE` for the completed
  Monday–Sunday week, and only when that week had an operational outage. It runs on its own
  cron, separate from the checks (see [Schedules](#schedules)).
- **Dashboard.** Table with filters, explicit and "all filtered" selection, bulk actions with
  confirmation, add/edit (a URL change must be confirmed and resets history), diagnostics-only
  *Check now*, and per-monitor incident history.

Checks run from Cloudflare's network only, a single vantage point. A result does not prove a
site is reachable from every region or network. Nothing independently monitors the monitor.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Request routing (Access check first) and the cron entry point |
| `src/cycle.ts` | One every-minute run: checks → notifications → retention |
| `src/checks.ts`, `src/probe.ts`, `src/state.ts` | Probing, redirect handling, Up/Down state machine |
| `src/notifications.ts` | Email/ntfy content and per-channel delivery with retries |
| `src/maintenance.ts` | Maintenance modes and the still-down reminder |
| `src/metrics.ts` | Operational/inclusive uptime over a window |
| `src/report.ts`, `src/time.ts` | Weekly report scheduling (configurable time zone) and rendering |
| `src/monitors.ts` | Monitor API: list, detail, create, edit, Check now, maintenance, bulk |
| `src/auth.ts` | Cloudflare Access JWT verification |
| `src/url.ts`, `src/budget.ts` | Public-URL validation, Free-plan subrequest budget |
| `public/` | Dashboard (plain HTML/CSS/JS, no build step) |
| `migrations/` | D1 schema |

### Schedules

| Cron (UTC) | Runs |
| --- | --- |
| `* * * * *` | Checks, notification delivery and retries, retention |
| `*/5 * * * *` | Weekly report |

Cron times are UTC, but "Monday morning" depends on your time zone and on daylight saving, so the
report cron simply fires every 5 minutes and the handler decides. It does nothing except during
the two hours starting at `REPORT_HOUR` on a local Monday (in `TIME_ZONE`). The first firing in
that window builds the report, and later firings retry a failed delivery. If every firing in the
window fails, the report for that week is not sent. You don't need to edit the cron strings; they
are matched by exact string in the code.

### Free-plan limits

- **50 external subrequests per invocation.** Every redirect hop and every ntfy publish counts.
  Each run gets a budget (`EXTERNAL_SUBREQUEST_LIMIT`), with 5 kept back for ntfy. A check that
  doesn't fit is *deferred*: no result is recorded and the state doesn't change. Deferred
  monitors go first on the next run.
- **6 simultaneous connections.** Probes run at most 6 at a time, so a request waiting in the
  runtime's queue can't eat into its own timeout.
- **D1 writes.** About 20 monitor updates per minute, which is roughly 29k rows a day, well
  within the free quota.

## API

All routes require a valid Cloudflare Access assertion.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/monitors` | All monitors with 30-day metrics |
| `POST` | `/api/monitors` | `{ name, url, group?, timeoutMs? }` |
| `GET` | `/api/monitors/:id` | Includes the 30-day incident list |
| `PATCH` | `/api/monitors/:id` | `{ name?, group?, timeoutMs?, url?, confirmUrlChange? }` |
| `DELETE` | `/api/monitors/:id?confirm=true` | Permanent; removes incident history |
| `POST` | `/api/monitors/:id/check` | Diagnostics only; records nothing |
| `PUT` | `/api/monitors/:id/maintenance` | `{ mode: "notify" \| "silent" \| "none" }` |
| `POST` | `/api/monitors/bulk` | `{ action: "maintenance" \| "end-maintenance" \| "delete", mode?, ids, confirm: true }` |
| `GET` | `/api/me` | Which notification channels are configured |

## Develop

This project uses [pnpm](https://pnpm.io). Wrangler is a local dev dependency, so run it
through pnpm (`pnpm exec wrangler …` or `pnpm wrangler …`), not as a bare `wrangler` command.

```bash
pnpm install
pnpm setup                         # creates wrangler.jsonc and .dev.vars (DEV_DISABLE_AUTH=true skips Access locally)
pnpm db:migrate:local
pnpm dev                           # wrangler dev --test-scheduled
```

To trigger the checks or the weekly report locally (the report only acts on a local Monday in the
report window, so test it by running the tests or setting the clock):

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
```

```bash
pnpm test
pnpm typecheck
pnpm types      # regenerate worker-configuration.d.ts after adding a setting
```

The tests use `wrangler.example.jsonc`, so they run without any personal configuration.
The dev bypass is ignored whenever `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, and
`.dev.vars` is never deployed.

## Glossary

- **Monitor:** one public HTTP(S) URL that is checked every minute. At most one **monitor group**.
- **Check:** one scheduled probe of a monitor. **Check now** is a manual probe for diagnostics
  that changes nothing.
- **Pending / Up / Down:** a monitor's availability state. `Down` and recovery are only
  confirmed after two consecutive results.
- **Incident:** one continuous confirmed `Down` period.
- **Maintenance with notifications:** marks planned work; alerts still go out.
- **Maintenance without notifications (silent):** marks planned work and suppresses alerts.
  Its time is excluded from operational metrics.
- **Operational vs. inclusive metrics:** operational values exclude silent maintenance;
  inclusive values (in parentheses) count everything.
- **Observation period:** the time a monitor has been watched at its current URL. It starts at
  creation and restarts on a confirmed URL change.
- **Operational outage:** an incident with downtime outside silent maintenance. A weekly report
  is only sent for weeks that contain one.

## Contributing and security

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a
vulnerability, see [SECURITY.md](SECURITY.md). Released under the [MIT License](LICENSE).
