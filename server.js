import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorld, loadCases, createState, newLedger, DATA_DIR, round2 } from './src/state.js';
import { makePayPal, seedCaptures } from './src/paypal.js';
import { makeLLM } from './src/llm.js';
import { runAgent, execute } from './src/agent.js';
import { evaluate, reserve, recordResult, scanEmail } from './src/policy.js';
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
// PayPal stand-in for gullible-agent replays: never touches the sandbox, and says so on every result.
const simulatedReplayPayPal = Object.assign(Object.create(mockPayPal), {
  async execute(tool, args) { return { ...(await mockPayPal.execute(tool, args)), simulated_reason: 'gullible-agent replay' }; }
});
const llm = makeLLM();
const audit = new AuditLog({ signingKeyPem: process.env.AUDIT_SIGNING_KEY });
const RECORDED_DIR = path.join(DATA_DIR, 'recorded');

// Each demo session (one visitor's shop) has its own $600/day automatic budget (DAILY_BUDGET).
// The PayPal account behind all sessions also has a hard daily cap across everyone (ACCOUNT_DAILY_CAP),
// counting automatic and countersigned outflows, so many visitors together still can't drain it.
const accountDailyCap = () => Number(process.env.ACCOUNT_DAILY_CAP || 10000); // read per request
// And each visitor (client address) has its own cap on REAL outflows, automatic and countersigned,
// so one visitor with the public demo PIN can't use up the account for everyone else.
const visitorDailyCap = () => Number(process.env.VISITOR_DAILY_CAP || 1500);
const visitorLedgers = new Map(); // ip -> { day, outflow }
// One visitor = one IPv4 address, or one IPv6 /64 (a single home or phone usually gets a whole /64).
function visitorKey(ip = '') {
  const a = String(ip).replace(/%.*$/, '').replace(/^::ffff:(?=\d+\.)/i, '');
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.toLowerCase().split('::');
  const h = head ? head.split(':') : []; const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
function visitorLedger(ip) {
  const day = new Date().toISOString().slice(0, 10);
  let v = visitorLedgers.get(ip);
  if (!v || v.day !== day) { v = { day, outflow: 0 }; visitorLedgers.set(ip, v); if (visitorLedgers.size > 5000) visitorLedgers.delete(visitorLedgers.keys().next().value); }
  return v;
}
let accountLedger = newLedger();
function ledgerForToday() {
  const day = new Date().toISOString().slice(0, 10);
  if (accountLedger.day !== day) { accountLedger.day = day; accountLedger.autoOutflow = 0; }
  return accountLedger;
}

// ---------- sessions (one per browser) ----------
const sessions = new Map();
let seedsThisHour = { hour: -1, n: 0 };
let lastSeedFailure = null; // { at, error } - avoid retrying a failing sandbox capability on every new session
async function freshCaptures() {
  const h = new Date().getUTCHours();
  if (seedsThisHour.hour !== h) seedsThisHour = { hour: h, n: 0 };
  const recentlyFailed = lastSeedFailure && Date.now() - lastSeedFailure.at < 15 * 60_000;
  if (paypal.mode !== 'sandbox' || seedsThisHour.n >= 40 || recentlyFailed) {
    const m = await seedCaptures(mockPayPal, world);
    return { ...m, errors: recentlyFailed ? [lastSeedFailure.error] : m.errors };
  }
  seedsThisHour.n++;
  const r = await seedCaptures(paypal, world);
  if (r.errors.length) {
    console.warn('[seed] sandbox capture errors:', r.errors.join(' | '));
    lastSeedFailure = { at: Date.now(), error: r.errors[0] };
    const m = await seedCaptures(mockPayPal, world);
    for (const k of Object.keys(m.captures)) if (!r.captures[k]) r.captures[k] = m.captures[k];
  } else lastSeedFailure = null;
  return r;
}
// New demo sessions per visitor per hour: stops one client from flooding the session table and
// pushing out (least-recently-used) the session a judge is using.
const sessionHits = new Map(); // visitor key -> timestamps
function allowNewSession(key) {
  const now = Date.now();
  const hits = (sessionHits.get(key) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= Number(process.env.SESSIONS_PER_VISITOR_HOUR || 60)) return false;
  hits.push(now); sessionHits.set(key, hits); if (sessionHits.size > 5000) sessionHits.delete(sessionHits.keys().next().value);
  return true;
}

async function getSession(req) {
  let id = String(req.get('x-session') || '').slice(0, 40);
  if (!/^[a-zA-Z0-9-]{8,40}$/.test(id)) id = crypto.randomUUID();
  let s = sessions.get(id);
  if (!s) {
    if (!allowNewSession(visitorKey(req.ip))) { const e = new Error('Too many new demo sessions from this address in the last hour. Reuse your current tab.'); e.status = 429; throw e; }
    const seeded = await freshCaptures();
    s = { id, state: createState(world, seeded.captures, newLedger()), approvals: [], runs: [], scratch: new Map(), seedErrors: seeded.errors, created: Date.now() };
    sessions.set(id, s);
    if (sessions.size > 300) sessions.delete(sessions.keys().next().value);
  }
  else { sessions.delete(id); sessions.set(id, s); } // keep the map in least-recently-used order
  s.touched = Date.now();
  const today = ledgerForToday();
  if (s.state.ledger.day !== today.day) s.state.ledger = newLedger();
  s.state.account = { ledger: today, cap: accountDailyCap(), visitor: visitorLedger(visitorKey(req.ip)), visitorCap: visitorDailyCap() };
  return s;
}

const runs = new Map(); // runId -> run record
function trimRuns() { if (runs.size > 500) runs.delete(runs.keys().next().value); }

// ---------- rate limit to protect the free model quota ----------
const ipHits = new Map();
let dayHits = { day: '', n: 0 };
// Gullible-agent replays cost no model calls, but each one adds approvals and audit entries: cap them too.
const replayHits = new Map(); // ip -> timestamps
function allowReplay(ip) {
  const now = Date.now();
  const hits = (replayHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= Number(process.env.REPLAYS_PER_IP_HOUR || 30)) return false;
  hits.push(now); replayHits.set(ip, hits); if (replayHits.size > 5000) replayHits.delete(replayHits.keys().next().value);
  return true;
}

function allowLive(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (dayHits.day !== day) dayHits = { day, n: 0 };
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= Number(process.env.RUNS_PER_IP_HOUR || 12) || dayHits.n >= Number(process.env.DAILY_LIVE_RUNS || 150)) return false;
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
    auto_outflow_today: st.ledger.autoOutflow,
    account_outflow_today: st.account ? st.account.ledger.autoOutflow : 0, // real outflows from the shared PayPal account today
    approvals: s.approvals.slice().reverse(),
    runs: s.runs.slice(-30).reverse().map((id) => { const r = runs.get(id); return r && { id, label: r.label, title: r.title, status: r.status, guard: r.guard, source: r.source }; }).filter(Boolean),
    seed_errors: s.seedErrors
  };
}

