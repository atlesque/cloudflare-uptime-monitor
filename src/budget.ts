// Outbound subrequest budget for one invocation.
//
// The Workers Free plan allows 50 external subrequests per invocation, and every
// redirect hop counts. Work that cannot fit is deferred rather than failed.

export const DEFAULT_EXTERNAL_LIMIT = 50;
/** Kept back from checks so notification delivery is never starved. */
export const NOTIFICATION_RESERVE = 5;

export class Budget {
  constructor(public remaining: number) {}

  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
}

export function externalLimit(env: Env): number {
  const n = Number(env.EXTERNAL_SUBREQUEST_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EXTERNAL_LIMIT;
}
