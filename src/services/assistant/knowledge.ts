export type KnowledgeKind = "rule" | "phrase" | "request";

export interface KnowledgeItem {
  /** Random UUID, never reused. */
  id: string;
  kind: KnowledgeKind;
  /** Rule text, what a phrase means, or the requested change. */
  text: string;
  /** Kind "phrase": the words as typed on a medication list, lowercase. */
  phrase?: string;
  /** Kind "request": a real line that shows the problem. */
  example?: string;
  /** Kind "request". */
  status?: "open" | "done";
  author: string;
  createdAt: string;
  updatedAt: string;
  /** Kept as a tombstone so a delete syncs to other computers instead of coming back. */
  deleted?: boolean;
}

export interface KnowledgeFile {
  version: 1;
  items: KnowledgeItem[];
}

export function emptyKnowledge(): KnowledgeFile {
  return { version: 1, items: [] };
}

export function parseKnowledge(raw: string | null | undefined): KnowledgeFile {
  if (!raw) return emptyKnowledge();
  try {
    const parsed = JSON.parse(raw) as Partial<KnowledgeFile>;
    const items = Array.isArray(parsed.items) ? parsed.items.filter(isItem) : [];
    return { version: 1, items };
  } catch {
    return emptyKnowledge();
  }
}

function isItem(value: unknown): value is KnowledgeItem {
  const item = value as KnowledgeItem;
  return (
    typeof item === "object" &&
    item !== null &&
    typeof item.id === "string" &&
    (item.kind === "rule" || item.kind === "phrase" || item.kind === "request") &&
    typeof item.text === "string" &&
    typeof item.updatedAt === "string"
  );
}

export function serializeKnowledge(file: KnowledgeFile) {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Union by id; the copy with the newer updatedAt wins, so edits and deletes from any computer survive. */
export function mergeKnowledge(...files: KnowledgeFile[]): KnowledgeFile {
  const byId = new Map<string, KnowledgeItem>();
  for (const file of files) {
    for (const item of file.items) {
      const current = byId.get(item.id);
      if (!current || item.updatedAt > current.updatedAt) byId.set(item.id, item);
    }
  }
  const items = [...byId.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  return { version: 1, items };
}

export function sameKnowledge(left: KnowledgeFile, right: KnowledgeFile) {
  return serializeKnowledge(left) === serializeKnowledge(right);
}

export function newItem(
  kind: KnowledgeKind,
  author: string,
  fields: Pick<KnowledgeItem, "text"> & Partial<KnowledgeItem>,
): KnowledgeItem {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), kind, author, createdAt: now, updatedAt: now, ...fields };
}

export function active(file: KnowledgeFile, kind: KnowledgeKind) {
  return file.items.filter((item) => item.kind === kind && !item.deleted);
}

/** Taught phrases for the parser. If two computers taught the same phrase, the newest meaning wins. */
export function aliasMap(file: KnowledgeFile) {
  const aliases: Record<string, string> = {};
  const newest: Record<string, string> = {};
  for (const item of active(file, "phrase")) {
    const phrase = item.phrase?.trim().toLowerCase();
    if (!phrase || !item.text.trim()) continue;
    if (!newest[phrase] || item.updatedAt > newest[phrase]) {
      newest[phrase] = item.updatedAt;
      aliases[phrase] = item.text.trim();
    }
  }
  return aliases;
}

export const shortId = (id: string) => id.slice(0, 8);

/** Finds an item by full or short id. */
export function findItem(file: KnowledgeFile, id: string) {
  const needle = id.trim().toLowerCase();
  if (needle.length < 4) return undefined;
  return file.items.find((item) => !item.deleted && item.id.toLowerCase().startsWith(needle));
}

/** Readable copy committed next to knowledge.json, for reviewing on GitHub. */
export function renderKnowledgeMarkdown(file: KnowledgeFile) {
  const by = (item: KnowledgeItem) => `_${item.author}, ${item.updatedAt.slice(0, 10)}, id ${shortId(item.id)}_`;
  const rules = active(file, "rule");
  const phrases = active(file, "phrase");
  const requests = active(file, "request");
  const open = requests.filter((item) => item.status !== "done");
  const done = requests.filter((item) => item.status === "done");
  const section = (title: string, lines: string[]) =>
    [`## ${title}`, "", ...(lines.length > 0 ? lines : ["_None yet._"]), ""].join("\n");
  const request = (item: KnowledgeItem) =>
    `- [${item.status === "done" ? "x" : " "}] ${item.text} ${by(item)}${item.example ? `\n  - Example: ${item.example}` : ""}`;
  return [
    "# Medicare assistant knowledge",
    "",
    "Generated from `knowledge.json` on every change. Edit the JSON (keep the ids), or teach the assistant, or use `npm run knowledge` in the app repo.",
    "",
    section("Rules", rules.map((item) => `- ${item.text} ${by(item)}`)),
    section("Taught phrases", phrases.map((item) => `- "${item.phrase}" means "${item.text}" ${by(item)}`)),
    section("Open requests", open.map(request)),
    section("Done requests", done.map(request)),
  ].join("\n");
}
