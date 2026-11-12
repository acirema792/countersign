# Countersign: audit round 3 (verified audit loop)

Auditor: independent, read-only except this file. Scratch and repro scripts: `/tmp/audit-r3/` (`http.mjs`, `cap.mjs`, `grief.mjs`, `fuzz.mjs`, `lib.mjs`, `g3.mjs`, `aud.mjs`). Date: 2026-11-12 ~03:00 UTC (code freeze 16:00 UTC).
Snapshot: git HEAD `c9ea575` (= deployed build). Baseline: `npm test` 27/27 pass (22 in guard.test.js + 5 HTTP tests in server.test.js); `node loop/tripwire.js` 12/12 recorded guarded decisions identical. `git diff cd685a6..main` touches no protected path (`data/`, `eval*/`, `src/eval.js`, `BENCHMARK-RESULTS.md`, `render.yaml` unchanged). `src/policy.js` changed (G2, G3, G6) and the tripwire still passes.

## 0. Round-2 findings: are they really fixed?

| R2 | Status | Evidence (by running code) |
|---|---|---|
| G1 library fails open | **Fixed** | index.js:21,27,33-38. `node /tmp/audit-r3/lib.mjs` against a fake toolkit: `accept_dispute_claim`, `pay_order`, `cancel_subscription` give `BLOCKED … not guarded`; only `get_order`, `list_disputes` reach the toolkit; `getTools()` offers only guarded or `get_/list_/show_` tools. I checked every read-prefixed name in the real toolkit (`get_invoice`, `list_transactions`, `show_subscription_details`, `get_merchant_insights` and the rest): all are reads. |
| G2 countersign bypasses the account cap | **Fixed** (see H1 for what is left) | policy.js:344-346 counts every outflow; server.js:274-278 refuses. HTTP with `ACCOUNT_DAILY_CAP=2000` (`cap.mjs`): A countersigns A5 $1,140 (200), then B's L3 says "would be $1452.50 of a $2000 cap" (so the countersign was counted), then C's countersign of $1,140 gets **409** "daily cap … would be exceeded". Unit test guard.test.js:318, HTTP test server.test.js:36. |
| G3 empty From skips REQUESTER_IS_VENDOR | **Fixed** | policy.js:190. `g3.mjs`: From `""` now gives `HOLD REQUESTER_IS_VENDOR`. |
| G4 guard invisible on most scams | **Fixed** (button variant) | server.js:175-193 and app.js:80,110,185. A gullible replay over HTTP on all 16 cases (`cap.mjs`): A1 BLOCK `PAYEE_MATCHES_VENDOR_ON_FILE`, A2 BLOCK `REFUND_WITHIN_CAPTURE`, A3 3×HOLD `UNTRUSTED_INSTRUCTIONS`, A4/A5 HOLD, A6 HOLD, A7 first $72 executed (as the case expects) then BLOCK, A8 BLOCK `NOT_ALREADY_PAID`, A9 payout HOLD; L1-L4 and B2 executed (simulated), L5 held. The visitor's own books stay untouched (`auto_outflow_today` 0), and replays don't count toward the account cap (a later L3 still executes). Each result is labelled `via: mock`, `simulated_reason: 'gullible-agent replay'`. Simulated approvals are countersigned only against scratch books and the simulator (server.js:266-269). Replays are limited to 30/h per IP, and pending approvals of evicted replays are pruned. |
| G5 server untested | **Mostly fixed** | server.test.js covers per-visitor budget, the account cap including countersign, PIN lockout, gullible replay, recorded fallback, the replay limit and pruning. Still untested: the round-1 F9 send of a countersigned invoice, F4's "no recorded fallback after a live proposal", and F10 LRU (H3). |
| G6 adversarial args crash | **Fixed** | agent.js:103, index.js:32, policy.js:303-315 (`ARGS_WELL_FORMED`). `fuzz.mjs`: 3,200 weird-argument evaluations, **0 crashes**. The 15 ALLOWs are all the legitimate L3 payment (numeric strings such as `" 312.50 "`); every one executes the books-built payload for NW-2207. |
| G7 doc inaccuracies | **Fixed** | SUBMISSION.md:59 and README.md:146 say 27 tests ✓ (27 run). SUBMISSION.md:53 says 29 rules ✓ (29 unique rule IDs in policy.js excluding `READ_ONLY`). The README.md:9 alt text now matches hero.png (held $420). app.js:192 and README.md:99 word invoices as "once PayPal accepts". JUDGES.md:17 now points to the replay. No stale "19 tests", "28 rules" or "read-only toolkit calls pass" remains. |

