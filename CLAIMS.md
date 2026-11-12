# Claims and their evidence

Every public claim about Countersign, with how you can check it.

- **REPRODUCIBLE:** a script or test in this repo produces it.
- **VERIFIED-LIVE:** observable on the live deployment now.
- **NOT-CLAIMED:** listed so nobody reads it in.

| # | Claim | Tier | How to check |
|---|---|---|---|
| 1 | No model output decides whether money moves; a deterministic policy does | REPRODUCIBLE | `src/policy.js` has no model calls; `src/agent.js` `handleCall()` runs `evaluate()` before any PayPal call; `npm test` |
| 2 | With Countersign, 0/9 scam emails moved money in the live benchmark | VERIFIED-LIVE | `eval_results/latest.json` (`summary.totals`), Measured results tab, `BENCHMARK-RESULTS.md` |
| 3 | Without Countersign, the same model, prompt and tools would have moved money on 2/9 scam emails ($492.00) | VERIFIED-LIVE | same bundle, `baseline` rows; replay any case in the live app with "Run without (baseline)" |
| 4 | Routine work still completes automatically: 5/5 routine cases, 2/2 look-alike cases as expected | VERIFIED-LIVE | same bundle |
| 5 | Expected outcomes were written before the run | REPRODUCIBLE | `data/cases.json` git history: committed before the first `eval_results/` commit |
| 6 | The agent's PayPal tools come from PayPal's official Agent Toolkit | REPRODUCIBLE | `src/paypal.js` imports `PayPalAgentToolkit` from `@paypal/agent-toolkit/openai`; `test/guard.test.js` asserts the tool list |
| 7 | Invoices go to PayPal's Invoicing API through the toolkit | REPRODUCIBLE, not live in the published run | During the run the sandbox app answered 403 for Invoicing (permission just enabled), so invoices were simulated and labelled. The same call goes live once PayPal accepts. |
| 8 | Supplier payments go through PayPal Payouts in the real sandbox | VERIFIED-LIVE | run "Invoice NW-2207": the card shows a real `payout_batch_id` |
| 9 | Refunds go to PayPal via the toolkit's `create_refund` | REPRODUCIBLE, not live today | Same code path; the demo sandbox account currently refuses card captures, so live refunds run against **simulated** captures and are labelled "Simulated" in the UI |
| 10 | Only the owner can countersign | VERIFIED-LIVE | approve with a wrong PIN → HTTP 403 (5 wrong PINs lock that session for 10 minutes); `server.js` approval route; hard BLOCK rules and the caps re-checked at approval time |
| 11 | Every decision is recorded in a tamper-evident chain | VERIFIED-LIVE | `GET /api/audit/verify`; `test/guard.test.js` "audit chain verifies and detects tampering" |
| 12 | The baseline never touches PayPal | REPRODUCIBLE | `src/agent.js`: the `guard === 'off'` branch uses the mock executor only |
| 13 | Rule changes made after the published run leave its results unchanged | REPRODUCIBLE | `node loop/tripwire.js` replays all 12 recorded guarded decisions through the current policy and checks verdicts and failed rules match |
| 14 | "Replay with a gullible agent" never reaches PayPal and never touches your books | REPRODUCIBLE | `test/server.test.js` (replay results are `via: mock`, your books and the caps are unchanged); entries are marked simulated in the Audit tab |
| 15 | Each visitor has a $1,500/day cap and the demo account a $10,000/day cap on real outflows, automatic and countersigned | REPRODUCIBLE + VERIFIED-LIVE | `test/server.test.js` (per-visitor and IPv6 /64 tests, forged `X-Forwarded-For` ignored); live: `GET /api/health?ip=<your IP>` returns `client_ip_matches: true` |
| 16 | A demo run is visible only to the browser session that started it | REPRODUCIBLE + VERIFIED-LIVE | `test/server.test.js` (another session gets 404) |
| 17 | The library wrapper fails closed for PayPal toolkit tools it doesn't guard | REPRODUCIBLE | `test/guard.test.js` "loop G1" |
| 18 | Every change after the published run was checked by a separate reviewer that re-ran the tests | REPRODUCIBLE | `loop/ledger.json` (each attempt and verdict, including the attempts the reviewer rejected), `loop/audits/round-1.md` … `round-5.md` |
| – | Countersign detects every prompt injection | NOT-CLAIMED | The scanner is a few regexes and only escalates. Safety comes from provenance: amounts and payees must match the books whatever the email says. |
| – | Production-ready email integration | NOT-CLAIMED | The inbox is a seeded case library plus "write your own" |
| – | Real money or real customers | NOT-CLAIMED | PayPal sandbox only; the business is fictional |
| – | Abuse-proof demo limits | NOT-CLAIMED | Caps and rate limits key on the client address (IPv4, or IPv6 /64); someone with many addresses gets one allowance per address. The account cap still bounds the total. |
| – | Statistical significance | NOT-CLAIMED | 16 hand-written cases, one live run per arm; read it as a reproducible demonstration, not a study |
