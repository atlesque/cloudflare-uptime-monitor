// Cloudflare Access verification for every dashboard and API request.
//
// Access enforces the administrator allowlist at the edge; the Worker verifies
// the signed assertion so that a request bypassing Access is still refused.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

export interface Identity {
  email: string;
}

export type AuthResult = { ok: true; identity: Identity } | { ok: false; response: Response };

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, "");
  const accessConfigured = Boolean(team && env.ACCESS_AUD);

  // Local development only (.dev.vars is never deployed). Once Access is
  // configured the bypass is ignored, so a stray flag cannot open production.
  if (!accessConfigured && env.DEV_DISABLE_AUTH === "true") {
    return { ok: true, identity: { email: "dev@localhost" } };
  }
  if (!team || !env.ACCESS_AUD) {
    return deny(500, "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return deny(401, "Missing Cloudflare Access assertion");

  let jwks = jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: env.ACCESS_AUD });
    return { ok: true, identity: { email: typeof payload.email === "string" ? payload.email : "unknown" } };
  } catch {
    return deny(403, "Invalid Cloudflare Access assertion");
  }
}

function deny(status: number, message: string): AuthResult {
  return { ok: false, response: Response.json({ error: message }, { status }) };
}
