<script setup lang="ts">
import type { BulkAction, BulkResult, CheckResult, ConfirmOptions, MaintenanceMode, Monitor } from "~/types";

const toast = useToast();
const { monitors, loaded, updatedAt, refreshError, refresh, groups } = useMonitors();
const { me, load: loadMe } = useMe();
const { settings, load: loadSettings } = useSettings();
const now = useTicker();

const status = ref("all");

// ---- overlays ----

const formOpen = ref(false);
const editing = ref<Monitor | null>(null);
const confirmOpen = ref(false);
const confirmOptions = ref<ConfirmOptions | null>(null);
const checkOpen = ref(false);
const checkResult = ref<{ monitor: Monitor; result: CheckResult } | null>(null);
const detailOpen = ref(false);
const detailId = ref<number | null>(null);
const detail = useTemplateRef("detail");

// Don't re-render the table under an open dialog; the next tick catches up.
useAutoRefresh(refresh, () => formOpen.value || confirmOpen.value || checkOpen.value || detailOpen.value);

const notify = (title: string, color: "success" | "error" | "neutral" = "success") =>
  toast.add({ title, color, icon: color === "error" ? "i-lucide-circle-alert" : "i-lucide-circle-check" });

function openForm(monitor: Monitor | null) {
  editing.value = monitor;
  formOpen.value = true;
}

async function onSaved(message: string) {
  notify(message);
  await refresh();
  if (detailOpen.value) await detail.value?.reload();
}

// The open monitor is kept in the URL hash (#monitor-<id>), which ntfy alerts link to.
const route = useRoute();
const router = useRouter();

function openDetail(monitor: Pick<Monitor, "id">) {
  router.replace({ hash: `#monitor-${monitor.id}` });
}
watch(detailOpen, (isOpen) => {
  if (!isOpen && route.hash.startsWith("#monitor-")) router.replace({ hash: "" });
});
watch(
  () => route.hash,
  (hash) => {
    const match = /^#monitor-(\d+)$/.exec(hash);
    if (!match) return;
    detailId.value = Number(match[1]);
    detailOpen.value = true;
  },
  { immediate: true },
);

function confirm(options: ConfirmOptions) {
  confirmOptions.value = options;
  confirmOpen.value = true;
}

// ---- row actions ----

const checking = ref(new Set<number>());
async function checkNow(monitor: Monitor) {
  checking.value = new Set(checking.value).add(monitor.id);
  try {
    const result = await api<CheckResult>(`/api/monitors/${monitor.id}/check`, { method: "POST" });
    checkResult.value = { monitor, result };
    checkOpen.value = true;
  } catch (err) {
    notify(errorMessage(err), "error");
  } finally {
    const next = new Set(checking.value);
    next.delete(monitor.id);
    checking.value = next;
  }
}

async function setMaintenance(monitor: Monitor, mode: MaintenanceMode) {
  try {
    await api(`/api/monitors/${monitor.id}/maintenance`, { method: "PUT", body: { mode } });
    notify(
      mode === "none"
        ? `Ended maintenance for ${monitor.name}`
        : `${monitor.name} is now in ${MAINTENANCE_LABELS[mode].toLowerCase()}`,
    );
    await refresh();
  } catch (err) {
    notify(errorMessage(err), "error");
  }
}

function deleteMonitor(monitor: Monitor) {
  confirm({
    title: `Delete ${monitor.name}?`,
    intro: "This permanently deletes the monitor and its incident history:",
    monitors: [monitor],
    note: "This cannot be undone.",
    okLabel: "Delete permanently",
    danger: true,
    run: async () => {
      await api(`/api/monitors/${monitor.id}?confirm=true`, { method: "DELETE" });
      notify(`Deleted ${monitor.name}`);
      if (detailId.value === monitor.id) detailOpen.value = false;
      await refresh();
    },
  });
}

// ---- bulk actions ----

