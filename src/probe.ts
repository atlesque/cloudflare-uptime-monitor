// A single HTTP check against a monitor URL.
//
// Redirects are followed manually so every hop can be re-validated against the
// public-target rules. The timeout covers the whole redirect chain.

import type { Budget } from "./budget";
import { disallowedHostReason } from "./url";

export const MAX_REDIRECTS = 5;
const USER_AGENT = "CloudflareUptimeMonitor/1.0 (+https://github.com/atlesque/cloudflare-uptime-monitor)";

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
  /** True when the check could not run within the invocation's subrequest budget. */
  skipped?: boolean;
}

export async function probe(url: string, timeoutMs: number, budget?: Budget): Promise<ProbeResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const done = (ok: boolean, status: number | null, error: string | null): ProbeResult => ({
    ok,
    status,
    error,
    durationMs: Date.now() - started,
  });

  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      if (budget && !budget.take()) {
        return { ...done(false, null, "Deferred: subrequest budget exhausted"), skipped: true };
      }
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "User-Agent": USER_AGENT },
      });
      // Only the status matters; release the connection immediately.
      await res.body?.cancel();

      const location = res.headers.get("Location");
      const isRedirect = res.status >= 300 && res.status < 400 && location !== null;
      if (!isRedirect) {
        const healthy = res.status >= 200 && res.status < 400;
        return done(healthy, res.status, healthy ? null : `HTTP ${res.status}`);
      }
      if (hop >= MAX_REDIRECTS) {
        return done(false, res.status, `Too many redirects (more than ${MAX_REDIRECTS})`);
      }
      const next = new URL(location, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return done(false, res.status, `Redirect to unsupported protocol ${next.protocol}`);
      }
      const blocked = disallowedHostReason(next.hostname);
      if (blocked) {
        return done(false, res.status, `Redirect to disallowed target: ${blocked}`);
      }
      current = next.toString();
    }
  } catch (err) {
    if (signal.aborted) return done(false, null, `Timeout after ${timeoutMs} ms`);
    return done(false, null, err instanceof Error ? err.message : String(err));
  }
}
