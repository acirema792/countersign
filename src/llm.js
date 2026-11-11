// LLM client: Google Gemini through its OpenAI-compatible endpoint, so the PayPal Agent
// Toolkit's OpenAI-format tool schemas are passed through unchanged (after removing JSON
// Schema keywords Gemini rejects).
import OpenAI from 'openai';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';

export function makeLLM(env = process.env) {
  if (!env.GEMINI_API_KEY) return null;
  const models = (env.GEMINI_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((s) => s.trim()).filter(Boolean);
  const client = new OpenAI({ apiKey: env.GEMINI_API_KEY, baseURL: GEMINI_BASE, maxRetries: 0, timeout: 60_000 });
  return {
    provider: 'gemini',
    models,
    async chat({ messages, tools }) {
      let lastErr;
      for (const model of models) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const t0 = Date.now();
            const r = await client.chat.completions.create({ model, messages, tools, tool_choice: 'auto', temperature: 0 });
            return { message: r.choices[0].message, model: r.model || model, usage: r.usage || null, ms: Date.now() - t0 };
          } catch (e) {
            lastErr = e;
            const status = e.status || 0;
            if (status === 429 || status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2)); continue; }
            break; // try next model
          }
        }
      }
      throw lastErr;
    }
  };
}

const DROP = new Set(['$schema', 'additionalProperties', 'pattern', 'maxLength', 'minLength', 'exclusiveMinimum', 'exclusiveMaximum', 'default', 'examples']);
export function sanitizeSchema(s) {
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k)) continue;
    if (k === 'format' && !['enum', 'date-time'].includes(v)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv)])) : sanitizeSchema(v);
  }
  return out;
}