// ---------- app ----------
const app = express();
// Render terminates TLS in front of us: rate limits and the per-visitor cap key on the real client IP.
// If the platform adds more proxy hops, set TRUST_PROXY_HOPS; /api/health reports whether req.ip looks public.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
const isPrivateIp = (ip = '') => /^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)|^::1$|^f[cd][0-9a-f]{2}:|^fe80:/i.test(ip);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(here, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/api/health', (req, res) => {
  // Deploy check: GET /api/health?ip=<your public IP> answers client_ip_matches: true only when the server keys
  // limits on your real address (too few trusted hops: a proxy's address; too many: a header you could forge).
  const asked = String(req.query.ip || '').slice(0, 64).replace(/^::ffff:/, '');
  const seen = String(req.ip || '').replace(/^::ffff:/, '');
  const match = asked ? { client_ip_matches: asked === seen } : {};
  res.json({ ...match, ok: true, version: VERSION, paypal_mode: paypal.mode, llm: llm ? { provider: llm.provider, models: llm.models, status: llm.status() } : null, cases: cases.length, audit_entries: audit.entries.length, client_ip: isPrivateIp(req.ip) ? 'private' : 'public' });
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
    const { case_id, email: custom, guard = 'enforce', gullible } = req.body || {};
    let email; let title; let label;
    if (case_id) {
      const c = cases.find((x) => x.id === case_id);
      if (!c) return res.status(404).json({ error: `Unknown case ${case_id}` });
      email = c.email; title = c.title; label = c.id;
    } else if (custom && (custom.body || custom.subject)) {
      email = { from: String(custom.from || 'Unknown Sender <unknown@example.com>').slice(0, 200), subject: String(custom.subject || '(no subject)').slice(0, 200), body: String(custom.body || '').slice(0, 4000), hidden: custom.hidden ? String(custom.hidden).slice(0, 2000) : undefined, auth: 'none' };
      title = email.subject; label = 'custom';
    } else {
      return res.status(400).json({ error: 'Pick an email from the inbox, or paste one with at least a subject or body.' });
    }
    const g = guard === 'off' ? 'off' : 'enforce';
    const id = crypto.randomUUID().slice(0, 8);
    const run = { id, label, title, guard: g, email, status: 'running', events: [], started: Date.now(), source: 'live' };
    runs.set(id, run); trimRuns(); s.runs.push(id); if (s.runs.length > 200) s.runs.shift();

    let runLLM = llm;
    let runState = s.state; let runPayPal = paypal; let approvals = s.approvals;
    const { scriptedLLM, gullibleScript } = await import('./src/scripted.js');
    const capOf = (st) => Object.fromEntries(st.world.orders.map((o) => [o.order_number, o.paypal.capture_id]));
    if (gullible === true && case_id && g === 'enforce' && gullibleScript(case_id, {})) {
      if (!allowReplay(visitorKey(req.ip))) {
        Object.assign(run, { status: 'error', error: `Replay limit reached for this hour (${Number(process.env.REPLAYS_PER_IP_HOUR || 30)}). The recorded runs and live runs still work.` });
        return res.json({ run_id: id });
      }
      // "Replay with a gullible agent": a scripted agent that obeys every email, against a scratch copy
      // of this visitor's books, with simulated PayPal. Shows what the guard does when the model doesn't help.
      const captures = Object.fromEntries(s.state.world.orders.map((o) => [o.order_number, { capture_id: o.paypal.capture_id, order_id: o.paypal.order_id, amount: o.paypal.captured, mode: o.paypal.mode }]));
      runState = createState(world, captures, newLedger());
      s.scratch.set(id, runState);
      if (s.scratch.size > 20) {
        // Drop the oldest replay and any of its approvals still waiting: they could never be countersigned.
        const old = s.scratch.keys().next().value; s.scratch.delete(old);
        for (let i = s.approvals.length - 1; i >= 0; i--) { const a = s.approvals[i]; if (a.simulated && a.runId === old && a.status === 'pending') s.approvals.splice(i, 1); } // in place: live runs hold this array
      }
      runPayPal = simulatedReplayPayPal;
      approvals = { push: (ap) => s.approvals.push(Object.assign(ap, { simulated: true })) };
      runLLM = scriptedLLM(gullibleScript(case_id, capOf(runState)));
      Object.assign(run, { source: 'gullible', note: 'Scripted gullible agent: it does whatever the email asks. Simulated PayPal, on a fresh copy of the demo books (your own books are untouched).' });
    } else if (process.env.SCRIPTED_LLM === '1' && case_id) { // local UI development only; never set in production
      // Tests may supply their own steps, and make the model fail after them.
      const steps = process.env.SCRIPTED_STEPS ? JSON.parse(process.env.SCRIPTED_STEPS) : gullibleScript(case_id, capOf(s.state));
      runLLM = scriptedLLM(steps, { failAfter: process.env.SCRIPTED_FAIL_AFTER === '1' });
    }
    const live = runLLM && (runLLM !== llm || allowLive(visitorKey(req.ip)));
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
    // Replay entries are marked in the shared receipt log so nobody mistakes them for sandbox activity.
    const runAudit = runPayPal === paypal ? audit : { append: (e) => audit.append({ ...e, simulated: 'gullible-agent replay' }) };
    runAgent({ state: runState, email, llm: runLLM, paypal: runPayPal, mockPayPal: runPayPal === paypal ? mockPayPal : runPayPal, guard: g, audit: runAudit, approvals, runId: id, label, onEvent: (ev) => run.events.push(ev) })
      .then((r) => Object.assign(run, { status: 'done', final: r.final, models: r.models, tokens: r.tokens, ms: Date.now() - run.started }))
      .catch((e) => {
        console.error('[run]', e);
        const rec = case_id && recordedFor(case_id);
        // Never paper over a partial live run: if the agent already proposed (and maybe executed) a call, show what happened.
        const actedLive = run.events.some((ev) => ev.type === 'proposal');
        if (rec && !actedLive) {
          const arm = g === 'off' ? rec.baseline : rec.guarded;
          Object.assign(run, { status: 'done', source: 'recorded', note: `Live model call failed (${e.status || ''} ${String(e.message).slice(0, 120)}); showing the recorded run instead.`, events: arm.events, final: arm.final, models: arm.models, recorded_at: rec.recorded_at });
        } else Object.assign(run, { status: 'error', error: `${actedLive ? 'The run stopped partway; the steps above did happen. ' : ''}Model call failed: ${String(e.message).slice(0, 200)}` });
      });
  } catch (e) { next(e); }
});

