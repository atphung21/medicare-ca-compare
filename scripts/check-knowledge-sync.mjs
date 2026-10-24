// Simulates two computers (Eric and Andy) sharing assistant memory through a fake GitHub API.
// Usage: npm run check:knowledge   (offline; never touches the real knowledge repo)
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { transpileSources } from "./lib/transpile.mjs";

const load = await transpileSources("check-knowledge", [
  "services/assistant/knowledge.ts",
  "services/assistant/knowledge-sync.ts",
  "services/assistant/memory.ts",
]);
const sync = await load("services/assistant/knowledge-sync");
const memory = await load("services/assistant/memory");

/** Just enough of the GitHub contents and git data APIs, with a hook to simulate another computer pushing first. */
function fakeGitHub() {
  const trees = new Map([["t0", { "README.md": "# knowledge\n" }]]);
  const commits = new Map([["c0", { tree: "t0", parent: null }]]);
  let head = "c0";
  let counter = 0;
  const state = { beforePatch: null, patches: 0 };
  const id = (prefix) => `${prefix}${++counter}`;
  const files = (ref) => trees.get(commits.get(commits.has(ref) ? ref : head).tree);
  const commitFiles = (changes, message) => {
    const tree = id("t");
    trees.set(tree, { ...files(head), ...changes });
    const sha = id("c");
    commits.set(sha, { tree, parent: head, message });
    head = sha;
  };
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const send = (status, json) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json));
    };
    if (request.headers.authorization !== "Bearer good") return send(401, { message: "Bad credentials" });
    const url = new URL(request.url, "http://local");
    const route = url.pathname.replace(/^\/repos\/team\/knowledge\//, "");
    const input = body ? JSON.parse(body) : {};
    if (request.method === "GET" && route === "git/ref/heads/main") return send(200, { object: { sha: head } });
    if (request.method === "GET" && route.startsWith("contents/")) {
      const name = route.slice("contents/".length);
      const content = files(url.searchParams.get("ref") ?? head)[name];
      if (content === undefined) return send(404, { message: "Not Found" });
      return send(200, { sha: id("b"), content: Buffer.from(content).toString("base64") });
    }
    if (request.method === "GET" && route.startsWith("git/commits/")) {
      return send(200, { tree: { sha: commits.get(route.slice("git/commits/".length)).tree } });
    }
    if (request.method === "POST" && route === "git/trees") {
      const tree = id("t");
      const next = { ...trees.get(input.base_tree) };
      for (const entry of input.tree) next[entry.path] = entry.content;
      trees.set(tree, next);
      return send(201, { sha: tree });
    }
    if (request.method === "POST" && route === "git/commits") {
      const sha = id("c");
      commits.set(sha, { tree: input.tree, parent: input.parents[0], message: input.message });
      return send(201, { sha });
    }
    if (request.method === "PATCH" && route === "git/refs/heads/main") {
      state.patches += 1;
      if (state.beforePatch) {
        const hook = state.beforePatch;
        state.beforePatch = null;
        hook(commitFiles);
      }
      if (commits.get(input.sha).parent !== head) return send(422, { message: "Update is not a fast forward" });
      head = input.sha;
      return send(200, { object: { sha: head } });
    }
    return send(404, { message: `No fake for ${request.method} ${route}` });
  });
  return { server, state, remoteFile: (name) => files(head)[name], headMessage: () => commits.get(head).message };
}

const fake = fakeGitHub();
await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
const api = `http://127.0.0.1:${fake.server.address().port}`;
const base = await mkdtemp(path.join(os.tmpdir(), "knowledge-check-"));

