import {
  active,
  emptyKnowledge,
  mergeKnowledge,
  newItem,
  parseKnowledge,
  renderKnowledgeMarkdown,
  sameKnowledge,
  serializeKnowledge,
  type KnowledgeFile,
  type KnowledgeItem,
} from "@/services/assistant/knowledge";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface SyncState {
  pendingPush: boolean;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
  lastError: string | null;
}

export interface SyncStatus extends SyncState {
  /** False when KNOWLEDGE_REPO or KNOWLEDGE_TOKEN is missing; the assistant then keeps knowledge on this computer only. */
  configured: boolean;
  repo: string | null;
  /** learnedLines counts learned medication lines and OTC markings. */
  counts: { rules: number; phrases: number; openRequests: number; learnedLines: number };
}

const PULL_INTERVAL_MS = 60_000;
const KNOWLEDGE_PATH = "knowledge.json";
const MARKDOWN_PATH = "KNOWLEDGE.md";

const directory = () => process.env.KNOWLEDGE_DIR || path.join(process.cwd(), "data", "agent");
const knowledgePath = () => path.join(directory(), "knowledge.json");
const statePath = () => path.join(directory(), "sync-state.json");

export function knowledgeAuthor() {
  const configured = process.env.KNOWLEDGE_AUTHOR?.trim();
  if (configured) return configured;
  try {
    return os.userInfo().username || "Unknown";
  } catch {
    return "Unknown";
  }
}