function bulk(action: BulkAction, selected: Monitor[], clear: () => void) {
  const n = selected.length;
  if (n === 0) return;
  const ids = selected.map((m) => m.id);
  const submit = async (body: Record<string, unknown>, done: (r: BulkResult) => string) => {
    const result = await api<BulkResult>("/api/monitors/bulk", { method: "POST", body: { ...body, ids, confirm: true } });
    clear();
    notify(done(result));
    await refresh();
  };

  switch (action) {
    case "maintenance-notify":
    case "maintenance-silent": {
      const silent = action === "maintenance-silent";
      return confirm({
        title: `Start ${silent ? "maintenance without notifications" : "maintenance with notifications"} for ${plural(n, "monitor")}?`,
        intro: `Checks continue${silent ? "; outage and recovery alerts are suppressed" : " and alerts are still sent"}. Applies to these ${plural(n, "monitor")}:`,
        monitors: selected,
        note: "Maintenance starts now and has no end time. It stays active until you end it manually.",
        okLabel: `Start maintenance for ${plural(n, "monitor")}`,
        run: () =>
          submit({ action: "maintenance", mode: silent ? "silent" : "notify" }, (r) => `Maintenance started for ${plural(r.changed, "monitor")}`),
      });
    }
    case "end-maintenance":
      return confirm({
        title: `End maintenance for ${plural(n, "monitor")}?`,
        intro: "Maintenance ends now for:",
        monitors: selected,
        note: "Monitors that are still down after silent maintenance send one “still down” notification.",
        okLabel: `End maintenance for ${plural(n, "monitor")}`,
        run: () => submit({ action: "end-maintenance" }, (r) => `Maintenance ended for ${plural(r.changed, "monitor")}`),
      });
    case "delete":
      return confirm({
        title: `Permanently delete ${plural(n, "monitor")}?`,
        intro: `This deletes these ${plural(n, "monitor")} and all their incident history:`,
        monitors: selected,
        note: "This cannot be undone.",
        okLabel: `Delete ${plural(n, "monitor")}`,
        danger: true,
        run: () => submit({ action: "delete" }, (r) => `Deleted ${plural(r.changed, "monitor")}`),
      });
  }
}

onMounted(async () => {
  await Promise.all([loadMe(), loadSettings()]);
  await refresh();
});
</script>

<template>
  <UContainer as="main" class="max-w-screen-2xl space-y-6 py-6">
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-xl font-semibold text-highlighted">Monitors</h1>
      <span class="text-xs text-muted" aria-live="polite">
        <span v-if="refreshError" class="text-error">Refresh failed: {{ refreshError }}</span>
        <template v-else-if="updatedAt">Updated {{ ago(updatedAt, now) }}</template>
      </span>
      <UButton class="ms-auto" icon="i-lucide-plus" label="Add monitor" @click="openForm(null)" />
    </div>

    <UAlert
      v-if="refreshError && !monitors.length && loaded"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load monitors"
      :description="refreshError"
    />

    <StatCards v-model:status="status" :monitors="monitors" />

    <MonitorsTable
      v-model:status="status"
      :monitors="monitors"
      :groups="groups"
      :loading="!loaded"
      :checking="checking"
      @add="openForm(null)"
      @detail="openDetail"
      @edit="openForm"
      @check="checkNow"
      @delete="deleteMonitor"
      @maintenance="setMaintenance"
      @bulk="bulk"
    />

    <footer class="space-y-1 pb-4 text-xs text-muted">
      <p v-if="me" class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-mail" class="size-3.5" />
          Email {{ me.notifications.email ? "configured" : "not configured" }}
        </span>
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-bell" class="size-3.5" />
          ntfy {{ me.notifications.ntfy ? "configured" : "not configured" }}
        </span>
        <span class="inline-flex items-center gap-1">
          <UIcon name="i-lucide-globe" class="size-3.5" />
          Times shown in {{ me.timeZone }}
        </span>
      </p>
      <p>
        Checks run from Cloudflare's network (a single vantage point). Results do not guarantee availability from
        every region or network. Values in parentheses include time in maintenance without notifications.
      </p>
    </footer>

    <MonitorFormModal
      v-model:open="formOpen"
      :monitor="editing"
      :groups="groups"
      :default-interval="settings?.checks.defaultIntervalMinutes ?? null"
      :intervals="settings?.checks.intervals ?? []"
      @saved="onSaved"
    />
    <ConfirmModal v-model:open="confirmOpen" :options="confirmOptions" />
    <CheckResultModal v-model:open="checkOpen" :monitor="checkResult?.monitor ?? null" :result="checkResult?.result ?? null" />
    <MonitorDetailSlideover
      ref="detail"
      v-model:open="detailOpen"
      :monitor-id="detailId"
      :default-interval="settings?.checks.defaultIntervalMinutes ?? null"
      :checking="detailId != null && checking.has(detailId)"
      @edit="openForm"
      @check="checkNow"
    />
  </UContainer>
</template>
