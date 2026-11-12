// Regression tripwire for the audit loop: replays every recorded (published) guarded run's
// tool proposals through the CURRENT policy and checks each verdict and its failing rules are
// unchanged. If this fails, a change would silently move the published benchmark numbers.
// Usage: node loop/tripwire.js   (exit 0 = identical, 1 = drift)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorld, loadCases, createState } from '../src/state.js';
import { evaluate, reserve, recordResult, scanEmail } from '../src/policy.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const world = loadWorld();
const cases = Object.fromEntries(loadCases().map((c) => [c.id, c]));
const dir = path.join(root, 'data', 'recorded');
let checked = 0;
const drift = [];

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const c = cases[rec.case];
  const events = rec.guarded?.events || [];
  // Rebuild the books with the capture IDs the recorded run actually saw.
  const captures = {};
  for (const o of world.orders) captures[o.order_number] = { capture_id: `REPLAY-${o.order_number}`, order_id: null, amount: o.total, mode: 'mock' };
  for (const e of events) {
    if (e.type === 'lookup' && e.result?.order_number && e.result.paypal_capture_id) {
      captures[e.result.order_number] = { capture_id: e.result.paypal_capture_id, order_id: e.result.paypal_order_id || null, amount: e.result.total, mode: 'mock' };
    }
  }
  const state = createState(world, captures, { day: 'replay', autoOutflow: 0 });
  const email = c.email;
  const scan = scanEmail(email);
  for (const e of events) {
    if (e.type !== 'proposal') continue;
    const now = evaluate(e.tool, e.args, { state, email, scan });
    const was = e.decision || {};
    const failed = (d) => (d.rules || []).filter((r) => !r.ok).map((r) => r.id).sort().join(',');
    checked++;
    if (now.verdict !== was.verdict || failed(now) !== failed(was)) {
      drift.push(`${rec.case} ${e.tool}: recorded ${was.verdict} [${failed(was)}] -> now ${now.verdict} [${failed(now)}]`);
    }
    // Replay the side effects that shaped later decisions in the recorded run.
    if (was.verdict === 'ALLOW' && now.verdict === 'ALLOW') {
      reserve(e.tool, now, state, { auto: true });
      if (e.result) recordResult(e.tool, now, state, e.result);
    }
  }
}

if (drift.length) {
  console.log(`TRIPWIRE FAILED: ${drift.length}/${checked} recorded decisions changed`);
  for (const d of drift) console.log('  ' + d);
  process.exit(1);
}
console.log(`TRIPWIRE OK: ${checked} recorded guarded decisions replay identically`);
