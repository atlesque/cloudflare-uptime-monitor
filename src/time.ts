// Time-zone and duration helpers. All instants are epoch milliseconds.

const DEFAULT_TIME_ZONE = "UTC";
let TIME_ZONE = DEFAULT_TIME_ZONE;
let timestampFormat = makeTimestampFormat(TIME_ZONE);
let dateFormat = makeDateFormat(TIME_ZONE);

/** The IANA time zone used for the weekly report and for times in notifications. */
export function getTimeZone(): string {
  return TIME_ZONE;
}

/** Sets the display/reporting time zone (the TIME_ZONE variable). Invalid or empty values fall back to UTC. */
export function setTimeZone(tz: string | undefined): void {
  let next = tz?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: next });
  } catch {
    console.warn(`Invalid TIME_ZONE "${next}", falling back to ${DEFAULT_TIME_ZONE}`);
    next = DEFAULT_TIME_ZONE;
  }
  if (next === TIME_ZONE) return;
  TIME_ZONE = next;
  timestampFormat = makeTimestampFormat(next);
  dateFormat = makeDateFormat(next);
}
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday ... 6 = Sunday */
  weekday: number;
}

export function zonedParts(ms: number, tz = TIME_ZONE): ZonedParts {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` shows the given local date and hour. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, tz = TIME_ZONE): number {
  const naive = Date.UTC(year, month - 1, day, hour);
  let utc = naive - offsetAt(naive, tz);
  const corrected = naive - offsetAt(utc, tz);
  if (corrected !== utc) utc = corrected;
  return utc;
}

/** Monday 00:00 local time of the week containing `ms`. */
export function weekStartContaining(ms: number, tz = TIME_ZONE): number {
  const p = zonedParts(ms, tz);
  return localDayAt(Date.UTC(p.year, p.month - 1, p.day - p.weekday), 0, tz);
}

/** `days` local calendar days after the local date of `ms`, at `hour` local time. */
export function addLocalDays(ms: number, days: number, hour = 0, tz = TIME_ZONE): number {
  const p = zonedParts(ms, tz);
  return localDayAt(Date.UTC(p.year, p.month - 1, p.day + days), hour, tz);
}

function localDayAt(utcMidnightOfDate: number, hour: number, tz: string): number {
  const d = new Date(utcMidnightOfDate);
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, tz);
}

function makeTimestampFormat(timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

/** e.g. "Sat, 3 Oct 2026, 21:45:17 CEST" */
export function formatTimestamp(ms: number): string {
  return timestampFormat.format(new Date(ms));
}

function makeDateFormat(timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** e.g. "Monday, 28 September 2026" */
export function formatDate(ms: number): string {
  return dateFormat.format(new Date(ms));
}

/** Compact human duration: "45s", "12m", "1h 05m", "2d 3h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
