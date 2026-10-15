<script setup lang="ts">
import type { FormError } from "@nuxt/ui";
import type { Group, Monitor } from "~/types";

const props = defineProps<{ monitor: Monitor | null; groups: string[]; defaultInterval: number | null; intervals: number[] }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ saved: [message: string] }>();

const form = reactive({ name: "", url: "", group: "", timeout: 10, interval: "default", confirmUrlChange: false });
const error = ref<string | null>(null);
const saving = ref(false);

// Groups can exist without monitors, so the suggestions also come from the groups list.
const savedGroups = ref<string[]>([]);
const groupOptions = computed(() => [...new Set([...props.groups, ...savedGroups.value])].sort((a, b) => a.localeCompare(b)));

watch(open, (isOpen) => {
  if (!isOpen) return;
  const m = props.monitor;
  Object.assign(form, {
    name: m?.name ?? "",
    url: m?.url ?? "",
    group: m?.group ?? "",
    timeout: (m?.timeoutMs ?? 10_000) / 1000,
    interval: m?.checkIntervalMinutes == null ? "default" : String(m.checkIntervalMinutes),
    confirmUrlChange: false,
  });
  error.value = null;
  api<{ groups: Group[] }>("/api/groups")
    .then((res) => (savedGroups.value = res.groups.map((g) => g.name)))
    .catch(() => {});
});

const intervalItems = computed(() => [
  { label: props.defaultInterval ? `Default (${formatInterval(props.defaultInterval)})` : "Default", value: "default" },
  ...props.intervals.map((n) => ({ label: formatInterval(n).replace(/^every/, "Every"), value: String(n) })),
]);

const urlChanged = computed(() => !!props.monitor && form.url.trim() !== props.monitor.url);

function validate(state: typeof form): FormError[] {
  const errors: FormError[] = [];
  if (!state.name.trim()) errors.push({ name: "name", message: "Enter a name" });
  if (!/^https?:\/\/\S+$/i.test(state.url.trim())) errors.push({ name: "url", message: "Enter an http:// or https:// URL" });
  if (!Number.isInteger(state.timeout) || state.timeout < 1 || state.timeout > 30) {
    errors.push({ name: "timeout", message: "Between 1 and 30 seconds" });
  }
  if (urlChanged.value && !state.confirmUrlChange) {
    errors.push({ name: "confirmUrlChange", message: "Confirm the URL change to continue" });
  }
  return errors;
}

async function submit() {
  const body: Record<string, unknown> = {
    name: form.name,
    url: form.url,
    group: form.group.trim() || null,
    timeoutMs: Math.round(form.timeout * 1000),
    checkIntervalMinutes: form.interval === "default" ? null : Number(form.interval),
  };
  saving.value = true;
  error.value = null;
  try {
    if (props.monitor) {
      if (urlChanged.value) body.confirmUrlChange = true;
      await api(`/api/monitors/${props.monitor.id}`, { method: "PATCH", body });
      emit("saved", `Saved ${form.name.trim()}`);
    } else {
      await api("/api/monitors", { method: "POST", body });
      emit("saved", `Added ${form.name.trim()}. It stays Pending until the first scheduled check.`);
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
  <UModal v-model:open="open" :title="monitor ? `Edit ${monitor.name}` : 'Add monitor'" description="Checked with a GET request. 2xx and 3xx responses count as up.">
    <template #body>
      <UForm id="monitor-form" :state="form" :validate="validate" :validate-on="['blur']" class="space-y-4" @submit="submit">
        <UFormField label="Name" name="name" required>
          <UInput v-model="form.name" maxlength="100" class="w-full" autofocus />
        </UFormField>
        <UFormField label="URL" name="url" required>
          <UInput v-model="form.url" type="url" placeholder="https://example.com/" class="w-full" />
        </UFormField>
        <template v-if="urlChanged">
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            description="Changing the URL starts a new observation period: state, incidents and uptime history for this monitor are reset."
          />
          <UFormField name="confirmUrlChange">
            <UCheckbox v-model="form.confirmUrlChange" label="I understand the history will be reset" />
          </UFormField>
        </template>
        <UFormField label="Check interval" name="interval" description="A monitor goes down after two failed checks in a row.">
          <USelect v-model="form.interval" :items="intervalItems" class="w-full" />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Group" name="group" hint="Optional">
            <UInput v-model="form.group" maxlength="50" list="group-options" class="w-full" />
            <datalist id="group-options">
              <option v-for="g in groupOptions" :key="g" :value="g" />
            </datalist>
          </UFormField>
          <UFormField label="Timeout" name="timeout" required>
            <UInputNumber v-model="form.timeout" :min="1" :max="30" :step="1" class="w-full" :format-options="{ style: 'unit', unit: 'second', unitDisplay: 'short' }" />
          </UFormField>
        </div>
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" role="alert" />
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="monitor-form" :loading="saving" :label="monitor ? 'Save' : 'Add monitor'" />
      </div>
    </template>
  </UModal>
</template>
