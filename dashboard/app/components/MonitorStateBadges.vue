<script setup lang="ts">
import type { Monitor } from "~/types";

const props = defineProps<{ monitor: Monitor; size?: "sm" | "md" | "lg" }>();

const maintenance = computed(() => (props.monitor.maintenanceMode === "none" ? null : props.monitor.maintenanceMode));
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1.5">
    <UBadge
      :color="STATE_COLORS[monitor.state]"
      :variant="monitor.state === 'pending' ? 'outline' : 'subtle'"
      :size="size ?? 'md'"
      class="gap-1.5"
    >
      <span
        class="size-1.5 rounded-full"
        :class="{
          'bg-success': monitor.state === 'up',
          'bg-error animate-pulse': monitor.state === 'down',
          'bg-neutral-400': monitor.state === 'pending',
        }"
      />
      {{ STATE_LABELS[monitor.state] }}
    </UBadge>
    <UTooltip
      v-if="maintenance"
      :text="`${MAINTENANCE_DESCRIPTIONS[maintenance]}, since ${formatFullTime(monitor.maintenanceStartedAt)}`"
    >
      <UBadge
        :color="maintenance === 'silent' ? 'warning' : 'info'"
        variant="subtle"
        :size="size ?? 'md'"
        :icon="maintenance === 'silent' ? 'i-lucide-bell-off' : 'i-lucide-wrench'"
      >
        {{ MAINTENANCE_LABELS[maintenance] }}
      </UBadge>
    </UTooltip>
  </span>
</template>
