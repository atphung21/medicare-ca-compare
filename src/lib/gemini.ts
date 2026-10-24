export function geminiGenerateUrl() {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}
