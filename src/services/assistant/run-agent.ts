import { geminiChat, type GeminiContent } from "@/lib/gemini";
import { pullKnowledge } from "./knowledge-sync";
import { readMemory } from "./memory";
import type { AssistantSession, ChatMessage, ToolEvent } from "./session";
import { runTool, toolDeclarations } from "./tools";

const MAX_STEPS = 8;

const DOMAIN_PROMPT = `You are the Medicare Compare assistant for a licensed Medicare insurance agent. You help compare Part D and Medicare Advantage drug coverage for their clients anywhere in the US.

How to work:
- Use the tools for every fact about drugs, ZIP codes, plans and prices. Never invent strengths, prices, plans or coverage.
- When the user pastes medications, call parse_medications with the lines exactly as typed. Then report each medication in one short line, and ask only about the ones whose status is not ready (offer their strength_choices or form_choices).
- Quantities are per fill: tablets and capsules count units; eye drops count mL (one 5, 10 or 15 mL bottle a month); insulin counts mL (pens are 3 mL, vials 10 mL); inhalers, creams and pens count packages.
- Diabetic supplies (test strips, lancets, sensors, pen needles) are searched on Medicare.gov by name. If Medicare.gov does not list one it is usually covered under Part B instead of Part D; say so.
- compare_plans gives sample planning estimates, not live prices. Say that, and offer run_medicare_proof for real Medicare.gov screenshots. Always ask before running run_medicare_proof, because it takes one to three minutes.
- When the user teaches you something ("remember", "always", "from now on"), save it with remember_rule. When a medication phrase was misread, teach it with teach_phrase and re-read the line. When the app cannot do something, or the user asks for a new feature, log it with log_enhancement_request so the developer can build it. This memory is shared by everyone on the team, so lessons from one computer apply on all of them; each tool result says whether the lesson was shared.
- Be brief and plain. Use short lists, not tables. Use dollar amounts as the tools give them.`;

function sessionSnapshot(session: AssistantSession) {
  const location = session.county ? `${session.zipCode} (${session.county.name}, ${session.county.state})` : "not set";
  const meds = session.medications.length > 0
    ? session.medications.map((item, index) => `${index + 1}. ${item.drug.name} ${item.drug.strength}`.trim()).join("; ")
    : "none yet";
  return `Current session: ZIP ${location}. Medications: ${meds}. Pharmacies: ${session.pharmacyIds.join(", ")}. Plan year ${session.contractYear}. Extra Help: ${session.lisLevel}. Plan type: ${session.planType}.`;
}

function historyContents(messages: ChatMessage[]): GeminiContent[] {
  return messages.map((message) => {
    const did = message.events?.length ? `\n[Tools used: ${message.events.map((event) => event.summary).join("; ")}]` : "";
    return { role: message.role === "user" ? "user" : "model", parts: [{ text: `${message.text}${did}` }] };
  });
}

export async function runAgent(messages: ChatMessage[], session: AssistantSession) {
  await pullKnowledge();
  const memory = await readMemory();
  const rules = memory.rules.length > 0
    ? `\n\nRules taught by the user or teammates. Follow them:\n${memory.rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`
    : "";
  const system = `${DOMAIN_PROMPT}${rules}\n\nToday is ${new Date().toDateString()}. ${sessionSnapshot(session)}`;
  const contents = historyContents(messages);
  const events: ToolEvent[] = [];

  for (let step = 0; step < MAX_STEPS; step += 1) {
    let reply;
    try {
      reply = await geminiChat(contents, toolDeclarations, system);
    } catch (error) {
      if (events.length === 0) throw error;
      const reason = error instanceof Error ? error.message : "Gemini stopped answering.";
      return {
        reply: `Here is what I finished before Gemini stopped answering (${reason}):\n${events.map((event) => `- ${event.summary}`).join("\n")}`,
        events,
        session,
      };
    }
    contents.push(reply);
    const calls = reply.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
    if (calls.length === 0) {
      const text = reply.parts.map((part) => part.text ?? "").join("").trim();
      return { reply: text || "Done.", events, session };
    }
    const responses = [];
    for (const call of calls) {
      const outcome = await runTool(call.name, call.args ?? {}, session);
      events.push({
        tool: call.name,
        args: call.args ?? {},
        summary: outcome.summary,
        ok: outcome.ok !== false,
        images: outcome.images,
        link: outcome.link,
      });
      responses.push({ functionResponse: { name: call.name, response: outcome.result } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return {
    reply: "I stopped after several steps without finishing. Tell me what to do next, or ask in smaller pieces.",
    events,
    session,
  };
}
