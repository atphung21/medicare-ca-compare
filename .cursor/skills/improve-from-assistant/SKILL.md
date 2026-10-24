---
name: improve-from-assistant
description: Turn what the in-app Medicare assistant learned into code. Use when the user says "process the assistant's requests", "check what the assistant learned", "apply taught phrases", or asks to implement items from data/agent/requests.md.
---

# Improve the app from the assistant's notes

The in-app assistant (`/assistant`) writes two files on whichever computer it runs on. Both are gitignored.

- `data/agent/requests.md`: unchecked `- [ ]` items are features or misreads the user asked for, often with an `Example:` line.
- `data/agent/memory.json`: `rules` (behavior instructions) and `aliases` (phrase -> what the parser should read).

If the notes came from the client PC, ask the user to paste them, or to copy `C:\MedicareCompare\data\agent\` over.

## Workflow

1. Read both files and list what you plan to do, grouped as parser fixes, new features and assistant behavior.
2. **Aliases**: for each phrase that names a real product or format, not a client-specific shortcut:
   - Make the parser handle it directly in `src/services/med-line-normalizer.ts` (abbreviations, supply brands, form hints) or `src/services/med-list-parser.ts`.
   - Add the original line as a case in `scripts/check-med-parser.mjs` with the expected name, strength, form and quantity.
   - Then tell the user the alias can be deleted (the assistant can do it with "forget the phrase …"). Leave client-specific shortcuts as aliases.
3. **Requests**: implement each one. Follow `.cursor/rules/medicare-domain.mdc`. If a request needs a new assistant capability, add a tool in `src/services/assistant/tools.ts`.
4. **Rules**: if a rule should become the default for everyone (for example, a default pharmacy), change the default in `src/services/assistant/session.ts` or the system prompt in `run-agent.ts`, and tell the user which rule is now redundant.
5. Verify with `npx tsc --noEmit`, `npm run lint` and `npm run check:meds`. For parser changes, also paste the example line into `/assistant` on `npm run dev`.
6. Mark finished items `- [x]` in `requests.md`, and summarize what changed and what the user should push.
