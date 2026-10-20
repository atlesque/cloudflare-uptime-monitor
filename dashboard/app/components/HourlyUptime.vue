<script setup lang="ts">
import type { HourUptime, Incident } from "~/types";

const props = defineProps<{ hours: HourUptime[]; incidents: Incident[] }>();
/** Incidents of the hour being read, so the incident list can highlight them. */
const highlighted = defineModel<number[]>("highlighted", { default: () => [] });

/** An hour is "major" when it had at least this much downtime. */
const MAJOR_MS = 15 * 60_000;

type Level = "none" | "ok" | "maintenance" | "minor" | "major";
function level(hour: HourUptime): Level {
  if (hour.downtimeMs >= MAJOR_MS) return "major";
  if (hour.downtimeMs > 0) return "minor";
  if (hour.maintenanceMs > 0) return "maintenance";
  return hour.observedMs > 0 ? "ok" : "none";
}
/** [resting, hovered or selected] */
const DOT_CLASSES: Record<Level, [string, string]> = {
  none: ["bg-accented", "bg-inverted/30"],
  ok: ["bg-success/60", "bg-success"],
  maintenance: ["bg-info/60", "bg-info"],
  minor: ["bg-warning", "bg-warning"],
  major: ["bg-error", "bg-error"],
};

/** Joins an hour to the next one when one outage runs across the boundary between them. */
function joinsNext(i: number) {
  const next = props.hours[i + 1];
  return !!next && props.hours[i]!.incidentIds.some((id) => next.incidentIds.includes(id));
}
function joinClass(i: number) {
  const both = [level(props.hours[i]!), level(props.hours[i + 1]!)];
  return both.includes("major") ? "bg-error" : "bg-warning";
}

const hourUptime = (hour: HourUptime) =>
  hour.observedMs > 0 ? (100 * (hour.observedMs - hour.downtimeMs)) / hour.observedMs : null;

const totals = computed(() => {
  const observed = props.hours.reduce((sum, h) => sum + h.observedMs, 0);
  const down = props.hours.reduce((sum, h) => sum + h.downtimeMs, 0);
  const outages = new Set(props.hours.flatMap((h) => h.incidentIds)).size;
  return { uptime: observed > 0 ? (100 * (observed - down)) / observed : null, down, outages };
});

/** Axis labels every 3 hours, and the weekday at local midnight. */
const isMidnight = (hour: HourUptime | undefined) => !!hour && formatClock(hour.start) === "00:00";
function axisLabel(hour: HourUptime, i: number) {
  if (isMidnight(hour)) return formatWeekday(hour.start);
  if (i % 3 || isMidnight(props.hours[i - 1]) || isMidnight(props.hours[i + 1])) return "";
  return formatClock(hour.start).slice(0, 2);
}

const incidentById = computed(() => new Map(props.incidents.map((i) => [i.id, i])));

// ---- hour details: on hover, tap, or arrow keys ----

const active = ref<number | null>(null);
const activeHour = computed(() => (active.value == null ? null : (props.hours[active.value] ?? null)));
const activeIncidents = computed(() =>
  (activeHour.value?.incidentIds ?? []).map((id) => incidentById.value.get(id)).filter((i) => i != null),
);
watch(activeHour, (hour) => (highlighted.value = hour?.incidentIds ?? []));
const panelSide = computed(() => {
  if (active.value == null) return "";
  const at = active.value / Math.max(1, props.hours.length - 1);
  return at < 0.33 ? "left-0" : at > 0.67 ? "right-0" : "left-1/2 -translate-x-1/2";
});

function onKey(event: KeyboardEvent) {
  const last = props.hours.length - 1;
  const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
  if (!(event.key in step) || last < 0) return;
  event.preventDefault();
  active.value = Math.min(last, Math.max(0, (active.value ?? last + 1) + step[event.key]!));
}
</script>

