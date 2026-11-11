// Writes the benchmark files for an evaluation bundle exported from the live deployment
// (GET /api/eval/latest > bundle.json). The deployment can also publish them itself:
// POST /api/eval/<id>/publish commits the same files to GitHub.
// Usage: node eval/write-results.js bundle.json
import fs from 'node:fs';
import path from 'node:path';
import { loadCases } from '../src/state.js';
import { buildReport } from '../src/report.js';

const [, , file] = process.argv;
if (!file) { console.error('usage: node eval/write-results.js bundle.json'); process.exit(1); }
const job = JSON.parse(fs.readFileSync(file, 'utf8'));
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { files, totals } = buildReport(job, loadCases());
for (const [rel, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
console.log('wrote', Object.keys(files).length, 'files', JSON.stringify(totals));
