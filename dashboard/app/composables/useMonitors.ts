import type { DayUptime, Me, Monitor, Settings } from "~/types";

const REFRESH_MS = 30_000;

/** Shared monitor list, refreshed every 30 seconds. */
export function useMonitors() {
  const monitors = useState<Monitor[]>("monitors", () => []);
  const loaded = useState("monitors-loaded", () => false);
  const updatedAt = useState<number | null>("monitors-updated", () => null);
  const refreshError = useState<string | null>("monitors-error", () => null);

  async function refresh() {
    try {
      const data = await api<{ monitors: Monitor[] }>("/api/monitors");
      monitors.value = data.monitors;
      updatedAt.value = Date.now();
      refreshError.value = null;
    } catch (err) {
      refreshError.value = errorMessage(err);
    } finally {
      loaded.value = true;
    }
  }

  const groups = computed(() =>
    [...new Set(monitors.value.map((m) => m.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)),
  );

  return { monitors, loaded, updatedAt, refreshError, refresh, groups };
}

/** Daily uptime across all monitors for the last 90 days, for the overview bar. */
export function useUptime() {
  const days = useState<DayUptime[] | null>("uptime", () => null);
  const loaded = useState("uptime-loaded", () => false);
  async function load() {
    try {
      days.value = (await api<{ days: DayUptime[] }>("/api/uptime")).days;
    } catch {
      // Keep the last good bar; the monitor list reports refresh errors.
    } finally {
      loaded.value = true;
    }
  }
  return { days, loaded, load };
}

/** Starts the auto refresh. `paused` skips ticks, e.g. while a dialog is open. */
export function useAutoRefresh(refresh: () => Promise<void>, paused: () => boolean) {
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    timer = setInterval(() => {
      if (!paused()) refresh();
    }, REFRESH_MS);
  });
  onBeforeUnmount(() => clearInterval(timer));
}

export function useMe() {
  const me = useState<Me | null>("me", () => null);
  async function load() {
    try {
      me.value = await api<Me>("/api/me");
      setDisplayTimeZone(me.value.timeZone);
    } catch {
      me.value = null;
    }
  }
  return { me, load };
}

/** A clock that ticks every few seconds, for "x ago" labels. */
export function useTicker(intervalMs = 5_000) {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => (timer = setInterval(() => (now.value = Date.now()), intervalMs)));
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}

export function useSettings() {
  const settings = useState<Settings | null>("settings", () => null);
  const error = useState<string | null>("settings-error", () => null);
  async function load() {
    try {
      settings.value = await api<Settings>("/api/settings");
      error.value = null;
    } catch (err) {
      error.value = errorMessage(err);
    }
  }
  return { settings, error, load };
}
