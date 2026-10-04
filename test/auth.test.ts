import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, fakeSites } from "./helpers";

const TEAM = "https://example.cloudflareaccess.com";
const AUD = "aud-tag-123";
const ORIGIN = "https://uptime.example.com";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: object[] };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});

beforeEach(() => {
  fakeSites({ [`${TEAM}/cdn-cgi/access/certs`]: () => Response.json(jwks) });
});
afterEach(() => vi.restoreAllMocks());

const accessEnv = (overrides: Partial<Env> = {}): Env => ({
  ...env,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  DEV_DISABLE_AUTH: "",
  ...overrides,
});

function token(opts: { key?: CryptoKey; aud?: string; iss?: string; expiresIn?: string } = {}) {
  return new SignJWT({ email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(opts.key ?? signingKey);
}

function request(path: string, jwt: string | null, e = accessEnv()) {
  return api(path, jwt ? { headers: { "Cf-Access-Jwt-Assertion": jwt } } : undefined, e, ORIGIN);
}

describe("Cloudflare Access", () => {
  it("allows requests carrying a valid Access assertion", async () => {
    expect((await request("/api/monitors", await token())).status).toBe(200);
  });

  it("protects the dashboard page as well as the API", async () => {
    expect((await request("/", null)).status).toBe(401);
    expect((await request("/", await token())).status).toBe(200);
  });

  it("rejects requests without an assertion", async () => {
    expect((await request("/api/monitors", null)).status).toBe(401);
  });

  it.each([
    ["the wrong audience", { aud: "another-app" }],
    ["the wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["an unknown signing key", { other: true }],
    ["an expired token", { expiresIn: "-1m" }],
  ])("rejects an assertion with %s", async (_, opts: { aud?: string; iss?: string; expiresIn?: string; other?: boolean }) => {
    const jwt = await token({ ...opts, key: opts.other ? otherKey : undefined });
    expect((await request("/api/monitors", jwt)).status).toBe(403);
  });

  it("rejects garbage assertions", async () => {
    expect((await request("/api/monitors", "not-a-jwt")).status).toBe(403);
  });

  it("fails closed when Access is not configured", async () => {
    const res = await request("/api/monitors", await token(), accessEnv({ ACCESS_AUD: "" }));
    expect(res.status).toBe(500);
  });

  it("ignores the development bypass once Access is configured", async () => {
    const e = accessEnv({ DEV_DISABLE_AUTH: "true" });
    expect((await request("/api/monitors", null, e)).status).toBe(401);
    const unconfigured = accessEnv({ DEV_DISABLE_AUTH: "true", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" });
    expect((await request("/api/monitors", null, unconfigured)).status).toBe(200);
  });
});
