// Formatting helpers. Times are shown in the deployment's TIME_ZONE (from /api/me).

const timeZone = ref<string | undefined>();

export function setDisplayTimeZone(zone: string | undefined) {
  timeZone.value = zone;
}

const shortFormat = computed(
  () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone.value,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
);
const fullFormat = computed(
  () => new Intl.DateTimeFormat("en-GB", { timeZone: timeZone.value, dateStyle: "medium", timeStyle: "long" }),
);

const dayFormat = computed(
  () => new Intl.DateTimeFormat("en-GB", { timeZone: timeZone.value, weekday: "short", day: "numeric", month: "short", year: "numeric" }),
);

const clockFormat = computed(
  () => new Intl.DateTimeFormat("en-GB", { timeZone: timeZone.value, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
);
const weekdayFormat = computed(() => new Intl.DateTimeFormat("en-GB", { timeZone: timeZone.value, weekday: "short" }));

export const formatTime = (ms: number | null | undefined) => (ms == null ? "—" : shortFormat.value.format(new Date(ms)));
export const formatFullTime = (ms: number | null | undefined) =>
  ms == null ? "—" : fullFormat.value.format(new Date(ms));

/** e.g. "Tue, 29 Sept 2026" */
export const formatDay = (ms: number) => dayFormat.value.format(new Date(ms));

/** e.g. "09:38" */
export const formatClock = (ms: number) => clockFormat.value.format(new Date(ms));

/** e.g. "Tue" */
export const formatWeekday = (ms: number) => weekdayFormat.value.format(new Date(ms));

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const formatDowntime = (ms: number) => (ms === 0 ? "0m" : formatDuration(ms));

export function ago(ms: number | null | undefined, now = Date.now()) {
  if (ms == null) return "never";
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return "just now";
  return `${formatDuration(s * 1000)} ago`;
}

export function formatUptime(pct: number | null) {
  if (pct == null) return "—";
  if (pct >= 100) return "100%";
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

export function uptimeColor(pct: number | null) {
  if (pct == null) return "text-muted";
  if (pct >= 99.9) return "text-success";
  if (pct >= 99) return "text-warning";
  return "text-error";
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const formatInterval = (minutes: number) => (minutes === 1 ? "every minute" : `every ${minutes} minutes`);
