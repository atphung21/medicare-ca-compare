// Reads and edits the assistant's shared team memory (rules, taught phrases, requests) from the terminal.
// Uses the same KNOWLEDGE_* settings in .env.local as the app. Run `npm run knowledge -- help` for commands.
import nextEnv from "@next/env";
import { root, transpileSources } from "./lib/transpile.mjs";

nextEnv.loadEnvConfig(root, false, { info: () => undefined, error: console.error });

const load = await transpileSources("knowledge-cli", [
  "services/assistant/knowledge.ts",
  "services/assistant/knowledge-sync.ts",
  "services/assistant/memory.ts",
]);
const { active, shortId } = await load("services/assistant/knowledge");
const { knowledgeSharingConfigured, pullKnowledge, pushKnowledge, readLocalKnowledge, syncStatus } = await load("services/assistant/knowledge-sync");
const memory = await load("services/assistant/memory");

const HELP = `npm run knowledge -- <command>

  status                         Where the memory is shared and whether this computer is in sync
  pull                           Bring in what other computers taught
  list                           Show rules, phrases and requests with their ids
  add-rule "<text>"              Add a rule every assistant follows
  add-phrase "<phrase>" "<meaning>"  Teach the medication reader a phrase
  request "<text>" ["<example>"] Log a request
  done <id>                      Mark a request done
  remove <id>                    Delete any rule, phrase or request
  push                           Share changes saved while offline`;

const [command = "help", ...args] = process.argv.slice(2);

function report(shared) {
  if (shared) console.log("Shared with the team.");
  else if (knowledgeSharingConfigured()) console.log("Saved on this computer; run `npm run knowledge -- push` once online.");
  else console.log("Saved on this computer only (no KNOWLEDGE_TOKEN in .env.local).");
}

function line(item) {
  const by = `(${item.author}, ${item.updatedAt.slice(0, 10)})`;
  if (item.kind === "phrase") return `  ${shortId(item.id)}  "${item.phrase}" means "${item.text}" ${by}`;
  if (item.kind === "request") {
    return `  ${shortId(item.id)}  [${item.status === "done" ? "x" : " "}] ${item.text} ${by}${item.example ? `\n            Example: ${item.example}` : ""}`;
  }
  return `  ${shortId(item.id)}  ${item.text} ${by}`;
}

async function need(count, usage) {
  if (args.length < count || args.slice(0, count).some((value) => !value.trim())) {
    console.error(`Usage: npm run knowledge -- ${usage}`);
    process.exit(1);
  }
}

switch (command) {
  case "status": {
    const status = await syncStatus();
    console.log(status.configured ? `Shared through ${status.repo}` : "Not shared: set KNOWLEDGE_REPO and KNOWLEDGE_TOKEN in .env.local.");
    console.log(`${status.counts.rules} rules, ${status.counts.phrases} phrases, ${status.counts.openRequests} open requests`);
    console.log(`Last pulled: ${status.lastPulledAt ?? "never"} · Last pushed: ${status.lastPushedAt ?? "never"}`);
    if (status.pendingPush) console.log("Changes are waiting to be shared.");
    if (status.lastError) console.log(`Last problem: ${status.lastError}`);
    break;
  }
  case "pull": {
    const ok = await pullKnowledge({ force: true });
    const status = await syncStatus();
    if (!status.configured) console.log("Not shared: set KNOWLEDGE_REPO and KNOWLEDGE_TOKEN in .env.local.");
    else if (ok) console.log(`Up to date: ${status.counts.rules} rules, ${status.counts.phrases} phrases, ${status.counts.openRequests} open requests.`);
    else {
      console.error(`Could not sync: ${status.lastError ?? "unknown problem"}`);
      process.exit(1);
    }
    break;
  }
  case "list": {
    await pullKnowledge({ force: true });
    const file = await readLocalKnowledge();
    for (const [title, kind] of [["Rules", "rule"], ["Taught phrases", "phrase"], ["Requests", "request"]]) {
      const items = active(file, kind).sort((left, right) => (left.status === "done") - (right.status === "done"));
      console.log(`${title}:`);
      console.log(items.length > 0 ? items.map(line).join("\n") : "  none");
    }
    break;
  }
  case "add-rule": {
    await need(1, 'add-rule "<text>"');
    report((await memory.addRule(args[0])).shared);
    break;
  }
  case "add-phrase": {
    await need(2, 'add-phrase "<phrase>" "<meaning>"');
    report((await memory.setAlias(args[0], args[1])).shared);
    break;
  }
  case "request": {
    await need(1, 'request "<text>" ["<example>"]');
    const { value, shared } = await memory.logRequest(args[0], args[1]);
    console.log(`Logged ${shortId(value.id)}.`);
    report(shared);
    break;
  }
  case "done":
  case "remove": {
    await need(1, `${command} <id>`);
    await pullKnowledge({ force: true });
    const { value, shared } = command === "done" ? await memory.markRequestDone(args[0]) : await memory.removeItem(args[0]);
    if (!value) {
      console.error(`Nothing ${command === "done" ? "requested " : ""}has id ${args[0]}. Run \`npm run knowledge -- list\` for ids.`);
      process.exit(1);
    }
    console.log(`${command === "done" ? "Marked done" : "Removed"}: ${value.text}`);
    report(shared);
    break;
  }
  case "push": {
    const ok = await pushKnowledge("Share lessons saved while offline");
    const status = await syncStatus();
    if (ok) console.log("Shared with the team.");
    else {
      console.error(status.configured ? `Could not share: ${status.lastError}` : "Not shared: set KNOWLEDGE_REPO and KNOWLEDGE_TOKEN in .env.local.");
      process.exit(1);
    }
    break;
  }
  default:
    console.log(HELP);
}
