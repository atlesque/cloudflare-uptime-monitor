// Writes wrangler.jsonc from the WRANGLER_CONFIG environment variable, for Cloudflare Workers
// Builds, where the git-ignored config isn't in the checkout. Store the full contents of your
// wrangler.jsonc as a build secret named WRANGLER_CONFIG.
import { existsSync, writeFileSync } from "node:fs";

const config = process.env.WRANGLER_CONFIG;
if (config) {
  writeFileSync("wrangler.jsonc", config.endsWith("\n") ? config : `${config}\n`);
  console.log("Wrote wrangler.jsonc from WRANGLER_CONFIG.");
} else if (existsSync("wrangler.jsonc")) {
  console.log("WRANGLER_CONFIG is not set, using the existing wrangler.jsonc.");
} else {
  console.error("WRANGLER_CONFIG is not set and there is no wrangler.jsonc. Add WRANGLER_CONFIG as a build secret.");
  process.exit(1);
}
