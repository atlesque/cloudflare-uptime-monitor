# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/atlesque/cloudflare-uptime-monitor/security/advisories/new)
(Security tab → Report a vulnerability) rather than in a public issue. You will get a response
as soon as the maintainer can, and a fix is credited to you unless you prefer otherwise.

## Security model

- Every request, including the dashboard's static files, must carry a valid Cloudflare Access
  assertion (`Cf-Access-Jwt-Assertion`). The Worker verifies its signature, issuer and audience,
  and refuses everything when `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are not set.
- Deploy only on a custom domain protected by an Access application. The template disables
  `workers.dev` and preview URLs so there is no hostname that bypasses Access.
- Monitor URLs must be public `http(s)` addresses. Private, loopback and reserved IP ranges and
  internal hostnames are rejected, and every redirect hop is checked again.
- Secrets (`NTFY_TOKEN`) are Wrangler secrets and never belong in `wrangler.jsonc`.
  `wrangler.jsonc` and `.dev.vars` are git-ignored. Don't commit them.
- `DEV_DISABLE_AUTH` is for local development only and is ignored once the Access settings exist.

## Hardening tips for your own deployment

- Keep the Access policy as narrow as possible (specific emails rather than a whole domain, unless
  you control that domain's mail).
- Use an unguessable ntfy topic, or an access token, if you use a public ntfy server.
- Use a Cloudflare API token scoped to this account's Workers and D1 when deploying from CI.