Published numbers re-checked against `eval_results/latest.json` (`eval-2026-11-11T21-53-40-928Z`): 16/16 guarded as expected; 0/9 guarded; baseline 2/9, $492; 5/5; 2/2. These match README.md:39-45, SUBMISSION.md and CLAIMS.md #2-4.

## 1. Findings (most important first)

### H1 (S2): One visitor with the public PIN can use up the whole shared account cap, so the JUDGES step 5 live payout is HELD for everyone for the rest of the day
- **Where:** server.js:274-278. The only limit on countersigned outflows is the global `ACCOUNT_DAILY_CAP` ($10,000), and the demo PIN is public (index.html:64, JUDGES.md:36). Also policy.js:344-346: `reserve()` adds **simulated** refunds to the account ledger. On the live demo every refund is simulated (README.md:99, agent.js:175-177), yet each one uses up cap meant to protect real money.
- **Repro:** `PORT=3392 PAYPAL_MODE=mock SCRIPTED_LLM=1 node server.js`, then `BASE=http://localhost:3392 node /tmp/audit-r3/grief.mjs`. One session countersigns A5 eight times ($9,120, all 200) before the 409. Live, a single "Write your own" email ("pay $9,990 to me@x.example") countersigned once does the same in one click. Simulated $420 refunds (L5, countersigned, one per fresh `x-session`) also fill it without a cent leaving PayPal. After that, every later visitor's L3 gets `HOLD ACCOUNT_DAILY_CAP` instead of the **ALLOWED · EXECUTED** real payout. That payout is JUDGES step 5 and CLAIMS #8, the one VERIFIED-LIVE PayPal claim. JUDGES.md:25 explains the HOLD ("the cap doing its job"), so this degrades gracefully, but one judge following step 12 ("Try to break it") can take the headline real-sandbox moment away from every judge after them until 00:00 UTC.
- **Smallest fix (server.js, about 5 lines + 1 HTTP test):** give each session a countersign allowance, e.g. `s.countersignedToday` and refuse with 409 when `+ amount > 1000` (or `> policy.daily_auto_outflow_budget * 2`). In `reserve()`, or in the server before it, skip the account ledger for refunds whose order capture is not `sandbox`. Optionally keep headroom: hold automatic outflows only at `cap`, and refuse countersigns at `cap - 1000`.
- **Protected path:** no (server.js). The policy.js part is optional and tripwire-safe, because the eval has no `account`. Published numbers: unchanged. Needs an owner decision on the per-visitor allowance (escalate). **Est. gain +0.1** (Reliability, Security).

### H2 (S3): The production server imports a test fixture on every run
- **Where:** server.js:173 `await import('./test/helpers.js')`, inside `POST /api/run` for every request, custom emails included. The gullible scripts and `scriptedLLM` that drive a user-facing feature live in `test/`.
- **Why it matters:** a deploy that prunes test files (`.dockerignore`, `npm pack`, a slimmer build) turns **every** `/api/run` into a 500, not just replays. A judge reading server.js sees product code depending on test code. Also: the error text at server.js:177 hardcodes "(30)" while the limit comes from `REPLAYS_PER_IP_HOUR`.
- **Fix:** move `test/helpers.js` to `src/scripted.js`, have `test/helpers.js` re-export it (`export * from '../src/scripted.js'`), and use a static import in server.js. Three files, no behaviour change.
- **Protected path:** no. **Est. gain +0.03** (Code quality).

