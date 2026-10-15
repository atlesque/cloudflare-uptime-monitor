import type { MaintenanceMode, MonitorState } from "~/types";

export const STATE_LABELS: Record<MonitorState, string> = { up: "Up", down: "Down", pending: "Pending" };
export const STATE_COLORS = { up: "success", down: "error", pending: "neutral" } as const;

export const MAINTENANCE_LABELS: Record<Exclude<MaintenanceMode, "none">, string> = {
  notify: "Maintenance",
  silent: "Silent maintenance",
};
export const MAINTENANCE_DESCRIPTIONS: Record<Exclude<MaintenanceMode, "none">, string> = {
  notify: "Maintenance with notifications: checks and alerts continue",
  silent: "Maintenance without notifications: checks continue, alerts are suppressed",
};
