// Uptime and downtime metrics over a reporting window.
//
// Operational figures exclude time in "Maintenance without notifications"
// (from both observed time and downtime). Inclusive figures count everything.
// The window is clipped to the monitor's observation start; ongoing incidents
// and maintenance count through the end of the window.

export type Interval = [start: number, end: number];

export interface IncidentSpan {
  startedAt: number;
  endedAt: number | null;
}

export interface MaintenanceSpan {
  mode: "notify" | "silent";
  startedAt: number;
  endedAt: number | null;
}

export interface Metrics {
  observedMs: number;
  outages: number;
  outagesInclusive: number;
  downtimeMs: number;
  downtimeInclusiveMs: number;
  /** null when nothing was observed operationally in the window */
  uptimePct: number | null;
  uptimeInclusivePct: number | null;
}

export interface WindowArgs {
  from: number;
  to: number;
  observedSince: number;
  incidents: IncidentSpan[];
  maintenance: MaintenanceSpan[];
}

/** Raw observed time and downtime in a window; `operationalMs` is observed time outside silent maintenance. */
export interface Measurement {
  observedMs: number;
  operationalMs: number;
  outages: number;
  outagesInclusive: number;
  downtimeMs: number;
  downtimeInclusiveMs: number;
}

export function measureWindow(args: WindowArgs): Measurement {
  const start = Math.max(args.from, args.observedSince);
  const end = args.to;
  if (end <= start) {
    return { observedMs: 0, operationalMs: 0, outages: 0, outagesInclusive: 0, downtimeMs: 0, downtimeInclusiveMs: 0 };
  }

  const silent = union(
    args.maintenance
      .filter((m) => m.mode === "silent")
      .map((m) => clip([m.startedAt, m.endedAt ?? end], start, end))
      .filter(isInterval),
  );
  const incidents = args.incidents.map((i) => clip([i.startedAt, i.endedAt ?? end], start, end)).filter(isInterval);
  const down = union(incidents);
  const downInclusive = totalLength(down);

  return {
    observedMs: end - start,
    operationalMs: end - start - totalLength(silent),
    outages: incidents.filter((iv) => iv[1] - iv[0] - overlapLength([iv], silent) > 0).length,
    outagesInclusive: incidents.length,
    downtimeMs: downInclusive - overlapLength(down, silent),
    downtimeInclusiveMs: downInclusive,
  };
}

export function computeMetrics(args: WindowArgs): Metrics {
  const m = measureWindow(args);
  return {
    observedMs: m.observedMs,
    outages: m.outages,
    outagesInclusive: m.outagesInclusive,
    downtimeMs: m.downtimeMs,
    downtimeInclusiveMs: m.downtimeInclusiveMs,
    uptimePct: m.operationalMs > 0 ? (100 * (m.operationalMs - m.downtimeMs)) / m.operationalMs : null,
    uptimeInclusivePct: m.observedMs > 0 ? (100 * (m.observedMs - m.downtimeInclusiveMs)) / m.observedMs : null,
  };
}

/** How much of an incident fell inside each maintenance mode. */
export function maintenanceOverlap(incident: IncidentSpan, maintenance: MaintenanceSpan[], now: number) {
  const iv: Interval = [incident.startedAt, incident.endedAt ?? now];
  const spans = (mode: MaintenanceSpan["mode"]) =>
    union(maintenance.filter((m) => m.mode === mode).map((m): Interval => [m.startedAt, m.endedAt ?? now]));
  return {
    silentMs: overlapLength([iv], spans("silent")),
    notifyMs: overlapLength([iv], spans("notify")),
  };
}

function clip([s, e]: Interval, from: number, to: number): Interval | null {
  const start = Math.max(s, from);
  const end = Math.min(e, to);
  return end > start ? [start, end] : null;
}

function isInterval(iv: Interval | null): iv is Interval {
  return iv !== null;
}

function union(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function totalLength(intervals: Interval[]): number {
  return intervals.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** Overlap between two sets of intervals, each already disjoint. */
function overlapLength(a: Interval[], b: Interval[]): number {
  let sum = 0;
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      sum += Math.max(0, Math.min(ae, be) - Math.max(as, bs));
    }
  }
  return sum;
}
