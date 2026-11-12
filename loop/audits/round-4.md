# Round 4 audit: Countersign

Auditor: independent, round 4. Scope: verify the round-4 fixes for H1-H4 (`git log 15adb3c..main`, 8 commits), look for regressions they introduced, and find what earlier rounds missed. Scratch work is in `/tmp/audit-r4/`.

**Baseline checks:** `npm test` passes 34/34 and `node loop/tripwire.js` passes 12/12 (both re-run here). The live app could not be reached: the egress proxy answered 403 to CONNECT for countersign-jlir.onrender.com, so every live claim is listed in section 4.

## 1. Status of the round-3 findings

| ID | Status | Evidence |
|---|---|---|
| H1 (one visitor can use up the account cap) | **Mostly fixed; some risk remains (J2)** | server.js:35-45 adds a per-visitor ledger, keyed on `req.ip`, with a $1,500 cap. policy.js:77-90 and 353-359 count only real outflows, so simulated refunds are skipped in both the rule and `reserve()`. The approval route now reuses the policy rule (server.js:296-299), which removes the separate check that could drift from the rule. HTTP test at server.test.js:160 covers: the same address in a new session, a forged left-hand XFF entry, the automatic path, and a second visitor who is unaffected. I re-ran the round-3 grief scenario: one address now stops after one $1,140 countersign. |
| H2 (server imports a test fixture) | **Fixed** | server.js:191 imports `./src/scripted.js`, and test/helpers.js re-exports it. Nit: it is still an `await import()` on every request, not the static import that was suggested. It works because the module is cached. |
| H3 (coverage overstated) | **Fixed** | New HTTP tests cover F9 (server.test.js:105, the invoice is created and then `SENT`), F4 (121, both halves) and F10 (135). With these, "regressions for every finding" (JUDGES.md:60) is now defensible. The `SCRIPTED_STEPS` and `SCRIPTED_FAIL_AFTER` hooks only work when `SCRIPTED_LLM=1` is set (server.js:212-216). |
| H4 (Audit tab doesn't mark simulated entries) | **Fixed** | Replay entries get `simulated: 'gullible-agent replay'`: from the run (server.js:232), on reject (284) and on countersign or send (307, 315). Executed entries with `via:'mock'` get "· simulated" (app.js:255). The test at server.test.js:147 checks every entry of a replay and that the chain still verifies. |

**Regressions checked; none found in:**
- **Real vs simulated agree at both checkpoints.** The cap rule (policy.js:157), `reserve()` (policy.js:355) and `execute()` (agent.js:175-176) all decide "real" with the same test, `order.paypal.mode === 'sandbox'`. So a refund that reaches the sandbox is always counted, and a simulated one never is.
- **Undo covers the visitor ledger.** It is released on a definitive failure and kept on a timeout.
- **Replay scratch books still have no `account`.** This is why `capRule` is absent for them.
- **No race.** There is still no `await` between `evaluate`, `capRule` and `reserve` (server.js:293-302).
- **XSS.** The new strings in app.js:255 are static.
- **`?ip=` on /api/health** is cut to 64 characters, compared, and never echoed back. Repeating `?ip=` doesn't crash it.

## 2. Findings (most important first)

### J1 (S2, Security/privacy): Any visitor can read any other visitor's runs, including the text of their "Write your own" emails
- **Where:** server.js:248-252. `GET /api/runs/:id` has no session check. `GET /api/audit` (server.js:328) is shared and lists the `run` id of every entry from every visitor. The run record includes `email` (from, subject, body, hidden), and that object is built before any model call (server.js:181-186).
- **Repro:** I started `PORT=3395 PAYPAL_MODE=mock SCRIPTED_LLM=1 node server.js`. Session `victim-aaaa-1111` ran L1. Session `snoop-bbbb-2222` then called `/api/audit`, took the first `run` id (`b23afc2a`, the victim's), and called `/api/runs/b23afc2a`. That returned the victim's full email and all 4 events. On the live app, a judge's custom email (step 12, "Try to break it") gets audit entries as soon as it proposes anything. From then on, every visitor who opens the Audit tab can read it.
- **Why earlier rounds missed it:** the run ids only became easy to collect once the Audit tab listed them for everyone. Run ids are 8 hex characters, but here they are published, not guessed.
- **Smallest fix (2 lines, server.js:248):** make the route async, call `const s = await getSession(req)`, and return 404 unless `s.runs.includes(req.params.id)`. app.js already sends `x-session`. Optionally, drop `run` from `/api/audit` entries for runs from other sessions, but the 404 is enough. Add one assertion to an existing HTTP test.
- **Est. gain +0.05** (Security).

### J2 (S3, Reliability): The per-visitor cap is keyed on the full address, so one IPv6 /64 still drains the shared cap and holds the judge-path payout for everyone
- **Where:** server.js:39-45 (`visitorLedger(req.ip)`) and server.js:89. An IPv6 client has a whole /64 of addresses. Privacy extensions also rotate the address on their own, so an attacker gets a fresh $1,500 from each new address. In addition, nothing reserves headroom for automatic payouts: countersigns can fill the account cap right up to $10,000.
- **Repro:** `node /tmp/audit-r4/grief6.mjs`, then `grief7.mjs`, against a local server. Addresses `2001:db8:1:1::1` to `::8` countersign A5 at $1,140 each: 8 × 200 OK, $9,120 in total. Two more L3 runs from `::20` and `::21` fill what is left. A new victim at `198.51.100.88` then gets **`held ACCOUNT_DAILY_CAP`** on L3, which is JUDGES step 5 and CLAIMS #8. It took 11 requests from one /64. This is much harder than in round 3 (one click), but a judge who sets out to break the demo can still do it. JUDGES.md:25 says the HOLD is "the cap doing its job", so this fails gracefully.
- **Smallest fix (3 lines):**
  - (a) Key the visitor on the /64 for IPv6: `const vkey = (ip) => ip.includes(':') && !ip.startsWith('::ffff:') ? ip.split(':').slice(0, 4).join(':') : ip;`. This is safe in the expanded form Express gives after the proxy. For compressed addresses, normalise them with `net.SocketAddress` or a tiny expander.
  - (b) Refuse countersigns once account outflows would pass `cap - 1000`, and keep the full `cap` for automatic outflows. Then the $312.50 judge-path payout survives anything except a distributed attack.
- **Protected path:** no. **Est. gain +0.04.**

### J3 (S2, Presentation/Deploy): `render.yaml` and the README disagree with the live configuration; a Blueprint deploy makes the per-visitor cap a single global $1,500/day cap
- **Where:**
  - render.yaml has no `TRUST_PROXY_HOPS`. The live setting of 3 exists only in the Render dashboard (loop/STATE.md:16).
  - README.md:129 says "default 1, Render's single hop", then two sentences later says Render needs 3. Both can't be true.
  - README.md:158 tells forkers to deploy with *New → Blueprint* (`render.yaml`).
- **Consequence:** with 1 trusted hop behind a 3-hop chain, `req.ip` is the address of a Render-internal proxy. Before round 4, that only made the rate limits global. Since H1 it also makes `VISITOR_DAILY_CAP` global: about 4 L3 payouts of $312.50 for **all** visitors, and then step 5 is HELD for the rest of the day. The same happens if the live service is ever recreated from the Blueprint. The server never warns about this. `/api/health` reports it only if someone looks (`client_ip: "private"`, if Render's proxies use RFC 1918 addresses; `isPrivateIp`, server.js:146, does not cover 100.64.0.0/10).
- **Smallest fix:**
  - Add `- key: TRUST_PROXY_HOPS` / `value: "3"` to render.yaml.
  - Change README.md:129 to "default 1; Render currently needs 3 (set in render.yaml)".
  - Optionally, `console.warn` once when the first `req.ip` looks private while `NODE_ENV=production`.
- **Est. gain +0.04** (Presentation, Reliability).

### J4 (S3, Testing): The HTTP tests still share module and environment state and depend on running in order
- **Where:** server.test.js:162 and :176. The H1 test sets `ACCOUNT_DAILY_CAP`/`VISITOR_DAILY_CAP` and then restores `ACCOUNT_DAILY_CAP='700'`, a value it assumes from the top of the file. `SCRIPTED_LLM='1'` is set by several tests and never unset. The H4 test raises `REPLAYS_PER_IP_HOUR` because "an earlier test used up this address's 30 replays" (server.test.js:148). Each test passes on its own only by accident of ordering. `node --test --test-name-pattern` on a single test can give different results.
- **Fix:** add a `withEnv(vars, fn)` helper that saves and restores, and give each test its own XFF address (the `visitor(ip)` helper already exists).
- **Est. gain +0.01.**

### Checked and fine (no finding)
- **`SCRIPTED_STEPS` hook:** a bad value only throws inside a dev-only branch, and Express's `next(e)` catches it. In production `SCRIPTED_LLM` is unset, so a request can't reach it.
- **Visitor map eviction (5000 entries):** evicting an entry only resets *someone else's* counter, and only after 5000 distinct addresses. If an attacker has that many addresses, J2 already applies.
- **Rule count "29" (SUBMISSION.md:53):** there are 30 `rule('…')` IDs, but `READ_ONLY` is the trivial pass for lookup tools. 29 is defensible.
- **Doc numbers:** "34 tests" appears in README.md:151, JUDGES.md:60 and SUBMISSION.md:59, and matches `npm test`. The cap figures in JUDGES.md:25, README.md:91 and index.html:120 match the defaults at server.js:35/38. No headline number changed, and the tripwire passes 12/12.

## 3. Scores

| Criterion | Score | Evidence |
|---|---|---|
| **1. Technological Implementation** | **8.2** | (+) H1-H4 are verified by running them. Real vs simulated is decided by one predicate in all three places (policy.js:157/355, agent.js:176). The countersign route reuses the policy rule instead of a parallel check. Tests 34/34, tripwire 12/12. (-) J1: runs can be read across sessions. J2: the cap can be bypassed by rotating addresses. J3: the safety of the per-visitor cap depends on a dashboard-only setting. |
| ↳ Security | 8.1 | Fail-closed library, constant-time PIN with lockout, per-visitor plus account caps that bind the owner too, replays isolated from PayPal. Residual: J1 (privacy), J2. |
| ↳ Reliability | 8.1 | The cap griefing that took one click in round 3 now needs about 11 requests from one /64 (J2). J3: a Blueprint deploy shrinks the visitor cap to a single global $1,500. |
| ↳ Testing | 8.4 | 13 HTTP tests start the real app and cover the budget, both caps, the PIN, replays, F4, F9, F10, H1, H4 and the health check. Gap: J4, the tests depend on their order. |
| ↳ Code quality | 7.7 | The scripted agent moved to src/. The intent comments are good. `/api/run` is still about 80 lines with inline replay branching and a dynamic import on every request. |
| **2. Design** | **8.1** | (+) Simulated and replay entries are now marked in the Audit tab (H4), the run head and the approval queue. (-) Nothing on screen tells a visitor that the shared Audit tab exposes their runs to others (J1). |
| **3. Potential Impact** | **7.1** | Unchanged. A real BEC problem, and a drop-in wrapper that fails closed. Limits: one fictional shop, no mailbox or DKIM, and refunds are simulated live. |
| **4. Innovation / Idea** | **7.2** | Unchanged. "Provenance, not detection", a pre-registered A/B with a documented miss, a replay tripwire and a live gullible-agent replay. The space is crowded, and the scanner is regex. |
| **5. Presentation** | **8.3** | (+) The coverage claim is now true (H3 fixed). The new deploy-check section is candid. The counts and caps in the docs match the code. (-) README.md:129 "Render's single hop" contradicts the live `TRUST_PROXY_HOPS=3`, and render.yaml doesn't carry it (J3). |

`OVERALL = (8.2 + 8.1 + 7.1 + 7.2 + 8.3) / 5 = 7.78`

J1-J3 together are about 10 lines plus one assertion, worth roughly +0.1. The rest of the gap to 9 is in Impact and Innovation (a real mailbox with DKIM, live refunds, an MCP proxy), and fixes can't close it.

## 4. Only verifiable live
- That `TRUST_PROXY_HOPS=3` is still set on the running service, and that a forged single `X-Forwarded-For: 6.6.6.6` with `?ip=6.6.6.6` returns `client_ip_matches: false`. I could not reach the host (proxy CONNECT 403).
- Whether Render or Cloudflare serves the app over IPv6. If it does, J2 can be exploited from an ordinary home connection.
- Whether the Render hop count is the same on every edge path. With 3 hops trusted, any path with fewer real hops would let a client forge its address.

_Status: complete._

OVERALL_SCORE=7.8
