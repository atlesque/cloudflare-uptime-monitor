# Cloudflare Free Uptime Monitor

Original design document. Deployment-specific values (hostname, time zone, report hour, addresses) are configuration; see the README.

## Problem Statement

A hosted monitoring service previously monitored approximately 20 public websites. The goal is to replace that recurring cost with a small, private uptime-monitoring system running on the Cloudflare Free plan.

The websites being monitored are not necessarily hosted behind or protected by Cloudflare, so Cloudflare Health Checks are not the right abstraction. The replacement must make ordinary public HTTP(S) requests to external sites, maintain enough state to detect outages, notify administrators through email and ntfy, support manual maintenance modes, and provide a private operational dashboard at the configured dashboard hostname.

The system does not need public status pages, extensive historical graphs, multi-region monitoring, or a broad monitoring platform. It does need reliable one-minute checks, a rolling 30-day view, one-month incident history, and a summary-style weekly report when a week contains an operational outage.

## Solution

Build a separate Cloudflare project consisting of one Worker, one D1 database, bundled dashboard assets, and scheduled Worker executions. The dashboard is hosted at the configured dashboard hostname and protected by Cloudflare Access for a small allowlist of administrators.

The Worker checks public HTTP(S) monitors once per minute from the Cloudflare Worker environment. A monitor becomes `Down` after two consecutive failed checks and returns to `Up` after two consecutive successful checks. Confirmed incidents are stored for the rolling 30-day window, with maintenance-aware operational and inclusive metrics.

The project sends transition notifications through globally configured Cloudflare Email Service recipients and a configured ntfy server. Every Monday at the configured report hour (`REPORT_HOUR`, default 08:00) in the configured time zone (`TIME_ZONE`), it sends a summary-style HTML report by email only when the completed Monday-through-Sunday period contains at least one operational outage. Weeks with no operational outage do not produce a report.

## User Stories

