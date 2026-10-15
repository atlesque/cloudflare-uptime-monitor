import { fileURLToPath } from "node:url";

// The dashboard is a client-only Nuxt app. `nuxt generate` writes static files to
// ../public, which the Worker serves as its assets (see wrangler.example.jsonc).
export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  // No web fonts: the build needs no network and the dashboard uses the system font.
  ui: { fonts: false },
  ssr: false,
  devtools: { enabled: false },
  telemetry: false,
  css: ["~/assets/css/main.css"],
  compatibilityDate: "2026-08-15",

  app: {
    head: {
      title: "Uptime Monitor",
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    },
  },

  // Icons are bundled into the client: there is no Nuxt server in production, and /api/
  // belongs to the Worker. Nuxt UI's own icons are referenced from its config, not from
  // our source files, so they are listed here for the scanner to include.
  icon: {
    provider: "none",
    serverBundle: false,
    clientBundle: {
      scan: true,
      icons: [
        "lucide:check",
        "lucide:chevron-down",
        "lucide:chevron-up",
        "lucide:chevron-left",
        "lucide:chevron-right",
        "lucide:x",
        "lucide:minus",
        "lucide:loader-circle",
        "lucide:search",
        "lucide:circle-alert",
        "lucide:circle-check",
        "lucide:circle-x",
        "lucide:info",
        "lucide:triangle-alert",
        "lucide:arrow-up-right",
        "lucide:ellipsis",
        "lucide:sun",
        "lucide:moon",
        "lucide:monitor",
      ],
    },
  },

  nitro: {
    // Generated straight into ../public, the Worker's assets directory, so existing
    // wrangler.jsonc files keep working unchanged.
    output: { publicDir: fileURLToPath(new URL("../public", import.meta.url)) },
    // `pnpm --filter dashboard dev` proxies the API to `pnpm dev` (wrangler dev on :8787).
    devProxy: { "/api": { target: "http://localhost:8787/api", changeOrigin: true } },
  },
});
