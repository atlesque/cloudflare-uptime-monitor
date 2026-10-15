<script setup lang="ts">
const { monitors } = useMonitors();
const route = useRoute();

const downCount = computed(() => monitors.value.filter((m) => m.state === "down").length);
useHead({ title: () => `${downCount.value > 0 ? `(${downCount.value} down) ` : ""}Uptime Monitor` });

const colorMode = useColorMode();
const colorModeIcon = computed(() =>
  colorMode.preference === "system" ? "i-lucide-monitor" : colorMode.preference === "dark" ? "i-lucide-moon" : "i-lucide-sun",
);
function cycleColorMode() {
  const order = ["system", "light", "dark"];
  colorMode.preference = order[(order.indexOf(colorMode.preference) + 1) % order.length]!;
}

const nav = computed(() => [
  { label: "Monitors", icon: "i-lucide-activity", to: "/", active: route.path === "/" },
  { label: "Settings", icon: "i-lucide-settings", to: "/settings", active: route.path === "/settings" },
]);
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }">
    <div class="min-h-screen bg-muted/40">
      <header class="sticky top-0 z-20 border-b border-default bg-default/80 backdrop-blur">
        <UContainer class="flex h-14 max-w-screen-2xl items-center gap-3">
          <NuxtLink to="/" class="flex items-center gap-2.5">
            <span class="relative flex size-3">
              <span v-if="downCount > 0" class="absolute inline-flex size-full animate-ping rounded-full bg-error opacity-60" />
              <span class="relative inline-flex size-3 rounded-full" :class="downCount > 0 ? 'bg-error' : 'bg-success'" />
            </span>
            <span class="hidden font-semibold text-highlighted sm:inline">Uptime Monitor</span>
          </NuxtLink>
          <UNavigationMenu :items="nav" class="ms-2" />
          <UTooltip :text="`Theme: ${colorMode.preference}`">
            <UButton class="ms-auto" :icon="colorModeIcon" color="neutral" variant="ghost" aria-label="Switch theme" @click="cycleColorMode" />
          </UTooltip>
        </UContainer>
      </header>
      <NuxtPage />
    </div>
  </UApp>
</template>
