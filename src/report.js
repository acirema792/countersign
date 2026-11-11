// Builds the published benchmark files from an evaluation job (pure: returns {path: content}).
export function buildReport(job, cases) {
  const files = {};
  const models = [...new Set([...job.guarded, ...job.baseline].flatMap((r) => r.models || []))];


  const bundle = {
    id: job.id, started: job.started, finished: job.finished, models,
    seed: { mode: job.seed?.mode, errors: job.seed?.errors || [], captures: job.seed?.captures },
    summary: job.summary,
    per_case: [...job.guarded, ...job.baseline].map((r) => ({ id: r.id, guard: r.guard, ms: r.ms, tokens: r.tokens, models: r.models, error: r.error, score: r.score }))
  };
  files[`eval_results/${job.id}.json`] = JSON.stringify(bundle, null, 2) + '\n';
  files['eval_results/latest.json'] = JSON.stringify(bundle, null, 2) + '\n';

  for (const c of cases) {
    const g = job.guarded.find((r) => r.id === c.id);
    const b = job.baseline.find((r) => r.id === c.id);
    if (!g || !b || g.error || b.error) continue;
    files[`data/recorded/${c.id}.json`] = JSON.stringify({
      case: c.id, recorded_at: job.finished, eval_id: job.id,
      guarded: { events: g.events, final: g.final, models: g.models, ms: g.ms },
      baseline: { events: b.events, final: b.final, models: b.models, ms: b.ms }
    }, null, 1) + '\n';
  }

  const t = job.summary.totals;
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const mv = (arr) => (arr && arr.length ? arr.map((d) => `${d.tool === 'create_refund' ? 'refund' : d.tool === 'pay_vendor' ? 'pay' : 'invoice'} ${money(d.amount)}${d.payee ? ` → ${d.payee}` : d.order_number ? ` #${d.order_number}` : d.recipient ? ` → ${d.recipient}` : ''}`).join('<br>') : '–');
  const lines = [];
  lines.push('# Benchmark results', '');
  lines.push(`Run \`${job.id}\` on the live deployment, finished ${String(job.finished).slice(0, 16).replace('T', ' ')} UTC. Model(s): ${models.join(', ')}. PayPal: ${job.seed?.mode}${job.seed?.errors?.length ? ` (seed errors: ${job.seed.errors.join('; ')})` : ''}.`, '');
  lines.push('Each of the 16 cases in [`data/cases.json`](data/cases.json) had its expected outcome written **before** the run. Every case runs twice with the same model, prompt and tools:', '');
  lines.push('- **With Countersign:** proposals go through the guard; ALLOW actions execute in the PayPal sandbox.');
  lines.push('- **Baseline:** guard off. Nothing is sent to PayPal; the agent is told each action succeeded, and we record what it *would* have done.', '');
  lines.push('## Headline', '');
  lines.push('| Metric | Result |', '|---|---|');
  lines.push(`| Scam emails that got the **unguarded** agent to move money | **${t.baseline_attacks_that_moved_money}/${t.attacks}** (${money(t.baseline_unsafe_amount)}) |`);
  lines.push(`| Scam emails that moved money **with Countersign** | **${t.guarded_attacks_that_moved_money}/${t.attacks}** |`);
  lines.push(`| Routine requests completed exactly as expected (positive controls) | **${t.legit_completed}/${t.legit}** |`);
  lines.push(`| Genuine look-alike emails cleared (false-positive controls) | **${t.lookalike_cleared}/${t.lookalike}** |`);
  lines.push(`| All cases matching the expected outcome with Countersign | **${t.guarded_expected}/${t.cases}** |`);
  if (t.errors.length) lines.push(`| Cases with run errors | ${t.errors.join(', ')} |`);
  lines.push('', '## Case by case', '');
  lines.push('| Case | Expected (written first) | With Countersign | Baseline (would have executed) |', '|---|---|---|---|');
  for (const r of job.summary.rows) {
    const g = r.guarded.error ? `error: ${r.guarded.error}` : `${r.guarded.pass ? '✅ as expected' : '❌ differs'}<br>moved: ${mv(r.guarded.moved)}${r.guarded.held?.length ? `<br>held: ${mv(r.guarded.held)}` : ''}${r.guarded.blocked?.length ? `<br>blocked: ${mv(r.guarded.blocked)}` : ''}`;
    const b = r.baseline.error ? `error: ${r.baseline.error}` : `${r.baseline.unsafe.length ? `❌ unsafe ${money(r.baseline.unsafe_amount)}` : '✅ no unsafe move'}<br>${mv(r.baseline.moved)}`;
    lines.push(`| **${r.id}** ${r.group}: ${r.title} | ${r.expected} | ${g} | ${b} |`);
  }
  lines.push('', '## Reproduce', '', '```bash', 'curl -X POST https://<your-deployment>/api/eval/start -H "x-admin-token: $ADMIN_TOKEN"', 'curl https://<your-deployment>/api/eval/latest > bundle.json', 'node eval/write-results.js bundle.json', '```', '');
  lines.push('Offline, without any keys, `npm test` runs the same 16 cases through a scripted, maximally gullible agent against a PayPal mock.');
  files['BENCHMARK-RESULTS.md'] = lines.join('\n') + '\n';

  return { files, totals: job.summary.totals };
}
