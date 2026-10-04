// Creates your local config files from the committed templates, without overwriting existing ones.
import { copyFileSync, existsSync } from "node:fs";

for (const [from, to] of [
  ["wrangler.example.jsonc", "wrangler.jsonc"],
  [".dev.vars.example", ".dev.vars"],
]) {
  if (existsSync(to)) {
    console.log(`${to} already exists, leaving it alone.`);
  } else {
    copyFileSync(from, to);
    console.log(`Created ${to} from ${from}.`);
  }
}
