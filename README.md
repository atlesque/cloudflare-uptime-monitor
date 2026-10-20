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
pnpm run setup                   # creates wrangler.jsonc and .dev.vars from the templates
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

**ntfy**: nothing to set in `wrangler.jsonc`. Set it up on the dashboard's **Settings** page
after the first deploy, or with Wrangler secrets (step 7). Pick a hard to guess topic name if you
use the public ntfy.sh server, or protect the topic with an access token.

### 6. Set your time zone

Set `TIME_ZONE` to an [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
such as `Europe/Brussels` or `America/New_York` (default `UTC`). It decides when a week starts
and ends for the weekly report, and which zone is used for times in alerts and the dashboard.
`REPORT_HOUR` (default `8`) is the local hour the weekly report goes out on Mondays.

### 7. Deploy

```bash
pnpm run deploy
```

To turn on ntfy, either open **Settings** on the dashboard, enter a topic and send a test
notification, or store its settings as secrets now. Wrangler prompts for each value, so it never
lands in your shell history or in git:

```bash
pnpm exec wrangler secret put NTFY_TOPIC   # required for ntfy
pnpm exec wrangler secret put NTFY_URL     # optional: only for a self-hosted server (default https://ntfy.sh)
pnpm exec wrangler secret put NTFY_TOKEN   # optional: only if your topic needs an access token
```

Secrets take effect immediately, without another deploy. To turn ntfy off again, run
`pnpm exec wrangler secret delete NTFY_TOPIC`.

Once ntfy is saved on the Settings page, those settings win over the secrets (an access token
saved there is kept in D1 and never shown again). *Use deployment secrets instead* on that page
switches back.

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
| `NTFY_URL` | no | **secret** | ntfy server, default `https://ntfy.sh` |
| `NTFY_TOPIC` | no | **secret** | ntfy topic. Unset disables ntfy |
| `NTFY_TOKEN` | no | **secret** | ntfy access token, if your topic requires one |
| `TIME_ZONE` | no | var | IANA time zone for the report and displayed times, default `UTC` |
| `REPORT_HOUR` | no | var | Local hour (0–21) for the Monday report, default `8` |
| `EXTERNAL_SUBREQUEST_LIMIT` | no | var | External requests per run, default `50` (Free plan). Raise on a paid plan |
| `CHECK_LOCATION` | no | var | Region checks run from, as a Durable Object location hint such as `weur`. Empty: wherever Cloudflare runs the cron (see [Where checks run from](#where-checks-run-from)) |
| `DEV_DISABLE_AUTH` | no | `.dev.vars` only | Skips Access for local development. Ignored when the Access settings are set |

## Updating

```bash
git pull
pnpm install
pnpm db:migrate:remote           # applies any new migrations
pnpm run deploy
```

Your `wrangler.jsonc` and `.dev.vars` aren't tracked, so pulling never overwrites them. If a new
release adds a setting, compare your file with `wrangler.example.jsonc`.

Upgrading from a version without `CHECK_LOCATION`: copy the `durable_objects` and `migrations`
blocks and the `CHECK_LOCATION` var from `wrangler.example.jsonc` into your `wrangler.jsonc`
(and into the `WRANGLER_CONFIG` build secret if you deploy with Workers Builds). Until then,
checks keep running from the Worker as before.

Upgrading from a version that had `NTFY_URL` and `NTFY_TOPIC` under `vars`: delete both from your
`wrangler.jsonc`, deploy, then set them with `wrangler secret put` as in step 7. Wrangler refuses a
secret with the same name as a var that is still deployed.

### Deploy automatically from GitHub

Cloudflare can deploy every push to `main` with Workers Builds. In the Cloudflare dashboard, open
**Workers & Pages**, select your Worker, then **Settings → Builds → Connect**, and choose your
repository with these settings:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Build command | *(leave empty)* |
| Deploy command | `pnpm run deploy:ci` |
| Non-production branch builds | Off |
| Build secret `WRANGLER_CONFIG` | The full contents of your `wrangler.jsonc` |

`deploy:ci` writes `wrangler.jsonc` from `WRANGLER_CONFIG` (the file is git-ignored), applies new
D1 migrations and deploys. When you change your `wrangler.jsonc`, update the build secret too.
ntfy secrets stay on the Worker and aren't touched by a deploy. If the migration step fails with
an authentication error, create an API token from the *Edit Cloudflare Workers* template with
**Account → D1 → Edit** added, and select it as the build's API token.

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
- **Wrangler can't find `wrangler.jsonc`**: run `pnpm run setup`.

## What it does

- **Checks every minute by default.** The interval is set on the Settings page (1 to 60 minutes)
  and can be overridden per monitor. Each check is a `GET` request. Up to 5 redirects are followed,
  including HTTP→HTTPS, and every hop is re-checked against the public-target rules. The final
  response counts: `2xx`/`3xx` within the timeout (default 10 s) is healthy. There are no
  retries within a run: each site gets one request per interval (plus one per redirect hop).
- **Failed-check diagnostics.** For each failed check the redirect chain, the response headers
  and the first 16 KB of the body are kept (the last 20 per monitor, for up to 31 days), and
  shown in the detail panel and in *Check now*. The dashboard points out Akamai and Cloudflare
  block pages (with their reference ID) and errors that came from the site's own origin.
- **Request headers per monitor.** Optional extra headers sent with each check, for example a
  secret header that a site's firewall is told to let through, or a different `User-Agent`. They only go to the monitor URL's
  own host, and not over plain HTTP when the URL is HTTPS, so a redirect to another site never
  sees them.
- **Cache busting per monitor.** Optional. Each check adds a unique `_uptime=<timestamp>`
  query parameter to the URL (after any query it already has), so a CDN can't answer with a
  cached copy. Akamai, for example, can keep serving the last `200` while the origin is down.
  Enter the URL without the parameter and tick *Bypass caches*.
- **Retry-After.** When a site answers `429` or `503` with `Retry-After`, it isn't checked again
  until then (at most 30 minutes later).
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
- **Dashboard.** Built with Nuxt 4 and Nuxt UI, with light and dark themes. A Settings page with tabs
  for notifications (ntfy, with a test notification), monitors (the default check interval) and
  groups (add, rename, merge or remove a group, and pick its monitors). Status cards that
  double as filters, a 90-day uptime bar across all monitors (one bar per day, with the outages of each day),
  a table (a card list on phones) with search and filters, explicit and "all
  filtered" selection, bulk actions with confirmation, add/edit (a URL change must be confirmed
  and resets history), diagnostics-only *Check now*, and a detail panel with per-monitor incident
  history.

Checks run from Cloudflare's network only, a single vantage point. A result does not prove a
site is reachable from every region or network. Nothing independently monitors the monitor.

### Where checks run from

Cloudflare runs scheduled Workers on whichever machine has spare capacity, anywhere in the world,
and Smart Placement doesn't apply to them. Without `CHECK_LOCATION`, a site sees checks from
Cloudflare IPs in Singapore, the US, Japan and elsewhere, and a WAF can block some of those on IP
reputation or location. With `CHECK_LOCATION` set (for example `weur` for Western Europe), the
checks run in a Durable Object created with that location hint, so they leave from that region.
The hint is best effort, and the IPs are still shared Cloudflare addresses, so a strict WAF may
still need an exception, for example on a secret request header. If the Durable Object can't be
reached, that run's checks fall back to the Worker rather than being skipped.

Each monitor can also pick its own location (**Check from** in the edit form); monitors left on
*Default* use `CHECK_LOCATION`.

**Cost.** There is one Durable Object per location hint, named after it, so at most nine ever
exist, however many monitors you have. Each run calls each location in use once, so even with all
nine in use that is about 13,000 calls a day, within the Free plan's 100,000 a day. An object is
only billed for duration while a run's checks are in flight; with one location, a run that takes
2 seconds comes to about 370 GB-s a day, against 13,000 a day on the Free plan.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Request routing (Access check first) and the cron entry point |
| `src/cycle.ts` | One every-minute run: checks → notifications → retention |
| `src/checks.ts`, `src/probe.ts`, `src/state.ts` | Probing, redirect handling, Up/Down state machine |
| `src/diagnosis.ts` | Reads a failed response for CDN block pages and origin errors |
| `src/notifications.ts` | Email/ntfy content and per-channel delivery with retries |
| `src/maintenance.ts` | Maintenance modes and the still-down reminder |
| `src/metrics.ts` | Operational/inclusive uptime over a window |
| `src/report.ts`, `src/time.ts` | Weekly report scheduling (configurable time zone) and rendering |
| `src/monitors.ts` | Monitor API: list, detail, create, edit, Check now, maintenance, bulk |
| `src/uptime.ts` | Daily uptime across all monitors for the dashboard's 90-day bar |
| `src/settings.ts`, `src/groups.ts` | Settings saved from the dashboard (ntfy, check interval) and group management |
| `src/auth.ts` | Cloudflare Access JWT verification |
| `src/url.ts`, `src/budget.ts` | Public-URL validation, Free-plan subrequest budget |
| `src/prober.ts`, `src/headers.ts` | Running checks from `CHECK_LOCATION`, per-monitor request headers |
| `dashboard/` | Dashboard: a client-only [Nuxt 4](https://nuxt.com) + [Nuxt UI](https://ui.nuxt.com) app, built into `public/` |
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
| `POST` | `/api/monitors` | `{ name, url, group?, timeoutMs?, checkIntervalMinutes?, requestHeaders?, checkLocation?, cacheBust? }`; `requestHeaders` is up to 10 `{ name, value }`, `checkLocation` a location hint such as `weur` or `null` for the default, `cacheBust` a boolean |
| `GET` | `/api/monitors/:id` | Includes the 30-day incident list and recent failed checks |
| `GET` | `/api/monitors/:id/failures/:failureId` | One failed check with its headers, body and diagnosis |
| `PATCH` | `/api/monitors/:id` | `{ name?, group?, timeoutMs?, checkIntervalMinutes?, requestHeaders?, checkLocation?, cacheBust?, url?, confirmUrlChange? }` |
| `DELETE` | `/api/monitors/:id?confirm=true` | Permanent; removes incident history |
| `POST` | `/api/monitors/:id/check` | Diagnostics only (includes the response when it fails); records nothing |
| `PUT` | `/api/monitors/:id/maintenance` | `{ mode: "notify" \| "silent" \| "none" }` |
| `POST` | `/api/monitors/bulk` | `{ action: "maintenance" \| "end-maintenance" \| "delete", mode?, ids, confirm: true }` |
| `GET` | `/api/me` | Which notification channels are configured, and the default check location |
| `GET` | `/api/settings` | ntfy settings (never the token or secret values) and the default check interval |
| `PUT` | `/api/settings/ntfy` | `{ url?, topic, token?, clearToken? }`; empty topic turns ntfy off |
| `DELETE` | `/api/settings/ntfy` | Forget the saved ntfy settings and use the Wrangler secrets |
| `POST` | `/api/settings/ntfy/test` | Test notification; body as for `PUT` to test unsaved values |
| `PUT` | `/api/settings/checks` | `{ defaultIntervalMinutes }`: one of 1, 2, 3, 5, 10, 15, 30, 60 |
| `GET` | `/api/groups` | Groups with their monitor counts, including empty groups |
| `POST` | `/api/groups` | `{ name, monitorIds? }`; adds a group, moving those monitors into it |
| `POST` | `/api/groups/edit` | `{ name, to?, monitorIds? }`; `monitorIds` sets the group's monitors exactly, `to` renames (merging into an existing group) |
| `POST` | `/api/groups/rename` | `{ from, to }`; renaming onto an existing group merges them |
| `POST` | `/api/groups/remove` | `{ name, confirm: true }`; the monitors stay, without a group |

## Develop

This project uses [pnpm](https://pnpm.io). Wrangler is a local dev dependency, so run it
through pnpm (`pnpm exec wrangler …` or `pnpm wrangler …`), not as a bare `wrangler` command.

```bash
pnpm install
pnpm run setup                     # creates wrangler.jsonc and .dev.vars (DEV_DISABLE_AUTH=true skips Access locally)
pnpm db:migrate:local
pnpm dev                           # builds the dashboard, then wrangler dev --test-scheduled
```

`pnpm run deploy` and `pnpm dev` build the dashboard into `public/` first (`pnpm build`). To work on
the dashboard with hot reload, keep `pnpm dev` running and start the Nuxt dev server next to it;
it proxies `/api` to the Worker on port 8787:

```bash
pnpm dev:dashboard                 # http://localhost:3000
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

- **Monitor:** one public HTTP(S) URL that is checked on an interval (every minute by default). At most one **monitor group**.
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
