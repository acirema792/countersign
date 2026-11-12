# Countersign: independent audit, round 5 (final scoring)

Build audited: `main` = de58841. Round-5 fixes are `8d37756..main`: J1 a941b89, J2 a096823, J3 b76751b, J4 e4b59bd, J5 17f6b59.
Live checks were already done by the operator: the health check IP matches with `TRUST_PROXY_HOPS=3`, a forged XFF is ignored, the gullible A1 replay is blocked, the live L3 sandbox payout executed, another session's run returns 404, and results are 16/16 with 0 unsafe. I did not repeat them. Local work is in /tmp/audit-r5/.

## 1. What I ran

- `npm test`: **38/38 pass** (3.0 s). `node loop/tripwire.js`: **12/12 recorded guarded decisions replay identically.**
- **Each server test run on its own** (`--test-name-pattern`): headroom, H1, session flood, IPv6, F10 and H4 each pass in isolation. J4's order-independence holds.
- **Local server** (`PAYPAL_MODE=mock SCRIPTED_LLM=1`, probe at /tmp/audit-r5/probe.mjs):
  - L3 run, polled by the session that started it: 200, `done`. Polled by another session: **404**. Polled with no session: **404**.
  - Gullible A1 replay: `done`, `source: gullible`.
  - 70 new sessions from one address: 57×200 then 13×429. Three slots were already used by the earlier calls, so the limit is exactly 60. The existing session A still gets 200 after the flood, and a brand-new id gets 429 with a readable message.
- **`visitorKey` edge cases** (server.js:41-48): `::ffff:1.2.3.4` maps to `1.2.3.4`. Upper case, leading zeros, zone ids (`%eth0`), `::` in any position and trailing `::` all fold to the same `/64`. An empty or undefined address maps to `''`.
- **Docs vs data:**
  - `eval_results/latest.json` has `summary.totals`: 16 cases, guarded_unsafe_moves 0, baseline 2/9 attacks moved $492, legit 5/5, look-alikes 2/2. The baseline passes 13/16. These match README.md:37-40 and SUBMISSION.md:42.
  - "38 tests" (README.md:152, JUDGES.md:60, SUBMISSION.md:59) matches `npm test`.

## 2. Round-5 fixes verified

| Fix | Verdict | Evidence |
|---|---|---|
| J1: runs are visible only to their own session | **Fixed** | server.js:270-278 serves a run only if it is in `s.runs`. The per-session list is capped at 200 (server.js:209). The probe returns 404 to another session and to no session. Test at server.test.js:234. |
| J2: IPv6 counts per /64; countersigns can't use the headroom | **Fixed** | `visitorKey` is used for every `req.ip` consumer: server.js:100, 110, 216, 239. The headroom check sits at server.js:326-332, before `reserve`, in the same tick as the `executing` claim, so a double click can't race it. Tests at server.test.js:203 and :213. |
| J3: render.yaml sets the proxy hop count | **Fixed** | render.yaml:20-22 sets `TRUST_PROXY_HOPS: "3"`. README.md:129 now agrees, and the operator verified it live. |
| J4: test isolation | **Fixed** | Tests use a `withEnv` helper and their own addresses. Each one passes when run alone. |
| J5: new-session flood limit | **Fixed as specified, but a partial mitigation (see K2)** | server.js:86-93 and :100. The 429 now keeps its status, and the error handler (server.js:479) logs only errors with no status or a 5xx status. |

**Regressions:** none found.
- The UI polls `/api/runs/:id` with the localStorage `x-session` (public/app.js:8-11, :97), so J1 doesn't break the browser flow.
- No document tells anyone to curl `/api/run` without a session. BENCHMARK-RESULTS.md:70-71 only uses the eval endpoints.
- `freshCaptures` already caps real sandbox seeding at 40 an hour across all visitors (server.js:70), so the per-address session limit isn't the only thing protecting PayPal.
- The error handler now honors `err.status`, and today that is safe. PayPal's own `e.status` (paypal.js:66) is caught and turned into a 502 in the approvals route (server.js:352-355). The agent catches it too (agent.js:145-150). `freshCaptures` records seed errors instead of throwing.

## 3. Findings

### K1 (S3, Security/Privacy): the shared receipt log still shows other visitors' money actions, including payees typed into "Write your own"
- **Where:**
  - `GET /api/audit` and `/api/audit/export` (server.js:361-363) return every entry from every session.
  - Agent entries carry `run` plus the full `money` object (agent.js:131, :135). For `pay_vendor` that includes `payee` and `bill_id`. For invoices it includes `recipient` (policy.js:232, :291).
- **Effect:** J1 hides the run and its email from other sessions. But the run id, tool, amount and payee address of a custom-email run are still public in the Audit tab. Nothing on screen says the log is shared. This is the "Design" residual from round 4, now narrowed to the money fields.
- **Smallest fix:** add one line to the Audit tab: "This receipt log is shared by all demo visitors". Optionally, also redact `money.payee` and `money.recipient` in entries whose run label is `custom`.

