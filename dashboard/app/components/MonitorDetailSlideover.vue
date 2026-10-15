<script setup lang="ts">
import type { Monitor, MonitorDetail } from "~/types";

const props = defineProps<{ monitorId: number | null; checking: boolean }>();
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
    if (previous && id !== previous[1]) detail.value = null;
    load();
  },
  { immediate: true },
);

defineExpose({ reload: load });

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
      <span v-else>Monitor</span>
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
      <span v-else class="sr-only">Monitor details</span>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" />

      <div v-else-if="!detail" class="space-y-4">
        <USkeleton class="h-24 w-full" />
        <USkeleton class="h-40 w-full" />
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
          </dl>
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
              <div class="rounded-lg border border-default p-3 text-sm">
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
