// A single HTTP check against a monitor URL.
//
// Redirects are followed manually so every hop can be re-validated against the
// public-target rules. The timeout covers the whole redirect chain.
//
// A failed check also returns diagnostics: the redirect chain, the response headers and
// the start of the body, so block pages (Akamai, Cloudflare) and origin errors can be
// told apart.
//
// A monitor's extra request headers (for example a secret header a site's WAF lets through)
// are only sent to the monitor's own host, so a redirect elsewhere never sees them.
//
// With cache busting on, the first request adds a unique `_uptime` query parameter so a CDN
// can't answer with a cached copy (Akamai can keep serving the last 200 while the origin is
// down). Redirect targets are followed as the site sent them.

import type { Budget } from "./budget";
import { disallowedHostReason } from "./url";

export const MAX_REDIRECTS = 5;
/** Bytes of a failed response's body kept for diagnostics. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Longest Retry-After the scheduler honors before checking again anyway. */
export const MAX_RETRY_AFTER_MS = 30 * 60_000;
// Workers allow 6 simultaneous outbound connections; further fetches queue
// inside the runtime while their timeout is already running. Limiting here
// keeps each probe's timeout measuring only its own request.
const PROBE_CONCURRENCY = 6;
const USER_AGENT = "CloudflareUptimeMonitor/1.0 (+https://github.com/atlesque/cloudflare-uptime-monitor)";

export interface ProbeRequest {
  url: string;
  timeoutMs: number;
  /** Extra request headers, sent only to the monitor URL's host. */
  headers?: [string, string][];
  /** Adds a unique `_uptime` query parameter to the URL. */
  cacheBust?: boolean;
}

export const CACHE_BUST_PARAM = "_uptime";

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface ProbeDiagnostics {
  /** URL of the last request made. */
  url: string;
  redirects: RedirectHop[];
  /** Headers of the last response; null when no response arrived (timeout, network error). */
  headers: [string, string][] | null;
  body: string | null;
  bodyTruncated: boolean;
}

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
  /** True when the check could not run within the invocation's subrequest budget. */
  skipped?: boolean;
  /** Present on failed checks that ran. */
  diagnostics?: ProbeDiagnostics;
  /** Delay the site asked for with Retry-After on a 429 or 503, capped at MAX_RETRY_AFTER_MS. */
  retryAfterMs?: number;
}

export async function probe(
  { url, timeoutMs, headers: extraHeaders = [], cacheBust = false }: ProbeRequest,
  budget?: Budget,
): Promise<ProbeResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const redirects: RedirectHop[] = [];
  let current = cacheBust ? withCacheBust(url, started) : url;
  const result = (ok: boolean, status: number | null, error: string | null): ProbeResult => ({
    ok,
    status,
    error,
    durationMs: Date.now() - started,
  });
  const failure = (status: number | null, error: string, response?: Response, body?: Body): ProbeResult => ({
    ...result(false, status, error),
    diagnostics: {
      url: current,
      redirects,
      headers: response ? [...response.headers] : null,
      body: body?.text ?? null,
      bodyTruncated: body?.truncated ?? false,
    },
  });

  try {
    for (let hop = 0; ; hop++) {
      if (budget && !budget.take()) {
        return { ...result(false, null, "Deferred: subrequest budget exhausted"), skipped: true };
      }
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: requestHeaders(url, current, extraHeaders),
      });

      const location = res.headers.get("Location");
      const isRedirect = res.status >= 300 && res.status < 400 && location !== null;
      if (!isRedirect) {
        const healthy = res.status >= 200 && res.status < 400;
        if (healthy) {
          // Only the status matters; release the connection immediately.
          await res.body?.cancel();
          return result(true, res.status, null);
        }
        const out = failure(res.status, `HTTP ${res.status}`, res, await readStart(res));
        const retryAfterMs =
          res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get("Retry-After"), Date.now()) : null;
        return retryAfterMs ? { ...out, retryAfterMs } : out;
      }
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) {
        return failure(res.status, `Too many redirects (more than ${MAX_REDIRECTS})`, res);
      }
      const next = new URL(location, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return failure(res.status, `Redirect to unsupported protocol ${next.protocol}`, res);
      }
      const blocked = disallowedHostReason(next.hostname);
      if (blocked) {
        return failure(res.status, `Redirect to disallowed target: ${blocked}`, res);
      }
      redirects.push({ url: current, status: res.status, location });
      current = next.toString();
    }
  } catch (err) {
    if (signal.aborted) return failure(null, `Timeout after ${timeoutMs} ms`);
    return failure(null, err instanceof Error ? err.message : String(err));
  }
}

/** Appends `_uptime=<time>` to the query string, keeping the existing query as written. */
export function withCacheBust(url: string, time: number): string {
  const u = new URL(url);
  const param = `${CACHE_BUST_PARAM}=${time}`;
  u.search = u.search.length > 1 ? `${u.search}&${param}` : `?${param}`;
  return u.toString();
}

/**
 * Headers for one hop. Extra headers go only to the monitor URL's host, and not over plain
 * HTTP when the monitor URL is HTTPS.
 */
export function requestHeaders(monitorUrl: string, hopUrl: string, extra: [string, string][]): Headers {
  const headers = new Headers({ "User-Agent": USER_AGENT });
  const from = new URL(monitorUrl);
  const to = new URL(hopUrl);
  const sameSite = to.hostname === from.hostname && (to.protocol === "https:" || from.protocol === "http:");
  if (sameSite) for (const [name, value] of extra) headers.set(name, value);
  return headers;
}

/** Probes at most PROBE_CONCURRENCY requests at a time; results are in request order. */
export async function probeMany(requests: ProbeRequest[], budget?: Budget): Promise<ProbeResult[]> {
  const out = new Array<ProbeResult>(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const i = next++;
      out[i] = await probe(requests[i], budget);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, requests.length) }, worker));
  return out;
}

interface Body {
  text: string;
  truncated: boolean;
}

/** Reads at most MAX_BODY_BYTES of the body, then releases the connection. Never throws. */
async function readStart(res: Response): Promise<Body> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    // A body of exactly MAX_BODY_BYTES also counts as truncated; reading on to tell would cost time.
    truncated = size >= MAX_BODY_BYTES;
  } catch {
    // Keep whatever arrived before the stream failed or the timeout hit.
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, MAX_BODY_BYTES));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.length) break;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

/** Retry-After as delay-seconds or an HTTP date, capped; null when absent, invalid or not in the future. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
