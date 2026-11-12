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
const visitor = () => {
  const sid = `test-session-${process.pid}-${++n}`;
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-session': sid }, body: body ? JSON.stringify(body) : undefined });
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