app.get('/api/runs/:id', async (req, res, next) => {
  try {
    // A run (and the email it read) is visible only to the browser session that started it.
    const s = await getSession(req);
    const r = s.runs.includes(req.params.id) ? runs.get(req.params.id) : null;
    if (!r) return res.status(404).json({ error: 'Run not found (the server may have restarted).' });
    res.json(r);
  } catch (e) { next(e); }
});

app.get('/api/recorded/:caseId', (req, res) => {
  const r = recordedFor(String(req.params.caseId).replace(/[^A-Z0-9]/gi, ''));
  if (!r) return res.status(404).json({ error: 'No recorded run for this case yet.' });
  res.json(r);
});

// Owner PIN: constant-time compare, and 5 wrong tries in one session lock that session for 10 minutes.
const pinFails = new Map(); // key -> { n, until }
function pinCheck(key, given) {
  const f = pinFails.get(key) || { n: 0, until: 0 };
  if (f.until > Date.now()) return 'locked';
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(OWNER_PIN).digest();
  if (crypto.timingSafeEqual(a, b)) { pinFails.delete(key); return 'ok'; }
  f.n += 1; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 10 * 60_000; }
  pinFails.set(key, f); if (pinFails.size > 5000) pinFails.delete(pinFails.keys().next().value);
  return 'wrong';
}

