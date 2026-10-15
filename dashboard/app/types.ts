// Shapes returned by the Worker API (src/monitors.ts, src/index.ts).

export type MonitorState = "up" | "down" | "pending";
export type MaintenanceMode = "none" | "notify" | "silent";

export interface Metrics {
  observedMs: number;
  outages: number;
  outagesInclusive: number;
  downtimeMs: number;
  downtimeInclusiveMs: number;
  uptimePct: number | null;
  uptimeInclusivePct: number | null;
}

export interface LastCheck {
  at: number;
  status: number | null;
  error: string | null;
  durationMs: number | null;
}

export interface Monitor {
  id: number;
  name: string;
  url: string;
  group: string | null;
  timeoutMs: number;
  /** null follows the default interval from the settings. */
  checkIntervalMinutes: number | null;
  createdAt: number;
  observedSince: number;
  state: MonitorState;
  maintenanceMode: MaintenanceMode;
  maintenanceStartedAt: number | null;
  currentOutageStartedAt: number | null;
  lastCheck: LastCheck | null;
  metrics30d: Metrics;
}

export interface Incident {
  id: number;
  startedAt: number;
  endedAt: number | null;
  ongoing: boolean;
  durationMs: number;
  failureReason: string | null;
  silentMaintenanceMs: number;
  notifyMaintenanceMs: number;
}

export interface MonitorDetail extends Monitor {
  incidents: Incident[];
}

export interface CheckResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
  checkedAt: number;
}

export interface Me {
  timeZone: string;
  notifications: { email: boolean; ntfy: boolean };
}

export interface BulkResult {
  action: string;
  selected: number;
  changed: number;
}

export type BulkAction = "maintenance-notify" | "maintenance-silent" | "end-maintenance" | "delete";

export interface ConfirmOptions {
  title: string;
  intro: string;
  monitors: Monitor[];
  note?: string;
  okLabel: string;
  danger?: boolean;
  run: () => Promise<void>;
}

export interface Settings {
  ntfy: {
    source: "dashboard" | "secrets";
    enabled: boolean;
    url: string | null;
    topic: string | null;
    tokenSet: boolean;
    secrets: { url: boolean; topic: boolean; token: boolean };
  };
  checks: { defaultIntervalMinutes: number; intervals: number[] };
}

export interface Group {
  name: string;
  monitors: number;
}
