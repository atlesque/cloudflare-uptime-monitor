<script setup lang="ts">
import type { ConfirmOptions, Group } from "~/types";

const toast = useToast();
const { settings, error: settingsError, load: loadSettings } = useSettings();
const { me, load: loadMe } = useMe();
const { monitors, refresh: refreshMonitors } = useMonitors();

const notify = (title: string, color: "success" | "error" = "success") =>
  toast.add({ title, color, icon: color === "error" ? "i-lucide-circle-alert" : "i-lucide-circle-check" });

// ---- tabs ----

const route = useRoute();
const router = useRouter();
const TABS = ["notifications", "monitors", "groups"] as const;
type Tab = (typeof TABS)[number];
const tab = computed<Tab>({
  get: () => (TABS as readonly string[]).includes(route.query.tab as string) ? (route.query.tab as Tab) : "notifications",
  set: (value) => router.replace({ query: { ...route.query, tab: value === "notifications" ? undefined : value } }),
});
const tabItems = computed(() => [
  { label: "Notifications", icon: "i-lucide-bell", value: "notifications", slot: "notifications" as const },
  { label: "Monitors", icon: "i-lucide-timer", value: "monitors", slot: "monitors" as const },
  {
    label: "Groups",
    icon: "i-lucide-folders",
    value: "groups",
    slot: "groups" as const,
    badge: groupsLoaded.value ? { label: String(groups.value.length), color: "neutral" as const, variant: "subtle" as const } : undefined,
  },
]);

// ---- ntfy ----

const ntfyForm = reactive({ url: "", topic: "", token: "", clearToken: false });
const ntfySaving = ref(false);
const ntfyTesting = ref(false);
const ntfyError = ref<string | null>(null);

function fillNtfyForm() {
  const n = settings.value?.ntfy;
  if (!n) return;
  Object.assign(ntfyForm, {
    url: n.source === "dashboard" ? (n.url ?? "") : "",
    topic: n.source === "dashboard" ? (n.topic ?? "") : "",
    token: "",
    clearToken: false,
  });
}

const ntfyBody = () => ({
  url: ntfyForm.url.trim() || null,
  topic: ntfyForm.topic.trim(),
  ...(ntfyForm.token.trim() ? { token: ntfyForm.token.trim() } : {}),
  ...(ntfyForm.clearToken ? { clearToken: true } : {}),
});

async function saveNtfy() {
  ntfySaving.value = true;
  ntfyError.value = null;
  try {
    settings.value = await api("/api/settings/ntfy", { method: "PUT", body: ntfyBody() });
    fillNtfyForm();
    await loadMe();
    notify(settings.value?.ntfy.enabled ? "ntfy settings saved" : "ntfy turned off");
  } catch (err) {
    ntfyError.value = errorMessage(err);
  } finally {
    ntfySaving.value = false;
  }
}

/** Tests what is in the form; with no topic there, tests the settings in use. */
async function testNtfy() {
  ntfyTesting.value = true;
  ntfyError.value = null;
  try {
    await api("/api/settings/ntfy/test", { method: "POST", body: ntfyForm.topic.trim() ? ntfyBody() : undefined });
    notify("Test notification sent. Check your ntfy app.");
  } catch (err) {
    ntfyError.value = errorMessage(err);
  } finally {
    ntfyTesting.value = false;
  }
}

const confirmOpen = ref(false);
const confirmOptions = ref<ConfirmOptions | null>(null);
function confirm(options: ConfirmOptions) {
  confirmOptions.value = options;
  confirmOpen.value = true;
}

function resetNtfy() {
  confirm({
    title: "Use the deployment's ntfy secrets?",
    intro: "This forgets the ntfy settings saved here. Notifications then use NTFY_URL, NTFY_TOPIC and NTFY_TOKEN from Wrangler secrets.",
    monitors: [],
    okLabel: "Use deployment secrets",
    run: async () => {
      settings.value = await api("/api/settings/ntfy", { method: "DELETE" });
      fillNtfyForm();
      await loadMe();
      notify("Using the deployment's ntfy secrets");
    },
  });
}

const secretsSummary = computed(() => {
  const s = settings.value?.ntfy.secrets;
  if (!s) return "";
  if (!s.topic) return "No NTFY_TOPIC secret is set, so ntfy is off.";
  const parts = ["NTFY_TOPIC"];
  if (s.url) parts.push("NTFY_URL");
  if (s.token) parts.push("NTFY_TOKEN");
  return `Using the ${parts.join(", ")} secret${parts.length > 1 ? "s" : ""}${s.url ? "" : " with https://ntfy.sh"}.`;
});