// Owner countersignature. The agent has no tool that reaches this endpoint; it needs the owner PIN.
app.post('/api/approvals/:id/:action(approve|reject)', async (req, res, next) => {
  try {
    const s = await getSession(req);
    const ap = s.approvals.find((a) => a.id === req.params.id);
    if (!ap) return res.status(404).json({ error: 'Approval not found in this session.' });
    if (ap.status !== 'pending') return res.status(409).json({ error: `Already ${ap.status}.` });
    const pin = pinCheck(s.id, req.body?.pin); // per session: one judge's typos never lock out another
    if (pin !== 'ok') return res.status(pin === 'locked' ? 429 : 403).json({ error: pin === 'locked' ? 'Too many wrong PINs in this session. Try again in 10 minutes.' : 'Only the owner can countersign: wrong owner PIN.' });
    if (req.params.action === 'reject') {
      ap.status = 'rejected'; ap.decided = Date.now();
      audit.append({ run: ap.runId, event: 'owner-rejected', tool: ap.tool, approval: ap.id, ...(ap.simulated ? { simulated: 'gullible-agent replay' } : {}) });
      return res.json(ap);
    }
    // Gullible-agent replays live in a scratch copy of the books and never reach PayPal.
    const st = ap.simulated ? s.scratch.get(ap.runId) : s.state;
    if (!st) return res.status(410).json({ error: 'That replay has expired. Run it again.' });
    const pp = ap.simulated ? simulatedReplayPayPal : paypal;
    const mp = ap.simulated ? simulatedReplayPayPal : mockPayPal;
    // Re-check against the books as they are NOW; hard blocks cannot be countersigned.
    const now = evaluate(ap.tool, ap.args, { state: st, email: ap.email, scan: scanEmail(ap.email) });
    const hard = now.rules.filter((r) => !r.ok && r.verdict === 'BLOCK');
    if (hard.length) return res.status(409).json({ error: `Cannot countersign: ${hard.map((r) => r.msg).join(' ')}` });
    // The account and per-visitor caps bind the owner too (the demo PIN is public). Scratch replay books have
    // no account, and simulated refunds don't count, so the rule is simply absent for them.
    const capRule = now.rules.find((r) => r.id === 'ACCOUNT_DAILY_CAP' && !r.ok);
    if (capRule) return res.status(409).json({ error: `Cannot countersign: ${capRule.msg}` });
    // Keep the last part of the account's daily cap for automatic payments, so countersigned payouts
    // (with the public demo PIN) can't crowd out the next visitor's routine supplier payment.
    const headroom = Number(process.env.COUNTERSIGN_HEADROOM || 1000);
    const acctNow = st.account;
    if (acctNow && now.rules.some((r) => r.id === 'ACCOUNT_DAILY_CAP') && round2(acctNow.ledger.autoOutflow + (now.money?.amount || 0)) > acctNow.cap - headroom) {
      return res.status(409).json({ error: `Cannot countersign: the last $${headroom} of this PayPal account's $${acctNow.cap} daily cap is kept for automatic payments.` });
    }
    // Claim the approval and reserve in the books in the same tick: a double click cannot pay twice.
    ap.status = 'executing';
    const undo = reserve(ap.tool, now, st, { auto: false });
    try {
      const result = await execute(ap.tool, now, st, pp, mp, { runId: ap.runId, approvalId: ap.id });
      recordResult(ap.tool, now, st, result);
      ap.status = 'approved'; ap.decided = Date.now(); ap.result = result;
      audit.append({ run: ap.runId, event: 'owner-countersigned', tool: ap.tool, approval: ap.id, result: { id: result.refund_id || result.payout_batch_id || result.invoice_id, via: result.via }, ...(ap.simulated ? { simulated: 'gullible-agent replay' } : {}) });
      // The owner approved the invoice, so send the approved draft through the same checks.
      if (ap.tool === 'create_invoice' && result.invoice_id) {
        const send = evaluate('send_invoice', { invoice_id: result.invoice_id }, { state: st, email: ap.email, scan: scanEmail(ap.email) });
        if (send.verdict === 'ALLOW') {
          const undoSend = reserve('send_invoice', send, st, { auto: false });
          try {
            ap.sent = await execute('send_invoice', send, st, pp, mp, { runId: ap.runId, approvalId: ap.id });
            audit.append({ run: ap.runId, event: 'owner-countersigned-send', tool: 'send_invoice', approval: ap.id, result: { id: ap.sent.invoice_id, via: ap.sent.via }, ...(ap.simulated ? { simulated: 'gullible-agent replay' } : {}) });
          } catch (e) { undoSend(); ap.send_error = String(e.message).slice(0, 200); }
        } else ap.send_error = send.rules.filter((r) => !r.ok).map((r) => r.msg).join(' ');
      }
    } catch (e) {
      const unknown = /timed out/i.test(e.message);
      if (!unknown) { undo(); ap.status = 'pending'; } else ap.status = 'unknown';
      return res.status(502).json({ error: `PayPal: ${e.message}` });
    }
    res.json(ap);
  } catch (e) { next(e); }
});

