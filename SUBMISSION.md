# Devpost submission copy

**Project name:** Countersign

**Elevator pitch (196/200):**
Let an AI agent run your PayPal back office without letting a scam email move your money. The agent proposes; code checks every amount and payee against your books; you countersign anything risky.

**Try it out links**
- Live demo: https://countersign-jlir.onrender.com
- Code: https://github.com/acirema792/countersign
- Review in five minutes: https://github.com/acirema792/countersign/blob/main/JUDGES.md

**Built with:** node.js, express, javascript, html5, css3, paypal, paypal-agent-toolkit, paypal-payouts-api, paypal-invoicing-api, paypal-orders-api, gemini, google-ai-studio, openai-sdk, render, github

---

## About the project (paste as Markdown)

## Inspiration
Small businesses are starting to let AI agents run their PayPal back office: refund the customer, invoice the wholesaler, pay the supplier. But the agent reads email, and email is where the fraud is. Business email compromise cost US victims **$3.05 billion in 2025** ([FBI IC3 2025 report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf)), and a prompt injection hidden in an email's HTML is invisible to the owner but perfectly visible to the model. We wanted an agent you could actually hand the keys to.

## What it does
**Countersign sits between an AI agent and PayPal. The model proposes; code decides; the owner countersigns anything risky.**

1. An email arrives. It is untrusted text.
2. A Gemini agent, equipped with tools from **PayPal's official Agent Toolkit** (`create_refund`, `create_invoice`, `send_invoice`, `get_order`) plus **PayPal Payouts**, proposes what it wants to do.
3. Every proposed money action goes through a deterministic policy engine **before** anything reaches PayPal. The core rule is **provenance**: every amount and payee must trace back to the business's own books (an order line, an open bill, a vendor's PayPal address on file, a catalog price), not just to the email.
4. The verdict:
   - **ALLOW** runs now in the PayPal sandbox.
   - **HOLD** waits for the owner's PIN.
   - **BLOCK** never runs.

   PayPal only ever receives the payload the policy rebuilt from the books, never the model's raw arguments. Every decision is written to a SHA-256 hash chain with an Ed25519-signed head.

**Try it:** open *"refund order 1060"* (a stranger asks for someone else's $420 refund). Run it **without** Countersign: the agent refunds $420 and tells the stranger it's done (recorded, never sent). Run it **with** Countersign: held for the owner, with the failing rule and the evidence.

## Measured, not claimed
16 cases (9 scams, 5 routine, 2 genuine look-alikes), with each **expected outcome written before any run**. Each case ran twice on the live deployment, with the same model, prompt and tools; only the guard differed.

| | With Countersign | Without |
|---|---|---|
| Scam emails that moved money | **0 / 9** | 2 / 9 ($492). It was 4 / 9 ($852.50) in an earlier run |
| Routine requests completed as expected | **5 / 5** | – |
| Genuine look-alikes cleared (false-positive controls) | **2 / 2** | – |
| All cases as expected | **16 / 16** | 13 / 16 |

The unguarded agent refunded a stranger $420 for someone else's order, refunded $420 above the limit without the owner, and issued two $72 refunds on a $96 order. The model's caution varies from run to run; the guard's decisions don't. Our first run had **one Countersign miss**, documented in the repo along with the rule that fixed it.

## How we built it
- **Node.js + Express**, no front-end framework. Deployed on **Render**.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit/openai`) supplies the agent's tool schemas and executes refunds and invoices. **PayPal Payouts** (REST) handles supplier payments, and **Orders v2** seeds the shop's orders as sandbox captures when the account supports card processing.
- **Gemini 3.5 Flash-Lite** runs through its OpenAI-compatible endpoint, which accepts the toolkit's OpenAI-format tool schemas directly (we strip the JSON Schema keywords Gemini rejects). A free-tier pacer and per-model cooldowns keep the live demo inside the quota.
- `src/policy.js` is the whole guard: no model calls, 29 rules.
- Reservations are made in the same tick as the verdict, so concurrent runs or double-clicked approvals can't pay twice, and payouts use deterministic `sender_batch_id`s.
- An evaluation harness runs the case library on the live stack and publishes a results bundle, recorded runs that the UI can replay, and `BENCHMARK-RESULTS.md`.
- **AI tools used:** Gemini at runtime. The project was designed, coded, tested, audited and documented with **Claude (Anthropic)** as an AI pair programmer.

## Challenges we ran into
- **An independent audit pass** broke our first build. It found double payment under concurrent approvals, invoice terms (currency, discounts, negative quantities) that the guard checked but didn't enforce, and a spoofable From line. All of these are fixed and pinned by regression tests (38 offline tests).
- **Free-tier model limits.** The full Flash models hit their daily cap mid-benchmark, so we rebuilt the client around Flash-Lite with pacing and fallbacks.
- **Sandbox realities.** The new US sandbox account refuses card captures, and the Invoicing permission was still propagating, so refunds and invoices in the published run are **simulated and clearly labelled**. Payouts are real.

## Accomplishments that we're proud of
- A headline number produced by a script on the live deployment, with controls and a documented miss.
- A drop-in library API: `guardToolkit(new PayPalAgentToolkit(...), { state })` puts Countersign in front of any agent that uses PayPal's toolkit.
- A five-minute judge path (`JUDGES.md`) and a claims file where every claim is marked reproducible, verified live, or not claimed.

## What we learned
Don't ask the model whether something is fraud. Ask whether each number and each payee came from somewhere you trust. Provenance is boring, deterministic and explainable, which is exactly what you want guarding money.

## What's next for Countersign
- PayPal webhooks to reconcile the books with what PayPal actually did.
- A real mailbox with DKIM/SPF results feeding sender authentication.
- Packaging Countersign as an MCP proxy in front of PayPal's MCP server.
- A card-enabled sandbox merchant, so refunds run live too.

**Links:** [Live demo](https://countersign-jlir.onrender.com) · [Code (MIT)](https://github.com/acirema792/countersign) · [Review in 5 minutes](https://github.com/acirema792/countersign/blob/main/JUDGES.md) · [Benchmark](https://github.com/acirema792/countersign/blob/main/BENCHMARK-RESULTS.md)

