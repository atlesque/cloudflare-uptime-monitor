<script setup lang="ts">
import type { ConfirmOptions } from "~/types";

const props = defineProps<{ options: ConfirmOptions | null }>();
const open = defineModel<boolean>("open", { required: true });

const running = ref(false);
const error = ref<string | null>(null);
watch(open, (isOpen) => isOpen && (error.value = null));

async function confirm() {
  if (!props.options) return;
  running.value = true;
  error.value = null;
  try {
    await props.options.run();
    open.value = false;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="options?.title" :dismissible="!running">
    <template #body>
      <div v-if="options" class="space-y-4 text-sm">
        <p>{{ options.intro }}</p>
        <ul v-if="options.monitors.length" class="max-h-60 divide-y divide-default overflow-y-auto rounded-md border border-default">
          <li v-for="m in options.monitors" :key="m.id" class="flex flex-col px-3 py-2">
            <span class="font-medium text-highlighted">{{ m.name }}</span>
            <span class="truncate text-xs text-muted">{{ m.url }}</span>
          </li>
        </ul>
        <UAlert
          v-if="options.note"
          :color="options.danger ? 'error' : 'neutral'"
          variant="subtle"
          :icon="options.danger ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
          :description="options.note"
        />
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" :disabled="running" @click="open = false" />
        <UButton :color="options?.danger ? 'error' : 'primary'" :loading="running" :label="options?.okLabel" @click="confirm" />
      </div>
    </template>
  </UModal>
</template>
