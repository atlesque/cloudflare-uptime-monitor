<script setup lang="ts">
// Operational value, with the value including silent maintenance in parentheses when it differs.
defineProps<{ value: string; inclusive: string; valueClass?: string }>();
</script>

<template>
  <span class="tabular-nums">
    <span :class="valueClass">{{ value }}</span>
    <span v-if="inclusive !== value" class="text-muted"> ({{ inclusive }})</span>
  </span>
</template>