1. As an administrator, I want to open a private dashboard at the configured dashboard hostname, so that I can manage monitoring without exposing operational information publicly.
2. As an administrator, I want Cloudflare Access to protect the dashboard, so that authentication does not depend on a custom shared-password implementation.
3. As an administrator, I want only a small allowlist of trusted administrators to access the dashboard, so that all authorized users can manage monitors without a complex role system.
4. As an administrator, I want to see every current monitor in one table, so that I can quickly assess the status of all monitored websites.
5. As an administrator, I want to see a selection checkbox for every monitor, so that I can perform actions on a deliberate set of monitors.
6. As an administrator, I want to select all monitors matching the current filter, so that I can manage a group without selecting every row manually.
7. As an administrator, I want the dashboard to show the exact selected count before a group action, so that I can catch an unintended selection.
8. As an administrator, I want hidden selections to be cleared when filters change, so that bulk actions cannot silently include monitors I can no longer see.
9. As an administrator, I want to add a monitor with a name, public HTTP(S) URL, optional group, and timeout, so that a new website can be monitored without code changes.
10. As an administrator, I want a new monitor to begin in `Pending`, so that the dashboard does not claim availability before the first scheduled check.
11. As an administrator, I want a successful new-monitor check to change the monitor to `Up`, so that healthy sites become visible immediately after observation begins.
12. As an administrator, I want two consecutive failures to change a monitor to `Down`, so that transient single-check failures do not create false outages.
13. As an administrator, I want two consecutive successes to recover a `Down` monitor, so that recovery is not reported on a single potentially transient success.
14. As an administrator, I want checks to run every minute, so that outages are detected promptly while remaining suitable for Cloudflare Free limits.
15. As an administrator, I want normal checks to follow HTTP redirects, including HTTP-to-HTTPS redirects, so that ordinary website redirect behavior is not reported as downtime.
16. As an administrator, I want the final response after a bounded redirect chain to determine health, so that the monitor reflects the endpoint users ultimately reach.
17. As an administrator, I want duplicate normalized URLs rejected, so that the same endpoint cannot generate duplicate checks and duplicate alerts.
18. As an administrator, I want private, loopback, link-local, and internal targets rejected, so that the Worker cannot be used as an SSRF proxy.
19. As an administrator, I want a monitor’s latest response status or error shown, so that I can diagnose why a check failed.
20. As an administrator, I want the latest response duration shown, so that I can identify sites that are reachable but slow without requiring latency history.
21. As an administrator, I want a `Check now` action, so that I can manually diagnose a site immediately.
22. As an administrator, I want `Check now` to be diagnostics-only, so that manual probes do not alter incidents, uptime metrics, state transitions, or notifications.
23. As an administrator, I want to edit a monitor’s name, group, and timeout without resetting its history, so that ordinary configuration changes preserve useful metrics.
24. As an administrator, I want changing a monitor URL to require confirmation, so that a URL change cannot silently rewrite the meaning of existing uptime data.
25. As an administrator, I want a URL change to start a new observation period, so that historical data for the previous endpoint is not blended with the new endpoint.
26. As an administrator, I want each monitor to have at most one group, so that filtering and bulk selection remain predictable.
27. As an administrator, I want to filter monitors by group and status, so that I can quickly find the monitors needing action.
28. As an administrator, I want each monitor to support `Maintenance with notifications`, so that I can identify planned work while continuing to receive ordinary outage and recovery alerts.
29. As an administrator, I want each monitor to support `Maintenance without notifications`, so that planned work does not create notifications while checks continue.
30. As an administrator, I want maintenance to start immediately, so that I can suppress or retain notifications before planned work begins.
31. As an administrator, I want maintenance to remain active until I manually end it, so that there is no unexpected automatic expiry.
32. As an administrator, I want to apply either maintenance mode to one selected monitor, so that maintenance can be managed at monitor level.
33. As an administrator, I want to apply either maintenance mode to a confirmed group of selected monitors, so that a coordinated deployment can be managed efficiently.
34. As an administrator, I want bulk maintenance actions to have no end-time field, so that group maintenance always ends through an explicit manual action.
35. As an administrator, I want a separate end-maintenance action for one or more selected monitors, so that maintenance state can be cleared deliberately.
36. As an administrator, I want maintenance modes visibly represented in the dashboard, so that suppressed notifications are not mistaken for healthy normal operation.
37. As an administrator, I want a monitor that enters silent maintenance while already `Down` to remain one continuous incident, so that maintenance does not inflate outage counts.
38. As an administrator, I want silent-maintenance time excluded from operational metrics, so that planned downtime does not reduce the operational uptime percentage.
39. As an administrator, I want all maintenance time included in parenthesized inclusive metrics, so that the report remains transparent about total downtime.
40. As an administrator, I want a single outage notification when a monitor becomes `Down`, so that I am informed without repeated alert noise.
41. As an administrator, I want a single recovery notification when a monitor becomes `Up`, so that I know the incident has ended.
42. As an administrator, I want notifications suppressed while a monitor is in `Maintenance without notifications`, so that planned work does not wake me up.
43. As an administrator, I want a “still down” notification when silent maintenance ends and the monitor remains down, so that an outage is not forgotten after maintenance.
44. As an administrator, I want notification delivery tracked independently for email and ntfy, so that failure of one channel does not duplicate or suppress successful delivery through the other.
45. As an administrator, I want failed notification channels retried a small number of times, so that temporary provider failures do not silently lose an outage alert.
46. As an administrator, I want email notifications to include monitor identity, URL, transition, local timestamp, result/error details, and recovery duration, so that the alert is actionable without opening the dashboard.
47. As an administrator, I want ntfy notifications to contain the same essential details in a concise message with a dashboard link, so that mobile alerts remain readable.
48. As an administrator, I want email recipients configured globally, so that all monitors use the same operational notification audience.
49. As an administrator, I want ntfy configured globally with the existing server URL, topic, and secret publish credential, so that all monitors use the existing notification infrastructure.
50. As an administrator, I want notification credentials stored as Worker secrets, so that they are not exposed in the dashboard or monitor records.
51. As an administrator, I want rolling 30-day uptime percentages, so that I can assess recent reliability without retaining extensive history.
52. As an administrator, I want rolling 30-day downtime totals, so that I can understand the operational impact of recent incidents.
53. As an administrator, I want one-month incident history per monitor, so that I can inspect recent outages without a raw per-minute event log.
54. As an administrator, I want each incident to show start time, end time, duration, failure reason, and maintenance status, so that recent outages can be understood in context.
55. As an administrator, I want incidents crossing a reporting boundary clipped to that window, so that the same downtime is not counted twice across reports.
56. As an administrator, I want an ongoing incident to count through the end of the reporting window, so that an outage active at week-end is not understated.
57. As an administrator, I want newly added monitors’ metrics calculated only from their creation time, so that early reports do not pretend to have observed unavailable history.
58. As an administrator, I want downtime measured from confirmed `Down` to confirmed `Up`, so that uptime calculations use the same boundaries as alert transitions.
59. As an administrator, I want a weekly email for the completed Monday-through-Sunday period, so that the report has a stable and comparable period.
60. As an administrator, I want the weekly email sent Monday at the configured report hour in the configured time zone, so that it arrives at a predictable local time.
61. As an administrator, I want no weekly report when the completed week has no operational outage, so that routine healthy weeks do not create unnecessary email.
62. As an administrator, I want a report when the week contains at least one operational outage, so that a weekly summary is available when there is something to review.
63. As an administrator, I want the weekly report delivered through email only, so that ntfy remains focused on concise operational alerts.
64. As an administrator, I want every current monitor included in a triggered weekly report, including monitors with no outage, so that the report provides a complete fleet view.
65. As an administrator, I want the weekly email to resemble the supplied summary-style presentation, so that the replacement feels familiar during migration.
66. As an administrator, I want the report to show a centered title and date range, so that the reporting period is immediately clear.
67. As an administrator, I want report columns for monitor name, outages, downtime, and uptime, so that every monitor has the same compact summary.
68. As an administrator, I want inclusive maintenance values shown in parentheses, so that operational figures and total figures are visible together.
69. As an administrator, I want a note explaining parenthesized maintenance values, so that the difference between operational and inclusive figures is unambiguous.
70. As an administrator, I want total outage incidents and total downtime minutes in the weekly email, so that I can understand the overall impact without calculating it manually.
71. As an administrator, I want no combined fleet uptime percentage, so that different monitor lifetimes are not misleadingly averaged together.
72. As an administrator, I want deleted monitors omitted from future reports, so that permanent deletion also removes their future operational representation.
73. As an administrator, I want to permanently delete a monitor, so that obsolete sites and their incident history can be removed completely.
74. As an administrator, I want deletion to always require explicit confirmation, including bulk deletion, so that a mistaken click cannot destroy monitoring data.
75. As an administrator, I want existing monitors entered manually during migration, so that the initial replacement does not depend on an unavailable export from the previous service.
76. As an administrator, I want the monitor project deployed independently from the existing admin panel, so that monitoring remains operationally separate from the NestJS/Nuxt application.
77. As an administrator, I want the system to use one Worker and one D1 database, so that deployment and maintenance remain simple.
78. As an administrator, I want the dashboard assets served by the same Worker, so that the private dashboard does not require a second application deployment.
79. As an administrator, I want the project to use Cloudflare Free-compatible scheduled checks and storage, so that migrating away from the paid previous service does not introduce a new recurring cost.
80. As an administrator, I want the monitoring vantage point documented as Cloudflare-based, so that I understand that results do not guarantee availability from every region or network.

