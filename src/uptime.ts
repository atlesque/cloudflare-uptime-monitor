// Daily uptime across all monitors, for the dashboard's overview bar.
//
// Days are local calendar days in the configured TIME_ZONE; today runs until now.
// Figures are operational: time in silent maintenance is left out, as in the 30-day metrics.

import { measureWindow } from "./metrics";
import { loadHistory, toIncidentSpans, toMaintenanceSpans } from "./monitors";
import { addLocalDays } from "./time";

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
