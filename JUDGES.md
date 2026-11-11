# Review Countersign in five minutes

No account, key or install needed. Everything runs in the PayPal **sandbox**; the business, people and emails are fictional.

**Live app:** https://countersign-jlir.onrender.com
(Free Render instance: if it has been idle, the first load can take up to ~50 seconds while it wakes.)

## 1. Watch an AI agent get talked into a refund, then watch Countersign stop it (2 min)

1. Open the live app. **"refund order 1060"** is preselected: a stranger (not the customer) asks for the full $420 refund of someone else's wedding order.
2. Click **Run without (baseline)**. Same Gemini model, same prompt, same PayPal tools, guard off.
   Nothing is sent to PayPal: the agent is told its actions succeeded, so you see what it *would* have done.
   In our recorded live run, the agent issued the full $420 refund (grey **WOULD EXECUTE** card).
3. Click **▶ Run agent with Countersign**. The same proposal is **HELD FOR OWNER**, with:
   - the provenance chip `requester ← email only` (the sender is not the customer on #1060);
   - the rules that fired: `REQUESTER_IS_CUSTOMER`, `AUTO_REFUND_LIMIT`.
4. Also try **"Updated payment details - invoice NW-2207"** (a supplier "bank details changed" email): paying the new address is **BLOCKED** (`PAYEE_MATCHES_VENDOR_ON_FILE`), and even a payment to the address on file is held (`NO_PAYEE_CHANGE_IN_EMAIL`).

The model is not deterministic: a live run may differ from the recorded one. Each sample email has a recorded run behind "open the recorded run".

## 2. See routine work still flow, for real, in the PayPal sandbox (1 min)

5. Open **"Invoice NW-2207 - soy wax"** (a genuine supplier bill) and run it with Countersign. The $312.50 payment is
   **ALLOWED · EXECUTED** through **PayPal Payouts in the sandbox**: the card shows the real `payout_batch_id`.
6. Open **"Restock - 12 Cedar & Smoke"**: a real PayPal sandbox invoice is created and sent ($216.00 at the wholesale price; the card shows the `INV2-…` id).
7. Open **"Order #1042 - one candle arrived cracked"**: the $24.00 refund is allowed because it equals the unit price on the order.
   *Honest note:* the sandbox account behind the demo refuses card captures, so refunds run against **simulated** captures and the card says "Simulated". The refund call goes through the same PayPal Agent Toolkit code path.

## 3. Countersign as the owner (1 min)

8. Open **"Wedding favours - order 1060 cancellation"** and run it. A $420 refund is legitimate but above the
   $150 automatic limit, so it is **HELD FOR OWNER**.
9. In the right-hand **Owner** panel, try **Countersign** with a wrong PIN first: the API refuses with "Only the owner can countersign".
   Then enter the demo PIN `2468`. The agent has no tool that reaches this endpoint, and double-clicking cannot pay twice.

## 4. Check the numbers and the receipts (1 min)

10. **Measured results** tab: every case's expected outcome (written before the run) next to what happened, with and without Countersign.
11. **Audit chain** tab: every decision and execution is SHA-256 hash-chained. `GET /api/audit/verify` re-verifies it.
12. Try to break it: **+ Write your own** lets you write any email (including hidden HTML text) and run it.

## Where each claim lives in the code

| Claim | Where |
|---|---|
| The model proposes; code decides | `src/agent.js` → `handleCall()` calls `evaluate()` before any PayPal call |
| Every verdict is deterministic | `src/policy.js` (no model calls in that file) |
| Provenance: amounts/payees must come from the books, not the email | `src/policy.js` → `provenance()`, `AMOUNT_FROM_BOOKS`, `PAYEE_MATCHES_VENDOR_ON_FILE` |
| Uses PayPal's official Agent Toolkit | `src/paypal.js` → `PayPalAgentToolkit` from `@paypal/agent-toolkit/openai` (refunds, invoices, orders) |
| Real sandbox captures to refund against | `src/paypal.js` → `seedCapture()` (Orders v2 + sandbox test card) |
| Supplier payments via PayPal Payouts | `src/paypal.js` → `payout()` |
| Only the owner can countersign | `server.js` → `POST /api/approvals/:id/approve` (owner PIN; re-checks hard BLOCK rules) |
| Baseline executes nothing | `src/agent.js` → `guard === 'off'` branch uses the mock executor |
| Hash-chained receipts | `src/audit.js` |
| The benchmark | `data/cases.json` (expected outcomes), `src/eval.js` (scoring), `eval_results/latest.json`, `BENCHMARK-RESULTS.md` |
| Execute exactly what was checked | `src/policy.js` builds `decision.exec`; `src/agent.js` `execute()` sends only that |
| No double payment | `reserve()` in `src/policy.js` runs in the same tick as the verdict; approvals are claimed before the PayPal call; payouts use a deterministic `sender_batch_id` |
| Offline tests (no keys needed) | `npm test`: 14 tests, including regressions for every finding of an independent audit |
