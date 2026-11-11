// LLM client: Google Gemini through its OpenAI-compatible endpoint, so the PayPal Agent
// Toolkit's OpenAI-format tool schemas are passed through unchanged (after removing JSON
// Schema keywords Gemini rejects).
//
// Free-tier friendly: a global pacer keeps us under the per-minute limit, and a model that
// answers 429 is put on cooldown so the next call goes straight to the fallback model
// instead of waiting through retries.
import OpenAI from 'openai';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';

export function makeLLM(env = process.env) {
  if (!env.GEMINI_API_KEY) return null;
  const models = (env.GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((s) => s.trim()).filter(Boolean);
  const client = new OpenAI({ apiKey: env.GEMINI_API_KEY, baseURL: GEMINI_BASE, maxRetries: 0, timeout: 45_000 });
  const minGapMs = Number(env.LLM_MIN_GAP_MS || 4500); // ~13 requests/minute
  const cooldown = new Map(); // model -> until (ms)
  let nextSlot = 0;

  async function pace() {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minGapMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  }

  return {
    provider: 'gemini',
    models,
    status: () => Object.fromEntries(models.map((m) => [m, (cooldown.get(m) || 0) > Date.now() ? `cooling down ${Math.round(((cooldown.get(m)) - Date.now()) / 1000)}s` : 'ready'])),
    async chat({ messages, tools }) {
      let lastErr;
      for (let round = 0; round < 3; round++) {
        const ready = models.filter((m) => (cooldown.get(m) || 0) <= Date.now());
        const order = ready.length ? ready : [models.slice().sort((a, b) => (cooldown.get(a) || 0) - (cooldown.get(b) || 0))[0]];
        for (const model of order) {
          await pace();
          try {
            const t0 = Date.now();
            const r = await client.chat.completions.create({ model, messages, ...(tools ? { tools, tool_choice: 'auto' } : {}), temperature: 0 });
            return { message: r.choices[0].message, model: r.model || model, usage: r.usage || null, ms: Date.now() - t0 };
          } catch (e) {
            lastErr = e;
            const status = e.status || 0;
            const msg = String(e.message || '');
            if (status === 429) cooldown.set(model, Date.now() + (/per.?day|daily|PerDay/i.test(msg) ? 6 * 3600_000 : 65_000));
            else if (status >= 500 || /timed? ?out/i.test(msg)) cooldown.set(model, Date.now() + 20_000);
            else if (status === 404) cooldown.set(model, Date.now() + 24 * 3600_000);
            else cooldown.set(model, Date.now() + 10 * 60_000); // e.g. 400: try the next model
          }
        }
        if (!ready.length) await new Promise((r) => setTimeout(r, 15_000));
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

export function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms); })]).finally(() => clearTimeout(t));
}
