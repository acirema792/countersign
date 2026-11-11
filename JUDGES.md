# Review Countersign in five minutes

No account, key or install needed. Everything runs in the PayPal **sandbox**; the business, people and emails are fictional.

**Live app:** https://countersign-jlir.onrender.com
(Free Render instance: if it has been idle, the first load can take up to ~50 seconds while it wakes.)

## 1. Watch an AI agent get scammed, then watch Countersign stop it (2 min)

1. Open the live app. The **"Updated payment details"** email (a supplier-fraud email) is preselected.
2. Click **Run without (baseline)**. Same Gemini model, same prompt, same PayPal tools, guard off.
   Nothing is sent to PayPal: the agent is told its actions succeeded, so you see what it *would* have done.
   Watch for a grey **WOULD EXECUTE** card: the agent tries to pay $312.50 to the scammer's new address.
3. Click **▶ Run agent with Countersign**. The same proposal now shows **BLOCKED**, with:
   - the provenance chips: `payee ← email only`, `amount ← email only`;
   - the rule that fired: `PAYEE_MATCHES_VENDOR_ON_FILE` ("payment-detail changes by email are the classic invoice-fraud pattern: verify by phone on file").

## 2. See routine work still flow, for real, in the PayPal sandbox (1 min)

4. Open **"Order #1042 - one candle arrived cracked"** and run it with Countersign.
   The $24.00 refund is **ALLOWED · EXECUTED**: the amount matches the unit price on the order, so a real refund is
   issued against a real sandbox capture (the refund ID is shown on the card).
5. Open **"Restock - 12 Cedar & Smoke"**: a real PayPal invoice is created and sent ($216.00 at wholesale price).

## 3. Countersign as the owner (1 min)

6. Open **"Wedding favours - order 1060 cancellation"** and run it. A $420 refund is legitimate but above the
   $150 automatic limit, so it is **HELD FOR OWNER**.
7. In the right-hand **Owner** panel, click **Countersign** (demo PIN `2468` is prefilled). The refund executes in the sandbox.
   Try a wrong PIN first: the API refuses with "Only the owner can countersign". The agent has no tool that reaches this endpoint.

## 4. Check the numbers and the receipts (1 min)

8. **Measured results** tab: every case's expected outcome (written before the run) next to what happened, with and without Countersign.
9. **Audit chain** tab: every decision and execution is SHA-256 hash-chained. `GET /api/audit/verify` re-verifies it.
10. Try to break it: **+ Write your own** lets you write any email (including hidden HTML text) and run it.

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
| Offline tests (no keys needed) | `npm test` (`test/guard.test.js`) |