function remote() {
  const repo = process.env.KNOWLEDGE_REPO?.trim();
  const token = process.env.KNOWLEDGE_TOKEN?.trim();
  if (!repo || !token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { repo, token, branch: process.env.KNOWLEDGE_BRANCH?.trim() || "main" };
}

export function knowledgeSharingConfigured() {
  return remote() !== null;
}

let queue: Promise<unknown> = Promise.resolve();
/** Local file updates and pushes run one at a time, so two chats can't overwrite each other's lessons. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function writeAtomic(file: string, contents: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

async function readText(file: string) {
  return readFile(file, "utf8").catch(() => null);
}

async function readState(): Promise<SyncState> {
  const fallback: SyncState = { pendingPush: false, lastPulledAt: null, lastPushedAt: null, lastError: null };
  try {
    return { ...fallback, ...(JSON.parse((await readText(statePath())) ?? "{}") as Partial<SyncState>) };
  } catch {
    return fallback;
  }
}

async function patchState(patch: Partial<SyncState>) {
  const state = { ...(await readState()), ...patch };
  await writeAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export async function readLocalKnowledge(): Promise<KnowledgeFile> {
  const raw = await readText(knowledgePath());
  if (raw !== null) return parseKnowledge(raw);
  return migrateLegacy();
}

/** Converts the first version's memory.json and requests.md into knowledge items, once. */
async function migrateLegacy(): Promise<KnowledgeFile> {
  const memoryFile = path.join(directory(), "memory.json");
  const requestsFile = path.join(directory(), "requests.md");
  const memoryRaw = await readText(memoryFile);
  const requestsRaw = await readText(requestsFile);
  if (memoryRaw === null && requestsRaw === null) return emptyKnowledge();
  const author = knowledgeAuthor();
  const items: KnowledgeItem[] = [];
  try {
    const memory = JSON.parse(memoryRaw ?? "{}") as { rules?: unknown; aliases?: unknown };
    for (const rule of Array.isArray(memory.rules) ? memory.rules : []) {
      if (typeof rule === "string" && rule.trim()) items.push(newItem("rule", author, { text: rule.trim() }));
    }
    const aliases = memory.aliases && typeof memory.aliases === "object" ? (memory.aliases as Record<string, unknown>) : {};
    for (const [phrase, meaning] of Object.entries(aliases)) {
      if (typeof meaning === "string") items.push(newItem("phrase", author, { phrase: phrase.toLowerCase(), text: meaning }));
    }
  } catch {
    // An unreadable memory.json has nothing worth keeping.
  }
  for (const line of (requestsRaw ?? "").split(/\r?\n/)) {
    const request = line.match(/^- \[( |x)\] (?:\d{4}-\d{2}-\d{2}: )?(.+)$/);
    const example = line.match(/^\s+- Example: (.+)$/);
    if (request) items.push(newItem("request", author, { text: request[2].trim(), status: request[1] === "x" ? "done" : "open" }));
    else if (example && items.at(-1)?.kind === "request") items[items.length - 1].example = example[1].trim();
  }
  const file: KnowledgeFile = { version: 1, items };
  await writeAtomic(knowledgePath(), serializeKnowledge(file));
  await patchState({ pendingPush: true });
  if (memoryRaw !== null) await rename(memoryFile, `${memoryFile}.migrated`).catch(() => undefined);
  if (requestsRaw !== null) await rename(requestsFile, `${requestsFile}.migrated`).catch(() => undefined);
  return file;
}

async function writeLocalKnowledge(file: KnowledgeFile) {
  await writeAtomic(knowledgePath(), serializeKnowledge(file));
}

/**
 * Applies a change to the local copy, then shares it. Returns whether the change reached GitHub;
 * if not, it stays queued and goes out with the next successful pull or change.
 */
export function updateKnowledge<T>(
  message: string,
  change: (file: KnowledgeFile) => T,
): Promise<{ value: T; shared: boolean }> {
  return exclusive(async () => {
    const file = await readLocalKnowledge();
    const value = change(file);
    await writeLocalKnowledge(file);
    await patchState({ pendingPush: true });
    const shared = await pushLocked(message);
    return { value, shared };
  });
}

let lastPullAttempt = 0;

/** Brings in what other computers taught. Throttled, and silent when offline, so it is safe before every message. */
export async function pullKnowledge(options: { force?: boolean } = {}) {
  const target = remote();
  if (!target) return false;
  if (!options.force && Date.now() - lastPullAttempt < PULL_INTERVAL_MS) return false;
  lastPullAttempt = Date.now();
  return exclusive(async () => {
    const state = await readState();
    if (state.pendingPush) return pushLocked("Share lessons saved while offline");
    try {
      const remoteFile = await fetchRemoteKnowledge(target, target.branch);
      const local = await readLocalKnowledge();
      const merged = mergeKnowledge(local, remoteFile.file);
      await writeLocalKnowledge(merged);
      await patchState({ lastPulledAt: new Date().toISOString(), lastError: null });
      if (!sameKnowledge(merged, remoteFile.file)) return pushLocked("Share local lessons");
      return true;
    } catch (error) {
      await patchState({ lastError: describe(error) });
      return false;
    }
  });
}

export function pushKnowledge(message: string) {
  return exclusive(() => pushLocked(message));
}

async function pushLocked(message: string): Promise<boolean> {
  const target = remote();
  if (!target) return false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await github(target, "GET", `git/ref/heads/${target.branch}`);
      if (head.status === 404 || head.status === 409) {
        throw new Error(`The ${target.branch} branch of ${target.repo} was not found. Create the repo with a README first.`);
      }
      const parent = expectOk(head).object.sha;
      const remoteFile = await fetchRemoteKnowledge(target, parent);
      const merged = mergeKnowledge(await readLocalKnowledge(), remoteFile.file);
      await writeLocalKnowledge(merged);
      if (remoteFile.exists && sameKnowledge(merged, remoteFile.file)) {
        await patchState({ pendingPush: false, lastPulledAt: new Date().toISOString(), lastError: null });
        return true;
      }
      const baseTree = expectOk(await github(target, "GET", `git/commits/${parent}`)).tree.sha;
      const tree = expectOk(
        await github(target, "POST", "git/trees", {
          base_tree: baseTree,
          tree: [
            { path: KNOWLEDGE_PATH, mode: "100644", type: "blob", content: serializeKnowledge(merged) },
            { path: MARKDOWN_PATH, mode: "100644", type: "blob", content: renderKnowledgeMarkdown(merged) },
          ],
        }),
      ).sha;
      const author = knowledgeAuthor();
      const commit = expectOk(
        await github(target, "POST", "git/commits", {
          message: `${author}: ${message}`.slice(0, 200),
          tree,
          parents: [parent],
          author: { name: author, email: "assistant@medicare-compare.local", date: new Date().toISOString() },
        }),
      ).sha;
      const moved = await github(target, "PATCH", `git/refs/heads/${target.branch}`, { sha: commit, force: false });
      if (moved.status === 422 || moved.status === 409) continue;
      expectOk(moved);
      const now = new Date().toISOString();
      await patchState({ pendingPush: false, lastPushedAt: now, lastPulledAt: now, lastError: null });
      return true;
    }
    throw new Error("Another computer kept saving at the same moment. The lesson will be shared next time.");
  } catch (error) {
    await patchState({ pendingPush: true, lastError: describe(error) });
    return false;
  }
}

