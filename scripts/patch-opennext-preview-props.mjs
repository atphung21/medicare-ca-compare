import { readFileSync, writeFileSync } from "node:fs";

const file = "node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js";
const source = readFileSync(file, "utf8");
const current = "**/{*-manifest,required-server-files,prefetch-hints}.json";
const next = "**/{*-manifest,required-server-files,prefetch-hints,preview-props}.json";
if (!source.includes(current)) {
  process.exit(0);
}
writeFileSync(file, source.replace(current, next));