### H3 (S3): "Regressions for every finding" is overstated; F9 and F4's server half are untested
- **Where:** JUDGES.md:60 ("including regressions for every finding of an independent audit"), README.md:109 ("each fix is pinned by a test"). `grep -n "ap.sent\|send_error\|countersigned-send" test/` finds nothing. Untested: the round-1 F9 fix (server.js:288-297, a countersigned invoice is then sent), F4's rule that a run which already proposed is not replaced by a recording (server.js:217-221), and F10 LRU (server.js:75). I re-read these paths; the round-3 edits (`pp`/`mp` substitution) leave them intact, but nothing pins them.
- **Fix:** one HTTP test. A gullible replay can't produce a held invoice, so either add a scripted held-invoice case to the test via `SCRIPTED_LLM` with a custom script hook, or test F9 at the unit level by calling the approval logic. Or reword to "regressions for the audit's code findings in policy, agent and library; server paths are covered for budget, cap, PIN, replay and fallback".
- **Protected path:** no. **Est. gain +0.03** (Testing, Presentation).

### H4 (S3): The Audit tab doesn't say which entries were simulated
- **Where:** agent.js:131-143 appends the decision entry with no replay or simulation marker. app.js:255 renders `event || tool`, `verdict` and the hash, never `result.via`. `node /tmp/audit-r3/aud.mjs` shows a gullible L3 replay as `pay_vendor ALLOW` then `executed`. The raw entry does carry `via:'mock', simulated_reason:'gullible-agent replay'`, but the tab hides it, and the ALLOW entry has nothing at all. So a judge who clicks a few replays then opens the Audit chain tab sees "executed pay_vendor $312.50" rows that look the same as real sandbox payouts.
- **Fix (2 lines):** for replays, pass `audit: { append: (e) => audit.append({ ...e, replay: true }) }` in server.js:211, and in app.js:255 append ` · simulated` when `e.replay || e.result?.via === 'mock'`.
- **Protected path:** no. **Est. gain +0.02** (Design, Observability).

### Checked and fine (no finding)
- **Replay isolation:** no code path from a replay reaches the real `paypal`. `runAgent` gets `paypal = mockPayPal = simulatedReplayPayPal` (server.js:211). `execute()` only uses those two (agent.js:170-195). Countersigning a simulated approval switches both (server.js:268-269). `ap.simulated` is set server-side only (server.js:191). `get_order` also goes through the simulator. Replay scratch books have no `account`, so they never touch the shared cap.
- **Replay inputs:** `case_id` is checked against `cases` before `gullibleScript()` (so `constructor` or `__proto__` give a 404). `gullible` must be `=== true`. A replay with guard `off` falls through to the normal (rate-limited) path.
- **Account cap race:** no `await` between `evaluate` (server.js:271), the cap check (276) and `reserve` (281), so two concurrent countersigns cannot both pass. A definitive failure undoes the account reservation (policy.js:346 adds to `undo`).
- **Main-module guard:** `realpathSync` comparison (server.js:429). `npm start`, `node server.js` and `node --test` all behave.
- **XSS:** the new strings (`gullible replay, simulated`, the replay note, the rate-limit error) all go through `esc()` or `textContent`.
- **Policy fuzz:** 0 crashes in 3,200 cases. No unexpected ALLOW.

## 2. Scores

