export function geminiGenerateUrl(model = process.env.GEMINI_MODEL || "gemini-flash-latest") {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
  /** Gemini 3 requires the signature it sent with a function call to be echoed back in the history. */
  thoughtSignature?: string;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** Google retires and slows models without notice, so the assistant falls back to the lite model. */
function chatModels() {
  const primary = process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_MODEL || "gemini-flash-latest";
  return [...new Set([primary, "gemini-flash-lite-latest"])];
}

/** One function-calling turn. Returns the model's content so the caller can append it to the history unchanged. */
export async function geminiChat(
  contents: GeminiContent[],
  functionDeclarations: GeminiFunctionDeclaration[],
  systemInstruction: string,
): Promise<GeminiContent> {
  let lastError: Error | null = null;
  for (const model of chatModels()) {
    try {
      return await chatOnce(model, contents, functionDeclarations, systemInstruction);
    } catch (error) {
      lastError =
        error instanceof Error && error.name === "TimeoutError"
          ? new Error(`Gemini (${model}) took too long to answer. Try again in a minute.`)
          : error instanceof Error
            ? error
            : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Gemini gave no answer.");
}

/** One JSON answer to a prompt, or null when there is no key, the call fails, or it takes too long. */
export async function geminiJson<T>(
  prompt: string,
  options: { model?: string; timeoutMs?: number } = {},
): Promise<T | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const response = await fetch(geminiGenerateUrl(options.model), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const raw =
      body?.candidates?.[0]?.content?.parts?.map((part: GeminiPart) => part.text ?? "").join("") ?? "";
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function chatOnce(
  model: string,
  contents: GeminiContent[],
  functionDeclarations: GeminiFunctionDeclaration[],
  systemInstruction: string,
): Promise<GeminiContent> {
  const response = await fetch(geminiGenerateUrl(model), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools: [{ functionDeclarations }],
      generationConfig: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(`Gemini (${model}) returned ${response.status}. ${body?.error?.message ?? ""}`.trim());
  }
  const body = await response.json();
  const content = body?.candidates?.[0]?.content as GeminiContent | undefined;
  if (!content?.parts?.length) {
    const reason = body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason ?? "no answer";
    throw new Error(`Gemini (${model}) gave no answer (${reason}).`);
  }
  return { role: "model", parts: content.parts };
}