function computer(author) {
  process.env.KNOWLEDGE_DIR = path.join(base, author);
  process.env.KNOWLEDGE_AUTHOR = author;
  process.env.KNOWLEDGE_REPO = "team/knowledge";
  process.env.KNOWLEDGE_TOKEN = "good";
  process.env.KNOWLEDGE_API_URL = api;
}
const remoteItems = () => JSON.parse(fake.remoteFile("knowledge.json") ?? '{"items":[]}').items;

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push([true, name]);
  } catch (error) {
    results.push([false, `${name}: ${error.message}`]);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

await check("Eric teaches a rule and it is committed with KNOWLEDGE.md", async () => {
  computer("Eric");
  const { shared } = await memory.addRule("Always include Walgreens");
  expect(shared, "push did not succeed");
  expect(remoteItems().some((item) => item.text === "Always include Walgreens" && item.author === "Eric"), "rule missing remotely");
  expect(fake.remoteFile("KNOWLEDGE.md")?.includes("Always include Walgreens"), "KNOWLEDGE.md not updated");
  expect(fake.headMessage().startsWith("Eric: remember"), `commit message was ${fake.headMessage()}`);
});

await check("Andy's assistant gets Eric's rule on pull", async () => {
  computer("Andy");
  expect((await memory.readMemory()).rules.length === 0, "Andy should start empty");
  expect(await sync.pullKnowledge({ force: true }), "pull failed");
  expect((await memory.readMemory()).rules.includes("Always include Walgreens"), "rule not pulled");
});

await check("Andy teaches a phrase and Eric's parser sees it", async () => {
  computer("Andy");
  expect((await memory.setAlias("Eliquis Starter", "apixaban 5 mg tablet")).shared, "push failed");
  computer("Eric");
  await sync.pullKnowledge({ force: true });
  const { aliases } = await memory.readMemory();
  expect(aliases["eliquis starter"] === "apixaban 5 mg tablet", `aliases were ${JSON.stringify(aliases)}`);
  expect(memory.applyAliases("eliquis starter bid", aliases) === "apixaban 5 mg tablet bid", "alias not applied");
});

await check("A delete on one computer removes the item on the other", async () => {
  computer("Eric");
  expect((await memory.removeRule("walgreens")).value.removed === 1, "rule not removed");
  computer("Andy");
  await sync.pullKnowledge({ force: true });
  expect((await memory.readMemory()).rules.length === 0, "deleted rule came back");
});

await check("Simultaneous pushes both survive", async () => {
  computer("Eric");
  fake.state.beforePatch = (commitFiles) => {
    const items = remoteItems();
    const now = new Date().toISOString();
    items.push({ id: "andy-race-item", kind: "rule", text: "Andy's rule saved at the same moment", author: "Andy", createdAt: now, updatedAt: now });
    commitFiles({ "knowledge.json": `${JSON.stringify({ version: 1, items }, null, 2)}\n` }, "Andy: race");
  };
  const patchesBefore = fake.state.patches;
  const { value, shared } = await memory.logRequest("Count fentanyl patches per month", "fentanyl 25 mcg/hr q72h");
  expect(shared, "push did not recover from the race");
  expect(fake.state.patches - patchesBefore === 2, "expected one rejected and one accepted update");
  const texts = remoteItems().map((item) => item.text);
  expect(texts.includes("Andy's rule saved at the same moment"), "the other computer's item was lost");
  expect(remoteItems().some((item) => item.id === value.id), "Eric's request was lost");
});

await check("Lessons taught offline are shared on the next pull", async () => {
  computer("Eric");
  process.env.KNOWLEDGE_API_URL = "http://127.0.0.1:9";
  const { shared } = await memory.addRule("Offline rule");
  expect(!shared, "should not have shared while offline");
  expect((await sync.syncStatus()).pendingPush, "pendingPush not set");
  process.env.KNOWLEDGE_API_URL = api;
  expect(await sync.pullKnowledge({ force: true }), "pull after reconnecting failed");
  expect(remoteItems().some((item) => item.text === "Offline rule"), "offline rule never reached GitHub");
  expect(!(await sync.syncStatus()).pendingPush, "pendingPush still set");
});

await check("Requests can be listed and marked done from either computer", async () => {
  computer("Andy");
  await sync.pullKnowledge({ force: true });
  const request = (await memory.listKnowledge()).requests.find((item) => item.text.startsWith("Count fentanyl"));
  expect(request, "request not pulled");
  expect((await memory.markRequestDone(request.id.slice(0, 8))).value, "short id did not match");
  expect(remoteItems().find((item) => item.id === request.id).status === "done", "status not shared");
});

await check("The first version's memory.json and requests.md are migrated", async () => {
  computer("Legacy");
  const directory = process.env.KNOWLEDGE_DIR;
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
  await writeFile(path.join(directory, "memory.json"), JSON.stringify({ rules: ["Old rule"], aliases: { "old phrase": "metformin 500 mg" } }));
  await writeFile(path.join(directory, "requests.md"), "- [ ] 2026-10-24: Old request\n  - Example: some line\n- [x] 2026-10-20: Finished one\n");
  const { rules, phrases, requests } = await memory.listKnowledge();
  expect(rules.length === 1 && phrases.length === 1 && requests.length === 2, "items not migrated");
  expect(requests[0].example === "some line" && requests[1].status === "done", "request details lost");
  expect((await readFile(path.join(directory, "memory.json.migrated"), "utf8")).includes("Old rule"), "old file not kept");
  expect(await sync.pullKnowledge({ force: true }), "migrated items not shared");
  expect(remoteItems().some((item) => item.text === "Old rule"), "migrated rule not on GitHub");
});

await check("A rejected token is reported instead of crashing", async () => {
  computer("Eric");
  process.env.KNOWLEDGE_TOKEN = "bad";
  const { shared } = await memory.addRule("Rule with a bad token");
  const status = await sync.syncStatus();
  expect(!shared && status.pendingPush, "should be queued");
  expect(status.lastError?.includes("KNOWLEDGE_TOKEN"), `error was ${status.lastError}`);
});

fake.server.close();
for (const [ok, name] of results) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
