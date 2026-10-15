<script setup lang="ts">
import type { Monitor } from "~/types";

const props = defineProps<{ monitors: Monitor[]; loading?: boolean }>();
const status = defineModel<string>("status", { required: true });

const cards = computed(() => {
  const count = (pred: (m: Monitor) => boolean) => props.monitors.filter(pred).length;
  return [
    { key: "down", label: "Down", icon: "i-lucide-circle-x", color: "text-error", ring: "ring-error/40", value: count((m) => m.state === "down") },
    { key: "up", label: "Up", icon: "i-lucide-circle-check", color: "text-success", ring: "ring-success/40", value: count((m) => m.state === "up") },
    { key: "pending", label: "Pending", icon: "i-lucide-circle-dashed", color: "text-muted", ring: "ring-neutral-400/40", value: count((m) => m.state === "pending") },
    { key: "maintenance", label: "In maintenance", icon: "i-lucide-wrench", color: "text-info", ring: "ring-info/40", value: count((m) => m.maintenanceMode !== "none") },
  ];
});

const toggle = (key: string) => (status.value = status.value === key ? "all" : key);
</script>

<template>
  <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
    <button
      v-for="card in cards"
      :key="card.key"
      type="button"
      class="group rounded-lg border border-default bg-default p-4 text-left transition hover:bg-elevated/60 focus-visible:outline-2 focus-visible:outline-primary"
      :class="status === card.key ? ['ring-2', card.ring] : ''"
      :aria-pressed="status === card.key"
      @click="toggle(card.key)"
    >
      <div class="flex items-center justify-between text-sm text-muted">
        <span>{{ card.label }}</span>
        <UIcon :name="card.icon" class="size-5" :class="card.value > 0 ? card.color : ''" />
      </div>
      <USkeleton v-if="loading" class="mt-3 h-8 w-10" />
      <div
        v-else
        class="mt-2 text-3xl font-semibold tabular-nums"
        :class="card.key === 'down' && card.value > 0 ? 'text-error' : 'text-highlighted'"
      >
        {{ card.value }}
      </div>
    </button>
  </div>
</template>
