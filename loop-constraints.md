# Loop constraints (binding for every audit-loop round)

Read at the start of every round. Machine-readable twin: `gate.yaml` (checked by `node loop/gate.js`).

## Freeze
- Hackathon deadline: 2026-11-12 20:00 UTC. **Code changes stop at 16:00 UTC**; after that, docs and tests only.
- The live demo must keep working at every commit that gets deployed.

## Protected paths (escalate, never auto-fix)
- Secrets and deploy config: `.env*`, `render.yaml`
- Anything behind a published number: `data/cases.json`, `data/world.json`, `data/recorded/**`, `eval_results/**`, `eval/**`, `src/eval.js`, `BENCHMARK-RESULTS.md`
- `src/policy.js` may change only if `node loop/tripwire.js` still passes (every published guarded decision replays identically) and a test pins the fix.

## Code
- One finding per change; smallest diff; no drive-by refactors; max 10 files.
- Run `npm test` and `node loop/tripwire.js` before proposing a fix.
- Never disable, skip or loosen a test, or change an expected outcome to make it pass.
- Max 3 attempts per finding (logged in `loop/ledger.json`), or stop after the same error twice.
- The implementer never approves its own change: a separate verifier must.

## Communication
- Findings that need a product decision, a published-claim change or a protected path go to Escalations in `loop/STATE.md`.
- Tell the owner before pushing or redeploying.
