// Gate for audit-loop changes: fails if the diff since <base> touches a denylisted path,
// exceeds maxFiles, or touches a tripwire path while loop/tripwire.js fails.
// Usage: node loop/gate.js [base-ref=HEAD]   (checks committed + working-tree changes)
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const base = process.argv[2] || 'HEAD';
const yaml = fs.readFileSync(new URL('../gate.yaml', import.meta.url), 'utf8');
const list = (key) => { const m = yaml.match(new RegExp(`^${key}:\\n((?:\\s+- .+\\n?)+)`, 'm')); return m ? m[1].split('\n').map((l) => l.trim().replace(/^- /, '').replace(/^"|"$/g, '')).filter(Boolean) : []; };
const maxFiles = Number((yaml.match(/^maxFiles:\s*(\d+)/m) || [])[1] || 10);
const toRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
const deny = list('denylist').map(toRe);
const trip = list('tripwire').map(toRe);
const files = [...new Set(execSync(`git diff --name-only ${base}`, { encoding: 'utf8' }).split('\n').concat(execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' }).split('\n')).filter(Boolean))];
const problems = [];
for (const f of files) if (deny.some((r) => r.test(f))) problems.push(`protected path: ${f}`);
if (files.length > maxFiles) problems.push(`${files.length} files changed (max ${maxFiles})`);
if (files.some((f) => trip.some((r) => r.test(f)))) {
  try { execSync('node loop/tripwire.js', { stdio: 'pipe' }); } catch (e) { problems.push('tripwire failed: ' + String(e.stdout).trim().split('\n')[0]); }
}
if (problems.length) { console.log('GATE FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`GATE OK: ${files.length} file(s) changed since ${base}`);