// ---- checks ----

const interval = ref("1");
const intervalSaving = ref(false);
const intervalItems = computed(() =>
  (settings.value?.checks.intervals ?? []).map((n) => ({ label: formatInterval(n).replace(/^every/, "Every"), value: String(n) })),
);
const overrides = computed(() => monitors.value.filter((m) => m.checkIntervalMinutes != null));
const intervalChanged = computed(() => Number(interval.value) !== settings.value?.checks.defaultIntervalMinutes);

async function saveInterval() {
  intervalSaving.value = true;
  try {
    settings.value = await api("/api/settings/checks", {
      method: "PUT",
      body: { defaultIntervalMinutes: Number(interval.value) },
    });
    notify(`Monitors on the default are now checked ${formatInterval(Number(interval.value))}`);
  } catch (err) {
    notify(errorMessage(err), "error");
  } finally {
    intervalSaving.value = false;
  }
}

// ---- diagnostics ----

const troubleshooterUrl = ref("");
const troubleshooterSaving = ref(false);
const troubleshooterChanged = computed(
  () => troubleshooterUrl.value.trim() !== (settings.value?.diagnostics.akamaiTroubleshooterUrl ?? ""),
);

async function saveTroubleshooter() {
  troubleshooterSaving.value = true;
  try {
    settings.value = await api("/api/settings/diagnostics", {
      method: "PUT",
      body: { akamaiTroubleshooterUrl: troubleshooterUrl.value.trim() },
    });
    troubleshooterUrl.value = settings.value!.diagnostics.akamaiTroubleshooterUrl ?? "";
    await loadMe();
    notify(troubleshooterUrl.value ? "Akamai references now link to the troubleshooter" : "Removed the troubleshooter link");
  } catch (err) {
    notify(errorMessage(err), "error");
  } finally {
    troubleshooterSaving.value = false;
  }
}

// ---- groups ----

const groups = ref<Group[]>([]);
const groupsLoaded = ref(false);
async function loadGroups() {
  try {
    groups.value = (await api<{ groups: Group[] }>("/api/groups")).groups;
  } catch (err) {
    notify(errorMessage(err), "error");
  } finally {
    groupsLoaded.value = true;
  }
}

const groupFormOpen = ref(false);
const editing = ref<Group | null>(null);

function openGroupForm(group: Group | null) {
  editing.value = group;
  groupFormOpen.value = true;
}

async function groupSaved(next: Group[], message: string) {
  groups.value = next;
  notify(message);
  await refreshMonitors();
}

function removeGroup(group: Group) {
  confirm({
    title: `Remove the group ${group.name}?`,
    intro: group.monitors
      ? `These ${plural(group.monitors, "monitor")} keep running, without a group:`
      : "No monitors are in this group.",
    monitors: monitors.value.filter((m) => m.group === group.name),
    okLabel: "Remove group",
    danger: true,
    run: async () => {
      groups.value = (await api<{ groups: Group[] }>("/api/groups/remove", { method: "POST", body: { name: group.name, confirm: true } })).groups;
      notify(`Removed the group ${group.name}`);
      await refreshMonitors();
    },
  });
}

onMounted(async () => {
  await Promise.all([loadSettings(), loadMe(), loadGroups(), monitors.value.length ? null : refreshMonitors()]);
  fillNtfyForm();
  if (settings.value) {
    interval.value = String(settings.value.checks.defaultIntervalMinutes);
    troubleshooterUrl.value = settings.value.diagnostics.akamaiTroubleshooterUrl ?? "";
  }
});
</script>

