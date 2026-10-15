# Contributing

Thanks for helping out. The project is intentionally small: one Worker, one D1 database and a
client-only Nuxt dashboard in `dashboard/` that is built into `public/` and served by the Worker.

```bash
pnpm install
pnpm run setup    # local wrangler.jsonc and .dev.vars (both git-ignored)
pnpm test         # builds the dashboard first, since the Worker serves it
pnpm typecheck    # Worker and dashboard
```

- Keep personal values (domains, addresses, IDs) out of the code and out of
  `wrangler.example.jsonc`. New settings belong in `vars` there, with a comment, a safe default,
  a row in the README's *Configuration* table, and (after running `pnpm types`) an updated
  `worker-configuration.d.ts`.
- Add or update tests for behavior changes. Tests run against `wrangler.example.jsonc`, so they
  need no Cloudflare account.
- Database changes are new files in `migrations/`; never edit an applied migration.
- Open an issue first for larger changes.