### K2 (S3, Reliability): the J5 session limit is per address, but eviction is global, so a few addresses can still push out a judge's session
- **Where:**
  - server.js:91 allows 60 new sessions per visitor key per hour.
  - server.js:104 evicts the least recently used session once there are more than 300.
  - The IPv6 key is a /64 (server.js:47).
- **Effect:**
  - Five IPv4 addresses (cheap cloud VMs), or one IPv6 /48 (65,536 /64s) if the edge serves IPv6, can still open 300+ sessions in an hour.
  - Those sessions evict an idle judge's session, along with its pending approvals and run list (J1 then makes the old runs 404).
  - The cost went from 1 address to about 5, which is an improvement, but the claim "so it cannot push a judge's session out" (README.md:144) is stronger than what the code guarantees.
- **Smallest fix:** add a global new-session budget (for example 250 an hour). Also either skip eviction for sessions touched in the last 30 minutes, or evict sessions that have no runs first. Alternatively, soften the README wording to "makes it much harder".

### K3 (S3, Design): `account_outflow_today` is in the API but not shown on screen
- **Where:** server.js:156 adds it to the session view. public/app.js:195-197 renders only the per-shop `auto_outflow_today` against the shop budget.
- **Effect:** when J2's headroom rule refuses a countersign with 409 ("the last $1000 … is kept"), the visitor has no gauge showing how close the shared account is to the cap. The refusal looks arbitrary.
- **Smallest fix:** show one more line under the budget bar, `Shared account today: $X of $cap`, using the field that already exists.

### Checked and fine
- **Headroom with small test caps:** with `ACCOUNT_DAILY_CAP` below `COUNTERSIGN_HEADROOM`, every countersign would be refused. Production defaults are 10,000 and 1,000, and the tests set `COUNTERSIGN_HEADROOM: 0` explicitly (server.test.js:58, 186, 204). The env var isn't in the README, which is acceptable.
- **`/api/session/reset`** deletes any session id it is given (server.js:188). Ids are random UUIDs kept in localStorage and never appear in audit entries, so this needs the id itself. The risk is negligible.
- **Shared NAT:** a hackathon venue behind one IPv4 address gets 60 new sessions an hour. Browsers reuse their localStorage id, so this is ample.

## 4. Scores

| Criterion | Score | Evidence |
|---|---|---|
| **1. Technological Implementation** | **8.4** | (+) J1-J5 verified by running them. Tests 38/38, each server test passes alone, tripwire 12/12. Every `req.ip` consumer goes through `visitorKey`. The headroom check is synchronous with the claim. (-) K2: eviction is still global. K1: the audit log exposes payees. |
| ↳ Security | 8.4 | Run isolation (server.js:270), IPv6 /64 keys, a headroom that binds the public PIN, plus everything from earlier rounds (fail-closed library, constant-time PIN with lockout, two-level caps, replays that never reach PayPal). Residual: K1. |
| ↳ Reliability | 8.3 | The proxy hop count is now in the Blueprint (J3), the flood limit is in place, and 4xx errors keep their status. Residual: K2. |
| ↳ Testing | 8.7 | 15 HTTP tests start the real app, restore their env and use their own addresses. Every J fix except the config-only J3 has a regression test. |
| ↳ Code quality | 7.8 | The fixes are small and commented. `/api/run` is still about 80 lines with inline replay branching and a dynamic import on every request (server.js:191-268). The approvals route is about 60 lines. |
| **2. Design** | **8.2** | (+) Runs are private, and simulated and replay entries are marked. (-) The shared log isn't labeled as shared (K1), and there's no account gauge to explain the headroom refusal (K3). |
| **3. Potential Impact** | **7.1** | Unchanged. A real BEC and agent-payment problem, and a drop-in wrapper that fails closed. Limits: one fictional shop, no real mailbox or DKIM, and live refunds are simulated. |
| **4. Innovation / Idea** | **7.2** | Unchanged. Provenance over detection, a pre-registered A/B with a documented miss, a decision-replay tripwire and a live gullible-agent replay. The space is crowded, and the scanner is regex. |
| **5. Presentation** | **8.4** | (+) Every headline number checked matches latest.json and `npm test`. The proxy section now agrees with render.yaml and the live setup. The changes list is candid. (-) README.md:144 "cannot push a judge's session out" overstates J5 (K2). |

`OVERALL = (8.4 + 8.2 + 7.1 + 7.2 + 8.4) / 5 = 7.86`

K1-K3 together are about 10 lines of UI and server code, worth roughly +0.05. The rest of the gap to 9 is in Impact and Innovation (a real mailbox with DKIM, live refunds, an MCP proxy deployment), and audit fixes can't close it.

_Status: complete._

OVERALL_SCORE=7.9
