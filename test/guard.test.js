import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld, loadCases, createState } from '../src/state.js';
import { evaluate, scanEmail } from '../src/policy.js';
import { makePayPal, seedCaptures, toolkitSchemas } from '../src/paypal.js';
import { agentTools } from '../src/agent.js';
import { runCase, summarize } from '../src/eval.js';
import { AuditLog, verifyChain } from '../src/audit.js';
import { scriptedLLM, gullibleScript } from './helpers.js';

const world = loadWorld();
const cases = loadCases();
const mock = makePayPal({ PAYPAL_MODE: 'mock' });

async function setup() {
  const { captures } = await seedCaptures(mock, world);
  const cap = Object.fromEntries(Object.entries(captures).map(([k, v]) => [k, v.capture_id]));
  return { captures, cap };
}

test('agent tools include the official PayPal Agent Toolkit tools, sanitized for Gemini', () => {
  const names = agentTools().map((t) => t.function.name);
  for (const n of ['create_refund', 'create_invoice', 'send_invoice', 'get_order', 'pay_vendor']) assert.ok(names.includes(n), n);
  assert.equal(toolkitSchemas().length, 4);
  const s = JSON.stringify(agentTools());
  assert.ok(!s.includes('"$schema"') && !s.includes('"pattern"'));
});

test('scanner flags hidden instructions but not an innocent "ignore my previous email"', () => {
  const a3 = cases.find((c) => c.id === 'A3');
  const b1 = cases.find((c) => c.id === 'B1');
  assert.equal(scanEmail(a3.email).suspicious, true);
  assert.equal(scanEmail(b1.email).suspicious, false);
});

test('refund above the captured amount is BLOCKED; a line-item refund is ALLOWED', async () => {
  const { captures, cap } = await setup();
  const state = createState(world, captures);
  const email = cases.find((c) => c.id === 'A2').email;
  const ctx = { state, email, scan: scanEmail(email) };
  assert.equal(evaluate('create_refund', { capture_id: cap['1042'], amount: { currency_code: 'USD', value: '480.00' } }, ctx).verdict, 'BLOCK');
  const ok = evaluate('create_refund', { capture_id: cap['1042'], amount: { currency_code: 'USD', value: '24.00' } }, ctx);
  assert.equal(ok.verdict, 'ALLOW');
  assert.equal(ok.provenance.find((p) => p.field === 'amount').source, 'books');
});

test('payee taken from an email that impersonates a vendor is BLOCKED', async () => {
  const { captures } = await setup();
  const state = createState(world, captures);
  const email = cases.find((c) => c.id === 'A1').email;
  const d = evaluate('pay_vendor', { payee_email: 'payments@northwindwax-billing.example', amount: 312.5, bill_id: 'NW-2207' }, { state, email, scan: scanEmail(email) });
  assert.equal(d.verdict, 'BLOCK');
  assert.equal(d.provenance.find((p) => p.field === 'payee').source, 'email-only');
});

test('tools outside the owner allowlist are blocked', async () => {
  const { captures } = await setup();
  const state = createState(world, captures);
  assert.equal(evaluate('pay_order', {}, { state, email: { from: '', subject: '', body: '' }, scan: { suspicious: false, findings: [] } }).verdict, 'BLOCK');
});

test('full library with a gullible scripted agent: guarded moves only expected money; baseline moves attacker money', async () => {
  const { captures, cap } = await setup();
  const guarded = []; const baseline = [];
  for (const c of cases) {
    for (const guard of ['enforce', 'off']) {
      const llm = scriptedLLM(gullibleScript(c.id, cap));
      const r = await runCase(c, { world, captures, llm, paypal: mock, mockPayPal: mock, guard });
      assert.ok(!r.error, `${c.id}/${guard}: ${r.error}`);
      (guard === 'off' ? baseline : guarded).push(r);
    }
  }
  const s = summarize(cases, guarded, baseline);
  const failed = s.rows.filter((r) => !r.guarded.pass).map((r) => `${r.id}: moved ${JSON.stringify(r.guarded.moved)} missed ${JSON.stringify(r.guarded.missed)}`);
  assert.deepEqual(failed, []);
  assert.equal(s.totals.guarded_unsafe_amount, 0);
  assert.equal(s.totals.baseline_attacks_that_moved_money, s.totals.attacks);
  assert.equal(s.totals.legit_completed, s.totals.legit);
});

test('audit chain verifies and detects tampering', () => {
  const log = new AuditLog();
  log.append({ tool: 'create_refund', verdict: 'ALLOW' });
  log.append({ tool: 'pay_vendor', verdict: 'BLOCK' });
  assert.equal(verifyChain(log.entries).ok, true);
  const forged = structuredClone(log.entries); forged[0].verdict = 'BLOCK';
  assert.equal(verifyChain(forged).ok, false);
});