<template>
  <UContainer as="main" class="max-w-3xl space-y-6 py-6">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Settings</h1>
      <p class="text-sm text-muted">Changes apply from the next scheduled run.</p>
    </div>

    <UAlert v-if="settingsError" color="error" variant="subtle" icon="i-lucide-circle-alert" title="Could not load settings" :description="settingsError" />

    <UTabs v-model="tab" :items="tabItems" variant="link" class="w-full" :ui="{ list: 'overflow-x-auto', trigger: 'flex-none', leadingIcon: 'hidden sm:inline-flex', label: 'overflow-visible', content: 'pt-4' }">
      <template #notifications>
        <!-- ntfy -->
        <UCard>
          <template #header>
            <div class="flex flex-wrap items-center gap-2">
              <UIcon name="i-lucide-bell" class="size-5 text-muted" />
              <h2 class="font-semibold text-highlighted">ntfy notifications</h2>
              <template v-if="settings">
                <UBadge v-if="!settings.ntfy.enabled" color="neutral" variant="subtle" label="Off" />
                <UBadge v-else-if="settings.ntfy.source === 'dashboard'" color="success" variant="subtle" label="On, set here" />
                <UBadge v-else color="success" variant="subtle" label="On, from deployment secrets" />
              </template>
            </div>
          </template>

          <div v-if="!settings" class="space-y-4" aria-busy="true" aria-label="Loading ntfy settings">
            <div class="grid gap-4 sm:grid-cols-2">
              <div v-for="i in 2" :key="i" class="space-y-2">
                <USkeleton class="h-4 w-20" />
                <USkeleton class="h-8 w-full rounded-md" />
              </div>
            </div>
            <div class="space-y-2">
              <USkeleton class="h-4 w-24" />
              <USkeleton class="h-8 w-full rounded-md" />
            </div>
            <div class="flex gap-2">
              <USkeleton class="h-8 w-16 rounded-md" />
              <USkeleton class="h-8 w-28 rounded-md" />
            </div>
          </div>
          <form v-else-if="settings" class="space-y-4" @submit.prevent="saveNtfy">
            <UAlert
              v-if="settings.ntfy.source === 'secrets'"
              color="neutral"
              variant="subtle"
              icon="i-lucide-key-round"
              :description="`${secretsSummary} Saving here overrides the secrets; you can switch back at any time.`"
            />
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField label="Server URL" hint="Optional" description="Leave empty for https://ntfy.sh">
                <UInput v-model="ntfyForm.url" type="url" placeholder="https://ntfy.sh" class="w-full" />
              </UFormField>
              <UFormField label="Topic" description="Leave empty to turn ntfy off.">
                <UInput v-model="ntfyForm.topic" placeholder="my-uptime-alerts" class="w-full" autocomplete="off" />
              </UFormField>
            </div>
            <UFormField
              label="Access token"
              hint="Optional"
              :description="
                settings?.ntfy.tokenSet
                  ? 'A token is saved. Leave empty to keep it.'
                  : 'Only needed for topics that require authentication.'
              "
            >
              <UInput
                v-model="ntfyForm.token"
                type="password"
                :placeholder="settings?.ntfy.tokenSet ? '••••••••' : 'tk_…'"
                :disabled="ntfyForm.clearToken"
                class="w-full"
                autocomplete="new-password"
              />
            </UFormField>
            <UCheckbox v-if="settings?.ntfy.tokenSet" v-model="ntfyForm.clearToken" label="Remove the saved token" />
            <p class="text-xs text-muted">
              On ntfy.sh anyone who knows the topic name can read it, so pick one that is hard to guess. Tokens are kept
              in the database and never shown again.
            </p>
            <UAlert v-if="ntfyError" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="ntfyError" role="alert" />
            <div class="flex flex-wrap items-center gap-2">
              <UButton type="submit" :loading="ntfySaving" label="Save" />
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-send"
                :loading="ntfyTesting"
                :disabled="!ntfyForm.topic.trim() && !settings?.ntfy.enabled"
                :label="ntfyForm.topic.trim() ? 'Send test' : 'Send test with current settings'"
                @click="testNtfy"
              />
              <UButton
                v-if="settings?.ntfy.source === 'dashboard'"
                class="ms-auto"
                color="neutral"
                variant="link"
                label="Use deployment secrets instead"
                @click="resetNtfy"
              />
            </div>
          </form>

          <template v-if="me" #footer>
            <p class="flex items-center gap-2 text-sm text-muted">
              <UIcon name="i-lucide-mail" class="size-4" />
              Email is {{ me.notifications.email ? "configured" : "not configured" }}. It is set with EMAIL_FROM and
              EMAIL_TO in wrangler.jsonc.
            </p>
          </template>
        </UCard>
      </template>

      <template #monitors>
        <div class="space-y-6">
          <!-- checks -->
          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <UIcon name="i-lucide-timer" class="size-5 text-muted" />
                <h2 class="font-semibold text-highlighted">Check frequency</h2>
              </div>
            </template>
            <div v-if="!settings" class="space-y-2" aria-busy="true" aria-label="Loading check settings">
              <USkeleton class="h-4 w-28" />
              <USkeleton class="h-3 w-full max-w-md" />
              <div class="flex gap-2">
                <USkeleton class="h-8 w-56 rounded-md" />
                <USkeleton class="h-8 w-16 rounded-md" />
              </div>
            </div>
            <div v-else class="space-y-4">
              <UFormField
                label="Default interval"
                :description="`Used by every monitor without its own interval. A monitor is marked down after two failed checks, so an outage is confirmed after about ${plural(2 * Number(interval), 'minute')}.`"
              >
                <div class="flex gap-2">
                  <USelect v-model="interval" :items="intervalItems" class="w-56" />
                  <UButton :loading="intervalSaving" :disabled="!intervalChanged" label="Save" @click="saveInterval" />
                </div>
              </UFormField>
              <div class="text-sm">
                <p v-if="overrides.length === 0" class="text-muted">All monitors use the default. Set a monitor's own interval when editing it.</p>
                <template v-else>
                  <p class="mb-2 text-muted">{{ plural(overrides.length, "monitor") }} {{ overrides.length === 1 ? "uses its" : "use their" }} own interval:</p>
                  <ul class="divide-y divide-default rounded-md border border-default">
                    <li v-for="m in overrides" :key="m.id" class="flex items-center justify-between gap-3 px-3 py-2">
                      <NuxtLink :to="`/#monitor-${m.id}`" class="truncate font-medium text-highlighted hover:underline">{{ m.name }}</NuxtLink>
                      <span class="shrink-0 text-muted">{{ formatInterval(m.checkIntervalMinutes!) }}</span>
                    </li>
                  </ul>
                </template>
              </div>
            </div>
          </UCard>

          <!-- diagnostics -->
          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <UIcon name="i-lucide-stethoscope" class="size-5 text-muted" />
                <h2 class="font-semibold text-highlighted">Failed-check diagnostics</h2>
              </div>
            </template>
            <div v-if="!settings" class="space-y-2" aria-busy="true" aria-label="Loading diagnostics settings">
              <USkeleton class="h-4 w-40" />
              <USkeleton class="h-3 w-full max-w-md" />
              <USkeleton class="h-8 w-full max-w-md rounded-md" />
            </div>
            <form v-else @submit.prevent="saveTroubleshooter">
              <UFormField
                label="Akamai troubleshooter"
                description="A page that looks up Akamai references, such as a site owner's own troubleshooter. Failed checks with an Akamai reference get a button that copies the reference and opens this page. Leave empty for no button."
              >
                <div class="flex gap-2">
                  <UInput v-model="troubleshooterUrl" type="url" placeholder="https://diagnostic.example.com/" class="w-full max-w-md" />
                  <UButton type="submit" :loading="troubleshooterSaving" :disabled="!troubleshooterChanged" label="Save" />
                </div>
              </UFormField>
            </form>
          </UCard>
        </div>
      </template>

      <template #groups>
        <!-- groups -->
        <UCard :ui="{ body: 'p-0 sm:p-0' }">
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-folders" class="size-5 text-muted" />
              <h2 class="font-semibold text-highlighted">Groups</h2>
              <UButton class="ms-auto" icon="i-lucide-plus" size="sm" label="Add group" @click="openGroupForm(null)" />
            </div>
            <p class="mt-1 text-sm text-muted">Group monitors to filter and select them together. Each monitor is in at most one group.</p>
          </template>
          <ul v-if="!groupsLoaded" class="divide-y divide-default" aria-busy="true" aria-label="Loading groups">
            <li v-for="i in 3" :key="i" class="flex items-center gap-3 px-4 py-3.5">
              <USkeleton class="h-4 w-32" />
              <USkeleton class="ms-auto h-3.5 w-16" />
              <USkeleton class="size-6 rounded-md" />
              <USkeleton class="size-6 rounded-md" />
            </li>
          </ul>
          <div v-else-if="groups.length === 0" class="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <UIcon name="i-lucide-folder-plus" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">No groups yet. Add one here, or type a group name when editing a monitor.</p>
            <UButton color="neutral" variant="outline" icon="i-lucide-plus" label="Add group" @click="openGroupForm(null)" />
          </div>
          <ul v-else class="divide-y divide-default">
            <li v-for="g in groups" :key="g.name" class="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-start font-medium text-highlighted hover:underline"
                @click="openGroupForm(g)"
              >
                {{ g.name }}
              </button>
              <span class="text-sm" :class="g.monitors ? 'text-muted' : 'text-dimmed'">{{ g.monitors ? plural(g.monitors, "monitor") : "Empty" }}</span>
              <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" :aria-label="`Edit ${g.name}`" @click="openGroupForm(g)" />
              <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" :aria-label="`Remove ${g.name}`" @click="removeGroup(g)" />
            </li>
          </ul>
        </UCard>
      </template>
    </UTabs>

    <GroupFormModal v-model:open="groupFormOpen" :group="editing" :groups="groups" :monitors="monitors" @saved="groupSaved" />

    <ConfirmModal v-model:open="confirmOpen" :options="confirmOptions" />
  </UContainer>
</template>