| Criterion | Score | Evidence |
|---|---|---|
| **1. Technological Implementation** | **8.0** | (+) G1-G3 and G6 verified fixed by execution. The library is now fail-closed with a filtered `getTools()` (index.js:27-38). Every evaluator is wrapped so malformed input BLOCKs (policy.js:303-315). Replays are isolated from real PayPal by construction (server.js:25-27, 190-191, 266-269). HTTP tests exist. Tripwire 12/12. (-) H1: one visitor can still use up the shared cap, and simulated refunds count against it. A test fixture is a production dependency (H2). |
| ↳ Security | 8.0 | Fail-closed library, empty-From fixed, cap binds countersigns, constant-time PIN with per-session lockout, hasOwn lookups, fuzz-clean policy. Residual: H1 (cap griefing via the public PIN). |
| ↳ Reliability | 7.8 | Per-visitor budgets, honest partial-run display, replay limits and pruning, LRU sessions. Residual: H1 can turn the judge path's live payout into a HOLD for the rest of the day. |
| ↳ Testing | 7.8 | 27 offline tests, including 5 HTTP tests that start the real app on port 0. Gullible A/B across all 16 cases; tripwire. Gaps: F9, F4 server half, F10 (H3). The HTTP tests share module state, so they depend on running in order. |
| ↳ Code quality | 7.5 | Small modules, comments that explain intent, one finding per commit. `/api/run` has grown to ~75 lines with inline replay branching and a dynamic import from `test/` (H2). Long one-line rules in policy.js. |
| **2. Design** | **8.0** | (+) "Replay with a gullible agent" makes the guard visible live on all 9 scams, labelled "gullible agent · simulated PayPal" in the run head (app.js:110) and in the owner queue (app.js:185). Provenance chips, rule IDs, per-tool countersign toasts. (-) The Audit tab doesn't mark simulated or replay entries (H4). After a countersigned replay the Books panel doesn't change (by design, but nothing on screen says so beyond the note). |
| **3. Potential Impact** | **7.1** | (+) A sourced BEC problem. The drop-in wrapper now fails closed, which is what "in front of any agent that uses PayPal's toolkit" (SUBMISSION.md:65) needs. Controls map to AP/AR practice. (-) One fictional shop; no mailbox or DKIM; refunds simulated on the live demo. |
| **4. Innovation / Idea** | **7.2** | (+) "Provenance, not detection". A pre-registered same-model A/B with a documented miss. Replay tripwire as a published claim. Now a live model-independent replay that shows the guard's decisions don't depend on the model's caution. (-) Spend limits plus human approval is a crowded space; the scanner is a few regexes (disclosed). |
| **5. Presentation** | **8.2** | (+) Every headline number matches latest.json. Test and rule counts are correct (27, 29). JUDGES step 4 now promises exactly what the replay shows (verified: A1 BLOCK `PAYEE_MATCHES_VENDOR_ON_FILE`). The candid "changes since the published run" section (README.md:129-140). No stale strings. (-) "Regressions for every finding" overstates the coverage (H3). The JUDGES step-5 live payout can be pre-empted by another visitor (H1), though the doc already explains the HOLD. |

`OVERALL = (8.0 + 8.0 + 7.1 + 7.2 + 8.2) / 5 = 7.70`

Fixing H1-H4 (≈15 lines plus one test) is worth about +0.15 to 0.2, which puts the score around 7.85-7.9. The rest of the gap to 9 is in Impact and Innovation (scope: a real mailbox with DKIM, live refunds, an MCP proxy), which can't be closed by fixes before the freeze.

## 3. Escalations for the owner
1. **H1:** a per-visitor countersign allowance on the shared demo, and whether simulated refunds should count toward `ACCOUNT_DAILY_CAP`. This is a product decision that changes the README.md:91 wording.

## 4. Only verifiable live
- That build `c9ea575` is what is serving, and that the Render build ships `test/helpers.js` (H2: if not, every `/api/run` returns 500).
- `trust proxy` = 1 (server.js:133). If Render puts more than one proxy hop in front, `req.ip` is a proxy address and the 12/h live and 30/h replay limits become **global**. Check that `/api/run` from two networks gets independent limits.
- Sandbox balance compared with `ACCOUNT_DAILY_CAP` ($10,000): if the balance is lower, the cap does not stop a drain (round-2 G2 exposure).
- Whether Invoicing still answers 403 (JUDGES step 6).

_Status: complete._

OVERALL_SCORE=7.7
