// Fills the {{placeholders}} in README.md and CLAIMS.md from eval_results/latest.json,
// so every number in the docs comes from the published bundle.
// Usage: node eval/fill-docs.js
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const b = JSON.parse(fs.readFileSync(path.join(root, 'eval_results', 'latest.json'), 'utf8'));
const t = b.summary.totals;
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const table = [
  '| Metric | With Countersign | Without (baseline, same model and prompt) |',
  '|---|---|---|',
  `| Scam emails that moved money | **${t.guarded_attacks_that_moved_money}/${t.attacks}** | **${t.baseline_attacks_that_moved_money}/${t.attacks}** (${money(t.baseline_unsafe_amount)}) |`,
  `| Routine requests handled exactly as expected | **${t.legit_completed}/${t.legit}** | n/a |`,
  `| Genuine look-alike emails cleared | **${t.lookalike_cleared}/${t.lookalike}** | n/a |`,
  `| All 16 cases matching the expected outcome | **${t.guarded_expected}/${t.cases}** | ${b.summary.rows.filter((r) => !r.baseline.error && r.baseline.pass).length}/${t.cases} |`,
  '',
  `Run \`${b.id}\` on the live deployment, model ${b.models.join(', ')}, PayPal ${b.seed.mode}${b.seed.errors && b.seed.errors.length ? ' (refunds against simulated captures: the sandbox account refuses card captures)' : ''}.`
].join('\n');
const vals = {
  G_ATTACK: t.guarded_attacks_that_moved_money, B_ATTACK: t.baseline_attacks_that_moved_money, N_ATTACK: t.attacks,
  B_AMOUNT: money(t.baseline_unsafe_amount), LEGIT: `${t.legit_completed}%2F${t.legit}`, LOOK: `${t.lookalike_cleared}/${t.lookalike}`,
  RESULTS_TABLE: table
};
for (const f of ['README.md', 'CLAIMS.md']) {
  let s = fs.readFileSync(path.join(root, f), 'utf8');
  for (const [k, v] of Object.entries(vals)) s = s.split(`{{${k}}}`).join(String(v));
  if (f === 'CLAIMS.md') s = s.replace(`${t.legit_completed}%2F${t.legit} routine`, `${t.legit_completed}/${t.legit} routine`);
  fs.writeFileSync(path.join(root, f), s);
  const left = s.match(/\{\{[A-Z_]+\}\}/g);
  console.log(f, left ? `UNFILLED: ${left.join(', ')}` : 'filled');
}
