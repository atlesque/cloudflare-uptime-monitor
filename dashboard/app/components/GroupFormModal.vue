<script setup lang="ts">
import type { Group, Monitor } from "~/types";

/** Adds a group, or edits one: its name and exactly which monitors are in it. */
const props = defineProps<{ group: Group | null; groups: Group[]; monitors: Monitor[] }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ saved: [groups: Group[], message: string] }>();

const name = ref("");
const selected = ref<Set<number>>(new Set());
const search = ref("");
const error = ref<string | null>(null);
const saving = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) return;
  name.value = props.group?.name ?? "";
  selected.value = new Set(props.group ? props.monitors.filter((m) => m.group === props.group!.name).map((m) => m.id) : []);
  search.value = "";
  error.value = null;
});

const trimmed = computed(() => name.value.trim());
const merging = computed(() => !!props.group && trimmed.value !== props.group.name && props.groups.some((g) => g.name === trimmed.value));
const exists = computed(() => !props.group && props.groups.some((g) => g.name === trimmed.value));

const sorted = computed(() => [...props.monitors].sort((a, b) => a.name.localeCompare(b.name)));
const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return sorted.value;
  return sorted.value.filter((m) => `${m.name} ${m.url} ${m.group ?? ""}`.toLowerCase().includes(q));
});
/** Selected monitors that now sit in another group and will move. */
const moving = computed(() => props.monitors.filter((m) => selected.value.has(m.id) && m.group && m.group !== props.group?.name));

function toggle(id: number, on: boolean | "indeterminate") {
  const next = new Set(selected.value);
  if (on === true) next.add(id);
  else next.delete(id);
  selected.value = next;
}

const allVisibleSelected = computed(() => visible.value.length > 0 && visible.value.every((m) => selected.value.has(m.id)));
function toggleVisible() {
  const next = new Set(selected.value);
  const on = !allVisibleSelected.value;
  for (const m of visible.value) on ? next.add(m.id) : next.delete(m.id);
  selected.value = next;
}

async function submit() {
  if (!trimmed.value || exists.value) return;
  saving.value = true;
  error.value = null;
  const monitorIds = [...selected.value];
  try {
    if (props.group) {
      const from = props.group.name;
      const res = await api<{ groups: Group[] }>("/api/groups/edit", {
        method: "POST",
        body: { name: from, ...(trimmed.value !== from ? { to: trimmed.value } : {}), monitorIds },
      });
      emit("saved", res.groups, merging.value ? `Merged ${from} into ${trimmed.value}` : `Saved ${trimmed.value}`);
    } else {
      const res = await api<{ groups: Group[] }>("/api/groups", { method: "POST", body: { name: trimmed.value, monitorIds } });
      emit("saved", res.groups, `Added the group ${trimmed.value}`);
    }
    open.value = false;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="group ? `Edit ${group.name}` : 'Add group'" :dismissible="!saving">
    <template #body>
      <form id="group-form" class="space-y-4" @submit.prevent="submit">
        <UFormField label="Name" :error="exists ? 'A group with this name already exists' : undefined" required>
          <UInput v-model="name" maxlength="50" class="w-full" autofocus />
        </UFormField>
        <UAlert
          v-if="merging"
          color="warning"
          variant="subtle"
          icon="i-lucide-merge"
          :description="`${trimmed} already exists. Its monitors and the ones picked here will form one group.`"
        />

        <UFormField :label="`Monitors (${selected.size} selected)`" :description="monitors.length ? 'A monitor is in at most one group.' : undefined">
          <p v-if="monitors.length === 0" class="text-sm text-muted">There are no monitors yet. You can add them to this group later.</p>
          <div v-else class="space-y-2">
            <div class="flex items-center gap-2">
              <UInput
                v-if="monitors.length > 6"
                v-model="search"
                icon="i-lucide-search"
                placeholder="Filter monitors"
                class="min-w-0 flex-1"
                aria-label="Filter monitors"
              />
              <UButton
                color="neutral"
                variant="link"
                size="sm"
                :class="monitors.length > 6 ? '' : 'ms-auto'"
                :disabled="visible.length === 0"
                :label="allVisibleSelected ? 'Clear' : search.trim() ? 'Select shown' : 'Select all'"
                @click="toggleVisible"
              />
            </div>
            <ul class="max-h-72 divide-y divide-default overflow-y-auto rounded-md border border-default">
              <li v-for="m in visible" :key="m.id">
                <label class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-elevated/50">
                  <UCheckbox :model-value="selected.has(m.id)" @update:model-value="toggle(m.id, $event)" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium text-highlighted">{{ m.name }}</span>
                    <span class="block truncate text-xs text-muted">{{ m.url }}</span>
                  </span>
                  <UBadge v-if="m.group && m.group !== group?.name" color="neutral" variant="soft" size="sm" :label="m.group" />
                </label>
              </li>
              <li v-if="visible.length === 0" class="px-3 py-2 text-sm text-muted">No monitors match.</li>
            </ul>
          </div>
        </UFormField>
        <p v-if="moving.length" class="text-sm text-muted">
          {{ plural(moving.length, "monitor") }} will move here from {{ [...new Set(moving.map((m) => m.group))].join(", ") }}.
        </p>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          type="submit"
          form="group-form"
          :loading="saving"
          :disabled="!trimmed || exists"
          :label="group ? (merging ? 'Merge groups' : 'Save') : 'Add group'"
        />
      </div>
    </template>
  </UModal>
</template>
