import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AssistantMemory {
  /** Plain-language instructions the assistant follows in every chat. */
  rules: string[];
  /** Lowercase phrase as typed on a medication list, mapped to the text the parser should read instead. */
  aliases: Record<string, string>;
}

const DIRECTORY = path.join(process.cwd(), "data", "agent");
const MEMORY_FILE = path.join(DIRECTORY, "memory.json");
export const REQUESTS_FILE = path.join(DIRECTORY, "requests.md");

export async function readMemory(): Promise<AssistantMemory> {
  try {
    const parsed = JSON.parse(await readFile(MEMORY_FILE, "utf8")) as Partial<AssistantMemory>;
    return {
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter((rule) => typeof rule === "string") : [],
      aliases: parsed.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {},
    };
  } catch {
    return { rules: [], aliases: {} };
  }
}

async function writeMemory(memory: AssistantMemory) {
  await mkdir(DIRECTORY, { recursive: true });
  const temporary = `${MEMORY_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(memory, null, 2)}\n`);
  await rename(temporary, MEMORY_FILE);
}

export async function addRule(rule: string) {
  const memory = await readMemory();
  const text = rule.trim();
  if (text && !memory.rules.includes(text)) memory.rules.push(text);
  await writeMemory(memory);
  return memory.rules;
}

/** Removes rules by 1-based number or by matching text. */
export async function removeRule(match: string) {
  const memory = await readMemory();
  const index = /^\d+$/.test(match.trim()) ? Number(match) - 1 : -1;
  const needle = match.trim().toLowerCase();
  const before = memory.rules.length;
  memory.rules = memory.rules.filter(
    (rule, position) => position !== index && !(index < 0 && rule.toLowerCase().includes(needle)),
  );
  await writeMemory(memory);
  return { removed: before - memory.rules.length, rules: memory.rules };
}

export async function setAlias(phrase: string, meaning: string) {
  const memory = await readMemory();
  const key = phrase.trim().toLowerCase();
  if (meaning.trim()) memory.aliases[key] = meaning.trim();
  else delete memory.aliases[key];
  await writeMemory(memory);
  return memory.aliases;
}

export async function logRequest(request: string, example?: string) {
  await mkdir(DIRECTORY, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`- [ ] ${date}: ${request.trim()}`];
  if (example?.trim()) lines.push(`  - Example: ${example.trim().replace(/\n+/g, " / ")}`);
  await appendFile(REQUESTS_FILE, `${lines.join("\n")}\n`);
}

/** Replaces taught phrases in a medication line, longest phrase first, matching whole words. */
export function applyAliases(line: string, aliases: Record<string, string>) {
  let result = line;
  for (const phrase of Object.keys(aliases).sort((left, right) => right.length - left.length)) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "gi"), aliases[phrase]);
  }
  return result;
}
