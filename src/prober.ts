// Runs checks from chosen regions.
//
// Cron-triggered Workers run on whichever Cloudflare machine has spare capacity, anywhere in
// the world, and Placement doesn't apply to them. Checks would then leave from IPs all over the
// world, some of which a site's WAF blocks on reputation or geography. A Durable Object stays
// where it was created, so checks it makes leave from that region.
//
// A monitor's check location is a Durable Object location hint such as "weur"; monitors without
// one use CHECK_LOCATION. There is exactly one object per location hint (named after it), so at
// most nine objects ever exist, and each run makes one call per location in use.

import { DurableObject } from "cloudflare:workers";
import { Budget } from "./budget";
import { probeMany, type ProbeRequest, type ProbeResult } from "./probe";

export const CHECK_LOCATIONS = ["weur", "eeur", "enam", "wnam", "sam", "apac", "oc", "afr", "me"] as const;
export type CheckLocation = (typeof CHECK_LOCATIONS)[number];

export const isCheckLocation = (v: string): v is CheckLocation => (CHECK_LOCATIONS as readonly string[]).includes(v);

export class Prober extends DurableObject<Env> {
  /** `budget` is the subrequest budget left, or null for none. */
  async probeAll(requests: ProbeRequest[], budget: number | null) {
    const b = budget === null ? undefined : new Budget(budget);
    const results = await probeMany(requests, b);
    return { results, remaining: b?.remaining ?? null };
  }
}

/** CHECK_LOCATION when it's a valid location hint, else null (checks run from the Worker). */
export function defaultLocation(env: Env): CheckLocation | null {
  const location = (env.CHECK_LOCATION ?? "").trim().toLowerCase();
  if (!location) return null;
  if (isCheckLocation(location)) return location;
  console.warn(`Unknown CHECK_LOCATION "${location}"; checks without a location run from the Worker`);
  return null;
}

/** The Prober for a location, or null to probe from the Worker. */
export function proberStub(env: Env, location: CheckLocation | null): DurableObjectStub<Prober> | null {
  if (!location || !env.PROBER) return null;
  // A location hint only applies when an object is first created, hence one name per location.
  return env.PROBER.get(env.PROBER.idFromName(`checks-${location}`), { locationHint: location });
}

export interface LocatedRequest extends ProbeRequest {
  /** The monitor's own location; null or absent uses CHECK_LOCATION. */
  location?: string | null;
}

/**
 * Probes each request from its location's Prober, one call per location, in turn so they share
 * the subrequest budget. If a Prober fails, its requests are probed from the Worker instead: a
 * check from elsewhere beats no check, since a missed run would also mean missed alerts.
 */
export async function runProbes(env: Env, requests: LocatedRequest[], budget?: Budget): Promise<ProbeResult[]> {
  const fallback = defaultLocation(env);
  const groups = new Map<CheckLocation | null, number[]>();
  requests.forEach((r, i) => {
    const location = r.location && isCheckLocation(r.location) ? r.location : fallback;
    groups.set(location, [...(groups.get(location) ?? []), i]);
  });

  const results = new Array<ProbeResult>(requests.length);
  for (const [location, indexes] of groups) {
    const batch = indexes.map((i): ProbeRequest => {
      const { url, timeoutMs, headers } = requests[i];
      return { url, timeoutMs, headers };
    });
    const out = await probeFrom(env, location, batch, budget);
    indexes.forEach((i, j) => (results[i] = out[j]));
  }
  return results;
}

async function probeFrom(env: Env, location: CheckLocation | null, requests: ProbeRequest[], budget?: Budget) {
  const stub = proberStub(env, location);
  if (stub) {
    try {
      const { results, remaining } = await stub.probeAll(requests, budget ? budget.remaining : null);
      if (budget && remaining !== null) budget.remaining = remaining;
      // RPC types widen tuples to arrays; the values are the ProbeResults the Prober returned.
      return results as ProbeResult[];
    } catch (err) {
      console.error(`Probing from ${location} failed; probing from the Worker instead:`, err);
    }
  }
  return probeMany(requests, budget);
}
