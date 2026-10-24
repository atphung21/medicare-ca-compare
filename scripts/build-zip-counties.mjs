// Builds src/data/zip-counties.json from the Census 2020 ZCTA-to-county relationship file.
// Usage: node scripts/build-zip-counties.mjs [path-to-tab20_zcta520_county20_natl.txt]
// Without a path the file is downloaded from census.gov.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SOURCE =
  "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt";
// A county that covers less than this share of a ZIP's land is a boundary sliver, not a real choice.
const MIN_LAND_SHARE = 0.05;

const root = path.resolve(import.meta.dirname, "..");
const input = process.argv[2];
const text = input
  ? await readFile(input, "utf8")
  : await fetch(SOURCE).then((response) => {
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      return response.text();
    });

const [header, ...rows] = text.replace(/^\uFEFF/, "").split(/\r?\n/);
const columns = header.split("|");
const at = (name) => columns.indexOf(name);
const zipColumn = at("GEOID_ZCTA5_20");
const zipLandColumn = at("AREALAND_ZCTA5_20");
const fipsColumn = at("GEOID_COUNTY_20");
const nameColumn = at("NAMELSAD_COUNTY_20");
const partColumn = at("AREALAND_PART");

const counties = {};
const parts = new Map();
for (const row of rows) {
  const cells = row.split("|");
  const zip = cells[zipColumn];
  const fips = cells[fipsColumn];
  if (!zip || !fips) continue;
  counties[fips] = cells[nameColumn];
  const zipLand = Number(cells[zipLandColumn]) || 0;
  const part = Number(cells[partColumn]) || 0;
  const list = parts.get(zip) ?? [];
  list.push({ fips, share: zipLand > 0 ? part / zipLand : 1 });
  parts.set(zip, list);
}

const zips = {};
for (const [zip, list] of [...parts.entries()].sort()) {
  list.sort((left, right) => right.share - left.share);
  const kept = list.filter((item, index) => index === 0 || item.share >= MIN_LAND_SHARE);
  zips[zip] = kept.map((item) => item.fips).join(",");
}

const target = path.join(root, "src", "data", "zip-counties.json");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify({ source: SOURCE, counties, zips }));
console.log(`Wrote ${Object.keys(zips).length} ZIP codes and ${Object.keys(counties).length} counties to ${target}`);
