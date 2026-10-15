<script setup lang="ts">
import type { DropdownMenuItem, TableColumn } from "@nuxt/ui";
import type { BulkAction, MaintenanceMode, Monitor } from "~/types";

const props = defineProps<{ monitors: Monitor[]; groups: string[]; loading: boolean; checking: Set<number> }>();
const status = defineModel<string>("status", { required: true });
const emit = defineEmits<{
  add: [];
  detail: [monitor: Monitor];
  edit: [monitor: Monitor];
  check: [monitor: Monitor];
  delete: [monitor: Monitor];
  maintenance: [monitor: Monitor, mode: MaintenanceMode];
  bulk: [action: BulkAction, monitors: Monitor[], clear: () => void];
}>();

const now = useTicker();
const search = ref("");
const group = ref("all");

const groupItems = computed(() => [
  { label: "All groups", value: "all" },
  ...props.groups.map((g) => ({ label: g, value: g })),
  { label: "No group", value: "__none__" },
]);
const statusItems = [
  { label: "All states", value: "all" },
  { label: "Down", value: "down" },
  { label: "Up", value: "up" },
  { label: "Pending", value: "pending" },
  { label: "In maintenance", value: "maintenance" },
];

// A group filter that no longer exists (its last monitor moved or was deleted) falls back to all.
watch(
  () => props.groups,
  (groups) => {
    if (group.value !== "all" && group.value !== "__none__" && !groups.includes(group.value)) group.value = "all";
  },
);

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return props.monitors.filter((m) => {
    if (q && !m.name.toLowerCase().includes(q) && !m.url.toLowerCase().includes(q)) return false;
    if (group.value === "__none__" ? m.group !== null : group.value !== "all" && m.group !== group.value) return false;
    if (status.value === "maintenance") return m.maintenanceMode !== "none";
    if (status.value !== "all" && m.state !== status.value) return false;
    return true;
  });
});

// Selection only ever contains visible monitors, so a bulk action never includes one you cannot see.
const rowSelection = ref<Record<string, boolean>>({});
watch(visible, (list) => {
  const ids = new Set(list.map((m) => String(m.id)));
  const pruned = Object.fromEntries(Object.entries(rowSelection.value).filter(([id, on]) => on && ids.has(id)));
  if (Object.keys(pruned).length !== Object.keys(rowSelection.value).length) rowSelection.value = pruned;
});
const selected = computed(() => props.monitors.filter((m) => rowSelection.value[String(m.id)]));
const clearSelection = () => (rowSelection.value = {});

const allSelected = computed(() => visible.value.length > 0 && selected.value.length === visible.value.length);
const someSelected = computed(() => selected.value.length > 0 && !allSelected.value);
function toggleAll(on: boolean | "indeterminate") {
  rowSelection.value = on === true ? Object.fromEntries(visible.value.map((m) => [String(m.id), true])) : {};
}
function toggleRow(id: number, on: boolean | "indeterminate") {
  const next = { ...rowSelection.value };
  if (on === true) next[String(id)] = true;
  else delete next[String(id)];
  rowSelection.value = next;
}

const right = { class: { th: "text-right", td: "text-right" } };
const columns: TableColumn<Monitor>[] = [
  { id: "select", meta: { class: { th: "w-10", td: "w-10" } } },
  { id: "name", header: "Monitor" },
  { id: "group", header: "Group" },
  { id: "state", header: "State" },
  { id: "uptime", header: "Uptime 30d", meta: right },
  { id: "downtime", header: "Downtime 30d", meta: right },
  { id: "lastCheck", header: "Last check" },
  { id: "outage", header: "Outage since" },
  { id: "actions", meta: { class: { th: "w-24", td: "w-24 text-right" } } },
];

