// HTTP tests for the demo server: per-visitor budget, account cap (automatic and countersigned),
// PIN lockout, gullible-agent replays and the recorded-run fallback. Offline: mock PayPal, scripted agent.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYPAL_MODE = 'mock';
delete process.env.GEMINI_API_KEY;
process.env.ACCOUNT_DAILY_CAP = '700';
const { app } = await import('../server.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

let n = 0;
const visitor = (ip) => {
  const sid = `test-session-${process.pid}-${++n}`;
  const headers = { 'content-type': 'application/json', 'x-session': sid, ...(ip ? { 'x-forwarded-for': ip } : {}) }; // as Render's proxy would set it
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const run = async (body) => {
    const { body: { run_id } } = await call('/api/run', body);
    for (let i = 0; i < 200; i++) {
      const { body: r } = await call(`/api/runs/${run_id}`);
      if (r.status !== 'running') return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('run stuck');
  };
  const pending = async () => (await call('/api/session')).body.approvals.find((a) => a.status === 'pending');
  return { call, run, pending };
};
const proposals = (r) => r.events.filter((e) => e.type === 'proposal');

test('server: each visitor has its own budget; the account cap binds automatic and countersigned outflows', async () => {
  process.env.SCRIPTED_LLM = '1';
  const [a, b, c] = [visitor(), visitor(), visitor()];
  assert.equal(proposals(await a.run({ case_id: 'L3' }))[0].status, 'executed'); // $312.50
  assert.equal(proposals(await b.run({ case_id: 'L3' }))[0].status, 'executed'); // a second visitor is not held: $625 on the account
  assert.equal((await c.call('/api/session')).body.auto_outflow_today, 0);
  const third = proposals(await c.run({ case_id: 'L3' }))[0];
  assert.equal(third.status, 'held');
  assert.ok(third.decision.rules.some((r) => r.id === 'ACCOUNT_DAILY_CAP' && !r.ok));
  // Countersigning cannot push the account past its cap either.
  const ap = await c.pending();
  const res = await c.call(`/api/approvals/${ap.id}/approve`, { pin: '2468' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /\$700 cap/);
});

test('server: wrong PINs lock only that session', async () => {
  process.env.SCRIPTED_LLM = '1';
  const [a, b] = [visitor(), visitor()];
  await a.run({ case_id: 'L5' }); await b.run({ case_id: 'L5' });
  const apA = await a.pending(); const apB = await b.pending();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await a.call(`/api/approvals/${apA.id}/approve`, { pin: '0000' })).status);
  assert.deepEqual(codes, [403, 403, 403, 403, 403, 429]);
  assert.equal((await a.call(`/api/approvals/${apA.id}/approve`, { pin: '2468' })).status, 429);
  assert.equal((await b.call(`/api/approvals/${apB.id}/approve`, { pin: '0000' })).status, 403);
  assert.equal((await b.call(`/api/approvals/${apB.id}/reject`, { pin: '2468' })).status, 200);
});

test('server: a gullible-agent replay shows the guard on a scam, on scratch books, with simulated PayPal', async () => {
  delete process.env.SCRIPTED_LLM;
  const v = visitor();
  const r = await v.run({ case_id: 'A1', guard: 'enforce', gullible: true });
  assert.equal(r.source, 'gullible');
  const p = proposals(r)[0];
  assert.equal(p.status, 'blocked');
  assert.ok(p.decision.rules.some((x) => x.id === 'PAYEE_MATCHES_VENDOR_ON_FILE' && !x.ok));
  // A held replay action can be countersigned, but only ever executes against the simulator.
  await v.run({ case_id: 'A5', guard: 'enforce', gullible: true });
  const ap = await v.pending();
  assert.equal(ap.simulated, true);
  const ok = await v.call(`/api/approvals/${ap.id}/approve`, { pin: '2468' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.via, 'mock');
  assert.equal(ok.body.result.simulated_reason, 'gullible-agent replay');
  const s = (await v.call('/api/session')).body;
  assert.equal(s.auto_outflow_today, 0); // the visitor's real books are untouched
  assert.ok(s.bills.every((b) => b.bill_id === 'WW-0930' || b.status === 'open'));
});

test('server: without a model, a sample email opens its recorded run', async () => {
  delete process.env.SCRIPTED_LLM;
  const r = await visitor().run({ case_id: 'A6' });
  assert.equal(r.source, 'recorded');
  assert.ok(proposals(r).some((p) => p.status === 'held'));
});

test('server: gullible replays are rate limited and stale replay approvals are pruned', async () => {
  delete process.env.SCRIPTED_LLM;
  const v = visitor();
  let last;
  for (let i = 0; i < 31; i++) last = await v.run({ case_id: 'A5', guard: 'enforce', gullible: true }); // more than the 30/hour limit for this address
  assert.equal(last.status, 'error');
  assert.match(last.error, /Replay limit/);
  const s = (await v.call('/api/session')).body;
  assert.ok(s.approvals.filter((a) => a.simulated && a.status === 'pending').length <= 20);
});

test('server: a countersigned invoice is created and then sent (F9)', async () => {
  process.env.SCRIPTED_LLM = '1';
  // Off-catalog price: the guard holds the invoice for the owner.
  process.env.SCRIPTED_STEPS = JSON.stringify([['create_invoice', { currency_code: 'USD', primary_recipients: [{ billing_info: { email_address: 'orders@hazelrye.example' } }], items: [{ name: 'Cedar & Smoke candle, 8 oz', quantity: '12', unit_amount: { currency_code: 'USD', value: '15.00' } }] }]]);
  try {
    const v = visitor();
    const r = await v.run({ case_id: 'L2' });
    assert.equal(proposals(r)[0].status, 'held');
    const ap = await v.pending();
    const ok = await v.call(`/api/approvals/${ap.id}/approve`, { pin: '2468' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.result.invoice_id);
    assert.equal(ok.body.sent.status, 'SENT');
  } finally { delete process.env.SCRIPTED_STEPS; }
});

test('server: a run that fails after a live proposal shows what happened, not a recording (F4)', async () => {
  process.env.SCRIPTED_LLM = '1'; process.env.SCRIPTED_FAIL_AFTER = '1';
  try {
    const partial = await visitor().run({ case_id: 'L1' }); // refunds $24 (executed), then the model fails
    assert.equal(partial.source, 'live');
    assert.equal(partial.status, 'error');
    assert.match(partial.error, /did happen/);
    assert.equal(proposals(partial)[0].status, 'executed');
    process.env.SCRIPTED_STEPS = '[]'; // fails before any proposal: the recorded run is shown instead
    const early = await visitor().run({ case_id: 'A6' });
    assert.equal(early.source, 'recorded');
  } finally { delete process.env.SCRIPTED_FAIL_AFTER; delete process.env.SCRIPTED_STEPS; }
});

test('server: an active session survives 300 newer sessions (least-recently-used eviction, F10)', async () => {
  process.env.SCRIPTED_LLM = '1';
  const keep = visitor();
  await keep.run({ case_id: 'L5' });
  assert.ok(await keep.pending());
  for (let i = 0; i < 310; i++) {
    await visitor().call('/api/session');
    if (i % 50 === 0) await keep.call('/api/session'); // the judge keeps using it
  }
  assert.ok(await keep.pending(), 'the active session and its pending approval were evicted');
});

test('server: replay entries in the shared receipt log are marked simulated (H4)', async () => {
  process.env.REPLAYS_PER_IP_HOUR = '1000'; // an earlier test used up this address's 30 replays
  const v = visitor();
  let r;
  try { r = await v.run({ case_id: 'A6', guard: 'enforce', gullible: true }); } finally { delete process.env.REPLAYS_PER_IP_HOUR; }
  assert.equal(r.source, 'gullible');
  const { body } = await v.call('/api/audit');
  const mine = body.entries.filter((e) => e.run === r.id);
  assert.ok(mine.length > 0);
  assert.ok(mine.every((e) => e.simulated === 'gullible-agent replay'));
  assert.equal(body.verify.ok, true);
});

test('server: the per-visitor cap follows the client address across sessions; other visitors are unaffected (H1)', async () => {
  process.env.SCRIPTED_LLM = '1';
  process.env.ACCOUNT_DAILY_CAP = '100000'; process.env.VISITOR_DAILY_CAP = '1500'; // isolate the visitor cap
  const bigPayout = JSON.stringify([['pay_vendor', { payee_email: 'ap@lumenjars.example', amount: 1400 }]]);
  try {
    const big = async (v) => {
      process.env.SCRIPTED_STEPS = bigPayout;
      try { await v.run({ case_id: 'A5' }); } finally { delete process.env.SCRIPTED_STEPS; }
      const ap = await v.pending();
      return v.call(`/api/approvals/${ap.id}/approve`, { pin: '2468' });
    };
    const A = '203.0.113.7'; const B = '198.51.100.9';
    assert.equal((await big(visitor(A))).status, 200); // $1,400 countersigned for visitor A
    const again = await big(visitor(A)); // a NEW session from the same address
    assert.equal(again.status, 409);
    assert.match(again.body.error, /per-visitor cap/);
    // A forged left-hand X-Forwarded-For entry (what a client can send through the proxy) doesn't make a new visitor.
    const forged = await big(visitor(`6.6.6.6, ${A}`));
    assert.equal(forged.status, 409);
    assert.match(forged.body.error, /per-visitor cap/);
    const auto = proposals(await visitor(A).run({ case_id: 'L3' }))[0]; // the automatic path is capped too
    assert.equal(auto.status, 'held');
    assert.ok(auto.decision.rules.some((r) => r.id === 'ACCOUNT_DAILY_CAP' && !r.ok));
    assert.equal(proposals(await visitor(B).run({ case_id: 'L3' }))[0].status, 'executed'); // visitor B is unaffected
  } finally { delete process.env.ACCOUNT_DAILY_CAP; delete process.env.VISITOR_DAILY_CAP; process.env.ACCOUNT_DAILY_CAP = '700'; }
});

test('server: /api/health reports whether the client address looks public (proxy hop check)', async () => {
  const { body: local } = await visitor().call('/api/health');
  assert.equal(local.client_ip, 'private'); // a direct local connection
  const { body: viaProxy } = await visitor('203.0.113.7').call('/api/health');
  assert.equal(viaProxy.client_ip, 'public');
  assert.equal((await visitor('203.0.113.7').call('/api/health?ip=203.0.113.7')).body.client_ip_matches, true);
  assert.equal((await visitor('6.6.6.6, 203.0.113.7').call('/api/health?ip=203.0.113.7')).body.client_ip_matches, true); // forged entry ignored
  assert.equal((await visitor('6.6.6.6, 203.0.113.7').call('/api/health?ip=6.6.6.6')).body.client_ip_matches, false);
});

test('server: a run is readable only by the session that started it (J1)', async () => {
  const owner = visitor(); const other = visitor();
  const { body: { run_id } } = await owner.call('/api/run', { email: { from: 'me@example.com', subject: 'private', body: 'my private note' } });
  assert.equal((await owner.call(`/api/runs/${run_id}`)).status, 200);
  const peek = await other.call(`/api/runs/${run_id}`);
  assert.equal(peek.status, 404);
  assert.ok(!JSON.stringify(peek.body).includes('my private note'));
});
