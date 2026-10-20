<script setup lang="ts">
// A column header that cycles its column's sort: ascending, descending, then off.
const props = defineProps<{ label: string; direction: "asc" | "desc" | null }>();
defineEmits<{ toggle: [] }>();

const icon = computed(() =>
  props.direction === "asc" ? "i-lucide-arrow-up" : props.direction === "desc" ? "i-lucide-arrow-down" : "i-lucide-arrow-up-down",
);
const next = computed(() => (props.direction === null ? "ascending" : props.direction === "asc" ? "descending" : "the default order"));
</script>

<template>
  <button
    type="button"
    class="group -mx-1 inline-flex items-center gap-1 rounded px-1 font-semibold hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
    :class="direction ? 'text-highlighted' : ''"
    :aria-label="`${label}: sort ${next}`"
    @click="$emit('toggle')"
  >
    <slot>{{ label }}</slot>
    <UIcon :name="icon" class="size-3.5 shrink-0" :class="direction ? 'text-primary' : 'text-dimmed opacity-50 group-hover:opacity-100'" />
  </button>
</template>