## Implementation Decisions

- The feature is a new, standalone Cloudflare project. It is not implemented inside the existing NestJS/Nuxt admin-panel repository or coupled to that application’s runtime.
- The deployment shape is one Cloudflare Worker with bundled dashboard assets, one D1 database, and the configured custom dashboard hostname.
- Cloudflare Access protects the dashboard and management API. Access is restricted to a small allowlist of full administrators. There is no application-level shared password and no viewer/editor role model in the initial release.
- The Worker uses scheduled execution for a one-minute check cycle and a weekly reporting cycle at the configured report hour and time zone. The implementation must account for the configured local timezone when generating the weekly report.
- A Monitor is a public HTTP(S) endpoint checked with `GET`. A healthy response is an accepted `2xx` or `3xx` result within the configured timeout. The default timeout is 10 seconds and remains configurable per monitor.
- Redirects are followed to a bounded depth, including HTTP-to-HTTPS redirects. The configured URL remains the Monitor identity; the final response determines the check result.
- Monitor URL validation permits public HTTP(S) endpoints only and rejects loopback, private, link-local, and other internal targets. The normalized URL must be unique across monitors.
- Each Monitor has a name, URL, optional single Monitor group, timeout, creation time, current availability state, consecutive-success/failure state, latest check result, latest response duration, and maintenance mode.
- New monitors begin in `Pending`. Their observation period begins at creation time. A successful first check can move the monitor to `Up`; two consecutive failed checks move it to `Down` and initiate the normal outage-notification flow.
- The availability state machine uses two consecutive failed checks for `Down` and two consecutive successful checks for `Up`. A single failed or successful check does not produce a transition for an already-established state.
- The `Check now` action performs an immediate diagnostics-only probe. It displays the result but does not affect state, incidents, uptime metrics, or notifications.
- No separate paused state is implemented. Maintenance is the mechanism for temporary planned work; deletion is the mechanism for permanently removing a monitor.
- `Maintenance with notifications` continues checks, visibly marks the monitor as under maintenance, and leaves normal outage/recovery notifications enabled.
- `Maintenance without notifications` continues checks, visibly marks the monitor as under maintenance, and suppresses outage/recovery notifications while active.
- Maintenance is manual-only. It starts immediately and remains active until manually ended. There are no future start schedules or automatic expiry times in the initial release.
- Maintenance can be applied to one monitor or to a selected group of monitors. Bulk maintenance requires confirmation showing the selected count, monitor names, chosen mode, and the fact that ending will be manual. Bulk maintenance has no end-time field.
- Bulk actions apply to explicit selections or to an explicit “all filtered monitors” selection. Hidden selections are cleared when filters change, and the UI always shows the exact selection count before applying an action.
- An Incident represents one continuous confirmed `Down` period. If silent maintenance begins during an incident, the incident remains continuous and contains a maintenance segment rather than creating a duplicate outage. If it remains down when maintenance ends, one “still down” notification is eligible.
- Operational metrics exclude time in `Maintenance without notifications`; `Maintenance with notifications` remains operational downtime. Inclusive metrics include all maintenance time. Inclusive values are shown in parentheses when they differ.
- Incidents are retained for the rolling 30-day reporting window, with ongoing incidents retained until they are resolved. Raw per-minute check history is not retained or exposed.
- Uptime percentage is calculated as the observed non-Down time divided by the observed time in the reporting window. The observation window is clipped to the monitor creation time and the selected reporting window.
- Incident durations are calculated from the confirmed `Down` transition to the confirmed `Up` transition. Incidents crossing a week or rolling-window boundary are clipped to the window.
- The dashboard table includes selection, monitor name and URL, group, current state, rolling 30-day uptime, rolling 30-day downtime, latest check time/result, latest response duration, current outage start where applicable, maintenance indication, and row actions.
- Monitor detail views show incidents from the rolling 30-day window with start/end, duration, failure reason, and maintenance status. They do not show raw per-minute probes or latency graphs.
- The notification configuration is global. It contains verified Cloudflare Email Service recipient addresses and a configured ntfy server URL, topic, and secret publish credential. Notification secrets are stored as Worker secrets.
- Outage and recovery notifications are emitted once per confirmed state transition. Email contains detailed monitor and diagnostic context; ntfy contains concise context and a dashboard link. Repeated reminders are not sent while state is unchanged.
- Email and ntfy delivery are tracked independently. A failed channel is retried up to three times on later scheduler runs; a channel that succeeded is not resent because the other channel failed.
- The weekly report covers the previous completed Monday-through-Sunday period in the configured time zone and is emailed on Monday at the configured local report hour.
- A weekly report is generated only when the completed week contains at least one operational outage. A week containing only `Maintenance without notifications` does not qualify.
- The weekly report is sent by email only. It contains every monitor present when the report is generated, including monitors with no outage. Deleted monitors are excluded.
- The report uses a summary-style HTML presentation: centered title and date range, compact table, `Monitor`, `Outages`, `Downtime`, and `Uptime` columns, green healthy uptime values, parenthesized inclusive maintenance values, an explanatory note, and overall outage/downtime totals. A plain-text fallback should accompany the HTML email.
- The report does not include a combined fleet uptime percentage. Per-monitor uptime is the authoritative percentage because monitor creation dates and observed periods may differ.
- Permanent deletion requires explicit confirmation and removes the monitor configuration and incident history. This applies equally to individual and bulk deletion.
- Editing name, group, or timeout preserves history. Changing a URL requires confirmation and resets current state, rolling metrics, and the observation period so history cannot be attributed to a different endpoint.
- Existing monitors from the previous service are entered manually. No importer specific to the previous service or CSV import is part of the initial release.
- The checker is a single Cloudflare Worker vantage point. There is no independent regional/provider check and no independent self-monitoring or canary endpoint.
- The system is designed for approximately 20 monitors and the Cloudflare Free plan. The implementation should batch and bound outbound work so all target checks and notification requests remain within Worker execution limits.

