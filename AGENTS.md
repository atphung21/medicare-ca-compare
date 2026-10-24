<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project map

- `/` (`src/components/compare-workspace.tsx`): the comparison form. Medication paste box in `chat-drug-intake.tsx`; draft-to-medication conversion in `src/lib/draft-cards.ts`.
- `/assistant` (`src/components/assistant-chat.tsx`): Gemini chat that runs the same services as tools. Server: `src/app/api/agent/route.ts`, then `src/services/assistant/run-agent.ts` (loop and system prompt), `tools.ts` (tool registry), `memory.ts` (rules, taught phrases, requests), synced across computers by `knowledge-sync.ts` through the private `KNOWLEDGE_REPO`. Terminal access: `npm run knowledge -- help`.
- Parsing: `src/services/med-line-normalizer.ts` (one line to name, strength, frequency and form hints), `med-list-parser.ts` (RxNorm lookup and drafts), `rxnorm-resolver.ts`, `drug-spellcheck.ts`, `src/lib/strength.ts`.
- Location: `src/lib/us-location.ts` with `src/data/zip-counties.json` (built by `scripts/build-zip-counties.mjs`); `GET /api/location?zip=`.
- Pricing: `src/services/medicare-compare.ts` (sample plans, not live prices), `lis.ts` (Extra Help, Part D cap).
- Medicare.gov proof: `src/services/medicare-agent.ts` (Playwright), `POST /api/medicare/proof`, screenshots in `data/proofs/`.
- Client PC: `scripts/client/setup-windows.ps1` (one-time) and `start-windows.ps1`/`.bat` (auto-update launcher).
- Checks: `npm run check:meds` (real-world medication lines), `npx tsc --noEmit`, `npm run lint`.
- To work through what the assistant learned, use the `improve-from-assistant` skill.
