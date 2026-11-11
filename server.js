import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorld, loadCases, createState, DATA_DIR, round2 } from './src/state.js';
import { makePayPal, seedCaptures } from './src/paypal.js';
import { makeLLM } from './src/llm.js';
import { runAgent, execute } from './src/agent.js';
import { evaluate, commit, scanEmail, MONEY_OUT_TOOLS } from './src/policy.js';
import { AuditLog, verifyChain } from './src/audit.js';
import { runCase, summarize } from './src/eval.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OWNER_PIN = process.env.OWNER_PIN || '2468';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const VERSION = process.env.RENDER_GIT_COMMIT ? process.env.RENDER_GIT_COMMIT.slice(0, 7) : 'dev';

const world = loadWorld();
const cases = loadCases();
const paypal = makePayPal();
const mockPayPal = makePayPal({ PAYPAL_MODE: 'mock' });
const llm = makeLLM();
const audit = new AuditLog();
const RECORDED_DIR = path.join(DATA_DIR, 'recorded');

// ---------- sessions (one per browser) ----------
const sessions = new Map();
let seedsThisHour = { hour: -1, n: 0 };
async function freshCaptures() {
  const h = new Date().getUTCHours();
  if (seedsThisHour.hour !== h) seedsThisHour = { hour: h, n: 0 };
  if (paypal.mode !== 'sandbox' || seedsThisHour.n >= 40) return seedCaptures(mockPayPal, world);
  seedsThisHour.n++;
  const r = await seedCaptures(paypal, world);
  if (r.errors.length) {
    console.warn('[seed] sandbox capture errors:', r.errors.join(' | '));
    const m = await seedCaptures(mockPayPal, world);
    for (const k of Object.keys(m.captures)) if (!r.captures[k]) r.captures[k] = m.captures[k];
  }
  return r;
}
async function getSession(req) {
  let id = String(req.get('x-session') || '').slice(0, 40);
  if (!/^[a-zA-Z0-9-]{8,40}$/.test(id)) id = crypto.randomUUID();
  let s = sessions.get(id);
  if (!s) {
    const seeded = await freshCaptures();
    s = { id, state: createState(world, seeded.captures), approvals: [], runs: [], seedErrors: seeded.errors, created: Date.now() };
    sessions.set(id, s);
    if (sessions.size > 300) sessions.delete(sessions.keys().next().value);
  }
  s.touched = Date.now();
  return s;
}

const runs = new Map(); // runId -> run record
function trimRuns() { if (runs.size > 500) runs.delete(runs.keys().next().value); }

// ---------- rate limit to protect the free model quota ----------
const ipHits = new Map();
let dayHits = { day: '', n: 0 };
function allowLive(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (dayHits.day !== day) dayHits = { day, n: 0 };
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= 20 || dayHits.n >= Number(process.env.DAILY_LIVE_RUNS || 300)) return false;
  hits.push(now); ipHits.set(ip, hits); dayHits.n++;
  return true;
}