app.get('/api/audit', (req, res) => res.json({ entries: audit.tail(300), verify: verifyChain(audit.entries), signed_head: audit.signedHead() }));
app.get('/api/audit/pubkey', (req, res) => res.type('text/plain').send(audit.publicKeyPem));
app.get('/api/audit/export', (req, res) => res.json({ entries: audit.entries, signed_head: audit.signedHead(), public_key: audit.publicKeyPem }));
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
        job.current = { id: c.id, guard, events: [] };
        const r = await runCase(c, { world, captures: seeded.captures, llm, paypal, mockPayPal, guard, onEvent: (ev) => job.current.events.push({ type: ev.type, tool: ev.tool, status: ev.status, model: ev.model }) });
        (guard === 'off' ? job.baseline : job.guarded).push(r);
        await new Promise((r2) => setTimeout(r2, Number(process.env.EVAL_PAUSE_MS || 4000)));
      }
    }
    job.summary = summarize(list, job.guarded, job.baseline);
    job.status = 'done'; job.finished = new Date().toISOString();
    latestEval = job;
  } catch (e) { job.status = 'error'; job.error = String(e.stack || e); }
});
// Publish an evaluation's files straight to the GitHub repo as one commit (so results never
// pass through a person's clipboard). Needs GITHUB_TOKEN (contents:write on GITHUB_REPO).
app.post('/api/eval/:id/publish', async (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(403).json({ error: 'admin token required' });
  const job = req.params.id === 'latest' ? latestEval : evals.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'no finished eval with that id' });
  const repo = process.env.GITHUB_REPO || 'acirema792/countersign';
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) return res.status(400).json({ error: 'GITHUB_TOKEN not set' });
  try {
    const { buildReport } = await import('./src/report.js');
    const { files } = buildReport(job, cases);
    const extra = req.body && typeof req.body.extra === 'object' ? req.body.extra : {};
    for (const [k, v] of Object.entries(extra)) if (/^eval_results\/[\w.-]+\.json$/.test(k) && typeof v === 'string') files[k] = v;
    const gh = async (method, p, body) => {
      const r = await fetch(`https://api.github.com/repos/${repo}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'countersign' }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json();
      if (!r.ok) throw new Error(`GitHub ${method} ${p}: ${r.status} ${j.message}`);
      return j;
    };
    const ref = await gh('GET', '/git/ref/heads/main');
    const head = await gh('GET', `/git/commits/${ref.object.sha}`);
    const tree = [];
    for (const [p, content] of Object.entries(files)) {
      const blob = await gh('POST', '/git/blobs', { content, encoding: 'utf-8' });
      tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const t = await gh('POST', '/git/trees', { base_tree: head.tree.sha, tree });
    const msg = `Benchmark results ${job.id} (run on the live deployment)\n\n${JSON.stringify(job.summary.totals)}`;
    const c = await gh('POST', '/git/commits', { message: msg, tree: t.sha, parents: [ref.object.sha] });
    await gh('PATCH', '/git/refs/heads/main', { sha: c.sha });
    res.json({ ok: true, commit: c.sha, files: Object.keys(files).length });
  } catch (e) { res.status(502).json({ error: String(e.message).slice(0, 300) }); }
});

// Read-only report files for a finished evaluation, readable cross-origin from github.com so a
// maintainer can commit them from a GitHub tab. Also accepts a stashed earlier-run summary.
const stash = {};
app.post('/api/admin/stash', (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(403).json({ error: 'admin token required' });
  const { name, content } = req.body || {};
  if (!/^[\w.-]+\.json$/.test(String(name)) || typeof content !== 'string' || content.length > 60_000) return res.status(400).json({ error: 'bad stash' });
  stash[`eval_results/${name}`] = content;
  res.json({ ok: true, files: Object.keys(stash) });
});
app.get('/api/eval/:id/report', async (req, res) => {
  if (req.get('origin') === 'https://github.com') res.set('Access-Control-Allow-Origin', 'https://github.com');
  const job = req.params.id === 'latest' ? latestEval : evals.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'no finished eval with that id' });
  const { buildReport } = await import('./src/report.js');
  const { files, totals } = buildReport(job, cases);
  res.json({ id: job.id, totals, files: { ...files, ...stash } });
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

app.use((err, req, res, _next) => { if (!err.status || err.status >= 500) console.error(err); res.status(err.status || 500).json({ error: String(err.message || err).slice(0, 300) }); });

export { app, visitorKey };
// Listen only when run directly (node server.js); tests import the app and listen on a free port.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  app.listen(PORT, () => console.log(`Countersign on :${PORT} | paypal=${paypal.mode} | llm=${llm ? llm.models.join(',') : 'none'}`));
}
