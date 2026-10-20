<script setup lang="ts">
import type { Diagnosis, ProbeDiagnostics } from "~/types";

const props = defineProps<{ diagnostics: ProbeDiagnostics; diagnosis: Diagnosis | null }>();
const { me } = useMe();
const toast = useToast();

// Which text was just copied: "body" or a reference value.
const copied = ref<string | null>(null);
async function copy(key: string, text: string) {
  await navigator.clipboard.writeText(text);
  copied.value = key;
  setTimeout(() => copied.value === key && (copied.value = null), 1500);
}

const verdict = computed(() => {
  const d = props.diagnosis;
  if (!d?.source) return null;
  if (d.blocked) return { color: "warning" as const, icon: "i-lucide-shield-alert", title: `Blocked by ${d.source}` };
  return { color: "info" as const, icon: "i-lucide-info", title: `Response from ${d.source}` };
});

type Reference = Diagnosis["references"][number];

// Akamai's support team knows its references by their leading "#".
const isAkamai = (r: Reference) => r.label.startsWith("Akamai");
const shown = (r: Reference) => (isAkamai(r) ? `#${r.value}` : r.value);

// The troubleshooter can't be prefilled from its URL, so the reference goes to the clipboard first.
async function troubleshoot(r: Reference) {
  const url = me.value?.akamaiTroubleshooterUrl;
  if (!url) return;
  window.open(url, "_blank", "noopener");
  try {
    await navigator.clipboard.writeText(shown(r));
    toast.add({ title: "Reference copied", description: "Paste it into the troubleshooter's reference field.", icon: "i-lucide-clipboard-check" });
  } catch {
    // The page still opens; the reference stays selectable above.
  }
}
</script>

<template>
  <div class="space-y-4 text-sm">
    <div v-if="diagnosis?.references.length" class="space-y-2">
      <div
        v-for="item in diagnosis.references"
        :key="item.label"
        class="flex items-start gap-3 rounded-md border border-default bg-elevated/50 px-3 py-2"
      >
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium text-muted">{{ item.label }}</div>
          <div class="font-mono text-base font-semibold break-all text-highlighted select-all">{{ shown(item) }}</div>
          <p v-if="item.meaning" class="mt-0.5 text-xs text-muted">{{ item.meaning }}</p>
          <UButton
            v-if="isAkamai(item) && me?.akamaiTroubleshooterUrl"
            class="mt-2"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-external-link"
            label="Look up in troubleshooter"
            @click="troubleshoot(item)"
          />
        </div>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="copied === item.value ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="copied === item.value ? 'Copied' : 'Copy'"
          @click="copy(item.value, shown(item))"
        />
      </div>
    </div>

    <UAlert v-if="verdict && diagnosis" :color="verdict.color" variant="subtle" :icon="verdict.icon" :title="verdict.title">
      <template #description>
        <ul class="list-disc space-y-0.5 ps-4">
          <li v-for="signal in diagnosis.signals" :key="signal" class="break-words">{{ signal }}</li>
        </ul>
      </template>
    </UAlert>
    <ul v-else-if="diagnosis?.signals.length" class="list-disc space-y-0.5 ps-4 text-muted">
      <li v-for="signal in diagnosis.signals" :key="signal" class="break-words">{{ signal }}</li>
    </ul>

    <div v-if="diagnostics.redirects.length">
      <div class="mb-1 text-xs font-medium text-muted">Redirects</div>
      <ol class="space-y-0.5 font-mono text-xs">
        <li v-for="(hop, i) in diagnostics.redirects" :key="i" class="break-all">
          {{ hop.status }} {{ hop.url }} → {{ hop.location }}
        </li>
      </ol>
    </div>

    <div>
      <div class="mb-1 text-xs font-medium text-muted">Requested URL</div>
      <div class="font-mono text-xs break-all">{{ diagnostics.url }}</div>
    </div>

    <div>
      <div class="mb-1 text-xs font-medium text-muted">Response headers</div>
      <p v-if="!diagnostics.headers" class="text-muted">No response arrived.</p>
      <div v-else class="max-h-64 overflow-auto rounded-md border border-default">
        <table class="w-full font-mono text-xs">
          <tbody>
            <tr v-for="([name, value], i) in diagnostics.headers" :key="i" class="border-b border-default last:border-0 align-top">
              <td class="px-2 py-1 whitespace-nowrap text-muted">{{ name }}</td>
              <td class="px-2 py-1 break-all">{{ value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="diagnostics.headers">
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted">
          Response body<template v-if="diagnostics.bodyTruncated"> (first 16 KB)</template>
        </span>
        <UButton
          v-if="diagnostics.body"
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="copied === 'body' ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="copied === 'body' ? 'Copied' : 'Copy'"
          @click="copy('body', diagnostics.body ?? '')"
        />
      </div>
      <p v-if="!diagnostics.body" class="text-muted">Empty body.</p>
      <pre
        v-else
        class="max-h-80 overflow-auto rounded-md border border-default bg-elevated/50 p-2 font-mono text-xs whitespace-pre-wrap break-all"
      >{{ diagnostics.body }}</pre>
    </div>
  </div>
</template>