async function fetchRemoteKnowledge(target: NonNullable<ReturnType<typeof remote>>, ref: string) {
  const response = await github(target, "GET", `contents/${KNOWLEDGE_PATH}?ref=${encodeURIComponent(ref)}`);
  if (response.status === 404) return { exists: false, file: emptyKnowledge() };
  const body = expectOk(response);
  const raw = body.content ? Buffer.from(body.content, "base64").toString("utf8") : await downloadRaw(body);
  return { exists: true, file: parseKnowledge(raw) };
}

/** The contents API omits the body for files over 1 MB; fetch the raw download instead. */
async function downloadRaw(body: { download_url?: string }) {
  if (!body.download_url) return "";
  const response = await fetch(body.download_url, { signal: AbortSignal.timeout(10000) });
  return response.ok ? response.text() : "";
}

async function github(
  target: NonNullable<ReturnType<typeof remote>>,
  method: "GET" | "POST" | "PATCH",
  apiPath: string,
  body?: unknown,
) {
  const api = process.env.KNOWLEDGE_API_URL || "https://api.github.com";
  const response = await fetch(`${api}/repos/${target.repo}/${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  const json = (await response.json().catch(() => ({}))) as GitHubJson;
  return { status: response.status, json };
}

interface GitHubJson {
  sha?: string;
  object?: { sha: string };
  tree?: { sha: string };
  content?: string;
  download_url?: string;
  message?: string;
}

function expectOk(response: { status: number; json: GitHubJson }) {
  if (response.status >= 200 && response.status < 300) return response.json as Required<GitHubJson>;
  if (response.status === 401) throw new Error("GitHub rejected KNOWLEDGE_TOKEN. It may have expired; make a new one.");
  if (response.status === 403 || response.status === 404) {
    throw new Error("KNOWLEDGE_TOKEN cannot read or write the knowledge repo. Check its repository access and Contents permission.");
  }
  throw new Error(`GitHub returned ${response.status}: ${response.json.message ?? "unknown error"}`);
}

function describe(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return "GitHub did not answer in time (offline?).";
  if (error instanceof TypeError) return "Could not reach GitHub (offline?).";
  return error instanceof Error ? error.message : String(error);
}

export async function syncStatus(): Promise<SyncStatus> {
  const target = remote();
  const [state, file] = await Promise.all([readState(), readLocalKnowledge()]);
  return {
    ...state,
    configured: Boolean(target),
    repo: target?.repo ?? null,
    counts: {
      rules: active(file, "rule").length,
      phrases: active(file, "phrase").length,
      openRequests: active(file, "request").filter((item) => item.status !== "done").length,
      learnedLines: active(file, "line").length + active(file, "otc").length,
    },
  };
}
