import { active, aliasMap, findItem, newItem, type KnowledgeItem } from "@/services/assistant/knowledge";
import { knowledgeAuthor, readLocalKnowledge, updateKnowledge } from "@/services/assistant/knowledge-sync";

export interface AssistantMemory {
  /** Plain-language instructions the assistant follows in every chat. */
  rules: string[];
  /** Lowercase phrase as typed on a medication list, mapped to the text the parser should read instead. */
  aliases: Record<string, string>;
}

/** Reads the local copy only. Callers that want other computers' lessons call pullKnowledge first. */
export async function readMemory(): Promise<AssistantMemory> {
  const file = await readLocalKnowledge();
  return { rules: active(file, "rule").map((item) => item.text), aliases: aliasMap(file) };
}

export async function listKnowledge() {
  const file = await readLocalKnowledge();
  return { rules: active(file, "rule"), phrases: active(file, "phrase"), requests: active(file, "request") };
}

function touch(item: KnowledgeItem, patch: Partial<KnowledgeItem>) {
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
}

export async function addRule(rule: string) {
  const text = rule.trim();
  return updateKnowledge(`remember "${text}"`, (file) => {
    const exists = active(file, "rule").some((item) => item.text.toLowerCase() === text.toLowerCase());
    if (text && !exists) file.items.push(newItem("rule", knowledgeAuthor(), { text }));
    return active(file, "rule").map((item) => item.text);
  });
}

/** Removes rules by 1-based number, id, or matching text. */
export async function removeRule(match: string) {
  const needle = match.trim().toLowerCase();
  return updateKnowledge(`forget rule "${match.trim()}"`, (file) => {
    const rules = active(file, "rule");
    const byNumber = /^\d{1,3}$/.test(needle) ? rules[Number(needle) - 1] : undefined;
    const byId = findItem(file, needle);
    const targets = byNumber
      ? [byNumber]
      : byId?.kind === "rule"
        ? [byId]
        : rules.filter((item) => needle && item.text.toLowerCase().includes(needle));
    for (const item of targets) touch(item, { deleted: true });
    return { removed: targets.length, rules: active(file, "rule").map((item) => item.text) };
  });
}

/** An empty meaning removes the phrase. */
export async function setAlias(phrase: string, meaning: string) {
  const key = phrase.trim().toLowerCase();
  const text = meaning.trim();
  return updateKnowledge(text ? `teach "${key}" = "${text}"` : `forget phrase "${key}"`, (file) => {
    const existing = active(file, "phrase").filter((item) => item.phrase === key);
    if (!text) existing.forEach((item) => touch(item, { deleted: true }));
    else if (existing.length > 0) {
      touch(existing[0], { text, author: knowledgeAuthor() });
      existing.slice(1).forEach((item) => touch(item, { deleted: true }));
    } else if (key) file.items.push(newItem("phrase", knowledgeAuthor(), { phrase: key, text }));
    return aliasMap(file);
  });
}

export async function logRequest(request: string, example?: string) {
  const text = request.trim();
  return updateKnowledge(`request "${text}"`, (file) => {
    const item = newItem("request", knowledgeAuthor(), { text, status: "open", ...(example?.trim() ? { example: example.trim().replace(/\n+/g, " / ") } : {}) });
    file.items.push(item);
    return item;
  });
}

export async function markRequestDone(id: string) {
  return updateKnowledge(`done: request ${id.trim()}`, (file) => {
    const item = findItem(file, id);
    if (!item || item.kind !== "request") return null;
    touch(item, { status: "done" });
    return item;
  });
}

/** Deletes any rule, phrase or request by full or short id, on every computer. */
export async function removeItem(id: string) {
  return updateKnowledge(`remove ${id.trim()}`, (file) => {
    const item = findItem(file, id);
    if (item) touch(item, { deleted: true });
    return item ?? null;
  });
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