## Testing Decisions

- The highest testing seam is the new Worker application boundary. Tests should exercise HTTP dashboard/API requests and scheduled events using fake D1, fake target-site responses, and fake email/ntfy transports.
- Tests should verify external behavior rather than internal function structure, SQL statement shape, or framework implementation details.
- The existing repository provides Jest, Supertest, and NestJS testing conventions, but it has no uptime or Cloudflare Worker implementation to reuse. The new standalone project should use the equivalent Worker-compatible test harness for request and scheduled-event behavior.
- Check-state tests should cover `Pending`, successful checks, isolated failures, the two-failure `Down` transition, isolated successes, the two-success `Up` transition, and suppression of duplicate notifications.
- Maintenance tests should cover both modes, per-monitor actions, confirmed group actions, manual end-maintenance, no automatic expiry, transitions into maintenance while already `Down`, operational versus inclusive metrics, and post-maintenance “still down” notification behavior.
- Reporting tests should cover rolling 30-day clipping, weekly Monday-through-Sunday clipping, incidents spanning reporting boundaries, ongoing incidents, newly created monitors, weeks with no operational outage, weeks with silent maintenance only, and reports containing all current monitors.
- Notification tests should verify detailed email content, concise ntfy content, global routing, independent channel success/failure, retry limits, and no duplicate delivery for a channel that already succeeded.
- Dashboard/API tests should cover Cloudflare-Access-authorized management behavior, monitor validation, normalized URL uniqueness, one-group assignment, explicit selection semantics, bulk confirmation requirements, diagnostics-only `Check now`, URL-change reset behavior, and confirmed permanent deletion.
- Email rendering tests should verify the summary-style title/date range, table columns, summary totals, parenthesized maintenance values, explanatory note, and plain-text fallback as externally received email content.
- Deployment verification should confirm the Worker route, D1 binding, scheduled events, Cloudflare Access protection, custom domain, Cloudflare Email Service configuration, and ntfy secret configuration without testing Cloudflare internals.

