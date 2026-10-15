<script setup lang="ts">
import type { CheckResult, Monitor } from "~/types";

defineProps<{ monitor: Monitor | null; result: CheckResult | null }>();
const open = defineModel<boolean>("open", { required: true });
</script>

<template>
  <UModal
    v-model:open="open"
    :title="`Check now: ${monitor?.name ?? ''}`"
    description="Diagnostic only. This result does not change the monitor's state, incidents, uptime or notifications."
  >
    <template #body>
      <div v-if="monitor && result" class="space-y-4">
        <div
          class="flex items-center gap-3 rounded-lg p-4"
          :class="result.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'"
        >
          <UIcon :name="result.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" class="size-8 shrink-0" />
          <div>
            <div class="text-lg font-semibold">{{ result.ok ? "Healthy" : "Failing" }}</div>
            <div class="text-sm opacity-80">
              {{ result.error ?? (result.status == null ? "No response" : `HTTP ${result.status}`) }}
            </div>
          </div>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt class="text-muted">URL</dt>
          <dd class="truncate">{{ monitor.url }}</dd>
          <dt class="text-muted">Status</dt>
          <dd>{{ result.status == null ? "—" : `HTTP ${result.status}` }}</dd>
          <dt class="text-muted">Response time</dt>
          <dd class="tabular-nums">{{ result.durationMs }} ms</dd>
          <dt class="text-muted">Checked at</dt>
          <dd>{{ formatFullTime(result.checkedAt) }}</dd>
        </dl>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton color="neutral" variant="outline" label="Close" @click="open = false" />
      </div>
    </template>
  </UModal>
</template>
