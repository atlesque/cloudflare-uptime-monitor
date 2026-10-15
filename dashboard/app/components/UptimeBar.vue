<script setup lang="ts">
import type { DayUptime, Monitor } from "~/types";

const props = defineProps<{ days: DayUptime[] | null; monitors: Monitor[]; loading?: boolean }>();

/** A day is "major" when one monitor was down for at least this long. */
const MAJOR_MS = 60 * 60_000;
const MAX_LISTED = 5;

// Phones get the last 30 days, so each bar stays wide enough to see and tap.
const narrow = ref(false);
let query: MediaQueryList | undefined;
const onQuery = () => (narrow.value = !!query?.matches);
onMounted(() => {
  query = window.matchMedia("(max-width: 639px)");
  onQuery();
  query.addEventListener("change", onQuery);
});
onBeforeUnmount(() => query?.removeEventListener("change", onQuery));

const shown = computed(() => {
  const days = props.days ?? [];
  return narrow.value ? days.slice(-30) : days;
});

type Level = "none" | "ok" | "minor" | "major";
function level(day: DayUptime): Level {
  if (day.observedMs === 0) return "none";
  if (day.downtimeMs === 0) return "ok";
  return day.down[0]!.downtimeMs >= MAJOR_MS ? "major" : "minor";
}
/** [resting, hovered or selected] */
const BAR_CLASSES: Record<Level, [string, string]> = {
  none: ["bg-accented", "bg-inverted/30"],
  ok: ["bg-success/60", "bg-success"],
  minor: ["bg-warning/80", "bg-warning"],
  major: ["bg-error/80", "bg-error"],
};

const dayUptime = (day: DayUptime) =>
  day.observedMs > 0 ? (100 * (day.observedMs - day.downtimeMs)) / day.observedMs : null;

const rangeUptime = computed(() => {
  const observed = shown.value.reduce((sum, d) => sum + d.observedMs, 0);
  const down = shown.value.reduce((sum, d) => sum + d.downtimeMs, 0);
  return observed > 0 ? (100 * (observed - down)) / observed : null;
});

const current = computed(() => {
  const down = props.monitors.filter((m) => m.state === "down").length;
  if (down > 0) return { label: `${plural(down, "monitor")} down`, icon: "i-lucide-circle-x", color: "text-error" };
  if (!props.monitors.length) return { label: "No monitors yet", icon: "i-lucide-circle-dashed", color: "text-muted" };
  if (props.monitors.every((m) => m.state === "pending"))
    return { label: "Waiting for the first checks", icon: "i-lucide-circle-dashed", color: "text-muted" };
  return { label: "All monitors up", icon: "i-lucide-circle-check", color: "text-success" };
});

// ---- day details: on hover, tap, or arrow keys ----

const active = ref<number | null>(null);
const activeDay = computed(() => (active.value == null ? null : (shown.value[active.value] ?? null)));
const panelSide = computed(() => {
  if (active.value == null) return "";
  const at = active.value / Math.max(1, shown.value.length - 1);
  return at < 0.33 ? "left-0" : at > 0.67 ? "right-0" : "left-1/2 -translate-x-1/2";
});

function onKey(event: KeyboardEvent) {
  const last = shown.value.length - 1;
  const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
  if (!(event.key in step) || last < 0) return;
  event.preventDefault();
  active.value = Math.min(last, Math.max(0, (active.value ?? last + 1) + step[event.key]!));
}
</script>

<template>
  <section class="rounded-lg border border-default bg-default p-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-medium text-highlighted">Uptime</h2>
      <USkeleton v-if="loading" class="size-6 rounded-full" />
      <UTooltip v-else :text="current.label">
        <UIcon :name="current.icon" class="size-6" :class="current.color" />
      </UTooltip>
    </div>

    <div v-if="loading || !days" class="mt-3 space-y-3" aria-hidden="true">
      <USkeleton class="h-9 w-full" />
      <div class="flex items-center justify-between gap-4">
        <USkeleton class="h-3 w-20" />
        <USkeleton class="h-3 w-24" />
        <USkeleton class="h-3 w-12" />
      </div>
      <USkeleton class="h-3 w-28" />
    </div>

    <template v-else>
      <div class="relative mt-3" @mouseleave="active = null">
        <div
          class="flex h-9 gap-px rounded outline-offset-4 focus-visible:outline-2 focus-visible:outline-primary sm:gap-0.5"
          tabindex="0"
          role="group"
          :aria-label="`Daily uptime for the last ${shown.length} days. Use the arrow keys to read each day.`"
          @keydown="onKey"
          @blur="active = null"
        >
          <button
            v-for="(day, i) in shown"
            :key="day.start"
            type="button"
            tabindex="-1"
            class="h-full min-w-0 flex-1 rounded-[2px] transition-colors"
            :class="BAR_CLASSES[level(day)][active === i ? 1 : 0]"
            :aria-label="formatDay(day.start)"
            @mouseenter="active = i"
            @focus="active = i"
            @click="active = i"
          />
        </div>

        <div
          v-if="activeDay"
          class="pointer-events-none absolute top-full z-10 mt-2 w-64 rounded-md border border-default bg-default p-3 text-sm shadow-lg"
          :class="panelSide"
          aria-live="polite"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium text-highlighted">{{ formatDay(activeDay.start) }}</span>
            <span class="tabular-nums" :class="uptimeColor(dayUptime(activeDay))">{{ formatUptime(dayUptime(activeDay)) }}</span>
          </div>
          <p v-if="activeDay.observedMs === 0" class="mt-1 text-muted">No data</p>
          <p v-else-if="activeDay.downtimeMs === 0" class="mt-1 text-muted">No downtime recorded</p>
          <template v-else>
            <p class="mt-1 text-muted">
              {{ plural(activeDay.outages, "outage") }}, {{ formatDowntime(activeDay.downtimeMs) }} down in total
            </p>
            <ul class="mt-2 space-y-1">
              <li v-for="m in activeDay.down.slice(0, MAX_LISTED)" :key="m.id" class="flex justify-between gap-3">
                <span class="truncate">{{ m.name }}</span>
                <span class="shrink-0 tabular-nums text-muted">{{ formatDowntime(m.downtimeMs) }}</span>
              </li>
              <li v-if="activeDay.down.length > MAX_LISTED" class="text-muted">
                and {{ plural(activeDay.down.length - MAX_LISTED, "more monitor") }}
              </li>
            </ul>
          </template>
        </div>
      </div>

      <div class="mt-2 flex items-center gap-3 text-sm text-muted">
        <span class="shrink-0">{{ shown.length }} days ago</span>
        <span class="h-px flex-1 bg-(--ui-border-accented)" />
        <span class="shrink-0 tabular-nums">{{ formatUptime(rangeUptime) }} uptime</span>
        <span class="h-px flex-1 bg-(--ui-border-accented)" />
        <span class="shrink-0">Today</span>
      </div>
      <p class="mt-2 text-sm" :class="current.color">{{ current.label }}</p>
    </template>
  </section>
</template>