## Out of Scope

- Cloudflare Health Checks as the monitoring mechanism.
- Monitoring TCP, UDP, ICMP, DNS, SSL expiry, domain expiry, keyword content, authenticated endpoints, custom HTTP methods, or custom headers in the initial release.
- Sites reachable only through a private network, VPN, or LAN.
- Multi-region or multi-provider checking.
- Independent monitoring of the monitor Worker, Cron schedule, D1 database, or notification system.
- A separate pause state.
- Future scheduled maintenance windows, recurring maintenance schedules, or automatic maintenance expiry.
- A public status page, public dashboard, public monitor links, or subscriber management.
- Extensive raw check history, uptime graphs, latency history, or long-term analytics.
- Per-monitor notification recipients or routing rules.
- Viewer/editor roles or a custom application password.
- Importer specific to the previous service, or CSV import in the initial migration.
- A combined fleet uptime percentage.
- Automatic migration or synchronization with a hosted monitoring service.
- Features visible in the reference screenshots but not explicitly agreed, including status-page management, contact-list management, public/private toggles, SSL/domain-expiry warnings, server-resource warnings, SLA calculations, private notes, and pause/unpause monitoring.

## Further Notes

- The attached screenshots are visual references for the dashboard/report style. They do not add requirements for unrelated menu items of the previous service.
- The dashboard hostname must be on a domain that is managed in a Cloudflare zone for the Worker route and Cloudflare Access configuration.
- Cloudflare Email Service must be configured with verified recipients to preserve the Free-plan email requirement.
- The ntfy server URL is already publicly reachable over HTTPS from Cloudflare Workers; its publish token must never be stored in a monitor record or returned by the dashboard.
- The system deliberately accepts the risk that the monitor itself may stop checking without independently alerting anyone.
- The first deployment should be populated manually with the approximately 20 existing monitors and verified against the the previous service configuration before it is retired.
- The agreed project terminology is recorded in the repository’s domain glossary.
