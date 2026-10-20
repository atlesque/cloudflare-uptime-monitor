// Runs checks from one region.
//
// Cron-triggered Workers run on whichever Cloudflare machine has spare capacity, anywhere in
// the world, and Placement doesn't apply to them. Checks would then leave from IPs all over the
// world, some of which a site's WAF blocks on reputation or geography. A Durable Object stays
// where it was created, so checks it makes leave from that region. CHECK_LOCATION is the
// object's location hint, such as "weur". Empty runs checks in the Worker itself.

import { DurableObject } from "cloudflare:workers";
import { Budget } from "./budget";
import { probeMany, type ProbeRequest, type ProbeResult } from "./probe";

const LOCATION_HINTS = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"]);

export class Prober extends DurableObject<Env> {
  /** `budget` is the subrequest budget left, or null for none. */
  async probeAll(requests: ProbeRequest[], budget: number | null) {
    const b = budget === null ? undefined : new Budget(budget);
    const results = await probeMany(requests, b);
    return { results, remaining: b?.remaining ?? null };
  }
}

/** The Prober for CHECK_LOCATION, or null to probe from the Worker. */
export function proberStub(env: Env): DurableObjectStub<Prober> | null {
  const location = (env.CHECK_LOCATION ?? "").trim().toLowerCase();
  if (!location || !env.PROBER) return null;
  // One object per location: a location hint only applies when an object is first created.
  if (LOCATION_HINTS.has(location)) {
    const id = env.PROBER.idFromName(`checks-${location}`);
    return env.PROBER.get(id, { locationHint: location as DurableObjectLocationHint });
  }
  console.warn(`Unknown CHECK_LOCATION "${location}"; checks run from the Worker`);
  return null;
}

/**
 * Probes from CHECK_LOCATION's Prober. If that fails, probes from the Worker instead: a check
 * from elsewhere beats no check, since a missed run would also mean missed alerts.
 */
export async function runProbes(env: Env, requests: ProbeRequest[], budget?: Budget): Promise<ProbeResult[]> {
  const stub = proberStub(env);
  if (stub && requests.length > 0) {
    try {
      const { results, remaining } = await stub.probeAll(requests, budget ? budget.remaining : null);
      if (budget && remaining !== null) budget.remaining = remaining;
      // RPC types widen tuples to arrays; the values are the ProbeResults the Prober returned.
      return results as ProbeResult[];
    } catch (err) {
      console.error("Probing from CHECK_LOCATION failed; probing from the Worker instead:", err);
    }
  }
  return probeMany(requests, budget);
}