<template>
  <section>
    <div class="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
      <h3 class="text-sm font-medium text-muted">Last 24 hours</h3>
      <span class="text-sm text-muted tabular-nums">
        <template v-if="totals.outages">
          <span class="font-medium text-error">{{ plural(totals.outages, "outage") }}</span> · {{ formatDowntime(totals.down) }} down
        </template>
        <template v-else>No downtime</template>
      </span>
    </div>

    <div class="rounded-lg border border-default px-3.5 pt-4 pb-3">
      <div class="relative" @mouseleave="active = null">
        <div
          class="grid grid-cols-24 rounded py-1 outline-offset-4 focus-visible:outline-2 focus-visible:outline-primary"
          tabindex="0"
          role="group"
          aria-label="Uptime per hour for the last 24 hours. Use the arrow keys to read each hour."
          @keydown="onKey"
          @blur="active = null"
        >
          <button
            v-for="(hour, i) in hours"
            :key="hour.start"
            type="button"
            tabindex="-1"
            class="relative flex h-2.5 min-w-0 justify-center sm:h-3.5"
            :aria-label="`${formatDay(hour.start)}, ${formatClock(hour.start)}`"
            @mouseenter="active = i"
            @focus="active = i"
            @click="active = i"
          >
            <span v-if="joinsNext(i)" class="absolute inset-y-0 left-1/2 -right-1/2" :class="joinClass(i)" />
            <span
              class="relative size-2.5 rounded-full transition sm:size-3.5"
              :class="[
                DOT_CLASSES[level(hour)][active === i ? 1 : 0],
                active === i && 'scale-125',
                i === hours.length - 1 && 'ring-2 ring-offset-2 ring-(--ui-border-accented) ring-offset-(--ui-bg)',
              ]"
            />
          </button>
        </div>

        <div class="mt-2 grid grid-cols-24 text-xs text-dimmed tabular-nums" aria-hidden="true">
          <span v-for="(hour, i) in hours" :key="hour.start" class="text-center whitespace-nowrap">{{ axisLabel(hour, i) }}</span>
        </div>

        <div
          v-if="activeHour"
          class="pointer-events-none absolute top-full z-10 mt-2 w-64 rounded-md border border-default bg-default p-3 text-sm shadow-lg"
          :class="panelSide"
          aria-live="polite"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium text-highlighted">
              {{ formatWeekday(activeHour.start) }} {{ formatClock(activeHour.start) }}–{{
                activeHour.end < activeHour.start + 3_600_000 ? "now" : formatClock(activeHour.end)
              }}
            </span>
            <span class="tabular-nums" :class="uptimeColor(hourUptime(activeHour))">{{ formatUptime(hourUptime(activeHour)) }}</span>
          </div>
          <p v-if="activeHour.observedMs === 0 && !activeHour.maintenanceMs" class="mt-1 text-muted">Not observed yet</p>
          <p v-else-if="activeHour.downtimeMs === 0" class="mt-1 text-muted">
            No downtime<template v-if="activeHour.maintenanceMs">, {{ formatDuration(activeHour.maintenanceMs) }} in silent maintenance</template>
          </p>
          <template v-else>
            <p class="mt-1 text-muted">{{ formatDowntime(activeHour.downtimeMs) }} down in this hour</p>
            <ul class="mt-2 space-y-1.5">
              <li v-for="incident in activeIncidents" :key="incident.id">
                <div v-if="incident.failureReason" class="truncate font-mono text-xs text-error">{{ incident.failureReason }}</div>
                <div class="flex justify-between gap-3">
                  <span>
                    {{ incident.ongoing ? `Ongoing since ${formatClock(incident.startedAt)}` : `Outage ${formatClock(incident.startedAt)}–${formatClock(incident.endedAt!)}` }}
                  </span>
                  <span class="shrink-0 tabular-nums text-muted">{{ formatDuration(incident.durationMs) }}</span>
                </div>
              </li>
            </ul>
          </template>
        </div>
      </div>

      <div class="mt-3 flex items-center gap-3 text-sm text-muted">
        <span class="shrink-0">24 hours ago</span>
        <span class="h-px flex-1 bg-(--ui-border-accented)" />
        <span class="shrink-0 tabular-nums">{{ formatUptime(totals.uptime) }} uptime</span>
        <span class="h-px flex-1 bg-(--ui-border-accented)" />
        <span class="shrink-0">Now</span>
      </div>
      <div class="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted">
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-success/60" />Up</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-warning" />Down less than 15 min</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-error" />Down 15 min or more</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-info/60" />Maintenance</span>
      </div>
    </div>
  </section>
</template>
