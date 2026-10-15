<script setup lang="ts">
import type { Diagnosis, ProbeDiagnostics } from "~/types";

const props = defineProps<{ diagnostics: ProbeDiagnostics; diagnosis: Diagnosis | null }>();

const copied = ref(false);
async function copyBody() {
  await navigator.clipboard.writeText(props.diagnostics.body ?? "");
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

const verdict = computed(() => {
  const d = props.diagnosis;
  if (!d?.source) return null;
  if (d.blocked) return { color: "warning" as const, icon: "i-lucide-shield-alert", title: `Blocked by ${d.source}` };
  return { color: "info" as const, icon: "i-lucide-info", title: `Response from ${d.source}` };
});
</script>

<template>
  <div class="space-y-4 text-sm">
    <UAlert v-if="verdict && diagnosis" :color="verdict.color" variant="subtle" :icon="verdict.icon" :title="verdict.title">
      <template #description>
        <div v-if="diagnosis.reference" class="mb-1">
          Reference <span class="font-mono select-all">{{ diagnosis.reference }}</span>
        </div>
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
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="copied ? 'Copied' : 'Copy'"
          @click="copyBody"
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