function actionItems(m: Monitor): DropdownMenuItem[][] {
  const maintenance: DropdownMenuItem[] = [];
  if (m.maintenanceMode !== "notify") {
    maintenance.push({
      label: "Start maintenance",
      description: "Checks and alerts continue",
      icon: "i-lucide-wrench",
      onSelect: () => emit("maintenance", m, "notify"),
    });
  }
  if (m.maintenanceMode !== "silent") {
    maintenance.push({
      label: "Start silent maintenance",
      description: "Checks continue, alerts are suppressed",
      icon: "i-lucide-bell-off",
      onSelect: () => emit("maintenance", m, "silent"),
    });
  }
  if (m.maintenanceMode !== "none") {
    maintenance.push({ label: "End maintenance", icon: "i-lucide-circle-stop", onSelect: () => emit("maintenance", m, "none") });
  }
  return [
    [
      { label: "Details", icon: "i-lucide-panel-right-open", onSelect: () => emit("detail", m) },
      { label: "Edit", icon: "i-lucide-pencil", onSelect: () => emit("edit", m) },
    ],
    maintenance,
    [{ label: "Delete", icon: "i-lucide-trash-2", color: "error", onSelect: () => emit("delete", m) }],
  ];
}

const bulk = (action: BulkAction) => emit("bulk", action, selected.value, clearSelection);
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0', header: 'p-3 sm:px-4' }">
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Search name or URL"
          type="search"
          autocomplete="off"
          class="w-full sm:w-64"
          aria-label="Search monitors"
        />
        <USelect v-model="group" :items="groupItems" class="w-40" aria-label="Filter by group" />
        <USelect v-model="status" :items="statusItems" class="w-40" aria-label="Filter by state" />
        <USkeleton v-if="loading" class="ms-auto h-4 w-20" />
        <div v-else class="ms-auto text-sm text-muted">
          {{ plural(visible.length, "monitor") }}<template v-if="visible.length !== monitors.length"> of {{ monitors.length }}</template>
        </div>
      </div>

      <div
        v-if="selected.length > 0"
        class="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
        role="region"
        aria-label="Selection actions"
      >
        <span class="me-2 text-sm font-medium text-highlighted">{{ selected.length }} selected</span>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-wrench" label="Maintenance" @click="bulk('maintenance-notify')" />
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-bell-off" label="Silent maintenance" @click="bulk('maintenance-silent')" />
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-circle-stop" label="End maintenance" @click="bulk('end-maintenance')" />
        <UButton size="sm" color="error" variant="soft" icon="i-lucide-trash-2" label="Delete…" @click="bulk('delete')" />
        <UButton size="sm" color="neutral" variant="link" label="Clear selection" class="ms-auto" @click="clearSelection" />
      </div>
    </template>

    <!-- First load: placeholder rows shaped like the table (or the card list on phones). -->
    <div v-if="loading" aria-busy="true" aria-label="Loading monitors">
      <div class="hidden border-b border-default px-4 py-3.5 md:flex md:items-center md:gap-6">
        <USkeleton class="size-4 rounded" />
        <USkeleton v-for="(w, i) in ['w-24', 'w-14', 'w-12', 'w-20', 'w-24', 'w-20', 'w-24']" :key="i" class="h-3.5" :class="w" />
      </div>
      <ul class="divide-y divide-default">
        <li v-for="i in 6" :key="i" class="flex items-start gap-4 px-4 py-4">
          <USkeleton class="mt-0.5 size-4 shrink-0 rounded" />
          <div class="min-w-0 flex-1 space-y-2 md:w-56 md:flex-none">
            <USkeleton class="h-4 w-32" />
            <USkeleton class="h-3 w-48 max-w-full" />
            <div class="flex gap-1.5 md:hidden">
              <USkeleton class="h-5 w-14 rounded-md" />
              <USkeleton class="h-5 w-16 rounded-md" />
            </div>
          </div>
          <USkeleton class="hidden h-5 w-16 rounded-md md:block" />
          <USkeleton class="hidden h-5 w-14 rounded-md md:block" />
          <USkeleton class="h-4 w-12 md:ms-auto md:w-16" />
          <USkeleton class="hidden h-4 w-14 md:block" />
          <div class="hidden space-y-2 lg:block">
            <USkeleton class="h-4 w-16" />
            <USkeleton class="h-3 w-24" />
          </div>
          <div class="flex gap-1">
            <USkeleton class="size-7 rounded-md" />
            <USkeleton class="hidden size-7 rounded-md md:block" />
          </div>
        </li>
      </ul>
    </div>

    <template v-else>
    <UTable
      v-model:row-selection="rowSelection"
      :data="visible"
      :columns="columns"
      :get-row-id="(row: Monitor) => String(row.id)"
      :meta="{ class: { tr: (row) => (row.original.state === 'down' ? 'bg-error/5' : '') } }"
      sticky="header"
      class="hidden max-h-[calc(100vh-18rem)] min-h-48 md:block"
      :ui="{ thead: 'bg-default', td: 'py-3 align-top', th: 'whitespace-nowrap' }"
    >
      <template #select-header>
        <UCheckbox
          :model-value="someSelected ? 'indeterminate' : allSelected"
          :disabled="visible.length === 0"
          aria-label="Select all filtered monitors"
          @update:model-value="toggleAll"
        />
      </template>
      <template #select-cell="{ row }">
        <UCheckbox
          :model-value="!!rowSelection[row.id]"
          :aria-label="`Select ${row.original.name}`"
          @update:model-value="(v) => toggleRow(row.original.id, v)"
        />
      </template>

      <template #name-cell="{ row }">
        <div class="max-w-72 min-w-40">
          <button
            type="button"
            class="block max-w-full truncate text-left font-medium text-highlighted hover:text-primary hover:underline"
            @click="emit('detail', row.original)"
          >
            {{ row.original.name }}
          </button>
          <a
            :href="row.original.url"
            target="_blank"
            rel="noopener noreferrer"
            class="block max-w-full truncate text-xs text-muted hover:text-default hover:underline"
          >{{ row.original.url }}</a>
        </div>
      </template>

      <template #group-cell="{ row }">
        <UBadge v-if="row.original.group" color="neutral" variant="soft" :label="row.original.group" />
        <span v-else class="text-dimmed">—</span>
      </template>

      <template #state-cell="{ row }">
        <MonitorStateBadges :monitor="row.original" size="sm" />
      </template>

      <template #uptime-header>
        <UTooltip text="Rolling 30 days. In parentheses: including silent maintenance">
          <span class="underline decoration-dotted underline-offset-4">Uptime 30d</span>
        </UTooltip>
      </template>
      <template #uptime-cell="{ row }">
        <MetricPair
          :value="formatUptime(row.original.metrics30d.uptimePct)"
          :inclusive="formatUptime(row.original.metrics30d.uptimeInclusivePct)"
          :value-class="['font-medium', uptimeColor(row.original.metrics30d.uptimePct)].join(' ')"
        />
      </template>

      <template #downtime-cell="{ row }">
        <MetricPair
          :value="formatDowntime(row.original.metrics30d.downtimeMs)"
          :inclusive="formatDowntime(row.original.metrics30d.downtimeInclusiveMs)"
        />
      </template>

      <template #lastCheck-cell="{ row }">
        <div v-if="row.original.lastCheck" class="whitespace-nowrap">
          <UTooltip :text="formatFullTime(row.original.lastCheck.at)">
            <span>{{ ago(row.original.lastCheck.at, now) }}</span>
          </UTooltip>
          <div class="max-w-56 truncate text-xs" :class="row.original.lastCheck.error ? 'text-error' : 'text-muted'">
            {{ row.original.lastCheck.error ?? `HTTP ${row.original.lastCheck.status}` }}<span
              v-if="row.original.lastCheck.durationMs != null"
              class="text-muted tabular-nums"
            > · {{ row.original.lastCheck.durationMs }} ms</span>
          </div>
        </div>
        <span v-else class="text-muted">Not checked yet</span>
      </template>

      <template #outage-cell="{ row }">
        <div v-if="row.original.currentOutageStartedAt" class="whitespace-nowrap">
          <UTooltip :text="formatFullTime(row.original.currentOutageStartedAt)">
            <span class="text-error">{{ formatTime(row.original.currentOutageStartedAt) }}</span>
          </UTooltip>
          <div class="text-xs text-muted">{{ formatDuration(now - row.original.currentOutageStartedAt) }}</div>
        </div>
        <span v-else class="text-dimmed">—</span>
      </template>

      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UTooltip text="Check now">
            <UButton
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="checking.has(row.original.id)"
              :aria-label="`Check ${row.original.name} now`"
              @click="emit('check', row.original)"
            />
          </UTooltip>
          <UDropdownMenu :items="actionItems(row.original)" :content="{ align: 'end' }">
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" size="sm" :aria-label="`Actions for ${row.original.name}`" />
          </UDropdownMenu>
        </div>
      </template>

      <template #empty>
        <div class="flex flex-col items-center gap-3 py-10 text-center">
          <UIcon name="i-lucide-activity" class="size-8 text-dimmed" />
          <template v-if="monitors.length === 0">
            <p class="text-muted">No monitors yet. Add one to start checking.</p>
            <UButton icon="i-lucide-plus" label="Add monitor" @click="emit('add')" />
          </template>
          <p v-else class="text-muted">No monitors match the filters.</p>
        </div>
      </template>
    </UTable>

    <!-- Below md the table becomes a list of cards. -->
    <div class="md:hidden">
      <div v-if="visible.length > 0" class="flex items-center gap-3 border-b border-default px-4 py-2">
        <UCheckbox
          :model-value="someSelected ? 'indeterminate' : allSelected"
          label="Select all"
          aria-label="Select all filtered monitors"
          @update:model-value="toggleAll"
        />
      </div>
      <ul class="divide-y divide-default">
        <li v-for="m in visible" :key="m.id" class="flex gap-3 px-4 py-3" :class="m.state === 'down' ? 'bg-error/5' : ''">
          <UCheckbox
            class="pt-0.5"
            :model-value="!!rowSelection[String(m.id)]"
            :aria-label="`Select ${m.name}`"
            @update:model-value="(v) => toggleRow(m.id, v)"
          />
          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="flex items-start justify-between gap-2">
              <button type="button" class="min-w-0 truncate text-left font-medium text-highlighted" @click="emit('detail', m)">
                {{ m.name }}
              </button>
              <MetricPair
                class="shrink-0 text-sm"
                :value="formatUptime(m.metrics30d.uptimePct)"
                :inclusive="formatUptime(m.metrics30d.uptimeInclusivePct)"
                :value-class="['font-medium', uptimeColor(m.metrics30d.uptimePct)].join(' ')"
              />
            </div>
            <div class="truncate text-xs text-muted">{{ m.url }}</div>
            <div class="flex flex-wrap items-center gap-1.5">
              <MonitorStateBadges :monitor="m" size="sm" />
              <UBadge v-if="m.group" color="neutral" variant="soft" size="sm" :label="m.group" />
            </div>
            <div class="text-xs text-muted">
              <template v-if="m.currentOutageStartedAt">
                <span class="text-error">Down for {{ formatDuration(now - m.currentOutageStartedAt) }}</span> ·
              </template>
              <template v-if="m.lastCheck">
                Checked {{ ago(m.lastCheck.at, now) }} ·
                <span :class="m.lastCheck.error ? 'text-error' : ''">{{ m.lastCheck.error ?? `HTTP ${m.lastCheck.status}` }}</span>
                <template v-if="m.lastCheck.durationMs != null"> · {{ m.lastCheck.durationMs }} ms</template>
              </template>
              <template v-else>Not checked yet</template>
            </div>
          </div>
          <div class="flex flex-col items-center">
            <UButton
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="checking.has(m.id)"
              :aria-label="`Check ${m.name} now`"
              @click="emit('check', m)"
            />
            <UDropdownMenu :items="actionItems(m)" :content="{ align: 'end' }">
              <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" size="sm" :aria-label="`Actions for ${m.name}`" />
            </UDropdownMenu>
          </div>
        </li>
      </ul>
      <div v-if="visible.length === 0" class="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <UIcon name="i-lucide-activity" class="size-8 text-dimmed" />
        <template v-if="monitors.length === 0">
          <p class="text-muted">No monitors yet. Add one to start checking.</p>
          <UButton icon="i-lucide-plus" label="Add monitor" @click="emit('add')" />
        </template>
        <p v-else class="text-muted">No monitors match the filters.</p>
      </div>
    </div>
    </template>
  </UCard>
</template>
