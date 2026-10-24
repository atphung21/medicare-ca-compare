---
name: improve-from-assistant
description: Turn what the in-app Medicare assistant learned into code. Use when the user says "process the assistant's requests", "check what the assistant learned", "apply taught phrases", or asks to implement items from the team memory or knowledge repo.
---

# Improve the app from the assistant's team memory

Everything the assistant learns on any computer (Eric's or the developer's) syncs through the private repo in `KNOWLEDGE_REPO` (default `atphung21/medicare-agent-knowledge`). Each computer keeps a local copy at `data/agent/knowledge.json`. Items have a `kind` (`rule`, `phrase` or `request`), an `author`, and an `id`; requests also have a `status` (`open` or `done`).

Never edit `data/agent/knowledge.json` by hand while the app runs. Use the CLI, which merges and shares changes:

```bash
npm run knowledge -- pull          # bring in the latest from every computer
npm run knowledge -- list          # rules, phrases and requests with short ids
npm run knowledge -- done <id>     # mark a request done
npm run knowledge -- remove <id>   # delete a rule, phrase or request everywhere
npm run knowledge -- add-rule "<text>"
npm run knowledge -- add-phrase "<phrase>" "<meaning>"
```

If `status` says "Not shared", ask the user to add `KNOWLEDGE_REPO`, `KNOWLEDGE_TOKEN` and `KNOWLEDGE_AUTHOR` to `.env.local`.

## Workflow

1. Run `npm run knowledge -- pull`, then `list`. Show the user what you plan to do, grouped as parser fixes, new features and assistant behavior.
2. **Phrases**: for each phrase that names a real product or format, not a client-specific shortcut:
   - Make the parser handle it directly in `src/services/med-line-normalizer.ts` (abbreviations, supply brands, form hints) or `src/services/med-list-parser.ts`.
   - Add the original line as a case in `scripts/check-med-parser.mjs` with the expected name, strength, form and quantity.
   - Once the code ships, run `remove <id>` so the phrase doesn't mask the parser. Keep client-specific shortcuts as phrases.
3. **Requests**: implement each open one, following `.cursor/rules/medicare-domain.mdc`. If it needs a new assistant capability, add a tool in `src/services/assistant/tools.ts`.
4. **Rules**: if a rule should become the default for everyone (for example, a default pharmacy), change the default in `src/services/assistant/session.ts` or the system prompt in `run-agent.ts`, then `remove <id>` the rule.
5. Verify with `npx tsc --noEmit`, `npm run lint` and `npm run check:meds`. For parser changes, also try the example line in `/assistant` on `npm run dev`.
6. Run `done <id>` for each finished request, after the code is pushed to `main` (that's when Eric gets it). Summarize what changed and what the user should push.