function recordedFor(caseId) {
  const f = path.join(RECORDED_DIR, `${caseId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function sessionView(s) {
  const st = s.state;
  return {
    id: s.id,
    business: st.world.business,
    policy: st.world.policy,
    orders: st.world.orders.map((o) => ({ order_number: o.order_number, customer: st.world.customers.find((c) => c.id === o.customer_id)?.name, total: o.total, refunded: o.refunded, status: o.status, capture_id: o.paypal.capture_id, paypal_order_id: o.paypal.order_id, mode: o.paypal.mode })),
    vendors: st.world.vendors,
    bills: st.world.open_bills,
    invoices: st.invoices,
    auto_outflow_today: st.autoOutflowToday,
    approvals: s.approvals.slice().reverse(),
    runs: s.runs.slice(-30).reverse().map((id) => { const r = runs.get(id); return r && { id, label: r.label, title: r.title, status: r.status, guard: r.guard, source: r.source }; }).filter(Boolean),
    seed_errors: s.seedErrors
  };
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(here, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, paypal_mode: paypal.mode, llm: llm ? { provider: llm.provider, models: llm.models } : null, cases: cases.length, audit_entries: audit.entries.length });
});

app.get('/api/inbox', (req, res) => {
  res.json(cases.map((c) => ({ id: c.id, group: c.group, title: c.title, email: c.email, expected: c.expected.summary, scan: scanEmail(c.email), recorded: !!recordedFor(c.id) })));
});

app.get('/api/session', async (req, res, next) => { try { res.json(sessionView(await getSession(req))); } catch (e) { next(e); } });

app.post('/api/session/reset', async (req, res, next) => {
  try { sessions.delete(String(req.get('x-session') || '')); res.json(sessionView(await getSession(req))); } catch (e) { next(e); }
});

app.post('/api/run', async (req, res, next) => {
  try {
    const s = await getSession(req);
    const { case_id, email: custom, guard = 'enforce' } = req.body || {};
    let email; let title; let label;
    if (case_id) {
      const c = cases.find((x) => x.id === case_id);
      if (!c) return res.status(404).json({ error: `Unknown case ${case_id}` });
      email = c.email; title = c.title; label = c.id;
    } else if (custom && (custom.body || custom.subject)) {
      email = { from: String(custom.from || 'Unknown Sender <unknown@example.com>').slice(0, 200), subject: String(custom.subject || '(no subject)').slice(0, 200), body: String(custom.body || '').slice(0, 4000), hidden: custom.hidden ? String(custom.hidden).slice(0, 2000) : undefined };
      title = email.subject; label = 'custom';
    } else {
      return res.status(400).json({ error: 'Pick an email from the inbox, or paste one with at least a subject or body.' });
    }
    const g = guard === 'off' ? 'off' : 'enforce';
    const id = crypto.randomUUID().slice(0, 8);
    const run = { id, label, title, guard: g, email, status: 'running', events: [], started: Date.now(), source: 'live' };
    runs.set(id, run); trimRuns(); s.runs.push(id);

    let runLLM = llm;
    if (process.env.SCRIPTED_LLM === '1' && case_id) { // local UI development only; never set in production
      const { scriptedLLM, gullibleScript } = await import('./test/helpers.js');
      const cap = Object.fromEntries(s.state.world.orders.map((o) => [o.order_number, o.paypal.capture_id]));
      runLLM = scriptedLLM(gullibleScript(case_id, cap));
    }
    const live = runLLM && (runLLM !== llm || allowLive(req.ip));
    if (!live) {
      const rec = case_id && recordedFor(case_id);
      if (!rec) {
        run.status = 'error';
        run.error = llm ? 'The live model quota for this hour is used up. Try a sample email to open its recorded run.' : 'No model key is configured on this server.';
        return res.json({ run_id: id });
      }
      const arm = g === 'off' ? rec.baseline : rec.guarded;
      Object.assign(run, { status: 'done', source: 'recorded', events: arm.events, final: arm.final, models: arm.models, recorded_at: rec.recorded_at });
      return res.json({ run_id: id });
    }

    res.json({ run_id: id });
    runAgent({ state: s.state, email, llm: runLLM, paypal, mockPayPal, guard: g, audit, approvals: s.approvals, runId: id, label, onEvent: (ev) => run.events.push(ev) })
      .then((r) => Object.assign(run, { status: 'done', final: r.final, models: r.models, tokens: r.tokens, ms: Date.now() - run.started }))
      .catch((e) => {
        console.error('[run]', e);
        const rec = case_id && recordedFor(case_id);
        if (rec) {
          const arm = g === 'off' ? rec.baseline : rec.guarded;
          Object.assign(run, { status: 'done', source: 'recorded', note: `Live model call failed (${e.status || ''} ${String(e.message).slice(0, 120)}); showing the recorded run instead.`, events: arm.events, final: arm.final, models: arm.models, recorded_at: rec.recorded_at });
        } else Object.assign(run, { status: 'error', error: `Model call failed: ${String(e.message).slice(0, 200)}` });
      });
  } catch (e) { next(e); }
});

app.get('/api/runs/:id', (req, res) => {
  const r = runs.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Run not found (the server may have restarted).' });
  res.json(r);
});

app.get('/api/recorded/:caseId', (req, res) => {
  const r = recordedFor(String(req.params.caseId).replace(/[^A-Z0-9]/gi, ''));
  if (!r) return res.status(404).json({ error: 'No recorded run for this case yet.' });
  res.json(r);
});

// Owner countersignature. The agent has no tool that reaches this endpoint; it needs the owner PIN.
app.post('/api/approvals/:id/:action(approve|reject)', async (req, res, next) => {
  try {
    const s = await getSession(req);
    const ap = s.approvals.find((a) => a.id === req.params.id);
    if (!ap) return res.status(404).json({ error: 'Approval not found in this session.' });
    if (ap.status !== 'pending') return res.status(409).json({ error: `Already ${ap.status}.` });
    if (String(req.body?.pin || '') !== OWNER_PIN) return res.status(403).json({ error: 'Only the owner can countersign: wrong owner PIN.' });
    if (req.params.action === 'reject') {
      ap.status = 'rejected'; ap.decided = Date.now();
      audit.append({ run: ap.runId, event: 'owner-rejected', tool: ap.tool, approval: ap.id });
      return res.json(ap);
    }
    // Re-check against the books as they are NOW; hard blocks cannot be countersigned.
    const now = evaluate(ap.tool, ap.args, { state: s.state, email: { ...ap.email, body: '' }, scan: { suspicious: false, findings: [] } });
    const hard = now.rules.filter((r) => !r.ok && r.verdict === 'BLOCK');
    if (hard.length) return res.status(409).json({ error: `Cannot countersign: ${hard.map((r) => r.msg).join(' ')}` });
    const result = await execute(ap.tool, ap.args, now, s.state, paypal, mockPayPal);
    commit(ap.tool, ap.args, now, s.state, result);
    ap.status = 'approved'; ap.decided = Date.now(); ap.result = result;
    audit.append({ run: ap.runId, event: 'owner-countersigned', tool: ap.tool, approval: ap.id, result: { id: result.refund_id || result.payout_batch_id || result.invoice_id, via: result.via } });
    res.json(ap);
  } catch (e) { next(e); }
});

app.get('/api/audit', (req, res) => res.json({ entries: audit.tail(300), verify: verifyChain(audit.entries) }));
app.get('/api/audit/verify', (req, res) => res.json(verifyChain(audit.entries)));

// ---------- admin self-test of each PayPal capability ----------
app.post('/api/selftest', async (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(403).json({ error: 'admin token required' });
  const out = { mode: paypal.mode };
  const step = async (name, fn) => { try { out[name] = { ok: true, ...(await fn()) }; } catch (e) { out[name] = { ok: false, error: String(e.message).slice(0, 400) }; } };
  await step('seed_capture', async () => { const c = await paypal.seedCapture({ order_number: 'ST', total: 5 }, world.business); out._cap = c.capture_id; return c; });
  if (out._cap) await step('refund', async () => paypal.execute('create_refund', { capture_id: out._cap, amount: { currency_code: 'USD', value: '1.00' } }));
  await step('payout', async () => paypal.execute('pay_vendor', { payee_email: 'billing@northwindwax.example', amount: 1, memo: 'self-test' }));
  await step('invoice', async () => {
    const r = await paypal.execute('create_invoice', { currency_code: 'USD', invoicer_business_name: world.business.name, primary_recipients: [{ billing_info: { email_address: 'orders@hazelrye.example' } }], items: [{ name: 'Cedar & Smoke candle, 8 oz', quantity: '1', unit_amount: { currency_code: 'USD', value: '18.00' } }] });
    const s = await paypal.execute('send_invoice', { invoice_id: r.invoice_id });
    return { invoice_id: r.invoice_id, sent: s.status };
  });
  if (llm) await step('llm', async () => { const r = await llm.chat({ messages: [{ role: 'user', content: 'Reply with OK' }], tools: undefined }); return { model: r.model, text: r.message.content }; });
  res.json(out);
});

// ---------- evaluation on the live stack ----------
const evals = new Map();
let latestEval = null;
app.post('/api/eval/start', async (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(403).json({ error: 'admin token required' });
  if (!llm) return res.status(400).json({ error: 'no model key' });
  const only = Array.isArray(req.body?.cases) ? req.body.cases : null;
  const id = 'eval-' + new Date().toISOString().replace(/[:.]/g, '-');
  const job = { id, status: 'running', started: new Date().toISOString(), progress: [], guarded: [], baseline: [] };
  evals.set(id, job);
  res.json({ id });
  try {
    const seeded = paypal.mode === 'sandbox' ? await seedCaptures(paypal, world) : await seedCaptures(mockPayPal, world);
    job.seed = { mode: paypal.mode, errors: seeded.errors, captures: seeded.captures };
    if (seeded.errors.length) { const m = await seedCaptures(mockPayPal, world); for (const k of Object.keys(m.captures)) if (!seeded.captures[k]) seeded.captures[k] = m.captures[k]; }
    const list = cases.filter((c) => !only || only.includes(c.id));
    for (const c of list) {
      for (const guard of ['enforce', 'off']) {
        job.progress.push(`${c.id}/${guard}`);
        const r = await runCase(c, { world, captures: seeded.captures, llm, paypal, mockPayPal, guard });
        (guard === 'off' ? job.baseline : job.guarded).push(r);
        await new Promise((r2) => setTimeout(r2, Number(process.env.EVAL_PAUSE_MS || 4000)));
      }
    }
    job.summary = summarize(list, job.guarded, job.baseline);
    job.status = 'done'; job.finished = new Date().toISOString();
    latestEval = job;
  } catch (e) { job.status = 'error'; job.error = String(e.stack || e); }
});
app.get('/api/eval/:id', (req, res) => {
  const j = req.params.id === 'latest' ? latestEval : evals.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'no eval' });
  res.json(j);
});

app.get('/api/results', (req, res) => {
  const f = path.join(here, 'eval_results', 'latest.json');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'No published results yet.' });
  res.type('json').send(fs.readFileSync(f, 'utf8'));
});

app.use((err, req, res, _next) => { console.error(err); res.status(500).json({ error: String(err.message || err).slice(0, 300) }); });

app.listen(PORT, () => console.log(`Countersign on :${PORT} | paypal=${paypal.mode} | llm=${llm ? llm.models.join(',') : 'none'}`));
