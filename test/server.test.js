// HTTP tests for the demo server: per-visitor budget, account cap (automatic and countersigned),
// PIN lockout, gullible-agent replays and the recorded-run fallback. Offline: mock PayPal, scripted agent.
// Each test sets its own environment (restored afterwards), uses its own client addresses, and measures
// the shared account ledger relative to where it starts, so the tests pass in any order.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PAYPAL_MODE = 'mock';
delete process.env.GEMINI_API_KEY;
const { app } = await import('../server.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// Run fn with these environment variables set (undefined = unset), then restore them exactly.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = String(v); };
  for (const [k, v] of Object.entries(vars)) set(k, v);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) set(k, v); }
}

let n = 0;
const freshIp = () => `198.18.${(n >> 8) & 255}.${n & 255}`; // a new public-looking address per visitor
// ip: undefined = a fresh address of its own; null = no X-Forwarded-For (a direct local connection).
const visitor = (ip) => {
  const sid = `test-session-${process.pid}-${++n}`;
  const addr = ip === undefined ? freshIp() : ip;
  const headers = { 'content-type': 'application/json', 'x-session': sid, ...(addr ? { 'x-forwarded-for': addr } : {}) }; // as Render's proxy would set it
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
const accountSpent = async () => (await visitor().call('/api/session')).body.account_outflow_today;
const scriptedPayout = (amount) => JSON.stringify([['pay_vendor', { payee_email: 'ap@lumenjars.example', amount }]]);
const countersignPayout = async (v, amount) => {
  await withEnv({ SCRIPTED_STEPS: scriptedPayout(amount) }, () => v.run({ case_id: 'A5' }));
  const ap = await v.pending();
  return v.call(`/api/approvals/${ap.id}/approve`, { pin: '2468' });
};

test('server: each visitor has its own budget; the account cap binds automatic and countersigned outflows', async () => {
  const start = await accountSpent();
  await withEnv({ SCRIPTED_LLM: '1', ACCOUNT_DAILY_CAP: start + 700, COUNTERSIGN_HEADROOM: 0 }, async () => {
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
    assert.match(res.body.error, new RegExp(`\\$${start + 700} cap`));
  });
});

test('server: wrong PINs lock only that session', async () => {
  await withEnv({ SCRIPTED_LLM: '1' }, async () => {
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
});

test('server: a gullible-agent replay shows the guard on a scam, on scratch books, with simulated PayPal', async () => {
  await withEnv({ SCRIPTED_LLM: undefined }, async () => {
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
});

test('server: without a model, a sample email opens its recorded run', async () => {
  await withEnv({ SCRIPTED_LLM: undefined }, async () => {
    const r = await visitor().run({ case_id: 'A6' });
    assert.equal(r.source, 'recorded');
    assert.ok(proposals(r).some((p) => p.status === 'held'));
  });
});

test('server: gullible replays are rate limited and stale replay approvals are pruned', async () => {
  await withEnv({ SCRIPTED_LLM: undefined, REPLAYS_PER_IP_HOUR: undefined }, async () => {
    const v = visitor();
    let last;
    for (let i = 0; i < 31; i++) last = await v.run({ case_id: 'A5', guard: 'enforce', gullible: true }); // more than the 30/hour limit for this address
    assert.equal(last.status, 'error');
    assert.match(last.error, /Replay limit/);
    const s = (await v.call('/api/session')).body;
    assert.ok(s.approvals.filter((a) => a.simulated && a.status === 'pending').length <= 20);
  });
});

test('server: a countersigned invoice is created and then sent (F9)', async () => {
  // Off-catalog price: the guard holds the invoice for the owner.
  const steps = JSON.stringify([['create_invoice', { currency_code: 'USD', primary_recipients: [{ billing_info: { email_address: 'orders@hazelrye.example' } }], items: [{ name: 'Cedar & Smoke candle, 8 oz', quantity: '12', unit_amount: { currency_code: 'USD', value: '15.00' } }] }]]);
  await withEnv({ SCRIPTED_LLM: '1', SCRIPTED_STEPS: steps }, async () => {
    const v = visitor();
    const r = await v.run({ case_id: 'L2' });
    assert.equal(proposals(r)[0].status, 'held');
    const ap = await v.pending();
    const ok = await v.call(`/api/approvals/${ap.id}/approve`, { pin: '2468' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.result.invoice_id);
    assert.equal(ok.body.sent.status, 'SENT');
  });
});

test('server: a run that fails after a live proposal shows what happened, not a recording (F4)', async () => {
  await withEnv({ SCRIPTED_LLM: '1', SCRIPTED_FAIL_AFTER: '1', SCRIPTED_STEPS: undefined }, async () => {
    const partial = await visitor().run({ case_id: 'L1' }); // refunds $24 (executed), then the model fails
    assert.equal(partial.source, 'live');
    assert.equal(partial.status, 'error');
    assert.match(partial.error, /did happen/);
    assert.equal(proposals(partial)[0].status, 'executed');
  });
  await withEnv({ SCRIPTED_LLM: '1', SCRIPTED_FAIL_AFTER: '1', SCRIPTED_STEPS: '[]' }, async () => {
    const early = await visitor().run({ case_id: 'A6' }); // fails before any proposal: the recorded run is shown instead
    assert.equal(early.source, 'recorded');
  });
});

test('server: an active session survives 300 newer sessions (least-recently-used eviction, F10)', async () => {
  await withEnv({ SCRIPTED_LLM: '1', SESSION_IDLE_MS: 0 }, async () => { // idle protection off: pure LRU order is tested
    const keep = visitor();
    await keep.run({ case_id: 'L5' });
    assert.ok(await keep.pending());
    for (let i = 0; i < 310; i++) {
      await visitor().call('/api/session');
      if (i % 50 === 0) await keep.call('/api/session'); // the judge keeps using it
    }
    assert.ok(await keep.pending(), 'the active session and its pending approval were evicted');
  });
});

test('server: replay entries in the shared receipt log are marked simulated (H4)', async () => {
  await withEnv({ SCRIPTED_LLM: undefined }, async () => {
    const v = visitor();
    const r = await v.run({ case_id: 'A6', guard: 'enforce', gullible: true });
    assert.equal(r.source, 'gullible');
    const { body } = await v.call('/api/audit');
    const mine = body.entries.filter((e) => e.run === r.id);
    assert.ok(mine.length > 0);
    assert.ok(mine.every((e) => e.simulated === 'gullible-agent replay'));
    assert.equal(body.verify.ok, true);
  });
});

test('server: the per-visitor cap follows the client address across sessions; other visitors are unaffected (H1)', async () => {
  await withEnv({ SCRIPTED_LLM: '1', ACCOUNT_DAILY_CAP: 1e9, COUNTERSIGN_HEADROOM: 0, VISITOR_DAILY_CAP: 1500 }, async () => {
    const A = (n++, freshIp()); const B = (n++, freshIp()); // addresses no other visitor uses
    assert.equal((await countersignPayout(visitor(A), 1400)).status, 200); // $1,400 countersigned for visitor A
    const again = await countersignPayout(visitor(A), 1400); // a NEW session from the same address
    assert.equal(again.status, 409);
    assert.match(again.body.error, /per-visitor cap/);
    // A forged left-hand X-Forwarded-For entry (what a client can send through the proxy) doesn't make a new visitor.
    const forged = await countersignPayout(visitor(`6.6.6.6, ${A}`), 1400);
    assert.equal(forged.status, 409);
    assert.match(forged.body.error, /per-visitor cap/);
    const auto = proposals(await visitor(A).run({ case_id: 'L3' }))[0]; // the automatic path is capped too
    assert.equal(auto.status, 'held');
    assert.ok(auto.decision.rules.some((r) => r.id === 'ACCOUNT_DAILY_CAP' && !r.ok));
    assert.equal(proposals(await visitor(B).run({ case_id: 'L3' }))[0].status, 'executed'); // visitor B is unaffected
  });
});

test('server: one IPv6 /64 is one visitor, so rotating addresses inside it gets no new allowance (J2)', async () => {
  await withEnv({ SCRIPTED_LLM: '1', ACCOUNT_DAILY_CAP: 1e9, COUNTERSIGN_HEADROOM: 0, VISITOR_DAILY_CAP: 1500 }, async () => {
    assert.equal((await countersignPayout(visitor('2001:db8:42:7::1'), 1400)).status, 200);
    const rotated = await countersignPayout(visitor('2001:db8:42:7:dead:beef:0:99'), 1400);
    assert.equal(rotated.status, 409);
    assert.match(rotated.body.error, /per-visitor cap/);
    assert.equal((await countersignPayout(visitor('2001:db8:42:8::1'), 1400)).status, 200); // another /64 is another visitor
  });
});

test('server: countersigned payouts cannot use the headroom kept for automatic payments (J2)', async () => {
  const start = await accountSpent();
  await withEnv({ SCRIPTED_LLM: '1', ACCOUNT_DAILY_CAP: start + 2000, COUNTERSIGN_HEADROOM: 1000, VISITOR_DAILY_CAP: 1e9 }, async () => {
    const big = await countersignPayout(visitor(), 1400); // would leave only $600 of the cap
    assert.equal(big.status, 409);
    assert.match(big.body.error, /kept for automatic payments/);
    assert.equal((await countersignPayout(visitor(), 900)).status, 200); // stays outside the headroom
    assert.equal(proposals(await visitor().run({ case_id: 'L3' }))[0].status, 'executed'); // the next visitor's routine payment still goes through
  });
});

test('server: /api/health reports whether the client address looks public (proxy hop check)', async () => {
  const { body: local } = await visitor(null).call('/api/health');
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

test('server: one address cannot flood the session table and push out a judge (new-session limit)', async () => {
  await withEnv({ SESSIONS_PER_VISITOR_HOUR: 5 }, async () => {
    const ip = (n++, freshIp());
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await visitor(ip).call('/api/session')).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    assert.equal((await visitor().call('/api/session')).status, 200); // other visitors are unaffected
  });
});

test('server: a burst of new sessions cannot drop a session used in the last 30 minutes (K2)', async () => {
  await withEnv({ SCRIPTED_LLM: '1', SESSION_IDLE_MS: undefined }, async () => {
    const judge = visitor();
    await judge.run({ case_id: 'L5' });
    for (let i = 0; i < 320; i++) await visitor().call('/api/session'); // the judge does nothing meanwhile
    assert.ok(await judge.pending(), 'a recently active session was evicted by a burst');
  });
});

test('server: the shared receipt log keeps custom-email payees out; the session shows the caps (K1, K3)', async () => {
  await withEnv({ SCRIPTED_LLM: '1', SCRIPTED_STEPS: JSON.stringify([['pay_vendor', { payee_email: 'secret-payee@example.com', amount: 50 }]]) }, async () => {
    const v = visitor();
    const r = await v.run({ email: { from: 'x@example.com', subject: 'pay me', body: 'pay 50 to secret-payee@example.com' } });
    assert.equal(proposals(r)[0].tool, 'pay_vendor'); // the payee was really proposed (and held)
    const { body } = await v.call('/api/audit');
    const mine = body.entries.filter((e) => e.run === r.id);
    assert.ok(mine.length > 0);
    assert.ok(!JSON.stringify(mine).includes('secret-payee@example.com'));
    assert.ok(mine.some((e) => e.money && e.money.payee === '(custom email)'));
    const s = (await v.call('/api/session')).body;
    assert.equal(typeof s.account_cap, 'number');
    assert.equal(typeof s.visitor_cap, 'number');
    assert.equal(s.countersign_headroom, 1000);
  });
});
