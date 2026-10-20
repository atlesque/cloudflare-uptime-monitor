// Daily uptime across all monitors, for the dashboard's overview bar,
// and hourly uptime of one monitor, for its detail panel.
//
// Days are local calendar days in the configured TIME_ZONE; today runs until now.
// Figures are operational: time in silent maintenance is left out, as in the 30-day metrics.

import { measureWindow, type MaintenanceSpan } from "./metrics";
import { loadHistory, toIncidentSpans, toMaintenanceSpans } from "./monitors";
import { addLocalDays, HOUR } from "./time";

export const UPTIME_DAYS = 90;

interface MonitorRow {
  id: number;
  name: string;
  observed_since: number;
}

export interface DayUptime {
  start: number;
  end: number;
  /** Operational time observed across all monitors; 0 when no monitor was observed that day. */
  observedMs: number;
  downtimeMs: number;
  outages: number;
  /** Monitors with operational downtime that day, most downtime first. */
  down: { id: number; name: string; downtimeMs: number; outages: number }[];
}

export async function getDailyUptime(env: Env, now = Date.now(), days = UPTIME_DAYS) {
  const starts = Array.from({ length: days }, (_, i) => addLocalDays(now, i - days + 1));
  const [{ results: monitors }, history] = await Promise.all([
    env.DB.prepare(`SELECT id, name, observed_since FROM monitors`).all<MonitorRow>(),
    loadHistory(env, starts[0]),
  ]);
  const spans = monitors.map((m) => {
    const h = history(m.id);
    return { monitor: m, incidents: toIncidentSpans(h.incidents), maintenance: toMaintenanceSpans(h.maintenance) };
  });

  const result: DayUptime[] = starts.map((start, i) => {
    const end = starts[i + 1] ?? now;
    const day: DayUptime = { start, end, observedMs: 0, downtimeMs: 0, outages: 0, down: [] };
    for (const { monitor, incidents, maintenance } of spans) {
      const m = measureWindow({ from: start, to: end, observedSince: monitor.observed_since, incidents, maintenance });
      day.observedMs += m.operationalMs;
      day.downtimeMs += m.downtimeMs;
      day.outages += m.outages;
      if (m.downtimeMs > 0) day.down.push({ id: monitor.id, name: monitor.name, downtimeMs: m.downtimeMs, outages: m.outages });
    }
    day.down.sort((a, b) => b.downtimeMs - a.downtimeMs || a.name.localeCompare(b.name));
    return day;
  });
  return { days: result, now };
}

export const UPTIME_HOURS = 24;

export interface HourUptime {
  start: number;
  end: number;
  /** Operational time observed in the hour; 0 before the monitor was observed. */
  observedMs: number;
  downtimeMs: number;
  /** Time in silent maintenance, which is left out of observedMs. */
  maintenanceMs: number;
  /** Incidents with operational downtime in this hour, so the dashboard can join hours of one outage. */
  incidentIds: number[];
}

/**
 * One monitor's uptime per clock hour over the last 24 hours; the last hour runs until now.
 * Hours are whole UTC hours, which are whole local hours in every zone with a whole-hour offset.
 */
export function hourlyUptime(
  args: {
    observedSince: number;
    incidents: { id: number; startedAt: number; endedAt: number | null }[];
    maintenance: MaintenanceSpan[];
  },
  now: number,
  hours = UPTIME_HOURS,
): HourUptime[] {
  const first = Math.floor(now / HOUR) * HOUR - (hours - 1) * HOUR;
  return Array.from({ length: hours }, (_, i) => {
    const start = first + i * HOUR;
    const end = Math.min(start + HOUR, now);
    const window = { from: start, to: end, observedSince: args.observedSince, maintenance: args.maintenance };
    const m = measureWindow({ ...window, incidents: args.incidents });
    const incidentIds = args.incidents
      .filter((incident) => measureWindow({ ...window, incidents: [incident] }).downtimeMs > 0)
      .map((incident) => incident.id)
      .sort((a, b) => a - b);
    return {
      start,
      end,
      observedMs: m.operationalMs,
      downtimeMs: m.downtimeMs,
      maintenanceMs: m.observedMs - m.operationalMs,
      incidentIds,
    };
  });
}
