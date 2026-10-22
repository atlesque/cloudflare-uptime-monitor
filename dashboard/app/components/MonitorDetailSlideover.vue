<script setup lang="ts">
import type { FailedCheck, FailureSummary, Monitor, MonitorDetail } from "~/types";

const props = defineProps<{ monitorId: number | null; checking: boolean; defaultInterval: number | null }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ edit: [monitor: Monitor]; check: [monitor: Monitor] }>();

const detail = ref<MonitorDetail | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const now = useTicker();

async function load() {
  if (props.monitorId == null) return;
  loading.value = true;
  error.value = null;
  try {
    detail.value = await api<MonitorDetail>(`/api/monitors/${props.monitorId}`);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [open.value, props.monitorId] as const,
  ([isOpen, id], previous) => {
    if (!isOpen) return;
    if (previous && id !== previous[1]) {
      detail.value = null;
      expandedFailure.value = null;
      openDays.value = new Set();
      failureCache.clear();
    }
    load();
  },
  { immediate: true },
);

defineExpose({ reload: load });

/** Incidents of the hour being read in the 24-hour strip. */
const highlightedIncidents = ref<number[]>([]);

// Full responses of failed checks load on demand; they can be up to 16 KB each.
const expandedFailure = ref<number | null>(null);
const failureCache = reactive(new Map<number, FailedCheck>());
const failureError = ref<string | null>(null);
async function toggleFailure(id: number) {
  failureError.value = null;
  if (expandedFailure.value === id) {
    expandedFailure.value = null;
    return;
  }
  expandedFailure.value = id;
  if (failureCache.has(id) || props.monitorId == null) return;
  try {
    failureCache.set(id, await api<FailedCheck>(`/api/monitors/${props.monitorId}/failures/${id}`));
  } catch (err) {
    failureError.value = errorMessage(err);
  }
}

// Failed checks grouped per day (newest first), so a burst of failures takes one row.
// Days start collapsed; the summary line says what happened.
const failureDays = computed(() => {
  const days: { key: string; failures: FailureSummary[]; summary: string }[] = [];
  for (const failure of detail.value?.failures ?? []) {
    const key = formatDay(failure.checkedAt);
    const last = days.at(-1);
    if (last?.key === key) last.failures.push(failure);
    else days.push({ key, failures: [failure], summary: "" });
  }
  for (const day of days) {
    const counts = new Map<string, number>();
    for (const failure of day.failures) {
      const label = failure.blocked ? `Blocked by ${failure.source}` : (failure.error ?? "Failed");
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    day.summary = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `${count} ${label}`)
      .join(", ");
  }
  return days;
});
const openDays = ref(new Set<string>());
function toggleDay(key: string) {
  const next = new Set(openDays.value);
  if (!next.delete(key)) next.add(key);
  openDays.value = next;
}

function maintenanceText(silentMs: number, notifyMs: number) {
  const parts = [];
  if (silentMs > 0) parts.push(`Silent ${formatDuration(silentMs)}`);
  if (notifyMs > 0) parts.push(`With notifications ${formatDuration(notifyMs)}`);
  return parts.join(", ");
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'max-w-2xl' }">
    <template #title>
      <span v-if="detail" class="flex flex-wrap items-center gap-2">
        {{ detail.name }}
        <MonitorStateBadges :monitor="detail" size="sm" />
      </span>
      <USkeleton v-else class="h-5 w-40" />
    </template>
    <template #description>
      <a
        v-if="detail"
        :href="detail.url"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 break-all hover:underline"
      >
        {{ detail.url }}
        <UIcon name="i-lucide-arrow-up-right" class="size-3.5 shrink-0" />
      </a>
      <USkeleton v-else class="mt-1 h-3.5 w-56" />
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" />

      <div v-else-if="!detail" class="space-y-6" aria-busy="true" aria-label="Loading monitor">
        <div class="flex gap-2">
          <USkeleton class="h-8 w-28 rounded-md" />
          <USkeleton class="h-8 w-20 rounded-md" />
        </div>
        <div class="space-y-2">
          <USkeleton class="h-4 w-24" />
          <USkeleton class="h-28 w-full rounded-lg" />
        </div>
        <div class="space-y-2">
          <USkeleton class="h-4 w-24" />
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div v-for="i in 3" :key="i" class="space-y-2 rounded-lg border border-default p-3">
              <USkeleton class="h-3 w-14" />
              <USkeleton class="h-6 w-20" />
            </div>
          </div>
        </div>
        <div class="space-y-3">
          <USkeleton class="h-4 w-16" />
          <div v-for="i in 5" :key="i" class="flex gap-6">
            <USkeleton class="h-4 w-24" />
            <USkeleton class="h-4 w-40" />
          </div>
        </div>
        <div class="space-y-3">
          <USkeleton class="h-4 w-20" />
          <USkeleton v-for="i in 2" :key="i" class="h-20 w-full rounded-lg" />
        </div>
      </div>

      <div v-else class="space-y-6">
        <div class="flex gap-2">
          <UButton
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            label="Check now"
            :loading="checking"
            @click="emit('check', detail)"
          />
          <UButton icon="i-lucide-pencil" color="neutral" variant="outline" label="Edit" @click="emit('edit', detail)" />
        </div>

        <HourlyUptime v-model:highlighted="highlightedIncidents" :hours="detail.last24h" :incidents="detail.incidents" />

        <section>
          <h3 class="mb-2 text-sm font-medium text-muted">Last 30 days</h3>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div class="rounded-lg border border-default p-3">
              <div class="text-xs text-muted">Uptime</div>
              <MetricPair
                class="text-lg whitespace-nowrap"
                :value="formatUptime(detail.metrics30d.uptimePct)"
                :inclusive="formatUptime(detail.metrics30d.uptimeInclusivePct)"
                :value-class="['font-semibold', uptimeColor(detail.metrics30d.uptimePct)].join(' ')"
              />
            </div>
            <div class="rounded-lg border border-default p-3">
              <div class="text-xs text-muted">Downtime</div>
              <MetricPair
                class="text-lg whitespace-nowrap"
                value-class="font-semibold text-highlighted"
                :value="formatDowntime(detail.metrics30d.downtimeMs)"
                :inclusive="formatDowntime(detail.metrics30d.downtimeInclusiveMs)"
              />
            </div>
            <div class="rounded-lg border border-default p-3">
              <div class="text-xs text-muted">Outages</div>
              <MetricPair
                class="text-lg whitespace-nowrap"
                value-class="font-semibold text-highlighted"
                :value="String(detail.metrics30d.outages)"
                :inclusive="String(detail.metrics30d.outagesInclusive)"
              />
            </div>
          </div>
          <p class="mt-2 text-xs text-muted">Values in parentheses include time in maintenance without notifications.</p>
        </section>

        <section>
          <h3 class="mb-2 text-sm font-medium text-muted">Details</h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt class="text-muted">Group</dt>
            <dd>{{ detail.group ?? "—" }}</dd>
            <dt class="text-muted">Checked</dt>
            <dd>
              <template v-if="detail.checkIntervalMinutes != null">{{ formatInterval(detail.checkIntervalMinutes) }}</template>
              <template v-else-if="defaultInterval">{{ formatInterval(defaultInterval) }} <span class="text-muted">(default)</span></template>
              <template v-else>Default interval</template>
            </dd>
            <dt class="text-muted">Timeout</dt>
            <dd>{{ detail.timeoutMs / 1000 }} s</dd>
            <dt class="text-muted">Observed since</dt>
            <dd>{{ formatFullTime(detail.observedSince) }}</dd>
            <dt class="text-muted">Last check</dt>
            <dd v-if="detail.lastCheck">
              {{ ago(detail.lastCheck.at, now) }}
              <span :class="detail.lastCheck.error ? 'text-error' : 'text-muted'">
                · {{ detail.lastCheck.error ?? `HTTP ${detail.lastCheck.status}` }}
              </span>
              <span v-if="detail.lastCheck.durationMs != null" class="text-muted"> · {{ detail.lastCheck.durationMs }} ms</span>
            </dd>
            <dd v-else class="text-muted">Not checked yet</dd>
            <template v-if="detail.nextCheckAfter">
              <dt class="text-muted">Next check</dt>
              <dd>
                Not before {{ formatTime(detail.nextCheckAfter) }}
                <span class="text-muted">· the site asked to wait (Retry-After)</span>
              </dd>
            </template>
          </dl>
        </section>

        <section>
          <h3 class="mb-2 text-sm font-medium text-muted">Failed checks</h3>
          <div v-if="detail.failures.length === 0" class="rounded-lg border border-dashed border-default p-4 text-sm text-muted">
            No failed checks recorded. The response of each failed check is kept here (the last 20).
          </div>
          <ul v-else class="divide-y divide-default rounded-lg border border-default">
            <li v-for="day in failureDays" :key="day.key">
              <button
                type="button"
                class="flex w-full items-start gap-2 px-3 py-2 text-start text-sm hover:bg-elevated/50"
                :aria-expanded="openDays.has(day.key)"
                @click="toggleDay(day.key)"
              >
                <UIcon
                  name="i-lucide-chevron-right"
                  class="mt-0.5 size-4 shrink-0 text-muted transition-transform"
                  :class="openDays.has(day.key) && 'rotate-90'"
                />
                <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span class="font-medium text-highlighted">{{ day.key }}</span>
                  <span class="text-error">{{ day.failures.length }} failed</span>
                  <span class="text-xs text-muted">{{ day.summary }}</span>
                </span>
              </button>
              <ul v-if="openDays.has(day.key)" class="divide-y divide-default border-t border-default bg-elevated/25">
                <li v-for="failure in day.failures" :key="failure.id">
                  <button
                    type="button"
                    class="flex w-full flex-wrap items-center gap-2 py-2 ps-9 pe-3 text-start text-sm hover:bg-elevated/50"
                    :aria-expanded="expandedFailure === failure.id"
                    @click="toggleFailure(failure.id)"
                  >
                    <UIcon
                      name="i-lucide-chevron-right"
                      class="size-4 shrink-0 text-muted transition-transform"
                      :class="expandedFailure === failure.id && 'rotate-90'"
                    />
                    <span class="font-mono text-xs text-highlighted tabular-nums">{{ formatClockSeconds(failure.checkedAt) }}</span>
                    <span class="font-mono text-xs text-error">{{ failure.error }}</span>
                    <UBadge v-if="failure.blocked" color="warning" variant="subtle" size="sm">Blocked by {{ failure.source }}</UBadge>
                    <UBadge v-else-if="failure.source" color="neutral" variant="soft" size="sm">{{ failure.source }}</UBadge>
                  </button>
                  <div v-if="expandedFailure === failure.id" class="border-t border-default bg-default p-3">
                    <UAlert v-if="failureError" color="error" variant="subtle" :description="failureError" />
                    <ResponseDiagnostics
                      v-else-if="failureCache.get(failure.id)"
                      :diagnostics="failureCache.get(failure.id)!.diagnostics"
                      :diagnosis="failureCache.get(failure.id)!.diagnosis"
                    />
                    <USkeleton v-else class="h-24 w-full" />
                  </div>
                </li>
              </ul>
            </li>
          </ul>
        </section>

        <section>
          <h3 class="mb-2 text-sm font-medium text-muted">Incidents</h3>
          <div v-if="detail.incidents.length === 0" class="flex items-center gap-2 rounded-lg border border-dashed border-default p-4 text-sm text-muted">
            <UIcon name="i-lucide-circle-check" class="size-5 text-success" />
            No incidents in the last 30 days.
          </div>
          <ol v-else class="relative space-y-3 border-s border-default ps-5">
            <li v-for="incident in detail.incidents" :key="incident.id" class="relative">
              <span
                class="absolute -start-[1.6rem] top-1.5 size-2.5 rounded-full ring-4 ring-(--ui-bg)"
                :class="incident.ongoing ? 'bg-error animate-pulse' : 'bg-neutral-400'"
              />
              <div
                class="rounded-lg border p-3 text-sm transition-colors"
                :class="highlightedIncidents.includes(incident.id) ? 'border-error/50 bg-error/5' : 'border-default'"
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-medium text-highlighted">{{ formatFullTime(incident.startedAt) }}</span>
                  <UBadge v-if="incident.ongoing" color="error" variant="subtle" size="sm">Ongoing · {{ formatDuration(incident.durationMs) }}</UBadge>
                  <UBadge v-else color="neutral" variant="soft" size="sm">{{ formatDuration(incident.durationMs) }}</UBadge>
                </div>
                <div v-if="!incident.ongoing" class="mt-0.5 text-xs text-muted">Recovered {{ formatFullTime(incident.endedAt) }}</div>
                <div v-if="incident.failureReason" class="mt-2 font-mono text-xs break-all text-error">{{ incident.failureReason }}</div>
                <div v-if="incident.silentMaintenanceMs || incident.notifyMaintenanceMs" class="mt-2 flex items-center gap-1 text-xs text-muted">
                  <UIcon name="i-lucide-wrench" class="size-3.5" />
                  During maintenance: {{ maintenanceText(incident.silentMaintenanceMs, incident.notifyMaintenanceMs) }}
                </div>
              </div>
            </li>
          </ol>
        </section>
      </div>
    </template>
  </USlideover>
</template>
