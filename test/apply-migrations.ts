import { setTimeZone } from "../src/time";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Direct calls into src/time.ts (outside a request) use the same zone the Worker would.
setTimeZone(env.TIME_ZONE);
